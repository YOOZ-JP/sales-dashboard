import { createClient } from "@/features/settlement/lib/supabase/client";
import { SETTLEMENT_HEARTBEAT_HEADER } from "./heartbeat-stream";

type PrepareResponse = {
  upload_id: string;
  path: string;
  token: string;
};

type UploadResponse = {
  results: Array<Record<string, unknown>>;
};

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

// Heartbeat-streamed process responses always arrive with status 200, so
// failures surface only in the body: a top-level `error`, or a payload
// without a `results` array (e.g. a truncated/garbled stream).
export function assertUploadResponsePayload(payload: unknown): UploadResponse {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    throw new Error(String((payload as { error: unknown }).error));
  }
  const results =
    typeof payload === "object" && payload !== null
      ? (payload as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(results)) {
    throw new Error("upload response missing results");
  }
  return { results: results as Array<Record<string, unknown>> };
}

// Parent directory of a selection-relative path (slash or backslash
// separated), without the filename. File-only selections have no directory
// part and yield undefined. Parsers key off the parent folder basename
// (e.g. ichijinsha deposit dates), so each file must carry its own.
export function parentFolderHint(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments.slice(0, -1).join("/");
}

function cleanFolderHint(folderHint: string | undefined): string | undefined {
  if (!folderHint) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = folderHint.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  return cleaned || undefined;
}

export function buildCleanupPreparedUploadRequest(uploadId: string): RequestInit {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId }),
  };
}

async function cleanupPreparedUpload(uploadId: string): Promise<void> {
  await fetch("/api/settlement/uploads/prepare", buildCleanupPreparedUploadRequest(uploadId)).catch(() => undefined);
}

export async function uploadSettlementFileDirect(
  file: File,
  activeMonth: string,
  folderHint?: string,
): Promise<UploadResponse> {
  const prepared = await fetch("/api/settlement/uploads/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      size_bytes: file.size,
      content_type: file.type || null,
      active_month: activeMonth,
    }),
  }).then((response) => readJsonOrThrow<PrepareResponse>(response));

  const supabase = createClient();
  const { error: uploadError } = await supabase.storage
    .from("upload-debug")
    .uploadToSignedUrl(prepared.path, prepared.token, file, {
      contentType: file.type || "application/octet-stream",
    });
  if (uploadError) {
    await cleanupPreparedUpload(prepared.upload_id);
    throw new Error(uploadError.message);
  }

  return fetch("/api/settlement/upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Opt in to heartbeat streaming so long OCR parses keep emitting bytes
      // instead of hitting the ~5-6 minute idle-connection reset.
      [SETTLEMENT_HEARTBEAT_HEADER]: "1",
    },
    body: JSON.stringify({
      upload_id: prepared.upload_id,
      folder_hint: cleanFolderHint(folderHint),
    }),
  })
    .then((response) => readJsonOrThrow<unknown>(response))
    .then((payload) => assertUploadResponsePayload(payload));
}
