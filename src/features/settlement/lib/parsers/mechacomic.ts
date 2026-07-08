/**
 * Mechacomic (Amutus / めちゃコミック) parser — XLSX.
 *
 * File: `RIVERSE_YYYYMM.xlsx` with four sheets:
 *   - 報告書                (summary header, ignored)
 *   - MG履歴(めちゃコミ)   (MG balance log — parsed separately for context, not used here)
 *   - スマートフォン明細  (per-volume / per-episode detail for web; header row 3)
 *   - アプリ明細          (same, for the native app channel; header row 3)
 *
 * Both detail sheets share the same trailing columns:
 *   シリーズ名 | 作家名 | 書名 | ... | 売上金額 | 率 | 支払 | 種別
 *
 * Derivation rules (reverse-engineered against 202604 GT / 107 rows):
 *
 *  1. Group raw rows by (シリーズ名, 種別). Each group maps to exactly one GT row.
 *  2. GT `total_amount_jpy` = GT `before_tax_jpy` = round(Σ 売上金額 × 1.10)
 *     (raw is tax-exclusive; GT rolls consumption tax into the gross).
 *  3. GT `before_tax_income_jpy` = floor(Σ 支払 × 1.10)   ← NOT round; consistently truncates.
 *  4. `rs_rate` = 率 / 100 (each group uses a single rate; raw reports 30 or 35).
 *  5. Type mapping (WT / EP / EB / WR):
 *       - 種別 == '巻' && title contains '分冊版'           → EP
 *       - 種別 == '巻' (no 分冊版)                            → EB   (physical-like volume)
 *       - 種別 contains '話'                                  → WT
 *       - Whenever title contains '[改訂版]'                  → WR   (override)
 *       - Whenever the same series has a sibling whose title adds
 *         '[完全版]' or '【完全版】' → the base series becomes WR (override)
 *     A handful of ambiguous '巻' rows (where 完全版 but no 分冊版 suffix) need an
 *     alias override — captured in data/aliases/mechacomic.json.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import ExcelJS from "exceljs";

// Static alias overrides for the handful of ambiguous 巻 (volume) rows where
// the default EP/EB heuristic can't tell. Keyed by `${series}|${kind}`.
// Kept small and data-driven — this table, not the parser logic, is the
// authoritative record of the exceptions.
const TYPE_OVERRIDES: Record<string, string> = {
  "結婚商売[完全版]|巻": "WT",
  "融点～とけあい～【完全版】|巻": "EP",
};

const DETAIL_SHEETS = ["スマートフォン明細", "アプリ明細"];
const REQUIRED_HEADERS = ["シリーズ名", "書名", "売上金額", "率", "支払", "種別"];

interface Group {
  series: string;
  kind: string;
  sales: number;
  pay: number;
  rateSum: number;
  rateCount: number;
  kubuns: Set<string>;
  rowCount: number;
}

export async function parseMechacomic({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];
  const groups = new Map<string, Group>();
  const matrices = await readDetailMatrices(buffer);

  for (const sheetName of DETAIL_SHEETS) {
    const matrix = matrices.get(sheetName);
    if (!matrix) {
      errors.push(`missing sheet: ${sheetName}`);
      continue;
    }
    const headerIdx = findHeaderRow(matrix);
    if (headerIdx < 0) {
      errors.push(`${sheetName}: could not find header row`);
      continue;
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
      const series = strOr(row[col["シリーズ名"]]);
      if (!series) continue; // skip empty / trailing blank rows
      const kind = strOr(row[col["種別"]]);
      const kubun = strOr(row[col["区分"] ?? -1]);
      const sales = numOr0(row[col["売上金額"]]);
      const pay = numOr0(row[col["支払"]]);
      const rate = numOr0(row[col["率"]]);

      const key = `${series}|${kind}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          series,
          kind,
          sales: 0,
          pay: 0,
          rateSum: 0,
          rateCount: 0,
          kubuns: new Set(),
          rowCount: 0,
        };
        groups.set(key, g);
      }
      g.sales += sales;
      g.pay += pay;
      if (rate > 0) {
        g.rateSum += rate;
        g.rateCount += 1;
      }
      if (kubun) g.kubuns.add(kubun);
      g.rowCount += 1;
    }
  }

  // Build type-resolution context
  const allSeries = new Set<string>();
  for (const g of groups.values()) allSeries.add(g.series);

  const records: RawRecord[] = [];
  let idx = 0;
  for (const g of groups.values()) {
    const type = resolveType(g.series, g.kind, allSeries);
    const rsRate = g.rateCount > 0 ? g.rateSum / g.rateCount / 100 : 0;

    // Tax rules (reverse-engineered):
    //   total_amount_jpy    = round(sales * 1.10)
    //   before_tax_income   = floor(pay  * 1.10)   ← floor, not round
    const total = Math.round(g.sales * 1.10);
    const beforeTaxIncome = Math.floor(g.pay * 1.10);
    const consumptionTax = total - Math.round(g.sales); // tax part of total
    const afterTaxIncome = beforeTaxIncome; // withholding is 0 for JP inter-corporate

    records.push({
      row_index: idx++,
      data: {
        title_jp: g.series,
        channel_title_jp: g.series,
        type,
        kind_raw: g.kind,
        kubuns: Array.from(g.kubuns),
        // gross/sales
        gross_jpy: total,
        total_amount_jpy: total,
        before_tax_jpy: total,
        // income
        before_tax_income_jpy: beforeTaxIncome,
        after_tax_income_jpy: afterTaxIncome,
        consumption_tax_jpy: consumptionTax,
        withholding_tax_jpy: 0,
        // raw (tax-exclusive) kept for audit
        raw_sales_jpy: g.sales,
        raw_payment_jpy: g.pay,
        // rate
        rs_rate_hint: rsRate,
        rs_rate: rsRate,
        // routing
        channel_code: "mechacomic",
        client_code: "amutus",
      },
    });
  }

  // Filename: RIVERSE_YYYYMM.xlsx — settlement month = the month *after* the sales month
  // (GT rows in 202604.json have sales_month = 2026-03-01 for 202603 file; settlement 2026-04-30).
  const m = filename.match(/(\d{4})(\d{2})/);
  const salesMonth = m ? `${m[1]}-${m[2]}-01` : null;
  const settlementMonth = salesMonth ? nextMonthIso(salesMonth) : null;

  return {
    platform_code: "mechacomic",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

async function readDetailMatrices(buffer: Buffer): Promise<Map<string, unknown[][]>> {
  // The 202606 めちゃコミック workbook has very large sheet XML parts.
  // SheetJS can try to materialize an over-sized string for that file and throw
  // ERR_STRING_TOO_LONG before parsing starts. ExcelJS streams the workbook
  // object model without that string expansion, while preserving the same cell
  // values we need for the two detail sheets.
  const wb = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  await wb.xlsx.load(arrayBuffer);
  const matrices = new Map<string, unknown[][]>();
  for (const sheetName of DETAIL_SHEETS) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    const matrix: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      matrix[rowNumber - 1] = values.map((cell) => normalizeExcelJsCell(cell));
    });
    matrices.set(sheetName, matrix);
  }
  return matrices;
}

function normalizeExcelJsCell(cell: unknown): unknown {
  if (cell == null) return null;
  if (cell instanceof Date) return cell;
  if (typeof cell !== "object") return cell;
  const c = cell as {
    result?: unknown;
    text?: string;
    richText?: Array<{ text?: string }>;
    formula?: string;
    hyperlink?: string;
  };
  if (c.result != null) return c.result;
  if (c.text != null) return c.text;
  if (Array.isArray(c.richText)) return c.richText.map((part) => part.text ?? "").join("");
  return String(cell);
}

/**
 * Detect the header row within a detail sheet.
 *
 * Mechacomic puts 3 "summary" rows at the top before the true header row:
 *   row 0:  label labels (DoCoMo販売数, ...)
 *   row 1:  aggregate totals
 *   row 2:  blank
 *   row 3:  real header (includes 書名, シリーズ名, etc.)
 */
function findHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(10, matrix.length); i++) {
    const row = matrix[i];
    if (!row) continue;
    const cells = row.map(c => String(c ?? ""));
    if (REQUIRED_HEADERS.every(h => cells.includes(h))) return i;
  }
  return -1;
}

function resolveType(series: string, kind: string, allSeries: Set<string>): string {
  const overrideKey = `${series}|${kind}`;
  if (TYPE_OVERRIDES[overrideKey]) return TYPE_OVERRIDES[overrideKey];

  // Revision edition always → WR
  if (series.includes("改訂版")) return "WR";

  // If this series has a sibling "{series}[完全版]" or "{series}【完全版】" then
  // the base series is the legacy version → WR.
  if (hasKanzenSibling(series, allSeries)) return "WR";

  if (kind && kind.includes("話")) return "WT";
  if (kind === "巻") {
    if (series.includes("分冊版")) return "EP";
    return "EB";
  }
  return "WT"; // safe default
}

function hasKanzenSibling(series: string, allSeries: Set<string>): boolean {
  for (const other of allSeries) {
    if (other === series) continue;
    // Various spacings + bracket styles seen in the data.
    const prefixes = [
      series + "【完全版】",
      series + " 【完全版】",
      series + "[完全版]",
      series + " [完全版]",
    ];
    if (prefixes.some(p => other === p || other.startsWith(p))) return true;
  }
  return false;
}

function nextMonthIso(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // last day of (y, m)
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
