import ExcelJS from "exceljs";

/**
 * Browser-facing preview types.
 *
 * A preview is a bounded, read-only snapshot of the SAME workbook buffer produced by
 * `fillInputV2Template` (the download path). We deliberately cap rows/columns so the
 * JSON payload stays small; the downloaded `.xlsx` remains the complete authority.
 */
export type WorkbookPreviewCell = {
  value: string | number | boolean | null;
  formula?: string;
  type?: "string" | "number" | "boolean" | "date" | "formula" | "blank";
};

export type WorkbookPreviewSheet = {
  name: string;
  /** Total rows present in the sheet (not just the previewed slice). */
  rowCount: number;
  /** Total columns present in the sheet (not just the previewed slice). */
  columnCount: number;
  rows: WorkbookPreviewCell[][];
  merges?: string[];
};

export type WorkbookPreview = {
  month: string;
  source: string;
  rowsWritten: number;
  electronicRows: number;
  publicationRows: number;
  generatedAt: string;
  sheets: WorkbookPreviewSheet[];
};

/** Default caps applied when a sheet has no more specific rule. */
const DEFAULT_ROW_LIMIT = 150;
const DEFAULT_COL_LIMIT = 70;

/** Per-sheet-name-pattern preview bounds, matched in order. */
const SHEET_LIMITS: Array<{ test: (name: string) => boolean; rows: number; cols: number }> = [
  { test: (n) => /^input_電子_/.test(n), rows: 150, cols: 70 },
  { test: (n) => n === "タイトル", rows: 120, cols: 25 },
  { test: (n) => n === "고유번호", rows: 120, cols: 9 },
  { test: (n) => n === "設定", rows: 120, cols: 16 },
];

function limitsFor(name: string): { rows: number; cols: number } {
  const match = SHEET_LIMITS.find((l) => l.test(name));
  return match ? { rows: match.rows, cols: match.cols } : { rows: DEFAULT_ROW_LIMIT, cols: DEFAULT_COL_LIMIT };
}

const BLANK_CELL: WorkbookPreviewCell = { value: null, type: "blank" };

/** Convert a single ExcelJS cell value into a compact, JSON-safe preview cell. */
function toPreviewCell(value: ExcelJS.CellValue): WorkbookPreviewCell {
  if (value === null || value === undefined || value === "") {
    return BLANK_CELL;
  }
  if (typeof value === "string") {
    return { value, type: "string" };
  }
  if (typeof value === "number") {
    return { value, type: "number" };
  }
  if (typeof value === "boolean") {
    return { value, type: "boolean" };
  }
  if (value instanceof Date) {
    return { value: value.toISOString(), type: "date" };
  }
  if (typeof value === "object") {
    // Formula cell: prefer the cached result so the preview shows a value, not "=...".
    if ("formula" in value || "sharedFormula" in value) {
      const formula = "formula" in value ? value.formula : value.sharedFormula;
      const result = "result" in value ? value.result : undefined;
      const resolved =
        result instanceof Date
          ? result.toISOString()
          : typeof result === "string" || typeof result === "number" || typeof result === "boolean"
            ? result
            : null;
      return { value: resolved, formula: formula ?? undefined, type: "formula" };
    }
    // Rich text -> concatenated plain string.
    if ("richText" in value && Array.isArray(value.richText)) {
      return { value: value.richText.map((rt) => rt.text).join(""), type: "string" };
    }
    // Hyperlink -> visible text.
    if ("text" in value) {
      const text = (value as { text?: unknown }).text;
      return { value: typeof text === "string" ? text : String(text ?? ""), type: "string" };
    }
    // Error cell.
    if ("error" in value) {
      return { value: String((value as { error?: unknown }).error ?? ""), type: "string" };
    }
  }
  return { value: String(value), type: "string" };
}

/**
 * Load a generated workbook buffer and return bounded per-sheet cell JSON.
 * Includes the full `rowCount`/`columnCount` so the UI can note that only part is shown.
 */
export async function workbookBufferToPreview(
  buffer: Buffer,
  meta: {
    month: string;
    source: string;
    rowsWritten: number;
    electronicRows: number;
    publicationRows: number;
    generatedAt: string;
  },
): Promise<WorkbookPreview> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheets: WorkbookPreviewSheet[] = wb.worksheets.map((ws) => {
    const totalRows = ws.rowCount;
    const totalCols = ws.columnCount;
    const { rows: rowLimit, cols: colLimit } = limitsFor(ws.name);
    const shownRows = Math.min(totalRows, rowLimit);
    const shownCols = Math.min(totalCols, colLimit);

    const rows: WorkbookPreviewCell[][] = [];
    for (let r = 1; r <= shownRows; r += 1) {
      const row = ws.getRow(r);
      const cells: WorkbookPreviewCell[] = [];
      for (let c = 1; c <= shownCols; c += 1) {
        cells.push(toPreviewCell(row.getCell(c).value));
      }
      rows.push(cells);
    }

    return {
      name: ws.name,
      rowCount: totalRows,
      columnCount: totalCols,
      rows,
    };
  });

  return { ...meta, sheets };
}
