/**
 * Privacy-safe Shueisha OCR benchmark against a real 支払通知書 scan.
 *
 * Prints ONLY counts and elapsed time — never titles, amounts, dates, or
 * OCR text. Skips (successfully) unless SHUEISHA_SOURCE_PDF points at the
 * authoritative source PDF, so it is safe in CI and on machines without
 * the private volume:
 *
 *   SHUEISHA_SOURCE_PDF=/path/to/notice.pdf npm run bench:shueisha
 *
 * Reference points (14 amount cells on the authoritative source):
 *   · old exhaustive reader: 12 recognitions per amount cell (168 total)
 *   · lazy fast path: 1 primary per cell + bounded fallback only while
 *     the printed totals cannot be reconciled
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  buildShueishaParseResult,
  extractShueishaFromPdf,
} from "../src/features/settlement/lib/parsers/shueisha";

async function main() {
  const source = process.env.SHUEISHA_SOURCE_PDF;
  if (!source) {
    console.log("bench-shueisha-ocr: skipped (SHUEISHA_SOURCE_PDF not set)");
    return;
  }
  const buffer = await readFile(source);
  const started = performance.now();
  const extract = await extractShueishaFromPdf(buffer);
  const result = buildShueishaParseResult(extract);
  const stats = extract.ocr_stats;
  console.log(
    JSON.stringify({
      records: result.records.length,
      errors: result.errors.length,
      amount_cells: stats?.amount_cells ?? null,
      amount_recognize_calls: stats?.amount_calls ?? null,
      fallback_recognize_calls: stats?.fallback_calls ?? null,
      exhaustive_equivalent_calls: stats ? stats.amount_cells * 12 : null,
      elapsed_ms: Math.round(performance.now() - started),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
