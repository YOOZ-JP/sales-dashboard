/**
 * Strict logical identity for a `sales_records` row.
 *
 * Two rows are the *same logical row* only when every business-distinguishing
 * field matches: who (client/channel), what (title), when (sales / settlement
 * / deposit months), how (type, distribution, currencies) and every monetary
 * figure. Same title + same amount alone is NOT a duplicate — one work
 * legitimately appears in multiple rows with different 勘定科目/type/month/tax
 * (e.g. KADOKAWA pays 原稿料 / 版権料 / 出版印税 rows for a single title).
 *
 * Used by:
 *  - the upload route, to skip inserts whose key already exists in the same
 *    settlement batch (re-upload, or the same statement in CSV + XLSX form);
 *  - the INPUT v2 export loader, to hide historical cross-upload duplicates
 *    that are already stacked in the DB.
 */

/** Columns needed to compute the key — usable in a Supabase select(). */
export const STRICT_KEY_COLUMNS =
  "client_id, channel_id, channel_title_jp, title_jp, sales_month, " +
  "settlement_month, deposit_month, type, distribution_strategy, " +
  "settlement_currency, vehicle_currency, total_amount_jpy, fee_jpy, " +
  "before_tax_jpy, after_tax_jpy, rs_rate, before_tax_income_jpy, " +
  "withholding_tax_jpy, consumption_tax_jpy, after_tax_income_jpy, " +
  "rate_jpy_krw, rate_krw_krw, exchange_rate, fee_krw, before_tax_krw, " +
  "after_tax_krw, after_tax_income_krw, vat_krw, withholding_tax_krw, sales_krw";

function text(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function num(v: unknown): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

function partyIdentity(r: Record<string, unknown>): { client: string; channel: string } {
  return {
    client: text(r.client_id) || text(r.client_code) || text(r.clients),
    channel: text(r.channel_id) || text(r.channel_code) || text(r.channel),
  };
}

/**
 * Duplicate suppression is only safe when the row has a concrete party
 * identity. If seed lookups are missing and both client/channel resolve to
 * blank, two unrelated rows with the same title/amount could otherwise be
 * collapsed. In that case we choose the safer failure mode: keep the row.
 */
export function hasStrictPartyIdentity(r: Record<string, unknown>): boolean {
  const party = partyIdentity(r);
  return party.client.length > 0 && party.channel.length > 0;
}

export function strictRecordKey(r: Record<string, unknown>): string {
  const party = partyIdentity(r);
  return [
    // Prefer resolved ids; fall back to raw codes so dry-run inserts
    // (unresolved lookups) still key consistently.
    party.client,
    party.channel,
    text(r.channel_title_jp),
    text(r.title_jp),
    text(r.sales_month),
    text(r.settlement_month),
    text(r.deposit_month),
    text(r.type),
    text(r.distribution_strategy),
    text(r.settlement_currency),
    text(r.vehicle_currency),
    num(r.total_amount_jpy),
    num(r.fee_jpy),
    num(r.before_tax_jpy),
    num(r.after_tax_jpy),
    num(r.rs_rate),
    num(r.before_tax_income_jpy),
    num(r.withholding_tax_jpy),
    num(r.consumption_tax_jpy),
    num(r.after_tax_income_jpy),
    num(r.rate_jpy_krw),
    num(r.rate_krw_krw),
    num(r.exchange_rate),
    num(r.fee_krw),
    num(r.before_tax_krw),
    num(r.after_tax_krw),
    num(r.after_tax_income_krw),
    num(r.vat_krw),
    num(r.withholding_tax_krw),
    num(r.sales_krw),
  ].join("␟"); // ␟ unit separator — never appears in the data
}

/**
 * Drop inserts whose strict key already exists among `existing` rows.
 * Multiset-aware: if the batch already holds N rows with a key, up to N new
 * inserts with that key are skipped and any surplus is kept, so a file that
 * legitimately repeats an identical line item is not over-suppressed.
 */
export function suppressExistingDuplicates<T extends Record<string, unknown>>(
  inserts: T[],
  existing: Array<Record<string, unknown>>,
): { kept: T[]; skipped: number } {
  const budget = new Map<string, number>();
  for (const row of existing) {
    if (!hasStrictPartyIdentity(row)) continue;
    const k = strictRecordKey(row);
    budget.set(k, (budget.get(k) ?? 0) + 1);
  }
  const kept: T[] = [];
  let skipped = 0;
  for (const ins of inserts) {
    if (!hasStrictPartyIdentity(ins)) {
      kept.push(ins);
      continue;
    }
    const k = strictRecordKey(ins);
    const left = budget.get(k) ?? 0;
    if (left > 0) {
      budget.set(k, left - 1);
      skipped++;
    } else {
      kept.push(ins);
    }
  }
  return { kept, skipped };
}

/**
 * Remove cross-upload duplicates from already-loaded rows: within each strict
 * key group, keep only the rows of one deterministic upload and drop the same
 * key coming from other uploads. The keeper is the upload holding the MOST
 * rows for that key (ties → smallest `upload_id`, nulls first), so legitimate
 * same-upload repeats are never under-kept when another upload carries fewer
 * copies. Rows repeated inside the keeper upload are preserved — only
 * re-uploads of the same logical row are hidden.
 */
export function dedupeCrossUploadDuplicates<T extends Record<string, unknown>>(
  records: T[],
): { records: T[]; removed: number } {
  const countsByKey = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!hasStrictPartyIdentity(r)) continue;
    const k = strictRecordKey(r);
    const upload = text(r.upload_id);
    const perUpload = countsByKey.get(k) ?? new Map<string, number>();
    countsByKey.set(k, perUpload);
    perUpload.set(upload, (perUpload.get(upload) ?? 0) + 1);
  }
  const keeperUpload = new Map<string, string>();
  for (const [k, perUpload] of countsByKey) {
    let best = "";
    let bestCount = -1;
    for (const [upload, count] of perUpload) {
      if (count > bestCount || (count === bestCount && upload < best)) {
        best = upload;
        bestCount = count;
      }
    }
    keeperUpload.set(k, best);
  }
  const kept: T[] = [];
  let removed = 0;
  for (const r of records) {
    if (!hasStrictPartyIdentity(r)) {
      kept.push(r);
    } else if (text(r.upload_id) === keeperUpload.get(strictRecordKey(r))) {
      kept.push(r);
    } else {
      removed++;
    }
  }
  return { records: kept, removed };
}
