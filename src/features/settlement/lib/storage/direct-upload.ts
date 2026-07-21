import { randomUUID } from "node:crypto";

import { sha256Hex } from "./archive-before-parse";

export const DIRECT_UPLOAD_BUCKET = "upload-debug";
export const DIRECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

const MONTH_RE = /^\d{4}-\d{2}-01$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DirectUploadStatus =
  | "uploaded"
  | "parsing"
  | "parsed"
  | "aggregated"
  | "failed"
  | "archived";

export interface PrepareUploadPayload {
  filename: string;
  size_bytes: number;
  content_type: string | null;
  active_month: string;
}

export interface DirectUploadRow {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number | null;
  content_type: string | null;
  settlement_month: string | null;
  status: DirectUploadStatus;
}

export type PrepareValidation =
  | { ok: true; value: PrepareUploadPayload }
  | { ok: false; error: string };

export type FolderHintValidation =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

export type CleanupUploadPayloadValidation =
  | { ok: true; uploadId: string }
  | { ok: false; error: string };

export type PreparedPath = {
  path: string;
  safeFilename: string;
};

export type DirectParsePreparation =
  | {
      ok: true;
      row: DirectUploadRow;
      buffer: Buffer;
      sha256: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      skipped?: true;
      row?: DirectUploadRow;
    };

export interface DirectParseDeps {
  getUpload(uploadId: string): Promise<DirectUploadRow | null>;
  download(path: string): Promise<Buffer>;
  markParsing(uploadId: string, sha256: string): Promise<"updated" | "not_uploaded">;
  markFailed(uploadId: string, message: string): Promise<void>;
}

export function validatePrepareUploadPayload(input: unknown): PrepareValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid JSON body" };
  }
  const body = input as Record<string, unknown>;
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const sizeBytes = body.size_bytes;
  const contentType = typeof body.content_type === "string" ? body.content_type.trim() : null;
  const activeMonth = typeof body.active_month === "string" ? body.active_month.trim() : "";

  const safe = sanitizeFilename(filename);
  if (!safe || safe === "." || safe === ".." || /[/\\]/.test(filename)) {
    return { ok: false, error: "invalid filename" };
  }
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes)) {
    return { ok: false, error: "invalid size_bytes" };
  }
  if (sizeBytes <= 0 || sizeBytes > DIRECT_UPLOAD_MAX_BYTES) {
    return { ok: false, error: "size_bytes out of range" };
  }
  if (!MONTH_RE.test(activeMonth)) {
    return { ok: false, error: "invalid active_month" };
  }
  if (contentType !== null && contentType.length > 200) {
    return { ok: false, error: "invalid content_type" };
  }

  return {
    ok: true,
    value: {
      filename: safe,
      size_bytes: sizeBytes,
      content_type: contentType || null,
      active_month: activeMonth,
    },
  };
}

export function validateFolderHint(input: unknown): FolderHintValidation {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: undefined };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "folder_hint must be a string" };
  }
  const value = input.trim();
  if (value.length > 200) {
    return { ok: false, error: "folder_hint too long" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, error: "folder_hint contains control characters" };
  }
  return { ok: true, value: value || undefined };
}

export function parseProcessUploadPayload(input: unknown): {
  uploadId: unknown;
  folderHint: FolderHintValidation;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { uploadId: null, folderHint: { ok: true, value: undefined } };
  }
  const body = input as Record<string, unknown>;
  return {
    uploadId: body.upload_id,
    folderHint: validateFolderHint(body.folder_hint),
  };
}

export function validateCleanupUploadPayload(input: unknown): CleanupUploadPayloadValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid JSON body" };
  }
  const uploadId = (input as Record<string, unknown>).upload_id;
  if (!isValidUploadId(uploadId)) {
    return { ok: false, error: "invalid upload_id" };
  }
  return { ok: true, uploadId };
}

export function buildDirectUploadPath(
  filename: string,
  activeMonth: string,
  uuid: () => string = randomUUID,
): PreparedPath {
  const safeFilename = sanitizeFilename(filename);
  return {
    safeFilename,
    // Storage keys must stay ASCII-only: Supabase rejects Japanese/spaces/
    // parentheses as "Invalid key". The original name lives in safeFilename
    // (persisted on the DB row), never in the object key.
    path: `uploads/${activeMonth.slice(0, 7)}/${uuid()}${asciiExtension(safeFilename)}`,
  };
}

function asciiExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? `.${match[1]}` : "";
}

export function isValidUploadId(uploadId: unknown): uploadId is string {
  return typeof uploadId === "string" && UUID_RE.test(uploadId);
}

export function isTerminalUploadStatus(status: DirectUploadStatus): boolean {
  return status === "parsed" || status === "aggregated" || status === "archived";
}

function isSafeRaceSkipStatus(status: DirectUploadStatus): boolean {
  return status === "parsing" || status === "parsed" || status === "aggregated" || status === "failed" || status === "archived";
}

export function statusAfterParseMetadata(
  parsedRows: number,
  zeroRowFailure: boolean,
): DirectUploadStatus {
  if (parsedRows > 0) return "parsing";
  return zeroRowFailure ? "failed" : "parsed";
}

export function validateDirectUploadRow(row: DirectUploadRow): string | null {
  if (!isValidUploadId(row.id)) return "invalid upload row id";
  if (!row.storage_path.startsWith("uploads/")) return "invalid storage path";
  if (row.storage_path.includes("..") || row.storage_path.includes("\\")) {
    return "invalid storage path";
  }
  if (row.size_bytes === null || row.size_bytes <= 0 || row.size_bytes > DIRECT_UPLOAD_MAX_BYTES) {
    return "invalid stored size";
  }
  if (!row.filename.trim()) return "invalid stored filename";
  return null;
}

export async function prepareDirectUploadForParse(
  uploadId: string,
  deps: DirectParseDeps,
): Promise<DirectParsePreparation> {
  if (!isValidUploadId(uploadId)) {
    return { ok: false, status: 400, error: "invalid upload_id" };
  }

  const row = await deps.getUpload(uploadId);
  if (!row) {
    return { ok: false, status: 404, error: "upload not found" };
  }
  const rowError = validateDirectUploadRow(row);
  if (rowError) {
    await deps.markFailed(row.id, rowError);
    return { ok: false, status: 400, error: rowError, row };
  }
  if (isTerminalUploadStatus(row.status)) {
    return { ok: false, status: 200, error: "upload already processed", skipped: true, row };
  }
  if (row.status !== "uploaded") {
    return {
      ok: false,
      status: 409,
      error: row.status === "failed" ? "upload failed; prepare a new upload" : "upload is not ready",
      row,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await deps.download(row.storage_path);
  } catch (e) {
    const message = (e as Error).message || "download failed";
    await deps.markFailed(row.id, message);
    return { ok: false, status: 500, error: message, row };
  }

  if (buffer.byteLength !== row.size_bytes) {
    const message = `size mismatch: expected ${row.size_bytes}, got ${buffer.byteLength}`;
    await deps.markFailed(row.id, message);
    return { ok: false, status: 400, error: message, row };
  }

  const sha256 = sha256Hex(buffer);
  const updated = await deps.markParsing(row.id, sha256);
  if (updated !== "updated") {
    const latest = await deps.getUpload(uploadId);
    if (latest && isSafeRaceSkipStatus(latest.status)) {
      return {
        ok: false,
        status: 200,
        error: latest.status === "parsing" ? "upload already parsing" : "upload already processed",
        skipped: true,
        row: latest,
      };
    }
    return { ok: false, status: 409, error: "upload status changed before parsing", row };
  }

  return { ok: true, row, buffer, sha256 };
}

function sanitizeFilename(name: string): string {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
