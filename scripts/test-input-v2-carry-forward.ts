/**
 * Privacy-safe regression test for INPUT v2/v3 carry-forward merging.
 * Run: node --import tsx scripts/test-input-v2-carry-forward.ts
 */

import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";
import {
  buildBaselineTitleAliases,
  canonicalizeStatementTitle,
  carryForwardRecordKey,
  mergeCarryForwardRows,
  SHUEISHA_OCR_TITLE_MARKER,
  splitStructuralSuffix,
} from "../src/features/settlement/lib/export/input-v2-carry-forward";
import { inputV2ElectronicSheet } from "../src/features/settlement/lib/export/input-v2-routing";

function iso(value: unknown): string {
  assert.ok(value instanceof Date, "expected Date");
  return value.toISOString().slice(0, 10);
}

const baseline = [
  {
    // U+301C wave dash; the current row uses U+FF5E — identity must fold them.
    channel_title_jp: "Synthetic Alpha〜encore〜",
    title_jp: "Synthetic Alpha〜encore〜",
    title_kr: "Synthetic A",
    clients: "NTTsolmare",
    channel: "cmoa",
    type: "ebook",
    company: "RJ",
    launch_date: new Date("2025-01-01"),
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
    rs: 0.5,
    allocation_rate: 0.75,
    creator_category: "制作社",
    total_amount_jpy: 1000,
    fee_jpy: 100,
    exchange_rate: 9.1,
  },
  {
    // renta is a cadence-carry channel: zero months keep explicit 0 amounts
    // and advance the row's own cadence one month.
    channel_title_jp: "Synthetic Beta",
    title_jp: "Synthetic Beta",
    title_kr: "Synthetic B",
    clients: "PAPYLESS",
    channel: "renta",
    type: "ebook",
    company: "RJ",
    launch_date: new Date("2025-02-01"),
    sales_month: new Date("2026-04-01"),
    deposit_month: new Date("2026-07-15"),
    rs: 0.4,
    total_amount_jpy: 2000,
    after_tax_jpy: 1800,
    exchange_rate: 9.1,
  },
  {
    // cmoa is a blank-carry channel: zero months blank dates and raw amounts.
    channel_title_jp: "Synthetic Delta",
    title_jp: "Synthetic Delta",
    clients: "NTTsolmare",
    channel: "cmoa",
    type: "ebook",
    launch_date: new Date("2025-03-01"),
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
    rs: 0.5,
    total_amount_jpy: 500,
    after_tax_jpy: 450,
    exchange_rate: 9.1,
  },
  {
    channel_title_jp: "Synthetic Publication",
    clients: "shueisha",
    channel: "shueisha",
    type: "ebook",
  },
];

const current = [
  {
    channel_title_jp: " synthetic  alpha～encore～ ",
    title_jp: "Synthetic Alpha〜encore〜",
    clients: "NTTsolmare",
    channel: "CMOA",
    type: "ebook",
    company: "RS",
    sales_month: new Date("2026-05-15"),
    deposit_month: new Date("2026-09-15"),
    rs: 0.99,
    allocation_rate: 0.99,
    total_amount_jpy: 3000,
    fee_jpy: 300,
  },
  {
    channel_title_jp: "Synthetic Gamma",
    clients: "Booklive",
    channel: "booklive",
    type: "ebook",
    total_amount_jpy: 4000,
  },
];

const result = mergeCarryForwardRows(baseline, current, "202606");

assert.equal(inputV2ElectronicSheet("202606"), "input_電子_7月", "June batch outputs July sheet");
assert.equal(result.overlay_rows, 1, "matched current row overlays baseline");
assert.equal(result.carry_rows, 2, "unmatched baseline rows are carried");
assert.equal(result.append_rows, 1, "unmatched current row is appended");
assert.equal(result.drop_rows, 1, "publication baseline row is dropped");
assert.equal(result.records.length, 4, "merged row count");

const [overlay, cadenceCarry, blankCarry, append] = result.records;
assert.equal(carryForwardRecordKey(overlay), carryForwardRecordKey(baseline[0]), "normalized key matches");
assert.equal(overlay.total_amount_jpy, 3000, "overlay keeps current money");
assert.equal(overlay.fee_jpy, 300, "overlay keeps current fee");
assert.equal(overlay.exchange_rate, null, "statement-silent raw input does not leak from baseline");
assert.equal(overlay.rs, 0.5, "overlay preserves baseline RS");
assert.equal(overlay.allocation_rate, 0.75, "overlay preserves baseline allocation");
assert.equal(overlay.company, "RS", "company follows current evidence, not baseline");
assert.equal(iso(overlay.launch_date), "2025-01-01", "overlay preserves launch date");
assert.equal(iso(overlay.sales_month), "2026-05-15", "overlay takes statement sales month");
assert.equal(iso(overlay.deposit_month), "2026-09-15", "overlay takes statement deposit month");
assert.equal(iso(overlay.updated), "2026-07-01", "updated default");
assert.equal(iso(overlay.month), "2026-06-01", "accounting default");
assert.equal(iso(overlay.settlement_month), "2026-07-31", "settlement default");

// Cadence-carry (renta): explicit zero amounts, formulas regenerated, and the
// row's own sales/deposit cadence advanced exactly one calendar month.
assert.equal(cadenceCarry.total_amount_jpy, null, "cadence carry lets total formula reset");
assert.equal(cadenceCarry.fee_jpy, 0, "cadence carry keeps explicit zero fee");
assert.equal(cadenceCarry.after_tax_jpy, 0, "cadence carry keeps explicit zero after-tax");
assert.equal(cadenceCarry.exchange_rate, null, "cadence carry clears exchange rate");
assert.equal(cadenceCarry.rs, 0.4, "cadence carry preserves RS");
assert.equal(cadenceCarry.clients, "PAPYLESS", "cadence carry preserves clients");
assert.equal(iso(cadenceCarry.launch_date), "2025-02-01", "cadence carry preserves launch date");
assert.equal(iso(cadenceCarry.sales_month), "2026-05-01", "cadence carry advances sales one month");
assert.equal(iso(cadenceCarry.deposit_month), "2026-08-15", "cadence carry advances deposit one month");
assert.equal(iso(cadenceCarry.updated), "2026-07-01", "carry updated default");
assert.equal(iso(cadenceCarry.month), "2026-06-01", "carry accounting default");
assert.equal(iso(cadenceCarry.settlement_month), "2026-07-31", "carry settlement default");

// Blank-carry (cmoa): contract metadata survives, but sales/deposit months and
// raw monetary inputs are blanked; the filler regenerates formula columns.
assert.equal(blankCarry.total_amount_jpy, null, "blank carry lets total formula reset");
assert.equal(blankCarry.fee_jpy, null, "blank carry blanks raw fee input");
assert.equal(blankCarry.after_tax_jpy, null, "blank carry blanks raw after-tax input");
assert.equal(blankCarry.exchange_rate, null, "blank carry clears exchange rate");
assert.equal(blankCarry.rs, 0.5, "blank carry preserves RS");
assert.equal(iso(blankCarry.launch_date), "2025-03-01", "blank carry preserves launch date");
assert.equal(blankCarry.sales_month, null, "blank carry clears sales month");
assert.equal(blankCarry.deposit_month, null, "blank carry clears deposit month");
assert.equal(iso(blankCarry.settlement_month), "2026-07-31", "blank carry settlement default");

assert.equal(append.total_amount_jpy, 4000, "append keeps current money");
assert.equal(iso(append.sales_month), "2026-06-01", "append receives sales default");
assert.equal(iso(append.deposit_month), "2026-08-31", "append receives deposit default");

// --- Baseline title canonicalization (structural-suffix invoice rows) ---

const SUFFIX = "（20th色紙原稿料）";
const rosterRows = [
  { channel: "ichijinsha", type: "PP", channel_title_jp: `Synthetic Legendary Saga${SUFFIX}` },
  { channel: "ichijinsha", type: "PP", channel_title_jp: `Synthetic Princess Saga！！${SUFFIX}` },
  { channel: "ichijinsha", type: "PP", channel_title_jp: `Synthetic Twin SagaA${SUFFIX}` },
  { channel: "ichijinsha", type: "PP", channel_title_jp: `Synthetic Twin SagaB${SUFFIX}` },
  { channel: "ichijinsha", type: "PP", channel_title_jp: `Shorty!${SUFFIX}` },
];
const aliases = buildBaselineTitleAliases(rosterRows);

assert.deepEqual(
  splitStructuralSuffix(`Base Title${SUFFIX}`),
  { base: "Base Title", suffix: SUFFIX },
  "structural suffix splits off the base",
);
assert.deepEqual(
  splitStructuralSuffix("Base Title"),
  { base: "Base Title", suffix: "" },
  "titles without a supported suffix keep an empty suffix",
);

const oneChar = canonicalizeStatementTitle(`Synthetic Legendry Saga${SUFFIX}`, "ichijinsha", aliases);
assert.equal(oneChar.changed, true, "unique one-codepoint omission canonicalizes");
assert.equal(oneChar.title, `Synthetic Legendary Saga${SUFFIX}`, "canonical base + unchanged suffix");

const punct = canonicalizeStatementTitle(`Synthetic Princess Saga${SUFFIX}`, "ichijinsha", aliases);
assert.equal(punct.changed, true, "unique two-terminal-punctuation omission canonicalizes");
assert.equal(punct.title, `Synthetic Princess Saga！！${SUFFIX}`, "terminal punctuation restored");

const collision = canonicalizeStatementTitle(`Synthetic Twin Saga${SUFFIX}`, "ichijinsha", aliases);
assert.equal(collision.changed, false, "colliding alias refuses to canonicalize");
assert.equal(collision.ambiguous, true, "collision is reported as ambiguous");
assert.equal(collision.title, `Synthetic Twin Saga${SUFFIX}`, "ambiguous title stays unchanged");

const crossChannel = canonicalizeStatementTitle(`Synthetic Legendry Saga${SUFFIX}`, "mbj_sales", aliases);
assert.equal(crossChannel.changed, false, "aliases never match across channels");
assert.equal(crossChannel.ambiguous, false, "cross-channel miss is not ambiguous");

const short = canonicalizeStatementTitle(`Shorty${SUFFIX}`, "ichijinsha", aliases);
assert.equal(short.changed, false, "bases under the minimum length get no deletion aliases");

const halfWidth = canonicalizeStatementTitle("Synthetic Legendry Saga(20th色紙原稿料)", "ichijinsha", aliases);
assert.equal(halfWidth.changed, true, "NFKC suffix variant is recognized");
assert.equal(
  halfWidth.title,
  "Synthetic Legendary Saga(20th色紙原稿料)",
  "the suffix is reattached exactly as the source wrote it",
);

const exact = canonicalizeStatementTitle(`Synthetic Legendary Saga${SUFFIX}`, "ichijinsha", aliases);
assert.equal(exact.changed, false, "already-exact title stays unchanged");
assert.equal(exact.ambiguous, false, "already-exact title is not ambiguous");

const noSuffix = canonicalizeStatementTitle("Synthetic Legendry Saga", "ichijinsha", aliases);
assert.equal(noSuffix.changed, false, "rows without a supported suffix are never rewritten");

// End-to-end: the canonicalized typo overlays its contract row instead of
// appending, while the ambiguous title appends unchanged with a marker.
const canonBaseline = [
  {
    channel_title_jp: `Synthetic Legendary Saga${SUFFIX}`,
    clients: "ichijinsha",
    channel: "ichijinsha",
    type: "PP",
    rs: "原稿料",
    total_amount_jpy: 50000,
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
  },
  { channel_title_jp: `Synthetic Twin SagaA${SUFFIX}`, channel: "ichijinsha", type: "PP" },
  { channel_title_jp: `Synthetic Twin SagaB${SUFFIX}`, channel: "ichijinsha", type: "PP" },
];
const canonCurrent = [
  {
    channel_title_jp: `Synthetic Legendry Saga${SUFFIX}`,
    channel: "ichijinsha",
    type: "PP",
    total_amount_jpy: 60000,
    sales_month: new Date("2026-06-01"),
  },
  {
    channel_title_jp: `Synthetic Twin Saga${SUFFIX}`,
    channel: "ichijinsha",
    type: "PP",
    total_amount_jpy: 70000,
  },
];
const canonMerge = mergeCarryForwardRows(canonBaseline, canonCurrent, "202606");
assert.equal(canonMerge.overlay_rows, 1, "canonicalized typo overlays rather than appends");
assert.equal(canonMerge.carry_rows, 2, "collision pair still carries");
assert.equal(canonMerge.append_rows, 1, "ambiguous title appends instead of guessing");
assert.equal(canonMerge.canonical_title_rows, 1, "one title was canonicalized");
assert.equal(canonMerge.ambiguous_title_rows, 1, "one title was ambiguous");
const canonOverlay = canonMerge.records.find((r) => r.total_amount_jpy === 60000)!;
assert.equal(canonOverlay.channel_title_jp, `Synthetic Legendary Saga${SUFFIX}`, "overlay row carries the canonical title");
assert.equal(canonOverlay.raw_title, `Synthetic Legendry Saga${SUFFIX}`, "original source title is preserved in raw_title");
assert.equal(canonOverlay.rs, "原稿料", "overlay preserves contract rs after canonicalization");
const ambiguousAppend = canonMerge.records.find((r) => r.total_amount_jpy === 70000)!;
assert.equal(ambiguousAppend.title_canonicalization, "ambiguous", "ambiguous row carries an audit marker");
assert.equal(ambiguousAppend.channel_title_jp, `Synthetic Twin Saga${SUFFIX}`, "ambiguous title text is untouched");

// --- Heuristic type reconciliation: same-channel first, global exact-title fallback ---

const typeBaseline = [
  // Same-channel roster: line already knows this title's contract type.
  { channel_title_jp: "Synthetic Local", channel: "line", type: "WT" },
  // Same-channel collision: two line types block reconciliation entirely.
  { channel_title_jp: "Synthetic Clash", channel: "line", type: "WT" },
  { channel_title_jp: "Synthetic Clash", channel: "line", type: "EB" },
  // No line roster for these titles; they only exist on other baseline channels.
  { channel_title_jp: "Synthetic Global", channel: "ebj", type: "WN" },
  { channel_title_jp: "Synthetic Split", channel: "ebj", type: "WN" },
  { channel_title_jp: "Synthetic Split", channel: "cmoa", type: "EB" },
];
const typeCurrent = [
  { channel_title_jp: "Synthetic Local", channel: "line", type: "EB", note2: "TYPE_HEURISTIC", total_amount_jpy: 11 },
  { channel_title_jp: "Synthetic Clash", channel: "line", type: "WT", note2: "TYPE_HEURISTIC", total_amount_jpy: 12 },
  { channel_title_jp: "Synthetic Global", channel: "line", type: "WT", note2: "TYPE_HEURISTIC", total_amount_jpy: 21 },
  { channel_title_jp: "Synthetic Split", channel: "line", type: "WT", note2: "TYPE_HEURISTIC", total_amount_jpy: 31 },
];
const typeMerge = mergeCarryForwardRows(typeBaseline, typeCurrent, "202606");
assert.equal(typeMerge.reconciled_type_rows, 2, "same-channel unique and globally unique titles reconcile");
assert.equal(typeMerge.ambiguous_type_rows, 1, "same-channel collision stays ambiguous, no global fallback");
const localRow = typeMerge.records.find((r) => r.total_amount_jpy === 11)!;
assert.equal(localRow.type, "WT", "same-channel unique baseline type wins as before");
assert.equal(localRow.raw_type, "EB", "reconciled row preserves its raw source type");
assert.equal(localRow.type_reconciliation, "baseline", "reconciled row carries the audit marker");
const clashRow = typeMerge.records.find((r) => r.total_amount_jpy === 12)!;
assert.equal(clashRow.type, "WT", "same-channel collision leaves the heuristic type unchanged");
assert.equal(clashRow.type_reconciliation, undefined, "colliding row gets no reconciliation marker");
const globalRow = typeMerge.records.find((r) => r.total_amount_jpy === 21)!;
assert.equal(globalRow.type, "WN", "globally unique exact-title type is adopted across channels");
assert.equal(globalRow.raw_type, "WT", "global fallback preserves raw_type audit");
assert.equal(globalRow.type_reconciliation, "baseline", "global fallback carries the same audit marker");
const splitRow = typeMerge.records.find((r) => r.total_amount_jpy === 31)!;
assert.equal(splitRow.type, "WT", "globally colliding types leave the heuristic row unchanged");
assert.equal(splitRow.raw_type, undefined, "untouched row gets no raw_type audit");

// --- Multi-type roster elimination: unique unclaimed baseline type wins ---

const elimBaseline = [
  {
    channel_title_jp: "Synthetic Duo",
    channel: "ebj",
    type: "EP",
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
  },
  {
    channel_title_jp: "Synthetic Duo",
    channel: "ebj",
    type: "WT",
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
  },
];
const elimCurrent = [
  { channel_title_jp: "Synthetic Duo", channel: "ebj", type: "WT", total_amount_jpy: 41 },
  {
    channel_title_jp: "Synthetic Duo",
    channel: "ebj",
    type: "EB",
    note2: "TYPE_HEURISTIC",
    total_amount_jpy: 42,
  },
];
const elimMerge = mergeCarryForwardRows(elimBaseline, elimCurrent, "202606");
assert.equal(elimMerge.reconciled_type_rows, 1, "heuristic sibling adopts the unique unclaimed type");
assert.equal(elimMerge.ambiguous_type_rows, 0, "elimination leaves no ambiguous count");
assert.equal(elimMerge.overlay_rows, 2, "both siblings overlay their baseline rows");
assert.equal(elimMerge.append_rows, 0, "elimination appends nothing");
assert.equal(elimMerge.records.length, 2, "row count is preserved");
const elimRow = elimMerge.records.find((r) => r.total_amount_jpy === 42)!;
assert.equal(elimRow.type, "EP", "absent EB heuristic reconciles to the unclaimed EP");
assert.equal(elimRow.raw_type, "EB", "eliminated row preserves its raw source type");
assert.equal(elimRow.type_reconciliation, "baseline", "eliminated row carries the audit marker");
const elimExplicit = elimMerge.records.find((r) => r.total_amount_jpy === 41)!;
assert.equal(elimExplicit.type, "WT", "explicit sibling stays untouched");
assert.equal(elimExplicit.type_reconciliation, undefined, "explicit sibling gets no marker");

// Fail closed: without an explicit sibling claiming a type, both baseline
// types stay unclaimed and the heuristic row must not guess.
const elimUnclaimed = mergeCarryForwardRows(
  elimBaseline,
  [
    {
      channel_title_jp: "Synthetic Duo",
      channel: "ebj",
      type: "EB",
      note2: "TYPE_HEURISTIC",
      total_amount_jpy: 43,
    },
  ],
  "202606",
);
assert.equal(elimUnclaimed.reconciled_type_rows, 0, "multiple unclaimed types fail closed");
assert.equal(elimUnclaimed.ambiguous_type_rows, 1, "fail-closed row is counted ambiguous");
const elimUnclaimedRow = elimUnclaimed.records.find((r) => r.total_amount_jpy === 43)!;
assert.equal(elimUnclaimedRow.type, "EB", "fail-closed heuristic type stays unchanged");

// Fail closed: siblings claiming every baseline type leave zero candidates.
const elimClaimed = mergeCarryForwardRows(
  elimBaseline,
  [
    { channel_title_jp: "Synthetic Duo", channel: "ebj", type: "EP", total_amount_jpy: 44 },
    { channel_title_jp: "Synthetic Duo", channel: "ebj", type: "WT", total_amount_jpy: 45 },
    {
      channel_title_jp: "Synthetic Duo",
      channel: "ebj",
      type: "EB",
      note2: "TYPE_HEURISTIC",
      total_amount_jpy: 46,
    },
  ],
  "202606",
);
assert.equal(elimClaimed.reconciled_type_rows, 0, "zero unclaimed types fail closed");
assert.equal(elimClaimed.ambiguous_type_rows, 1, "fully claimed roster is counted ambiguous");
assert.equal(elimClaimed.records.find((r) => r.total_amount_jpy === 46)!.type, "EB", "fully claimed roster leaves the heuristic type unchanged");

// --- Reconciled-key consolidation (EBJ unit categories collapsing to one key) ---

const unitBaseline = [
  {
    channel_title_jp: "Synthetic Units",
    channel: "ebj",
    type: "WN",
    sales_month: new Date("2026-05-01"),
    deposit_month: new Date("2026-06-30"),
  },
];
const unitCurrent = [
  {
    channel_title_jp: "Synthetic Units",
    channel: "ebj",
    type: "WN",
    after_tax_jpy: 100,
    after_tax_income_jpy: 50,
    source_file: "a.csv",
  },
  {
    channel_title_jp: "Synthetic Units",
    channel: "ebj",
    type: "WT",
    note2: "TYPE_HEURISTIC",
    after_tax_jpy: 30,
    after_tax_income_jpy: 15,
    source_file: "b.csv",
  },
  // Pre-existing duplicate keys with no reconciled member must never merge.
  { channel_title_jp: "Synthetic Dupes", channel: "ebj", type: "EB", after_tax_jpy: 1 },
  { channel_title_jp: "Synthetic Dupes", channel: "ebj", type: "EB", after_tax_jpy: 2 },
];
const unitMerge = mergeCarryForwardRows(unitBaseline, unitCurrent, "202606");
assert.equal(unitMerge.reconciled_type_rows, 1, "heuristic unit row reconciles to the contract type");
assert.equal(unitMerge.consolidated_rows, 1, "reconciled sibling merges into the explicit row");
const unitRow = unitMerge.records.find((r) => r.channel_title_jp === "Synthetic Units")!;
assert.equal(unitRow.type, "WN", "consolidated row keeps the contract type");
assert.equal(unitRow.after_tax_jpy, 130, "additive money fields sum across siblings");
assert.equal(unitRow.after_tax_income_jpy, 65, "income fields sum across siblings");
assert.equal(unitRow.consolidated_source_count, 2, "consolidation audit counts both sources");
assert.equal(unitRow.type_consolidation, "baseline", "consolidated row carries the audit marker");
const dupeRows = unitMerge.records.filter((r) => r.channel_title_jp === "Synthetic Dupes");
assert.equal(dupeRows.length, 2, "ordinary pre-existing duplicate keys are not consolidated");

// Input order must never change the consolidated result.
const reversedMerge = mergeCarryForwardRows(unitBaseline, [...unitCurrent].reverse(), "202606");
assert.equal(reversedMerge.consolidated_rows, 1, "reversed input consolidates identically");
const reversedUnit = reversedMerge.records.find((r) => r.channel_title_jp === "Synthetic Units")!;
assert.equal(reversedUnit.after_tax_jpy, 130, "consolidation is input-order invariant");

// --- Shueisha local-OCR strict title reconciliation ---

function shueishaBaseline(title: string, extra: Record<string, unknown> = {}) {
  return {
    channel_title_jp: `${title}(話配信)`,
    title_jp: title,
    clients: "shueisha",
    channel: "Jumptoon",
    type: "EB",
    rs: 0.45,
    total_amount_jpy: 100,
    ...extra,
  };
}

function shueishaCurrent(title: string, extra: Record<string, unknown> = {}) {
  return {
    channel_title_jp: `${title}(話配信)`,
    title_jp: title,
    clients: "shueisha",
    channel: "Jumptoon",
    type: "EB",
    total_amount_jpy: 200,
    note2: SHUEISHA_OCR_TITLE_MARKER,
    ...extra,
  };
}

function assertOcrRejected(
  baselineRows: Record<string, unknown>[],
  currentRows: Record<string, unknown>[],
  message: string,
) {
  const merged = mergeCarryForwardRows(baselineRows, currentRows, "202606");
  assert.equal(merged.ocr_title_reconciled_rows, 0, `${message}: no OCR reconciliation`);
  assert.equal(merged.append_rows, currentRows.length, `${message}: current row appends`);
}

const ocrPositive = mergeCarryForwardRows(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国")],
  "202606",
);
assert.equal(ocrPositive.ocr_title_reconciled_rows, 1, "marked insertion-only Shueisha row reconciles");
assert.equal(ocrPositive.overlay_rows, 1, "reconciled Shueisha row overlays baseline");
const ocrOverlay = ocrPositive.records.find((r) => r.total_amount_jpy === 200)!;
assert.equal(ocrOverlay.channel_title_jp, "蒼の王国(話配信)", "channel title canonicalizes to baseline");
assert.equal(ocrOverlay.title_jp, "蒼の王国", "title_jp canonicalizes to baseline");
assert.equal(ocrOverlay.raw_title, "蒼Xの王国(話配信)", "raw OCR title is preserved internally");
assert.equal(ocrOverlay.rs, 0.45, "canonicalized row overlays onto baseline contract metadata");

const ocrOneToOne = mergeCarryForwardRows(
  [shueishaBaseline("星の扉"), shueishaBaseline("月の扉")],
  [shueishaCurrent("星Zの扉"), shueishaCurrent("月Zの扉")],
  "202606",
);
assert.equal(ocrOneToOne.ocr_title_reconciled_rows, 2, "independent pairs reconcile one-to-one");
assert.equal(ocrOneToOne.overlay_rows, 2, "independent pairs overlay deterministically");
assert.equal(ocrOneToOne.append_rows, 0, "one-to-one reconciliation leaves no Shueisha append");

assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼の玉国")],
  "substitution is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼の国")],
  "deletion is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼ABCDの王国")],
  "more than three insertions is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国", { note2: null })],
  "unmarked current row is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国", { channel: "manga mee" })],
  "wrong channel is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国", { type: "AD" })],
  "wrong type is rejected",
);
assertOcrRejected(
  [shueishaBaseline("ABCD"), shueishaBaseline("ABCE")],
  [shueishaCurrent("ABCXDE")],
  "current-to-baseline best tie is rejected",
);
assertOcrRejected(
  [shueishaBaseline("ABCDE"), shueishaBaseline("ACE")],
  [shueishaCurrent("ABXCDE")],
  "second-best margin under three is rejected",
);
assertOcrRejected(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国"), shueishaCurrent("蒼Yの王国")],
  "reciprocal tie is rejected",
);

const ocrNonreciprocal = mergeCarryForwardRows(
  [shueishaBaseline("蒼の王国")],
  [shueishaCurrent("蒼Xの王国"), shueishaCurrent("蒼XYの王国")],
  "202606",
);
assert.equal(ocrNonreciprocal.ocr_title_reconciled_rows, 1, "only reciprocal best current row reconciles");
assert.equal(ocrNonreciprocal.overlay_rows, 1, "reciprocal best row overlays");
assert.equal(ocrNonreciprocal.append_rows, 1, "nonreciprocal row appends");

async function assertShueishaMarkerDoesNotLeakToWorkbook() {
  const markedText = `visible ${SHUEISHA_OCR_TITLE_MARKER} text`;
  const records = [
    {
      unique_identifier: markedText,
      channel_title_jp: markedText,
      title_kr: markedText,
      title_jp: markedText,
      recoder: markedText,
      company: markedText,
      clients: markedText,
      channel: markedText,
      type: markedText,
      distribution_strategy: markedText,
      settlement_currency: "JPY",
      vehicle_currency: "KRW",
      note1: markedText,
      note2: `left / ${SHUEISHA_OCR_TITLE_MARKER} / right`,
    },
  ];
  const { buffer, electronic_sheet } = await fillInputV2Template({ month: "202606", records });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(electronic_sheet);
  assert.ok(ws, `sheet ${electronic_sheet} exists in output`);
  const maxCol = Math.max(ws.columnCount, 102);
  for (let c = 1; c <= maxCol; c += 1) {
    const value = ws.getRow(6).getCell(c).value;
    if (typeof value !== "string") continue;
    assert.ok(
      !value.includes(SHUEISHA_OCR_TITLE_MARKER),
      `Shueisha OCR marker leaked into workbook cell 6:${c}`,
    );
  }
}

assertShueishaMarkerDoesNotLeakToWorkbook()
  .then(() => {
    console.log("OK: carry-forward synthetic regression passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
