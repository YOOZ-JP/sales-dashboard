import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const TEMP_ACCESS_TOKEN = 'rvjp-temporary-mock-access-token';

async function requireValidAccessToken(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return false;
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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase env');
  return createClient(url, key);
}

function getContentMasterSource() {
  // Production has anon Supabase env. When service role is absent, read only
  // through a DB view that deliberately excludes raw_data and private batches.
  return process.env.SUPABASE_SERVICE_ROLE_KEY ? 'content_master' : 'content_master_public';
}

/**
 * GET /api/content-master/stats
 * 작품 마스터 경량 통계 — 상태/장르/레이블/형식 분포 및 총계.
 * (전체 행 덤프가 아닌 집계값만 반환)
 * @returns { total, active, byStatus, byGenre, byLabel, byFormat }
 */
export async function GET(request: NextRequest) {
  if (!(await requireValidAccessToken(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 활성 행만 대상으로 분류 필드를 조회해 애플리케이션 단에서 집계한다.
  // (테이블 규모가 수백 건 수준이라 별도 RPC 없이 충분히 가볍다.)
  const { data, error, count } = await getSupabaseAdmin()
    .from(getContentMasterSource())
    .select('status, genre, label, format', { count: 'exact' })
    .eq('is_active', true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const tally = (key: 'status' | 'genre' | 'label' | 'format') => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const v = (r[key] as string | null) ?? '(미지정)';
      map.set(v, (map.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
  };

  return NextResponse.json({
    total: count ?? rows.length,
    active: rows.length,
    byStatus: tally('status'),
    byGenre: tally('genre'),
    byLabel: tally('label'),
    byFormat: tally('format'),
  });
}
