/**
 * SB Creative parser — AI Vision.
 *
 * Two PDF formats arrive monthly:
 *   · 前払印税報告書 (monthly pre-paid royalty report)
 *   · 支払通知書 (payment notice, consolidated per month-end)
 *
 * Business rule: the accountant's master sheet records SB Creative as
 * a SINGLE monthly line regardless of how many works or volumes are
 * listed on the PDF (see GT: title_jp=null, one row per month). This
 * parser therefore sums every detail row (less MG offsets and section-
 * header noise) into one aggregated figure before × 1.10.
 */
import { z } from "zod";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { extractPdfWithAI } from "./ai-pdf";

const TAX_RATE = 0.10;

const SB_SCHEMA = z.object({
  detail_rows: z.array(
    z.object({
      title: z.string().describe("Exact work title as printed (include 分冊版/巻 markers)"),
      amount_taxexcl: z.number().describe("税抜 amount, JPY (positive for revenue, negative for MG offset)"),
    }),
  ),
  mg_rollups: z
    .array(
      z.object({
        title_family: z
          .string()
          .describe("The parent title that this MG deduction belongs to"),
        mg_offset: z
          .number()
          .describe("当期MG取崩額 — positive integer to subtract from the family's revenue"),
      }),
    )
    .describe("Optional — only when the PDF carries a separate MG table"),
});

const PROMPT = `This is an SB Creative royalty PDF (前払印税報告書 or 支払通知書).

Extract every 税抜 amount row under the detail table. For each row:
  · capture the title exactly as printed (include 分冊版 / 巻数 / 話数 markers),
  · capture the 税抜 amount as a plain integer (positive integer for revenue lines;
    use a NEGATIVE integer if the row is an MG offset / 取崩額 that reduces revenue).

If a separate MG table (当期MG取崩額) appears at the bottom listing a title family
and its MG amount, extract it into "mg_rollups" — later processing subtracts those
from the family's revenue sum.

Ignore header/footer lines (発行日, 合計, 振込先, etc). Do not guess amounts.
Only return what is clearly printed.`;

/**
 * Rows whose title string is actually a section header or metadata
 * marker rather than a work title. AI Vision picks them up because
 * they sit alongside a 税抜 figure, but the accountant never counts
 * them as an individual work line — they're rolled into the client's
 * single monthly row.
 */
const METADATA_TITLE = /配信分|電子書籍[/／]|小計|合計|\bGA\b/;

export async function parseSbCreative({
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];
  let data: z.infer<typeof SB_SCHEMA>;
  try {
    data = await extractPdfWithAI({
      buffer,
      platform: "sb_creative",
      schema: SB_SCHEMA,
      prompt: PROMPT,
    });
  } catch (e) {
    return {
      platform_code: "sb_creative",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`sb-creative AI extraction failed: ${(e as Error).message}`],
    };
  }

  // Roll the whole PDF up into one client-level figure.
  let taxExcl = 0;
  for (const r of data.detail_rows) {
    if (METADATA_TITLE.test(r.title)) continue;
    taxExcl += r.amount_taxexcl;
  }
  for (const m of data.mg_rollups ?? []) {
    taxExcl -= m.mg_offset;
  }

  const records: ParseResult["records"] = [];
  if (taxExcl > 0) {
    const beforeTaxIncome = Math.round(taxExcl * (1 + TAX_RATE));
    const afterTaxIncome = taxExcl;
    records.push({
      row_index: 0,
      data: {
        // Left blank to mirror the GT's single-row format for SB Creative.
        title_jp: null,
        channel_title_jp: null,
        type: "EB",
        channel_code: "sb_creative",
        client_code: "sb_creative",
        before_tax_jpy: beforeTaxIncome,
        after_tax_jpy: afterTaxIncome,
        before_tax_income_jpy: beforeTaxIncome,
        after_tax_income_jpy: afterTaxIncome,
        after_tax_income_jpy_a: afterTaxIncome,
        consumption_tax_jpy: beforeTaxIncome - afterTaxIncome,
        withholding_tax_jpy: 0,
      },
    });
  } else {
    errors.push("sb-creative: zero or negative net revenue after aggregation");
  }

  return {
    platform_code: "sb_creative",
    sales_month: null,
    settlement_month: null,
    records,
    errors,
  };
}
