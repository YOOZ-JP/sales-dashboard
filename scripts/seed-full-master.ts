// ---------------------------------------------------------------------------
// seed-full-master.ts — Seed ALL data from Excel master to DB
// All sheets, all columns, platform availability
// Run: npx tsx scripts/seed-full-master.ts
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

config({ path: path.resolve(import.meta.dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing env vars'); process.exit(1); }
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

const EXCEL_PATH = '/Volumes/SSD_MacMini/CLINK_YANGIL_GoogleDrive/리버스 제팬/매출 분석 시스템/2026_3월 최신데이터/RIVERSE_統合コンテンツリスト.xlsx';

const SHEET_CATEGORY: Record<string, string> = {
  '日本(タテヨミ)': 'active_tateyomi',
  '日本(版面)': 'active_hanmen',
  '日本(タテヨミ)準備作品': 'prep_tateyomi',
  '日本(版面)準備作品': 'prep_hanmen',
};

const PLATFORM_COL_MAP: Record<number, string> = {
  35: 'line_manga', 36: 'ebookjapan', 37: 'piccoma', 38: 'comico',
  39: 'mechacomic', 40: 'cmoa', 41: 'lezhin', 42: 'belltoon',
  43: 'renta', 44: 'dmm', 45: 'mangabang', 46: 'booklive',
  47: 'bukkomu', 48: 'manga_oukoku', 49: 'u_next', 50: 'mbj',
  51: 'animate', 53: 'mediado', 54: 'kinoppy', 55: 'reader_store',
  56: 'au_bookpass', 57: 'fod',
};

// --- Helpers ---
function parseDate(val: unknown): string | null {
  if (!val || val === '-' || val === '' || val === 'ー') return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (typeof val === 'number' && val > 10000) {
    const d = new Date((val - 25569) * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return null;
}

function parseNum(val: unknown): number | null {
  if (!val || val === '-' || val === '' || val === 'ー') return null;
  const n = Number(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

function normalizeFormat(val: unknown): string {
  if (!val) return 'WEBTOON';
  const s = String(val).toUpperCase().trim();
  if (s.includes('WEBTOON') || s.includes('ウェブ')) return 'WEBTOON';
  if (s.includes('PAGE') || s.includes('版面') || s.includes('ページ')) return 'PAGETOON';
  if (s.includes('NOVEL') || s.includes('小説') || s.includes('ノベル')) return 'NOVEL';
  return 'WEBTOON';
}

function normalizeStatus(val: unknown): string | null {
  if (!val || val === '-') return null;
  const s = String(val).trim();
  if (s.includes('連載中')) return '連載中';
  if (s.includes('完結')) return '完結';
  if (s.includes('休載')) return '休載中';
  if (s.includes('未連載') || s.includes('未配信')) return '未連載';
  return s;
}

// --- Main ---
async function main() {
  console.log('Reading Excel:', EXCEL_PATH);
  if (!fs.existsSync(EXCEL_PATH)) { console.error('File not found'); process.exit(1); }
  const wb = XLSX.readFile(EXCEL_PATH);

  // Step 1: Parse all sheets
  interface TitleRow {
    title_jp: string; title_kr: string | null; management_type: string | null;
    company: string | null; distribution_company: string | null; content_format: string;
    illustrator: string | null; illustrator_yomi: string | null;
    screenwriter: string | null; screenwriter_yomi: string | null;
    original_author: string | null; original_author_yomi: string | null;
    genre_jp: string | null; label_name: string | null;
    serial_day_of_week: string | null; copyright_text: string | null; synopsis: string | null;
    distribution_scope: string | null; exclusive_conv_date: string | null;
    nonexclusive_conv_date: string | null; latest_episode_count: number | null;
    serial_status: string | null; return_schedule_date: string | null;
    always_free_chapters: number; fixed_paid_chapters: number | null;
    rental_price_incl: number | null; purchase_price_excl: number | null;
    purchase_price_incl: number | null; contract_start_date: string | null;
    contract_end_date: string | null; service_launch_date: string | null;
    completion_date: string | null; sheet_category: string;
    platforms: Array<{ code: string; launch_date: string | null }>;
  }

  const allTitles: TitleRow[] = [];

  for (const sheetName of Object.keys(SHEET_CATEGORY)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) { console.log(`Sheet "${sheetName}" not found, skip`); continue; }
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
    const category = SHEET_CATEGORY[sheetName];
    let count = 0;

    // 헤더에서 컬럼 위치 자동 감지
    const headerRow = data[1] as unknown[] | undefined;
    const colIdx: Record<string, number> = {};
    if (headerRow) {
      for (let c = 0; c < headerRow.length; c++) {
        const h = String(headerRow[c] || '').replace(/\n/g, ' ').trim();
        if (h.includes('作品名(JP)') || h.includes('JPタイトル(仮)') || (h.includes('作品名') && !h.includes('KR'))) colIdx.title_jp = c;
        if (h.includes('作品名(KR)') || h === '作品名(KR)') colIdx.title_kr = c;
        if (h === '管理事項') colIdx.management = c;
        if (h === '制作会社' && !colIdx.company) colIdx.company = c;
        if (h === '流通会社') colIdx.distribution = c;
        if (h === '形式') colIdx.format = c;
        if (h === '作画' && !colIdx.illustrator) colIdx.illustrator = c;
        if (h.includes('作画') && h.includes('ヨミ')) colIdx.illustrator_yomi = c;
        if (h === '脚色' && !colIdx.screenwriter) colIdx.screenwriter = c;
        if (h.includes('脚色') && h.includes('ヨミ')) colIdx.screenwriter_yomi = c;
        if (h === '原作' && !colIdx.original_author) colIdx.original_author = c;
        if (h.includes('原作') && h.includes('ヨミ')) colIdx.original_author_yomi = c;
        if (h === 'ジャンル') colIdx.genre = c;
        if (h === 'レーベル') colIdx.label = c;
        if (h.includes('連載') && h.includes('曜日')) colIdx.serial_day = c;
        if (h.includes('コピーライト')) colIdx.copyright = c;
        if (h.includes('作品紹介')) colIdx.synopsis = c;
        if (h.includes('配信範囲') || h.includes('提供範囲')) colIdx.distribution_scope = c;
        if (h.includes('連載状況')) colIdx.serial_status = c;
        if (h.includes('最新話') || h === '話数') colIdx.episode_count = c;
      }
    }
    const g = (col: string) => colIdx[col] ?? -1;
    const getVal = (row: unknown[], col: string): string | null => {
      const idx = g(col);
      if (idx < 0 || !row[idx]) return null;
      return String(row[idx]).trim() || null;
    };
    console.log(`  ${sheetName}: title_jp=Col${g('title_jp')}, genre=Col${g('genre')}, company=Col${g('company')}`);

    for (let i = 2; i < data.length; i++) {
      const row = data[i];
      const titleCol = g('title_jp');
      if (!row || titleCol < 0 || !row[titleCol]) continue;
      const title_jp = String(row[titleCol]).trim();
      if (!title_jp || title_jp === '作品名(JP)' || title_jp === 'JPタイトル(仮)') continue;

      const platforms: Array<{ code: string; launch_date: string | null }> = [];
      for (const [colStr, code] of Object.entries(PLATFORM_COL_MAP)) {
        const col = parseInt(colStr);
        const d = parseDate(row[col]);
        if (d) platforms.push({ code, launch_date: d });
      }

      allTitles.push({
        title_jp,
        title_kr: getVal(row, 'title_kr'),
        management_type: getVal(row, 'management'),
        company: getVal(row, 'company'),
        distribution_company: getVal(row, 'distribution'),
        content_format: normalizeFormat(row[g('format')] ?? null),
        illustrator: getVal(row, 'illustrator'),
        illustrator_yomi: getVal(row, 'illustrator_yomi'),
        screenwriter: getVal(row, 'screenwriter'),
        screenwriter_yomi: getVal(row, 'screenwriter_yomi'),
        original_author: getVal(row, 'original_author'),
        original_author_yomi: getVal(row, 'original_author_yomi'),
        genre_jp: getVal(row, 'genre'),
        label_name: getVal(row, 'label'),
        serial_day_of_week: getVal(row, 'serial_day'),
        copyright_text: getVal(row, 'copyright'),
        synopsis: getVal(row, 'synopsis'),
        distribution_scope: getVal(row, 'distribution_scope'),
        exclusive_conv_date: null,
        nonexclusive_conv_date: null,
        latest_episode_count: g('episode_count') >= 0 ? parseNum(row[g('episode_count')]) as number | null : null,
        serial_status: g('serial_status') >= 0 ? normalizeStatus(row[g('serial_status')]) : null,
        return_schedule_date: null,
        always_free_chapters: 0,
        fixed_paid_chapters: null,
        rental_price_incl: null,
        purchase_price_excl: parseNum(row[29]),
        purchase_price_incl: parseNum(row[30]),
        contract_start_date: parseDate(row[31]),
        contract_end_date: parseDate(row[32]),
        service_launch_date: parseDate(row[33]),
        completion_date: parseDate(row[34]),
        sheet_category: category,
        platforms,
      });
      count++;
    }
    console.log(`  ${sheetName}: ${count} titles`);
  }
  console.log(`Total: ${allTitles.length} titles\n`);

  // Step 2: Upsert production_companies
  const companies = [...new Set(allTitles.map(t => t.company).filter(Boolean))] as string[];
  console.log(`--- Upserting ${companies.length} companies ---`);
  for (const name of companies) {
    await supabase.from('production_companies').upsert({ name }, { onConflict: 'name' });
  }
  const { data: compData } = await supabase.from('production_companies').select('id, name');
  const companyMap = new Map((compData ?? []).map(c => [c.name, c.id]));

  // Step 3: Upsert genres
  const genres = [...new Set(allTitles.map(t => t.genre_jp).filter(Boolean))] as string[];
  console.log(`--- Upserting ${genres.length} genres ---`);
  const { data: genreData } = await supabase.from('genres').select('id, name_jp, code');
  const genreMap = new Map((genreData ?? []).map(g => [g.name_jp, g.id]));
  for (const name of genres) {
    if (!genreMap.has(name)) {
      const code = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      const { data: ins } = await supabase.from('genres').insert({ code, name_jp: name, name_kr: name }).select('id').single();
      if (ins) genreMap.set(name, ins.id);
      else console.log(`  Genre "${name}" insert failed, trying direct...`);
    }
  }

  // Step 4: Upsert labels
  const labels = [...new Set(allTitles.map(t => t.label_name).filter(Boolean))] as string[];
  console.log(`--- Upserting ${labels.length} labels ---`);
  for (const name of labels) {
    await supabase.from('labels').upsert({ name }, { onConflict: 'name' });
  }
  const { data: labelData } = await supabase.from('labels').select('id, name');
  const labelMap = new Map((labelData ?? []).map(l => [l.name, l.id]));

  // Step 5: Upsert platforms
  const { data: platformData } = await supabase.from('platforms').select('id, code');
  const platformMap = new Map((platformData ?? []).map(p => [p.code, p.id]));

  // Step 6: Upsert titles
  console.log(`\n--- Upserting ${allTitles.length} titles ---`);
  let updated = 0, inserted = 0, failed = 0;

  for (const t of allTitles) {
    const titleData: Record<string, unknown> = {
      title_jp: t.title_jp,
      title_kr: t.title_kr,
      management_type: t.management_type,
      distribution_company: t.distribution_company,
      content_format: t.content_format,
      illustrator: t.illustrator,
      illustrator_yomi: t.illustrator_yomi,
      screenwriter: t.screenwriter,
      screenwriter_yomi: t.screenwriter_yomi,
      original_author: t.original_author,
      original_author_yomi: t.original_author_yomi,
      serial_day_of_week: t.serial_day_of_week,
      copyright_text: t.copyright_text,
      synopsis: t.synopsis,
      distribution_scope: t.distribution_scope,
      exclusive_conv_date: t.exclusive_conv_date,
      nonexclusive_conv_date: t.nonexclusive_conv_date,
      latest_episode_count: t.latest_episode_count,
      serial_status: t.serial_status,
      return_schedule_date: t.return_schedule_date,
      always_free_chapters: t.always_free_chapters,
      fixed_paid_chapters: t.fixed_paid_chapters,
      rental_price_incl: t.rental_price_incl,
      purchase_price_excl: t.purchase_price_excl,
      purchase_price_incl: t.purchase_price_incl,
      contract_start_date: t.contract_start_date,
      contract_end_date: t.contract_end_date,
      service_launch_date: t.service_launch_date,
      completion_date: t.completion_date,
      sheet_category: t.sheet_category,
      is_active: true,
    };

    if (t.company && companyMap.has(t.company)) titleData.production_company_id = companyMap.get(t.company);
    if (t.genre_jp && genreMap.has(t.genre_jp)) titleData.genre_id = genreMap.get(t.genre_jp);
    if (t.label_name && labelMap.has(t.label_name)) titleData.label_id = labelMap.get(t.label_name);

    // Check if exists
    const { data: existing } = await supabase
      .from('titles')
      .select('id')
      .eq('title_jp', t.title_jp)
      .limit(1);

    let titleId: string | null = null;

    if (existing && existing.length > 0) {
      titleId = existing[0].id;
      const { error } = await supabase.from('titles').update(titleData).eq('id', titleId);
      if (error) { failed++; console.error(`  UPDATE fail "${t.title_jp}": ${error.message}`); }
      else updated++;
    } else {
      const { data: ins, error } = await supabase.from('titles').insert(titleData).select('id').single();
      if (error) { failed++; console.error(`  INSERT fail "${t.title_jp}": ${error.message}`); }
      else { inserted++; titleId = ins?.id ?? null; }
    }

    // Step 7: Platform availability
    if (titleId && t.platforms.length > 0) {
      for (const p of t.platforms) {
        const platformId = platformMap.get(p.code);
        if (!platformId) continue;
        await supabase.from('title_platform_availability').upsert(
          { title_id: titleId, platform_id: platformId, launch_date: p.launch_date, is_available: true },
          { onConflict: 'title_id,platform_id' }
        );
      }
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Inserted: ${inserted}`);
  console.log(`Failed: ${failed}`);

  // Verify
  const { count: totalTitles } = await supabase.from('titles').select('*', { count: 'exact', head: true });
  const { count: withGenre } = await supabase.from('titles').select('*', { count: 'exact', head: true }).not('genre_id', 'is', null);
  const { count: withCompany } = await supabase.from('titles').select('*', { count: 'exact', head: true }).not('production_company_id', 'is', null);
  const { count: withLabel } = await supabase.from('titles').select('*', { count: 'exact', head: true }).not('label_id', 'is', null);
  const { count: tpa } = await supabase.from('title_platform_availability').select('*', { count: 'exact', head: true });

  console.log(`\n=== Verification ===`);
  console.log(`Total titles: ${totalTitles}`);
  console.log(`With genre: ${withGenre}`);
  console.log(`With company: ${withCompany}`);
  console.log(`With label: ${withLabel}`);
  console.log(`Platform availability: ${tpa}`);
}

main().catch(console.error);
