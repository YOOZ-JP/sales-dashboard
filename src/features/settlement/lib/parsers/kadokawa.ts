/**
 * KADOKAWA parser.
 *
 * Primary raw file: `支払通知書_YYYYMMDD_<取引先>.csv` (Shift-JIS).
 * A PDF (`01_<取引先>_Rnnnnnn_…pdf`) exists with the same content but the CSV
 * is easier to parse and sums to the exact aggregate shown at the top.
 *
 * Key columns:
 *   取引先コード, 取引先名, 発行日, 適格事業者番号, 支払日, 支払方法, 振込銀行,
 *   計上日付, ジャンル, 書名, 版数, 勘定科目, 摘要, 消費税率, 軽減税率,
 *   合計金額（明細）, 所得税等（明細）, 合計金額, 合計消費税金額, ..., 支払元名称
 *
 * Detail rows (one per 書名 × 計上日付 month) have:
 *   合計金額（明細）= tax-inclusive royalty for that 書名/month
 *
 * Aggregate columns repeat the grand total on every row:
 *   合計金額 = sum of all 合計金額（明細）= the single GT before_tax_income_jpy
 *
 * Rules:
 *   - Skip the admin row 「消費税端数差額調整」 (zero in our data).
 *   - Collapse all "盗掘王 …" variants into one series → channel_title_jp = "盗掘王"
 *     sum of all 合計金額（明細）rows = GT before_tax_income_jpy
 *   - after_tax_income = sum / 1.10 (but an exact figure is the aggregate
 *     「合計金額 - 合計消費税金額」 which we prefer).
 */
import iconv from "iconv-lite";
import Papa from "papaparse";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import aliases from "../../data/aliases/kadokawa.json" with { type: "json" };

type Row = Record<string, string>;

function num(s: string | undefined): number {
  if (!s) return 0;
  return Number(String(s).replace(/,/g, "").trim() || 0);
}

function decodeShiftJis(buf: Buffer): string {
  return iconv.decode(buf, aliases.csv_encoding); // "shift_jis"
}

function matchSeries(title: string): { series: string; gt_title: string } | null {
  const t = title.trim();
  for (const rule of aliases.series_rollup) {
    const re = new RegExp(rule.pattern);
    if (re.test(t)) return { series: rule.series_key, gt_title: rule.gt_title };
  }
  return null;
}

export async function parseKadokawa({ buffer, filename }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  const errors: string[] = [];

  // Only the CSV is a line-item source. PDF has the same data but harder.
  const isCsv = /\.csv$/i.test(filename);
  if (!isCsv) {
    return {
      platform_code: "kadokawa",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`skipped: ${filename} (only CSV is parsed for KADOKAWA)`],
    };
  }

  const text = decodeShiftJis(buffer);
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  const rows: Row[] = parsed.data ?? [];
  if (!rows.length) {
    return { platform_code: "kadokawa", sales_month: null, settlement_month: null, records: [], errors: ["csv empty"] };
  }

  // Aggregate per series.
  const seriesAgg = new Map<string, { gt_title: string; incomeTaxIncl: number; raw_titles: Set<string>; months: Set<string> }>();
  const skipTitles = new Set<string>(aliases.skip_titles ?? []);
  const adjustmentTitles = new Set<string>(aliases.adjustment_titles ?? []);
  const adjustmentAttachTo = aliases.adjustment_attaches_to ?? null;

  function bucketFor(seriesKey: string, gt_title: string) {
    const entry = seriesAgg.get(seriesKey) ?? {
      gt_title,
      incomeTaxIncl: 0,
      raw_titles: new Set<string>(),
      months: new Set<string>(),
    };
    seriesAgg.set(seriesKey, entry);
    return entry;
  }

  for (const r of rows) {
    const title = (r["書名"] ?? "").trim();
    if (!title || skipTitles.has(title)) continue;

    const detailAmt = num(r["合計金額（明細）"]);
    if (detailAmt === 0) continue;

    // 消費税端数差額調整 — apportion to the configured series.
    if (adjustmentTitles.has(title)) {
      if (adjustmentAttachTo) {
        const matched = matchSeries(adjustmentAttachTo);
        const series = matched?.series ?? adjustmentAttachTo;
        const gt_title = matched?.gt_title ?? adjustmentAttachTo;
        const e = bucketFor(series, gt_title);
        e.incomeTaxIncl += detailAmt;
        e.raw_titles.add(title);
        if (r["計上日付"]) e.months.add(r["計上日付"]);
      }
      continue;
    }

    const matched = matchSeries(title);
    if (!matched) {
      errors.push(`unclassified title: ${title}`);
      continue;
    }
    const e = bucketFor(matched.series, matched.gt_title);
    e.incomeTaxIncl += detailAmt;
    e.raw_titles.add(title);
    if (r["計上日付"]) e.months.add(r["計上日付"]);
  }

  // Determine settlement / sales month based on the CSV header cells.
  const first = rows[0]!;
  const payDate = (first["支払日"] ?? "").replace(/\//g, "-"); // e.g. "20260331"
  const isoPay = payDate.length === 8
    ? `${payDate.slice(0, 4)}-${payDate.slice(4, 6)}-${payDate.slice(6, 8)}`
    : null;
  const settlementMonth = isoPay ? `${isoPay.slice(0, 7)}-01` : null;
  // The "representative" sales month is the newest 計上日付 across details
  // (GT uses the end-of-window month, typically the final 計上日付).
  let latestCal: string | null = null;
  for (const r of rows) {
    const c = (r["計上日付"] ?? "").trim();
    if (!c) continue;
    if (!latestCal || c > latestCal) latestCal = c;
  }
  const salesMonth = latestCal ? latestCal.slice(0, 7).replace(/\//g, "-") + "-01" : null;

  const records: ParseResult["records"] = [];
  let idx = 0;
  for (const [, agg] of seriesAgg) {
    idx++;
    const beforeTaxIncome = agg.incomeTaxIncl;
    const afterTaxIncome = Math.round(beforeTaxIncome / (1 + aliases.rules.tax_rate));
    const consumptionTax = beforeTaxIncome - afterTaxIncome;

    records.push({
      row_index: idx,
      data: {
        sales_month: salesMonth,
        client_code: aliases.client_code,
        channel_code: aliases.channel_code,
        type: aliases.rules.type,
        title_jp: agg.gt_title,
        channel_title_jp: agg.gt_title,
        raw_titles: [...agg.raw_titles],
        months_covered: [...agg.months].sort(),
        before_tax_jpy: beforeTaxIncome,
        after_tax_jpy: afterTaxIncome,
        before_tax_income_jpy: beforeTaxIncome,
        after_tax_income_jpy: afterTaxIncome,
        consumption_tax_jpy: consumptionTax,
        total_amount_jpy: beforeTaxIncome,
        gross_jpy: beforeTaxIncome,
      },
    });
  }

  return {
    platform_code: "kadokawa",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}
