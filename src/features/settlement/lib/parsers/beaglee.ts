import type { ParseResult, RawRecord } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";

interface Agg {
  title: string;
  type: string;
  salesMonth: string;
  grossTaxExcl: number;
  royaltyTaxExcl: number;
  rates: Set<number>;
}

export async function parseBeaglee({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  if (/\.pdf$/i.test(filename) || !/\.xlsx$/i.test(filename)) {
    return { platform_code: "beaglee", sales_month: null, settlement_month: null, records: [], errors: [] };
  }

  const wb = readWorkbook(buffer);
  const groups = new Map<string, Agg>();

  for (const sheetName of wb.SheetNames) {
    const month = sheetMonth(sheetName);
    if (!month) continue;
    const matrix = sheetToMatrix(wb, sheetName);
    const headerIdx = matrix.findIndex((row) => row.some((cell) => String(cell ?? "").includes("コミック名称")));
    if (headerIdx < 0) continue;
    const header = matrix[headerIdx].map((cell) => String(cell ?? "").replace(/\s+/g, "").trim());
    const col = Object.fromEntries(header.map((name, i) => [name, i]));

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i];
      const title = str(row[col["コミック名称"]]);
      if (!title || title === "合計") continue;
      const type = resolveType(title);
      const key = `${month}|${type}|${title}`;
      let agg = groups.get(key);
      if (!agg) {
        agg = { title, type, salesMonth: month, grossTaxExcl: 0, royaltyTaxExcl: 0, rates: new Set() };
        groups.set(key, agg);
      }
      agg.grossTaxExcl += toNumber(row[col["課金額（税抜）"]]);
      agg.royaltyTaxExcl += toNumber(row[col["ロイヤリティ(税抜)"]]);
      const rate = parseRate(row[col["ロイヤリティ率"]]);
      if (rate) agg.rates.add(rate);
    }
  }

  const records: RawRecord[] = [];
  for (const agg of groups.values()) {
    const total = Math.round(agg.grossTaxExcl * 1.10);
    const beforeTaxIncome = Math.round(agg.royaltyTaxExcl * 1.10);
    const tax = beforeTaxIncome - Math.round(agg.royaltyTaxExcl);
    const rs = highest(agg.rates) ?? 0.3;
    records.push({
      row_index: records.length,
      data: {
        title_jp: agg.title,
        channel_title_jp: agg.title,
        sales_month: agg.salesMonth,
        client_code: "beaglee",
        channel_code: "beaglee",
        type: agg.type,
        total_amount_jpy: total,
        before_tax_jpy: total,
        after_tax_jpy: Math.round(agg.grossTaxExcl),
        before_tax_income_jpy: beforeTaxIncome,
        consumption_tax_jpy: tax,
        after_tax_income_jpy: Math.round(agg.royaltyTaxExcl),
        withholding_tax_jpy: 0,
        fee_jpy: 0,
        rs_rate: rs,
        rs_rate_hint: rs,
        rs_label: `${Math.round(rs * 100)}%`,
      },
    });
  }

  return {
    platform_code: "beaglee",
    sales_month: records[0]?.data.sales_month ? String(records[0].data.sales_month) : null,
    settlement_month: null,
    records,
    errors: [],
  };
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function sheetMonth(sheetName: string): string | null {
  const m = sheetName.match(/(20\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

function parseRate(v: unknown): number | null {
  const s = str(v);
  const m = s.match(/([\d.]+)\s*%/);
  if (m) return Number(m[1]) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
}

function highest(values: Set<number>): number | null {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function resolveType(title: string): string {
  if (title.includes("分冊") || title.includes("連載")) return "EP";
  if (title.includes("タテヨミ") || title.includes("待ちコミ")) return "WT";
  return "EB";
}
