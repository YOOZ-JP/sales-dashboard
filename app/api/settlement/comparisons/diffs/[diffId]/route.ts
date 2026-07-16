/**
 * PATCH /api/settlement/comparisons/diffs/[diffId]
 *   Operator review verdict for one diff: body { review_status?, note? }.
 *   review_status ∈ pending|candidate_correct|golden_correct|needs_review|resolved.
 *   Setting a status stamps reviewed_at.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { validateDiffReviewPatch } from "@/features/settlement/lib/comparison/review";
import { patchComparisonDiffReview } from "@/features/settlement/lib/comparison/store";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ diffId: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { diffId } = await params;
  if (!UUID_PATTERN.test(diffId)) {
    return NextResponse.json({ error: "invalid diff id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const validation = validateDiffReviewPatch(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  let data;
  try {
    data = await patchComparisonDiffReview(diffId, {
      ...validation.patch,
      reviewed_by: validation.patch.review_status !== undefined ? "settlement-dashboard" : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "diff not found" }, { status: 404 });
  }
  return NextResponse.json({ diff: data });
}
