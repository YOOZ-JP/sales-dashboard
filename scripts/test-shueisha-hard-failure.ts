/**
 * Shueisha hard-failure routing (synthetic, no private titles/amounts).
 *
 * The scanned 支払通知書（集英社） is an authoritative detail source. When its
 * local OCR pipeline fails (e.g. the deployed bundle is missing the
 * @napi-rs/canvas native binding), the upload must surface a hard failure —
 * never a generic 1-row summary success and never a benign "supporting
 * document" skip.
 */
import assert from "node:assert/strict";

import { parseFile, detectPlatform } from "../src/features/settlement/lib/parsers";
import { parseGenericSummaryFallback } from "../src/features/settlement/lib/parsers/generic-summary-fallback";
import {
  buildShueishaParseResult,
  type ShueishaExtract,
} from "../src/features/settlement/lib/parsers/shueisha";
import {
  isZeroRowParseFailure,
  statusAfterParseMetadata,
} from "../src/features/settlement/lib/storage/direct-upload";

const SHUEISHA_FILENAME = "20260625_支払通知書（集英社）.pdf";
// Not a valid PDF: forces the OCR pipeline to fail exactly like a broken
// serverless runtime does (before any page is rasterized).
const GARBAGE_PDF = Buffer.from("%PDF-1.4 not really a pdf");

async function main() {
  // --- detection still routes the payment notice to the shueisha parser ---
  const detection = detectPlatform({ filename: SHUEISHA_FILENAME });
  assert.equal(detection.platform_code, "shueisha");

  // --- the generic fallback would mask the failure as a 1-row success ---
  const masked = await parseGenericSummaryFallback({
    filename: SHUEISHA_FILENAME,
    buffer: GARBAGE_PDF,
    platformCode: "shueisha",
  });
  assert.equal(masked.records.length, 1, "fallback contract: always emits one summary row");
  assert.deepEqual(masked.errors, [], "fallback contract: reports no errors");

  // --- ...which is why parseFile must never route shueisha into it ---
  const parsed = await parseFile({ filename: SHUEISHA_FILENAME, buffer: GARBAGE_PDF });
  assert.equal(parsed.platform_code, "shueisha");
  assert.equal(parsed.records.length, 0, "OCR failure must not produce fallback records");
  assert.ok(parsed.errors.length > 0, "OCR failure must carry parser errors");
  assert.ok(
    parsed.errors.some((e) => e.includes("shueisha")),
    `errors must identify the shueisha parser, got: ${parsed.errors.join("; ")}`,
  );

  // --- zero detail rows from a readable extract is also a loud failure ---
  const emptyExtract: ShueishaExtract = {
    payment_date: "2026-06-25",
    page2_payment_date: "2026-06-25",
    grand_total: 1000,
    manga_rows: [],
    jumptoon_summary_total: 500,
    detail_sales_month: "2026-02-01",
    detail_rows: [],
    detail_total: 500,
    ocr_errors: [],
  };
  const zeroRows = buildShueishaParseResult(emptyExtract);
  assert.equal(zeroRows.records.length, 0);
  assert.ok(
    zeroRows.errors.some((e) => e.includes("no Jumptoon detail rows")),
    "zero detail rows must be reported as an error",
  );

  // --- upload-route policy: shueisha zero rows = hard failure, not a skip ---
  assert.equal(
    isZeroRowParseFailure("shueisha", 0, ["shueisha local OCR failed: Cannot find module"]),
    true,
    "shueisha zero rows must be a hard failure regardless of error wording",
  );
  assert.equal(isZeroRowParseFailure("shueisha", 0, []), true);
  assert.equal(isZeroRowParseFailure("shueisha", 9, []), false, "a real 9-row parse is not a failure");
  assert.equal(statusAfterParseMetadata(0, true), "failed", "hard failure must persist as failed status");
  // Non-authoritative platforms keep the existing lenient skip behavior.
  assert.equal(isZeroRowParseFailure("dmm", 0, ["some benign note"]), false);
  assert.equal(isZeroRowParseFailure("unknown", 0, []), true);

  console.log("test-shueisha-hard-failure: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
