/**
 * Fallback display lookups parsed from the golden INPUT v2 template workbook.
 *
 * On deployments where the clients/channels/titles DB tables are empty, the
 * export/preview rows would render blank Clients/Channel columns. The golden
 * template already carries the master data we need:
 *
 * - 設定 sheet: independent dropdown lists. Column 채널 (rows 5+) is the
 *   canonical set of channel codes; it does NOT pair channels with clients
 *   row-by-row, so it only seeds the known-channel set.
 * - input_電子_N月 sheet: real settlement rows. Per channel code we take the
 *   most frequent Clients/Type/Distribution Strategy/Country/currency values
 *   as the fallback attributes (e.g. cmoa → NTTsolmare).
 * - タイトル sheet: Channel Title(JP) variants → Title(KR) / canonical
 *   Title(JP).
 */

import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

// Same workbook as input-v2-filler's DEFAULT_TEMPLATE (kept private there).
const TEMPLATE = new URL(
  "../../data/templates/input_jp_2026_2605_golden.xlsx",
  import.meta.url,
);

export interface TemplateChannelInfo {
  clients: string | null;
  channel: string;
  type: string | null;
  distribution_strategy: string | null;
  country: string | null;
  settlement_currency: string | null;
  vehicle_currency: string | null;
}

export interface TemplateTitleInfo {
  title_kr: string | null;
  title_jp: string | null;
}

export interface InputV2TemplateLookups {
  /** channel code (e.g. "cmoa", "line_ads") → display attributes */
  channelByCode: Map<string, TemplateChannelInfo>;
  /** normalizeTitleKey(channel title JP or canonical title JP) → titles */
  titleByChannelTitle: Map<string, TemplateTitleInfo>;
}

/**
 * raw_uploads.platform_code (parser codes) → template channel code.
 * Codes missing from this table pass through lowercased, since most parser
 * codes already match the template's channel codes.
 */
const PLATFORM_CODE_TO_CHANNEL: Record<string, string> = {
  cmoa: "cmoa",
  mechacomic: "mechacomic",
  renta: "renta",
  line_ad: "line_ads",
  piccoma_ads: "piccoma_ads",
  mediado: "mediado_sales",
  mbj: "mbj_sales",
  sb_creative: "sb creative",
  u_next: "u-next",
  dmm: "dmm",
  booklive: "booklive",
  ichijinsha: "ichijinsha",
  shueisha: "shueisha",
  mangabang: "mangabang",
  piccoma: "piccoma",
  piccoma_gaiakuhan: "piccoma_sales",
  // The LINE/eBookJapan parser tags mixed files as ebj_line; ebj is the best
  // single-channel fallback for them.
  ebj_line: "ebj",
  ebj: "ebj",
  ebj_webtoon: "ebj_webtoon",
};

export function platformCodeToChannel(platformCode: string): string {
  const key = platformCode.trim().toLowerCase();
  return PLATFORM_CODE_TO_CHANNEL[key] ?? key;
}

/**
 * raw_records.data.channel_code can contain parser-side aliases. Normalize them
 * to the channel spelling used by the golden INPUT template.
 */
const RAW_CHANNEL_CODE_TO_TEMPLATE: Record<string, string> = {
  sb_creative: "sb creative",
  piccoma_gaiakuhan: "piccoma_sales",
};

export function rawChannelCodeToTemplate(channelCode: string): string {
  const key = channelCode.trim().toLowerCase();
  return RAW_CHANNEL_CODE_TO_TEMPLATE[key] ?? channelCode.trim();
}

/**
 * raw_records.data.client_code (parser codes) → Clients display name as it
 * appears in the golden template. Unknown codes return null so callers can
 * fall back to the per-channel template attributes.
 */
const CLIENT_CODE_DISPLAY: Record<string, string> = {
  nttsolmare: "NTTsolmare",
  line_dl_frontier: "Line Digital Frontier",
  papyless: "PAPYLESS",
  piccoma: "Piccoma",
  booklive: "Booklive",
  amutus: "Amutus",
  dmm: "DMM",
  mediado: "mediado",
  u_next: "U-NEXT",
  mbj: "MBJ",
  shueisha: "shueisha",
  ichijinsha: "ichijinsha",
  amazia: "Amazia",
  sb_creative: "sb creative",
  kadokawa: "kadokawa",
  comico_jp: "comico JP",
  comico: "comico JP",
};

export function clientCodeToDisplay(clientCode: string): string | null {
  return CLIENT_CODE_DISPLAY[clientCode.trim().toLowerCase()] ?? null;
}

/** Whitespace/width-insensitive key for タイトル sheet lookups. */
export function normalizeTitleKey(title: string): string {
  return title.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("").trim();
    }
    if ("result" in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      return result === null || result === undefined ? "" : String(result).trim();
    }
    if ("text" in value) return String(value.text).trim();
  }
  return String(value).trim();
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function findColumn(row: ExcelJS.Row, label: string): number | null {
  const wanted = normalizeLabel(label);
  for (let c = 1; c <= row.cellCount; c++) {
    if (normalizeLabel(cellText(row.getCell(c).value)) === wanted) return c;
  }
  return null;
}

function modalValue(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function parseChannelCodes(ws: ExcelJS.Worksheet): string[] {
  const channelCol = findColumn(ws.getRow(4), "채널");
  if (!channelCol) return [];
  const codes: string[] = [];
  for (let r = 5; r <= ws.actualRowCount; r++) {
    const code = cellText(ws.getRow(r).getCell(channelCol).value);
    if (code) codes.push(code);
  }
  return codes;
}

const CHANNEL_ATTRS = [
  "clients",
  "type",
  "distribution_strategy",
  "country",
  "settlement_currency",
  "vehicle_currency",
] as const;
type ChannelAttr = (typeof CHANNEL_ATTRS)[number];

const ATTR_LABELS: Record<ChannelAttr, string> = {
  clients: "Clients",
  type: "Type",
  distribution_strategy: "Distribution Strategy",
  country: "Country",
  settlement_currency: "Settlement Currency",
  vehicle_currency: "Vehicle Currency",
};

function parseChannelAttributes(
  ws: ExcelJS.Worksheet,
): Map<string, TemplateChannelInfo> {
  const header = ws.getRow(4);
  const channelCol = findColumn(header, "Channel");
  const result = new Map<string, TemplateChannelInfo>();
  if (!channelCol) return result;

  const attrCols = new Map<ChannelAttr, number>();
  for (const attr of CHANNEL_ATTRS) {
    const col = findColumn(header, ATTR_LABELS[attr]);
    if (col) attrCols.set(attr, col);
  }

  const tallies = new Map<string, Map<ChannelAttr, Map<string, number>>>();
  for (let r = 6; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const channel = cellText(row.getCell(channelCol).value);
    if (!channel) continue;
    let tally = tallies.get(channel);
    if (!tally) {
      tally = new Map();
      tallies.set(channel, tally);
    }
    for (const [attr, col] of attrCols) {
      const value = cellText(row.getCell(col).value);
      if (!value) continue;
      let counts = tally.get(attr);
      if (!counts) {
        counts = new Map();
        tally.set(attr, counts);
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  for (const [channel, tally] of tallies) {
    result.set(channel, {
      channel,
      clients: modalValue(tally.get("clients") ?? new Map()),
      type: modalValue(tally.get("type") ?? new Map()),
      distribution_strategy: modalValue(tally.get("distribution_strategy") ?? new Map()),
      country: modalValue(tally.get("country") ?? new Map()),
      settlement_currency: modalValue(tally.get("settlement_currency") ?? new Map()),
      vehicle_currency: modalValue(tally.get("vehicle_currency") ?? new Map()),
    });
  }
  return result;
}

function parseTitleLookup(ws: ExcelJS.Worksheet): Map<string, TemplateTitleInfo> {
  const header = ws.getRow(3);
  const channelTitleCol = findColumn(header, "Channel Title(JP)");
  const titleKrCol = findColumn(header, "Title(KR)");
  const titleJpCol = findColumn(header, "Title(JP)");
  const result = new Map<string, TemplateTitleInfo>();
  if (!channelTitleCol || !titleKrCol || !titleJpCol) return result;

  for (let r = 4; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const channelTitle = cellText(row.getCell(channelTitleCol).value);
    const titleKr = cellText(row.getCell(titleKrCol).value) || null;
    const titleJp = cellText(row.getCell(titleJpCol).value) || null;
    if (!titleKr && !titleJp) continue;
    const info: TemplateTitleInfo = { title_kr: titleKr, title_jp: titleJp };
    if (channelTitle) {
      const key = normalizeTitleKey(channelTitle);
      if (!result.has(key)) result.set(key, info);
    }
    if (titleJp) {
      const key = normalizeTitleKey(titleJp);
      if (!result.has(key)) result.set(key, info);
    }
  }
  return result;
}

async function parseTemplateLookups(): Promise<InputV2TemplateLookups> {
  const wb = new ExcelJS.Workbook();
  const buffer = await readFile(TEMPLATE);
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const dataSheet = wb.worksheets.find((ws) => /^input_電子_\d+月$/.test(ws.name));
  const channelByCode = dataSheet
    ? parseChannelAttributes(dataSheet)
    : new Map<string, TemplateChannelInfo>();

  const settingsSheet = wb.getWorksheet("設定");
  if (settingsSheet) {
    for (const code of parseChannelCodes(settingsSheet)) {
      if (!channelByCode.has(code)) {
        channelByCode.set(code, {
          channel: code,
          clients: null,
          type: null,
          distribution_strategy: null,
          country: null,
          settlement_currency: null,
          vehicle_currency: null,
        });
      }
    }
  }

  const titleSheet = wb.getWorksheet("タイトル");
  const titleByChannelTitle = titleSheet
    ? parseTitleLookup(titleSheet)
    : new Map<string, TemplateTitleInfo>();

  return { channelByCode, titleByChannelTitle };
}

let cachedLookups: Promise<InputV2TemplateLookups> | null = null;

export function loadInputV2TemplateLookups(): Promise<InputV2TemplateLookups> {
  if (!cachedLookups) {
    cachedLookups = parseTemplateLookups().catch((err) => {
      cachedLookups = null;
      throw err;
    });
  }
  return cachedLookups;
}
