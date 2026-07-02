import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

import { splitInputV2Records } from "./input-v2-routing";

/**
 * 202605 answer-key workbook supplied by RIVERSE/Nakatani. It is the default
 * template for every month: its input_電子_5月 sheet is renamed to the target
 * month's input_電子_N月 sheet on fill. It has no input_出版 sheet, so all
 * records route to the electronic sheet when this default is in effect.
 */
const DEFAULT_TEMPLATE = new URL(
  "../../data/templates/input_jp_2026_2605_golden.xlsx",
  import.meta.url,
);

const FIRST_DATA_ROW = 6;

const ELECTRONIC_COL = {
  unique_identifier: 1,
  channel_title_jp: 2,
  title_kr: 3,
  title_jp: 4,
  updated: 5,
  recoder: 6,
  company: 7,
  launch_date: 8,
  sales_month: 9,
  month: 10,
  settlement_month: 11,
  deposit_month: 12,
  country: 13,
  clients: 14,
  channel: 15,
  type: 16,
  distribution_strategy: 17,
  settlement_currency: 18,
  vehicle_currency: 19,
  total_amount_jpy: 20,
  fee_jpy: 21,
  before_tax_jpy: 22,
  after_tax_jpy: 23,
  rs: 24,
  before_tax_income_jpy: 25,
  withholding_tax_jpy: 26,
  tax_jpy: 27,
  after_tax_income_jpy: 28,
  after_tax_income_vehicle: 29,
  exchange_rate: 30,
  rate_krw_krw: 31,
  fee_krw: 33,
  before_tax_krw: 34,
  after_tax_krw: 35,
  after_tax_income_krw: 36,
  vat_krw: 37,
  withholding_tax_krw: 38,
  sales_krw: 39,
  mg_begin: 40,
  mg_increase: 41,
  mg_decrease: 42,
  mg_end: 43,
  note1: 44,
  note2: 45,
} as const;

const PUBLICATION_COL = {
  unique_identifier: 1,
  channel_title_jp: 2,
  title_kr: 3,
  title_jp: 4,
  updated: 5,
  recoder: 6,
  company: 8,
  launch_date: 9,
  sales_month: 10,
  settlement_month: 11,
  statement_received: 12,
  deposit_month: 13,
  country: 14,
  clients: 15,
  channel: 16,
  type: 17,
  distribution_strategy: 18,
  settlement_currency: 19,
  vehicle_currency: 20,
  total_amount_jpy: 21,
  fee_jpy: 22,
  before_tax_jpy: 23,
  after_tax_jpy: 24,
  rs: 25,
  before_tax_income_jpy: 26,
  withholding_tax_jpy: 27,
  tax_jpy: 28,
  after_tax_income_jpy: 29,
  after_tax_income_vehicle: 30,
  exchange_rate: 31,
  rate_krw_krw: 32,
  fee_krw: 34,
  before_tax_krw: 35,
  after_tax_krw: 36,
  after_tax_income_krw: 37,
  vat_krw: 38,
  withholding_tax_krw: 39,
  sales_krw: 40,
  mg_begin: 41,
  mg_increase: 42,
  mg_decrease: 43,
  mg_end: 44,
  note1: 45,
  note2: 46,
} as const;

type ColMap = typeof ELECTRONIC_COL | typeof PUBLICATION_COL;
type Prim = string | number | boolean | Date | null;

export interface InputV2FillOptions {
  month: string;
  records: Record<string, unknown>[];
  templatePath?: string;
}

export interface InputV2FillResult {
  buffer: Buffer;
  fill_ms: number;
  rows_written: number;
  electronic_rows: number;
  publication_rows: number;
  electronic_sheet: string;
  publication_sheet: string;
}

function pick(r: Record<string, unknown>, ...keys: string[]): Prim {
  for (const k of keys) {
    const x = r[k];
    if (x === null || x === undefined || x === "") continue;
    if (
      typeof x === "string" ||
      typeof x === "number" ||
      typeof x === "boolean" ||
      x instanceof Date
    ) {
      return x;
    }
    return String(x);
  }
  return null;
}

function str(r: Record<string, unknown>, ...keys: string[]): string | null {
  const v = pick(r, ...keys);
  return v === null ? null : String(v);
}

function num(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function toDate(x: unknown): Date | string | null {
  if (!x) return null;
  if (x instanceof Date) return x;
  const s = String(x);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d;
}

function cloneStyle(style: Partial<ExcelJS.Style> | undefined): Partial<ExcelJS.Style> | undefined {
  return style ? JSON.parse(JSON.stringify(style)) as Partial<ExcelJS.Style> : undefined;
}

function captureTemplate(ws: ExcelJS.Worksheet, maxCol: number) {
  const row = ws.getRow(FIRST_DATA_ROW);
  const styles: Array<Partial<ExcelJS.Style> | undefined> = [];
  const formulas: Array<string | null> = [];
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    styles[c] = cloneStyle(cell.style);
    const val = cell.value;
    formulas[c] = val && typeof val === "object" && "formula" in val
      ? (val as ExcelJS.CellFormulaValue).formula ?? null
      : null;
  }
  return { styles, formulas };
}

function clearDataRows(ws: ExcelJS.Worksheet) {
  const last = Math.max(ws.actualRowCount, ws.rowCount, FIRST_DATA_ROW);
  for (let r = FIRST_DATA_ROW; r <= last; r++) {
    ws.getRow(r).values = [];
  }
}

function adjustFormula(formula: string, rowIdx: number): string {
  return formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (_m, col, dollar, n) => {
    if (dollar === "$") return `${col}${dollar}${n}`;
    const refRow = Number(n);
    return refRow === FIRST_DATA_ROW ? `${col}${rowIdx}` : `${col}${n}`;
  });
}

function writeRecord(
  row: ExcelJS.Row,
  rec: Record<string, unknown>,
  col: ColMap,
  styles: Array<Partial<ExcelJS.Style> | undefined>,
  formulas: Array<string | null>,
  maxCol: number,
) {
  const values: Record<number, Prim> = {
    [col.unique_identifier]: str(rec, "unique_identifier", "unique_id"),
    [col.channel_title_jp]: str(rec, "channel_title_jp"),
    [col.title_kr]: str(rec, "title_kr"),
    [col.title_jp]: str(rec, "title_jp"),
    [col.updated]: toDate(pick(rec, "updated_at", "updated")),
    [col.recoder]: str(rec, "recoder"),
    [col.company]: str(rec, "company") ?? "RJ",
    [col.launch_date]: toDate(pick(rec, "launch_date")),
    [col.sales_month]: toDate(pick(rec, "sales_month")),
    [col.settlement_month]: toDate(pick(rec, "settlement_month")),
    [col.deposit_month]: toDate(pick(rec, "deposit_month")),
    [col.country]: str(rec, "country") ?? "JP",
    [col.clients]: str(rec, "clients", "client_display_name", "client_code"),
    [col.channel]: str(rec, "channel", "channel_code"),
    [col.type]: str(rec, "type"),
    [col.distribution_strategy]: str(rec, "distribution_strategy"),
    [col.settlement_currency]: str(rec, "settlement_currency") ?? "JPY",
    [col.vehicle_currency]: str(rec, "vehicle_currency") ?? "KRW",
    [col.total_amount_jpy]: num(pick(rec, "total_amount_jpy")),
    [col.fee_jpy]: num(pick(rec, "fee_jpy")) ?? 0,
    [col.before_tax_jpy]: num(pick(rec, "before_tax_jpy")),
    [col.after_tax_jpy]: num(pick(rec, "after_tax_jpy")),
    [col.rs]: pick(rec, "rs_label", "rs", "rs_rate"),
    [col.before_tax_income_jpy]: num(pick(rec, "before_tax_income_jpy")),
    [col.withholding_tax_jpy]: num(pick(rec, "withholding_tax_jpy")) ?? 0,
    [col.tax_jpy]: num(pick(rec, "consumption_tax_jpy", "tax_jpy")),
    [col.after_tax_income_jpy]: num(pick(rec, "after_tax_income_jpy", "after_tax_income_jpy_a")),
    [col.after_tax_income_vehicle]: num(pick(rec, "after_tax_income_jpy_b", "after_tax_income_vehicle")),
    [col.exchange_rate]: num(pick(rec, "exchange_rate", "rate_jpy_krw")),
    [col.rate_krw_krw]: num(pick(rec, "rate_krw_krw")) ?? 1,
    [col.fee_krw]: num(pick(rec, "fee_krw")),
    [col.before_tax_krw]: num(pick(rec, "before_tax_krw")),
    [col.after_tax_krw]: num(pick(rec, "after_tax_krw")),
    [col.after_tax_income_krw]: num(pick(rec, "after_tax_income_krw")),
    [col.vat_krw]: num(pick(rec, "vat_krw")),
    [col.withholding_tax_krw]: num(pick(rec, "withholding_tax_krw")),
    [col.sales_krw]: num(pick(rec, "sales_krw")),
    [col.mg_begin]: num(pick(rec, "mg_begin")) ?? 0,
    [col.mg_increase]: num(pick(rec, "mg_increase")) ?? 0,
    [col.mg_decrease]: num(pick(rec, "mg_decrease")) ?? 0,
    [col.mg_end]: num(pick(rec, "mg_end")) ?? 0,
    [col.note1]: str(rec, "note1"),
    [col.note2]: str(rec, "note2"),
  };

  if ("month" in col) {
    values[col.month] = toDate(pick(rec, "month", "accounting_month"));
  }
  if ("statement_received" in col) {
    values[col.statement_received] = toDate(pick(rec, "statement_received", "sales_month"));
  }

  const explicitCols = new Set(Object.keys(values).map(Number));
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    const style = styles[c];
    if (style) cell.style = cloneStyle(style) ?? {};
    if (explicitCols.has(c)) {
      cell.value = values[c] ?? null;
      continue;
    }
    const formula = formulas[c];
    if (formula) {
      cell.value = { formula: adjustFormula(formula, row.number) } as ExcelJS.CellFormulaValue;
    }
  }
}

function stretchSubtotalRanges(ws: ExcelJS.Worksheet, finalRow: number, maxCol: number) {
  const row = ws.getRow(1);
  const safeFinal = Math.max(finalRow, FIRST_DATA_ROW);
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    const val = cell.value;
    if (!val || typeof val !== "object" || !("formula" in val)) continue;
    const formula = (val as ExcelJS.CellFormulaValue).formula;
    if (!formula || !/SUBTOTAL\(9,/i.test(formula)) continue;
    cell.value = {
      formula: formula.replace(
        /([A-Z]+)(\d+):([A-Z]+)\d+/g,
        (_m, col1, start, col2) => `${col1}${start}:${col2}${safeFinal}`,
      ),
    };
  }
}

function fillSheet(
  ws: ExcelJS.Worksheet,
  records: Record<string, unknown>[],
  col: ColMap,
) {
  const maxCol = Math.max(ws.columnCount, 102);
  const template = captureTemplate(ws, maxCol);
  clearDataRows(ws);

  records.forEach((rec, i) => {
    const row = ws.getRow(FIRST_DATA_ROW + i);
    writeRecord(row, rec, col, template.styles, template.formulas, maxCol);
    row.commit();
  });

  stretchSubtotalRanges(ws, FIRST_DATA_ROW + records.length - 1, maxCol);
}

export async function fillInputV2Template(opts: InputV2FillOptions): Promise<InputV2FillResult> {
  const t0 = Date.now();
  // The golden default template only has the electronic sheet; splitting into a
  // publication sheet only applies when an explicit template provides one.
  const usesGoldenDefaultTemplate = !opts.templatePath;
  const split = splitInputV2Records(opts.records, opts.month);
  const effectiveSplit = usesGoldenDefaultTemplate
    ? {
        ...split,
        electronic: opts.records,
        publication: [],
      }
    : split;
  const templatePath = opts.templatePath ?? DEFAULT_TEMPLATE;

  const wb = new ExcelJS.Workbook();
  const templateBuffer = await readFile(templatePath);
  await wb.xlsx.load(templateBuffer as unknown as ExcelJS.Buffer);

  let electronicSheet = wb.getWorksheet(effectiveSplit.electronicSheet);
  const publicationSheet = wb.getWorksheet(effectiveSplit.publicationSheet);
  if (!electronicSheet) {
    electronicSheet = wb.worksheets.find((ws) => /^input_電子_\d+月$/.test(ws.name));
    if (electronicSheet) {
      electronicSheet.name = effectiveSplit.electronicSheet;
    }
  }
  if (!electronicSheet) {
    throw new Error(`Template sheet '${effectiveSplit.electronicSheet}' not found and no input_電子_N月 fallback exists`);
  }
  if (!publicationSheet && effectiveSplit.publication.length > 0) {
    throw new Error(`Template sheet '${effectiveSplit.publicationSheet}' not found`);
  }

  fillSheet(electronicSheet, effectiveSplit.electronic, ELECTRONIC_COL);
  if (publicationSheet) {
    fillSheet(publicationSheet, effectiveSplit.publication, PUBLICATION_COL);
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    buffer,
    fill_ms: Date.now() - t0,
    rows_written: opts.records.length,
    electronic_rows: effectiveSplit.electronic.length,
    publication_rows: effectiveSplit.publication.length,
    electronic_sheet: effectiveSplit.electronicSheet,
    publication_sheet: effectiveSplit.publicationSheet,
  };
}
