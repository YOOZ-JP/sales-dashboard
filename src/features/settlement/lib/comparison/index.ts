export { identityKey, normalizeIdentityPart, type RowIdentity } from "./identity";
export {
  COMPARE_FIELDS,
  FIRST_DATA_ROW,
  readInputSheet,
  semanticScalar,
  type CellSnapshot,
  type CellState,
  type CompareField,
  type InputRowSnapshot,
  type InputSheetSnapshot,
  type SemanticValue,
} from "./workbook";
export {
  compareInputWorkbooks,
  DEFAULT_MAX_DIFFS,
  type CompareInputWorkbooksOptions,
  type ComparisonDiffCategory,
  type ComparisonDiffFinding,
  type ComparisonResult,
  type ComparisonSummary,
} from "./compare";
export {
  DIFF_REVIEW_STATUSES,
  REVIEW_NOTE_MAX_LENGTH,
  validateDiffReviewPatch,
  type DiffReviewPatch,
  type DiffReviewValidation,
} from "./review";
