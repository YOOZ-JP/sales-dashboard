/**
 * Privacy-safe synthetic checks for sales/settlement/deposit date alignment
 * (MechaComic, Piccoma, MediaDo, MangaBang), including month/year/leap
 * boundaries. No real titles or amounts.
 * Run: node --import tsx scripts/test-parser-deposit-dates.ts
 */
import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";

import { parseMangabang } from "../src/features/settlement/lib/parsers/mangabang";
import { parseMechacomic } from "../src/features/settlement/lib/parsers/mechacomic";
import { parseMediado } from "../src/features/settlement/lib/parsers/mediado";
import { parsePiccoma } from "../src/features/settlement/lib/parsers/piccoma";

function xlsxBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

function data(result: { records: Array<{ data: Record<string, unknown> }> }) {
  return result.records.map((record) => record.data);
}

async function mechacomicBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const name of ["スマートフォン明細", "アプリ明細"]) {
    const ws = wb.addWorksheet(name);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow(["シリーズ名", "作家名", "書名", "区分", "売上金額", "率", "支払", "種別"]);
  }
  wb.getWorksheet("スマートフォン明細")!.addRow(["Synthetic Vertical", "", "", "", 20, 30, 6, "話(BSF・WT)"]);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function checkMechacomic() {
  const buffer = await mechacomicBuffer();

  // Filename YYYYMM is the sales month; settlement = end of sales + 1 month;
  // deposit = end of sales + 2 months.
  const june = await parseMechacomic({ filename: "RIVERSE_202606.xlsx", buffer });
  assert.equal(june.sales_month, "2026-06-01", "Mecha sales month comes from filename");
  assert.equal(june.settlement_month, "2026-07-31", "Mecha settlement is end of the month after sales");
  assert.equal(data(june)[0].deposit_month, "2026-08-31", "Mecha deposit is end of settlement + 1");

  // Year boundary: December sales settle in January, deposit end of February.
  const december = await parseMechacomic({ filename: "RIVERSE_202612.xlsx", buffer });
  assert.equal(december.settlement_month, "2027-01-31", "Mecha settlement crosses the year boundary");
  assert.equal(data(december)[0].deposit_month, "2027-02-28", "Mecha deposit handles short February");

  // Leap-year February deposit.
  const leap = await parseMechacomic({ filename: "RIVERSE_202312.xlsx", buffer });
  assert.equal(data(leap)[0].deposit_month, "2024-02-29", "Mecha deposit handles leap February");
}

async function checkPiccomaDetailOnly() {
  const header = new Array(17).fill("");
  const detailRow = new Array(17).fill("");
  detailRow[2] = "合成タイトルA";
  detailRow[14] = 100; // 売上(税別)
  detailRow[15] = 0.26; // R/S
  detailRow[16] = 26; // 精算金額(税別)
  const buffer = xlsxBuffer({ "話売精算対象使用件数": [header, detailRow] });

  // 出版社report filename date is the detail report's *sales* month;
  // settlement = sales + 1; deposit = end of settlement + 1.
  const result = await parsePiccoma({ filename: "出版社report_株式会社RIVERSE_20261201_0001.xlsx", buffer });
  assert.equal(result.sales_month, "2026-12-01", "Piccoma detail-only sales month is the filename month");
  assert.equal(result.settlement_month, "2027-01-01", "Piccoma detail-only settlement is sales + 1 across year boundary");
  const parsed = data(result);
  assert.equal(parsed.length, 1, "Piccoma detail-only parses the synthetic row");
  assert.equal(parsed[0].sales_month, "2026-12-01", "Piccoma detail-only record keeps the sales month");
  assert.equal(parsed[0].settlement_month, "2027-01-31", "Piccoma detail-only record settlement is end of sales + 1");
  assert.equal(parsed[0].deposit_month, "2027-02-28", "Piccoma detail-only deposit is end of settlement + 1 (short February)");

  // Leap-year February deposit (sales 2023-12 → settlement 2024-01 → deposit 2024-02-29).
  const leap = await parsePiccoma({ filename: "出版社report_株式会社RIVERSE_20231201_0001.xlsx", buffer });
  assert.equal(data(leap)[0].deposit_month, "2024-02-29", "Piccoma detail-only deposit handles leap February");
}

async function checkPiccomaSummary() {
  const summaryRow = new Array(15).fill(0);
  summaryRow[0] = 1;
  summaryRow[1] = "合成タイトルB";
  summaryRow[2] = 26; // 料率 (%)
  summaryRow[7] = 100; // 精算対象当月売上[話]
  const buffer = xlsxBuffer({
    "227_株式会社RIVERSE": [
      ["", "期間", "2026.12.1", "~", "", "2026.12.31"],
      [],
      new Array(15).fill(""),
      summaryRow,
    ],
  });

  // Summary route: parsed 期間 is the sales month; settlement = sales + 1;
  // deposit = end of the month after settlement.
  const result = await parsePiccoma({ filename: "取次report_株式会社RIVERSE_20270101_v1.xlsx", buffer });
  assert.equal(result.sales_month, "2026-12-01", "Piccoma summary sales month comes from the 期間 row");
  assert.equal(result.settlement_month, "2027-01-01", "Piccoma summary settlement is sales + 1");
  const parsed = data(result);
  assert.equal(parsed.length, 1, "Piccoma summary parses the synthetic row");
  assert.equal(parsed[0].settlement_month, "2027-01-31", "Piccoma summary record settlement is end of sales + 1");
  assert.equal(parsed[0].deposit_month, "2027-02-28", "Piccoma summary deposit is end of settlement + 1 (short February)");
}

async function checkMediado() {
  const headers = ["販売月", "支払先名", "出版者名", "書店会社名", "書店名", "タイトル名称", "巻数", "コンテンツ名称", "著者名", "CID", "出版者経理コード", "JDCN", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", "発行形態", "JP-eコード"];
  const tsv = (month: string) =>
    Buffer.from(
      [
        headers.join("\t"),
        [month, "", "", "", "Store", "Synthetic Book Form", "", "", "", "", "", "", "10", "50", "", "1", "5", "書籍", ""].join("\t"),
      ].join("\n"),
      "utf8",
    );

  // Settlement = end of sales + 3 months; deposit = end of settlement month.
  const november = await parseMediado({
    filename: "202611_BR217_RIVERSE_書籍.tsv",
    folderName: "202611_BR217_RIVERSE_書籍",
    buffer: tsv("2026-11"),
  });
  assert.equal(november.sales_month, "2026-11-01", "MediaDo sales month comes from 販売月");
  assert.equal(november.settlement_month, "2027-02-28", "MediaDo settlement is end of sales + 3 across year boundary");
  assert.equal(data(november)[0].deposit_month, "2027-02-28", "MediaDo deposit is end of settlement month");

  // Leap-year February settlement (sales 2027-11 → settlement 2028-02-29).
  const leap = await parseMediado({
    filename: "202711_BR217_RIVERSE_書籍.tsv",
    folderName: "202711_BR217_RIVERSE_書籍",
    buffer: tsv("2027-11"),
  });
  assert.equal(leap.settlement_month, "2028-02-29", "MediaDo settlement handles leap February");
  assert.equal(data(leap)[0].deposit_month, "2028-02-29", "MediaDo deposit preserves leap settlement end");
}

async function checkMangabang() {
  const headers = ["年月", "出版社", "タイトル名", "話", "販売件数", "単価（税込）", "単価（税抜）", "総収益", "総収益（税抜）", "版権料率", "版権元収益（税込）", "巻番号", "管理コード"];
  const csv = (yearMonth: string) =>
    iconv.encode(
      [
        ",,,,,,,110,,,38.5,,",
        headers.join(","),
        [yearMonth, "Synthetic社", "合成タイトルC", "1", "1", "110", "100", "110", "100", "35", "38.5", "", ""].join(","),
      ].join("\n"),
      "shift_jis",
    );

  // Filename YYYYMM is the sales month; settlement = sales + 1;
  // deposit = end of that settlement month.
  const december = await parseMangabang({
    filename: "mangabang_RIVERSE_ticket_202612.csv",
    buffer: csv("2026年12月"),
  });
  assert.equal(december.sales_month, "2026-12-01", "MangaBang sales month comes from filename");
  assert.equal(december.settlement_month, "2027-01-01", "MangaBang settlement is sales + 1 across year boundary");
  const parsed = data(december);
  assert.equal(parsed.length, 1, "MangaBang parses the synthetic row");
  assert.equal(parsed[0].deposit_month, "2027-01-31", "MangaBang deposit is end of settlement month");

  // Year-boundary settlement end (sales 2023-12 → settlement 2024-01-31).
  const leap = await parseMangabang({
    filename: "mangabang_RIVERSE_ticket_202312.csv",
    buffer: csv("2023年12月"),
  });
  assert.equal(data(leap)[0].deposit_month, "2024-01-31", "MangaBang deposit preserves settlement month end");
}

async function main() {
  await checkMechacomic();
  await checkPiccomaDetailOnly();
  await checkPiccomaSummary();
  await checkMediado();
  await checkMangabang();
  console.log("test-parser-deposit-dates: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
