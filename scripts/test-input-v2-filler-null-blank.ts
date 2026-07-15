/**
 * Regression: fee/withholding retain their contract zero defaults, while the
 * formula-owned JPY columns U/W/Z/AB always receive template formulas even
 * when parser-derived values are present. Exception: rows appended by
 * carry-forward (provenance "append") leave Total (U) fully blank — no source
 * value, no template formula — matching the official NAKATANI ledgers.
 * Synthetic records only.
 * Run: node --import tsx scripts/test-input-v2-filler-null-blank.ts
 */
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { CARRY_FORWARD_PROVENANCE_FIELD } from "../src/features/settlement/lib/export/input-v2-carry-forward";
import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";

const FIRST_DATA_ROW = 6;
const COL = {
  total_amount_jpy: 21,
  fee_jpy: 22,
  before_tax_jpy: 23,
  after_tax_jpy: 24,
  before_tax_income_jpy: 26,
  withholding_tax_jpy: 27,
  tax_jpy: 28,
  after_tax_income_jpy: 29,
};

function formulaOf(v: ExcelJS.CellValue): string | null {
  return v && typeof v === "object" && "formula" in v
    ? (v as ExcelJS.CellFormulaValue).formula ?? null
    : null;
}

async function main() {
  const base = {
    title_jp: "synthetic-title",
    clients: "syn-client",
    channel: "syn-channel",
    sales_month: "2026-06-01",
    settlement_month: "2026-06-01",
  };
  const records = [
    { ...base, unique_identifier: "syn-null", [CARRY_FORWARD_PROVENANCE_FIELD]: "carry" },
    {
      ...base,
      unique_identifier: "syn-values",
      total_amount_jpy: 999,
      fee_jpy: 7,
      before_tax_jpy: 888,
      after_tax_jpy: 100,
      before_tax_income_jpy: 777,
      withholding_tax_jpy: 3,
      consumption_tax_jpy: 66,
      after_tax_income_jpy: 50,
      [CARRY_FORWARD_PROVENANCE_FIELD]: "overlay",
    },
    { ...base, unique_identifier: "syn-direct-append" },
    {
      ...base,
      unique_identifier: "syn-append-total",
      total_amount_jpy: 555,
      [CARRY_FORWARD_PROVENANCE_FIELD]: "append",
    },
    {
      ...base,
      unique_identifier: "syn-append-ichijinsha",
      channel: "ichijinsha",
      total_amount_jpy: 444,
      [CARRY_FORWARD_PROVENANCE_FIELD]: "append",
    },
  ];

  const result = await fillInputV2Template({ month: "202606", records });
  const { buffer, electronic_sheet } = result;
  assert.equal(result.carry_rows, 1, "filler reports carried provenance");
  assert.equal(result.overlay_rows, 1, "filler reports overlay provenance");
  assert.equal(result.append_rows, 3, "markerless direct row plus append-marked rows report as append");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(electronic_sheet);
  assert.ok(ws, `sheet ${electronic_sheet} exists in output`);

  const nullRow = ws.getRow(FIRST_DATA_ROW);
  const valueRow = ws.getRow(FIRST_DATA_ROW + 1);
  const markerlessRow = ws.getRow(FIRST_DATA_ROW + 2);
  const appendRow = ws.getRow(FIRST_DATA_ROW + 3);
  const appendIchijinshaRow = ws.getRow(FIRST_DATA_ROW + 4);

  assert.equal(nullRow.getCell(COL.fee_jpy).value, 0, "absent fee_jpy keeps zero default");
  assert.equal(nullRow.getCell(COL.withholding_tax_jpy).value, 0, "absent withholding keeps zero default");

  assert.ok(formulaOf(nullRow.getCell(COL.tax_jpy).value), "null tax receives template formula");

  for (const c of [COL.total_amount_jpy, COL.before_tax_jpy]) {
    const formula = formulaOf(valueRow.getCell(c).value);
    assert.ok(formula, `universally formula-owned column ${c} ignores parser-derived value`);
    assert.ok(formula.includes(String(FIRST_DATA_ROW + 1)), `formula in column ${c} targets output row`);
  }
  assert.equal(valueRow.getCell(COL.before_tax_income_jpy).value, 777, "explicit source-family Z exception survives");
  assert.equal(valueRow.getCell(COL.tax_jpy).value, 66, "explicit source-family AB exception survives");

  assert.equal(valueRow.getCell(COL.fee_jpy).value, 7, "source fee remains numeric");
  assert.equal(valueRow.getCell(COL.after_tax_jpy).value, 100, "source after-tax transaction remains numeric");
  assert.equal(valueRow.getCell(COL.withholding_tax_jpy).value, 3, "source withholding remains numeric");
  assert.equal(valueRow.getCell(COL.after_tax_income_jpy).value, 50, "source after-tax income remains numeric");

  assert.ok(
    formulaOf(markerlessRow.getCell(COL.total_amount_jpy).value),
    "markerless direct row keeps template Total formula",
  );
  for (const [row, label] of [
    [appendRow, "append row"],
    [appendIchijinshaRow, "append row on source-owned-total channel"],
  ] as const) {
    const cell = row.getCell(COL.total_amount_jpy);
    assert.equal(formulaOf(cell.value), null, `${label} Total has no formula`);
    assert.equal(cell.value ?? null, null, `${label} Total stays blank despite explicit source total`);
  }

  console.log("test-input-v2-filler-null-blank: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
