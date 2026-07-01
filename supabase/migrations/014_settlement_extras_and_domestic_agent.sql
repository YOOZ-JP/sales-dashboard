-- ========================================================================
-- Additional columns on sales_records to fully mirror 62-col GT sheet.
-- ========================================================================
-- The GT (data/ground-truth/202604.json) exposes 62 source columns. The
-- initial migration covered ~44 of them; this migration backfills the
-- remaining 18 "extra_XX" columns as well as a few meta fields we noticed
-- in the GT payload (updated, unique_id, after_tax_income_jpy_a/b,
-- rate_jpy_krw, rate_krw_krw, col31).
--
-- All additions are idempotent (`if not exists`) so re-running is safe.

-- Meta fields that sneak in through the GT JSON ------------------------
alter table sales_records add column if not exists updated                   date;
alter table sales_records add column if not exists unique_id                 text;    -- GT col `unique_id`

-- Extra amount buckets (GT cols 27/28 and 29/30/31) -------------------
alter table sales_records add column if not exists after_tax_income_jpy_a    numeric(14,2);
alter table sales_records add column if not exists after_tax_income_jpy_b    numeric(14,2);
alter table sales_records add column if not exists rate_jpy_krw              numeric(10,4);
alter table sales_records add column if not exists rate_krw_krw              numeric(10,4);
alter table sales_records add column if not exists col31                     numeric(14,2);

-- Domestic-agent split columns (GT cols 45 ~ 62) ----------------------
-- These carry the "domestic agency fee" that the human accountant layers on
-- top of the JPY settlement: agent A (cols 45~52), agent B (cols 53~57),
-- external studio (cols 58~62).  Labels are text, amounts/rates are numeric.
alter table sales_records add column if not exists extra_45                  numeric(10,4);
alter table sales_records add column if not exists extra_46                  numeric(14,2);
alter table sales_records add column if not exists extra_47                  numeric(10,4);
alter table sales_records add column if not exists extra_48                  numeric(10,4);
alter table sales_records add column if not exists extra_49                  numeric(14,2);
alter table sales_records add column if not exists extra_50                  numeric(10,4);
alter table sales_records add column if not exists extra_51                  numeric(14,2);
alter table sales_records add column if not exists extra_52                  numeric(14,2);
alter table sales_records add column if not exists extra_53                  text;
alter table sales_records add column if not exists extra_54                  numeric(10,4);
alter table sales_records add column if not exists extra_55                  numeric(14,2);
alter table sales_records add column if not exists extra_56                  numeric(14,2);
alter table sales_records add column if not exists extra_57                  numeric(14,2);
alter table sales_records add column if not exists extra_58                  text;
alter table sales_records add column if not exists extra_59                  numeric(10,4);
alter table sales_records add column if not exists extra_60                  numeric(14,2);
alter table sales_records add column if not exists extra_61                  numeric(14,2);
alter table sales_records add column if not exists extra_62                  numeric(14,2);

-- Platform-level tag that the importer can use for raw_uploads matching
alter table raw_uploads add column if not exists platform_code text;
create index if not exists idx_uploads_platform_code on raw_uploads (platform_code);

-- View: per-client monthly summary (used by dashboard) ----------------
create or replace view v_monthly_summary_by_client as
select
  settlement_month,
  coalesce(client_id::text, 'unknown') as client_bucket,
  count(*)                            as row_count,
  sum(total_amount_jpy)               as total_jpy,
  sum(before_tax_income_jpy)          as before_tax_income_jpy,
  sum(after_tax_income_jpy)           as after_tax_income_jpy,
  sum(sales_krw)                      as sales_krw
from sales_records
group by settlement_month, client_id
order by settlement_month desc, total_jpy desc nulls last;
