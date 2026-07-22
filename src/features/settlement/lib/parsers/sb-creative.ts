/**
 * SB Creative parser.
 *
 * Three source-file families arrive monthly:
 *   · 売上報告書／前払印税報告書 PDF — the monthly sales report. This is the
 *     ONLY authoritative source for INPUT EB detail rows: one row per logical
 *     work+volume, net of that volume's 当期MG取崩額 from the MG一覧 table.
 *   · 【請求書】 MG invoice XLSX/PDF — summary/audit evidence only.
 *   · 支払通知書 PDF — monthly cash summary, audit evidence only.
 *
 * Detail rows are merged by a normalized work+volume key, never by row
 * adjacency or a whole-month rollup. Titles, months, and amounts are never
 * hardcoded; the identity rules below are structural only.
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { parseInvoicePdf, parseInvoiceXlsx } from "./invoice-common";
import { extractPdfText } from "./pdf-text";

const TAX_RATE = 0.10;

/**
 * Rows whose title string is a section header or metadata marker rather
 * than a work title (小計/合計/channel headings picked up by AI Vision).
 */
const METADATA_TITLE = /配信分|電子書籍[/／]|小計|合計|\bGA\b/;

export type SbSourceFileKind = "mg_invoice" | "payment_notice" | "sales_report";

export function classifySbSourceFile(filename: string): SbSourceFileKind {
  if (/【請求書】/.test(filename)) return "mg_invoice";
  if (/支払通知書/.test(filename)) return "payment_notice";
  return "sales_report";
}

export type SbWorkKey = {
  /** Normalized series identity: NFKC, whitespace/bracket folding, edition markers removed. */
  seriesKey: string;
  /** Canonical volume number ("1", "2", …) or null when the row carries no volume. */
  volumeKey: string | null;
  /** Display form of the series title (marker-free, whitespace-free). */
  seriesLabel: string;
};

/** Episode-range decorations on 分冊版 rows: `(1話～9話)` or bare `1話～9話`. */
const EPISODE_RANGE = /\(?\s*\d+\s*話\s*~\s*\d+\s*話\s*\)?/g;
/** Edition/format markers that never carry work identity. Volume digits are preserved. */
const EDITION_MARKER = /【[^】]*(?:分冊|単行本|合本)[^】]*】|\(\s*(?:分冊版|単行本|コミック)\s*\)/g;

export function normalizeSbWorkKey(rawTitle: string): SbWorkKey {
  let text = String(rawTitle ?? "")
    .normalize("NFKC")
    .replace(/[〜~]/g, "~")
    .replace(/[「」『』]/g, "")
    .replace(EPISODE_RANGE, " ")
    .replace(EDITION_MARKER, " ");

  let volume: string | null = null;
  const kan = text.match(/第\s*(\d+)\s*巻/);
  if (kan) {
    volume = kan[1];
    text = text.replace(kan[0], " ");
  }
  if (!volume) {
    const paren = text.match(/\(\s*(\d+)\s*\)\s*$/);
    if (paren) {
      volume = paren[1];
      text = text.slice(0, paren.index ?? text.length);
    }
  }
  if (!volume) {
    const tail = text.match(/(\d+)\s*$/);
    if (tail) {
      volume = tail[1];
      text = text.slice(0, tail.index ?? text.length);
    }
  }

  const seriesLabel = text.replace(/\(\s*\)/g, " ").replace(/\s+/g, "");
  return {
    seriesLabel,
    seriesKey: seriesLabel.toLowerCase(),
    volumeKey: volume ? String(Number(volume)) : null,
  };
}

const FULLWIDTH_DIGITS = "０１２３４５６７８９";

/** Workbook display title for one work+volume, e.g. `作品名（１）`. */
export function canonicalSbVolumeTitle(seriesLabel: string, volumeKey: string): string {
  const volume = [...volumeKey]
    .map((d) => FULLWIDTH_DIGITS[Number(d)] ?? d)
    .join("");
  return `${seriesLabel}（${volume}）`;
}

export type SbSalesDetailRow = { title: string; royalty_taxincl: number };
export type SbMgDrawRow = { title: string; current_draw_taxincl: number };

/**
 * Turn the sales report's detail rows + MG一覧 into INPUT EB records.
 *
 * · Normal-edition, 分冊版, and multiple-price rows of the same work+volume
 *   merge into one row (validated by key, not adjacency — row order never
 *   affects the result).
 * · A volume-less 分冊版 row binds to a volume only when exactly one
 *   candidate exists in its series (detail-row volumes first, then MG
 *   volumes); several candidates are a parser error, never a guess.
 * · Per work+volume: net(税込) = Σroyalty − Σ当期MG取崩額; rows with
 *   net ≤ 0 are skipped; net(税抜) = round(net / 1.1).
 */
export function aggregateSbSalesReport(input: {
  detailRows: SbSalesDetailRow[];
  mgRows: SbMgDrawRow[];
  salesMonth?: string | null;
}): { records: ParseResult["records"]; errors: string[] } {
  const errors: string[] = [];
  // SB Creative pays the report's target sales month four months later, at
  // month end. Applies only to these authoritative sales-report detail rows;
  // invoice / payment-notice evidence stays summary-only and untouched.
  const depositMonth = input.salesMonth ? addMonthsEndOfMonth(input.salesMonth, 4) : null;
  type Bucket = { seriesLabel: string; volumeKey: string; grossIncl: number; drawIncl: number };
  const buckets = new Map<string, Bucket>();
  const bucketId = (seriesKey: string, volumeKey: string) => `${seriesKey}\u0000${volumeKey}`;
  const detailVolumes = new Map<string, Set<string>>();
  const mgVolumes = new Map<string, Set<string>>();
  const pending: { key: SbWorkKey; amount: number; title: string }[] = [];

  const bucketFor = (key: SbWorkKey, volumeKey: string): Bucket => {
    const id = bucketId(key.seriesKey, volumeKey);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { seriesLabel: key.seriesLabel, volumeKey, grossIncl: 0, drawIncl: 0 };
      buckets.set(id, bucket);
    }
    return bucket;
  };

  for (const row of input.detailRows) {
    if (METADATA_TITLE.test(row.title)) continue;
    const key = normalizeSbWorkKey(row.title);
    if (!key.seriesKey) continue;
    if (key.volumeKey) {
      bucketFor(key, key.volumeKey).grossIncl += row.royalty_taxincl;
      const volumes = detailVolumes.get(key.seriesKey) ?? new Set<string>();
      volumes.add(key.volumeKey);
      detailVolumes.set(key.seriesKey, volumes);
    } else {
      pending.push({ key, amount: row.royalty_taxincl, title: row.title });
    }
  }

  for (const mg of input.mgRows) {
    const key = normalizeSbWorkKey(mg.title);
    if (!key.seriesKey) continue;
    if (!key.volumeKey) {
      errors.push(`sb-creative: MG row has no work+volume identity: ${mg.title}`);
      continue;
    }
    bucketFor(key, key.volumeKey).drawIncl += mg.current_draw_taxincl;
    const volumes = mgVolumes.get(key.seriesKey) ?? new Set<string>();
    volumes.add(key.volumeKey);
    mgVolumes.set(key.seriesKey, volumes);
  }

  // Volume-less rows resolve against the full report, so input order is
  // irrelevant. Ambiguity is isolated as an error instead of paired away.
  for (const row of pending) {
    const fromDetail = detailVolumes.get(row.key.seriesKey);
    const candidates = fromDetail && fromDetail.size > 0
      ? fromDetail
      : mgVolumes.get(row.key.seriesKey) ?? new Set<string>();
    if (candidates.size === 1) {
      const [volumeKey] = candidates;
      bucketFor(row.key, volumeKey).grossIncl += row.amount;
    } else {
      errors.push(
        `sb-creative: volume-less row "${row.title}" has ${candidates.size} candidate volumes in its series — refusing to guess`,
      );
    }
  }

  const ordered = [...buckets.entries()].sort(([a], [b]) => {
    const [seriesA, volA] = a.split("\u0000");
    const [seriesB, volB] = b.split("\u0000");
    return seriesA.localeCompare(seriesB) || Number(volA) - Number(volB);
  });

  const records: ParseResult["records"] = [];
  for (const [, bucket] of ordered) {
    const netIncl = bucket.grossIncl - bucket.drawIncl;
    if (netIncl <= 0) continue;
    const netExcl = Math.round(netIncl / (1 + TAX_RATE));
    const title = canonicalSbVolumeTitle(bucket.seriesLabel, bucket.volumeKey);
    records.push({
      row_index: records.length,
      data: {
        title_jp: title,
        channel_title_jp: title,
        type: "EB",
        channel_code: "sb creative",
        client_code: "sb creative",
        sales_month: input.salesMonth ?? null,
        settlement_month: null,
        deposit_month: depositMonth,
        total_amount_jpy: null,
        before_tax_jpy: netIncl,
        after_tax_jpy: netExcl,
        before_tax_income_jpy: netIncl,
        after_tax_income_jpy: netExcl,
        after_tax_income_jpy_a: netExcl,
        consumption_tax_jpy: netIncl - netExcl,
        withholding_tax_jpy: 0,
        source_file_kind: "sb_creative_sales_report",
      },
    });
  }

  return { records, errors };
}

/** End of the month `months` after the given YYYY-MM-01. */
function addMonthsEndOfMonth(iso: string, months: number): string {
  const [year, month] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1 + months + 1, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Signed, comma-formatted JPY: `¥1,234`, `-1,234`, `▲1,234`, `−1,234`. */
function parseSignedAmount(raw: string): number | null {
  const cleaned = raw.replace(/[¥￥\s,]/g, "").replace(/[−▲]/g, "-");
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * Column-header / price-config vocabulary of the detail table. These tokens
 * may lead or trail a title in the flattened text stream (価格・販売数・算出元
 * cells, % rates, circled markers) and never carry work identity.
 */
const CONFIG_TOKEN = /^(?:[-−▲]?[\d.,]+%?|[①②③]|書名|価格|販売数|算出元|料率|区分|消費税率|ネット|グロス|電子書籍|ロイヤリティ\(税込\))$/;

function cleanDetailTitle(candidate: string): string {
  const tokens = candidate.split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && CONFIG_TOKEN.test(tokens[0].normalize("NFKC"))) tokens.shift();
  while (tokens.length > 0 && CONFIG_TOKEN.test(tokens[tokens.length - 1].normalize("NFKC"))) tokens.pop();
  return tokens.join(" ").trim();
}

/** Structural work-row markers; a bare short volume number also qualifies. */
const WORK_TITLE_MARKER = /コミック|分冊版|第\s*\d+\s*巻|\d+\s*話/;

function isWorkDetailTitle(title: string): boolean {
  if (!title || METADATA_TITLE.test(title)) return false;
  if (WORK_TITLE_MARKER.test(title)) return true;
  const volume = normalizeSbWorkKey(title).volumeKey;
  return volume !== null && volume.length <= 3;
}

export type SbSalesReportParse = {
  targetMonth: string | null;
  detailRows: SbSalesDetailRow[];
  mgRows: SbMgDrawRow[];
  errors: string[];
};

type SbAmountCandidate = {
  index: number;
  offset: number;
  amount: number;
  isDetail: boolean;
};

type SbSummaryTotals = {
  gross: number;
  draw: number;
  final: number;
};

function findSbSummaryTotals(
  detailRegion: string,
  candidates: SbAmountCandidate[],
  expectedDraw: number | null,
): { totals: SbSummaryTotals | null; errors: string[] } {
  const labelPositions = [
    detailRegion.indexOf("総合計額"),
    detailRegion.indexOf("当期売上合計"),
    detailRegion.indexOf("当期MG取崩額"),
    detailRegion.indexOf("MG一覧シート参照"),
  ];
  if (labelPositions.some((pos) => pos < 0)) {
    return {
      totals: null,
      errors: ["sb-creative: summary cluster labels were not found"],
    };
  }
  for (let i = 1; i < labelPositions.length; i++) {
    if (labelPositions[i] <= labelPositions[i - 1]) {
      return {
        totals: null,
        errors: ["sb-creative: summary cluster labels were not in the expected order"],
      };
    }
  }

  const summaryStart = labelPositions[0];
  const pool = candidates.filter((c) => !c.isDetail && c.offset >= summaryStart && c.amount >= 0);
  const matches: SbSummaryTotals[] = [];
  for (const gross of pool) {
    if (gross.amount <= 0) continue;
    for (const draw of pool) {
      if (draw.index === gross.index) continue;
      if (expectedDraw !== null && draw.amount !== expectedDraw) continue;
      for (const final of pool) {
        if (final.index === gross.index || final.index === draw.index) continue;
        if (gross.amount - draw.amount === final.amount) {
          matches.push({ gross: gross.amount, draw: draw.amount, final: final.amount });
        }
      }
    }
  }

  const unique = new Map(matches.map((m) => [`${m.gross}\u0000${m.draw}\u0000${m.final}`, m]));
  if (unique.size !== 1) {
    return {
      totals: null,
      errors: [
        unique.size === 0
          ? "sb-creative: summary cluster did not contain a gross - MG draw = final match"
          : "sb-creative: summary cluster had multiple gross - MG draw = final matches",
      ],
    };
  }

  return { totals: [...unique.values()][0], errors: [] };
}

/**
 * Deterministic (no-AI) parse of unpdf-flattened sales-report text.
 * Pages arrive as one space-joined string each, "\n"-separated; token order
 * follows the content stream, so parsing is structural, not positional:
 *   · 対象期間 YYYY年MM月 → targetMonth.
 *   · Work detail entries are a title bearing structural edition markers
 *     (コミック/分冊版/巻/話数-range/volume) followed by its ¥amount. Price
 *     rows (¥price 販売数 ネット …), summary prose, and channel rows are
 *     excluded structurally; continuation entries after summary prose still
 *     parse because pairing is stream-wide, not page/line-scoped.
 *   · The MG section starts at the standalone MG一覧 heading; each row is
 *     management-number + MGタイトル + 取崩開始年月 + four money cells whose
 *     THIRD value is 当期MG取崩額②.
 *   · When the printed 当期売上合計① / MG header 取崩 total are found, the
 *     parsed sums must reconcile exactly — otherwise this returns an explicit
 *     error and no INPUT detail at all.
 */
export function parseSbSalesReportText(flattenedText: string): SbSalesReportParse {
  const errors: string[] = [];
  const text = String(flattenedText ?? "");

  const period = text.match(/対象期間\s*(\d{4})\s*年\s*(\d{1,2})\s*月/);
  const targetMonth = period ? `${period[1]}-${period[2].padStart(2, "0")}` : null;

  // Region boundaries. The MG list heading, not the 「MG一覧シート参照」
  // mention in the totals block, starts the MG section; the channel table
  // (チャネル別) sits between details and the MG list and is skipped.
  const mgMatch = /MG一覧(?!シート)/.exec(text);
  const mgStart = mgMatch ? mgMatch.index : text.length;
  const channelMatch = /チャネル別/.exec(text);
  const detailEnd =
    channelMatch && channelMatch.index < mgStart ? channelMatch.index : mgStart;
  const detailRegion = text.slice(0, detailEnd);
  const mgRegion = text.slice(mgStart);

  // Detail entries: stream-wide (title, ¥amount) pairing.
  const detailRows: SbSalesDetailRow[] = [];
  const amountCandidates: SbAmountCandidate[] = [];
  const amountRe = /[¥￥]\s*([-−▲]?[\d,]+)/g;
  let cursor = 0;
  let amountIndex = 0;
  for (let m = amountRe.exec(detailRegion); m; m = amountRe.exec(detailRegion)) {
    const candidate = detailRegion.slice(cursor, m.index);
    cursor = amountRe.lastIndex;
    const amount = parseSignedAmount(m[1]);
    if (amount === null) continue;
    const title = cleanDetailTitle(candidate);
    const isDetail = isWorkDetailTitle(title);
    amountCandidates.push({
      index: amountIndex++,
      offset: m.index,
      amount,
      isDetail,
    });
    if (!isDetail) continue;
    detailRows.push({ title, royalty_taxincl: amount });
  }

  // MG rows: management number + title + start month + money cells.
  const mgRows: SbMgDrawRow[] = [];
  // (?<![\d,¥￥.]) keeps the management number from matching inside a money
  // cell (e.g. the "900" of "298,900") without consuming the row boundary.
  const mgRowRe = /(?<![\d,¥￥.])(\d{3,6})\s+(.+?)\s+\d{4}年\d{1,2}月\s+((?:[¥￥]\s*[-−▲]?[\d,]+\s*){3,4})/g;
  let firstMgRowIndex: number | null = null;
  for (let m = mgRowRe.exec(mgRegion); m; m = mgRowRe.exec(mgRegion)) {
    if (firstMgRowIndex === null) firstMgRowIndex = m.index;
    const cells = m[3].match(/[¥￥]\s*[-−▲]?[\d,]+/g) ?? [];
    if (cells.length < 3) continue;
    const draw = parseSignedAmount(cells[2]);
    if (draw === null) continue;
    mgRows.push({ title: m[2].trim(), current_draw_taxincl: draw });
  }

  // Printed MG draw total: third value of the first run of ≥4 bare numbers
  // in the MG header (MG支払額計 / 期首計 / 当期取崩計② / 期末計).
  let printedDrawTotal: number | null = null;
  const headerTokens = mgRegion
    .slice(0, firstMgRowIndex ?? mgRegion.length)
    .split(/\s+/)
    .filter(Boolean);
  let run: number[] = [];
  for (const token of headerTokens) {
    const value = /^[-−▲]?\d[\d,]*$/.test(token) ? parseSignedAmount(token) : null;
    if (value === null) {
      run = [];
      continue;
    }
    run.push(value);
    if (run.length >= 4) {
      printedDrawTotal = run[2];
      break;
    }
  }

  const summary = findSbSummaryTotals(detailRegion, amountCandidates, printedDrawTotal);
  errors.push(...summary.errors);
  const printedSalesTotal = summary.totals?.gross ?? null;
  const printedSummaryDrawTotal = summary.totals?.draw ?? null;

  if (printedSalesTotal !== null) {
    const sum = detailRows.reduce((s, r) => s + r.royalty_taxincl, 0);
    if (sum !== printedSalesTotal) {
      errors.push(
        `sb-creative: parsed detail sum ${sum} does not match printed 当期売上合計 ${printedSalesTotal} — refusing to emit INPUT detail`,
      );
    }
  }
  if (
    printedDrawTotal !== null &&
    printedSummaryDrawTotal !== null &&
    printedDrawTotal !== printedSummaryDrawTotal
  ) {
    errors.push("sb-creative: printed MG draw totals disagree between summary cluster and MG list header");
  }
  if (printedSummaryDrawTotal !== null) {
    const sum = mgRows.reduce((s, r) => s + r.current_draw_taxincl, 0);
    if (sum !== printedSummaryDrawTotal) {
      errors.push(
        `sb-creative: parsed MG draw sum ${sum} does not match printed 当期MG取崩額 ${printedSummaryDrawTotal} — refusing to emit INPUT detail`,
      );
    }
  }
  if (errors.length > 0) {
    return { targetMonth, detailRows: [], mgRows: [], errors };
  }
  return { targetMonth, detailRows, mgRows, errors };
}

export async function parseSbCreative({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const kind = classifySbSourceFile(filename);

  if (kind === "mg_invoice") {
    const ctx = {
      platform_code: "sb_creative",
      client_code: "sb_creative",
      channel_code: "sb_creative",
      type: "OTHER",
      note: "sb_creative invoice summary — non-aggregated evidence row",
    };
    const isPdf = /\.pdf$/i.test(filename);
    const result = await (isPdf
      ? parseInvoicePdf(filename, buffer, ctx)
      : parseInvoiceXlsx(filename, buffer, ctx));
    // Invoice line items are MG billing evidence, not INPUT detail: the
    // authoritative source for EB rows is the monthly sales report.
    for (const record of result.records) {
      record.data.is_summary = true;
      record.data.source_file_kind =
        record.data.source_file_kind ?? (isPdf ? "sb_creative_invoice_pdf" : "sb_creative_invoice_xlsx");
    }
    return result;
  }

  if (kind === "payment_notice") {
    // Monthly cash summary. Audit evidence only — returning zero records lets
    // the generic summary fallback keep the totals row with is_summary=true.
    return {
      platform_code: "sb_creative",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: [],
    };
  }

  // Sales report: deterministic serverless text extraction, no AI dependency.
  const text = await extractPdfText(buffer, { maxPages: 10 });
  if (!text.trim()) {
    return {
      platform_code: "sb_creative",
      sales_month: null,
      settlement_month: null,
      records: [],
      errors: ["sb-creative: sales report has no extractable text layer"],
    };
  }

  const parsed = parseSbSalesReportText(text);
  const salesMonth = parsed.targetMonth ? `${parsed.targetMonth}-01` : null;
  if (parsed.errors.length > 0) {
    return {
      platform_code: "sb_creative",
      sales_month: salesMonth,
      settlement_month: null,
      records: [],
      errors: parsed.errors,
    };
  }

  const { records, errors } = aggregateSbSalesReport({
    detailRows: parsed.detailRows,
    mgRows: parsed.mgRows,
    salesMonth,
  });
  if (records.length === 0 && errors.length === 0) {
    errors.push("sb-creative: sales report produced no positive work+volume rows");
  }

  return {
    platform_code: "sb_creative",
    sales_month: salesMonth,
    settlement_month: null,
    records,
    errors,
  };
}
