/**
 * Piccoma (Kakao Piccoma JP) parser.
 *
 * The platform emits TWO related files per month:
 *   1. 取次report_株式会社RIVERSE_YYYYMMDD_vN.xlsx    — summary, one row per title
 *      Header on row 3 (index 2); data starts row 4 (index 3). xlsx.sheet_to_json
 *      strips leading empty column A, so in the matrix the 0-based offsets are:
 *        [0] No.
 *        [1] 作品名
 *        [2] 料率              (whole-number %, already the RS)
 *        [3] 精算対象外閲覧件数［話］
 *        [4] 精算対象閲覧件数［話］
 *        [5] 精算対象閲覧件数［巻］
 *        [6] 売上総額（税抜）
 *        [7] 精算対象当月売上［話］(税抜)  — current-month settled sales, 話 portion
 *        [8] 精算対象当月売上［巻］(税抜)  — current-month settled sales, 巻 portion
 *        [9] 精算対象（税抜）
 *       [10] (S)精算対象（税抜）
 *       [11] 最終精算［話］（税抜）       — final settle after MG/deferral, 話
 *       [12] 最終精算［巻］（税抜）       — final settle after MG/deferral, 巻
 *       [13] MG
 *       [14..] recoup, expired MG, etc.
 *
 *   2. 出版社report_株式会社RIVERSE_YYYYMMDD_NNN.xlsx — per-chapter/volume detail
 *      Sheets:
 *        <話売>精算対象使用件数   — per-episode Android/iOS/Web rows; cols include:
 *          [2] 作品名 [14] 売上(税別) [16] 精算金額(税別) [15] R/S
 *        <巻売>精算対象使用件数   — per-volume rows; cols include:
 *          [2] 作品名 [12] 売上(税別) [14] 精算金額(税別)
 *        (other sheets are informational and ignored)
 *
 * Row-level formulas (reverse-engineered, 98/98 match against 202604 GT):
 *
 *   let col_type = (type ∈ {EB,EP}) ? '巻' : '話'
 *   let raw_sales  = Σ detail[col_type] sales per title                        (出版社report)
 *   let raw_settle = max(取次.精算対象当月売上[col_type], 取次.最終精算[col_type])  (取次report)
 *
 *   total_amount_jpy       = excel_round(raw_sales * 1.10)           // round half-up (NOT banker's)
 *   before_tax_jpy         = total_amount_jpy                         // fee_jpy = 0
 *   after_tax_jpy          = round(total_amount_jpy / 1.10)           // == raw_sales up to rounding
 *   before_tax_income_jpy  = floor(raw_settle * 1.10)                 // Excel truncates at ¥1 boundary
 *   after_tax_income_jpy_a = raw_settle                               // raw tax-excluded settle
 *   consumption_tax_jpy    = before_tax_income_jpy - after_tax_income_jpy_a
 *
 * Type derivation (title-level; multiple GT rows per title when raw has both 話 and 巻 flowing):
 *   - If raw 精算対象当月売上[話]>0 OR 最終精算[話]>0 → emit a 話-row:
 *       * ends with "（ノベル）" → WN
 *       * overrides map {title → 'WR'} for editorial/revised webtoons
 *       * else → WT
 *   - If raw 精算対象当月売上[巻]>0 OR 最終精算[巻]>0 → emit a 巻-row:
 *       * overrides map {title → 'EP'} (e.g. 結婚商売【完全版】【分冊版】)
 *       * else → EB
 *
 * Rs rate: the 取次 column "料率" is a whole-number %. For 202604 only two values
 *   appear (26, 35) and these drive GT.rs. Both 話 and 巻 rows share the same rate.
 *
 * Sales month: row 1 of 取次 sheet contains "期間 | 2026.03.1 | ~ | 2026.03.31"; settlement
 *   month is sales+1 month (lag=1).
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber, toIsoMonth } from "./common";
import fs from "node:fs";
import path from "node:path";

const TAX_MULT = 1.10;

/** round half up (Excel ROUND), NOT banker's rounding (Math.round on .5 → down for even). */
function excelRound(x: number): number {
  return Math.floor(x + 0.5);
}

function normalizeRsRate(v: number): number {
  return v > 1 ? v / 100 : v;
}

type TypeOverride = "WT" | "WR" | "WN" | "EB" | "EP";

interface PiccomaAliases {
  type_overrides: Record<string, TypeOverride>;
}

let _aliases: PiccomaAliases | null = null;
function loadAliases(): PiccomaAliases {
  if (_aliases) return _aliases;
  const candidates = [
    path.resolve(process.cwd(), "src/features/settlement/data/aliases/piccoma.json"),
    path.resolve(process.cwd(), "../data/aliases/piccoma.json"),
    path.resolve(__dirname, "../../data/aliases/piccoma.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      _aliases = {
        type_overrides: j.type_overrides ?? {},
      };
      return _aliases;
    }
  }
  _aliases = { type_overrides: {} };
  return _aliases;
}

function classifyKanaType(title: string, column: "話" | "巻"): TypeOverride {
  const a = loadAliases();
  const override = a.type_overrides[title];
  if (override) return override;
  if (column === "巻") return "EB";
  if (/（ノベル）$/.test(title) || /\(ノベル\)$/.test(title)) return "WN";
  return "WT";
}

interface DetailSums {
  /** 話売 per-title sum of 売上(税別) from <話売>精算対象使用件数 */
  sales話: Map<string, number>;
  /** 話売 per-title sum of 精算金額(税別) from <話売>精算対象使用件数 */
  settle話: Map<string, number>;
  /** 話売 per-title average/observed R/S from <話売>精算対象使用件数 */
  rs話: Map<string, number>;
  /** 巻売 per-title sum of 売上(税別) from <巻売>精算対象使用件数 */
  sales巻: Map<string, number>;
  /** 巻売 per-title sum of 精算金額(税別) from <巻売>精算対象使用件数 */
  settle巻: Map<string, number>;
  /** 巻売 per-title average/observed R/S from <巻売>精算対象使用件数 */
  rs巻: Map<string, number>;
}

/** Load the sibling 出版社report detail file if it exists nearby. */
function tryLoadDetail(summaryFilename: string, summaryBuffer?: Buffer): DetailSums | null {
  void summaryBuffer;
  // Summary filename looks like: 取次report_株式会社RIVERSE_YYYYMMDD_vN.xlsx
  // Detail  filename looks like: 出版社report_株式会社RIVERSE_YYYYMMDD_NNNN.xlsx
  const m = summaryFilename.match(/取次report_株式会社RIVERSE_(\d{8})_/);
  if (!m) return null;
  const date = m[1];
  const month = date.slice(0, 6);

  const candidateDirs = [
    `/Volumes/SSD_MacMini/CLINK_YANGIL_GoogleDrive/리버스 제팬/일본_매출정산_나카타니용/${month}/${month}_ピッコマ`,
    `/Volumes/SSD_MacMini/CLINK_YANGIL_GoogleDrive/리버스 제팬/일본_매출정산_나카타니용/${month}/202603_ピッコマ`, // legacy
    path.resolve(process.cwd(), "../raw", `${month}_piccoma`),
  ];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const detail = files.find(f => new RegExp(`^出版社report_株式会社RIVERSE_${date}_\\d+\\.xlsx$`).test(f));
    if (detail) {
      const buf = fs.readFileSync(path.join(dir, detail));
      return parseDetailBuffer(buf);
    }
  }
  return null;
}

/** Parse a 出版社report buffer into per-title 話/巻 sales sums. */
export function parseDetailBuffer(buffer: Buffer): DetailSums {
  const wb = readWorkbook(buffer);
  const out: DetailSums = {
    sales話: new Map<string, number>(),
    settle話: new Map<string, number>(),
    rs話: new Map<string, number>(),
    sales巻: new Map<string, number>(),
    settle巻: new Map<string, number>(),
    rs巻: new Map<string, number>(),
  };

  const rsTotals話 = new Map<string, { sum: number; count: number }>();
  const rsTotals巻 = new Map<string, { sum: number; count: number }>();

  const chapSheetName = wb.SheetNames.find(n => /<?話売>?.*精算対象使用件数/.test(n));
  const volSheetName = wb.SheetNames.find(n => /<?巻売>?.*精算対象使用件数/.test(n));

  if (chapSheetName) {
    const matrix = sheetToMatrix(wb, chapSheetName);
    // header row 0; cols: [2] 作品名, [14] 売上(税別), [15] R/S, [16] 精算金額(税別)
    for (let i = 1; i < matrix.length; i++) {
      const r = matrix[i] ?? [];
      const title = r[2];
      if (!title || typeof title !== "string") continue;
      const sales = toNumber(r[14]);
      const rs = normalizeRsRate(toNumber(r[15]));
      const settle = toNumber(r[16]);
      out.sales話.set(title, (out.sales話.get(title) ?? 0) + sales);
      out.settle話.set(title, (out.settle話.get(title) ?? 0) + settle);
      if (rs > 0) {
        const prev = rsTotals話.get(title) ?? { sum: 0, count: 0 };
        rsTotals話.set(title, { sum: prev.sum + rs, count: prev.count + 1 });
      }
    }
  }

  if (volSheetName) {
    const matrix = sheetToMatrix(wb, volSheetName);
    // header row 0; cols: [2] 作品名, [12] 売上(税別), [13] R/S, [14] 精算金額(税別)
    for (let i = 1; i < matrix.length; i++) {
      const r = matrix[i] ?? [];
      const title = r[2];
      if (!title || typeof title !== "string") continue;
      const sales = toNumber(r[12]);
      const rs = normalizeRsRate(toNumber(r[13]));
      const settle = toNumber(r[14]);
      out.sales巻.set(title, (out.sales巻.get(title) ?? 0) + sales);
      out.settle巻.set(title, (out.settle巻.get(title) ?? 0) + settle);
      if (rs > 0) {
        const prev = rsTotals巻.get(title) ?? { sum: 0, count: 0 };
        rsTotals巻.set(title, { sum: prev.sum + rs, count: prev.count + 1 });
      }
    }
  }

  for (const [title, v] of rsTotals話) out.rs話.set(title, v.count > 0 ? v.sum / v.count : 0);
  for (const [title, v] of rsTotals巻) out.rs巻.set(title, v.count > 0 ? v.sum / v.count : 0);

  return out;
}

function inferMonthFromPiccomaFilename(filename: string): string | null {
  const m = filename.match(/株式会社RIVERSE_(\d{6})\d{2}/);
  if (!m) return null;
  return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-01`;
}

function previousMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function recordsFromDetailOnly(filename: string, buffer: Buffer): { records: RawRecord[]; salesMonth: string | null; settlementMonth: string | null } {
  const detail = parseDetailBuffer(buffer);
  const settlementMonth = inferMonthFromPiccomaFilename(filename);
  // Piccoma regular reports usually settle the previous month's sales. The
  // upload UI still forces the operator-selected settlement month for the DB
  // batch, so this only fills the workbook's sales-month column when available.
  const salesMonth = settlementMonth ? previousMonth(settlementMonth) : null;
  const depositMonth = settlementMonth ? addMonth(settlementMonth) : null;
  const records: RawRecord[] = [];
  let rowIdx = 0;

  for (const [title, rawSales] of detail.sales話) {
    const rawSettle = detail.settle話.get(title) ?? 0;
    if (rawSales === 0 && rawSettle === 0) continue;
    const rsRate = detail.rs話.get(title) ?? (rawSales > 0 ? rawSettle / rawSales : 0);
    records.push(buildRecord({
      rowIdx: rowIdx++,
      title,
      type: classifyKanaType(title, "話"),
      rsRate,
      rawSales,
      rawSettle,
      salesMonth,
      settlementMonth,
      depositMonth,
      mg: 0,
      col: "話",
    }));
  }

  for (const [title, rawSales] of detail.sales巻) {
    const rawSettle = detail.settle巻.get(title) ?? 0;
    if (rawSales === 0 && rawSettle === 0) continue;
    const rsRate = detail.rs巻.get(title) ?? (rawSales > 0 ? rawSettle / rawSales : 0);
    records.push(buildRecord({
      rowIdx: rowIdx++,
      title,
      type: classifyKanaType(title, "巻"),
      rsRate,
      rawSales,
      rawSettle,
      salesMonth,
      settlementMonth,
      depositMonth,
      mg: 0,
      col: "巻",
    }));
  }

  return { records, salesMonth, settlementMonth };
}

interface SummaryRow {
  title: string;
  rs_rate: number;
  /** 精算対象当月売上[話] (税抜) */
  settle_current話: number;
  /** 精算対象当月売上[巻] (税抜) */
  settle_current巻: number;
  /** 最終精算[話] (税抜) */
  settle_final話: number;
  /** 最終精算[巻] (税抜) */
  settle_final巻: number;
  /** gross (税抜, combined 話+巻) */
  gross_total_tax_excl: number;
  mg: number;
}

function parseSummarySheet(buffer: Buffer): { salesMonth: string | null; rows: SummaryRow[] } {
  const wb = readWorkbook(buffer);
  // The summary sheet's name is like "227_株式会社RIVERSE" — use the first sheet.
  const sheetName = wb.SheetNames[0];
  const matrix = sheetToMatrix(wb, sheetName);

  // Row 1 (index 0): [null, '期間', '2026.03.1', '~', null, '2026.03.31', ...]
  // We take the 3rd non-null cell as the period start.
  const periodRow = matrix[0] ?? [];
  let salesMonth: string | null = null;
  for (const cell of periodRow) {
    if (cell instanceof Date) {
      salesMonth = toIsoMonth(cell);
      if (salesMonth) break;
    } else if (typeof cell === "string" && /\d{4}\.\d{1,2}\.\d{1,2}/.test(cell)) {
      salesMonth = toIsoMonth(cell.replace(/\./g, "-"));
      if (salesMonth) break;
    }
  }

  // Row 3 (index 2) is the header; data starts at index 3.
  // xlsx.sheet_to_json drops the leading empty column so No. is at index 0.
  const rows: SummaryRow[] = [];
  for (let i = 3; i < matrix.length; i++) {
    const r = matrix[i] ?? [];
    const title = r[1];
    if (!title || typeof title !== "string") continue;
    if (title.includes("合計")) continue;
    rows.push({
      title: title.trim(),
      rs_rate: toNumber(r[2]) / 100, // 26 → 0.26
      settle_current話: toNumber(r[7]),
      settle_current巻: toNumber(r[8]),
      settle_final話: toNumber(r[11]),
      settle_final巻: toNumber(r[12]),
      gross_total_tax_excl: toNumber(r[6]),
      mg: toNumber(r[13]),
    });
  }

  return { salesMonth, rows };
}

/** Add 1 month to a YYYY-MM-01 string. */
function addMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // m is 1-12; Date month is 0-11, so Date(m) advances by 1
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** End-of-month of a YYYY-MM-01 string. */
function endOfMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last of this month
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Main entry.
 *
 * Piccoma emits two files per month. We only produce rows when invoked with the
 * 取次report; the 出版社report is loaded as a detail lookup from disk. If the
 * detail file is missing, we fall back to approximating `total_amount_jpy` from
 * the 取次 settle value divided by the RS rate (less accurate).
 */
export async function parsePiccoma({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const isSummary = /^取次report_株式会社RIVERSE_/.test(filename);
  const isDetail = /^出版社report_株式会社RIVERSE_/.test(filename);

  if (isDetail) {
    const detailOnly = recordsFromDetailOnly(filename, buffer);
    return {
      platform_code: "piccoma",
      sales_month: detailOnly.salesMonth,
      settlement_month: detailOnly.settlementMonth,
      records: detailOnly.records,
      errors: detailOnly.records.length > 0
        ? ["piccoma: 出版社report detail-only upload parsed directly; 取次report was not uploaded"]
        : ["piccoma: 出版社report detail-only upload contained no parseable detail rows"],
    };
  }

  if (!isSummary) {
    // Best-effort: still try to parse as summary.
  }

  const { salesMonth, rows } = parseSummarySheet(buffer);
  const detail = tryLoadDetail(filename, buffer);

  const settlementMonth = salesMonth ? addMonth(salesMonth) : null;
  const depositMonth = settlementMonth ? addMonth(settlementMonth) : null;

  const errors: string[] = [];
  if (!detail) {
    errors.push(
      "piccoma: sibling 出版社report (detail) not found — total_amount_jpy will be approximated via 取次 settle/rs",
    );
  }

  const records: RawRecord[] = [];
  let rowIdx = 0;

  for (const r of rows) {
    // 話 emission
    const settle話 = Math.max(r.settle_current話, r.settle_final話);
    if (settle話 > 0) {
      const type = classifyKanaType(r.title, "話");
      const rawSales = detail?.sales話.get(r.title) ?? (r.rs_rate > 0 ? settle話 / r.rs_rate : 0);
      records.push(
        buildRecord({
          rowIdx: rowIdx++,
          title: r.title,
          type,
          rsRate: r.rs_rate,
          rawSales,
          rawSettle: settle話,
          salesMonth,
          settlementMonth,
          depositMonth,
          mg: r.mg,
          col: "話",
        }),
      );
    }
    // 巻 emission
    const settle巻 = Math.max(r.settle_current巻, r.settle_final巻);
    if (settle巻 > 0) {
      const type = classifyKanaType(r.title, "巻");
      const rawSales = detail?.sales巻.get(r.title) ?? (r.rs_rate > 0 ? settle巻 / r.rs_rate : 0);
      records.push(
        buildRecord({
          rowIdx: rowIdx++,
          title: r.title,
          type,
          rsRate: r.rs_rate,
          rawSales,
          rawSettle: settle巻,
          salesMonth,
          settlementMonth,
          depositMonth,
          mg: r.mg,
          col: "巻",
        }),
      );
    }
  }

  return {
    platform_code: "piccoma",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

function buildRecord(opts: {
  rowIdx: number;
  title: string;
  type: TypeOverride;
  rsRate: number;
  rawSales: number;
  rawSettle: number;
  salesMonth: string | null;
  settlementMonth: string | null;
  depositMonth: string | null;
  mg: number;
  col: "話" | "巻";
}): RawRecord {
  const {
    rowIdx, title, type, rsRate, rawSales, rawSettle,
    salesMonth, settlementMonth, depositMonth, mg, col,
  } = opts;

  const total_amount_jpy = excelRound(rawSales * TAX_MULT);
  const before_tax_jpy = total_amount_jpy;
  const after_tax_jpy = Math.round(total_amount_jpy / TAX_MULT);
  const before_tax_income_jpy = Math.floor(rawSettle * TAX_MULT);
  const after_tax_income_jpy_a = Math.floor(rawSettle);
  const consumption_tax_jpy = before_tax_income_jpy - after_tax_income_jpy_a;

  return {
    row_index: rowIdx,
    data: {
      sales_month: salesMonth,
      settlement_month: settlementMonth ? endOfMonth(settlementMonth) : null,
      deposit_month: depositMonth ? endOfMonth(depositMonth) : null,
      channel_title_jp: title,
      title_jp: title,
      type,
      distribution_strategy: "non-ex",
      channel_code: "piccoma",
      client_code: "piccoma",
      rs_label: null,
      rs_rate: rsRate,
      total_amount_jpy,
      fee_jpy: 0,
      before_tax_jpy,
      after_tax_jpy,
      before_tax_income_jpy,
      withholding_tax_jpy: 0,
      consumption_tax_jpy,
      after_tax_income_jpy: after_tax_income_jpy_a,
      mg,
      raw_column: col,
      raw_sales_tax_excl: rawSales,
      raw_settle_tax_excl: rawSettle,
    },
  };
}
