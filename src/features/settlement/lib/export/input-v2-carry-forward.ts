import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

import { normalizeSbWorkKey } from "@/features/settlement/lib/parsers/sb-creative";
import { normalizeTitleKey } from "./input-v2-template-lookups";

type Prim = string | number | boolean | Date | null;

const BASELINE_FIRST_DATA_ROW = 6;

const BASELINE_COL = {
  unique_identifier: 1,
  channel_title_jp: 2,
  title_kr: 3,
  title_jp: 4,
  updated: 5,
  recoder: 6,
  company: 7,
  launch_date: 8,
  sales_month: 9,
  month: 10,
  settlement_month: 11,
  deposit_month: 12,
  country: 13,
  clients: 14,
  channel: 15,
  type: 16,
  distribution_strategy: 17,
  settlement_currency: 18,
  vehicle_currency: 19,
  total_amount_jpy: 20,
  fee_jpy: 21,
  before_tax_jpy: 22,
  after_tax_jpy: 23,
  rs: 24,
  before_tax_income_jpy: 25,
  withholding_tax_jpy: 26,
  tax_jpy: 27,
  after_tax_income_jpy: 28,
  after_tax_income_vehicle: 29,
  exchange_rate: 30,
  rate_krw_krw: 31,
  fee_krw: 33,
  before_tax_krw: 34,
  after_tax_krw: 35,
  after_tax_income_krw: 36,
  vat_krw: 37,
  withholding_tax_krw: 38,
  sales_krw: 39,
  mg_begin: 40,
  mg_increase: 41,
  mg_decrease: 42,
  mg_end: 43,
  note1: 44,
  note2: 45,
  allocation_rate: 46,
  total_allocation_rate: 48,
  distribution_coop_rate: 49,
  production_participation_rate: 51,
  creator_category: 54,
  creator_allocation_rate: 55,
} as const;

const MONEY_FIELDS = [
  "fee_jpy",
  "after_tax_jpy",
  "withholding_tax_jpy",
  "after_tax_income_jpy",
  "after_tax_income_vehicle",
  "fee_krw",
  "before_tax_krw",
  "after_tax_krw",
  "after_tax_income_krw",
  "vat_krw",
  "withholding_tax_krw",
  "sales_krw",
] as const;

// Rates are per-statement inputs, never carried across months.
const RATE_FIELDS = ["exchange_rate", "rate_krw_krw"] as const;

/**
 * Zero-carry policy is structural per channel family. Storefront/ad channels
 * blank their sales/deposit months and raw amounts when a month brings no
 * evidence; statement-cadence channels instead keep explicit zero amounts and
 * advance the row's own month cadence by exactly one calendar month.
 */
const BLANK_CARRY_CHANNELS = new Set([
  "cmoa",
  "piccoma_ads",
  "comico jp",
  "comico_ads",
  "u-next",
]);

const CADENCE_CARRY_CHANNELS = new Set([
  "mediado_sales",
  "renta",
  "bookcomi",
  "booklive",
  "dmm",
  "ebj_webtoon",
  "mbj_sales",
  "line",
  "mechacomic",
  "ebj",
  "mangabang",
  "piccoma",
]);

type ZeroCarryPolicy = "blank" | "cadence";

function zeroCarryPolicy(channel: string): ZeroCarryPolicy {
  if (BLANK_CARRY_CHANNELS.has(channel)) return "blank";
  if (CADENCE_CARRY_CHANNELS.has(channel)) return "cadence";
  // Channels without a verified cadence blank out rather than invent dates.
  return "blank";
}

const FORMULA_MONEY_FIELDS = [
  "total_amount_jpy",
  "before_tax_jpy",
  "before_tax_income_jpy",
  "tax_jpy",
] as const;

// Company and currency are NOT here: a statement may legitimately move a row
// to another company/currency, so those follow the current evidence.
const CONTRACT_FIELDS = [
  "launch_date",
  "rs",
  "allocation_rate",
  "total_allocation_rate",
  "distribution_coop_rate",
  "production_participation_rate",
  "creator_category",
  "creator_allocation_rate",
] as const;

/**
 * Internal provenance marker set by the merge phase and consumed by the
 * filler's fee/RS policy. It is a private record field like raw_type or
 * title_canonicalization: never mapped to a worksheet column.
 */
export const CARRY_FORWARD_PROVENANCE_FIELD = "carry_forward_provenance";

export type CarryForwardProvenance = "carry" | "overlay" | "append";

export interface CarryForwardCounts {
  carry_rows: number;
  overlay_rows: number;
  append_rows: number;
  drop_rows: number;
  /** Current rows whose title was canonicalized against the baseline roster. */
  canonical_title_rows: number;
  /** Current rows left unchanged because their title alias was ambiguous. */
  ambiguous_title_rows: number;
  /** Heuristic-typed current rows rewritten to their unique baseline contract type. */
  reconciled_type_rows: number;
  /** Heuristic-typed current rows left unchanged because baseline types collided. */
  ambiguous_type_rows: number;
  /**
   * Sibling statement rows merged into another current row with the same
   * business key: MBJ site files, plus reconciled-type siblings on eligible
   * channels whose keys collapsed after type reconciliation.
   */
  consolidated_rows: number;
  /** Marked Shueisha OCR rows whose title adopted a unique baseline spelling. */
  ocr_title_reconciled_rows: number;
}

export interface CarryForwardResult extends CarryForwardCounts {
  records: Record<string, unknown>[];
}

function cellValue(value: ExcelJS.CellValue): Prim {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return value;
  }
  if ("result" in value) return cellValue(value.result as ExcelJS.CellValue);
  if ("richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if ("text" in value) return String(value.text).trim();
  return String(value);
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(value: unknown): string | null {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Advance a baseline month cell by exactly one month, keeping the row's own
 * cadence: month-end dates stay month-end, other days keep their day number.
 * The workbook mixes Excel-native cells (UTC midnight) with tool-written
 * cells shifted by -9h (JST), so the civil date is canonicalized first.
 */
function shiftMonthForward(value: unknown): Date | null {
  const d = toDate(value);
  if (!d) return null;
  const canonical = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = canonical.getUTCFullYear();
  const m = canonical.getUTCMonth();
  const day = canonical.getUTCDate();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (day === lastOfMonth) return new Date(Date.UTC(y, m + 2, 0));
  return new Date(Date.UTC(y, m + 1, day));
}

function calendarDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

function addMonths(year: number, month: number, offset: number): { year: number; month: number } {
  const zeroBased = month - 1 + offset;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

function monthDefaults(month: string) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(4, 6));
  const settlement = addMonths(year, monthNumber, 1);
  const deposit = addMonths(year, monthNumber, 2);
  return {
    updated: calendarDate(settlement.year, settlement.month, 1),
    sales_month: calendarDate(year, monthNumber, 1),
    accounting_month: calendarDate(year, monthNumber, 1),
    settlement_month: lastDayOfMonth(settlement.year, settlement.month),
    deposit_month: lastDayOfMonth(deposit.year, deposit.month),
  };
}

function normalizePart(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

/** U+301C wave dash and U+FF5E fullwidth tilde are used interchangeably across statements. */
function foldWaveDash(text: string): string {
  return text.replace(/[〜～~]/g, "~");
}

/**
 * Row identity for carry/overlay matching: exactly (channel, type,
 * channel_title_jp) under NFKC + whitespace folding + wave-dash folding.
 * Clients, company, IDs, currency, and display metadata are deliberately
 * excluded — they vary between statements for the same logical row.
 */
export function carryForwardRecordKey(record: Record<string, unknown>): string | null {
  const channel = normalizePart(record.channel ?? record.channel_code);
  const type = normalizePart(record.type);
  const title = String(record.channel_title_jp ?? record.title_jp ?? "").trim();
  if (!channel || !type || !title) return null;
  return `${channel}\u0000${type}\u0000${normalizeTitleKey(foldWaveDash(title))}`;
}

function hasOwnValue(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  return value !== null && value !== undefined && value !== "";
}

// ---------------------------------------------------------------------------
// Baseline title canonicalization
//
// Publisher invoice statements occasionally misspell a title the prior
// month's workbook already spells correctly (one missing codepoint, or one or
// two missing terminal punctuation marks). Only current rows whose title
// carries a registered structural suffix are eligible: their base is
// canonicalized against the baseline roster of the same normalized channel
// and the suffix is reattached unchanged. No Levenshtein, substitutions, or
// cross-channel matching — aliases are exact signatures derived from each
// baseline canonical base only.
// ---------------------------------------------------------------------------

/** Structural invoice suffix classes eligible for base canonicalization. */
const STRUCTURAL_TITLE_SUFFIXES = ["（20th色紙原稿料）"] as const;

/** Bases shorter than this (normalized codepoints) get no deletion aliases. */
const MIN_ALIAS_BASE_CODEPOINTS = 8;

const PUNCTUATION_CODEPOINT = /^[\p{P}\p{S}]$/u;

/** Signature used for alias lookups: same folding as the carry key title. */
function titleSignature(text: string): string {
  return normalizeTitleKey(foldWaveDash(text));
}

export function splitStructuralSuffix(title: string): { base: string; suffix: string } {
  for (const suffix of STRUCTURAL_TITLE_SUFFIXES) {
    for (const variant of new Set([suffix, suffix.normalize("NFKC")])) {
      if (title.endsWith(variant) && title.length > variant.length) {
        return { base: title.slice(0, -variant.length).trim(), suffix: variant };
      }
    }
  }
  return { base: title, suffix: "" };
}

/** signature → canonical base, or null when two canonical bases collide. */
type TitleAliasBucket = Map<string, string | null>;

function registerAlias(bucket: TitleAliasBucket, signature: string, canonical: string) {
  if (!signature) return;
  const existing = bucket.get(signature);
  if (existing === undefined) bucket.set(signature, canonical);
  else if (existing !== null && existing !== canonical) bucket.set(signature, null);
}

/**
 * Build per-channel alias signatures from baseline canonical bases: the exact
 * signature, every one-codepoint deletion, and terminal punctuation deletions
 * of one or two codepoints. Short bases only register their exact signature.
 */
export function buildBaselineTitleAliases(
  baselineRows: Record<string, unknown>[],
): Map<string, TitleAliasBucket> {
  const byChannel = new Map<string, TitleAliasBucket>();
  for (const row of baselineRows) {
    const channel = normalizePart(row.channel ?? row.channel_code);
    const title = String(row.channel_title_jp ?? row.title_jp ?? "").trim();
    if (!channel || !title) continue;
    const canonical = splitStructuralSuffix(title).base;
    const signature = titleSignature(canonical);
    if (!signature) continue;
    const bucket = byChannel.get(channel) ?? new Map<string, string | null>();
    byChannel.set(channel, bucket);
    registerAlias(bucket, signature, canonical);
    const codepoints = [...signature];
    if (codepoints.length < MIN_ALIAS_BASE_CODEPOINTS) continue;
    for (let i = 0; i < codepoints.length; i += 1) {
      registerAlias(
        bucket,
        codepoints.slice(0, i).join("") + codepoints.slice(i + 1).join(""),
        canonical,
      );
    }
    if (PUNCTUATION_CODEPOINT.test(codepoints[codepoints.length - 1])) {
      registerAlias(bucket, codepoints.slice(0, -1).join(""), canonical);
      if (PUNCTUATION_CODEPOINT.test(codepoints[codepoints.length - 2])) {
        registerAlias(bucket, codepoints.slice(0, -2).join(""), canonical);
      }
    }
  }
  return byChannel;
}

export interface TitleCanonicalization {
  title: string;
  changed: boolean;
  ambiguous: boolean;
}

/**
 * Canonicalize a current statement title against the baseline roster of its
 * channel. Only titles with a registered structural suffix are eligible; the
 * suffix is reattached unchanged. An ambiguous alias leaves the title as-is.
 */
export function canonicalizeStatementTitle(
  title: string,
  channel: string,
  aliases: Map<string, TitleAliasBucket>,
): TitleCanonicalization {
  const unchanged: TitleCanonicalization = { title, changed: false, ambiguous: false };
  const { base, suffix } = splitStructuralSuffix(title);
  if (!suffix) return unchanged;
  const bucket = aliases.get(channel);
  if (!bucket) return unchanged;
  const canonical = bucket.get(titleSignature(base));
  if (canonical === undefined) return unchanged;
  if (canonical === null) return { title, changed: false, ambiguous: true };
  const rewritten = `${canonical}${suffix}`;
  if (rewritten === title) return unchanged;
  return { title: rewritten, changed: true, ambiguous: false };
}

function canonicalizeCurrentRow(
  row: Record<string, unknown>,
  aliases: Map<string, TitleAliasBucket>,
): { row: Record<string, unknown>; changed: boolean; ambiguous: boolean } {
  const channel = normalizePart(row.channel ?? row.channel_code);
  const field = hasOwnValue(row, "channel_title_jp") ? "channel_title_jp" : "title_jp";
  const title = String(row[field] ?? "").trim();
  if (!channel || !title) return { row, changed: false, ambiguous: false };
  const result = canonicalizeStatementTitle(title, channel, aliases);
  if (result.ambiguous) {
    return { row: { ...row, title_canonicalization: "ambiguous" }, changed: false, ambiguous: true };
  }
  if (!result.changed) return { row, changed: false, ambiguous: false };
  const rewritten: Record<string, unknown> = {
    ...row,
    [field]: result.title,
    title_canonicalization: "baseline",
  };
  if (!hasOwnValue(rewritten, "raw_title")) rewritten.raw_title = title;
  return { row: rewritten, changed: true, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Heuristic contract-type reconciliation
//
// LINE/EBJ and Mechacomic parsers mark rows whose type came from an ambiguous
// fallback (unit-only, bare 巻, sibling inference) with TYPE_HEURISTIC in
// note2. Before carry keys are built, such a row adopts the baseline contract
// type when the same normalized channel + title has exactly one type in the
// baseline ledger. Explicit source evidence (no marker) is never overridden,
// and colliding baseline types leave the row unchanged with a diagnostic
// count — unless the heuristic type is absent from the multi-type roster and
// sibling current rows already claim all but exactly one baseline type; then
// the row adopts that unique unclaimed type. Zero or several unclaimed
// candidates still fail closed. Only when the channel has no baseline roster
// for the title at all
// does matching widen to the exact normalized title across every baseline
// channel, and it is trusted only when the whole ledger agrees on a single
// type; any global disagreement leaves the row unchanged.
//
// Piccoma is stricter: its statement distinguishes only 話 (chapter) and 巻
// (volume) sale columns, so default rows carry a family-scoped marker
// (TYPE_HEURISTIC:chapter / TYPE_HEURISTIC:volume). Such a row may adopt a
// baseline type only from its own family (chapter → WT/WR/WN, volume →
// EB/EP), only from the exact same channel + normalized title, and only when
// exactly one compatible baseline type is not already claimed by an exact
// current row. Multiple unclaimed candidates fail closed, and there is no
// global-title fallback. Explicit alias overrides and novel evidence emit no
// marker and are never touched.
// ---------------------------------------------------------------------------

const TYPE_HEURISTIC_MARKER = "TYPE_HEURISTIC";

const TYPE_RECONCILE_CHANNELS = new Set([
  "line",
  "ebj",
  "ebj_webtoon",
  "mechacomic",
  "booklive",
  "bookcomi",
  "piccoma",
]);

const PICCOMA_CHANNEL = "piccoma";

const PICCOMA_FAMILY_TYPES = {
  chapter: new Set(["wt", "wr", "wn"]),
  volume: new Set(["eb", "ep"]),
} as const;

function piccomaHeuristicFamily(
  row: Record<string, unknown>,
): keyof typeof PICCOMA_FAMILY_TYPES | null {
  const note2 = String(row.note2 ?? "");
  if (note2.includes(`${TYPE_HEURISTIC_MARKER}:chapter`)) return "chapter";
  if (note2.includes(`${TYPE_HEURISTIC_MARKER}:volume`)) return "volume";
  return null;
}

function reconcileTitleKey(row: Record<string, unknown>): string | null {
  const title = String(row.channel_title_jp ?? row.title_jp ?? "").trim();
  if (!title) return null;
  return normalizeTitleKey(foldWaveDash(title));
}

function hasHeuristicTypeMarker(row: Record<string, unknown>): boolean {
  return String(row.note2 ?? "").includes(TYPE_HEURISTIC_MARKER);
}

interface BaselineTypeRoster {
  /** channel\0title → distinct baseline contract types (normalized → raw spelling). */
  byChannelTitle: Map<string, Map<string, unknown>>;
  /** title → distinct baseline contract types across every baseline channel. */
  byTitle: Map<string, Map<string, unknown>>;
}

function registerRosterType(
  roster: Map<string, Map<string, unknown>>,
  key: string,
  type: string,
  rawType: unknown,
) {
  const types = roster.get(key) ?? new Map<string, unknown>();
  roster.set(key, types);
  if (!types.has(type)) types.set(type, rawType);
}

function buildBaselineTypeRoster(baselineRows: Record<string, unknown>[]): BaselineTypeRoster {
  const roster: BaselineTypeRoster = { byChannelTitle: new Map(), byTitle: new Map() };
  for (const row of baselineRows) {
    const channel = normalizePart(row.channel ?? row.channel_code);
    const titleKey = reconcileTitleKey(row);
    const type = normalizePart(row.type);
    if (!titleKey || !type) continue;
    registerRosterType(roster.byTitle, titleKey, type, row.type);
    if (!TYPE_RECONCILE_CHANNELS.has(channel)) continue;
    registerRosterType(roster.byChannelTitle, `${channel}\u0000${titleKey}`, type, row.type);
  }
  return roster;
}

/**
 * Family-restricted Piccoma reconciliation. Candidates come only from the
 * piccoma baseline roster of the exact normalized title, filtered to the
 * marker's family. An exact-match own type wins outright (the simultaneous
 * exact row overlays untouched); otherwise the unique compatible baseline
 * type not already claimed by an exact current-row key is adopted, and two or
 * more unclaimed candidates fail closed as ambiguous.
 */
function reconcilePiccomaHeuristicType(
  row: Record<string, unknown>,
  roster: BaselineTypeRoster,
  currentKeys: ReadonlySet<string>,
): { row: Record<string, unknown>; reconciled: boolean; ambiguous: boolean } {
  const unchanged = { row, reconciled: false, ambiguous: false };
  const family = piccomaHeuristicFamily(row);
  if (!family) return unchanged;
  const titleKey = reconcileTitleKey(row);
  if (!titleKey) return unchanged;
  const channelTypes = roster.byChannelTitle.get(`${PICCOMA_CHANNEL}\u0000${titleKey}`);
  if (!channelTypes || channelTypes.size === 0) return unchanged;
  const compatible = [...channelTypes.entries()].filter(([type]) =>
    PICCOMA_FAMILY_TYPES[family].has(type),
  );
  if (compatible.some(([type]) => type === normalizePart(row.type))) return unchanged;
  const unclaimed = compatible.filter(
    ([type]) => !currentKeys.has(`${PICCOMA_CHANNEL}\u0000${type}\u0000${titleKey}`),
  );
  if (unclaimed.length === 0) return unchanged;
  if (unclaimed.length > 1) return { row, reconciled: false, ambiguous: true };
  const [[, contractType]] = unclaimed;
  return {
    row: { ...row, type: contractType, raw_type: row.type, type_reconciliation: "baseline" },
    reconciled: true,
    ambiguous: false,
  };
}

function reconcileHeuristicType(
  row: Record<string, unknown>,
  roster: BaselineTypeRoster,
  currentKeys: ReadonlySet<string>,
): { row: Record<string, unknown>; reconciled: boolean; ambiguous: boolean } {
  const unchanged = { row, reconciled: false, ambiguous: false };
  if (!hasHeuristicTypeMarker(row)) return unchanged;
  const channel = normalizePart(row.channel ?? row.channel_code);
  if (!TYPE_RECONCILE_CHANNELS.has(channel)) return unchanged;
  if (channel === PICCOMA_CHANNEL) {
    return reconcilePiccomaHeuristicType(row, roster, currentKeys);
  }
  const titleKey = reconcileTitleKey(row);
  if (!titleKey) return unchanged;
  const channelTypes = roster.byChannelTitle.get(`${channel}\u0000${titleKey}`);
  // A same-channel multi-type roster is authoritative and never widens to the
  // global ledger. A heuristic type already present in the roster stays
  // ambiguous; a type absent from the roster may adopt the single baseline
  // type not already claimed by a sibling current row, failing closed when
  // zero or several roster types remain unclaimed.
  if (channelTypes && channelTypes.size > 1) {
    if (channelTypes.has(normalizePart(row.type))) {
      return { row, reconciled: false, ambiguous: true };
    }
    const unclaimed = [...channelTypes.entries()].filter(
      ([type]) => !currentKeys.has(`${channel}\u0000${type}\u0000${titleKey}`),
    );
    if (unclaimed.length !== 1) return { row, reconciled: false, ambiguous: true };
    const [[, contractType]] = unclaimed;
    return {
      row: { ...row, type: contractType, raw_type: row.type, type_reconciliation: "baseline" },
      reconciled: true,
      ambiguous: false,
    };
  }
  let types = channelTypes;
  if (!types || types.size === 0) {
    // No same-channel roster for this title: the exact-title global ledger is
    // trusted only when every historical row agrees on a single type.
    const globalTypes = roster.byTitle.get(titleKey);
    if (!globalTypes || globalTypes.size !== 1) return unchanged;
    types = globalTypes;
  }
  const [contractType] = types.values();
  if (normalizePart(row.type) === normalizePart(contractType)) return unchanged;
  return {
    row: { ...row, type: contractType, raw_type: row.type, type_reconciliation: "baseline" },
    reconciled: true,
    ambiguous: false,
  };
}

// ---------------------------------------------------------------------------
// MBJ sibling consolidation
//
// Each MBJ bookstore-site .xls parses independently, so current rows sharing
// one business key (channel, type, normalized title) only meet here. They are
// merged into a single row before carry keys: additive money fields are
// summed exactly, everything else comes from a deterministically chosen
// sibling so file order never changes the result. Other channels and rows
// without a resolvable key pass through untouched.
// ---------------------------------------------------------------------------

const MBJ_CONSOLIDATE_CHANNEL = "mbj_sales";

const MBJ_ADDITIVE_MONEY_FIELDS = [
  "total_amount_jpy",
  "fee_jpy",
  "before_tax_jpy",
  "after_tax_jpy",
  "before_tax_income_jpy",
  "withholding_tax_jpy",
  "consumption_tax_jpy",
  "after_tax_income_jpy",
] as const;

/** Canonical serialization so sibling merging is input-order invariant. */
function stableRowSignature(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((key) => {
        const value = row[key];
        return [key, value instanceof Date ? value.toISOString() : value ?? null];
      }),
  );
}

function mergeMbjSiblings(bucket: Record<string, unknown>[]): Record<string, unknown> {
  const sorted = [...bucket].sort((a, b) =>
    stableRowSignature(a).localeCompare(stableRowSignature(b)),
  );
  const merged = { ...sorted[0] };
  for (const field of MBJ_ADDITIVE_MONEY_FIELDS) {
    const values = sorted
      .map((row) => row[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length > 0) merged[field] = values.reduce((sum, value) => sum + value, 0);
  }
  const sources = [
    ...new Set(
      sorted
        .map((row) => String(row.source_file ?? row.upload_id ?? row.id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  merged.consolidated_source_count = sorted.length;
  if (sources.length > 0) merged.consolidated_sources = sources;
  return merged;
}

function consolidateMbjSiblingRows(
  rows: Record<string, unknown>[],
): { rows: Record<string, unknown>[]; consolidated: number } {
  const buckets = new Map<string, Record<string, unknown>[]>();
  const slots: Array<{ row?: Record<string, unknown>; key?: string }> = [];
  for (const row of rows) {
    const channel = normalizePart(row.channel ?? row.channel_code);
    const key = channel === MBJ_CONSOLIDATE_CHANNEL ? carryForwardRecordKey(row) : null;
    if (!key) {
      slots.push({ row });
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
      slots.push({ key });
    }
  }
  let consolidated = 0;
  const out = slots.map((slot) => {
    if (slot.row) return slot.row;
    const bucket = buckets.get(slot.key!)!;
    if (bucket.length === 1) return bucket[0];
    consolidated += bucket.length - 1;
    return mergeMbjSiblings(bucket);
  });
  return { rows: out, consolidated };
}

// ---------------------------------------------------------------------------
// Reconciled-key consolidation
//
// When type reconciliation collapses two source unit categories onto one
// business key (the EBJ case: an explicit row plus a heuristic sibling
// reconciled to the same contract type), the siblings merge into a single row
// exactly like MBJ site files: additive money fields sum, everything else
// comes from a deterministically chosen sibling. Buckets whose duplicate keys
// predate reconciliation (no type_reconciliation=baseline member) pass
// through untouched, as do non-eligible channels.
// ---------------------------------------------------------------------------

function consolidateReconciledTypeRows(
  rows: Record<string, unknown>[],
): { rows: Record<string, unknown>[]; consolidated: number } {
  const keyOf = (row: Record<string, unknown>): string | null => {
    const channel = normalizePart(row.channel ?? row.channel_code);
    return TYPE_RECONCILE_CHANNELS.has(channel) ? carryForwardRecordKey(row) : null;
  };
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  let consolidated = 0;
  const mergedKeys = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = key ? buckets.get(key)! : null;
    const mergeable =
      bucket !== null &&
      bucket.length > 1 &&
      bucket.some((sibling) => sibling.type_reconciliation === "baseline");
    if (!mergeable) {
      out.push(row);
      continue;
    }
    if (mergedKeys.has(key!)) continue;
    mergedKeys.add(key!);
    consolidated += bucket.length - 1;
    const merged = mergeMbjSiblings(bucket);
    merged.type_consolidation = "baseline";
    out.push(merged);
  }
  return { rows: out, consolidated };
}

// ---------------------------------------------------------------------------
// Shueisha local-OCR title reconciliation
//
// The Shueisha payment notice is a scanned image parsed by local OCR, so a
// current title can carry a few spurious inserted characters that the
// baseline spelling does not have. Rows emitted by the Shueisha parser are
// marked with SHUEISHA_OCR_TITLE_MARKER in note2 (the TYPE_HEURISTIC
// convention); the marker is a private token stripped from note2 at the
// workbook boundary. Only marked current rows — and only after exact key
// matching found nothing on either side — may adopt a baseline title, and
// only when every gate passes:
//   · same normalized channel and same normalized contract type
//   · the baseline normalized title is a proper subsequence of the current
//     normalized title (insertion-only OCR noise), with ≤3 insertions
//   · the best baseline candidate is unique (no distance tie), beats the
//     second-best candidate by ≥3 insertions (or has no second candidate),
//     and the current row is reciprocally the unique closest marked row for
//     that baseline title.
// Matching is computed from immutable snapshots and inherently one-to-one;
// the title identity is rewritten to the baseline spelling only after all
// gates pass, so the ordinary exact overlay does the rest.
// ---------------------------------------------------------------------------

export const SHUEISHA_OCR_TITLE_MARKER = "SHUEISHA_OCR_TITLE";

const OCR_TITLE_MAX_INSERTIONS = 3;
const OCR_TITLE_SECOND_BEST_MARGIN = 3;

function hasShueishaOcrTitleMarker(row: Record<string, unknown>): boolean {
  return String(row.note2 ?? "").includes(SHUEISHA_OCR_TITLE_MARKER);
}

/** Remove the private OCR provenance token from a workbook-visible string. */
export function stripShueishaOcrTitleMarker(note2: string | null): string | null {
  if (!note2 || !note2.includes(SHUEISHA_OCR_TITLE_MARKER)) return note2;
  const cleaned = note2
    .replaceAll(SHUEISHA_OCR_TITLE_MARKER, "")
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
  return cleaned || null;
}

/** True when `needle` is a subsequence of `hay` (codepoint arrays). */
function isCodepointSubsequence(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const cp of hay) {
    if (i < needle.length && cp === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Insertion count from a baseline title to a current title, or null when the
 * current title is not a strict insertion-only superset. For a subsequence,
 * Levenshtein distance is exactly the codepoint-length difference.
 */
function ocrInsertionDistance(baseline: string[], current: string[]): number | null {
  if (current.length <= baseline.length) return null;
  if (!isCodepointSubsequence(baseline, current)) return null;
  return current.length - baseline.length;
}

function ocrChannelTypeKey(row: Record<string, unknown>): string | null {
  const channel = normalizePart(row.channel ?? row.channel_code);
  const type = normalizePart(row.type);
  if (!channel || !type) return null;
  return `${channel}\u0000${type}`;
}

function ocrTitleKey(row: Record<string, unknown>): string {
  return normalizeTitleKey(
    foldWaveDash(String(row.channel_title_jp ?? row.title_jp ?? "").trim()),
  );
}

function reconcileShueishaOcrTitles(
  baselineRows: Record<string, unknown>[],
  currentRows: Record<string, unknown>[],
): { rows: Record<string, unknown>[]; reconciled: number } {
  const currentKeys = new Set(currentRows.map(carryForwardRecordKey).filter(Boolean));

  // Unmatched baseline spellings per (channel, type): titleKey → raw spellings.
  const baselineTitles = new Map<string, Map<string, { channelTitle: string; titleJp: string | null }>>();
  for (const row of baselineRows) {
    const key = carryForwardRecordKey(row);
    if (!key || currentKeys.has(key)) continue; // exact matching stays first
    const groupKey = ocrChannelTypeKey(row);
    if (!groupKey) continue;
    const titleKey = ocrTitleKey(row);
    if (!titleKey) continue;
    const group = baselineTitles.get(groupKey) ?? new Map();
    baselineTitles.set(groupKey, group);
    if (!group.has(titleKey)) {
      group.set(titleKey, {
        channelTitle: String(row.channel_title_jp ?? row.title_jp ?? "").trim(),
        titleJp: hasOwnValue(row, "title_jp") ? String(row.title_jp).trim() : null,
      });
    }
  }
  if (baselineTitles.size === 0) return { rows: currentRows, reconciled: 0 };

  const baselineKeys = new Set(baselineRows.map(carryForwardRecordKey).filter(Boolean));
  // Marked current rows with no exact baseline match: the only fuzzy-eligible set.
  const eligible = currentRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (!hasShueishaOcrTitleMarker(row)) return false;
      const key = carryForwardRecordKey(row);
      return key !== null && !baselineKeys.has(key);
    });

  const planned: Array<{ index: number; channelTitle: string; titleJp: string | null }> = [];
  for (const { row, index } of eligible) {
    const groupKey = ocrChannelTypeKey(row);
    const group = groupKey ? baselineTitles.get(groupKey) : undefined;
    if (!group) continue;
    const currentCps = [...ocrTitleKey(row)];
    const candidates: Array<{ titleKey: string; distance: number }> = [];
    for (const titleKey of group.keys()) {
      const distance = ocrInsertionDistance([...titleKey], currentCps);
      if (distance !== null) candidates.push({ titleKey, distance });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.distance - b.distance || a.titleKey.localeCompare(b.titleKey));
    const [best, second] = candidates;
    if (best.distance > OCR_TITLE_MAX_INSERTIONS) continue;
    if (second && second.distance === best.distance) continue; // tied best
    if (second && second.distance - best.distance < OCR_TITLE_SECOND_BEST_MARGIN) continue;

    // Reciprocal gate: this row must be the unique closest marked row for the
    // chosen baseline title, so two current rows can never claim one baseline.
    const bestCps = [...best.titleKey];
    let reciprocalIndex = -1;
    let reciprocalDistance = Number.POSITIVE_INFINITY;
    let reciprocalUnique = false;
    for (const other of eligible) {
      if (ocrChannelTypeKey(other.row) !== groupKey) continue;
      const distance = ocrInsertionDistance(bestCps, [...ocrTitleKey(other.row)]);
      if (distance === null) continue;
      if (distance < reciprocalDistance) {
        reciprocalDistance = distance;
        reciprocalIndex = other.index;
        reciprocalUnique = true;
      } else if (distance === reciprocalDistance) {
        reciprocalUnique = false;
      }
    }
    if (!reciprocalUnique || reciprocalIndex !== index) continue;

    const spelling = group.get(best.titleKey)!;
    planned.push({ index, channelTitle: spelling.channelTitle, titleJp: spelling.titleJp });
  }

  if (planned.length === 0) return { rows: currentRows, reconciled: 0 };
  const rows = [...currentRows];
  for (const { index, channelTitle, titleJp } of planned) {
    const row = rows[index];
    const original = String(row.channel_title_jp ?? row.title_jp ?? "").trim();
    const rewritten: Record<string, unknown> = {
      ...row,
      title_reconciliation: "shueisha_ocr_baseline",
    };
    if (hasOwnValue(row, "channel_title_jp")) rewritten.channel_title_jp = channelTitle;
    // The garbled OCR base title must not leak through the overlay either.
    if (hasOwnValue(row, "title_jp")) rewritten.title_jp = titleJp ?? channelTitle;
    if (!hasOwnValue(rewritten, "raw_title")) rewritten.raw_title = original;
    rows[index] = rewritten;
  }
  return { rows, reconciled: planned.length };
}

function applySheetMonths(record: Record<string, unknown>, month: string) {
  const defaults = monthDefaults(month);
  record.updated = defaults.updated;
  record.updated_at = defaults.updated;
  record.month = defaults.accounting_month;
  record.accounting_month = defaults.accounting_month;
  record.settlement_month = defaults.settlement_month;
  return defaults;
}

/**
 * Blank raw monetary inputs so the filler regenerates formula columns from
 * the template and leaves value columns blank (null, not literal 0).
 */
function clearMonetaryInputs(record: Record<string, unknown>) {
  for (const field of MONEY_FIELDS) record[field] = null;
  for (const field of RATE_FIELDS) record[field] = null;
  for (const field of FORMULA_MONEY_FIELDS) record[field] = null;
}

/** Explicit-zero variant for cadence channels: raw amounts become literal 0. */
function zeroMonetaryInputs(record: Record<string, unknown>) {
  for (const field of MONEY_FIELDS) record[field] = 0;
  for (const field of RATE_FIELDS) record[field] = null;
  for (const field of FORMULA_MONEY_FIELDS) record[field] = null;
}

function preserveContractMetadata(
  target: Record<string, unknown>,
  baseline: Record<string, unknown>,
) {
  for (const field of CONTRACT_FIELDS) {
    if (hasOwnValue(baseline, field)) target[field] = baseline[field];
  }
}

function mergeOverlay(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  month: string,
): Record<string, unknown> {
  const merged = { ...baseline };
  // The statement is authoritative for amounts: never let a baseline amount
  // survive into a month the statement did not report it for.
  clearMonetaryInputs(merged);
  // Overlay every value the statement actually provides (dates, amounts,
  // company/currency, display metadata). Fields the statement is silent on
  // (null/empty) keep their baseline value as-is — no roll-forward, no
  // modal fill.
  for (const [field, value] of Object.entries(current)) {
    if (value !== null && value !== undefined && value !== "") merged[field] = value;
  }
  preserveContractMetadata(merged, baseline);
  applySheetMonths(merged, month);
  merged[CARRY_FORWARD_PROVENANCE_FIELD] = "overlay" satisfies CarryForwardProvenance;
  return merged;
}

function carryRow(baseline: Record<string, unknown>, month: string): Record<string, unknown> {
  const carried = { ...baseline };
  applySheetMonths(carried, month);
  // No current evidence: contract metadata (launch date, country, clients,
  // channel, type, distribution strategy, RS/allocation) survives from the
  // baseline clone; the money/date treatment is the channel's carry policy.
  const channel = normalizePart(carried.channel ?? carried.channel_code);
  if (zeroCarryPolicy(channel) === "cadence") {
    zeroMonetaryInputs(carried);
    carried.sales_month = shiftMonthForward(baseline.sales_month);
    carried.deposit_month = shiftMonthForward(baseline.deposit_month);
  } else {
    clearMonetaryInputs(carried);
    carried.sales_month = null;
    carried.deposit_month = null;
  }
  carried[CARRY_FORWARD_PROVENANCE_FIELD] = "carry" satisfies CarryForwardProvenance;
  return carried;
}

function appendRow(record: Record<string, unknown>, month: string): Record<string, unknown> {
  const appended = { ...record };
  const defaults = applySheetMonths(appended, month);
  if (!dateKey(appended.sales_month)) appended.sales_month = defaults.sales_month;
  if (!dateKey(appended.deposit_month)) appended.deposit_month = defaults.deposit_month;
  appended[CARRY_FORWARD_PROVENANCE_FIELD] = "append" satisfies CarryForwardProvenance;
  return appended;
}

function isSbCreativeRow(record: Record<string, unknown>): boolean {
  const channel = normalizePart(record.channel ?? record.channel_code);
  return channel === "sb creative" || channel === "sbcreative" || channel === "sb_creative";
}

function sbSeriesKey(record: Record<string, unknown>): string | null {
  const title = String(record.channel_title_jp ?? record.title_jp ?? "").trim();
  if (!title) return null;
  const key = normalizeSbWorkKey(title).seriesKey;
  return key || null;
}

function shouldDropBaselineRow(
  record: Record<string, unknown>,
  sbCurrentSeries: ReadonlySet<string>,
): boolean {
  // Monthly publisher documents are source-driven. Client names alone are too
  // broad: Shueisha/Ichijinsha also own channels whose contract rows must carry.
  const channel = normalizePart(record.channel ?? record.channel_code);
  if (channel === "kadokawa" || channel === "shueisha") return true;
  // SB Creative: the current sales report replaces a series' prior rows at
  // work+volume granularity, so coarse baseline keys for that series must not
  // carry (not even as zero rows). Series absent from the current report keep
  // their normal carry behavior.
  if (isSbCreativeRow(record)) {
    const series = sbSeriesKey(record);
    return series !== null && sbCurrentSeries.has(series);
  }
  return false;
}

export function mergeCarryForwardRows(
  baselineRows: Record<string, unknown>[],
  currentRows: Record<string, unknown>[],
  month: string,
): CarryForwardResult {
  // Canonicalize eligible current titles against the baseline roster before
  // any key building or dedupe, so a source typo overlays its contract row
  // instead of appending a near-duplicate.
  const titleAliases = buildBaselineTitleAliases(baselineRows);
  let canonicalTitleRows = 0;
  let ambiguousTitleRows = 0;
  const canonicalizedRows = currentRows.map((row) => {
    const result = canonicalizeCurrentRow(row, titleAliases);
    if (result.changed) canonicalTitleRows += 1;
    if (result.ambiguous) ambiguousTitleRows += 1;
    return result.row;
  });

  // Heuristic-typed current rows adopt their unique baseline contract type
  // before any carry key is built, so they overlay the contract row instead
  // of appending a duplicate next to a zero-carry.
  const typeRoster = buildBaselineTypeRoster(baselineRows);
  const currentTypeKeys = new Set<string>();
  for (const row of canonicalizedRows) {
    const channel = normalizePart(row.channel ?? row.channel_code);
    const type = normalizePart(row.type);
    const titleKey = reconcileTitleKey(row);
    if (channel && type && titleKey) currentTypeKeys.add(`${channel}\u0000${type}\u0000${titleKey}`);
  }
  let reconciledTypeRows = 0;
  let ambiguousTypeRows = 0;
  const reconciledRows = canonicalizedRows.map((row) => {
    const result = reconcileHeuristicType(row, typeRoster, currentTypeKeys);
    if (result.reconciled) reconciledTypeRows += 1;
    if (result.ambiguous) ambiguousTypeRows += 1;
    return result.row;
  });

  const consolidation = consolidateMbjSiblingRows(reconciledRows);
  const typeConsolidation = consolidateReconciledTypeRows(consolidation.rows);

  // Marked Shueisha OCR rows may adopt a unique insertion-only baseline
  // spelling before keys are built, so they overlay their contract row
  // instead of appending next to a zero-carry duplicate.
  const ocrTitleReconciliation = reconcileShueishaOcrTitles(
    baselineRows,
    typeConsolidation.rows,
  );
  const preparedRows = ocrTitleReconciliation.rows;

  const baselineByKey = new Map<string, Record<string, unknown>[]>();
  let dropRows = 0;

  const sbCurrentSeries = new Set<string>();
  for (const row of currentRows) {
    if (!isSbCreativeRow(row)) continue;
    const series = sbSeriesKey(row);
    if (series) sbCurrentSeries.add(series);
  }

  for (const row of baselineRows) {
    if (shouldDropBaselineRow(row, sbCurrentSeries)) {
      dropRows += 1;
      continue;
    }
    const key = carryForwardRecordKey(row);
    if (!key) {
      dropRows += 1;
      continue;
    }
    const bucket = baselineByKey.get(key) ?? [];
    bucket.push(row);
    baselineByKey.set(key, bucket);
  }

  const currentByKey = new Map<string, Record<string, unknown>[]>();
  const appendOnly: Record<string, unknown>[] = [];
  for (const row of preparedRows) {
    const key = carryForwardRecordKey(row);
    if (!key) {
      appendOnly.push(row);
      continue;
    }
    const bucket = currentByKey.get(key) ?? [];
    const channel = normalizePart(row.channel ?? row.channel_code);
    // Piccoma's 出版社report and 取次report represent the same statement.
    // Keep one logical row per title/type regardless of nullable master IDs.
    if (channel === "piccoma" && bucket.length > 0) {
      dropRows += 1;
      continue;
    }
    bucket.push(row);
    currentByKey.set(key, bucket);
  }

  const records: Record<string, unknown>[] = [];
  let carryRows = 0;
  let overlayRows = 0;
  let appendRows = 0;

  for (const [key, baselineBucket] of baselineByKey) {
    const currentBucket = currentByKey.get(key) ?? [];
    for (const baselineRow of baselineBucket) {
      const currentRow = currentBucket.shift();
      if (currentRow) {
        records.push(mergeOverlay(baselineRow, currentRow, month));
        overlayRows += 1;
      } else {
        records.push(carryRow(baselineRow, month));
        carryRows += 1;
      }
    }
    if (currentBucket.length === 0) currentByKey.delete(key);
  }

  for (const row of appendOnly) {
    records.push(appendRow(row, month));
    appendRows += 1;
  }
  for (const bucket of currentByKey.values()) {
    for (const row of bucket) {
      records.push(appendRow(row, month));
      appendRows += 1;
    }
  }

  return {
    records,
    carry_rows: carryRows,
    overlay_rows: overlayRows,
    append_rows: appendRows,
    drop_rows: dropRows,
    canonical_title_rows: canonicalTitleRows,
    ambiguous_title_rows: ambiguousTitleRows,
    reconciled_type_rows: reconciledTypeRows,
    ambiguous_type_rows: ambiguousTypeRows,
    consolidated_rows: consolidation.consolidated + typeConsolidation.consolidated,
    ocr_title_reconciled_rows: ocrTitleReconciliation.reconciled,
  };
}

function readBaselineRow(row: ExcelJS.Row): Record<string, unknown> | null {
  const record: Record<string, unknown> = {};
  for (const [field, col] of Object.entries(BASELINE_COL)) {
    record[field] = cellValue(row.getCell(col).value);
  }
  if (!record.channel_title_jp && !record.channel) return null;
  return record;
}

export async function loadCarryForwardBaselineRowsFromBuffer(
  buffer: Buffer | ArrayBuffer | Uint8Array,
): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets.find((sheet) => /^input_電子_\d+月$/.test(sheet.name));
  if (!ws) {
    throw new Error("Carry-forward baseline has no input_電子_N月 sheet");
  }

  const records: Record<string, unknown>[] = [];
  for (let r = BASELINE_FIRST_DATA_ROW; r <= ws.actualRowCount; r += 1) {
    const record = readBaselineRow(ws.getRow(r));
    if (record) records.push(record);
  }
  return records;
}

export async function loadCarryForwardBaselineRows(
  baselinePath: string | URL,
): Promise<Record<string, unknown>[]> {
  return loadCarryForwardBaselineRowsFromBuffer(await readFile(baselinePath));
}
