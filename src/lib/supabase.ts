import { createClient } from '@supabase/supabase-js';
import type {
  DailySale, InitialSale,
  KPIData, MonthlyTrendRow, PlatformSummaryRow, TopTitleRow, GrowthAlertRow,
  PlatformDetailData, TitleSummaryRow, TitleDetailData,
  TitleMasterRow,
} from '@/types';

// ============================================================
// Title normalization utilities (base_title grouping)
// ============================================================

/** 작품명에서 base_title 추출 (그룹화용) */
export function extractBaseTitle(titleJp: string): string {
  return titleJp
    .replace(/（ノベル）|\(ノベル\)/g, '')
    .replace(/（版面）|\(版面\)/g, '')
    .replace(/（LDF）|\(LDF\)/g, '')
    .replace(/\[完全版\]/g, '')
    .replace(/\[分冊版\]/g, '')
    .replace(/\[特装版\]/g, '')
    .replace(/\[連載版\]/g, '')
    .replace(/\[改訂版\]/g, '')
    .replace(/【分冊版】/g, '')
    .replace(/【特装版】/g, '')
    .replace(/【連載版】/g, '')
    .replace(/【完全版】/g, '')
    .replace(/【改訂版】/g, '')
    .replace(/【タテヨミ】/g, '')
    .replace(/\(巻\)/g, '')
    .replace(/（巻）/g, '')
    // 괄호 없는 에디션 표기도 제거 (改訂版, 完全版 등)
    .replace(/[\s\u3000]*(改訂版|完全版|分冊版|特装版|連載版)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 상품 유형 추출 */
export function extractProductType(titleJp: string): string {
  if (/（ノベル）|\(ノベル\)/.test(titleJp)) return 'ノベル';
  if (/（版面）|\(版面\)/.test(titleJp)) return '版面';
  if (/（LDF）|\(LDF\)/.test(titleJp)) return 'LDF';
  if (/【分冊版】/.test(titleJp)) return '分冊版';
  if (/【特装版】/.test(titleJp)) return '特装版';
  if (/【連載版】/.test(titleJp)) return '連載版';
  if (/\[完全版\]|【完全版】/.test(titleJp)) return '完全版';
  return 'オリジナル';
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_KEY || 'placeholder');

// ============================================================
// Generic fetch helper
// ============================================================

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ============================================================
// Daily Sales queries
// ============================================================

export async function fetchDailySalesPage(
  page: number,
  pageSize: number,
  options?: {
    platform?: string;
    titleSearch?: string;
    startDate?: string;
    endDate?: string;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }
): Promise<{ rows: DailySale[]; count: number }> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (options?.platform) params.set('platform', options.platform);
  if (options?.titleSearch) params.set('titleSearch', options.titleSearch);
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDir) params.set('sortDir', options.sortDir);

  return apiFetch<{ rows: DailySale[]; count: number }>(`/api/sales/paginated?${params}`);
}

export async function fetchAllDailySales(limit = 200000): Promise<DailySale[]> {
  return apiFetch<DailySale[]>(`/api/sales/all?limit=${limit}`);
}

// ============================================================
// Dashboard RPC functions → API Routes
// ============================================================

export async function fetchDashboardKPIs(): Promise<KPIData | null> {
  try {
    return await apiFetch<KPIData>('/api/dashboard/kpis');
  } catch (e) {
    console.error('fetchDashboardKPIs error:', e);
    return null;
  }
}

export async function fetchMonthlyTrend(): Promise<MonthlyTrendRow[]> {
  try {
    return await apiFetch<MonthlyTrendRow[]>('/api/dashboard/monthly-trend');
  } catch (e) {
    console.error('fetchMonthlyTrend error:', e);
    return [];
  }
}

export async function fetchPlatformSummary(): Promise<PlatformSummaryRow[]> {
  try {
    return await apiFetch<PlatformSummaryRow[]>('/api/dashboard/platform-summary');
  } catch (e) {
    console.error('fetchPlatformSummary error:', e);
    return [];
  }
}

export async function fetchTopTitles(limit = 20, month?: string): Promise<TopTitleRow[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (month) params.set('month', month);
  try {
    return await apiFetch<TopTitleRow[]>(`/api/dashboard/top-titles?${params}`);
  } catch (e) {
    console.error('fetchTopTitles error:', e);
    return [];
  }
}

export async function fetchPlatformDetail(channel: string): Promise<PlatformDetailData | null> {
  const params = new URLSearchParams({ channel });
  try {
    return await apiFetch<PlatformDetailData>(`/api/dashboard/platform-detail?${params}`);
  } catch (e) {
    console.error('fetchPlatformDetail error:', e);
    return null;
  }
}

export async function fetchTitleDetail(titleJP: string): Promise<TitleDetailData | null> {
  const params = new URLSearchParams({ title_jp: titleJP });
  try {
    return await apiFetch<TitleDetailData>(`/api/dashboard/title-detail?${params}`);
  } catch (e) {
    console.error('fetchTitleDetail error:', e);
    return null;
  }
}

export async function fetchGrowthAlerts(): Promise<GrowthAlertRow[]> {
  try {
    return await apiFetch<GrowthAlertRow[]>('/api/dashboard/growth-alerts');
  } catch (e) {
    console.warn('fetchGrowthAlerts failed (non-critical):', e);
    return [];
  }
}

// ============================================================
// Prefetch ALL page data on app startup (background)
// ============================================================

export function clearAllCache() {
  // SWR handles caching — no manual prefetch needed
}

export function prefetchAllData() {
  // SWR handles caching — no manual prefetch needed
}

export async function fetchTitleSummaries(): Promise<TitleSummaryRow[]> {
  try {
    return await apiFetch<TitleSummaryRow[]>('/api/sales/title-summaries');
  } catch (e) {
    console.error('fetchTitleSummaries error:', e);
    return [];
  }
}

// ============================================================
// Title master data (genre, company, etc from titles table)
// ============================================================

export async function fetchTitleMaster() {
  try {
    return await apiFetch<Array<{ title_jp: string; title_kr: string | null; genre: string | null; company: string | null; format: string }>>('/api/sales/title-master');
  } catch (e) {
    console.error('fetchTitleMaster error:', e);
    return [];
  }
}

// ============================================================
// Initial Sales queries
// ============================================================

export async function fetchInitialSales(options?: {
  platform?: string;
  genre?: string;
  launchType?: string;
}): Promise<InitialSale[]> {
  const params = new URLSearchParams();
  if (options?.platform) params.set('platform', options.platform);
  if (options?.genre) params.set('genre', options.genre);
  if (options?.launchType) params.set('launchType', options.launchType);
  const qs = params.toString();
  try {
    return await apiFetch<InitialSale[]>(`/api/sales/initial-sales${qs ? `?${qs}` : ''}`);
  } catch (e) {
    console.error('fetchInitialSales error:', e);
    return [];
  }
}

// ============================================================
// Upload functions
// ============================================================

export async function upsertDailySales(
  rows: Array<{
    title_jp: string;
    title_kr?: string;
    channel_title_jp?: string;
    channel: string;
    sale_date: string;
    sales_amount: number;
    sales_amount_gross?: number;
  }>,
  source: string = 'weekly_report',
  isPreliminary = false,
  isLastBatch = true,
  isFirstBatch = true,
) {
  return apiFetch<{ inserted: number; updated: number; dedup?: { action: string; count: number } }>('/api/sales/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, source, isPreliminary, isLastBatch, isFirstBatch }),
  });
}

// ============================================================
// Title daily sales (used by InitialSales page)
// ============================================================

export async function fetchTitleDailySales(titleJP: string) {
  const params = new URLSearchParams({ title_jp: titleJP });
  return apiFetch<Array<{ sale_date: string; daily_total: number }>>(`/api/sales/title-daily-sales?${params}`);
}

// ============================================================
// Genres
// ============================================================

export async function fetchGenres(): Promise<Array<{ id: number; name: string }>> {
  try {
    return await apiFetch<Array<{ id: number; name: string }>>('/api/sales/genres');
  } catch (e) {
    console.error('fetchGenres error:', e);
    return [];
  }
}

// ============================================================
// Analysis API functions
// ============================================================

function buildDateParams(startDate?: string, endDate?: string): string {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchGenreSummary(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ genre_code: string; genre_kr: string; total_sales: number; title_count: number; avg_daily: number }>>(
    `/api/analysis/genre-summary${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchCompanySummary(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ company_name: string; total_sales: number; title_count: number; avg_daily: number }>>(
    `/api/analysis/company-summary${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchFormatSummary(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ content_format: string; total_sales: number; title_count: number }>>(
    `/api/analysis/format-summary${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchDailyTrend(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ day: string; total_sales: number }>>(
    `/api/analysis/daily-trend${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchWeeklyTrend(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ week: string; total_sales: number }>>(
    `/api/analysis/weekly-trend${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchPlatformGenreMatrix(startDate?: string, endDate?: string) {
  return apiFetch<Array<{ channel: string; genre_kr: string; total_sales: number }>>(
    `/api/analysis/platform-genre-matrix${buildDateParams(startDate, endDate)}`
  );
}

export async function fetchPeriodKpis(startDate: string, endDate: string) {
  const params = new URLSearchParams({ startDate, endDate });
  return apiFetch<{ total_sales: number; active_titles: number; active_platforms: number }>(
    `/api/analysis/period-kpis?${params}`
  );
}

export async function fetchTitleRankings(currentStart: string, currentEnd: string, prevStart: string, prevEnd: string, limit?: number) {
  const params = new URLSearchParams({ currentStart, currentEnd, prevStart, prevEnd });
  if (limit) params.set('limit', String(limit));
  return apiFetch<Array<{ title_jp: string; title_kr: string; channels: string[]; current_sales: number; prev_sales: number; rank_change: number }>>(
    `/api/analysis/title-rankings?${params}`
  );
}

export async function fetchPlatformHealth(channel: string, months?: number) {
  const params = new URLSearchParams({ channel });
  if (months) params.set('months', String(months));
  return apiFetch<{ monthly_health: Array<{ month: string; total_sales: number; active_titles: number; daily_avg: number }> }>(
    `/api/analysis/platform-health?${params}`
  );
}

// ============================================================
// Manage API: 작품 CRUD
// ============================================================

export async function createTitle(data: Partial<TitleMasterRow>) {
  return apiFetch<TitleMasterRow>('/api/manage/titles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateTitle(id: string, data: Partial<TitleMasterRow>) {
  return apiFetch<TitleMasterRow>('/api/manage/titles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...data }),
  });
}

export async function deleteTitle(id: string) {
  return apiFetch<{ deleted: number }>('/api/manage/titles', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function batchUpdateTitles(ids: string[], updates: Record<string, unknown>) {
  return apiFetch<{ updated: number }>('/api/manage/titles/batch', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, updates }),
  });
}

// ============================================================
// Manage API: 플랫폼 CRUD
// ============================================================

interface Platform {
  id: number;
  code: string;
  name_jp: string;
  name_kr?: string;
  color?: string;
  is_active?: boolean;
  sort_order?: number;
}

export async function createPlatform(data: { code: string; name_jp: string; name_kr?: string; color?: string; sort_order?: number }) {
  return apiFetch<Platform>('/api/manage/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updatePlatform(id: number, data: Partial<Platform>) {
  return apiFetch<Platform>('/api/manage/platforms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...data }),
  });
}

export async function deletePlatform(id: number) {
  return apiFetch<{ deleted: number }>('/api/manage/platforms', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

// ============================================================
// Manage API: 장르 CRUD
// ============================================================

interface Genre {
  id: number;
  code: string;
  name_jp: string;
  name_kr?: string;
}

export async function createGenre(data: { code: string; name_jp: string; name_kr?: string }) {
  return apiFetch<Genre>('/api/manage/genres', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateGenre(id: number, data: Partial<Genre>) {
  return apiFetch<Genre>('/api/manage/genres', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...data }),
  });
}

export async function deleteGenre(id: number) {
  return apiFetch<{ deleted: number }>('/api/manage/genres', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

// ============================================================
// Manage API: 제작사 CRUD
// ============================================================

export async function createCompany(name: string) {
  return apiFetch<{ id: number; name: string }>('/api/manage/companies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function updateCompany(id: number, name: string) {
  return apiFetch<{ id: number; name: string }>('/api/manage/companies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}

export async function deleteCompany(id: number) {
  return apiFetch<{ deleted: number }>('/api/manage/companies', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function mergeCompanies(fromId: number, toId: number) {
  return apiFetch<{ merged: boolean; from: number; to: number }>('/api/manage/companies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mergeFrom: fromId, mergeTo: toId }),
  });
}

// ============================================================
// Manage API: 매출 데이터 수정/삭제
// ============================================================

export async function updateSalesRow(id: number, data: Partial<DailySale>) {
  return apiFetch<DailySale>('/api/manage/sales', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...data }),
  });
}

export async function deleteSalesRows(ids: number[]) {
  return apiFetch<{ deleted: number }>('/api/manage/sales', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export async function confirmPreliminary(ids: number[]) {
  return apiFetch<{ confirmed: number }>('/api/manage/sales/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

// ============================================================
// Manage API: 감사 로그
// ============================================================

export async function fetchAuditLogs(page = 1, limit = 50) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return apiFetch<{ rows: Array<{ id: string; action: string; table_name: string; record_id: string; old_data: unknown; new_data: unknown; user_info: string; created_at: string }>; count: number }>(
    `/api/manage/audit-logs?${params}`
  );
}
