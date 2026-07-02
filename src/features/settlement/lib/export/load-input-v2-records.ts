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
import {
  clientCodeToDisplay,
  loadInputV2TemplateLookups,
  normalizeTitleKey,
  platformCodeToChannel,
  rawChannelCodeToTemplate,
  type TemplateChannelInfo,
} from "./input-v2-template-lookups";

export type InputV2LoadError = {
  status: 503 | 500;
  error: string;
  details: string;
};

function formatSupabaseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts = [obj.message, obj.details, obj.hint, obj.code]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(obj);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

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
            .map(([table, error]) => `${table} lookup failed: ${formatSupabaseError(error)}`)
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

      // Deployment fallback: when the clients/channels/titles tables are
      // empty the loop above leaves display fields blank, so backfill them
      // from the golden template's master sheets keyed by each row's raw
      // channel/client codes, falling back to the upload's platform_code.
      // Failure here must not break the export itself.
      const needsFallback = all.some(
        (r) => !r.clients || !r.channel || !r.title_kr || !r.title_jp,
      );
      if (needsFallback) {
        try {
          const uploadIds = [
            ...new Set(
              all
                .map((r) => r.upload_id)
                .filter((id): id is string => typeof id === "string" && id.length > 0),
            ),
          ];
          const platformByUpload = new Map<string, string>();
          if (uploadIds.length > 0) {
            const { data: uploads, error: uploadsError } = await supabase
              .from("raw_uploads")
              .select("id, platform_code, filename")
              .in("id", uploadIds);
            if (uploadsError) throw uploadsError;
            for (const u of uploads ?? []) {
              if (u.platform_code) platformByUpload.set(u.id, u.platform_code);
            }
          }

          // Row-level channel/client codes from the original parsed rows.
          // These beat the upload's platform_code because one file can mix
          // channels (e.g. an ebj_line upload holds line/ebj_webtoon/ebj rows).
          type RawRecordCodes = {
            id: string;
            channel_code: string | null;
            channel: string | null;
            store_code: string | null;
            service_code: string | null;
            client_code: string | null;
          };
          const rawCodesById = new Map<string, RawRecordCodes>();
          if (uploadIds.length > 0) {
            for (let offset = 0; ; offset += PAGE) {
              const { data: rawRows, error: rawError } = await supabase
                .from("raw_records")
                .select(
                  "id, channel_code:data->>channel_code, channel:data->>channel, store_code:data->>store_code, service_code:data->>service_code, client_code:data->>client_code",
                )
                .in("upload_id", uploadIds)
                .order("id", { ascending: true })
                .range(offset, offset + PAGE - 1);
              if (rawError) throw rawError;
              if (!rawRows || rawRows.length === 0) break;
              for (const row of rawRows as RawRecordCodes[]) {
                rawCodesById.set(row.id, row);
              }
              if (rawRows.length < PAGE) break;
            }
          }

          const lookups = await loadInputV2TemplateLookups();
          // Template channel codes are cased as they appear in the workbook
          // (e.g. "Jumptoon"), so match raw codes case-insensitively.
          const channelInfoByKey = new Map<string, TemplateChannelInfo>();
          for (const info of lookups.channelByCode.values()) {
            channelInfoByKey.set(info.channel.trim().toLowerCase(), info);
          }
          const text = (value: unknown): string | null =>
            typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

          for (const r of all) {
            const raw =
              typeof r.raw_record_id === "string"
                ? rawCodesById.get(r.raw_record_id)
                : undefined;
            const uploadId = typeof r.upload_id === "string" ? r.upload_id : null;
            const platformCode = uploadId ? platformByUpload.get(uploadId) : undefined;

            const rawChannelKey =
              text(raw?.channel_code) ??
              text(raw?.channel) ??
              text(raw?.store_code) ??
              text(raw?.service_code);
            const normalizedRawChannelKey = rawChannelKey
              ? rawChannelCodeToTemplate(rawChannelKey)
              : null;
            const channelKey =
              normalizedRawChannelKey ?? (platformCode ? platformCodeToChannel(platformCode) : null);
            const info = channelKey
              ? channelInfoByKey.get(channelKey.toLowerCase())
              : undefined;

            if (!r.channel) {
              if (info) r.channel = info.channel;
              else if (normalizedRawChannelKey) r.channel = normalizedRawChannelKey;
            }
            const rawClientCode = text(raw?.client_code);
            const clientDisplay =
              (rawClientCode ? clientCodeToDisplay(rawClientCode) : null) ??
              info?.clients ??
              null;
            if (!r.clients && clientDisplay) r.clients = clientDisplay;
            if (info) {
              if (!r.type && info.type) r.type = info.type;
              if (!r.distribution_strategy && info.distribution_strategy) {
                r.distribution_strategy = info.distribution_strategy;
              }
              if (!r.country && info.country) r.country = info.country;
              if (!r.settlement_currency && info.settlement_currency) {
                r.settlement_currency = info.settlement_currency;
              }
              if (!r.vehicle_currency && info.vehicle_currency) {
                r.vehicle_currency = info.vehicle_currency;
              }
            }
            if ((!r.title_kr || !r.title_jp) && typeof r.channel_title_jp === "string") {
              const t = lookups.titleByChannelTitle.get(normalizeTitleKey(r.channel_title_jp));
              if (t) {
                if (!r.title_kr && t.title_kr) r.title_kr = t.title_kr;
                if (!r.title_jp && t.title_jp) r.title_jp = t.title_jp;
              }
            }
          }
        } catch (fallbackErr) {
          console.warn(
            "[input-v2] template fallback enrichment failed:",
            formatSupabaseError(fallbackErr),
          );
        }
      }
    }
    return { records: all, source: "supabase", loadError: null };
  } catch (err) {
    const message = formatSupabaseError(err);
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
