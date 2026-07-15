/**
 * Unit checks for the SB Creative work+volume identity and sales-report
 * aggregation. Uses synthetic labels/amounts only — no real titles.
 * Run: node --import tsx scripts/test-sb-creative-title.ts
 */
import assert from "node:assert/strict";

import {
  aggregateSbSalesReport,
  canonicalSbVolumeTitle,
  classifySbSourceFile,
  normalizeSbWorkKey,
  parseSbCreative,
  parseSbSalesReportText,
} from "../src/features/settlement/lib/parsers/sb-creative";

// ── normalizeSbWorkKey ──────────────────────────────────────────────────────

// Normal edition with trailing volume digit (fullwidth folds via NFKC).
{
  const key = normalizeSbWorkKey("作品Ａ（コミック）２");
  assert.equal(key.seriesKey, "作品a", "NFKC folds fullwidth letters/digits");
  assert.equal(key.volumeKey, "2", "volume preserved from trailing digit");
}

// 分冊版 with volume + episode range → same key as the normal edition.
{
  const normal = normalizeSbWorkKey("作品X（コミック）１");
  const split = normalizeSbWorkKey("作品X（コミック）１【分冊版】（1話～10話）");
  const splitAlt = normalizeSbWorkKey("作品X１【分冊版】（コミック）(1話～9話）");
  const bare = normalizeSbWorkKey("作品X１【分冊版】（コミック）1話～7話");
  for (const k of [split, splitAlt, bare]) {
    assert.equal(k.seriesKey, normal.seriesKey, "split rows share the series key");
    assert.equal(k.volumeKey, normal.volumeKey, "split rows preserve the volume");
  }
}

// 第N巻 + corner brackets + whitespace variants (invoice-style labels).
{
  const key = normalizeSbWorkKey("「作品Y」  第4巻（単行本）");
  assert.equal(key.seriesKey, "作品y");
  assert.equal(key.volumeKey, "4");
}

// Canonical workbook form round-trips: 作品Z（３） → same key again.
{
  const key = normalizeSbWorkKey("作品Z（コミック）３");
  assert.equal(key.volumeKey, "3");
  const title = canonicalSbVolumeTitle(key.seriesLabel, key.volumeKey!);
  assert.equal(title, "作品Z（３）", "canonical title uses fullwidth digits");
  const reparsed = normalizeSbWorkKey(title);
  assert.equal(reparsed.seriesKey, key.seriesKey, "canonical title reparses to same series");
  assert.equal(reparsed.volumeKey, key.volumeKey, "canonical title reparses to same volume");
}

// Volume-less split row → null volume, no invented identity.
assert.equal(
  normalizeSbWorkKey("作品W【分冊版】（コミック）(1話～8話）").volumeKey,
  null,
  "volume-less split row has null volume",
);

// ── aggregateSbSalesReport ──────────────────────────────────────────────────

// Two synthetic families → exactly four work+volume EB keys:
//   family A: volumes 1 (normal + split, 2 rows), 2 (1 row), 3 (multi-price, 2 rows)
//   family B: volume 1 (2 price rows + 1 volume-less split row bound uniquely)
const DETAIL = [
  { title: "作品A（コミック）１", royalty_taxincl: 5000 },
  { title: "作品A（コミック）１【分冊版】（1話～10話）", royalty_taxincl: 500 },
  { title: "作品A（コミック）２", royalty_taxincl: 3000 },
  { title: "作品A（コミック）３", royalty_taxincl: 2000 },
  { title: "作品A（コミック）３", royalty_taxincl: 1000 },
  { title: "作品B（コミック）１", royalty_taxincl: 9000 },
  { title: "作品B（コミック）１", royalty_taxincl: 800 },
  { title: "作品B【分冊版】（コミック）(1話～8話）", royalty_taxincl: 200 },
  { title: "小計", royalty_taxincl: 99999 },
];
const MG = [
  { title: "作品A（コミック）１", current_draw_taxincl: 1100 },
  { title: "作品A（コミック）２", current_draw_taxincl: 0 },
  { title: "作品B（コミック）１", current_draw_taxincl: 0 },
];

function keysOf(records: { data: Record<string, unknown> }[]): string[] {
  return records.map((r) => `${r.data.channel_title_jp}|${r.data.type}`).sort();
}

{
  const { records, errors } = aggregateSbSalesReport({ detailRows: DETAIL, mgRows: MG });
  assert.deepEqual(errors, [], "clean synthetic report has no errors");
  assert.deepEqual(
    keysOf(records),
    ["作品A（１）|EB", "作品A（２）|EB", "作品A（３）|EB", "作品B（１）|EB"],
    "exactly four work+volume EB keys across two families",
  );

  const byTitle = new Map(records.map((r) => [String(r.data.channel_title_jp), r.data]));
  // MG draw applies at work+volume: A1 = 5000+500−1100 = 4400.
  assert.equal(byTitle.get("作品A（１）")!.before_tax_jpy, 4400, "gross − MG draw at work+volume");
  assert.equal(byTitle.get("作品A（１）")!.after_tax_jpy, 4000, "round(net/1.1)");
  // Odd number of contributing rows merges fine (A3: 2 price rows).
  assert.equal(byTitle.get("作品A（３）")!.before_tax_jpy, 3000, "multi-price rows merge by key");
  // Volume-less split row bound to the unique volume of its series.
  assert.equal(byTitle.get("作品B（１）")!.before_tax_jpy, 10000, "volume-less row binds uniquely");
  // Tax rounding on a non-divisible net: 10000/1.1 = 9090.90… → 9091.
  assert.equal(byTitle.get("作品B（１）")!.after_tax_jpy, 9091);
  assert.equal(byTitle.get("作品B（１）")!.consumption_tax_jpy, 909);
  assert.equal(byTitle.get("作品B（１）")!.withholding_tax_jpy, 0);

  // Totals: Σ emitted net(税込) === Σ detail − Σ MG draw (metadata row excluded).
  const emitted = records.reduce((s, r) => s + Number(r.data.before_tax_jpy), 0);
  assert.equal(emitted, 5000 + 500 + 3000 + 2000 + 1000 + 9000 + 800 + 200 - 1100, "totals reconcile");
}

// Row-order invariance: shuffled input produces identical keys and amounts.
{
  const base = aggregateSbSalesReport({ detailRows: DETAIL, mgRows: MG });
  const shuffled = [...DETAIL].reverse();
  const rotated = [...DETAIL.slice(4), ...DETAIL.slice(0, 4)];
  for (const detailRows of [shuffled, rotated]) {
    const alt = aggregateSbSalesReport({ detailRows, mgRows: [...MG].reverse() });
    assert.deepEqual(
      alt.records.map((r) => r.data),
      base.records.map((r) => r.data),
      "row order never changes the emitted rows",
    );
  }
}

// Ambiguous volume-less split row → parser error, never adjacent-pair merge.
{
  const { records, errors } = aggregateSbSalesReport({
    detailRows: [
      { title: "作品C（コミック）１", royalty_taxincl: 1000 },
      { title: "作品C（コミック）２", royalty_taxincl: 2000 },
      { title: "作品C【分冊版】（コミック）(1話～5話）", royalty_taxincl: 300 },
    ],
    mgRows: [],
  });
  assert.equal(errors.length, 1, "ambiguous volume-less row is a parser error");
  assert.match(errors[0], /refusing to guess/);
  const amounts = records.map((r) => Number(r.data.before_tax_jpy)).sort((a, b) => a - b);
  assert.deepEqual(amounts, [1000, 2000], "ambiguous amount is isolated, not merged anywhere");
}

// Volume-less row with no detail-volume candidates binds via a unique MG volume.
{
  const { records, errors } = aggregateSbSalesReport({
    detailRows: [{ title: "作品D【分冊版】（コミック）(1話～3話）", royalty_taxincl: 700 }],
    mgRows: [{ title: "作品D（コミック）５", current_draw_taxincl: 100 }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(keysOf(records), ["作品D（５）|EB"]);
  assert.equal(records[0].data.before_tax_jpy, 600);
}

// Work+volume whose MG draw consumes the gross emits nothing (net ≤ 0).
{
  const { records } = aggregateSbSalesReport({
    detailRows: [
      { title: "作品E（コミック）１", royalty_taxincl: 1000 },
      { title: "作品F（コミック）１", royalty_taxincl: 500 },
    ],
    mgRows: [{ title: "作品E（コミック）１", current_draw_taxincl: 1000 }],
  });
  assert.deepEqual(keysOf(records), ["作品F（１）|EB"], "net ≤ 0 volumes are skipped");
}

// ── parseSbSalesReportText: deterministic flattened-PDF-text parsing ────────

// Synthetic unpdf-style flatten: each page is one space-joined string, pages
// joined by "\n". Page 2 places continuation detail entries AFTER the summary
// prose block; page 3 is the channel table; page 4 the MG list.
const SYNTH_PAGE_1 = [
  "〒000-0000 テスト住所 0-0-0 株式会社テスト 様 売上報告書",
  "対象期間 2099年07月 総合計額 ¥13,710",
  "書名 価格 販売数 算出元 料率 ロイヤリティ（税込） 区分 消費税率",
  "¥990 10 ネット 50.00% 電子書籍 10%",
  "¥150 5 ネット 50.00% 電子書籍 10%",
  "作品A（コミック）１ ¥5,000",
  "作品A（コミック）１【分冊版】（1話～10話） ¥500",
  "作品A（コミック）２ ¥3,000",
  "作品C（コミック）３【分冊版】（21 話～30話） ¥610",
].join(" ");
const SYNTH_PAGE_2 = [
  "¥150 8 ネット 50.00% 電子書籍 10%",
  "当期売上合計 ① 当期MG取崩額（MG一覧シート参照） ② ③ 総合計額 ①－②＋③",
  "※当該対価金額が5,000円に満たない場合は繰り越されるものとします。 以上",
  "¥14,810 ¥1,100 繰越分 ¥0 ¥13,710",
  "作品B（コミック）１ ¥4,500",
  "作品B【分冊版】（コミック）(1話～8話） ¥200",
  "作品C（コミック）３ ¥1,000",
].join(" ");
const SYNTH_PAGE_3 =
  "チャネル別 ¥14,810 ① 1002 チャネルX ¥6,072 1023 チャネルY ¥8,738 3 / 4 ページ";
const SYNTH_PAGE_4 = [
  "MG一覧 ＊全て税込金額になります。 660,000 300,000 1,100 298,900",
  "前払印税 管理No. MGタイトル 取崩開始年月 MG支払額 期首MG残高 当期MG取崩額② 期末MG残高",
  "10001 作品A（コミック）１ 2098年09月 ¥220,000 ¥100,000 ¥1,100 ¥98,900",
  "10002 作品A（コミック）２ 2098年09月 ¥220,000 ¥200,000 ¥0 ¥200,000",
  "10003 作品B（コミック）１ 2098年09月 ¥220,000 ¥0 ¥0 ¥0",
  "4 / 4 ページ",
].join(" ");
const SYNTH_TEXT = [SYNTH_PAGE_1, SYNTH_PAGE_2, SYNTH_PAGE_3, SYNTH_PAGE_4].join("\n");

{
  const parsed = parseSbSalesReportText(SYNTH_TEXT);
  assert.deepEqual(parsed.errors, [], "clean synthetic report text parses without errors");
  assert.equal(parsed.targetMonth, "2099-07", "対象期間 → targetMonth");

  // 7 detail entries, including the ones flattened after the summary prose;
  // price/config rows, totals, 繰越分, and channel rows are all excluded.
  assert.equal(parsed.detailRows.length, 7, "all detail entries found across pages");
  const amounts = parsed.detailRows.map((r) => r.royalty_taxincl).sort((a, b) => a - b);
  assert.deepEqual(amounts, [200, 500, 610, 1000, 3000, 4500, 5000]);
  assert.equal(
    parsed.detailRows.reduce((s, r) => s + r.royalty_taxincl, 0),
    14810,
    "detail sum reconciles with the printed 当期売上合計①",
  );

  // MG rows: third money cell after title/start-month is the 当期MG取崩額②.
  assert.deepEqual(
    parsed.mgRows.map((r) => r.current_draw_taxincl),
    [1100, 0, 0],
    "MG draw is the third money value of each row",
  );

  // End-to-end: exactly four generic work+volume EB keys, order invariant.
  const salesMonth = `${parsed.targetMonth}-01`;
  const base = aggregateSbSalesReport({
    detailRows: parsed.detailRows,
    mgRows: parsed.mgRows,
    salesMonth,
  });
  assert.deepEqual(base.errors, []);
  assert.deepEqual(
    keysOf(base.records),
    ["作品A（１）|EB", "作品A（２）|EB", "作品B（１）|EB", "作品C（３）|EB"],
    "parsed report aggregates to exactly four work+volume EB keys",
  );
  const byTitle = new Map(base.records.map((r) => [String(r.data.channel_title_jp), r.data]));
  assert.equal(byTitle.get("作品A（１）")!.before_tax_jpy, 4400, "5000+500−1100 MG draw");
  assert.equal(byTitle.get("作品B（１）")!.before_tax_jpy, 4700, "volume-less split row bound");
  assert.equal(byTitle.get("作品C（３）")!.before_tax_jpy, 1610, "wrapped title + continuation merge");
  const shuffled = aggregateSbSalesReport({
    detailRows: [...parsed.detailRows].reverse(),
    mgRows: [...parsed.mgRows].reverse(),
    salesMonth,
  });
  assert.deepEqual(
    shuffled.records.map((r) => r.data),
    base.records.map((r) => r.data),
    "parsed-row order never changes the aggregate",
  );
}

// Printed-total mismatch → explicit error and no INPUT detail at all.
{
  const tampered = parseSbSalesReportText(SYNTH_TEXT.replace("¥5,000", "¥5,001"));
  assert.equal(tampered.errors.length, 1, "detail-sum mismatch is an explicit error");
  assert.match(tampered.errors[0], /当期売上合計/);
  assert.deepEqual(tampered.detailRows, [], "mismatch emits no INPUT detail");
}
{
  const tampered = parseSbSalesReportText(
    SYNTH_TEXT.replace("660,000 300,000 1,100 298,900", "660,000 300,000 9,999 298,900"),
  );
  assert.equal(tampered.errors.length, 1, "MG draw-sum mismatch is an explicit error");
  assert.match(tampered.errors[0], /当期MG取崩額/);
  assert.deepEqual(tampered.detailRows, [], "MG mismatch emits no INPUT detail");
}

// ── source-file routing: summary files never produce INPUT detail ───────────

assert.equal(classifySbSourceFile("【請求書】SBクリエイティブ様_「作品」他（株式会社).xlsx"), "mg_invoice");
assert.equal(classifySbSourceFile("【請求書】SBクリエイティブ様_「作品」他（株式会社）.pdf"), "mg_invoice");
assert.equal(classifySbSourceFile("支払通知書_2026年06月30日お支払い.pdf"), "payment_notice");
assert.equal(classifySbSourceFile("12850_株式会社RIVERSE様【2026年06月】前払印税報告書.pdf"), "sales_report");

// Payment notices return zero INPUT records (audit evidence handled downstream).
(async () => {
  const result = await parseSbCreative({
    filename: "支払通知書_2099年01月31日お支払い.pdf",
    buffer: Buffer.alloc(0),
  });
  assert.deepEqual(result.records, [], "payment notice emits no INPUT rows");
  assert.deepEqual(result.errors, []);
  console.log("test-sb-creative-title: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
