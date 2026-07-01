/**
 * ai-pdf.ts — Shared AI-Vision PDF extraction helper.
 *
 * Flow per PDF:
 *   1. unpdf renders each page to PNG (Uint8Array). Works for both
 *      text-layer PDFs and image-only scans.
 *   2. A SHA-256 of the file bytes is used as a cache key. If we've
 *      already processed the same file, the stored JSON is returned
 *      and no AI call is made.
 *   3. generateObject() is called with Claude Sonnet 4.6 via the
 *      Vercel AI Gateway (no API key required when running inside a
 *      Vercel Function — OIDC auth is automatic). The model receives
 *      all page images plus a platform-specific system prompt and is
 *      constrained by a Zod schema, so the response is always valid
 *      JSON matching the parser's expectations.
 *   4. The JSON is cached in Supabase Storage under
 *      `upload-debug/ai-cache/<sha>.json` so re-uploads are free.
 *
 * A single helper covers shueisha / ichijinsha / sb-creative / any
 * future PDF platform — callers supply the Zod schema + prompt.
 */
import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { createServiceClient } from "@/features/settlement/lib/supabase/server";

// Claude Sonnet 4.6 ingests PDFs natively (no image conversion step
// required — it reads text layers AND rasterizes image-only pages
// internally). That's exactly what we need on Vercel, where we have no
// canvas / pdfium to render pages ourselves.

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readCache<T>(sha: string): Promise<T | null> {
  try {
    const sb = createServiceClient();
    const { data } = await sb.storage
      .from("upload-debug")
      .download(`ai-cache/${sha}.json`);
    if (!data) return null;
    const text = await data.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeCache(sha: string, payload: unknown): Promise<void> {
  try {
    const sb = createServiceClient();
    await sb.storage
      .from("upload-debug")
      .upload(`ai-cache/${sha}.json`, Buffer.from(JSON.stringify(payload)), {
        contentType: "application/json",
        upsert: true,
      });
  } catch {
    // non-fatal
  }
}

export interface AiPdfOptions<T> {
  /** File bytes */
  buffer: Buffer;
  /** Platform identifier — used only in logs / cache key */
  platform: string;
  /** Zod schema describing the expected structured output */
  schema: z.ZodType<T>;
  /** System/user prompt explaining what to extract */
  prompt: string;
  /** Override model. Defaults to Claude Sonnet 4.6 via the AI Gateway. */
  model?: string;
}

/**
 * Extract structured data from a PDF using AI vision.
 * Returns the validated Zod-parsed object. Throws on extraction
 * failure so the caller can decide how to surface the error.
 */
export async function extractPdfWithAI<T>(opts: AiPdfOptions<T>): Promise<T> {
  const { buffer, schema, prompt } = opts;
  const modelId = opts.model ?? "anthropic/claude-sonnet-4-6";

  const sha = sha256(buffer);
  const cached = await readCache<T>(sha);
  if (cached) {
    try {
      return schema.parse(cached);
    } catch {
      // cache held an older shape — fall through and re-run
    }
  }

  // Hand the raw PDF buffer to the model as a `file` part. Claude reads
  // both text-layer PDFs and scanned image-only PDFs this way, so we
  // don't need a canvas / rasterizer on the Vercel side.
  const { object } = await generateObject({
    model: modelId,
    schema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "file",
            data: new Uint8Array(buffer),
            mediaType: "application/pdf",
          },
        ],
      },
    ],
  });

  await writeCache(sha, object);
  return object;
}
