import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { loadInputV2Records } from "@/features/settlement/lib/export/load-input-v2-records";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  const { records, source, loadError } = await loadInputV2Records(month);
  if (loadError) {
    return NextResponse.json(
      { error: loadError.error, details: loadError.details },
      { status: loadError.status },
    );
  }
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
