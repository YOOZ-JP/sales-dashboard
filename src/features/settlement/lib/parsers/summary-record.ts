/**
 * summary-record.ts — single-record representation of a payment notice /
 * invoice / cover letter whose row-level detail lives in a sibling file
 * (or doesn't exist at all).
 *
 * The emitted RawRecord uses the canonical field names the
 * to-sales-records adapter reads, plus `source_file_kind` / `is_summary`
 * markers so downstream aggregation can recognise (and, when the sibling
 * detail file is also uploaded, exclude) these file-level rows.
 */
import type { RawRecord } from "@/features/settlement/lib/schema/sales";

export interface SummaryAmounts {
  /** 税抜 amount */
  tax_excl?: number | null;
  /** 税込 amount */
  tax_incl?: number | null;
  /** 消費税 */
  consumption_tax?: number | null;
}

/**
 * Fill the missing member of the (excl, incl, tax) trio. Only derives by
 * arithmetic on values printed in the file — 10% is used solely when the
 * file states one amount and no tax line.
 */
export function completeAmounts(a: SummaryAmounts): {
  tax_excl: number;
  tax_incl: number;
  consumption_tax: number;
} {
  let { tax_excl, tax_incl, consumption_tax } = a;
  if (tax_incl == null && tax_excl != null) {
    tax_incl = consumption_tax != null ? tax_excl + consumption_tax : Math.round(tax_excl * 1.1);
  }
  if (tax_excl == null && tax_incl != null) {
    tax_excl = consumption_tax != null ? tax_incl - consumption_tax : Math.round(tax_incl / 1.1);
  }
  if (consumption_tax == null && tax_incl != null && tax_excl != null) {
    consumption_tax = tax_incl - tax_excl;
  }
  return {
    tax_excl: tax_excl ?? 0,
    tax_incl: tax_incl ?? 0,
    consumption_tax: consumption_tax ?? 0,
  };
}

export interface SummaryRecordOptions {
  platform_code: string;
  /** Human-readable label, e.g. "MBJ 支払通知書 2026-05" */
  raw_title: string;
  /** e.g. "payment_notice_pdf", "invoice_pdf", "point_uplift_xlsx" */
  source_file_kind: string;
  client_code: string;
  channel_code: string;
  type?: string;
  title_jp?: string;
  sales_month?: string | null;
  settlement_month?: string | null;
  amounts: SummaryAmounts;
  withholding_tax_jpy?: number;
  note1?: string | null;
  /** Extra raw passthrough fields (may override the defaults above). */
  extra?: Record<string, unknown>;
}

export function buildSummaryRecord(opts: SummaryRecordOptions): RawRecord {
  const { tax_excl, tax_incl, consumption_tax } = completeAmounts(opts.amounts);
  const title = opts.title_jp ?? opts.raw_title;
  return {
    row_index: 0,
    data: {
      title_jp: title,
      channel_title_jp: title,
      raw_title: opts.raw_title,
      client_code: opts.client_code,
      channel_code: opts.channel_code,
      type: opts.type ?? "OTHER",
      sales_month: opts.sales_month ?? null,
      settlement_month: opts.settlement_month ?? null,
      total_amount_jpy: tax_incl,
      fee_jpy: 0,
      before_tax_jpy: tax_incl,
      after_tax_jpy: tax_excl,
      before_tax_income_jpy: tax_incl,
      after_tax_income_jpy: tax_excl,
      withholding_tax_jpy: opts.withholding_tax_jpy ?? 0,
      consumption_tax_jpy: consumption_tax,
      source_file_kind: opts.source_file_kind,
      is_summary: true,
      note1:
        opts.note1 ??
        `${opts.platform_code}: file-level summary (${opts.source_file_kind})`,
      ...(opts.extra ?? {}),
    },
  };
}
