'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react';
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
  const covered = new Map<string, { row: number; col: number }>();
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
        if (r !== r1 || c !== c1) covered.set(`${r}:${c}`, { row: r1, col: c1 });
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
const VIRTUAL_ROW_HEIGHT = 25;
const VIRTUAL_OVERSCAN_ROWS = 8;
const VIRTUAL_OVERSCAN_COLS = 6;

/** Excel column width (character units) → CSS px (Calibri-11 approximation; 8.43 chars ≈ 64px). */
function columnWidthPx(width: number | null | undefined): number {
  const chars = typeof width === 'number' && width > 0 ? width : 8.43;
  return Math.max(28, Math.round(chars * 7 + 5));
}

/** Excel row height is in points; CSS px = pt × 4/3. */
function rowHeightPx(height: number | null | undefined): number | undefined {
  return typeof height === 'number' && height > 0 ? Math.round((height * 4) / 3) : undefined;
}

/** Largest index whose prefix offset is <= offset; works for row heights and column widths alike. */
function findIndexForOffset(prefixOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = Math.max(0, prefixOffsets.length - 1);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (prefixOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, Math.max(0, prefixOffsets.length - 2));
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [viewportWidth, setViewportWidth] = useState(1280);

  const sheet = useMemo(
    () => preview.sheets.find((s) => s.name === activeSheet) ?? preview.sheets[0] ?? null,
    [preview.sheets, activeSheet],
  );
  const sheetName = sheet?.name ?? '';
  const shownRows = sheet?.rows.length ?? 0;
  const shownCols = sheet?.rows[0]?.length ?? 0;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    const frame = window.requestAnimationFrame(() => {
      setScrollTop(0);
      setScrollLeft(0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sheetName]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      setViewportHeight(scroller.clientHeight || 720);
      setViewportWidth(scroller.clientWidth || 1280);
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(scroller);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      setScrollTop(target.scrollTop);
      setScrollLeft(target.scrollLeft);
      scrollFrameRef.current = null;
    });
  };

  const rowMetrics = useMemo(() => {
    const heights = Array.from({ length: shownRows }, (_, i) => rowHeightPx(sheet?.rowHeights?.[i]) ?? VIRTUAL_ROW_HEIGHT);
    const offsets = [0];
    for (const height of heights) {
      offsets.push(offsets[offsets.length - 1] + height);
    }
    return { heights, offsets };
  }, [sheet?.rowHeights, shownRows]);

  const colMetrics = useMemo(() => {
    const widths = Array.from({ length: shownCols }, (_, i) => columnWidthPx(sheet?.columnWidths?.[i]));
    const offsets = [0];
    for (const width of widths) {
      offsets.push(offsets[offsets.length - 1] + width);
    }
    return { widths, offsets, totalWidth: offsets[offsets.length - 1] ?? 0 };
  }, [sheet?.columnWidths, shownCols]);

  if (!sheet) {
    return null;
  }

  // Use explicit workbook widths, but render only the visible row/column window.
  // This keeps the Excel-like surface while avoiding thousands of hidden cells
  // on lower-powered Chrome/remote desktop environments.
  const hasWidths = Boolean(sheet.columnWidths?.some((w) => typeof w === 'number'));
  const tableStyle: CSSProperties | undefined = hasWidths
    ? {
        tableLayout: 'fixed',
        width: ROW_HEADER_WIDTH + colMetrics.totalWidth,
      }
    : undefined;
  const canVirtualizeCols = hasWidths;
  const anchorRow = findIndexForOffset(rowMetrics.offsets, scrollTop);
  const visibleStart = Math.max(0, anchorRow - VIRTUAL_OVERSCAN_ROWS);
  const visibleEnd = Math.min(
    shownRows,
    findIndexForOffset(rowMetrics.offsets, scrollTop + viewportHeight) + VIRTUAL_OVERSCAN_ROWS + 1,
  );
  const dataScrollLeft = Math.max(0, scrollLeft - ROW_HEADER_WIDTH);
  const anchorCol = findIndexForOffset(colMetrics.offsets, dataScrollLeft);
  const visibleColStart = canVirtualizeCols ? Math.max(0, anchorCol - VIRTUAL_OVERSCAN_COLS) : 0;
  const visibleColEnd = canVirtualizeCols
    ? Math.min(
        shownCols,
        findIndexForOffset(colMetrics.offsets, dataScrollLeft + viewportWidth) + VIRTUAL_OVERSCAN_COLS + 1,
      )
    : shownCols;
  const visibleRows = sheet.rows.slice(visibleStart, visibleEnd);
  const visibleColIndexes = Array.from(
    { length: Math.max(0, visibleColEnd - visibleColStart) },
    (_, i) => visibleColStart + i,
  );
  const topSpacerHeight = rowMetrics.offsets[visibleStart] ?? 0;
  const bottomSpacerHeight = Math.max(0, (rowMetrics.offsets[shownRows] ?? 0) - (rowMetrics.offsets[visibleEnd] ?? 0));
  const leftSpacerWidth = canVirtualizeCols ? (colMetrics.offsets[visibleColStart] ?? 0) : 0;
  const rightSpacerWidth = canVirtualizeCols ? Math.max(0, colMetrics.totalWidth - (colMetrics.offsets[visibleColEnd] ?? 0)) : 0;
  // In horizontal virtualization mode, merged cells are intentionally shown as
  // simple cells. Native HTML colSpan/rowSpan can consume virtual spacer
  // columns and distort the grid; the downloaded Excel remains the merge-true
  // source of record.
  const mergeMaps = canVirtualizeCols
    ? { masters: new Map<string, { rowSpan: number; colSpan: number }>(), covered: new Map<string, { row: number; col: number }>() }
    : buildMergeMaps(sheet.merges, shownRows, shownCols);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('INPUT 미리보기', 'INPUT プレビュー')}</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>{t('생성', '生成')}: {formatGeneratedAt(preview.generatedAt)}</span>
          <span>
            {t('행', '行')}: {preview.rowsWritten} / {t('전자', '電子')}: {preview.electronicRows} / {t('출판', '出版')}: {preview.publicationRows}
          </span>
        </div>
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap gap-2">
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
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800"
      >
        <table className="border-collapse text-xs" style={tableStyle}>
          {hasWidths && (
            <colgroup>
              <col style={{ width: ROW_HEADER_WIDTH }} />
              {leftSpacerWidth > 0 && <col style={{ width: leftSpacerWidth }} />}
              {visibleColIndexes.map((cIdx) => (
                <col key={cIdx} style={{ width: colMetrics.widths[cIdx] }} />
              ))}
              {rightSpacerWidth > 0 && <col style={{ width: rightSpacerWidth }} />}
            </colgroup>
          )}
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border border-slate-200 bg-slate-100 px-2 py-1 text-slate-500" />
              {leftSpacerWidth > 0 && (
                <th aria-hidden="true" className="sticky top-0 z-10 border-0 bg-slate-100 p-0" />
              )}
              {visibleColIndexes.map((cIdx) => (
                <th
                  key={cIdx}
                  className={`sticky top-0 z-20 border border-slate-200 bg-slate-100 px-2 py-1 font-semibold text-slate-600 ${hasWidths ? 'overflow-hidden' : 'min-w-[80px]'}`}
                >
                  {columnLetter(cIdx + 1)}
                </th>
              ))}
              {rightSpacerWidth > 0 && (
                <th aria-hidden="true" className="sticky top-0 z-10 border-0 bg-slate-100 p-0" />
              )}
            </tr>
          </thead>
          <tbody>
            {topSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={visibleColIndexes.length + 1 + (leftSpacerWidth > 0 ? 1 : 0) + (rightSpacerWidth > 0 ? 1 : 0)}
                  style={{ height: topSpacerHeight, padding: 0, border: 0 }}
                />
              </tr>
            )}
            {visibleRows.map((row, localIdx) => {
              const rIdx = visibleStart + localIdx;
              return (
                <tr key={rIdx} style={{ height: rowHeightPx(sheet.rowHeights?.[rIdx]) ?? VIRTUAL_ROW_HEIGHT }}>
                  <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-500">
                    {rIdx + 1}
                  </th>
                  {leftSpacerWidth > 0 && <td aria-hidden="true" className="border-0 p-0" />}
                  {visibleColIndexes.map((cIdx) => {
                    const cell = row[cIdx] ?? { value: null };
                    const key = `${rIdx}:${cIdx}`;
                    const coveredBy = mergeMaps.covered.get(key);
                    const masterVisible = coveredBy
                      ? coveredBy.row >= visibleStart && coveredBy.row < visibleEnd && coveredBy.col >= visibleColStart && coveredBy.col < visibleColEnd
                      : false;
                    if (coveredBy && masterVisible) return null;
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
                  {rightSpacerWidth > 0 && <td aria-hidden="true" className="border-0 p-0" />}
                </tr>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={visibleColIndexes.length + 1 + (leftSpacerWidth > 0 ? 1 : 0) + (rightSpacerWidth > 0 ? 1 : 0)}
                  style={{ height: bottomSpacerHeight, padding: 0, border: 0 }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-1 shrink-0 text-xs text-slate-500 dark:text-slate-400">
        {t(
          '미리보기는 생성되는 Excel 파일 전체를 빠르게 확인하는 화면입니다. 성능을 위해 큰 시트의 병합 셀은 단순 셀로 표시될 수 있으며, 수식·병합·최종 서식은 다운로드한 Excel 파일이 기준입니다.',
          'プレビューは生成されるExcelファイル全体を素早く確認する画面です。性能維持のため、大きなシートの結合セルは通常セルとして表示される場合があります。数式・結合・最終書式はダウンロードしたExcelファイルが基準です。',
        )}
      </p>
    </section>
  );
}

