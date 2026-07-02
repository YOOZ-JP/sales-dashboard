/**
 * Assertions for the upload route's settlement-month resolution.
 * Run: node --import tsx scripts/test-resolve-settlement-month.ts
 *
 * Proves that in auto mode (no activeMonth) a file with records but no
 * detectable month is rejected — never bucketed into the current date.
 */
import assert from "node:assert/strict";
import { resolveSettlementMonth } from "../src/features/settlement/lib/resolve-settlement-month";

// Manual mode: operator month wins, even over parsed content.
assert.deepEqual(
  resolveSettlementMonth({ activeMonth: "2026-05-01", parsedSettlementMonth: "2026-07-01", hasRecords: true }),
  { ok: true, month: "2026-05-01" },
);

// Auto mode: parsed content is the truth.
assert.deepEqual(
  resolveSettlementMonth({ activeMonth: null, parsedSettlementMonth: "2026-05-01", hasRecords: true }),
  { ok: true, month: "2026-05-01" },
);

// Auto mode: a non-first-of-month day is normalized to YYYY-MM-01.
assert.deepEqual(
  resolveSettlementMonth({ activeMonth: null, parsedSettlementMonth: "2026-05-31", hasRecords: true }),
  { ok: true, month: "2026-05-01" },
);

// Auto mode, records present, no parsed month → hard error, no month.
for (const parsedSettlementMonth of [null, "", "202605", "garbage"]) {
  const r = resolveSettlementMonth({ activeMonth: null, parsedSettlementMonth, hasRecords: true });
  assert.equal(r.ok, false, `expected rejection for parsed=${JSON.stringify(parsedSettlementMonth)}`);
  // The whole point: the result never contains a fabricated month.
  assert.ok(!("month" in r), "rejected file must not carry any month");
}

// Auto mode, informational file (no records) → allowed through without a month.
assert.deepEqual(
  resolveSettlementMonth({ activeMonth: null, parsedSettlementMonth: null, hasRecords: false }),
  { ok: true, month: null },
);

// The current date never leaks into any resolution.
const today = new Date().toISOString().slice(0, 7) + "-01";
const r = resolveSettlementMonth({ activeMonth: null, parsedSettlementMonth: null, hasRecords: true });
assert.ok(!(r.ok && r.month === today), "auto mode must not fall back to the current month");

console.log("resolve-settlement-month: all assertions passed");
