'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, UploadCloud, Trash2 } from 'lucide-react';

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

  const validMonth = /^\d{6}$/.test(month);
  const activeMonth = useMemo(() => (validMonth ? toIsoMonth(month) : ''), [month, validMonth]);

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
      setMessage('업로드 처리가 끝났습니다. 아래 결과를 확인해 주세요.');
    } catch (err) {
      setMessage(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  async function resetMonth() {
    if (!validMonth || resetting) return;
    const confirmed = window.confirm(`${month} 정산 데이터를 비우시겠습니까? 업로드 테스트를 다시 할 때만 사용해 주세요.`);
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
      setMessage(`초기화 완료: sales_records ${String(json.sales_records_deleted ?? 0)}건 삭제`);
      setResults([]);
    } catch (err) {
      setMessage(`초기화 실패: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950 dark:text-white">정산 / INPUT Export</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
          매출 현황 보드 안에 독립적으로 붙인 정산 기능입니다. 업로드 전에는 데이터가 비어 있어야 정상이며,
          파일을 올린 뒤 해당 월의 INPUT v2 엑셀을 내려받아 테스트합니다.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <label className="block text-sm font-semibold text-slate-800 dark:text-slate-100">정산월</label>
          <input
            value={month}
            onChange={(e) => setMonth(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="202605"
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
          <p className="mt-2 text-xs text-slate-500">YYYYMM 형식입니다. 예: 202605</p>

          <label className="mt-5 block text-sm font-semibold text-slate-800 dark:text-slate-100">폴더 힌트</label>
          <input
            value={folderHint}
            onChange={(e) => setFolderHint(e.target.value)}
            placeholder="예: 202605_BookLive"
            className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
          <p className="mt-2 text-xs text-slate-500">플랫폼 자동판별 보조값입니다. 모르면 비워두셔도 됩니다.</p>

          <label className="mt-5 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
            <input
              type="checkbox"
              checked={replaceMonth}
              onChange={(e) => setReplaceMonth(e.target.checked)}
              className="mt-0.5"
            />
            <span>이번 업로드 전에 해당 월의 기존 정산 행을 비웁니다. 반복 테스트할 때만 켜 주세요.</span>
          </label>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <label className="flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition hover:border-blue-500 dark:border-slate-700">
            <UploadCloud className="mb-3 h-10 w-10 text-blue-600" />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">정산 원본 파일 선택</span>
            <span className="mt-1 text-xs text-slate-500">여러 파일을 한 번에 선택할 수 있습니다.</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
              <div className="font-semibold text-slate-800 dark:text-slate-100">선택된 파일 {files.length}개</div>
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
              업로드 / 파싱 시작
            </button>
            <a
              href={validMonth ? `/api/settlement/export-v2/${month}.xlsx` : undefined}
              download={validMonth ? `JP_INPUT_V2_${month}.xlsx` : undefined}
              className={`inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-slate-700 ${validMonth ? 'text-slate-800 dark:text-slate-100' : 'pointer-events-none opacity-50'}`}
            >
              <Download className="mr-2 h-4 w-4" />
              INPUT v2 다운로드
            </a>
            <button
              onClick={resetMonth}
              disabled={!validMonth || resetting}
              className="inline-flex items-center rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300"
            >
              {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              해당 월 비우기
            </button>
          </div>
        </div>
      </section>

      {message && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
          {message}
        </div>
      )}

      {results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-bold text-slate-950 dark:text-white">처리 결과</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-2 pr-3">상태</th>
                  <th className="py-2 pr-3">파일</th>
                  <th className="py-2 pr-3">플랫폼</th>
                  <th className="py-2 pr-3">파싱 행</th>
                  <th className="py-2 pr-3">정산 행</th>
                  <th className="py-2 pr-3">메시지</th>
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
    </div>
  );
}
