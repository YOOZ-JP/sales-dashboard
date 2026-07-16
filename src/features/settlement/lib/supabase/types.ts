/**
 * Typed Supabase schema — hand-written from
 *   supabase/migrations/20260422000001_initial_schema.sql
 *   supabase/migrations/20260422000002_extras_and_domestic_agent.sql
 *
 * Regenerate with:
 *   supabase gen types typescript \
 *     --project-id "$SUPABASE_PROJECT_ID" \
 *     --schema public > web/lib/supabase/types.ts
 *
 * Until the CLI can reach a live project, this file is the source of truth
 * for the importer + query layer.
 *
 * Note: we avoid self-referencing `Database["public"][...]` in Update
 * definitions because that form collapses to `never` under certain TS
 * inference paths. Each Update type is spelled out inline instead.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ------------------------------------------------------------------ //
// Row / Insert / Update pieces                                       //
// ------------------------------------------------------------------ //

export type PlatformRow = {
  id: string;
  code: string;
  name_jp: string;
  name_en: string | null;
  folder_prefix: string | null;
  settlement_lag_m: number | null;
  notes: string | null;
  created_at: string;
}
export type PlatformInsert = {
  id?: string;
  code: string;
  name_jp: string;
  name_en?: string | null;
  folder_prefix?: string | null;
  settlement_lag_m?: number | null;
  notes?: string | null;
  created_at?: string;
}

export type ClientRow = {
  id: string;
  code: string;
  display_name: string;
  aliases: string[];
  country: string | null;
  tax_type: string | null;
  created_at: string;
}
export type ClientInsert = {
  id?: string;
  code: string;
  display_name: string;
  aliases?: string[];
  country?: string | null;
  tax_type?: string | null;
  created_at?: string;
}

export type ChannelRow = {
  id: string;
  code: string;
  platform_id: string | null;
  client_id: string | null;
  display_name: string | null;
  created_at: string;
}
export type ChannelInsert = {
  id?: string;
  code: string;
  platform_id?: string | null;
  client_id?: string | null;
  display_name?: string | null;
  created_at?: string;
}

export type TitleRow = {
  id: string;
  title_kr: string | null;
  title_jp: string;
  type: "WT" | "EP" | "COMIC" | "NOVEL" | "OTHER" | null;
  distribution_strategy: "ex" | "non-ex" | "both" | null;
  launch_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
export type TitleInsert = {
  id?: string;
  title_kr?: string | null;
  title_jp: string;
  type?: "WT" | "EP" | "COMIC" | "NOVEL" | "OTHER" | null;
  distribution_strategy?: "ex" | "non-ex" | "both" | null;
  launch_date?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type TitleAliasRow = {
  id: string;
  title_id: string;
  alias: string;
  source: string | null;
}
export type TitleAliasInsert = {
  id?: string;
  title_id: string;
  alias: string;
  source?: string | null;
}

export type RsRuleRow = {
  id: string;
  title_id: string | null;
  channel_id: string | null;
  client_id: string | null;
  rs_rate: number;
  rs_label: string | null;
  effective_from: string;
  effective_to: string | null;
  priority: number | null;
  notes: string | null;
  created_at: string;
}
export type RsRuleInsert = {
  id?: string;
  title_id?: string | null;
  channel_id?: string | null;
  client_id?: string | null;
  rs_rate: number;
  rs_label?: string | null;
  effective_from?: string;
  effective_to?: string | null;
  priority?: number | null;
  notes?: string | null;
  created_at?: string;
}

export type ExchangeRateRow = {
  rate_date: string;
  jpy_to_krw: number;
  source: string | null;
}
export type ExchangeRateInsert = {
  rate_date: string;
  jpy_to_krw: number;
  source?: string | null;
}

export type RawUploadRow = {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number | null;
  content_type: string | null;
  platform_id: string | null;
  platform_code: string | null;
  sales_month: string | null;
  settlement_month: string | null;
  status:
    | "uploaded"
    | "parsing"
    | "parsed"
    | "aggregated"
    | "failed"
    | "archived";
  detection_confidence: number | null;
  parse_error: string | null;
  parsed_rows: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
  parsed_at: string | null;
  sha256: string | null;
  archived_at: string | null;
}
export type RawUploadInsert = {
  id?: string;
  filename: string;
  storage_path: string;
  size_bytes?: number | null;
  content_type?: string | null;
  platform_id?: string | null;
  platform_code?: string | null;
  sales_month?: string | null;
  settlement_month?: string | null;
  status?:
    | "uploaded"
    | "parsing"
    | "parsed"
    | "aggregated"
    | "failed"
    | "archived";
  detection_confidence?: number | null;
  parse_error?: string | null;
  parsed_rows?: number | null;
  uploaded_by?: string | null;
  uploaded_at?: string;
  parsed_at?: string | null;
  sha256?: string | null;
  archived_at?: string | null;
}

export type RawRecordRow = {
  id: string;
  upload_id: string;
  row_index: number;
  data: Json;
  created_at: string;
}
export type RawRecordInsert = {
  id?: string;
  upload_id: string;
  row_index: number;
  data: Json;
  created_at?: string;
}

// sales_records has 60+ columns — factored below

export type MgBalanceRow = {
  id: string;
  title_id: string;
  client_id: string | null;
  as_of_month: string;
  beginning_mg: number | null;
  increase_mg: number | null;
  decrease_mg: number | null;
  ending_mg: number | null;
  notes: string | null;
}
export type MgBalanceInsert = {
  id?: string;
  title_id: string;
  client_id?: string | null;
  as_of_month: string;
  beginning_mg?: number | null;
  increase_mg?: number | null;
  decrease_mg?: number | null;
  notes?: string | null;
}

export type SettlementComparisonRunStatus = "processing" | "completed" | "failed";

export type SettlementComparisonRunRow = {
  id: string;
  month: string;                       // YYYY-MM-01
  status: SettlementComparisonRunStatus;
  answer_filename: string;
  answer_storage_path: string;
  answer_sha256: string | null;
  candidate_filename: string | null;
  candidate_storage_path: string | null;
  candidate_sha256: string | null;
  source_upload_ids: string[] | null;
  source_manifest: Json | null;
  summary: Json | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export type SettlementComparisonRunInsert = {
  id?: string;
  month: string;
  status?: SettlementComparisonRunStatus;
  answer_filename: string;
  answer_storage_path: string;
  answer_sha256?: string | null;
  candidate_filename?: string | null;
  candidate_storage_path?: string | null;
  candidate_sha256?: string | null;
  source_upload_ids?: string[] | null;
  source_manifest?: Json | null;
  summary?: Json | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
}

export type ComparisonDiffCategory = "missing" | "extra" | "field" | "formula";
export type ComparisonDiffReviewStatus =
  | "pending"
  | "candidate_correct"
  | "golden_correct"
  | "needs_review"
  | "resolved";

export type SettlementComparisonDiffRow = {
  id: string;
  run_id: string;
  category: ComparisonDiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  candidate_value: Json | null;
  golden_value: Json | null;
  review_status: ComparisonDiffReviewStatus;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
}
export type SettlementComparisonDiffInsert = {
  id?: string;
  run_id: string;
  category: ComparisonDiffCategory;
  identity_channel?: string | null;
  identity_type?: string | null;
  identity_title?: string | null;
  field?: string | null;
  candidate_value?: Json | null;
  golden_value?: Json | null;
  review_status?: ComparisonDiffReviewStatus;
  review_note?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  created_at?: string;
}

export type AuditLogRow = {
  id: number;
  actor: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before_data: Json | null;
  after_data: Json | null;
  at: string;
}
export type AuditLogInsert = {
  id?: number;
  actor?: string | null;
  entity: string;
  entity_id?: string | null;
  action: string;
  before_data?: Json | null;
  after_data?: Json | null;
  at?: string;
}

// ------------------------------------------------------------------ //
// sales_records row/insert                                           //
// ------------------------------------------------------------------ //

export type SalesRecordRow = {
  id: string;
  upload_id: string | null;
  raw_record_id: string | null;

  unique_identifier: string | null;
  unique_id: string | null;
  channel_title_jp: string | null;
  title_id: string | null;
  title_kr: string | null;
  title_jp: string | null;

  updated: string | null;
  updated_at: string;
  recoder: string | null;
  company: string | null;
  launch_date: string | null;

  sales_month: string | null;
  settlement_month: string | null;
  deposit_month: string | null;
  /** Month bucket this row belongs to (YYYY-MM-01). */
  settlement_batch: string | null;

  country: string | null;
  client_id: string | null;
  channel_id: string | null;
  type: string | null;
  distribution_strategy: string | null;

  settlement_currency: string | null;
  vehicle_currency: string | null;
  total_amount_jpy: number | null;
  fee_jpy: number | null;
  before_tax_jpy: number | null;
  after_tax_jpy: number | null;
  rs_label: string | null;
  rs_rate: number | null;
  before_tax_income_jpy: number | null;
  withholding_tax_jpy: number | null;
  consumption_tax_jpy: number | null;
  after_tax_income_jpy: number | null;
  after_tax_income_jpy_a: number | null;
  after_tax_income_jpy_b: number | null;

  rate_jpy_krw: number | null;
  rate_krw_krw: number | null;
  col31: number | null;
  exchange_rate: number | null;
  fee_krw: number | null;
  before_tax_krw: number | null;
  after_tax_krw: number | null;
  after_tax_income_krw: number | null;
  vat_krw: number | null;
  withholding_tax_krw: number | null;
  sales_krw: number | null;

  mg_begin: number | null;
  mg_increase: number | null;
  mg_decrease: number | null;
  mg_end: number | null;

  note1: string | null;
  note2: string | null;

  extra_45: number | null;
  extra_46: number | null;
  extra_47: number | null;
  extra_48: number | null;
  extra_49: number | null;
  extra_50: number | null;
  extra_51: number | null;
  extra_52: number | null;
  extra_53: string | null;
  extra_54: number | null;
  extra_55: number | null;
  extra_56: number | null;
  extra_57: number | null;
  extra_58: string | null;
  extra_59: number | null;
  extra_60: number | null;
  extra_61: number | null;
  extra_62: number | null;

  created_at: string;
}

export type SalesRecordInsert = {
  id?: string;
  upload_id?: string | null;
  raw_record_id?: string | null;

  unique_identifier?: string | null;
  unique_id?: string | null;
  channel_title_jp?: string | null;
  title_id?: string | null;
  title_kr?: string | null;
  title_jp?: string | null;

  updated?: string | null;
  updated_at?: string;
  recoder?: string | null;
  company?: string | null;
  launch_date?: string | null;

  sales_month?: string | null;
  settlement_month?: string | null;
  deposit_month?: string | null;
  settlement_batch?: string | null;

  country?: string | null;
  client_id?: string | null;
  channel_id?: string | null;
  type?: string | null;
  distribution_strategy?: string | null;

  settlement_currency?: string | null;
  vehicle_currency?: string | null;
  total_amount_jpy?: number | null;
  fee_jpy?: number | null;
  before_tax_jpy?: number | null;
  after_tax_jpy?: number | null;
  rs_label?: string | null;
  rs_rate?: number | null;
  before_tax_income_jpy?: number | null;
  withholding_tax_jpy?: number | null;
  consumption_tax_jpy?: number | null;
  after_tax_income_jpy?: number | null;
  after_tax_income_jpy_a?: number | null;
  after_tax_income_jpy_b?: number | null;

  rate_jpy_krw?: number | null;
  rate_krw_krw?: number | null;
  col31?: number | null;
  exchange_rate?: number | null;
  fee_krw?: number | null;
  before_tax_krw?: number | null;
  after_tax_krw?: number | null;
  after_tax_income_krw?: number | null;
  vat_krw?: number | null;
  withholding_tax_krw?: number | null;
  sales_krw?: number | null;

  mg_begin?: number | null;
  mg_increase?: number | null;
  mg_decrease?: number | null;
  mg_end?: number | null;

  note1?: string | null;
  note2?: string | null;

  extra_45?: number | null;
  extra_46?: number | null;
  extra_47?: number | null;
  extra_48?: number | null;
  extra_49?: number | null;
  extra_50?: number | null;
  extra_51?: number | null;
  extra_52?: number | null;
  extra_53?: string | null;
  extra_54?: number | null;
  extra_55?: number | null;
  extra_56?: number | null;
  extra_57?: number | null;
  extra_58?: string | null;
  extra_59?: number | null;
  extra_60?: number | null;
  extra_61?: number | null;
  extra_62?: number | null;

  created_at?: string;
}

// ------------------------------------------------------------------ //
// Main Database type                                                 //
// ------------------------------------------------------------------ //

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      platforms: {
        Row: PlatformRow;
        Insert: PlatformInsert;
        Update: Partial<PlatformInsert>;
        Relationships: [];
      };
      clients: {
        Row: ClientRow;
        Insert: ClientInsert;
        Update: Partial<ClientInsert>;
        Relationships: [];
      };
      channels: {
        Row: ChannelRow;
        Insert: ChannelInsert;
        Update: Partial<ChannelInsert>;
        Relationships: [];
      };
      titles: {
        Row: TitleRow;
        Insert: TitleInsert;
        Update: Partial<TitleInsert>;
        Relationships: [];
      };
      title_aliases: {
        Row: TitleAliasRow;
        Insert: TitleAliasInsert;
        Update: Partial<TitleAliasInsert>;
        Relationships: [];
      };
      rs_rules: {
        Row: RsRuleRow;
        Insert: RsRuleInsert;
        Update: Partial<RsRuleInsert>;
        Relationships: [];
      };
      exchange_rates: {
        Row: ExchangeRateRow;
        Insert: ExchangeRateInsert;
        Update: Partial<ExchangeRateInsert>;
        Relationships: [];
      };
      raw_uploads: {
        Row: RawUploadRow;
        Insert: RawUploadInsert;
        Update: Partial<RawUploadInsert>;
        Relationships: [];
      };
      raw_records: {
        Row: RawRecordRow;
        Insert: RawRecordInsert;
        Update: Partial<RawRecordInsert>;
        Relationships: [];
      };
      sales_records: {
        Row: SalesRecordRow;
        Insert: SalesRecordInsert;
        Update: Partial<SalesRecordInsert>;
        Relationships: [];
      };
      mg_balances: {
        Row: MgBalanceRow;
        Insert: MgBalanceInsert;
        Update: Partial<MgBalanceInsert>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLogRow;
        Insert: AuditLogInsert;
        Update: Partial<AuditLogInsert>;
        Relationships: [];
      };
      settlement_comparison_runs: {
        Row: SettlementComparisonRunRow;
        Insert: SettlementComparisonRunInsert;
        Update: Partial<SettlementComparisonRunInsert>;
        Relationships: [];
      };
      settlement_comparison_diffs: {
        Row: SettlementComparisonDiffRow;
        Insert: SettlementComparisonDiffInsert;
        Update: Partial<SettlementComparisonDiffInsert>;
        Relationships: [];
      };
    };
    Views: {
      v_monthly_summary: {
        Row: {
          settlement_month: string;
          row_count: number;
          total_jpy: number | null;
          before_tax_income_jpy: number | null;
          sales_krw: number | null;
        };
        Relationships: [];
      };
      v_monthly_summary_by_client: {
        Row: {
          settlement_month: string;
          client_bucket: string;
          row_count: number;
          total_jpy: number | null;
          before_tax_income_jpy: number | null;
          after_tax_income_jpy: number | null;
          sales_krw: number | null;
        };
        Relationships: [];
      };
    };
    Functions: { [K in never]: never };
    Enums: { [K in never]: never };
    CompositeTypes: { [K in never]: never };
  };
};

// ------------------------------------------------------------------ //
// Convenience aliases                                                //
// ------------------------------------------------------------------ //

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type InsertTables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
