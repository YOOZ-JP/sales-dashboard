/**
 * Mangabang (Amazia / マンガBANG!) parser — 202603 raw folder.
 *
 * Folder contents for a single settlement month:
 *   mangabang_RIVERSE_ticket_YYYYMM.csv   — per-episode ticket detail (Shift-JIS)
 *   RIVERSE様_支払通知書.xlsx             — 1-page cover letter with grand totals only
 *   RIVERSE様_支払通知書.pdf              — printable version of the xlsx (ignored)
 *
 * The CSV is authoritative. The xlsx has no per-title breakdown — just the
 * aggregate 総収益(税込) and 版権元(税込) matching the CSV grand totals.
 *
 * CSV layout (Shift-JIS, 13 columns):
 *   row 0 : sparse summary line ",,,,,,,{総収益},,,{版権元税込},,"
 *   row 1 : header (年月, 出版社, タイトル名, 話, 販売件数, 単価（税込）,
 *                   単価（税抜）, 総収益, 総収益（税抜）, 版権料率,
 *                   版権元収益（税込）, 巻番号, 管理コード)
 *   row 2+: per (title × 話) rows. One row per combination; Amazia sometimes
 *           splits the same episode into two CSV rows with split units.
 *
 * GT row = one row per title (5 titles → 5 rows).
 *
 * FORMULA (derived from 3 non-zero rows; 0-value titles trivially match):
 *   sum_excl       = Σ (総収益（税抜）)        -- int (already whole yen per row)
 *   sum_pub_incl   = Σ (版権元収益（税込）)    -- float (67×0.35=23.45 per unit)
 *
 *   total_amount_jpy       = round(sum_excl × 1.10)
 *   before_tax_jpy         = total_amount_jpy            (no fee layer)
 *   after_tax_jpy          = sum_excl
 *   before_tax_income_jpy  = round(sum_pub_incl)         (±1¥ tolerance OK)
 *   consumption_tax_jpy    = floor(before_tax_income_jpy × 10 / 110)
 *   after_tax_income_jpy   = before_tax_income_jpy - consumption_tax_jpy
 *
 *   rs_rate                = 0.35  (raw 版権料率 column confirms for every row)
 *   fee_jpy / withholding  = 0
 *
 * TITLE NORMALIZATION
 *   raw U+301C wave-dash '〜'  →  canonical U+FF5E full-width tilde '～'
 *     (only affects 融点〜とけあい〜【タテヨミ】)
 *
 * TYPE
 *   The detail CSV is authoritative vertical evidence: 【タテヨミ】 → WT, and
 *   the config default (WT) covers the rest. No per-title overrides — a type
 *   conflict with the prior contract ledger is reconciled at carry-forward,
 *   not by re-tagging source rows.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import Papa from "papaparse";
import iconv from "iconv-lite";
import fs from "node:fs";
import path from "node:path";

interface AliasConfig {
  title_rules: Array<{ pattern: string; replace: string }>;
  default_type: string;
  default_rs: number;
}

let aliasCache: AliasConfig | null = null;

function loadAliases(): AliasConfig {
  if (aliasCache) return aliasCache;
  const candidates = [
    path.resolve(process.cwd(), "src/features/settlement/data/aliases/mangabang.json"),
    path.resolve(process.cwd(), "../data/aliases/mangabang.json"),
    path.resolve(__dirname, "../../data/aliases/mangabang.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      aliasCache = {
        title_rules: j.title_normalization ?? [],
        default_type: j.type_rules?.[0]?.type ?? "WT",
        default_rs: j.default_rs ?? 0.35,
      };
      return aliasCache;
    }
  }
  aliasCache = {
    title_rules: [{ pattern: "〜", replace: "～" }],
    default_type: "WT",
    default_rs: 0.35,
  };
  return aliasCache;
}

/** Raw U+301C wave-dash → canonical U+FF5E full-width tilde. */
export function normalizeMangabangTitle(s: string): string {
  const a = loadAliases();
  let out = s;
  for (const rule of a.title_rules) {
    out = out.split(rule.pattern).join(rule.replace);
  }
  return out;
}

function decodeShiftJis(buffer: Buffer): string {
  try {
    return iconv.decode(buffer, "shift_jis");
  } catch {
    return buffer.toString("utf-8");
  }
}

interface CsvRow {
  "年月": string;
  "出版社": string;
  "タイトル名": string;
  "話": string;
  "販売件数": string;
  "単価（税込）": string;
  "単価（税抜）": string;
  "総収益": string;
  "総収益（税抜）": string;
  "版権料率": string;
  "版権元収益（税込）": string;
  "巻番号": string;
  "管理コード": string;
}

/** `2026年3月` → `2026-03-01`. */
function parseJpYearMonth(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = String(s).match(/(\d{4})年\s*(\d{1,2})月/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-01`;
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

/** First day of month `months` after a YYYY-MM-01 string (UTC-safe). */
function addMonthsFirstOfMonth(iso: string, months: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

/** End of month `months` after a YYYY-MM-01 string (UTC-safe). */
function addMonthsEndOfMonth(iso: string, months: number): string {
  // Day 0 of the following month index = last day of the target month.
  const [y, m] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  return target.toISOString().slice(0, 10);
}

export async function parseMangabang({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];

  // The xlsx / pdf are informational (grand totals). Only the ticket CSV has the per-title data.
  const isCsv = /\.csv$/i.test(filename);
  const isXlsx = /\.xlsx$/i.test(filename);
  const isPdf = /\.pdf$/i.test(filename);

  if (isPdf) {
    return {
      platform_code: "mangabang",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: ["mangabang: PDF payment notice ignored (identical to xlsx, summary only)"],
    };
  }
  if (isXlsx) {
    return {
      platform_code: "mangabang",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [
        "mangabang: xlsx 支払通知書 has grand totals only; per-title data comes from mangabang_RIVERSE_ticket_YYYYMM.csv",
      ],
    };
  }
  if (!isCsv) {
    return {
      platform_code: "mangabang",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`mangabang: unexpected file type: ${filename}`],
    };
  }

  // Detect & decode (Shift-JIS).
  const text = decodeShiftJis(buffer);

  // The CSV has a summary line at row 0 that breaks header-based parsing.
  // Drop it, then parse with header: true.
  const firstNl = text.indexOf("\n");
  const body = firstNl >= 0 ? text.slice(firstNl + 1) : text;

  const parsed = Papa.parse<CsvRow>(body, {
    header: true,
    skipEmptyLines: true,
  });

  // Aggregate per title.
  interface Agg {
    raw_title: string;
    channel_title: string;
    sales_month: string | null;
    units: number;
    sum_excl: number;      // Σ 総収益(税抜)   -- integer per row
    sum_incl: number;      // Σ 総収益(税込)   -- integer per row
    sum_pub_incl: number;  // Σ 版権元(税込)   -- float per row (67*0.35 = 23.45)
    rs_rates: Set<number>;
  }
  const aggs = new Map<string, Agg>();

  for (const r of parsed.data) {
    const rawTitle = (r["タイトル名"] ?? "").trim();
    if (!rawTitle) continue;
    // Defensive filter against total/合計 rows (none observed, but common in JP invoices).
    if (/合計|総合計|TOTAL/i.test(rawTitle)) continue;

    const channelTitle = normalizeMangabangTitle(rawTitle);
    const prev = aggs.get(channelTitle) ?? {
      raw_title: rawTitle,
      channel_title: channelTitle,
      sales_month: parseJpYearMonth(r["年月"]),
      units: 0,
      sum_excl: 0,
      sum_incl: 0,
      sum_pub_incl: 0,
      rs_rates: new Set<number>(),
    };
    prev.units += toNum(r["販売件数"]);
    prev.sum_excl += toNum(r["総収益（税抜）"]);
    prev.sum_incl += toNum(r["総収益"]);
    prev.sum_pub_incl += toNum(r["版権元収益（税込）"]);
    const rsPct = toNum(r["版権料率"]);
    if (rsPct > 0) prev.rs_rates.add(rsPct / 100);
    aggs.set(channelTitle, prev);
  }

  // Derive settlement month from filename YYYYMM (= sales_month + 1); the
  // payout lands at the end of that settlement month.
  const mm = filename.match(/(\d{4})(\d{2})/);
  const sales_month_filename = mm ? `${mm[1]}-${mm[2]}-01` : null;
  const settlement_month = sales_month_filename
    ? addMonthsFirstOfMonth(sales_month_filename, 1)
    : null;
  const deposit_month = sales_month_filename
    ? addMonthsEndOfMonth(sales_month_filename, 1)
    : null;

  const aliases = loadAliases();
  const records: RawRecord[] = [];
  let rowIdx = 0;

  for (const a of aggs.values()) {
    // The detail CSV is authoritative vertical evidence: every row is WT.
    const type = "WT";
    const rs_rate = a.rs_rates.size === 1 ? [...a.rs_rates][0] : aliases.default_rs;

    const total_amount_jpy = Math.round(a.sum_excl * 1.10);
    const before_tax_jpy = total_amount_jpy; // fee = 0
    const after_tax_jpy = Math.round(a.sum_excl); // sum_excl is already integer per row

    const before_tax_income_jpy = Math.round(a.sum_pub_incl);
    const consumption_tax_jpy = Math.floor((before_tax_income_jpy * 10) / 110);
    const after_tax_income_jpy = before_tax_income_jpy - consumption_tax_jpy;

    records.push({
      row_index: rowIdx++,
      data: {
        sales_month: a.sales_month,
        deposit_month,
        channel_title_jp: a.channel_title,
        title_jp: a.channel_title,
        client_code: "amazia",
        channel_code: "mangabang",
        type,
        distribution_strategy: "non-ex",
        total_amount_jpy,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_rate,
        fee_jpy: 0,
        withholding_tax_jpy: 0,
      },
    });
  }

  let sales_month_top = sales_month_filename;
  if (!sales_month_top) {
    // Fallback to the first record's sales_month.
    const firstWithMonth = records.find(r => typeof r.data.sales_month === "string");
    sales_month_top = firstWithMonth ? (firstWithMonth.data.sales_month as string) : null;
  }

  return {
    platform_code: "mangabang",
    sales_month: sales_month_top,
    settlement_month,
    records,
    errors,
  };
}
