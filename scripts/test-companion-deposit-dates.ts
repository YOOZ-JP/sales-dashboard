/**
 * Privacy-safe synthetic checks for the companion/cadence deposit-date
 * policies (Ichijinsha folder date, MBJ batch+1, SB Creative sales+4),
 * including month/year/leap boundaries. No real titles or amounts.
 * Run: node --import tsx scripts/test-companion-deposit-dates.ts
 */
import assert from "node:assert/strict";

import * as XLSX from "xlsx";

import {
  applyIchijinshaFolderDepositDate,
  extractIchijinshaFolderDepositDate,
} from "../src/features/settlement/lib/parsers/ichijinsha";
import { parseMbj } from "../src/features/settlement/lib/parsers/mbj";
import { aggregateSbSalesReport } from "../src/features/settlement/lib/parsers/sb-creative";
import type { ParseResult } from "../src/features/settlement/lib/schema/sales";

function checkIchijinshaFolderDate() {
  // Platform folder prefix carries the deposit date as a YYYYMMDD token.
  assert.equal(
    extractIchijinshaFolderDepositDate("20260731一迅社"),
    "2026-07-31",
    "Ichijinsha folder prefix yields the deposit date",
  );
  assert.equal(
    extractIchijinshaFolderDepositDate("uploads/20270101一迅社"),
    "2027-01-01",
    "Ichijinsha uses the folder basename, year boundary intact",
  );
  assert.equal(
    extractIchijinshaFolderDepositDate("20240229一迅社"),
    "2024-02-29",
    "Ichijinsha accepts a valid leap-day token",
  );
  assert.equal(
    extractIchijinshaFolderDepositDate("20230229一迅社"),
    null,
    "Ichijinsha rejects Feb 29 in a non-leap year",
  );
  assert.equal(
    extractIchijinshaFolderDepositDate("20261301一迅社"),
    null,
    "Ichijinsha rejects an invalid month",
  );
  assert.equal(
    extractIchijinshaFolderDepositDate("一迅社202607310"),
    null,
    "Ichijinsha ignores digit runs longer than 8",
  );
  assert.equal(extractIchijinshaFolderDepositDate(undefined), null, "No folder → no deposit date");
  assert.equal(extractIchijinshaFolderDepositDate("一迅社"), null, "No token → no deposit date");

  // Deposit applies to non-summary detail rows only; summary evidence keeps its own dates.
  const result: ParseResult = {
    platform_code: "ichijinsha",
    sales_month: null,
    settlement_month: null,
    records: [
      { row_index: 0, data: { title_jp: "合成タイトルＡ（１）", type: "EB" } },
      { row_index: 1, data: { title_jp: "合成請求書控え", is_summary: true } },
    ],
    errors: [],
  };
  applyIchijinshaFolderDepositDate(result, "2026-07-31");
  assert.equal(
    result.records[0].data.deposit_month,
    "2026-07-31",
    "Ichijinsha detail row receives the folder deposit date",
  );
  assert.equal(
    result.records[1].data.deposit_month,
    undefined,
    "Ichijinsha summary evidence is never stamped",
  );
}

function mbjBuffer(): Buffer {
  const rows = [
    ["書籍code", "タイトル", "フォーマット", "分配料率", "売上金額", "支払金額"],
    ["B001", "合成タイトルＢ（１）", "EPUB 3", 0.6, 100, 60],
    ["合計", "", "", "", 100, 60],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

async function checkMbj() {
  const buffer = mbjBuffer();

  // Deposit = end of the month after the settlement batch month (year boundary).
  const december = await parseMbj({
    filename: "416829-202612-LI-54575Synthetic(Multi)-都度-202610.xls",
    buffer,
  });
  assert.equal(december.settlement_month, "2026-12-31", "MBJ settlement is end of batch month");
  const decData = december.records.map((r) => r.data);
  assert.equal(decData.length, 1, "MBJ parses the synthetic detail row");
  assert.equal(
    decData[0].deposit_month,
    "2027-01-31",
    "MBJ deposit is end of batch + 1 across the year boundary",
  );

  // Leap-year February deposit (batch 2024-01 → deposit 2024-02-29).
  const leap = await parseMbj({
    filename: "416829-202401-LI-54575Synthetic(Multi)-都度-202311.xls",
    buffer,
  });
  assert.equal(leap.records[0].data.deposit_month, "2024-02-29", "MBJ deposit handles leap February");

  // Short February in a non-leap year (batch 2023-01 → deposit 2023-02-28).
  const shortFeb = await parseMbj({
    filename: "416829-202301-LI-54575Synthetic(Multi)-都度-202211.xls",
    buffer,
  });
  assert.equal(shortFeb.records[0].data.deposit_month, "2023-02-28", "MBJ deposit handles short February");

  // No batch token in the filename → no deposit date is invented.
  const noBatch = await parseMbj({ filename: "synthetic.xls", buffer });
  assert.equal(noBatch.records[0].data.deposit_month, null, "MBJ without batch month leaves deposit null");
}

function checkSbCreative() {
  const detailRows = [{ title: "合成タイトルＣ 第1巻", royalty_taxincl: 110 }];

  // Deposit = end of the month four months after the target sales month
  // (October + 4 → short February across the year boundary).
  const october = aggregateSbSalesReport({ detailRows, mgRows: [], salesMonth: "2026-10-01" });
  assert.equal(october.errors.length, 0, "SB synthetic report aggregates cleanly");
  assert.equal(october.records.length, 1, "SB synthetic report yields one detail row");
  assert.equal(october.records[0].data.sales_month, "2026-10-01", "SB detail keeps the sales month");
  assert.equal(
    october.records[0].data.deposit_month,
    "2027-02-28",
    "SB deposit is end of sales + 4 across the year boundary (short February)",
  );

  // Leap-year February deposit (sales 2023-10 → deposit 2024-02-29).
  const leap = aggregateSbSalesReport({ detailRows, mgRows: [], salesMonth: "2023-10-01" });
  assert.equal(leap.records[0].data.deposit_month, "2024-02-29", "SB deposit handles leap February");

  // Plain month arithmetic too (sales 2026-03 → deposit 2026-07-31).
  const march = aggregateSbSalesReport({ detailRows, mgRows: [], salesMonth: "2026-03-01" });
  assert.equal(march.records[0].data.deposit_month, "2026-07-31", "SB deposit is end of sales + 4");

  // No parsed target month → no deposit date is invented.
  const unknown = aggregateSbSalesReport({ detailRows, mgRows: [], salesMonth: null });
  assert.equal(unknown.records[0].data.deposit_month, null, "SB without sales month leaves deposit null");
}

async function main() {
  checkIchijinshaFolderDate();
  await checkMbj();
  checkSbCreative();
  console.log("test-companion-deposit-dates: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
