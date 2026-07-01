'use client';

import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  LayoutDashboard, TrendingUp, TrendingDown, AlertTriangle, Rocket,
  ChevronRight, ChevronLeft, Activity, BarChart3,
  BookOpen,
} from 'lucide-react';
import {
  useMonthlyTrend, usePlatformSummaryForPeriod,
  useGrowthAlerts, usePeriodKpis, useTitleRankings,
  useGenreSummary, useCompanySummary,
  useDailyTrend, useWeeklyTrend, useTitleMaster,
} from '@/hooks/useData';
import { getPlatformColor, getPlatformBrand, PLATFORM_BRANDS } from '@/utils/platformConfig';
import { PlatformBadge } from '@/components/PlatformBadge';
import { useApp } from '@/context/AppContext';
import { useRouter } from 'next/navigation';
import type {
  KPIData, MonthlyTrendRow, PlatformSummaryRow, TopTitleRow, GrowthAlertRow,
  GenreSalesRow, CompanySalesRow, DailyTrendRow, WeeklyTrendRow, PeriodKPIData,
} from '@/types';

import StatusKPICard from '@/components/dashboard/StatusKPICard';
import InsightPanel from '@/components/dashboard/InsightPanel';
import {
  GLASS_CARD, darkTooltipStyle, formatShort, GENRE_COLORS,
} from '@/components/dashboard/shared';

// ============================================================
// Props — server-side prefetched data
// ============================================================

export interface DashboardInitialData {
  kpis: KPIData | null;
  trend: MonthlyTrendRow[] | null;
  platforms: PlatformSummaryRow[] | null;
  topTitles: TopTitleRow[] | null;
  growthAlerts: GrowthAlertRow[] | null;
}

interface DashboardClientProps {
  initialData?: DashboardInitialData | null;
}

// ============================================================
// Types
// ============================================================

type TrendMode = 'daily' | 'weekly' | 'monthly';
// TabId removed — tabs replaced with inline sections

// ============================================================
// Date helpers
// ============================================================

function getThisMonthRange(): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return {
    start: `${y}-${String(m + 1).padStart(2, '0')}-01`,
    end: now.toISOString().slice(0, 10),
  };
}

// YoY removed — replaced with period-based MoM comparison

// ============================================================
// Loading skeletons
// ============================================================

function KPISkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl p-5" style={{ ...GLASS_CARD, minHeight: '150px', borderLeft: '3px solid var(--color-glass-border)' }}>
          <div className="h-3 w-20 rounded skeleton-shimmer mb-4" />
          <div className="h-9 w-32 rounded skeleton-shimmer mb-2" />
          <div className="h-5 w-24 rounded-full skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton({ height = 360 }: { height?: number }) {
  return (
    <div className="rounded-2xl p-6" style={{ ...GLASS_CARD, minHeight: height }}>
      <div className="h-4 w-40 rounded skeleton-shimmer mb-6" />
      <div className="flex items-end gap-1" style={{ height: height - 100 }}>
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="flex-1 rounded-t skeleton-shimmer" style={{ height: `${30 + ((i * 37 + 13) % 60)}%` }} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Custom chart tooltip
// ============================================================

function AreaChartTooltip({ active, payload, label, fmtCurrency }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  fmtCurrency: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{
      background: 'var(--color-tooltip-bg)',
      border: '1px solid var(--color-tooltip-border)',
      borderRadius: '12px',
      padding: '14px 18px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
      backdropFilter: 'blur(8px)',
      minWidth: 140,
    }}>
      <p style={{ color: 'var(--color-tooltip-label)', fontSize: 13, marginBottom: 8, fontWeight: 600 }}>{label}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1A2B5E', boxShadow: '0 0 6px rgba(26,43,94,0.4)', flexShrink: 0 }} />
        <p style={{ color: 'var(--color-tooltip-value)', fontSize: 16, fontWeight: 700, margin: 0 }}>
          {fmtCurrency(payload[0].value)}
        </p>
      </div>
    </div>
  );
}

// ============================================================
// Donut label
// ============================================================

function renderDonutLabel(props: {
  cx?: number; cy?: number; midAngle?: number;
  innerRadius?: number; outerRadius?: number; percent?: number; name?: string;
}) {
  const cx = Number(props.cx ?? 0);
  const cy = Number(props.cy ?? 0);
  const midAngle = Number(props.midAngle ?? 0);
  const innerRadius = Number(props.innerRadius ?? 0);
  const outerRadius = Number(props.outerRadius ?? 0);
  const percent = Number(props.percent ?? 0);
  const name = String(props.name ?? '');
  if (percent < 0.04) return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 1.4;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const displayName = PLATFORM_BRANDS[name]?.nameJP || name;
  return (
    <text x={x} y={y} fill="var(--color-text-secondary)" textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central" fontSize={12} fontWeight={500}>
      {displayName} ({(percent * 100).toFixed(1)}%)
    </text>
  );
}

// ============================================================
// Tab configuration
// ============================================================

// TABS removed — all sections shown inline on the page

// ============================================================
// Main Dashboard Page
// ============================================================

export default function DashboardClient({ initialData }: DashboardClientProps) {
  const { formatCurrency, t } = useApp();
  const router = useRouter();

  // Date range
  const defaultRange = useMemo(() => getThisMonthRange(), []);
  const [startDate, setStartDate] = useState(defaultRange.start);
  const [endDate, setEndDate] = useState(defaultRange.end);
  const [activePreset, setActivePreset] = useState('thisMonth');

  // Tab
  // activeTab removed — all sections shown inline

  // Trend mode
  // 기간에 따라 자동 전환: 한 달이면 일별, 그 외 월별
  const isOneMonth = useMemo(() => {
    const s = new Date(startDate);
    const e = new Date(endDate);
    return s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  }, [startDate, endDate]);
  const [trendModeOverride, setTrendModeOverride] = useState<TrendMode | null>(null);
  // 기간 변경 시 자동 전환 리셋
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      setTrendModeOverride(null);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [startDate, endDate]);
  const trendMode: TrendMode = trendModeOverride ?? (isOneMonth ? 'daily' : 'monthly');
  const setTrendMode = (mode: TrendMode) => setTrendModeOverride(mode);

  // salesGoal removed — replaced with period-based KPIs

  // SWR data hooks (client-side fetch with server prefetch as fallback)
  const sd = startDate || undefined;
  const ed = endDate || undefined;

  // KPI: 선택 기간 기반 (날짜 변경 시 자동 갱신)
  const { data: periodKpisRaw } = usePeriodKpis(startDate, endDate);
  // 전월 계산
  const prevMonth = useMemo(() => {
    const d = new Date(startDate);
    const pm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const pmEnd = new Date(d.getFullYear(), d.getMonth(), 0);
    return {
      start: `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}-01`,
      end: pmEnd.toISOString().slice(0, 10),
    };
  }, [startDate]);
  const { data: prevPeriodKpis } = usePeriodKpis(prevMonth.start, prevMonth.end);

  const { data: monthlyTrendRaw } = useMonthlyTrend();
  const { data: platformSummaryRaw } = usePlatformSummaryForPeriod(startDate, endDate);
  // Top titles: 선택 기간의 매출 기준 (title-rankings API 사용)
  const { data: topTitlesRaw } = useTitleRankings(startDate, endDate, prevMonth.start, prevMonth.end);
  const { data: growthAlertsRaw } = useGrowthAlerts();
  const { data: genreSummaryRaw } = useGenreSummary(sd, ed);
  const { data: companySummaryRaw } = useCompanySummary(sd, ed);
  const { data: dailyTrendRaw } = useDailyTrend(sd, ed);
  const { data: weeklyTrendRaw } = useWeeklyTrend(sd, ed);
  const { data: titleMasterRaw } = useTitleMaster();

  // Title metadata map (title_jp → { genre, company })
  const titleMetaMap = useMemo(() => {
    const map = new Map<string, { genre: string; company: string }>();
    if (titleMasterRaw && Array.isArray(titleMasterRaw)) {
      for (const t of titleMasterRaw) {
        map.set(t.title_jp, {
          genre: t.production_companies?.name ? '' : '',
          company: '',
        });
        // Try nested join data
        const genre = (t as Record<string, unknown>).genres;
        const company = (t as Record<string, unknown>).production_companies;
        map.set(t.title_jp, {
          genre: genre && typeof genre === 'object' && 'name_kr' in (genre as Record<string, unknown>) ? String((genre as Record<string, unknown>).name_kr) : '',
          company: company && typeof company === 'object' && 'name' in (company as Record<string, unknown>) ? String((company as Record<string, unknown>).name) : '',
        });
      }
    }
    return map;
  }, [titleMasterRaw]);

  // 선택 기간의 KPI 데이터
  const periodKpis = periodKpisRaw as PeriodKPIData | undefined;

  // kpis를 periodKpis 기반으로 재구성 (기존 KPIData 형식 호환)
  const kpis = useMemo(() => {
    if (!periodKpis) return initialData?.kpis as KPIData | undefined;
    const prevTotal = (prevPeriodKpis as PeriodKPIData | undefined)?.total_sales ?? 0;
    const momChange = prevTotal > 0 ? ((periodKpis.total_sales - prevTotal) / prevTotal) * 100 : 0;
    return {
      total_sales: periodKpis.total_sales,
      this_month_sales: periodKpis.total_sales,
      last_month_sales: prevTotal,
      mom_change: Math.round(momChange * 10) / 10,
      active_titles: periodKpis.active_titles,
      active_platforms: periodKpis.active_platforms,
    } as KPIData;
  }, [periodKpis, prevPeriodKpis, initialData?.kpis]);

  // Normalize SWR data with fallbacks — prefer SWR, then initialData, then empty
  const monthlyTrend = useMemo<MonthlyTrendRow[]>(() => monthlyTrendRaw ?? initialData?.trend ?? [], [monthlyTrendRaw, initialData?.trend]);
  const platformSummary = useMemo<PlatformSummaryRow[]>(() => platformSummaryRaw ?? initialData?.platforms ?? [], [platformSummaryRaw, initialData?.platforms]);
  // title-rankings 응답을 TopTitleRow 형식으로 변환
  const topTitles = useMemo<TopTitleRow[]>(() => {
    const raw = topTitlesRaw as Array<{ title_jp: string; title_kr: string | null; channels: string[]; current_sales: number; prev_sales: number; rank_change: number }> | undefined;
    if (!raw) return initialData?.topTitles ?? [];
    return raw.slice(0, 20).map(r => ({
      title_jp: r.title_jp,
      title_kr: r.title_kr,
      channels: r.channels ?? [],
      total_sales: r.current_sales, // 해당 기간 매출
      day_count: 0,
    }));
  }, [topTitlesRaw, initialData?.topTitles]);
  const growthAlerts = useMemo<GrowthAlertRow[]>(() => growthAlertsRaw ?? initialData?.growthAlerts ?? [], [growthAlertsRaw, initialData?.growthAlerts]);
  const genreSummary = useMemo<GenreSalesRow[]>(() => (genreSummaryRaw ?? []) as GenreSalesRow[], [genreSummaryRaw]);
  const companySummary = useMemo<CompanySalesRow[]>(() => (companySummaryRaw ?? []) as CompanySalesRow[], [companySummaryRaw]);
  const dailyTrend = useMemo<DailyTrendRow[]>(() => (dailyTrendRaw ?? []) as DailyTrendRow[], [dailyTrendRaw]);
  const weeklyTrend = useMemo<WeeklyTrendRow[]>(() => (weeklyTrendRaw ?? []) as WeeklyTrendRow[], [weeklyTrendRaw]);

  // 데이터가 없으면 로딩 (에러 중에도 재시도 대기하므로 로딩 유지)
  const loading = !kpis;

  // Data freshness — simplified
  const [, setHasPreliminary] = useState(false);
  useEffect(() => {
    fetch('/api/sales/paginated?page=1&pageSize=1&sortBy=sale_date&sortDir=desc')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.rows?.[0]?.is_preliminary) setHasPreliminary(true); })
      .catch(() => {});
  }, []);

  // ---------- Derived data ----------
  // yoyChange, goalRate removed — replaced with period-based KPIs

  // 월별 추이를 선택 기간으로 필터링
  const filteredMonthlyTrend = useMemo(() => {
    const startM = startDate.slice(0, 7);
    const endM = endDate.slice(0, 7);
    return monthlyTrend.filter(r => r.month >= startM && r.month <= endM);
  }, [monthlyTrend, startDate, endDate]);

  const trendChartData = useMemo(() => {
    if (trendMode === 'daily') return dailyTrend.map(r => ({ label: r.day.length >= 10 ? r.day.slice(5) : r.day, sales: r.total_sales }));
    if (trendMode === 'weekly') return weeklyTrend.map(r => ({ label: r.week.length >= 10 ? r.week.slice(5) : r.week, sales: r.total_sales }));
    return filteredMonthlyTrend.map(r => ({ label: r.month.length >= 7 ? r.month.slice(2) : r.month, sales: r.total_sales }));
  }, [trendMode, dailyTrend, weeklyTrend, filteredMonthlyTrend]);

  const pieData = platformSummary.map(r => ({ name: r.channel, value: r.total_sales, color: getPlatformColor(r.channel) }));
  const platformBarData = platformSummary.slice(0, 8).map(r => ({ name: r.channel, sales: r.total_sales, color: getPlatformColor(r.channel) }));

  const trendLabels: Record<TrendMode, string> = {
    daily: t('일별', '日別'),
    weekly: t('주별', '週別'),
    monthly: t('월별', '月別'),
  };

  // ---------- Alert data ----------
  const declining = useMemo(() => growthAlerts.filter(a => a.growth_pct <= -30).sort((a, b) => a.growth_pct - b.growth_pct), [growthAlerts]);
  const surging = useMemo(() => growthAlerts.filter(a => a.growth_pct >= 50).sort((a, b) => b.growth_pct - a.growth_pct), [growthAlerts]);

  // Genre pie data
  const genrePieData = genreSummary.map((d, i) => ({
    name: d.genre_kr || d.genre_code,
    value: d.total_sales,
    color: GENRE_COLORS[i % GENRE_COLORS.length],
    genre_code: d.genre_code,
  }));
  // genreTotal removed — ranking bars used instead of percentage

  // Error state removed — loading skeleton shown while SWR retries

  // =================================================================
  // RENDER
  // =================================================================

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* ===== HEADER ===== */}
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center page-icon-glow">
          <LayoutDashboard size={22} color="white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('매출 현황', '売上現況')}
          </h1>
        </div>

        {/* Date selector — 제목 바로 옆 */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* 월 선택 네비게이션 */}
          <div className="flex items-center gap-1 rounded-xl px-1 py-1" style={{ background: 'var(--color-glass)', border: '1px solid var(--color-glass-border)' }}>
            {(() => {
              // 데이터가 있는 최소/최대 월 계산
              const minMonth = monthlyTrend.length > 0 ? monthlyTrend[0].month : '2025-03';
              const maxMonth = monthlyTrend.length > 0 ? monthlyTrend[monthlyTrend.length - 1].month : new Date().toISOString().slice(0, 7);
              const currentMonth = startDate.slice(0, 7);
              const canGoPrev = currentMonth > minMonth;
              const canGoNext = currentMonth < maxMonth;

              return (
                <>
                  <button
                    onClick={() => {
                      if (!canGoPrev) return;
                      const d = new Date(startDate);
                      d.setMonth(d.getMonth() - 1);
                      const y = d.getFullYear();
                      const m = d.getMonth();
                      setStartDate(`${y}-${String(m + 1).padStart(2, '0')}-01`);
                      const lastDay = new Date(y, m + 1, 0);
                      setEndDate(lastDay.toISOString().slice(0, 10));
                      setActivePreset('custom');
                    }}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: canGoPrev ? 'var(--color-text-secondary)' : 'var(--color-text-subtle)', cursor: canGoPrev ? 'pointer' : 'default', opacity: canGoPrev ? 1 : 0.3 }}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-[15px] font-bold px-3 min-w-[140px] text-center" style={{ color: 'var(--color-text-primary)' }}>
                    {(() => {
                      if (activePreset === 'all') return t('전체 기간', '全期間');
                      if (activePreset === 'thisYear') return `${new Date().getFullYear()}${t('년', '年')}`;
                      const d = new Date(startDate);
                      return `${d.getFullYear()}${t('년', '年')} ${d.getMonth() + 1}${t('월', '月')}`;
                    })()}
                  </span>
                  <button
                    onClick={() => {
                      if (!canGoNext) return;
                      const d = new Date(startDate);
                      d.setMonth(d.getMonth() + 1);
                      const y = d.getFullYear();
                      const m = d.getMonth();
                      setStartDate(`${y}-${String(m + 1).padStart(2, '0')}-01`);
                      const lastDay = new Date(y, m + 1, 0);
                      const today = new Date();
                      setEndDate(lastDay > today ? today.toISOString().slice(0, 10) : lastDay.toISOString().slice(0, 10));
                      setActivePreset('custom');
                    }}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: canGoNext ? 'var(--color-text-secondary)' : 'var(--color-text-subtle)', cursor: canGoNext ? 'pointer' : 'default', opacity: canGoNext ? 1 : 0.3 }}
                  >
                    <ChevronRight size={16} />
                  </button>
                </>
              );
            })()}
          </div>

          {/* 프리셋 버튼 */}
          {[
            { id: 'thisMonth', ko: '이번달', ja: '今月' },
            { id: 'lastMonth', ko: '지난달', ja: '先月' },
            { id: 'thisYear', ko: '올해', ja: '今年' },
            { id: 'all', ko: '전체', ja: '全体' },
          ].map((preset) => (
            <button
              key={preset.id}
              onClick={() => {
                setActivePreset(preset.id);
                const now = new Date();
                if (preset.id === 'thisMonth') {
                  setStartDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
                  setEndDate(now.toISOString().slice(0, 10));
                } else if (preset.id === 'lastMonth') {
                  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                  setStartDate(`${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-01`);
                  const lastDay = new Date(lm.getFullYear(), lm.getMonth() + 1, 0);
                  setEndDate(lastDay.toISOString().slice(0, 10));
                } else if (preset.id === 'thisYear') {
                  setStartDate(`${now.getFullYear()}-01-01`);
                  setEndDate(now.toISOString().slice(0, 10));
                } else {
                  // 전체: 데이터가 있는 최소 월부터
                  const minM = monthlyTrend.length > 0 ? monthlyTrend[0].month : '2025-03';
                  setStartDate(`${minM}-01`);
                  setEndDate(now.toISOString().slice(0, 10));
                }
              }}
              className="px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all"
              style={{
                background: activePreset === preset.id ? '#1A2B5E' : 'var(--color-glass)',
                color: activePreset === preset.id ? '#fff' : 'var(--color-text-secondary)',
                border: `1px solid ${activePreset === preset.id ? 'transparent' : 'var(--color-glass-border)'}`,
              }}
            >
              {t(preset.ko, preset.ja)}
            </button>
          ))}

{/* 속보치 뱃지 제거 */}
        </div>
      </div>

      {loading ? (
        <div className="space-y-6">
          <KPISkeleton />
          <ChartSkeleton height={200} />
          <ChartSkeleton height={400} />
        </div>
      ) : !kpis ? (
        /* kpis가 없으면 로딩과 동일하게 스켈레톤 표시 (SWR 재시도 대기) */
        <div className="space-y-6">
          <KPISkeleton />
          <ChartSkeleton height={200} />
        </div>
      ) : (
        <div className="space-y-6">

          {/* ===== KPI SECTION ===== */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatusKPICard
              label={(() => {
                if (activePreset === 'all') return t('전체 매출', '全期間売上');
                if (activePreset === 'thisYear') {
                  const sy = new Date(startDate);
                  return `${sy.getFullYear()}${t('년 매출', '年売上')}`;
                }
                const sd2 = new Date(startDate);
                const ed2 = new Date(endDate);
                if (sd2.getMonth() === ed2.getMonth() && sd2.getFullYear() === ed2.getFullYear()) {
                  return `${sd2.getFullYear()}.${sd2.getMonth() + 1}${t('월 매출', '月売上')}`;
                }
                return `${startDate.slice(2, 7)}~${endDate.slice(2, 7)} ${t('매출', '売上')}`;
              })()}
              value={kpis.this_month_sales}
              formatter={formatCurrency}
              status={kpis.mom_change >= 0 ? 'good' : kpis.mom_change >= -20 ? 'warn' : 'bad'}
              subText={`${t('전월', '前月')}: ${formatCurrency(kpis.last_month_sales)}`}
              delay={0}
              icon={<BarChart3 size={16} />}
            />
            <StatusKPICard
              label={t('전월 대비', '前月比')}
              value={Math.abs(kpis.mom_change)}
              formatter={(v) => `${kpis.mom_change >= 0 ? '+' : '-'}${v.toFixed(1)}%`}
              status={kpis.mom_change >= 0 ? 'good' : kpis.mom_change >= -20 ? 'warn' : 'bad'}
              changePct={kpis.mom_change}
              changeLabel="MoM"
              delay={0.08}
              icon={kpis.mom_change >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            />
            <StatusKPICard
              label={t('서비스 플랫폼', 'サービスPF')}
              value={kpis.active_platforms}
              formatter={(v) => `${v}${t('개', '個')}`}
              status="neutral"
              delay={0.16}
              icon={<Activity size={16} />}
              noAnimation
            />
            <StatusKPICard
              label={t('서비스 작품', 'サービス作品')}
              value={kpis.active_titles}
              formatter={(v) => `${v}${t('작품', '作品')}`}
              status="neutral"
              delay={0.24}
              icon={<BookOpen size={16} />}
              noAnimation
            />
          </div>

          {/* ===== 현황 포커스 ===== */}
          <InsightPanel
            kpis={kpis}
            yoyChange={null}
            growthAlerts={growthAlerts}
            platformSummary={platformSummary}
            goalRate={null}
            genreSummary={genreSummary}
            companySummary={companySummary}
            topTitles={topTitles}
            dailyTrend={dailyTrend}
          />

          {/* ── 1. 현황: 매출 추이 ── */}
          <div className="rounded-2xl p-6" style={GLASS_CARD}>
            <div className="flex items-center gap-3 mb-5 flex-wrap">
              <h3 className="text-[16px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                {t('매출 추이', '売上推移')}
              </h3>
              <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-glass-border)' }}>
                {(['daily', 'weekly', 'monthly'] as TrendMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setTrendMode(mode)}
                    className="px-3 py-1.5 text-[13px] font-medium transition-all"
                    style={{
                      background: trendMode === mode ? '#1A2B5E' : 'transparent',
                      color: trendMode === mode ? '#fff' : 'var(--color-text-secondary)',
                    }}
                  >
                    {trendLabels[mode]}
                  </button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trendChartData}>
                <defs>
                  <linearGradient id="execAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3B6FF6" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#3B6FF6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} tickFormatter={formatShort} width={110} />
                <ReTooltip content={<AreaChartTooltip fmtCurrency={formatCurrency} />} />
                <Area type="monotone" dataKey="sales" stroke="#3B6FF6" strokeWidth={2.5} fill="url(#execAreaGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* ── 2. 플랫폼 ── */}
          <div className="rounded-2xl p-6" style={GLASS_CARD}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Donut */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('플랫폼 점유율', 'PF占有率')}
                        </h3>
                        <ResponsiveContainer width="100%" height={300}>
                          <PieChart>
                            <Pie
                              data={pieData} dataKey="value" nameKey="name"
                              cx="50%" cy="50%" innerRadius={60} outerRadius={105}
                              paddingAngle={2} label={renderDonutLabel} labelLine={false}
                              onClick={(_, idx) => router.push(`/platforms?channel=${encodeURIComponent(pieData[idx].name)}`)}
                              style={{ cursor: 'pointer' }}
                            >
                              {pieData.map((entry, idx) => <Cell key={idx} fill={entry.color} fillOpacity={0.85} />)}
                            </Pie>
                            <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), t('매출', '売上')]} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Ranking bars */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('플랫폼 랭킹', 'PFランキング')}
                        </h3>
                        <div className="space-y-3">
                          {platformBarData.map((pf, i) => {
                            const maxSales = platformBarData[0]?.sales ?? 1;
                            const barWidth = maxSales > 0 ? (pf.sales / maxSales) * 100 : 0;
                            const brand = getPlatformBrand(pf.name);
                            return (
                              <motion.div
                                key={pf.name}
                                initial={{ opacity: 0, x: 16 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.06 }}
                                className="cursor-pointer group"
                                onClick={() => router.push(`/platforms?channel=${encodeURIComponent(pf.name)}`)}
                              >
                                <div className="flex items-center gap-3 mb-1">
                                  <span className="text-[13px] font-bold w-5 text-center" style={{ color: i < 3 ? pf.color : 'var(--color-text-muted)' }}>
                                    {i + 1}
                                  </span>
                                  {brand.logo ? (
                                    <img src={brand.logo} alt={pf.name} className="w-6 h-6 rounded-md object-contain" />
                                  ) : (
                                    <div className="w-6 h-6 rounded-md flex items-center justify-center text-[12px] font-bold"
                                      style={{ background: brand.bgColor, color: brand.color, border: `1px solid ${brand.borderColor}` }}>
                                      {brand.icon}
                                    </div>
                                  )}
                                  <span className="text-[14px] font-medium flex-1 truncate" style={{ color: 'var(--color-text-primary)' }}>
                                    {t(brand.nameKR, brand.nameJP) || pf.name}
                                  </span>
                                  <span className="text-[14px] font-bold shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                                    {formatCurrency(pf.sales)}
                                  </span>
                                </div>
                                <div className="ml-8 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-glass-border)' }}>
                                  <motion.div
                                    className="h-full rounded-full"
                                    style={{ background: pf.color }}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${barWidth}%` }}
                                    transition={{ duration: 0.7, delay: 0.1 + i * 0.06 }}
                                  />
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
          </div>

          {/* ── 3. 장르 ── */}
          <div className="rounded-2xl p-6" style={GLASS_CARD}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Genre donut */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('장르별 점유율', 'ジャンル別占有率')}
                        </h3>
                        <ResponsiveContainer width="100%" height={300}>
                          <PieChart>
                            <Pie
                              data={genrePieData} dataKey="value" nameKey="name"
                              cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2}
                              onClick={(_, idx) => router.push(`/titles?genre=${encodeURIComponent(genrePieData[idx].genre_code)}`)}
                              style={{ cursor: 'pointer' }}
                            >
                              {genrePieData.map((entry, idx) => <Cell key={idx} fill={entry.color} fillOpacity={0.85} />)}
                            </Pie>
                            <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), t('매출', '売上')]} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Genre ranking bars */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('장르별 랭킹', 'ジャンル別ランキング')}
                        </h3>
                        <div className="space-y-3">
                          {genreSummary.slice(0, 10).map((row, i) => {
                            const maxSales = genreSummary[0]?.total_sales ?? 1;
                            const barWidth = maxSales > 0 ? (row.total_sales / maxSales) * 100 : 0;
                            const color = GENRE_COLORS[i % GENRE_COLORS.length];
                            return (
                              <motion.div
                                key={row.genre_code}
                                initial={{ opacity: 0, x: 16 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.06 }}
                                className="cursor-pointer group"
                                onClick={() => router.push(`/titles?genre=${encodeURIComponent(row.genre_code)}`)}
                              >
                                <div className="flex items-center gap-3 mb-1">
                                  <span className="text-[13px] font-bold w-5 text-center" style={{ color: i < 3 ? color : 'var(--color-text-muted)' }}>
                                    {i + 1}
                                  </span>
                                  <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                                  <span className="text-[14px] font-medium flex-1 truncate" style={{ color: 'var(--color-text-primary)' }}>
                                    {row.genre_kr || row.genre_code}
                                  </span>
                                  <span className="text-[12px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                                    {row.title_count}{t('작품', '作品')}
                                  </span>
                                  <span className="text-[14px] font-bold shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                                    {formatCurrency(row.total_sales)}
                                  </span>
                                </div>
                                <div className="ml-8 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-glass-border)' }}>
                                  <motion.div
                                    className="h-full rounded-full"
                                    style={{ background: color }}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${barWidth}%` }}
                                    transition={{ duration: 0.7, delay: 0.1 + i * 0.06 }}
                                  />
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
          </div>

          {/* ── 4. 제작사 ── */}
          <div className="rounded-2xl p-6" style={GLASS_CARD}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Company donut */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('제작사 점유율', '制作会社占有率')}
                        </h3>
                        <ResponsiveContainer width="100%" height={300}>
                          <PieChart>
                            <Pie
                              data={companySummary.slice(0, 8).map((row, i) => ({
                                name: row.company_name,
                                value: row.total_sales,
                                color: GENRE_COLORS[i % GENRE_COLORS.length],
                              }))}
                              dataKey="value" nameKey="name"
                              cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2}
                            >
                              {companySummary.slice(0, 8).map((_, idx) => (
                                <Cell key={idx} fill={GENRE_COLORS[idx % GENRE_COLORS.length]} fillOpacity={0.85} />
                              ))}
                            </Pie>
                            <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), t('매출', '売上')]} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Company ranking bars */}
                      <div>
                        <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                          {t('제작사 랭킹', '制作会社ランキング')}
                        </h3>
                        <div className="space-y-3">
                          {companySummary.slice(0, 10).map((row, i) => {
                            const maxSales = companySummary[0]?.total_sales ?? 1;
                            const barWidth = maxSales > 0 ? (row.total_sales / maxSales) * 100 : 0;
                            const color = GENRE_COLORS[i % GENRE_COLORS.length];
                            return (
                              <motion.div
                                key={row.company_name}
                                initial={{ opacity: 0, x: 16 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.06 }}
                                className="cursor-pointer group"
                              >
                                <div className="flex items-center gap-3 mb-1">
                                  <span className="text-[13px] font-bold w-5 text-center" style={{ color: i < 3 ? color : 'var(--color-text-muted)' }}>
                                    {i + 1}
                                  </span>
                                  <span className="text-[14px] font-medium flex-1 truncate" style={{ color: 'var(--color-text-primary)' }}>
                                    {row.company_name}
                                  </span>
                                  <span className="text-[12px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                                    {row.title_count}{t('작품', '作品')}
                                  </span>
                                  <span className="text-[14px] font-bold shrink-0" style={{ color: 'var(--color-text-primary)' }}>
                                    {formatCurrency(row.total_sales)}
                                  </span>
                                </div>
                                <div className="ml-8 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-glass-border)' }}>
                                  <motion.div
                                    className="h-full rounded-full"
                                    style={{ background: color }}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${barWidth}%` }}
                                    transition={{ duration: 0.7, delay: 0.1 + i * 0.06 }}
                                  />
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
          </div>

          {/* ===== ALERT PANEL (주의/급성장 작품) ===== */}
          {(declining.length > 0 || surging.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Declining */}
              <motion.div
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className="rounded-2xl p-5"
                style={{ ...GLASS_CARD, borderLeft: '3px solid #ef4444' }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={16} color="#ef4444" />
                  <h3 className="text-[15px] font-semibold" style={{ color: '#ef4444' }}>
                    {t('주의 작품', '注意作品')}
                  </h3>
                  <span className="text-[12px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                    {declining.length}{t('건', '件')}
                  </span>
                </div>
                <div className="space-y-2">
                  {declining.slice(0, 5).map((alert, i) => (
                    <motion.div
                      key={alert.title_jp}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.4 + i * 0.12 }}
                      className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all"
                      style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.08)' }}
                      whileHover={{ x: 4, background: 'rgba(239,68,68,0.08)' }}
                      onClick={() => router.push(`/titles?search=${encodeURIComponent(alert.title_jp)}`)}
                    >
                      <TrendingDown size={14} color="#ef4444" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                          {alert.title_kr || alert.title_jp}
                        </p>
                      </div>
                      <span className="text-[14px] font-bold shrink-0" style={{ color: '#ef4444' }}>
                        {alert.growth_pct.toFixed(0)}%
                      </span>
                      <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />
                    </motion.div>
                  ))}
                </div>
                {declining.length > 5 && (
                  <button onClick={() => router.push('/titles')}
                    className="mt-3 text-[13px] font-medium w-full text-center py-1.5 rounded-lg transition-colors"
                    style={{ color: '#ef4444', background: 'rgba(239,68,68,0.06)' }}>
                    {t('전체 보기', 'すべて表示')} ({declining.length})
                  </button>
                )}
              </motion.div>

              {/* Surging */}
              <motion.div
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className="rounded-2xl p-5"
                style={{ ...GLASS_CARD, borderLeft: '3px solid #22c55e' }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Rocket size={16} color="#22c55e" />
                  <h3 className="text-[15px] font-semibold" style={{ color: '#22c55e' }}>
                    {t('급성장 작품', '急成長作品')}
                  </h3>
                  <span className="text-[12px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                    {surging.length}{t('건', '件')}
                  </span>
                </div>
                <div className="space-y-2">
                  {surging.slice(0, 5).map((alert, i) => (
                    <motion.div
                      key={alert.title_jp}
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.4 + i * 0.12 }}
                      className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all"
                      style={{ background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.08)' }}
                      whileHover={{ x: 4, background: 'rgba(34,197,94,0.08)' }}
                      onClick={() => router.push(`/titles?search=${encodeURIComponent(alert.title_jp)}`)}
                    >
                      <TrendingUp size={14} color="#22c55e" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                          {alert.title_kr || alert.title_jp}
                        </p>
                      </div>
                      <span className="text-[14px] font-bold shrink-0" style={{ color: '#22c55e' }}>
                        +{alert.growth_pct.toFixed(0)}%
                      </span>
                      <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />
                    </motion.div>
                  ))}
                </div>
                {surging.length > 5 && (
                  <button onClick={() => router.push('/titles')}
                    className="mt-3 text-[13px] font-medium w-full text-center py-1.5 rounded-lg transition-colors"
                    style={{ color: '#22c55e', background: 'rgba(34,197,94,0.06)' }}>
                    {t('전체 보기', 'すべて表示')} ({surging.length})
                  </button>
                )}
              </motion.div>
            </div>
          )}

          {/* ── 5. 트렌드 작품 ── */}
          <div className="rounded-2xl p-6" style={GLASS_CARD}>
            <h3 className="text-[16px] font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
              Top {Math.min(topTitles.length, 20)} {t('작품', 'タイトル')}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[600px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-table-border)' }}>
                    <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>#</th>
                    <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('작품', 'タイトル')}</th>
                    <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('장르', 'ジャンル')}</th>
                    <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('제작사', '制作会社')}</th>
                    <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('플랫폼', 'PF')}</th>
                    <th className="text-right py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('해당 기간 매출', '期間売上')}</th>
                  </tr>
                </thead>
                <tbody>
                  {topTitles.slice(0, 20).map((title, idx) => (
                    <motion.tr
                      key={title.title_jp}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.04 }}
                      style={{ borderBottom: '1px solid var(--color-table-border-subtle)' }}
                      className="cursor-pointer transition-colors hover:brightness-110"
                      onClick={() => router.push(`/titles?highlight=${encodeURIComponent(title.title_jp)}`)}
                    >
                      <td className="py-3 px-2 font-bold text-[14px]" style={{ color: idx < 3 ? '#1A2B5E' : 'var(--color-text-muted)' }}>
                        {idx + 1}
                      </td>
                      <td className="py-3 px-2" style={{ maxWidth: 220 }}>
                        <p className="font-medium text-[14px] truncate" style={{ color: 'var(--color-text-primary)' }}>{title.title_jp}</p>
                        {title.title_kr && <p className="text-[12px] truncate" style={{ color: 'var(--color-text-muted)' }}>{title.title_kr}</p>}
                      </td>
                      <td className="py-3 px-2">
                        <span className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                          {titleMetaMap.get(title.title_jp)?.genre || '-'}
                        </span>
                      </td>
                      <td className="py-3 px-2">
                        <span className="text-[12px] truncate block max-w-[100px]" title={titleMetaMap.get(title.title_jp)?.company || ''} style={{ color: 'var(--color-text-secondary)' }}>
                          {titleMetaMap.get(title.title_jp)?.company || '-'}
                        </span>
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex gap-1 flex-wrap">
                          {(title.channels ?? []).slice(0, 3).map((ch) => (
                            <PlatformBadge key={ch} name={ch} showName={false} size="sm" />
                          ))}
                          {(title.channels ?? []).length > 3 && (
                            <span className="text-[12px] px-1" style={{ color: 'var(--color-text-muted)' }}>+{title.channels.length - 3}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-bold text-[14px]" style={{ color: 'var(--color-text-primary)' }}>
                        {formatCurrency(title.total_sales)}
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
    </motion.div>
  );
}
