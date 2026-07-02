'use client';

import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type InputHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, UploadCloud, Trash2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import InputPreviewTable, { type PreviewData } from './InputPreviewTable';

type UploadResult = {
  file?: string;
  platform?: string;
  parsed_rows?: number;
  sales_records_written?: number;
  error?: string;
  errors?: string[];
};

type ResetResult = Record<string, unknown> & { ok?: boolean; error?: string };

function toIsoMonth(yyyymm: string) {
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-01`;
}

type SelectedFile = { file: File; relativePath: string };

function fileKey(sf: SelectedFile) {
  return `${sf.relativePath}|${sf.file.size}|${sf.file.lastModified}`;
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

// Finds a YYYYMM month in folder or file names (e.g. "202605/...", "202605_mangabang").
// The lookbehind/lookahead keep it from matching inside longer digit runs like timestamps.
function detectMonthFromPaths(incoming: SelectedFile[]): string | null {
  for (const sf of incoming) {
    const m = sf.relativePath.match(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(?!\d)/);
    if (m) return `${m[1]}${m[2]}`;
  }
  return null;
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

export default function SettlementClient() {
  const { t } = useApp();
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [month, setMonth] = useState(defaultMonth);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const filesRef = useRef<SelectedFile[]>([]);
  const [folderHint, setFolderHint] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [selectionNote, setSelectionNote] = useState<string | null>(null);
  const [replaceMonth, setReplaceMonth] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);

  const validMonth = /^\d{6}$/.test(month);
  const activeMonth = useMemo(() => (validMonth ? toIsoMonth(month) : ''), [month, validMonth]);

  function changeMonth(next: string) {
    if (next === month) return;
    setMonth(next);
    // Drop a preview that no longer matches the selected month so nothing stale is shown.
    if (preview && preview.month !== next) {
      setPreview(null);
      setActiveSheet(null);
    }
    // An error message always refers to the previously selected month; never keep it.
    setPreviewError(null);
  }

  async function loadPreview(targetMonth = month) {
    if (!/^\d{6}$/.test(targetMonth) || previewLoading) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/settlement/preview-v2/${targetMonth}`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setPreview(null);
        setActiveSheet(null);
        setPreviewError(t('업로드 후 미리보기가 생성됩니다.', 'アップロード後にプレビューが生成されます。'));
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
      setPreviewError(`${t('미리보기 실패', 'プレビュー失敗')}: ${(err as Error).message}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  function addFiles(incoming: SelectedFile[], unreadable: number) {
    if (incoming.length === 0 && unreadable === 0) return;
    const topFolder = incoming.find((sf) => sf.relativePath.includes('/'))?.relativePath.split('/')[0];
    if (topFolder) setFolderHint((prev) => (prev.trim() ? prev : topFolder));

    // Use a ref-backed latest snapshot so overlapping async folder traversals
    // merge into the newest list without causing side effects inside a React updater.
    const map = new Map(filesRef.current.map((sf) => [fileKey(sf), sf] as const));
    const before = map.size;
    for (const sf of incoming) map.set(fileKey(sf), sf);

    const nextFiles = Array.from(map.values());
    filesRef.current = nextFiles;
    setFiles(nextFiles);

    const added = map.size - before;
    const duplicates = incoming.length - added;
    const parts: string[] = [t(`${added}개 파일 추가됨`, `${added}件のファイルを追加しました`)];
    // If the dropped folder/files name a settlement month, follow it so the
    // upload and preview target that month instead of the current calendar month.
    const detected = detectMonthFromPaths(incoming);
    if (detected && detected !== month) {
      changeMonth(detected);
      parts.push(t(`정산월을 ${detected}로 자동 설정`, `精算月を${detected}に自動設定`));
    }
    if (duplicates > 0) parts.push(t(`중복 ${duplicates}개 제외`, `重複${duplicates}件を除外`));
    if (unreadable > 0) parts.push(t(`읽지 못한 항목 ${unreadable}개 제외`, `読み込めなかった項目${unreadable}件を除外`));
    setSelectionNote(parts.join(' · '));
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    addFiles(picked, 0);
    // Reset so selecting the same files/folder again still fires onChange.
    e.target.value = '';
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
    addFiles(collected, unreadable);
  }

  async function upload() {
    if (!validMonth || uploading) return;
    // Snapshot the latest list now so files added/removed mid-upload can't shift batches.
    const selected = filesRef.current.slice();
    if (selected.length === 0) return;
    setUploading(true);
    setMessage(null);
    setResults([]);
    // The current preview predates this upload; drop it now so a failed upload
    // (before loadPreview runs) never leaves stale data on screen.
    setPreview(null);
    setActiveSheet(null);
    setPreviewError(null);
    try {
      const batches = buildBatches(selected);
      const totalBatches = batches.length;
      const trimmedFolder = folderHint.trim();
      // replaceMonth must clear the month exactly once. A 413 is rejected by the
      // platform before the route runs, so the flag stays pending; any other
      // response reached the server, so later requests must not send it again.
      let replacePending = replaceMonth;
      const aggregated: UploadResult[] = [];
      let failedFiles = 0;

      const send = async (chunk: SelectedFile[]) => {
        const fd = new FormData();
        for (const sf of chunk) fd.append('files', sf.file);
        fd.append('activeMonth', activeMonth);
        if (trimmedFolder) fd.append('folder', trimmedFolder);
        const sentReplace = replacePending;
        if (sentReplace) fd.append('replaceMonth', '1');
        const res = await fetch('/api/settlement/upload', { method: 'POST', body: fd });
        if (res.status !== 413) replacePending = false;
        return { res, sentReplace };
      };

      const recordFailure = (chunk: SelectedFile[], error: string) => {
        failedFiles += chunk.length;
        for (const sf of chunk) aggregated.push({ file: sf.relativePath, error });
      };

      const handleResponse = async (res: Response, chunk: SelectedFile[]) => {
        if (res.status === 413) {
          recordFailure(chunk, t(
            '파일이 Vercel 업로드 용량 제한(약 4.5MB)을 초과합니다. 이 파일은 추후 스토리지 직접 업로드 방식으로 처리해야 합니다.',
            'ファイルがVercelのアップロード容量制限（約4.5MB）を超えています。このファイルは今後ストレージ直接アップロード方式での対応が必要です。',
          ));
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          recordFailure(chunk, json.error || `HTTP ${res.status}`);
          return;
        }
        if (Array.isArray(json.results)) aggregated.push(...json.results);
      };

      let abortRemaining = false;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        setMessage(t(
          `업로드 중... 파일 ${i + 1}/${totalBatches}: ${batch[0].relativePath}`,
          `アップロード中... ファイル ${i + 1}/${totalBatches}: ${batch[0].relativePath}`,
        ));
        try {
          const { res, sentReplace } = await send(batch);
          await handleResponse(res, batch);
          // If the one-time clear-month request reached the server but failed,
          // do not continue later files in an uncleared/ambiguous month.
          if (sentReplace && res.status !== 413 && !res.ok) abortRemaining = true;
        } catch (err) {
          recordFailure(batch, (err as Error).message);
        }
        setResults([...aggregated]);
        if (abortRemaining) break;
      }

      setResults(aggregated);
      if (failedFiles === selected.length) {
        setMessage(t('업로드 실패: 모든 파일 전송에 실패했습니다. 아래 결과를 확인해 주세요.', 'アップロード失敗: すべてのファイル送信に失敗しました。下の結果をご確認ください。'));
        return;
      }
      setMessage(
        failedFiles === 0
          ? t('업로드 처리가 끝났습니다. 아래 결과를 확인해 주세요.', 'アップロード処理が完了しました。下の結果をご確認ください。')
          : t(`업로드 처리가 끝났습니다. ${failedFiles}개 파일 전송에 실패했습니다. 아래 결과를 확인해 주세요.`, `アップロード処理が完了しました。${failedFiles}件のファイル送信に失敗しました。下の結果をご確認ください。`),
      );
      await loadPreview(month);
    } catch (err) {
      setMessage(`${t('업로드 실패', 'アップロード失敗')}: ${(err as Error).message}`);
    } finally {
      setUploading(false);
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
      setPreview(null);
      setActiveSheet(null);
      setPreviewError(null);
    } catch (err) {
      setMessage(`${t('초기화 실패', '初期化失敗')}: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950 dark:text-white">{t('정산 / INPUT Export', '精算 / INPUT Export')}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
          {t(
            '매출 현황 보드 안에 독립적으로 붙인 정산 기능입니다. 업로드 전에는 데이터가 비어 있어야 정상이며, 파일을 올린 뒤 해당 월의 INPUT v2 엑셀을 내려받아 테스트합니다.',
            '売上現況ボードに独立して追加した精算機能です。アップロード前はデータが空の状態が正常です。ファイルをアップロードした後、該当月のINPUT v2 Excelをダウンロードしてテストします。',
          )}
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <label className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{t('정산월', '精算月')}</label>
          <input
            value={month}
            onChange={(e) => changeMonth(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="202605"
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
          <p className="mt-2 text-xs text-slate-500">{t('YYYYMM 형식입니다. 예: 202605', 'YYYYMM形式です。例: 202605')}</p>

          <label className="mt-5 block text-sm font-semibold text-slate-800 dark:text-slate-100">{t('폴더 힌트', 'フォルダヒント')}</label>
          <input
            value={folderHint}
            onChange={(e) => setFolderHint(e.target.value)}
            placeholder={t('예: 202605_BookLive', '例: 202605_BookLive')}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
          <p className="mt-2 text-xs text-slate-500">{t('플랫폼 자동판별 보조값입니다. 모르면 비워두셔도 됩니다.', 'プラットフォーム自動判別の補助値です。不明な場合は空欄でも問題ありません。')}</p>

          <label className="mt-5 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
            <input
              type="checkbox"
              checked={replaceMonth}
              onChange={(e) => setReplaceMonth(e.target.checked)}
              className="mt-0.5"
            />
            <span>{t('이번 업로드 전에 해당 월의 기존 정산 행을 비웁니다. 반복 테스트할 때만 켜 주세요.', '今回のアップロード前に該当月の既存精算行を削除します。繰り返しテストする場合のみオンにしてください。')}</span>
          </label>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex min-h-44 flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${dragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 dark:border-slate-700'}`}
          >
            <UploadCloud className="mb-3 h-10 w-10 text-blue-600" />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t('정산 원본 파일이나 폴더를 여기로 드래그하세요', '精算原本ファイルやフォルダをここにドラッグしてください')}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              {t('폴더를 통째로 놓으면 하위 파일까지 모두 추가됩니다. 중복 파일은 자동으로 제외됩니다.', 'フォルダごとドロップすると配下のファイルもすべて追加されます。重複ファイルは自動的に除外されます。')}
            </span>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100">
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                {t('파일 선택', 'ファイルを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} />
              </label>
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100">
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('폴더 선택', 'フォルダを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} {...folderInputProps} />
              </label>
            </div>
          </div>

          {selectionNote && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{selectionNote}</p>}

          {files.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-slate-800 dark:text-slate-100">{t(`선택된 파일 ${files.length}개`, `選択されたファイル ${files.length}件`)}</div>
                <button
                  onClick={() => {
                    filesRef.current = [];
                    setFiles([]);
                    setSelectionNote(null);
                  }}
                  className="text-xs font-semibold text-red-600 hover:underline dark:text-red-400"
                >
                  {t('전체 해제', 'すべて解除')}
                </button>
              </div>
              <ul className="mt-2 max-h-28 space-y-1 overflow-auto text-xs text-slate-600 dark:text-slate-300">
                {files.map((sf) => <li key={fileKey(sf)}>{sf.relativePath}</li>)}
              </ul>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={upload}
              disabled={!validMonth || files.length === 0 || uploading}
              className="inline-flex items-center rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
              {t('업로드 / 파싱 시작', 'アップロード / 解析開始')}
            </button>
            <a
              href={validMonth ? `/api/settlement/export-v2/${month}.xlsx` : undefined}
              download={validMonth ? `JP_INPUT_V2_${month}.xlsx` : undefined}
              className={`inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-slate-700 ${validMonth ? 'text-slate-800 dark:text-slate-100' : 'pointer-events-none opacity-50'}`}
            >
              <Download className="mr-2 h-4 w-4" />
              {t('최종 INPUT Excel 다운로드', '最終 INPUT Excel ダウンロード')}
            </a>
            <button
              onClick={() => loadPreview(month)}
              disabled={!validMonth || previewLoading}
              className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-100"
            >
              {previewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {t('미리보기 새로고침', 'プレビュー更新')}
            </button>
            <button
              onClick={resetMonth}
              disabled={!validMonth || resetting}
              className="inline-flex items-center rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300"
            >
              {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t('해당 월 비우기', '該当月を削除')}
            </button>
          </div>

          {!preview && (
            <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
              {t(
                '파일을 업로드하면 아래에 생성될 INPUT Excel 미리보기가 표시됩니다.',
                'ファイルをアップロードすると、下に生成される INPUT Excel プレビューが表示されます。',
              )}
            </p>
          )}
        </div>
      </section>

      {message && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
          {message}
        </div>
      )}

      {results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('처리 결과', '処理結果')}</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-2 pr-3">{t('상태', '状態')}</th>
                  <th className="py-2 pr-3">{t('파일', 'ファイル')}</th>
                  <th className="py-2 pr-3">{t('플랫폼', 'プラットフォーム')}</th>
                  <th className="py-2 pr-3">{t('파싱 행', '解析行')}</th>
                  <th className="py-2 pr-3">{t('정산 행', '精算行')}</th>
                  <th className="py-2 pr-3">{t('메시지', 'メッセージ')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => {
                  const ok = !r.error;
                  return (
                    <tr key={`${r.file ?? 'row'}-${idx}`} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertCircle className="h-4 w-4 text-red-600" />}
                      </td>
                      <td className="py-2 pr-3">{r.file ?? '-'}</td>
                      <td className="py-2 pr-3">{r.platform ?? '-'}</td>
                      <td className="py-2 pr-3">{r.parsed_rows ?? '-'}</td>
                      <td className="py-2 pr-3">{r.sales_records_written ?? '-'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.error ?? r.errors?.join('; ') ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {previewError && !preview && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {previewError}
        </div>
      )}

      {preview && activeSheet && (
        <InputPreviewTable preview={preview} activeSheet={activeSheet} onSheetChange={setActiveSheet} />
      )}
    </div>
  );
}
