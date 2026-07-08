'use client';

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type InputHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, ExternalLink, FolderOpen, Loader2, UploadCloud, Trash2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';

type UploadResult = {
  file?: string;
  platform?: string;
  parsed_rows?: number;
  sales_records_written?: number;
  sales_records_skipped_duplicates?: number;
  skipped?: boolean;
  skip_reason?: string;
  settlement_month?: string | null;
  sales_month?: string | null;
  error?: string;
  errors?: string[];
};

// "2026-05-01" → "202605" (server months are ISO first-of-month dates).
function isoToYyyymm(iso: string) {
  return iso.slice(0, 7).replace('-', '');
}

type ResetResult = Record<string, unknown> & { ok?: boolean; error?: string };

// One platform that already has settlement rows in a month — names only, no amounts/counts.
type MonthPlatform = { code: string | null; name: string | null };

function toIsoMonth(yyyymm: string) {
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-01`;
}

type SelectedFile = { file: File; relativePath: string };

function fileKey(sf: SelectedFile) {
  return `${sf.relativePath}|${sf.file.size}|${sf.file.lastModified}`;
}

// Same file picked twice in one selection (or the same entry reached via two
// directory branches) should upload once.
function dedupeSelection(incoming: SelectedFile[]): SelectedFile[] {
  const map = new Map<string, SelectedFile>();
  for (const sf of incoming) map.set(fileKey(sf), sf);
  return Array.from(map.values());
}

// React/TS don't type the non-standard directory-picker attributes; the cast keeps them on the DOM input.
const folderInputProps = { webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

// Vercel rejects request bodies over ~4.5MB with 413 before the route runs, and
// parsing several workbooks in one invocation can exceed the function timeout (504),
// so each file is sent as its own request.
const BATCH_MAX_FILES = 1;
const BATCH_MAX_BYTES = 3_500_000;

function buildBatches(selected: SelectedFile[]): SelectedFile[][] {
  const batches: SelectedFile[][] = [];
  let current: SelectedFile[] = [];
  let currentBytes = 0;
  for (const sf of selected) {
    if (current.length > 0 && (current.length >= BATCH_MAX_FILES || currentBytes + sf.file.size > BATCH_MAX_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(sf);
    currentBytes += sf.file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

type UploadRunFailure = { file: string; status: number | null; error: string };

const UPLOAD_RUN_LOG_KEY = 'settlementUploadRuns';
const UPLOAD_RUN_LOG_MAX = 5;

// Keeps the last few upload run summaries in this browser (run id, counts,
// failed file names/statuses/messages — never file contents or amounts) so
// "what failed last time?" can still be answered after the page state is gone.
function appendUploadRunLog(entry: {
  runId: string;
  at: string;
  fileCount: number;
  failCount: number;
  failures: UploadRunFailure[];
}) {
  try {
    const raw = window.localStorage.getItem(UPLOAD_RUN_LOG_KEY);
    const prev: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(prev) ? prev : [];
    window.localStorage.setItem(UPLOAD_RUN_LOG_KEY, JSON.stringify([...list, entry].slice(-UPLOAD_RUN_LOG_MAX)));
  } catch {
    // localStorage unavailable (private mode, quota) — the trace is best-effort.
  }
}

// Chrome returns at most 100 entries per readEntries() call; keep reading until it comes back empty.
// A read error still resolves with the entries gathered so far, flagged so the caller can count it.
function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<{ entries: FileSystemEntry[]; errored: boolean }> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) return resolve({ entries: all, errored: false });
          all.push(...entries);
          readBatch();
        },
        () => resolve({ entries: all, errored: true }),
      );
    };
    readBatch();
  });
}

// Collects files under an entry into `collected`; returns how many entries could not be read.
async function collectFilesFromEntry(entry: FileSystemEntry, collected: SelectedFile[]): Promise<number> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (!file) return 1;
    collected.push({ file, relativePath: entry.fullPath.replace(/^\//, '') });
    return 0;
  }
  if (entry.isDirectory) {
    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch {
      return 1;
    }
    const { entries: children, errored } = await readAllDirectoryEntries(reader);
    let skipped = errored ? 1 : 0;
    for (const child of children) skipped += await collectFilesFromEntry(child, collected);
    return skipped;
  }
  return 1;
}

const YEAR_RANGE = 3;

export default function SettlementClient() {
  const { t } = useApp();
  const now = new Date();
  const currentYear = now.getFullYear();
  const defaultMonth = `${currentYear}${String(now.getMonth() + 1).padStart(2, '0')}`;
  // The single source of truth for "which settlement month is this upload":
  // whatever the operator picked here is sent as activeMonth with every
  // request and overrides any month found inside file contents or names.
  const [month, setMonth] = useState(defaultMonth);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Synchronous guard against overlapping runs: a second drop while a folder
  // traversal or upload is still running must be ignored, and `uploading`
  // state alone updates too late for that.
  const uploadingRef = useRef(false);
  // Live upload gauge: files handed off so far (in-flight file included),
  // out of the run's total, plus the name currently being processed.
  const [progress, setProgress] = useState<{ current: number; total: number; currentFile: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  // The detailed per-file table is tall; keep it collapsed so the summary
  // stays the main content after an upload.
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Which platforms already hold settlement rows, per YYYYMM of the shown
  // year. null = fetch failed/unavailable; bumping the version refetches
  // after an upload or reset changed the data.
  const [monthPlatforms, setMonthPlatforms] = useState<Record<string, MonthPlatform[]> | null>(null);
  const [monthPlatformsLoading, setMonthPlatformsLoading] = useState(false);
  const [monthPlatformsVersion, setMonthPlatformsVersion] = useState(0);

  const validMonth = /^\d{6}$/.test(month);
  const selectedYear = Number(month.slice(0, 4));
  const selectedMonthNum = Number(month.slice(4, 6));
  const minYear = currentYear - YEAR_RANGE;
  const maxYear = currentYear + YEAR_RANGE;

  useEffect(() => {
    let cancelled = false;
    setMonthPlatformsLoading(true);
    fetch(`/api/settlement/month-platforms?year=${selectedYear}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (!cancelled) setMonthPlatforms((json.months ?? {}) as Record<string, MonthPlatform[]>);
      })
      .catch(() => {
        if (!cancelled) setMonthPlatforms(null);
      })
      .finally(() => {
        if (!cancelled) setMonthPlatformsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedYear, monthPlatformsVersion]);

  const monthLabel = (yyyymm: string) =>
    t(`${Number(yyyymm.slice(0, 4))}년 ${Number(yyyymm.slice(4, 6))}월`, `${Number(yyyymm.slice(0, 4))}年${Number(yyyymm.slice(4, 6))}月`);

  function changeMonth(next: string) {
    if (next === month) return;
    setMonth(next);
  }

  function changeYear(nextYear: number) {
    if (nextYear < minYear || nextYear > maxYear) return;
    changeMonth(`${nextYear}${month.slice(4, 6)}`);
  }

  function openPreviewWindow() {
    if (!validMonth) return;
    const url = `/settlement-preview/${month}`;
    const width = Math.min(1600, window.screen.availWidth || 1600);
    const height = Math.min(1000, window.screen.availHeight || 1000);
    window.open(url, `settlement-preview-${month}`, `popup=yes,width=${width},height=${height},left=40,top=40,noopener,noreferrer`);
  }

  // Selecting or dropping files IS the upload: no staging list, no upload
  // button. Everything lands in the operator-picked settlement month.
  async function startUpload(incoming: SelectedFile[], unreadable: number, lockAlreadyHeld = false) {
    if (!lockAlreadyHeld) {
      if (uploadingRef.current) {
        setMessage(t('업로드가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.', 'アップロードが進行中です。完了後にもう一度お試しください。'));
        return;
      }
      uploadingRef.current = true;
    }
    setUploading(true);
    const releaseBusy = () => {
      setUploading(false);
      uploadingRef.current = false;
    };
    const selected = dedupeSelection(incoming);
    if (selected.length === 0) {
      if (unreadable > 0) {
        setMessage(t(`읽을 수 있는 파일이 없습니다. (읽지 못한 항목 ${unreadable}개)`, `読み込めるファイルがありません。（読み込めなかった項目${unreadable}件）`));
      }
      releaseBusy();
      return;
    }
    if (!validMonth) {
      releaseBusy();
      return;
    }
    // Snapshot the target month now: the picker is disabled during the run,
    // but the snapshot keeps every request and the final preview consistent
    // even if that ever changes.
    const targetMonth = month;
    const targetIso = toIsoMonth(targetMonth);
    const targetLabel = monthLabel(targetMonth);
    // Top-level folder name of the dropped selection, if any — platform
    // detection aid only; never used for month decisions.
    const folderHint = selected.find((sf) => sf.relativePath.includes('/'))?.relativePath.split('/')[0] ?? '';
    setMessage(null);
    setResults([]);
    setResultsExpanded(false);
    try {
      const batches = buildBatches(selected);
      // Correlation id for this run: shown in failed rows, kept in the
      // localStorage run log, and echoed by the server into Vercel function
      // logs — the only way to match a body-less failure (504) to a request.
      const uploadRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const httpStatusByFile = new Map<string, number>();
      const aggregated: UploadResult[] = [];

      const send = async (chunk: SelectedFile[]) => {
        const fd = new FormData();
        fd.append('uploadRunId', uploadRunId);
        for (const sf of chunk) fd.append('files', sf.file);
        // The picked month is authoritative: the server stores every row under
        // it, above any month parsed from file contents or names.
        fd.append('activeMonth', targetIso);
        if (folderHint) fd.append('folder', folderHint);
        return fetch('/api/settlement/upload', {
          method: 'POST',
          body: fd,
          headers: { 'X-Settlement-Upload-Run-Id': uploadRunId },
        });
      };

      const recordFailure = (chunk: SelectedFile[], error: string, status: number | null = null) => {
        const at = new Date().toISOString();
        const suffix = [
          `run ${uploadRunId}`,
          ...(status !== null && !error.includes(`HTTP ${status}`) ? [`HTTP ${status}`] : []),
          at,
        ].join(' · ');
        console.warn('[settlement-upload] batch failed', {
          runId: uploadRunId,
          at,
          status,
          files: chunk.map((sf) => sf.relativePath),
          error,
        });
        for (const sf of chunk) {
          if (status !== null) httpStatusByFile.set(sf.relativePath, status);
          aggregated.push({ file: sf.relativePath, error: `${error} [${suffix}]` });
        }
      };

      const handleResponse = async (res: Response, chunk: SelectedFile[]) => {
        if (res.status === 413) {
          recordFailure(chunk, t(
            '파일이 Vercel 업로드 용량 제한(약 4.5MB)을 초과합니다. 이 파일은 추후 스토리지 직접 업로드 방식으로 처리해야 합니다.',
            'ファイルがVercelのアップロード容量制限（約4.5MB）を超えています。このファイルは今後ストレージ直接アップロード方式での対応が必要です。',
          ), 413);
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          recordFailure(chunk, json.error || `HTTP ${res.status}`, res.status);
          return;
        }
        if (Array.isArray(json.results)) aggregated.push(...json.results);
      };

      // Batches are 1 file each today (BATCH_MAX_FILES=1), but the gauge
      // counts files, not batches, so it stays correct if that changes.
      let sentFiles = 0;
      for (const batch of batches) {
        setProgress({ current: sentFiles + batch.length, total: selected.length, currentFile: batch[0].relativePath });
        try {
          const res = await send(batch);
          await handleResponse(res, batch);
        } catch (err) {
          recordFailure(batch, (err as Error).message);
        }
        sentFiles += batch.length;
        setResults([...aggregated]);
      }
      // Transfer is done; hide the gauge before the summary/preview phase.
      setProgress(null);

      setResults(aggregated);
      const failedRows = aggregated.filter((r) => r.error);
      const skippedRows = aggregated.filter((r) => r.skipped);
      const successfulRows = aggregated.filter((r) => !r.error && !r.skipped && ((r.sales_records_written ?? 0) > 0 || (r.sales_records_skipped_duplicates ?? 0) > 0));
      const successCount = successfulRows.length;
      appendUploadRunLog({
        runId: uploadRunId,
        at: new Date().toISOString(),
        fileCount: selected.length,
        failCount: failedRows.length,
        failures: failedRows.slice(0, 10).map((r) => ({
          file: r.file ?? '(unknown)',
          status: r.file ? httpStatusByFile.get(r.file) ?? null : null,
          error: r.error ?? '',
        })),
      });
      // A partial failure never blocks the rest: successful files are already
      // saved, so the preview is generated whenever at least one succeeded.
      if (successCount === 0) {
        setMessage(t(
          skippedRows.length > 0
            ? '저장된 정산행이 없습니다. 보조자료/비정산 파일은 건너뛰었고, 아래 결과에서 파일별 상태를 확인해 주세요.'
            : '업로드 실패: 모든 파일 처리에 실패했습니다. 아래 결과에서 파일별 원인을 확인해 주세요.',
          skippedRows.length > 0
            ? '保存された精算行はありません。補助資料・非精算ファイルはスキップしました。下の結果でファイルごとの状態をご確認ください。'
            : 'アップロード失敗: すべてのファイル処理に失敗しました。下の結果でファイルごとの原因をご確認ください。',
        ));
        return;
      }
      // Rows were written — refresh the month/platform availability panel.
      setMonthPlatformsVersion((v) => v + 1);
      const parts: string[] = [
        failedRows.length === 0
          ? t(
              `업로드 완료: 파일 ${successCount}개가 ${targetLabel} 정산월로 저장되었습니다.${skippedRows.length > 0 ? ` 보조/비정산 파일 ${skippedRows.length}개는 건너뛰었습니다.` : ''}`,
              `アップロード完了: ファイル${successCount}件が${targetLabel}の精算月に保存されました。${skippedRows.length > 0 ? `補助・非精算ファイル${skippedRows.length}件はスキップしました。` : ''}`,
            )
          : t(
              `파일 ${successCount}개는 ${targetLabel} 정산월로 저장되어 미리보기를 생성했습니다. 실패 ${failedRows.length}개, 건너뜀 ${skippedRows.length}개는 아래 결과에 표시됩니다.`,
              `ファイル${successCount}件は${targetLabel}の精算月に保存され、プレビューを生成しました。失敗${failedRows.length}件、スキップ${skippedRows.length}件は下の結果に表示されます。`,
            ),
      ];
      if (unreadable > 0) {
        parts.push(t(`읽지 못한 항목 ${unreadable}개는 제외되었습니다.`, `読み込めなかった項目${unreadable}件は除外されました。`));
      }
      setMessage(parts.join(' '));
    } catch (err) {
      setMessage(`${t('업로드 실패', 'アップロード失敗')}: ${(err as Error).message}`);
    } finally {
      setProgress(null);
      setUploading(false);
      uploadingRef.current = false;
    }
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    // Reset so selecting the same files/folder again still fires onChange.
    e.target.value = '';
    void startUpload(picked, 0);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // dragleave also fires when moving over children; only deactivate when actually leaving the zone.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (uploadingRef.current) {
      setMessage(t('업로드가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.', 'アップロードが進行中です。完了後にもう一度お試しください。'));
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      // Entries and files must be captured synchronously: the DataTransfer item list
      // is cleared as soon as the handler yields to an await.
      const captured = Array.from(e.dataTransfer?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => ({
          entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
          file: item.getAsFile(),
        }));
      const collected: SelectedFile[] = [];
      let unreadable = 0;
      if (captured.length > 0) {
        for (const { entry, file } of captured) {
          if (entry) unreadable += await collectFilesFromEntry(entry, collected);
          else if (file) collected.push({ file, relativePath: file.name });
          else unreadable += 1;
        }
      } else {
        for (const file of Array.from(e.dataTransfer?.files ?? [])) {
          collected.push({ file, relativePath: file.name });
        }
      }
      await startUpload(collected, unreadable, true);
    } catch (err) {
      setMessage(`${t('업로드 실패', 'アップロード失敗')}: ${(err as Error).message}`);
      setUploading(false);
      uploadingRef.current = false;
    }
  }

  async function resetMonth() {
    if (!validMonth || resetting) return;
    const confirmed = window.confirm(
      t(
        `${month} 정산 데이터를 비우시겠습니까? 업로드 테스트를 다시 할 때만 사용해 주세요.`,
        `${month} の精算データを削除しますか？アップロードテストをやり直す場合のみ使用してください。`,
      ),
    );
    if (!confirmed) return;
    setResetting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/settlement/reset/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const json = (await res.json().catch(() => ({}))) as ResetResult;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMessage(`${t('초기화 완료', '初期化完了')}: sales_records ${String(json.sales_records_deleted ?? 0)}${t('건 삭제', '件を削除')}`);
      setResults([]);
      setMonthPlatformsVersion((v) => v + 1);
    } catch (err) {
      setMessage(`${t('초기화 실패', '初期化失敗')}: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  const failedResults = results.filter((r) => r.error);
  const skippedResults = results.filter((r) => r.skipped);
  const successfulResults = results.filter((r) => !r.error && !r.skipped && ((r.sales_records_written ?? 0) > 0 || (r.sales_records_skipped_duplicates ?? 0) > 0));
  const parsedRowsTotal = results.reduce((sum, r) => sum + (r.parsed_rows ?? 0), 0);
  const salesRowsTotal = results.reduce((sum, r) => sum + (r.sales_records_written ?? 0), 0);
  const progressPercent = progress ? Math.min(100, Math.round((progress.current / Math.max(progress.total, 1)) * 100)) : 0;
  const pickerButtonBase = 'rounded-xl py-3 text-base font-bold transition disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950 dark:text-white">{t('정산 / INPUT Export', '精算 / INPUT Export')}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
          {t(
            '정산월을 고른 뒤 파일이나 폴더를 올리면 바로 파싱·저장되고, 해당 월의 INPUT v2 엑셀 미리보기와 다운로드가 준비됩니다.',
            '精算月を選んでファイルやフォルダをアップロードすると、すぐに解析・保存され、該当月のINPUT v2 Excelのプレビューとダウンロードが利用できます。',
          )}
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t('1. 정산월 선택', '1. 精算月を選択')}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('어느 달의 정산 데이터를 업로드하나요?', 'どの月の精算データをアップロードしますか？')}
          </p>

          <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-100 px-2 py-1.5 dark:bg-slate-950">
            <button
              type="button"
              onClick={() => changeYear(selectedYear - 1)}
              disabled={uploading || selectedYear <= minYear}
              aria-label={t('이전 연도', '前の年')}
              className="rounded-lg p-2 text-slate-600 transition hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="text-xl font-bold text-slate-950 dark:text-white">{t(`${selectedYear}년`, `${selectedYear}年`)}</span>
            <button
              type="button"
              onClick={() => changeYear(selectedYear + 1)}
              disabled={uploading || selectedYear >= maxYear}
              aria-label={t('다음 연도', '次の年')}
              className="rounded-lg p-2 text-slate-600 transition hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const yyyymm = `${selectedYear}${String(m).padStart(2, '0')}`;
              const active = m === selectedMonthNum;
              const hasData = (monthPlatforms?.[yyyymm]?.length ?? 0) > 0;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => changeMonth(yyyymm)}
                  disabled={uploading}
                  className={`${pickerButtonBase} ${
                    active && hasData
                      ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-300 dark:ring-emerald-500'
                      : active
                        ? 'bg-blue-600 text-white shadow-sm'
                        : hasData
                          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800 dark:hover:bg-emerald-950/70'
                          : 'bg-slate-100 text-slate-700 hover:bg-blue-100 hover:text-blue-800 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  {t(`${m}월`, `${m}月`)}
                  {hasData && <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />}
                </button>
              );
            })}
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
            <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
              {t(`${monthLabel(month)} 저장된 플랫폼`, `${monthLabel(month)} 保存済みプラットフォーム`)}
            </p>
            {monthPlatformsLoading ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin align-[-2px]" />
                {t('플랫폼 현황을 불러오는 중…', 'プラットフォーム状況を読み込み中…')}
              </p>
            ) : monthPlatforms === null ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {t('플랫폼 현황을 불러오지 못했습니다.', 'プラットフォーム状況を読み込めませんでした。')}
              </p>
            ) : (monthPlatforms[month]?.length ?? 0) === 0 ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {t('이 달에는 저장된 정산 데이터가 없습니다.', 'この月には保存された精算データはありません。')}
              </p>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {monthPlatforms[month].map((p, idx) => (
                    <span
                      key={`${p.code ?? 'unknown'}-${idx}`}
                      className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                    >
                      {p.name ?? p.code ?? t('미분류', '未分類')}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                  {t('초록색 월은 이미 정산 데이터가 저장된 달입니다.', '緑色の月はすでに精算データが保存されている月です。')}
                </p>
              </>
            )}
          </div>

          <p className="mt-4 rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
            {t(
              `선택한 ${monthLabel(month)}이(가) 이번 업로드의 정산월이 됩니다. 파일 내용이나 폴더 이름에 다른 월이 적혀 있어도 항상 이 선택이 우선합니다.`,
              `選択した${monthLabel(month)}が今回のアップロードの精算月になります。ファイル内容やフォルダ名に別の月が書かれていても、常にこの選択が優先されます。`,
            )}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t('2. 파일 올리기', '2. ファイルをアップロード')}</h2>
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`mt-3 flex min-h-52 flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${dragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 dark:border-slate-700'}`}
          >
            {uploading ? (
              <Loader2 className="mb-3 h-10 w-10 animate-spin text-blue-600" />
            ) : (
              <UploadCloud className="mb-3 h-10 w-10 text-blue-600" />
            )}
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {uploading
                ? t('업로드 진행 중입니다…', 'アップロード進行中です…')
                : t('파일이나 폴더를 여기에 놓으면 바로 업로드가 시작됩니다', 'ファイルやフォルダをここにドロップすると、すぐにアップロードが始まります')}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              {t(
                `놓는 즉시 ${monthLabel(month)} 정산월로 파싱·저장됩니다. 별도의 업로드 버튼은 없으며, 일부 파일이 실패해도 나머지는 저장됩니다.`,
                `ドロップすると、すぐに${monthLabel(month)}の精算月として解析・保存されます。別途アップロードボタンはなく、一部のファイルが失敗しても残りは保存されます。`,
              )}
            </span>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${uploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                {t('파일 선택', 'ファイルを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={uploading} />
              </label>
              <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${uploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('폴더 선택', 'フォルダを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={uploading} {...folderInputProps} />
              </label>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={validMonth ? `/api/settlement/export-v2/${month}.xlsx` : undefined}
              download={validMonth ? `JP_INPUT_V2_${month}.xlsx` : undefined}
              className={`inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-slate-700 ${validMonth ? 'text-slate-800 dark:text-slate-100' : 'pointer-events-none opacity-50'}`}
            >
              <Download className="mr-2 h-4 w-4" />
              {t('최종 INPUT Excel 다운로드', '最終 INPUT Excel ダウンロード')}
            </a>
            <button
              type="button"
              onClick={openPreviewWindow}
              disabled={!validMonth}
              className="inline-flex items-center rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-800 transition hover:border-blue-500 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-950"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('INPUT Excel 미리보기 열기', 'INPUT Excel プレビューを開く')}
            </button>
            <button
              onClick={resetMonth}
              disabled={!validMonth || resetting || uploading}
              className="inline-flex items-center rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300"
            >
              {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t('해당 월 비우기', '該当月を削除')}
            </button>
          </div>

          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            {t(
              '미리보기는 아래에 붙지 않고 별도 창에서 Excel 파일처럼 열립니다.',
              'プレビューは下に表示せず、別ウィンドウでExcelファイルのように開きます。',
            )}
          </p>
        </div>
      </section>

      {progress && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 shadow-sm dark:border-blue-900 dark:bg-blue-950/40">
          <div className="flex items-center text-sm font-semibold text-blue-900 dark:text-blue-100">
            <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
            {t(
              `처리중 ${progress.current}/${progress.total} · ${progressPercent}%`,
              `処理中 ${progress.current}/${progress.total} · ${progressPercent}%`,
            )}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/60">
            <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${progressPercent}%` }} />
          </div>
          <p className="mt-2 break-all text-xs text-blue-800 dark:text-blue-200">{progress.currentFile}</p>
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
          {message}
        </div>
      )}

      {results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('처리 결과 요약', '処理結果サマリー')}</h2>
            <button
              type="button"
              onClick={() => setResultsExpanded((v) => !v)}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100"
            >
              {resultsExpanded ? <ChevronUp className="mr-1.5 h-3.5 w-3.5" /> : <ChevronDown className="mr-1.5 h-3.5 w-3.5" />}
              {resultsExpanded ? t('처리결과 상세 접기', '処理結果の詳細を閉じる') : t('처리결과 상세 펼치기', '処理結果の詳細を開く')}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`파일 ${results.length}개`, `ファイル ${results.length}件`)}
            </span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              {t(`성공 ${successfulResults.length}`, `成功 ${successfulResults.length}`)}
            </span>
            <span className={`rounded-full px-2.5 py-1 ${failedResults.length > 0 ? 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
              {t(`실패 ${failedResults.length}`, `失敗 ${failedResults.length}`)}
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              {t(`건너뜀 ${skippedResults.length}`, `スキップ ${skippedResults.length}`)}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`파싱 행 ${parsedRowsTotal}`, `解析行 ${parsedRowsTotal}`)}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`정산 행 ${salesRowsTotal}`, `精算行 ${salesRowsTotal}`)}
            </span>
          </div>
          {failedResults.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-red-700 dark:text-red-300">
              {failedResults.slice(0, 3).map((r, idx) => (
                <li key={`${r.file ?? 'fail'}-${idx}`} className="break-all">
                  <AlertCircle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  {r.file ?? '-'}: {r.error}
                </li>
              ))}
              {failedResults.length > 3 && (
                <li className="text-slate-500 dark:text-slate-400">
                  {t(`외 ${failedResults.length - 3}건은 '처리결과 상세 펼치기'에서 확인해 주세요.`, `他${failedResults.length - 3}件は「処理結果の詳細を開く」でご確認ください。`)}
                </li>
              )}
            </ul>
          )}
        </section>
      )}

      {resultsExpanded && results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('처리 결과 상세', '処理結果詳細')}</h2>
            <button
              type="button"
              onClick={() => setResultsExpanded(false)}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100"
            >
              <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
              {t('처리결과 상세 접기', '処理結果の詳細を閉じる')}
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-2 pr-3">{t('상태', '状態')}</th>
                  <th className="py-2 pr-3">{t('파일', 'ファイル')}</th>
                  <th className="py-2 pr-3">{t('플랫폼', 'プラットフォーム')}</th>
                  <th className="py-2 pr-3">{t('파싱 행', '解析行')}</th>
                  <th className="py-2 pr-3">{t('정산 행', '精算行')}</th>
                  <th className="py-2 pr-3">{t('정산월', '精算月')}</th>
                  <th className="py-2 pr-3">{t('메시지', 'メッセージ')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => {
                  const ok = !r.error && !r.skipped && ((r.sales_records_written ?? 0) > 0 || (r.sales_records_skipped_duplicates ?? 0) > 0);
                  const skipped = Boolean(r.skipped);
                  return (
                    <tr key={`${r.file ?? 'row'}-${idx}`} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        {ok ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : skipped ? (
                          <AlertCircle className="h-4 w-4 text-amber-500" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-red-600" />
                        )}
                      </td>
                      <td className="py-2 pr-3">{r.file ?? '-'}</td>
                      <td className="py-2 pr-3">{r.platform ?? '-'}</td>
                      <td className="py-2 pr-3">{r.parsed_rows ?? '-'}</td>
                      <td className="py-2 pr-3">{r.sales_records_written ?? '-'}</td>
                      <td className="py-2 pr-3">{typeof r.settlement_month === 'string' ? isoToYyyymm(r.settlement_month) : '-'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.error ?? r.skip_reason ?? r.errors?.join('; ') ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
