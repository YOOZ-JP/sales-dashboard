'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import InputPreviewTable, { type PreviewData } from './InputPreviewTable';

// Error state carries a kind instead of a translated string so that switching
// the UI language never has to re-run the (expensive) preview fetch.
type LoadError = { kind: 'missing' } | { kind: 'failed'; message: string };

function normalizeMonth(value: string): string {
  const trimmed = String(value ?? '').trim();
  const iso = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
  if (iso) return `${iso[1]}${iso[2]}`;
  return trimmed;
}

export default function InputPreviewWindow({ month }: { month: string }) {
  const { t } = useApp();
  const normalizedMonth = normalizeMonth(month);
  const validMonth = /^\d{6}$/.test(normalizedMonth);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(validMonth);
  const [error, setError] = useState<LoadError | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/settlement/preview-v2/${normalizedMonth}`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setPreview(null);
        setActiveSheet(null);
        setError({ kind: 'missing' });
        return;
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const data = json as PreviewData;
      setPreview(data);
      const firstInput = data.sheets.find((s) => s.name.startsWith('input_'));
      setActiveSheet(firstInput?.name ?? data.sheets[0]?.name ?? null);
    } catch (err) {
      setPreview(null);
      setActiveSheet(null);
      setError({ kind: 'failed', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [normalizedMonth]);

  useEffect(() => {
    if (validMonth) void load();
  }, [validMonth, load]);

  if (!validMonth) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {t(`잘못된 정산월입니다: ${month} (YYYYMM 형식이어야 합니다)`, `無効な精算月です: ${month}（YYYYMM形式である必要があります）`)}
        </div>
      </div>
    );
  }

  const monthLabel = t(
    `${Number(normalizedMonth.slice(0, 4))}년 ${Number(normalizedMonth.slice(4, 6))}월`,
    `${Number(normalizedMonth.slice(0, 4))}年${Number(normalizedMonth.slice(4, 6))}月`,
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
          <h1 className="mt-1 text-xl font-bold text-slate-950 dark:text-white">
            {t(`${monthLabel} INPUT Excel 미리보기`, `${monthLabel} INPUT Excel プレビュー`)}
          </h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-100"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('새로고침', '更新')}
          </button>
          <a
            href={`/api/settlement/export-v2/${normalizedMonth}.xlsx`}
            download={`JP_INPUT_V2_${normalizedMonth}.xlsx`}
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-100"
          >
            <Download className="mr-2 h-4 w-4" />
            {t('Excel 다운로드', 'Excel ダウンロード')}
          </a>
        </div>
      </header>

      {loading && !preview && (
        <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white p-16 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
          {t('미리보기를 생성하는 중입니다…', 'プレビューを生成しています…')}
        </div>
      )}

      {error?.kind === 'missing' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t(
            `${monthLabel} 데이터가 없습니다. 정산 화면에서 파일을 업로드한 뒤 다시 열어 주세요.`,
            `${monthLabel}のデータがありません。精算画面でファイルをアップロードしてから、もう一度開いてください。`,
          )}
        </div>
      )}
      {error?.kind === 'failed' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {t('미리보기 실패', 'プレビュー失敗')}: {error.message}
        </div>
      )}

      {preview && activeSheet && (
        <InputPreviewTable preview={preview} activeSheet={activeSheet} onSheetChange={setActiveSheet} />
      )}
    </div>
  );
}
