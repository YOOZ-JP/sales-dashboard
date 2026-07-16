-- ========================================================================
-- Settlement reconciliation: raw-upload integrity columns + comparison runs
-- ========================================================================
-- 1. raw_uploads gains sha256/archived_at so every INPUT file archived to
--    Storage carries a content hash and the moment it became durable.
-- 2. settlement_comparison_runs records one answer-key-vs-candidate
--    comparison (either side can be wrong; the run keeps both artifacts).
-- 3. settlement_comparison_diffs holds the bounded structured findings for
--    operator review.

alter table raw_uploads
  add column if not exists sha256 text,
  add column if not exists archived_at timestamptz;

create table if not exists settlement_comparison_runs (
  id                      uuid primary key default uuid_generate_v4(),
  month                   date not null,               -- settlement batch, YYYY-MM-01
  status                  text not null default 'processing'
                          check (status in ('processing','completed','failed')),
  -- human answer-key workbook (uploaded first, kept even when the run fails)
  answer_filename         text not null,
  answer_storage_path     text not null,
  answer_sha256           text,
  -- generated candidate workbook (null until generation succeeds)
  candidate_filename      text,
  candidate_storage_path  text,
  candidate_sha256        text,
  -- provenance: which raw uploads fed the candidate
  source_upload_ids       uuid[],
  source_manifest         jsonb,
  -- aggregate comparison result (row counts, matched/missing/extra, per-field counts)
  summary                 jsonb,
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_at            timestamptz
);
create index if not exists idx_comparison_runs_month  on settlement_comparison_runs (month);
create index if not exists idx_comparison_runs_status on settlement_comparison_runs (status);

create table if not exists settlement_comparison_diffs (
  id               uuid primary key default uuid_generate_v4(),
  run_id           uuid not null references settlement_comparison_runs(id) on delete cascade,
  category         text not null check (category in ('missing','extra','field','formula')),
  -- normalized identity of the row the finding is about
  identity_channel text,
  identity_type    text,
  identity_title   text,
  field            text,                               -- null for missing/extra rows
  candidate_value  jsonb,
  golden_value     jsonb,
  review_status    text not null default 'pending'
                   check (review_status in
                     ('pending','candidate_correct','golden_correct','needs_review','resolved')),
  review_note      text,
  reviewed_at      timestamptz,
  reviewed_by      text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_comparison_diffs_run        on settlement_comparison_diffs (run_id);
create index if not exists idx_comparison_diffs_run_review on settlement_comparison_diffs (run_id, review_status);
create index if not exists idx_comparison_diffs_category   on settlement_comparison_diffs (run_id, category);

-- RLS: same single-tenant policy as the rest of the schema — authenticated
-- users only. No anon/public policy: raw settlement data never becomes
-- publicly readable. Service-role routes bypass RLS as before.
alter table settlement_comparison_runs  enable row level security;
alter table settlement_comparison_diffs enable row level security;

create policy "authenticated full access" on settlement_comparison_runs
  for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on settlement_comparison_diffs
  for all using (auth.role() = 'authenticated');
