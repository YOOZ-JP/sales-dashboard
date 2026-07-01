/**
 * Piccoma EPUB 外販 (external EPUB distribution) parser — XLSX.
 *
 * Context
 * -------
 * Piccoma (カカオピッコマ) acts as an agent to distribute our EPUBs on other
 * Japanese ebook stores (Kindle, ブックライブ, まんがセゾン, U-NEXT,
 * コミックシーモア, ebookjapan, パピレス, DMM, …). Each month they remit a
 * consolidated royalty report per title.
 *
 * Input files (folder /202603_ピッコマ外販/):
 *   1. `外販お支払報告書 {YYYYMM} （{Y}年{M}月〆報告分）_RIVERSE_ver{n}.xlsx`
 *      - Sheet "【巻】外販お支払報告書" — per (店舗 × 巻 × 対象月) detail
 *        with columns: 対象年月 | 販売先 | 発行元 | 対象作品 | 巻数 | 受領額 |
 *        分配料率 | 分配金. Authoritative source.
 *      - Sheet "【巻】要約" — per-title summary (cross-check).
 *   2. `【請求書】ピッコマEPUB外販ロイヤリティー_{YYYYMM}_…xlsx`
 *      - Invoice with a single consolidated line per title — cross-check only.
 *   3. `.pdf` — ignored.
 *
 * Ground-truth mapping (GT channel = `piccoma_sales`, single row per title):
 *   after_tax_jpy         = Σ(受領額)   per 対象作品
 *   total_amount_jpy      = round(after_tax_jpy × 1.10)
 *   before_tax_jpy        = total_amount_jpy                (fee_jpy = 0)
 *   after_tax_income_jpy  = Σ(分配金)   per 対象作品
 *   consumption_tax_jpy   = round(after_tax_income_jpy × 0.10)
 *   before_tax_income_jpy = after_tax_income_jpy + consumption_tax_jpy
 *   rs_rate               = 分配料率 / 100   (uniform per title, e.g. 60 → 0.60)
 *   type                  = EB    (external EPUB distribution = ebook/volume)
 *   distribution_strategy = exclusive
 *
 * Verified against 202604 GT for title "4000年ぶりに帰還した大魔導士":
 *   Σ受領額 = 55707  → total 61278 ✓
 *   Σ分配金 = 33424  → ctax 3342, bti 36766 ✓   (matches GT exactly)
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";
import aliases from "../../data/aliases/piccoma-gaiakuhan.json" with { type: "json" };

const PRIMARY_SHEET = aliases.source_files.payment_report.primary_sheet;
const HEADER_LABEL = aliases.source_files.payment_report.header_row_label;
const INVOICE_PATTERN = new RegExp(aliases.source_files.invoice.pattern);
const REPORT_PATTERN = new RegExp(aliases.source_files.payment_report.pattern);

const DEFAULT_TYPE = aliases.defaults.type;
const DEFAULT_DIST = aliases.defaults.distribution_strategy;
const DEFAULT_COUNTRY = aliases.defaults.country;
const CHANNEL = aliases.defaults.channel_code;
const CLIENT = aliases.client_code;

interface Agg {
  title: string;
  sales: number;        // Σ 受領額
  share: number;        // Σ 分配金
  rateSum: number;
  rateCount: number;
  stores: Set<string>;
  months: Set<string>;
  volumes: Set<number>;
  rowCount: number;
}

function looksLikePdf(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

/** Extract the reporting month (YYYY-MM-01) from filename. */
function extractReportMonth(filename: string): string | null {
  // "外販お支払報告書 202604 （2026年3月〆報告分）_..." — the 202604 is the
  // *settlement* (報告) month. The embedded "3月〆" hints the sales month is
  // the month prior, matching the GT convention (sales_month = 2026-03-01).
  const shimeMatch = filename.match(/(\d{4})年\s*(\d{1,2})月〆/);
  if (shimeMatch) {
    return `${shimeMatch[1]}-${String(shimeMatch[2]).padStart(2, "0")}-01`;
  }
  // Fallback: a bare YYYYMM somewhere.
  const m = filename.match(/(\d{4})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/** Month-end ISO date for the settlement month: "YYYY-MM" → "YYYY-MM-DD". */
function monthEnd(iso: string | null): string | null {
  if (!iso) return null;
  const [y, mm] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, mm, 0));
  return d.toISOString().slice(0, 10);
}

/** Next month first-of-month: "2026-03-01" → "2026-04-01". */
function nextMonth(iso: string | null): string | null {
  if (!iso) return null;
  const [y, mm] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, mm, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Find the header row index in the detail sheet (row containing `対象年月`). */
function findHeaderRow(matrix: unknown[][]): { row: number; cols: Record<string, number> } | null {
  for (let i = 0; i < Math.min(30, matrix.length); i++) {
    const row = matrix[i];
    if (!row) continue;
    const idx = row.findIndex((c) => String(c ?? "").trim() === HEADER_LABEL);
    if (idx < 0) continue;
    const cols: Record<string, number> = {};
    row.forEach((c, j) => {
      const key = String(c ?? "").trim();
      if (key) cols[key] = j;
    });
    return { row: i, cols };
  }
  return null;
}

export async function parsePiccomaGaiakuhan({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];
  const salesMonth = extractReportMonth(filename);
  // settlement follows the sales month by one month; matches BookLive / cmoa convention
  const settlementMonth = nextMonth(salesMonth);

  if (looksLikePdf(filename)) {
    return {
      platform_code: "piccoma_gaiakuhan",
      sales_month: salesMonth,
      settlement_month: settlementMonth,
      records: [],
      errors: ["piccoma_gaiakuhan: PDF file ignored"],
    };
  }

  // Invoice file is a cross-check only — don't double count.
  if (INVOICE_PATTERN.test(filename)) {
    return {
      platform_code: "piccoma_gaiakuhan",
      sales_month: salesMonth,
      settlement_month: settlementMonth,
      records: [],
      errors: ["piccoma_gaiakuhan: invoice XLSX is a cross-check; no rows emitted"],
    };
  }

  // Accept both the named-pattern report and unknown .xlsx by best-effort.
  if (!REPORT_PATTERN.test(filename)) {
    errors.push(
      `piccoma_gaiakuhan: filename does not match expected report pattern — treating as report anyway (${filename})`,
    );
  }

  const wb = readWorkbook(buffer);
  const sheetName = wb.SheetNames.includes(PRIMARY_SHEET)
    ? PRIMARY_SHEET
    : wb.SheetNames.find((n) => n.includes("外販お支払報告書")) ?? wb.SheetNames[0];

  const matrix = sheetToMatrix(wb, sheetName);
  const header = findHeaderRow(matrix);
  if (!header) {
    return {
      platform_code: "piccoma_gaiakuhan",
      sales_month: salesMonth,
      settlement_month: settlementMonth,
      records: [],
      errors: [
        `piccoma_gaiakuhan: header row not found in sheet "${sheetName}"`,
        ...errors,
      ],
    };
  }

  const C = header.cols;
  const required = ["対象年月", "対象作品", "受領額", "分配料率", "分配金"];
  for (const h of required) {
    if (!(h in C)) {
      errors.push(`piccoma_gaiakuhan: missing expected column "${h}" in sheet "${sheetName}"`);
    }
  }

  // Aggregate per 対象作品 (title)
  const byTitle = new Map<string, Agg>();

  for (let i = header.row + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;

    const ym = String(row[C["対象年月"]] ?? "").trim();
    const title = String(row[C["対象作品"]] ?? "").trim();
    const rateCell = row[C["分配料率"]];

    // Footer / blank rows:
    //   - 対象年月 blank AND title blank → skip (totals / trailing)
    //   - 分配料率 column contains "合計" / "消費税" / "支払金額" labels → skip
    if (!ym && !title) continue;
    if (typeof rateCell === "string" && /合計|消費税|支払金額/.test(rateCell)) continue;
    if (!title) continue; // defensive: row without a title isn't a detail line

    const store = String(row[C["販売先"] ?? -1] ?? "").trim();
    const volRaw = row[C["巻数"] ?? -1];
    const volume = typeof volRaw === "number" ? volRaw : toNumber(volRaw);
    const juryou = toNumber(row[C["受領額"]]);
    const bunpai = toNumber(row[C["分配金"]]);
    const rate = toNumber(rateCell);

    let g = byTitle.get(title);
    if (!g) {
      g = {
        title,
        sales: 0,
        share: 0,
        rateSum: 0,
        rateCount: 0,
        stores: new Set(),
        months: new Set(),
        volumes: new Set(),
        rowCount: 0,
      };
      byTitle.set(title, g);
    }
    g.sales += juryou;
    g.share += bunpai;
    if (rate > 0) {
      g.rateSum += rate;
      g.rateCount += 1;
    }
    if (store) g.stores.add(store);
    if (ym) g.months.add(ym);
    if (volume) g.volumes.add(volume);
    g.rowCount += 1;
  }

  const records: RawRecord[] = [];
  let idx = 0;
  for (const g of byTitle.values()) {
    const after_tax_jpy = Math.round(g.sales);
    const total_amount_jpy = Math.round(after_tax_jpy * 1.10);
    const before_tax_jpy = total_amount_jpy;

    const after_tax_income_jpy = Math.round(g.share);
    const consumption_tax_jpy = Math.round(after_tax_income_jpy * 0.10);
    const before_tax_income_jpy = after_tax_income_jpy + consumption_tax_jpy;

    // Rate column holds a whole-number percentage (e.g. 60 → 0.60).
    const rsRaw = g.rateCount > 0 ? g.rateSum / g.rateCount : 0;
    const rs_rate = rsRaw > 1 ? rsRaw / 100 : rsRaw;

    records.push({
      row_index: idx++,
      data: {
        sales_month: salesMonth,
        country: DEFAULT_COUNTRY,
        client_code: CLIENT,
        channel_code: CHANNEL,
        type: DEFAULT_TYPE,
        distribution_strategy: DEFAULT_DIST,

        title_jp: g.title,
        channel_title_jp: g.title,

        // Amounts (GT-aligned)
        gross_jpy: total_amount_jpy,
        total_amount_jpy,
        fee_jpy: 0,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        withholding_tax_jpy: 0,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_rate,
        rs_label: `${Math.round(rs_rate * 100)}%`,

        // Raw passthrough for audit
        raw_sales_jpy: g.sales,
        raw_payment_jpy: g.share,
        raw_stores: Array.from(g.stores),
        raw_months: Array.from(g.months),
        raw_volumes: Array.from(g.volumes).sort((a, b) => a - b),
        raw_row_count: g.rowCount,
      },
    });
  }

  return {
    platform_code: "piccoma_gaiakuhan",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

/** Re-exports for verify scripts that want to call helpers directly. */
export const __testables = {
  extractReportMonth,
  nextMonth,
  monthEnd,
  findHeaderRow,
};
