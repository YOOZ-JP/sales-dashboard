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

function piccomaStatementKey(r: Record<string, unknown>): string | null {
  const title = text(r.channel_title_jp) || text(r.title_jp);
  const type = text(r.type);
  const settlementMonth = text(r.settlement_month);
  if (!title || !type || !settlementMonth) return null;
  return [
    text(r.client_id) || text(r.client_code) || text(r.clients),
    text(r.channel_id) || text(r.channel_code) || text(r.channel),
    text(r.channel_title_jp),
    text(r.title_jp),
    settlementMonth,
    type,
    text(r.distribution_strategy),
    text(r.settlement_currency),
    text(r.vehicle_currency),
  ].join("␟");
}

/**
 * Piccoma sends a summary workbook and a detail workbook for the same monthly
 * statement. They can produce the same title/type rows with different derived
 * gross fields when uploaded independently, so the exact monetary strict key is
 * intentionally too narrow for this one paired-file suppression.
 */
export function suppressExistingPiccomaStatementDuplicates<T extends Record<string, unknown>>(
  inserts: T[],
  existing: Array<Record<string, unknown>>,
): { kept: T[]; skipped: number } {
  const insertChannelIds = new Set(inserts.map((row) => text(row.channel_id)).filter(Boolean));
  const insertClientIds = new Set(inserts.map((row) => text(row.client_id)).filter(Boolean));
  const budget = new Map<string, number>();
  for (const row of existing) {
    const channelId = text(row.channel_id);
    const clientId = text(row.client_id);
    const matchesIncomingParty = channelId
      ? insertChannelIds.has(channelId)
      : clientId
        ? insertClientIds.has(clientId)
        : false;
    if (!isPiccomaRow(row) && !matchesIncomingParty) continue;
    const key = piccomaStatementKey(row);
    if (!key) continue;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }

  const kept: T[] = [];
  let skipped = 0;
  for (const insert of inserts) {
    const key = piccomaStatementKey(insert);
    if (!key) {
      kept.push(insert);
      continue;
    }
    const left = budget.get(key) ?? 0;
    if (left > 0) {
      budget.set(key, left - 1);
      skipped += 1;
    } else {
      kept.push(insert);
    }
  }
  return { kept, skipped };
}

export function isPiccomaRow(r: Record<string, unknown>): boolean {
  const channel = text(r.channel_code) || text(r.channel);
  const client = text(r.client_code) || text(r.clients);
  return channel.toLowerCase() === "piccoma" || client.toLowerCase() === "piccoma";
}

/**
 * Role of a Piccoma companion upload within the monthly statement pair.
 * 出版社report (per-chapter/volume detail) is authoritative for the
 * transaction/gross figures; 取次report (per-title summary) is authoritative
 * for the RS rate and the settlement figures/metadata it alone documents
 * (料率, 精算対象当月売上/最終精算, 期間 — see parsers/piccoma.ts).
 */
export type PiccomaSourceRole = "publisher_detail" | "broker_summary";

/**
 * Internal-only filename provenance: classify a raw_uploads filename into its
 * companion role. Filenames are consulted here and must never be echoed into
 * logs, errors, or exported output.
 */
export function piccomaSourceRoleFromFilename(filename: unknown): PiccomaSourceRole | null {
  const name = text(filename);
  if (/^出版社report_/.test(name)) return "publisher_detail";
  if (/^取次report_/.test(name)) return "broker_summary";
  return null;
}

/**
 * Fields the 取次report owns when both companion files are present, per the
 * documented parser semantics: 料率 drives rs_rate, and raw_settle (hence the
 * before-tax income and its consumption-tax split) is defined from the
 * summary's 精算対象当月売上/最終精算 columns; the 期間 row defines the
 * statement months. All remaining fields — the gross/transaction figures —
 * stay with the 出版社report detail base row.
 */
const PICCOMA_BROKER_OWNED_FIELDS = [
  "rs_rate",
  "before_tax_income_jpy",
  "consumption_tax_jpy",
  "after_tax_income_jpy",
  "sales_month",
  "deposit_month",
] as const;

function mergePiccomaCompanionRow<T extends Record<string, unknown>>(base: T, broker: T): T {
  const merged: Record<string, unknown> = { ...base };
  for (const field of PICCOMA_BROKER_OWNED_FIELDS) {
    const value = broker[field];
    // A blank summary value never clobbers real detail data.
    if (value !== null && value !== undefined && value !== "") merged[field] = value;
  }
  return merged as T;
}

/** Most rows wins; ties break on the smallest upload id (nulls first). */
function pickKeeperUpload<T>(
  rowsByUpload: ReadonlyMap<string, T[]>,
  candidates: readonly string[],
): string {
  let best = "";
  let bestCount = -1;
  for (const upload of candidates) {
    const count = rowsByUpload.get(upload)?.length ?? 0;
    if (count > bestCount || (count === bestCount && upload < best)) {
      best = upload;
      bestCount = count;
    }
  }
  return best;
}

/** Content-deterministic ordering so pairing ignores input order and UUIDs. */
function sortByStrictKey<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
  return [...rows]
    .map((row) => ({ row, key: strictRecordKey(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.row);
}

/**
 * Hide (or, with provenance, reconcile) Piccoma companion duplicates in
 * already-loaded rows.
 *
 * When `sourceRoleByUploadId` identifies both a 出版社report and a 取次report
 * upload inside a statement-key group, the group is reconciled by source role
 * instead of by picking one whole upload: each publisher detail row is the
 * base and the paired broker summary row overlays only its documented
 * summary-owned fields. Multiplicity is preserved (rows are paired one-to-one
 * after a content-deterministic sort; unpaired rows on either side survive
 * as-is), so the outcome never depends on upload UUIDs or input order.
 *
 * Without role provenance for both sides, the legacy deterministic keeper
 * (most rows, tie → smallest upload id) applies. Groups from a single upload
 * are always untouched.
 */
export function dedupePiccomaStatementDuplicates<T extends Record<string, unknown>>(
  records: T[],
  sourceRoleByUploadId?: ReadonlyMap<string, PiccomaSourceRole>,
): { records: T[]; removed: number } {
  const rowsByKey = new Map<string, Map<string, T[]>>();
  for (const row of records) {
    if (!isPiccomaRow(row)) continue;
    const key = piccomaStatementKey(row);
    if (!key) continue;
    const upload = text(row.upload_id);
    const perUpload = rowsByKey.get(key) ?? new Map<string, T[]>();
    rowsByKey.set(key, perUpload);
    const rows = perUpload.get(upload) ?? [];
    perUpload.set(upload, rows);
    rows.push(row);
  }

  const plannedByKey = new Map<string, T[]>();
  for (const [key, perUpload] of rowsByKey) {
    if (perUpload.size < 2) continue;
    const publisherUploads: string[] = [];
    const brokerUploads: string[] = [];
    for (const upload of perUpload.keys()) {
      const role = sourceRoleByUploadId?.get(upload);
      if (role === "publisher_detail") publisherUploads.push(upload);
      else if (role === "broker_summary") brokerUploads.push(upload);
    }
    if (publisherUploads.length > 0 && brokerUploads.length > 0) {
      const base = sortByStrictKey(
        perUpload.get(pickKeeperUpload(perUpload, publisherUploads)) ?? [],
      );
      const overlay = sortByStrictKey(
        perUpload.get(pickKeeperUpload(perUpload, brokerUploads)) ?? [],
      );
      const reconciled: T[] = [];
      for (let i = 0; i < Math.max(base.length, overlay.length); i += 1) {
        const baseRow = base[i];
        const brokerRow = overlay[i];
        if (baseRow && brokerRow) reconciled.push(mergePiccomaCompanionRow(baseRow, brokerRow));
        else reconciled.push((baseRow ?? brokerRow) as T);
      }
      plannedByKey.set(key, reconciled);
    } else {
      const keeper = pickKeeperUpload(perUpload, [...perUpload.keys()]);
      plannedByKey.set(key, perUpload.get(keeper) ?? []);
    }
  }

  const emitted = new Set<string>();
  const kept: T[] = [];
  for (const row of records) {
    const key = isPiccomaRow(row) ? piccomaStatementKey(row) : null;
    const planned = key ? plannedByKey.get(key) : undefined;
    if (!planned) {
      kept.push(row);
      continue;
    }
    if (!emitted.has(key as string)) {
      emitted.add(key as string);
      kept.push(...planned);
    }
  }
  return { records: kept, removed: records.length - kept.length };
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
