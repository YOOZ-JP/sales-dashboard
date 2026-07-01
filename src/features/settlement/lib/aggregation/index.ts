/**
 * Aggregation engine.
 *
 * raw_records (platform-canonical) → sales_records (Excel-mirror 62-col schema)
 *
 * Handles:
 *  - title matching (alias → canonical title)
 *  - RS rate lookup (effective period + priority)
 *  - MG consumption (beginning → decrease → ending snapshot)
 *  - JPY amounts: before-tax/after-tax/income/withholding/consumption tax
 *  - KRW conversion via exchange_rates lookup
 */
import type { SalesRecord, ParseResult } from "@/features/settlement/lib/schema/sales";

export interface AggregationContext {
  settlement_month: string;              // 'YYYY-MM-01'
  platform_code: string;
  // lookups (loaded from DB or seed)
  clientAliases: Map<string, string>;    // alias → client_code
  titleAliases: Map<string, string>;     // alias (jp lower) → title_id
  rsRules: Map<string, number>;          // `${client_code}::${title_id}::${channel_code}` → rate
  defaultRs: Map<string, number>;        // fallback by client_code
  exchangeRate: number;                  // JPY → KRW for the month
  mgBalances: Map<string, number>;       // title_id → remaining MG
}

const DEFAULT_TAX_RATE = 0.10;           // JP consumption tax

export function aggregate(
  parse: ParseResult,
  ctx: AggregationContext,
): SalesRecord[] {
  const out: SalesRecord[] = [];

  for (const raw of parse.records) {
    const data = raw.data as Record<string, unknown>;
    const title_jp = String(data.title_jp ?? "").trim();
    if (!title_jp) continue;

    const client_code = ctx.clientAliases.get(String(data.client_code ?? "")) ?? String(data.client_code ?? "unknown");
    const channel_code = String(data.channel_code ?? "");
    const title_id = ctx.titleAliases.get(title_jp.toLowerCase()) ?? null;

    const gross_raw = numOr0(data.gross_jpy ?? data.total_amount_jpy);
    const before_tax_jpy = data.before_tax_jpy != null
      ? numOr0(data.before_tax_jpy)
      : gross_raw / (1 + DEFAULT_TAX_RATE);
    const after_tax_jpy = data.after_tax_jpy != null
      ? numOr0(data.after_tax_jpy)
      : gross_raw - before_tax_jpy;

    // RS lookup
    let rs_rate: number | null = null;
    if (title_id) {
      rs_rate = ctx.rsRules.get(`${client_code}::${title_id}::${channel_code}`)
            ?? ctx.rsRules.get(`${client_code}::${title_id}::*`)
            ?? null;
    }
    if (rs_rate == null) rs_rate = ctx.defaultRs.get(client_code) ?? toNumber(data.rs_rate_hint) ?? 0.5;

    const before_tax_income_jpy = data.before_tax_income_jpy != null
      ? numOr0(data.before_tax_income_jpy)
      : before_tax_jpy * rs_rate;

    const withholding = 0;                   // JP cross-border; most rows are 0
    const consumption_tax_jpy = data.consumption_tax_jpy != null
      ? numOr0(data.consumption_tax_jpy)
      : Math.round(before_tax_income_jpy * DEFAULT_TAX_RATE);
    const after_tax_income_jpy = data.after_tax_income_jpy != null
      ? numOr0(data.after_tax_income_jpy)
      : before_tax_income_jpy - withholding + 0; // mirror of sheet behavior

    // KRW conversion
    const fx = ctx.exchangeRate;
    const fee_krw = 0;
    const before_tax_krw = Math.round(before_tax_jpy * fx);
    const after_tax_krw = Math.round(after_tax_jpy * fx);
    const after_tax_income_krw = Math.round(after_tax_income_jpy * fx);
    const sales_krw = after_tax_income_krw;
    const vat_krw = Math.round(sales_krw * 0.10);
    const withholding_krw = 0;

    // MG consumption (simple FIFO-style; real implementation lives in aggregation/mg.ts)
    const mg_begin = title_id ? (ctx.mgBalances.get(title_id) ?? 0) : 0;
    const mg_decrease = Math.min(mg_begin, before_tax_income_jpy);
    const mg_end = mg_begin - mg_decrease;
    if (title_id) ctx.mgBalances.set(title_id, mg_end);

    out.push({
      title_jp,
      title_kr: null,
      channel_title_jp: strOrNull(data.channel_title_jp) ?? title_jp,
      unique_identifier: null,
      recoder: "system",
      company: "RJ",
      launch_date: null,
      sales_month: isoMonthFirstOrNull(data.sales_month) ?? parse.sales_month ?? ctx.settlement_month,
      settlement_month: isoMonthFirstOrNull(data.settlement_month) ?? ctx.settlement_month,
      deposit_month: ctx.settlement_month,
      country: "JP",
      client_code,
      channel_code,
      type: normalizeType(data.type),
      distribution_strategy: "non-ex",
      settlement_currency: "JPY",
      vehicle_currency: "KRW",
      total_amount_jpy: gross_raw,
      fee_jpy: 0,
      before_tax_jpy: Math.round(before_tax_jpy),
      after_tax_jpy: Math.round(after_tax_jpy),
      rs_label: String(data.rs_label ?? ""),
      rs_rate,
      before_tax_income_jpy: Math.round(before_tax_income_jpy),
      withholding_tax_jpy: withholding,
      consumption_tax_jpy,
      after_tax_income_jpy: Math.round(after_tax_income_jpy),
      exchange_rate: fx,
      fee_krw,
      before_tax_krw,
      after_tax_krw,
      after_tax_income_krw,
      vat_krw,
      withholding_tax_krw: withholding_krw,
      sales_krw,
      mg_begin,
      mg_increase: 0,
      mg_decrease,
      mg_end,
      note1: parse.errors.length > 0 ? parse.errors.join("; ") : null,
      note2: null,
    });
  }

  return out;
}

function numOr0(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function isoMonthFirstOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 7) + "-01";
  const s = String(v).trim();
  const m = s.match(/(\d{4})[-/.年]?\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-01`;
}
function normalizeType(v: unknown): SalesRecord["type"] {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "WT" || s === "WR" || s === "EP" || s === "EB" || s === "COMIC" || s === "NOVEL" || s === "OTHER") return s;
  return "WT";
}
