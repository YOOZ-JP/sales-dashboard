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
 * Emission rules (matched against the accountant's INPUT sheet):
 *   - One record per non-zero detail row. The same 書名 legitimately appears
 *     several times with different 勘定科目 (原稿料 / 版権料 / 出版印税 /
 *     二次的利用印税) and amounts — these are distinct GT rows, not dupes.
 *   - 勘定科目 → type via aliases.account_type_map (原稿料→MF, 出版印税→PP,
 *     版権料→PP, 二次的利用印税→EB); unmapped accounts fall back to rules.type.
 *   - Exception: series listed in aliases.series_rollup (盗掘王 incl. 分冊版)
 *     keep the historical behaviour of collapsing into one aggregated record,
 *     and the admin row 「消費税端数差額調整」 is apportioned into the
 *     configured rollup series.
 *
 * Dates:
 *   - settlement_month (per record) = the exact 支払日 (e.g. 2026-05-29);
 *     the GT sheet stores the full payment date, so the transformer preserves
 *     it. The file-level ParseResult.settlement_month stays first-of-month
 *     for batch bucketing.
 *   - sales_month (per record) = the end of the accounting period, i.e. the
 *     last day of the month before the 支払日 month. Individual 計上日付 can
 *     post into the payment month (e.g. 素材費 posted 05/14 paid 05/29) but
 *     the GT books the whole notice under the closed period (2026-04-30).
 *
 * Amounts (per detail row, 合計金額（明細） is tax-inclusive):
 *   after_tax_income = round(amount / 1.1), consumption_tax = amount − after.
 */
import iconv from "iconv-lite";
import Papa from "papaparse";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import aliases from "../../data/aliases/kadokawa.json" with { type: "json" };
import { parseInvoiceXlsx, parseInvoicePdf } from "./invoice-common";
import { extractPdfText, findMonth } from "./pdf-text";
import { buildSummaryRecord } from "./summary-record";

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

/** Last day of the month preceding the given ISO date (accounting period end). */
function periodEndBefore(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1, 0)); // day 0 of month m = last day of m-1
  return d.toISOString().slice(0, 10);
}

function splitAmount(taxIncl: number): { after: number; tax: number } {
  const after = Math.round(taxIncl / (1 + aliases.rules.tax_rate));
  return { after, tax: taxIncl - after };
}

function parseIsoDateLike(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const separated = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (separated) {
    return `${separated[1]}-${separated[2].padStart(2, "0")}-${separated[3].padStart(2, "0")}`;
  }
  return null;
}

/**
 * 支払通知書 PDF (01_*.pdf). Text stream groups the header labels then the
 * numbers, so we take the first figures after the 合計金額（消費税込）label
 * block: 合計金額, 所得税等, 送金手数料, 差引支払金額.
 */
async function parseKadokawaNoticePdf(filename: string, buffer: Buffer): Promise<ParseResult> {
  const text = await extractPdfText(buffer, { maxPages: 2 });
  const numsAfterLabel = text.match(
    /合計金額（消費税込）[^0-9]{0,120}([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/,
  );
  if (!text.trim() || !numsAfterLabel) {
    return {
      platform_code: "kadokawa",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`kadokawa: could not extract totals from 支払通知書 PDF (${filename})`],
    };
  }
  const totalIncl = Number(numsAfterLabel[1].replace(/,/g, ""));
  const withholding = Number(numsAfterLabel[2].replace(/,/g, ""));
  const payMonth = findMonth(text, [/支払日\s*(\d{4})年(\d{1,2})月/]);
  const payDay = text.match(/支払日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const payIso = payDay
    ? `${payDay[1]}-${payDay[2].padStart(2, "0")}-${payDay[3].padStart(2, "0")}`
    : null;
  const salesMonth = payIso ? periodEndBefore(payIso) : null;

  return {
    platform_code: "kadokawa",
    sales_month: salesMonth,
    settlement_month: payMonth,
    records: [
      buildSummaryRecord({
        platform_code: "kadokawa",
        raw_title: `KADOKAWA 支払通知書 ${payMonth ?? ""}`.trim(),
        source_file_kind: "payment_notice_pdf",
        client_code: aliases.client_code,
        channel_code: aliases.channel_code,
        sales_month: salesMonth,
        settlement_month: payIso ?? payMonth,
        amounts: { tax_incl: totalIncl },
        withholding_tax_jpy: withholding,
        note1: "kadokawa: 支払通知書 PDF summary — line items come from the CSV twin",
      }),
    ],
    errors: [],
  };
}

export async function parseKadokawa({ buffer, filename }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  const errors: string[] = [];

  // RIVERSE-issued MG / 定価差額 invoices (PDF + XLSX twins).
  if (/【請求書】/.test(filename)) {
    const ctx = {
      platform_code: "kadokawa",
      client_code: aliases.client_code,
      channel_code: aliases.channel_code,
      type: "OTHER",
      note: "kadokawa: RIVERSE→KADOKAWA invoice (MG/定価差額)",
    };
    return /\.pdf$/i.test(filename)
      ? parseInvoicePdf(filename, buffer, ctx)
      : parseInvoiceXlsx(filename, buffer, ctx);
  }

  // 支払通知書 PDF — same statement as the CSV; emit a file-level summary
  // record so the file is represented (the CSV stays the line-item source).
  if (/\.pdf$/i.test(filename)) {
    return parseKadokawaNoticePdf(filename, buffer);
  }

  // Only the CSV is a line-item source.
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

  // Determine settlement / sales month based on the CSV header cells.
  const first = rows[0]!;
  const payDate = first["支払日"];
  const isoPay = parseIsoDateLike(payDate);
  const settlementMonth = isoPay ? `${isoPay.slice(0, 7)}-01` : null;
  // Accounting period end: last day of the month before payment. Fallback
  // when 支払日 is unreadable: newest 計上日付 across details.
  let latestCal: string | null = null;
  for (const r of rows) {
    const c = (r["計上日付"] ?? "").trim();
    if (!c) continue;
    if (!latestCal || c > latestCal) latestCal = c;
  }
  const salesMonth = isoPay
    ? periodEndBefore(isoPay)
    : latestCal
      ? latestCal.slice(0, 7).replace(/\//g, "-") + "-01"
      : null;

  const accountTypeMap: Record<string, string> = aliases.account_type_map ?? {};
  const skipTitles = new Set<string>(aliases.skip_titles ?? []);
  const adjustmentTitles = new Set<string>(aliases.adjustment_titles ?? []);
  const adjustmentAttachTo = aliases.adjustment_attaches_to ?? null;

  // Rollup buckets for configured series (盗掘王 分冊版 variants → one row).
  const seriesAgg = new Map<string, { gt_title: string; incomeTaxIncl: number; raw_titles: Set<string>; months: Set<string> }>();
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

  const records: ParseResult["records"] = [];
  let idx = 0;
  const baseDates = {
    sales_month: salesMonth,
    settlement_month: isoPay ?? settlementMonth,
  };

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
    if (matched) {
      const e = bucketFor(matched.series, matched.gt_title);
      e.incomeTaxIncl += detailAmt;
      e.raw_titles.add(title);
      if (r["計上日付"]) e.months.add(r["計上日付"]);
      continue;
    }

    // Default path: one record per non-zero detail row.
    const account = (r["勘定科目"] ?? "").trim();
    const { after, tax } = splitAmount(detailAmt);
    records.push({
      row_index: ++idx,
      data: {
        ...baseDates,
        client_code: aliases.client_code,
        channel_code: aliases.channel_code,
        type: accountTypeMap[account] ?? aliases.rules.type,
        title_jp: title,
        channel_title_jp: title,
        raw_title: title,
        account,
        accounting_date: (r["計上日付"] ?? "").trim() || null,
        before_tax_jpy: detailAmt,
        after_tax_jpy: after,
        before_tax_income_jpy: detailAmt,
        after_tax_income_jpy: after,
        consumption_tax_jpy: tax,
        total_amount_jpy: detailAmt,
        gross_jpy: detailAmt,
      },
    });
  }

  for (const [, agg] of seriesAgg) {
    const beforeTaxIncome = agg.incomeTaxIncl;
    const { after: afterTaxIncome, tax: consumptionTax } = splitAmount(beforeTaxIncome);
    records.push({
      row_index: ++idx,
      data: {
        ...baseDates,
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
