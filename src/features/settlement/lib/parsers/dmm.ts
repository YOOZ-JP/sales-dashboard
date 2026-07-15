/**
 * DMM / FANZA parser — XLSX.
 *
 * File: `YYMM_<account>_株式会社RIVERSE_支払通知書_明細.xlsx`
 *
 * Sheets:
 *   - `報告書` — payment-notice-letter header (skipped; header/control data only)
 *   - `ﾌﾞｯｸｽ(ｱﾀﾞﾙﾄ)` — adult catalog → channel `dmm_fanza`
 *   - `ﾌﾞｯｸｽ(一般)` — general catalog → channel `dmm`
 *
 * Data table layout on data sheets (header row 1, data rows 2..N):
 *   A 集計期間 | B カテゴリ | C コンテンツＩＤ | D 書籍コード | E 商品タイトル
 *   F 作家名  | G メーカー名 | H レーベル名 | I 件数 | J 売上金額 (tax-excluded)
 *
 * Rules learned from GT 202604:
 *   1. Each raw row is ONE volume/episode of a series. Volume suffixes:
 *       ` NN巻`  → `type = "EB"`
 *       `NN話`   → `type = "EP"`  (also `NN話 外伝NN` tail is ignored)
 *       trailing digits (` NN` or bare `NN`) → `type = "WT"`  (`外伝NN` tail ignored)
 *     We aggregate to series-level by stripping these suffixes.
 *   2. `GT.total_amount_jpy  = round(Σsheet売上金額 * 1.10)`   // 10% consumption tax
 *      `GT.before_tax_income = round(GT.total * 0.45)`         // DMM fixed RS 45%
 *   3. Title canonicalisation (for matching against GT): fullwidth digits → ASCII;
 *      `［］`→`[]`; `～` (U+FF5E) and `〜` (U+301C) unified; all spaces stripped;
 *      `♥` stripped.
 *   4. GT may wrap the WT/EP series name with `【分冊版】` (recorder convention);
 *      matching tries both with and without the suffix.
 *   5. Specific EB alias: GT `融点 [完全版](巻)` → series `融点〜とけあい〜[完全版]【特装版】`.
 *
 * Output records carry series totals plus `channel_code`, `type`, and
 * `raw_sales_jpy` (tax-excluded) so the aggregation layer can apply tax/RS.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";
import aliasRules from "../../data/aliases/dmm.json";

const ADULT_SHEET = "ﾌﾞｯｸｽ(ｱﾀﾞﾙﾄ)";
const GENERAL_SHEET = "ﾌﾞｯｸｽ(一般)";

const HEADER_COLS = {
  title: 4,    // E 商品タイトル (0-indexed)
  maker: 6,    // G メーカー名
  label: 7,    // H レーベル名
  count: 8,    // I 件数
  sales: 9,    // J 売上金額 (tax-excluded)
};

type SeriesType = "WT" | "EP" | "EB";

interface SeriesAgg {
  series_raw: string;        // raw series name before canonicalisation
  series_canonical: string;  // canonical key used for matching
  type: SeriesType;
  channel_code: "dmm" | "dmm_fanza";
  raw_sales_jpy: number;     // Σ sheet 売上金額 (税抜)
  quantity: number;          // Σ sheet 件数
  maker?: string;
  label?: string;
}

/**
 * Classify a raw row title into (series, type). The suffix decides the type:
 *   - `<series>NN巻`           → EB
 *   - `<series>NN話` (optional ` 外伝NN` after)   → EP
 *   - `<series>NN`  (optional ` 外伝NN` after)    → WT
 *     (the space between series and NN is optional in the source)
 *   - no trailing digits       → WT (treat whole string as series)
 */
function classifyTitle(raw: string): { series: string; type: SeriesType } {
  const t = raw.trim();

  // NN巻 at the end → EB (bound volume)
  const ebMatch = t.match(/^(.*?)\s*(\d+)巻$/);
  if (ebMatch) return { series: ebMatch[1].trim(), type: "EB" };

  // NN話, optionally followed by " 外伝NN" → EP (episode)
  const epMatch = t.match(/^(.*?)\s*(\d+)話(?:\s+外伝\d+)?$/);
  if (epMatch) return { series: epMatch[1].trim(), type: "EP" };

  // Trailing digits (with optional " 外伝NN") → WT (volume in 縦読み)
  const wtMatch = t.match(/^(.*?[^\d])\s*(\d+)(?:\s+外伝\d+)?$/);
  if (wtMatch) return { series: wtMatch[1].trim(), type: "WT" };

  return { series: t, type: "WT" };
}

/**
 * Canonical title form for fuzzy matching between raw series and GT titles.
 *  - fullwidth digits → ASCII
 *  - ［］ → []
 *  - ～ (FULLWIDTH TILDE U+FF5E) unified with 〜 (WAVE DASH U+301C)
 *  - spaces / ideographic spaces / ♥ stripped
 */
export function canonicalTitle(s: string): string {
  const fwDigits = "０１２３４５６７８９";
  let out = "";
  for (const ch of s) {
    const i = fwDigits.indexOf(ch);
    if (i >= 0) { out += String(i); continue; }
    if (ch === "［") { out += "["; continue; }
    if (ch === "］") { out += "]"; continue; }
    if (ch === "～") { out += "〜"; continue; }  // unify both tildes to U+301C
    if (ch === " " || ch === "　" || ch === "♥") continue;
    out += ch;
  }
  return out;
}

function parseSheet(
  wb: ReturnType<typeof readWorkbook>,
  sheetName: string,
  channel: "dmm" | "dmm_fanza",
): Map<string, SeriesAgg> {
  const agg = new Map<string, SeriesAgg>();
  if (!wb.Sheets[sheetName]) return agg;
  const matrix = sheetToMatrix(wb, sheetName);

  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    const title = row[HEADER_COLS.title];
    if (!title || typeof title !== "string") continue;
    const sales = toNumber(row[HEADER_COLS.sales]);
    const count = toNumber(row[HEADER_COLS.count]);
    const maker = row[HEADER_COLS.maker] as string | undefined;
    const label = row[HEADER_COLS.label] as string | undefined;

    const { series, type } = classifyTitle(title);
    const canonical = canonicalTitle(series);
    const key = `${type}|${canonical}`;

    const prev = agg.get(key);
    if (prev) {
      prev.raw_sales_jpy += sales;
      prev.quantity += count;
    } else {
      agg.set(key, {
        series_raw: series,
        series_canonical: canonical,
        type,
        channel_code: channel,
        raw_sales_jpy: sales,
        quantity: count,
        maker: typeof maker === "string" ? maker.trim() : undefined,
        label: typeof label === "string" ? label.trim() : undefined,
      });
    }
  }
  return agg;
}

export async function parseDmm({ filename, buffer }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename) || /ポイント上乗せ施策/.test(filename)) {
    return { platform_code: "dmm", sales_month: null, settlement_month: null, records: [], errors: [] };
  }
  const wb = readWorkbook(buffer);

  const adult = parseSheet(wb, ADULT_SHEET, "dmm_fanza");
  const general = parseSheet(wb, GENERAL_SHEET, "dmm");

  const records: RawRecord[] = [];
  let rowIdx = 0;
  for (const agg of [...adult.values(), ...general.values()]) {
    const afterTaxIncome = Math.round(agg.raw_sales_jpy * 0.45);
    records.push({
      row_index: rowIdx++,
      data: {
        title_jp: agg.series_raw,
        title_canonical: agg.series_canonical,
        type: agg.type,
        channel_code: agg.channel_code,
        client_code: "dmm",
        raw_sales_jpy: agg.raw_sales_jpy,
        quantity: agg.quantity,
        maker: agg.maker ?? null,
        label: agg.label ?? null,
        total_amount_jpy: null,
        before_tax_jpy: null,
        after_tax_jpy: Math.round(agg.raw_sales_jpy),
        before_tax_income_jpy: null,
        after_tax_income_jpy: afterTaxIncome,
        consumption_tax_jpy: null,
        rs_rate: 0.45,
      },
    });
  }

  // Filename "2603_..." → 2026-03
  const m = filename.match(/^(\d{2})(\d{2})_/);
  const salesMonth = m ? `20${m[1]}-${m[2]}-01` : null;
  const depositMonth = salesMonth ? addMonthsEndOfMonth(salesMonth, 2) : null;
  for (const record of records) record.data.deposit_month = depositMonth;

  return {
    platform_code: "dmm",
    sales_month: salesMonth,
    settlement_month: salesMonth,
    records,
    errors: records.length === 0 ? ["no records extracted from DMM file"] : [],
  };
}

function addMonthsEndOfMonth(iso: string, months: number): string {
  const [year, month] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1 + months + 1, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Alias-aware lookup of a GT row inside the parser output. Used by the
 * verification script.
 */
export function lookupByGtTitle(
  records: RawRecord[],
  gtTitle: string,
  gtType: SeriesType,
): RawRecord | undefined {
  const aliases = (aliasRules as { direct: Record<string, { series: string; type: SeriesType }> })?.direct ?? {};

  const direct = aliases[`${gtType}|${gtTitle}`];
  const candidates: string[] = [];
  if (direct) candidates.push(canonicalTitle(direct.series));
  candidates.push(canonicalTitle(gtTitle));
  // GT may wrap series with 【分冊版】 suffix (recorder convention)
  if (gtTitle.endsWith("【分冊版】")) {
    candidates.push(canonicalTitle(gtTitle.slice(0, -"【分冊版】".length)));
  } else {
    candidates.push(canonicalTitle(gtTitle + "【分冊版】"));
  }

  const typeKey = direct?.type ?? gtType;
  for (const cand of candidates) {
    const hit = records.find(r => r.data.type === typeKey && r.data.title_canonical === cand);
    if (hit) return hit;
  }
  return undefined;
}
