import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_GOLDEN = path.resolve(
  "src/features/settlement/data/templates/input_jp_2026_2605_golden.xlsx",
);
const DEFAULT_REPORT = path.resolve(
  "tmp_2605_analysis/input_jp_golden_compare_report.json",
);
const INPUT_SHEET = "input_電子_5月";
const HEADER_ROWS = [4, 5] as const;
const FIRST_DATA_ROW = 6;
const LAST_STRUCTURE_COL = 97; // A:BY

type FindingLevel = "PASS" | "WARN" | "FAIL";

type Finding = {
  level: FindingLevel;
  check: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
};

type WorkbookSummary = {
  sheets: string[];
  input?: {
    rowCount: number;
    columnCount: number;
    actualRowCount: number;
    autoFilter: string | null;
    freezePanes: string | null;
    hiddenRow3: boolean;
    nonEmptyBRows: number;
    headers: Record<string, string>;
    formulaCountsByColumn: Record<string, number>;
  };
};

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("formula" in value && typeof value.formula === "string") {
      return `=${value.formula}`;
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("richText" in value) return JSON.stringify(value.richText);
    return JSON.stringify(value);
  }
  return String(value);
}

function cellFormula(value: unknown): string | null {
  if (value && typeof value === "object" && "formula" in value) {
    const formula = value.formula;
    return typeof formula === "string" ? formula : null;
  }
  return null;
}

function normalizeFormula(formula: string): string {
  return formula.replace(/(?<![$A-Z])([A-Z]{1,3})(\d+)/g, (_match, col: string) => `${col}#`);
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

function summarizeWorkbook(workbook: ExcelJS.Workbook): WorkbookSummary {
  const summary: WorkbookSummary = {
    sheets: workbook.worksheets.map((sheet) => sheet.name),
  };
  const sheet = workbook.getWorksheet(INPUT_SHEET);
  if (!sheet) return summary;

  const headers: Record<string, string> = {};
  for (const rowNumber of HEADER_ROWS) {
    for (let col = 1; col <= LAST_STRUCTURE_COL; col += 1) {
      const cell = sheet.getRow(rowNumber).getCell(col);
      const letter = cell.address.replace(String(rowNumber), "");
      headers[`${letter}${rowNumber}`] = stringifyCell(cell.value);
    }
  }

  let nonEmptyBRows = 0;
  const formulaCountsByColumn: Record<string, number> = {};
  for (let row = FIRST_DATA_ROW; row <= sheet.rowCount; row += 1) {
    if (stringifyCell(sheet.getRow(row).getCell(2).value) !== "") nonEmptyBRows += 1;
    for (let col = 1; col <= LAST_STRUCTURE_COL; col += 1) {
      const cell = sheet.getRow(row).getCell(col);
      const formula = cellFormula(cell.value);
      if (!formula) continue;
      const letter = cell.address.replace(String(row), "");
      const key = `${letter}:${normalizeFormula(formula)}`;
      formulaCountsByColumn[key] = (formulaCountsByColumn[key] ?? 0) + 1;
    }
  }

  summary.input = {
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    actualRowCount: sheet.actualRowCount,
    autoFilter: sheet.autoFilter ? String(sheet.autoFilter) : null,
    freezePanes: sheet.views[0]?.state === "frozen" ? JSON.stringify(sheet.views[0]) : String(sheet.views[0] ?? null),
    hiddenRow3: sheet.getRow(3).hidden === true,
    nonEmptyBRows,
    headers,
    formulaCountsByColumn,
  };
  return summary;
}

function addFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function compareRecord(
  findings: Finding[],
  check: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): void {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches: Array<{ key: string; expected: unknown; actual: unknown }> = [];
  for (const key of keys) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      mismatches.push({ key, expected: expected[key], actual: actual[key] });
    }
  }
  addFinding(findings, {
    level: mismatches.length === 0 ? "PASS" : "FAIL",
    check,
    message: mismatches.length === 0 ? "matched" : `${mismatches.length} mismatches`,
    expected: mismatches.length === 0 ? undefined : mismatches.slice(0, 50),
  });
}

async function main(): Promise<void> {
  const candidatePath = process.argv[2];
  const goldenPath = process.argv[3] ?? DEFAULT_GOLDEN;
  const reportPath = process.argv[4] ?? DEFAULT_REPORT;

  if (!candidatePath) {
    throw new Error(
      "Usage: tsx scripts/compare-input-jp-golden.ts <candidate.xlsx> [golden.xlsx] [report.json]",
    );
  }

  const [goldenWorkbook, candidateWorkbook] = await Promise.all([
    loadWorkbook(goldenPath),
    loadWorkbook(candidatePath),
  ]);
  const golden = summarizeWorkbook(goldenWorkbook);
  const candidate = summarizeWorkbook(candidateWorkbook);
  const findings: Finding[] = [];

  addFinding(findings, {
    level: JSON.stringify(golden.sheets) === JSON.stringify(candidate.sheets) ? "PASS" : "FAIL",
    check: "sheet_names_order",
    message: "Workbook sheet names/order match golden",
    expected: golden.sheets,
    actual: candidate.sheets,
  });

  if (!golden.input || !candidate.input) {
    addFinding(findings, {
      level: "FAIL",
      check: "input_sheet_exists",
      message: `${INPUT_SHEET} must exist in both workbooks`,
      expected: Boolean(golden.input),
      actual: Boolean(candidate.input),
    });
  } else {
    addFinding(findings, {
      level: golden.input.nonEmptyBRows === candidate.input.nonEmptyBRows ? "PASS" : "FAIL",
      check: "input_nonempty_b_rows",
      message: "Main input data row count by B column",
      expected: golden.input.nonEmptyBRows,
      actual: candidate.input.nonEmptyBRows,
    });
    compareRecord(
      findings,
      "input_sheet_structure",
      {
        rowCount: golden.input.rowCount,
        columnCount: golden.input.columnCount,
        autoFilter: golden.input.autoFilter,
        hiddenRow3: golden.input.hiddenRow3,
      },
      {
        rowCount: candidate.input.rowCount,
        columnCount: candidate.input.columnCount,
        autoFilter: candidate.input.autoFilter,
        hiddenRow3: candidate.input.hiddenRow3,
      },
    );
    compareRecord(findings, "input_headers_rows_4_5", golden.input.headers, candidate.input.headers);
    compareRecord(
      findings,
      "input_formula_patterns_by_column",
      golden.input.formulaCountsByColumn,
      candidate.input.formulaCountsByColumn,
    );
  }

  const failed = findings.filter((finding) => finding.level === "FAIL").length;
  const warned = findings.filter((finding) => finding.level === "WARN").length;
  const status = failed > 0 ? "FAIL" : warned > 0 ? "PARTIAL" : "PASS";
  const report = {
    status,
    goldenPath,
    candidatePath,
    generatedAt: new Date().toISOString(),
    note: "Amounts are intentionally not printed; this is a structural/formula golden comparison.",
    findings,
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`status=${status}`);
  console.log(`findings=${findings.length} failed=${failed} warned=${warned}`);
  console.log(`report=${reportPath}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
