/**
 * Shueisha parser — deterministic local OCR (no AI gateway).
 *
 * The source is a scanned image-only 2-page 集英社 支払通知書:
 *   · page 1 (cover): per-payee table with Manga Mee advertising detail
 *     rows plus one Jumptoon summary row (【売上・印税】ジャンプTOON) and a
 *     ***消費税率別支払額*** grand-total row. The Jumptoon summary is NOT
 *     emitted — its detail lives on page 2.
 *   · page 2 (デジタルコミックス御支払明細書): ruled Jumptoon detail table
 *     (作品名/販路/入金額/支払率/税率/支払額) with a 合計 row. Source rows
 *     are aggregated by normalized title + channel kind (単行本/話配信),
 *     SUMMING 支払額 — never deduped by amount.
 *
 * Pages are rasterized + binarized, the ruled grids are detected from
 * pixel runs, and each cell is OCR'd locally (tesseract.js, packaged
 * jpn+eng data). Amount cells use a digits-only whitelist.
 *
 * Validation is strict and the parser fails loudly (zero records) when
 *   · page-2 detail sum ≠ page-2 合計 支払額
 *   · page-2 detail sum ≠ page-1 Jumptoon summary
 *   · manga rows + Jumptoon summary ≠ page-1 grand total
 *   · dates/amounts are unreadable or non-positive
 *
 * Output → Ground Truth mapping (unchanged from the AI version):
 *   · manga rows    → channel="manga mee", type="AD", title "<T>(広告)"
 *   · jumptoon rows → channel="Jumptoon",  type="EB", title "<T>(話配信|単行本)"
 *   · before_tax_income_jpy = 支払額(税込); after = round(/1.10)
 *   · deposit_month = exact printed 支払日; sales_month = printed source month
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { SHUEISHA_OCR_TITLE_MARKER } from "@/features/settlement/lib/export/input-v2-carry-forward";
import {
  binarizePng,
  createLocalOcrWorkers,
  detectTableGrid,
  gridCellRect,
  loadPageImage,
  ocrCellAmount,
  ocrCellText,
  ocrPngToLines,
  regionInkRatio,
  renderPdfPagesToPng,
  terminateOcrWorkers,
  type BinarizedPage,
  type OcrLine,
  type OcrWorker,
  type PageImage,
  type Rect,
  type TableGrid,
} from "./ocr-pdf";

// ---------------------------------------------------------------------------
// Pure text helpers (exported for privacy-safe synthetic tests)
// ---------------------------------------------------------------------------

/** Full-width latin/digits → ASCII, normalize parens, collapse spaces. */
export function normalizeShueishaText(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeShueishaTitle(text: string): string {
  return normalizeShueishaText(text).replace(/\((広告|単行本|話配信)\)$/, "").trim();
}

/** Grouping/output key: Japanese titles carry no meaningful spaces. */
export function shueishaTitleKey(title: string): string {
  return normalizeShueishaTitle(title).replace(/\s+/g, "");
}

export function dedupeShueishaRows<T extends { title: string; payment_taxincl: number; channel_kind?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = [
      normalizeShueishaTitle(row.title),
      row.channel_kind ?? "",
      row.payment_taxincl,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/** "支払日 2026年 06月 25日" → "2026-06-25" */
export function parseShueishaPaymentDate(text: string): string | null {
  const m = normalizeShueishaText(text).match(/[御お]?[支文]?\s*払\s*日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** "2026年02月発生分" → "2026-02-01" */
export function parseShueishaSalesMonthLabel(text: string): string | null {
  const m = normalizeShueishaText(text).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*発生分/);
  if (!m) return null;
  const [, y, mo] = m;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  return `${y}-${mo.padStart(2, "0")}-01`;
}

/** Remark "マンガMee広告202602" → "2026-02-01" */
export function parseShueishaAdSalesMonth(text: string): string | null {
  const compact = normalizeShueishaText(text).replace(/\s+/g, "");
  const m = compact.match(/広告(\d{4})(\d{2})/) ?? compact.match(/(20\d{2})(0[1-9]|1[0-2])/);
  if (!m) return null;
  const [, y, mo] = m;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  return `${y}-${mo}-01`;
}

/**
 * Page-2 作品名 cell → base title + channel kind.
 * "T 単行本版【フルカラー】 EPUB版" → {title:"T", kind:"単行本"}
 * "T 話配信" / "T 単行本版… 話配信"  → {title:"T", kind:"話配信"}
 */
export function splitShueishaWorkCell(text: string): { title: string; kind: "単行本" | "話配信" } | null {
  const normalized = normalizeShueishaText(text);
  if (!normalized) return null;
  const compact = normalized.replace(/\s+/g, "");
  const kind: "単行本" | "話配信" = compact.includes("話配信") ? "話配信" : "単行本";
  // Cut at the first edition marker. Individual markers are matched loosely
  // (単行本 not 単行本版, EPUB not EPUB版, the 【フルカラー】 bracket itself)
  // because scanned cells often garble part of the marker text.
  const cutAt = Math.min(
    ...["単行本", "話配信", "EPUB", "フルカラー", "【"]
      .map((marker) => compact.indexOf(marker))
      .filter((i) => i >= 0),
  );
  const title = Number.isFinite(cutAt) ? compact.slice(0, cutAt) : compact;
  if (!title) return null;
  return { title, kind };
}

/** Pick the work-title line out of a page-1 内容 cell (multi-line OCR text). */
export function pickShueishaTitleLine(cellText: string): string | null {
  const lines = cellText
    .split(/\n/)
    .map((l) => normalizeShueishaText(l))
    .filter(Boolean);
  for (const line of lines) {
    const compact = line
      .replace(/\s+/g, "")
      .replace(/(?:マンガM(?:ee)?|Mee)?広告20\d{4}/gi, "");
    if (/マンガMee|ジャンプ|原作使用料|WEB広告/i.test(compact)) continue; // channel/usage header line
    if (/^[\d.,/\s-]+$/.test(compact)) continue; // 取引日 line
    if (compact.length < 2) continue;
    return compact;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structured extract → ParseResult (pure; exported for synthetic tests)
// ---------------------------------------------------------------------------

export interface ShueishaMangaRow {
  title: string;
  payment_taxincl: number;
  sales_month: string | null;
}

export interface ShueishaDetailRow {
  title: string;
  kind: "単行本" | "話配信";
  payment_taxincl: number;
}

export interface ShueishaExtract {
  /** page-1 支払日 (exact printed date, ISO) */
  payment_date: string | null;
  /** page-2 御支払日 when readable — must agree with page 1 */
  page2_payment_date: string | null;
  /** page-1 ***消費税率別支払額*** row (cover grand total, tax incl.) */
  grand_total: number | null;
  /** page-1 Manga Mee advertising detail rows */
  manga_rows: ShueishaMangaRow[];
  /** page-1 Jumptoon summary amount (NOT emitted as a row) */
  jumptoon_summary_total: number | null;
  /** page-2 printed source month (YYYY年MM月発生分) */
  detail_sales_month: string | null;
  /** page-2 Jumptoon source detail rows (pre-aggregation) */
  detail_rows: ShueishaDetailRow[];
  /** page-2 合計 御支払額 */
  detail_total: number | null;
  /** hard OCR/structure failures collected while extracting */
  ocr_errors: string[];
}

export interface ShueishaAggregatedRow {
  title: string;
  kind: "単行本" | "話配信";
  payment_taxincl: number;
  source_rows: number;
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/** OCR noise tolerance for scanned title cells, including short title keys. */
function sameShueishaTitle(a: string, b: string): boolean {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  return levenshtein(a, b) <= Math.max(2, Math.floor(maxLen * 0.45));
}

/**
 * Aggregate detail rows by normalized title + kind, SUMMING payment —
 * never deduping by amount. Titles are matched with a small edit-distance
 * tolerance because per-row OCR of the same scanned title can drop or
 * add a character; the most frequent spelling wins as the group title.
 */
export function aggregateShueishaDetailRows(rows: ShueishaDetailRow[]): ShueishaAggregatedRow[] {
  const groups: Array<ShueishaAggregatedRow & { spellings: Map<string, number> }> = [];
  for (const row of rows) {
    const key = shueishaTitleKey(row.title);
    const group = groups.find((g) => g.kind === row.kind && sameShueishaTitle(g.title, key));
    if (group) {
      group.payment_taxincl += row.payment_taxincl;
      group.source_rows += 1;
      group.spellings.set(key, (group.spellings.get(key) ?? 0) + 1);
    } else {
      groups.push({
        title: key,
        kind: row.kind,
        payment_taxincl: row.payment_taxincl,
        source_rows: 1,
        spellings: new Map([[key, 1]]),
      });
    }
  }
  return groups.map(({ spellings, ...group }) => {
    let title = group.title;
    let best = 0;
    for (const [spelling, count] of spellings) {
      if (count > best) {
        best = count;
        title = spelling;
      }
    }
    return { ...group, title };
  });
}

/**
 * Validate a structured extract and build the ParseResult. All error
 * messages carry counts only — never titles or amounts.
 */
export function buildShueishaParseResult(extract: ShueishaExtract): ParseResult {
  const errors: string[] = [...extract.ocr_errors];
  const fail = (records: ParseResult["records"] = []): ParseResult => ({
    platform_code: "shueisha",
    sales_month: null,
    settlement_month: null,
    records,
    errors,
  });

  if (!extract.payment_date) {
    errors.push("shueisha: payment date (支払日) not readable on page 1");
  }
  if (
    extract.payment_date &&
    extract.page2_payment_date &&
    extract.page2_payment_date !== extract.payment_date
  ) {
    errors.push("shueisha: page-1 and page-2 payment dates disagree");
  }
  if (extract.manga_rows.length === 0) {
    errors.push("shueisha: no Manga Mee detail rows recognized on page 1");
  }
  if (extract.detail_rows.length === 0) {
    errors.push("shueisha: no Jumptoon detail rows recognized on page 2");
  }
  if (extract.grand_total === null) {
    errors.push("shueisha: cover grand total (消費税率別支払額) not readable");
  }
  if (extract.jumptoon_summary_total === null) {
    errors.push("shueisha: Jumptoon summary amount not readable on page 1");
  }
  if (extract.detail_total === null) {
    errors.push("shueisha: page-2 合計 amount not readable");
  }
  if (!extract.detail_sales_month) {
    errors.push("shueisha: page-2 source month (発生分) not readable");
  }
  for (const row of extract.manga_rows) {
    if (!Number.isSafeInteger(row.payment_taxincl) || row.payment_taxincl <= 0) {
      errors.push("shueisha: non-positive/unreadable Manga Mee amount");
    }
    if (!row.sales_month) {
      errors.push("shueisha: Manga Mee row without a readable source month");
    }
  }
  for (const row of extract.detail_rows) {
    if (!Number.isSafeInteger(row.payment_taxincl) || row.payment_taxincl <= 0) {
      errors.push("shueisha: non-positive/unreadable Jumptoon detail amount");
    }
  }
  if (errors.length > 0) return fail();

  const mangaSum = extract.manga_rows.reduce((s, r) => s + r.payment_taxincl, 0);
  const detailSum = extract.detail_rows.reduce((s, r) => s + r.payment_taxincl, 0);
  if (detailSum !== extract.detail_total) {
    errors.push(
      `shueisha: page-2 detail sum does not match the printed 合計 (${extract.detail_rows.length} rows read) — refusing to guess`,
    );
  }
  if (detailSum !== extract.jumptoon_summary_total) {
    errors.push("shueisha: page-2 detail sum does not match the page-1 Jumptoon summary — refusing to guess");
  }
  if (mangaSum + detailSum !== extract.grand_total) {
    errors.push("shueisha: manga rows + Jumptoon detail do not add up to the cover grand total — refusing to guess");
  }
  if (errors.length > 0) return fail();

  const paymentDate = extract.payment_date!;
  const settlementMonth = `${paymentDate.slice(0, 7)}-01`;
  const records: ParseResult["records"] = [];
  let idx = 0;

  const emit = (
    title: string,
    suffix: string,
    type: "AD" | "EB",
    channel: string,
    paymentTaxIncl: number,
    salesMonth: string | null,
  ) => {
    const afterTaxIncome = Math.round(paymentTaxIncl / 1.10);
    const consumptionTax = paymentTaxIncl - afterTaxIncome;
    const normalizedTitle = normalizeShueishaTitle(title);
    records.push({
      row_index: idx++,
      data: {
        title_jp: normalizedTitle,
        channel_title_jp: `${normalizedTitle}(${suffix})`,
        type,
        channel_code: channel,
        client_code: "shueisha",
        sales_month: salesMonth,
        deposit_month: paymentDate,
        total_amount_jpy: null,
        before_tax_jpy: null,
        after_tax_jpy: null,
        before_tax_income_jpy: paymentTaxIncl,
        after_tax_income_jpy: afterTaxIncome,
        after_tax_income_jpy_a: afterTaxIncome,
        consumption_tax_jpy: consumptionTax,
        withholding_tax_jpy: 0,
        // Titles came from local OCR of a scanned notice: mark provenance so
        // carry-forward may reconcile insertion-only title noise against the
        // baseline. The token is stripped before any workbook cell is written.
        note2: SHUEISHA_OCR_TITLE_MARKER,
      },
    });
  };

  for (const row of extract.manga_rows) {
    emit(row.title, "広告", "AD", "manga mee", row.payment_taxincl, row.sales_month);
  }
  for (const row of aggregateShueishaDetailRows(extract.detail_rows)) {
    emit(row.title, row.kind, "EB", "Jumptoon", row.payment_taxincl, extract.detail_sales_month);
  }

  const salesMonths = new Set(records.map((r) => r.data.sales_month).filter(Boolean));
  return {
    platform_code: "shueisha",
    sales_month: salesMonths.size === 1 ? ([...salesMonths][0] as string) : null,
    settlement_month: settlementMonth,
    records,
    errors,
  };
}

// ---------------------------------------------------------------------------
// OCR layer: pages → ShueishaExtract
// ---------------------------------------------------------------------------

const EMPTY_CELL_INK = 0.0025;

/**
 * One rasterized page in both flavors: the original render for text OCR
 * (binarization shreds kanji strokes) and the binarized copy for grid
 * detection, ink ratios and digit OCR (kills dashed guides/tint).
 */
interface SourcePage {
  png: Buffer;
  img: PageImage;
  bin: BinarizedPage;
}

function compactText(text: string): string {
  return normalizeShueishaText(text).replace(/\s+/g, "");
}

/** Find the grid column whose header matches; -1 when absent. */
function findColumn(headers: string[], match: (compact: string) => boolean): number {
  return headers.findIndex((h) => match(compactText(h)));
}

function gridRowRect(grid: TableGrid, row: number, inset = 4): Rect {
  return {
    x: grid.xs[0] + inset,
    y: grid.ys[row] + inset,
    w: grid.xs[grid.xs.length - 1] - grid.xs[0] - inset * 2,
    h: grid.ys[row + 1] - grid.ys[row] - inset * 2,
  };
}

function rectX1(rect: Rect): number {
  return rect.x + rect.w;
}

function rectY1(rect: Rect): number {
  return rect.y + rect.h;
}

function overlapSize(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function ocrLinesForCell(lines: OcrLine[], rowRect: Rect, colRect: Rect): string {
  return lines
    .map((line) => {
      const words = (line.words ?? [])
        .filter((word) => {
          const xCenter = (word.x0 + word.x1) / 2;
          const yCenter = (word.y0 + word.y1) / 2;
          const xOverlap = overlapSize(word.x0, word.x1, colRect.x, rectX1(colRect));
          const yOverlap = overlapSize(word.y0, word.y1, rowRect.y, rectY1(rowRect));
          const wordWidth = Math.max(1, word.x1 - word.x0);
          const wordHeight = Math.max(1, word.y1 - word.y0);
          return (
            yCenter >= rowRect.y &&
            yCenter <= rectY1(rowRect) &&
            yOverlap / wordHeight >= 0.5 &&
            xCenter >= colRect.x &&
            xCenter <= rectX1(colRect) &&
            xOverlap / wordWidth >= 0.5
          );
        })
        .sort((a, b) => a.x0 - b.x0)
        .map((word) => word.text)
        .join("");
      if (words.trim()) return { ...line, text: words };

      const xCenter = (line.x0 + line.x1) / 2;
      const yCenter = (line.y0 + line.y1) / 2;
      const xOverlap = overlapSize(line.x0, line.x1, colRect.x, rectX1(colRect));
      const yOverlap = overlapSize(line.y0, line.y1, rowRect.y, rectY1(rowRect));
      const lineWidth = Math.max(1, line.x1 - line.x0);
      const lineHeight = Math.max(1, line.y1 - line.y0);
      if (
        line.x0 >= colRect.x - 8 &&
        line.x1 <= rectX1(colRect) + 8 &&
        yCenter >= rowRect.y &&
        yCenter <= rectY1(rowRect) &&
        yOverlap / lineHeight >= 0.5 &&
        xCenter >= colRect.x &&
        xCenter <= rectX1(colRect) &&
        xOverlap / lineWidth >= 0.5
      ) {
        return line;
      }
      return null;
    })
    .filter((line): line is OcrLine => line !== null)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((line) => line.text)
    .join("\n");
}

function parseTaxIncludedAmountCandidatesFromRowText(text: string): number[] {
  const seen = new Set<number>();
  const amounts: number[] = [];
  for (const match of normalizeShueishaText(text).matchAll(/(\d[\d,]*)\s*税込/g)) {
    const amount = Number(match[1].replace(/,/g, ""));
    if (Number.isSafeInteger(amount) && amount > 0 && !seen.has(amount)) {
      seen.add(amount);
      amounts.push(amount);
    }
  }
  return amounts;
}

function uniqueAmounts(amounts: Array<number | null | undefined>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const amount of amounts) {
    if (amount === null || amount === undefined || amount <= 0 || seen.has(amount)) continue;
    seen.add(amount);
    out.push(amount);
  }
  return out;
}

interface Page1Reconciliation {
  mangaCandidates: number[][];
  summaryCandidates: number[];
  grandCandidates: number[];
}

async function readHeaderRow(
  worker: OcrWorker,
  page: SourcePage,
  grid: TableGrid,
): Promise<string[]> {
  const headers: string[] = [];
  for (let col = 0; col < grid.xs.length - 1; col++) {
    headers.push(await ocrCellText(worker, page.img, gridCellRect(grid, col, 0)));
  }
  return headers;
}

async function readAmountCell(
  worker: OcrWorker,
  page: SourcePage,
  rect: Rect,
): Promise<number | null> {
  return (await readAmountCandidates(worker, page, rect))[0] ?? null;
}

async function readAmountCandidates(
  worker: OcrWorker,
  page: SourcePage,
  rect: Rect,
): Promise<number[]> {
  const seen = new Set<number>();
  const amounts: number[] = [];
  const variants: Rect[] = [
    rect,
    { x: rect.x - 8, y: rect.y - 3, w: rect.w + 16, h: rect.h + 6 },
    { x: rect.x - 14, y: rect.y - 5, w: rect.w + 28, h: rect.h + 10 },
    { x: rect.x + 4, y: rect.y, w: rect.w - 8, h: rect.h },
  ];
  for (const candidate of variants) {
    for (const threshold of [150, 170, 130]) {
      const amount = await ocrCellAmount(worker, page.img, candidate, { threshold, scaleUp: 4 });
      if (amount !== null && !seen.has(amount)) {
        seen.add(amount);
        amounts.push(amount);
      }
    }
  }
  return amounts;
}

function chooseAmountsBySum(candidates: number[][], target: number): number[] | null {
  const memo = new Set<string>();
  const dfs = (index: number, sum: number, picked: number[]): number[] | null => {
    if (sum > target) return null;
    if (index === candidates.length) return sum === target ? picked : null;
    const key = `${index}:${sum}`;
    if (memo.has(key)) return null;
    for (const amount of candidates[index]) {
      const found = dfs(index + 1, sum + amount, [...picked, amount]);
      if (found) return found;
    }
    memo.add(key);
    return null;
  };
  return dfs(0, 0, []);
}

async function ocrLinesAboveTable(
  worker: OcrWorker,
  page: SourcePage,
  grid: TableGrid,
): Promise<string> {
  const lines = await ocrPngToLines(worker, page.png, { psm: "3" });
  return lines
    .filter((line) => line.y1 <= grid.ys[0])
    .map((line) => line.text)
    .join("\n");
}

async function extractPage1(
  textWorker: OcrWorker,
  amountWorker: OcrWorker,
  page: SourcePage,
  out: ShueishaExtract,
  reconciliation: Page1Reconciliation,
  errors: string[],
): Promise<void> {
  const grid = detectTableGrid(page.bin);
  if (!grid || grid.ys.length < 3) {
    errors.push("shueisha: page-1 table grid not detected");
    return;
  }

  // 支払日 lives above the table; psm 3 (auto layout) — the strip is a
  // sparse full-width region, not a uniform text block.
  const topStrip = await ocrCellText(textWorker, page.img, {
    x: 0,
    y: 0,
    w: page.bin.width,
    h: Math.max(1, grid.ys[0] - 4),
  }, { psm: "3", scaleUp: 1 });
  out.payment_date = parseShueishaPaymentDate(topStrip);

  // Header keywords are matched loosely — scanned header cells often
  // garble a character (e.g. 支払金額 → 支払金祝).
  const headers = await readHeaderRow(textWorker, page, grid);
  const payCol = findColumn(headers, (h) => h.includes("支払金"));
  const detectedRemarkCol = findColumn(headers, (h) => /備|考/.test(h));
  const remarkCol = detectedRemarkCol >= 0 ? detectedRemarkCol : grid.xs.length - 2;
  if (payCol < 0) {
    errors.push("shueisha: page-1 支払金額 column not found");
    return;
  }
  const pageLines = await ocrPngToLines(textWorker, page.png);

  for (let row = 1; row < grid.ys.length - 1; row++) {
    const contentRect = gridCellRect(grid, 0, row);
    const payRect = gridCellRect(grid, payCol, row);
    const rowRect = gridRowRect(grid, row, 0);
    if (
      regionInkRatio(page.bin, contentRect) < EMPTY_CELL_INK &&
      regionInkRatio(page.bin, payRect) < EMPTY_CELL_INK
    ) {
      continue;
    }
    const content = await ocrCellText(textWorker, page.img, contentRect);
    const compact = compactText(content);
    if (!compact) continue;
    const rowLineText = pageLines
      .filter((line) => line.y0 < grid.ys[row + 1] && line.y1 > grid.ys[row])
      .map((line) => line.text)
      .join("\n");

    if (/消費税|率別/.test(compact) && !/マンガM|Mee|ジャンプT/i.test(compact)) {
      const rowText = await ocrCellText(textWorker, page.img, gridRowRect(grid, row));
      reconciliation.grandCandidates = uniqueAmounts([
        ...(await readAmountCandidates(amountWorker, page, payRect)),
        ...parseTaxIncludedAmountCandidatesFromRowText(rowText),
        ...parseTaxIncludedAmountCandidatesFromRowText(rowLineText),
      ]);
      out.grand_total = reconciliation.grandCandidates[0] ?? null;
      continue;
    }
    const isManga = /マンガM|Mee/i.test(compact);
    const isJumptoon = /ジャンプT/i.test(compact);
    if (!isManga && !isJumptoon) continue;

    const rowText = await ocrCellText(textWorker, page.img, gridRowRect(grid, row));
    const amountCandidates = uniqueAmounts([
      ...(await readAmountCandidates(amountWorker, page, payRect)),
      ...parseTaxIncludedAmountCandidatesFromRowText(rowText),
      ...parseTaxIncludedAmountCandidatesFromRowText(rowLineText),
    ]);
    const amount = amountCandidates[0] ?? null;
    if (isManga) {
      const geometryTitleText = ocrLinesForCell(pageLines, rowRect, contentRect);
      const title = pickShueishaTitleLine(geometryTitleText) ?? pickShueishaTitleLine(content);
      const remark = remarkCol >= 0
        ? await ocrCellText(textWorker, page.img, gridCellRect(grid, remarkCol, row))
        : "";
      if (!title) {
        errors.push("shueisha: page-1 Manga Mee row without a readable title");
        continue;
      }
      out.manga_rows.push({
        title,
        payment_taxincl: amount ?? -1,
        sales_month: parseShueishaAdSalesMonth(remark) ?? parseShueishaAdSalesMonth(rowText),
      });
      reconciliation.mangaCandidates.push(amountCandidates.length > 0 ? amountCandidates : [-1]);
    } else {
      if (out.jumptoon_summary_total !== null) {
        errors.push("shueisha: multiple Jumptoon summary rows on page 1");
        continue;
      }
      out.jumptoon_summary_total = amount;
      reconciliation.summaryCandidates = amountCandidates;
    }
  }
}

async function extractPage2(
  textWorker: OcrWorker,
  amountWorker: OcrWorker,
  page: SourcePage,
  out: ShueishaExtract,
  errors: string[],
): Promise<void> {
  const grid = detectTableGrid(page.bin);
  if (!grid || grid.ys.length < 3) {
    errors.push("shueisha: page-2 table grid not detected");
    return;
  }

  // 御支払日 / 総御支払金額 / 発生分 live above the table
  const topStrip = await ocrCellText(textWorker, page.img, {
    x: 0,
    y: 0,
    w: page.bin.width,
    h: Math.max(1, grid.ys[0] - 4),
  }, { psm: "3", scaleUp: 1 });
  out.page2_payment_date = parseShueishaPaymentDate(topStrip);
  out.detail_sales_month = parseShueishaSalesMonthLabel(topStrip);
  if (!out.page2_payment_date || !out.detail_sales_month) {
    const lineText = await ocrLinesAboveTable(textWorker, page, grid);
    out.page2_payment_date ??= parseShueishaPaymentDate(lineText);
    out.detail_sales_month ??= parseShueishaSalesMonthLabel(lineText);
  }

  const headers = await readHeaderRow(textWorker, page, grid);
  const titleCol = Math.max(0, findColumn(headers, (h) => h.includes("作品名")));
  const payCol = findColumn(headers, (h) => h.includes("支払額") && !h.includes("率"));
  if (payCol < 0) {
    errors.push("shueisha: page-2 御支払額 column not found");
    return;
  }

  const nonEmptyPayRows: number[] = [];
  for (let row = 1; row < grid.ys.length - 1; row++) {
    if (regionInkRatio(page.bin, gridCellRect(grid, payCol, row)) >= EMPTY_CELL_INK) {
      nonEmptyPayRows.push(row);
    }
  }
  const finalTotalRow = nonEmptyPayRows.at(-1) ?? -1;
  const detailAmountCandidates: number[][] = [];
  const detailStartIndex = out.detail_rows.length;
  const pageLines = await ocrPngToLines(textWorker, page.png);

  for (let row = 1; row < grid.ys.length - 1; row++) {
    const titleRect = gridCellRect(grid, titleCol, row);
    const payRect = gridCellRect(grid, payCol, row);
    const rowRect = gridRowRect(grid, row, 0);
    const hasTitle = regionInkRatio(page.bin, titleRect) >= EMPTY_CELL_INK;
    const hasPay = regionInkRatio(page.bin, payRect) >= EMPTY_CELL_INK;
    if (!hasTitle && !hasPay) continue;

    const titleText = hasTitle ? await ocrCellText(textWorker, page.img, titleRect) : "";
    const geometryTitleText = ocrLinesForCell(pageLines, rowRect, titleRect);
    const compact = compactText(geometryTitleText || titleText);
    if (row === finalTotalRow || /合計/.test(compact)) {
      out.detail_total = await readAmountCell(amountWorker, page, payRect);
      continue;
    }
    if (!hasPay) continue;
    const geometryWork = splitShueishaWorkCell(geometryTitleText);
    const cellWork = splitShueishaWorkCell(titleText);
    const work = geometryWork && cellWork
      ? { title: geometryWork.title, kind: cellWork.kind }
      : geometryWork ?? cellWork;
    const amountCandidates = await readAmountCandidates(amountWorker, page, payRect);
    const amount = amountCandidates[0] ?? null;
    if (!work) {
      errors.push("shueisha: page-2 detail row without a readable title");
      continue;
    }
    out.detail_rows.push({
      title: work.title,
      kind: work.kind,
      payment_taxincl: amount ?? -1,
    });
    detailAmountCandidates.push(amountCandidates.length > 0 ? amountCandidates : [-1]);
  }

  const target =
    out.detail_total !== null ? out.detail_total : null;
  if (target !== null) {
    const chosen = chooseAmountsBySum(detailAmountCandidates, target);
    if (chosen) {
      for (let i = 0; i < chosen.length; i++) {
        out.detail_rows[detailStartIndex + i].payment_taxincl = chosen[i];
      }
    }
  }
}

function reconcilePage1Amounts(out: ShueishaExtract, reconciliation: Page1Reconciliation): void {
  if (out.detail_total !== null && reconciliation.summaryCandidates.includes(out.detail_total)) {
    out.jumptoon_summary_total = out.detail_total;
  }

  const targetDetail = out.detail_total ?? out.jumptoon_summary_total;
  if (targetDetail === null || out.manga_rows.length !== reconciliation.mangaCandidates.length) return;

  for (const grand of reconciliation.grandCandidates) {
    const mangaTarget = grand - targetDetail;
    if (mangaTarget <= 0) continue;
    const mangaAmounts = chooseAmountsBySum(reconciliation.mangaCandidates, mangaTarget);
    if (!mangaAmounts) continue;
    out.grand_total = grand;
    for (let i = 0; i < mangaAmounts.length; i++) {
      out.manga_rows[i].payment_taxincl = mangaAmounts[i];
    }
    return;
  }
}

export async function extractShueishaFromPdf(buffer: Buffer): Promise<ShueishaExtract> {
  const out: ShueishaExtract = {
    payment_date: null,
    page2_payment_date: null,
    grand_total: null,
    manga_rows: [],
    jumptoon_summary_total: null,
    detail_sales_month: null,
    detail_rows: [],
    detail_total: null,
    ocr_errors: [],
  };

  const pages = await renderPdfPagesToPng(buffer, { scale: 4 });
  if (pages.length !== 2) {
    out.ocr_errors.push(`shueisha: expected a 2-page payment notice, got ${pages.length} page(s)`);
    return out;
  }

  // Each page gets its own text+amount worker pair so the two pages OCR
  // truly concurrently. Worker parameter state (psm/whitelist) is per
  // worker, so per-page call sequences — and therefore OCR readings —
  // are identical to the old sequential run.
  const workers = await createLocalOcrWorkers(["jpn+eng", "eng", "jpn+eng", "eng"]);
  const [page1Text, page1Amount, page2Text, page2Amount] = workers;
  try {
    const prepare = async (png: Buffer): Promise<SourcePage> => {
      const [img, bin] = await Promise.all([loadPageImage(png), binarizePng(png)]);
      return { png, img, bin };
    };
    const [page1, page2] = await Promise.all([prepare(pages[0]), prepare(pages[1])]);
    const reconciliation: Page1Reconciliation = {
      mangaCandidates: [],
      summaryCandidates: [],
      grandCandidates: [],
    };
    // Per-page error sinks keep ocr_errors in a fixed page-1-then-page-2
    // order regardless of completion timing; allSettled guarantees both
    // extractions have finished before workers terminate (no in-flight
    // recognize on a dead worker) and before either failure is rethrown.
    const page1Errors: string[] = [];
    const page2Errors: string[] = [];
    const settled = await Promise.allSettled([
      extractPage1(page1Text, page1Amount, page1, out, reconciliation, page1Errors),
      extractPage2(page2Text, page2Amount, page2, out, page2Errors),
    ]);
    out.ocr_errors.push(...page1Errors, ...page2Errors);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
    reconcilePage1Amounts(out, reconciliation);
  } finally {
    await terminateOcrWorkers(workers);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseShueisha({
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  let extract: ShueishaExtract;
  try {
    extract = await extractShueishaFromPdf(buffer);
  } catch (e) {
    return {
      platform_code: "shueisha",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [`shueisha local OCR failed: ${(e as Error).message}`],
    };
  }
  return buildShueishaParseResult(extract);
}
