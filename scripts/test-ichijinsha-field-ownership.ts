/**
 * Regression: Ichijinsha field ownership. The source documents state
 * payment/income amounts only, so a null total stays blank (never the
 * template Total formula), a null fee stays blank (never the zero default),
 * explicit source totals/fees still write through, non-Ichijinsha rows keep
 * the universal formula ownership, and anniversary manuscript-fee invoice
 * rows never adopt the invoice/payment month as their sales month.
 * Synthetic records only.
 * Run: node --import tsx scripts/test-ichijinsha-field-ownership.ts
 */
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";
import { retagInvoiceRows } from "../src/features/settlement/lib/parsers/ichijinsha";
import type { ParseResult } from "../src/features/settlement/lib/schema/sales";

const FIRST_DATA_ROW = 6;
const COL = { total_amount_jpy: 21, fee_jpy: 22, before_tax_jpy: 23 };

function formulaOf(v: ExcelJS.CellValue): string | null {
  return v && typeof v === "object" && "formula" in v
    ? (v as ExcelJS.CellFormulaValue).formula ?? null
    : null;
}

async function testFillerOwnership() {
  const base = {
    title_jp: "synthetic-title",
    clients: "ichijinsha",
    sales_month: "2026-06-01",
    settlement_month: "2026-06-01",
    after_tax_jpy: 100,
    before_tax_income_jpy: 110,
  };
  const records = [
    { ...base, unique_identifier: "ichi-null", channel: "ichijinsha" },
    {
      ...base,
      unique_identifier: "ichi-explicit",
      channel: "ichijinsha",
      total_amount_jpy: 500,
      fee_jpy: 12,
    },
    { ...base, unique_identifier: "jump-fee", channel: "Jumptoon", fee_jpy: 0 },
    { ...base, unique_identifier: "mee-fee", channel: "manga mee", fee_jpy: 0 },
    { ...base, unique_identifier: "syn-other", channel: "syn-channel", clients: "syn-client" },
  ];

  const { buffer, electronic_sheet } = await fillInputV2Template({ month: "202606", records });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(electronic_sheet);
  assert.ok(ws, `sheet ${electronic_sheet} exists in output`);

  const nullRow = ws.getRow(FIRST_DATA_ROW);
  const explicitRow = ws.getRow(FIRST_DATA_ROW + 1);
  const jumpRow = ws.getRow(FIRST_DATA_ROW + 2);
  const meeRow = ws.getRow(FIRST_DATA_ROW + 3);
  const otherRow = ws.getRow(FIRST_DATA_ROW + 4);

  const nullTotal = nullRow.getCell(COL.total_amount_jpy).value;
  assert.equal(formulaOf(nullTotal), null, "ichijinsha null total gets no Total formula");
  assert.equal(nullTotal ?? null, null, "ichijinsha null total stays blank");
  const nullFee = nullRow.getCell(COL.fee_jpy).value;
  assert.equal(formulaOf(nullFee), null, "ichijinsha null fee gets no formula");
  assert.equal(nullFee ?? null, null, "ichijinsha null fee stays blank, not 0");

  assert.equal(
    explicitRow.getCell(COL.total_amount_jpy).value,
    500,
    "explicit ichijinsha source total writes through as a value",
  );
  assert.equal(
    explicitRow.getCell(COL.fee_jpy).value ?? null,
    null,
    "ichijinsha fee stays blank because the source family has no fee field",
  );
  assert.ok(
    formulaOf(explicitRow.getCell(COL.before_tax_jpy).value),
    "W stays universally formula-owned even for ichijinsha",
  );

  assert.equal(
    jumpRow.getCell(COL.fee_jpy).value ?? null,
    null,
    "Jumptoon carried zero fee stays blank",
  );
  assert.equal(
    meeRow.getCell(COL.fee_jpy).value ?? null,
    null,
    "Manga Mee carried zero fee stays blank",
  );

  assert.ok(
    formulaOf(otherRow.getCell(COL.total_amount_jpy).value),
    "non-ichijinsha U keeps the universal template formula",
  );
  assert.equal(otherRow.getCell(COL.fee_jpy).value, 0, "non-ichijinsha null fee keeps the zero default");
}

function invoiceResult(): ParseResult {
  return {
    platform_code: "ichijinsha",
    sales_month: null,
    settlement_month: "2026-06-01",
    errors: [],
    records: [
      // anniversary manuscript fee — no source sales period printed
      { row_index: 0, data: { raw_title: "「作品Ａ」イラスト原稿料", after_tax_jpy: 100 } },
      // anniversary manuscript fee — source-printed sales month must survive
      {
        row_index: 1,
        data: { raw_title: "「作品Ｂ」イラスト原稿料", after_tax_jpy: 100, sales_month: "2026-03-01" },
      },
      // electronic volume line keeps the settlement-month booking rule
      { row_index: 2, data: { raw_title: "電子「作品Ｃ」第3巻", after_tax_jpy: 100 } },
    ],
  };
}

function testAnniversarySalesMonth() {
  const retagged = retagInvoiceRows(
    invoiceResult(),
    "【請求書】一迅社様（20周年記念イラスト原稿料）.xlsx",
    false,
  );
  const [mfBlank, mfSourced, eb] = retagged.records.map((r) => r.data);

  assert.equal(mfBlank.type, "MF", "anniversary 原稿料 row classifies as MF");
  assert.equal(mfBlank.sales_month, null, "MF row without source period keeps sales month blank");
  assert.ok(
    String(mfBlank.note1 ?? "").includes("sales month needs review"),
    "blank MF sales month is flagged for review",
  );
  assert.equal(mfBlank.total_amount_jpy, null, "invoice rows never carry a transaction total");

  assert.equal(
    mfSourced.sales_month,
    "2026-03-01",
    "source-printed MF sales month survives untouched",
  );
  assert.ok(!String(mfSourced.note1 ?? "").includes("needs review"), "sourced MF row is not flagged");

  assert.equal(eb.type, "EB", "電子 volume line classifies as EB");
  assert.equal(eb.sales_month, "2026-06-01", "non-MF invoice rows keep the settlement-month booking");
}

async function main() {
  await testFillerOwnership();
  testAnniversarySalesMonth();
  console.log("test-ichijinsha-field-ownership: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
