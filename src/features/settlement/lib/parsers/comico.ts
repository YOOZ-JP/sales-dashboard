/**
 * comico JP parser — 202603.xlsx
 *
 * This workbook is a settlement package with many sheets. Two carry the
 * title × revenue data that ends up in the 62-col GT:
 *
 *   1. `プラットフォーム売上現況`   — channel `comico jp`   (WT / WR / EP / EB)
 *   2. `広告売上`                   — channel `comico_ads` (AD, rs=0.3 or 0.2)
 *
 * The first sheet (`精算書(JP)`) is an invoice letter and is skipped.
 *
 * Key findings (see data/aliases/comico.json and data/verification/comico-report.json):
 *
 *  - "Platform sales" rows: one row per (title × store). 1 title spans 1..3
 *    stores (WEB / iOS / Google). GT collapses them to a single row per title.
 *  - Column semantics (row index in raw):
 *       col14  合計              → coin sales (tax-incl), paid + free
 *       col10  コイン売上(税込)  → paid coin only (tax-incl)
 *       col21  (G)分配金         → paid coin distribution (tax-exclusive)
 *       col30  分配金[(G)+(G')]  → total distribution (tax-exclusive, paid + free)
 *       col20  (F)分配率          → RS rate for the row
 *       col2   Content Type     → "comic" (WT) | "magazine_comic" (EP/EB)
 *  - Tax handling:
 *       GT total_amount_jpy       = raw total-coin (already tax-incl)
 *       GT before_tax_income_jpy  = round( raw distribution × 1.10 )
 *  - `magazine_comic` Content Type (分冊版/特装版) is special:
 *       GT total_amount_jpy       = sum(col10) only (paid coin tax-incl) - NOT col14
 *       GT before_tax_income_jpy  = round( sum(col21) × 1.10 ) - paid only
 *       rs                        = 0.55  (raw col20 confirms)
 *  - Type classification:
 *       EP  : magazine_comic + 【分冊版】 suffix
 *       EB  : magazine_comic + 【特装版】 suffix
 *       WR  : all-ages variant (`【全年齢版】` OR a title that has a paired
 *             `title + 【完全版】` sibling — meaning this title is the base
 *             version and the `【完全版】` is the 18+ edition marketed as WT)
 *       WT  : everything else (主にウェブトゥーン, `【完全版】`含む)
 *  - Ads sheet formula:
 *       total  = round( sum(売上高) × 1.10 )
 *       income = round( sum(分配金額) × 1.10 )
 *       rs     = 分配率 (0.3 for comic, 0.2 for magazine_comic)
 *       channel = `comico_ads`, type = `AD`
 *  - Sales month for `comico jp` comes from (year, month) columns of the
 *    platform-sales row. Ads rows usually report the previous month.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix } from "./common";


const PLATFORM_SHEET = "プラットフォーム売上現況";
const AD_SHEET = "広告売上";

interface PlatformAgg {
  title: string;                // master title (col5)
  content_type: string;         // "comic" | "magazine_comic"
  year: number | null;
  month: number | null;
  coin_total: number;           // sum of col14 (税込, paid + free)
  paid_coin_tax_incl: number;   // sum of col10
  G: number;                    // sum of col21 (paid distribution, 税抜)
  G_plus_Gp: number;            // sum of col30 (paid + free distribution, 税抜)
  rs_set: Set<number>;          // distinct values of col20
}

interface AdAgg {
  title: string;                // col8 master title
  content_type: string;         // col3
  year: number | null;
  month: number | null;
  sales: number;                // sum of col9
  dist: number;                 // sum of col11
  rs: number;                   // col10 (assumed constant per title)
}

/** Pull integer or null from mixed cell. */
function numOr0(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

/** `{year}-{mm}-01` from numeric year/month; null if either missing. */
function ymToIso(year: number | null, month: number | null): string | null {
  if (!year || !month) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** Classify title by WT/WR/EP/EB. WR rule needs knowledge of sibling titles. */
function classifyType(
  title: string,
  contentType: string,
  rsSet: Set<number>,
  allTitles: Set<string>,
): "WT" | "WR" | "EP" | "EB" {
  if (contentType === "magazine_comic" || rsSet.has(0.55)) {
    if (title.includes("【特装版】")) return "EB";
    return "EP"; // default for magazine_comic / 分冊版
  }
  // WR: explicit 【全年齢版】 marker
  if (title.includes("【全年齢版】")) return "WR";
  // WR: base title has a paired `…【完全版】` sibling → this is the all-ages edition
  if (!title.includes("【完全版】") && allTitles.has(`${title}【完全版】`)) {
    return "WR";
  }
  return "WT";
}

export async function parseComico({ filename, buffer }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  const wb = readWorkbook(buffer);
  const errors: string[] = [];

  // --- 1. Platform sales -------------------------------------------------
  const platformAggs = new Map<string, PlatformAgg>();
  if (wb.SheetNames.includes(PLATFORM_SHEET)) {
    const matrix = sheetToMatrix(wb, PLATFORM_SHEET);
    // Header rows are 0 and 1; data starts at row 2.
    for (let i = 2; i < matrix.length; i++) {
      const row = matrix[i];
      const title = row?.[5];
      if (!title || typeof title !== "string") continue;
      const ct = String(row[2] ?? "");
      const prev = platformAggs.get(title) ?? {
        title,
        content_type: ct,
        year: row[0] != null ? Number(row[0]) : null,
        month: row[1] != null ? Number(row[1]) : null,
        coin_total: 0,
        paid_coin_tax_incl: 0,
        G: 0,
        G_plus_Gp: 0,
        rs_set: new Set<number>(),
      };
      prev.coin_total += numOr0(row[14]);
      prev.paid_coin_tax_incl += numOr0(row[10]);
      prev.G += numOr0(row[21]);
      prev.G_plus_Gp += numOr0(row[30]);
      const rsCell = row[20];
      if (rsCell != null && rsCell !== "") prev.rs_set.add(Number(rsCell));
      platformAggs.set(title, prev);
    }
  } else {
    errors.push(`sheet missing: ${PLATFORM_SHEET}`);
  }

  // --- 2. Ads ------------------------------------------------------------
  const adAggs = new Map<string, AdAgg>();
  if (wb.SheetNames.includes(AD_SHEET)) {
    const matrix = sheetToMatrix(wb, AD_SHEET);
    // Header row is 0; data starts at row 1.
    for (let i = 1; i < matrix.length; i++) {
      const row = matrix[i];
      const title = row?.[8];
      if (!title || typeof title !== "string") continue;
      const prev = adAggs.get(title) ?? {
        title,
        content_type: String(row[3] ?? ""),
        year: row[0] != null ? Number(row[0]) : null,
        month: row[1] != null ? Number(row[1]) : null,
        sales: 0,
        dist: 0,
        rs: numOr0(row[10]),
      };
      prev.sales += numOr0(row[9]);
      prev.dist += numOr0(row[11]);
      adAggs.set(title, prev);
    }
  }

  // --- 3. Emit RawRecords ------------------------------------------------
  const records: RawRecord[] = [];
  const allTitles = new Set(platformAggs.keys());

  // Platform (comico jp) — emit in the raw sheet order, which we preserved
  // via Map insertion order.
  for (const agg of platformAggs.values()) {
    const type = classifyType(agg.title, agg.content_type, agg.rs_set, allTitles);
    const isMag = agg.content_type === "magazine_comic" || agg.rs_set.has(0.55);

    // GT total_amount_jpy
    const total_amount_jpy = isMag
      ? Math.round(agg.paid_coin_tax_incl)
      : Math.round(agg.coin_total);

    // GT before_tax_income_jpy  (round(dist × 1.10))
    const distBase = isMag ? agg.G : agg.G_plus_Gp;
    const before_tax_income_jpy = Math.round(distBase * 1.10);

    // GT before_tax_jpy — mirror of total (no fee layer on this platform)
    const before_tax_jpy = total_amount_jpy;
    // after_tax_jpy = total / 1.1 rounded
    const after_tax_jpy = Math.round(total_amount_jpy / 1.10);
    const consumption_tax_jpy = Math.round(before_tax_income_jpy - Math.round(before_tax_income_jpy / 1.10));
    const after_tax_income_jpy = before_tax_income_jpy - consumption_tax_jpy;

    // RS: take the paid rate (the dominant one in the rs_set)
    const rs_rate = agg.rs_set.has(0.55) ? 0.55 : 0.5;

    records.push({
      row_index: records.length,
      data: {
        title_jp: agg.title,
        channel_title_jp: agg.title,
        client_code: "comico_jp",
        channel_code: "comico jp",
        type,
        sales_month: ymToIso(agg.year, agg.month),
        total_amount_jpy,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_rate,
        fee_jpy: 0,
        withholding_tax_jpy: 0,
        distribution_strategy: "non-ex",
      },
    });
  }

  // Ads (comico_ads)
  for (const agg of adAggs.values()) {
    const total_amount_jpy = Math.round(agg.sales * 1.10);
    const before_tax_income_jpy = Math.round(agg.dist * 1.10);
    const before_tax_jpy = total_amount_jpy;
    const after_tax_jpy = Math.round(total_amount_jpy / 1.10);
    const consumption_tax_jpy = Math.round(before_tax_income_jpy - Math.round(before_tax_income_jpy / 1.10));
    const after_tax_income_jpy = before_tax_income_jpy - consumption_tax_jpy;

    records.push({
      row_index: records.length,
      data: {
        title_jp: agg.title,
        channel_title_jp: agg.title,
        client_code: "comico_jp",
        channel_code: "comico_ads",
        type: "AD",
        sales_month: ymToIso(agg.year, agg.month),
        total_amount_jpy,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_rate: agg.rs,
        fee_jpy: 0,
        withholding_tax_jpy: 0,
        distribution_strategy: "non-ex",
      },
    });
  }

  // Use filename yyyymm for settlement month (the settlement is one month
  // after the sales month of the platform-sales rows).
  const m = filename.match(/(\d{4})(\d{2})/);
  const settlementFromFilename = m ? `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}-01` : null;

  // "sales_month" at parse level is a hint only — per-record sales_month lives
  // inside `data`. We report the newest observed platform month here.
  const platformMonths = Array.from(platformAggs.values())
    .map(a => ymToIso(a.year, a.month))
    .filter((x): x is string => !!x);
  const sales_month = platformMonths[0] ?? settlementFromFilename;

  return {
    platform_code: "comico",
    sales_month,
    settlement_month: settlementFromFilename,
    records,
    errors,
  };
}
