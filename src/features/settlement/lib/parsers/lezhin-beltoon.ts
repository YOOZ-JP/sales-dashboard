import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";

type Platform = "beltoon" | "lezhin";

export async function parseLezhinBeltoon({
  filename,
  buffer,
  folderName,
}: {
  filename: string;
  buffer: Buffer;
  folderName?: string;
}): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename) || /^【請求書】/i.test(filename)) {
    return zero(platformFromName(filename, folderName));
  }

  const platform = platformFromName(filename, folderName);
  const wb = readWorkbook(buffer);
  const matrix = sheetToMatrix(wb, wb.SheetNames[0]);
  const headerIdx = matrix.findIndex((row) => row.some((cell) => String(cell ?? "").trim() === "タイトル"));
  if (headerIdx < 0) {
    return { ...zero(platform), errors: [`${platform}: could not find header row`] };
  }

  const header = matrix[headerIdx].map((cell) => String(cell ?? "").trim());
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  const records: RawRecord[] = [];

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    const title = str(row[col["タイトル"]]);
    if (!title) continue;
    const sales = toNumber(row[col["売上額(円)"]]);
    const pay = toNumber(row[col["支払(円)"]]);
    const rs = parseRate(row[col["料率"]]) ?? 0.5;
    records.push({
      row_index: records.length,
      data: {
        title_jp: title,
        channel_title_jp: title,
        sales_month: parseSalesMonth(row[col["精算月"]]),
        client_code: platform,
        channel_code: platform,
        type: resolveType(title),
        total_amount_jpy: sales,
        before_tax_jpy: sales,
        after_tax_jpy: sales,
        before_tax_income_jpy: pay,
        after_tax_income_jpy: pay,
        consumption_tax_jpy: 0,
        withholding_tax_jpy: 0,
        fee_jpy: 0,
        rs_rate: rs,
        rs_rate_hint: rs,
        rs_label: `${Math.round(rs * 100)}%`,
      },
    });
  }

  return {
    platform_code: platform,
    sales_month: firstRecordMonth(records) ?? quarterStart(filename, folderName),
    settlement_month: null,
    records,
    errors: [],
  };
}

function zero(platform: Platform): ParseResult {
  return { platform_code: platform, sales_month: null, settlement_month: null, records: [], errors: [] };
}

function platformFromName(filename: string, folderName?: string): Platform {
  return /beltoon/i.test(`${folderName ?? ""} ${filename}`) ? "beltoon" : "lezhin";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseRate(v: unknown): number | null {
  const s = str(v);
  const m = s.match(/([\d.]+)\s*%/);
  if (m) return Number(m[1]) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
}

function parseSalesMonth(v: unknown): string | null {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-01`;
  const s = str(v);
  const ymd = s.match(/(\d{4})[.\-/年]\s*(\d{1,2})/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-01`;
  const mon = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})$/i);
  if (mon) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    return `20${mon[2]}-${String(months.indexOf(mon[1].toLowerCase()) + 1).padStart(2, "0")}-01`;
  }
  return null;
}

function firstRecordMonth(records: RawRecord[]): string | null {
  for (const record of records) {
    const month = record.data.sales_month;
    if (month) return String(month);
  }
  return null;
}

function quarterStart(filename: string, folderName?: string): string | null {
  const m = `${folderName ?? ""} ${filename}`.match(/(20\d{2}).*?Q([1-4])/i);
  if (!m) return null;
  return `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}-01`;
}

function resolveType(title: string): string {
  if (title.includes("分冊") || title.includes("連載")) return "EP";
  if (title.includes("完全版") || title.includes("全年齢版")) return "WT";
  return "WT";
}
