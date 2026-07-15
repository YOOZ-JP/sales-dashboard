/**
 * MediaDo (メディアドゥ) parser — tab-separated values.
 *
 * Two subfolder categories (each contains one UTF-8 TSV + a PDF summary):
 *   202601_BR217_RIVERSE_コミック/   — 電子コミック channel: EB / EP
 *   202601_BR217_RIVERSE_タテヨミ/   — vertical-scroll WT: WT / WR
 *
 * TSV schema (UTF-8, single header row; one detail row per
 * (title, volume/episode, book-store)):
 *   販売月 | 支払先名 | 出版者名 | 書店会社名 | 書店名 |
 *   タイトル名称 | 巻数 | コンテンツ名称 | 著者名 | CID | 出版者経理コード | JDCN |
 *   販売価格 | 料率 | 支払い単価 | DL数 | 税抜き金額 | 発行形態 | JP-eコード
 *
 * Derivation rules (reverse-engineered against 202604 GT / 77 rows):
 *
 *   1. One GT row per unique タイトル名称. Raw rows are aggregated
 *      across bookstores, volumes, and rate tiers. (77 raw titles ↔ 77 GT rows.)
 *   2. GT `total_amount_jpy` = GT `before_tax_jpy`
 *        = round( Σ (販売価格 × DL数) × 1.10 )
 *      (raw 販売価格 is tax-exclusive; GT rolls the 10% consumption tax in.)
 *   3. GT `after_tax_income_jpy` (== raw royalty) = round( Σ 税抜き金額 )
 *   4. GT `before_tax_income_jpy` = round( Σ 税抜き金額 × 1.10 )
 *   5. GT `consumption_tax_jpy` = before_tax_income − after_tax_income
 *   6. `rs` string format: if all raw rows for the title share a single 料率
 *      → numeric rs (料率 / 100). Otherwise the rates are sorted ascending
 *      and joined as `X/Y%` or `X/Y/Z%`.
 *   7. Type mapping:
 *      COMIC folder (発行形態 == "コミック"):
 *        - title ⊃ 【分冊版】 or 【連載版】                          → EP
 *        - else                                                        → EB
 *      タテヨミ folder (発行形態 == "タテヨミ"):
 *        - title ⊃ ［改訂版］ (full-width) or [改訂版] (half-width)   → WR
 *        - title has a sibling "${base}[完全版]【タテヨミ】" etc.    → WR
 *          (base = legacy version; 完全版 sibling is WT)
 *        - else                                                        → WT
 *   8. Empty trailing row with blank 発行形態 is skipped.
 */
import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix } from "./common";
import iconv from "iconv-lite";

interface TsvRow {
  販売月: string;
  書店名: string;
  タイトル名称: string;
  販売価格: string;
  料率: string;
  支払い単価: string;
  DL数: string;
  税抜き金額: string;
  発行形態: string;
}

interface TitleAgg {
  title: string;
  fallbackKind: SourceKind;
  sourceKinds: Set<SourceKind>;
  salesTaxExcl: number;   // Σ (販売価格 × DL数)  — raw tax-exclusive sales
  payment: number;        // Σ 税抜き金額          — raw tax-exclusive royalty
  rates: Set<number>;
  rateLabels: Set<string>;
  stores: Set<string>;
  rowCount: number;
}

const COMIC_MARKER = "コミック";
const TATE_MARKER = "タテヨミ";
const BOOK_MARKER = "書籍";
type SourceKind = "COMIC" | "TATE" | "BOOK";

export async function parseMediado({
  filename,
  buffer,
  folderName,
}: {
  filename: string;
  buffer: Buffer;
  folderName?: string;
}): Promise<ParseResult> {
  const errors: string[] = [];

  if (/\.pdf$/i.test(filename)) {
    return { platform_code: "mediado", sales_month: null, settlement_month: null, records: [], errors: [] };
  }

  const fallbackKind = detectKind(folderName, filename);
  const rows = /\.xlsx$/i.test(filename)
    ? parseWorkbookRows(buffer)
    : parseTsv(decodeTsv(buffer));
  if (rows.length === 0) {
    errors.push("no data rows parsed from TSV");
  }

  // Aggregate by タイトル名称 (skip aggregation/summary blanks)
  const byTitle = new Map<string, TitleAgg>();
  for (const r of rows) {
    const title = (r.タイトル名称 ?? "").trim();
    // The TSV can include valid rows with blank/special 発行形態. Only the
    // fully blank trailing row is skipped.
    if (!title) continue;

    const price = toNum(r.販売価格);
    const dl = toNum(r.DL数);
    const rate = toNum(r.料率);
    const taxExcl = toNum(r.税抜き金額);
    const sourceKind = detectRowKind(r.発行形態, fallbackKind);

    let agg = byTitle.get(title);
    if (!agg) {
      agg = {
        title,
        fallbackKind,
        sourceKinds: new Set(),
        salesTaxExcl: 0,
        payment: 0,
        rates: new Set(),
        rateLabels: new Set(),
        stores: new Set(),
        rowCount: 0,
      };
      byTitle.set(title, agg);
    }
    agg.sourceKinds.add(sourceKind);
    agg.salesTaxExcl += price * dl;
    agg.payment += taxExcl;
    if (rate > 0) agg.rates.add(rate);
    const rateLabel = formatRateLabel(r.料率);
    if (rateLabel) agg.rateLabels.add(rateLabel);
    if (r.書店名) agg.stores.add(r.書店名.trim());
    agg.rowCount += 1;
  }

  // First pass collects all titles in this folder so the type resolver
  // can detect "[完全版] sibling" relationships on タテヨミ rows. Titles are
  // whitespace-normalized: the statement writes some siblings with a space
  // before the bracket (e.g. "響弦文字 [完全版]【タテヨミ】").
  const allTitles = new Set([...byTitle.keys()].map(normalizeSiblingKey));

  const salesMonth = deriveSalesMonth(filename, rows);
  const settlementMonth = salesMonth ? addMonthsEndOfMonth(salesMonth, 3) : null;
  // MediaDo pays at the end of the settlement month (sales + 3 months).
  const depositMonth = settlementMonth;

  const records: RawRecord[] = [];
  let idx = 0;
  for (const agg of byTitle.values()) {
    const type = resolveType(agg, allTitles);
    const rsLabel = formatRs(agg.rateLabels, agg.rates);
    const rsRate = computeRsRate(agg.rates);

    const afterTaxIncome = Math.round(agg.payment);

    records.push({
      row_index: idx++,
      data: {
        title_jp: agg.title,
        channel_title_jp: agg.title,
        type,
        total_amount_jpy: null,
        before_tax_jpy: null,
        after_tax_jpy: Math.round(agg.salesTaxExcl),
        gross_jpy: null,
        before_tax_income_jpy: null,
        after_tax_income_jpy: afterTaxIncome,
        consumption_tax_jpy: null,
        withholding_tax_jpy: 0,
        fee_jpy: 0,
        // Rate
        rs_label: rsLabel,
        rs_rate: rsRate,
        // Raw audit
        raw_sales_tax_excl: agg.salesTaxExcl,
        raw_payment_tax_excl: agg.payment,
        raw_stores: Array.from(agg.stores),
        raw_rates: Array.from(agg.rates).sort((a, b) => a - b),
        raw_row_count: agg.rowCount,
        // Routing
        client_code: "mediado",
        channel_code: "mediado_sales",
        deposit_month: depositMonth,
      },
    });
  }

  return {
    platform_code: "mediado",
    sales_month: salesMonth,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function detectKind(folderName?: string, filename?: string): SourceKind {
  const hay = `${folderName ?? ""} ${filename ?? ""}`;
  if (hay.includes(TATE_MARKER)) return "TATE";
  if (hay.includes(COMIC_MARKER)) return "COMIC";
  if (hay.includes(BOOK_MARKER)) return "BOOK";
  // Safe default: COMIC (single-rate fallback)
  return "COMIC";
}

function detectRowKind(form: string | undefined, fallbackKind: SourceKind): SourceKind {
  const f = (form ?? "").trim();
  if (f.includes(TATE_MARKER)) return "TATE";
  if (f.includes(COMIC_MARKER)) return "COMIC";
  if (f.includes(BOOK_MARKER)) return "BOOK";
  return fallbackKind;
}

/**
 * Hand-rolled TSV parser (no dependencies). We do the splitting ourselves
 * because Papa/csv-parse both add weight for features we don't need, and the
 * MediaDo TSVs contain no embedded quotes or newlines within fields.
 */
function parseTsv(text: string): TsvRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t").map(s => s.trim());
  const out: TsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    out.push(row as unknown as TsvRow);
  }
  return out;
}

function decodeTsv(buffer: Buffer): string {
  const utf8 = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  if (!utf8.includes("�") && utf8.includes("販売月")) return utf8;
  return iconv.decode(buffer, "shift_jis").replace(/^\uFEFF/, "");
}

function parseWorkbookRows(buffer: Buffer): TsvRow[] {
  const wb = readWorkbook(buffer);
  const matrix = sheetToMatrix(wb, wb.SheetNames[0]);
  const header = (matrix[0] ?? []).map((cell) => String(cell ?? "").trim());
  return matrix.slice(1).map((row) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      out[header[i]] = String(row[i] ?? "").trim();
    }
    return out as unknown as TsvRow;
  });
}

function toNum(v: string | undefined | null): number {
  if (v == null || v === "") return 0;
  const cleaned = String(v).replace(/[,¥￥\s円]/g, "").replace(/−/g, "-");
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function formatRateLabel(raw: string | undefined): string | null {
  const rate = toNum(raw);
  if (rate <= 0) return null;
  if (String(raw ?? "").includes("%")) return `${rate}%`;
  return `${rate}%`;
}

function formatRs(rateLabels: Set<string>, rates: Set<number>): string {
  const labels = Array.from(rateLabels);
  if (labels.length > 0) {
    return labels
      .sort((a, b) => toNum(a) - toNum(b))
      .map((label) => label.replace(/%$/, ""))
      .join("/") + "%";
  }
  const sorted = Array.from(rates).sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  return sorted.join("/") + "%";
}

function computeRsRate(rates: Set<number>): number {
  // Use the highest tier as the effective rate — matches how downstream
  // systems usually interpret compound RS labels.
  const sorted = Array.from(rates).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[sorted.length - 1] / 100;
}

function resolveType(agg: TitleAgg, allTitles: Set<string>): string {
  const t = agg.title;
  if (agg.sourceKinds.has("TATE")) {
    if (t.includes("［改訂版］") || t.includes("[改訂版]")) return "WR";
    if (hasKanzenSibling(t, allTitles)) return "WR";
    return "WT";
  }
  if (agg.sourceKinds.has("BOOK")) {
    if (t.includes("【分冊版】") || t.includes("【連載版】")) return "EP";
    return "EB";
  }
  if (agg.fallbackKind === "COMIC") {
    if (t.includes("【分冊版】") || t.includes("【連載版】")) return "EP";
    return "EB";
  }
  if (t.includes("［改訂版］") || t.includes("[改訂版]")) return "WR";
  if (hasKanzenSibling(t, allTitles)) return "WR";
  return "WT";
}

function normalizeSiblingKey(title: string): string {
  return title.replace(/[\s\u3000]+/g, "");
}

function hasKanzenSibling(title: string, allTitles: Set<string>): boolean {
  // If a title has a "sibling completed edition" it means the current title is
  // the legacy variant — GT classifies it as WR. Check both bracket styles.
  //
  // e.g. '融点～とけあい～【タテヨミ】' has sibling '融点～とけあい～[完全版]【タテヨミ】'
  //      → '融点～とけあい～【タテヨミ】' is WR, the sibling is WT.
  // Matching is whitespace-insensitive (see normalizeSiblingKey callers).
  const mTate = normalizeSiblingKey(title).match(/^(.*)【タテヨミ】$/);
  if (!mTate) return false;
  const base = mTate[1];
  // Stop if this title already carries a 完全版 tag itself.
  if (base.endsWith("[完全版]") || base.endsWith("［完全版］")) return false;

  const candidates = [
    `${base}[完全版]【タテヨミ】`,
    `${base}［完全版］【タテヨミ】`,
  ];
  return candidates.some(c => allTitles.has(c));
}

function deriveSalesMonth(filename: string, rows: TsvRow[]): string | null {
  // Prefer the TSV's 販売月 field (e.g. "2026-01") which is what the human
  // ground truth keys off of.
  for (const r of rows) {
    const s = (r.販売月 ?? "").trim();
    const m = s.match(/(\d{4})[-/年](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-01`;
  }
  const m = filename.match(/(\d{4})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

function addMonthsEndOfMonth(iso: string, months: number): string {
  const [y, m] = iso.split("-").map(Number);
  // `new Date(UTC(y, m, 0))` returns the last day of month m (1-indexed),
  // so for "3 months after 2026-01" we want last day of 2026-04 → UTC(2026, 4, 0).
  const target = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  return target.toISOString().slice(0, 10);
}
