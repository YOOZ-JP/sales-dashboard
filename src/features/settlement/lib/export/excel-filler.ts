/**
 * excel-filler.ts — Node-only xlsx generator (Vercel-safe).
 *
 * Opens data/templates/master_template.xlsx with exceljs, copies the
 * golden reference row (row 5) style + formulas onto each injected
 * data row, and rewrites row-1 SUBTOTAL ranges. Produces an xlsx
 * Buffer that the API route can stream directly.
 *
 * The previous Python/openpyxl pipeline died on Vercel (no python3
 * binary). exceljs round-trips everything this template actually
 * uses — column widths, merged ranges, header styles, named ranges,
 * theme colors, row-local formulas.
 */
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// The comment-free template lives inside the web/ bundle so Vercel's
// file-tracing includes it automatically. The sibling file in the
// repo-root data/ dir is kept for Python tooling.
const DEFAULT_TEMPLATE = resolve(
  process.cwd(),
  "src/features/settlement/data/templates/master_template_node.xlsx",
);

/** Column positions (1-indexed). Matches the 62-col GT layout. */
const COL = {
  unique_identifier: 1,
  channel_title_jp: 2,
  title_kr: 3,
  title_jp: 4,
  updated: 5,
  recoder: 6,
  company: 7,
  launch_date: 8,
  sales_month: 9,
  settlement_month: 10,
  deposit_month: 11,
  country: 12,
  clients: 13,
  channel: 14,
  type: 15,
  distribution_strategy: 16,
  settlement_currency: 17,
  vehicle_currency: 18,
  total_amount_jpy: 19,
  fee_jpy: 20,
  before_tax_jpy: 21,
  after_tax_jpy: 22,
  rs: 23,
  before_tax_income_jpy: 24,
  withholding_tax_jpy: 25,
  tax_jpy: 26,
  after_tax_income_jpy_a: 27,
  after_tax_income_jpy_b: 28,
  exchange_rate: 29,
  rate_krw_krw: 30,
  // col 31 intentionally skipped (gap in master)
  fee_krw: 32,
  before_tax_krw: 33,
  after_tax_krw: 34,
  after_tax_income_krw: 35,
  vat_krw: 36,
  withholding_tax_krw: 37,
  sales_krw: 38,
  mg_begin: 39,
  mg_increase: 40,
  mg_decrease: 41,
  mg_end: 42,
  note1: 43,
  note2: 44,
} as const;

export interface FillOptions {
  /** YYYYMM, e.g. "202604" */
  month: string;
  /** GT / sales_records-shaped row objects */
  records: Record<string, unknown>[];
  /** Override template path */
  templatePath?: string;
  /** Override sheet name (default: 일본_신INPUT_{N}월) */
  sheetName?: string;
  /** Kept for API compat — a no-op in the Node path */
  recalculate?: boolean;
}

export interface FillResult {
  buffer: Buffer;
  rows_written: number;
  fill_ms: number;
  sheet: string;
  recalculated: boolean;
  recalc_ms: number;
}

function sheetNameForMonth(month: string): string {
  const n = Number(month.slice(4, 6));
  return `일본_신INPUT_${n}월`;
}

type Prim = string | number | boolean | Date | null;

/** Pick the first non-empty value among `keys`; always returns something exceljs accepts. */
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

function toDate(x: unknown): Date | null {
  if (!x) return null;
  if (x instanceof Date) return x;
  const d = new Date(String(x));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fillTemplate(opts: FillOptions): Promise<FillResult> {
  const { month, records } = opts;
  if (!/^\d{6}$/.test(month)) {
    throw new Error(`Invalid month '${month}', expected YYYYMM`);
  }

  const templatePath = opts.templatePath ?? DEFAULT_TEMPLATE;
  const sheetName = opts.sheetName ?? sheetNameForMonth(month);
  const t0 = Date.now();

  const wb = new ExcelJS.Workbook();
  const tplBuf = await readFile(templatePath);
  await wb.xlsx.load(tplBuf as unknown as ExcelJS.Buffer);

  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    const source = wb.worksheets.find((ws) =>
      /^일본_신INPUT_\d+월$/.test(ws.name),
    );
    if (!source) {
      throw new Error(`Sheet '${sheetName}' not found in template.`);
    }
    // exceljs has no copyWorksheet; repurpose the source sheet.
    sheet = source;
    sheet.name = sheetName;
  }

  // Drop every unrelated sheet. The output workbook only needs:
  //   · the target monthly sheet (sheetName)
  //   · 타이틀 — VLOOKUP target for column C/D
  //   · MG     — rarely referenced but cheap to keep
  // Stripping everything else avoids exceljs round-tripping quirks on
  // sheets like 취합 / 결산자료 / 출판 (cross-workbook formulas,
  // conditional-formatting operator enums, etc.) that trigger Excel's
  // "부분의 수식이 제거되었습니다" repair dialog on open.
  const keep = new Set([sheetName, "타이틀", "MG"]);
  for (const ws of [...wb.worksheets]) {
    if (!keep.has(ws.name)) {
      wb.removeWorksheet(ws.id);
    }
  }

  // Capture the golden reference row (row 5) styles + formulas.
  const tplRow = sheet.getRow(5);
  const tplStyles: (Partial<ExcelJS.Style> | undefined)[] = [];
  const tplFormulas: (string | null)[] = [];
  for (let c = 1; c <= 62; c++) {
    const cell = tplRow.getCell(c);
    tplStyles[c] = cell.style ? { ...cell.style } : undefined;
    const val = cell.value;
    if (val && typeof val === "object" && "formula" in val) {
      tplFormulas[c] = (val as ExcelJS.CellFormulaValue).formula;
    } else {
      tplFormulas[c] = null;
    }
  }

  // Clear rows 5 .. actualRowCount
  const oldLast = Math.max(sheet.actualRowCount, 5);
  for (let r = 5; r <= oldLast; r++) {
    sheet.getRow(r).values = [];
  }

  const firstDataRow = 5;
  let rowsWritten = 0;

  records.forEach((rec, i) => {
    const rowIdx = firstDataRow + i;
    const row = sheet!.getRow(rowIdx);

    // Strings
    row.getCell(COL.unique_identifier).value = str(rec, "unique_identifier", "unique_id");
    row.getCell(COL.channel_title_jp).value = str(rec, "channel_title_jp");
    row.getCell(COL.title_kr).value = str(rec, "title_kr");
    row.getCell(COL.title_jp).value = str(rec, "title_jp");
    row.getCell(COL.updated).value = toDate(pick(rec, "updated_at", "updated"));
    row.getCell(COL.recoder).value = str(rec, "recoder");
    row.getCell(COL.company).value = str(rec, "company") ?? "RJ";
    row.getCell(COL.launch_date).value = toDate(pick(rec, "launch_date"));
    row.getCell(COL.sales_month).value = toDate(pick(rec, "sales_month"));
    row.getCell(COL.settlement_month).value = toDate(pick(rec, "settlement_month"));
    row.getCell(COL.deposit_month).value = toDate(pick(rec, "deposit_month"));
    row.getCell(COL.country).value = str(rec, "country") ?? "JP";
    row.getCell(COL.clients).value = str(rec, "clients", "client_display_name", "client_code");
    row.getCell(COL.channel).value = str(rec, "channel", "channel_code");
    row.getCell(COL.type).value = str(rec, "type");
    row.getCell(COL.distribution_strategy).value = str(rec, "distribution_strategy");
    row.getCell(COL.settlement_currency).value = str(rec, "settlement_currency") ?? "JPY";
    row.getCell(COL.vehicle_currency).value = str(rec, "vehicle_currency") ?? "KRW";

    // JPY numbers
    row.getCell(COL.total_amount_jpy).value = num(pick(rec, "total_amount_jpy"));
    row.getCell(COL.fee_jpy).value = num(pick(rec, "fee_jpy")) ?? 0;
    row.getCell(COL.before_tax_jpy).value = num(pick(rec, "before_tax_jpy"));
    row.getCell(COL.after_tax_jpy).value = num(pick(rec, "after_tax_jpy"));
    row.getCell(COL.rs).value = pick(rec, "rs_label", "rs", "rs_rate");
    row.getCell(COL.before_tax_income_jpy).value = num(pick(rec, "before_tax_income_jpy"));
    row.getCell(COL.withholding_tax_jpy).value = num(pick(rec, "withholding_tax_jpy")) ?? 0;
    row.getCell(COL.tax_jpy).value = num(pick(rec, "consumption_tax_jpy", "tax_jpy"));
    row.getCell(COL.after_tax_income_jpy_a).value = num(pick(rec, "after_tax_income_jpy", "after_tax_income_jpy_a"));
    row.getCell(COL.after_tax_income_jpy_b).value = num(pick(rec, "after_tax_income_jpy_b"));

    // Exchange
    row.getCell(COL.exchange_rate).value = num(pick(rec, "exchange_rate", "rate_jpy_krw"));
    row.getCell(COL.rate_krw_krw).value = num(pick(rec, "rate_krw_krw")) ?? 1;

    // KRW
    row.getCell(COL.fee_krw).value = num(pick(rec, "fee_krw"));
    row.getCell(COL.before_tax_krw).value = num(pick(rec, "before_tax_krw"));
    row.getCell(COL.after_tax_krw).value = num(pick(rec, "after_tax_krw"));
    row.getCell(COL.after_tax_income_krw).value = num(pick(rec, "after_tax_income_krw"));
    row.getCell(COL.vat_krw).value = num(pick(rec, "vat_krw"));
    row.getCell(COL.withholding_tax_krw).value = num(pick(rec, "withholding_tax_krw"));
    row.getCell(COL.sales_krw).value = num(pick(rec, "sales_krw"));

    // MG
    row.getCell(COL.mg_begin).value = num(pick(rec, "mg_begin")) ?? 0;
    row.getCell(COL.mg_increase).value = num(pick(rec, "mg_increase")) ?? 0;
    row.getCell(COL.mg_decrease).value = num(pick(rec, "mg_decrease")) ?? 0;
    row.getCell(COL.mg_end).value = num(pick(rec, "mg_end")) ?? 0;

    row.getCell(COL.note1).value = str(rec, "note1");
    row.getCell(COL.note2).value = str(rec, "note2");

    // Copy row-5 style + formulas onto this data row. Columns that we
    // populated from DB data above (C=title_kr, D=title_jp) are styled
    // but skipped by the formula loop — otherwise the VLOOKUP template
    // would clobber our value and Excel renders #N/A when the lookup
    // table ('타이틀') has no match.
    const SKIP_FORMULA_COLS = new Set<number>([COL.title_kr, COL.title_jp]);
    for (let c = 1; c <= 62; c++) {
      const destCell = row.getCell(c);
      const s = tplStyles[c];
      if (s) destCell.style = s;
      if (SKIP_FORMULA_COLS.has(c)) continue;
      const f = tplFormulas[c];
      if (f) {
        const adjusted = f.replace(/(\$?)(\d+)/g, (_m, dollar, n) => {
          if (dollar === "$") return dollar + n;
          const refRow = Number(n);
          return refRow === 5 ? dollar + String(rowIdx) : dollar + n;
        });
        destCell.value = { formula: adjusted } as ExcelJS.CellFormulaValue;
      }
    }

    row.commit();
    rowsWritten++;
  });

  // Stretch SUBTOTAL ranges in row 1
  const finalRow = firstDataRow + rowsWritten - 1;
  const r1 = sheet.getRow(1);
  for (let c = 1; c <= 62; c++) {
    const cell = r1.getCell(c);
    const val = cell.value;
    if (val && typeof val === "object" && "formula" in val) {
      const f = (val as ExcelJS.CellFormulaValue).formula;
      if (f && /SUBTOTAL\(9,/i.test(f)) {
        const adjusted = f.replace(
          /([A-Z]+)(\d+):([A-Z]+)\d+/g,
          (_m, col1, start, col2) => `${col1}${start}:${col2}${finalRow}`,
        );
        cell.value = { formula: adjusted };
      }
    }
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  return {
    buffer,
    rows_written: rowsWritten,
    fill_ms: Date.now() - t0,
    sheet: sheetName,
    recalculated: false,
    recalc_ms: 0,
  };
}
