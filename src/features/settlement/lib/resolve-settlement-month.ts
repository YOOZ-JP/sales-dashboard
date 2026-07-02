/**
 * Decides which settlement month an uploaded file's rows belong to.
 *
 * Manual mode (activeMonth given): the operator's explicit choice wins.
 * Auto mode (activeMonth null): only the month parsed from the file
 * content counts — never the current date. A file that produced records
 * but no detectable month is a hard per-file error, so its rows can't
 * silently land in the wrong month's settlement.
 */
export type MonthResolution =
  | { ok: true; month: string | null }
  | { ok: false; error: string };

// Parsers return ISO YYYY-MM-DD (normally YYYY-MM-01); tolerate any day
// component and normalize to the first of the month.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveSettlementMonth(opts: {
  activeMonth: string | null;
  parsedSettlementMonth: string | null;
  hasRecords: boolean;
}): MonthResolution {
  if (opts.activeMonth) return { ok: true, month: opts.activeMonth };

  const raw = opts.parsedSettlementMonth ?? "";
  if (ISO_DATE.test(raw)) return { ok: true, month: `${raw.slice(0, 7)}-01` };

  // Informational files (payment notices, cross-check details) produce no
  // records, so they don't need a month bucket.
  if (!opts.hasRecords) return { ok: true, month: null };

  return {
    ok: false,
    error:
      "정산월을 파일 내용에서 찾지 못했습니다. 정산월을 '직접 입력'으로 바꿔 다시 업로드해 주세요. / ファイル内容から精算月を特定できませんでした。精算月を「手動入力」に切り替えて再アップロードしてください。",
  };
}
