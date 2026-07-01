import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

async function loadRecords(month: string): Promise<{ records: Record<string, unknown>[]; source: string }> {
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
        "[export-v2] Supabase fetch failed, falling back to JSON:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { records: [], source: "none" };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ month: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { month: rawMonth } = await params;
  const month = rawMonth.replace(/\.xlsx$/i, "");
  if (!/^\d{6}$/.test(month)) {
    return NextResponse.json(
      { error: "month must be YYYYMM, e.g. 202604" },
      { status: 400 },
    );
  }

  const { records, source } = await loadRecords(month);
  if (records.length === 0) {
    return NextResponse.json(
      {
        error: `No data available for ${month}`,
        details: "No uploaded/processed settlement data exists yet. Upload files first, then export again.",
      },
      { status: 404 },
    );
  }

  try {
    const { fillInputV2Template } = await import(
      "@/features/settlement/lib/export/input-v2-filler"
    );
    const result = await fillInputV2Template({ month, records });
    return new NextResponse(result.buffer as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          `attachment; filename="JP_INPUT_V2_${month}.xlsx"; ` +
          `filename*=UTF-8''JP_INPUT_V2_${month}.xlsx`,
        "X-Export-V2-Source": source,
        "X-Export-V2-Rows": String(result.rows_written),
        "X-Export-V2-Electronic-Rows": String(result.electronic_rows),
        "X-Export-V2-Publication-Rows": String(result.publication_rows),
        "X-Export-V2-Electronic-Sheet": result.electronic_sheet,
        "X-Export-V2-Publication-Sheet": result.publication_sheet,
        "X-Export-V2-Fill-Ms": String(result.fill_ms),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to generate INPUT v2 xlsx",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
