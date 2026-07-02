-- Safe read view for content master dashboard.
-- Production currently has anon Supabase env only; this view exposes only dashboard-safe
-- columns and keeps workbook raw_data/private import batches hidden.

create or replace view content_master_public as
select
  id,
  source_sheet,
  source_row,
  status,
  title_jp,
  title_kr,
  management_type,
  production_company,
  distribution_company,
  format,
  artist,
  artist_reading,
  adaptation,
  adaptation_reading,
  original_author,
  original_author_reading,
  genre,
  label,
  weekday,
  copyright,
  synopsis,
  distribution_scope,
  non_exclusive_conversion_date,
  service_planned_date,
  notes,
  is_active,
  created_at,
  updated_at
from content_master
where is_active = true;

revoke all on content_master_public from public;
grant select on content_master_public to anon, authenticated;
