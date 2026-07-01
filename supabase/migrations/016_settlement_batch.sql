-- ========================================================================
-- settlement_batch: month-bucket an entry belongs to, independent from
-- the actual settlement date. Lets us mirror the original Excel, where
-- a row with J="2026-03-31" lives inside the 4月 sheet because the human
-- grouped it into April's batch.
-- ========================================================================

alter table sales_records
  add column if not exists settlement_batch date;

-- Backfill: anything currently in the DB was imported as April's batch.
update sales_records
   set settlement_batch = '2026-04-01'
 where settlement_batch is null;

create index if not exists idx_sales_batch on sales_records (settlement_batch);

-- Keep the per-client view working with the new column so queries
-- that filter by batch stay cheap.
drop view if exists v_monthly_summary_by_client;
create view v_monthly_summary_by_client as
select
  settlement_batch                              as settlement_month,
  client_id,
  count(*)                                      as row_count,
  sum(total_amount_jpy)                         as total_jpy,
  sum(before_tax_income_jpy)                    as before_tax_income_jpy,
  sum(after_tax_income_jpy)                     as after_tax_income_jpy,
  sum(sales_krw)                                as sales_krw
from sales_records
where settlement_batch is not null
group by settlement_batch, client_id;

drop view if exists v_monthly_summary;
create view v_monthly_summary as
select
  settlement_batch                              as settlement_month,
  count(*)                                      as row_count,
  sum(total_amount_jpy)                         as total_jpy,
  sum(before_tax_income_jpy)                    as before_tax_income_jpy,
  sum(sales_krw)                                as sales_krw
from sales_records
where settlement_batch is not null
group by settlement_batch;
