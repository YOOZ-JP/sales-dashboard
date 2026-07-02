/**
 * Shared month-record loader for the INPUT v2 export and preview routes.
 *
 * Both `/api/settlement/export-v2/[month]` and `/api/settlement/preview-v2/[month]`
 * must feed identical records into `fillInputV2Template`, so this loader is the single
 * source of truth for fetching + enriching `sales_records` for a settlement month.
 */

/**
 * Deploy blocker surfaced to the API routes: missing Supabase env (503) or a
 * Supabase query failure (500). `null` means the DB was queried successfully —
 * zero records is then a genuine "no data" case (404 at the route level).
 */
export type InputV2LoadError = {
  status: 503 | 500;
  error: string;
  details: string;
};

export async function loadInputV2Records(
  month: string,
): Promise<{
  records: Record<string, unknown>[];
  source: string;
  loadError: InputV2LoadError | null;
}> {
  const missingEnv = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ].filter((name) => !process.env[name]);

  if (missingEnv.length > 0) {
    return {
      records: [],
      source: "none",
      loadError: {
        status: 503,
        error: "Supabase is not configured on this deployment",
        details: `Missing environment variables: ${missingEnv.join(", ")}. Set them in the deployment settings, then retry.`,
      },
    };
  }

  try {
    // Match the rest of the dashboard: use the service-role key when it exists,
    // otherwise fall back to the normal server anon client. Preview/export are
    // protected by the dashboard cookie before this loader runs, so lack of a
    // service key should not make a healthy Vercel deployment look broken.
    const { supabaseServer: supabase } = await import("@/lib/supabase-server");
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
      const lookupFailures = [
        ["clients", clientsRes.error],
        ["channels", channelsRes.error],
        ["titles", titlesRes.error],
      ].filter(([, error]) => error);
      if (lookupFailures.length > 0) {
        throw new Error(
          lookupFailures
            .map(([table, error]) => `${table} lookup failed: ${(error as { message: string }).message}`)
            .join("; "),
        );
      }
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
    }
    return { records: all, source: "supabase", loadError: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[input-v2] Supabase fetch failed:", message);
    return {
      records: [],
      source: "none",
      loadError: {
        status: 500,
        error: "Failed to fetch settlement records from Supabase",
        details: message,
      },
    };
  }
}
