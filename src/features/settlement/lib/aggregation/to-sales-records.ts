/**
 * to-sales-records.ts
 *
 * Transforms parser emissions (RawRecord) or already-aggregated SalesRecord
 * rows into `sales_records` table Insert payloads ready for Supabase.
 *
 * Handles the union of 19 platform shapes using a per-platform adapter
 * strategy pattern: each adapter knows how to normalize the platform's
 * canonical field names to the 62-col sales_records schema.
 *
 * The transformer is DB-aware but DB-free — it produces Insert payloads
 * with `client_code` / `channel_code` resolution deferred to a lookup map
 * passed in by the caller. That way the importer script (DB-backed) and
 * the verification harness (dry-run) share the same logic.
 *
 * Inputs accepted (auto-detected):
 *  1. RawRecord[]                       — `{ row_index, data }` from a parser
 *  2. SalesRecord[]                     — already-normalized rows (zod schema)
 *  3. GT-style rows                     — `{ clients, channel, rs, ... }`
 */
import type {
  Database,
  SalesRecordInsert,
} from "@/features/settlement/lib/supabase/types";
import type { RawRecord, SalesRecord } from "@/features/settlement/lib/schema/sales";

export interface LookupMaps {
  /** client_code → client_id uuid */
  clientIds: Map<string, string>;
  /** channel_code → channel_id uuid */
  channelIds: Map<string, string>;
  /** title_jp canonical → title_id uuid */
  titleIds?: Map<string, string>;
  /** client alias (any casing/spacing) → client_code */
  clientAliasesToCode?: Map<string, string>;
}

export interface TransformContext {
  settlement_month: string; // 'YYYY-MM-01'
  /**
   * When true, the caller-picked settlement month is authoritative and row
   * contents must not override it. Live dashboard uploads use this because the
   * operator explicitly chooses "this upload is YYYY-MM" before dropping files.
   */
  forceSettlementMonth?: boolean;
  /**
   * File-level sales month parsed from the upload (ISO date), used as the
   * fallback when a record carries no own sales_month. Prevents e.g. a renta
   * 2026-04 statement settling in 2026-05 from being stamped 2026-05.
   */
  sales_month?: string | null;
  platform_code: string; // 'booklive', 'cmoa', ...
  upload_id?: string | null;
  raw_record_id_by_index?: Map<number, string>;
  lookups: LookupMaps;
}

export type AnyInputRow =
  | RawRecord
  | SalesRecord
  | GroundTruthLike
  | Record<string, unknown>;

/** Shape of rows stored in data/ground-truth/YYYYMM.json */
export interface GroundTruthLike {
  unique_id?: string | null;
  channel_title_jp?: string | null;
  title_kr?: string | null;
  title_jp?: string;
  updated?: string | null;
  recoder?: string | null;
  company?: string | null;
  launch_date?: string | null;
  sales_month?: string | null;
  settlement_month?: string | null;
  deposit_month?: string | null;
  country?: string | null;
  clients?: string | null;
  channel?: string | null;
  type?: string | null;
  distribution_strategy?: string | null;
  settlement_currency?: string | null;
  vehicle_currency?: string | null;
  total_amount_jpy?: number | null;
  fee_jpy?: number | null;
  before_tax_jpy?: number | null;
  after_tax_jpy?: number | null;
  rs?: number | null;
  before_tax_income_jpy?: number | null;
  withholding_tax_jpy?: number | null;
  consumption_tax_jpy?: number | null;
  after_tax_income_jpy_a?: number | null;
  after_tax_income_jpy_b?: number | null;
  rate_jpy_krw?: number | null;
  rate_krw_krw?: number | null;
  col31?: number | null;
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
}

export interface TransformResult {
  inserts: SalesRecordInsert[];
  errors: ValidationError[];
  platform_code: string;
  resolved: {
    clients: Set<string>;   // client_codes actually used
    channels: Set<string>;  // channel_codes actually used
  };
}

export interface ValidationError {
  row_index: number;
  platform_code: string;
  field: string;
  message: string;
  sample?: unknown;
}

// ------------------------------------------------------------------ //
// Shape detection                                                    //
// ------------------------------------------------------------------ //

function isRawRecord(r: unknown): r is RawRecord {
  return (
    typeof r === "object" &&
    r != null &&
    "row_index" in r &&
    "data" in r &&
    typeof (r as RawRecord).data === "object"
  );
}

function isGtLike(r: unknown): r is GroundTruthLike {
  return (
    typeof r === "object" &&
    r != null &&
    ("clients" in r || "channel" in r || "rs" in r)
  );
}

function isSalesRecordLike(r: unknown): r is SalesRecord {
  return (
    typeof r === "object" &&
    r != null &&
    "client_code" in r &&
    "channel_code" in r
  );
}

// ------------------------------------------------------------------ //
// Normalizers                                                        //
// ------------------------------------------------------------------ //

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOr0(v: unknown): number {
  return numOrNull(v) ?? 0;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/** Normalize "YYYY-MM-DD" | "YYYY-MM" | Date-ish → ISO date string or null. */
function isoDateOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const match = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (!match) return null;
  const y = match[1];
  const m = String(match[2]).padStart(2, "0");
  const d = match[3] ? String(match[3]).padStart(2, "0") : "01";
  return `${y}-${m}-${d}`;
}

/** Normalize a month-ish value to YYYY-MM-01 (first of month). */
function isoMonthFirstOrNull(v: unknown): string | null {
  const d = isoDateOrNull(v);
  if (!d) return null;
  return d.slice(0, 7) + "-01";
}

function settlementMonthFor(ctx: TransformContext, rowValue: unknown): string {
  return ctx.forceSettlementMonth
    ? ctx.settlement_month
    : isoMonthFirstOrNull(rowValue) ?? ctx.settlement_month;
}

function settlementDateFor(ctx: TransformContext, rowValue: unknown): string {
  return ctx.forceSettlementMonth
    ? ctx.settlement_month
    : isoDateOrNull(rowValue) ?? ctx.settlement_month;
}

/** Canonical fold — same transforms the seeded aliases use (case + trim). */
function foldAlias(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

// ------------------------------------------------------------------ //
// Per-input-shape adapters                                           //
// ------------------------------------------------------------------ //

/**
 * Adapter: already-aggregated SalesRecord (the shape emitted by
 * verify-202604.ts under `system[]`). These carry `client_code` and
 * `channel_code` directly.
 */
function fromSalesRecord(
  row: SalesRecord,
  ctx: TransformContext,
  rowIndex: number,
): { insert: SalesRecordInsert; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const { lookups, platform_code } = ctx;

  const clientCode = foldAlias(row.client_code);
  const channelCode = String(row.channel_code ?? "").trim(); // keep original casing for channel codes ("comico jp" has a space)

  const resolvedClientCode =
    lookups.clientAliasesToCode?.get(clientCode) ??
    (lookups.clientIds.has(clientCode) ? clientCode : null) ??
    clientCode;

  return {
    insert: {
      upload_id: ctx.upload_id ?? null,
      raw_record_id: ctx.raw_record_id_by_index?.get(rowIndex) ?? null,
      unique_identifier: row.unique_identifier ?? null,
      channel_title_jp: row.channel_title_jp ?? null,
      title_kr: row.title_kr ?? null,
      title_jp: row.title_jp ?? null,
      title_id: lookups.titleIds?.get(String(row.title_jp).toLowerCase()) ?? null,
      recoder: "SYSTEM",
      company: row.company ?? "RJ",
      launch_date: isoDateOrNull(row.launch_date),
      sales_month:
        isoMonthFirstOrNull(row.sales_month) ??
        isoMonthFirstOrNull(ctx.sales_month) ??
        ctx.settlement_month,
      settlement_month: settlementMonthFor(ctx, row.settlement_month),
      settlement_batch: ctx.settlement_month,
      deposit_month: isoDateOrNull(row.deposit_month),
      country: row.country ?? "JP",
      client_id: lookups.clientIds.get(resolvedClientCode) ?? null,
      channel_id: lookups.channelIds.get(channelCode) ?? null,
      type: row.type ?? "WT",
      distribution_strategy: row.distribution_strategy ?? "non-ex",
      settlement_currency: row.settlement_currency ?? "JPY",
      vehicle_currency: row.vehicle_currency ?? "KRW",
      total_amount_jpy: numOrNull(row.total_amount_jpy),
      fee_jpy: numOr0(row.fee_jpy),
      before_tax_jpy: numOrNull(row.before_tax_jpy),
      after_tax_jpy: numOrNull(row.after_tax_jpy),
      rs_label: strOrNull(row.rs_label),
      rs_rate: numOrNull(row.rs_rate),
      before_tax_income_jpy: numOrNull(row.before_tax_income_jpy),
      withholding_tax_jpy: numOr0(row.withholding_tax_jpy),
      consumption_tax_jpy: numOrNull(row.consumption_tax_jpy),
      after_tax_income_jpy: numOrNull(row.after_tax_income_jpy),
      exchange_rate: numOrNull(row.exchange_rate),
      fee_krw: numOrNull(row.fee_krw),
      before_tax_krw: numOrNull(row.before_tax_krw),
      after_tax_krw: numOrNull(row.after_tax_krw),
      after_tax_income_krw: numOrNull(row.after_tax_income_krw),
      vat_krw: numOrNull(row.vat_krw),
      withholding_tax_krw: numOrNull(row.withholding_tax_krw),
      sales_krw: numOrNull(row.sales_krw),
      mg_begin: numOr0(row.mg_begin),
      mg_increase: numOr0(row.mg_increase),
      mg_decrease: numOr0(row.mg_decrease),
      mg_end: numOr0(row.mg_end),
      note1: strOrNull(row.note1),
      note2: strOrNull(row.note2),
    },
    errors: [
      ...errors,
      ...(lookups.clientIds.size > 0 && !lookups.clientIds.has(resolvedClientCode)
        ? [
            {
              row_index: rowIndex,
              platform_code,
              field: "client_code",
              message: `unresolved client: ${resolvedClientCode}`,
              sample: row.client_code,
            },
          ]
        : []),
      ...(lookups.channelIds.size > 0 && !lookups.channelIds.has(channelCode)
        ? [
            {
              row_index: rowIndex,
              platform_code,
              field: "channel_code",
              message: `unresolved channel: ${channelCode}`,
              sample: row.channel_code,
            },
          ]
        : []),
    ],
  };
}

/**
 * Adapter: Ground-Truth-shaped row (the accountant's 62-col sheet JSON).
 *
 * Field renames versus SalesRecord:
 *   clients   → client_code (via alias map)
 *   channel   → channel_code
 *   rs        → rs_rate
 *   updated   → updated
 *   unique_id → unique_id
 *   extra_45..extra_62 → extra_45..extra_62 (pass-through)
 */
function fromGroundTruth(
  row: GroundTruthLike,
  ctx: TransformContext,
  rowIndex: number,
): { insert: SalesRecordInsert; errors: ValidationError[] } {
  const { lookups, platform_code } = ctx;

  const rawClient = foldAlias(row.clients);
  const resolvedClientCode =
    lookups.clientAliasesToCode?.get(rawClient) ?? rawClient;

  const channelCode = String(row.channel ?? "").trim();

  const errors: ValidationError[] = [];
  if (
    lookups.clientIds.size > 0 &&
    !lookups.clientIds.has(resolvedClientCode)
  ) {
    errors.push({
      row_index: rowIndex,
      platform_code,
      field: "clients",
      message: `unresolved client: ${resolvedClientCode}`,
      sample: row.clients,
    });
  }
  if (lookups.channelIds.size > 0 && !lookups.channelIds.has(channelCode)) {
    errors.push({
      row_index: rowIndex,
      platform_code,
      field: "channel",
      message: `unresolved channel: ${channelCode}`,
      sample: row.channel,
    });
  }

  // after_tax_income_jpy: prefer a (net-net), fall back to b.
  const after_tax_income_jpy =
    numOrNull(row.after_tax_income_jpy_a) ??
    numOrNull(row.after_tax_income_jpy_b);

  return {
    insert: {
      upload_id: ctx.upload_id ?? null,
      raw_record_id: ctx.raw_record_id_by_index?.get(rowIndex) ?? null,
      unique_id: strOrNull(row.unique_id),
      unique_identifier: strOrNull(row.unique_id),
      channel_title_jp: strOrNull(row.channel_title_jp),
      title_kr: strOrNull(row.title_kr),
      title_jp: strOrNull(row.title_jp),
      title_id: lookups.titleIds?.get(String(row.title_jp ?? "").toLowerCase()) ?? null,
      updated: isoDateOrNull(row.updated),
      recoder: "SYSTEM",
      company: strOrNull(row.company) ?? "RJ",
      launch_date: isoDateOrNull(row.launch_date),
      sales_month:
        isoMonthFirstOrNull(row.sales_month) ??
        isoMonthFirstOrNull(ctx.sales_month) ??
        ctx.settlement_month,
      settlement_month: settlementMonthFor(ctx, row.settlement_month),
      settlement_batch: ctx.settlement_month,
      deposit_month: isoDateOrNull(row.deposit_month),
      country: strOrNull(row.country) ?? "JP",
      client_id: lookups.clientIds.get(resolvedClientCode) ?? null,
      channel_id: lookups.channelIds.get(channelCode) ?? null,
      type: strOrNull(row.type) ?? "WT",
      distribution_strategy: strOrNull(row.distribution_strategy) ?? "non-ex",
      settlement_currency: strOrNull(row.settlement_currency) ?? "JPY",
      vehicle_currency: strOrNull(row.vehicle_currency) ?? "KRW",
      total_amount_jpy: numOrNull(row.total_amount_jpy),
      fee_jpy: numOr0(row.fee_jpy),
      before_tax_jpy: numOrNull(row.before_tax_jpy),
      after_tax_jpy: numOrNull(row.after_tax_jpy),
      rs_rate: numOrNull(row.rs),
      before_tax_income_jpy: numOrNull(row.before_tax_income_jpy),
      withholding_tax_jpy: numOr0(row.withholding_tax_jpy),
      consumption_tax_jpy: numOrNull(row.consumption_tax_jpy),
      after_tax_income_jpy,
      after_tax_income_jpy_a: numOrNull(row.after_tax_income_jpy_a),
      after_tax_income_jpy_b: numOrNull(row.after_tax_income_jpy_b),
      rate_jpy_krw: numOrNull(row.rate_jpy_krw),
      rate_krw_krw: numOrNull(row.rate_krw_krw),
      col31: numOrNull(row.col31),
      fee_krw: numOrNull(row.fee_krw),
      before_tax_krw: numOrNull(row.before_tax_krw),
      after_tax_krw: numOrNull(row.after_tax_krw),
      after_tax_income_krw: numOrNull(row.after_tax_income_krw),
      vat_krw: numOrNull(row.vat_krw),
      withholding_tax_krw: numOrNull(row.withholding_tax_krw),
      sales_krw: numOrNull(row.sales_krw),
      mg_begin: numOr0(row.mg_begin),
      mg_increase: numOr0(row.mg_increase),
      mg_decrease: numOr0(row.mg_decrease),
      mg_end: numOr0(row.mg_end),
      note1: strOrNull(row.note1),
      note2: strOrNull(row.note2),
      extra_45: numOrNull(row.extra_45),
      extra_46: numOrNull(row.extra_46),
      extra_47: numOrNull(row.extra_47),
      extra_48: numOrNull(row.extra_48),
      extra_49: numOrNull(row.extra_49),
      extra_50: numOrNull(row.extra_50),
      extra_51: numOrNull(row.extra_51),
      extra_52: numOrNull(row.extra_52),
      extra_53: strOrNull(row.extra_53),
      extra_54: numOrNull(row.extra_54),
      extra_55: numOrNull(row.extra_55),
      extra_56: numOrNull(row.extra_56),
      extra_57: numOrNull(row.extra_57),
      extra_58: strOrNull(row.extra_58),
      extra_59: numOrNull(row.extra_59),
      extra_60: numOrNull(row.extra_60),
      extra_61: numOrNull(row.extra_61),
      extra_62: numOrNull(row.extra_62),
    },
    errors,
  };
}

/**
 * Adapter: RawRecord (`{row_index, data}`). Each platform parser emits
 * its own `data` shape; we normalize by reading the same *_jpy / *_rs
 * fields that the aggregation engine expects. For platform-specific
 * quirks we extend with a per-platform override map (currently a
 * pass-through — the 19 existing parsers already produce a compatible
 * minimal shape, and the `verify-202604.ts` aggregator backfills the
 * rest via `aggregate()`).
 *
 * The importer's preferred path is to feed the aggregator output (which
 * is already a SalesRecord), so this adapter is mostly a convenience
 * for single-file live uploads.
 */
function fromRawRecord(
  raw: RawRecord,
  ctx: TransformContext,
): { insert: SalesRecordInsert; errors: ValidationError[] } {
  const d = raw.data as Record<string, unknown>;
  const { lookups } = ctx;
  const errors: ValidationError[] = [];

  const clientCode =
    (d.client_code as string | undefined) ??
    (d.clients as string | undefined) ??
    "";
  const channelCode =
    (d.channel_code as string | undefined) ??
    (d.channel as string | undefined) ??
    "";

  const resolvedClientCode =
    lookups.clientAliasesToCode?.get(foldAlias(clientCode)) ?? String(clientCode);
  const isSummary = d.is_summary === true;
  const sourceFileKind = strOrNull(d.source_file_kind);
  const summaryNote = isSummary
    ? ["SUMMARY_NON_AGGREGATED", sourceFileKind].filter(Boolean).join(":")
    : null;
  const note2 = [strOrNull(d.note2), summaryNote].filter(Boolean).join(" / ") || null;

  return {
    insert: {
      upload_id: ctx.upload_id ?? null,
      raw_record_id:
        ctx.raw_record_id_by_index?.get(raw.row_index) ?? null,
      channel_title_jp: strOrNull(d.channel_title_jp ?? d.title_jp),
      title_kr: strOrNull(d.title_kr),
      title_jp: strOrNull(d.title_jp),
      title_id: lookups.titleIds?.get(String(d.title_jp ?? "").toLowerCase()) ?? null,
      recoder: "SYSTEM",
      company: strOrNull(d.company) ?? "RJ",
      launch_date: isoDateOrNull(d.launch_date),
      // Parser rows may carry exact dates (piccoma end-of-month, KADOKAWA
      // 支払日 / period-end) — preserve them instead of collapsing to the 1st.
      // File-level ctx.sales_month beats ctx.settlement_month so a statement
      // for month M settling in M+n keeps sales_month = M.
      sales_month:
        isoDateOrNull(d.sales_month) ??
        isoDateOrNull(ctx.sales_month) ??
        ctx.settlement_month,
      settlement_month: settlementDateFor(ctx, d.settlement_month),
      settlement_batch: ctx.settlement_month,
      deposit_month: isoDateOrNull(d.deposit_month),
      country: strOrNull(d.country) ?? "JP",
      client_id: lookups.clientIds.get(resolvedClientCode) ?? null,
      channel_id: lookups.channelIds.get(String(channelCode).trim()) ?? null,
      type: (strOrNull(d.type) as string | null) ?? "WT",
      distribution_strategy: strOrNull(d.distribution_strategy) ?? "non-ex",
      settlement_currency: strOrNull(d.settlement_currency) ?? "JPY",
      vehicle_currency: strOrNull(d.vehicle_currency) ?? "KRW",
      total_amount_jpy: isSummary ? null : numOrNull(d.total_amount_jpy ?? d.gross_jpy),
      fee_jpy: isSummary ? 0 : numOr0(d.fee_jpy),
      before_tax_jpy: isSummary ? null : numOrNull(d.before_tax_jpy),
      after_tax_jpy: isSummary ? null : numOrNull(d.after_tax_jpy),
      rs_label: strOrNull(d.rs_label),
      rs_rate: isSummary ? null : numOrNull(d.rs_rate ?? d.rs_rate_hint),
      before_tax_income_jpy: isSummary ? null : numOrNull(d.before_tax_income_jpy),
      withholding_tax_jpy: isSummary ? 0 : numOr0(d.withholding_tax_jpy),
      consumption_tax_jpy: isSummary ? 0 : numOrNull(d.consumption_tax_jpy),
      after_tax_income_jpy: isSummary ? null : numOrNull(d.after_tax_income_jpy),
      note1: strOrNull(d.note1),
      note2,
    },
    errors,
  };
}

// ------------------------------------------------------------------ //
// Public API                                                         //
// ------------------------------------------------------------------ //

export function toSalesRecords(
  rows: AnyInputRow[],
  ctx: TransformContext,
): TransformResult {
  const inserts: SalesRecordInsert[] = [];
  const errors: ValidationError[] = [];
  const clients = new Set<string>();
  const channels = new Set<string>();

  rows.forEach((row, i) => {
    let out: { insert: SalesRecordInsert; errors: ValidationError[] };
    if (isRawRecord(row)) {
      out = fromRawRecord(row, ctx);
    } else if (isSalesRecordLike(row)) {
      out = fromSalesRecord(row, ctx, i);
    } else if (isGtLike(row)) {
      out = fromGroundTruth(row as GroundTruthLike, ctx, i);
    } else {
      errors.push({
        row_index: i,
        platform_code: ctx.platform_code,
        field: "_shape",
        message: "row does not match any known adapter shape",
      });
      return;
    }
    inserts.push(out.insert);
    errors.push(...out.errors);
    if (out.insert.client_id === null && typeof (row as Record<string, unknown>).client_code === "string") {
      clients.add(String((row as Record<string, unknown>).client_code));
    }
    if (out.insert.channel_id === null && typeof (row as Record<string, unknown>).channel_code === "string") {
      channels.add(String((row as Record<string, unknown>).channel_code));
    }
  });

  return {
    inserts,
    errors,
    platform_code: ctx.platform_code,
    resolved: { clients, channels },
  };
}

/** Build a LookupMaps from Supabase rows (tiny helper the importer uses). */
export function buildLookupMaps(opts: {
  clients: Array<Database["public"]["Tables"]["clients"]["Row"]>;
  channels: Array<Database["public"]["Tables"]["channels"]["Row"]>;
  titles?: Array<Database["public"]["Tables"]["titles"]["Row"]>;
}): LookupMaps {
  const clientIds = new Map<string, string>();
  const clientAliasesToCode = new Map<string, string>();
  for (const c of opts.clients) {
    clientIds.set(c.code, c.id);
    clientAliasesToCode.set(c.code.toLowerCase(), c.code);
    for (const a of c.aliases ?? []) {
      clientAliasesToCode.set(String(a).trim().toLowerCase(), c.code);
    }
  }
  const channelIds = new Map<string, string>();
  for (const ch of opts.channels) channelIds.set(ch.code, ch.id);

  const titleIds = new Map<string, string>();
  for (const t of opts.titles ?? []) {
    if (t.title_jp) titleIds.set(t.title_jp.toLowerCase(), t.id);
  }
  return { clientIds, channelIds, titleIds, clientAliasesToCode };
}

/** Empty lookup maps for dry-run mode (no DB). */
export function emptyLookupMaps(): LookupMaps {
  return {
    clientIds: new Map(),
    channelIds: new Map(),
    titleIds: new Map(),
    clientAliasesToCode: new Map(),
  };
}

export const __test = {
  foldAlias,
  numOrNull,
  numOr0,
  isoDateOrNull,
  isoMonthFirstOrNull,
  fromGroundTruth,
  fromSalesRecord,
  fromRawRecord,
};
