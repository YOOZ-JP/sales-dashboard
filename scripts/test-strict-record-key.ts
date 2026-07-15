/**
 * Unit checks for the strict duplicate helpers.
 * Run: node --import tsx scripts/test-strict-record-key.ts
 */
import assert from "node:assert/strict";

import {
  dedupeCrossUploadDuplicates,
  dedupePiccomaStatementDuplicates,
  hasStrictPartyIdentity,
  strictRecordKey,
  suppressExistingPiccomaStatementDuplicates,
  suppressExistingDuplicates,
} from "../src/features/settlement/lib/aggregation/strict-record-key";

const base = {
  client_id: "c1",
  channel_id: "ch1",
  channel_title_jp: "タイトルA",
  title_jp: "タイトルA",
  sales_month: "2026-04-30",
  settlement_month: "2026-05-29",
  deposit_month: null,
  type: "PP",
  distribution_strategy: "non-ex",
  settlement_currency: "JPY",
  vehicle_currency: "KRW",
  total_amount_jpy: 1000,
  fee_jpy: 0,
  before_tax_jpy: 1000,
  after_tax_jpy: 909,
  rs_rate: null,
  before_tax_income_jpy: 1000,
  withholding_tax_jpy: 0,
  consumption_tax_jpy: 91,
  after_tax_income_jpy: 909,
};

// Legitimate variants (different type / amount / month) must key differently.
assert.notEqual(strictRecordKey(base), strictRecordKey({ ...base, type: "MF" }), "type variant");
assert.notEqual(
  strictRecordKey(base),
  strictRecordKey({ ...base, total_amount_jpy: 2000, before_tax_jpy: 2000 }),
  "amount variant",
);
assert.notEqual(
  strictRecordKey(base),
  strictRecordKey({ ...base, sales_month: "2026-03-31" }),
  "month variant",
);
assert.notEqual(
  strictRecordKey(base),
  strictRecordKey({ ...base, sales_krw: 1234 }),
  "KRW/conversion variant",
);
assert.equal(hasStrictPartyIdentity(base), true, "base has client/channel identity");
assert.equal(
  hasStrictPartyIdentity({ ...base, client_id: null, channel_id: null }),
  false,
  "blank party identity is unsafe for duplicate suppression",
);
// Field-level identity keys equal.
assert.equal(strictRecordKey(base), strictRecordKey({ ...base }), "identical rows share a key");

// --- suppressExistingDuplicates (upload time) ---

// Fresh upload into an empty batch: same-file identical repeats all kept.
{
  const { kept, skipped } = suppressExistingDuplicates([{ ...base }, { ...base }], []);
  assert.equal(kept.length, 2, "empty batch keeps same-upload repeats");
  assert.equal(skipped, 0);
}
// Exact re-upload: every row already present once per copy → all skipped.
{
  const { kept, skipped } = suppressExistingDuplicates(
    [{ ...base }, { ...base }],
    [{ ...base }, { ...base }],
  );
  assert.equal(kept.length, 0, "exact re-upload fully suppressed");
  assert.equal(skipped, 2);
}
// Partial overlap: batch holds 1 copy, file carries 2 → surplus copy kept.
{
  const { kept, skipped } = suppressExistingDuplicates([{ ...base }, { ...base }], [{ ...base }]);
  assert.equal(kept.length, 1, "surplus beyond existing count is kept");
  assert.equal(skipped, 1);
}
// Different type rows never suppressed by same-title/same-amount rows.
{
  const { kept } = suppressExistingDuplicates([{ ...base, type: "MF" }], [{ ...base }]);
  assert.equal(kept.length, 1, "legit variant survives");
}
// Missing client/channel identity: prefer keeping a possible duplicate over data loss.
{
  const unsafe = { ...base, client_id: null, channel_id: null };
  const { kept, skipped } = suppressExistingDuplicates([unsafe], [unsafe]);
  assert.equal(kept.length, 1, "unsafe blank-party rows are not suppressed");
  assert.equal(skipped, 0);
}

// Piccoma paired summary/detail rows suppress even when derived gross fields differ.
{
  const existing = {
    ...base,
    client_id: null,
    channel_id: null,
    clients: "Piccoma",
    channel: "piccoma",
    type: "WT",
    total_amount_jpy: 1000,
    before_tax_jpy: 1000,
  };
  const incoming = {
    ...existing,
    sales_month: "2026-06-01",
    total_amount_jpy: 999,
    before_tax_jpy: 999,
  };
  const { kept, skipped } = suppressExistingPiccomaStatementDuplicates([incoming], [existing]);
  assert.equal(kept.length, 0, "Piccoma paired duplicate suppresses without ids or exact amounts");
  assert.equal(skipped, 1);
}

// A same-looking row from another platform must never consume Piccoma's budget.
{
  const incoming = {
    ...base,
    client_id: null,
    channel_id: null,
    clients: "Piccoma",
    channel: "piccoma",
    type: "WT",
  };
  const unrelated = {
    ...incoming,
    clients: "Other Client",
    channel: "other-channel",
  };
  const { kept, skipped } = suppressExistingPiccomaStatementDuplicates([incoming], [unrelated]);
  assert.equal(kept.length, 1, "non-Piccoma row cannot suppress Piccoma insert");
  assert.equal(skipped, 0);
}

// Supabase existing-row queries carry foreign-key ids but not display codes.
// A matching Piccoma DB row must still suppress, while another channel id must not.
{
  const incoming = {
    ...base,
    client_id: "client-piccoma",
    channel_id: "channel-piccoma",
    clients: null,
    channel: null,
    type: "WT",
  };
  const existing = { ...incoming };
  const unrelated = { ...incoming, channel_id: "channel-other" };
  const matched = suppressExistingPiccomaStatementDuplicates([incoming], [existing]);
  assert.equal(matched.kept.length, 0, "Piccoma DB row suppresses by foreign-key ids");
  assert.equal(matched.skipped, 1);
  const notMatched = suppressExistingPiccomaStatementDuplicates([incoming], [unrelated]);
  assert.equal(notMatched.kept.length, 1, "different channel id cannot consume Piccoma budget");
  assert.equal(notMatched.skipped, 0);
}

// Same Piccoma title with different types is legitimate and must survive.
{
  const existing = { ...base, clients: "Piccoma", channel: "piccoma", type: "WT" };
  const incoming = { ...existing, type: "EB" };
  const { kept, skipped } = suppressExistingPiccomaStatementDuplicates([incoming], [existing]);
  assert.equal(kept.length, 1, "Piccoma same-title multi-type row survives");
  assert.equal(skipped, 0);
}

// --- dedupeCrossUploadDuplicates (export time) ---

// CSV + XLSX twins (1 copy each) → one survives.
{
  const rows = [
    { ...base, upload_id: "u1" },
    { ...base, upload_id: "u2" },
  ];
  const { records, removed } = dedupeCrossUploadDuplicates(rows);
  assert.equal(records.length, 1, "cross-upload twin hidden");
  assert.equal(removed, 1);
}
// Keeper is the upload with the MOST copies: legit repeats never under-kept.
{
  const rows = [
    { ...base, upload_id: "u1" },
    { ...base, upload_id: "u2" },
    { ...base, upload_id: "u2" },
  ];
  const { records, removed } = dedupeCrossUploadDuplicates(rows);
  assert.equal(records.length, 2, "max-copy upload wins");
  assert.equal(removed, 1);
  assert.ok(records.every((r) => r.upload_id === "u2"), "kept rows come from one upload");
}
// Same-upload repeats with no other upload → untouched.
{
  const rows = [
    { ...base, upload_id: "u1" },
    { ...base, upload_id: "u1" },
  ];
  const { records, removed } = dedupeCrossUploadDuplicates(rows);
  assert.equal(records.length, 2, "same-upload repeats preserved");
  assert.equal(removed, 0);
}
// Distinct keys across uploads → nothing removed.
{
  const rows = [
    { ...base, upload_id: "u1" },
    { ...base, upload_id: "u2", type: "MF" },
  ];
  const { records, removed } = dedupeCrossUploadDuplicates(rows);
  assert.equal(records.length, 2, "variants across uploads preserved");
  assert.equal(removed, 0);
}

// Export-time Piccoma paired duplicate suppression is deterministic by upload id.
{
  const rows = [
    { ...base, clients: "Piccoma", channel: "piccoma", type: "WT", total_amount_jpy: 1000, upload_id: "u2" },
    { ...base, clients: "Piccoma", channel: "piccoma", type: "WT", total_amount_jpy: 999, upload_id: "u1" },
    { ...base, clients: "Piccoma", channel: "piccoma", type: "EB", total_amount_jpy: 999, upload_id: "u1" },
  ];
  const { records, removed } = dedupePiccomaStatementDuplicates(rows);
  assert.equal(records.length, 2, "Piccoma paired duplicate hidden, multi-type preserved");
  assert.equal(removed, 1);
  assert.ok(records.some((r) => r.type === "EB"), "EB variant survives");
  assert.ok(records.some((r) => r.upload_id === "u1" && r.type === "WT"), "stable upload keeper");
}

console.log("strict-record-key: all checks passed");
