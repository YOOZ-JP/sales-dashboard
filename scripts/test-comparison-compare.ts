/**
 * Synthetic-workbook assertions for the settlement comparison library.
 * Run: node --import tsx scripts/test-comparison-compare.ts
 */
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { compareInputWorkbooks } from "../src/features/settlement/lib/comparison";
import { ELECTRONIC_COL } from "../src/features/settlement/lib/export/input-v2-filler";

type Field = keyof typeof ELECTRONIC_COL;
type Row = Partial<Record<Field, ExcelJS.CellValue>>;

async function makeWorkbook(
  rows: Row[],
  opts: { sheetName?: string; headers?: boolean } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? "input_電子_5月");
  if (opts.headers !== false) {
    ws.getRow(4).getCell(ELECTRONIC_COL.unique_identifier).value = "Unique Identifier";
    ws.getRow(4).getCell(ELECTRONIC_COL.channel).value = "Channel";
    ws.getRow(4).getCell(ELECTRONIC_COL.type).value = "Type";
  }
  rows.forEach((row, i) => {
    const wsRow = ws.getRow(6 + i);
    for (const [field, value] of Object.entries(row)) {
      wsRow.getCell(ELECTRONIC_COL[field as Field]).value = value as ExcelJS.CellValue;
    }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function baseRow(overrides: Row = {}): Row {
  return {
    channel_title_jp: "タイトルA",
    channel: "cmoa",
    type: "WT",
    total_amount_jpy: 1000,
    before_tax_income_jpy: 600,
    ...overrides,
  };
}

const VECTOR_FIELDS: Field[] = [
  "total_amount_jpy",
  "fee_jpy",
  "before_tax_jpy",
  "after_tax_jpy",
  "rs",
  "before_tax_income_jpy",
];

function vectorRow(bits: readonly number[]): Row {
  const overrides: Row = {};
  VECTOR_FIELDS.forEach((field, index) => {
    overrides[field] = bits[index] ?? 0;
  });
  return baseRow(overrides);
}

async function run() {
  // 1. Identical workbooks → all rows exact, zero diffs.
  {
    const rows = [baseRow(), baseRow({ channel_title_jp: "タイトルB", total_amount_jpy: 50 })];
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook(rows),
      golden: await makeWorkbook(rows),
    });
    assert.equal(result.summary.candidate_rows, 2);
    assert.equal(result.summary.golden_rows, 2);
    assert.equal(result.summary.matched_rows, 2);
    assert.equal(result.summary.exact_rows, 2);
    assert.equal(result.summary.diff_total, 0);
    assert.deepEqual(result.diffs, []);
  }

  // 2. Duplicate identities pair by content, independent of row order.
  {
    const v1 = baseRow({ total_amount_jpy: 100 });
    const v2 = baseRow({ total_amount_jpy: 200 });
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([v1, v2]),
      golden: await makeWorkbook([v2, v1]),
    });
    assert.equal(result.summary.exact_rows, 2, "swapped duplicates must pair exactly");
    assert.equal(result.summary.diff_total, 0);
  }

  // 2b. Duplicate multiplicity mismatch: 3 copies vs 2 copies → 1 extra.
  {
    const row = baseRow();
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([row, row, row]),
      golden: await makeWorkbook([row, row]),
    });
    assert.equal(result.summary.exact_rows, 2);
    assert.equal(result.summary.extra_rows, 1);
    assert.equal(result.summary.missing_rows, 0);
    assert.equal(result.diffs.filter((d) => d.category === "extra").length, 1);
  }

  // 2c. Adversarial 2x2: row-wise greedy would choose costs 1+3, optimum is 2+0.
  {
    const result = await compareInputWorkbooks({
      golden: await makeWorkbook([vectorRow([0, 0, 0]), vectorRow([1, 0, 0])]),
      candidate: await makeWorkbook([vectorRow([1, 0, 0]), vectorRow([0, 1, 1])]),
    });
    assert.equal(result.summary.matched_rows, 2);
    assert.equal(result.summary.exact_rows, 1);
    assert.equal(result.summary.diff_total, 2, "global assignment beats greedy 2x2 total");
  }

  // 2d. Adversarial 3x3 stays optimal and invariant under input order.
  {
    const golden = [
      vectorRow([0, 0, 0, 0, 0, 0]),
      vectorRow([1, 0, 0, 0, 0, 0]),
      vectorRow([1, 1, 1, 1, 1, 1]),
    ];
    const candidate = [
      vectorRow([1, 0, 0, 0, 0, 0]),
      vectorRow([0, 1, 1, 0, 0, 0]),
      vectorRow([1, 1, 1, 1, 1, 1]),
    ];
    const expected = await compareInputWorkbooks({
      golden: await makeWorkbook(golden),
      candidate: await makeWorkbook(candidate),
    });
    const reordered = await compareInputWorkbooks({
      golden: await makeWorkbook([golden[2], golden[0], golden[1]]),
      candidate: await makeWorkbook([candidate[1], candidate[2], candidate[0]]),
    });
    assert.equal(expected.summary.matched_rows, 3);
    assert.equal(expected.summary.exact_rows, 2);
    assert.equal(expected.summary.diff_total, 2, "global assignment beats greedy 3x3 total");
    assert.equal(reordered.summary.diff_total, expected.summary.diff_total);
    assert.equal(reordered.summary.exact_rows, expected.summary.exact_rows);
    assert.deepEqual(reordered.summary.field_mismatches, expected.summary.field_mismatches);
  }

  // 3. Missing / extra whole rows.
  {
    const shared = baseRow();
    const goldenOnly = baseRow({ channel_title_jp: "タイトルZ" });
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([shared]),
      golden: await makeWorkbook([shared, goldenOnly]),
    });
    assert.equal(result.summary.missing_rows, 1);
    assert.equal(result.summary.extra_rows, 0);
    const missing = result.diffs.find((d) => d.category === "missing");
    assert.ok(missing, "missing diff must exist");
    assert.equal(missing.identity.title, "タイトルZ");
    assert.equal(missing.candidate, null);
    assert.ok(missing.golden, "missing diff carries a golden row digest");
  }

  // 4. Formula vs blank and formula vs value are 'formula' diffs.
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([
        baseRow({ fee_jpy: undefined }),
        baseRow({ channel_title_jp: "タイトルB", fee_jpy: 70 }),
      ]),
      golden: await makeWorkbook([
        baseRow({ fee_jpy: { formula: "U6*0.1" } as ExcelJS.CellValue }),
        baseRow({
          channel_title_jp: "タイトルB",
          fee_jpy: { formula: "U7*0.1" } as ExcelJS.CellValue,
        }),
      ]),
    });
    const formulaDiffs = result.diffs.filter((d) => d.category === "formula");
    assert.equal(formulaDiffs.length, 2, "blank-vs-formula and value-vs-formula");
    assert.ok(formulaDiffs.every((d) => d.field === "fee_jpy"));
    assert.equal(result.summary.formula_mismatches, 2);
  }

  // 4b. Same formula on different rows compares equal (row-masked).
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([
        baseRow({ channel_title_jp: "先頭", fee_jpy: 1 }),
        baseRow({ fee_jpy: { formula: "U7*0.1" } as ExcelJS.CellValue }),
      ]),
      golden: await makeWorkbook([
        baseRow({ fee_jpy: { formula: "U6*0.1" } as ExcelJS.CellValue }),
      ]),
    });
    assert.equal(
      result.diffs.filter((d) => d.field === "fee_jpy").length,
      0,
      "row-shifted formulas must not diff",
    );
  }

  // 5. Numeric string equivalence: 1234 (number) == "1,234" (string).
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([baseRow({ total_amount_jpy: 1234 })]),
      golden: await makeWorkbook([baseRow({ total_amount_jpy: "1,234" })]),
    });
    assert.equal(result.summary.diff_total, 0, "numeric strings compare numerically");
    assert.equal(result.summary.exact_rows, 1);
  }

  // 6. NFKC + whitespace + wave-dash identity normalization.
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([
        baseRow({ channel_title_jp: "ＡＢＣ〜テスト", channel: "cmoa", type: "WT" }),
      ]),
      golden: await makeWorkbook([
        baseRow({ channel_title_jp: "  ABC～テスト ", channel: "CMOA ", type: " WT" }),
      ]),
    });
    assert.equal(result.summary.matched_rows, 1, "normalized identities must pair");
    assert.equal(result.summary.missing_rows, 0);
    assert.equal(result.summary.extra_rows, 0);
  }

  // 7. Plain value mismatch is a 'field' diff on the right field.
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([baseRow({ before_tax_income_jpy: 600 })]),
      golden: await makeWorkbook([baseRow({ before_tax_income_jpy: 601 })]),
    });
    assert.equal(result.summary.diff_total, 1);
    assert.equal(result.diffs[0].category, "field");
    assert.equal(result.diffs[0].field, "before_tax_income_jpy");
    assert.deepEqual(result.summary.field_mismatches, { before_tax_income_jpy: 1 });
  }

  // 8. Unidentifiable sheet fails clearly.
  {
    await assert.rejects(
      compareInputWorkbooks({
        candidate: await makeWorkbook([baseRow()], { sheetName: "何か別物", headers: false }),
        golden: await makeWorkbook([baseRow()]),
      }),
      /electronic INPUT sheet not found/,
    );
  }

  // 8b. Header-signature fallback identifies a renamed sheet.
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([baseRow()], { sheetName: "renamed_sheet" }),
      golden: await makeWorkbook([baseRow()]),
    });
    assert.equal(result.summary.matched_rows, 1);
    assert.equal(result.summary.candidate_sheet, "renamed_sheet");
  }

  // 9. Diff list is bounded; summary still counts everything.
  {
    const result = await compareInputWorkbooks({
      candidate: await makeWorkbook([
        baseRow({ total_amount_jpy: 1, fee_jpy: 2, before_tax_income_jpy: 3 }),
      ]),
      golden: await makeWorkbook([
        baseRow({ total_amount_jpy: 9, fee_jpy: 8, before_tax_income_jpy: 7 }),
      ]),
      maxDiffs: 2,
    });
    assert.equal(result.summary.diff_total, 3);
    assert.equal(result.diffs.length, 2);
    assert.equal(result.summary.diffs_truncated, true);
  }

  console.log("comparison-compare: all assertions passed");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
