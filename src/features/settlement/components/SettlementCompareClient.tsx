"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCcw,
  UploadCloud,
} from "lucide-react";

import { useApp } from "@/context/AppContext";
import { uploadSettlementFileDirect } from "@/features/settlement/lib/storage/direct-upload-client";

type ReviewStatus =
  | "pending"
  | "candidate_correct"
  | "golden_correct"
  | "needs_review"
  | "resolved";
type DiffCategory = "missing" | "extra" | "field" | "formula";

type Summary = {
  candidate_rows?: number;
  golden_rows?: number;
  matched_rows?: number;
  exact_rows?: number;
  missing_rows?: number;
  extra_rows?: number;
  diff_total?: number;
  source_warnings?: string[];
  source_uploads_truncated?: boolean;
  source_uploads_observed_count_at_least?: number;
  persisted_diff_count?: number;
  diffs_truncated?: boolean;
};

type Run = {
  id: string;
  month: string;
  status: "processing" | "completed" | "failed";
  answer_filename: string;
  answer_sha256?: string | null;
  candidate_filename?: string | null;
  candidate_sha256?: string | null;
  summary?: Summary | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

type Diff = {
  id: string;
  category: DiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  candidate_value: unknown;
  golden_value: unknown;
  review_status: ReviewStatus;
  review_note: string | null;
};

const REVIEW_STATUSES: ReviewStatus[] = [
  "pending",
  "candidate_correct",
  "golden_correct",
  "needs_review",
  "resolved",
];
const CATEGORIES: DiffCategory[] = ["missing", "extra", "field", "formula"];
const PAGE_SIZE = 100;
const MAX_ANSWER_BYTES = 3_500_000;
const SOURCE_EXTENSIONS = new Set([".xlsx", ".xls", ".csv", ".tsv", ".pdf", ".zip"]);

type SourceSelection = {
  file: File;
  folderHint?: string;
};

type UploadProgress = {
  current: number;
  total: number;
  currentFile: string;
};

type UploadSummary = {
  success: number;
  skipped: number;
  failure: number;
  failures: Array<{ file: string; error: string }>;
};

function displayMonth(month: string) {
  return `${month.slice(0, 4)}-${month.slice(4, 6)}`;
}

function boundedText(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value.slice(0, 220);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.state === "blank") return "-";
    if (obj.state === "formula") {
      const formula = typeof obj.formula === "string" ? obj.formula.slice(0, 120) : "";
      const result = obj.value === null || obj.value === undefined ? "" : ` = ${boundedText(obj.value)}`;
      return `formula ${formula}${result}`.slice(0, 220);
    }
    if ("value" in obj) return boundedText(obj.value);
    if ("row" in obj) return `row ${String(obj.row).slice(0, 20)}`;
  }
  return String(value).slice(0, 220);
}

function metric(value: unknown) {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function runStatusLabel(status: Run["status"], t: (ko: string, ja: string) => string) {
  const labels: Record<Run["status"], string> = {
    processing: t("처리 중", "処理中"),
    completed: t("완료", "完了"),
    failed: t("실패", "失敗"),
  };
  return labels[status] ?? status;
}

function reviewStatusLabel(status: ReviewStatus, t: (ko: string, ja: string) => string) {
  const labels: Record<ReviewStatus, string> = {
    pending: t("대기", "未確認"),
    candidate_correct: t("후보가 맞음", "候補が正しい"),
    golden_correct: t("정답지가 맞음", "正解が正しい"),
    needs_review: t("검토 필요", "要レビュー"),
    resolved: t("해결됨", "解決済み"),
  };
  return labels[status] ?? status;
}

function categoryLabel(category: DiffCategory, t: (ko: string, ja: string) => string) {
  const labels: Record<DiffCategory, string> = {
    missing: t("누락", "不足"),
    extra: t("추가", "追加"),
    field: t("값 차이", "値差分"),
    formula: t("수식 차이", "数式差分"),
  };
  return labels[category] ?? category;
}

function monthToIso(month: string) {
  return `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
}

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function folderHintFor(file: File) {
  const relativePath = file.webkitRelativePath;
  return relativePath.includes("/") ? relativePath.split("/")[0] : undefined;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function SettlementCompareClient({ month, embedded = false }: { month: string; embedded?: boolean }) {
  const { t } = useApp();
  const sourceFilesInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFolderInputRef = useRef<HTMLInputElement | null>(null);
  const answerInputRef = useRef<HTMLInputElement | null>(null);
  const loadRunsSeqRef = useRef(0);
  const loadRunDetailsSeqRef = useRef(0);
  const compareSeqRef = useRef(0);
  const patchDiffSeqRef = useRef(0);
  const currentMonthRef = useRef(month);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [run, setRun] = useState<Run | null>(null);
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [totalDiffs, setTotalDiffs] = useState(0);
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState<DiffCategory | "">("");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | "">("");
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingSources, setUploadingSources] = useState(false);
  const [patchingId, setPatchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sourceSelection, setSourceSelection] = useState<SourceSelection[]>([]);
  const [ignoredSourceCount, setIgnoredSourceCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [answerFile, setAnswerFile] = useState<File | null>(null);

  currentMonthRef.current = month;

  const monthLabel = t(`${Number(month.slice(0, 4))}년 ${Number(month.slice(4, 6))}월`, `${Number(month.slice(0, 4))}年${Number(month.slice(4, 6))}月`);

  function clearMonthState() {
    setRuns([]);
    setSelectedRunId("");
    setRun(null);
    setDiffs([]);
    setTotalDiffs(0);
    setOffset(0);
    setCategory("");
    setReviewStatus("");
    setNotes({});
    setError(null);
    setAnswerFile(null);
    setSourceSelection([]);
    setIgnoredSourceCount(0);
    setUploadSummary(null);
    setUploadProgress(null);
    setLoadingDiffs(false);
    if (answerInputRef.current) answerInputRef.current.value = "";
    if (sourceFilesInputRef.current) sourceFilesInputRef.current.value = "";
    if (sourceFolderInputRef.current) sourceFolderInputRef.current.value = "";
  }

  function invalidateRunDetails() {
    loadRunDetailsSeqRef.current += 1;
  }

  async function loadRuns(selectLatest = false) {
    const requestSeq = ++loadRunsSeqRef.current;
    const requestMonth = month;
    setLoadingRuns(true);
    setError(null);
    try {
      const res = await fetch(`/api/settlement/comparisons?month=${requestMonth}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (requestSeq !== loadRunsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      const nextRuns = (json.runs ?? []) as Run[];
      setRuns(nextRuns);
      if (nextRuns.length > 0 && (selectLatest || !selectedRunId)) {
        invalidateRunDetails();
        setSelectedRunId(nextRuns[0].id);
      } else if (nextRuns.length === 0) {
        invalidateRunDetails();
        setSelectedRunId("");
        setRun(null);
        setDiffs([]);
        setTotalDiffs(0);
        setNotes({});
      }
    } catch (e) {
      if (requestSeq !== loadRunsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setError((e as Error).message);
    } finally {
      if (requestSeq === loadRunsSeqRef.current && requestMonth === currentMonthRef.current) {
        setLoadingRuns(false);
      }
    }
  }

  async function loadRunDetails(id: string, nextOffset = offset) {
    const requestSeq = ++loadRunDetailsSeqRef.current;
    const requestMonth = month;
    if (!id) {
      setRun(null);
      setDiffs([]);
      setTotalDiffs(0);
      return;
    }
    setLoadingDiffs(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        offset: String(nextOffset),
        limit: String(PAGE_SIZE),
      });
      if (category) params.set("category", category);
      if (reviewStatus) params.set("review_status", reviewStatus);
      const res = await fetch(`/api/settlement/comparisons/${id}?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (requestSeq !== loadRunDetailsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setRun(json.run as Run);
      const nextDiffs = (json.diffs ?? []) as Diff[];
      setDiffs(nextDiffs);
      setTotalDiffs(Number(json.pagination?.total ?? 0));
      setNotes(Object.fromEntries(nextDiffs.map((d) => [d.id, d.review_note ?? ""])));
    } catch (e) {
      if (requestSeq !== loadRunDetailsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setError((e as Error).message);
    } finally {
      if (requestSeq === loadRunDetailsSeqRef.current && requestMonth === currentMonthRef.current) {
        setLoadingDiffs(false);
      }
    }
  }

  useEffect(() => {
    compareSeqRef.current += 1;
    patchDiffSeqRef.current += 1;
    setSubmitting(false);
    setPatchingId(null);
    invalidateRunDetails();
    clearMonthState();
    void loadRuns(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    if (selectedRunId) void loadRunDetails(selectedRunId, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, offset, category, reviewStatus]);

  function addSourceFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const supported: SourceSelection[] = [];
    let ignored = 0;
    for (const file of files) {
      if (!SOURCE_EXTENSIONS.has(fileExtension(file.name))) {
        ignored += 1;
        continue;
      }
      supported.push({ file, folderHint: folderHintFor(file) });
    }
    setSourceSelection((prev) => [...prev, ...supported]);
    setIgnoredSourceCount((prev) => prev + ignored);
    setUploadSummary(null);
  }

  async function uploadSources() {
    if (sourceSelection.length === 0) return;
    const targetIsoMonth = monthToIso(month);
    const summary: UploadSummary = { success: 0, skipped: 0, failure: 0, failures: [] };

    setUploadingSources(true);
    setUploadProgress(null);
    setError(null);
    setUploadSummary(null);
    try {
      for (let index = 0; index < sourceSelection.length; index += 1) {
        const selected = sourceSelection[index];
        setUploadProgress({
          current: index + 1,
          total: sourceSelection.length,
          currentFile: selected.file.name,
        });
        try {
          const json = await uploadSettlementFileDirect(selected.file, targetIsoMonth, selected.folderHint);
          const results = Array.isArray(json.results) ? json.results : [];
          const failedRows = results.filter((row) => row.error);
          const skippedRows = results.filter((row) => row.skipped);
          const successRows = results.filter((row) => !row.error && !row.skipped);
          if (failedRows.length > 0) {
            summary.failure += 1;
          } else if (skippedRows.length > 0 && successRows.length === 0) {
            summary.skipped += 1;
          } else {
            summary.success += 1;
          }
          const firstFailure = failedRows[0];
          if (firstFailure && summary.failures.length < 10) {
            summary.failures.push({
              file: selected.file.name,
              error: String(firstFailure.error ?? t("처리 실패", "処理失敗")).slice(0, 180),
            });
          }
        } catch (e) {
          summary.failure += 1;
          if (summary.failures.length < 10) {
            summary.failures.push({
              file: selected.file.name,
              error: (e as Error).message.slice(0, 180),
            });
          }
        }
        setUploadSummary({ ...summary, failures: [...summary.failures] });
      }
    } finally {
      if (sourceSelection.length > 0) {
        setSourceSelection([]);
        setIgnoredSourceCount(0);
        if (sourceFilesInputRef.current) sourceFilesInputRef.current.value = "";
        if (sourceFolderInputRef.current) sourceFolderInputRef.current.value = "";
      }
      setUploadProgress(null);
      setUploadingSources(false);
    }
  }

  function selectAnswer(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError(t("정답지는 .xlsx 파일이어야 합니다.", "正解ファイルは .xlsx である必要があります。"));
      return;
    }
    if (file.size > MAX_ANSWER_BYTES) {
      setError(t("정답지 파일은 3.5MB 이하만 업로드할 수 있습니다.", "正解ファイルは3.5MB以下のみアップロードできます。"));
      return;
    }
    setError(null);
    setAnswerFile(file);
  }

  async function compareAnswer() {
    if (!answerFile) return;
    const requestSeq = ++compareSeqRef.current;
    const requestMonth = month;
    const isCurrentRequest = () => requestSeq === compareSeqRef.current && requestMonth === currentMonthRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("month", requestMonth);
      form.append("answer", answerFile);
      const res = await fetch("/api/settlement/comparisons", { method: "POST", body: form });
      if (!isCurrentRequest()) return;
      const json = await res.json().catch(() => ({}));
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await loadRuns(true);
      if (!isCurrentRequest()) return;
      if (json.run_id) {
        invalidateRunDetails();
        setSelectedRunId(String(json.run_id));
        setOffset(0);
      }
      setAnswerFile(null);
      if (answerInputRef.current) answerInputRef.current.value = "";
    } catch (e) {
      if (!isCurrentRequest()) return;
      setError((e as Error).message);
      await loadRuns(true);
      if (!isCurrentRequest()) return;
    } finally {
      if (isCurrentRequest()) {
        setSubmitting(false);
      }
    }
  }

  async function patchDiff(diff: Diff, status: ReviewStatus) {
    const requestSeq = ++patchDiffSeqRef.current;
    const requestMonth = month;
    const isCurrentRequest = () => requestSeq === patchDiffSeqRef.current && requestMonth === currentMonthRef.current;
    setPatchingId(diff.id);
    setError(null);
    try {
      const res = await fetch(`/api/settlement/comparisons/diffs/${diff.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ review_status: status, note: notes[diff.id] ?? "" }),
      });
      if (!isCurrentRequest()) return;
      const json = await res.json().catch(() => ({}));
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const updated = json.diff as Diff;
      setDiffs((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      setNotes((prev) => ({ ...prev, [updated.id]: updated.review_note ?? "" }));
    } catch (e) {
      if (!isCurrentRequest()) return;
      setError((e as Error).message);
    } finally {
      if (isCurrentRequest()) {
        setPatchingId(null);
      }
    }
  }

  const summary = run?.summary ?? null;
  const sourceWarnings = useMemo(
    () => (Array.isArray(summary?.source_warnings) ? summary.source_warnings : []),
    [summary],
  );
  const busy = (!embedded && uploadingSources) || submitting;
  const pageStart = totalDiffs === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, totalDiffs);

  return (
    <div className={embedded ? "flex w-full flex-col gap-6" : "mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8"}>
      {!embedded && (
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-950 dark:text-white">
              {t("정산 정답지 비교", "精算 正解ファイル比較")} · {monthLabel}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
              {t("정답지 .xlsx를 올려 DB 후보 INPUT과 비교하고, 차이별 검토 상태를 남깁니다.", "正解 .xlsx をアップロードしてDB候補INPUTと比較し、差分ごとのレビュー状態を残します。")}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {t("페이지의 정산월이 기준입니다. 소스 원본은 직접 업로드로 저장하고, 정답지는 3.5MB 이하 .xlsx만 비교에 사용합니다.", "ページの精算月が基準です。ソース原本は直接アップロードで保存し、正解ファイルは3.5MB以下の .xlsx のみ比較に使用します。")}
        </p>
      </header>
      )}

      {embedded && (
        <div>
          <h2 className="text-lg font-bold text-slate-950 dark:text-white">
            {t("정답지 비교", "正解ファイル比較")} · {monthLabel}
          </h2>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("비교 워크플로", "比較ワークフロー")}</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">{t("1단계 · 기존 INPUT 저장·파싱", "ステップ1 · 既存INPUTの保存・解析")}</p>
            {embedded ? (
              <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {t(
                  "INPUT 업로드는 상단의 정산 작업 탭에서 진행해 주세요. 이 비교 탭은 같은 정산월에 저장된 INPUT 후보를 사용합니다.",
                  "INPUTアップロードは上部の精算作業タブで行ってください。この比較タブは同じ精算月に保存されたINPUT候補を使用します。",
                )}
              </p>
            ) : (
              <>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-100">
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                {t("파일 선택", "ファイル選択")}
                <input
                  ref={sourceFilesInputRef}
                  type="file"
                  multiple
                  accept=".xlsx,.xls,.csv,.tsv,.pdf,.zip"
                  className="hidden"
                  disabled={busy}
                  onChange={addSourceFiles}
                />
              </label>
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-100">
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                {t("폴더 선택", "フォルダ選択")}
                <input
                  ref={sourceFolderInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  disabled={busy}
                  onChange={addSourceFiles}
                  {...{ webkitdirectory: "", directory: "" }}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>
                {t(
                  `선택 ${sourceSelection.length.toLocaleString()}개${ignoredSourceCount > 0 ? ` · 미지원 ${ignoredSourceCount.toLocaleString()}개 제외` : ""}`,
                  `選択 ${sourceSelection.length.toLocaleString()}件${ignoredSourceCount > 0 ? ` · 非対応 ${ignoredSourceCount.toLocaleString()}件を除外` : ""}`,
                )}
              </span>
              {(sourceSelection.length > 0 || ignoredSourceCount > 0) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSourceSelection([]);
                    setIgnoredSourceCount(0);
                    if (sourceFilesInputRef.current) sourceFilesInputRef.current.value = "";
                    if (sourceFolderInputRef.current) sourceFolderInputRef.current.value = "";
                  }}
                  className="rounded border border-slate-300 px-2 py-1 font-semibold disabled:opacity-50 dark:border-slate-700"
                >
                  {t("선택 해제", "選択解除")}
                </button>
              )}
            </div>
            {uploadProgress && (
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                {t(
                  `${uploadProgress.current}/${uploadProgress.total} 처리 중 · ${uploadProgress.currentFile}`,
                  `${uploadProgress.current}/${uploadProgress.total} 処理中 · ${uploadProgress.currentFile}`,
                )}
              </p>
            )}
            <button
              type="button"
              onClick={() => void uploadSources()}
              disabled={busy || sourceSelection.length === 0}
              className="mt-3 inline-flex items-center rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
            >
              {uploadingSources ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="mr-1.5 h-3.5 w-3.5" />}
              {t("기존 INPUT 저장·파싱", "既存INPUTを保存・解析")}
            </button>
            {uploadSummary && (
              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                <p>
                  {t(
                    `성공 ${uploadSummary.success.toLocaleString()} · 건너뜀 ${uploadSummary.skipped.toLocaleString()} · 실패 ${uploadSummary.failure.toLocaleString()}`,
                    `成功 ${uploadSummary.success.toLocaleString()} · スキップ ${uploadSummary.skipped.toLocaleString()} · 失敗 ${uploadSummary.failure.toLocaleString()}`,
                  )}
                </p>
                {uploadSummary.failures.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {uploadSummary.failures.map((failure, index) => (
                      <li key={`${failure.file}-${index}`} className="break-words text-red-700 dark:text-red-300">
                        {failure.file}: {failure.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
              </>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">{t("2단계 · 정답지 선택", "ステップ2 · 正解ファイル選択")}</p>
            <label className="mt-3 inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-100">
              <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
              {answerFile ? t("교체", "差し替え") : t("정답지 선택", "正解ファイル選択")}
              <input ref={answerInputRef} type="file" accept=".xlsx" className="hidden" disabled={busy} onChange={selectAnswer} />
            </label>
            {answerFile ? (
              <div className="mt-3 text-xs text-slate-600 dark:text-slate-300">
                <p className="font-semibold text-slate-800 dark:text-slate-100">{answerFile.name}</p>
                <p className="mt-1">{formatBytes(answerFile.size)}</p>
                <button
                  type="button"
                  onClick={() => {
                    setAnswerFile(null);
                    if (answerInputRef.current) answerInputRef.current.value = "";
                  }}
                  disabled={busy}
                  className="mt-2 rounded-lg border border-slate-300 px-2 py-1 font-semibold disabled:opacity-50 dark:border-slate-700"
                >
                  {t("선택 해제", "選択解除")}
                </button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                {t(".xlsx 1개, 3.5MB 이하만 선택할 수 있습니다.", ".xlsx 1件、3.5MB以下のみ選択できます。")}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">{t("3단계 · 비교 실행", "ステップ3 · 比較実行")}</p>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {t("선택한 정답지와 현재 정산월의 후보 INPUT을 비교합니다.", "選択した正解ファイルと現在の精算月の候補INPUTを比較します。")}
            </p>
            <button
              type="button"
              onClick={() => void compareAnswer()}
              disabled={busy || !answerFile}
              className="mt-3 inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              {t("비교 실행", "比較実行")}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4 align-[-3px]" />
          {error}
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("최근 실행", "最近の実行")}</h2>
            <button
              type="button"
              onClick={() => void loadRuns(true)}
              className="rounded-lg border border-slate-300 p-2 text-slate-700 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-200"
              aria-label={t("새로고침", "更新")}
            >
              {loadingRuns ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {runs.length === 0 && (
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                {t("아직 비교 실행이 없습니다.", "まだ比較実行がありません。")}
              </p>
            )}
            {runs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  invalidateRunDetails();
                  setSelectedRunId(item.id);
                  setOffset(0);
                }}
                className={`w-full rounded-lg border p-3 text-left text-xs transition ${
                  item.id === selectedRunId
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                    : "border-slate-200 bg-white text-slate-700 hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{item.answer_filename}</span>
                  <span>{runStatusLabel(item.status, t)}</span>
                </div>
                <div className="mt-1 text-slate-500 dark:text-slate-400">{new Date(item.created_at).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex flex-col gap-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("실행 상태", "実行状態")}</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {run ? `${displayMonth(run.month.replaceAll("-", "").slice(0, 6))} · ${runStatusLabel(run.status, t)}` : t("실행을 선택해 주세요.", "実行を選択してください。")}
                </p>
              </div>
              {run && (
                <div className="flex flex-wrap gap-2">
                  <a
                    href={`/api/settlement/comparisons/${run.id}/artifacts/answer`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-100"
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {t("정답지 열기", "正解を開く")}
                  </a>
                  <a
                    href={`/api/settlement/comparisons/${run.id}/artifacts/candidate`}
                    target="_blank"
                    rel="noreferrer"
                    className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold dark:border-slate-700 ${run.candidate_filename ? "text-slate-800 dark:text-slate-100" : "pointer-events-none opacity-50"}`}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {t("후보 열기", "候補を開く")}
                  </a>
                </div>
              )}
            </div>
            {run?.error && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">{run.error}</p>
            )}
            {sourceWarnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {t("누락 소스 family", "不足ソースfamily")}: {sourceWarnings.join(", ")}
              </div>
            )}
            {summary?.diffs_truncated && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {t(
                  `차이가 매우 많아 ${metric(summary.persisted_diff_count)}건까지만 검토 목록에 저장됐습니다.`,
                  `差分が非常に多いため、レビュー一覧には${metric(summary.persisted_diff_count)}件まで保存されました。`,
                )}
              </div>
            )}
            {summary?.source_uploads_truncated && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {t(
                  `소스 업로드가 많아 처음 500건만 manifest에 저장했습니다. 관측 수는 최소 ${metric(summary.source_uploads_observed_count_at_least)}건입니다.`,
                  `ソースアップロードが多いため、manifestには最初の500件のみ保存しました。観測数は少なくとも${metric(summary.source_uploads_observed_count_at_least)}件です。`,
                )}
              </div>
            )}
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [t("후보 행", "候補行"), summary?.candidate_rows],
                [t("정답 행", "正解行"), summary?.golden_rows],
                [t("매칭 행", "照合行"), summary?.matched_rows],
                [t("완전 일치", "完全一致"), summary?.exact_rows],
                [t("누락", "不足"), summary?.missing_rows],
                [t("추가", "追加"), summary?.extra_rows],
                [t("차이 총계", "差分合計"), summary?.diff_total],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                  <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-1 text-xl font-bold text-slate-950 dark:text-white">{metric(value)}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("차이 목록", "差分一覧")}</h2>
              <div className="flex flex-wrap gap-2">
                <select
                  value={category}
                  onChange={(e) => {
                    invalidateRunDetails();
                    setCategory(e.target.value as DiffCategory | "");
                    setOffset(0);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">{t("전체 분류", "全分類")}</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c, t)}</option>)}
                </select>
                <select
                  value={reviewStatus}
                  onChange={(e) => {
                    invalidateRunDetails();
                    setReviewStatus(e.target.value as ReviewStatus | "");
                    setOffset(0);
                  }}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">{t("전체 상태", "全状態")}</option>
                  {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{reviewStatusLabel(s, t)}</option>)}
                </select>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                  <tr>
                    <th className="py-2 pr-3">{t("상태", "状態")}</th>
                    <th className="py-2 pr-3">{t("분류", "分類")}</th>
                    <th className="py-2 pr-3">{t("채널", "チャネル")}</th>
                    <th className="py-2 pr-3">{t("유형", "種別")}</th>
                    <th className="py-2 pr-3">{t("작품명", "タイトル")}</th>
                    <th className="py-2 pr-3">{t("필드", "項目")}</th>
                    <th className="py-2 pr-3">{t("후보", "候補")}</th>
                    <th className="py-2 pr-3">{t("정답", "正解")}</th>
                    <th className="py-2 pr-3">{t("메모", "メモ")}</th>
                    <th className="py-2 pr-3">{t("저장", "保存")}</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingDiffs && (
                    <tr><td colSpan={10} className="py-8 text-center text-slate-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />{t("불러오는 중", "読み込み中")}</td></tr>
                  )}
                  {!loadingDiffs && diffs.length === 0 && (
                    <tr><td colSpan={10} className="py-8 text-center text-slate-500">{t("표시할 차이가 없습니다.", "表示する差分はありません。")}</td></tr>
                  )}
                  {!loadingDiffs && diffs.map((diff) => (
                    <tr key={diff.id} className="border-b border-slate-100 align-top dark:border-slate-800">
                      <td className="py-2 pr-3">
                        <select
                          value={diff.review_status}
                          onChange={(e) => void patchDiff(diff, e.target.value as ReviewStatus)}
                          disabled={patchingId === diff.id}
                          className="w-40 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                        >
                          {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{reviewStatusLabel(s, t)}</option>)}
                        </select>
                      </td>
                      <td className="py-2 pr-3 text-xs">{categoryLabel(diff.category, t)}</td>
                      <td className="py-2 pr-3 text-xs">{diff.identity_channel ?? "-"}</td>
                      <td className="py-2 pr-3 text-xs">{diff.identity_type ?? "-"}</td>
                      <td className="max-w-56 break-words py-2 pr-3 text-xs">{diff.identity_title ?? "-"}</td>
                      <td className="py-2 pr-3 text-xs">{diff.field ?? "-"}</td>
                      <td className="max-w-64 break-words py-2 pr-3 text-xs">{boundedText(diff.candidate_value)}</td>
                      <td className="max-w-64 break-words py-2 pr-3 text-xs">{boundedText(diff.golden_value)}</td>
                      <td className="py-2 pr-3">
                        <input
                          value={notes[diff.id] ?? ""}
                          onChange={(e) => setNotes((prev) => ({ ...prev, [diff.id]: e.target.value.slice(0, 2000) }))}
                          className="w-52 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => void patchDiff(diff, diff.review_status)}
                          disabled={patchingId === diff.id}
                          className="inline-flex items-center rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold dark:border-slate-700"
                        >
                          {patchingId === diff.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                          {t("저장", "保存")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span>{pageStart}-{pageEnd} / {totalDiffs}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    invalidateRunDetails();
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                  disabled={offset === 0 || loadingDiffs}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700"
                >
                  {t("이전", "前へ")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    invalidateRunDetails();
                    setOffset(offset + PAGE_SIZE);
                  }}
                  disabled={offset + PAGE_SIZE >= totalDiffs || loadingDiffs}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700"
                >
                  {t("다음", "次へ")}
                </button>
              </div>
            </div>
          </section>
        </main>
      </section>
    </div>
  );
}
