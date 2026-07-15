import assert from "node:assert/strict";

import * as XLSX from "xlsx";

import {
  classifyIchijinshaInvoiceItem,
  expandIchijinshaVolumeRange,
  parseIchijinsha,
  parseIchijinshaDetailText,
} from "../src/features/settlement/lib/parsers/ichijinsha";
import { toNumber } from "../src/features/settlement/lib/parsers/common";
import { normalizeSbWorkKey } from "../src/features/settlement/lib/parsers/sb-creative";
import { dedupeShueishaRows, normalizeShueishaTitle } from "../src/features/settlement/lib/parsers/shueisha";

// --- Ichijinsha invoice-content classification (semantic, before cleanup) ---

const ebRange = classifyIchijinshaInvoiceItem("「合成義家族」第7～9巻（電子）");
assert.equal(ebRange.type, "EB");
assert.equal(ebRange.item_kind, "electronic");
assert.equal(ebRange.base_title, "合成義家族");
assert.equal(ebRange.volume_start, 7);
assert.equal(ebRange.volume_end, 9);
assert.equal(ebRange.raw_title, "「合成義家族」第7～9巻（電子）", "raw title preserved through classification");

const mfRange = classifyIchijinshaInvoiceItem("「合成義家族」第7～9巻（素材費）");
assert.equal(mfRange.type, "MF");
assert.equal(mfRange.item_kind, "material_fee");

const ppSingle = classifyIchijinshaInvoiceItem("「合成義家族」第7巻（単行本）");
assert.equal(ppSingle.type, "PP");
assert.equal(ppSingle.item_kind, "paper_book");
assert.equal(ppSingle.volume_start, 7);
assert.equal(ppSingle.volume_end, 7);

const anniversary = classifyIchijinshaInvoiceItem("「合成タイトル」", { anniversary: true });
assert.equal(anniversary.type, "MF");
assert.equal(anniversary.item_kind, "manuscript_fee");
assert.equal(anniversary.base_title, "合成タイトル");

// --- Ichijinsha volume-range expansion: sum preservation + mismatch error ---

const expanded = expandIchijinshaVolumeRange(ebRange, {
  quantity: 3,
  unit_price_jpy: 200000,
  line_total_jpy: 600001,
});
assert.ok("rows" in expanded, "valid range expands");
assert.deepEqual(
  expanded.rows.map((r) => r.amount_jpy),
  [200000, 200000, 200001],
  "unit price first, remainder on last volume",
);
assert.equal(
  expanded.rows.reduce((s, r) => s + r.amount_jpy, 0),
  600001,
  "expanded sum equals source line total",
);

const mismatch = expandIchijinshaVolumeRange(ebRange, {
  quantity: 2,
  unit_price_jpy: 200000,
  line_total_jpy: 600000,
});
assert.ok("error" in mismatch, "range length ≠ 数量 is a parser error, not silent");

// --- Ichijinsha 詳細別送の内訳 flattened-text parser (deterministic, no AI) ---

const detailText = [
  "株式会社一迅社 支払通知書 詳細別送の内訳",
  "国内電子 合成タイトルA 集計期間：2026年4月～2026年6月 976,473",
  "国内電子 合成タイトルB 集計期間：2026年6月 660,451",
  "国内電子 合成タイトルC 集計期間：2026年6月 241,547",
  "国内電子 合成タイトルD 集計期間：2026年6月 111,644",
  "国内電子 合成タイトルE 集計期間：2026年6月 66,109",
  "国内電子 合成タイトルF 集計期間：2026年6月 49,034",
  "国内電子 合成タイトルG 集計期間：2026年6月 13,868",
  "国内電子 合成タイトルH 集計期間：2026年6月 -191,452",
  "国内電子 合成タイトルH(2) 集計期間：2026年6月 1,267",
  "国内電子 合成タイトルA（６） 集計期間：2026年6月 729,539",
  "国内電子 合成タイトルH(2)(MG) 集計期間：2026年6月 -500",
  "国内電子 合成タイトルA(6)（MG） 集計期間：2026年6月 -29,539",
].join(" ");

const detail = parseIchijinshaDetailText(detailText);
assert.deepEqual(detail.errors, [], "clean detail text parses without errors");
assert.equal(detail.rows.length, 10, "12 source rows (10 normal + 2 MG offsets) merge to 10 EB rows");
const byTitle = new Map(detail.rows.map((r) => [r.title, r]));
assert.equal(byTitle.get("合成タイトルH（２）")?.amount_taxexcl, 767, "MG offset merges by title+volume key despite non-adjacency");
assert.equal(byTitle.get("合成タイトルA（６）")?.amount_taxexcl, 700000, "second MG offset merges across paren styles");
assert.equal(byTitle.get("合成タイトルH")?.amount_taxexcl, -191452, "signed amounts preserved; volume rows never merge into the bare title");
assert.equal(byTitle.get("合成タイトルA")?.sales_month, "2026-06-01", "period range keeps the final year/month");
assert.equal(byTitle.get("合成タイトルB")?.sales_month, "2026-06-01", "single-month period parses");

const emptyDetail = parseIchijinshaDetailText("支払通知書 表紙のみ 合計 1,000,000");
assert.equal(emptyDetail.rows.length, 0);
assert.ok(
  emptyDetail.errors.some((e) => e.includes("zero detail rows")),
  "zero detail rows is an explicit parser error",
);

const unmatchedMg = parseIchijinshaDetailText(
  "国内電子 合成タイトルX 集計期間：2026年6月 100 国内電子 合成タイトルY(3)(MG) 集計期間：2026年6月 -50",
);
assert.ok(
  unmatchedMg.errors.some((e) => e.includes("MG offset")),
  "unmatched MG offset is an explicit parser error",
);

assert.equal(toNumber({ v: 495000, f: "J15*K15*L15" }), 495000, "XLSX formula cached values parse");
assert.equal(toNumber({ result: 1234, formula: "A1" }), 1234, "ExcelJS formula results parse");

assert.equal(normalizeSbWorkKey("합성작품（コミック）２【分冊版】（1話～9話）").seriesKey, "합성작품");
assert.equal(normalizeSbWorkKey("합성작품（コミック）２【分冊版】（1話～9話）").volumeKey, "2");

assert.equal(normalizeShueishaTitle("합성작품（広告）"), "합성작품");
assert.equal(normalizeShueishaTitle("합성작품(話配信)"), "합성작품");
const deduped = dedupeShueishaRows([
  { title: "합성작품（広告）", payment_taxincl: 110 },
  { title: "합성작품(広告)", payment_taxincl: 110 },
  { title: "합성작품(広告)", payment_taxincl: 220 },
]);
assert.equal(deduped.length, 2, "same logical source row dedupes but different payment remains");

// --- Ichijinsha synthetic invoice XLSX end-to-end (retag + expansion path) ---

function invoiceXlsxBuffer(subject: string, items: Array<[string, number, number, number]>): Buffer {
  const rows: unknown[][] = [
    [`件名：${subject}`],
    ["№", "内容", "単価", "数量", "金額"],
    ...items.map(([content, unit, qty, amount], i) => [i + 1, content, unit, qty, amount]),
    ["", "振込先：合成銀行"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "請求書");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

function typeCounts(rows: Array<Record<string, unknown>>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.type)] = (acc[String(row.type)] ?? 0) + 1;
    return acc;
  }, {});
}

async function checkIchijinshaInvoices() {
  // Anniversary manuscript-detail XLSX: all 4 line items stay MF details —
  // no quantity-based summary promotion, no title-only dedupe.
  const annivResult = await parseIchijinsha({
    filename: "【請求書】一迅社様_20周年記念イラスト原稿料_202606.xlsx",
    buffer: invoiceXlsxBuffer("一迅社20周年記念イラスト原稿料", [
      ["「合成タイトルA」", 20000, 3, 60000],
      ["「合成タイトルB」", 20000, 3, 60000],
      ["「合成タイトルC」", 20000, 2, 40000],
      ["「合成タイトルD」", 20000, 3, 60000],
    ]),
  });
  const anniv = annivResult.records.map((r) => r.data);
  assert.equal(anniv.length, 4, "anniversary XLSX keeps all 4 detail rows");
  assert.deepEqual(typeCounts(anniv), { MF: 4 }, "anniversary details are MF");
  assert.equal(anniv.filter((row) => row.is_summary === true).length, 0, "XLSX line items never become summary");
  const qty2 = anniv.find((row) => row.channel_title_jp === "合成タイトルC（20th色紙原稿料）");
  assert.equal(qty2?.after_tax_jpy, 40000, "quantity<3 row survives as a normal detail row");
  assert.ok(
    anniv.every((row) => String(row.channel_title_jp).endsWith("（20th色紙原稿料）")),
    "anniversary MF details carry the structural （20th色紙原稿料） suffix",
  );

  // Minimum-guarantee XLSX: 3 paper singles → PP, electronic range → EB×3,
  // material-cost range → MF×3; same base title across volumes/types survives.
  const mgResult = await parseIchijinsha({
    filename: "【請求書】一迅社様_最低保証印税_202606.xlsx",
    buffer: invoiceXlsxBuffer("最低保証印税（2026年6月度）", [
      ["「合成義家族」第7巻（単行本）", 990, 5000, 495000],
      ["「合成義家族」第8巻（単行本）", 990, 5000, 495000],
      ["「合成義家族」第9巻（単行本）", 990, 5000, 495000],
      ["「合成義家族」第7～9巻（電子）", 200000, 3, 600000],
      ["「合成義家族」第7～9巻（素材費）", 150000, 3, 450000],
    ]),
  });
  const mg = mgResult.records.map((r) => r.data);
  assert.equal(mgResult.errors.length, 0, `minimum-guarantee XLSX parses cleanly: ${mgResult.errors.join("; ")}`);
  assert.equal(mg.length, 9, "5 source rows expand to 9 INPUT detail rows");
  assert.deepEqual(typeCounts(mg), { EB: 3, MF: 3, PP: 3 }, "PP3 / EB3 / MF3 distribution");
  assert.equal(mg.filter((row) => row.is_summary === true).length, 0, "no summary promotion for XLSX details");

  const keys = mg.map((row) => `${row.channel_title_jp}|${row.type}`).sort();
  assert.equal(new Set(keys).size, 9, "same base title with different volume/type is preserved");
  for (const vol of ["７", "８", "９"]) {
    assert.ok(keys.includes(`合成義家族（${vol}）|PP`), `PP volume ${vol} present`);
    assert.ok(keys.includes(`合成義家族（${vol}）|EB`), `EB volume ${vol} present`);
    assert.ok(keys.includes(`合成義家族（${vol}）|MF`), `MF volume ${vol} present`);
  }
  const ebRows = mg.filter((row) => row.type === "EB");
  assert.deepEqual(ebRows.map((row) => row.after_tax_jpy), [200000, 200000, 200000], "EB range allocates by unit price");
  assert.equal(
    ebRows.reduce((s, row) => s + Number(row.after_tax_jpy), 0),
    600000,
    "EB expansion preserves the source line total",
  );
  const mfRows = mg.filter((row) => row.type === "MF");
  assert.equal(
    mfRows.reduce((s, row) => s + Number(row.after_tax_jpy), 0),
    450000,
    "MF expansion preserves the source line total",
  );

  // Range length vs 数量 mismatch: parser error, source row kept unexpanded.
  const badResult = await parseIchijinsha({
    filename: "【請求書】一迅社様_最低保証印税_202606.xlsx",
    buffer: invoiceXlsxBuffer("最低保証印税（2026年6月度）", [
      ["「合成義家族」第7～9巻（電子）", 200000, 2, 600000],
    ]),
  });
  assert.ok(
    badResult.errors.some((e) => e.includes("数量")),
    "quantity/range-length mismatch surfaces as parser error",
  );
  assert.equal(badResult.records.length, 1, "mismatched range row is kept unexpanded");
}

checkIchijinshaInvoices()
  .then(() => console.log("test-parser-repair-phase-b: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
