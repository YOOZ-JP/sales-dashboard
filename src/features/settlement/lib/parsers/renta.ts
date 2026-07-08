/**
 * Renta (Papyless) parser — CSV (Shift-JIS).
 *
 * Raw file:  PAS02181-A-YYYYMMrnt_jp.csv
 * Companion PDF (掲載料通知書) — ignored here; the CSV is authoritative for
 * per-title breakdown and the PDF total is exactly SUM(支払額) × 1.10.
 *
 * Columns:
 *   掲載日 | 書名 | 著者名 | 価格 | 支払率 | 売上冊数 | アップグレード冊数 |
 *   当月合計冊数 | 累計冊数 | 支払額 | 管理番号 | 出版社名
 *
 * GT matching (verified 112/112 for 202604):
 *   - Rows are episode-level (第N話). Human aggregates to book level.
 *   - total_amount_jpy   = round_half_up( Σ 価格×(売上冊数+アップグレード冊数) × 1.10 )
 *   - after_tax_jpy      = Σ 価格×(売上冊数+アップグレード冊数)               (pre-tax sale)
 *   - before_tax_income  = Σ 支払額 + floor(Σ 支払額 × 0.10) = floor(Σ 支払額 × 1.10)
 *   - consumption_tax    = floor(Σ 支払額 × 0.10)
 *   - after_tax_income   = Σ 支払額                                          (raw pay)
 *   - rs_rate            = 0.37  (fixed, 支払率=37 in all rows)
 *
 * Title normalization: strip 【フルカラー】, episode tails (第N話, N話, 外伝N),
 * volume suffixes (（N）, 【特装版】N, 【分冊版】N) and tilde/bracket variants.
 *
 * Type classification: 分冊版/連載版 → EP, 特装版 → EB, タテコミ without 改訂版
 * and without 完全版 is WR iff a 完全版 sibling exists in the file (else WT).
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import iconv from "iconv-lite";
import Papa from "papaparse";
import aliases from "../../data/aliases/renta.json" with { type: "json" };
import { readWorkbook, sheetToMatrix } from "./common";

const TAX_RATE = 0.10;
const RS_RATE = 0.37;

type CsvRow = Record<string, string>;

/** Apply unicode & whitespace normalization used for dictionary keys (stable comparison form). */
function canonicalTitle(s: string): string {
  let t = s ?? "";
  if (aliases.normalization.tilde_full_to_wave) t = t.replace(/〜/g, "～"); // U+301C → U+FF5E
  if (aliases.normalization.fullwidth_brackets_to_half) t = t.replace(/［/g, "[").replace(/］/g, "]");
  if (aliases.normalization.collapse_whitespace) t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Strip episode/volume markers so all raw rows of one book collapse to the same string. */
function stripMarkers(title: string): string {
  let t = title;
  for (const rule of aliases.normalization.strip_suffix_regex) {
    const re = new RegExp(rule.pattern, (rule as { flags?: string }).flags ?? "");
    const replacement = (rule as { replace?: string }).replace ?? "";
    t = t.replace(re, replacement).trim();
  }
  return t;
}

/** Title used for GT matching: strip markers first, THEN canonicalize (tilde/bracket). */
function rawToChannelTitle(raw: string): string {
  return canonicalTitle(stripMarkers(raw));
}

/** Golden INPUT keeps full-width Japanese brackets in emitted titles. */
function displayTitle(title: string): string {
  return title.replace(/\[/g, "［").replace(/\]/g, "］");
}

/** Base key ignoring 完全版 / 改訂版 decorations — used for 完全版-sibling detection. */
function baseKey(channelTitle: string): string {
  return channelTitle
    .replace(/\s*\[完全版\]\s*/g, "")
    .replace(/\s*【完全版】\s*/g, "")
    .replace(/\s*\[改訂版\]\s*/g, "")
    .replace(/\s*【改訂版】\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Preliminary type based on the raw title's markers alone. 'WT?' means 'needs sibling check'. */
function prelimType(rawTitle: string): "EP" | "EB" | "WR" | "WT" | "WT?" {
  if (rawTitle.includes("【分冊版】")) return "EP";
  if (rawTitle.includes("【連載版】")) return "EP";
  if (rawTitle.includes("【特装版】")) return "EB";
  if (rawTitle.includes("【タテコミ】")) {
    if (rawTitle.includes("改訂版")) return "WR";
    if (rawTitle.includes("完全版")) return "WT";
    return "WT?";
  }
  if (/[（(]\d+[）)]$/.test(rawTitle)) return "EB";
  return "EB";
}

type Aggregate = {
  title_jp: string;        // canonicalized title (GT channel_title_jp form)
  type: "EP" | "EB" | "WR" | "WT";
  units: number;
  units_upgrade: number;
  raw_sales: number;       // Σ 価格 × (売上冊数 + アップグレード冊数)
  raw_pay: number;         // Σ 支払額
  row_count: number;
};

function numCell(v: string | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5 + 1e-9); // tiny epsilon to guard against FP drift (e.g. 4939.7 → 4940)
}

function floor(x: number): number {
  return Math.floor(x + 1e-9);
}

export async function parseRenta({ filename, buffer }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename)) {
    return { platform_code: "renta", sales_month: null, settlement_month: null, records: [], errors: [] };
  }

  const rows = readRows(filename, buffer);

  // Pass 1: collect the set of base keys that have a 完全版 variant (within 【タテコミ】
  // scope, excluding 分冊版/連載版/特装版). This drives the WT-vs-WR decision for
  // 'original' タテコミ rows that carry no 完全版/改訂版 marker.
  const basesWithKanzen = new Set<string>();
  for (const r of rows) {
    const raw = String(r["書名"]);
    if (!raw.includes("【タテコミ】")) continue;
    if (raw.includes("【分冊版】") || raw.includes("【連載版】") || raw.includes("【特装版】")) continue;
    if (!raw.includes("完全版")) continue;
    basesWithKanzen.add(baseKey(rawToChannelTitle(raw)));
  }

  // Pass 2: aggregate by (normalized_title, type).
  const agg = new Map<string, Aggregate>();
  for (const r of rows) {
    const raw = String(r["書名"]);
    const channelTitle = rawToChannelTitle(raw);
    const preliminary = prelimType(raw);
    let type: Aggregate["type"];
    if (preliminary === "WT?") {
      type = basesWithKanzen.has(baseKey(channelTitle)) ? "WR" : "WT";
    } else {
      type = preliminary;
    }

    const price = numCell(r["価格"]);
    const units = numCell(r["売上冊数"]);
    const upgrade = numCell(r["アップグレード冊数"]);
    const pay = numCell(r["支払額"]);
    const rowSales = price * (units + upgrade);

    const key = `${type}::${channelTitle}`;
    const prev = agg.get(key);
    if (prev) {
      prev.units += units;
      prev.units_upgrade += upgrade;
      prev.raw_sales += rowSales;
      prev.raw_pay += pay;
      prev.row_count += 1;
    } else {
      agg.set(key, {
        title_jp: channelTitle,
        type,
        units,
        units_upgrade: upgrade,
        raw_sales: rowSales,
        raw_pay: pay,
        row_count: 1,
      });
    }
  }

  // Emit one record per (title, type). Include ALL aggregates even if sales=0
  // so we match GT rows with total=0 (many exist for inactive titles).
  const records: ParseResult["records"] = [];
  let i = 0;
  for (const a of agg.values()) {
    const title = displayTitle(a.title_jp);
    const total_amount_jpy = roundHalfUp(a.raw_sales * (1 + TAX_RATE));
    const consumption_tax_jpy = floor(a.raw_pay * TAX_RATE);
    const before_tax_income_jpy = a.raw_pay + consumption_tax_jpy; // = floor(raw_pay * 1.10)
    const after_tax_income_jpy = a.raw_pay;

    records.push({
      row_index: i++,
      data: {
        client_code: aliases.client_code,
        channel_code: aliases.channel_code,
        type: a.type,
        title_jp: title,
        channel_title_jp: title,
        raw_title: a.title_jp,
        units: a.units,
        units_upgrade: a.units_upgrade,
        gross_jpy: total_amount_jpy,
        total_amount_jpy,
        before_tax_jpy: total_amount_jpy,
        after_tax_jpy: a.raw_sales,
        before_tax_income_jpy,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_label: "37%",
        rs_rate_hint: RS_RATE,
        fee_jpy: 0,
        withholding_tax_jpy: 0,
      },
    });
  }

  // Filename: PAS02181-A-202602rnt_jp.csv → 202602.
  // Settlement month is two months later (sales 2026-02 settles 2026-04).
  const m = filename.match(/-(\d{4})(\d{2})rnt_/);
  const salesMonth = m ? `${m[1]}-${m[2]}-01` : null;
  const settlementMonth = salesMonth ? addMonths(salesMonth, 2) : null;

  return {
    platform_code: "renta",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors: [],
  };
}

function readRows(filename: string, buffer: Buffer): CsvRow[] {
  if (/\.xlsx$/i.test(filename)) {
    const wb = readWorkbook(buffer);
    const matrix = sheetToMatrix(wb, wb.SheetNames[0]);
    const header = (matrix[0] ?? []).map((cell) => String(cell ?? "").trim());
    return matrix.slice(1)
      .map((row) => Object.fromEntries(header.map((name, i) => [name, String(row[i] ?? "").trim()])) as CsvRow)
      .filter((r) => r && (r["書名"] ?? "").trim() !== "");
  }
  const text = iconv.decode(buffer, "shift_jis");
  const parsed = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: true });
  return parsed.data.filter((r: CsvRow) => r && (r["書名"] ?? "").trim() !== "");
}

function addMonths(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m ?? 1) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
