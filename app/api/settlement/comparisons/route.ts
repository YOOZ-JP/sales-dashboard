/**
 * POST /api/settlement/comparisons
 *   Multipart: month=YYYYMM, answer=<xlsx File> (the human answer-key).
 *   1. Archive the answer-key to private Storage FIRST (it must survive any
 *      later failure — either side of the comparison can be wrong).
 *   2. Insert a 'processing' settlement_comparison_runs row with source
 *      upload provenance for the month.
 *   3. Generate the candidate workbook from the DB (loadInputV2Records +
 *      fillInputV2Template), archive it, compare, persist summary + bounded
 *      diffs, complete the run.
 *   Generation/comparison failure marks the run 'failed' but keeps the
 *   archived answer-key and whatever was stored before the failure.
 *
 * GET /api/settlement/comparisons?month=YYYYMM
 *   Recent runs (newest first), optionally filtered by month.
 *
 * Same auth as the rest of the settlement API (dashboard refresh cookie);
 * comparison table access uses server-only direct Postgres. Raw-upload
 * manifest and Storage access keep using the shared Supabase server client.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import {
  completeComparisonRun,
  createComparisonRun,
  insertComparisonDiffChunks,
  listComparisonRuns,
  markComparisonRunFailed,
  updateComparisonRunCandidate,
} from "@/features/settlement/lib/comparison/store";
import {
  buildSourceUploadManifest,
  SOURCE_MANIFEST_OBSERVE_LIMIT,
} from "@/features/settlement/lib/comparison/source-manifest";
import type {
  Json,
  SettlementComparisonDiffInsert,
  SettlementComparisonRunInsert,
} from "@/features/settlement/lib/supabase/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ANSWER_BYTES = 3_500_000;
const MAX_PERSISTED_DIFFS = 20_000;
const DIFF_INSERT_CHUNK = 500;

function monthToBatchIso(month: string): string | null {
  if (!/^\d{6}$/.test(month)) return null;
  const m = Number(month.slice(4, 6));
  if (m < 1 || m > 12) return null;
  return `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
}

export async function POST(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const form = await request.formData();
  const month = typeof form.get("month") === "string" ? (form.get("month") as string) : "";
  const batchIso = monthToBatchIso(month);
  if (!batchIso) {
    return NextResponse.json({ error: "month must be YYYYMM, e.g. 202605" }, { status: 400 });
  }
  const answer = form.get("answer");
  if (!(answer instanceof File) || answer.size === 0) {
    return NextResponse.json({ error: "answer must be a non-empty file" }, { status: 400 });
  }
  if (answer.size > MAX_ANSWER_BYTES) {
    return NextResponse.json({ error: "answer file too large (max 3.5MB)" }, { status: 413 });
  }
  const answerBuffer = Buffer.from(await answer.arrayBuffer());

  const [sharedSupabase, archive, coordinator] = await Promise.all([
    import("@/lib/supabase-server"),
    import("@/features/settlement/lib/storage/archive"),
    import("@/features/settlement/lib/storage/archive-before-parse"),
  ]);
  const { supabaseServer: supabase } = sharedSupabase;
  const { writeComparisonArtifact } = archive;
  const { sha256Hex } = coordinator;

  // 1. The answer-key becomes durable before anything else can fail.
  const answerSha = sha256Hex(answerBuffer);
  let answerPath: string;
  try {
    const stored = await writeComparisonArtifact(
      "answer-key",
      answer.name || `answer_${month}.xlsx`,
      answerBuffer,
      batchIso,
      supabase,
    );
    answerPath = stored.path;
  } catch (e) {
    return NextResponse.json(
      { error: `failed to store answer-key: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Provenance: which raw uploads exist for this month right now.
  let sourceUploadIds: string[] = [];
  let sourceManifest: Json | null = null;
  try {
    const { data: uploads, error } = await supabase
      .from("raw_uploads")
      .select("id, filename, platform_code, status, parsed_rows, sha256")
      .eq("settlement_month", batchIso)
      .order("uploaded_at", { ascending: true })
      .limit(SOURCE_MANIFEST_OBSERVE_LIMIT);
    if (error) throw new Error(error.message);
    const manifest = buildSourceUploadManifest(uploads ?? []);
    sourceUploadIds = manifest.sourceUploadIds;
    sourceManifest = manifest.sourceManifest;
  } catch (e) {
    // Provenance is best-effort; the run itself must still be recorded.
    console.warn(`[comparisons] ${month}: source manifest failed: ${(e as Error).message}`);
  }

  // 2. Insert the processing run.
  const runInsert: SettlementComparisonRunInsert = {
    month: batchIso,
    status: "processing",
    answer_filename: answer.name || `answer_${month}.xlsx`,
    answer_storage_path: answerPath,
    answer_sha256: answerSha,
    source_upload_ids: sourceUploadIds,
    source_manifest: sourceManifest,
  };
  let run: { id: string };
  try {
    run = await createComparisonRun(runInsert);
  } catch (e) {
    return NextResponse.json(
      { error: `failed to create comparison run: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const failRun = async (message: string, status: number) => {
    try {
      await markComparisonRunFailed(run.id, message);
    } catch {
      console.error(`[comparisons] run ${run.id}: failed-status update error`);
    }
    return NextResponse.json({ error: message, run_id: run.id }, { status });
  };

  // 3. Generate candidate → archive it → compare → persist findings.
  try {
    const { loadInputV2Records } = await import(
      "@/features/settlement/lib/export/load-input-v2-records"
    );
    const { records, loadError, sourceWarnings } = await loadInputV2Records(month, {
      allowIncompleteSources: true,
    });
    if (loadError) {
      return await failRun(`candidate generation failed: ${loadError.error} — ${loadError.details}`, loadError.status);
    }
    if (records.length === 0) {
      return await failRun(`no settlement records exist for ${month}; upload files first`, 404);
    }

    const { fillInputV2Template } = await import(
      "@/features/settlement/lib/export/input-v2-filler"
    );
    const filled = await fillInputV2Template({ month, records });
    const candidateFilename = `JP_INPUT_V2_${month}_candidate.xlsx`;
    const candidateSha = sha256Hex(filled.buffer);
    const stored = await writeComparisonArtifact(
      "candidate",
      candidateFilename,
      filled.buffer,
      batchIso,
      supabase,
    );
    await updateComparisonRunCandidate(run.id, {
      candidate_filename: candidateFilename,
      candidate_storage_path: stored.path,
      candidate_sha256: candidateSha,
    });

    const { compareInputWorkbooks } = await import("@/features/settlement/lib/comparison");
    const { summary: comparisonSummary, diffs } = await compareInputWorkbooks({
      candidate: filled.buffer,
      golden: answerBuffer,
      maxDiffs: MAX_PERSISTED_DIFFS,
    });
    const summary = {
      ...comparisonSummary,
      source_warnings: sourceWarnings,
      source_uploads_truncated:
        typeof sourceManifest === "object" && sourceManifest !== null && !Array.isArray(sourceManifest)
          ? Boolean((sourceManifest as { uploads_truncated?: unknown }).uploads_truncated)
          : false,
      source_uploads_observed_count_at_least:
        typeof sourceManifest === "object" && sourceManifest !== null && !Array.isArray(sourceManifest)
          ? Number((sourceManifest as { observed_count_at_least?: unknown }).observed_count_at_least ?? 0)
          : 0,
      persisted_diff_count: diffs.length,
      diffs_truncated: comparisonSummary.diff_total > diffs.length,
    };

    const diffRows: SettlementComparisonDiffInsert[] = diffs.map((d) => ({
      run_id: run.id,
      category: d.category,
      identity_channel: d.identity.channel || null,
      identity_type: d.identity.type || null,
      identity_title: d.identity.title || null,
      field: d.field,
      candidate_value: d.candidate,
      golden_value: d.golden,
    }));
    await insertComparisonDiffChunks(diffRows, DIFF_INSERT_CHUNK);

    await completeComparisonRun(run.id, summary as unknown as Json);

    return NextResponse.json({
      run_id: run.id,
      status: "completed",
      month: batchIso,
      summary,
      source_warnings: sourceWarnings,
      persisted_diffs: diffs.length,
    });
  } catch (e) {
    return await failRun((e as Error).message || "comparison failed", 500);
  }
}

export async function GET(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  let batchIso: string | null = null;
  if (month) {
    batchIso = monthToBatchIso(month);
    if (!batchIso) {
      return NextResponse.json({ error: "month must be YYYYMM" }, { status: 400 });
    }
  }

  try {
    const runs = await listComparisonRuns({ month: batchIso, limit: 50 });
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
