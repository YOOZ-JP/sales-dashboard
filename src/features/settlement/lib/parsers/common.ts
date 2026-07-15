/**
 * Shared parser utilities.
 * - File readers (xlsx, csv/tsv)
 * - Cell coercion (numbers, dates, currency symbols)
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";

export function readWorkbook(buffer: ArrayBuffer | Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: buffer instanceof Buffer ? "buffer" : "array", cellDates: true });
}

export function sheetToRows<T = Record<string, unknown>>(
  wb: XLSX.WorkBook,
  sheetName?: string,
  header: "A" | 1 = 1,
): T[] {
  const name = sheetName ?? wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet not found: ${name}`);
  return XLSX.utils.sheet_to_json<T>(ws, { header, defval: null, raw: false });
}

export function sheetToMatrix(wb: XLSX.WorkBook, sheetName?: string): unknown[][] {
  const name = sheetName ?? wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet not found: ${name}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }) as unknown[][];
}

export function parseCsv(buffer: string | Buffer, delimiter?: string) {
  const text = typeof buffer === "string" ? buffer : buffer.toString("utf-8");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter,
    skipEmptyLines: true,
  });
  return result.data;
}

const JPY_CLEAN_RE = /[¥￥,\s円]/g;

export function toNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "object") {
    const obj = v as { v?: unknown; result?: unknown };
    if (obj.v !== undefined) return toNumber(obj.v);
    if (obj.result !== undefined) return toNumber(obj.result);
  }
  const s = String(v).replace(JPY_CLEAN_RE, "").replace(/−/g, "-");
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

export function toOptionalNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = toNumber(v);
  return n === 0 && String(v).replace(JPY_CLEAN_RE, "") === "" ? null : n;
}

export function toIsoMonth(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-01`;
  const s = String(v).trim();
  const m = s.match(/(\d{4})[-/年]?(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-01`;
  return null;
}

export function toIsoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/(\d{4})[-/年]?(\d{1,2})[-/月]?(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return null;
}

/** 0.60 | 60 | "60%" | "50/60%" → 0.60 */
export function parseRsRate(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v > 1 ? v / 100 : v;
  const s = String(v).trim();
  const m = s.match(/([\d.]+)\s*%/);
  if (m) return Number(m[1]) / 100;
  const compound = s.match(/^([\d.]+)\s*\/\s*([\d.]+)/);
  if (compound) return Number(compound[2]) / 100;  // take the higher tier
  const n = Number(s);
  if (isFinite(n)) return n > 1 ? n / 100 : n;
  return 0;
}
