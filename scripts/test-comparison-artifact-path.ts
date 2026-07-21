/**
 * Pure assertions for comparison artifact storage keys.
 *
 * Regression: production POST /api/settlement/comparisons failed with
 * "Invalid key: comparisons/answer-keys/2026-06/<ts>_<unicode name>" because
 * the key embedded the original filename (Korean/Japanese/fullwidth parens).
 * Keys must be UUID-based ASCII-only; the original filename lives on the run
 * row instead. Assertions use filenames only — no workbook contents.
 * Run: node --import tsx scripts/test-comparison-artifact-path.ts
 */
import assert from "node:assert/strict";

import { buildComparisonArtifactPath } from "../src/features/settlement/lib/storage/comparison-artifact-path";
import {
  asciiExtension,
  buildDirectUploadPath,
} from "../src/features/settlement/lib/storage/direct-upload";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const uuid = () => UUID;
const SAFE_KEY_RE = /^[A-Za-z0-9/._-]+$/;

// The exact production filename pattern that triggered "Invalid key".
const PROD_NAME = "25년 일본 종합 정산자료_INPUT_JP_fin_（6月分）260714.xlsx";

{
  const path = buildComparisonArtifactPath("answer-key", PROD_NAME, "2026-06-01", uuid);
  assert.equal(path, `comparisons/answer-keys/2026-06/${UUID}.xlsx`);
  assert.match(path, SAFE_KEY_RE);
}

// Candidate prefix; month accepted as YYYY-MM too.
assert.equal(
  buildComparisonArtifactPath("candidate", "JP_INPUT_V2_202606_candidate.xlsx", "2026-06", uuid),
  `comparisons/candidates/2026-06/${UUID}.xlsx`,
);

// Missing month falls into the undated folder.
assert.equal(
  buildComparisonArtifactPath("answer-key", "answer.xlsx", null, uuid),
  `comparisons/answer-keys/undated/${UUID}.xlsx`,
);

// Uppercase extension is lowercased in the key.
assert.equal(
  buildComparisonArtifactPath("answer-key", "ANSWER.XLSX", "2026-06-01", uuid),
  `comparisons/answer-keys/2026-06/${UUID}.xlsx`,
);

// Missing, non-ASCII, trailing-junk, or overlong extensions are omitted.
for (const name of ["answer", "정산.자료", "answer.xlsx?", `answer.${"x".repeat(11)}`]) {
  const path = buildComparisonArtifactPath("answer-key", name, "2026-06-01", uuid);
  assert.equal(path, `comparisons/answer-keys/2026-06/${UUID}`);
  assert.match(path, SAFE_KEY_RE);
}

// Shared helper: asciiExtension itself preserves case, so direct-upload keys
// keep their existing behavior (uppercase extension survives, name intact).
assert.equal(asciiExtension("ANSWER.XLSX"), ".XLSX");
{
  const prepared = buildDirectUploadPath("集英社 明細.XLSX", "2026-06-01", uuid);
  assert.equal(prepared.path, `uploads/2026-06/${UUID}.XLSX`);
  assert.equal(prepared.safeFilename, "集英社 明細.XLSX");
}

console.log("comparison-artifact-path: all assertions passed");
