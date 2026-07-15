/**
 * Regression: fee/RS contract-cell policy by merge provenance.
 *
 * Carry/overlay rows preserve baseline contract metadata (zero and nonzero);
 * appended rows with no baseline contract row leave fee/RS blank even when
 * the parser supplied fee_jpy=0 or rs_label/rs_rate payment hints, unless an
 * explicitly approved contract-master value (contract_fee_jpy/contract_rs)
 * is present. The internal provenance marker must never reach a worksheet
 * cell. Synthetic records only.
 * Run: node --import tsx scripts/test-input-v2-append-contract-metadata.ts
 */
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import {
  CARRY_FORWARD_PROVENANCE_FIELD,
  mergeCarryForwardRows,
} from "../src/features/settlement/lib/export/input-v2-carry-forward";
import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";

const FIRST_DATA_ROW = 6;
const COL = { fee_jpy: 22, rs: 25 };

const baseline = [
  {
    // Cadence carry: explicit zero fee, nonzero contract RS survives.
    channel_title_jp: "Synthetic Carry Nonzero",
    clients: "PAPYLESS",
    channel: "renta",
    type: "ebook",
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-07-15"),
    rs: 0.4,
    fee_jpy: 100,
  },
  {
    // Blank carry: explicit-zero contract RS survives as 0, not blank.
    channel_title_jp: "Synthetic Carry Zero",
    clients: "NTTsolmare",
    channel: "cmoa",
    type: "ebook",
    rs: 0,
  },
  {
    channel_title_jp: "Synthetic Overlay Nonzero",
    clients: "NTTsolmare",
    channel: "cmoa",
    type: "ebook",
    rs: 0.5,
  },
  {
    channel_title_jp: "Synthetic Overlay Zero",
    clients: "NTTsolmare",
    channel: "cmoa",
    type: "ebook",
    rs: 0,
  },
];

const current = [
  {
    // Statement hints must not displace the baseline contract RS.
    channel_title_jp: "Synthetic Overlay Nonzero",
    channel: "cmoa",
    type: "ebook",
    fee_jpy: 300,
    rs_label: "70%",
    rs_rate: 0.7,
    total_amount_jpy: 3000,
  },
  {
    channel_title_jp: "Synthetic Overlay Zero",
    channel: "cmoa",
    type: "ebook",
    fee_jpy: 250,
    rs_label: "70%",
    total_amount_jpy: 2500,
  },
  {
    // New key: parser fee=0 and RS hints are not contract terms.
    channel_title_jp: "Synthetic Append Hints",
    channel: "cmoa",
    type: "ebook",
    fee_jpy: 0,
    rs_label: "70%",
    rs_rate: 0.7,
    rs_rate_hint: 0.7,
    total_amount_jpy: 5000,
  },
  {
    // New key with explicitly approved contract-master values.
    channel_title_jp: "Synthetic Append Approved",
    channel: "cmoa",
    type: "ebook",
    fee_jpy: 0,
    rs_label: "70%",
    contract_fee_jpy: 123,
    contract_rs: 0.55,
    total_amount_jpy: 6000,
  },
];

async function main() {
  const merged = mergeCarryForwardRows(baseline, current, "202606");
  assert.equal(merged.carry_rows, 2, "two baseline rows carry");
  assert.equal(merged.overlay_rows, 2, "two current rows overlay");
  assert.equal(merged.append_rows, 2, "two current rows append");
  assert.deepEqual(
    merged.records.map((r) => r[CARRY_FORWARD_PROVENANCE_FIELD]),
    ["carry", "carry", "overlay", "overlay", "append", "append"],
    "merge phase stamps internal provenance on every row",
  );

  const { buffer, electronic_sheet } = await fillInputV2Template({
    month: "202606",
    records: merged.records,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(electronic_sheet);
  assert.ok(ws, `sheet ${electronic_sheet} exists in output`);

  const cell = (i: number, c: number) => ws.getRow(FIRST_DATA_ROW + i).getCell(c).value;

  // Carry rows preserve baseline contract metadata.
  assert.equal(cell(0, COL.fee_jpy), 0, "cadence carry keeps explicit zero fee");
  assert.equal(cell(0, COL.rs), 0.4, "cadence carry preserves nonzero RS");
  assert.equal(cell(1, COL.fee_jpy), 0, "blank carry keeps contract zero fee default");
  assert.equal(cell(1, COL.rs), 0, "blank carry preserves explicit-zero RS as 0, not blank");

  // Overlay rows preserve baseline RS even when the statement carries hints.
  assert.equal(cell(2, COL.fee_jpy), 300, "overlay keeps statement fee");
  assert.equal(cell(2, COL.rs), 0.5, "overlay preserves nonzero baseline RS over rs_label/rs_rate");
  assert.equal(cell(3, COL.fee_jpy), 250, "overlay keeps statement fee (zero-RS row)");
  assert.equal(cell(3, COL.rs), 0, "overlay preserves explicit-zero baseline RS over rs_label");

  // Appended rows: parser fee=0 and RS hints stay blank.
  assert.equal(cell(4, COL.fee_jpy), null, "append with parser fee=0 leaves fee blank");
  assert.equal(cell(4, COL.rs), null, "append with rs_label/rs_rate/rs_rate_hint leaves RS blank");

  // Appended rows: explicitly approved contract-master values populate.
  assert.equal(cell(5, COL.fee_jpy), 123, "approved contract_fee_jpy populates appended fee");
  assert.equal(cell(5, COL.rs), 0.55, "approved contract_rs populates appended RS");

  // The private provenance marker must never appear in any exported cell.
  const forbidden = new Set(["carry", "overlay", "append", CARRY_FORWARD_PROVENANCE_FIELD]);
  const maxCol = Math.max(ws.columnCount, 102);
  for (let r = FIRST_DATA_ROW; r < FIRST_DATA_ROW + merged.records.length; r += 1) {
    for (let c = 1; c <= maxCol; c += 1) {
      const value = ws.getRow(r).getCell(c).value;
      if (typeof value !== "string") continue;
      assert.ok(
        !forbidden.has(value.trim().toLowerCase()),
        `provenance marker leaked into cell ${r}:${c}`,
      );
    }
  }

  console.log("test-input-v2-append-contract-metadata: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
