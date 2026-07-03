/**
 * pdf-text.ts — non-AI PDF text extraction via unpdf (serverless pdfjs).
 *
 * Used as a lightweight fallback for payment-notice / invoice PDFs whose
 * numbers we only need at summary level. unpdf is already a dependency and
 * is safe in Vercel Functions (no DOMMatrix issue like pdf-parse); it is
 * imported lazily so plain xlsx/csv uploads never load it.
 *
 * Some PDFs (e.g. DMM) embed CID fonts that need Adobe cMap tables. When
 * the pdfjs-dist cmaps directory exists on disk we feed it through an
 * fs-backed CMapReaderFactory; if anything fails the function returns ""
 * so callers keep their existing "no rows" behaviour.
 */
import fs from "node:fs";
import path from "node:path";

let cmapDirCache: string | null | undefined;

function findCmapDir(): string | null {
  if (cmapDirCache !== undefined) return cmapDirCache;
  const candidates = [
    path.resolve(process.cwd(), "node_modules/pdfjs-dist/cmaps"),
    path.resolve(__dirname, "../../../../../node_modules/pdfjs-dist/cmaps"),
  ];
  cmapDirCache = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? null;
  return cmapDirCache;
}

/**
 * Extract plain text from a PDF. Token order follows the content stream,
 * not visual layout — callers must use order-tolerant regexes.
 * Returns "" when the PDF has no text layer or extraction fails.
 */
export async function extractPdfText(
  buffer: Buffer,
  opts: { maxPages?: number } = {},
): Promise<string> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const docOpts: Record<string, unknown> = {};
    const cmaps = findCmapDir();
    if (cmaps) {
      docOpts.cMapUrl = cmaps + "/";
      docOpts.cMapPacked = true;
      docOpts.CMapReaderFactory = class {
        async fetch({ name }: { name: string }) {
          const data = fs.readFileSync(path.join(cmaps, `${name}.bcmap`));
          return { cMapData: new Uint8Array(data), compressionType: 1 };
        }
      };
    }
    const pdf = await getDocumentProxy(new Uint8Array(buffer), docOpts);
    const pages = Math.min(pdf.numPages, opts.maxPages ?? pdf.numPages);
    const chunks: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      chunks.push(
        (content.items as Array<{ str?: string }>)
          .map((it) => it.str ?? "")
          .join(" "),
      );
    }
    return chunks.join("\n").replace(/\u00a0/g, " ");
  } catch {
    return "";
  }
}

const NUM = "[-−▲]?[\\d,]+(?:\\.\\d+)?";

function toAmount(s: string): number | null {
  const n = Number(s.replace(/[,¥￥\\]/g, "").replace(/[−▲]/g, "-"));
  return Number.isFinite(n) ? n : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the amount attached to a label in extracted PDF text. Because the
 * content stream may put the number either right before or right after the
 * label, both adjacencies are tried (before wins — it is tighter).
 */
export function findLabeledAmount(text: string, label: string | RegExp): number | null {
  const l = typeof label === "string" ? escapeRe(label) : label.source;
  const before = new RegExp(`[¥￥\\\\]?(${NUM})\\s*円?\\s*${l}`);
  const after = new RegExp(`${l}[^0-9¥￥\\\\−▲-]{0,25}[¥￥\\\\]?(${NUM})\\s*円?`);
  for (const re of [before, after]) {
    const m = text.match(re);
    if (m?.[1] != null) {
      const n = toAmount(m[1]);
      if (n != null) return n;
    }
  }
  return null;
}

/** First match of any pattern with (year, month) capture groups → YYYY-MM-01. */
export function findMonth(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && m?.[2]) {
      return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-01`;
    }
  }
  return null;
}
