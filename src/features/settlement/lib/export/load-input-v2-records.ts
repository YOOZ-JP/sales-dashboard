/**
 * Shared month-record loader for the INPUT v2 export and preview routes.
 *
 * Both `/api/settlement/export-v2/[month]` and `/api/settlement/preview-v2/[month]`
 * must feed identical records into `fillInputV2Template`, so this loader is the single
 * source of truth for fetching + enriching `sales_records` for a settlement month.
 */
export async function loadInputV2Records(
  month: string,
): Promise<{ records: Record<string, unknown>[]; source: string }> {
  const supabaseConfigured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseConfigured) {
    try {
      const { createServiceClient } = await import("@/features/settlement/lib/supabase/server");
      const supabase = createServiceClient();
      const batchIso = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
      const PAGE = 1000;
      const all: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from("sales_records")
          .select("*")
          .eq("settlement_batch", batchIso)
          .order("client_id", { ascending: true, nullsFirst: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
      }

      if (all.length > 0) {
        const [clientsRes, channelsRes, titlesRes] = await Promise.all([
          supabase.from("clients").select("id, code, display_name"),
          supabase.from("channels").select("id, code"),
          supabase.from("titles").select("id, title_kr"),
        ]);
        const clientName = new Map<string, string>();
        for (const c of clientsRes.data ?? []) {
          clientName.set(c.id, c.display_name ?? c.code ?? "");
        }
        const channelName = new Map<string, string>();
        for (const ch of channelsRes.data ?? []) {
          channelName.set(ch.id, ch.code ?? "");
        }
        const titleKr = new Map<string, string>();
        for (const t of titlesRes.data ?? []) {
          if (t.title_kr) titleKr.set(t.id, t.title_kr);
        }
        for (const r of all) {
          const cid = r.client_id as string | null;
          const chid = r.channel_id as string | null;
          const tid = r.title_id as string | null;
          if (cid && clientName.has(cid)) r.clients = clientName.get(cid);
          if (chid && channelName.has(chid)) r.channel = channelName.get(chid);
          if (tid && titleKr.has(tid) && !r.title_kr) r.title_kr = titleKr.get(tid);
        }
        return { records: all, source: "supabase" };
      }
    } catch (err) {
      console.warn(
        "[input-v2] Supabase fetch failed, falling back to empty:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { records: [], source: "none" };
}
