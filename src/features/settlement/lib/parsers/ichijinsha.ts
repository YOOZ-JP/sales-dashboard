/**
 * Ichijinsha parser — AI Vision.
 *
 * The supplier delivers two PDFs:
 *   · 支払通知書.pdf         — cover letter (no rows)
 *   · 詳細別送の内訳.pdf     — detail table (authoritative)
 *
 * Two section types in the detail PDF:
 *   · MD (商品化使用料 / merchandise-license royalty) — per title
 *   · EB (国内電子 / domestic e-book) — per title, sometimes with a
 *     matching "(N)（MG）" offset row whose amount must be added to the
 *     sibling "(N)" row before × 1.10.
 *
 * AI returns a flat row list; this parser handles MG pairing + rounds
 * to GT shape.
 */
import { z } from "zod";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { extractPdfWithAI } from "./ai-pdf";
import aliases from "../../data/aliases/ichijinsha.json" with { type: "json" };

const TAX_RATE: number = aliases.rules.tax_rate;
const MD_SUFFIX: string = aliases.md_channel_title_suffix;

const ICHIJINSHA_SCHEMA = z.object({
  md_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese"),
      amount_taxexcl: z.number().describe("支払金額 (税抜), JPY"),
    }),
  ),
  eb_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese (include 巻数 e.g. ' 3' if printed)"),
      amount_taxexcl: z.number().describe("支払金額 (税抜), JPY"),
      is_mg_offset: z.boolean().describe("True when this row is the (MG) offset that pairs with a preceding title"),
    }),
  ),
});

const PROMPT = `This is a 一迅社 詳細別送の内訳 PDF (Ichijinsha royalty detail).

Extract two row types:

1. "md_rows" — 商品化使用料 / 複製色紙 rows.
   Pattern: "国内版権 一迅社20周年記念フレーム付き複製色紙 商品化権使用料 (TITLE) ... ... NET"
   The TITLE sometimes wraps across two lines between the outer ( ).
   Capture only the work title in Japanese and the final net 税抜 amount.

2. "eb_rows" — 国内電子 rows.
   Pattern: header "国内電子 TITLE", below that "集計期間：YYYY年MM月", then a line ending in the amount.
   Some rows come with a second "(MG)" row right after that shares the
   same volume number — mark that row with is_mg_offset: true.
   Capture the title exactly as printed (include the volume suffix like " 3" if shown).

Ignore the cover-letter totals; only the numeric detail rows matter.
If a number is illegible, shrink the row list rather than guessing.
Return amounts as plain integers (no commas, no currency symbol).`;

function sanitizeTitle(t: string): string {
  return t.replace(/[\s\u3000]+/g, " ").trim();
}

function normalizeVolumeTitle(t: string): string {
  // 「義家族に執着されています (3)」 → 「義家族に執着されています 3」
  return sanitizeTitle(t)
    .replace(/\s*[(（](\d+)[)）]\s*$/, " $1")
    .replace(/\s+/g, " ")
    .trim();
}

export async function parseIchijinsha({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const errors: string[] = [];

  // Cover letter carries no rows — bail early for it.
  if (/支払通知書\.pdf$/i.test(filename) && !/詳細/.test(filename)) {
    return {
      platform_code: "ichijinsha",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: ["ichijinsha: cover letter PDF contains no row-level data (expected)"],
    };
  }

  let data: z.infer<typeof ICHIJINSHA_SCHEMA>;
  try {
    data = await extractPdfWithAI({
      buffer,
      platform: "ichijinsha",
      schema: ICHIJINSHA_SCHEMA,
      prompt: PROMPT,
    });
  } catch (e) {
    return {
      platform_code: "ichijinsha",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`ichijinsha AI extraction failed: ${(e as Error).message}`],
    };
  }

  // Merge MG-offset rows onto the preceding EB row sharing the same volume.
  type EbRow = { title: string; amount: number };
  const ebMerged: EbRow[] = [];
  for (const r of data.eb_rows) {
    if (r.is_mg_offset && ebMerged.length > 0) {
      ebMerged[ebMerged.length - 1].amount += r.amount_taxexcl;
    } else {
      ebMerged.push({ title: r.title, amount: r.amount_taxexcl });
    }
  }

  const records: ParseResult["records"] = [];
  let idx = 0;

  for (const r of data.md_rows) {
    const before_tax_income = Math.round(r.amount_taxexcl * (1 + TAX_RATE));
    const after_tax_income = r.amount_taxexcl;
    const title = sanitizeTitle(r.title);
    records.push({
      row_index: idx++,
      data: {
        title_jp: title,
        channel_title_jp: `${title}${MD_SUFFIX}`,
        type: "MD",
        channel_code: "ichijinsha",
        client_code: "ichijinsha",
        before_tax_jpy: before_tax_income,
        after_tax_jpy: after_tax_income,
        before_tax_income_jpy: before_tax_income,
        after_tax_income_jpy: after_tax_income,
        after_tax_income_jpy_a: after_tax_income,
        consumption_tax_jpy: before_tax_income - after_tax_income,
        withholding_tax_jpy: 0,
      },
    });
  }

  for (const r of ebMerged) {
    const before_tax_income = Math.round(r.amount * (1 + TAX_RATE));
    const after_tax_income = r.amount;
    const title = normalizeVolumeTitle(r.title);
    records.push({
      row_index: idx++,
      data: {
        title_jp: title,
        channel_title_jp: title,
        type: "EB",
        channel_code: "ichijinsha",
        client_code: "ichijinsha",
        before_tax_jpy: before_tax_income,
        after_tax_jpy: after_tax_income,
        before_tax_income_jpy: before_tax_income,
        after_tax_income_jpy: after_tax_income,
        after_tax_income_jpy_a: after_tax_income,
        consumption_tax_jpy: before_tax_income - after_tax_income,
        withholding_tax_jpy: 0,
      },
    });
  }

  if (records.length === 0) errors.push("ichijinsha: AI returned zero rows");

  return {
    platform_code: "ichijinsha",
    sales_month: null,
    settlement_month: null,
    records,
    errors,
  };
}
