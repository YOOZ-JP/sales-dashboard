/**
 * Shared month-record loader for the INPUT v2 export and preview routes.
 *
 * Both `/api/settlement/export-v2/[month]` and `/api/settlement/preview-v2/[month]`
 * must feed identical records into `fillInputV2Template`, so this loader is the single
 * source of truth for fetching + enriching `sales_records` for a settlement month.
 */

/**
 * Deploy blocker surfaced to the API routes: missing Supabase env (503), a
 * Supabase query failure (500), or a source-completeness conflict (409: a
 * required source-family upload is missing, failed, or empty). `null` means
 * the DB was queried successfully — zero records is then a genuine "no data"
 * case (404 at the route level).
 */
import {
  carryForwardRecordKey,
  mergeCarryForwardRows,
} from "./input-v2-carry-forward";
import {
  dedupeCrossUploadDuplicates,
  dedupePiccomaStatementDuplicates,
} from "@/features/settlement/lib/aggregation/strict-record-key";
import {
  clientCodeToDisplay,
  loadInputV2TemplateLookups,
  normalizeTitleKey,
  platformCodeToChannel,
  rawChannelCodeToTemplate,
  type TemplateChannelInfo,
} from "./input-v2-template-lookups";

export type InputV2LoadError = {
  status: 503 | 500 | 409;
  error: string;
  details: string;
};

export type InputV2SourceWarning = string;

export type LoadInputV2RecordsOptions = {
  /**
   * Audit-only mode for comparison runs. Export/preview callers must keep the
   * default false so missing source families remain a 409 conflict.
   */
  allowIncompleteSources?: boolean;
};

/** Current-batch raw_uploads projection used by the source-family gate. */
export interface SourceUploadStatus {
  id?: string | null;
  platform_code: string | null;
  status: string | null;
  parsed_rows: number | null;
  parse_error?: string | null;
}

/**
 * Statement-cadence contract channels whose month can only be evidenced by a
 * specific uploaded source family. When the baseline roster contains one of
 * the listed channels, the current batch must hold a successful upload of a
 * matching platform (status "parsed" or "aggregated" with parsed_rows > 0)
 * that actually produced current-batch non-summary sales_records; otherwise
 * the export would silently zero-carry a month whose statement was simply
 * never uploaded (or only landed as a generic summary fallback). Channels
 * outside this table are never gated.
 */
const REQUIRED_SOURCE_FAMILIES: ReadonlyArray<{
  family: string;
  channels: readonly string[];
  platforms: readonly string[];
}> = [
  { family: "booklive", channels: ["booklive", "bookcomi"], platforms: ["booklive"] },
  { family: "dmm", channels: ["dmm"], platforms: ["dmm"] },
  { family: "renta", channels: ["renta"], platforms: ["renta"] },
  { family: "shueisha", channels: ["jumptoon", "manga mee"], platforms: ["shueisha"] },
  { family: "kadokawa", channels: ["kadokawa"], platforms: ["kadokawa"] },
  { family: "piccoma_ads", channels: ["piccoma_ads"], platforms: ["piccoma_ads"] },
  { family: "u_next", channels: ["u-next"], platforms: ["u_next"] },
  { family: "cmoa", channels: ["cmoa"], platforms: ["cmoa"] },
  { family: "comico", channels: ["comico jp", "comico_ads"], platforms: ["comico"] },
];

function normalizeChannelPart(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

/**
 * Comparison key for channel/platform matching: internal whitespace is also
 * collapsed so "Manga Mee" and "manga mee" compare equal.
 */
function normalizeChannelKey(value: unknown): string {
  return normalizeChannelPart(value).replace(/\s+/g, "");
}

/**
 * Returns the privacy-safe family names whose required upload is missing,
 * failed, or empty.
 *
 * When `detailUploadIds` is given (the ids of uploads that produced the
 * current batch's non-summary sales_records), a family is satisfied only by
 * a successful upload whose id is in that set — so a generic summary-only
 * fallback upload can never satisfy the gate on its own.
 */
export function validateRequiredSourceFamilies(
  baselineChannels: ReadonlySet<string>,
  uploads: readonly SourceUploadStatus[],
  detailUploadIds?: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  const baselineKeys = new Set([...baselineChannels].map(normalizeChannelKey));
  for (const { family, channels, platforms } of REQUIRED_SOURCE_FAMILIES) {
    if (!channels.some((channel) => baselineKeys.has(normalizeChannelKey(channel)))) continue;
    const satisfied = uploads.some((upload) => {
      if (!platforms.includes(normalizeChannelKey(upload.platform_code))) return false;
      const status = normalizeChannelPart(upload.status);
      if (status !== "parsed" && status !== "aggregated") return false;
      if (typeof upload.parsed_rows !== "number" || upload.parsed_rows <= 0) return false;
      if (!detailUploadIds) return true;
      return typeof upload.id === "string" && detailUploadIds.has(upload.id);
    });
    if (!satisfied) missing.push(family);
  }
  return missing;
}

export type SourceCompletenessDecision =
  | { ok: true; sourceWarnings: InputV2SourceWarning[] }
  | { ok: false; sourceWarnings: InputV2SourceWarning[]; loadError: InputV2LoadError };

export function decideSourceCompleteness(
  missingFamilies: readonly string[],
  options: LoadInputV2RecordsOptions = {},
): SourceCompletenessDecision {
  const sourceWarnings = missingFamilies
    .map((family) => String(family).trim())
    .filter(Boolean)
    .slice(0, REQUIRED_SOURCE_FAMILIES.length);
  if (sourceWarnings.length === 0 || options.allowIncompleteSources) {
    return { ok: true, sourceWarnings };
  }
  return {
    ok: false,
    sourceWarnings,
    loadError: {
      status: 409,
      error: "missing_source_family",
      details: `Required source uploads are missing, failed, or empty for this month: ${sourceWarnings.join(", ")}. Upload a successful statement for each family, then retry.`,
    },
  };
}

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
  options: LoadInputV2RecordsOptions = {},
): Promise<{
  records: Record<string, unknown>[];
  source: string;
  loadError: InputV2LoadError | null;
  sourceWarnings: InputV2SourceWarning[];
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
      sourceWarnings: [],
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
    // Contract rows must survive months with zero revenue. Build that roster
    // from real historical DB rows instead of replaying one fixed workbook.
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("sales_records")
        .select("*")
        .lt("settlement_batch", batchIso)
        .order("settlement_batch", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
    }

    if (all.length > 0) {
      // Summary/audit rows preserve evidence from payment notices, invoices,
      // and generic support-file fallbacks in the DB, but they are not ordinary
      // INPUT line items and must not be written to the NAKATANI workbook.
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const note2 = String(all[i]?.note2 ?? "");
        if (note2.includes("SUMMARY_NON_AGGREGATED")) all.splice(i, 1);
      }

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

    // Hide historical cross-upload duplicates (the same statement uploaded
    // twice, e.g. as CSV and XLSX) without touching the DB: per strict
    // logical key, keep one upload's rows and drop the re-uploaded copies.
    // Legitimate variants (same title, different type/month/amount) have
    // distinct keys and always survive.
    const piccomaDeduped = dedupePiccomaStatementDuplicates(all);
    if (piccomaDeduped.removed > 0) {
      console.warn(
        `[input-v2] ${month}: suppressed ${piccomaDeduped.removed} Piccoma paired duplicate rows`,
      );
    }
    const deduped = dedupeCrossUploadDuplicates(piccomaDeduped.records);
    if (deduped.removed > 0) {
      console.warn(
        `[input-v2] ${month}: suppressed ${deduped.removed} cross-upload duplicate rows`,
      );
    }
    const current = deduped.records.filter(
      (row) => String(row.settlement_batch ?? "").slice(0, 10) === batchIso,
    );
    const latestHistory = new Map<
      string,
      { batch: string; rows: Record<string, unknown>[] }
    >();
    for (const row of deduped.records) {
      const batch = String(row.settlement_batch ?? "").slice(0, 10);
      if (!batch || batch >= batchIso) continue;
      const key = carryForwardRecordKey(row);
      if (!key) continue;
      const found = latestHistory.get(key);
      if (!found || batch > found.batch) {
        latestHistory.set(key, { batch, rows: [row] });
      } else if (batch === found.batch) {
        found.rows.push(row);
      }
    }
    const baseline = [...latestHistory.values()].flatMap((entry) => entry.rows);

    // Source completeness gate: contract channels that live in the baseline
    // must be backed by a successful current-batch upload of their source
    // family, or the export must stop instead of silently zero-carrying.
    const baselineChannels = new Set(
      baseline
        .map((row) => normalizeChannelPart(row.channel ?? row.channel_code))
        .filter(Boolean),
    );
    const { data: uploads, error: uploadsError } = await supabase
      .from("raw_uploads")
      .select("id, platform_code, status, parsed_rows, parse_error")
      .eq("settlement_month", batchIso);
    if (uploadsError) throw uploadsError;
    // Uploads that produced current-batch non-summary sales_records (`all` was
    // already stripped of SUMMARY_NON_AGGREGATED rows above). Only these can
    // satisfy a required family — a summary-only fallback upload cannot.
    const currentDetailUploadIds = new Set<string>();
    for (const row of all) {
      if (String(row.settlement_batch ?? "").slice(0, 10) !== batchIso) continue;
      const uploadId = row.upload_id;
      if (typeof uploadId === "string" && uploadId.length > 0) {
        currentDetailUploadIds.add(uploadId);
      }
    }
    const missingFamilies = validateRequiredSourceFamilies(
      baselineChannels,
      (uploads ?? []) as SourceUploadStatus[],
      currentDetailUploadIds,
    );
    const sourceDecision = decideSourceCompleteness(missingFamilies, options);
    if (!sourceDecision.ok) {
      return {
        records: [],
        source: "supabase",
        loadError: sourceDecision.loadError,
        sourceWarnings: sourceDecision.sourceWarnings,
      };
    }

    const carried = mergeCarryForwardRows(baseline, current, month);
    return {
      records: carried.records,
      source: "supabase",
      loadError: null,
      sourceWarnings: sourceDecision.sourceWarnings,
    };
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
      sourceWarnings: [],
    };
  }
}
