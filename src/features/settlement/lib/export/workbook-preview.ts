import ExcelJS from "exceljs";

/**
 * Browser-facing preview types.
 *
 * A preview is a read-only snapshot of the SAME workbook buffer produced by
 * `fillInputV2Template` (the download path). It returns every generated row
 * and column so the browser preview matches the downloaded `.xlsx` workbook.
 *
 * Basic workbook styling (solid fills, font bold/color, horizontal alignment,
 * column widths, row heights) is carried along so the browser table can mimic
 * the generated Excel file. Styles are deduplicated into a per-sheet table and
 * cells reference them by index, keeping the JSON bounded.
 */
export type WorkbookPreviewStyle = {
  /** Solid-fill background color as "#RRGGBB". */
  bg?: string;
  /** Font color as "#RRGGBB". */
  color?: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
};

export type WorkbookPreviewCell = {
  value: string | number | boolean | null;
  formula?: string;
  type?: "string" | "number" | "boolean" | "date" | "formula" | "blank";
  /** Index into the sheet's deduplicated `styles` table. */
  s?: number;
};

export type WorkbookPreviewSheet = {
  name: string;
  /** Total rows present in the sheet (not just the previewed slice). */
  rowCount: number;
  /** Total columns present in the sheet (not just the previewed slice). */
  columnCount: number;
  rows: WorkbookPreviewCell[][];
  merges?: string[];
  /** Deduplicated cell styles referenced by `WorkbookPreviewCell.s`. */
  styles?: WorkbookPreviewStyle[];
  /** Excel column widths (character units) for the previewed columns; null = sheet default. */
  columnWidths?: (number | null)[];
  /** Row heights in points for the previewed rows; null = sheet default. */
  rowHeights?: (number | null)[];
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

const BLANK_CELL: WorkbookPreviewCell = { value: null, type: "blank" };

/** Runaway guard: a sheet with more distinct styles than this stops collecting new ones. */
const MAX_STYLES_PER_SHEET = 256;

/** ExcelJS color ({ argb: "FFRRGGBB" }) → "#RRGGBB". Theme-indexed colors have no argb and are skipped. */
function argbToHex(color: unknown): string | undefined {
  const argb = (color as { argb?: unknown } | undefined)?.argb;
  if (typeof argb !== "string") return undefined;
  if (/^[0-9A-Fa-f]{8}$/.test(argb)) {
    if (argb.slice(0, 2).toUpperCase() === "00") return undefined; // fully transparent
    return `#${argb.slice(2).toUpperCase()}`;
  }
  if (/^[0-9A-Fa-f]{6}$/.test(argb)) return `#${argb.toUpperCase()}`;
  return undefined;
}

/** Extract the subset of a cell's style the preview can render; null when there is nothing to carry. */
function toPreviewStyle(cell: ExcelJS.Cell): WorkbookPreviewStyle | null {
  const style: WorkbookPreviewStyle = {};
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern === "solid") {
    const bg = argbToHex(fill.fgColor);
    if (bg) style.bg = bg;
  }
  const font = cell.font;
  if (font) {
    if (font.bold) style.bold = true;
    const color = argbToHex(font.color);
    if (color) style.color = color;
  }
  const horizontal = cell.alignment?.horizontal;
  if (horizontal === "left" || horizontal === "center" || horizontal === "right") {
    style.align = horizontal;
  }
  return Object.keys(style).length > 0 ? style : null;
}

function styleKey(style: WorkbookPreviewStyle): string {
  return `${style.bg ?? ""}|${style.color ?? ""}|${style.bold ? 1 : 0}|${style.align ?? ""}`;
}

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
 * Load a generated workbook buffer and return full per-sheet cell JSON.
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
    const shownRows = totalRows;
    const shownCols = totalCols;

    const styles: WorkbookPreviewStyle[] = [];
    const styleIndexByKey = new Map<string, number>();
    const rowHeights: (number | null)[] = [];
    let hasRowHeight = false;

    const rows: WorkbookPreviewCell[][] = [];
    for (let r = 1; r <= shownRows; r += 1) {
      const row = ws.getRow(r);
      const height = typeof row.height === "number" && row.height > 0 ? Math.round(row.height * 100) / 100 : null;
      if (height !== null) hasRowHeight = true;
      rowHeights.push(height);
      const cells: WorkbookPreviewCell[] = [];
      for (let c = 1; c <= shownCols; c += 1) {
        const cell = row.getCell(c);
        const previewCell = toPreviewCell(cell.value);
        const style = toPreviewStyle(cell);
        if (style) {
          const key = styleKey(style);
          let idx = styleIndexByKey.get(key);
          if (idx === undefined && styles.length < MAX_STYLES_PER_SHEET) {
            idx = styles.length;
            styles.push(style);
            styleIndexByKey.set(key, idx);
          }
          cells.push(idx === undefined ? previewCell : { ...previewCell, s: idx });
        } else {
          cells.push(previewCell);
        }
      }
      rows.push(cells);
    }

    const columnWidths: (number | null)[] = [];
    let hasColumnWidth = false;
    for (let c = 1; c <= shownCols; c += 1) {
      const width = ws.getColumn(c).width;
      const rounded = typeof width === "number" && width > 0 ? Math.round(width * 100) / 100 : null;
      if (rounded !== null) hasColumnWidth = true;
      columnWidths.push(rounded);
    }

    return {
      name: ws.name,
      rowCount: totalRows,
      columnCount: totalCols,
      rows,
      ...(styles.length > 0 ? { styles } : {}),
      merges: ((ws.model as { merges?: string[] }).merges ?? []).filter((range) => typeof range === "string"),
      ...(hasColumnWidth ? { columnWidths } : {}),
      ...(hasRowHeight ? { rowHeights } : {}),
    };
  });

  return { ...meta, sheets };
}
