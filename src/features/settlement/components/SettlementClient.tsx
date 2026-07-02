'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw, UploadCloud, Trash2 } from 'lucide-react';
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

export default function SettlementClient() {
  const { t } = useApp();
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [month, setMonth] = useState(defaultMonth);
  const [files, setFiles] = useState<File[]>([]);
  const [folderHint, setFolderHint] = useState('');
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
    setMonth(next);
    // Drop a preview that no longer matches the selected month so nothing stale is shown.
    if (preview && preview.month !== next) {
      setPreview(null);
      setActiveSheet(null);
      setPreviewError(null);
    }
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

  async function upload() {
    if (!validMonth || files.length === 0 || uploading) return;
    setUploading(true);
    setMessage(null);
    setResults([]);
    try {
      const fd = new FormData();
      for (const file of files) fd.append('files', file);
      fd.append('activeMonth', activeMonth);
      if (folderHint.trim()) fd.append('folder', folderHint.trim());
      if (replaceMonth) fd.append('replaceMonth', '1');
      const res = await fetch('/api/settlement/upload', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResults(Array.isArray(json.results) ? json.results : []);
      setMessage(t('업로드 처리가 끝났습니다. 아래 결과를 확인해 주세요.', 'アップロード処理が完了しました。下の結果をご確認ください。'));
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
          <label className="flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition hover:border-blue-500 dark:border-slate-700">
            <UploadCloud className="mb-3 h-10 w-10 text-blue-600" />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('정산 원본 파일 선택', '精算原本ファイルを選択')}</span>
            <span className="mt-1 text-xs text-slate-500">{t('여러 파일을 한 번에 선택할 수 있습니다.', '複数ファイルを一度に選択できます。')}</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
              <div className="font-semibold text-slate-800 dark:text-slate-100">{t(`선택된 파일 ${files.length}개`, `選択されたファイル ${files.length}件`)}</div>
              <ul className="mt-2 max-h-28 space-y-1 overflow-auto text-xs text-slate-600 dark:text-slate-300">
                {files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}
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
