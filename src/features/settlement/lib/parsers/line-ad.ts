/**
 * LINE Ad (広告印税 / 外部PF) parser — Shift-JIS CSV.
 *
 * Raw file:
 *   YYYYMMDD_N{顧客コード}_R{帳票No}_N{顧客コード}_(株)RIVERSE様.csv
 *   located under .../202603/202603_LINE_AD/
 *
 * Header row (22 cols):
 *   帳票No, 顧客コード, 顧客名, お支払内容, 対象期間, 通知日付, 支払期日,
 *   税抜金額(10%), 税抜金額(対象外), 消費税(10%), 源泉税, 合計金額, 備考,
 *   報告年月, 商品ID, コード, タイトル, 販売形式, 販売地域,
 *   売上額(基準額), 配分料率, 支払額
 *
 * Each data row is one (title × videoad placement). Summary / invoice-level
 * fields (税抜金額(10%), 合計金額, 消費税(10%)) repeat on every row — those
 * describe the payout envelope, NOT the per-title split. Per-title amounts are
 * in `売上額(基準額)` (gross) and `支払額` (royalty share after RS).
 *
 * Ground Truth mapping (reverse-engineered against 202604, 71 rows):
 *   after_tax_jpy         = round(売上額(基準額))
 *   total_amount_jpy      = round(after_tax_jpy × 1.10)
 *   before_tax_jpy        = total_amount_jpy                   (fee_jpy = 0)
 *   after_tax_income_jpy  = round(支払額)
 *   consumption_tax_jpy   = floor(after_tax_income_jpy × 0.10) ← floor, NOT round
 *   before_tax_income_jpy = after_tax_income_jpy + consumption_tax_jpy
 *   rs_rate               = parse "20.00%" → 0.20
 *   type                  = "AD"
 *   distribution_strategy = "non-ex"
 *   sales_month           = 報告年月 → first of that month
 *   channel_title_jp      = タイトル (raw, verbatim)
 *
 * All rules live in `data/aliases/line-ad.json` so the parser stays declarative.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { toNumber } from "./common";
import iconv from "iconv-lite";
import Papa from "papaparse";
import aliases from "../../data/aliases/line-ad.json" with { type: "json" };

type CsvRow = {
  "帳票No"?: string;
  "顧客コード"?: string;
  "顧客名"?: string;
  "お支払内容"?: string;
  "対象期間"?: string;
  "通知日付"?: string;
  "支払期日"?: string;
  "税抜金額(10%)"?: string;
  "税抜金額(対象外)"?: string;
  "消費税(10%)"?: string;
  "源泉税"?: string;
  "合計金額"?: string;
  "備考"?: string;
  "報告年月"?: string;
  "商品ID"?: string;
  "コード"?: string;
  "タイトル"?: string;
  "販売形式"?: string;
  "販売地域"?: string;
  "売上額(基準額)"?: string;
  "配分料率"?: string;
  "支払額"?: string;
};

const ENCODING = aliases.encoding as string;
const DEFAULT_TYPE = aliases.defaults.type;
const DEFAULT_DIST = aliases.defaults.distribution_strategy;
const COUNTRY = aliases.defaults.country;
const CLIENT = aliases.client_code;
const CHANNEL = aliases.channel_code;

/** "20.00%" → 0.20, "0.2" → 0.20, "20" → 0.20 */
function parseRate(s: unknown): number {
  if (s == null || s === "") return 0;
  const str = String(s).trim();
  const pct = str.match(/^([\d.]+)\s*%$/);
  if (pct) return Number(pct[1]) / 100;
  const n = Number(str);
  if (!isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/** "2026/02/28" or "2026-02-28" → "2026-02-01" */
function salesMonthFromReport(s: unknown): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{4})[-/年]?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-01`;
}

/** "2026/04/30" → "2026-04-30" */
function isoDate(s: unknown): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{4})[-/年]?(\d{1,2})[-/月]?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/** Extract settlement month-end from filename prefix YYYYMMDD. */
function settlementFromFilename(filename: string): string | null {
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})_/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export async function parseLineAd({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename)) {
    return { platform_code: "line_ad", sales_month: null, settlement_month: null, records: [], errors: [] };
  }
  const text = iconv.decode(buffer, ENCODING);
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: string[] = [];
  for (const e of parsed.errors) errors.push(`CSV parse: ${e.message} (row ${e.row})`);

  const records: RawRecord[] = [];
  let salesMonth: string | null = null;
  let notifyDate: string | null = null;
  let payDue: string | null = null;

  let idx = 0;
  for (const r of parsed.data) {
    // Must have both 帳票No and タイトル to be a real row (drops trailing blanks / totals)
    const title = (r["タイトル"] ?? "").trim();
    const ledger = (r["帳票No"] ?? "").trim();
    if (!ledger || !title) continue;

    const sm = salesMonthFromReport(r["報告年月"]);
    if (!salesMonth && sm) salesMonth = sm;
    if (!notifyDate) notifyDate = isoDate(r["通知日付"]);
    if (!payDue) payDue = isoDate(r["支払期日"]);

    const rawSales = toNumber(r["売上額(基準額)"]);
    const rawPay = toNumber(r["支払額"]);
    const withholding = toNumber(r["源泉税"]);

    // === Ground-truth formulas ===
    const after_tax_jpy = Math.round(rawSales);
    const total_amount_jpy = Math.round(after_tax_jpy * 1.10);
    const before_tax_jpy = total_amount_jpy; // fee_jpy = 0

    const after_tax_income_jpy = Math.round(rawPay);
    const consumption_tax_jpy = Math.floor(after_tax_income_jpy * 0.10);
    const before_tax_income_jpy = after_tax_income_jpy + consumption_tax_jpy;

    const rs_rate = parseRate(r["配分料率"]);
    const rs_label = (r["配分料率"] ?? "").toString().trim() || null;

    records.push({
      row_index: idx++,
      data: {
        sales_month: sm,
        country: COUNTRY,
        client_code: CLIENT,
        channel_code: CHANNEL,
        type: DEFAULT_TYPE,
        distribution_strategy: DEFAULT_DIST,

        title_jp: title,
        channel_title_jp: title,

        // Amounts (GT-aligned)
        gross_jpy: total_amount_jpy,
        total_amount_jpy,
        fee_jpy: 0,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        withholding_tax_jpy: withholding,
        consumption_tax_jpy,
        after_tax_income_jpy,
        rs_rate,
        rs_label,

        // Raw passthrough for audit
        raw_title: title,
        raw_product_id: (r["商品ID"] ?? "").trim() || null,
        raw_format: (r["販売形式"] ?? "").trim() || null,
        raw_region: (r["販売地域"] ?? "").trim() || null,
        raw_period: (r["対象期間"] ?? "").trim() || null,
        raw_sales_amount: rawSales,
        raw_pay_amount: rawPay,
        raw_ledger_no: ledger,
        raw_customer_code: (r["顧客コード"] ?? "").trim() || null,
        raw_pay_content: (r["お支払内容"] ?? "").trim() || null,
        notify_date: isoDate(r["通知日付"]),
        pay_due: isoDate(r["支払期日"]),
      },
    });
  }

  // Settlement date from filename prefix YYYYMMDD (end-of-month notify)
  const settlement_day = settlementFromFilename(filename);
  // Aggregation engine expects first-of-month; keep that convention.
  const settlement_month =
    settlement_day != null ? `${settlement_day.slice(0, 7)}-01` : null;

  return {
    platform_code: "line_ad",
    sales_month: salesMonth,
    settlement_month,
    records,
    errors,
  };
}
