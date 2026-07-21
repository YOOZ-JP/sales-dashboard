/**
 * Shueisha lazy amount-OCR fast path (synthetic — no private scans, no
 * titles, no amounts from any real source).
 *
 * readLazyAmountCell replaced an exhaustive reader that always ran
 * 4 rect variants × 3 thresholds = 12 recognitions per amount cell —
 * which blew the serverless deadline on limited vCPU. These assertions
 * pin the adaptive contract:
 *   1. the primary reading costs exactly one recognize call, on the
 *      exact grid rect at threshold 150,
 *   2. fallback variants are read lazily in the legacy deterministic
 *      order, dedupe repeated values, and respect the recognize budget,
 *   3. detail-amount resolution short-circuits (zero fallback calls)
 *      when the primary readings already satisfy the printed 合計,
 *   4. a null/ambiguous primary triggers bounded fallback that stops as
 *      soon as reconciliation succeeds,
 *   5. an exhausted budget leaves rows unresolved and strict validation
 *      fails closed (zero records) instead of guessing,
 *   6. page-1 reconciliation keeps the same fast-path/fallback contract,
 *   7. the -1 unresolved-row sentinel is never a sum candidate: a null
 *      primary next to a misread companion must keep expanding (not
 *      "reconcile" via -1), and an empty candidate list never solves.
 */
import assert from "node:assert/strict";

import {
  buildShueishaParseResult,
  createShueishaOcrStats,
  expandAmountCellsRound,
  readLazyAmountCell,
  reconcilePage1Amounts,
  resolveShueishaDetailAmounts,
  type LazyAmountCell,
  type Page1Reconciliation,
  type RecognizeBudget,
  type ShueishaDetailRow,
  type ShueishaExtract,
  type ShueishaOcrStats,
} from "../src/features/settlement/lib/parsers/shueisha";
import type { Rect } from "../src/features/settlement/lib/parsers/ocr-pdf";

const RECT: Rect = { x: 100, y: 200, w: 60, h: 20 };

interface FakeCell {
  cell: LazyAmountCell;
  stats: ShueishaOcrStats;
  calls: () => number;
}

/** Drive the real lazy cell with a scripted sequence of OCR readings. */
async function makeCell(
  readings: Array<number | null>,
  stats = createShueishaOcrStats(),
): Promise<FakeCell> {
  let i = 0;
  const cell = await readLazyAmountCell(
    async () => readings[i++] ?? null,
    RECT,
    stats,
  );
  return { cell, stats, calls: () => i };
}

function detailRow(payment: number): ShueishaDetailRow {
  return { title: "t", kind: "単行本", payment_taxincl: payment };
}

function baseExtract(overrides: Partial<ShueishaExtract>): ShueishaExtract {
  return {
    payment_date: "2026-06-25",
    page2_payment_date: "2026-06-25",
    grand_total: 800,
    manga_rows: [{ title: "m", payment_taxincl: 300, sales_month: "2026-02-01" }],
    jumptoon_summary_total: 500,
    detail_sales_month: "2026-02-01",
    detail_rows: [detailRow(200), detailRow(300)],
    detail_total: 500,
    ocr_errors: [],
    ...overrides,
  };
}

async function testLazyCellContract() {
  // --- primary: exactly one call, exact rect, threshold 150 ---
  const seen: Array<{ x: number; w: number; threshold: number }> = [];
  const stats = createShueishaOcrStats();
  const cell = await readLazyAmountCell(
    async (rect, threshold) => {
      seen.push({ x: rect.x, w: rect.w, threshold });
      return 100;
    },
    RECT,
    stats,
  );
  assert.equal(seen.length, 1, "creating a cell must cost exactly one recognize call");
  assert.deepEqual(seen[0], { x: RECT.x, w: RECT.w, threshold: 150 }, "primary is the exact rect at threshold 150");
  assert.deepEqual(cell.candidates, [100]);
  assert.deepEqual(stats, { amount_cells: 1, amount_calls: 1, fallback_calls: 0 });

  // --- expansion follows the legacy variant-major order and dedupes ---
  const budget: RecognizeBudget = { remaining: 100 };
  while (await cell.expandNext(budget)) {
    // exhaust every variant
  }
  assert.equal(seen.length, 12, "a fully expanded cell reproduces the old 12-variant read");
  assert.deepEqual(
    seen.map((s) => s.threshold),
    [150, 170, 130, 150, 170, 130, 150, 170, 130, 150, 170, 130],
    "thresholds cycle inside each rect variant (legacy order)",
  );
  assert.deepEqual(
    seen.map((s) => s.x),
    [100, 100, 100, 92, 92, 92, 86, 86, 86, 104, 104, 104],
    "rect variants expand in the legacy order (exact, +8, +14, inset)",
  );
  assert.equal(cell.exhausted, true);
  assert.deepEqual(cell.candidates, [100], "repeated readings dedupe");
  assert.equal(budget.remaining, 100 - 11);
  assert.deepEqual(stats, { amount_cells: 1, amount_calls: 12, fallback_calls: 11 });

  // --- an empty budget blocks expansion entirely ---
  const blocked = await makeCell([null, 7]);
  assert.equal(await blocked.cell.expandNext({ remaining: 0 }), false);
  assert.equal(blocked.calls(), 1, "no recognize call may happen without budget");
  assert.deepEqual(blocked.cell.candidates, []);

  // --- round-robin expansion spreads a tight budget across cells ---
  const a = await makeCell([null, 1, 2]);
  const b = await makeCell([null, 3, 4]);
  const roundBudget: RecognizeBudget = { remaining: 2 };
  assert.equal(await expandAmountCellsRound([a.cell, b.cell], roundBudget), true);
  assert.equal(a.calls(), 2, "round-robin gives the first cell one variant");
  assert.equal(b.calls(), 2, "round-robin gives the second cell one variant too");
  assert.equal(roundBudget.remaining, 0);
  assert.equal(await expandAmountCellsRound([a.cell, b.cell], roundBudget), false);
}

async function testDetailFastPath() {
  // --- primaries already satisfy the printed 合計 → zero fallback ---
  const a = await makeCell([200]);
  const b = await makeCell([300], a.stats);
  const rows = [detailRow(200), detailRow(300)];
  const budget: RecognizeBudget = { remaining: 48 };
  await resolveShueishaDetailAmounts(rows, [a.cell, b.cell], 500, budget);
  assert.deepEqual(rows.map((r) => r.payment_taxincl), [200, 300]);
  assert.equal(a.stats.fallback_calls, 0, "consistent primaries must not trigger fallback OCR");
  assert.equal(budget.remaining, 48);
}

async function testDetailFallback() {
  // --- a null primary invokes fallback and stops once reconciled ---
  const stats = createShueishaOcrStats();
  const a = await makeCell([null, 200], stats); // primary unreadable
  const b = await makeCell([300], stats);
  const rows = [detailRow(-1), detailRow(300)];
  const budget: RecognizeBudget = { remaining: 48 };
  await resolveShueishaDetailAmounts(rows, [a.cell, b.cell], 500, budget);
  assert.deepEqual(rows.map((r) => r.payment_taxincl), [200, 300], "fallback must recover the unreadable amount");
  assert.equal(stats.fallback_calls, 2, "one round-robin round (both cells) suffices — then stop");

  // --- an ambiguous primary (sum mismatch) is corrected the same way ---
  const stats2 = createShueishaOcrStats();
  const c = await makeCell([900, 900, 200], stats2); // misread primary
  const d = await makeCell([300], stats2);
  const rows2 = [detailRow(900), detailRow(300)];
  await resolveShueishaDetailAmounts(rows2, [c.cell, d.cell], 500, { remaining: 48 });
  assert.deepEqual(rows2.map((r) => r.payment_taxincl), [200, 300]);
  assert.ok(stats2.fallback_calls > 0 && stats2.fallback_calls < 22, "fallback is bounded, not exhaustive");
}

async function testFailClosed() {
  // --- exhausted budget: rows stay unresolved, validation fails closed ---
  const a = await makeCell([null, 200]);
  const b = await makeCell([300], a.stats);
  const rows = [detailRow(-1), detailRow(300)];
  await resolveShueishaDetailAmounts(rows, [a.cell, b.cell], 500, { remaining: 0 });
  assert.equal(rows[0].payment_taxincl, -1, "no budget → the sentinel must survive");
  const starved = buildShueishaParseResult(baseExtract({ detail_rows: rows }));
  assert.equal(starved.records.length, 0, "unresolved amounts must not produce records");
  assert.ok(starved.errors.length > 0);

  // --- no variant ever reconciles: rows keep primaries, build fails ---
  const c = await makeCell([900]); // every variant reads the same wrong value
  const d = await makeCell([300], c.stats);
  const rows2 = [detailRow(900), detailRow(300)];
  await resolveShueishaDetailAmounts(rows2, [c.cell, d.cell], 500, { remaining: 48 });
  assert.deepEqual(rows2.map((r) => r.payment_taxincl), [900, 300]);
  const mismatched = buildShueishaParseResult(baseExtract({ detail_rows: rows2 }));
  assert.equal(mismatched.records.length, 0, "an unreconciled 合計 must fail closed");
  assert.ok(
    mismatched.errors.some((e) => e.includes("合計")),
    `expected the printed-total mismatch error, got: ${mismatched.errors.join("; ")}`,
  );

  // --- strict happy-path validation still emits records ---
  const ok = buildShueishaParseResult(baseExtract({}));
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.records.length, 2, "1 manga row + 1 aggregated Jumptoon group");
}

async function testSentinelNeverACandidate() {
  // --- regression: a null primary next to a misread companion used to
  //     "reconcile" through the -1 placeholder (-1 + 501 === 500), which
  //     stopped fallback with the first row still unresolved. The sum
  //     search now rejects rows without a positive candidate, so bounded
  //     fallback keeps expanding and recovers the real amounts. ---
  const stats = createShueishaOcrStats();
  const a = await makeCell([null, 200], stats); // primary unreadable
  const b = await makeCell([501, 300], stats); // misread primary: -1 + 501 === 500
  const rows = [detailRow(-1), detailRow(501)];
  const budget: RecognizeBudget = { remaining: 48 };
  await resolveShueishaDetailAmounts(rows, [a.cell, b.cell], 500, budget);
  assert.deepEqual(
    rows.map((r) => r.payment_taxincl),
    [200, 300],
    "-1 must never satisfy the printed 合計 — fallback must continue and recover both amounts",
  );
  assert.ok(stats.fallback_calls > 0, "recovery must come from fallback OCR, not the sentinel");

  // --- an empty candidate list never solves: a cell that reads nothing
  //     on every variant exhausts fallback, keeps the sentinel, and the
  //     build fails closed instead of emitting records ---
  const c = await makeCell([null]); // every one of the 12 variants reads nothing
  const d = await makeCell([300], c.stats);
  const rows2 = [detailRow(-1), detailRow(300)];
  await resolveShueishaDetailAmounts(rows2, [c.cell, d.cell], 500, { remaining: 48 });
  assert.equal(c.cell.exhausted, true, "fallback must run the unreadable cell through every variant");
  assert.equal(rows2[0].payment_taxincl, -1, "an empty candidate list must leave the sentinel");
  assert.equal(rows2[1].payment_taxincl, 300);
  const failed = buildShueishaParseResult(baseExtract({ detail_rows: rows2 }));
  assert.equal(failed.records.length, 0, "unresolved rows must fail closed, never guess");
  assert.ok(failed.errors.length > 0);

  // --- page-1 manga search had the same -1 injection: an unreadable
  //     manga cell beside a misread one (-1 + 301 === 300) must expand
  //     instead of writing the sentinel into the row ---
  const stats3 = createShueishaOcrStats();
  const m1 = await makeCell([null, 100], stats3);
  const m2 = await makeCell([301, 200], stats3);
  const summary = await makeCell([500], stats3);
  const grand = await makeCell([800], stats3);
  const out = baseExtract({
    manga_rows: [
      { title: "m1", payment_taxincl: -1, sales_month: "2026-02-01" },
      { title: "m2", payment_taxincl: 301, sales_month: "2026-02-01" },
    ],
  });
  await reconcilePage1Amounts(
    out,
    {
      mangaCells: [
        { cell: m1.cell, textAmounts: [] },
        { cell: m2.cell, textAmounts: [] },
      ],
      summaryCell: { cell: summary.cell, textAmounts: [] },
      grandCell: { cell: grand.cell, textAmounts: [] },
    },
    { remaining: 48 },
  );
  assert.deepEqual(
    out.manga_rows.map((r) => r.payment_taxincl),
    [100, 200],
    "page-1 fallback must recover the manga amounts, not accept -1 + 301",
  );
  assert.equal(out.grand_total, 800);
  const rebuilt = buildShueishaParseResult(out);
  assert.equal(rebuilt.errors.length, 0);
}

async function testPage1Reconciliation() {
  // --- fast path: consistent primaries cost zero fallback calls ---
  const stats = createShueishaOcrStats();
  const manga = await makeCell([300], stats);
  const summary = await makeCell([500], stats);
  const grand = await makeCell([800], stats);
  const out = baseExtract({});
  const reconciliation: Page1Reconciliation = {
    mangaCells: [{ cell: manga.cell, textAmounts: [] }],
    summaryCell: { cell: summary.cell, textAmounts: [] },
    grandCell: { cell: grand.cell, textAmounts: [] },
  };
  await reconcilePage1Amounts(out, reconciliation, { remaining: 48 });
  assert.equal(stats.fallback_calls, 0, "consistent page-1 primaries must not trigger fallback OCR");
  assert.equal(out.grand_total, 800);
  assert.equal(out.manga_rows[0].payment_taxincl, 300);

  // --- misread summary + misread grand are recovered from fallback and
  //     row-text candidates, bounded by the budget ---
  const stats2 = createShueishaOcrStats();
  const manga2 = await makeCell([300], stats2);
  const summary2 = await makeCell([999, 500], stats2);
  const grand2 = await makeCell([null], stats2); // OCR never reads the grand total
  const out2 = baseExtract({ jumptoon_summary_total: 999, grand_total: null });
  const reconciliation2: Page1Reconciliation = {
    mangaCells: [{ cell: manga2.cell, textAmounts: [] }],
    summaryCell: { cell: summary2.cell, textAmounts: [] },
    // the ***消費税率別支払額*** row text carried a 税込 amount for free
    grandCell: { cell: grand2.cell, textAmounts: [800] },
  };
  await reconcilePage1Amounts(out2, reconciliation2, { remaining: 48 });
  assert.equal(out2.jumptoon_summary_total, 500, "summary must align with the page-2 合計");
  assert.equal(out2.grand_total, 800, "grand total must be recoverable from row-text candidates");
  assert.equal(out2.manga_rows[0].payment_taxincl, 300);
  const rebuilt = buildShueishaParseResult(out2);
  assert.equal(rebuilt.errors.length, 0);
  assert.equal(rebuilt.records.length, 2);

  // --- zero budget: nothing is guessed, validation fails closed ---
  const stats3 = createShueishaOcrStats();
  const manga3 = await makeCell([999, 300], stats3);
  const summary3 = await makeCell([500], stats3);
  const grand3 = await makeCell([800], stats3);
  const out3 = baseExtract({
    manga_rows: [{ title: "m", payment_taxincl: 999, sales_month: "2026-02-01" }],
  });
  await reconcilePage1Amounts(
    out3,
    {
      mangaCells: [{ cell: manga3.cell, textAmounts: [] }],
      summaryCell: { cell: summary3.cell, textAmounts: [] },
      grandCell: { cell: grand3.cell, textAmounts: [] },
    },
    { remaining: 0 },
  );
  assert.equal(out3.manga_rows[0].payment_taxincl, 999, "no budget → the misread primary stays");
  assert.equal(stats3.fallback_calls, 0);
  const failed = buildShueishaParseResult(out3);
  assert.equal(failed.records.length, 0, "an unreconciled cover total must fail closed");
  assert.ok(failed.errors.length > 0);
}

async function main() {
  await testLazyCellContract();
  await testDetailFastPath();
  await testDetailFallback();
  await testFailClosed();
  await testSentinelNeverACandidate();
  await testPage1Reconciliation();
  console.log("test-shueisha-amount-fastpath: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
