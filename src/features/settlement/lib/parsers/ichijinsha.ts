/**
 * Ichijinsha parser.
 *
 * The supplier delivers two PDFs:
 *   · 支払通知書.pdf         — cover letter (no rows)
 *   · 詳細別送の内訳.pdf     — detail table (authoritative)
 *
 * The 詳細別送の内訳 PDF is parsed deterministically from its flattened
 * text layer (extractPdfText): repeated 国内電子 blocks of
 *   国内電子 + title + 集計期間：YYYY年MM月[～YYYY年MM月] + signed amount.
 * "(N)（MG）" offset rows are merged into the normal row sharing the same
 * normalized title+volume key regardless of adjacency. A zero-row text or
 * an unmatched MG offset is a hard parser error (never a generic summary).
 *
 * RIVERSE-issued 請求書 twins (XLSX + PDF) also arrive per settlement:
 *   · the PDF twin is summary/audit evidence only (is_summary),
 *   · the XLSX grid carries real line items which are classified
 *     semantically from the 内容 text (paper 単行本 → PP, 電子 volume
 *     range → EB, 素材費 volume range → MF, anniversary 原稿料 detail
 *     → MF) and inclusive volume ranges are expanded per volume.
 *
 * Canonical channel titles carry the volume in fullwidth parentheses with
 * fullwidth digits: 「タイトル（７）」.
 */
import { z } from "zod";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { extractPdfWithAI } from "./ai-pdf";
import { extractPdfText } from "./pdf-text";
import { parseInvoicePdf, parseInvoiceXlsx } from "./invoice-common";
import aliases from "../../data/aliases/ichijinsha.json" with { type: "json" };

const TAX_RATE: number = aliases.rules.tax_rate;
const MD_SUFFIX: string = aliases.md_channel_title_suffix;
/** Structural suffix for anniversary manuscript-fee detail rows. */
const ANNIVERSARY_MF_SUFFIX = "（20th色紙原稿料）";

const ICHIJINSHA_SCHEMA = z.object({
  md_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese"),
      amount_taxexcl: z.number().describe("支払金額 (税抜), JPY"),
      sales_month: z
        .string()
        .nullable()
        .optional()
        .describe("Source 集計期間 / 対象月 as YYYY-MM-01 when printed"),
    }),
  ),
  eb_rows: z.array(
    z.object({
      title: z.string().describe("Work title in Japanese (include 巻数 e.g. ' 3' if printed)"),
      amount_taxexcl: z.number().describe("支払金額 (税抜), JPY"),
      is_mg_offset: z.boolean().describe("True when this row is the (MG) offset that pairs with a preceding title"),
      sales_month: z
        .string()
        .nullable()
        .optional()
        .describe("Source 集計期間 / 対象月 as YYYY-MM-01 when printed"),
    }),
  ),
});

const PROMPT = `This is a 一迅社 royalty statement PDF (Ichijinsha).

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

For every row, preserve the source 集計期間 / 対象月 as sales_month (YYYY-MM-01) when printed.
Ignore the cover-letter totals; only the numeric detail rows matter.
If a number is illegible, shrink the row list rather than guessing.
Return amounts as plain integers (no commas, no currency symbol).`;

/** Statement title cleanup (MD rows only — invoice items keep raw text). */
function sanitizeTitle(t: string): string {
  const normalized = t.replace(/[\s\u3000]+/g, " ").trim();
  const quoted = normalized.match(/「([^」]+)」/u)?.[1]?.trim();
  return (quoted || normalized)
    .replace(/(?:イラスト)?原稿料$/u, "")
    .trim();
}

function toAsciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d)));
}

function toFullwidthDigits(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => "０１２３４５６７８９"[Number(d)]);
}

/** Canonical channel title: volume in fullwidth parens with fullwidth digits. */
function volumeTitle(base: string, volume: number | null): string {
  return volume == null ? base : `${base}（${toFullwidthDigits(volume)}）`;
}

/** Split a trailing volume marker — "X (3)" / "X（３）" / "X 3" → base + volume. */
function splitTrailingVolume(t: string): { base: string; volume: number | null } {
  const normalized = t.replace(/[\s\u3000]+/g, " ").trim();
  const m =
    normalized.match(/^(.*?)\s*[（(]\s*([0-9０-９]+)\s*[）)]$/u) ??
    normalized.match(/^(.*?)\s+([0-9０-９]+)$/u);
  if (!m) return { base: normalized, volume: null };
  return { base: m[1].trim(), volume: Number(toAsciiDigits(m[2])) };
}

/** Whitespace-insensitive merge key over base title + volume. */
function detailMergeKey(base: string, volume: number | null): string {
  return `${base.replace(/[\s\u3000]+/g, "")}#${volume ?? ""}`;
}

const MG_MARKER_RE = /[（(]\s*[MＭ][GＧ]\s*[）)]\s*$/iu;
const PERIOD_RE = /(\d{4})年\s*(\d{1,2})月(?:\s*[～〜~\-－]\s*(?:(\d{4})年\s*)?(\d{1,2})月)?/u;

export interface IchijinshaDetailEbRow {
  title: string; // canonical: base（Ｎ） with fullwidth digits, MG merged
  amount_taxexcl: number;
  sales_month: string | null;
}

/**
 * Pure structural parser for the flattened 詳細別送の内訳 text layer.
 * Emits normal EB rows with MG offsets merged by title+volume key
 * (adjacency-independent). Zero detail rows or an unmatched MG offset is
 * returned as an explicit error — callers must not mask it as a summary.
 */
export function parseIchijinshaDetailText(text: string): {
  rows: IchijinshaDetailEbRow[];
  errors: string[];
} {
  const errors: string[] = [];
  const flat = toAsciiDigits(String(text ?? "")).replace(/[\s\u3000]+/g, " ");
  type Normal = { key: string; title: string; amount: number; sales_month: string | null };
  const normals: Normal[] = [];
  const offsets: Array<{ key: string; raw: string; amount: number }> = [];

  for (const segment of flat.split("国内電子").slice(1)) {
    const periodIdx = segment.search(/集計期間\s*[：:]/u);
    if (periodIdx < 0) continue; // not a detail row (cover text etc.)
    const rawTitle = segment.slice(0, periodIdx).trim();
    if (!rawTitle) continue;

    const afterLabel = segment.slice(periodIdx).replace(/^集計期間\s*[：:]\s*/u, "");
    const period = afterLabel.match(PERIOD_RE);
    if (!period) {
      errors.push(`ichijinsha: 集計期間 without a readable month near "${rawTitle}"`);
      continue;
    }
    // A range keeps the FINAL year/month (e.g. 2026年4月～6月 → 2026-06-01).
    const year = period[4] != null ? (period[3] ?? period[1]) : period[1];
    const month = period[4] ?? period[2];
    const sales_month = `${year}-${String(Number(month)).padStart(2, "0")}-01`;

    const remainder = afterLabel.slice((period.index ?? 0) + period[0].length);
    const amountToken = remainder.match(/-?\d[\d,]*/);
    if (!amountToken) {
      errors.push(`ichijinsha: no amount found for detail row "${rawTitle}"`);
      continue;
    }
    const amount = Number(amountToken[0].replace(/,/g, ""));
    if (!Number.isFinite(amount)) {
      errors.push(`ichijinsha: unreadable amount "${amountToken[0]}" for "${rawTitle}"`);
      continue;
    }

    const isMg = MG_MARKER_RE.test(rawTitle);
    const { base, volume } = splitTrailingVolume(rawTitle.replace(MG_MARKER_RE, "").trim());
    const key = detailMergeKey(base, volume);
    if (isMg) {
      offsets.push({ key, raw: rawTitle, amount });
    } else {
      normals.push({ key, title: volumeTitle(base, volume), amount, sales_month });
    }
  }

  if (normals.length === 0) {
    errors.push("ichijinsha: 詳細別送の内訳 text yielded zero detail rows");
    return { rows: [], errors };
  }

  for (const offset of offsets) {
    const target = normals.find((row) => row.key === offset.key);
    if (!target) {
      errors.push(`ichijinsha: MG offset "${offset.raw}" has no matching detail row`);
      continue;
    }
    target.amount += offset.amount;
  }

  return {
    rows: normals.map(({ title, amount, sales_month }) => ({
      title,
      amount_taxexcl: amount,
      sales_month,
    })),
    errors,
  };
}

export type IchijinshaItemKind =
  | "manuscript_fee"
  | "paper_book"
  | "electronic"
  | "material_fee"
  | "other";

export interface IchijinshaInvoiceItem {
  raw_title: string;
  base_title: string;
  volume_start: number | null;
  volume_end: number | null;
  item_kind: IchijinshaItemKind;
  type: "EB" | "MF" | "PP";
}

const ITEM_TYPE: Record<IchijinshaItemKind, "EB" | "MF" | "PP"> = {
  manuscript_fee: "MF",
  paper_book: "PP",
  electronic: "EB",
  material_fee: "MF",
  other: "MF",
};

// 第7巻 / 第7～9巻 / 7-9巻 — inclusive volume (range) marker.
const VOLUME_RE = /第?\s*(\d+)\s*(?:[～〜~\-－―]\s*第?\s*(\d+)\s*)?巻/u;

/**
 * Classify a raw 請求書 内容 string BEFORE any title cleanup.
 * The semantic markers (単行本 / 電子 / 素材費 / 原稿料) live outside the
 * 「…」-quoted work title; the quoted part is preserved as base_title.
 */
export function classifyIchijinshaInvoiceItem(
  rawTitle: string,
  ctx: { anniversary?: boolean } = {},
): IchijinshaInvoiceItem {
  const raw = toAsciiDigits(String(rawTitle ?? ""))
    .replace(/[\s\u3000]+/g, " ")
    .trim();
  const quoted = raw.match(/「([^」]+)」/u);
  // markers/volumes are read outside the quoted title so that work titles
  // containing e.g. 数字+巻 or 電子 are never misread as markers.
  const outside = quoted ? raw.replace(quoted[0], " ") : raw;

  const vol = outside.match(VOLUME_RE);
  const volume_start = vol ? Number(vol[1]) : null;
  const volume_end = vol ? Number(vol[2] ?? vol[1]) : null;

  let item_kind: IchijinshaItemKind;
  if (/素材費/u.test(outside)) item_kind = "material_fee";
  else if (/電子/u.test(outside)) item_kind = "electronic";
  else if (/単行本|紙/u.test(outside)) item_kind = "paper_book";
  else if (/原稿料/u.test(outside) || ctx.anniversary) item_kind = "manuscript_fee";
  else item_kind = "other";

  let base_title: string;
  if (quoted) {
    base_title = quoted[1].trim();
  } else {
    base_title = raw
      .replace(VOLUME_RE, " ")
      .replace(/[(（][^)）]*[)）]\s*$/u, " ")
      .replace(/(?:イラスト)?原稿料$/u, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return {
    raw_title: rawTitle,
    base_title,
    volume_start,
    volume_end,
    item_kind,
    type: ITEM_TYPE[item_kind],
  };
}

/**
 * Expand an inclusive volume range into per-volume rows.
 * Validates range length against the source 数量 and allocates the source
 * line total per volume (unit price first, remainder on the last volume) so
 * the expanded sum always equals the source line total.
 */
export function expandIchijinshaVolumeRange(
  item: IchijinshaInvoiceItem,
  money: { quantity?: number | null; unit_price_jpy?: number | null; line_total_jpy: number },
): { rows: Array<{ volume: number; base_title: string; amount_jpy: number }> } | { error: string } {
  const { volume_start, volume_end } = item;
  if (volume_start == null || volume_end == null || volume_end < volume_start) {
    return { error: `invalid volume range ${volume_start}–${volume_end}` };
  }
  const count = volume_end - volume_start + 1;
  if (typeof money.quantity === "number" && money.quantity !== count) {
    return {
      error: `volume range 第${volume_start}～${volume_end}巻 length ${count} ≠ 数量 ${money.quantity}`,
    };
  }
  const unit = typeof money.unit_price_jpy === "number" && money.unit_price_jpy > 0
    ? money.unit_price_jpy
    : Math.floor(money.line_total_jpy / count);
  const rows: Array<{ volume: number; base_title: string; amount_jpy: number }> = [];
  let allocated = 0;
  for (let v = volume_start; v <= volume_end; v++) {
    const amount = v === volume_end ? money.line_total_jpy - allocated : unit;
    allocated += amount;
    rows.push({ volume: v, base_title: item.base_title, amount_jpy: amount });
  }
  const sum = rows.reduce((s, r) => s + r.amount_jpy, 0);
  if (sum !== money.line_total_jpy) {
    return { error: `expanded sum ${sum} ≠ line total ${money.line_total_jpy}` };
  }
  return { rows };
}

function setLineAmounts(data: Record<string, unknown>, afterTax: number): void {
  const beforeTax = Math.round(afterTax * (1 + TAX_RATE));
  data.after_tax_jpy = afterTax;
  data.before_tax_jpy = beforeTax;
  data.after_tax_income_jpy = afterTax;
  data.before_tax_income_jpy = beforeTax;
  data.consumption_tax_jpy = beforeTax - afterTax;
}

export function retagInvoiceRows(
  result: ParseResult,
  filename: string,
  markSummary: boolean,
): ParseResult {
  const anniversary = filename.includes("20周年記念") || filename.includes("イラスト原稿料");
  const errors = [...result.errors];
  const records: ParseResult["records"] = [];
  let idx = 0;
  const push = (data: Record<string, unknown>) => records.push({ row_index: idx++, data });

  for (const record of result.records) {
    const data = record.data;
    data.total_amount_jpy = null;
    // Invoice rows are booked in the settlement/payment month shown by the
    // accounting answer key. Detailed statements never pass through this
    // helper and therefore keep their original source sales month.
    // Anniversary manuscript-fee rows are the exception (handled below):
    // their invoice states no sales period, and the payment month is not
    // sales evidence.
    const bookedSalesMonth =
      result.settlement_month ?? data.sales_month ?? result.sales_month ?? null;

    // Only PDF twins (and explicit summary fallbacks) stay summary/audit
    // evidence; XLSX line items are never promoted to summary.
    if (markSummary || data.is_summary === true) {
      data.sales_month = bookedSalesMonth;
      data.is_summary = true;
      data.source_file_kind = data.source_file_kind ?? "ichijinsha_invoice";
      data.note1 = [data.note1, "invoice summary evidence — excluded from INPUT detail"]
        .filter(Boolean)
        .join(" / ");
      push(data);
      continue;
    }

    data.source_file_kind = data.source_file_kind ?? "ichijinsha_invoice_xlsx";
    const rawTitle = String(data.raw_title ?? data.title_jp ?? data.channel_title_jp ?? "");
    const item = classifyIchijinshaInvoiceItem(rawTitle, { anniversary });
    data.type = item.type;
    data.raw_title = rawTitle;

    if (item.item_kind === "manuscript_fee") {
      // The anniversary 原稿料 invoice carries no 集計期間, so only a
      // source-printed sales month may fill the cell; otherwise it stays
      // blank and is flagged for manual review — never the payment month.
      data.sales_month = data.sales_month ?? null;
      if (data.sales_month == null) {
        data.note1 = [data.note1, "sales month needs review — invoice states no sales period"]
          .filter(Boolean)
          .join(" / ");
      }
    } else {
      data.sales_month = bookedSalesMonth;
    }

    const isRange =
      item.volume_start != null && item.volume_end != null && item.volume_end > item.volume_start;
    if (isRange) {
      const lineTotal = Number(data.after_tax_jpy ?? 0);
      const expanded = expandIchijinshaVolumeRange(item, {
        quantity: typeof data.quantity === "number" ? data.quantity : null,
        unit_price_jpy: typeof data.unit_price_jpy === "number" ? data.unit_price_jpy : null,
        line_total_jpy: lineTotal,
      });
      if ("error" in expanded) {
        errors.push(`ichijinsha: ${expanded.error} (${rawTitle})`);
        push(data); // keep the source row unexpanded rather than losing it
        continue;
      }
      for (const perVolume of expanded.rows) {
        const rowData: Record<string, unknown> = { ...data };
        const title = volumeTitle(perVolume.base_title, perVolume.volume);
        rowData.title_jp = title;
        rowData.channel_title_jp = title;
        rowData.quantity = 1;
        setLineAmounts(rowData, perVolume.amount_jpy);
        push(rowData);
      }
      continue;
    }

    data.title_jp = volumeTitle(item.base_title, item.volume_start);
    data.channel_title_jp =
      item.item_kind === "manuscript_fee"
        ? `${item.base_title}${ANNIVERSARY_MF_SUFFIX}`
        : (data.title_jp as string);
    push(data);
  }
  return { ...result, records, errors };
}

/**
 * Extract a validated YYYYMMDD deposit date from the source folder basename
 * (e.g. a platform folder prefixed with the deposit date). Returns an ISO
 * YYYY-MM-DD string, or null when no valid calendar-date token exists.
 */
export function extractIchijinshaFolderDepositDate(
  folderName?: string | null,
): string | null {
  if (!folderName) return null;
  const basename = folderName.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const token = basename.match(/(?<!\d)(\d{8})(?!\d)/)?.[1];
  if (!token) return null;
  const year = Number(token.slice(0, 4));
  const month = Number(token.slice(4, 6));
  const day = Number(token.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return valid ? `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}` : null;
}

/**
 * Apply the folder-derived deposit date to authoritative (non-summary)
 * detail records. Summary/audit evidence rows are never touched.
 */
export function applyIchijinshaFolderDepositDate(
  result: ParseResult,
  depositDate: string | null,
): ParseResult {
  if (!depositDate) return result;
  for (const record of result.records) {
    if (record.data.is_summary === true) continue;
    record.data.deposit_month = depositDate;
  }
  return result;
}

function buildEbRecord(
  idx: number,
  title: string,
  amountTaxExcl: number,
  salesMonth: string | null,
): ParseResult["records"][number] {
  const before_tax_income = Math.round(amountTaxExcl * (1 + TAX_RATE));
  return {
    row_index: idx,
    data: {
      title_jp: title,
      channel_title_jp: title,
      type: "EB",
      channel_code: "ichijinsha",
      client_code: "ichijinsha",
      before_tax_jpy: before_tax_income,
      after_tax_jpy: amountTaxExcl,
      before_tax_income_jpy: before_tax_income,
      after_tax_income_jpy: amountTaxExcl,
      after_tax_income_jpy_a: amountTaxExcl,
      consumption_tax_jpy: before_tax_income - amountTaxExcl,
      withholding_tax_jpy: 0,
      sales_month: salesMonth,
      total_amount_jpy: null,
    },
  };
}

export async function parseIchijinsha({
  filename,
  buffer,
  folderName,
}: {
  filename: string;
  buffer: Buffer;
  folderName?: string;
}): Promise<ParseResult> {
  const errors: string[] = [];
  const folderDeposit = extractIchijinshaFolderDepositDate(folderName);

  if (/【請求書】一迅社様/.test(filename)) {
    const ctx = {
      platform_code: "ichijinsha",
      client_code: "ichijinsha",
      channel_code: "ichijinsha",
      type: filename.includes("20周年記念") ? "MD" : "EB",
      note: "ichijinsha invoice summary — non-aggregated evidence row",
    };
    const isPdf = /\.pdf$/i.test(filename);
    const result = await (isPdf
      ? parseInvoicePdf(filename, buffer, ctx)
      : parseInvoiceXlsx(filename, buffer, ctx));
    // PDF twins are summary/audit evidence only; the XLSX carries line items.
    return applyIchijinshaFolderDepositDate(
      retagInvoiceRows(result, filename, isPdf),
      folderDeposit,
    );
  }

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

  // Authoritative detail statement — deterministic text parse, no AI.
  if (/詳細別送の内訳/.test(filename)) {
    let text = "";
    try {
      text = await extractPdfText(buffer, { maxPages: 3 });
    } catch (e) {
      return {
        platform_code: "ichijinsha",
        sales_month: null,
        settlement_month: null,
        records: [],
        errors: [`ichijinsha: 詳細別送の内訳 text extraction failed: ${(e as Error).message}`],
      };
    }
    const parsed = parseIchijinshaDetailText(text);
    if (parsed.errors.length > 0) {
      return {
        platform_code: "ichijinsha",
        sales_month: null,
        settlement_month: null,
        records: [],
        errors: parsed.errors,
      };
    }
    return applyIchijinshaFolderDepositDate(
      {
        platform_code: "ichijinsha",
        sales_month: null,
        settlement_month: null,
        records: parsed.rows.map((r, i) => buildEbRecord(i, r.title, r.amount_taxexcl, r.sales_month)),
        errors: [],
      },
      folderDeposit,
    );
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

  // Merge MG-offset rows onto the EB row sharing the same title+volume key
  // (falling back to the preceding row when no key matches).
  type EbRow = { title: string; amount: number; sales_month: string | null };
  const aiKey = (t: string) => {
    const { base, volume } = splitTrailingVolume(t.replace(MG_MARKER_RE, "").trim());
    return detailMergeKey(base, volume);
  };
  const ebMerged: EbRow[] = [];
  for (const r of data.eb_rows) {
    if (r.is_mg_offset && ebMerged.length > 0) {
      const key = aiKey(r.title);
      const target = ebMerged.find((row) => aiKey(row.title) === key);
      (target ?? ebMerged[ebMerged.length - 1]).amount += r.amount_taxexcl;
    } else {
      ebMerged.push({ title: r.title, amount: r.amount_taxexcl, sales_month: r.sales_month ?? null });
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
        sales_month: r.sales_month ?? null,
        total_amount_jpy: null,
      },
    });
  }

  for (const r of ebMerged) {
    const { base, volume } = splitTrailingVolume(sanitizeTitle(r.title));
    records.push(buildEbRecord(idx++, volumeTitle(base, volume), r.amount, r.sales_month));
  }

  if (records.length === 0) errors.push("ichijinsha: AI returned zero rows");

  return applyIchijinshaFolderDepositDate(
    {
      platform_code: "ichijinsha",
      sales_month: null,
      settlement_month: null,
      records,
      errors,
    },
    folderDeposit,
  );
}
