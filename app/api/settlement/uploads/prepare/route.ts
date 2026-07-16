import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { supabaseServer as supabase } from "@/lib/supabase-server";
import {
  buildDirectUploadPath,
  DIRECT_UPLOAD_BUCKET,
  validateCleanupUploadPayload,
  validatePrepareUploadPayload,
} from "@/features/settlement/lib/storage/direct-upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validatePrepareUploadPayload(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { filename, size_bytes, content_type, active_month } = validation.value;
  const { path } = buildDirectUploadPath(filename, active_month);

  const { data: row, error: insertError } = await supabase
    .from("raw_uploads")
    .insert({
      filename,
      storage_path: path,
      size_bytes,
      content_type,
      settlement_month: active_month,
      status: "uploaded",
    })
    .select("id")
    .single();

  if (insertError || !row) {
    return NextResponse.json(
      { error: insertError?.message ?? "raw_uploads insert failed" },
      { status: 500 },
    );
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from(DIRECT_UPLOAD_BUCKET)
    .createSignedUploadUrl(path);

  if (signedError || !signed) {
    await supabase
      .from("raw_uploads")
      .update({
        status: "failed",
        parse_error: signedError?.message ?? "signed upload URL creation failed",
        parsed_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return NextResponse.json(
      { error: "signed upload URL creation failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    upload_id: row.id,
    path,
    token: signed.token,
  });
}

export async function DELETE(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validateCleanupUploadPayload(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("raw_uploads")
    .update({
      status: "failed",
      parse_error: "direct storage upload failed before parse".slice(0, 500),
      parsed_at: new Date().toISOString(),
    })
    .eq("id", validation.uploadId)
    .eq("status", "uploaded")
    .is("sha256", null)
    .is("archived_at", null)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ cleaned: (data ?? []).length === 1 });
}
