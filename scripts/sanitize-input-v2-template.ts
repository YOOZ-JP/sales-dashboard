/**
 * Build a privacy-safe reusable INPUT template from a filled golden workbook.
 *
 * Keeps master/config sheets (作品番号/設定/タイトル/MG) untouched, but strips
 * every real input row from data sheets: rows 7+ are deleted and the row-6
 * prototype keeps only formulas and styles (no titles, amounts, or dates).
 * The hidden 참고용 reference sheet gets the same row>=6 value strip so no
 * sample row leaks real data.
 *
 * Run: node --import tsx scripts/sanitize-input-v2-template.ts <source.xlsx> [dest.xlsx]
 */
import ExcelJS from "exceljs";
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_DEST = "src/features/settlement/data/templates/input_jp_2026_v3_template.xlsx";
const FIRST_DATA_ROW = 6;

function needsSanitize(ws: ExcelJS.Worksheet): boolean {
  return /^input_/.test(ws.name) || /참고용/.test(ws.name);
}

function isFormulaValue(v: ExcelJS.CellValue): boolean {
  return !!v && typeof v === "object" && ("formula" in v || "sharedFormula" in v);
}

function sanitizeSheet(ws: ExcelJS.Worksheet): { kept: number; removed: number } {
  const last = Math.max(ws.actualRowCount, ws.rowCount, FIRST_DATA_ROW);

  // Prototype row: keep formula text + style, drop every value and cached result.
  let kept = 0;
  const proto = ws.getRow(FIRST_DATA_ROW);
  for (let c = 1; c <= ws.columnCount; c++) {
    const cell = proto.getCell(c);
    const v = cell.value;
    if (isFormulaValue(v)) {
      const formula = (v as ExcelJS.CellFormulaValue).formula;
      cell.value = formula ? ({ formula } as ExcelJS.CellFormulaValue) : null;
      if (formula) kept++;
    } else if (v !== null && v !== undefined) {
      cell.value = null;
    }
  }
  proto.commit();

  const removed = last - FIRST_DATA_ROW;
  if (removed > 0) {
    // Keep the formatted row grid but remove every value. Splicing thousands of
    // heavily-formatted Excel rows is both slow and unreliable in ExcelJS.
    for (let r = FIRST_DATA_ROW + 1; r <= last; r++) {
      ws.getRow(r).values = [];
    }
  }
  return { kept, removed };
}

function verifySheet(ws: ExcelJS.Worksheet): void {
  const last = Math.max(ws.actualRowCount, ws.rowCount);
  for (let r = FIRST_DATA_ROW; r <= last; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).value;
      if (v === null || v === undefined) continue;
      if (r === FIRST_DATA_ROW && isFormulaValue(v)) {
        const f = v as ExcelJS.CellFormulaValue;
        if (f.result === null || f.result === undefined) continue;
      }
      throw new Error(`${ws.name}!R${r}C${c} still holds a value after sanitize`);
    }
  }
}

async function main() {
  const [, , source, destArg] = process.argv;
  if (!source) {
    console.error("usage: sanitize-input-v2-template.ts <source.xlsx> [dest.xlsx]");
    process.exit(1);
  }
  const dest = destArg ?? DEFAULT_DEST;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(source)) as unknown as ExcelJS.Buffer);

  for (const ws of wb.worksheets) {
    if (!needsSanitize(ws)) continue;
    const { kept, removed } = sanitizeSheet(ws);
    verifySheet(ws);
    console.log(`${ws.name}: removed ${removed} data rows, prototype formulas kept ${kept}`);
  }

  // Deterministic output: fixed document properties, recalc on open so the
  // prototype formulas render without cached results.
  wb.creator = "rvjp-sanitizer";
  wb.lastModifiedBy = "rvjp-sanitizer";
  wb.created = new Date(Date.UTC(2026, 0, 1));
  wb.modified = new Date(Date.UTC(2026, 0, 1));
  wb.calcProperties.fullCalcOnLoad = true;

  await writeFile(dest, Buffer.from(await wb.xlsx.writeBuffer()));
  console.log(`wrote ${dest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
