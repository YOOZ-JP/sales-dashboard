-- ========================================================================
-- JP Sales Settlement Platform — Initial Schema
-- ========================================================================
-- Mirrors the human-curated "일본_신INPUT_XX월" sheet structure in relational form.
-- Every row of sales_records corresponds to one row of the Excel sheet.

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";  -- fuzzy title matching

-- ========================================================================
-- MASTER TABLES
-- ========================================================================

create table if not exists platforms (
  id                uuid primary key default uuid_generate_v4(),
  code              text unique not null,            -- 'cmoa', 'piccoma', 'booklive' ...
  name_jp           text not null,
  name_en           text,
  folder_prefix     text,                            -- '202603_cmoa' → prefix pattern
  settlement_lag_m  int  default 1,                  -- months between sales and settlement
  notes             text,
  created_at        timestamptz default now()
);

create table if not exists clients (
  id                uuid primary key default uuid_generate_v4(),
  code              text unique not null,            -- normalized: 'piccoma', 'line_dl_frontier'
  display_name      text not null,                   -- 'Piccoma', 'Line Digital Frontier'
  aliases           text[] default '{}',             -- ['piccoma','Piccoma','piccoma ']
  country           text default 'JP',
  tax_type          text,                            -- 'withholding' / 'exempt' / ...
  created_at        timestamptz default now()
);

create table if not exists channels (
  id                uuid primary key default uuid_generate_v4(),
  code              text unique not null,            -- 'cmoa', 'piccoma_ads', 'line_ads'
  platform_id       uuid references platforms(id) on delete set null,
  client_id         uuid references clients(id)   on delete set null,
  display_name      text,
  created_at        timestamptz default now()
);

create table if not exists titles (
  id                uuid primary key default uuid_generate_v4(),
  title_kr          text,
  title_jp          text not null,
  type              text check (type in ('WT','EP','COMIC','NOVEL','OTHER')) default 'WT',
  distribution_strategy text check (distribution_strategy in ('ex','non-ex','both')) default 'non-ex',
  launch_date       date,
  notes             text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists idx_titles_jp_trgm on titles using gin (title_jp gin_trgm_ops);
create index if not exists idx_titles_kr_trgm on titles using gin (title_kr gin_trgm_ops);

create table if not exists title_aliases (
  id                uuid primary key default uuid_generate_v4(),
  title_id          uuid not null references titles(id) on delete cascade,
  alias             text not null,                   -- 「分冊版」, 'ライブ配信で会いましょう【分冊版】'
  source            text,                            -- which platform emits this alias
  unique (alias)
);

create table if not exists rs_rules (
  id                uuid primary key default uuid_generate_v4(),
  title_id          uuid references titles(id) on delete cascade,
  channel_id        uuid references channels(id) on delete cascade,
  client_id         uuid references clients(id) on delete cascade,
  rs_rate           numeric(5,4) not null,           -- 0.60 = 60%
  rs_label          text,                            -- '50/60%', '0.6' (raw label from sheet)
  effective_from    date not null default '2000-01-01',
  effective_to      date,
  priority          int default 100,                 -- lower wins (more specific)
  notes             text,
  created_at        timestamptz default now()
);
create index if not exists idx_rs_lookup on rs_rules (title_id, channel_id, client_id, effective_from);

create table if not exists exchange_rates (
  rate_date         date primary key,
  jpy_to_krw        numeric(10,4) not null,
  source            text default 'manual'
);

-- ========================================================================
-- TRANSACTIONAL TABLES
-- ========================================================================

create table if not exists raw_uploads (
  id                uuid primary key default uuid_generate_v4(),
  filename          text not null,
  storage_path      text not null,                   -- supabase storage path
  size_bytes        bigint,
  content_type      text,
  platform_id       uuid references platforms(id),   -- detected (nullable until detection)
  sales_month       date,                            -- YYYY-MM-01
  settlement_month  date,
  status            text not null default 'uploaded' check (status in
                    ('uploaded','parsing','parsed','aggregated','failed','archived')),
  detection_confidence  numeric(4,3),
  parse_error       text,
  parsed_rows       int default 0,
  uploaded_by       uuid references auth.users(id),
  uploaded_at       timestamptz default now(),
  parsed_at         timestamptz
);
create index if not exists idx_uploads_month   on raw_uploads (settlement_month);
create index if not exists idx_uploads_status  on raw_uploads (status);

create table if not exists raw_records (
  id                uuid primary key default uuid_generate_v4(),
  upload_id         uuid not null references raw_uploads(id) on delete cascade,
  row_index         int not null,                    -- position in original file
  data              jsonb not null,                  -- original column-name → value
  created_at        timestamptz default now()
);
create index if not exists idx_raw_records_upload on raw_records (upload_id);

-- Mirrors the 62-column "일본_신INPUT" sheet.
-- One row == one Excel row == one settlement line item.
create table if not exists sales_records (
  id                uuid primary key default uuid_generate_v4(),
  upload_id         uuid references raw_uploads(id) on delete set null,
  raw_record_id     uuid references raw_records(id) on delete set null,

  -- identification
  unique_identifier text,
  channel_title_jp  text,
  title_id          uuid references titles(id),
  title_kr          text,
  title_jp          text,

  -- meta
  updated_at        timestamptz default now(),
  recoder           text,
  company           text default 'RJ',
  launch_date       date,

  -- period  (3-stage)
  sales_month       date,
  settlement_month  date,
  deposit_month     date,

  -- counterparty
  country           text default 'JP',
  client_id         uuid references clients(id),
  channel_id        uuid references channels(id),
  type              text,
  distribution_strategy text,

  -- JPY amounts (mirrors cols 17~28)
  settlement_currency text default 'JPY',
  vehicle_currency    text default 'KRW',
  total_amount_jpy    numeric(14,2),
  fee_jpy             numeric(14,2),
  before_tax_jpy      numeric(14,2),
  after_tax_jpy       numeric(14,2),
  rs_label            text,
  rs_rate             numeric(5,4),
  before_tax_income_jpy numeric(14,2),
  withholding_tax_jpy   numeric(14,2),
  consumption_tax_jpy   numeric(14,2),
  after_tax_income_jpy  numeric(14,2),

  -- KRW conversion (cols 29~38)
  exchange_rate     numeric(10,4),
  fee_krw           numeric(16,2),
  before_tax_krw    numeric(16,2),
  after_tax_krw     numeric(16,2),
  after_tax_income_krw numeric(16,2),
  vat_krw           numeric(16,2),
  withholding_tax_krw  numeric(16,2),
  sales_krw         numeric(16,2),

  -- MG (cols 39~42)
  mg_begin          numeric(14,2),
  mg_increase       numeric(14,2),
  mg_decrease       numeric(14,2),
  mg_end            numeric(14,2),

  -- notes
  note1             text,
  note2             text,

  created_at        timestamptz default now()
);
create index if not exists idx_sales_settlement on sales_records (settlement_month);
create index if not exists idx_sales_sales_m    on sales_records (sales_month);
create index if not exists idx_sales_client     on sales_records (client_id);
create index if not exists idx_sales_channel    on sales_records (channel_id);
create index if not exists idx_sales_title      on sales_records (title_id);

create table if not exists mg_balances (
  id                uuid primary key default uuid_generate_v4(),
  title_id          uuid not null references titles(id) on delete cascade,
  client_id         uuid references clients(id)  on delete set null,
  as_of_month       date not null,
  beginning_mg      numeric(14,2) default 0,
  increase_mg       numeric(14,2) default 0,
  decrease_mg       numeric(14,2) default 0,
  ending_mg         numeric(14,2) generated always as (coalesce(beginning_mg,0) + coalesce(increase_mg,0) - coalesce(decrease_mg,0)) stored,
  notes             text,
  unique (title_id, client_id, as_of_month)
);

create table if not exists audit_logs (
  id                bigserial primary key,
  actor             uuid references auth.users(id),
  entity            text not null,
  entity_id         uuid,
  action            text not null,
  before_data       jsonb,
  after_data        jsonb,
  at                timestamptz default now()
);

-- ========================================================================
-- VIEWS
-- ========================================================================

create or replace view v_monthly_summary as
select
  settlement_month,
  count(*)                              as row_count,
  sum(total_amount_jpy)                 as total_jpy,
  sum(before_tax_income_jpy)            as before_tax_income_jpy,
  sum(sales_krw)                        as sales_krw
from sales_records
group by settlement_month
order by settlement_month desc;

-- ========================================================================
-- RLS — all team members are admin for now (single-tenant)
-- ========================================================================

alter table platforms        enable row level security;
alter table clients          enable row level security;
alter table channels         enable row level security;
alter table titles           enable row level security;
alter table title_aliases    enable row level security;
alter table rs_rules         enable row level security;
alter table exchange_rates   enable row level security;
alter table raw_uploads      enable row level security;
alter table raw_records      enable row level security;
alter table sales_records    enable row level security;
alter table mg_balances      enable row level security;
alter table audit_logs       enable row level security;

-- Any authenticated user = admin (Phase 0 choice)
create policy "authenticated full access" on platforms      for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on clients        for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on channels       for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on titles         for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on title_aliases  for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on rs_rules       for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on exchange_rates for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on raw_uploads    for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on raw_records    for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on sales_records  for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on mg_balances    for all using (auth.role() = 'authenticated');
create policy "authenticated full access" on audit_logs     for all using (auth.role() = 'authenticated');
