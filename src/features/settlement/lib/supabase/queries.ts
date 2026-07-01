/**
 * Server-side typed queries used by dashboard pages and API routes.
 *
 * All queries are written against the Database type in ./types.ts so
 * missing columns are caught at compile time. Every function degrades
 * to `null` / `[]` when Supabase is not configured, which lets the
 * dashboard fall back to empty states until live settlement rows exist.
 */
import { createServiceClient } from "./server";
// All dashboard queries use the service client — no user sessions exist since
// the app has no login.
const createServerClient = createServiceClient;
import type { Database } from "./types";

/**
 * Convert a month value (YYYYMM or YYYY-MM-DD) to the first-of-month
 * date string used as the inclusive lower bound for a month-range query.
 */
function monthStart(month: string): string {
  if (/^\d{6}$/.test(month)) return `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  return month.slice(0, 7) + "-01";
}


export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return false;
  if (url.includes("YOUR-PROJECT") || anon.startsWith("eyJ...")) return false;
  return true;
}

type SalesRecordRow = Database["public"]["Tables"]["sales_records"]["Row"];

export interface ClientMonthlySummary {
  client_id: string | null;
  client_code: string | null;
  client_display_name: string | null;
  row_count: number;
  total_jpy: number;
  before_tax_income_jpy: number;
  after_tax_income_jpy: number;
  sales_krw: number;
}

/**
 * getMonthlySummary
 *
 * Returns per-client totals for a given settlement month.
 *
 * Paginates the raw `sales_records` query in 1000-row chunks so the
 * PostgREST default LIMIT 1000 doesn't silently truncate the result
 * (a fan-out without `.range()` caps at 1000 even though the table
 * holds more). Aggregates client-side into one row per client_id.
 */
export async function getMonthlySummary(
  month: string,
): Promise<ClientMonthlySummary[] | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = createServerClient();
  const batchIso = monthStart(month);

  const PAGE = 1000;
  type Row = Pick<
    SalesRecordRow,
    | "client_id"
    | "total_amount_jpy"
    | "before_tax_income_jpy"
    | "after_tax_income_jpy"
    | "sales_krw"
  >;
  const all: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("sales_records")
      .select(
        "client_id, total_amount_jpy, before_tax_income_jpy, after_tax_income_jpy, sales_krw",
      )
      .eq("settlement_batch", batchIso)
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.warn("[supabase queries] getMonthlySummary:", error.message);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  const byClient = new Map<string | null, ClientMonthlySummary>();
  for (const r of all) {
    const key = r.client_id ?? null;
    const prev =
      byClient.get(key) ??
      ({
        client_id: key,
        client_code: null,
        client_display_name: null,
        row_count: 0,
        total_jpy: 0,
        before_tax_income_jpy: 0,
        after_tax_income_jpy: 0,
        sales_krw: 0,
      } as ClientMonthlySummary);
    prev.row_count += 1;
    prev.total_jpy += Number(r.total_amount_jpy ?? 0);
    prev.before_tax_income_jpy += Number(r.before_tax_income_jpy ?? 0);
    prev.after_tax_income_jpy += Number(r.after_tax_income_jpy ?? 0);
    prev.sales_krw += Number(r.sales_krw ?? 0);
    byClient.set(key, prev);
  }

  // Decorate with client info
  const clientIds = [...byClient.keys()].filter((x): x is string => !!x);
  if (clientIds.length > 0) {
    const { data: clients } = await supabase
      .from("clients")
      .select("id, code, display_name")
      .in("id", clientIds);
    for (const c of clients ?? []) {
      const entry = byClient.get(c.id);
      if (entry) {
        entry.client_code = c.code;
        entry.client_display_name = c.display_name;
      }
    }
  }

  return [...byClient.values()].sort((a, b) => b.total_jpy - a.total_jpy);
}

// ------------------------------------------------------------------ //
// getSalesRecords                                                    //
// ------------------------------------------------------------------ //

export interface SalesRecordFilters {
  clientCode?: string;
  channelCode?: string;
  search?: string; // title_jp ILIKE
  limit?: number;
  offset?: number;
}

export async function getSalesRecords(
  month: string,
  filters: SalesRecordFilters = {},
): Promise<{ rows: SalesRecordRow[]; total: number } | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = createServerClient();

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  let q = supabase
    .from("sales_records")
    .select("*", { count: "exact" })
    .eq("settlement_batch", monthStart(month))
    .range(offset, offset + limit - 1)
    .order("total_amount_jpy", { ascending: false, nullsFirst: false });

  if (filters.clientCode) {
    const { data: c } = await supabase
      .from("clients")
      .select("id")
      .eq("code", filters.clientCode)
      .maybeSingle();
    if (c?.id) q = q.eq("client_id", c.id);
  }
  if (filters.channelCode) {
    const { data: ch } = await supabase
      .from("channels")
      .select("id")
      .eq("code", filters.channelCode)
      .maybeSingle();
    if (ch?.id) q = q.eq("channel_id", ch.id);
  }
  if (filters.search) {
    q = q.ilike("title_jp", `%${filters.search}%`);
  }

  const { data, error, count } = await q;
  if (error) {
    console.warn("[supabase queries] getSalesRecords:", error.message);
    return null;
  }
  return { rows: (data ?? []) as SalesRecordRow[], total: count ?? 0 };
}

// ------------------------------------------------------------------ //
// listSettlementMonths                                               //
// ------------------------------------------------------------------ //

export interface SettlementMonth {
  settlement_month: string;
  row_count: number;
  total_jpy: number;
}

export async function listSettlementMonths(): Promise<SettlementMonth[] | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("v_monthly_summary" satisfies keyof Database["public"]["Views"])
    .select("settlement_month, row_count, total_jpy")
    .order("settlement_month", { ascending: false });

  if (error) {
    console.warn("[supabase queries] listSettlementMonths:", error.message);
    // Fallback: derive from sales_records.settlement_batch
    const { data: raw } = await supabase
      .from("sales_records")
      .select("settlement_batch, total_amount_jpy")
      .not("settlement_batch", "is", null) as { data: { settlement_batch: string; total_amount_jpy: number | null }[] | null };
    if (!raw) return [];
    const map = new Map<string, { row_count: number; total_jpy: number }>();
    for (const r of raw) {
      const m = r.settlement_batch!;
      const prev = map.get(m) ?? { row_count: 0, total_jpy: 0 };
      prev.row_count += 1;
      prev.total_jpy += Number(r.total_amount_jpy ?? 0);
      map.set(m, prev);
    }
    return [...map.entries()]
      .map(([settlement_month, v]) => ({ settlement_month, ...v }))
      .sort((a, b) => (a.settlement_month < b.settlement_month ? 1 : -1));
  }

  return (data ?? []).map((r) => ({
    settlement_month: r.settlement_month,
    row_count: r.row_count ?? 0,
    total_jpy: Number(r.total_jpy ?? 0),
  }));
}

// ------------------------------------------------------------------ //
// getVerificationStatus                                              //
// ------------------------------------------------------------------ //

export interface PlatformVerification {
  platform_code: string;
  gt_rows: number;
  parsed_rows: number;
  db_rows: number | null;
  matched: boolean;
}

export async function getVerificationStatus(
  month: string,
): Promise<PlatformVerification[]> {
  void month;
  // The integrated dashboard must not rely on local golden/verification
  // fixture folders from the standalone settlement repo. Keep this API shape
  // for compatibility, but return an empty verification list until a live
  // dashboard-native verification view is added.
  return [];
}

// ------------------------------------------------------------------ //
// Helpers for the importer (service-role; ignores auth)              //
// ------------------------------------------------------------------ //

export async function fetchLookupSeed() {
  if (!isSupabaseConfigured()) return null;
  const supabase = createServiceClient();

  const [clients, channels] = await Promise.all([
    supabase.from("clients").select("*"),
    supabase.from("channels").select("*"),
  ]);

  if (clients.error || channels.error) {
    console.warn(
      "[supabase queries] fetchLookupSeed error:",
      clients.error?.message ?? channels.error?.message,
    );
    return null;
  }
  return {
    clients: (clients.data ?? []) as Array<
      Database["public"]["Tables"]["clients"]["Row"]
    >,
    channels: (channels.data ?? []) as Array<
      Database["public"]["Tables"]["channels"]["Row"]
    >,
  };
}
