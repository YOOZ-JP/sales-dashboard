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
      { error: "month must be YYYYMM, e.g. 202605" },
      { status: 400 },
    );
  }

  const { records, source } = await loadInputV2Records(month);
  if (records.length === 0) {
    return NextResponse.json(
      {
        error: `No data available for ${month}`,
        details: "No uploaded/processed settlement data exists yet. Upload files first, then preview again.",
      },
      { status: 404 },
    );
  }

  try {
    const { fillInputV2Template } = await import(
      "@/features/settlement/lib/export/input-v2-filler"
    );
    const { workbookBufferToPreview } = await import(
      "@/features/settlement/lib/export/workbook-preview"
    );
    const result = await fillInputV2Template({ month, records });
    const preview = await workbookBufferToPreview(result.buffer, {
      month,
      source,
      rowsWritten: result.rows_written,
      electronicRows: result.electronic_rows,
      publicationRows: result.publication_rows,
      generatedAt: new Date().toISOString(),
    });
    return NextResponse.json(preview);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to generate INPUT v2 preview",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
