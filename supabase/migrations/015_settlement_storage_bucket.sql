-- ========================================================================
-- Storage bucket for preserved raw uploads
-- ========================================================================
-- Mirrors rvjp-sales-dashboard: every file dropped into /api/upload is
-- written here under uploads/YYYY-MM/<ts>_<name>. Operators open the
-- signed URL later when investigating a parse error.
--
-- Bucket is private. Reads go through signed URLs issued server-side.

insert into storage.buckets (id, name, public)
values ('upload-debug', 'upload-debug', false)
on conflict (id) do nothing;

-- Service role already bypasses RLS, so the /api/upload route works
-- without a policy. We still add an explicit authenticated-read policy
-- so future Supabase Auth sessions can list their own uploads if needed.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'upload-debug authenticated read'
  ) then
    create policy "upload-debug authenticated read"
      on storage.objects for select
      using (bucket_id = 'upload-debug' and auth.role() = 'authenticated');
  end if;
end $$;
