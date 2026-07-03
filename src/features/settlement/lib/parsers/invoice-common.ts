/**
 * invoice-common.ts — RIVERSE-issued 請求書 (invoice) template parser.
 *
 * KADOKAWA / めちゃコミック / ピッコマ外販 MG & royalty invoices all share
 * one Excel template: a header block (件名 / 発行日 / 御請求金額(税込) /
 * お支払期限), a numbered item grid (№ | 内容 | 単価 | [印税率] | 数量 |
 * 金額, tax-exclusive) and a 小計 / 消費税額 / 合計金額 footer.
 *
 * The XLSX carries the grid natively → one record per line item.
 * The PDF twin is the printed version; its text stream reorders table
 * cells, so the PDF is parsed at summary level only (件名 + 御請求金額),
 * leaving line items to the XLSX.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";
import { extractPdfText, findMonth } from "./pdf-text";
import { buildSummaryRecord } from "./summary-record";

export interface InvoiceContext {
  platform_code: string;
  client_code: string;
  channel_code: string;
  /** record type for emitted rows (e.g. "OTHER" for MG invoices) */
  type?: string;
  /** extra note appended to every record */
  note?: string;
}

function cellStr(v: unknown): string {
  return String(v ?? "").replace(/\u3000/g, " ").trim();
}

/** "件名：EPUB外販ロイヤリティー（2026年5月度）" / "…_202505（…" → YYYY-MM-01 */
function monthFromText(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    if (!t) continue;
    const jp = t.match(/(\d{4})年\s*(\d{1,2})月/);
    if (jp) return `${jp[1]}-${String(Number(jp[2])).padStart(2, "0")}-01`;
    const compact = t.match(/(20\d{2})(0[1-9]|1[0-2])/);
    if (compact) return `${compact[1]}-${compact[2]}-01`;
  }
  return null;
}

function monthFromDateish(v: unknown): string | null {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-01`;
  }
  return monthFromText(cellStr(v));
}

/** Parse the invoice XLSX grid into per-item records. */
export function parseInvoiceXlsx(
  filename: string,
  buffer: Buffer,
  ctx: InvoiceContext,
): ParseResult {
  const errors: string[] = [];
  const wb = readWorkbook(buffer);
  const sheetName = wb.SheetNames.find((n) => n.includes("請求書")) ?? wb.SheetNames[0];
  const matrix = sheetToMatrix(wb, sheetName);

  let subject: string | null = null;
  let issueMonth: string | null = null;
  let dueMonth: string | null = null;
  let totalIncl: number | null = null;
  let subtotal: number | null = null;
  let taxAmount: number | null = null;
  let header: { row: number; content: number; unit: number; rate: number; qty: number; amount: number } | null = null;

  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    for (let j = 0; j < row.length; j++) {
      const s = cellStr(row[j]);
      if (!s) continue;
      if (s.startsWith("件名：")) subject = s.slice(3).trim();
      else if (s === "発行日") issueMonth = monthFromDateish(row[j + 1] ?? matrix[i + 1]?.[j]);
      else if (s.startsWith("お支払期限")) {
        for (let k = j + 1; k < row.length; k++) {
          const m = monthFromDateish(row[k]);
          if (m) { dueMonth = m; break; }
        }
      } else if (s === "御請求金額") {
        const num = row.slice(j + 1).map(toNumber).find((n) => n !== 0);
        if (num != null) totalIncl = num;
      } else if (s === "小計") subtotal = lastNumber(row) ?? subtotal;
      else if (s.startsWith("消費税額")) taxAmount = lastNumber(row) ?? taxAmount;
      else if (s === "№" || s === "No") {
        const cols = mapColumns(row);
        if (cols) header = { row: i, ...cols };
      }
    }
  }

  const records: RawRecord[] = [];
  const salesMonth = monthFromText(subject, filename) ?? issueMonth;

  if (header) {
    let idx = 0;
    for (let i = header.row + 1; i < matrix.length; i++) {
      const row = matrix[i] ?? [];
      const content = cellStr(row[header.content]);
      // grid ends at the 振込手数料/footer block
      if (content.includes("振込手数料") || content.includes("振込先")) break;
      const amount = toNumber(row[header.amount]);
      if (!content || amount === 0) continue;

      const rate = header.rate >= 0 ? cellStr(row[header.rate]) : "";
      records.push({
        row_index: idx++,
        data: {
          title_jp: content,
          channel_title_jp: content,
          raw_title: content,
          client_code: ctx.client_code,
          channel_code: ctx.channel_code,
          type: ctx.type ?? "OTHER",
          sales_month: salesMonth,
          settlement_month: dueMonth,
          // item 金額 is tax-exclusive; the invoice adds 10% at footer level
          total_amount_jpy: Math.round(amount * 1.1),
          fee_jpy: 0,
          before_tax_jpy: Math.round(amount * 1.1),
          after_tax_jpy: amount,
          before_tax_income_jpy: Math.round(amount * 1.1),
          after_tax_income_jpy: amount,
          withholding_tax_jpy: 0,
          consumption_tax_jpy: Math.round(amount * 1.1) - amount,
          unit_price_jpy: toNumber(row[header.unit]) || null,
          quantity: header.qty >= 0 ? toNumber(row[header.qty]) || null : null,
          royalty_rate_label: rate && rate !== "-" ? rate : null,
          source_file_kind: "invoice_xlsx",
          note1: [ctx.note, subject ? `件名: ${subject}` : null].filter(Boolean).join(" / ") || null,
        },
      });
    }
  }

  if (records.length === 0) {
    // Grid not found or empty — fall back to a single summary record so the
    // file is still represented.
    if (totalIncl != null || subtotal != null) {
      records.push(
        buildSummaryRecord({
          platform_code: ctx.platform_code,
          raw_title: subject ?? filename.replace(/\.[^.]+$/, ""),
          source_file_kind: "invoice_xlsx_summary",
          client_code: ctx.client_code,
          channel_code: ctx.channel_code,
          type: ctx.type ?? "OTHER",
          sales_month: salesMonth,
          settlement_month: dueMonth,
          amounts: { tax_incl: totalIncl, tax_excl: subtotal, consumption_tax: taxAmount },
          note1: ctx.note ?? null,
        }),
      );
    } else {
      errors.push(`invoice: no item rows or totals found in "${sheetName}" (${filename})`);
    }
  } else if (subtotal != null) {
    const sum = records.reduce((s, r) => s + Number(r.data.after_tax_jpy ?? 0), 0);
    if (sum !== subtotal) {
      errors.push(`invoice: item sum ${sum} ≠ 小計 ${subtotal} (${filename})`);
    }
  }

  return {
    platform_code: ctx.platform_code,
    sales_month: salesMonth,
    settlement_month: dueMonth,
    records,
    errors,
  };
}

function lastNumber(row: unknown[]): number | null {
  for (let j = row.length - 1; j >= 0; j--) {
    const v = row[j];
    if (v == null || cellStr(v) === "") continue;
    const n = toNumber(v);
    if (n !== 0) return n;
  }
  return null;
}

function mapColumns(row: unknown[]): { content: number; unit: number; rate: number; qty: number; amount: number } | null {
  let content = -1, unit = -1, rate = -1, qty = -1, amount = -1;
  row.forEach((c, j) => {
    const s = cellStr(c).replace(/\s+/g, "");
    if (s === "内容") content = j;
    else if (s === "単価") unit = j;
    else if (s === "印税率") rate = j;
    else if (s === "数量") qty = j;
    else if (s === "金額") amount = j;
  });
  return content >= 0 && amount >= 0 ? { content, unit, rate, qty, amount } : null;
}

/** Parse the printed PDF twin at summary level (件名 + 御請求金額). */
export async function parseInvoicePdf(
  filename: string,
  buffer: Buffer,
  ctx: InvoiceContext,
): Promise<ParseResult> {
  const text = await extractPdfText(buffer, { maxPages: 2 });
  if (!text.trim()) {
    return {
      platform_code: ctx.platform_code,
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`invoice: PDF has no extractable text layer (${filename})`],
    };
  }

  const subjectMatch = text.match(/件名[：:]\s*(.+?)(?:\s{2,}|御請求金額|お支払期限|№|$)/);
  const subject = subjectMatch?.[1]?.trim() ?? null;
  // The label is often followed by the payment deadline before the ¥ amount
  // ("御請求金額 2026年5月末日¥11,000,000") — require the currency symbol.
  // 小計 / 消費税額 are typographically detached from their numbers in the
  // text stream, so the trio is derived from the (uniform-10%) total instead.
  const totalIncl = text.match(/御請求金額[^¥￥\\]{0,40}[¥￥\\]([\d,]+)/)?.[1];
  const totalInclNum = totalIncl != null ? Number(totalIncl.replace(/,/g, "")) : null;
  const salesMonth = monthFromText(subject, filename);
  const dueMonth = findMonth(text, [/お支払期限[：:]?\s*(\d{4})年(\d{1,2})月/]);

  if (totalInclNum == null || !Number.isFinite(totalInclNum)) {
    return {
      platform_code: ctx.platform_code,
      sales_month: salesMonth,
      settlement_month: dueMonth,
      records: [],
      errors: [`invoice: no 御請求金額/小計 found in PDF text (${filename})`],
    };
  }

  return {
    platform_code: ctx.platform_code,
    sales_month: salesMonth,
    settlement_month: dueMonth,
    records: [
      buildSummaryRecord({
        platform_code: ctx.platform_code,
        raw_title: subject ?? filename.replace(/\.[^.]+$/, ""),
        source_file_kind: "invoice_pdf",
        client_code: ctx.client_code,
        channel_code: ctx.channel_code,
        type: ctx.type ?? "OTHER",
        sales_month: salesMonth,
        settlement_month: dueMonth,
        amounts: { tax_incl: totalInclNum },
        note1: [
          ctx.note,
          "invoice PDF summary — line items come from the XLSX twin",
        ].filter(Boolean).join(" / "),
      }),
    ],
    errors: [],
  };
}
