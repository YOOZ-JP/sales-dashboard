'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { Pagination } from '@/components/Pagination';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/providers/AuthProvider';

// ============================================================
// Types
// ============================================================

interface ContentRow {
  id: string;
  source_sheet: string;
  source_row: number;
  status: 'service' | 'prep';
  title_jp: string | null;
  title_kr: string | null;
  management_type: string | null;
  production_company: string | null;
  distribution_company: string | null;
  format: string | null;
  artist: string | null;
  artist_reading: string | null;
  adaptation: string | null;
  adaptation_reading: string | null;
  original_author: string | null;
  original_author_reading: string | null;
  genre: string | null;
  label: string | null;
  weekday: string | null;
  copyright: string | null;
  synopsis: string | null;
  distribution_scope: string | null;
  non_exclusive_conversion_date: string | null;
  service_planned_date: string | null;
  notes: string | null;
}

interface Stats {
  total: number;
  active: number;
  byStatus: Record<string, number>;
  byGenre: Record<string, number>;
  byLabel: Record<string, number>;
  byFormat: Record<string, number>;
}

// ============================================================
// Shared styles
// ============================================================

const GLASS_CARD = {
  background: 'var(--color-glass)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--color-glass-border)',
  borderRadius: '16px',
} as const;

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.03 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

const PAGE_SIZE = 50;

// ============================================================
// Component
// ============================================================

export default function ContentMasterTab() {
  const { t } = useApp();
  const { accessToken } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ContentRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);

  // Filters
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [formatFilter, setFormatFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Row expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load lightweight stats once (also drives filter dropdowns)
  useEffect(() => {
    if (!accessToken) return;
    fetch('/api/content-master/stats', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((res) => res.json())
      .then((data: Stats) => setStats(data))
      .catch((err) => console.error('Failed to load content master stats:', err));
  }, [accessToken]);

  const loadPage = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ page: String(page + 1), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (statusFilter) params.set('status', statusFilter);
    if (genreFilter) params.set('genre', genreFilter);
    if (labelFilter) params.set('label', labelFilter);
    if (formatFilter) params.set('format', formatFilter);
    try {
      const res = await fetch(`/api/content-master?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotalCount(data.count ?? 0);
    } catch (err) {
      console.error('Failed to load content master:', err);
      setRows([]);
      setTotalCount(0);
    }
    setLoading(false);
  }, [page, q, statusFilter, genreFilter, labelFilter, formatFilter, accessToken]);

  // Fetching rows here is the intended external synchronization for this tab.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadPage(); }, [loadPage]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const genreOptions = stats ? Object.keys(stats.byGenre).filter((g) => g !== '(미지정)') : [];
  const labelOptions = stats ? Object.keys(stats.byLabel).filter((g) => g !== '(미지정)') : [];
  const formatOptions = stats ? Object.keys(stats.byFormat).filter((g) => g !== '(미지정)') : [];

  const statCards = stats
    ? [
        { label: t('전체 작품', '全作品'), value: stats.active },
        { label: t('서비스', 'サービス'), value: stats.byStatus['service'] ?? 0 },
        { label: t('준비 작품', '準備作品'), value: stats.byStatus['prep'] ?? 0 },
        { label: t('장르 수', 'ジャンル数'), value: genreOptions.length },
      ]
    : [];

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-4">
      {/* Stats */}
      {stats && (
        <motion.div variants={cardVariants} className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statCards.map((c) => (
            <div key={c.label} className="rounded-2xl p-4" style={GLASS_CARD}>
              <p className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>{c.label}</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>{c.value.toLocaleString()}</p>
            </div>
          ))}
        </motion.div>
      )}

      {/* Filters */}
      <motion.div variants={cardVariants} className="rounded-2xl p-4" style={GLASS_CARD}>
        <button onClick={() => setShowFilters(!showFilters)} className="flex items-center gap-2 w-full text-left cursor-pointer">
          <Filter size={16} color="var(--color-text-secondary)" />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('검색 · 필터', '検索・フィルター')}</span>
          {showFilters ? <ChevronUp size={14} color="var(--color-text-secondary)" /> : <ChevronDown size={14} color="var(--color-text-secondary)" />}
        </button>

        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4"
          >
            {/* Search */}
            <div className="lg:col-span-3">
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>{t('작품명 검색 (JP/KR)', 'タイトル検索 (JP/KR)')}</label>
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-input-border)' }}>
                <Search size={14} color="var(--color-text-muted)" />
                <input
                  type="text"
                  value={q}
                  onChange={(e) => {
                    setPage(0);
                    setQ(e.target.value);
                  }}
                  placeholder={t('작품명...', 'タイトル名...')}
                  className="flex-1 bg-transparent outline-none text-sm"
                  style={{ color: 'var(--color-text-primary)' }}
                />
              </div>
            </div>

            {/* Status */}
            <FilterSelect label={t('상태', 'ステータス')} value={statusFilter} onChange={(value) => { setPage(0); setStatusFilter(value); }}
              options={[{ v: 'service', l: t('서비스', 'サービス') }, { v: 'prep', l: t('준비 작품', '準備作品') }]} allLabel={t('전체', 'すべて')} />
            {/* Genre */}
            <FilterSelect label={t('장르', 'ジャンル')} value={genreFilter} onChange={(value) => { setPage(0); setGenreFilter(value); }}
              options={genreOptions.map((g) => ({ v: g, l: g }))} allLabel={t('전체', 'すべて')} />
            {/* Format */}
            <FilterSelect label={t('형식', '形式')} value={formatFilter} onChange={(value) => { setPage(0); setFormatFilter(value); }}
              options={formatOptions.map((g) => ({ v: g, l: g }))} allLabel={t('전체', 'すべて')} />
            {/* Label */}
            <FilterSelect label={t('레이블', 'レーベル')} value={labelFilter} onChange={(value) => { setPage(0); setLabelFilter(value); }}
              options={labelOptions.map((g) => ({ v: g, l: g }))} allLabel={t('전체', 'すべて')} />
          </motion.div>
        )}
      </motion.div>

      {/* Summary */}
      <motion.div variants={cardVariants} className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        <span>{totalCount.toLocaleString()} {t('건', '件')}</span>
        <span>Page {page + 1} / {Math.max(totalPages, 1)}</span>
      </motion.div>

      {/* Table */}
      {loading ? (
        <div className="rounded-2xl p-6 animate-pulse" style={GLASS_CARD}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-4 py-3">
              <div className="h-4 flex-1 rounded skeleton-shimmer" />
              <div className="h-4 w-24 rounded skeleton-shimmer" />
              <div className="h-4 w-20 rounded skeleton-shimmer" />
            </div>
          ))}
        </div>
      ) : (
        <motion.div variants={cardVariants} className="rounded-2xl p-4 overflow-x-auto" style={GLASS_CARD}>
          <table className="w-full text-sm min-w-[860px] table-striped">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-table-border)' }}>
                {[
                  t('작품(JP)', 'タイトル(JP)'),
                  t('작품(KR)', 'タイトル(KR)'),
                  t('상태', 'ステータス'),
                  t('형식', '形式'),
                  t('장르', 'ジャンル'),
                  t('레이블', 'レーベル'),
                  t('제작사', '制作会社'),
                  '',
                ].map((h, i) => (
                  <th key={i} className="py-3 px-2 font-medium text-left" style={{ color: 'var(--color-text-secondary)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isOpen = expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      onClick={() => setExpandedId(isOpen ? null : row.id)}
                      className="hover:bg-[var(--color-glass)] cursor-pointer"
                      style={{ borderBottom: '1px solid var(--color-table-border-subtle)' }}
                    >
                      <td className="py-3 px-2" style={{ maxWidth: '240px' }}>
                        <p className="font-medium truncate" title={row.title_jp ?? ''} style={{ color: 'var(--color-text-primary)' }}>{row.title_jp ?? '-'}</p>
                      </td>
                      <td className="py-3 px-2" style={{ maxWidth: '200px' }}>
                        <p className="text-xs truncate" title={row.title_kr ?? ''} style={{ color: 'var(--color-text-muted)' }}>{row.title_kr ?? '-'}</p>
                      </td>
                      <td className="py-3 px-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{
                          background: row.status === 'service' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(251, 191, 36, 0.15)',
                          color: row.status === 'service' ? '#22c55e' : '#f59e0b',
                        }}>
                          {row.status === 'service' ? t('서비스', 'サービス') : t('준비', '準備')}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{row.format ?? '-'}</td>
                      <td className="py-3 px-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{row.genre ?? '-'}</td>
                      <td className="py-3 px-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{row.label ?? '-'}</td>
                      <td className="py-3 px-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>{row.production_company ?? '-'}</td>
                      <td className="py-3 px-2 text-center">
                        {isOpen ? <ChevronUp size={14} color="var(--color-text-muted)" /> : <ChevronDown size={14} color="var(--color-text-muted)" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: 'var(--color-glass)' }}>
                        <td colSpan={8} className="px-4 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-xs">
                            <DetailRow label={t('관리사항', '管理事項')} value={row.management_type} />
                            <DetailRow label={t('유통사', '流通会社')} value={row.distribution_company} />
                            <DetailRow label={t('작화', '作画')} value={joinReading(row.artist, row.artist_reading)} />
                            <DetailRow label={t('각색', '脚色')} value={joinReading(row.adaptation, row.adaptation_reading)} />
                            <DetailRow label={t('원작', '原作')} value={joinReading(row.original_author, row.original_author_reading)} />
                            <DetailRow label={t('연재요일', '連載曜日')} value={row.weekday} />
                            <DetailRow label={t('배포 범위', '配信/提供範囲')} value={row.distribution_scope} />
                            <DetailRow label={t('비독점 전환일', '非独占転換日')} value={row.non_exclusive_conversion_date} />
                            <DetailRow label={t('서비스 예정일', 'サービス予定日')} value={row.service_planned_date} />
                            <DetailRow label={t('출처', '出典')} value={`${row.source_sheet} · row ${row.source_row}`} />
                            <DetailRow label={t('저작권', 'コピーライト')} value={row.copyright} full />
                            <DetailRow label={t('작품 소개', '作品紹介')} value={row.synopsis} full />
                            <DetailRow label={t('비고', '備考')} value={row.notes} full />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          {rows.length === 0 && (
            <div className="flex flex-col items-center py-12 gap-2" style={{ color: 'var(--color-text-muted)' }}>
              <Layers size={28} />
              <p>{t('작품 데이터가 없습니다', '作品データがありません')}</p>
              <p className="text-xs">{t('npm run content-master:import 로 워크북을 가져오세요', 'npm run content-master:import でワークブックを取り込んでください')}</p>
            </div>
          )}
        </motion.div>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </motion.div>
  );
}

// ============================================================
// Small presentational helpers
// ============================================================

function FilterSelect({
  label, value, onChange, options, allLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
  allLabel: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-xl text-sm outline-none cursor-pointer"
        style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-input-border)', color: 'var(--color-text-primary)' }}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.v} value={o.v}>{o.l}</option>
        ))}
      </select>
    </div>
  );
}

function DetailRow({ label, value, full }: { label: string; value: string | null; full?: boolean }) {
  if (!value) return null;
  return (
    <div className={full ? 'md:col-span-2' : undefined}>
      <span className="font-semibold" style={{ color: 'var(--color-text-secondary)' }}>{label}: </span>
      <span style={{ color: 'var(--color-text-primary)', whiteSpace: full ? 'pre-wrap' : 'normal' }}>{value}</span>
    </div>
  );
}

function joinReading(name: string | null, reading: string | null): string | null {
  if (!name) return null;
  return reading ? `${name} (${reading})` : name;
}
