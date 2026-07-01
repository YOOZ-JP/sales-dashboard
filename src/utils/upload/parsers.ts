import ExcelJS from 'exceljs';
import type { ParsedRow } from './types';

// ============================================================
// Parsers
// ============================================================

export function parseCSVText(text: string, delimiter?: string): string[][] {
  const lines: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];
  const delim = delimiter ?? null; // null = auto-detect (comma or tab)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === (delim ?? ',') || (!delim && ch === '\t')) {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(current.trim());
        if (row.some((c) => c !== '')) lines.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current || row.length > 0) {
    row.push(current.trim());
    if (row.some((c) => c !== '')) lines.push(row);
  }
  return lines;
}

export function parseTSVText(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split('\t').map((c) => c.trim()))
    .filter((row) => row.some((c) => c !== ''));
}

export function parseDateString(raw: string): string {
  const cleaned = raw.replace(/\//g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(cleaned)) {
    const parts = cleaned.split('-');
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }
  return '';
}

export function parseCSVWeeklyReport(text: string): ParsedRow[] {
  const lines = parseCSVText(text);
  if (lines.length < 2) return [];

  // 헤더 행 찾기 + 컬럼 인덱스 동적 매핑
  let headerIdx = 0;
  const col: Record<string, number> = { titleJP: 0, titleKR: 1, channelTitleJP: 2, channel: 3, date: 4, amount: 5 };

  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const hasKeyword = lines[i].some((c) => c.includes('Title') || c.includes('Channel') || c.includes('Date') || c.includes('Sales'));
    if (hasKeyword) {
      headerIdx = i;
      // 컬럼 매핑: Channel 관련을 먼저 체크
      lines[i].forEach((c, idx) => {
        const lower = c.toLowerCase().trim();
        if (lower.includes('channel') && lower.includes('title')) col.channelTitleJP = idx;
        else if (lower.includes('channel')) col.channel = idx;
        else if (lower === 'title(jp)' || (lower.includes('title') && lower.includes('jp'))) col.titleJP = idx;
        else if (lower === 'title(kr)' || (lower.includes('title') && lower.includes('kr'))) col.titleKR = idx;
        else if (lower.includes('date') || lower.includes('날짜')) col.date = idx;
        else if (lower.includes('sales') || lower.includes('amount') || lower.includes('매출')) col.amount = idx;
      });
      break;
    }
  }

  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const vals = lines[i];
    const titleJP = (vals[col.titleJP] ?? '').trim();
    const titleKR = (vals[col.titleKR] ?? '').trim();
    const channelTitleJP = (vals[col.channelTitleJP] ?? '').trim();
    const channel = (vals[col.channel] ?? '').trim();
    const rawDate = (vals[col.date] ?? '').trim();
    const rawAmount = (vals[col.amount] ?? '').trim();
    if (!titleJP || !channel) continue;
    const saleDate = parseDateString(rawDate);
    const salesAmount = parseInt(rawAmount.replace(/[¥,]/g, ''), 10) || 0;
    if (saleDate && salesAmount > 0) {
      rows.push({ title_jp: titleJP, title_kr: titleKR, channel_title_jp: channelTitleJP, channel, sale_date: saleDate, sales_amount: salesAmount });
    }
  }
  return rows;
}

/**
 * Piccoma 속보치 CSV parser (Shift-JIS decoded externally)
 * Header: 日付,取次店書籍ID,ブックID,ブック名,チャプタID/巻ID,チャプタ名/巻名,話数番号/巻番号,著者名,出版社名,価格,購入件数,購入ポイント数
 * Aggregate by (ブック名, 日付) summing 購入ポイント数
 */
export function parseCSVSokuhochi(text: string, channel: string, divideByTax = false, isKan = false): ParsedRow[] {
  const lines = parseCSVText(text);
  if (lines.length < 2) return [];

  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].some((c) => c.includes('日付') || c.includes('ブック名') || c.includes('購入ポイント数'))) {
      headerIdx = i;
      break;
    }
  }

  const salesMap = new Map<string, Map<string, number>>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i];
    const rawDate = (cols[0] ?? '').trim();
    let titleJP = (cols[3] ?? '').trim();
    const rawAmount = (cols[11] ?? '').trim();

    // kan(権별/판면) 파일이면 작품명에 (巻) 접미어 추가
    if (isKan && titleJP && !titleJP.includes('(巻)')) {
      titleJP = `${titleJP}(巻)`;
    }

    if (!rawDate || !titleJP) continue;

    const saleDate = parseDateString(rawDate);
    const rawVal = parseInt(rawAmount.replace(/[¥,]/g, ''), 10) || 0;

    if (!saleDate || rawVal <= 0) continue;

    if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
    const dateMap = salesMap.get(titleJP)!;
    dateMap.set(saleDate, (dateMap.get(saleDate) || 0) + rawVal);
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, grossAmount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel,
        sale_date: date,
        sales_amount: divideByTax ? Math.round(grossAmount / 1.1) : grossAmount,
        sales_amount_gross: divideByTax ? grossAmount : undefined,
      });
    }
  }

  return rows;
}

/**
 * cmoa 속보치 TSV parser
 * Columns (0-indexed):
 *   0: コンテンツID, 1: タイトルID, 2: 作者名, 3: タイトル名,
 *   4: 話巻区分, 5: メニュー区分, 6: 話巻数, 7: 単価, 8: 件数,
 *   9: 消費PT, 10: 料率, 11: 支払額, 12: 雑誌名, 13: 備考,
 *   14: 単品パック, 15: パックID, 16: 書籍タイプ, 17: ISBNコード,
 *   18: JDCNコード, 19: その他, 20: 販売年月, 21: コンテンツ販売開始日
 */
export function parseCmoaSokuhochi(text: string): ParsedRow[] {
  const lines = parseTSVText(text);
  if (lines.length < 2) return [];

  // Find header row
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].some((c) => c === 'コンテンツID' || c === 'タイトル名' || c === '消費PT')) {
      headerIdx = i;
      break;
    }
  }

  // Aggregate by (titleJP, saleMonth)
  const salesMap = new Map<string, Map<string, number>>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i];
    if (cols.length < 21) continue;

    const titleJP = (cols[3] ?? '').trim();
    const rawConsumePT = (cols[9] ?? '').trim();
    const rawPayment = (cols[11] ?? '').trim();
    const rawSaleMonth = (cols[20] ?? '').trim(); // YYYYMM

    if (!titleJP || !rawSaleMonth) continue;

    // Convert YYYYMM → YYYY-MM-01
    const saleDate = rawSaleMonth.length === 6
      ? `${rawSaleMonth.slice(0, 4)}-${rawSaleMonth.slice(4, 6)}-01`
      : '';
    if (!saleDate) continue;

    // Determine amount: prefer 消費PT, fallback to 支払額
    const parseCurrencyVal = (v: string) => {
      if (!v || v === '-' || v === '－') return 0;
      return parseInt(v.replace(/[¥,，]/g, ''), 10) || 0;
    };

    let amount = parseCurrencyVal(rawConsumePT);
    if (amount <= 0) amount = parseCurrencyVal(rawPayment);
    if (amount <= 0) continue;

    if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
    const dateMap = salesMap.get(titleJP)!;
    dateMap.set(saleDate, (dateMap.get(saleDate) || 0) + amount);
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, amount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel: 'cmoa',
        sale_date: date,
        sales_amount: amount,
      });
    }
  }

  return rows;
}

/**
 * Piccoma Product KPI CSV parser
 * Header: id, 作品名, 出版社, カテゴリ, APP販売タイプ, WEB販売タイプ, 販売話数, 販売巻数, MM-DD RU, MM-DD FRU, MM-DD Total売上, ...
 * 날짜별/월별 Total売上 컬럼에서 매출 추출
 */
export function parsePiccomaKPI(text: string, channel: string, fileName?: string): ParsedRow[] {
  // BOM 제거
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = parseCSVText(cleaned);
  if (lines.length < 2) return [];

  // 헤더에서 "MM-DD Total売上" 패턴 컬럼 찾기
  const header = lines[0];
  const dailySalesColumns: Array<{ idx: number; date: string }> = [];
  const monthlySalesColumns: Array<{ idx: number; month: string }> = [];

  // 파일명에서 연도 추출 (YYYYMMDD 패턴)
  const fnYearMatch = (fileName ?? '').match(/(\d{4})\d{4}/);
  const year = fnYearMatch ? fnYearMatch[1] : new Date().getFullYear().toString();

  header.forEach((col, idx) => {
    const stripped = col.replace(/"/g, '');
    // "03-23 Total売上" 패턴 (일별)
    const dailyMatch = stripped.match(/^(\d{2})-(\d{2})\s+Total売上$/);
    if (dailyMatch) {
      const saleDate = `${year}-${dailyMatch[1]}-${dailyMatch[2]}`;
      dailySalesColumns.push({ idx, date: saleDate });
      return;
    }
    // "03月 Total売上" 패턴 (월별) — 일별이 없을 때 폴백
    const monthlyMatch = stripped.match(/^(\d{2})月\s+Total売上$/);
    if (monthlyMatch) {
      monthlySalesColumns.push({ idx, month: `${year}-${monthlyMatch[1]}-01` });
    }
  });

  // 일별 데이터가 있으면 일별 사용, 없으면 월별 사용
  const targetColumns = dailySalesColumns.length > 0 ? dailySalesColumns : monthlySalesColumns.map(c => ({ idx: c.idx, date: c.month }));

  if (targetColumns.length === 0) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i];
    const titleJP = (vals[1] ?? '').replace(/"/g, '').trim();
    if (!titleJP) continue;

    for (const col of targetColumns) {
      const rawAmount = (vals[col.idx] ?? '').replace(/"/g, '').trim();
      const grossAmount = parseInt(rawAmount.replace(/[¥,]/g, ''), 10) || 0;
      // 세전 → 세후 변환 (÷1.1)
      const netAmount = Math.round(grossAmount / 1.1);
      if (netAmount > 0) {
        rows.push({
          title_jp: titleJP,
          title_kr: '',
          channel_title_jp: titleJP,
          channel,
          sale_date: col.date,
          sales_amount: netAmount,
          sales_amount_gross: grossAmount,
        });
      }
    }
  }

  return rows;
}

/**
 * cmoa Excel parser (시모아 xlsx)
 * Sheet "Q003_売上": 헤더 타イトル名(col4), 1日~31日(col10~40) = 일별 매출
 * 파일명 또는 시트명에서 월 추출
 */
export async function parseCmoaExcel(buffer: ArrayBuffer, fileName: string): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // Q003_売上 시트 찾기
  const salesSheet = wb.worksheets.find(ws => ws.name.includes('売上')) ?? wb.worksheets[0];
  if (!salesSheet) return [];

  // 파일명에서 연월 추출 (202603 → 2026-03)
  const monthMatch = fileName.match(/(\d{4})(\d{2})/);
  let yearMonth = monthMatch ? `${monthMatch[1]}-${monthMatch[2]}` : '';

  // 파일명에서 못 찾으면 시트명에서 시도 (예: "2026年03月")
  if (!yearMonth) {
    for (const ws of wb.worksheets) {
      const m = ws.name.match(/(\d{4}).*?(\d{2})/);
      if (m) { yearMonth = `${m[1]}-${m[2]}`; break; }
    }
  }
  // 그래도 없으면 현재 월 사용
  if (!yearMonth) {
    const now = new Date();
    yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // 헤더 확인 — タイトル名 위치 찾기
  let titleColIdx = 4; // 기본값 (0-indexed: col E = index 4 in 1-based = vals[5])
  let dayStartIdx = 10; // 1日 컬럼 시작 (1-based: col K = vals[11])

  const headerRow = salesSheet.getRow(1);
  const headerVals = headerRow.values as (string | null | undefined)[];
  headerVals.forEach((v, idx) => {
    if (typeof v === 'string' && v === 'タイトル名') titleColIdx = idx;
    if (typeof v === 'string' && v === '1日') dayStartIdx = idx;
  });

  // 작품별 일별 매출 집계
  const salesMap = new Map<string, Map<string, number>>();

  salesSheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    const vals = row.values as (string | number | null | undefined)[];
    const titleJP = String(vals[titleColIdx] ?? '').trim();
    if (!titleJP) return;

    // 1日~31日 컬럼 순회
    for (let day = 0; day < 31; day++) {
      const colIdx = dayStartIdx + day;
      const rawVal = vals[colIdx];
      const amount = typeof rawVal === 'number' ? rawVal : parseInt(String(rawVal ?? '0'), 10) || 0;
      if (amount <= 0) continue;

      const dayStr = String(day + 1).padStart(2, '0');
      const saleDate = `${yearMonth}-${dayStr}`;

      if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
      const dateMap = salesMap.get(titleJP)!;
      dateMap.set(saleDate, (dateMap.get(saleDate) || 0) + amount);
    }
  });

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, amount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel: 'cmoa',
        sale_date: date,
        sales_amount: amount,
      });
    }
  }

  return rows;
}

// ============================================================
// Excel Parsers
// ============================================================

export async function parseWeeklyReport(buffer: ArrayBuffer): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const dailySheet =
    wb.worksheets.find((ws) => ws.name.toLowerCase().includes('daily_raw') || ws.name.toLowerCase().includes('daily')) ??
    wb.worksheets[0];
  if (!dailySheet) return [];

  const rows: ParsedRow[] = [];

  // 헤더 행 찾기 + 컬럼 인덱스 동적 매핑
  let headerRowNum = -1;
  const colMap: Record<string, number> = {};

  dailySheet.eachRow((row, rowNumber) => {
    if (headerRowNum > 0) return;
    const vals = row.values as (string | null | undefined)[];
    // 헤더 행: Title, Channel, Date 등 키워드 포함
    const hasKeyword = vals.some((v) => typeof v === 'string' && (
      v.includes('Title') || v.includes('Channel') || v.includes('Date') || v.includes('Sales')
    ));
    if (hasKeyword) {
      headerRowNum = rowNumber;
      // 컬럼 매핑: Channel 관련을 먼저 체크 (Channel Title(JP)가 Title(JP)로 잘못 매핑되는 것 방지)
      vals.forEach((v, idx) => {
        if (typeof v !== 'string') return;
        const lower = v.toLowerCase().trim();
        // 1. Channel 관련 우선
        if (lower.includes('channel') && lower.includes('title')) colMap.channelTitleJP = idx;
        else if (lower.includes('channel')) colMap.channel = idx;
        // 2. Title(JP) / Title(KR)
        else if (lower === 'title(jp)' || lower === 'title_jp' || (lower.includes('title') && lower.includes('jp'))) colMap.titleJP = idx;
        else if (lower === 'title(kr)' || lower === 'title_kr' || (lower.includes('title') && lower.includes('kr'))) colMap.titleKR = idx;
        // 3. Date
        else if (lower.includes('date') || lower.includes('날짜') || lower.includes('日付')) colMap.date = idx;
        // 4. Sales
        else if (lower.includes('sales') || lower.includes('매출') || lower.includes('売上') || lower.includes('amount')) colMap.amount = idx;
      });
    }
  });

  // 폴백: 헤더 못 찾으면 기본 순서 (A=1:JP, B=2:KR, C=3:ChTitleJP, D=4:Channel, E=5:Date, F=6:Amount)
  if (headerRowNum < 0) headerRowNum = 2;
  if (!colMap.titleJP) colMap.titleJP = 1;
  if (!colMap.titleKR) colMap.titleKR = 2;
  if (!colMap.channelTitleJP) colMap.channelTitleJP = 3;
  if (!colMap.channel) colMap.channel = 4;
  if (!colMap.date) colMap.date = 5;
  if (!colMap.amount) colMap.amount = 6;

  // ExcelJS 셀 값 정규화: 수식/리치텍스트/에러/하이퍼링크 셀을 원시값으로 풀어냄
  const cellValue = (v: unknown): unknown => {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    if ('result' in obj) return cellValue(obj.result);
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((seg) => seg.text ?? '').join('');
    }
    if ('error' in obj) return '';
    if ('text' in obj && typeof obj.text === 'string') return obj.text;
    return v;
  };

  dailySheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNum) return;
    const rawVals = row.values as unknown[];
    const vals = rawVals.map(cellValue) as (string | number | Date | null | undefined)[];
    const titleJP = String(vals[colMap.titleJP] ?? '').trim();
    const titleKR = String(vals[colMap.titleKR] ?? '').trim();
    const channelTitleJP = String(vals[colMap.channelTitleJP] ?? '').trim();
    const channel = String(vals[colMap.channel] ?? '').trim();
    const rawDate = vals[colMap.date];
    const rawAmount = vals[colMap.amount];
    if (!titleJP || !channel) return;
    let saleDate = '';
    if (rawDate instanceof Date) {
      saleDate = rawDate.toISOString().slice(0, 10);
    } else if (typeof rawDate === 'string') {
      saleDate = parseDateString(rawDate);
    } else if (typeof rawDate === 'number') {
      const excelEpoch = new Date(1899, 11, 30);
      const d = new Date(excelEpoch.getTime() + rawDate * 86400000);
      saleDate = d.toISOString().slice(0, 10);
    }
    const salesAmount =
      typeof rawAmount === 'number'
        ? Math.round(rawAmount)
        : parseInt(String(rawAmount ?? '0').replace(/[¥,\\\\]/g, ''), 10) || 0;
    if (saleDate && salesAmount > 0) {
      rows.push({ title_jp: titleJP, title_kr: titleKR, channel_title_jp: channelTitleJP, channel, sale_date: saleDate, sales_amount: salesAmount });
    }
  });
  return rows;
}

/**
 * 누계 매출 메타데이터 Excel 파서
 * 시트: 누계매출메타데이터(2020~)
 * 헤더: 5행, 데이터: 6행부터
 * 컬럼: 1=채널작품명JP, 2=작품명KR, 3=작품명JP, 9=판매월(Date), 15=채널, 23=세후거래액JPY
 */
export async function parseRuikeiMetadata(buffer: ArrayBuffer): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // "누계매출메타데이터" 또는 가장 큰 시트 찾기
  const sheet = wb.worksheets.find((ws) => ws.name.includes('누계') || ws.name.includes('메타데이터')) ?? wb.worksheets[0];
  if (!sheet) return [];

  const rows: ParsedRow[] = [];
  // ExcelJS 셀 값 정규화: 수식/리치텍스트/에러 셀을 원시값으로 풀어냄
  const cellResult = (v: unknown): unknown => {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    // 수식 셀: { formula, result }
    if ('result' in obj) return cellResult(obj.result);
    // 리치 텍스트 셀: { richText: [{text, font?}, ...] }
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>).map((seg) => seg.text ?? '').join('');
    }
    // 에러 셀: { error: '#N/A' }
    if ('error' in obj) return '';
    // 하이퍼링크 셀: { text, hyperlink }
    if ('text' in obj && typeof obj.text === 'string') return obj.text;
    return v;
  };

  // 헤더 행 찾기 (5행 근처에서 '판매월' 또는 'Title(JP)' 찾기)
  let headerRow = 5;
  for (let r = 1; r <= 10; r++) {
    const cell = sheet.getCell(r, 9);
    const v = cellResult(cell.value);
    if (typeof v === 'string' && (v.includes('판매월') || v.includes('Month'))) {
      headerRow = r;
      break;
    }
  }

  // 데이터 행: 헤더 + 1부터 끝까지
  const lastRow = sheet.rowCount;
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const titleJpCell = cellResult(sheet.getCell(r, 3).value);
    const titleKrCell = cellResult(sheet.getCell(r, 2).value);
    const monthCell = cellResult(sheet.getCell(r, 9).value);
    const channelCell = cellResult(sheet.getCell(r, 15).value);
    const amountCell = cellResult(sheet.getCell(r, 23).value);

    const titleJp = String(titleJpCell ?? '').trim();
    const titleKr = String(titleKrCell ?? '').trim();
    const channel = String(channelCell ?? '').trim();

    if (!titleJp || !channel) continue;

    // 판매월 → YYYY-MM-01
    let saleDate = '';
    if (monthCell instanceof Date) {
      saleDate = monthCell.toISOString().slice(0, 7) + '-01';
    } else if (typeof monthCell === 'string' && /^\d{4}-\d{2}/.test(monthCell)) {
      saleDate = monthCell.slice(0, 7) + '-01';
    } else if (typeof monthCell === 'number' && monthCell > 40000) {
      const epoch = new Date(1899, 11, 30);
      const d = new Date(epoch.getTime() + monthCell * 86400000);
      saleDate = d.toISOString().slice(0, 7) + '-01';
    }
    if (!saleDate) continue;

    // 매출: 세후거래액(JPY) — 컬럼 23
    const amount = typeof amountCell === 'number' ? Math.round(amountCell) : parseInt(String(amountCell ?? '0').replace(/[¥,]/g, ''), 10) || 0;
    if (amount <= 0) continue;

    rows.push({
      title_jp: titleJp,
      title_kr: titleKr,
      channel_title_jp: titleJp,
      channel,
      sale_date: saleDate,
      sales_amount: amount,
    });
  }

  return rows;
}

export async function parseSokuhochiExcel(buffer: ArrayBuffer): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows: ParsedRow[] = [];
  let headerRow = -1;
  sheet.eachRow((row, rowNumber) => {
    if (headerRow > 0) return;
    const vals = row.values as (string | null | undefined)[];
    if (vals.some((v) => typeof v === 'string' && (v.includes('作品') || v.includes('タイトル') || v.includes('売上')))) {
      headerRow = rowNumber;
    }
  });
  if (headerRow < 0) headerRow = 1;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const vals = row.values as (string | number | Date | null | undefined)[];
    const titleJP = String(vals[1] ?? '').trim();
    const channel = String(vals[2] ?? '').trim();
    const rawDate = vals[3];
    const rawAmount = vals[4];
    if (!titleJP) return;
    let saleDate = '';
    if (rawDate instanceof Date) {
      saleDate = rawDate.toISOString().slice(0, 10);
    } else if (typeof rawDate === 'string') {
      saleDate = parseDateString(rawDate);
    } else if (typeof rawDate === 'number') {
      const excelEpoch = new Date(1899, 11, 30);
      const d = new Date(excelEpoch.getTime() + rawDate * 86400000);
      saleDate = d.toISOString().slice(0, 10);
    }
    const salesAmount =
      typeof rawAmount === 'number'
        ? rawAmount
        : parseInt(String(rawAmount ?? '0').replace(/[¥,]/g, ''), 10) || 0;
    if (saleDate && salesAmount > 0) {
      rows.push({ title_jp: titleJP, title_kr: '', channel_title_jp: '', channel, sale_date: saleDate, sales_amount: salesAmount });
    }
  });
  return rows;
}

// ============================================================
// Renta 속보치 parser
// 월간 파일 + 일별 컬럼 (cmoa 구조와 유사)
// 헤더: 参照ID, 商品名, 著者名, 版元名, 販売開始日, 貸出期間, 価格, 売上件数, 売上金額,
//       2026/04/01, 2026/04/02, ... (일별 판매 건수)
// 일별 셀 = 판매 건수 → 금액 = 건수 × 価格
// ============================================================
export function parseRentaSokuhochi(text: string): ParsedRow[] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = parseCSVText(cleaned, ',');
  if (lines.length < 2) return [];

  const header = lines[0];
  const titleIdx = header.findIndex((h) => h === '商品名');
  const priceIdx = header.findIndex((h) => h === '価格');
  if (titleIdx < 0 || priceIdx < 0) return [];

  // 일별 컬럼 찾기 (YYYY/MM/DD 형식)
  const dateCols: Array<{ idx: number; date: string }> = [];
  header.forEach((h, idx) => {
    const m = h.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (m) {
      dateCols.push({ idx, date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` });
    }
  });

  if (dateCols.length === 0) return [];

  // Renta 타이틀에서 화수/권수 접미사 제거하여 하나의 작품으로 집계
  // 예: "...！第10話【フルカラー】"        → "...！"
  //     "デイジー～...～ 157話" (第 없이) → "デイジー～...～"
  //     "商品名 10" (공백+숫자)           → "商品名"
  //     "響弦文字 [完全版]【特装版】1"    → "響弦文字 [完全版]【特装版】"
  // "プロローグ" 등 문자 접미사는 유지.
  const normalizeRentaTitle = (raw: string): string => {
    let s = raw;
    // 반복 적용 (여러 접미사가 겹친 경우)
    for (let i = 0; i < 3; i++) {
      s = s
        .replace(/\s*【フルカラー】\s*$/g, '')             // 끝의 "【フルカラー】"
        .replace(/\s*第?\s*\d+[話巻]\s*【[^】]*】\s*$/g, '') // "第10話【...】"
        .replace(/\s*第?\s*\d+[話巻]\s*$/g, '')            // "第10話" / "10話"
        .replace(/\s+\d+\s*【[^】]*】\s*$/g, '')          // "商品名 10【...】"
        .replace(/\s*\d+\s*$/g, '');                       // 끝의 숫자 (공백 유무 무관)
    }
    return s.trim();
  };

  // 집계: (title_jp, date) → amount
  const salesMap = new Map<string, Map<string, number>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    const rawTitle = (cols[titleIdx] ?? '').trim();
    const titleJP = normalizeRentaTitle(rawTitle);
    const price = parseInt(String(cols[priceIdx] ?? '0').replace(/[¥,]/g, ''), 10) || 0;
    if (!titleJP || price <= 0) continue;

    for (const dc of dateCols) {
      const count = parseInt(String(cols[dc.idx] ?? '0').replace(/[¥,]/g, ''), 10) || 0;
      if (count <= 0) continue;
      const amount = count * price;
      if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
      const dateMap = salesMap.get(titleJP)!;
      dateMap.set(dc.date, (dateMap.get(dc.date) || 0) + amount);
    }
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, amount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel: 'Renta',
        sale_date: date,
        sales_amount: amount,
      });
    }
  }
  return rows;
}

// ============================================================
// ebookjapan 속보치 parser
// 헤더: 集計単位, 書店名, タイトルID, ブックコード, 商品コード, SKU, 出版社名,
//       タイトル名, 表示用刊行物名, 刊行物名, 著者名, 販売数計,
//       単価(税抜), 単価(税込), 販売額計, ...
// 각 행이 하루치 매출
// ============================================================
export function parseEbookjapanSokuhochi(text: string): ParsedRow[] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = parseCSVText(cleaned, ',');
  if (lines.length < 2) return [];

  const header = lines[0];
  const dateIdx = header.findIndex((h) => h === '集計単位');
  const titleIdx = header.findIndex((h) => h === 'タイトル名');
  const amountIdx = header.findIndex((h) => h === '販売額計');
  const storeIdx = header.findIndex((h) => h === '書店名');
  if (dateIdx < 0 || titleIdx < 0 || amountIdx < 0) return [];

  const salesMap = new Map<string, Map<string, number>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    const titleJP = (cols[titleIdx] ?? '').trim();
    const rawDate = (cols[dateIdx] ?? '').trim();
    const amount = parseInt(String(cols[amountIdx] ?? '0').replace(/[¥,]/g, ''), 10) || 0;
    if (!titleJP || !rawDate || amount <= 0) continue;

    const dm = rawDate.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!dm) continue;
    const saleDate = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;

    // 書店名이 ebookjapan（web）이면 채널은 'ebookjapan'
    const storeName = storeIdx >= 0 ? (cols[storeIdx] ?? '') : '';
    const channel = /ebookjapan/i.test(storeName) ? 'ebookjapan' : 'ebookjapan';

    if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
    const dateMap = salesMap.get(titleJP)!;
    dateMap.set(saleDate, (dateMap.get(saleDate) || 0) + amount);

    // channel은 첫 루프에서 한 번만 기록되면 됨 (모든 row 같은 channel 가정)
    void channel;
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, amount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel: 'ebookjapan',
        sale_date: date,
        sales_amount: amount,
      });
    }
  }
  return rows;
}

// ============================================================
// DMM 속보치 parser
// 예상 헤더: 集計期間, カテゴリ, コンテンツＩＤ, 書籍コード, 商品タイトル,
//            作家名, メーカー名, レーベル名, 件数, 売上金額
// 또는 일별 데이터: 日付, 商品タイトル, 件数, 売上金額
// 集計期間 형식: "2025/04/01～2025/04/30" 또는 단일 날짜
// ============================================================
export function parseDmmSokuhochi(text: string): ParsedRow[] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = parseCSVText(cleaned, ',');
  if (lines.length < 2) return [];

  const header = lines[0];
  // 타이틀: 商品タイトル / タイトル名 / 作品名 (정확 매칭)
  const titleIdx = header.findIndex((h) =>
    h === '商品タイトル' || h === 'タイトル名' || h === '作品名',
  );
  // 금액: "売上金額", "売上金額（税抜）", "売上金額(税抜)", "販売額計", "金額" 등 유연 매칭
  const amountIdx = header.findIndex((h) => /売上金額|販売額計|取扱高/.test(h) && !/税込/.test(h))
    >= 0
      ? header.findIndex((h) => /売上金額|販売額計|取扱高/.test(h) && !/税込/.test(h))
      : header.findIndex((h) => /売上金額|販売額計|金額/.test(h));
  // 날짜: 売上月/売上日, 日付, 集計期間, 集計単位, 販売日
  const dateIdx = header.findIndex((h) =>
    /売上月|売上日|^日付$|集計期間|集計単位|販売日/.test(h),
  );
  // 配信サイト 컬럼 (FANZA 분기용)
  const siteIdx = header.findIndex((h) => h === '配信サイト' || h === 'サイト');

  if (titleIdx < 0 || amountIdx < 0 || dateIdx < 0) return [];

  // DMM 타이틀에서 화수 접미사 제거
  // 예: "僕に教えて 4" → "僕に教えて"
  //     "ツンデレ幼馴染、催眠でトロ～る25" → "ツンデレ幼馴染、催眠でトロ～る"
  //     "タイトル 10話" → "タイトル"
  // "プロローグ" 등 문자 접미사는 유지.
  const normalizeDmmTitle = (raw: string): string => {
    let s = raw;
    for (let i = 0; i < 3; i++) {
      s = s
        .replace(/\s*第?\s*\d+[話巻]\s*【[^】]*】\s*$/g, '') // "第10話【...】" / "10話"
        .replace(/\s*第?\s*\d+[話巻]\s*$/g, '')             // "10話" 단독
        .replace(/\s*【フルカラー】\s*$/g, '')
        .replace(/\s*\d+\s*$/g, '');                         // 공백 유무 무관 끝의 숫자
    }
    return s.trim();
  };

  const salesMap = new Map<string, Map<string, { amount: number; channel: string }>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    const rawTitle = (cols[titleIdx] ?? '').trim();
    const titleJP = normalizeDmmTitle(rawTitle);
    const rawDate = (cols[dateIdx] ?? '').trim();
    const amount = parseInt(String(cols[amountIdx] ?? '0').replace(/[¥,]/g, ''), 10) || 0;
    if (!titleJP || !rawDate || amount <= 0) continue;

    // 配信サイト에 FANZA가 있으면 DMM(FANZA), 아니면 DMM
    // 반각 괄호로 통일 (platforms 테이블 및 필터와 일치)
    const site = siteIdx >= 0 ? (cols[siteIdx] ?? '').toUpperCase() : '';
    const channel = site.includes('FANZA') ? 'DMM(FANZA)' : 'DMM';

    // 날짜: "2026年04月01日" / "2026/04/01" / "2025/04/01～2025/04/30"
    let saleDate = '';
    const rangeMatch = rawDate.match(/^(\d{4})[/-年](\d{1,2})[/-月](\d{1,2})日?\s*[～~]\s*\d{4}/);
    if (rangeMatch) {
      saleDate = `${rangeMatch[1]}-${rangeMatch[2].padStart(2, '0')}-01`;
    } else {
      const m1 = rawDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      const m2 = rawDate.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      const m = m1 || m2;
      if (m) saleDate = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }
    if (!saleDate) continue;

    if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
    const dateMap = salesMap.get(titleJP)!;
    const key = `${saleDate}\0${channel}`;
    const existing = dateMap.get(key);
    if (existing) existing.amount += amount;
    else dateMap.set(key, { amount, channel });
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [key, { amount, channel }] of dateMap) {
      const saleDate = key.split('\0')[0];
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel,
        sale_date: saleDate,
        sales_amount: amount,
      });
    }
  }
  return rows;
}

// ============================================================
// LINE Manga 속보치 parser
// 헤더: 集計単位, 出版社名, 作品ID, 作品名, 著者名, ジャンル, 掲載誌名,
//       冊単価(税抜), 冊単価(税込), 販売冊数, 取扱高(税抜), 取扱高(税込)
// 날짜 형식: "2026年04月15日" (연월일)
// 금액: 取扱高(税抜)
// ============================================================
export function parseLineMangaSokuhochi(text: string): ParsedRow[] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = parseCSVText(cleaned, ',');
  if (lines.length < 2) return [];

  const header = lines[0];
  const dateIdx = header.findIndex((h) => h === '集計単位');
  const titleIdx = header.findIndex((h) => h === '作品名');
  // 取扱高(税抜) 우선, 없으면 取扱高(税込)
  let amountIdx = header.findIndex((h) => h === '取扱高(税抜)' || h === '取扱高（税抜）');
  if (amountIdx < 0) amountIdx = header.findIndex((h) => h === '取扱高(税込)' || h === '取扱高（税込）');
  if (dateIdx < 0 || titleIdx < 0 || amountIdx < 0) return [];

  const salesMap = new Map<string, Map<string, number>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    const titleJP = (cols[titleIdx] ?? '').trim();
    const rawDate = (cols[dateIdx] ?? '').trim();
    const amount = Math.round(parseFloat(String(cols[amountIdx] ?? '0').replace(/[¥,]/g, '')) || 0);
    if (!titleJP || !rawDate || amount <= 0) continue;

    // 날짜: "2026年04月15日" 또는 "2026/04/15"
    let saleDate = '';
    const dm1 = rawDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const dm2 = rawDate.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    const dm = dm1 || dm2;
    if (!dm) continue;
    saleDate = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;

    if (!salesMap.has(titleJP)) salesMap.set(titleJP, new Map());
    const dateMap = salesMap.get(titleJP)!;
    dateMap.set(saleDate, (dateMap.get(saleDate) || 0) + amount);
  }

  const rows: ParsedRow[] = [];
  for (const [titleJP, dateMap] of salesMap) {
    for (const [date, amount] of dateMap) {
      rows.push({
        title_jp: titleJP,
        title_kr: '',
        channel_title_jp: titleJP,
        channel: 'LINEマンガ',
        sale_date: date,
        sales_amount: amount,
      });
    }
  }
  return rows;
}
