import type { Json } from "../supabase/types";

export const SOURCE_MANIFEST_UPLOAD_LIMIT = 500;
export const SOURCE_MANIFEST_OBSERVE_LIMIT = SOURCE_MANIFEST_UPLOAD_LIMIT + 1;

export type SourceUploadManifestRow = {
  id: string;
  filename: string | null;
  platform_code: string | null;
  status: string | null;
  parsed_rows: number | null;
  sha256: string | null;
};

export type SourceUploadManifest = {
  sourceUploadIds: string[];
  sourceManifest: Json;
};

export function buildSourceUploadManifest(
  uploads: SourceUploadManifestRow[],
): SourceUploadManifest {
  const persisted = uploads.slice(0, SOURCE_MANIFEST_UPLOAD_LIMIT);
  const uploadsTruncated = uploads.length > SOURCE_MANIFEST_UPLOAD_LIMIT;
  return {
    sourceUploadIds: persisted.map((upload) => upload.id),
    sourceManifest: {
      uploads: persisted as unknown as Json,
      uploads_truncated: uploadsTruncated,
      observed_count_at_least: uploadsTruncated ? SOURCE_MANIFEST_OBSERVE_LIMIT : persisted.length,
    },
  };
}
