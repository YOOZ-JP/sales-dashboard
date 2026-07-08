/**
 * MBJ (Media Do Books Japan) parser — old binary .xls (single sheet).
 *
 * MBJ distributes digital comics to multiple bookstore sites. Each raw file
 * covers exactly one bookstore site and comes in a separate .xls:
 *
 *   - `416829-202603-LI-54575Apple Books(Multi)-都度-202601.xls`          (Apple Books)
 *   - `416829-202603-LI-54846アニメイトブックストア(Multi)-都度-202601.xls` (Animate Bookstore)
 *
 * Both files share the same schema:
 *
 *   Pre-header rows 0-8   : document metadata (発行日, 御中, 【書店サイト:...】 banner)
 *   Row 9                 : header  — 書籍code, SKU, クレジット, カテゴリ, 区分, タイトル,
 *                                       著者名, フォーマット, 販売単価, 分配料率, 分配単価,
 *                                       売上冊数, 売上金額, 支払金額
 *   Row 10..N-2           : detail rows (one per volume/episode)
 *   Last row              : 合計 totals (skipped)
 *
 * Derivation rules (reverse-engineered against the 5 MBJ rows in 202604 GT):
 *
 *  1. Drop the '合計' totals row, empty rows, and pre-header banner rows.
 *  2. Derive series title from detail `タイトル`:
 *       - Episode suffix: strip trailing `第N話` (also 第N.M話 etc.)
 *       - Volume suffix:  strip trailing `（N）` / `（N～N）` (full-width parens, digits).
 *  3. Type resolution (per raw row, then aggregated to series):
 *       - フォーマット contains 'webtoon'        → WT
 *       - タイトル contains '【分冊版】'           → EP
 *       - タイトル has a volume suffix `（N）`    → EB
 *       - title contains '［完全版］' or '【特装版】' and format EPUB 3 → EB
 *       - else                                   → EB  (safe default for 巻)
 *     All detail rows in one series always share a single type.
 *  4. Group by (series, type). Each group = one GT row.
 *  5. Tax rules:
 *       total_amount_jpy     = round(Σ 売上金額 × 1.10)     (raw is tax-exclusive)
 *       before_tax_jpy       = same as total_amount_jpy
 *       after_tax_jpy        = Σ 売上金額                    (tax-exclusive gross)
 *       before_tax_income_jpy= floor(Σ 支払金額 × 1.10)      ← truncates, not rounds
 *       after_tax_income_jpy = Σ 支払金額
 *       consumption_tax_jpy  = before_tax_income - Σ 支払金額
 *       withholding_tax_jpy  = 0   (inter-corporate JP)
 *  6. rs_rate = average of 分配料率 in the group (raw already reports decimals like 0.6/0.5).
 *     rs_label: when the group mixes rates (e.g. 0.5 and 0.6 for webtoon) we emit '50/60%';
 *     otherwise e.g. '60%'. GT uses the same convention.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix } from "./common";

const REQUIRED_HEADERS = [
  "書籍code",
  "タイトル",
  "フォーマット",
  "分配料率",
  "売上金額",
  "支払金額",
];

interface DetailRow {
  title: string;
  format: string;
  rate: number;
  sales: number;
  pay: number;
}

interface Group {
  series: string;
  type: string;
  sales: number;
  pay: number;
  rates: Set<number>;
  rowCount: number;
}

export async function parseMbj({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename)) {
    return { platform_code: "mbj", sales_month: null, settlement_month: null, records: [], errors: [] };
  }
  const wb = readWorkbook(buffer);
  const errors: string[] = [];

  const groups = new Map<string, Group>();
  const sheetName = wb.SheetNames[0];
  const matrix = sheetToMatrix(wb, sheetName);
  const headerIdx = findHeaderRow(matrix);
  if (headerIdx < 0) {
    errors.push(`could not find header row in ${filename}`);
    return {
      platform_code: "mbj",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors,
    };
  }
  const header = matrix[headerIdx] as unknown[];
  const col: Record<string, number> = {};
  header.forEach((cell, j) => {
    const key = String(cell ?? "").trim();
    if (key) col[key] = j;
  });

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    const first = strOr(row[0]);
    // Skip totals ('合計'), fully-empty rows, and any leftover banner text.
    if (!first) continue;
    if (first.startsWith("合計")) continue;

    const title = strOr(row[col["タイトル"]]);
    const format = strOr(row[col["フォーマット"]]);
    if (!title) continue;

    const detail: DetailRow = {
      title,
      format,
      rate: numOr0(row[col["分配料率"]]),
      sales: numOr0(row[col["売上金額"]]),
      pay: numOr0(row[col["支払金額"]]),
    };

    const series = normalizeSeries(detail.title);
    const type = resolveType(detail);
    const key = `${series}|${type}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        series,
        type,
        sales: 0,
        pay: 0,
        rates: new Set<number>(),
        rowCount: 0,
      };
      groups.set(key, g);
    }
    g.sales += detail.sales;
    g.pay += detail.pay;
    if (detail.rate > 0) g.rates.add(roundRate(detail.rate));
    g.rowCount += 1;
  }

  const records: RawRecord[] = [];
  let idx = 0;
  for (const g of groups.values()) {
    const series = g.type === "EP" && !g.series.includes("【分冊版】")
      ? `${g.series}【分冊版】`
      : g.series;
    const total = Math.round(g.sales * 1.10);
    const beforeTaxIncome = Math.floor(g.pay * 1.10);
    const consumptionTax = beforeTaxIncome - g.pay;
    const afterTaxIncome = g.pay;
    const afterTax = g.sales;

    const rates = Array.from(g.rates).sort((a, b) => a - b);
    const rsRate = rates.length > 0 ? rates[rates.length - 1] : 0; // highest tier
    const rsLabel =
      rates.length > 1
        ? rates.map(r => Math.round(r * 100)).join("/") + "%"
        : rates.length === 1
          ? `${Math.round(rates[0] * 100)}%`
          : null;

    records.push({
      row_index: idx++,
      data: {
        title_jp: series,
        channel_title_jp: series,
        type: g.type,
        total_amount_jpy: total,
        before_tax_jpy: total,
        after_tax_jpy: afterTax,
        before_tax_income_jpy: beforeTaxIncome,
        after_tax_income_jpy: afterTaxIncome,
        consumption_tax_jpy: consumptionTax,
        withholding_tax_jpy: 0,
        // raw (audit)
        raw_sales_jpy: g.sales,
        raw_payment_jpy: g.pay,
        // rate
        rs_rate: rsRate,
        rs_rate_hint: rsRate,
        rs_label: rsLabel,
        // routing
        channel_code: "mbj_sales",
        client_code: "mbj",
      },
    });
  }

  // Filename e.g. `416829-202603-LI-54575Apple Books(Multi)-都度-202601.xls`:
  //   - 202603 = settlement batch month
  //   - 202601 = sales month (trailing)
  const salesMatch = filename.match(/(\d{6})\.xls$/);
  const salesMonth = salesMatch
    ? `${salesMatch[1].slice(0, 4)}-${salesMatch[1].slice(4)}-01`
    : null;
  const settlementMatch = filename.match(/-(\d{6})-/);
  const settlementMonth = settlementMatch
    ? lastDayOfMonthIso(
        `${settlementMatch[1].slice(0, 4)}-${settlementMatch[1].slice(4)}-01`
      )
    : null;

  return {
    platform_code: "mbj",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

/**
 * Both MBJ files follow the same template: metadata/banner rows, then the real
 * header row (row index 9 in the samples). Detect it by required header cells.
 */
function findHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(20, matrix.length); i++) {
    const row = matrix[i];
    if (!row) continue;
    const cells = row.map(c => String(c ?? "").trim());
    if (REQUIRED_HEADERS.every(h => cells.includes(h))) return i;
  }
  return -1;
}

/**
 * Strip episode / volume suffix from a raw title to produce the GT series name.
 *  - Episode: 'X第10話' → 'X'       (tolerant of trailing spaces)
 *  - Volume:  'X（１）', 'X（10）' → 'X'
 *
 * Uses both full-width and half-width digits. Called per detail row.
 */
function normalizeSeries(title: string): string {
  let t = title.trim();
  // Remove trailing 第N話 or 第N.M話 etc. Can have full/half-width digits.
  t = t.replace(/第[０-９\d]+(?:[．.][０-９\d]+)?話(?:外伝[０-９\d]+)?\s*$/u, "").trim();
  // Remove trailing volume marker like （１）, （10）, （１～３）.
  t = t.replace(/（[０-９\d]+(?:[～〜-][０-９\d]+)?）\s*$/u, "").trim();
  return t;
}

/**
 * Resolve WT / EP / EB per raw row. The group type is the first non-empty
 * resolution of any of its rows (they're consistent in practice).
 */
function resolveType(d: DetailRow): string {
  const fmt = (d.format || "").toLowerCase();
  if (d.title.includes("【分冊版】")) return "EP";
  if (/第[０-９\d]+(?:[．.][０-９\d]+)?話/u.test(d.title)) return "EP";
  if (fmt.includes("webtoon")) return "WT";
  // Volume suffix detection
  if (/（[０-９\d]+(?:[～〜-][０-９\d]+)?）/.test(d.title)) return "EB";
  // Full-edition / special edition markers without a volume suffix still ship
  // as 巻-style EB.
  if (d.title.includes("［完全版］") || d.title.includes("【特装版】")) return "EB";
  return "EB";
}

function roundRate(r: number): number {
  // Snap to 2 decimal places so 0.59999 / 0.6 / 0.60000000001 coalesce.
  return Math.round(r * 100) / 100;
}

function lastDayOfMonthIso(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

function strOr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function numOr0(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[,¥￥\s円]/g, ""));
  return isFinite(n) ? n : 0;
}
