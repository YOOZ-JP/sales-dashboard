/**
 * Read-only extraction of the electronic INPUT sheet from an xlsx buffer.
 *
 * Used for both sides of a comparison (generated candidate and human
 * answer-key). Strictly read-only: nothing here can write into either
 * workbook, so golden content can never leak into a candidate.
 *
 * Sheet selection: prefer the canonical sheet name (input_電子_N月), else the
 * first sheet whose row-4 header signature matches the known INPUT layout
 * (Unique Identifier / Channel / Type in the mapped columns). Anything else
 * is a clear error — we never guess a sheet.
 */
import ExcelJS from "exceljs";

import { ELECTRONIC_COL } from "../export/input-v2-filler";
import { identityKey, normalizeIdentityPart, type RowIdentity } from "./identity";

export const FIRST_DATA_ROW = 6;
const HEADER_ROW = 4;
const SHEET_NAME_PATTERN = /^input_電子_\d{1,2}月$/;

export type CompareField = keyof typeof ELECTRONIC_COL;
export const COMPARE_FIELDS = Object.keys(ELECTRONIC_COL) as CompareField[];

export type CellState = "blank" | "formula" | "value";
export type SemanticValue = string | number | boolean | null;

export interface CellSnapshot {
  state: CellState;
  /** Semantic value: numeric strings → number, dates → 'YYYY-MM-DD', text NFKC-trimmed. */
  value: SemanticValue;
  /** Row-masked formula text (A7 → A#) so row position never causes a diff. */
  formula: string | null;
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

const BLANK: CellSnapshot = { state: "blank", value: null, formula: null };

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
      return {
        state: "formula",
        value: semanticScalar(fv.result),
        formula: normalizeFormulaText(formula),
      };
    }
    if ("richText" in v) {
      const text = (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
      const value = semanticScalar(text);
      return value === null ? BLANK : { state: "value", value, formula: null };
    }
    if ("text" in v) {
      const value = semanticScalar((v as ExcelJS.CellHyperlinkValue).text);
      return value === null ? BLANK : { state: "value", value, formula: null };
    }
    if ("error" in v) {
      return { state: "value", value: String((v as ExcelJS.CellErrorValue).error), formula: null };
    }
    return BLANK;
  }
  const value = semanticScalar(v);
  return value === null ? BLANK : { state: "value", value, formula: null };
}

function headerText(ws: ExcelJS.Worksheet, col: number): string {
  return normalizeIdentityPart(snapshotCell(ws.getRow(HEADER_ROW).getCell(col)).value).toLowerCase();
}

/** Row-4 signature of the known INPUT layout, in the mapped columns. */
function headerLooksLikeInput(ws: ExcelJS.Worksheet): boolean {
  return (
    headerText(ws, ELECTRONIC_COL.unique_identifier) === "unique identifier" &&
    headerText(ws, ELECTRONIC_COL.channel) === "channel" &&
    headerText(ws, ELECTRONIC_COL.type) === "type"
  );
}

export async function readInputSheet(buffer: Buffer): Promise<InputSheetSnapshot> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const byName = wb.worksheets.filter((ws) =>
    SHEET_NAME_PATTERN.test(ws.name.normalize("NFKC").trim()),
  );
  let ws = byName.find(headerLooksLikeInput);
  if (!ws) ws = wb.worksheets.find(headerLooksLikeInput);
  if (!ws) {
    const names = wb.worksheets.map((w) => w.name).join(", ");
    throw new Error(
      `electronic INPUT sheet not found: no sheet named like input_電子_N月 with the expected ` +
        `row-${HEADER_ROW} headers (Unique Identifier / Channel / Type). Sheets present: ${names}`,
    );
  }

  const rows: InputRowSnapshot[] = [];
  const lastRow = Math.max(ws.actualRowCount, ws.rowCount, FIRST_DATA_ROW);
  for (let r = FIRST_DATA_ROW; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const cells = {} as Record<CompareField, CellSnapshot>;
    let hasValue = false;
    for (const field of COMPARE_FIELDS) {
      const snap = snapshotCell(row.getCell(ELECTRONIC_COL[field]));
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
