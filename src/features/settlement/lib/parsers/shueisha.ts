/**
 * Shueisha parser — AI Vision.
 *
 * The source is a scanned image-only PDF (集英社 支払通知書) that has
 * no text layer, so regex-based extraction is impossible. We hand the
 * pages to Claude Sonnet via the Vercel AI Gateway and ask for a
 * structured JSON payload, then map it onto the standard rows.
 *
 * Output → Ground Truth mapping:
 *   · manga_mee rows → channel="manga mee", type="AD",
 *       channel_title_jp = "<TITLE>(広告)"
 *   · jumptoon rows  → channel="Jumptoon", type="EB",
 *       channel_title_jp = "<TITLE>(話配信|単行本)"
 *   · before_tax_income_jpy = payment_taxincl
 *   · after_tax_income_jpy  = round(payment / 1.10)
 *   · consumption_tax_jpy   = payment - after_tax_income_jpy
 */
import { z } from "zod";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { extractPdfWithAI } from "./ai-pdf";

const SHUEISHA_SCHEMA = z.object({
  grand_total_taxincl: z.number().nullable(),
  manga_mee_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese"),
      payment_taxincl: z.number().describe("支払金額 (税込), in JPY"),
    }),
  ),
  jumptoon_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese"),
      channel_kind: z
        .enum(["単行本", "話配信"])
        .describe("Which Jumptoon sub-channel the row belongs to"),
      payment_taxincl: z.number().describe("支払金額 (税込), in JPY"),
    }),
  ),
});

const PROMPT = `This is a 集英社 支払通知書 (payment notice) PDF from Shueisha. Extract every payment row.

Two section types appear:
  · "manga mee (広告)" — advertising royalty rows (per title)
  · "Jumptoon" — split into "単行本" (volume sales) and "話配信" (episode distribution)

For each row, capture:
  · the work title in Japanese exactly as printed (no translation, no truncation)
  · the 支払金額 / 税込金額 in JPY as a plain integer (remove commas, no currency symbol)

Also capture the overall 合計 (grand_total_taxincl) if it's printed on the cover. If no grand total is visible, use null.

Do NOT invent rows. If a number is illegible, make the whole row smaller rather than guessing.`;

export async function parseShueisha({
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];
  let data: z.infer<typeof SHUEISHA_SCHEMA>;
  try {
    data = await extractPdfWithAI({
      buffer,
      platform: "shueisha",
      schema: SHUEISHA_SCHEMA,
      prompt: PROMPT,
    });
  } catch (e) {
    return {
      platform_code: "shueisha",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`shueisha AI extraction failed: ${(e as Error).message}`],
    };
  }

  const records: ParseResult["records"] = [];
  let idx = 0;

  const emit = (title: string, suffix: string, type: "AD" | "EB", channel: string, paymentTaxIncl: number) => {
    const afterTaxIncome = Math.round(paymentTaxIncl / 1.10);
    const consumptionTax = paymentTaxIncl - afterTaxIncome;
    records.push({
      row_index: idx++,
      data: {
        title_jp: title,
        channel_title_jp: `${title}（${suffix}）`,
        type,
        channel_code: channel,
        client_code: "shueisha",
        before_tax_jpy: paymentTaxIncl,
        after_tax_jpy: afterTaxIncome,
        before_tax_income_jpy: paymentTaxIncl,
        after_tax_income_jpy: afterTaxIncome,
        after_tax_income_jpy_a: afterTaxIncome,
        consumption_tax_jpy: consumptionTax,
        withholding_tax_jpy: 0,
      },
    });
  };

  for (const row of data.manga_mee_rows) {
    emit(row.title, "広告", "AD", "manga mee", row.payment_taxincl);
  }
  for (const row of data.jumptoon_rows) {
    emit(row.title, row.channel_kind, "EB", "Jumptoon", row.payment_taxincl);
  }

  if (records.length === 0) {
    errors.push("shueisha: AI returned zero rows");
  }

  return {
    platform_code: "shueisha",
    sales_month: null,
    settlement_month: null,
    records,
    errors,
  };
}
