'use client';

import { useMemo, type CSSProperties } from 'react';
import { useApp } from '@/context/AppContext';

export type PreviewStyle = {
  bg?: string;
  color?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
};

export type PreviewCell = {
  value: string | number | boolean | null;
  formula?: string;
  type?: string;
  s?: number;
};

export type PreviewSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  rows: PreviewCell[][];
  merges?: string[];
  styles?: PreviewStyle[];
  columnWidths?: (number | null)[];
  rowHeights?: (number | null)[];
};

export type PreviewData = {
  month: string;
  source: string;
  rowsWritten: number;
  electronicRows: number;
  publicationRows: number;
  generatedAt: string;
  sheets: PreviewSheet[];
};

type InputPreviewTableProps = {
  preview: PreviewData;
  activeSheet: string;
  onSheetChange: (sheet: string) => void;
};

/** Bijective base-26 spreadsheet column label: 1 -> A, 27 -> AA, 97 -> CS. */
function columnLetter(index: number): string {
  let n = index;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function columnIndex(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  const col = columnIndex(m[1]);
  const row = Number(m[2]);
  return row > 0 && col > 0 ? { row: row - 1, col: col - 1 } : null;
}

function buildMergeMaps(merges: string[] | undefined, shownRows: number, shownCols: number) {
  const masters = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const range of merges ?? []) {
    const [fromRaw, toRaw] = range.split(':');
    if (!fromRaw || !toRaw) continue;
    const from = parseCellRef(fromRaw);
    const to = parseCellRef(toRaw);
    if (!from || !to) continue;
    const r1 = Math.min(from.row, to.row);
    const r2 = Math.min(Math.max(from.row, to.row), shownRows - 1);
    const c1 = Math.min(from.col, to.col);
    const c2 = Math.min(Math.max(from.col, to.col), shownCols - 1);
    if (r1 >= shownRows || c1 >= shownCols || r2 < r1 || c2 < c1) continue;
    masters.set(`${r1}:${c1}`, { rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
      }
    }
  }
  return { masters, covered };
}

function formatCell(cell: PreviewCell): string {
  if (cell.value === null || cell.value === undefined) return '';
  if (typeof cell.value === 'number') return String(cell.value);
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return String(cell.value);
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Server-produced colors are already "#RRGGBB", but only ever inject values that match. */
const SAFE_HEX = /^#[0-9A-F]{6}$/i;

const ROW_HEADER_WIDTH = 44;

/** Excel column width (character units) → CSS px (Calibri-11 approximation; 8.43 chars ≈ 64px). */
function columnWidthPx(width: number | null | undefined): number {
  const chars = typeof width === 'number' && width > 0 ? width : 8.43;
  return Math.max(28, Math.round(chars * 7 + 5));
}

/** Excel row height is in points; CSS px = pt × 4/3. */
function rowHeightPx(height: number | null | undefined): number | undefined {
  return typeof height === 'number' && height > 0 ? Math.round((height * 4) / 3) : undefined;
}

function cellCss(cell: PreviewCell, styles?: PreviewStyle[]): CSSProperties | undefined {
  if (cell.s === undefined || !styles) return undefined;
  const style = styles[cell.s];
  if (!style) return undefined;
  const css: CSSProperties = {};
  if (style.bg && SAFE_HEX.test(style.bg)) css.backgroundColor = style.bg;
  if (style.color && SAFE_HEX.test(style.color)) css.color = style.color;
  if (style.bold) css.fontWeight = 700;
  if (style.align === 'left' || style.align === 'center' || style.align === 'right') css.textAlign = style.align;
  return Object.keys(css).length > 0 ? css : undefined;
}

export default function InputPreviewTable({ preview, activeSheet, onSheetChange }: InputPreviewTableProps) {
  const { t } = useApp();

  const sheet = useMemo(
    () => preview.sheets.find((s) => s.name === activeSheet) ?? preview.sheets[0],
    [preview.sheets, activeSheet],
  );

  if (!sheet) {
    return null;
  }

  const shownRows = sheet.rows.length;
  const shownCols = sheet.rows[0]?.length ?? 0;

  // With workbook column widths available, lay the table out exactly like the
  // sheet (fixed layout + explicit pixel widths, long text clipped like Excel).
  // Older payloads without widths keep the size-to-content behavior.
  const hasWidths = Boolean(sheet.columnWidths?.some((w) => typeof w === 'number'));
  const colPx = Array.from({ length: shownCols }, (_, i) => columnWidthPx(sheet.columnWidths?.[i]));
  const tableStyle: CSSProperties | undefined = hasWidths
    ? { tableLayout: 'fixed', width: ROW_HEADER_WIDTH + colPx.reduce((a, b) => a + b, 0) }
    : undefined;
  const mergeMaps = buildMergeMaps(sheet.merges, shownRows, shownCols);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('INPUT 미리보기', 'INPUT プレビュー')}</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>{t('생성', '生成')}: {formatGeneratedAt(preview.generatedAt)}</span>
          <span>
            {t('행', '行')}: {preview.rowsWritten} / {t('전자', '電子')}: {preview.electronicRows} / {t('출판', '出版')}: {preview.publicationRows}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {preview.sheets.map((s) => {
          const active = s.name === sheet.name;
          return (
            <button
              key={s.name}
              onClick={() => onSheetChange(s.name)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                active
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-300 text-slate-700 hover:border-blue-400 dark:border-slate-700 dark:text-slate-200'
              }`}
            >
              {s.name}
            </button>
          );
        })}
      </div>

      {/* The grid keeps a light spreadsheet surface in both themes so cell
          fills/font colors from the workbook read the same as in Excel. */}
      <div className="mt-4 max-h-[620px] overflow-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800">
        <table className="border-collapse text-xs" style={tableStyle}>
          {hasWidths && (
            <colgroup>
              <col style={{ width: ROW_HEADER_WIDTH }} />
              {colPx.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border border-slate-200 bg-slate-100 px-2 py-1 text-slate-500" />
              {Array.from({ length: shownCols }, (_, i) => (
                <th
                  key={i}
                  className={`sticky top-0 z-20 border border-slate-200 bg-slate-100 px-2 py-1 font-semibold text-slate-600 ${hasWidths ? 'overflow-hidden' : 'min-w-[80px]'}`}
                >
                  {columnLetter(i + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rIdx) => (
              <tr key={rIdx} style={{ height: rowHeightPx(sheet.rowHeights?.[rIdx]) }}>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-500">
                  {rIdx + 1}
                </th>
                {row.map((cell, cIdx) => {
                  const key = `${rIdx}:${cIdx}`;
                  if (mergeMaps.covered.has(key)) return null;
                  const merge = mergeMaps.masters.get(key);
                  return (
                    <td
                      key={cIdx}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      title={cell.formula ? `=${cell.formula}` : undefined}
                      style={cellCss(cell, sheet.styles)}
                      className={`overflow-hidden whitespace-nowrap border border-slate-200 px-2 py-1 text-slate-800 ${
                        typeof cell.value === 'number' ? 'text-right tabular-nums' : ''
                      }`}
                    >
                      {formatCell(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {t(
          '미리보기는 생성되는 Excel 파일 전체를 표시하며, 서식(배경색·글자색·정렬·열 너비·병합 셀 등)을 지원 범위 안에서 따릅니다. 수식을 포함한 최종본은 다운로드한 Excel 파일이 기준입니다.',
          'プレビューは生成されるExcelファイル全体を表示し、書式（背景色・文字色・配置・列幅・結合セルなど）を対応範囲内で再現します。数式を含む最終版はダウンロードしたExcelファイルが基準です。',
        )}
      </p>
    </section>
  );
}
