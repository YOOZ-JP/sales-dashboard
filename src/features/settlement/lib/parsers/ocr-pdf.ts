/**
 * ocr-pdf.ts — deterministic local OCR for scanned (image-only) PDFs.
 *
 * No network, no AI gateway, no CDN:
 *   · pages are rasterized with unpdf (pdfjs) + @napi-rs/canvas
 *   · text is read with tesseract.js; the worker script and WASM core
 *     resolve from node_modules, and language data comes from the
 *     locally installed @tesseract.js-data/<lang> packages
 *   · traineddata is staged into the OS tmp dir because tesseract.js
 *     wants a single langPath directory and Vercel Functions only
 *     allow writes under /tmp
 *
 * Besides plain line OCR this module offers ruled-table support: pages
 * are binarized, solid grid lines are detected from pixel runs, and
 * individual cells can be OCR'd with a digits-only whitelist so amounts
 * survive dashed column guides and tinted carbon-copy backgrounds.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createWorker } from "tesseract.js";
import type Tesseract from "tesseract.js";

export type OcrWorker = Tesseract.Worker;

export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  words?: OcrWord[];
}

export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BinarizedPage {
  /** Re-encoded black & white PNG (what OCR should read). */
  png: Buffer;
  width: number;
  height: number;
  /** 1 byte per pixel; 1 = dark. */
  dark: Uint8Array;
}

export interface TableGrid {
  /** x centers of vertical rules, left → right */
  xs: number[];
  /** y centers of horizontal rules, top → bottom */
  ys: number[];
}

/**
 * All canvas access goes through here so a missing platform binary
 * (e.g. a prebuilt deploy that never bundled skia.linux-*.node) fails
 * with an actionable message instead of a bare "Cannot find module".
 */
async function importCanvas(): Promise<typeof import("@napi-rs/canvas")> {
  try {
    return await import("@napi-rs/canvas");
  } catch (e) {
    throw new Error(
      `ocr-pdf: @napi-rs/canvas native binding unavailable for ${process.platform}-${process.arch} — ` +
      `the deployed bundle is missing the platform binary (deploy via scripts that run ` +
      `scripts/ensure-canvas-linux-binding.mjs before "vercel build"): ${(e as Error).message}`,
    );
  }
}

function findLangSource(lang: string): string | null {
  const rel = `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
  const candidates = [
    path.resolve(process.cwd(), rel),
    path.resolve(__dirname, `../../../../../${rel}`),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? null;
}

/** Copy packaged traineddata into a single writable langPath directory. */
function stageLangData(langs: string[]): string {
  const dir = path.join(os.tmpdir(), "rvjp-tessdata");
  fs.mkdirSync(dir, { recursive: true });
  for (const lang of langs) {
    const dest = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(dest)) continue;
    const src = findLangSource(lang);
    if (!src) throw new Error(`ocr-pdf: no local traineddata for "${lang}" (expected @tesseract.js-data/${lang})`);
    fs.copyFileSync(src, dest);
  }
  return dir;
}

/** Render every page of a PDF to a PNG buffer. scale 1 = 72dpi. */
export async function renderPdfPagesToPng(
  buffer: Buffer,
  opts: { scale?: number } = {},
): Promise<Buffer[]> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await import("unpdf");
  const canvasImport = () => importCanvas();
  // Scanned pages are image XObjects; pdfjs needs a document-level canvas
  // factory to decode them (renderPageAsImage's canvasImport only covers the
  // output canvas).
  const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    CanvasFactory,
  } as Parameters<typeof getDocumentProxy>[1]);
  const pages: Buffer[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const png = await renderPageAsImage(pdf, i, {
      canvasImport,
      scale: opts.scale ?? 3,
    });
    pages.push(Buffer.from(png));
  }
  return pages;
}

/** langs in tesseract "+" form, e.g. "jpn+eng". */
export async function createLocalOcrWorker(langs: string): Promise<OcrWorker> {
  const langPath = stageLangData(langs.split("+"));
  const worker = await createWorker(langs, 1, {
    langPath,
    gzip: true,
    cacheMethod: "none",
  });
  await worker.setParameters({ preserve_interword_spaces: "1" });
  return worker;
}

/**
 * Create one OCR worker per langs spec, all concurrently. Either every
 * worker comes up and they are returned in spec order, or every worker
 * that did come up is terminated before the first creation error is
 * rethrown — a partial failure must not leak WASM workers inside a
 * serverless function. `create` is injectable for synthetic tests.
 */
export async function createLocalOcrWorkers(
  langsList: string[],
  create: (langs: string) => Promise<OcrWorker> = createLocalOcrWorker,
): Promise<OcrWorker[]> {
  const settled = await Promise.allSettled(langsList.map((langs) => create(langs)));
  const failure = settled.find((s) => s.status === "rejected");
  if (failure) {
    await terminateOcrWorkers(
      settled
        .filter((s): s is PromiseFulfilledResult<OcrWorker> => s.status === "fulfilled")
        .map((s) => s.value),
    );
    throw (failure as PromiseRejectedResult).reason;
  }
  return (settled as PromiseFulfilledResult<OcrWorker>[]).map((s) => s.value);
}

/** Terminate every worker, tolerating individual terminate() failures. */
export async function terminateOcrWorkers(workers: OcrWorker[]): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
}

/**
 * Threshold a rendered page to pure black & white. Kills tinted
 * carbon-copy backgrounds and light dashed digit guides that otherwise
 * corrupt digit OCR.
 */
export async function binarizePng(png: Buffer, threshold = 150): Promise<BinarizedPage> {
  const { createCanvas, loadImage } = await importCanvas();
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, img.width, img.height);
  const px = image.data;
  const dark = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const isDark = lum < threshold ? 1 : 0;
    dark[p] = isDark;
    const v = isDark ? 0 : 255;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return {
    png: canvas.toBuffer("image/png"),
    width: img.width,
    height: img.height,
    dark,
  };
}

function clusterPositions(hits: number[], gap = 6): number[] {
  const centers: number[] = [];
  let start = -1;
  let prev = -1;
  for (const v of hits) {
    if (start === -1) {
      start = v;
    } else if (v - prev > gap) {
      centers.push(Math.round((start + prev) / 2));
      start = v;
    }
    prev = v;
  }
  if (start !== -1) centers.push(Math.round((start + prev) / 2));
  return centers;
}

interface RuleSegment {
  start: number;
  end: number;
  /** dark hits inside [start, end] */
  dark: number;
}

/**
 * Longest dark segment along one axis, tolerating small gaps so a
 * slightly skewed scan (rule drifting across a few pixels) still reads
 * as one line. `isDark` should already look through a small window
 * perpendicular to the scan direction.
 */
function bestSegment(isDark: (i: number) => boolean, length: number, maxGap: number): RuleSegment | null {
  let best: RuleSegment | null = null;
  let cur: RuleSegment | null = null;
  let gap = 0;
  for (let i = 0; i < length; i++) {
    if (isDark(i)) {
      if (!cur) cur = { start: i, end: i, dark: 0 };
      cur.end = i;
      cur.dark++;
      gap = 0;
    } else if (cur) {
      gap++;
      if (gap > maxGap) {
        if (!best || cur.end - cur.start > best.end - best.start) best = cur;
        cur = null;
        gap = 0;
      }
    }
  }
  if (cur && (!best || cur.end - cur.start > best.end - best.start)) best = cur;
  return best;
}

/**
 * Detect the dominant ruled table on a binarized page.
 *
 * Vertical rule candidates (long, mostly-continuous dark segments) bound
 * the table; horizontal rules are wide dark segments inside those bounds.
 * A density cut keeps dashed digit guides and stray boxes out of the
 * final rule set while still letting them contribute to the bounds.
 */
export function detectTableGrid(page: BinarizedPage): TableGrid | null {
  const { dark, width, height } = page;
  const darkNearX = (x: number, y: number): boolean => {
    const row = y * width;
    for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
      if (dark[row + xx]) return true;
    }
    return false;
  };
  const darkNearY = (y: number, x: number): boolean => {
    for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
      if (dark[yy * width + x]) return true;
    }
    return false;
  };

  // 1. vertical candidates → table bounds
  const minVExtent = Math.floor(height * 0.12);
  const vCands: Array<{ x: number; seg: RuleSegment }> = [];
  for (let x = 0; x < width; x++) {
    const seg = bestSegment((y) => darkNearX(x, y), height, 8);
    if (seg && seg.end - seg.start >= minVExtent) vCands.push({ x, seg });
  }
  if (vCands.length < 2) return null;
  const yTop = Math.max(0, Math.min(...vCands.map((c) => c.seg.start)) - 4);
  const yBottom = Math.min(height - 1, Math.max(...vCands.map((c) => c.seg.end)) + 4);
  const xLeft = Math.max(0, vCands[0].x - 4);
  const xRight = Math.min(width - 1, vCands[vCands.length - 1].x + 4);
  const tableH = yBottom - yTop;
  const tableW = xRight - xLeft;
  if (tableH < 20 || tableW < 20) return null;

  // 2. horizontal rules inside the bounds
  const minHExtent = Math.floor(tableW * 0.55);
  const hHits: number[] = [];
  for (let y = yTop; y <= yBottom; y++) {
    const seg = bestSegment((i) => darkNearY(y, xLeft + i), tableW + 1, 12);
    if (seg && seg.end - seg.start >= minHExtent && seg.dark / (seg.end - seg.start + 1) >= 0.5) {
      hHits.push(y);
    }
  }
  const ys = clusterPositions(hHits);
  if (ys.length < 2) return null;

  // 3. vertical rules spanning most of the table, solid (not dashed guides)
  const minVSpan = Math.floor(tableH * 0.6);
  const xHits = vCands
    .filter(({ seg }) =>
      seg.end - seg.start >= minVSpan &&
      seg.dark / (seg.end - seg.start + 1) >= 0.6,
    )
    .map(({ x }) => x);
  const xs = clusterPositions(xHits);
  if (xs.length < 2) return null;
  return { xs, ys };
}

/** Fraction of dark pixels inside a rect of a binarized page. */
export function regionInkRatio(page: BinarizedPage, rect: Rect): number {
  const { dark, width, height } = page;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  let count = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (dark[y * width + x]) count++;
    }
  }
  return total === 0 ? 0 : count / total;
}

/** Cell rect between grid lines (col i, row band j), inset from the rules. */
export function gridCellRect(grid: TableGrid, col: number, row: number, inset = 4): Rect {
  const x = grid.xs[col] + inset;
  const y = grid.ys[row] + inset;
  return {
    x,
    y,
    w: grid.xs[col + 1] - grid.xs[col] - inset * 2,
    h: grid.ys[row + 1] - grid.ys[row] - inset * 2,
  };
}

/** Decoded page raster, reusable across many cell crops. */
export interface PageImage {
  img: import("@napi-rs/canvas").Image;
  width: number;
  height: number;
}

export async function loadPageImage(png: Buffer): Promise<PageImage> {
  const { loadImage } = await importCanvas();
  const img = await loadImage(png);
  return { img, width: img.width, height: img.height };
}

/**
 * Crop a cell out of the page and upscale it — tesseract reads small
 * scanned glyphs far better at 2-3×. An optional threshold binarizes the
 * crop (for digit cells with dashed guides / tinted paper).
 */
async function cropUpscaled(
  page: PageImage,
  rect: Rect,
  scaleUp: number,
  threshold?: number,
): Promise<Buffer> {
  const { createCanvas } = await importCanvas();
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.max(1, Math.min(Math.floor(rect.w), page.width - x));
  const h = Math.max(1, Math.min(Math.floor(rect.h), page.height - y));
  const canvas = createCanvas(w * scaleUp, h * scaleUp);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w * scaleUp, h * scaleUp);
  ctx.drawImage(page.img, x, y, w, h, 0, 0, w * scaleUp, h * scaleUp);
  if (threshold !== undefined) {
    const image = ctx.getImageData(0, 0, w * scaleUp, h * scaleUp);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = lum < threshold ? 0 : 255;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas.toBuffer("image/png");
}

/** OCR a cell (or strip) as free text from the original render. */
export async function ocrCellText(
  worker: OcrWorker,
  page: PageImage,
  rect: Rect,
  opts: { psm?: string; scaleUp?: number; threshold?: number } = {},
): Promise<string> {
  return (await ocrCellTextWithConfidence(worker, page, rect, opts)).text;
}

/**
 * Like ocrCellText but also reports tesseract's mean confidence, so a
 * caller trying several crop/scale/threshold variants of the same cell
 * can pick between candidate readings deterministically.
 */
export async function ocrCellTextWithConfidence(
  worker: OcrWorker,
  page: PageImage,
  rect: Rect,
  opts: { psm?: string; scaleUp?: number; threshold?: number } = {},
): Promise<{ text: string; confidence: number }> {
  const crop = await cropUpscaled(page, rect, opts.scaleUp ?? 2, opts.threshold);
  await worker.setParameters({
    tessedit_pageseg_mode: (opts.psm ?? "6") as Tesseract.PSM,
  });
  const { data } = await worker.recognize(crop);
  return { text: data.text ?? "", confidence: data.confidence ?? 0 };
}

/** OCR a cell that contains only a number; returns the integer or null. */
export async function ocrCellAmount(
  worker: OcrWorker,
  page: PageImage,
  rect: Rect,
  opts: { scaleUp?: number; threshold?: number } = {},
): Promise<number | null> {
  const crop = await cropUpscaled(page, rect, opts.scaleUp ?? 3, opts.threshold ?? 150);
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789,",
    tessedit_pageseg_mode: "7" as Tesseract.PSM,
  });
  const { data } = await worker.recognize(crop);
  const compact = (data.text ?? "").replace(/\s+/g, "");
  if (!/^\d[\d,]*$/.test(compact)) return null;
  const n = Number(compact.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

async function recognizeRect(
  worker: OcrWorker,
  png: Buffer,
  rect: Rect,
  params: Record<string, string>,
): Promise<string> {
  await worker.setParameters(params);
  const { data } = await worker.recognize(png, {
    rectangle: {
      left: Math.max(0, Math.floor(rect.x)),
      top: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.floor(rect.w)),
      height: Math.max(1, Math.floor(rect.h)),
    },
  });
  return data.text ?? "";
}

/** OCR a cell as free text (Japanese + Latin). */
export async function ocrRegionText(worker: OcrWorker, png: Buffer, rect: Rect): Promise<string> {
  return recognizeRect(worker, png, rect, {
    tessedit_pageseg_mode: "6",
  });
}

/** OCR a cell that contains only a number; returns the integer or null. */
export async function ocrRegionAmount(worker: OcrWorker, png: Buffer, rect: Rect): Promise<number | null> {
  const text = await recognizeRect(worker, png, rect, {
    tessedit_char_whitelist: "0123456789,",
    tessedit_pageseg_mode: "7",
  });
  const compact = text.replace(/\s+/g, "");
  if (!/^\d[\d,]*$/.test(compact)) return null;
  const n = Number(compact.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** OCR one PNG and return visual text lines (top-to-bottom) with bboxes. */
export async function ocrPngToLines(
  worker: OcrWorker,
  png: Buffer,
  opts: { psm?: string } = {},
): Promise<OcrLine[]> {
  if (opts.psm) {
    await worker.setParameters({
      tessedit_pageseg_mode: opts.psm as Tesseract.PSM,
    });
  }
  const { data } = await worker.recognize(png, {}, { blocks: true, text: true });
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.replace(/\s+$/, "");
        if (!text.trim()) continue;
        lines.push({
          text,
          x0: line.bbox.x0,
          y0: line.bbox.y0,
          x1: line.bbox.x1,
          y1: line.bbox.y1,
          words: (line.words ?? [])
            .map((word) => ({
              text: word.text,
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
            }))
            .filter((word) => word.text.trim()),
        });
      }
    }
  }
  lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return lines;
}
