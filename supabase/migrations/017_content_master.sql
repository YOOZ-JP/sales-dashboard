-- ========================================================================
-- RIVERSE Content Master — internal reference of the comprehensive
-- content list (RIVERSE_*.xlsx). Mirrors the 4 main works sheets:
--   日本(タテヨミ)        → status 'service'
--   日本(版面)            → status 'service'
--   日本(タテヨミ)準備作品 → status 'prep'
--   日本(版面)準備作品     → status 'prep'
--
-- Design notes:
--   * One unified table with the requested typed columns + a lossless
--     raw_data JSONB so no source cell is ever dropped.
--   * Dates are stored as text: the workbook mixes yyyy.mm.dd strings,
--     Excel serials, quarter labels (26年3분기) and status words (미진행).
--   * Delete-safe: re-imports never hard-delete. Each run creates an
--     import batch; rows absent from the latest batch for a sheet are
--     flagged is_active = false instead of being removed.
-- ========================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ------------------------------------------------------------------------
-- Import batches — one row per script run, for traceability & reconciliation
-- ------------------------------------------------------------------------
create table if not exists content_master_import_batches (
  id            uuid primary key default uuid_generate_v4(),
  source_file   text,                       -- basename of the imported workbook
  sheets        text[] default '{}',        -- sheet names covered by this run
  row_count     int  default 0,             -- rows upserted in this run
  note          text,
  created_at    timestamptz default now()
);

-- ------------------------------------------------------------------------
-- Content master
-- ------------------------------------------------------------------------
create table if not exists content_master (
  id                            uuid primary key default uuid_generate_v4(),
  import_batch_id               uuid references content_master_import_batches(id) on delete set null,

  -- provenance
  source_sheet                  text not null,       -- e.g. '日本(タテヨミ)'
  source_row                    int  not null,        -- 1-based Excel row number
  status                        text not null check (status in ('service', 'prep')),

  -- 作品基本情報
  title_jp                      text,
  title_kr                      text,
  management_type               text,                 -- 管理事項 (直接管理 / 流通代行 ...)
  production_company            text,                 -- 制作会社
  distribution_company          text,                 -- 流通会社
  format                        text,                 -- 形式 (WEBTOON / 版面(話別) ...)

  -- creators & readings
  artist                        text,                 -- 作画
  artist_reading                text,                 -- 作画(ヨミ)
  adaptation                    text,                 -- 脚色
  adaptation_reading            text,                 -- 脚色(ヨミ)
  original_author               text,                 -- 原作
  original_author_reading       text,                 -- 原作(ヨミ)

  -- classification
  genre                         text,                 -- ジャンル
  label                         text,                 -- レーベル
  weekday                       text,                 -- 連載曜日 / (連載)曜日
  copyright                     text,                 -- コピーライト / コピーライト(奥付)
  synopsis                      text,                 -- 作品紹介

  -- service / distribution scope
  distribution_scope            text,                 -- 配信範囲 / 提供範囲
  non_exclusive_conversion_date text,                 -- 非独占転換日
  service_planned_date          text,                 -- サービス予定 (prep sheets)

  notes                         text,                 -- 備考
  raw_data                      jsonb default '{}'::jsonb,  -- full source row, header→value

  is_active                     boolean default true,
  created_at                    timestamptz default now(),
  updated_at                    timestamptz default now(),

  unique (source_sheet, source_row)
);

create index if not exists idx_content_master_status  on content_master (status);
create index if not exists idx_content_master_active   on content_master (is_active);
create index if not exists idx_content_master_genre    on content_master (genre);
create index if not exists idx_content_master_label    on content_master (label);
create index if not exists idx_content_master_format   on content_master (format);
create index if not exists idx_content_master_sheet    on content_master (source_sheet);
create index if not exists idx_content_master_jp_trgm  on content_master using gin (title_jp gin_trgm_ops);
create index if not exists idx_content_master_kr_trgm  on content_master using gin (title_kr gin_trgm_ops);

-- Keep workbook-derived data private. Application reads/writes through
-- service-role API routes/scripts after checking the dashboard session cookie.
alter table content_master_import_batches enable row level security;
alter table content_master enable row level security;
