/**
 * GET /api/settlement/comparisons/[id]/artifacts/[kind]
 *   Authenticated short signed-url redirect for private comparison artifacts.
 *   kind = answer | candidate. Storage paths never leave the server.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { getComparisonArtifactPaths } from "@/features/settlement/lib/comparison/store";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["answer", "candidate"] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { id, kind } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    return NextResponse.json({ error: "kind must be answer or candidate" }, { status: 400 });
  }

  const { supabaseServer: supabase } = await import("@/lib/supabase-server");
  const { getSignedArchiveUrl } = await import("@/features/settlement/lib/storage/archive");
  let run;
  try {
    run = await getComparisonArtifactPaths(id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: "comparison run not found" }, { status: 404 });
  }

  const path = kind === "answer" ? run.answer_storage_path : run.candidate_storage_path;
  if (!path) {
    return NextResponse.json({ error: "artifact not available" }, { status: 404 });
  }
  const signedUrl = await getSignedArchiveUrl(path, 300, supabase);
  if (!signedUrl) {
    return NextResponse.json({ error: "artifact not available" }, { status: 404 });
  }
  return NextResponse.redirect(signedUrl, { status: 302 });
}
