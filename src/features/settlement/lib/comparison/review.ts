/**
 * Validation for the diff-review PATCH body. Pure so it is testable without
 * the route: the operator can mark either side correct, flag for deeper
 * review, or resolve — and attach a bounded note.
 */
import type { ComparisonDiffReviewStatus } from "../supabase/types";

export const DIFF_REVIEW_STATUSES: readonly ComparisonDiffReviewStatus[] = [
  "pending",
  "candidate_correct",
  "golden_correct",
  "needs_review",
  "resolved",
];

export const REVIEW_NOTE_MAX_LENGTH = 2000;

export interface DiffReviewPatch {
  review_status?: ComparisonDiffReviewStatus;
  review_note?: string | null;
}

export type DiffReviewValidation =
  | { ok: true; patch: DiffReviewPatch }
  | { ok: false; error: string };

export function validateDiffReviewPatch(body: unknown): DiffReviewValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { review_status, note, review_note } = body as Record<string, unknown>;
  const patch: DiffReviewPatch = {};

  if (review_status !== undefined) {
    if (
      typeof review_status !== "string" ||
      !DIFF_REVIEW_STATUSES.includes(review_status as ComparisonDiffReviewStatus)
    ) {
      return {
        ok: false,
        error: `review_status must be one of: ${DIFF_REVIEW_STATUSES.join(", ")}`,
      };
    }
    patch.review_status = review_status as ComparisonDiffReviewStatus;
  }

  // Accept both `note` and `review_note`; `review_note` wins when both exist.
  const rawNote = review_note !== undefined ? review_note : note;
  if (rawNote !== undefined) {
    if (rawNote === null) {
      patch.review_note = null;
    } else if (typeof rawNote === "string") {
      if (rawNote.length > REVIEW_NOTE_MAX_LENGTH) {
        return { ok: false, error: `note must be at most ${REVIEW_NOTE_MAX_LENGTH} characters` };
      }
      patch.review_note = rawNote;
    } else {
      return { ok: false, error: "note must be a string or null" };
    }
  }

  if (patch.review_status === undefined && patch.review_note === undefined) {
    return { ok: false, error: "provide review_status and/or note" };
  }
  return { ok: true, patch };
}
