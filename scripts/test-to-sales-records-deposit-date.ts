/**
 * Regression: deposit_month must keep the exact source deposit date
 * (month-end or day-25 payouts), not collapse to the first of the month.
 * sales_month stays month-first. Synthetic rows only.
 * Run: node --import tsx scripts/test-to-sales-records-deposit-date.ts
 */
import assert from "node:assert/strict";

import {
  emptyLookupMaps,
  toSalesRecords,
  type TransformContext,
} from "../src/features/settlement/lib/aggregation/to-sales-records";

const ctx: TransformContext = {
  settlement_month: "2026-07-01",
  platform_code: "synthetic",
  lookups: emptyLookupMaps(),
};

// SalesRecord-shaped rows (detected via client_code/channel_code).
const salesRecordRows = [
  {
    client_code: "syn-client",
    channel_code: "syn-channel",
    title_jp: "synthetic-title",
    sales_month: "2026-07-31",
    deposit_month: "2026-07-31",
  },
  {
    client_code: "syn-client",
    channel_code: "syn-channel",
    title_jp: "synthetic-title",
    sales_month: "2026-06-25",
    deposit_month: "2026-06-25",
  },
];

// Ground-truth-shaped rows (detected via clients/channel).
const groundTruthRows = [
  {
    clients: "syn-client",
    channel: "syn-channel",
    title_jp: "synthetic-title",
    sales_month: "2026-07-31",
    deposit_month: "2026-07-31",
  },
  {
    clients: "syn-client",
    channel: "syn-channel",
    title_jp: "synthetic-title",
    sales_month: "2026-06-25",
    deposit_month: "2026-06-25",
  },
];

for (const [label, rows] of [
  ["fromSalesRecord", salesRecordRows],
  ["fromGroundTruth", groundTruthRows],
] as const) {
  const { inserts, errors } = toSalesRecords(rows, ctx);
  assert.equal(errors.length, 0, `${label}: no validation errors`);
  assert.equal(inserts.length, 2, `${label}: both rows transformed`);

  assert.equal(
    inserts[0].deposit_month,
    "2026-07-31",
    `${label}: month-end deposit date survives`,
  );
  assert.equal(
    inserts[1].deposit_month,
    "2026-06-25",
    `${label}: day-25 deposit date survives`,
  );

  // sales_month keeps month-first normalization.
  assert.equal(inserts[0].sales_month, "2026-07-01", `${label}: sales_month month-first`);
  assert.equal(inserts[1].sales_month, "2026-06-01", `${label}: sales_month month-first`);
}

console.log("test-to-sales-records-deposit-date: all assertions passed");
