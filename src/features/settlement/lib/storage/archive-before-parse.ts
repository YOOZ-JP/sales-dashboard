/**
 * Sequencing contract for /api/settlement/upload:
 *
 *   archive raw bytes → record real storage_path (+sha256) on the audit row → parse
 *
 * The raw INPUT file must be durable in Storage before any parser touches
 * it. If archiving fails the file is never parsed; if parsing fails the
 * archived object remains and the result still carries its path. Extracted
 * as a pure coordinator (dependencies injected) so the ordering is testable
 * without Supabase or a real parser.
 */
import { createHash } from "node:crypto";

/** Hex SHA-256 of the raw file bytes. Never returned to the client. */
export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export interface ArchiveBeforeParseDeps<P> {
  /** Upload the raw bytes to durable storage; returns the storage path. */
  archive(): Promise<{ path: string }>;
  /** Persist the real storage path + hash on the pre-created audit row. */
  recordArchived(path: string, sha256: string): Promise<void>;
  /** Parse the file. Only called after the two steps above succeeded. */
  parse(): Promise<P>;
}

export type ArchiveBeforeParseResult<P> =
  | { ok: true; archivePath: string; sha256: string; parsed: P }
  | {
      ok: false;
      stage: "archive" | "record" | "parse";
      /** Set when the file did reach storage before the failure. */
      archivePath: string | null;
      sha256: string;
      error: string;
    };

export async function archiveBeforeParse<P>(
  buffer: Buffer,
  deps: ArchiveBeforeParseDeps<P>,
): Promise<ArchiveBeforeParseResult<P>> {
  const sha256 = sha256Hex(buffer);

  let archivePath: string;
  try {
    archivePath = (await deps.archive()).path;
  } catch (e) {
    return { ok: false, stage: "archive", archivePath: null, sha256, error: (e as Error).message || "archive write failed" };
  }

  try {
    await deps.recordArchived(archivePath, sha256);
  } catch (e) {
    // The bytes are safe in storage, but the audit row would keep lying about
    // its storage_path — stop before parsing rather than continue on a row we
    // could not stamp.
    return { ok: false, stage: "record", archivePath, sha256, error: (e as Error).message || "audit row update failed" };
  }

  try {
    return { ok: true, archivePath, sha256, parsed: await deps.parse() };
  } catch (e) {
    return { ok: false, stage: "parse", archivePath, sha256, error: (e as Error).message || "parse failed" };
  }
}
