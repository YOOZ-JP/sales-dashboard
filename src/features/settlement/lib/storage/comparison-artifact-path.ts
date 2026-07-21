/**
 * Pure storage-key builder for comparison artifacts, kept import-safe for
 * test scripts (no Supabase/Next imports here).
 *
 * Storage keys must stay ASCII-only: Supabase rejects Japanese/Korean/spaces/
 * fullwidth parentheses as "Invalid key". The original filename is persisted
 * on the comparison run row (answer_filename / candidate_filename), never in
 * the object key.
 */
import { randomUUID } from "node:crypto";

import { asciiExtension } from "./direct-upload";

export type ComparisonArtifactKind = "answer-key" | "candidate";

const ARTIFACT_PREFIX: Record<ComparisonArtifactKind, string> = {
  "answer-key": "comparisons/answer-keys",
  candidate: "comparisons/candidates",
};

/**
 * comparisons/<kind-prefix>/YYYY-MM/<uuid><ext> — <ext> is the filename's
 * trailing ASCII-alphanumeric extension lowercased, or omitted when the
 * extension is missing, non-ASCII, or longer than 10 characters.
 */
export function buildComparisonArtifactPath(
  kind: ComparisonArtifactKind,
  filename: string,
  month?: string | null,
  uuid: () => string = randomUUID,
): string {
  const folder = month ? month.slice(0, 7) : "undated";
  return `${ARTIFACT_PREFIX[kind]}/${folder}/${uuid()}${asciiExtension(filename).toLowerCase()}`;
}
