/**
 * "Active settlement month" — the month the operator is currently
 * working on. Stored in a cookie so every server component + API route
 * sees the same value.
 *
 * Value format: YYYY-MM-01 (first of month). All queries use a
 * gte/lt range anyway so the exact day doesn't matter; we pick the 1st
 * as the canonical bucket marker.
 */
export const ACTIVE_MONTH_COOKIE = "jp_active_month";

/** YYYY-MM-01 shape — reject anything else. */
export function isValidMonth(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-01$/.test(v);
}

/** Default: the most recent calendar month (today's YYYY-MM-01). */
export function currentMonthIso(): string {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-01`;
}

/** Format for display: "2026年4月" / "2026년 4월". */
export function formatMonthLabel(iso: string, locale: "ja" | "ko"): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  return locale === "ja" ? `${y}年${m}月` : `${y}년 ${m}월`;
}

/** Produce a reasonable menu of months: DB months + last 12 calendar months (deduped). */
export function buildMonthOptions(dbMonths: string[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const m of dbMonths ?? []) {
    // Normalize to first-of-month
    const norm = m.slice(0, 7) + "-01";
    set.add(norm);
  }
  const now = new Date();
  for (let i = -1; i < 12; i++) {
    // -1 = next month (useful when uploading early)
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    set.add(iso);
  }
  return [...set].sort((a, b) => (a < b ? 1 : -1));
}
