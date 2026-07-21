/**
 * Synthetic checks for source-role-aware Piccoma companion reconciliation.
 * Run: node --import tsx scripts/test-piccoma-companion-reconcile.ts
 *
 * All rows are synthetic — no golden data, real titles, or real amounts.
 */
import assert from "node:assert/strict";

import {
  dedupePiccomaStatementDuplicates,
  piccomaSourceRoleFromFilename,
  type PiccomaSourceRole,
} from "../src/features/settlement/lib/aggregation/strict-record-key";

type Row = Record<string, unknown>;

const statement: Row = {
  clients: "Piccoma",
  channel: "piccoma",
  channel_title_jp: "作品A",
  title_jp: "作品A",
  settlement_month: "2099-02-28",
  type: "WT",
  distribution_strategy: "non-ex",
  settlement_currency: "JPY",
  vehicle_currency: "KRW",
};

/** 出版社report-shaped row: exact gross, detail-derived (noisy) RS/settle. */
function publisherRow(overrides: Row = {}): Row {
  return {
    ...statement,
    upload_id: "pub-upload",
    sales_month: "2099-01-01",
    deposit_month: "2099-03-31",
    total_amount_jpy: 1100,
    fee_jpy: 0,
    before_tax_jpy: 1100,
    after_tax_jpy: 1000,
    rs_rate: 0.26000000004,
    before_tax_income_jpy: 285,
    withholding_tax_jpy: 0,
    consumption_tax_jpy: 25,
    after_tax_income_jpy: 260,
    ...overrides,
  };
}

/** 取次report-shaped row: approximate gross, authoritative RS/settle/期間. */
function brokerRow(overrides: Row = {}): Row {
  return {
    ...statement,
    upload_id: "brk-upload",
    sales_month: "2099-01-31",
    deposit_month: "2099-03-31",
    total_amount_jpy: 1099,
    fee_jpy: 0,
    before_tax_jpy: 1099,
    after_tax_jpy: 999,
    rs_rate: 0.26,
    before_tax_income_jpy: 286,
    withholding_tax_jpy: 0,
    consumption_tax_jpy: 26,
    after_tax_income_jpy: 260,
    ...overrides,
  };
}

function roles(entries: Array<[string, PiccomaSourceRole]>): Map<string, PiccomaSourceRole> {
  return new Map(entries);
}

const bothRoles = roles([
  ["pub-upload", "publisher_detail"],
  ["brk-upload", "broker_summary"],
]);

/** Stable multiset fingerprint for order-invariance comparisons. */
function fingerprint(rows: Row[]): string {
  return rows
    .map((row) => JSON.stringify(row, Object.keys(row).sort()))
    .sort()
    .join("\n");
}

// --- filename role classification (internal provenance) ---
{
  assert.equal(
    piccomaSourceRoleFromFilename("出版社report_株式会社RIVERSE_20990101_001.xlsx"),
    "publisher_detail",
  );
  assert.equal(
    piccomaSourceRoleFromFilename("取次report_株式会社RIVERSE_20990101_v1.xlsx"),
    "broker_summary",
  );
  assert.equal(piccomaSourceRoleFromFilename("someother_report.xlsx"), null);
  assert.equal(piccomaSourceRoleFromFilename(null), null);
}

// --- merge field ownership: publisher base, broker overlay ---
{
  const { records, removed } = dedupePiccomaStatementDuplicates(
    [publisherRow(), brokerRow()],
    bothRoles,
  );
  assert.equal(records.length, 1, "companion pair reconciles to one row");
  assert.equal(removed, 1);
  const merged = records[0];
  // Transaction/gross fields come from the publisher detail base.
  assert.equal(merged.total_amount_jpy, 1100, "gross owned by publisher");
  assert.equal(merged.before_tax_jpy, 1100, "before-tax gross owned by publisher");
  assert.equal(merged.after_tax_jpy, 1000, "after-tax gross owned by publisher");
  assert.equal(merged.upload_id, "pub-upload", "base row identity is the publisher's");
  // RS and documented summary-owned settle/metadata come from the broker.
  assert.equal(merged.rs_rate, 0.26, "RS owned by broker");
  assert.equal(merged.before_tax_income_jpy, 286, "settle income owned by broker");
  assert.equal(merged.consumption_tax_jpy, 26, "settle tax split owned by broker");
  assert.equal(merged.after_tax_income_jpy, 260, "after-tax income owned by broker");
  assert.equal(merged.sales_month, "2099-01-31", "期間-derived sales month owned by broker");
}

// --- UUID invariance: swapping which upload id sorts first changes nothing ---
{
  const swappedRoles = roles([
    ["zzz-upload", "publisher_detail"],
    ["aaa-upload", "broker_summary"],
  ]);
  const a = dedupePiccomaStatementDuplicates(
    [publisherRow({ upload_id: "zzz-upload" }), brokerRow({ upload_id: "aaa-upload" })],
    swappedRoles,
  );
  assert.equal(a.records.length, 1);
  assert.equal(a.records[0].total_amount_jpy, 1100, "publisher base wins despite larger UUID");
  assert.equal(a.records[0].rs_rate, 0.26, "broker RS overlays despite smaller UUID");
}

// --- order invariance: shuffled input yields the identical row multiset ---
{
  const rowsAsc = [
    publisherRow(),
    publisherRow({ channel_title_jp: "作品B", title_jp: "作品B", total_amount_jpy: 2200 }),
    brokerRow(),
    brokerRow({ channel_title_jp: "作品B", title_jp: "作品B", rs_rate: 0.35 }),
  ];
  const rowsShuffled = [rowsAsc[3], rowsAsc[0], rowsAsc[2], rowsAsc[1]];
  const a = dedupePiccomaStatementDuplicates(rowsAsc, bothRoles);
  const b = dedupePiccomaStatementDuplicates(rowsShuffled, bothRoles);
  assert.equal(a.records.length, 2);
  assert.equal(b.records.length, 2);
  assert.equal(fingerprint(a.records), fingerprint(b.records), "input order is irrelevant");
}

// --- multiplicity: extra publisher rows survive unmerged ---
{
  const { records, removed } = dedupePiccomaStatementDuplicates(
    [
      publisherRow({ total_amount_jpy: 1100 }),
      publisherRow({ total_amount_jpy: 3300 }),
      brokerRow(),
    ],
    bothRoles,
  );
  assert.equal(records.length, 2, "publisher multiplicity preserved");
  assert.equal(removed, 1);
  const totals = records.map((r) => r.total_amount_jpy).sort();
  assert.deepEqual(totals, [1100, 3300], "both distinct publisher rows kept");
  assert.ok(
    records.every((r) => r.rs_rate === 0.26 || r.rs_rate === 0.26000000004),
    "one row merged with broker RS, the unpaired one keeps its own",
  );
  assert.ok(
    records.some((r) => r.rs_rate === 0.26),
    "exactly one pairing received the broker overlay",
  );
}

// --- multiplicity: extra broker rows survive as-is ---
{
  const { records } = dedupePiccomaStatementDuplicates(
    [publisherRow(), brokerRow({ after_tax_income_jpy: 260 }), brokerRow({ after_tax_income_jpy: 520 })],
    bothRoles,
  );
  assert.equal(records.length, 2, "broker multiplicity preserved");
  assert.ok(
    records.some((r) => r.upload_id === "brk-upload"),
    "unpaired broker row survives whole",
  );
  assert.ok(
    records.some((r) => r.upload_id === "pub-upload" && r.total_amount_jpy === 1100),
    "merged row keeps the publisher gross",
  );
}

// --- one-source fallback: a lone upload is never altered ---
{
  const pubOnly = dedupePiccomaStatementDuplicates([publisherRow(), publisherRow()], bothRoles);
  assert.equal(pubOnly.records.length, 2, "publisher-only rows untouched");
  assert.equal(pubOnly.removed, 0);
  assert.equal(pubOnly.records[0].rs_rate, 0.26000000004, "detail RS kept without a companion");

  const brkOnly = dedupePiccomaStatementDuplicates([brokerRow()], bothRoles);
  assert.equal(brkOnly.records.length, 1, "broker-only row untouched");
  assert.equal(brkOnly.records[0].total_amount_jpy, 1099, "summary gross kept without a companion");
}

// --- blank broker values never clobber real detail data ---
{
  const { records } = dedupePiccomaStatementDuplicates(
    [publisherRow(), brokerRow({ rs_rate: null, before_tax_income_jpy: null })],
    bothRoles,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].rs_rate, 0.26000000004, "null broker RS falls back to base");
  assert.equal(records[0].before_tax_income_jpy, 285, "null broker settle falls back to base");
  assert.equal(records[0].consumption_tax_jpy, 26, "non-null broker fields still overlay");
}

// --- without role provenance the legacy deterministic keeper still applies ---
{
  const { records, removed } = dedupePiccomaStatementDuplicates([
    publisherRow({ upload_id: "u2" }),
    brokerRow({ upload_id: "u1" }),
  ]);
  assert.equal(records.length, 1, "no roles → one whole upload kept");
  assert.equal(removed, 1);
  assert.equal(records[0].upload_id, "u1", "legacy tie-break on smallest upload id");
}

// --- non-Piccoma rows pass through unchanged ---
{
  const foreign = {
    ...publisherRow(),
    clients: "Other Client",
    channel: "other-channel",
  };
  const { records, removed } = dedupePiccomaStatementDuplicates(
    [foreign, { ...foreign, upload_id: "brk-upload" }],
    bothRoles,
  );
  assert.equal(records.length, 2, "non-Piccoma duplicates are out of scope here");
  assert.equal(removed, 0);
}

console.log("piccoma-companion-reconcile: all checks passed");
