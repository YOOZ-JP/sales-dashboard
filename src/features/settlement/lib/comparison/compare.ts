/**
 * Deterministic comparison of two INPUT workbooks (generated candidate vs
 * human answer-key). Either side can be wrong — findings are symmetric and
 * only describe differences; nothing is ever copied between the workbooks.
 *
 * Rows are matched as an identity multiset on (channel, type, title): within
 * each identity group, candidate rows are paired to golden rows by an exact
 * globally minimum-cost assignment on field-mismatch counts (bitmask DP for
 * small groups, Hungarian for larger ones), computed over canonically sorted
 * rows so the pairing — and any tie between equal-cost assignments — is
 * independent of row order in either file. Unpaired golden rows are
 * 'missing', unpaired candidate rows are 'extra'.
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

export type ComparisonDiffCategory = "missing" | "extra" | "field" | "formula";

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
  exact_rows: number;
  missing_rows: number;
  extra_rows: number;
  /** Per-field mismatch counts, including formula-state mismatches. */
  field_mismatches: Record<string, number>;
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

/**
 * Field-level verdict for one paired cell.
 *  - equal: same state and same semantic value/formula
 *  - 'formula': the states disagree about formula-ness, or both are formulas
 *    with different (row-masked) formula text
 *  - 'field': plain value/blank disagreement
 */
function cellDiffCategory(
  candidate: CellSnapshot,
  golden: CellSnapshot,
): ComparisonDiffCategory | null {
  const cFormula = candidate.state === "formula";
  const gFormula = golden.state === "formula";
  if (cFormula !== gFormula) return "formula";
  if (cFormula && gFormula) {
    if (candidate.formula !== golden.formula) return "formula";
    return null;
  }
  return valuesEqual(candidate.value, golden.value) ? null : "field";
}

function countMismatches(candidate: InputRowSnapshot, golden: InputRowSnapshot): number {
  let n = 0;
  for (const field of COMPARE_FIELDS) {
    if (cellDiffCategory(candidate.cells[field], golden.cells[field]) !== null) n += 1;
  }
  return n;
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

/** Content key so pairing (and tie-breaking) never depends on file row order. */
function canonicalRowKey(row: InputRowSnapshot): string {
  const parts: string[] = [];
  for (const field of COMPARE_FIELDS) {
    const snap = row.cells[field];
    if (snap.state === "formula") parts.push(`f:${snap.formula ?? ""}`);
    else if (snap.state === "blank") parts.push("b");
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
 * Pair one identity group's rows by globally minimum total field-mismatch
 * cost — an exact assignment, not greedy selection, so no pairing can be
 * stranded with an avoidably expensive partner.
 */
function pairGroup(candidatesIn: InputRowSnapshot[], goldensIn: InputRowSnapshot[]): PairedRows {
  const candidates = sortCanonical(candidatesIn);
  const goldens = sortCanonical(goldensIn);
  const result: PairedRows = { pairs: [], missing: [], extra: [] };

  const cost = goldens.map((g) => candidates.map((c) => countMismatches(c, g)));
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
  /** Structured diffs are capped here; summary counts always cover everything. */
  maxDiffs?: number;
}

export async function compareInputWorkbooks(
  opts: CompareInputWorkbooksOptions,
): Promise<ComparisonResult> {
  const maxDiffs = opts.maxDiffs ?? DEFAULT_MAX_DIFFS;
  const [candidateSheet, goldenSheet] = await Promise.all([
    readInputSheet(opts.candidate),
    readInputSheet(opts.golden),
  ]);

  const candidateGroups = groupByIdentity(candidateSheet.rows);
  const goldenGroups = groupByIdentity(goldenSheet.rows);
  const allKeys = [...new Set([...goldenGroups.keys(), ...candidateGroups.keys()])].sort();

  const diffs: ComparisonDiffFinding[] = [];
  const fieldMismatches: Record<string, number> = {};
  let matchedRows = 0;
  let exactRows = 0;
  let missingRows = 0;
  let extraRows = 0;
  let formulaMismatches = 0;
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
      let mismatched = false;
      for (const field of COMPARE_FIELDS) {
        const category = cellDiffCategory(candidate.cells[field], golden.cells[field]);
        if (category === null) continue;
        mismatched = true;
        fieldMismatches[field] = (fieldMismatches[field] ?? 0) + 1;
        if (category === "formula") formulaMismatches += 1;
        pushDiff({
          category,
          identity: golden.identity,
          field,
          candidate: snapshotJson(candidate.cells[field]),
          golden: snapshotJson(golden.cells[field]),
        });
      }
      if (!mismatched) exactRows += 1;
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
      formula_mismatches: formulaMismatches,
      diff_total: diffTotal,
      diffs_truncated: diffTotal > diffs.length,
    },
    diffs,
  };
}

/** Fields compared per paired row — exported for tests/UI legends. */
export const COMPARED_FIELDS: readonly CompareField[] = COMPARE_FIELDS;
