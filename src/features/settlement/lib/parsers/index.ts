/**
 * Top-level parse dispatcher.
 *
 * Parsers that bundle heavy / Node-incompatible dependencies
 * (pdf-parse pulls in pdfjs which references the browser-only
 * DOMMatrix global) are imported lazily so the /api/upload route can
 * boot in Vercel serverless even when those modules can't be evaluated
 * at top level. A regular xlsx/csv upload therefore never touches the
 * PDF code paths.
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { detectPlatform } from "./registry";
import { readWorkbook } from "./common";
import { parseGenericSummaryFallback } from "./generic-summary-fallback";

// Lightweight parsers — safe to eager-import.
import { parseCmoa } from "./cmoa";
import { parsePiccoma } from "./piccoma";
import { parseLineEbj } from "./line-ebj";
import { parseBooklive } from "./booklive";
import { parseRenta } from "./renta";
import { parseMechacomic } from "./mechacomic";
import { parseComico } from "./comico";
import { parseDmm } from "./dmm";
import { parseLineAd } from "./line-ad";
import { parseUnext } from "./unext";
import { parsePiccomaGaiakuhan } from "./piccoma-gaiakuhan";
import { parsePiccomaAds } from "./piccoma-ads";
import { parseMediado } from "./mediado";
import { parseMbj } from "./mbj";
import { parseMangabang } from "./mangabang";
import { parseKadokawa } from "./kadokawa";
import { parseLezhinBeltoon } from "./lezhin-beltoon";
import { parseBeaglee } from "./beaglee";

export type ParserFn = (opts: {
  filename: string;
  buffer: Buffer;
  folderName?: string;
}) => Promise<ParseResult>;

type LazyParser = () => Promise<ParserFn>;

const EAGER: Record<string, ParserFn> = {
  cmoa: parseCmoa,
  piccoma: parsePiccoma,
  ebj_line: parseLineEbj,
  booklive: parseBooklive,
  renta: parseRenta,
  mechacomic: parseMechacomic,
  comico: parseComico,
  dmm: parseDmm,
  line_ad: parseLineAd,
  u_next: parseUnext,
  piccoma_gaiakuhan: parsePiccomaGaiakuhan,
  piccoma_ads: parsePiccomaAds,
  mediado: parseMediado,
  mbj: parseMbj,
  mangabang: parseMangabang,
  kadokawa: parseKadokawa,
  beltoon: parseLezhinBeltoon,
  lezhin: parseLezhinBeltoon,
  beaglee: parseBeaglee,
};

// Parsers that import pdf-parse (which references DOMMatrix at module
// eval) or spawn child processes. Loaded only when that platform is
// actually detected — so a plain xlsx upload never pays the cost.
const LAZY: Record<string, LazyParser> = {
  shueisha: async () => (await import("./shueisha")).parseShueisha,
  ichijinsha: async () => (await import("./ichijinsha")).parseIchijinsha,
  sb_creative_m: async () => (await import("./sb-creative")).parseSbCreative,
  sb_creative_e: async () => (await import("./sb-creative")).parseSbCreative,
};

export async function parseFile(opts: {
  filename: string;
  buffer: Buffer;
  folderName?: string;
  headerSample?: string[];
  sheetNames?: string[];
}): Promise<ParseResult & { detection_confidence: number }> {
  const sheetNames = opts.sheetNames ?? safeSheetNames(opts.filename, opts.buffer);
  const detection = detectPlatform({ ...opts, sheetNames });
  const code = detection.platform_code;

  const eager = EAGER[code];
  const lazyGetter = LAZY[code];
  const parser = eager ?? (lazyGetter ? await lazyGetter() : null);

  if (!parser) {
    return {
      platform_code: code,
      sales_month: null,
      settlement_month: "",
      records: [],
      errors: [`no parser for platform: ${code}`],
      detection_confidence: detection.confidence,
    };
  }

  const result = await parser({
    filename: opts.filename,
    buffer: opts.buffer,
    folderName: opts.folderName,
  });
  if (result.records.length === 0 && shouldUseGenericSummaryFallback(opts.filename, code)) {
    const fallback = await parseGenericSummaryFallback({
      filename: opts.filename,
      buffer: opts.buffer,
      platformCode: code,
      previousErrors: result.errors,
    });
    return { ...fallback, detection_confidence: detection.confidence };
  }
  return { ...result, detection_confidence: detection.confidence };
}

function shouldUseGenericSummaryFallback(filename: string, platformCode: string): boolean {
  if (platformCode === "unknown") return false;
  // The Ichijinsha 詳細別送の内訳 statement is an authoritative detail source:
  // a zero-row parse there is a hard parser error that must surface instead
  // of being masked by a generic one-line summary.
  if (platformCode === "ichijinsha" && /詳細別送の内訳/.test(filename)) return false;
  // The Shueisha 支払通知書 is the authoritative detail source for Manga Mee /
  // Jumptoon rows and its parser already reconciles printed totals. Zero rows
  // therefore means the local OCR pipeline itself failed (e.g. the deployed
  // bundle is missing the @napi-rs/canvas native binding) and must surface as
  // a hard failure instead of being masked by a generic one-line summary.
  if (platformCode === "shueisha") return false;
  // The SB Creative monthly sales report is the authoritative EB detail
  // source: zero rows or a totals-reconciliation failure there must surface
  // as a parser error instead of being masked by a generic one-line summary.
  // Invoice (【請求書】) and payment-notice (支払通知書) files keep the
  // fallback — their evidence rows are summary-only by design.
  if (
    platformCode.startsWith("sb_creative") &&
    !/【請求書】/.test(filename) &&
    !/支払通知書/.test(filename)
  ) {
    return false;
  }
  return /\.(pdf|xlsx|xls|csv|tsv)$/i.test(filename);
}

function safeSheetNames(filename: string, buffer: Buffer): string[] {
  if (!/\.(xlsx|xls)$/i.test(filename)) return [];
  try {
    return readWorkbook(buffer).SheetNames;
  } catch {
    return [];
  }
}

// Re-export for callers that still look at the registry / detection directly.
export { detectPlatform };

// Flat map that behaves like the old PARSERS export — async resolution
// so callers can `await PARSERS[code]({...})` transparently.
export const PARSERS: Record<string, ParserFn> = {
  ...EAGER,
  // Wrap each lazy parser so its signature stays ParserFn.
  ...Object.fromEntries(
    Object.entries(LAZY).map(([code, getter]) => [
      code,
      async (opts) => (await getter())(opts),
    ]),
  ),
};
