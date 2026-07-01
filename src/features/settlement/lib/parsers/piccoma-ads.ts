/**
 * Piccoma 広告 / 動画リワード (video-reward advertising) parser — XLSX.
 *
 * Context
 * -------
 * Kakao Piccoma's video-reward product: users watch a short ad to earn
 * unlock-currency. Every impression converts to a fractional yen revenue and a
 * fractional settlement share. Files are daily rollups per (title × OS).
 *
 * A single settlement month produces TWO files in
 *   /202603/202601_ピッコマ広告/:
 *     1. 動画リワード_株式会社RIVERSE_YYYYMM.xlsx         — main reward log (many titles)
 *     2. 動画リワード_株式会社RIVERSE_砂時計_YYYYMM.xlsx  — separate 砂時計 product
 *
 * Both share the same sheet layout:
 *   Sheet "動画リワード_株式会社RIVERSE": daily per (title × OS) rows
 *     0 日付 | 1 出版社 | 2 書籍ID | 3 作品名 | 4 OS |
 *     5 動画リワード使用件数 | 6 売上金額（税込） | 7 R/S |
 *     8 精算金額(税込み)
 *   Sheet "お支払報告書_YYYYMM": invoice summary (ignored — cross-check only)
 *
 * Ground-truth mapping (channel = `piccoma_ads`, client = `Piccoma`):
 *   One GT row per 作品名 (aggregating across OS × date × both files).
 *
 *   Let sum_sales_c = Σ round(売上金額 × 100)   (integer hundredths, per-row)
 *   Let sum_pay_c   = Σ round(精算金額 × 100)   (integer hundredths, per-row)
 *
 *   after_tax_jpy          = ROUND_HALF_UP(sum_sales_c / 110)      ← col V
 *   after_tax_income_jpy_a = ROUND_HALF_UP(sum_pay_c   / 110)      ← col AA
 *   before_tax_jpy         = ROUND_HALF_UP(after_tax_jpy × 1.10)   ← col U
 *   total_amount_jpy       = fee_jpy + before_tax_jpy = 0 + U      ← col S
 *   consumption_tax_jpy    = ROUNDDOWN(AA × 0.10, 0)               ← col Z
 *   before_tax_income_jpy  = ROUND_HALF_UP(Z + AA)                 ← col X
 *   rs_rate                = 0.25   (fixed; R/S column in raw confirms)
 *   type                   = "AD"
 *
 * The raw 売上金額(税込) cell is already *tax-inclusive* (uses × 143 pts); the
 * GT's AT(税抜) value is therefore `sum_sales / 1.10` rounded half-up. Floating
 * point is untrustworthy at the ¥0.50 boundary — we sum in integer hundredths
 * (cents) and then divide by 110 with an exact half-up rounding.
 *
 * Distribution strategy (exclusive vs non-ex): the raw file does NOT carry this
 * flag. GT pulls it via VLOOKUP from a master title sheet. We mirror that via
 * the `exclusive_titles` list in data/aliases/piccoma-ads.json. Unknown titles
 * default to non-ex.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix } from "./common";
import fs from "node:fs";
import path from "node:path";

const DAILY_SHEET = "動画リワード_株式会社RIVERSE";

// -- alias loader ----------------------------------------------------------
interface PiccomaAdsAliases {
  /** List of titles that should be marked distribution_strategy = "exclusive" */
  exclusive_titles: string[];
  /** Optional: type_overrides, but default is always "AD" */
  type_overrides?: Record<string, string>;
}

let _aliases: PiccomaAdsAliases | null = null;
function loadAliases(): PiccomaAdsAliases {
  if (_aliases) return _aliases;
  const candidates = [
    path.resolve(process.cwd(), "src/features/settlement/data/aliases/piccoma-ads.json"),
    path.resolve(process.cwd(), "../data/aliases/piccoma-ads.json"),
    path.resolve(__dirname, "../../data/aliases/piccoma-ads.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      _aliases = {
        exclusive_titles: j.exclusive_titles ?? [],
        type_overrides: j.type_overrides ?? {},
      };
      return _aliases;
    }
  }
  _aliases = { exclusive_titles: [], type_overrides: {} };
  return _aliases;
}

// -- arithmetic helpers ----------------------------------------------------

/** Integer hundredths (cents) from a JS float, avoiding the 7711.99 * 100 = 771198.9999 trap. */
function toCents(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return 0;
  // Use toFixed(2) to snap to exact 2-decimal integer cents (raw file always has ≤2dp).
  return Math.round(Number(n.toFixed(2)) * 100);
}

/**
 * ROUND_HALF_UP(a / b) for non-negative integers a, b.
 *
 * Equivalent to Excel's ROUND(x, 0) where x = a/b and x >= 0. Uses integer
 * math to avoid float precision at the exact .5 boundary (e.g. 192775/110
 * is 1752.5 which must round to 1753, not 1752).
 */
function roundHalfUpDiv(a: number, b: number): number {
  if (b === 0) return 0;
  // (2a + b) / (2b) floor = half-up for positive a,b.
  return Math.floor((2 * a + b) / (2 * b));
}

/** ROUND_HALF_UP(n × 11 / 10) — i.e. `×1.10` with Excel-style rounding. */
function roundHalfUpTimes11Div10(n: number): number {
  // = round_half_up(11n/10) = floor((22n + 10) / 20) = floor((11n + 5)/10) for n>=0
  return Math.floor((11 * n + 5) / 10);
}

/** ROUNDDOWN(n × 0.1, 0) — integer floor of n/10 for n>=0. */
function floorDiv10(n: number): number {
  return Math.floor(n / 10);
}

// -- daily-sheet reader -----------------------------------------------------

interface TitleAgg {
  title: string;
  salesCents: number;
  payCents: number;
  rowCount: number;
  rsValues: Set<number>;
  osValues: Set<string>;
  dates: Set<string>;
}

/**
 * Read the daily-log sheet and accumulate per-title integer-cent sums.
 * Returns the raw date strings so we can infer the sales month.
 */
function aggregateDaily(buffer: Buffer, acc: Map<string, TitleAgg>): {
  dateStrings: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const wb = readWorkbook(buffer);
  if (!wb.Sheets[DAILY_SHEET]) {
    errors.push(`missing sheet: ${DAILY_SHEET}`);
    return { dateStrings: [], errors };
  }
  const matrix = sheetToMatrix(wb, DAILY_SHEET);
  // Row 0 is the header.
  const dateStrings: string[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    const title = row[3];
    if (!title || typeof title !== "string") continue;
    const trimmed = title.trim();
    if (!trimmed) continue;
    const sales = toCents(row[6]);
    const pay = toCents(row[8]);
    if (sales === 0 && pay === 0) continue; // skip zero/empty rows
    let g = acc.get(trimmed);
    if (!g) {
      g = {
        title: trimmed,
        salesCents: 0,
        payCents: 0,
        rowCount: 0,
        rsValues: new Set(),
        osValues: new Set(),
        dates: new Set(),
      };
      acc.set(trimmed, g);
    }
    g.salesCents += sales;
    g.payCents += pay;
    g.rowCount += 1;
    const rsCell = row[7];
    if (typeof rsCell === "number") g.rsValues.add(rsCell);
    const osCell = row[4];
    if (typeof osCell === "string") g.osValues.add(osCell);
    const dateCell = row[0];
    if (typeof dateCell === "string") {
      g.dates.add(dateCell);
      dateStrings.push(dateCell);
    }
  }
  return { dateStrings, errors };
}

/**
 * Translate a Japanese date cell like '2026年01月01日' to 'YYYY-MM-01' for the
 * sales_month field. Assumes all rows in a single file share the same month.
 */
function inferSalesMonth(dateStrings: string[]): string | null {
  for (const s of dateStrings) {
    const m = s.match(/(\d{4})[年\-/](\d{1,2})[月\-/]/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-01`;
  }
  return null;
}

/** Add N months (N may be negative) to an ISO yyyy-mm-01. */
function addMonths(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** End-of-month date for an ISO yyyy-mm-01. */
function endOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// -- public entry ----------------------------------------------------------

export async function parsePiccomaAds({
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const aliases = loadAliases();
  const exclusiveSet = new Set(aliases.exclusive_titles);

  // Each Piccoma-ads file now emits its own rows. On Vercel we can't
  // scan the local filesystem for a sibling (the raw-folder mount doesn't
  // exist), and the upload UI already ships both files individually, so
  // keeping the old "fold 砂時計 into main" logic meant 砂時計 silently
  // went missing whenever the main file was uploaded without its sibling
  // on the same disk. The 砂時計 xlsx holds exactly one title ('悪女は
  // 砂時計をひっくり返す') which doesn't appear in the main file, so
  // treating them as independent files produces no duplicates.
  const agg = new Map<string, TitleAgg>();
  const errors: string[] = [];

  const mainResult = aggregateDaily(buffer, agg);
  errors.push(...mainResult.errors);

  const salesMonth = inferSalesMonth(mainResult.dateStrings);
  // Settlement lag = 3 months, settlement = last day of (sales_month + 3).
  // Deposit   lag = 4 months, deposit    = last day of (sales_month + 4).
  const settlementMonth = salesMonth ? endOfMonth(addMonths(salesMonth, 3)) : null;
  const depositMonth = salesMonth ? endOfMonth(addMonths(salesMonth, 4)) : null;

  const records: RawRecord[] = [];
  let idx = 0;

  for (const g of agg.values()) {
    // GT formula chain — all rounding exactly matches Excel.
    const after_tax_jpy = roundHalfUpDiv(g.salesCents, 110); // V = round(sales/1.1)
    const after_tax_income_jpy = roundHalfUpDiv(g.payCents, 110); // AA
    const before_tax_jpy = roundHalfUpTimes11Div10(after_tax_jpy); // U = round(V*1.1)
    const total_amount_jpy = 0 + before_tax_jpy; // S = T + U
    const consumption_tax_jpy = floorDiv10(after_tax_income_jpy); // Z = rounddown(AA*0.1)
    const before_tax_income_jpy = consumption_tax_jpy + after_tax_income_jpy; // X = round(Z+AA) — Z,AA ints already

    const type = aliases.type_overrides?.[g.title] ?? "AD";
    const distribution_strategy = exclusiveSet.has(g.title) ? "exclusive" : "non-ex";

    // rs_rate: R/S column in raw; fallback to 0.25 (observed constant).
    const rs_rate = g.rsValues.size > 0
      ? [...g.rsValues].reduce((a, b) => a + b, 0) / g.rsValues.size
      : 0.25;

    records.push({
      row_index: idx++,
      data: {
        sales_month: salesMonth,
        settlement_month: settlementMonth,
        deposit_month: depositMonth,
        country: "JP",
        client_code: "piccoma",
        channel_code: "piccoma_ads",
        type,
        distribution_strategy,
        title_jp: g.title,
        channel_title_jp: g.title,
        settlement_currency: "JPY",
        vehicle_currency: "KRW",

        // Amounts (GT-aligned integer yen)
        total_amount_jpy,
        fee_jpy: 0,
        before_tax_jpy,
        after_tax_jpy,
        rs_rate,
        rs_label: `${Math.round(rs_rate * 100)}%`,
        before_tax_income_jpy,
        withholding_tax_jpy: 0,
        consumption_tax_jpy,
        after_tax_income_jpy,

        // Raw passthrough for audit
        raw_sales_cents: g.salesCents,
        raw_pay_cents: g.payCents,
        raw_row_count: g.rowCount,
        raw_os_values: [...g.osValues],
        raw_date_count: g.dates.size,
      },
    });
  }

  return {
    platform_code: "piccoma_ads",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

export const __testables = {
  toCents,
  roundHalfUpDiv,
  roundHalfUpTimes11Div10,
  floorDiv10,
  aggregateDaily,
};
