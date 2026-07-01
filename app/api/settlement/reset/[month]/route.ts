/**
 * POST /api/settlement/reset/[month]
 *
 * Wipes every trace of the given month-batch so the upload pipeline
 * can be re-run from scratch. Touches:
 *   · sales_records (where settlement_batch = month)
 *   · raw_records / raw_uploads for uploads that landed in this month
 *     (raw_records cascades through raw_uploads.id)
 *   · Supabase Storage objects under upload-debug/uploads/YYYY-MM/
 *
 * Safeguards:
 *   · Requires POST body {"confirm": true} so a misfired link can't
 *     nuke a month.
 *   · month must be YYYYMM.
 */
import { NextResponse } from "next/server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { createServiceClient, hasServiceRoleKey } from "@/features/settlement/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ month: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  if (!hasServiceRoleKey()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const { month } = await params;
  if (!/^\d{6}$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYYMM" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as { confirm?: boolean };
  if (body.confirm !== true) {
    return NextResponse.json({ error: "confirm=true required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const batchIso = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  const ymPrefix = `${month.slice(0, 4)}-${month.slice(4, 6)}`;

  const result: Record<string, number | string> = {};

  // 1. sales_records
  {
    const { error, count } = await supabase
      .from("sales_records")
      .delete({ count: "exact" })
      .eq("settlement_batch", batchIso);
    if (error) return NextResponse.json({ error: `sales_records: ${error.message}` }, { status: 500 });
    result.sales_records_deleted = count ?? 0;
  }

  // 2. raw_uploads (cascades into raw_records). Match by settlement_month
  // falling into this month, OR by storage_path in this month's prefix
  // (catches historical uploads that saved under the prefix even if the
  // parser couldn't derive a settlement_month).
  {
    const { data: uploads } = await supabase
      .from("raw_uploads")
      .select("id, storage_path, settlement_month")
      .or(
        `settlement_month.gte.${batchIso},` +
          `storage_path.ilike.uploads/${ymPrefix}%`,
      );
    const matching = ((uploads ?? []) as Array<{
      id: string;
      storage_path: string | null;
      settlement_month: string | null;
    }>).filter(
      (u) =>
        (u.storage_path && u.storage_path.startsWith(`uploads/${ymPrefix}`)) ||
        (typeof u.settlement_month === "string" &&
          u.settlement_month.startsWith(ymPrefix)),
    );
    const ids = matching.map((u) => u.id);

    if (ids.length > 0) {
      await supabase.from("raw_records").delete().in("upload_id", ids);
      const { error, count } = await supabase
        .from("raw_uploads")
        .delete({ count: "exact" })
        .in("id", ids);
      if (error) return NextResponse.json({ error: `raw_uploads: ${error.message}` }, { status: 500 });
      result.raw_uploads_deleted = count ?? 0;
    } else {
      result.raw_uploads_deleted = 0;
    }
  }

  // 3. Storage: list + bulk remove. The folder holds at most a few
  // hundred files per month so a single list() call is enough.
  {
    const prefix = `uploads/${ymPrefix}`;
    const { data: files, error } = await supabase.storage
      .from("upload-debug")
      .list(prefix, { limit: 1000 });
    if (error) {
      result.storage_list_error = error.message;
    } else if (files && files.length > 0) {
      const paths = files.map((f) => `${prefix}/${f.name}`);
      const { error: rmErr, data: removed } = await supabase.storage
        .from("upload-debug")
        .remove(paths);
      if (rmErr) result.storage_remove_error = rmErr.message;
      result.storage_objects_removed = removed?.length ?? 0;
    } else {
      result.storage_objects_removed = 0;
    }
  }

  return NextResponse.json({ ok: true, month, batch: batchIso, ...result });
}
