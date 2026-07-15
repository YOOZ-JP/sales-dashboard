/**
 * Regression: consumption_tax_jpy keeps null-vs-zero semantics through all
 * three adapters so absent/null stays null for export formula ownership, while
 * fee_jpy and withholding_tax_jpy retain their contract default of zero.
 * Synthetic rows only.
 * Run: node --import tsx scripts/test-to-sales-records-null-vs-zero.ts
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

const FIELDS = ["fee_jpy", "withholding_tax_jpy", "consumption_tax_jpy"] as const;

// Row 0: fields absent → null. Row 1: explicit 0 → 0. Row 2: explicit value survives.
const moneyCases = [
  {},
  { fee_jpy: 0, withholding_tax_jpy: 0, consumption_tax_jpy: 0 },
  { fee_jpy: 111, withholding_tax_jpy: 22, consumption_tax_jpy: 33 },
];

// SalesRecord-shaped rows (detected via client_code/channel_code).
const salesRecordRows = moneyCases.map((money) => ({
  client_code: "syn-client",
  channel_code: "syn-channel",
  title_jp: "synthetic-title",
  ...money,
}));

// Ground-truth-shaped rows (detected via clients/channel).
const groundTruthRows = moneyCases.map((money) => ({
  clients: "syn-client",
  channel: "syn-channel",
  title_jp: "synthetic-title",
  ...money,
}));

// RawRecord-shaped rows (detected via row_index/data).
const rawRecordRows = moneyCases.map((money, i) => ({
  row_index: i,
  data: {
    client_code: "syn-client",
    channel_code: "syn-channel",
    title_jp: "synthetic-title",
    ...money,
  },
}));

for (const [label, rows] of [
  ["fromSalesRecord", salesRecordRows],
  ["fromGroundTruth", groundTruthRows],
  ["fromRawRecord", rawRecordRows],
] as const) {
  const { inserts, errors } = toSalesRecords(rows, ctx);
  assert.equal(errors.length, 0, `${label}: no validation errors`);
  assert.equal(inserts.length, 3, `${label}: all rows transformed`);

  assert.equal(inserts[0].fee_jpy, 0, `${label}: absent fee_jpy keeps contract zero default`);
  assert.equal(inserts[0].withholding_tax_jpy, 0, `${label}: absent withholding_tax_jpy keeps contract zero default`);
  assert.equal(inserts[0].consumption_tax_jpy, null, `${label}: absent consumption_tax_jpy stays null`);
  for (const field of FIELDS) {
    assert.equal(inserts[1][field], 0, `${label}: explicit zero ${field} stays 0`);
  }
  assert.equal(inserts[2].fee_jpy, 111, "explicit fee_jpy survives");
  assert.equal(inserts[2].withholding_tax_jpy, 22, "explicit withholding_tax_jpy survives");
  assert.equal(inserts[2].consumption_tax_jpy, 33, "explicit consumption_tax_jpy survives");
}

console.log("test-to-sales-records-null-vs-zero: all assertions passed");
