/**
 * Parser for the RIVERSE comprehensive content list workbook.
 *
 * Intentionally decoupled from `xlsx`: it consumes plain `unknown[][]` rows
 * (header:1 output) so it can be unit-tested and driven from either a script
 * or an API route without pulling the spreadsheet library into that layer.
 */

export type ContentStatus = 'service' | 'prep';

/** Which sheets we import and how to classify them. */
export const SHEET_CONFIGS: ReadonlyArray<{ sheet: string; status: ContentStatus }> = [
  { sheet: '日本(タテヨミ)', status: 'service' },
  { sheet: '日本(版面)', status: 'service' },
  { sheet: '日本(タテヨミ)準備作品', status: 'prep' },
  { sheet: '日本(版面)準備作品', status: 'prep' },
];

/** All 4 sheets place the real header on the 2nd row and data from the 3rd. */
const HEADER_ROW_INDEX = 1;
const DATA_START_INDEX = 2;

export interface ParsedContentRow {
  source_sheet: string;
  source_row: number; // 1-based Excel row number
  status: ContentStatus;
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
  raw_data: Record<string, unknown>;
}

type FieldKey = keyof Omit<
  ParsedContentRow,
  'source_sheet' | 'source_row' | 'status' | 'raw_data'
>;

/**
 * Normalized-header → field. Multiple source headers can map to the same
 * field; the FIRST matching column in a sheet wins (see buildFieldColumns),
 * which correctly picks the primary 制作会社 / JPタイトル(仮) columns.
 */
const HEADER_FIELD_MAP: Record<string, FieldKey> = {
  '作品名(jp)': 'title_jp',
  'jpタイトル(仮)': 'title_jp',
  'jpタイトル': 'title_jp',
  '作品名(kr)': 'title_kr',
  '管理事項': 'management_type',
  '制作会社': 'production_company',
  '流通会社': 'distribution_company',
  '形式': 'format',
  '作画': 'artist',
  '作画(ヨミ)': 'artist_reading',
  '脚色': 'adaptation',
  '脚色(ヨミ)': 'adaptation_reading',
  '原作': 'original_author',
  '原作(ヨミ)': 'original_author_reading',
  'ジャンル': 'genre',
  'レーベル': 'label',
  '連載曜日': 'weekday',
  '(連載)曜日': 'weekday',
  '曜日': 'weekday',
  'コピーライト': 'copyright',
  'コピーライト(奥付)': 'copyright',
  '作品紹介': 'synopsis',
  '配信範囲': 'distribution_scope',
  '提供範囲': 'distribution_scope',
  '非独占転換日': 'non_exclusive_conversion_date',
  'サービス予定': 'service_planned_date',
  '備考': 'notes',
};

/** Strip whitespace/newlines/full-width spaces and lowercase latin chars. */
function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

function toCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' || s === '-' ? null : s;
}

/** Map each field to the first source column index that satisfies it. */
function buildFieldColumns(headerRow: unknown[]): Partial<Record<FieldKey, number>> {
  const cols: Partial<Record<FieldKey, number>> = {};
  headerRow.forEach((cell, idx) => {
    const field = HEADER_FIELD_MAP[normalizeHeader(cell)];
    if (field && cols[field] === undefined) cols[field] = idx;
  });
  return cols;
}

/** Build the lossless raw_data object (header→value, deduping collisions). */
function buildRawData(headerRow: unknown[], dataRow: unknown[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  headerRow.forEach((cell, idx) => {
    const header = String(cell ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!header) return;
    const value = dataRow[idx];
    if (value === null || value === undefined || value === '') return;
    const key = raw[header] === undefined ? header : `${header} (${idx})`;
    raw[key] = value;
  });
  return raw;
}

/**
 * Parse one sheet's `header:1` rows into normalized content rows.
 * Rows with no title in any position are treated as empty and skipped.
 */
export function parseSheet(
  sheet: string,
  status: ContentStatus,
  rows: unknown[][],
): ParsedContentRow[] {
  const headerRow = rows[HEADER_ROW_INDEX] ?? [];
  const cols = buildFieldColumns(headerRow);
  const out: ParsedContentRow[] = [];

  for (let i = DATA_START_INDEX; i < rows.length; i++) {
    const dataRow = rows[i] ?? [];
    const get = (field: FieldKey): string | null => {
      const idx = cols[field];
      return idx === undefined ? null : toCell(dataRow[idx]);
    };

    const title_jp = get('title_jp');
    const title_kr = get('title_kr');
    // Skip structural/blank rows that carry no title at all.
    if (!title_jp && !title_kr) continue;

    out.push({
      source_sheet: sheet,
      source_row: i + 1, // 1-based Excel row
      status,
      title_jp,
      title_kr,
      management_type: get('management_type'),
      production_company: get('production_company'),
      distribution_company: get('distribution_company'),
      format: get('format'),
      artist: get('artist'),
      artist_reading: get('artist_reading'),
      adaptation: get('adaptation'),
      adaptation_reading: get('adaptation_reading'),
      original_author: get('original_author'),
      original_author_reading: get('original_author_reading'),
      genre: get('genre'),
      label: get('label'),
      weekday: get('weekday'),
      copyright: get('copyright'),
      synopsis: get('synopsis'),
      distribution_scope: get('distribution_scope'),
      non_exclusive_conversion_date: get('non_exclusive_conversion_date'),
      service_planned_date: get('service_planned_date'),
      notes: get('notes'),
      raw_data: buildRawData(headerRow, dataRow),
    });
  }

  return out;
}
