/**
 * Pure validation assertions for the settlement comparison Postgres store.
 * Run: node --import tsx scripts/test-comparison-store-validation.ts
 */
import assert from "node:assert/strict";

import {
  clampComparisonDiffLimit,
  clampComparisonRunLimit,
  normalizeComparisonOffset,
  validateComparisonDiffCategory,
  validateComparisonMonth,
  validateComparisonReviewStatus,
  validateComparisonRunStatus,
  validateComparisonUuid,
} from "../src/features/settlement/lib/comparison/store-validation";
import { buildSourceUploadManifest } from "../src/features/settlement/lib/comparison/source-manifest";

assert.equal(validateComparisonUuid("123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
assert.throws(() => validateComparisonUuid("not-a-uuid"), /invalid UUID/);

assert.equal(validateComparisonMonth("2026-05-01"), "2026-05-01");
assert.throws(() => validateComparisonMonth("202605"), /invalid comparison month/);
assert.throws(() => validateComparisonMonth("2026-5-01"), /invalid comparison month/);

assert.equal(validateComparisonRunStatus("processing"), "processing");
assert.equal(validateComparisonRunStatus("completed"), "completed");
assert.equal(validateComparisonRunStatus("failed"), "failed");
assert.throws(() => validateComparisonRunStatus("done"), /status must be one of/);

assert.equal(validateComparisonDiffCategory("missing"), "missing");
assert.equal(validateComparisonDiffCategory("extra"), "extra");
assert.equal(validateComparisonDiffCategory("field"), "field");
assert.equal(validateComparisonDiffCategory("formula"), "formula");
assert.throws(() => validateComparisonDiffCategory("other"), /category must be one of/);

assert.equal(validateComparisonReviewStatus("pending"), "pending");
assert.equal(validateComparisonReviewStatus("candidate_correct"), "candidate_correct");
assert.equal(validateComparisonReviewStatus("golden_correct"), "golden_correct");
assert.equal(validateComparisonReviewStatus("needs_review"), "needs_review");
assert.equal(validateComparisonReviewStatus("resolved"), "resolved");
assert.throws(() => validateComparisonReviewStatus("approved"), /review_status must be one of/);

assert.equal(clampComparisonRunLimit(100), 50);
assert.equal(clampComparisonRunLimit(0), 1);
assert.equal(clampComparisonDiffLimit(500), 200);
assert.equal(clampComparisonDiffLimit(0), 1);
assert.equal(normalizeComparisonOffset(-10), 0);
assert.equal(normalizeComparisonOffset(12.9), 12);

{
  const uploads = Array.from({ length: 501 }, (_, index) => ({
    id: `123e4567-e89b-42d3-a456-42661417${String(index).padStart(4, "0")}`,
    filename: `source-${index}.xlsx`,
    platform_code: "cmoa",
    status: "aggregated",
    parsed_rows: index,
    sha256: null,
  }));
  const manifest = buildSourceUploadManifest(uploads);
  assert.equal(manifest.sourceUploadIds.length, 500);
  assert.equal(manifest.sourceUploadIds[499], uploads[499].id);
  const sourceManifest = manifest.sourceManifest as {
    uploads: Array<Record<string, unknown>>;
    uploads_truncated: boolean;
    observed_count_at_least: number;
  };
  assert.equal(sourceManifest.uploads.length, 500);
  assert.equal(sourceManifest.uploads_truncated, true);
  assert.equal(sourceManifest.observed_count_at_least, 501);
  assert.equal("storage_path" in sourceManifest.uploads[0], false);
}

console.log("comparison-store-validation: all assertions passed");
