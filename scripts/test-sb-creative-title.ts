/**
 * Unit checks for the SB Creative aggregate-title helper.
 * Uses synthetic labels only — no real titles or amounts.
 * Run: node --import tsx scripts/test-sb-creative-title.ts
 */
import assert from "node:assert/strict";

import { deriveAggregateTitle } from "../src/features/settlement/lib/parsers/sb-creative";

// Single title → used verbatim.
assert.equal(deriveAggregateTitle(["作品X"]), "作品X", "single title");

// Duplicate title (incl. whitespace variants) → deduped to one.
assert.equal(
  deriveAggregateTitle(["作品X", "作品X", " 作品X "]),
  "作品X",
  "duplicate title dedupes",
);

// Multiple titles → deterministic "first + 他N作品" regardless of input order.
assert.equal(
  deriveAggregateTitle(["作品Y", "作品X", "作品Z"]),
  "作品X 他2作品",
  "multiple titles",
);
assert.equal(
  deriveAggregateTitle(["作品Z", "作品Y", "作品X"]),
  deriveAggregateTitle(["作品X", "作品Y", "作品Z"]),
  "order-independent",
);

// Metadata/section-header rows are filtered out.
assert.equal(
  deriveAggregateTitle(["小計", "作品X", "電子書籍/配信分", "合計"]),
  "作品X",
  "metadata filtering",
);

// Nothing but metadata/blank rows → source filename (no invented title).
assert.equal(
  deriveAggregateTitle(["小計", "合計", "  "], "source-report.pdf"),
  "source-report",
  "metadata-only → source filename",
);
assert.equal(deriveAggregateTitle([], "source-report.pdf"), "source-report", "empty → source filename");
assert.equal(deriveAggregateTitle([]), null, "empty without source → null");

console.log("test-sb-creative-title: all assertions passed");
