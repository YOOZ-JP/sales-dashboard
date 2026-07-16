import { createClient } from "@/features/settlement/lib/supabase/client";

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      upload_id: prepared.upload_id,
      folder_hint: cleanFolderHint(folderHint),
    }),
  }).then((response) => readJsonOrThrow<UploadResponse>(response));
}
