'use client';

import { useMemo } from 'react';
import { useApp } from '@/context/AppContext';

export type PreviewCell = {
  value: string | number | boolean | null;
  formula?: string;
  type?: string;
};

export type PreviewSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  rows: PreviewCell[][];
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
  const truncated = shownRows < sheet.rowCount || shownCols < sheet.columnCount;

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

      <div className="mt-4 max-h-[620px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border border-slate-200 bg-slate-100 px-2 py-1 text-slate-500 dark:border-slate-700 dark:bg-slate-800" />
              {Array.from({ length: shownCols }, (_, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-20 min-w-[80px] border border-slate-200 bg-slate-100 px-2 py-1 font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  {columnLetter(i + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rIdx) => (
              <tr key={rIdx}>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-normal text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                  {rIdx + 1}
                </th>
                {row.map((cell, cIdx) => (
                  <td
                    key={cIdx}
                    title={cell.formula ? `=${cell.formula}` : undefined}
                    className={`whitespace-nowrap border border-slate-200 px-2 py-1 text-slate-800 dark:border-slate-800 dark:text-slate-200 ${
                      typeof cell.value === 'number' ? 'text-right tabular-nums' : ''
                    }`}
                  >
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {truncated && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {t(
            `미리보기는 일부만 표시합니다. (표시 ${shownRows}행 × ${shownCols}열 / 전체 ${sheet.rowCount}행 × ${sheet.columnCount}열)`,
            `プレビューは一部のみ表示します。（表示 ${shownRows}行 × ${shownCols}列 / 全体 ${sheet.rowCount}行 × ${sheet.columnCount}列）`,
          )}
        </p>
      )}

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {t(
          '웹 미리보기는 빠른 확인용입니다. 수식/서식까지 포함한 최종본은 다운로드 파일을 기준으로 확인해 주세요.',
          'Webプレビューは簡易確認用です。数式・書式を含む最終版はダウンロードファイルをご確認ください。',
        )}
      </p>
    </section>
  );
}
