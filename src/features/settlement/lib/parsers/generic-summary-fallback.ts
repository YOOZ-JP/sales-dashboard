import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix } from "./common";
import { extractPdfText, findLabeledAmount, findMonth } from "./pdf-text";
import { buildSummaryRecord } from "./summary-record";

function normalizeSpace(s: string): string {
  return s.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
}

function filenameMonth(filename: string): string | null {
  const jp = filename.match(/(20\d{2})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${String(Number(jp[2])).padStart(2, "0")}-01`;
  const compact = filename.match(/(20\d{2})(0[1-9]|1[0-2])/);
  if (compact) return `${compact[1]}-${compact[2]}-01`;
  const yy = filename.match(/(?:^|[^\d])(\d{2})(0[1-9]|1[0-2])(?:[^\d]|$)/);
  if (yy) return `20${yy[1]}-${yy[2]}-01`;
  return null;
}

function inferKind(filename: string): string {
  if (/請求書/.test(filename)) return "invoice_summary_fallback";
  if (/支払通知|支払案内|掲載料通知/.test(filename)) return "payment_notice_summary_fallback";
  if (/report|レポート|明細|内訳/i.test(filename)) return "detail_report_summary_fallback";
  return "file_summary_fallback";
}

function inferTitle(filename: string, text?: string): string {
  const cleanName = filename.replace(/\.[^.]+$/, "");
  const hay = normalizeSpace(text ?? "");
  const subject = hay.match(/件名[：:]\s*(.+?)(?: 御請求金額| お支払期限| №| No|$)/)?.[1];
  if (subject) return subject.trim();
  return cleanName;
}

function amountsFromText(text: string): { tax_incl: number | null; tax_excl: number | null; consumption_tax: number | null; withholding_tax: number | null } {
  const labelsIncl = ["御請求金額", "お支払額合計", "支払額合計", "合計金額", "差引支払金額", "お支払額", "支払額", "版権支払額合計", "期間中売上合計"];
  const labelsExcl = ["小計", "計上額合計", "総収入金額", "税抜き金額", "お取引先様ご負担額合計"];
  const labelsTax = ["消費税", "消費税額"];
  const labelsWh = ["源泉額合計", "源泉税", "所得税"];
  let tax_incl: number | null = null;
  let tax_excl: number | null = null;
  let consumption_tax: number | null = null;
  let withholding_tax: number | null = null;
  for (const l of labelsIncl) { tax_incl = findLabeledAmount(text, l); if (tax_incl) break; }
  for (const l of labelsExcl) { tax_excl = findLabeledAmount(text, l); if (tax_excl) break; }
  for (const l of labelsTax) { consumption_tax = findLabeledAmount(text, l); if (consumption_tax) break; }
  for (const l of labelsWh) { withholding_tax = findLabeledAmount(text, l); if (withholding_tax) break; }
  if (tax_incl == null) {
    tax_incl = firstAmount(text, [
      /[¥￥\\]([\d,]+)\s+合計/,
      /[¥￥\\]([\d,]+)[^¥￥\\]{0,120}支払金額合計/,
      /支払金額\s+Payment amount[\s\S]{0,200}[¥￥\\]([\d,]+)/,
      /Total price[\s\S]{0,120}[¥￥\\]([\d,]+)/,
    ]);
  }
  return { tax_incl, tax_excl, consumption_tax, withholding_tax };
}

function firstAmount(text: string, patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function workbookTextAndAmount(buffer: Buffer): { text: string; amount: number | null; month: string | null } {
  const wb = readWorkbook(buffer);
  const chunks: string[] = [];
  for (const sheet of wb.SheetNames) {
    const m = sheetToMatrix(wb, sheet);
    chunks.push(sheet);
    for (const row of m) {
      for (const cell of row) {
        if (cell == null || cell === "") continue;
        chunks.push(String(cell));
      }
    }
  }
  const text = normalizeSpace(chunks.join(" "));
  const labeled = amountsFromText(text);
  const amount = labeled.tax_incl ?? labeled.tax_excl ?? null;
  const month = findMonth(text, [/(20\d{2})年\s*(\d{1,2})月/, /(20\d{2})[-/](\d{1,2})/]);
  return { text, amount, month };
}

export async function parseGenericSummaryFallback(opts: {
  filename: string;
  buffer: Buffer;
  platformCode: string;
  previousErrors?: string[];
}): Promise<ParseResult> {
  const { filename, buffer, platformCode } = opts;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  let text = "";
  let amount: number | null = null;
  let taxExcl: number | null = null;
  let tax: number | null = null;
  let withholding: number | null = null;
  let month: string | null = filenameMonth(filename);

  try {
    if (ext === "xlsx" || ext === "xls") {
      const wb = workbookTextAndAmount(buffer);
      text = wb.text;
      amount = wb.amount;
      month = wb.month ?? month;
      const a = amountsFromText(text);
      taxExcl = a.tax_excl;
      tax = a.consumption_tax;
      withholding = a.withholding_tax;
    } else if (ext === "pdf") {
      text = await extractPdfText(buffer, { maxPages: 3 });
      const a = amountsFromText(text);
      amount = a.tax_incl ?? a.tax_excl;
      taxExcl = a.tax_excl;
      tax = a.consumption_tax;
      withholding = a.withholding_tax;
      month = findMonth(text, [/(20\d{2})年\s*(\d{1,2})月/, /(20\d{2})[-/](\d{1,2})/]) ?? month;
    } else {
      text = buffer.toString("utf8");
      const a = amountsFromText(text);
      amount = a.tax_incl ?? a.tax_excl;
      taxExcl = a.tax_excl;
      tax = a.consumption_tax;
      withholding = a.withholding_tax;
    }
  } catch {
    // keep fallback alive; produce a representation row below
  }

  const rawTitle = inferTitle(filename, text);
  const hasAmount = amount != null || taxExcl != null;
  return {
    platform_code: platformCode,
    sales_month: month,
    settlement_month: month,
    records: [
      buildSummaryRecord({
        platform_code: platformCode,
        raw_title: rawTitle,
        source_file_kind: inferKind(filename),
        client_code: platformCode,
        channel_code: platformCode,
        type: "OTHER",
        sales_month: month,
        settlement_month: month,
        amounts: { tax_incl: amount, tax_excl: taxExcl, consumption_tax: tax },
        withholding_tax_jpy: withholding ?? 0,
        note1: hasAmount
          ? `${platformCode}: generic summary fallback after zero-row parser`
          : `${platformCode}: generic summary fallback; amount not machine-extracted, manual review required`,
        extra: {
          original_parser_errors: opts.previousErrors ?? [],
          generic_summary_needs_review: !hasAmount,
        },
      }),
    ],
    errors: [],
  };
}
