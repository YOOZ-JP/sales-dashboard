/**
 * POST /api/settlement/upload
 *
 * Accepts multipart form with one or more raw settlement files. Per file:
 *   1. Insert a raw_uploads row in status 'parsing' — done before any parsing
 *      so a function timeout (504) still leaves durable evidence of which
 *      file was in flight
 *   2. Detect platform + parse (server-side)
 *   3. Write to the archive (archive/YYYY-MM/<ts>_<name>) and update the
 *      raw_uploads row with the parse outcome
 *   4. Insert raw_records (line-items)
 *   5. Build sales_records rows via the shared transformer
 *
 * Requires the same dashboard refresh-token cookie as protected pages.
 * The DB is touched only after the dashboard cookie guard passes, using the
 * same server Supabase client as the rest of the dashboard.
 */
import { NextResponse } from "next/server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { resolveSettlementMonth } from "@/features/settlement/lib/resolve-settlement-month";
import type { Json, RawUploadInsert } from "@/features/settlement/lib/supabase/types";
import {
  type TransformContext,
  type LookupMaps,
} from "@/features/settlement/lib/aggregation/to-sales-records";
import {
  STRICT_KEY_COLUMNS,
  suppressExistingDuplicates,
} from "@/features/settlement/lib/aggregation/strict-record-key";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

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
  const folderHint = (form.get("folder") as string) || undefined;
  const activeMonthRaw = (form.get("activeMonth") as string) || "";
  const activeMonth = /^\d{4}-\d{2}-01$/.test(activeMonthRaw) ? activeMonthRaw : null;
  // Batch-level month hint the client derived from the selected upload's
  // folder/file names (only sent when every hint agrees on one month).
  // Consulted only when a file's content yields no settlement month.
  const fallbackMonthRaw = (form.get("fallbackMonth") as string) || "";
  const fallbackMonth = /^\d{4}-\d{2}-01$/.test(fallbackMonthRaw) ? fallbackMonthRaw : null;
  // Test-scenario flag: when the UI passes replaceMonth=1 we wipe the
  // active month's sales_records before inserting, so the operator can
  // re-run a test upload without stacking duplicates on top of the
  // existing rows. raw_uploads / raw_records are kept for audit.
  const replaceMonth = form.get("replaceMonth") === "1";
  // Client-generated correlation id (see SettlementClient). raw_uploads has no
  // column for it, so it only goes to the function logs; sanitized because it
  // is caller-supplied and printed there.
  const rawRunId =
    request.headers.get("x-settlement-upload-run-id") ||
    (typeof form.get("uploadRunId") === "string" ? (form.get("uploadRunId") as string) : "");
  const uploadRunId = rawRunId.replace(/[^\w.-]/g, "").slice(0, 64) || null;
  const runLabel = uploadRunId ? ` run=${uploadRunId}` : "";
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

  // Preload client/channel lookup maps
  let lookups: LookupMaps;
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
    lookups = buildLookupMaps({ clients: clients ?? [], channels: channels ?? [] });
  } catch (e) {
    return NextResponse.json(
      { error: `failed to load lookups: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const f of files) {
    const buffer = Buffer.from(await f.arrayBuffer());

    // 1. Create the raw_uploads row before parsing. If the function times out
    //    or crashes mid-parse (504 → no JSON response reaches the browser),
    //    this row stays in status 'parsing' — durable evidence of which file
    //    it died on. All later steps update this same row; nothing re-inserts.
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

    // Leaves the pre-created row in a terminal state on the failure paths
    // below. An update error here is only logged — the file result already
    // carries the original failure.
    const markUploadFailed = async (fields: Partial<RawUploadInsert>) => {
      const { error } = await supabase
        .from("raw_uploads")
        .update({ ...fields, status: "failed", parsed_at: new Date().toISOString() })
        .eq("id", uploadRow.id);
      if (error) {
        console.error(`[upload]${runLabel} ${f.name}: raw_uploads failed-status update error`);
      }
    };

    // 2. Parse so we know which month bucket to archive under.
    let parsed: Awaited<ReturnType<typeof parseFile>>;
    try {
      parsed = await parseFile({
        filename: f.name,
        buffer,
        folderName: folderHint,
      });
    } catch (e) {
      const msg = `parse failed: ${(e as Error).message}`;
      console.error(`[upload]${runLabel} ${f.name}: ${msg}`);
      await markUploadFailed({ parse_error: msg });
      results.push({ file: f.name, error: msg });
      continue;
    }

    // Settlement-month resolution:
    //   · When the operator explicitly picked a month in the UI (manual
    //     mode), trust it — this is the "I'm processing May now" intent.
    //   · Otherwise (auto mode) the month parsed from the file content
    //     counts; a file without one inherits the batch's unambiguous
    //     folder/file-name month (fallbackMonth) when the client sent one.
    //     A file with records but no resolvable month is rejected here,
    //     before any DB write — never bucketed into the current date.
    const resolution = resolveSettlementMonth({
      activeMonth,
      parsedSettlementMonth: parsed.settlement_month,
      hasRecords: parsed.records.length > 0,
      fallbackMonth,
    });
    if (!resolution.ok) {
      console.warn(`[upload]${runLabel} ${f.name} platform=${parsed.platform_code}: ${resolution.error}`);
      await markUploadFailed({
        platform_code: parsed.platform_code,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: resolution.error,
      });
      results.push({
        file: f.name,
        platform: parsed.platform_code,
        parsed_rows: parsed.records.length,
        sales_month: parsed.sales_month || null,
        error: resolution.error,
      });
      continue;
    }
    const effectiveSettlement = resolution.month;
    // Inherited-month case: surface it as an informational note (never a
    // failure). Pushed onto parsed.errors so it reaches both the response
    // row and the raw_uploads.parse_error audit trail below.
    if (resolution.note) {
      console.log(`[upload]${runLabel} ${f.name}: settlement month inherited from batch hint ${effectiveSettlement}`);
      parsed.errors.push(resolution.note);
    }
    const zeroRowFailure = isZeroRowParseFailure(parsed.platform_code, parsed.records.length, parsed.errors);

    // 3. Archive the raw file into Supabase Storage (upload-debug bucket).
    let archivePath: string | null = null;
    let archiveError: string | null = null;
    try {
      const archived = await writeToArchive(f.name, buffer, effectiveSettlement, supabase);
      archivePath = archived.path;
    } catch (e) {
      archiveError = (e as Error).message || "archive write failed";
      console.warn(`[upload]${runLabel} ${f.name}: archive write failed: ${archiveError}`);
    }

    // 4. Update the pre-created raw_uploads row with the parse outcome.
    const { error: updateErr } = await supabase
      .from("raw_uploads")
      .update({
        storage_path: archivePath ?? `(not archived) ${f.name}`,
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        // Files with no settlement rows are not necessarily failures: monthly
        // folders often include payment notices, detail PDFs, or companion
        // workbooks that are useful for audit but do not create INPUT rows.
        // But if the platform is unknown/no-parser or a tabular parser reports
        // "no data rows", keep it in the red bucket so real sales files do not
        // get hidden as harmless skips.
        status: zeroRowFailure ? "failed" : "parsed",
        detection_confidence: parsed.detection_confidence,
        parse_error: [...parsed.errors, archiveError ? `archive: ${archiveError}` : null]
          .filter(Boolean)
          .join("; ") || null,
        parsed_rows: parsed.records.length,
        parsed_at: new Date().toISOString(),
      })
      .eq("id", uploadRow.id);

    if (updateErr) {
      console.error(`[upload]${runLabel} ${f.name}: raw_uploads update failed`);
      results.push({ file: f.name, error: updateErr.message });
      continue;
    }

    // 5. Insert raw_records (JSONB line-items)
    let rawRecordIds: Map<number, string> | undefined;
    if (parsed.records.length > 0) {
      const { data: insertedRaws, error: rawsErr } = await supabase
        .from("raw_records")
        .insert(
          parsed.records.map((r) => ({
            upload_id: uploadRow.id,
            row_index: r.row_index,
            data: r.data as unknown as Json,
          })),
        )
        .select("id, row_index");
      if (rawsErr) {
        const msg = `raw_records insert: ${rawsErr.message}`;
        console.error(`[upload]${runLabel} ${f.name} platform=${parsed.platform_code}: raw_records insert failed`);
        await markUploadFailed({
          platform_code: parsed.platform_code,
          settlement_month: effectiveSettlement,
          sales_month: parsed.sales_month || null,
          detection_confidence: parsed.detection_confidence,
          parsed_rows: parsed.records.length,
          parse_error: msg,
        });
        results.push({ file: f.name, error: `raw_records insert: ${rawsErr.message}` });
        continue;
      }
      if (insertedRaws) {
        rawRecordIds = new Map(insertedRaws.map((r) => [r.row_index, r.id]));
      }
    }

    // 6. Transform → sales_records
    let salesWritten = 0;
    let skippedDuplicates = 0;
    let transformWarnings: unknown[] | undefined;
    if (parsed.records.length === 0) {
      if (zeroRowFailure) {
        const msg = parsed.errors.join("; ") || "정산행 0건: 파일 형식 분석 실패/파서 미지원입니다.";
        results.push({
          file: f.name,
          platform: parsed.platform_code,
          parsed_rows: 0,
          sales_records_written: 0,
          error: msg,
          settlement_month: effectiveSettlement,
          sales_month: parsed.sales_month || null,
        });
        continue;
      }
      const msg = "정산행 없음: 보조자료/비정산 파일로 보고 건너뛰었습니다.";
      results.push({
        file: f.name,
        platform: parsed.platform_code,
        parsed_rows: 0,
        sales_records_written: 0,
        skipped: true,
        skip_reason: msg,
        archive_error: archiveError,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        });
      continue;
    }
    if (parsed.records.length > 0) {
      // resolveSettlementMonth guarantees a month whenever records exist;
      // this guard only keeps TypeScript honest and catches regressions.
      const batch = effectiveSettlement;
      if (!batch) {
        results.push({ file: f.name, error: "internal: settlement month missing for records" });
        continue;
      }
      const ctx: TransformContext = {
        settlement_month: batch,
        forceSettlementMonth: true,
        sales_month: parsed.sales_month || null,
        platform_code: parsed.platform_code,
        upload_id: uploadRow.id,
        raw_record_id_by_index: rawRecordIds,
        lookups,
      };
      const transformed = toSalesRecords(parsed.records, ctx);
      transformWarnings = transformed.errors.length > 0 ? transformed.errors : undefined;
      let inserts = transformed.inserts;
      if (parsed.platform_code === "piccoma" && inserts.length > 0) {
        const piccomaChannelIds = [...new Set(inserts.map((r) => r.channel_id).filter(Boolean))];
        if (piccomaChannelIds.length > 0) {
          const { count, error } = await supabase
            .from("sales_records")
            .select("id", { count: "exact", head: true })
            .eq("settlement_batch", batch)
            .in("channel_id", piccomaChannelIds);
          if (!error && (count ?? 0) > 0) {
            skippedDuplicates += inserts.length;
            inserts = [];
            transformWarnings = [
              ...(transformWarnings ?? []),
              {
                row_index: -1,
                platform_code: parsed.platform_code,
                field: "piccoma",
                message: "same settlement batch already has Piccoma rows; skipped to prevent double counting",
              },
            ];
          }
        }
      }
      if (inserts.length > 0) {
        // Skip rows whose strict logical key already exists in this batch —
        // re-uploads and CSV+XLSX twins of the same statement. Legitimate
        // variants (same title, different type/month/amount) key differently
        // and are kept.
        try {
          const existing: Record<string, unknown>[] = [];
          const PAGE = 1000;
          for (let offset = 0; ; offset += PAGE) {
            const { data, error } = await supabase
              .from("sales_records")
              .select(STRICT_KEY_COLUMNS)
              .eq("settlement_batch", batch)
              .range(offset, offset + PAGE - 1)
              // STRICT_KEY_COLUMNS is a runtime string, so supabase-js cannot
              // derive the row shape at the type level.
              .returns<Record<string, unknown>[]>();
            if (error) throw error;
            if (!data || data.length === 0) break;
            existing.push(...data);
            if (data.length < PAGE) break;
          }
          if (existing.length > 0) {
            const suppressed = suppressExistingDuplicates(inserts, existing);
            inserts = suppressed.kept;
            skippedDuplicates = suppressed.skipped;
            if (skippedDuplicates > 0) {
              console.warn(
                `[upload]${runLabel} ${f.name}: skipped ${skippedDuplicates} duplicate sales rows already in ${batch}`,
              );
            }
          }
        } catch {
          console.warn(`[upload]${runLabel} ${f.name}: duplicate check failed, inserting all rows`);
        }
      }
      if (inserts.length === 0 && skippedDuplicates === 0) {
        const msg = transformed.errors.length > 0
          ? `정산 행으로 변환하지 못했습니다: ${transformed.errors.slice(0, 3).map((e) => `${e.field} ${e.message}`).join('; ')}`
          : "정산 행으로 변환할 수 있는 데이터가 없습니다.";
        await markUploadFailed({
          platform_code: parsed.platform_code,
          settlement_month: effectiveSettlement,
          sales_month: parsed.sales_month || null,
          detection_confidence: parsed.detection_confidence,
          parsed_rows: parsed.records.length,
          parse_error: msg,
        });
        results.push({
          file: f.name,
          platform: parsed.platform_code,
          parsed_rows: parsed.records.length,
          sales_records_written: 0,
          settlement_month: effectiveSettlement,
          sales_month: parsed.sales_month || null,
          error: msg,
        });
        continue;
      }
      if (inserts.length > 0) {
        const { error: salesErr, data: salesData } = await supabase
          .from("sales_records")
          .insert(inserts)
          .select("id");
        if (salesErr) {
          const msg = `sales_records insert: ${salesErr.message}`;
          console.error(`[upload]${runLabel} ${f.name} platform=${parsed.platform_code}: sales_records insert failed`);
          await markUploadFailed({
            platform_code: parsed.platform_code,
            settlement_month: effectiveSettlement,
            sales_month: parsed.sales_month || null,
            detection_confidence: parsed.detection_confidence,
            parsed_rows: parsed.records.length,
            parse_error: msg,
          });
          results.push({
            file: f.name,
            platform: parsed.platform_code,
            error: `sales_records insert: ${salesErr.message}`,
          });
          continue;
        }
        salesWritten = salesData?.length ?? 0;
      }

      if (salesWritten > 0 || skippedDuplicates > 0) {
        await supabase
          .from("raw_uploads")
          .update({ status: "aggregated" })
          .eq("id", uploadRow.id);
      }
    }

    results.push({
      file: f.name,
      platform: parsed.platform_code,
      confidence: parsed.detection_confidence,
      parsed_rows: parsed.records.length,
      sales_records_written: salesWritten,
      sales_records_skipped_duplicates: skippedDuplicates,
      skipped_duplicates: skippedDuplicates,
      archive_error: archiveError,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      archive_path: archivePath,
      warnings: transformWarnings,
      errors: parsed.errors,
    });
  }

  return NextResponse.json({ results });
}

function isZeroRowParseFailure(platformCode: string, parsedRows: number, errors: string[]): boolean {
  if (parsedRows > 0) return false;
  const joined = errors.join("; ").toLowerCase();
  if (platformCode === "unknown") return true;
  return (
    joined.includes("no parser for platform") ||
    joined.includes("no data rows parsed") ||
    joined.includes("unsupported")
  );
}
