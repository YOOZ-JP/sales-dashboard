/**
 * Privacy-safe synthetic checks for parser repair phase A.
 * Run: node --import tsx scripts/test-parser-repair-phase-a.ts
 */
import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";

import { parseDmm } from "../src/features/settlement/lib/parsers/dmm";
import { parseLineAd } from "../src/features/settlement/lib/parsers/line-ad";
import { parseLineEbj } from "../src/features/settlement/lib/parsers/line-ebj";
import { parseMbj } from "../src/features/settlement/lib/parsers/mbj";
import { parseMechacomic } from "../src/features/settlement/lib/parsers/mechacomic";
import { parseMediado } from "../src/features/settlement/lib/parsers/mediado";

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


async function checkDmm() {
  const header = ["集計期間", "カテゴリ", "コンテンツID", "書籍コード", "商品タイトル", "作家名", "メーカー名", "レーベル名", "件数", "売上金額"];
  const buffer = xlsxBuffer({
    "ﾌﾞｯｸｽ(一般)": [
      header,
      ["", "", "", "", "Synthetic Zero 1", "", "", "", 1, 0],
      ["", "", "", "", "Synthetic Blank 2", "", "", "", 1, ""],
      ["", "", "", "", "Synthetic Positive 3", "", "", "", 1, 10],
    ],
    "ﾌﾞｯｸｽ(ｱﾀﾞﾙﾄ)": [header],
  });

  const result = await parseDmm({ filename: "2606_synthetic.xlsx", buffer });
  const rows = data(result);
  assert.equal(rows.length, 3, "DMM keeps zero/blank sales groups");
  assert.equal(rows.filter((row) => row.after_tax_jpy === 0).length, 2, "DMM preserves zero-value rows");
  assert.equal(rows[0].total_amount_jpy, null, "DMM leaves W for workbook formula");
  assert.equal(rows[0].before_tax_income_jpy, null, "DMM leaves Z for workbook formula");
  assert.equal(rows[0].consumption_tax_jpy, null, "DMM leaves AB for workbook formula");
}

async function checkLineEbj() {
  const headers = [
    "書店名",
    "タイトルID",
    "商品コード",
    "SKU",
    "出版社名",
    "販売単位区分",
    "サービス区分",
    "タイトル名",
    "表示用刊行物名",
    "刊行物名",
    "著者名",
    "販売数計",
    "単価(税抜)",
    "単価(税込)",
    "販売額計",
    "許諾料(単価)",
    "許諾額計",
  ];
  const rows = [
    headers.join(","),
    ["LINEマンガ(APP)", "", "", "", "Publisher", "単話", "買いきり", "Synthetic Vertical【タテヨミ】", "", "", "Author", "1", "", "", "10", "", "5"].join(","),
    ["ebookjapan(web)", "", "", "", "Publisher", "単話", "買いきり", "Synthetic Novel（ノベル）", "Synthetic Novel（ノベル）", "", "Author", "1", "", "", "0", "", "0"].join(","),
  ].join("\n");
  const buffer = iconv.encode(rows, "shift_jis");

  const result = await parseLineEbj({ filename: "ExportCSV_PaymentReport_1_EpiVol_CSV_WEB.20260701000000000.csv", buffer });
  const parsed = data(result);
  assert.equal(parsed.length, 2, "LINE/EBJ keeps zero rows");
  assert.equal(parsed.find((row) => row.channel_code === "ebj_webtoon")?.type, "WN", "EBJ novel evidence resolves WN");
  assert.equal(parsed.find((row) => row.channel_code === "line")?.type, "WT", "LINE vertical row remains WT");
  assert.equal(parsed[0].total_amount_jpy, null, "LINE/EBJ leaves W for workbook formula");
  assert.equal(parsed[0].after_tax_income_jpy, 5, "LINE/EBJ AC is tax-exclusive royalty");

  // Date propagation: settlement 2026-07 → LINE lags 2 months, ebookjapan 1 month,
  // deposit is the end of the month after settlement. No titles or hardcoded exceptions involved.
  assert.equal(result.settlement_month, "2026-07-01", "LINE/EBJ settlement month comes from filename");
  assert.equal(parsed.find((row) => row.channel_code === "line")?.sales_month, "2026-05-01", "LINE channel sales month is settlement - 2");
  assert.equal(parsed.find((row) => row.channel_code === "ebj_webtoon")?.sales_month, "2026-06-01", "ebookjapan channel sales month is settlement - 1");
  assert.equal(parsed.every((row) => row.deposit_month === "2026-08-31"), true, "LINE/EBJ deposit month is end of settlement + 1");

  // Year-boundary safety for the calendar-month shifts (Feb 2026 has 28 days).
  const january = await parseLineEbj({ filename: "ExportCSV_PaymentReport_1_EpiVol_CSV_WEB.20260101000000000.csv", buffer });
  const janParsed = data(january);
  assert.equal(janParsed.find((row) => row.channel_code === "line")?.sales_month, "2025-11-01", "LINE channel sales month crosses year boundary");
  assert.equal(janParsed.find((row) => row.channel_code === "ebj_webtoon")?.sales_month, "2025-12-01", "ebookjapan channel sales month crosses year boundary");
  assert.equal(janParsed[0].deposit_month, "2026-02-28", "LINE/EBJ deposit end-of-month handles short February");

  // Leap-year February deposit.
  const leap = await parseLineEbj({ filename: "ExportCSV_PaymentReport_1_EpiVol_CSV_WEB.20240101000000000.csv", buffer });
  assert.equal(data(leap)[0].deposit_month, "2024-02-29", "LINE/EBJ deposit end-of-month handles leap February");
}

async function checkLineAd() {
  const headers = ["帳票No", "顧客コード", "顧客名", "お支払内容", "対象期間", "通知日付", "支払期日", "税抜金額(10%)", "税抜金額(対象外)", "消費税(10%)", "源泉税", "合計金額", "備考", "報告年月", "商品ID", "コード", "タイトル", "販売形式", "販売地域", "売上額(基準額)", "配分料率", "支払額"];
  const rows = [
    headers.join(","),
    ["R1", "N1", "RIVERSE", "広告印税", "2026/02/01-2026/02/28", "2026/03/31", "2026/04/30", "100", "0", "10", "0", "110", "", "2026/02", "P1", "", "Synthetic Ad Title", "videoad", "JP", "100", "20.00%", "20"].join(","),
  ].join("\n");
  const buffer = iconv.encode(rows, "shift_jis");

  const result = await parseLineAd({ filename: "20260331_N1_R1_N1_(株)RIVERSE様.csv", buffer });
  const parsed = data(result);
  assert.equal(parsed.length, 1, "LINE Ad parses the synthetic row");
  assert.equal(parsed[0].sales_month, "2026-02-01", "LINE Ad sales month comes from 報告年月");
  assert.equal(parsed[0].pay_due, "2026-04-30", "LINE Ad keeps the raw 支払期日 date");
  assert.equal(parsed[0].deposit_month, "2026-04-30", "LINE Ad deposit month is the raw 支払期日 date");
  assert.equal(result.settlement_month, "2026-03-01", "LINE Ad settlement month stays filename-derived");
}

async function checkMbj() {
  const header = ["書籍code", "SKU", "クレジット", "カテゴリ", "区分", "タイトル", "著者名", "フォーマット", "販売単価", "分配料率", "分配単価", "売上冊数", "売上金額", "支払金額"];
  const buffer = xlsxBuffer({
    Sheet1: [
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      header,
      ["1", "", "", "", "", "Synthetic WT第1話", "", "webtoon", "", 0.5, "", "", 10, 5],
      ["2", "", "", "", "", "Synthetic WT第2話", "", "webtoon", "", 0.5, "", "", 20, 10],
      ["3", "", "", "", "", "Synthetic WR第1話", "", "webtoon WR", "", 0.5, "", "", 7, 3],
      ["4", "", "", "", "", "Synthetic EP【分冊版】第1話", "", "EPUB 3", "", 0.5, "", "", 6, 2],
      ["5", "", "", "", "", "Synthetic EB（１）", "", "EPUB 3", "", 0.5, "", "", 8, 4],
      ["合計"],
    ],
  });

  const result = await parseMbj({ filename: "416829-202608-LI-00000Synthetic-都度-202606.xls", buffer });
  const parsed = data(result);
  const typeCounts = parsed.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.type)] = (acc[String(row.type)] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(typeCounts, { EB: 1, EP: 1, WT: 2 }, "MBJ treats authoritative webtoon format as WT before WR/title markers");
  assert.equal(parsed.find((row) => row.type === "WT")?.after_tax_jpy, 30, "MBJ aggregates webtoon before episode marker");
  assert.equal(parsed[0].total_amount_jpy, null, "MBJ leaves W for workbook formula");
  assert.equal(parsed[0].after_tax_income_jpy, 15, "MBJ AC is tax-exclusive payment");
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
  wb.getWorksheet("スマートフォン明細")!.addRows([
    ["Synthetic Novel", "", "", "ノベル", 10, 30, 3, "書籍"],
    ["Synthetic Vertical", "", "", "", 20, 30, 6, "話(BSF・WT)"],
    ["Synthetic Part【分冊版】", "", "", "", 30, 30, 9, "巻"],
    ["Synthetic Volume", "", "", "", 40, 30, 12, "巻"],
    ["Synthetic Revised 改訂版", "", "", "", 50, 30, 15, "巻"],
    ["Synthetic Vertical Revised 改訂版", "", "", "", 60, 30, 18, "話(BSF・WT)"],
  ]);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function checkMechacomic() {
  const result = await parseMechacomic({ filename: "RIVERSE_202606.xlsx", buffer: await mechacomicBuffer() });
  const parsed = data(result);
  const typeCounts = parsed.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.type)] = (acc[String(row.type)] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(typeCounts, { EB: 1, EP: 1, WN: 1, WR: 2, WT: 1 }, "Mecha preserves revised-edition contract precedence over coarse kind");
  assert.equal(
    parsed.find((row) => row.title_jp === "Synthetic Vertical Revised 改訂版")?.type,
    "WR",
    "Mecha 改訂版 contract marker outranks coarse 話 kind",
  );
  assert.equal(
    parsed.find((row) => row.title_jp === "Synthetic Revised 改訂版")?.type,
    "WR",
    "Mecha 改訂版 without explicit 話 kind still resolves WR",
  );
  const wn = parsed.find((row) => row.type === "WN")!;
  assert.equal(wn.after_tax_income_jpy, 3, "Mecha AC is raw payment");
  assert.equal(wn.before_tax_income_jpy, 3, "Mecha Z follows floor payment gross-up evidence");
  assert.equal(wn.total_amount_jpy, null, "Mecha leaves W for workbook formula");
  assert.equal(wn.consumption_tax_jpy, null, "Mecha leaves AB for workbook formula");
}

async function checkMediado() {
  const headers = ["販売月", "支払先名", "出版者名", "書店会社名", "書店名", "タイトル名称", "巻数", "コンテンツ名称", "著者名", "CID", "出版者経理コード", "JDCN", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", "発行形態", "JP-eコード"];
  const rows = [
    headers.join("\t"),
    ["2026-06", "", "", "", "Store", "Synthetic Blank Form", "", "", "", "", "", "", "0", "50", "", "0", "0", "", ""].join("\t"),
    ["2026-06", "", "", "", "Store", "Synthetic Book Form", "", "", "", "", "", "", "10", "50", "", "1", "5", "書籍", ""].join("\t"),
    ["2026-06", "", "", "", "Store", "Synthetic Special Form", "", "", "", "", "", "", "10", "60", "", "1", "6", "特殊", ""].join("\t"),
  ].join("\n");

  const result = await parseMediado({
    filename: "202606_BR217_RIVERSE_書籍.tsv",
    folderName: "202606_BR217_RIVERSE_書籍",
    buffer: Buffer.from(rows, "utf8"),
  });
  const parsed = data(result);
  assert.equal(parsed.length, 3, "MediaDo keeps blank/special 発行形態 rows with titles");
  assert.equal(parsed.filter((row) => row.after_tax_jpy === 0).length, 1, "MediaDo preserves zero rows");
  assert.equal(parsed.every((row) => row.type === "EB"), true, "MediaDo maps 書籍 evidence explicitly");
  assert.equal(parsed[0].rs_label, "50%", "MediaDo retains textual RS labels");
  assert.equal(parsed[0].before_tax_income_jpy, null, "MediaDo leaves Z for workbook formula");
  assert.equal(parsed[0].after_tax_income_jpy, 0, "MediaDo AC is tax-exclusive payment");
}

async function main() {
  await checkDmm();
  await checkLineEbj();
  await checkLineAd();
  await checkMbj();
  await checkMechacomic();
  await checkMediado();
  console.log("test-parser-repair-phase-a: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
