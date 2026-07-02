import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const TEMP_ACCESS_TOKEN = 'rvjp-temporary-mock-access-token';
const SAFE_SELECT = [
  'id',
  'source_sheet',
  'source_row',
  'status',
  'title_jp',
  'title_kr',
  'management_type',
  'production_company',
  'distribution_company',
  'format',
  'artist',
  'artist_reading',
  'adaptation',
  'adaptation_reading',
  'original_author',
  'original_author_reading',
  'genre',
  'label',
  'weekday',
  'copyright',
  'synopsis',
  'distribution_scope',
  'non_exclusive_conversion_date',
  'service_planned_date',
  'notes',
].join(',');

function normalizeSearch(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

async function requireValidAccessToken(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return false;

  // Temporary app-wide fallback token used by the current login flow.
  // Keep this scoped to authenticated API checks; do not rely on cookie presence.
  if (token === TEMP_ACCESS_TOKEN) return true;

  if (!AUTH0_DOMAIN) return false;
  try {
    const res = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase service-role environment variables');
  return createClient(url, key);
}

/**
 * GET /api/content-master
 * 작품 마스터 목록 조회 (검색 / 필터 / 페이지네이션).
 * @param page — 페이지 번호 (기본 1)
 * @param pageSize — 페이지 크기 (기본 50, 최대 200)
 * @param q — 작품명(JP/KR) 검색 (선택)
 * @param status — 'service' | 'prep' (선택)
 * @param genre — ジャンル 필터 (선택)
 * @param label — レーベル 필터 (선택)
 * @param format — 形式 필터 (선택)
 * @returns { rows, count }
 */
export async function GET(request: NextRequest) {
  if (!(await requireValidAccessToken(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10)));
  const q = normalizeSearch(searchParams.get('q'));
  const status = searchParams.get('status');
  const genre = searchParams.get('genre');
  const label = searchParams.get('label');
  const format = searchParams.get('format');

  let query = getSupabaseAdmin().from('content_master').select(SAFE_SELECT, { count: 'exact' });

  query = query.eq('is_active', true);
  if (status) query = query.eq('status', status);
  if (genre) query = query.eq('genre', genre);
  if (label) query = query.eq('label', label);
  if (format) query = query.eq('format', format);

  query = query.order('status', { ascending: true }).order('source_sheet', { ascending: true }).order('source_row', { ascending: true });

  // Avoid raw PostgREST `.or()` interpolation for title search. The workbook
  // is small enough to search safely in-process after exact DB filters.
  if (q) {
    query = query.limit(5000);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const filtered = ((data ?? []) as unknown as Array<Record<string, unknown>>).filter((row) => {
      const titleJp = String(row.title_jp ?? '').toLocaleLowerCase();
      const titleKr = String(row.title_kr ?? '').toLocaleLowerCase();
      return titleJp.includes(q) || titleKr.includes(q);
    });
    const from = (page - 1) * pageSize;
    return NextResponse.json({ rows: filtered.slice(from, from + pageSize), count: filtered.length });
  }

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data, count });
}
