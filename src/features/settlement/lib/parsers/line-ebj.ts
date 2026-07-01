/**
 * EBJ (ebookjapan) / LINE Digital Frontier parser.
 *
 * Source: `ExportCSV_PaymentReport_<id>_EpiVol_CSV_WEB.<yyyyMMddHHmmss>.csv`
 *   - Shift-JIS encoded, header row, ~9k rows per settlement month
 *   - 書店名 splits into: LINEマンガ(APP|WEB) = GT channel `line`
 *                        ebookjapan(web|APP|Yahoo! ショッピング) = GT channel `ebj` or `ebj_webtoon`
 *
 * Aggregation key = (channel, type, normalized title_jp). Monetary fields are
 * summed across all detail lines (chapters/volumes) for that key.
 *
 * Rules discovered by diffing against ground-truth/202604.json:
 *   1. total_amount_jpy         = 販売額計 × 1.1   (CSV is tax-exclusive, GT is tax-inclusive)
 *   2. before_tax_income_jpy    = 許諾額計 × 1.1   (royalty also grossed up by 10%)
 *   3. title_jp normalization   = wave dash `〜` (U+301C) → full-width tilde `～` (U+FF5E)
 *   4. Type derivation (priority):
 *        - 【タテヨミ】 suffix         → WT, or WR if title has ［改訂版］ or a [完全版]
 *                                       sibling exists (older/non-full-edition variant)
 *        - 【分冊版】 / 【連載版】      → EP
 *        - 単話 販売単位区分 (no tag)  → WT  (covers 年下旦那 which lacks 【タテヨミ】)
 *        - otherwise                  → EB  (single volume / 【特装版】 / plain title)
 *   5. ebookjapan store splits by type:  WT/WR → ebj_webtoon,  EP/EB → ebj
 *      LINE store is always channel `line` regardless of type.
 *
 * No platform-total pre-aggregation / summary rows exist in the CSV — every
 * line is a per-chapter/per-volume sale, so we just sum.
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";
import iconv from "iconv-lite";
import Papa from "papaparse";

type Row = {
  書店名: string;
  タイトル名: string;
  販売単位区分: string;
  サービス区分: string;
  販売数計: string;
  販売額計: string;
  許諾額計: string;
  出版社名: string;
  表示用刊行物名: string;
  刊行物名: string;
  著者名: string;
};

type Channel = "line" | "ebj" | "ebj_webtoon";
type EbjType = "WT" | "WR" | "EP" | "EB";

/** Wave dash (U+301C) → full-width tilde (U+FF5E). Matches GT convention. */
function normalizeTitle(t: string): string {
  return (t || "").replace(/〜/g, "～").trim();
}

/** Strip version markers + 【タテヨミ】 so sibling editions collapse to one key. */
function titleBase(t: string): string {
  return t
    .replace(/\[完全版\]|\[改訂版\]|［完全版］|［改訂版］/g, "")
    .replace(/【タテヨミ】/g, "")
    .trim();
}

function hasFullEditionTag(t: string): boolean {
  return t.includes("[完全版]") || t.includes("［完全版］");
}

function hasRevisedTag(t: string): boolean {
  return t.includes("[改訂版]") || t.includes("［改訂版］");
}

/**
 * Walk every タテヨミ title in the file and mark the WR variants.
 *
 * A タテヨミ title is WR when either:
 *   a) its own name contains ［改訂版］, or
 *   b) there exists another タテヨミ title sharing the same `titleBase(...)`
 *      that carries [完全版] — meaning the current one is the older edition.
 */
function computeWrSet(titles: Iterable<string>): Set<string> {
  const ty: string[] = [];
  for (const t of titles) {
    if (t.includes("【タテヨミ】")) ty.push(t);
  }
  const byBase = new Map<string, string[]>();
  for (const t of ty) {
    const b = titleBase(t);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b)!.push(t);
  }
  const wr = new Set<string>();
  for (const variants of byBase.values()) {
    const siblingHasFull = variants.some(hasFullEditionTag);
    for (const v of variants) {
      if (hasRevisedTag(v)) wr.add(v);
      else if (siblingHasFull && !hasFullEditionTag(v)) wr.add(v);
    }
  }
  return wr;
}

function classifyType(title: string, unit: string, wrSet: Set<string>): EbjType {
  if (title.includes("【タテヨミ】")) {
    return wrSet.has(title) ? "WR" : "WT";
  }
  if (title.includes("【分冊版】") || title.includes("【連載版】")) return "EP";
  // No genre tag — fall back to unit. 単話 is a chapter (webtoon); else treat as EB volume.
  if (unit === "単話") return "WT";
  return "EB";
}

function classifyChannel(store: string, type: EbjType): Channel {
  if (store.includes("LINE")) return "line";
  return type === "WT" || type === "WR" ? "ebj_webtoon" : "ebj";
}

/** Round half-up so a .5 residue from the ×1.1 multiplication doesn't drift. */
function round1(n: number): number {
  return Math.round(n);
}

export async function parseLineEbj({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename)) {
    return { platform_code: "ebj_line", sales_month: null, settlement_month: null, records: [], errors: [] };
  }
  const parsed = readRows(filename, buffer);

  // Pass 1 — collect every distinct (normalized) title so we can spot the
  // [完全版] / [改訂版] pairs that determine WT-vs-WR.
  const allTitles = new Set<string>();
  for (const r of parsed.rows) {
    const t = normalizeTitle(r["タイトル名"]);
    if (t) allTitles.add(t);
  }
  const wrSet = computeWrSet(allTitles);

  // Pass 2 — aggregate.
  type Agg = {
    title_jp: string;
    channel: Channel;
    type: EbjType;
    store_samples: Set<string>;
    publisher: string;
    author: string;
    sales_count: number;
    sales_jpy_raw: number;   // pre-tax
    royalty_jpy_raw: number; // pre-tax
  };
  const byKey = new Map<string, Agg>();

  for (const r of parsed.rows) {
    const title = normalizeTitle(r["タイトル名"]);
    const store = (r["書店名"] || "").trim();
    if (!title || !store) continue;

    const unit = (r["販売単位区分"] || "").trim();
    const type = classifyType(title, unit, wrSet);
    const channel = classifyChannel(store, type);
    const key = `${channel}||${type}||${title}`;

    let a = byKey.get(key);
    if (!a) {
      a = {
        title_jp: title,
        channel,
        type,
        store_samples: new Set(),
        publisher: (r["出版社名"] || "").trim(),
        author: (r["著者名"] || "").trim(),
        sales_count: 0,
        sales_jpy_raw: 0,
        royalty_jpy_raw: 0,
      };
      byKey.set(key, a);
    }
    a.store_samples.add(store);
    a.sales_count += toNumber(r["販売数計"]);
    a.sales_jpy_raw += toNumber(r["販売額計"]);
    a.royalty_jpy_raw += toNumber(r["許諾額計"]);
  }

  const records = Array.from(byKey.values()).map((a, i) => {
    const total = round1(a.sales_jpy_raw * 1.1);
    const income = round1(a.royalty_jpy_raw * 1.1);
    return {
      row_index: i,
      data: {
        title_jp: a.title_jp,
        channel_code: a.channel,
        client_code: "line_dl_frontier",
        type: a.type,
        publisher: a.publisher || null,
        author: a.author || null,
        stores: Array.from(a.store_samples).sort(),
        sales_count: a.sales_count,
        // pre-tax raw figures kept for audit
        sales_jpy_pretax: a.sales_jpy_raw,
        royalty_jpy_pretax: a.royalty_jpy_raw,
        // tax-inclusive figures matching GT
        total_amount_jpy: total,
        before_tax_jpy: total,
        before_tax_income_jpy: income,
        after_tax_income_jpy_a: a.royalty_jpy_raw,
        consumption_tax_jpy: income - a.royalty_jpy_raw,
      },
    };
  });

  // EBJ file names encode the settlement (export) date, e.g.
  // `...20260409132654817.csv` → settlement month 2026-04.
  const m = filename.match(/(\d{4})(\d{2})\d{2}\d{6,}/);
  const settlement = m ? `${m[1]}-${m[2]}-01` : "";
  // Per Nakatani's notes EBJ runs on a two-month lag.
  const salesMonth = settlement
    ? (() => {
        const y = Number(settlement.slice(0, 4));
        const mo = Number(settlement.slice(5, 7));
        const prev2 = new Date(Date.UTC(y, mo - 1 - 2, 1));
        return `${prev2.getUTCFullYear()}-${String(prev2.getUTCMonth() + 1).padStart(2, "0")}-01`;
      })()
    : null;

  return {
    platform_code: "ebj_line",
    sales_month: salesMonth,
    settlement_month: settlement,
    records,
    errors: parsed.errors,
  };
}

function readRows(filename: string, buffer: Buffer): { rows: Row[]; errors: string[] } {
  if (/\.xlsx$/i.test(filename)) {
    const wb = readWorkbook(buffer);
    const matrix = sheetToMatrix(wb, wb.SheetNames[0]);
    const header = (matrix[0] ?? []).map((cell) => String(cell ?? "").trim());
    const rows = matrix.slice(1)
      .map((row) => Object.fromEntries(header.map((name, i) => [name, String(row[i] ?? "").trim()])) as Row)
      .filter((row) => row["タイトル名"] || row["書店名"]);
    return { rows, errors: [] };
  }
  const text = iconv.decode(buffer, "shift_jis");
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  return {
    rows: parsed.data,
    errors: parsed.errors.map((e: Papa.ParseError) => `${e.code}: ${e.message}`),
  };
}
