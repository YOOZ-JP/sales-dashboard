/**
 * Core domain types mirroring the 62-column 일본_신INPUT sheet.
 * Kept in sync with supabase/migrations/20260422000001_initial_schema.sql.
 */
import { z } from "zod";

export const SalesRecordSchema = z.object({
  unique_identifier: z.string().optional().nullable(),
  channel_title_jp: z.string().optional().nullable(),
  title_kr: z.string().optional().nullable(),
  title_jp: z.string(),
  recoder: z.string().optional().nullable(),
  company: z.string().default("RJ"),
  launch_date: z.string().optional().nullable(),          // ISO YYYY-MM-DD

  sales_month: z.string(),                                 // ISO YYYY-MM-01
  settlement_month: z.string(),
  deposit_month: z.string().optional().nullable(),

  country: z.string().default("JP"),
  client_code: z.string(),
  channel_code: z.string(),
  type: z.enum(["WT", "WR", "EP", "EB", "COMIC", "NOVEL", "OTHER"]).default("WT"),
  distribution_strategy: z.enum(["ex", "non-ex", "both"]).default("non-ex"),

  settlement_currency: z.string().default("JPY"),
  vehicle_currency: z.string().default("KRW"),

  // JPY
  total_amount_jpy: z.number(),
  fee_jpy: z.number().default(0),
  before_tax_jpy: z.number(),
  after_tax_jpy: z.number(),
  rs_label: z.string().optional().nullable(),
  rs_rate: z.number().min(0).max(1),
  before_tax_income_jpy: z.number(),
  withholding_tax_jpy: z.number().default(0),
  consumption_tax_jpy: z.number().default(0),
  after_tax_income_jpy: z.number(),

  // KRW
  exchange_rate: z.number().optional().nullable(),
  fee_krw: z.number().optional().nullable(),
  before_tax_krw: z.number().optional().nullable(),
  after_tax_krw: z.number().optional().nullable(),
  after_tax_income_krw: z.number().optional().nullable(),
  vat_krw: z.number().optional().nullable(),
  withholding_tax_krw: z.number().optional().nullable(),
  sales_krw: z.number().optional().nullable(),

  // MG
  mg_begin: z.number().default(0),
  mg_increase: z.number().default(0),
  mg_decrease: z.number().default(0),
  mg_end: z.number().default(0),

  note1: z.string().optional().nullable(),
  note2: z.string().optional().nullable(),
});

export type SalesRecord = z.infer<typeof SalesRecordSchema>;

/** One raw row from a platform file after initial parsing but before normalization. */
export interface RawRecord {
  row_index: number;
  data: Record<string, unknown>;           // original column → value
}

export interface PlatformDetection {
  platform_code: string;
  confidence: number;                       // 0..1
  signals: string[];                        // what matched (filename, header, sheet name)
}

export interface ParseResult {
  platform_code: string;
  sales_month: string | null;
  settlement_month: string | null;
  records: RawRecord[];
  errors: string[];
}
