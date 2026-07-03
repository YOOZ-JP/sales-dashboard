/**
 * Decides which settlement month an uploaded file's rows belong to.
 *
 * Manual mode (activeMonth given): the operator's explicit choice wins.
 * Auto mode (activeMonth null): the month parsed from the file content
 * wins. When the content has no month, fallbackMonth — the single
 * unambiguous month hint the client derived from the selected upload
 * batch's folder/file names — is inherited with an informational note.
 * Never the current date. A file that produced records but no resolvable
 * month is a hard per-file error, so its rows can't silently land in the
 * wrong month's settlement.
 */
export type MonthResolution =
  | { ok: true; month: string | null; note?: string }
  | { ok: false; error: string };

// Parsers return ISO YYYY-MM-DD (normally YYYY-MM-01); tolerate any day
// component and normalize to the first of the month.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveSettlementMonth(opts: {
  activeMonth: string | null;
  parsedSettlementMonth: string | null;
  hasRecords: boolean;
  fallbackMonth?: string | null;
}): MonthResolution {
  if (opts.activeMonth) return { ok: true, month: opts.activeMonth };

  const raw = opts.parsedSettlementMonth ?? "";
  if (ISO_DATE.test(raw)) return { ok: true, month: `${raw.slice(0, 7)}-01` };

  // Informational files (payment notices, cross-check details) produce no
  // records, so they don't need a month bucket.
  if (!opts.hasRecords) return { ok: true, month: null };

  const fallback = opts.fallbackMonth ?? "";
  if (ISO_DATE.test(fallback)) {
    return {
      ok: true,
      month: `${fallback.slice(0, 7)}-01`,
      note: "정산월을 파일 내용에서 찾지 못해 함께 업로드한 폴더/파일명의 정산월을 적용했습니다. / ファイル内容から精算月を特定できなかったため、同時にアップロードしたフォルダ・ファイル名の精算月を適用しました。",
    };
  }

  return {
    ok: false,
    error:
      "정산월을 파일 내용에서 찾지 못했습니다. 정산월을 '직접 입력'으로 바꿔 다시 업로드해 주세요. / ファイル内容から精算月を特定できませんでした。精算月を「手動入力」に切り替えて再アップロードしてください。",
  };
}
