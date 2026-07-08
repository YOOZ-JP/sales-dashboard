/**
 * GET /api/settlement/month-platforms?year=YYYY
 *
 * For each settlement_batch month of the given year, returns which
 * platforms (channels) already have sales_records rows — platform names
 * only, never amounts or volume counts. Used by the settlement month picker to mark
 * months that hold data and to list that month's platforms.
 *
 * Response: { year, months: { "202605": [{ code, name }, …], … } }
 */
import { NextResponse } from "next/server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { supabaseServer as supabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PAGE = 1000;

type PlatformEntry = { code: string | null; name: string | null };

export async function GET(request: Request) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const yearParam = new URL(request.url).searchParams.get("year") ?? "";
  if (!/^\d{4}$/.test(yearParam)) {
    return NextResponse.json({ error: "year must be YYYY" }, { status: 400 });
  }
  const year = Number(yearParam);

  // De-duplicate platforms client-side: PostgREST has no simple GROUP BY here,
  // and the same paginated pattern is already used by settlement APIs.
  const byMonth = new Map<string, Set<string>>();
  const fallbackUploadIds = new Set<string>();
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from("sales_records")
      .select("settlement_batch, channel_id, upload_id")
      .gte("settlement_batch", `${year}-01-01`)
      .lt("settlement_batch", `${year + 1}-01-01`)
      .order("settlement_batch", { ascending: true })
      .order("channel_id", { ascending: true, nullsFirst: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: `sales_records: ${error.message}` }, { status: 500 });
    }
    const rows = (data ?? []) as Array<{ settlement_batch: string | null; channel_id: string | null; upload_id: string | null }>;
    for (const row of rows) {
      if (!row.settlement_batch) continue;
      const yyyymm = row.settlement_batch.slice(0, 7).replace("-", "");
      const channels = byMonth.get(yyyymm) ?? new Set<string>();
      if (row.channel_id) {
        channels.add(`channel:${row.channel_id}`);
      } else if (row.upload_id) {
        channels.add(`upload:${row.upload_id}`);
        fallbackUploadIds.add(row.upload_id);
      } else {
        channels.add("unknown:");
      }
      byMonth.set(yyyymm, channels);
    }
    if (rows.length < PAGE) break;
  }

  // Resolve channel ids to code/display name in one lookup.
  const channelIds = Array.from(
    new Set(Array.from(byMonth.values()).flatMap((m) => Array.from(m.values()))),
  ).flatMap((key) => (key.startsWith("channel:") ? [key.slice("channel:".length)] : []));
  const channelInfo = new Map<string, { code: string | null; name: string | null }>();
  if (channelIds.length > 0) {
    const { data, error } = await supabase
      .from("channels")
      .select("id, code, display_name")
      .in("id", channelIds);
    if (error) {
      return NextResponse.json({ error: `channels: ${error.message}` }, { status: 500 });
    }
    for (const c of (data ?? []) as Array<{ id: string; code: string | null; display_name: string | null }>) {
      channelInfo.set(c.id, { code: c.code, name: c.display_name });
    }
  }

  const uploadPlatform = new Map<string, string>();
  if (fallbackUploadIds.size > 0) {
    const { data, error } = await supabase
      .from("raw_uploads")
      .select("id, platform_code")
      .in("id", Array.from(fallbackUploadIds));
    if (error) {
      return NextResponse.json({ error: `raw_uploads: ${error.message}` }, { status: 500 });
    }
    for (const u of (data ?? []) as Array<{ id: string; platform_code: string | null }>) {
      if (u.platform_code) uploadPlatform.set(u.id, u.platform_code);
    }
  }

  const months: Record<string, PlatformEntry[]> = {};
  for (const [yyyymm, channels] of byMonth) {
    const platforms = new Map<string, PlatformEntry>();
    for (const key of channels) {
      let entry: PlatformEntry;
      if (key.startsWith("channel:")) {
        const channelId = key.slice("channel:".length);
        const info = channelInfo.get(channelId);
        entry = { code: info?.code ?? null, name: info?.name ?? null };
      } else if (key.startsWith("upload:")) {
        const uploadId = key.slice("upload:".length);
        const code = uploadPlatform.get(uploadId) ?? null;
        entry = { code, name: code };
      } else {
        entry = { code: null, name: null };
      }
      platforms.set(entry.code ?? entry.name ?? "unknown", entry);
    }
    months[yyyymm] = Array.from(platforms.values()).sort((a, b) => (a.name ?? a.code ?? "").localeCompare(b.name ?? b.code ?? ""));
  }

  return NextResponse.json({ year, months });
}
