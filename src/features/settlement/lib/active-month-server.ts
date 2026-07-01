/**
 * Server-side helpers for the active settlement month. Separated from
 * lib/active-month.ts so pure helpers can be imported from client code
 * without pulling in next/headers.
 */
import { cookies } from "next/headers";
import {
  ACTIVE_MONTH_COOKIE,
  buildMonthOptions,
  currentMonthIso,
  isValidMonth,
} from "./active-month";
import { isSupabaseConfigured, listSettlementMonths } from "./supabase/queries";

/** Read the cookie; fall back to most recent DB month, then today's month. */
export async function getActiveMonth(): Promise<string> {
  const store = await cookies();
  const fromCookie = store.get(ACTIVE_MONTH_COOKIE)?.value;
  if (isValidMonth(fromCookie)) return fromCookie;

  if (isSupabaseConfigured()) {
    const dbMonths = await listSettlementMonths();
    const firstDb = dbMonths?.[0]?.settlement_month;
    if (firstDb) return firstDb.slice(0, 7) + "-01";
  }
  return currentMonthIso();
}

/** Month options for the dropdown = DB months ∪ rolling calendar window. */
export async function getMonthOptions(): Promise<{ options: string[]; dbMonths: Set<string> }> {
  const dbRaw = isSupabaseConfigured() ? await listSettlementMonths() : null;
  const dbMonths = new Set<string>(
    (dbRaw ?? []).map((m) => m.settlement_month.slice(0, 7) + "-01"),
  );
  return {
    options: buildMonthOptions([...dbMonths]),
    dbMonths,
  };
}
