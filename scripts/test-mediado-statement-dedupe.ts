/**
 * MediaDo statement-family regression checks (synthetic data only).
 *
 * Guards three behaviors that reproduce the 202606 answer workbook:
 *  1. The monthly folder ships each statement as both `.tsv` and `.tsv.xlsx`;
 *     the twin files must yield strict-key-identical rows so the export-side
 *     cross-upload dedupe keeps exactly one copy per logical row.
 *  2. 完全版-sibling detection is whitespace-insensitive: "作品A【タテヨミ】"
 *     is WR when the folder also holds "作品A [完全版]【タテヨミ】" (note the
 *     space the real statements print before the bracket).
 *  3. Carry/overlay of mediado contract rows: the baseline RS label survives
 *     the statement overlay; the statement's own months are authoritative
 *     (including the statement deposit month — end of settlement + 1, i.e.
 *     sales + 4 months), and a contract row with no statement evidence follows
 *     the mediado cadence policy — explicit zero amounts with sales/deposit
 *     advanced exactly one calendar month from the row's own cadence
 *     (month-end stays month-end).
 *
 * Run: node --import tsx scripts/test-mediado-statement-dedupe.ts
 */
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseMediado } from "../src/features/settlement/lib/parsers/mediado";
import {
  emptyLookupMaps,
  toSalesRecords,
} from "../src/features/settlement/lib/aggregation/to-sales-records";
import {
  dedupeCrossUploadDuplicates,
  strictRecordKey,
} from "../src/features/settlement/lib/aggregation/strict-record-key";
import { mergeCarryForwardRows } from "../src/features/settlement/lib/export/input-v2-carry-forward";

const HEADER = [
  "販売月", "支払先名", "出版者名", "書店会社名", "書店名", "タイトル名称", "巻数",
  "コンテンツ名称", "著者名", "CID", "出版者経理コード", "JDCN", "販売価格", "料率",
  "支払い単価", "DL数", "税抜き金額", "発行形態", "JP-eコード",
];

function tsvRow(title: string, price: number, rate: number, dl: number, taxExcl: number): string[] {
  return [
    "2026-04", "SYNTH", "synth", "書店S", "store-a", title, "1", `${title}（1）`, "author",
    "CID1", "", "", String(price), String(rate), String(price * rate / 100), String(dl),
    String(taxExcl), "タテヨミ", "",
  ];
}

const rows = [
  tsvRow("作品A【タテヨミ】", 100, 40, 3, 120),
  tsvRow("作品A [完全版]【タテヨミ】", 100, 40, 5, 200),
  tsvRow("作品B【タテヨミ】", 200, 35, 2, 140),
];
const tsvText = [HEADER, ...rows].map((r) => r.join("\t")).join("\n");
const tsvBuffer = Buffer.from(tsvText, "utf-8");

const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function main() {
  const [fromTsv, fromXlsx] = await Promise.all([
    parseMediado({
      filename: "202604_BR217_SYNTH_タテヨミ_0000_synth.tsv",
      folderName: "202604_BR217_SYNTH_タテヨミ",
      buffer: tsvBuffer,
    }),
    parseMediado({
      filename: "202604_BR217_SYNTH_タテヨミ_0000_synth.tsv.xlsx",
      folderName: "202604_BR217_SYNTH_タテヨミ",
      buffer: xlsxBuffer,
    }),
  ]);
  assert.equal(fromTsv.errors.length, 0, "tsv parse has no errors");
  assert.equal(fromXlsx.errors.length, 0, "xlsx parse has no errors");
  assert.equal(fromTsv.records.length, 3, "tsv aggregates one row per title");
  assert.equal(fromXlsx.records.length, 3, "xlsx twin aggregates identically");

  // 2. whitespace-insensitive 完全版 sibling typing
  const typeByTitle = new Map(
    fromTsv.records.map((r) => [String(r.data.channel_title_jp), String(r.data.type)]),
  );
  assert.equal(typeByTitle.get("作品A【タテヨミ】"), "WR", "legacy variant with spaced 完全版 sibling is WR");
  assert.equal(typeByTitle.get("作品A [完全版]【タテヨミ】"), "WT", "完全版 edition itself stays WT");
  assert.equal(typeByTitle.get("作品B【タテヨミ】"), "WT", "sibling-less title stays WT");

  // 1. tsv + xlsx twins produce strict-key-identical rows → dedupe keeps one
  const transform = (parsed: typeof fromTsv, uploadId: string) =>
    toSalesRecords(parsed.records, {
      settlement_month: "2026-06-01",
      forceSettlementMonth: true,
      sales_month: parsed.sales_month,
      platform_code: parsed.platform_code,
      lookups: emptyLookupMaps(),
    }).inserts.map((insert) => ({
      ...insert,
      upload_id: uploadId,
      // The export pipeline enriches display identity from template lookups
      // before deduping; dedupe deliberately skips identity-less rows.
      clients: "mediado",
      channel: "mediado_sales",
    }));
  const tsvInserts = transform(fromTsv, "upload-tsv");
  const xlsxInserts = transform(fromXlsx, "upload-xlsx");
  assert.deepEqual(
    tsvInserts.map(strictRecordKey).sort(),
    xlsxInserts.map(strictRecordKey).sort(),
    "twin statements share strict keys",
  );
  const deduped = dedupeCrossUploadDuplicates([...tsvInserts, ...xlsxInserts]);
  assert.equal(deduped.removed, 3, "cross-upload dedupe drops the twin copy");
  assert.equal(deduped.records.length, 3, "one logical row per title survives");

  // 3. carry/overlay keeps contract rs; statement months are authoritative,
  //    evidence-less mediado rows follow the cadence policy (+1 month, zeros)
  const baseline = [
    {
      channel_title_jp: "作品B【タテヨミ】",
      title_jp: "作品B【タテヨミ】",
      clients: "mediado",
      channel: "mediado_sales",
      type: "WT",
      rs: "35/40/45%",
      sales_month: new Date("2026-03-01"),
      deposit_month: new Date("2026-06-30"),
      total_amount_jpy: 111,
    },
    {
      channel_title_jp: "作品C【タテヨミ】",
      title_jp: "作品C【タテヨミ】",
      clients: "mediado",
      channel: "mediado_sales",
      type: "WT",
      rs: "35/40/45%",
      sales_month: new Date("2026-03-01"),
      deposit_month: new Date("2026-06-30"),
      total_amount_jpy: 222,
    },
  ];
  const merged = mergeCarryForwardRows(baseline, deduped.records, "202606");
  assert.equal(merged.overlay_rows >= 1, true, "作品B overlays its contract row");
  const overlaid = merged.records.find(
    (r) => r.channel_title_jp === "作品B【タテヨミ】" && r.type === "WT",
  )!;
  assert.equal(overlaid.rs, "35/40/45%", "overlay preserves the contract rs label");
  assert.equal(iso(overlaid.sales_month), "2026-04-01", "overlay takes the statement sales month");
  assert.equal(
    iso(overlaid.deposit_month),
    "2026-07-31",
    "overlay takes the statement deposit month (end of settlement month)",
  );
  const carried = merged.records.find((r) => r.channel_title_jp === "作品C【タテヨミ】")!;
  assert.equal(iso(carried.sales_month), "2026-04-01", "carried row advances sales one month");
  assert.equal(
    iso(carried.deposit_month),
    "2026-07-31",
    "carried row advances month-end deposit to the next month-end",
  );
  assert.equal(carried.total_amount_jpy, null, "carried row lets the total formula reset");
  assert.equal(carried.after_tax_jpy, 0, "carried row keeps explicit zero raw amounts");
  assert.equal(carried.rs, "35/40/45%", "evidence-less row keeps the contract rs label");

  console.log("OK: mediado statement-family regression passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
