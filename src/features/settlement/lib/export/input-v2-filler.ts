import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

import {
  CARRY_FORWARD_PROVENANCE_FIELD,
  stripShueishaOcrTitleMarker,
} from "./input-v2-carry-forward";
import { splitInputV2Records } from "./input-v2-routing";

/**
 * Sanitized INPUT v3 workbook. It has a blank G column, so the 202605 baseline
 * layout keeps A:F and shifts G onward by +1 when rows are carried forward.
 */
const DEFAULT_TEMPLATE = new URL(
  "../../data/templates/input_jp_2026_v3_template.xlsx",
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
  company: 8,
  launch_date: 9,
  sales_month: 10,
  month: 11,
  settlement_month: 12,
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
  allocation_rate: 47,
  total_allocation_rate: 49,
  distribution_coop_rate: 50,
  production_participation_rate: 52,
  creator_category: 55,
  creator_allocation_rate: 56,
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

/**
 * U/W are universally derived by the template. Z/AB have source-family formula
 * exceptions, so they remain record-owned when explicit and fall back to the
 * template formula only when null.
 */
const FORMULA_OWNED_KEYS = ["total_amount_jpy", "before_tax_jpy"] as const;

/**
 * Ichijinsha documents state payment/income amounts only — no transaction
 * total and no fee. For these rows U is source-owned instead of
 * formula-owned: an explicit source total writes through, a null total stays
 * blank (never the template Total formula), and a null fee stays blank
 * instead of the zero contract default.
 */
const SOURCE_OWNED_TOTAL_CHANNELS = new Set(["ichijinsha"]);
const NO_SOURCE_FEE_CHANNELS = new Set(["ichijinsha", "jumptoon", "manga mee"]);

function normalizeChannel(rec: Record<string, unknown>): string {
  return String(rec.channel ?? rec.channel_code ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

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
  carry_rows: number;
  overlay_rows: number;
  append_rows: number;
  drop_rows: number;
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
  return v === null ? null : stripShueishaOcrTitleMarker(String(v));
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

function collapseArrayFormulaRanges(formula: string, rowIdx: number): string {
  // ExcelJS exposes some template array formulas as a single-cell formula with
  // vertical ranges (e.g. T6:T2023). Writing that back as a normal cell formula
  // makes desktop Excel repair/remove formulas. Convert only those vertical
  // same-column array ranges to the current row's scalar cell reference.
  return formula.replace(/(\$?[A-Z]{1,3})\$?\d+:\1\$?\d+/g, (_m, col) => `${col}${rowIdx}`);
}

function captureTemplate(ws: ExcelJS.Worksheet, maxCol: number) {
  const row = ws.getRow(FIRST_DATA_ROW);
  const styles: Array<Partial<ExcelJS.Style> | undefined> = [];
  const formulas: Array<string | null> = [];
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    styles[c] = cloneStyle(cell.style);
    const val = cell.value;
    if (val && typeof val === "object" && "formula" in val) {
      const formula = (val as ExcelJS.CellFormulaValue).formula ?? null;
      formulas[c] = formula && "shareType" in val && val.shareType === "array"
        ? collapseArrayFormulaRanges(formula, FIRST_DATA_ROW)
        : formula;
    } else {
      formulas[c] = null;
    }
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
  // Fee/RS are contract terms, not statement amounts. Rows appended without a
  // baseline contract row must not promote parser artifacts (a default
  // fee_jpy=0, rs_label/rs_rate payment hints) into those cells: they stay
  // blank unless an explicitly approved contract-master value
  // (contract_fee_jpy/contract_rs) is present. Carry/overlay rows and records
  // without merge provenance (direct filler callers) keep the legacy behavior.
  const isNewContractRow = rec[CARRY_FORWARD_PROVENANCE_FIELD] === "append";
  const normalizedChannel = normalizeChannel(rec);
  const sourceOwnsTotal = SOURCE_OWNED_TOTAL_CHANNELS.has(normalizedChannel);
  const sourceHasNoFee = NO_SOURCE_FEE_CHANNELS.has(normalizedChannel);
  const values: Record<number, Prim> = {
    [col.unique_identifier]: str(rec, "unique_identifier", "unique_id"),
    [col.channel_title_jp]: str(rec, "channel_title_jp", "title_jp"),
    // Keep preview/export readable when the title master does not yet have a
    // Korean mapping for a newly seen Japanese title; never leave title cells blank.
    [col.title_kr]: str(rec, "title_kr", "title_jp", "channel_title_jp"),
    [col.title_jp]: str(rec, "title_jp", "channel_title_jp"),
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
    // Official NAKATANI ledgers leave Total blank on newly appended
    // identities, so append rows suppress both source totals and the
    // template formula — even on source-owned-total channels.
    [col.total_amount_jpy]: isNewContractRow ? null : num(pick(rec, "total_amount_jpy")),
    // These source families do not provide a fee field. Even a carried
    // baseline zero is not current source evidence and must remain blank.
    [col.fee_jpy]: sourceHasNoFee
      ? null
      : isNewContractRow
        ? num(pick(rec, "contract_fee_jpy"))
        : num(pick(rec, "fee_jpy")) ?? 0,
    [col.before_tax_jpy]: num(pick(rec, "before_tax_jpy")),
    [col.after_tax_jpy]: num(pick(rec, "after_tax_jpy")),
    // `rs` is contract metadata restored from the carry-forward baseline
    // (preserveContractMetadata). Appended rows have no contract row, so
    // their RS stays blank until a contract-master value approves one.
    [col.rs]: isNewContractRow ? pick(rec, "contract_rs") : pick(rec, "rs", "rs_label", "rs_rate"),
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
    // note2 may carry the private Shueisha OCR provenance token; it must
    // never reach a workbook cell.
    [col.note2]: stripShueishaOcrTitleMarker(str(rec, "note2")),
  };

  if ("allocation_rate" in col) {
    values[col.allocation_rate] = num(pick(rec, "allocation_rate"));
    values[col.total_allocation_rate] = num(pick(rec, "total_allocation_rate"));
    values[col.distribution_coop_rate] = num(pick(rec, "distribution_coop_rate"));
    values[col.production_participation_rate] = num(pick(rec, "production_participation_rate"));
    values[col.creator_category] = str(rec, "creator_category");
    values[col.creator_allocation_rate] = num(pick(rec, "creator_allocation_rate"));
  }
  if ("month" in col) {
    values[col.month] = toDate(pick(rec, "month", "accounting_month"));
  }
  if ("statement_received" in col) {
    values[col.statement_received] = toDate(pick(rec, "statement_received", "sales_month"));
  }

  const explicitCols = new Set(Object.keys(values).map(Number));
  const formulaOwnedCols = new Set<number>(FORMULA_OWNED_KEYS.map((k) => col[k]));
  const blankWhenNullCols = new Set<number>();
  if (sourceOwnsTotal || isNewContractRow) {
    formulaOwnedCols.delete(col.total_amount_jpy);
    blankWhenNullCols.add(col.total_amount_jpy);
  }
  if (sourceHasNoFee) blankWhenNullCols.add(col.fee_jpy);
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    const style = styles[c];
    if (style) cell.style = cloneStyle(style) ?? {};
    if (explicitCols.has(c) && !(formulaOwnedCols.has(c) && formulas[c])) {
      if (values[c] !== null && values[c] !== undefined) {
        cell.value = values[c];
        continue;
      }
      if (blankWhenNullCols.has(c)) continue; // source-owned null stays blank
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
  // The sanitized v3 default template only has the electronic sheet; splitting
  // into a publication sheet only applies when an explicit template provides one.
  const usesDefaultTemplate = !opts.templatePath;
  // Records are already dynamically carried/overlaid by loadInputV2Records.
  // Keep the filler a pure workbook renderer; never replay a fixed month here.
  const records = opts.records;
  const counts = records.reduce<{
    carry_rows: number;
    overlay_rows: number;
    append_rows: number;
    drop_rows: number;
  }>(
    (acc, record) => {
      const provenance = record[CARRY_FORWARD_PROVENANCE_FIELD];
      if (provenance === "carry") acc.carry_rows += 1;
      else if (provenance === "overlay") acc.overlay_rows += 1;
      else acc.append_rows += 1;
      return acc;
    },
    { carry_rows: 0, overlay_rows: 0, append_rows: 0, drop_rows: 0 },
  );
  const split = splitInputV2Records(records, opts.month);
  const effectiveSplit = usesDefaultTemplate
    ? {
        ...split,
        electronic: records,
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
    rows_written: records.length,
    electronic_rows: effectiveSplit.electronic.length,
    publication_rows: effectiveSplit.publication.length,
    electronic_sheet: effectiveSplit.electronicSheet,
    publication_sheet: effectiveSplit.publicationSheet,
    carry_rows: counts.carry_rows,
    overlay_rows: counts.overlay_rows,
    append_rows: counts.append_rows,
    drop_rows: counts.drop_rows,
  };
}
