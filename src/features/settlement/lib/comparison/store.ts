import "server-only";

import postgres from "postgres";

import {
  clampComparisonDiffLimit,
  clampComparisonRunLimit,
  normalizeComparisonOffset,
  validateComparisonDiffCategory,
  validateComparisonMonth,
  validateComparisonReviewStatus,
  validateComparisonRunStatus,
  validateComparisonUuid,
} from "./store-validation";
import type {
  ComparisonDiffCategory,
  ComparisonDiffReviewStatus,
  Json,
  SettlementComparisonDiffInsert,
  SettlementComparisonDiffRow,
  SettlementComparisonRunInsert,
  SettlementComparisonRunRow,
} from "../supabase/types";

type Sql = postgres.Sql;

export type SanitizedComparisonRun = Omit<
  SettlementComparisonRunRow,
  "answer_storage_path" | "candidate_storage_path" | "source_manifest" | "source_upload_ids"
>;

export type ComparisonArtifactPaths = {
  answer_storage_path: string | null;
  candidate_storage_path: string | null;
};

export type DiffListFilters = {
  runId: string;
  category?: ComparisonDiffCategory | null;
  reviewStatus?: ComparisonDiffReviewStatus | null;
  offset?: number;
  limit?: number;
};

export type DiffReviewUpdate = {
  review_status?: ComparisonDiffReviewStatus;
  review_note?: string | null;
  reviewed_by?: string | null;
};

const MAX_RUN_LIMIT = 50;
const DIFF_INSERT_COLUMNS = [
  "run_id",
  "category",
  "identity_channel",
  "identity_type",
  "identity_title",
  "field",
  "candidate_value",
  "golden_value",
] as const;

let sqlSingleton: Sql | null = null;

function getSql(): Sql {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) {
    throw new Error("SUPABASE_DATABASE_URL is required for settlement comparison store");
  }
  if (!sqlSingleton) {
    sqlSingleton = postgres(url, {
      max: 1,
      prepare: false,
      ssl: "require",
    });
  }
  return sqlSingleton;
}

function toJsonParam(value: Json | undefined): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sanitizeRun(row: SettlementComparisonRunRow): SanitizedComparisonRun {
  return {
    id: row.id,
    month: row.month,
    status: row.status,
    answer_filename: row.answer_filename,
    answer_sha256: row.answer_sha256,
    candidate_filename: row.candidate_filename,
    candidate_sha256: row.candidate_sha256,
    summary: row.summary,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export async function createComparisonRun(
  insert: SettlementComparisonRunInsert,
): Promise<{ id: string }> {
  validateComparisonMonth(insert.month);
  if (insert.status) validateComparisonRunStatus(insert.status);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    insert into settlement_comparison_runs (
      month,
      status,
      answer_filename,
      answer_storage_path,
      answer_sha256,
      source_upload_ids,
      source_manifest
    )
    values (
      ${insert.month},
      ${insert.status ?? "processing"},
      ${insert.answer_filename},
      ${insert.answer_storage_path},
      ${insert.answer_sha256 ?? null},
      ${insert.source_upload_ids ?? null},
      ${insert.source_manifest === undefined || insert.source_manifest === null
        ? null
        : sql.json(insert.source_manifest)}
    )
    returning id
  `;
  return rows[0];
}

export async function markComparisonRunFailed(
  id: string,
  message: string,
): Promise<void> {
  validateComparisonUuid(id);
  const sql = getSql();
  await sql`
    update settlement_comparison_runs
    set status = 'failed',
        error = ${message},
        updated_at = now()
    where id = ${id}
  `;
}

export async function updateComparisonRunCandidate(
  id: string,
  fields: {
    candidate_filename: string;
    candidate_storage_path: string;
    candidate_sha256: string | null;
  },
): Promise<void> {
  validateComparisonUuid(id);
  const sql = getSql();
  await sql`
    update settlement_comparison_runs
    set candidate_filename = ${fields.candidate_filename},
        candidate_storage_path = ${fields.candidate_storage_path},
        candidate_sha256 = ${fields.candidate_sha256},
        updated_at = now()
    where id = ${id}
  `;
}

export async function completeComparisonRun(
  id: string,
  summary: Json,
): Promise<void> {
  validateComparisonUuid(id);
  const sql = getSql();
  await sql`
    update settlement_comparison_runs
    set status = 'completed',
        summary = ${sql.json(summary)},
        updated_at = now(),
        completed_at = now()
    where id = ${id}
  `;
}

export async function insertComparisonDiffChunks(
  diffs: SettlementComparisonDiffInsert[],
  chunkSize: number,
): Promise<void> {
  if (diffs.length === 0) return;
  const size = Math.max(1, Math.floor(chunkSize));
  for (const diff of diffs) {
    validateComparisonUuid(diff.run_id);
    validateComparisonDiffCategory(diff.category);
  }

  const sql = getSql();
  await sql.begin(async (tx) => {
    const trx = tx as unknown as Sql;
    for (let offset = 0; offset < diffs.length; offset += size) {
      const rows = diffs.slice(offset, offset + size).map((diff) => ({
        run_id: diff.run_id,
        category: diff.category,
        identity_channel: diff.identity_channel ?? null,
        identity_type: diff.identity_type ?? null,
        identity_title: diff.identity_title ?? null,
        field: diff.field ?? null,
        candidate_value: toJsonParam(diff.candidate_value),
        golden_value: toJsonParam(diff.golden_value),
      }));
      await trx`
        insert into settlement_comparison_diffs
        ${trx(rows, DIFF_INSERT_COLUMNS)}
      `;
    }
  });
}

export async function listComparisonRuns(params: {
  month?: string | null;
  limit?: number;
}): Promise<SanitizedComparisonRun[]> {
  const limit = clampComparisonRunLimit(params.limit ?? MAX_RUN_LIMIT);
  const month = params.month ? validateComparisonMonth(params.month) : null;
  const sql = getSql();
  const rows = month
    ? await sql<SettlementComparisonRunRow[]>`
        select
          id, month::text, status, answer_filename, answer_storage_path, answer_sha256,
          candidate_filename, candidate_storage_path, candidate_sha256,
          source_upload_ids, source_manifest, summary, error,
          created_at::text, updated_at::text, completed_at::text
        from settlement_comparison_runs
        where month = ${month}
        order by created_at desc
        limit ${limit}
      `
    : await sql<SettlementComparisonRunRow[]>`
        select
          id, month::text, status, answer_filename, answer_storage_path, answer_sha256,
          candidate_filename, candidate_storage_path, candidate_sha256,
          source_upload_ids, source_manifest, summary, error,
          created_at::text, updated_at::text, completed_at::text
        from settlement_comparison_runs
        order by created_at desc
        limit ${limit}
      `;
  return rows.map(sanitizeRun);
}

export async function getComparisonRun(
  id: string,
): Promise<SanitizedComparisonRun | null> {
  validateComparisonUuid(id);
  const sql = getSql();
  const rows = await sql<SettlementComparisonRunRow[]>`
    select
      id, month::text, status, answer_filename, answer_storage_path, answer_sha256,
      candidate_filename, candidate_storage_path, candidate_sha256,
      source_upload_ids, source_manifest, summary, error,
      created_at::text, updated_at::text, completed_at::text
    from settlement_comparison_runs
    where id = ${id}
    limit 1
  `;
  return rows[0] ? sanitizeRun(rows[0]) : null;
}

export async function listComparisonDiffs(params: DiffListFilters): Promise<{
  diffs: SettlementComparisonDiffRow[];
  total: number;
  offset: number;
  limit: number;
}> {
  const runId = validateComparisonUuid(params.runId);
  const category = params.category ? validateComparisonDiffCategory(params.category) : null;
  const reviewStatus = params.reviewStatus
    ? validateComparisonReviewStatus(params.reviewStatus)
    : null;
  const offset = normalizeComparisonOffset(params.offset ?? 0);
  const limit = clampComparisonDiffLimit(params.limit ?? 100);
  const sql = getSql();

  const countRows = category && reviewStatus
    ? await sql<{ count: string }[]>`
        select count(*)::text as count
        from settlement_comparison_diffs
        where run_id = ${runId}
          and category = ${category}
          and review_status = ${reviewStatus}
      `
    : category
      ? await sql<{ count: string }[]>`
          select count(*)::text as count
          from settlement_comparison_diffs
          where run_id = ${runId}
            and category = ${category}
        `
      : reviewStatus
        ? await sql<{ count: string }[]>`
            select count(*)::text as count
            from settlement_comparison_diffs
            where run_id = ${runId}
              and review_status = ${reviewStatus}
          `
        : await sql<{ count: string }[]>`
            select count(*)::text as count
            from settlement_comparison_diffs
            where run_id = ${runId}
          `;

  const diffs = category && reviewStatus
    ? await selectDiffs(sql, runId, offset, limit, category, reviewStatus)
    : category
      ? await selectDiffs(sql, runId, offset, limit, category, null)
      : reviewStatus
        ? await selectDiffs(sql, runId, offset, limit, null, reviewStatus)
        : await selectDiffs(sql, runId, offset, limit, null, null);

  return {
    diffs,
    total: Number(countRows[0]?.count ?? 0),
    offset,
    limit,
  };
}

async function selectDiffs(
  sql: Sql,
  runId: string,
  offset: number,
  limit: number,
  category: ComparisonDiffCategory | null,
  reviewStatus: ComparisonDiffReviewStatus | null,
): Promise<SettlementComparisonDiffRow[]> {
  if (category && reviewStatus) {
    return sql<SettlementComparisonDiffRow[]>`
      select
        id, run_id, category, identity_channel, identity_type, identity_title,
        field, candidate_value, golden_value, review_status, review_note,
        reviewed_at::text, reviewed_by, created_at::text
      from settlement_comparison_diffs
      where run_id = ${runId}
        and category = ${category}
        and review_status = ${reviewStatus}
      order by created_at asc, id asc
      offset ${offset}
      limit ${limit}
    `;
  }
  if (category) {
    return sql<SettlementComparisonDiffRow[]>`
      select
        id, run_id, category, identity_channel, identity_type, identity_title,
        field, candidate_value, golden_value, review_status, review_note,
        reviewed_at::text, reviewed_by, created_at::text
      from settlement_comparison_diffs
      where run_id = ${runId}
        and category = ${category}
      order by created_at asc, id asc
      offset ${offset}
      limit ${limit}
    `;
  }
  if (reviewStatus) {
    return sql<SettlementComparisonDiffRow[]>`
      select
        id, run_id, category, identity_channel, identity_type, identity_title,
        field, candidate_value, golden_value, review_status, review_note,
        reviewed_at::text, reviewed_by, created_at::text
      from settlement_comparison_diffs
      where run_id = ${runId}
        and review_status = ${reviewStatus}
      order by created_at asc, id asc
      offset ${offset}
      limit ${limit}
    `;
  }
  return sql<SettlementComparisonDiffRow[]>`
    select
      id, run_id, category, identity_channel, identity_type, identity_title,
      field, candidate_value, golden_value, review_status, review_note,
      reviewed_at::text, reviewed_by, created_at::text
    from settlement_comparison_diffs
    where run_id = ${runId}
    order by created_at asc, id asc
    offset ${offset}
    limit ${limit}
  `;
}

export async function patchComparisonDiffReview(
  diffId: string,
  update: DiffReviewUpdate,
): Promise<SettlementComparisonDiffRow | null> {
  validateComparisonUuid(diffId);
  if (update.review_status !== undefined) {
    validateComparisonReviewStatus(update.review_status);
  }
  const sql = getSql();
  const rows = await sql<SettlementComparisonDiffRow[]>`
    update settlement_comparison_diffs
    set review_status = coalesce(${update.review_status ?? null}, review_status),
        review_note = case
          when ${update.review_note !== undefined} then ${update.review_note ?? null}
          else review_note
        end,
        reviewed_at = case
          when ${update.review_status ?? null}::text is null then reviewed_at
          else now()
        end,
        reviewed_by = case
          when ${update.review_status ?? null}::text is null then reviewed_by
          else ${update.reviewed_by ?? null}
        end
    where id = ${diffId}
    returning
      id, run_id, category, identity_channel, identity_type, identity_title,
      field, candidate_value, golden_value, review_status, review_note,
      reviewed_at::text, reviewed_by, created_at::text
  `;
  return rows[0] ?? null;
}

export async function getComparisonArtifactPaths(
  id: string,
): Promise<ComparisonArtifactPaths | null> {
  validateComparisonUuid(id);
  const sql = getSql();
  const rows = await sql<ComparisonArtifactPaths[]>`
    select answer_storage_path, candidate_storage_path
    from settlement_comparison_runs
    where id = ${id}
    limit 1
  `;
  return rows[0] ?? null;
}
