/**
 * POST /api/settlement/upload
 *
 * Accepts multipart form with one or more raw settlement files. Per file:
 *   1. Write to the on-disk archive (archive/YYYY-MM/<ts>_<name>)
 *   2. Detect platform + parse (server-side)
 *   3. Insert raw_uploads (metadata) + raw_records (line-items)
 *   4. Build sales_records rows via the shared transformer
 *
 * Requires the same dashboard refresh-token cookie as protected pages.
 * The DB is touched via the Supabase service-role client, so this route
 * must never be exposed as an unauthenticated public endpoint.
 */
import { NextResponse } from "next/server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import type { Json } from "@/features/settlement/lib/supabase/types";
import {
  type TransformContext,
  type LookupMaps,
} from "@/features/settlement/lib/aggregation/to-sales-records";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const [supabaseServer, parsers, aggregation, archive] = await Promise.all([
    import("@/features/settlement/lib/supabase/server"),
    import("@/features/settlement/lib/parsers"),
    import("@/features/settlement/lib/aggregation/to-sales-records"),
    import("@/features/settlement/lib/storage/archive"),
  ]);
  const { createServiceClient, hasServiceRoleKey } = supabaseServer;
  const { parseFile } = parsers;
  const { toSalesRecords, buildLookupMaps } = aggregation;
  const { writeToArchive } = archive;

  if (!hasServiceRoleKey()) {
    return NextResponse.json(
      { error: "Supabase is not configured" },
      { status: 503 },
    );
  }

  const supabase = createServiceClient();

  const form = await request.formData();
  const files = form.getAll("files") as File[];
  const folderHint = (form.get("folder") as string) || undefined;
  const activeMonthRaw = (form.get("activeMonth") as string) || "";
  const activeMonth = /^\d{4}-\d{2}-01$/.test(activeMonthRaw) ? activeMonthRaw : null;
  // Test-scenario flag: when the UI passes replaceMonth=1 we wipe the
  // active month's sales_records before inserting, so the operator can
  // re-run a test upload without stacking duplicates on top of the
  // existing rows. raw_uploads / raw_records are kept for audit.
  const replaceMonth = form.get("replaceMonth") === "1";
  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }

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
    const [{ data: clients }, { data: channels }] = await Promise.all([
      supabase.from("clients").select("*"),
      supabase.from("channels").select("*"),
    ]);
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

    // 1. Parse first so we know which month bucket to archive under.
    let parsed: Awaited<ReturnType<typeof parseFile>>;
    try {
      parsed = await parseFile({
        filename: f.name,
        buffer,
        folderName: folderHint,
      });
    } catch (e) {
      results.push({ file: f.name, error: `parse failed: ${(e as Error).message}` });
      continue;
    }

    // Settlement-month resolution:
    //   · When the operator explicitly picked a month in the UI, trust
    //     it — this is the "I'm processing May now" intent.
    //   · Otherwise fall back to whatever the parser could derive.
    //
    // The parser's value is still kept on raw_uploads.sales_month so
    // it's visible when auditing which period the file actually covers.
    const effectiveSettlement = activeMonth ?? parsed.settlement_month ?? null;

    // 2. Archive the raw file into Supabase Storage (upload-debug bucket).
    let archivePath: string | null = null;
    try {
      const archived = await writeToArchive(f.name, buffer, effectiveSettlement, supabase);
      archivePath = archived.path;
    } catch (e) {
      console.warn("[upload] archive write failed:", (e as Error).message);
    }

    // 3. Insert raw_uploads
    const { data: uploadRow, error: insertErr } = await supabase
      .from("raw_uploads")
      .insert({
        filename: f.name,
        storage_path: archivePath ?? `(not archived) ${f.name}`,
        size_bytes: buffer.byteLength,
        content_type: f.type,
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        status: parsed.records.length > 0 ? "parsed" : "failed",
        detection_confidence: parsed.detection_confidence,
        parse_error: parsed.errors.join("; ") || null,
        parsed_rows: parsed.records.length,
        parsed_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertErr || !uploadRow) {
      results.push({ file: f.name, error: insertErr?.message ?? "upload insert failed" });
      continue;
    }

    // 4. Insert raw_records (JSONB line-items)
    let rawRecordIds: Map<number, string> | undefined;
    if (parsed.records.length > 0) {
      const { data: insertedRaws } = await supabase
        .from("raw_records")
        .insert(
          parsed.records.map((r) => ({
            upload_id: uploadRow.id,
            row_index: r.row_index,
            data: r.data as unknown as Json,
          })),
        )
        .select("id, row_index");
      if (insertedRaws) {
        rawRecordIds = new Map(insertedRaws.map((r) => [r.row_index, r.id]));
      }
    }

    // 5. Transform → sales_records
    let salesWritten = 0;
    if (parsed.records.length > 0) {
      const batch = activeMonth ?? effectiveSettlement ?? new Date().toISOString().slice(0, 7) + "-01";
      const ctx: TransformContext = {
        settlement_month: batch,
        platform_code: parsed.platform_code,
        upload_id: uploadRow.id,
        raw_record_id_by_index: rawRecordIds,
        lookups,
      };
      const transformed = toSalesRecords(parsed.records, ctx);
      if (transformed.inserts.length > 0) {
        const { error: salesErr, data: salesData } = await supabase
          .from("sales_records")
          .insert(transformed.inserts)
          .select("id");
        if (salesErr) {
          results.push({
            file: f.name,
            platform: parsed.platform_code,
            error: `sales_records insert: ${salesErr.message}`,
          });
          continue;
        }
        salesWritten = salesData?.length ?? 0;
      }

      if (salesWritten > 0) {
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
      archive_path: archivePath,
      errors: parsed.errors,
    });
  }

  return NextResponse.json({ results });
}
