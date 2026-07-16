/**
 * GET /api/settlement/comparisons/[id]
 *   One comparison run plus a bounded, filterable page of its diffs.
 *   Query: category=missing|extra|field|formula, review_status=<enum>,
 *          offset (default 0), limit (default 100, max 200).
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { DIFF_REVIEW_STATUSES } from "@/features/settlement/lib/comparison/review";
import {
  getComparisonRun,
  listComparisonDiffs,
} from "@/features/settlement/lib/comparison/store";
import type {
  ComparisonDiffCategory,
  ComparisonDiffReviewStatus,
} from "@/features/settlement/lib/supabase/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ["missing", "extra", "field", "formula"] as const;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  if (category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return NextResponse.json(
      { error: `category must be one of: ${CATEGORIES.join(", ")}` },
      { status: 400 },
    );
  }
  const categoryFilter = category as ComparisonDiffCategory | null;
  const reviewStatus = url.searchParams.get("review_status");
  if (
    reviewStatus &&
    !DIFF_REVIEW_STATUSES.includes(reviewStatus as (typeof DIFF_REVIEW_STATUSES)[number])
  ) {
    return NextResponse.json(
      { error: `review_status must be one of: ${DIFF_REVIEW_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  const reviewStatusFilter = reviewStatus as ComparisonDiffReviewStatus | null;
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const rawLimit = Number(url.searchParams.get("limit")) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

  let run;
  try {
    run = await getComparisonRun(id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: "comparison run not found" }, { status: 404 });
  }

  let diffPage;
  try {
    diffPage = await listComparisonDiffs({
      runId: id,
      category: categoryFilter,
      reviewStatus: reviewStatusFilter,
      offset,
      limit,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    run,
    diffs: diffPage.diffs,
    pagination: { offset: diffPage.offset, limit: diffPage.limit, total: diffPage.total },
  });
}
