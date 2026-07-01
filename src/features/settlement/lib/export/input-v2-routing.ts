const PUBLICATION_CLIENT_PATTERNS = [
  /kadokawa/i,
  /角川/i,
  /ichijinsha/i,
  /一迅社/i,
  /shueisha/i,
  /集英社/i,
  /sb\s*creative/i,
  /sbcreative/i,
  /sbクリエイティブ/i,
  /ＳＢクリエイティブ/i,
];

export const INPUT_V2_PUBLICATION_SHEET = "input_出版";

export function monthNumber(month: string): number {
  if (!/^\d{6}$/.test(month)) {
    throw new Error(`Invalid month '${month}', expected YYYYMM`);
  }
  const n = Number(month.slice(4, 6));
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new Error(`Invalid month '${month}', month must be 01..12`);
  }
  return n;
}

export function inputV2ElectronicSheet(month: string): string {
  return `input_電子_${monthNumber(month)}月`;
}

export function isPublicationClient(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  return PUBLICATION_CLIENT_PATTERNS.some((pattern) => pattern.test(text));
}

function recordClient(record: Record<string, unknown>): unknown {
  return (
    record.clients ??
    record.client_display_name ??
    record.client_code ??
    record.platform_code ??
    record.channel ??
    record.channel_code
  );
}

export function targetSheetForRecord(record: Record<string, unknown>, month: string): string {
  return isPublicationClient(recordClient(record))
    ? INPUT_V2_PUBLICATION_SHEET
    : inputV2ElectronicSheet(month);
}

export interface InputV2SplitResult {
  electronic: Record<string, unknown>[];
  publication: Record<string, unknown>[];
  electronicSheet: string;
  publicationSheet: string;
}

export function splitInputV2Records(
  records: Record<string, unknown>[],
  month: string,
): InputV2SplitResult {
  const electronicSheet = inputV2ElectronicSheet(month);
  const publicationSheet = INPUT_V2_PUBLICATION_SHEET;
  const electronic: Record<string, unknown>[] = [];
  const publication: Record<string, unknown>[] = [];

  for (const record of records) {
    if (targetSheetForRecord(record, month) === publicationSheet) {
      publication.push(record);
    } else {
      electronic.push(record);
    }
  }

  return { electronic, publication, electronicSheet, publicationSheet };
}
