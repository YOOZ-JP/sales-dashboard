/**
 * U-NEXT parser — XLSX.
 *
 * File shape (hol0002587_株式会社RIVERSE御中_YYYYMM.xlsx):
 *   Sheet 0: "ヘッダー"        — metadata (権利者, 集計対象期間, 支払情報, …)
 *   Sheet 1: "タイトル一覧"    — per-title monthly summary (30 rows)
 *   Sheet 2: "コンテンツ明細"  — per-episode/content detail (thousands of rows)
 *
 * Ground-truth mapping
 * ---------------------
 * Each GT row is one U-NEXT 作品 = one row in "タイトル一覧" == sum of all
 * rows sharing the same タイトル名 in "コンテンツ明細".  Verified against the
 * 30 "U-NEXT" rows in data/ground-truth/202604.json.
 *
 * For each title:
 *   raw_sales  = Σ "売上"    over all detail rows       (= GT after_tax_jpy)
 *   raw_bunpai = Σ "分配額"  over all detail rows       (= GT after_tax_income_jpy_a)
 *   rate       = "料率"      (constant 0.4 across the 2207 detail rows)
 *
 *   GT total_amount_jpy       = round(raw_sales  × 1.10)   (10% consumption tax outside)
 *   GT before_tax_jpy         = GT total_amount_jpy        (fee_jpy = 0)
 *   GT after_tax_jpy          = raw_sales                  (= round(total / 1.10))
 *   GT before_tax_income_jpy  = round(raw_bunpai × 1.10)
 *   GT consumption_tax_jpy    = before_tax_income_jpy - after_tax_income_jpy_a
 *   GT after_tax_income_jpy_a = raw_bunpai
 *
 * "タイトル一覧" 当月分配金額 / 当月支払金額 equal raw_bunpai (= after_tax_income_jpy_a),
 * so we cross-check against it as a sanity fence.
 *
 * Fixed fields (all 30 GT rows):
 *   channel              = "u-next"
 *   type                 = "WT"
 *   distribution_strategy = "non-ex"
 *   rs_rate              = 0.40   (also the 料率 column value)
 *   settlement_currency  = "JPY", vehicle_currency = "KRW"
 *
 * Title normalization
 *   "タイトル名" already matches GT channel_title_jp exactly (including ～ vs
 *   〜 vs ~ variants) — no character substitution required.
 */
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, sheetToMatrix, toNumber } from "./common";
import fs from "node:fs";
import path from "node:path";

const CHANNEL_CODE = "u-next";
const CLIENT_CODE = "u_next";
const DEFAULT_RS = 0.40;
const TAX_MULT = 1.10;

interface AliasRules {
  title_normalize: Array<{ from: string; to: string }>;
  default_type: "WT" | "EP" | "COMIC" | "NOVEL" | "OTHER";
  default_distribution: "ex" | "non-ex" | "both";
  default_rs: number;
  tax_multiplier: number;
}

let aliasCache: AliasRules | null = null;

function loadAliases(): AliasRules {
  if (aliasCache) return aliasCache;
  const candidates = [
    path.resolve(process.cwd(), "src/features/settlement/data/aliases/unext.json"),
    path.resolve(process.cwd(), "../data/aliases/unext.json"),
    path.resolve(__dirname, "../../data/aliases/unext.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      aliasCache = {
        title_normalize: j.title_normalize ?? [],
        default_type: j.default_type ?? "WT",
        default_distribution: j.default_distribution ?? "non-ex",
        default_rs: j.default_rs ?? DEFAULT_RS,
        tax_multiplier: j.tax_multiplier ?? TAX_MULT,
      };
      return aliasCache;
    }
  }
  aliasCache = {
    title_normalize: [],
    default_type: "WT",
    default_distribution: "non-ex",
    default_rs: DEFAULT_RS,
    tax_multiplier: TAX_MULT,
  };
  return aliasCache;
}

function normalizeTitle(s: string, rules: AliasRules): string {
  let out = s;
  for (const r of rules.title_normalize) {
    out = out.split(r.from).join(r.to);
  }
  return out;
}

/** Locate a header cell's column index by substring match. */
function findCol(header: unknown[], ...needles: string[]): number {
  return header.findIndex(c => typeof c === "string" && needles.some(n => (c as string).includes(n)));
}

/** Read "集計対象期間" from the ヘッダー sheet → YYYY-MM-01. */
function readSalesMonth(matrix: unknown[][]): string | null {
  for (const row of matrix) {
    const label = String(row?.[0] ?? "");
    if (label.includes("集計対象期間") || label.includes("対象期間")) {
      const val = String(row?.[1] ?? "");
      // "2026/03/01-2026/03/31" or "2026-03"
      const m = val.match(/(\d{4})[/年-](\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, "0")}-01`;
    }
  }
  return null;
}

export async function parseUnext({
  filename,
  buffer,
}: {
  filename: string;
  buffer: Buffer;
}): Promise<ParseResult> {
  const rules = loadAliases();
  const wb = readWorkbook(buffer);

  // Resolve sheet names defensively — use known names but fall back to heuristics.
  const headerSheet =
    wb.SheetNames.find(n => n === "ヘッダー") ??
    wb.SheetNames.find(n => n.includes("ヘッダー"));
  const detailSheet =
    wb.SheetNames.find(n => n === "コンテンツ明細") ??
    wb.SheetNames.find(n => n.includes("コンテンツ"));
  const summarySheet =
    wb.SheetNames.find(n => n === "タイトル一覧") ??
    wb.SheetNames.find(n => n.includes("タイトル一覧"));

  const errors: string[] = [];

  // 1) sales_month from ヘッダー sheet; fall back to filename YYYYMM.
  let salesMonth: string | null = null;
  if (headerSheet) salesMonth = readSalesMonth(sheetToMatrix(wb, headerSheet));
  if (!salesMonth) {
    const m = filename.match(/(\d{4})(\d{2})/);
    salesMonth = m ? `${m[1]}-${m[2]}-01` : null;
  }

  // 2) Build a per-title summary check from タイトル一覧 (not strictly required,
  //    but lets us sanity-check that every detail title also has a summary row).
  const summaryByTitle = new Map<
    string,
    { payout_jp: number; work_mgmt_code: string | null }
  >();
  if (summarySheet) {
    const mat = sheetToMatrix(wb, summarySheet);
    if (mat.length > 1) {
      const h = mat[0];
      const titleCol = findCol(h, "タイトル名");
      const monthPayCol = findCol(h, "当月分配金額");
      const workCodeCol = findCol(h, "作品管理コード");
      for (let i = 1; i < mat.length; i++) {
        const r = mat[i];
        if (!r) continue;
        const title = r[titleCol];
        if (typeof title !== "string" || !title.trim()) continue;
        summaryByTitle.set(normalizeTitle(title.trim(), rules), {
          payout_jp: toNumber(r[monthPayCol]),
          work_mgmt_code:
            workCodeCol >= 0 && typeof r[workCodeCol] === "string"
              ? (r[workCodeCol] as string).trim()
              : null,
        });
      }
    }
  }

  // 3) Aggregate コンテンツ明細 by タイトル名.
  if (!detailSheet) {
    return {
      platform_code: "u_next",
      sales_month: salesMonth,
      settlement_month: salesMonth,
      records: [],
      errors: ["u-next: detail sheet 'コンテンツ明細' not found"],
    };
  }
  const detail = sheetToMatrix(wb, detailSheet);
  if (detail.length < 2) {
    return {
      platform_code: "u_next",
      sales_month: salesMonth,
      settlement_month: salesMonth,
      records: [],
      errors: ["u-next: 'コンテンツ明細' sheet is empty"],
    };
  }

  const header = detail[0];
  const titleCol = findCol(header, "タイトル名");
  const salesCol = findCol(header, "売上");
  const bunpaiCol = findCol(header, "分配額");
  const rateCol = findCol(header, "料率");
  const workCodeCol = findCol(header, "作品管理コード");
  const titleIdCol = findCol(header, "タイトルID");
  const mediaTypeCol = findCol(header, "メディア種別");

  if (titleCol < 0 || salesCol < 0 || bunpaiCol < 0) {
    return {
      platform_code: "u_next",
      sales_month: salesMonth,
      settlement_month: salesMonth,
      records: [],
      errors: [
        `u-next: required columns missing (title=${titleCol}, sales=${salesCol}, bunpai=${bunpaiCol})`,
      ],
    };
  }

  type Agg = {
    title: string;
    raw_sales: number;
    raw_bunpai: number;
    rs_rate: number;
    title_id: string | null;
    media_type: string | null;
    work_mgmt_code: string | null;
    row_count: number;
    order: number;
  };
  const byTitle = new Map<string, Agg>();

  for (let i = 1; i < detail.length; i++) {
    const r = detail[i];
    if (!r) continue;
    const rawTitle = r[titleCol];
    if (typeof rawTitle !== "string") continue;
    const t = rawTitle.trim();
    if (!t) continue;
    if (/合計|総合計|TOTAL/i.test(t)) continue;

    const key = normalizeTitle(t, rules);
    const agg = byTitle.get(key) ?? {
      title: key,
      raw_sales: 0,
      raw_bunpai: 0,
      rs_rate: 0,
      title_id: titleIdCol >= 0 && typeof r[titleIdCol] === "string" ? (r[titleIdCol] as string).trim() : null,
      media_type:
        mediaTypeCol >= 0 && typeof r[mediaTypeCol] === "string"
          ? (r[mediaTypeCol] as string).trim()
          : null,
      work_mgmt_code:
        workCodeCol >= 0 && typeof r[workCodeCol] === "string"
          ? (r[workCodeCol] as string).trim()
          : null,
      row_count: 0,
      order: byTitle.size,
    };
    agg.raw_sales += toNumber(r[salesCol]);
    agg.raw_bunpai += toNumber(r[bunpaiCol]);
    if (rateCol >= 0) {
      const rate = toNumber(r[rateCol]);
      if (rate > 0) agg.rs_rate = rate;
    }
    agg.row_count += 1;
    byTitle.set(key, agg);
  }

  // 4) Build records — one per title, in first-seen order.
  const records: ParseResult["records"] = [];
  const aggs = Array.from(byTitle.values()).sort((a, b) => a.order - b.order);

  for (const a of aggs) {
    const after_tax_jpy = Math.round(a.raw_sales);
    const total_amount_jpy = Math.round(a.raw_sales * rules.tax_multiplier);
    const before_tax_jpy = total_amount_jpy; // fee_jpy = 0
    const after_tax_income_jpy = Math.round(a.raw_bunpai);
    const before_tax_income_jpy = Math.round(a.raw_bunpai * rules.tax_multiplier);
    const consumption_tax_jpy = before_tax_income_jpy - after_tax_income_jpy;

    const summary = summaryByTitle.get(a.title);
    if (summary && Math.abs(summary.payout_jp - after_tax_income_jpy) > 1) {
      errors.push(
        `u-next: detail Σ分配額 (${after_tax_income_jpy}) disagrees with タイトル一覧 当月分配金額 (${summary.payout_jp}) for "${a.title}"`,
      );
    }

    records.push({
      row_index: records.length,
      data: {
        sales_month: salesMonth,
        channel_title_jp: a.title,
        title_jp: a.title,
        type: rules.default_type,
        distribution_strategy: rules.default_distribution,
        channel_code: CHANNEL_CODE,
        client_code: CLIENT_CODE,
        country: "JP",
        settlement_currency: "JPY",
        vehicle_currency: "KRW",
        rs_rate: a.rs_rate > 0 ? a.rs_rate : rules.default_rs,
        total_amount_jpy,
        fee_jpy: 0,
        before_tax_jpy,
        after_tax_jpy,
        before_tax_income_jpy,
        withholding_tax_jpy: 0,
        consumption_tax_jpy,
        after_tax_income_jpy,
        // raw snapshot for debugging / traceability
        raw_sales: a.raw_sales,
        raw_bunpai: a.raw_bunpai,
        raw_detail_rows: a.row_count,
        raw_title_id: a.title_id,
        raw_media_type: a.media_type,
        raw_work_mgmt_code: a.work_mgmt_code ?? summary?.work_mgmt_code ?? null,
      },
    });
  }

  return {
    platform_code: "u_next",
    sales_month: salesMonth,
    settlement_month: salesMonth,
    records,
    errors,
  };
}
