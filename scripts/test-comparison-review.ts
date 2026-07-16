/**
 * Assertions for the diff-review PATCH validation.
 * Run: node --import tsx scripts/test-comparison-review.ts
 */
import assert from "node:assert/strict";

import {
  REVIEW_NOTE_MAX_LENGTH,
  validateDiffReviewPatch,
} from "../src/features/settlement/lib/comparison/review";

// Every allowed status validates.
for (const status of ["pending", "candidate_correct", "golden_correct", "needs_review", "resolved"]) {
  const r = validateDiffReviewPatch({ review_status: status });
  assert.deepEqual(r, { ok: true, patch: { review_status: status } });
}

// Unknown status, wrong types, and non-object bodies are rejected.
for (const body of [
  { review_status: "approved" },
  { review_status: 1 },
  { review_status: null },
  null,
  "resolved",
  ["resolved"],
  {},
]) {
  const r = validateDiffReviewPatch(body);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(body)}`);
}

// Note-only patch is allowed; both `note` and `review_note` spellings work.
assert.deepEqual(validateDiffReviewPatch({ note: "확인 필요" }), {
  ok: true,
  patch: { review_note: "확인 필요" },
});
assert.deepEqual(validateDiffReviewPatch({ review_note: null }), {
  ok: true,
  patch: { review_note: null },
});

// Combined patch keeps both fields.
assert.deepEqual(
  validateDiffReviewPatch({ review_status: "golden_correct", note: "정답지가 맞음" }),
  { ok: true, patch: { review_status: "golden_correct", review_note: "정답지가 맞음" } },
);

// Oversized or non-string notes are rejected.
assert.equal(validateDiffReviewPatch({ note: "a".repeat(REVIEW_NOTE_MAX_LENGTH + 1) }).ok, false);
assert.equal(validateDiffReviewPatch({ note: 42 }).ok, false);

console.log("comparison-review: all assertions passed");
