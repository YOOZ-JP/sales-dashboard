'use client';

import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import {
  Monitor, TrendingUp, BarChart3, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Minus,
  Activity, X, Check, Hash, CalendarDays,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { usePlatformSummary, usePlatformDetail, usePlatformSummaryForPeriod, useTitleMaster } from '@/hooks/useData';
import { fetchPlatformDetail } from '@/lib/supabase';
import { getPlatformColor, getPlatformBrand, getPlatformLogo } from '@/utils/platformConfig';
import { useApp } from '@/context/AppContext';
import type { PlatformSummaryRow, PlatformDetailData } from '@/types';
// DateRangePicker replaced with inline month navigator
import PlatformGenreMatrix from '@/components/platforms/PlatformGenreMatrix';
// ParetoChart, HealthTrend removed (tab system removed)
import { GLASS_CARD, darkTooltipStyle, containerVariants, cardVariants } from '@/lib/design-tokens';

// ============================================================
// Props — server-side prefetched data
// ============================================================

export interface PlatformsInitialData {
  platforms: PlatformSummaryRow[] | null;
}

interface PlatformsClientProps {
  initialData?: PlatformsInitialData | null;
}

const platformCardContainer = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const platformCardItem = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const } },
};

type ChartTooltipPayload = {
  value?: string | number;
  name?: string | number;
  color?: string;
};

// ─── Skeletons ───────────────────────────────────────────────
function KPISkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl p-5 animate-pulse" style={{ ...GLASS_CARD, minHeight: 100 }}>
          <div className="h-3 w-16 rounded skeleton-shimmer mb-3" />
          <div className="h-7 w-24 rounded skeleton-shimmer mb-2" />
          <div className="h-3 w-12 rounded skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton({ height = 360 }: { height?: number }) {
  return (
    <div className="rounded-2xl p-6 animate-pulse" style={{ ...GLASS_CARD, minHeight: height }}>
      <div className="h-4 w-40 rounded skeleton-shimmer mb-6" />
      <div className="flex items-end gap-1" style={{ height: height - 100 }}>
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="flex-1 rounded-t bg-[var(--color-glass)]" style={{ height: `${30 + ((i * 37 + 13) % 60)}%` }} />
        ))}
      </div>
    </div>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="rounded-2xl p-5 animate-pulse" style={{ ...GLASS_CARD, minHeight: 140 }}>
          <div className="h-8 w-8 rounded-lg skeleton-shimmer mb-3" />
          <div className="h-4 w-20 rounded skeleton-shimmer mb-2" />
          <div className="h-6 w-24 rounded skeleton-shimmer mb-2" />
          <div className="h-3 w-16 rounded skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}

// ─── Growth pill badge ───────────────────────────────────────
function GrowthPill({ current, previous, size = 'sm' }: { current: number; previous: number; size?: 'sm' | 'md' }) {
  if (previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const isUp = pct > 0;
  const isFlat = Math.abs(pct) < 0.5;

  const textSize = size === 'md' ? 'text-sm' : 'text-[13px]';
  const px = size === 'md' ? 'px-2.5 py-1' : 'px-1.5 py-0.5';

  return (
    <span
      className={`inline-flex items-center gap-0.5 ${textSize} font-semibold ${px} rounded-full`}
      style={{
        background: isFlat ? 'rgba(148, 163, 184, 0.15)' : isUp ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
        color: isFlat ? '#94a3b8' : isUp ? '#22c55e' : '#ef4444',
      }}
    >
      {isFlat ? <Minus size={10} /> : isUp ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      {isFlat ? '0%' : `${isUp ? '+' : ''}${pct.toFixed(1)}%`}
    </span>
  );
}

// ─── Rank change badge ───────────────────────────────────────
function RankChangeBadge({ change }: { change: number }) {
  if (change === 0) return null;
  const isUp = change > 0;
  return (
    <span className="text-[12px] font-bold" style={{ color: isUp ? '#22c55e' : '#ef4444' }}>
      {isUp ? `↑${change}` : `↓${Math.abs(change)}`}
    </span>
  );
}

// ─── Detail tab names ────────────────────────────────────────
// Detail tabs removed — content shown inline

// ─── Top N options ───────────────────────────────────────────
const TOP_N_OPTIONS = [5, 10, 20, 50];

export default function PlatformsClient({ initialData }: PlatformsClientProps) {
  const { formatCurrency, t } = useApp();
  const router = useRouter();
  const { data: titleMasterRaw } = useTitleMaster();
  const titleMetaMap = useMemo(() => {
    const map = new Map<string, { genre: string; company: string }>();
    if (titleMasterRaw && Array.isArray(titleMasterRaw)) {
      for (const tm of titleMasterRaw) {
        const g = (tm as Record<string, unknown>).genres;
        const c = (tm as Record<string, unknown>).production_companies;
        map.set(tm.title_jp, {
          genre: g && typeof g === 'object' && 'name_kr' in (g as Record<string, unknown>) ? String((g as Record<string, unknown>).name_kr) : '',
          company: c && typeof c === 'object' && 'name' in (c as Record<string, unknown>) ? String((c as Record<string, unknown>).name) : '',
        });
      }
    }
    return map;
  }, [titleMasterRaw]);

  // SWR data hooks (client-side fetch with server prefetch as fallback)
  const { data: platformSummaryRaw } = usePlatformSummary();
  const platformSummary = useMemo<PlatformSummaryRow[]>(() => platformSummaryRaw ?? initialData?.platforms ?? [], [platformSummaryRaw, initialData?.platforms]);
  const loading = !platformSummaryRaw && !initialData?.platforms;

  // Auto-select first platform once data loads
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

  // platformDetailSWR는 startDate 선언 이후로 이동

  // C1: Date range (default: 전체 기간)
  const [startDate, setStartDate] = useState('2025-03-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [activePreset, setActivePreset] = useState<string>('all');

  // selectedPlatform 초기화는 displaySummary 뒤에서 처리

  // 선택된 플랫폼 상세 (기간 필터 포함)
  const { data: platformDetailSWR, isValidating: platformDetailValidating } = usePlatformDetail(
    selectedPlatform && !loading ? selectedPlatform : null,
    startDate,
    endDate,
  );
  const detailData = useMemo<PlatformDetailData | null>(() => {
    return (platformDetailSWR as PlatformDetailData) ?? null;
  }, [platformDetailSWR]);
  const detailLoading = platformDetailValidating && !platformDetailSWR;

  // C2: Period-based platform summary
  const { data: periodSummaryRaw } = usePlatformSummaryForPeriod(startDate, endDate);

  // Previous period range (same duration, immediately before startDate)
  const prevRange = useMemo(() => {
    if (!startDate || !endDate) return { start: '', end: '' };
    const s = new Date(startDate + 'T00:00:00');
    const e = new Date(endDate + 'T00:00:00');
    const diffMs = e.getTime() - s.getTime();
    const prevEnd = new Date(s.getTime() - 86400000); // day before startDate
    const prevStart = new Date(prevEnd.getTime() - diffMs);
    return {
      start: prevStart.toISOString().slice(0, 10),
      end: prevEnd.toISOString().slice(0, 10),
    };
  }, [startDate, endDate]);

  const { data: prevSummaryRaw } = usePlatformSummaryForPeriod(prevRange.start, prevRange.end);

  // Display data: period selection -> periodSummary, else -> platformSummary (all-time)
  const displaySummary = useMemo<PlatformSummaryRow[]>(() => {
    if (startDate && endDate && periodSummaryRaw) return periodSummaryRaw as PlatformSummaryRow[];
    return platformSummary;
  }, [startDate, endDate, periodSummaryRaw, platformSummary]);

  // 기간 변경 시 1위 플랫폼 자동 선택
  useEffect(() => {
    if (displaySummary.length > 0) {
      const handle = window.requestAnimationFrame(() => {
        setSelectedPlatform(displaySummary[0].channel);
      });
      return () => window.cancelAnimationFrame(handle);
    }
  }, [displaySummary]);

  // Previous period data for growth calculation
  const prevSummary = useMemo<PlatformSummaryRow[]>(() => {
    if (prevSummaryRaw) return prevSummaryRaw as PlatformSummaryRow[];
    return [];
  }, [prevSummaryRaw]);

  // Detail tab
  // detailTab removed — content shown inline

  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [comparePlatforms, setComparePlatforms] = useState<string[]>([]);
  const [compareDetails, setCompareDetails] = useState<Map<string, PlatformDetailData>>(new Map());
  const [compareLoading, setCompareLoading] = useState(false);

  // C8: Top N
  const [topN, setTopN] = useState(10);

  const formatShort = (value: number): string => {
    return Math.round(value).toLocaleString();
  };

  // Compare mode still uses manual fetch for multiple platforms

  useEffect(() => {
    if (!compareMode || comparePlatforms.length === 0) return;
    let cancelled = false;
    async function loadAll() {
      setCompareLoading(true);
      const newMap = new Map<string, PlatformDetailData>();
      for (const ch of comparePlatforms) {
        try {
          const data = await fetchPlatformDetail(ch);
          if (!cancelled && data) newMap.set(ch, data);
        } catch (err) {
          console.error(`Failed to load detail for ${ch}:`, err);
        }
      }
      if (!cancelled) {
        setCompareDetails(newMap);
        setCompareLoading(false);
      }
    }
    loadAll();
    return () => { cancelled = true; };
  }, [compareMode, comparePlatforms]);

  // ─── Computed values ───────────────────────────────────────
  // C2: sorted platforms with rank info
  const sortedPlatforms = useMemo(() => {
    const current = [...displaySummary].sort((a, b) => b.total_sales - a.total_sales);
    const prevRanks = new Map<string, number>();
    const prevSorted = [...prevSummary].sort((a, b) => b.total_sales - a.total_sales);
    prevSorted.forEach((p, i) => prevRanks.set(p.channel, i + 1));

    return current.map((p, i) => {
      const prevRank = prevRanks.get(p.channel) ?? (i + 1);
      const prevData = prevSummary.find((ps) => ps.channel === p.channel);
      return {
        ...p,
        rank: i + 1,
        rankChange: prevRank - (i + 1),
        prevTotalSales: prevData?.total_sales ?? 0,
      };
    });
  }, [displaySummary, prevSummary]);

  // Title count shown inline in the list header

  // Compare chart data
  const compareChartData = useMemo(() => {
    if (comparePlatforms.length === 0 || compareDetails.size === 0) return [];
    const monthSet = new Set<string>();
    for (const detail of compareDetails.values()) {
      for (const mt of detail.monthly_trend ?? []) monthSet.add(mt.month);
    }
    const months = Array.from(monthSet).sort();
    return months.map((month) => {
      const point: Record<string, string | number> = { label: month };
      for (const [ch, detail] of compareDetails) {
        const match = (detail.monthly_trend ?? []).find((mt) => mt.month === month);
        point[ch] = match?.sales ?? 0;
      }
      return point;
    });
  }, [comparePlatforms, compareDetails]);

  // Filter monthly trend by date range (C1)
  const filteredMonthlyTrend = useMemo(() => {
    const trend = detailData?.monthly_trend ?? [];
    if (!startDate && !endDate) return trend;
    return trend.filter((mt) => {
      if (startDate && mt.month < startDate.substring(0, 7)) return false;
      if (endDate && mt.month > endDate.substring(0, 7)) return false;
      return true;
    });
  }, [detailData, startDate, endDate]);

  const toggleComparePlatform = (pf: string) => {
    setComparePlatforms((prev) =>
      prev.includes(pf) ? prev.filter((p) => p !== pf) : [...prev, pf]
    );
  };

  const selectedSummary = useMemo(
    () => displaySummary.find((p) => p.channel === selectedPlatform),
    [displaySummary, selectedPlatform]
  );

  const selectedSorted = useMemo(
    () => sortedPlatforms.find((p) => p.channel === selectedPlatform),
    [sortedPlatforms, selectedPlatform]
  );

  const handleCardClick = (pf: string) => {
    if (compareMode) {
      toggleComparePlatform(pf);
    } else {
      setSelectedPlatform(pf === selectedPlatform ? null : pf);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center page-icon-glow">
          <Monitor size={20} color="white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('플랫폼별 매출 분석', 'プラットフォーム別売上分析')}
          </h1>
        </div>

        {/* 월 네비게이터 + 프리셋 (매출 대시보드와 동일) */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 rounded-xl px-1 py-1" style={{ background: 'var(--color-glass)', border: '1px solid var(--color-glass-border)' }}>
            <button
              onClick={() => {
                if (activePreset === 'all') return;
                const d = new Date(startDate);
                d.setMonth(d.getMonth() - 1);
                const y = d.getFullYear(), m = d.getMonth();
                setStartDate(`${y}-${String(m + 1).padStart(2, '0')}-01`);
                setEndDate(new Date(y, m + 1, 0).toISOString().slice(0, 10));
                setActivePreset('custom');
              }}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: activePreset !== 'all' ? 'var(--color-text-secondary)' : 'var(--color-text-subtle)', opacity: activePreset !== 'all' ? 1 : 0.3 }}
            ><ChevronLeft size={16} /></button>
            <span className="text-[15px] font-bold px-3 min-w-[130px] text-center" style={{ color: 'var(--color-text-primary)' }}>
              {(() => {
                if (activePreset === 'all') return t('전체 기간', '全期間');
                if (activePreset === 'thisYear') return `${new Date().getFullYear()}${t('년', '年')}`;
                const d = new Date(startDate);
                return `${d.getFullYear()}${t('년', '年')} ${d.getMonth() + 1}${t('월', '月')}`;
              })()}
            </span>
            <button
              onClick={() => {
                if (activePreset === 'all') return;
                const d = new Date(startDate);
                d.setMonth(d.getMonth() + 1);
                const y = d.getFullYear(), m = d.getMonth();
                setStartDate(`${y}-${String(m + 1).padStart(2, '0')}-01`);
                const last = new Date(y, m + 1, 0), today = new Date();
                setEndDate(last > today ? today.toISOString().slice(0, 10) : last.toISOString().slice(0, 10));
                setActivePreset('custom');
              }}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: activePreset !== 'all' ? 'var(--color-text-secondary)' : 'var(--color-text-subtle)', opacity: activePreset !== 'all' ? 1 : 0.3 }}
            ><ChevronRight size={16} /></button>
          </div>
          {[
            { id: 'thisMonth', ko: '이번달', ja: '今月' },
            { id: 'lastMonth', ko: '지난달', ja: '先月' },
            { id: 'thisYear', ko: '올해', ja: '今年' },
            { id: 'all', ko: '전체', ja: '全体' },
          ].map((p) => (
            <button key={p.id} onClick={() => {
              setActivePreset(p.id);
              const now = new Date();
              if (p.id === 'thisMonth') { setStartDate(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`); setEndDate(now.toISOString().slice(0,10)); }
              else if (p.id === 'lastMonth') { const lm = new Date(now.getFullYear(), now.getMonth()-1, 1); setStartDate(`${lm.getFullYear()}-${String(lm.getMonth()+1).padStart(2,'0')}-01`); setEndDate(new Date(lm.getFullYear(), lm.getMonth()+1, 0).toISOString().slice(0,10)); }
              else if (p.id === 'thisYear') { setStartDate(`${now.getFullYear()}-01-01`); setEndDate(now.toISOString().slice(0,10)); }
              else { setStartDate('2025-03-01'); setEndDate(now.toISOString().slice(0,10)); }
            }}
              className="px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all"
              style={{
                background: activePreset === p.id ? '#1A2B5E' : 'var(--color-glass)',
                color: activePreset === p.id ? '#fff' : 'var(--color-text-secondary)',
                border: `1px solid ${activePreset === p.id ? 'transparent' : 'var(--color-glass-border)'}`,
              }}
            >{t(p.ko, p.ja)}</button>
          ))}
        </div>
      </div>

      {/* Compare toggle */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="flex items-center gap-3 mb-6"
      >
        <div>
          <button
            onClick={() => {
              setCompareMode(!compareMode);
              setComparePlatforms(selectedPlatform ? [selectedPlatform] : []);
            }}
            className="text-[13px] px-4 py-2 rounded-xl cursor-pointer transition-all font-medium self-start sm:self-auto"
            style={{
              background: compareMode ? 'rgba(99, 102, 241, 0.2)' : 'var(--color-input-bg)',
              color: compareMode ? '#a5b4fc' : 'var(--color-text-secondary)',
              border: compareMode ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid var(--color-glass-border)',
            }}
          >
            <BarChart3 size={13} className="inline mr-1.5 -mt-0.5" />
            {t('비교 모드', '比較モード')}
            {compareMode && ` (${comparePlatforms.length})`}
          </button>
        </div>
      </motion.div>

      {loading ? (
        <div className="space-y-6"><CardGridSkeleton /><ChartSkeleton /></div>
      ) : (
        <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">

          {/* ═══ Platform Card Grid ═══ */}
          <motion.div
            variants={platformCardContainer}
            initial="hidden"
            animate="show"
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
          >
            {sortedPlatforms.map((pf) => {
              const brand = getPlatformBrand(pf.channel);
              const logo = getPlatformLogo(pf.channel);
              const color = brand.color;
              const isSelected = compareMode
                ? comparePlatforms.includes(pf.channel)
                : selectedPlatform === pf.channel;

              return (
                <motion.button
                  key={pf.channel}
                  variants={platformCardItem}
                  whileHover={{
                    scale: 1.03,
                    boxShadow: `0 8px 30px ${color}33`,
                    transition: { duration: 0.2 },
                  }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleCardClick(pf.channel)}
                  className="relative text-left cursor-pointer rounded-2xl p-4 sm:p-5 transition-all"
                  style={{
                    background: isSelected
                      ? `linear-gradient(135deg, ${color}18, ${color}08)`
                      : `linear-gradient(135deg, ${color}08, ${color}03)`,
                    border: 'none',
                    borderLeft: `3px solid ${isSelected ? color : `${color}55`}`,
                    borderRadius: '16px',
                    boxShadow: isSelected
                      ? `0 4px 20px ${color}25, inset 0 0 0 1px ${color}30`
                      : 'inset 0 0 0 1px var(--color-glass-border)',
                  }}
                >
                  {/* Compare checkbox */}
                  {compareMode && (
                    <div
                      className="absolute top-3 right-3 w-5 h-5 rounded-md flex items-center justify-center"
                      style={{
                        background: isSelected ? color : 'rgba(255,255,255,0.05)',
                        border: isSelected ? 'none' : '1.5px solid var(--color-glass-border)',
                      }}
                    >
                      {isSelected && <Check size={12} color="#fff" strokeWidth={3} />}
                    </div>
                  )}

                  {/* Selected check (single mode) */}
                  {!compareMode && isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center"
                      style={{ background: color }}
                    >
                      <Check size={11} color="#fff" strokeWidth={3} />
                    </motion.div>
                  )}

                  {/* Platform logo */}
                  <div className="flex items-center gap-2.5 mb-3">
                    {logo ? (
                      <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0" style={{ boxShadow: `0 2px 8px ${color}30` }}>
                        <img src={logo} alt={t(brand.nameKR, brand.nameJP) || pf.channel} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold"
                        style={{ background: `${color}20`, color }}
                      >
                        {brand.icon}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {t(brand.nameKR, brand.nameJP) || pf.channel}
                      </p>
                      {/* Rank badge */}
                      <div className="flex items-center gap-1">
                        <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                          #{pf.rank}
                        </span>
                        {pf.rankChange !== 0 && <RankChangeBadge change={pf.rankChange} />}
                      </div>
                    </div>
                  </div>

                  {/* Sales amount */}
                  <p className="text-xl sm:text-2xl font-bold mb-1.5" style={{ color: 'var(--color-text-primary)' }}>
                    {formatCurrency(pf.total_sales)}
                  </p>

                  {/* Growth + title count */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <GrowthPill current={pf.total_sales} previous={pf.prevTotalSales} />
                    <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                      {t(`작품 ${pf.title_count}개`, `${pf.title_count}作品`)}
                    </span>
                  </div>
                </motion.button>
              );
            })}
          </motion.div>

          {/* ═══ Compare mode chart ═══ */}
          {compareMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-2xl p-6"
              style={GLASS_CARD}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  {t('플랫폼 비교', 'プラットフォーム比較')}
                </h2>
                {/* Legend with logos */}
                <div className="flex items-center gap-3 flex-wrap">
                  {comparePlatforms.map((pf) => {
                    const brand = getPlatformBrand(pf);
                    const logo = getPlatformLogo(pf);
                    return (
                      <div key={pf} className="flex items-center gap-1.5">
                        {logo ? (
                          <img src={logo} alt="" className="w-4 h-4 rounded object-cover" />
                        ) : (
                          <div className="w-3 h-3 rounded-full" style={{ background: brand.color }} />
                        )}
                        <span className="text-[13px] font-medium" style={{ color: brand.color }}>
                          {t(brand.nameKR, brand.nameJP) || pf}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {compareLoading ? (
                <div className="flex justify-center py-12">
                  <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
                </div>
              ) : compareChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <AreaChart data={compareChartData}>
                    <defs>
                      {comparePlatforms.map((pf) => (
                        <linearGradient key={pf} id={`pfGrad-${pf.replace(/[^a-zA-Z0-9]/g, '_')}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={getPlatformColor(pf)} stopOpacity={0.25} />
                          <stop offset="100%" stopColor={getPlatformColor(pf)} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} tickFormatter={formatShort} width={110} />
                    <ReTooltip content={({ active, payload, label }: { active?: boolean; payload?: readonly ChartTooltipPayload[]; label?: string | number }) => {
                      if (!active || !payload) return null;
                      const sorted = [...payload].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
                      return (
                        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-glass-border)', borderRadius: 12, padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 6 }}>{label}</p>
                          {sorted.map((entry) => (
                            <p key={String(entry.name)} style={{ color: entry.color, fontSize: 14, fontWeight: 600 }}>
                              {t(getPlatformBrand(String(entry.name)).nameKR, getPlatformBrand(String(entry.name)).nameJP) || String(entry.name)}: {formatCurrency(Number(entry.value ?? 0))}
                            </p>
                          ))}
                        </div>
                      );
                    }} />
                    <Legend
                      wrapperStyle={{ fontSize: 13, color: 'var(--color-text-secondary)' }}
                      formatter={(value: string) => {
                        const brand = getPlatformBrand(value);
                        return t(brand.nameKR, brand.nameJP) || value;
                      }}
                    />
                    {comparePlatforms.map((pf) => (
                      <Area
                        key={pf}
                        type="monotone"
                        dataKey={pf}
                        name={pf}
                        stroke={getPlatformColor(pf)}
                        strokeWidth={2.5}
                        fill={`url(#pfGrad-${pf.replace(/[^a-zA-Z0-9]/g, '_')})`}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-center py-12" style={{ color: 'var(--color-text-muted)' }}>
                  {t('비교할 플랫폼을 선택해주세요', 'プラットフォームを選択してください')}
                </p>
              )}
            </motion.div>
          )}

          {/* ═══ Platform Detail Panel (single mode) ═══ */}
          <AnimatePresence mode="wait">
            {!compareMode && selectedPlatform && (
              <motion.div
                key={selectedPlatform}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="rounded-2xl overflow-hidden"
                style={{
                  ...GLASS_CARD,
                  borderLeft: `3px solid ${getPlatformColor(selectedPlatform)}`,
                }}
              >
                {/* Detail Header */}
                <div className="p-5 sm:p-6">
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-3">
                      {getPlatformLogo(selectedPlatform) ? (
                        <div className="w-9 h-9 rounded-xl overflow-hidden" style={{ boxShadow: `0 2px 12px ${getPlatformColor(selectedPlatform)}30` }}>
                          <img src={getPlatformLogo(selectedPlatform)} alt="" className="w-full h-full object-cover" />
                        </div>
                      ) : (
                        <div
                          className="w-9 h-9 rounded-xl flex items-center justify-center font-bold"
                          style={{ background: `${getPlatformColor(selectedPlatform)}20`, color: getPlatformColor(selectedPlatform) }}
                        >
                          {getPlatformBrand(selectedPlatform).icon}
                        </div>
                      )}
                      <div>
                        <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
                          {getPlatformBrand(selectedPlatform).nameJP || selectedPlatform}
                          <span className="text-sm font-normal ml-2" style={{ color: 'var(--color-text-muted)' }}>
                            {t('상세 분석', '詳細分析')}
                          </span>
                        </h2>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedPlatform(null)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors"
                      style={{ background: 'var(--color-input-bg)', border: 'none', color: 'var(--color-text-muted)' }}
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* KPI Row */}
                  {detailLoading ? <KPISkeleton /> : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                      {[
                        {
                          label: t('총매출', '総売上'),
                          value: formatCurrency(detailData?.total_sales ?? selectedSummary?.total_sales ?? 0),
                          icon: <TrendingUp size={14} />,
                          growth: selectedSorted ? { current: selectedSorted.total_sales, previous: selectedSorted.prevTotalSales } : null,
                          isGrowthCard: false,
                        },
                        {
                          label: t('작품수', 'タイトル数'),
                          value: String(detailData?.title_count ?? selectedSummary?.title_count ?? 0),
                          icon: <Hash size={14} />,
                          growth: null,
                          isGrowthCard: false,
                        },
                        {
                          label: t('일평균', '日平均'),
                          value: formatCurrency(detailData?.daily_avg ?? selectedSummary?.avg_daily ?? 0),
                          icon: <CalendarDays size={14} />,
                          growth: null,
                          isGrowthCard: false,
                        },
                        {
                          label: t('성장률', '成長率'),
                          value: selectedSorted && selectedSorted.prevTotalSales > 0
                            ? `${(((selectedSorted.total_sales - selectedSorted.prevTotalSales) / selectedSorted.prevTotalSales) * 100).toFixed(1)}%`
                            : '—',
                          icon: <Activity size={14} />,
                          growth: null,
                          isGrowthCard: true,
                        },
                      ].map((kpi, idx) => (
                        <motion.div
                          key={idx}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="rounded-xl p-4"
                          style={{
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid var(--color-glass-border)',
                          }}
                        >
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span style={{ color: getPlatformColor(selectedPlatform), opacity: 0.7 }}>{kpi.icon}</span>
                            <p className="text-[12px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{kpi.label}</p>
                          </div>
                          <p className="text-lg sm:text-xl font-bold" style={{
                            color: kpi.isGrowthCard
                              ? (selectedSorted && selectedSorted.total_sales >= selectedSorted.prevTotalSales ? '#22c55e' : '#ef4444')
                              : 'var(--color-text-primary)',
                          }}>
                            {kpi.value}
                          </p>
                          {kpi.growth && <GrowthPill current={kpi.growth.current} previous={kpi.growth.previous} size="sm" />}
                        </motion.div>
                      ))}
                    </div>
                  )}

                </div>

                {/* ===== 추이 그래프 + 작품 리스트 (탭 없이 연속 표시) ===== */}
                <div className="px-5 sm:px-6 pb-6 space-y-6">
                  {/* 매출 추이 */}
                  <div>
                    <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                      {t('월별 매출 추이', '月別売上推移')}
                    </h3>
                    {detailLoading ? (
                      <ChartSkeleton height={300} />
                    ) : filteredMonthlyTrend.length > 0 ? (
                      <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={filteredMonthlyTrend.map((d) => ({ label: d.month, sales: d.sales }))}>
                          <defs>
                            <linearGradient id="pfSingleGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={getPlatformColor(selectedPlatform)} stopOpacity={0.3} />
                              <stop offset="100%" stopColor={getPlatformColor(selectedPlatform)} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                          <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 13 }} axisLine={false} tickLine={false} tickFormatter={formatShort} width={110} />
                          <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), t('매출', '売上')]} />
                          <Area type="monotone" dataKey="sales" stroke={getPlatformColor(selectedPlatform)} strokeWidth={2.5} fill="url(#pfSingleGrad)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
                        {t('데이터가 없습니다', 'データがありません')}
                      </p>
                    )}
                  </div>

                  {/* 서비스 중인 작품 리스트 */}
                  {!detailLoading && (detailData?.top_titles ?? []).length > 0 && (
                    <div>
                      <div className="flex items-center gap-3 mb-4 flex-wrap">
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                          {t('서비스 중인 작품', 'サービス中の作品')} ({(detailData?.top_titles ?? []).length})
                        </h3>
                        <select
                          value={topN}
                          onChange={(e) => setTopN(Number(e.target.value))}
                          className="text-[13px] px-2 py-1.5 rounded-lg cursor-pointer outline-none"
                          style={{
                            background: 'var(--color-input-bg)',
                            color: 'var(--color-text-secondary)',
                            border: '1px solid var(--color-glass-border)',
                          }}
                        >
                          {TOP_N_OPTIONS.map((n) => (
                            <option key={n} value={n}>Top {n}</option>
                          ))}
                        </select>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-sm table-striped">
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--color-table-border)' }}>
                              <th className="text-left py-3 px-2 font-medium" style={{ color: 'var(--color-text-secondary)' }}>#</th>
                              <th className="text-left py-3 px-2 font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                                {t('작품', 'タイトル')}
                              </th>
                              <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                                {t('장르', 'ジャンル')}
                              </th>
                              <th className="text-left py-3 px-2 font-medium text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                                {t('제작사', '制作会社')}
                              </th>
                              <th className="text-right py-3 px-2 font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                                {t('매출', '売上')}
                              </th>
                              <th className="w-8"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {(detailData?.top_titles ?? []).slice(0, topN).map((title, idx) => (
                              <motion.tr
                                key={title.title_jp}
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: idx * 0.03 }}
                                style={{ borderBottom: '1px solid var(--color-table-border-subtle)' }}
                                className="cursor-pointer transition-all hover:brightness-110"
                                onClick={() => router.push(`/titles?highlight=${encodeURIComponent(title.title_jp)}`)}
                              >
                                <td className="py-3 px-2 font-bold" style={{ color: idx < 3 ? getPlatformColor(selectedPlatform) : 'var(--color-text-muted)' }}>
                                  {idx + 1}
                                </td>
                                <td className="py-3 px-2" style={{ maxWidth: '220px' }}>
                                  <p className="font-medium truncate" title={title.title_jp} style={{ color: 'var(--color-text-primary)' }}>{title.title_jp}</p>
                                  {title.title_kr && <p className="text-[13px] truncate" title={title.title_kr} style={{ color: 'var(--color-text-muted)' }}>{title.title_kr}</p>}
                                </td>
                                <td className="py-3 px-2">
                                  <span className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                                    {titleMetaMap.get(title.title_jp)?.genre || '-'}
                                  </span>
                                </td>
                                <td className="py-3 px-2">
                                  <span className="text-[12px] truncate block max-w-[80px]" title={titleMetaMap.get(title.title_jp)?.company || ''} style={{ color: 'var(--color-text-secondary)' }}>
                                    {titleMetaMap.get(title.title_jp)?.company || '-'}
                                  </span>
                                </td>
                                <td className="py-3 px-2 text-right font-bold" style={{ color: 'var(--color-text-primary)' }}>
                                  {formatCurrency(title.total_sales)}
                                </td>
                                <td className="py-2 px-2">
                                  <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />
                                </td>
                              </motion.tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* C3: Platform x Genre Cross Analysis (always visible when no platform selected or in compare mode) */}
          {(compareMode || !selectedPlatform) && (
            <motion.div variants={cardVariants} className="rounded-2xl p-6" style={GLASS_CARD}>
              <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>
                {t('플랫폼 × 장르 크로스 분석', 'プラットフォーム × ジャンル クロス分析')}
              </h2>
              <p className="text-[13px] mb-4" style={{ color: 'var(--color-text-muted)' }}>
                {t('어떤 장르가 어떤 플랫폼에서 강한지 한눈에', 'どのジャンルがどのプラットフォームで強いか一目で確認')}
              </p>
              <PlatformGenreMatrix startDate={startDate} endDate={endDate} />
            </motion.div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
