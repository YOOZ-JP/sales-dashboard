/**
 * Read-only extraction of the electronic INPUT sheet from an xlsx buffer.
 *
 * Used for both sides of a comparison (generated candidate and human
 * answer-key). Strictly read-only: nothing here can write into either
 * workbook, so golden content can never leak into a candidate.
 *
 * Sheet selection: a requested compatible sheet wins. Without an explicit
 * request, compatible canonical input_電子_N月 sheets use the rightmost/latest
 * worksheet in workbook order; a single other compatible INPUT sheet is the
 * final fallback. Anything else is a clear error — we never guess by filename
 * alone.
 */
import ExcelJS from "exceljs";

import { ELECTRONIC_COL } from "../export/input-v2-filler";
import { identityKey, normalizeIdentityPart, type RowIdentity } from "./identity";

export const FIRST_DATA_ROW = 6;
const HEADER_ROW = 4;
const SHEET_NAME_PATTERN = /^input_電子_\d{1,2}月$/;

export type CompareField = keyof typeof ELECTRONIC_COL;
export const COMPARE_FIELDS = Object.keys(ELECTRONIC_COL) as CompareField[];
type InputColumnMap = Record<CompareField, number>;

// The 2026 v3 template inserted a blank G column. Historical answer keys use
// the same schema with every field from company onward shifted one column left.
const LEGACY_ELECTRONIC_COL = Object.fromEntries(
  Object.entries(ELECTRONIC_COL).map(([field, col]) => [
    field,
    col >= ELECTRONIC_COL.company ? col - 1 : col,
  ]),
) as InputColumnMap;

// Publication uses the v3 column positions but has no separate accounting
// month column: settlement month is K and statement-received is L.
const PUBLICATION_COL = {
  ...ELECTRONIC_COL,
  month: 12,
  settlement_month: 11,
} as InputColumnMap;

export type CellState = "blank" | "formula" | "value";
export type SemanticValue = string | number | boolean | null;

export interface CellSnapshot {
  state: CellState;
  /** Semantic value: numeric strings → number, dates → 'YYYY-MM-DD', text NFKC-trimmed. */
  value: SemanticValue;
  /** Row-masked formula text (A7 → A#) so row position never causes a diff. */
  formula: string | null;
  /**
   * False only for formulas with no usable cached result (uncached or error):
   * the semantic value is unknown, which is never a business difference.
   */
  known: boolean;
}

export interface InputRowSnapshot {
  rowNumber: number;
  identity: RowIdentity;
  identityKey: string;
  cells: Record<CompareField, CellSnapshot>;
}

export interface InputSheetSnapshot {
  sheetName: string;
  rows: InputRowSnapshot[];
}

const BLANK: CellSnapshot = { state: "blank", value: null, formula: null, known: true };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Numeric strings ("1,234", "１２３") become numbers; blank-ish becomes null. */
export function semanticScalar(x: unknown): SemanticValue {
  if (x === null || x === undefined) return null;
  if (x instanceof Date) return isoDate(x);
  if (typeof x === "number" || typeof x === "boolean") return x;
  const t = String(x).normalize("NFKC").trim();
  if (t === "") return null;
  const numeric = t.replace(/,/g, "");
  if (/^[+-]?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
  return t;
}

/** Mask row numbers (A7 → A#) exactly like the golden-compare script does. */
function normalizeFormulaText(formula: string): string {
  return formula.replace(/(?<![$A-Z])([A-Z]{1,3})(\d+)/g, (_m, col: string) => `${col}#`);
}

function snapshotCell(cell: ExcelJS.Cell): CellSnapshot {
  const v = cell.value;
  if (v === null || v === undefined) return BLANK;
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("formula" in v || "sharedFormula" in v) {
      const fv = v as ExcelJS.CellFormulaValue & { sharedFormula?: string };
      const formula = typeof fv.formula === "string" ? fv.formula : fv.sharedFormula ?? "";
      const result = fv.result;
      // No cached result (fresh ExcelJS output) or a cached error: the
      // semantic value is unknown, not blank/zero.
      const uncached =
        result === null ||
        result === undefined ||
        (typeof result === "object" && !(result instanceof Date) && "error" in result);
      return {
        state: "formula",
        value: uncached ? null : semanticScalar(result),
        formula: normalizeFormulaText(formula),
        known: !uncached,
      };
    }
    if ("richText" in v) {
      const text = (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
      const value = semanticScalar(text);
      return value === null ? BLANK : { state: "value", value, formula: null, known: true };
    }
    if ("text" in v) {
      const value = semanticScalar((v as ExcelJS.CellHyperlinkValue).text);
      return value === null ? BLANK : { state: "value", value, formula: null, known: true };
    }
    if ("error" in v) {
      return {
        state: "value",
        value: String((v as ExcelJS.CellErrorValue).error),
        formula: null,
        known: true,
      };
    }
    return BLANK;
  }
  const value = semanticScalar(v);
  return value === null ? BLANK : { state: "value", value, formula: null, known: true };
}

function headerTextAt(ws: ExcelJS.Worksheet, row: number, col: number): string {
  return normalizeIdentityPart(snapshotCell(ws.getRow(row).getCell(col)).value).toLowerCase();
}

function headerText(ws: ExcelJS.Worksheet, col: number): string {
  return headerTextAt(ws, HEADER_ROW, col);
}

/** Row-4 signature of the known INPUT layout, in the mapped columns. */
function headerLooksLikeInput(ws: ExcelJS.Worksheet, cols: InputColumnMap): boolean {
  return (
    headerText(ws, cols.unique_identifier) === "unique identifier" &&
    headerText(ws, cols.channel) === "channel" &&
    headerText(ws, cols.type) === "type"
  );
}

function inputColumnMap(ws: ExcelJS.Worksheet): InputColumnMap | null {
  if (ws.name.normalize("NFKC").trim() === "input_出版") {
    const publicationHeaderOk =
      headerTextAt(ws, 5, PUBLICATION_COL.unique_identifier) === "고유번호" &&
      headerTextAt(ws, 5, PUBLICATION_COL.channel) === "채널" &&
      headerTextAt(ws, 5, PUBLICATION_COL.type) === "유형";
    if (publicationHeaderOk) return PUBLICATION_COL;
  }
  if (headerLooksLikeInput(ws, ELECTRONIC_COL)) return ELECTRONIC_COL;
  if (headerLooksLikeInput(ws, LEGACY_ELECTRONIC_COL)) return LEGACY_ELECTRONIC_COL;
  return null;
}

export async function readInputSheet(
  buffer: Buffer,
  preferredSheetName?: string,
  strictPreferred = false,
): Promise<InputSheetSnapshot> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const normalizedPreferred = preferredSheetName?.normalize("NFKC").trim();
  if (normalizedPreferred) {
    const preferred = wb.worksheets
      .map((ws) => ({ ws, cols: inputColumnMap(ws) }))
      .find(
        (item): item is { ws: ExcelJS.Worksheet; cols: InputColumnMap } =>
          item.ws.name.normalize("NFKC").trim() === normalizedPreferred && item.cols !== null,
      );
    if (preferred) return snapshotWorksheet(preferred.ws, preferred.cols);
    if (strictPreferred) {
      throw new Error(`requested INPUT sheet not found or incompatible: ${normalizedPreferred}`);
    }
  }

  const canonical = wb.worksheets
    .filter((ws) => SHEET_NAME_PATTERN.test(ws.name.normalize("NFKC").trim()))
    .map((ws) => ({ ws, cols: inputColumnMap(ws) }))
    .filter((item): item is { ws: ExcelJS.Worksheet; cols: InputColumnMap } => item.cols !== null);

  let selected = normalizedPreferred
    ? canonical.find((item) => item.ws.name.normalize("NFKC").trim() === normalizedPreferred)
    : undefined;
  if (!selected && canonical.length >= 1) {
    // Historical multi-month workbooks accumulate INPUT sheets from left to
    // right. The rightmost compatible canonical sheet is the active/latest one.
    selected = canonical[canonical.length - 1];
  }
  if (!selected) {
    const compatible = wb.worksheets
      .map((ws) => ({ ws, cols: inputColumnMap(ws) }))
      .filter((item): item is { ws: ExcelJS.Worksheet; cols: InputColumnMap } => item.cols !== null);
    if (compatible.length === 1) selected = compatible[0];
  }
  if (!selected) {
    const names = wb.worksheets.map((w) => w.name).join(", ");
    throw new Error(
      `electronic INPUT sheet not found: no unambiguous sheet named like input_電子_N月 with the expected ` +
        `row-${HEADER_ROW} headers (Unique Identifier / Channel / Type). Sheets present: ${names}`,
    );
  }
  return snapshotWorksheet(selected.ws, selected.cols);
}

function snapshotWorksheet(ws: ExcelJS.Worksheet, cols: InputColumnMap): InputSheetSnapshot {
  const rows: InputRowSnapshot[] = [];
  const lastRow = Math.max(ws.actualRowCount, ws.rowCount, FIRST_DATA_ROW);
  for (let r = FIRST_DATA_ROW; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const cells = {} as Record<CompareField, CellSnapshot>;
    let hasValue = false;
    for (const field of COMPARE_FIELDS) {
      const snap = snapshotCell(row.getCell(cols[field]));
      cells[field] = snap;
      if (snap.state === "value") hasValue = true;
    }
    // Rows with only formulas (uncleared template rows) or nothing are not data.
    if (!hasValue) continue;
    const title =
      normalizeIdentityPart(cells.channel_title_jp.value) ||
      normalizeIdentityPart(cells.title_jp.value);
    const identity: RowIdentity = {
      channel: normalizeIdentityPart(cells.channel.value),
      type: normalizeIdentityPart(cells.type.value),
      title,
    };
    rows.push({ rowNumber: r, identity, identityKey: identityKey(identity), cells });
  }

  return { sheetName: ws.name, rows };
}
