/**
 * Raw-upload archive on Supabase Storage.
 *
 * Every file POSTed to /api/upload is preserved in the `upload-debug`
 * bucket under uploads/YYYY-MM/<ts>_<sanitized-name>. This lives in the
 * same cloud as the DB, so the feature works from any environment that
 * has service-role credentials — Vercel, localhost, a peer's laptop.
 *
 * When investigating a parse error, issue a signed URL via
 * `getSignedArchiveUrl(path)` (1-hour expiry by default) and open the
 * original file in the browser.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/features/settlement/lib/supabase/server";
import {
  buildComparisonArtifactPath,
  type ComparisonArtifactKind,
} from "./comparison-artifact-path";

export type { ComparisonArtifactKind } from "./comparison-artifact-path";

const BUCKET = "upload-debug";

export interface ArchiveWriteResult {
  /** bucket-relative path — store this in raw_uploads.storage_path */
  path: string;
  bucket: typeof BUCKET;
  size: number;
}

function safeName(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Upload a raw buffer into the archive bucket.
 *
 * @param filename Original filename — used verbatim in the stored path (with a timestamp prefix).
 * @param buffer   File bytes.
 * @param settlementMonth 'YYYY-MM-DD' | 'YYYY-MM' | null — decides the month bucket.
 * @param client   Pass an already-created Supabase client to reuse its connection pool; otherwise one is created lazily.
 */
export async function writeToArchive(
  filename: string,
  buffer: Buffer,
  settlementMonth?: string | null,
  client?: SupabaseClient,
): Promise<ArchiveWriteResult> {
  const supabase = client ?? createServiceClient();
  const bucket = settlementMonth ? settlementMonth.slice(0, 7) : "undated";
  const ts = Date.now();
  const path = `uploads/${bucket}/${ts}_${safeName(filename)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`archive upload failed: ${error.message}`);
  return { path, bucket: BUCKET, size: buffer.byteLength };
}

/**
 * Write an immutable comparison artifact into the private archive bucket.
 * Artifacts live under dedicated prefixes, separate from the raw-upload
 * archive:
 *   comparisons/answer-keys/YYYY-MM/<uuid><ext>  — human answer-key workbooks
 *   comparisons/candidates/YYYY-MM/<uuid><ext>   — generated candidate workbooks
 * Keys are UUID-based ASCII (see buildComparisonArtifactPath); the original
 * filename is stored on the comparison run row, not in the key.
 *
 * Same durability contract as `writeToArchive`: private bucket only,
 * `upsert: false` so an existing object is never overwritten, unique
 * path so retries create a new object instead of clobbering evidence.
 *
 * @param kind  Which dedicated prefix the artifact belongs under.
 * @param month 'YYYY-MM-DD' | 'YYYY-MM' | null — decides the month folder.
 */
export async function writeComparisonArtifact(
  kind: ComparisonArtifactKind,
  filename: string,
  buffer: Buffer,
  month?: string | null,
  client?: SupabaseClient,
): Promise<ArchiveWriteResult> {
  const supabase = client ?? createServiceClient();
  const path = buildComparisonArtifactPath(kind, filename, month);
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`artifact upload failed: ${error.message}`);
  return { path, bucket: BUCKET, size: buffer.byteLength };
}

/**
 * Issue a signed URL for an archived file. Default TTL is 1 hour.
 * Returns null if the object is missing so callers can show a clean UI.
 */
export async function getSignedArchiveUrl(
  path: string,
  expiresInSeconds = 3600,
  client?: SupabaseClient,
): Promise<string | null> {
  const supabase = client ?? createServiceClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

/** List archived files for a month bucket (or all of them when `month` is null). */
export async function listArchive(
  month: string | null = null,
  client?: SupabaseClient,
) {
  const supabase = client ?? createServiceClient();
  const prefix = month ? `uploads/${month.slice(0, 7)}` : "uploads";
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
    limit: 1000,
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) return [];
  return data;
}
