/**
 * POST /api/settlement/upload
 *
 * Supports two upload modes:
 *   - multipart/form-data with raw files, archived before parsing
 *   - application/json { upload_id } for files already uploaded directly to
 *     private Supabase Storage through /api/settlement/uploads/prepare
 *
 * Both modes converge on the same buffer -> parse -> raw_records ->
 * sales_records business logic.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseServer } from "@/lib/supabase-server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { resolveSettlementMonth } from "@/features/settlement/lib/resolve-settlement-month";
import { archiveBeforeParse } from "@/features/settlement/lib/storage/archive-before-parse";
import {
  DIRECT_UPLOAD_BUCKET,
  TERMINAL_UPLOAD_STATUSES,
  evaluateExactSourceDuplicate,
  isZeroRowParseFailure,
  parseProcessUploadPayload,
  prepareDirectUploadForParse,
  statusAfterParseMetadata,
  validateFolderHint,
  type ExactSourceCandidate,
  type ExactSourceDuplicateDecision,
} from "@/features/settlement/lib/storage/direct-upload";
import type { Json, RawUploadInsert } from "@/features/settlement/lib/supabase/types";
import type {
  TransformContext,
  LookupMaps,
} from "@/features/settlement/lib/aggregation/to-sales-records";
import {
  STRICT_KEY_COLUMNS,
  suppressDuplicatesAtInsert,
} from "@/features/settlement/lib/aggregation/strict-record-key";

export const runtime = "nodejs";
// Pro plan allows up to 800s; deterministic image-PDF OCR (Shueisha) can
// exceed the 300s default and was hitting the timeout in production.
export const maxDuration = 800;

type ParseFile = typeof import("@/features/settlement/lib/parsers").parseFile;
type ParsedFile = Awaited<ReturnType<ParseFile>>;
type ToSalesRecords = typeof import("@/features/settlement/lib/aggregation/to-sales-records").toSalesRecords;
type BuildLookupMaps = typeof import("@/features/settlement/lib/aggregation/to-sales-records").buildLookupMaps;

type UploadResult = Record<string, unknown>;

type ProcessParsedArgs = {
  supabase: SupabaseClient;
  uploadId: string;
  filename: string;
  parsed: ParsedFile;
  activeMonth: string | null;
  fallbackMonth: string | null;
  lookups: LookupMaps;
  toSalesRecords: ToSalesRecords;
  runLabel: string;
  /** True only when the exact-source SHA duplicate gate already ran for this upload. */
  exactSourceGateApplied: boolean;
};

export async function POST(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handlePreparedUpload(request);
  }
  return handleMultipartUpload(request);
}

async function handleMultipartUpload(request: Request) {
  const [sharedSupabase, parsers, aggregation, archive] = await Promise.all([
    import("@/lib/supabase-server"),
    import("@/features/settlement/lib/parsers"),
    import("@/features/settlement/lib/aggregation/to-sales-records"),
    import("@/features/settlement/lib/storage/archive"),
  ]);
  const { supabaseServer: supabase } = sharedSupabase;
  const { parseFile } = parsers;
  const { toSalesRecords, buildLookupMaps } = aggregation;
  const { writeToArchive } = archive;

  const form = await request.formData();
  const files = form.getAll("files") as File[];
  const folderHintValidation = validateFolderHint(form.get("folder"));
  if (!folderHintValidation.ok) {
    return NextResponse.json({ error: folderHintValidation.error }, { status: 400 });
  }
  const folderHint = folderHintValidation.value;
  const activeMonthRaw = (form.get("activeMonth") as string) || "";
  const activeMonth = /^\d{4}-\d{2}-01$/.test(activeMonthRaw) ? activeMonthRaw : null;
  const fallbackMonthRaw = (form.get("fallbackMonth") as string) || "";
  const fallbackMonth = /^\d{4}-\d{2}-01$/.test(fallbackMonthRaw) ? fallbackMonthRaw : null;
  const replaceMonth = form.get("replaceMonth") === "1";
  const runLabel = buildRunLabel(request, form);

  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }
  console.log(`[upload]${runLabel} received ${files.length} file(s)`);

  if (replaceMonth && activeMonth) {
    const { error: delErr } = await supabase
      .from("sales_records")
      .delete()
      .eq("settlement_batch", activeMonth);
    if (delErr) {
      return NextResponse.json(
        { error: `failed to clear month: ${delErr.message}` },
        { status: 500 },
      );
    }
  }

  const lookups = await loadLookups(supabase, buildLookupMaps);
  if ("error" in lookups) {
    return NextResponse.json({ error: lookups.error }, { status: 500 });
  }

  const results: UploadResult[] = [];
  for (const f of files) {
    const buffer = Buffer.from(await f.arrayBuffer());
    const { data: uploadRow, error: insertErr } = await supabase
      .from("raw_uploads")
      .insert({
        filename: f.name,
        storage_path: `(parsing) ${f.name}`,
        size_bytes: buffer.byteLength,
        content_type: f.type,
        settlement_month: activeMonth,
        status: "parsing",
      })
      .select("id")
      .single();

    if (insertErr || !uploadRow) {
      const msg = insertErr?.message ?? "upload insert failed";
      console.error(`[upload]${runLabel} ${f.name}: raw_uploads insert failed`);
      results.push({ file: f.name, error: msg });
      continue;
    }
    console.log(`[upload]${runLabel} parsing ${f.name} (${buffer.byteLength} bytes) upload_id=${uploadRow.id}`);

    const coordinated = await archiveBeforeParse<ParsedFile>(buffer, {
      archive: () => writeToArchive(f.name, buffer, activeMonth, supabase),
      recordArchived: async (path, sha256) => {
        const { error } = await supabase
          .from("raw_uploads")
          .update({ storage_path: path, sha256, archived_at: new Date().toISOString() })
          .eq("id", uploadRow.id);
        if (error) throw new Error(error.message);
      },
      parse: () => parseFile({ filename: f.name, buffer, folderName: folderHint }),
    });

    if (!coordinated.ok) {
      const msg =
        coordinated.stage === "parse"
          ? `parse failed: ${coordinated.error}`
          : coordinated.stage === "archive"
            ? `archive failed: ${coordinated.error}`
            : `archive record failed: ${coordinated.error}`;
      console.error(`[upload]${runLabel} ${f.name}: ${msg}`);
      await markUploadFailed(supabase, uploadRow.id, {
        parse_error: msg,
        storage_path: coordinated.archivePath ?? `(not archived) ${f.name}`,
        sha256: coordinated.sha256,
      }, runLabel, f.name);
      results.push({ file: f.name, error: msg });
      continue;
    }

    results.push(await processParsedUpload({
      supabase,
      uploadId: uploadRow.id,
      filename: f.name,
      parsed: coordinated.parsed,
      activeMonth,
      fallbackMonth,
      lookups: lookups.value,
      toSalesRecords,
      runLabel,
      // Legacy multipart archives files but never compares SHAs, so identical
      // reuploads reach the insert stage and must be suppressed there.
      exactSourceGateApplied: false,
    }));
  }

  return NextResponse.json({ results });
}

async function handlePreparedUpload(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { uploadId, folderHint } = parseProcessUploadPayload(body);
  if (!folderHint.ok) {
    return NextResponse.json({ error: folderHint.error }, { status: 400 });
  }

  const prepared = await prepareDirectUploadForParse(String(uploadId ?? ""), {
    getUpload: async (id) => {
      const { data, error } = await supabaseServer
        .from("raw_uploads")
        .select("id, filename, storage_path, size_bytes, content_type, settlement_month, status")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    download: async (path) => {
      const { data, error } = await supabaseServer.storage.from(DIRECT_UPLOAD_BUCKET).download(path);
      if (error || !data) throw new Error(error?.message ?? "download failed");
      return Buffer.from(await data.arrayBuffer());
    },
    markParsing: async (id, sha256) => {
      const { data, error } = await supabaseServer
        .from("raw_uploads")
        .update({ status: "parsing", sha256, archived_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "uploaded")
        .select("id");
      if (error) throw new Error(error.message);
      return data && data.length === 1 ? "updated" : "not_uploaded";
    },
    markFailed: async (id, message) => {
      await markUploadFailed(supabaseServer, id, { parse_error: message }, "", "direct upload");
    },
  });

  if (!prepared.ok) {
    if (prepared.skipped) {
      return NextResponse.json({
        results: [{
          upload_id: prepared.row?.id,
          file: prepared.row?.filename,
          skipped: true,
          skip_reason: prepared.error,
          status: prepared.row?.status,
        }],
      });
    }
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }

  // Exact-source duplicate gate: the row is already claimed as parsing with
  // sha256/archived_at stamped, so a byte-identical reupload of an already
  // processed month is preserved as an audit row and skipped with zero writes.
  // A gate lookup failure only degrades to parsing normally — it never blocks.
  let duplicate: ExactSourceDuplicateDecision = { skip: false };
  let exactSourceGateApplied = false;
  if (prepared.row.settlement_month) {
    try {
      const { data, error } = await supabaseServer
        .from("raw_uploads")
        .select("id, filename, status, sha256, settlement_month, parsed_rows")
        .eq("sha256", prepared.sha256)
        .eq("settlement_month", prepared.row.settlement_month)
        .neq("id", prepared.row.id)
        .in("status", TERMINAL_UPLOAD_STATUSES as string[])
        .limit(20)
        .returns<ExactSourceCandidate[]>();
      if (error) throw new Error(error.message);
      duplicate = evaluateExactSourceDuplicate(prepared.row, prepared.sha256, data ?? []);
      exactSourceGateApplied = true;
    } catch (e) {
      console.warn(
        `[upload] ${prepared.row.filename}: exact-source duplicate check failed (${(e as Error).message}); continuing with parse`,
      );
    }
  }
  if (duplicate.skip) {
    const { error: skipErr } = await supabaseServer
      .from("raw_uploads")
      .update({
        status: duplicate.status,
        parsed_rows: duplicate.parsedRows,
        parse_error: duplicate.note,
        parsed_at: new Date().toISOString(),
      })
      .eq("id", prepared.row.id);
    if (skipErr) {
      const msg = `duplicate skip update: ${skipErr.message}`;
      console.error(`[upload] ${prepared.row.filename}: ${msg}`);
      await markUploadFailed(supabaseServer, prepared.row.id, { parse_error: msg }, "", prepared.row.filename);
      return NextResponse.json({
        results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: msg }],
      });
    }
    console.log(
      `[upload] ${prepared.row.filename}: skipped exact-source duplicate of upload ${duplicate.prior.id}`,
    );
    return NextResponse.json({
      results: [{
        upload_id: prepared.row.id,
        file: prepared.row.filename,
        skipped: true,
        skip_reason: duplicate.note,
        status: duplicate.status,
        parsed_rows: duplicate.parsedRows,
        sales_records_written: 0,
        settlement_month: prepared.row.settlement_month,
      }],
    });
  }

  const [parsers, aggregation] = await Promise.all([
    import("@/features/settlement/lib/parsers"),
    import("@/features/settlement/lib/aggregation/to-sales-records"),
  ]);
  const lookups = await loadLookups(supabaseServer, aggregation.buildLookupMaps);
  if ("error" in lookups) {
    return NextResponse.json({ error: lookups.error }, { status: 500 });
  }

  let parsed: ParsedFile;
  try {
    parsed = await parsers.parseFile({
      filename: prepared.row.filename,
      buffer: prepared.buffer,
      folderName: folderHint.value,
    });
  } catch (e) {
    const msg = `parse failed: ${(e as Error).message || "parse failed"}`;
    await markUploadFailed(supabaseServer, prepared.row.id, { parse_error: msg }, "", prepared.row.filename);
    return NextResponse.json({
      results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: msg }],
    });
  }

  const result = await processParsedUpload({
    supabase: supabaseServer,
    uploadId: prepared.row.id,
    filename: prepared.row.filename,
    parsed,
    activeMonth: prepared.row.settlement_month,
    fallbackMonth: null,
    lookups: lookups.value,
    toSalesRecords: aggregation.toSalesRecords,
    runLabel: "",
    // Preserve Piccoma companions only when the exact-source lookup really
    // completed. A lookup failure falls back to conservative suppression.
    exactSourceGateApplied,
  });
  return NextResponse.json({ results: [result] });
}

async function loadLookups(
  supabase: SupabaseClient,
  buildLookupMaps: BuildLookupMaps,
): Promise<{ value: LookupMaps } | { error: string }> {
  try {
    const [{ data: clients, error: clientsError }, { data: channels, error: channelsError }] = await Promise.all([
      supabase.from("clients").select("*"),
      supabase.from("channels").select("*"),
    ]);
    if (clientsError || channelsError) {
      throw new Error(
        [clientsError?.message, channelsError?.message].filter(Boolean).join("; "),
      );
    }
    return { value: buildLookupMaps({ clients: clients ?? [], channels: channels ?? [] }) };
  } catch (e) {
    return { error: `failed to load lookups: ${(e as Error).message}` };
  }
}

async function processParsedUpload(args: ProcessParsedArgs): Promise<UploadResult> {
  const {
    supabase,
    uploadId,
    filename,
    parsed,
    activeMonth,
    fallbackMonth,
    lookups,
    toSalesRecords,
    runLabel,
    exactSourceGateApplied,
  } = args;

  const resolution = resolveSettlementMonth({
    activeMonth,
    parsedSettlementMonth: parsed.settlement_month,
    hasRecords: parsed.records.length > 0,
    fallbackMonth,
  });
  if (!resolution.ok) {
    console.warn(`[upload]${runLabel} ${filename} platform=${parsed.platform_code}: ${resolution.error}`);
    await markUploadFailed(supabase, uploadId, {
      platform_code: parsed.platform_code,
      sales_month: parsed.sales_month || null,
      detection_confidence: parsed.detection_confidence,
      parsed_rows: parsed.records.length,
      parse_error: resolution.error,
    }, runLabel, filename);
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: parsed.records.length,
      sales_month: parsed.sales_month || null,
      error: resolution.error,
    };
  }

  const effectiveSettlement = resolution.month;
  if (resolution.note) {
    console.log(`[upload]${runLabel} ${filename}: settlement month inherited from batch hint ${effectiveSettlement}`);
    parsed.errors.push(resolution.note);
  }
  const zeroRowFailure = isZeroRowParseFailure(parsed.platform_code, parsed.records.length, parsed.errors);
  const parsedStatus = statusAfterParseMetadata(parsed.records.length, zeroRowFailure);

  const { error: updateErr } = await supabase
    .from("raw_uploads")
    .update({
      platform_code: parsed.platform_code,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      status: parsedStatus,
      detection_confidence: parsed.detection_confidence,
      parse_error: parsed.errors.filter(Boolean).join("; ") || null,
      parsed_rows: parsed.records.length,
      parsed_at: new Date().toISOString(),
    })
    .eq("id", uploadId);

  if (updateErr) {
    console.error(`[upload]${runLabel} ${filename}: raw_uploads update failed`);
    return { file: filename, error: updateErr.message };
  }

  let rawRecordIds: Map<number, string> | undefined;
  if (parsed.records.length > 0) {
    const { data: insertedRaws, error: rawsErr } = await supabase
      .from("raw_records")
      .insert(
        parsed.records.map((r) => ({
          upload_id: uploadId,
          row_index: r.row_index,
          data: r.data as unknown as Json,
        })),
      )
      .select("id, row_index");
    if (rawsErr) {
      const msg = `raw_records insert: ${rawsErr.message}`;
      console.error(`[upload]${runLabel} ${filename} platform=${parsed.platform_code}: raw_records insert failed`);
      await markUploadFailed(supabase, uploadId, {
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: msg,
      }, runLabel, filename);
      return { file: filename, error: msg };
    }
    if (insertedRaws) {
      rawRecordIds = new Map(insertedRaws.map((r) => [r.row_index, r.id]));
    }
  }

  let salesWritten = 0;
  let skippedDuplicates = 0;

  if (parsed.records.length === 0) {
    if (zeroRowFailure) {
      const msg = parsed.errors.join("; ") || "정산행 0건: 파일 형식 분석 실패/파서 미지원입니다.";
      return {
        file: filename,
        platform: parsed.platform_code,
        parsed_rows: 0,
        sales_records_written: 0,
        error: msg,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
      };
    }
    const msg = "정산행 없음: 보조자료/비정산 파일로 보고 건너뛰었습니다.";
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: 0,
      sales_records_written: 0,
      skipped: true,
      skip_reason: msg,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
    };
  }

  const batch = effectiveSettlement;
  if (!batch) {
    return { file: filename, error: "internal: settlement month missing for records" };
  }

  const ctx: TransformContext = {
    settlement_month: batch,
    forceSettlementMonth: true,
    sales_month: parsed.sales_month || null,
    platform_code: parsed.platform_code,
    upload_id: uploadId,
    raw_record_id_by_index: rawRecordIds,
    lookups,
  };
  const transformed = toSalesRecords(parsed.records, ctx);
  const transformWarnings = transformed.errors.length > 0 ? transformed.errors : undefined;
  let inserts = transformed.inserts;

  if (inserts.length > 0) {
    try {
      const existing: Record<string, unknown>[] = [];
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from("sales_records")
          .select(STRICT_KEY_COLUMNS)
          .eq("settlement_batch", batch)
          .range(offset, offset + PAGE - 1)
          .returns<Record<string, unknown>[]>();
        if (error) throw error;
        if (!data || data.length === 0) break;
        existing.push(...data);
        if (data.length < PAGE) break;
      }
      if (existing.length > 0) {
        const suppressed = suppressDuplicatesAtInsert(parsed.platform_code, inserts, existing, {
          exactSourceGateApplied,
        });
        inserts = suppressed.kept;
        skippedDuplicates += suppressed.skipped;
        if (suppressed.skipped > 0) {
          console.warn(
            `[upload]${runLabel} ${filename}: skipped ${suppressed.skipped} duplicate sales rows already in ${batch}`,
          );
        }
      }
    } catch {
      console.warn(`[upload]${runLabel} ${filename}: duplicate check failed, inserting all rows`);
    }
  }

  if (inserts.length === 0 && skippedDuplicates === 0) {
    const msg = transformed.errors.length > 0
      ? `정산 행으로 변환하지 못했습니다: ${transformed.errors.slice(0, 3).map((e) => `${e.field} ${e.message}`).join("; ")}`
      : "정산 행으로 변환할 수 있는 데이터가 없습니다.";
    await markUploadFailed(supabase, uploadId, {
      platform_code: parsed.platform_code,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      detection_confidence: parsed.detection_confidence,
      parsed_rows: parsed.records.length,
      parse_error: msg,
    }, runLabel, filename);
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: parsed.records.length,
      sales_records_written: 0,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      error: msg,
    };
  }

  if (inserts.length > 0) {
    const { error: salesErr, data: salesData } = await supabase
      .from("sales_records")
      .insert(inserts)
      .select("id");
    if (salesErr) {
      const msg = `sales_records insert: ${salesErr.message}`;
      console.error(`[upload]${runLabel} ${filename} platform=${parsed.platform_code}: sales_records insert failed`);
      await markUploadFailed(supabase, uploadId, {
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: msg,
      }, runLabel, filename);
      return { file: filename, platform: parsed.platform_code, error: msg };
    }
    salesWritten = salesData?.length ?? 0;
  }

  if (salesWritten > 0 || skippedDuplicates > 0) {
    await supabase
      .from("raw_uploads")
      .update({ status: "aggregated" })
      .eq("id", uploadId);
  }

  return {
    file: filename,
    platform: parsed.platform_code,
    confidence: parsed.detection_confidence,
    parsed_rows: parsed.records.length,
    sales_records_written: salesWritten,
    sales_records_skipped_duplicates: skippedDuplicates,
    skipped_duplicates: skippedDuplicates,
    settlement_month: effectiveSettlement,
    sales_month: parsed.sales_month || null,
    warnings: transformWarnings,
    errors: parsed.errors,
  };
}

async function markUploadFailed(
  supabase: SupabaseClient,
  uploadId: string,
  fields: Partial<RawUploadInsert>,
  runLabel: string,
  filename: string,
) {
  const { error } = await supabase
    .from("raw_uploads")
    .update({ ...fields, status: "failed", parsed_at: new Date().toISOString() })
    .eq("id", uploadId);
  if (error) {
    console.error(`[upload]${runLabel} ${filename}: raw_uploads failed-status update error`);
  }
}

function buildRunLabel(request: Request, form: FormData): string {
  const rawRunId =
    request.headers.get("x-settlement-upload-run-id") ||
    (typeof form.get("uploadRunId") === "string" ? (form.get("uploadRunId") as string) : "");
  const uploadRunId = rawRunId.replace(/[^\w.-]/g, "").slice(0, 64) || null;
  return uploadRunId ? ` run=${uploadRunId}` : "";
}
