/**
 * Deterministic comparison of two INPUT workbooks (generated candidate vs
 * human answer-key). Either side can be wrong — findings are symmetric and
 * only describe differences; nothing is ever copied between the workbooks.
 *
 * Rows are matched as an identity multiset on (channel, type, title): within
 * each identity group, candidate rows are paired to golden rows by an exact
 * globally minimum-cost assignment (bitmask DP for small groups, Hungarian
 * for larger ones), computed over canonically sorted rows so the pairing —
 * and any tie between equal-cost assignments — is independent of row order
 * in either file. Unpaired golden rows are 'missing', unpaired candidate
 * rows are 'extra'.
 *
 * Only the 14 business fields (BUSINESS_COMPARE_FIELDS) are compared per
 * paired row; the remaining template columns are formula/master-data driven
 * and must never produce a business diff. Cells whose semantic value is
 * unknown (formulas without a cached result) never diff and never disqualify
 * a row: exact_rows means business-exact — a matched row with zero known
 * business-field mismatches. Unknown only acts as a pairing-cost penalty so
 * duplicate-identity groups still align cache-known rows optimally.
 * Semantics ported from the proven diagnose-new44.mts golden comparator.
 */
import type { Json } from "../supabase/types";
import { normalizeIdentityPart, type RowIdentity } from "./identity";
import {
  COMPARE_FIELDS,
  readInputSheet,
  type CellSnapshot,
  type CompareField,
  type InputRowSnapshot,
} from "./workbook";

/**
 * 'formula' is kept for API/schema compatibility with persisted runs but is
 * no longer emitted: formula text and cached/uncached state never constitute
 * a business difference on their own.
 */
export type ComparisonDiffCategory = "missing" | "extra" | "field" | "formula";

/**
 * The business fields compared per paired row, matching the authoritative
 * golden comparator. Identity (channel, type, title) is handled by grouping;
 * every other template column is auto-derived and excluded from comparison.
 */
export const BUSINESS_COMPARE_FIELDS = [
  "clients",
  "sales_month",
  "month",
  "settlement_month",
  "deposit_month",
  "total_amount_jpy",
  "fee_jpy",
  "before_tax_jpy",
  "after_tax_jpy",
  "rs",
  "before_tax_income_jpy",
  "withholding_tax_jpy",
  "tax_jpy",
  "after_tax_income_jpy",
] as const satisfies readonly CompareField[];

export interface ComparisonDiffFinding {
  category: ComparisonDiffCategory;
  identity: RowIdentity;
  /** null for whole-row findings (missing/extra). */
  field: string | null;
  candidate: Json | null;
  golden: Json | null;
}

export interface ComparisonSummary {
  candidate_sheet: string;
  golden_sheet: string;
  candidate_rows: number;
  golden_rows: number;
  matched_rows: number;
  /** Business-exact matched rows: zero known business-field mismatches. */
  exact_rows: number;
  missing_rows: number;
  extra_rows: number;
  /** Per-business-field mismatch counts (both sides known, values differ). */
  field_mismatches: Record<string, number>;
  /** Always 0 — kept for schema compatibility with persisted runs. */
  formula_mismatches: number;
  diff_total: number;
  diffs_truncated: boolean;
}

export interface ComparisonResult {
  summary: ComparisonSummary;
  diffs: ComparisonDiffFinding[];
}

export const DEFAULT_MAX_DIFFS = 1000;
const ROW_DIGEST_TEXT_LIMIT = 200;

/** Relative tolerance for float noise from Excel serial/formula round-trips. */
function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
}

function valuesEqual(a: CellSnapshot["value"], b: CellSnapshot["value"]): boolean {
  if (a === null && b === null) return true;
  if (typeof a === "number" && typeof b === "number") return numbersEqual(a, b);
  if (typeof a === "string" && typeof b === "string") {
    return normalizeIdentityPart(a) === normalizeIdentityPart(b);
  }
  return a === b;
}

type CellVerdict = "equal" | "mismatch" | "unknown";

/**
 * Field-level verdict for one paired business cell.
 *  - Both sides known (raw value or cached formula result): compare normalized
 *    semantic values; formula/raw state and formula text never matter.
 *  - Both sides unknown (uncached formulas): exact.
 *  - One side unknown: no diff is emitted and the row still counts as
 *    business-exact; 'unknown' only feeds the pairing cost.
 */
function cellVerdict(candidate: CellSnapshot, golden: CellSnapshot): CellVerdict {
  if (candidate.known && golden.known) {
    return valuesEqual(candidate.value, golden.value) ? "equal" : "mismatch";
  }
  if (!candidate.known && !golden.known) return "equal";
  return "unknown";
}

/**
 * Assignment-only cost tuple. Unlike the summary's business-exact notion,
 * 'unknown' still penalizes here (notExact + unknown) so duplicate-identity
 * pairing keeps preferring cache-known partners over uncached ones.
 */
interface PairCost {
  /** 1 unless every business field is verdict-equal. */
  notExact: number;
  /** Both sides known, values differ. */
  mismatch: number;
  /** Exactly one side unknown. */
  unknown: number;
}

function pairCost(candidate: InputRowSnapshot, golden: InputRowSnapshot): PairCost {
  let mismatch = 0;
  let unknown = 0;
  for (const field of BUSINESS_COMPARE_FIELDS) {
    const verdict = cellVerdict(candidate.cells[field], golden.cells[field]);
    if (verdict === "mismatch") mismatch += 1;
    else if (verdict === "unknown") unknown += 1;
  }
  return { notExact: mismatch === 0 && unknown === 0 ? 0 : 1, mismatch, unknown };
}

const FIELD_COUNT = BUSINESS_COMPARE_FIELDS.length;

/**
 * Scalarize the lexicographic cost tuple (maximize exact pairs, then minimize
 * known mismatches, then unknown pairings) with weights that dominate lower
 * tiers across a whole bucket of `pairCount` pairs, as in diagnose-new44.mts.
 */
function scalarWeights(pairCount: number) {
  const wUnknown = 1;
  const wMismatch = 2 * FIELD_COUNT * pairCount + 1;
  const wNotExact = (FIELD_COUNT * pairCount + 1) * wMismatch;
  return { wUnknown, wMismatch, wNotExact };
}

function snapshotJson(snap: CellSnapshot): Json {
  if (snap.state === "formula") {
    return { state: "formula", formula: snap.formula, value: snap.value };
  }
  if (snap.state === "blank") return { state: "blank" };
  return { state: "value", value: snap.value };
}

/** Bounded whole-row digest for missing/extra findings: non-blank cells only. */
function rowDigest(row: InputRowSnapshot): Json {
  const cells: Record<string, Json> = {};
  for (const field of COMPARE_FIELDS) {
    const snap = row.cells[field];
    if (snap.state === "blank") continue;
    const value =
      typeof snap.value === "string" ? snap.value.slice(0, ROW_DIGEST_TEXT_LIMIT) : snap.value;
    cells[field] = snap.state === "formula" ? { formula: snap.formula, value } : value;
  }
  return { row: row.rowNumber, cells };
}

interface PairedRows {
  pairs: Array<{ candidate: InputRowSnapshot; golden: InputRowSnapshot }>;
  missing: InputRowSnapshot[];
  extra: InputRowSnapshot[];
}

/**
 * Exact-assignment size caps, ported from the proven subset-DP + Hungarian
 * matcher in diagnose-new44.mts and adapted to plain field-mismatch costs.
 */
const DP_MAX_K = 14;
const DP_MAX_M = 40;
const HUNGARIAN_MAX_N = 150;

/**
 * Content key so pairing (and tie-breaking) never depends on file row order.
 * Built from the business fields under the same known/unknown semantics as
 * the comparison itself, so formula text and excluded columns cannot reorder
 * canonically equal rows.
 */
function canonicalRowKey(row: InputRowSnapshot): string {
  const parts: string[] = [];
  for (const field of BUSINESS_COMPARE_FIELDS) {
    const snap = row.cells[field];
    if (!snap.known) parts.push("u");
    else if (snap.value === null) parts.push("b");
    else {
      const value =
        typeof snap.value === "string" ? normalizeIdentityPart(snap.value) : String(snap.value);
      parts.push(`v:${value}`);
    }
  }
  return parts.join("\u0000");
}

function sortCanonical(rows: InputRowSnapshot[]): InputRowSnapshot[] {
  return rows
    .map((row) => ({ row, key: canonicalRowKey(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.row.rowNumber - b.row.rowNumber))
    .map((entry) => entry.row);
}

/**
 * Exact minimum-cost assignment via bitmask DP: every row of the smaller
 * side is matched to a distinct row of the larger side. Ties prefer the
 * earliest large-side row and then the smallest small-side index that still
 * reaches the optimum, matching the proven diagnostic implementation.
 */
function assignByDp(cost: number[][], nG: number, nC: number): Array<{ g: number; c: number }> {
  const goldenIsSmall = nG <= nC;
  const smallCount = goldenIsSmall ? nG : nC;
  const largeCount = goldenIsSmall ? nC : nG;
  const at = (large: number, small: number) =>
    goldenIsSmall ? cost[small][large] : cost[large][small];
  const fullMask = (1 << smallCount) - 1;
  const popCount = (x: number) => {
    let count = 0;
    let value = x;
    while (value !== 0) {
      value &= value - 1;
      count += 1;
    }
    return count;
  };

  const dp: Float64Array[] = Array.from({ length: largeCount + 1 }, () =>
    new Float64Array(1 << smallCount).fill(Number.POSITIVE_INFINITY),
  );
  dp[largeCount][fullMask] = 0;
  for (let large = largeCount - 1; large >= 0; large -= 1) {
    for (let mask = 0; mask <= fullMask; mask += 1) {
      const needed = smallCount - popCount(mask);
      const remaining = largeCount - large;
      if (needed < 0 || needed > remaining) continue;
      let best = needed <= remaining - 1 ? dp[large + 1][mask] : Number.POSITIVE_INFINITY;
      for (let small = 0; small < smallCount; small += 1) {
        if (mask & (1 << small)) continue;
        const value = at(large, small) + dp[large + 1][mask | (1 << small)];
        if (value < best) best = value;
      }
      dp[large][mask] = best;
    }
  }

  const pairs: Array<{ g: number; c: number }> = [];
  let mask = 0;
  for (let large = 0; large < largeCount; large += 1) {
    const target = dp[large][mask];
    let chosen = -1;
    for (let small = 0; small < smallCount; small += 1) {
      if (mask & (1 << small)) continue;
      if (at(large, small) + dp[large + 1][mask | (1 << small)] === target) {
        chosen = small;
        break;
      }
    }
    if (chosen >= 0) {
      pairs.push(goldenIsSmall ? { g: chosen, c: large } : { g: large, c: chosen });
      mask |= 1 << chosen;
    }
  }
  return pairs;
}

/**
 * Exact minimum-cost assignment via the Hungarian algorithm on a square
 * padded matrix. A small deterministic index term makes equal-cost ties
 * stable while preserving the primary mismatch-count objective.
 */
function assignByHungarian(
  cost: number[][],
  nG: number,
  nC: number,
): Array<{ g: number; c: number }> {
  const n = Math.max(nG, nC);
  if (n > HUNGARIAN_MAX_N) throw new Error(`comparison group too large to pair exactly: ${n}`);

  const tieMod = n * (n + 1) * (n + 1) + 1;
  let maxScaled = 0;
  const squareCost: number[][] = [];
  for (let g = 0; g < n; g += 1) {
    const row: number[] = [];
    for (let c = 0; c < n; c += 1) {
      const real = g < nG && c < nC;
      const value = real ? cost[g][c] * tieMod + (g * (n + 1) + c + 1) : 0;
      if (value > maxScaled) maxScaled = value;
      row.push(value);
    }
    squareCost.push(row);
  }
  if (maxScaled * n > Number.MAX_SAFE_INTEGER) {
    throw new Error("comparison assignment weights exceed safe integer range");
  }

  const inf = Number.MAX_SAFE_INTEGER;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const matchedRow = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    matchedRow[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(inf);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = matchedRow[j0];
      let delta = inf;
      let j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const cur = squareCost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[matchedRow[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (matchedRow[j0] !== 0);
    do {
      const j1 = way[j0];
      matchedRow[j0] = matchedRow[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const pairs: Array<{ g: number; c: number }> = [];
  for (let j = 1; j <= n; j += 1) {
    const i = matchedRow[j];
    if (i >= 1 && i <= nG && j <= nC) pairs.push({ g: i - 1, c: j - 1 });
  }
  pairs.sort((a, b) => a.g - b.g);
  return pairs;
}

function solveAssignment(
  cost: number[][],
  nG: number,
  nC: number,
): Array<{ g: number; c: number }> {
  if (nG === 0 || nC === 0) return [];
  if (Math.min(nG, nC) <= DP_MAX_K && Math.max(nG, nC) <= DP_MAX_M) {
    return assignByDp(cost, nG, nC);
  }
  return assignByHungarian(cost, nG, nC);
}

/**
 * Pair one identity group's rows by globally minimum total business-field
 * cost — an exact assignment, not greedy selection, so no pairing can be
 * stranded with an avoidably expensive partner.
 */
function pairGroup(candidatesIn: InputRowSnapshot[], goldensIn: InputRowSnapshot[]): PairedRows {
  const candidates = sortCanonical(candidatesIn);
  const goldens = sortCanonical(goldensIn);
  const result: PairedRows = { pairs: [], missing: [], extra: [] };

  const { wUnknown, wMismatch, wNotExact } = scalarWeights(
    Math.min(goldens.length, candidates.length),
  );
  const cost = goldens.map((g) =>
    candidates.map((c) => {
      const t = pairCost(c, g);
      return t.notExact * wNotExact + t.mismatch * wMismatch + t.unknown * wUnknown;
    }),
  );
  const assigned = solveAssignment(cost, goldens.length, candidates.length);
  assigned.sort((a, b) => a.g - b.g);

  const candidateUsed = new Array<boolean>(candidates.length).fill(false);
  const goldenUsed = new Array<boolean>(goldens.length).fill(false);
  for (const { g, c } of assigned) {
    goldenUsed[g] = true;
    candidateUsed[c] = true;
    result.pairs.push({ candidate: candidates[c], golden: goldens[g] });
  }
  result.missing = goldens.filter((_, i) => !goldenUsed[i]);
  result.extra = candidates.filter((_, i) => !candidateUsed[i]);
  return result;
}

function groupByIdentity(rows: InputRowSnapshot[]): Map<string, InputRowSnapshot[]> {
  const groups = new Map<string, InputRowSnapshot[]>();
  for (const row of rows) {
    const group = groups.get(row.identityKey);
    if (group) group.push(row);
    else groups.set(row.identityKey, [row]);
  }
  return groups;
}

export interface CompareInputWorkbooksOptions {
  candidate: Buffer;
  golden: Buffer;
  /** Force both sides to the same compatible sheet. */
  sheetName?: string;
  /** Optional side-specific sheet names for historical workbooks whose labels differ. */
  candidateSheetName?: string;
  goldenSheetName?: string;
  /** Structured diffs are capped here; summary counts always cover everything. */
  maxDiffs?: number;
}

export async function compareInputWorkbooks(
  opts: CompareInputWorkbooksOptions,
): Promise<ComparisonResult> {
  const maxDiffs = opts.maxDiffs ?? DEFAULT_MAX_DIFFS;
  const candidateSheetName = opts.candidateSheetName ?? opts.sheetName;
  const strictCandidate = typeof candidateSheetName === "string" && candidateSheetName.trim().length > 0;
  const candidateSheet = await readInputSheet(opts.candidate, candidateSheetName, strictCandidate);
  const goldenSheetName = opts.goldenSheetName ?? opts.sheetName ?? candidateSheet.sheetName;
  const strictGolden =
    typeof opts.goldenSheetName === "string" || typeof opts.sheetName === "string";
  const goldenSheet = await readInputSheet(opts.golden, goldenSheetName, strictGolden);

  const candidateGroups = groupByIdentity(candidateSheet.rows);
  const goldenGroups = groupByIdentity(goldenSheet.rows);
  const allKeys = [...new Set([...goldenGroups.keys(), ...candidateGroups.keys()])].sort();

  const diffs: ComparisonDiffFinding[] = [];
  const fieldMismatches: Record<string, number> = {};
  let matchedRows = 0;
  let exactRows = 0;
  let missingRows = 0;
  let extraRows = 0;
  let diffTotal = 0;

  const pushDiff = (finding: ComparisonDiffFinding) => {
    diffTotal += 1;
    if (diffs.length < maxDiffs) diffs.push(finding);
  };

  for (const key of allKeys) {
    const { pairs, missing, extra } = pairGroup(
      candidateGroups.get(key) ?? [],
      goldenGroups.get(key) ?? [],
    );

    for (const golden of missing) {
      missingRows += 1;
      pushDiff({
        category: "missing",
        identity: golden.identity,
        field: null,
        candidate: null,
        golden: rowDigest(golden),
      });
    }
    for (const candidate of extra) {
      extraRows += 1;
      pushDiff({
        category: "extra",
        identity: candidate.identity,
        field: null,
        candidate: rowDigest(candidate),
        golden: null,
      });
    }

    for (const { candidate, golden } of pairs) {
      matchedRows += 1;
      let exact = true;
      for (const field of BUSINESS_COMPARE_FIELDS) {
        const verdict = cellVerdict(candidate.cells[field], golden.cells[field]);
        // Only a known business mismatch disqualifies exactness; 'unknown'
        // (one side uncached) emits no diff and stays business-exact.
        if (verdict !== "mismatch") continue;
        exact = false;
        fieldMismatches[field] = (fieldMismatches[field] ?? 0) + 1;
        pushDiff({
          category: "field",
          identity: golden.identity,
          field,
          candidate: snapshotJson(candidate.cells[field]),
          golden: snapshotJson(golden.cells[field]),
        });
      }
      if (exact) exactRows += 1;
    }
  }

  return {
    summary: {
      candidate_sheet: candidateSheet.sheetName,
      golden_sheet: goldenSheet.sheetName,
      candidate_rows: candidateSheet.rows.length,
      golden_rows: goldenSheet.rows.length,
      matched_rows: matchedRows,
      exact_rows: exactRows,
      missing_rows: missingRows,
      extra_rows: extraRows,
      field_mismatches: fieldMismatches,
      formula_mismatches: 0,
      diff_total: diffTotal,
      diffs_truncated: diffTotal > diffs.length,
    },
    diffs,
  };
}

/** Fields compared per paired row — exported for tests/UI legends. */
export const COMPARED_FIELDS: readonly CompareField[] = BUSINESS_COMPARE_FIELDS;
