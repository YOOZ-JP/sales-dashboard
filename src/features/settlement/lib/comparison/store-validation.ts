import { DIFF_REVIEW_STATUSES } from "./review";
import type {
  ComparisonDiffCategory,
  ComparisonDiffReviewStatus,
  SettlementComparisonRunStatus,
} from "../supabase/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_PATTERN = /^\d{4}-\d{2}-01$/;
const RUN_STATUSES: readonly SettlementComparisonRunStatus[] = [
  "processing",
  "completed",
  "failed",
];
const DIFF_CATEGORIES: readonly ComparisonDiffCategory[] = ["missing", "extra", "field", "formula"];
const MAX_RUN_LIMIT = 50;
const MAX_DIFF_LIMIT = 200;

export function validateComparisonUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("invalid UUID");
  }
  return value;
}

export function validateComparisonMonth(value: string): string {
  if (!MONTH_PATTERN.test(value)) {
    throw new Error("invalid comparison month");
  }
  return value;
}

export function validateComparisonRunStatus(value: string): SettlementComparisonRunStatus {
  if (!RUN_STATUSES.includes(value as SettlementComparisonRunStatus)) {
    throw new Error(`status must be one of: ${RUN_STATUSES.join(", ")}`);
  }
  return value as SettlementComparisonRunStatus;
}

export function validateComparisonDiffCategory(
  value: string,
): ComparisonDiffCategory {
  if (!DIFF_CATEGORIES.includes(value as ComparisonDiffCategory)) {
    throw new Error(`category must be one of: ${DIFF_CATEGORIES.join(", ")}`);
  }
  return value as ComparisonDiffCategory;
}

export function validateComparisonReviewStatus(
  value: string,
): ComparisonDiffReviewStatus {
  if (!DIFF_REVIEW_STATUSES.includes(value as ComparisonDiffReviewStatus)) {
    throw new Error(`review_status must be one of: ${DIFF_REVIEW_STATUSES.join(", ")}`);
  }
  return value as ComparisonDiffReviewStatus;
}

export function clampComparisonRunLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_RUN_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_RUN_LIMIT);
}

export function clampComparisonDiffLimit(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(Math.max(1, Math.floor(value)), MAX_DIFF_LIMIT);
}

export function normalizeComparisonOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
