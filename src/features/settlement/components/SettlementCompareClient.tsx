"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
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

const CATEGORY_BADGE: Record<DiffCategory, string> = {
  missing: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  extra: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  field: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  formula: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function SettlementCompareClient({ month }: { month: string }) {
  const { t } = useApp();
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
  const [patchingId, setPatchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

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
    setDragActive(false);
    setLoadingDiffs(false);
    if (answerInputRef.current) answerInputRef.current.value = "";
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
      if (nextRuns.length > 0 && selectLatest) {
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
    // Load history for the bottom section without presenting an old run as
    // the result of the operator's current comparison.
    void loadRuns(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    if (selectedRunId) void loadRunDetails(selectedRunId, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, offset, category, reviewStatus]);

  function applyAnswerFile(file: File) {
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

  function selectAnswer(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    applyAnswerFile(file);
  }

  function dropAnswer(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (submitting) return;
    const file = e.dataTransfer.files?.[0];
    if (file) applyAnswerFile(file);
  }

  function clearAnswer() {
    setAnswerFile(null);
    if (answerInputRef.current) answerInputRef.current.value = "";
  }

  async function compareAnswer() {
    if (!answerFile) return;
    const requestSeq = ++compareSeqRef.current;
    const requestMonth = month;
    const isCurrentRequest = () => requestSeq === compareSeqRef.current && requestMonth === currentMonthRef.current;
    setSubmitting(true);
    setError(null);
    // Drop the previous run immediately so its result and artifact links
    // cannot stay visible while this comparison runs or after it fails.
    invalidateRunDetails();
    setSelectedRunId("");
    setRun(null);
    setDiffs([]);
    setTotalDiffs(0);
    setOffset(0);
    setNotes({});
    setLoadingDiffs(false);
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
      const message = (e as Error).message;
      await loadRuns(false);
      if (!isCurrentRequest()) return;
      setError(message);
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
  const pageStart = totalDiffs === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, totalDiffs);

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h2 className="text-lg font-bold text-slate-950 dark:text-white">
          {t("정답지 비교", "正解ファイル比較")} · {monthLabel}
        </h2>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
          <div
            role="button"
            tabIndex={0}
            aria-label={t("정답지 .xlsx 선택 또는 끌어다 놓기", "正解 .xlsx を選択またはドラッグ＆ドロップ")}
            onClick={() => {
              if (!submitting) answerInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!submitting) answerInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={dropAnswer}
            className={`flex min-h-36 flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              dragActive
                ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                : "border-slate-300 bg-slate-50 hover:border-emerald-400 dark:border-slate-700 dark:bg-slate-950"
            }`}
          >
            <UploadCloud className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            {answerFile ? (
              <>
                <p className="break-all text-sm font-semibold text-slate-900 dark:text-white">{answerFile.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{formatBytes(answerFile.size)}</p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearAnswer();
                  }}
                  disabled={submitting}
                  className="mt-1 rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                >
                  {t("선택 해제", "選択解除")}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t("정답지 .xlsx를 여기에 끌어다 놓거나 클릭해 선택하세요.", "正解 .xlsx をここにドラッグ＆ドロップするか、クリックして選択してください。")}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(".xlsx 1개, 3.5MB 이하 · 현재 정산월의 INPUT 후보와 비교합니다.", ".xlsx 1件、3.5MB以下 · 現在の精算月のINPUT候補と比較します。")}
                </p>
              </>
            )}
          </div>
          <input ref={answerInputRef} type="file" accept=".xlsx" className="hidden" disabled={submitting} onChange={selectAnswer} />
          <button
            type="button"
            onClick={() => void compareAnswer()}
            disabled={submitting || !answerFile}
            className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 lg:self-stretch"
          >
            {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
            {t("비교하기", "比較実行")}
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4 align-[-3px]" />
          {error}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("비교 결과", "比較結果")}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {run
                ? `${run.answer_filename} · ${displayMonth(run.month.replaceAll("-", "").slice(0, 6))} · ${runStatusLabel(run.status, t)}`
                : t("정답지를 업로드해 비교를 실행하거나, 아래 비교 이력에서 선택해 주세요.", "正解ファイルをアップロードして比較を実行するか、下の比較履歴から選択してください。")}
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t("후보 행", "候補行"), summary?.candidate_rows],
            [t("정답 행", "正解行"), summary?.golden_rows],
            [t("매칭 행", "照合行"), summary?.matched_rows],
            [t("완전 일치", "完全一致"), summary?.exact_rows],
            [t("누락", "不足"), summary?.missing_rows],
            [t("추가", "追加"), summary?.extra_rows],
            [t("차이 총계", "差分合計"), summary?.diff_total],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</p>
              <p className="mt-1 text-2xl font-bold text-slate-950 dark:text-white">{metric(value)}</p>
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

        {loadingDiffs && (
          <div className="mt-4 rounded-xl bg-slate-50 py-10 text-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            {t("불러오는 중", "読み込み中")}
          </div>
        )}
        {!loadingDiffs && diffs.length === 0 && (
          <div className="mt-4 rounded-xl bg-slate-50 py-10 text-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
            {t("표시할 차이가 없습니다.", "表示する差分はありません。")}
          </div>
        )}
        {!loadingDiffs && diffs.length > 0 && (
          <ul className="mt-4 space-y-3">
            {diffs.map((diff) => (
              <li key={diff.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${CATEGORY_BADGE[diff.category]}`}>
                    {categoryLabel(diff.category, t)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {reviewStatusLabel(diff.review_status, t)}
                  </span>
                </div>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    [t("채널", "チャネル"), diff.identity_channel],
                    [t("유형", "種別"), diff.identity_type],
                    [t("작품명", "タイトル"), diff.identity_title],
                    [t("필드", "項目"), diff.field],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
                      <dd className="break-words font-medium text-slate-900 dark:text-slate-100">{value ?? "-"}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{t("후보 (DB)", "候補 (DB)")}</p>
                    <p className="mt-1 break-words text-sm text-slate-900 dark:text-slate-100">{boundedText(diff.candidate_value)}</p>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
                    <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{t("정답 (파일)", "正解 (ファイル)")}</p>
                    <p className="mt-1 break-words text-sm text-slate-900 dark:text-slate-100">{boundedText(diff.golden_value)}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    value={diff.review_status}
                    onChange={(e) => void patchDiff(diff, e.target.value as ReviewStatus)}
                    disabled={patchingId === diff.id}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{reviewStatusLabel(s, t)}</option>)}
                  </select>
                  <input
                    value={notes[diff.id] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [diff.id]: e.target.value.slice(0, 2000) }))}
                    placeholder={t("메모", "メモ")}
                    className="min-w-48 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={() => void patchDiff(diff, diff.review_status)}
                    disabled={patchingId === diff.id}
                    className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold dark:border-slate-700"
                  >
                    {patchingId === diff.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                    {t("저장", "保存")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

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

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("비교 이력", "比較履歴")}</h2>
          <button
            type="button"
            onClick={() => void loadRuns(false)}
            className="rounded-lg border border-slate-300 p-2 text-slate-700 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-200"
            aria-label={t("새로고침", "更新")}
          >
            {loadingRuns ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {runs.length === 0 && (
            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-950 dark:text-slate-400 sm:col-span-2 lg:col-span-3">
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
      </section>
    </div>
  );
}
