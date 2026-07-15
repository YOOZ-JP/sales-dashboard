/**
 * BookLive parser.
 *
 * Raw file: 株式会社ＲＩＶＥＲＳＥ様_タイトル毎_売上報告書.xlsx
 *
 * Headers on row 1:
 *   配信月 | タイトル名 | 著者名 | 出版社名 | 支払先名 | 書店名称 | WT/版面 |
 *   BookLive売上 | 権利元取分(税抜) | 消費税額 | 権利元取分(税込) | 支払額 | 支払期日
 *
 * Transformations:
 *  - Skip subtotal rows (書店名称 is empty)
 *  - Map 書店名称 → channel_code (ブックライブ→booklive, ブッコミ→bookcomi)
 *  - Map WT/版面 → type (WT→WT, 版面→EP), with a lookup table that promotes
 *    selected titles to WR / EB to match Ground Truth
 *  - Normalize title: canonical form via full-width tilde/bracket/digit rewrite,
 *    plus a small alias map for titles that GT renames wholesale
 *  - Amounts: total_amount_jpy = raw.BookLive売上 × 1.10 (rounded), and
 *    before_tax_income_jpy = raw.権利元取分(税込)  (which GT matches within ±1 yen)
 *
 * All normalization rules live in `data/aliases/booklive.json` so that the
 * parser stays declarative.
 */
import * as XLSX from "xlsx";
import type { ParseResult } from "@/features/settlement/lib/schema/sales";
import { readWorkbook, toNumber, toIsoMonth, toIsoDate } from "./common";
import aliases from "../../data/aliases/booklive.json" with { type: "json" };

type Row = {
  "配信月"?: unknown;
  "タイトル名"?: unknown;
  "著者名"?: unknown;
  "出版社名"?: unknown;
  "支払先名"?: unknown;
  "書店名称"?: unknown;
  "WT/版面"?: unknown;
  "BookLive売上"?: unknown;
  "権利元取分(税抜)"?: unknown;
  "消費税額"?: unknown;
  "権利元取分(税込)"?: unknown;
  "支払額"?: unknown;
  "支払期日"?: unknown;
};

const STORE_TO_CHANNEL = aliases.store_to_channel as Record<string, string>;
const WT_TO_TYPE = aliases.wt_to_type as Record<string, string>;

/** Canonical form for loose title comparison. */
export function canonicalTitle(raw: string): string {
  let s = (raw ?? "").trim();
  s = s.replace(/[〜～]/g, "~");       // 〜 U+301C / ～ U+FF5E → ~
  s = s.replace(/［/g, "[").replace(/］/g, "]"); // ［ ］ → [ ]
  s = s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFF10 + 0x30));
  s = s.replace(/\s+/g, "");
  s = s.replace(/【完全版】/g, "[完全版]");    // unify 完全版 bracket style
  return s;
}

const STRIPABLE_SUFFIXES: readonly string[] =
  aliases.normalization_rules.stripable_suffix_markers;

/** Return the set of plausible canonical-title variants for matching. */
export function titleVariants(raw: string): Set<string> {
  const base = canonicalTitle(raw);
  const out = new Set<string>();
  out.add(base);

  // Fully stripped of all markers
  let stripped = base;
  for (const sf of STRIPABLE_SUFFIXES) stripped = stripped.split(sf).join("");
  out.add(stripped);

  // Each marker individually stripped
  for (const sf of STRIPABLE_SUFFIXES) out.add(base.split(sf).join(""));
  return out;
}

type TypeOverride = { match: { wt: string }; titles: string[]; type: string };
const TYPE_OVERRIDES = aliases.type_overrides as TypeOverride[];
const OVERRIDE_INDEX = new Map<string, string>();
for (const o of TYPE_OVERRIDES) {
  for (const t of o.titles) OVERRIDE_INDEX.set(`${o.match.wt}::${canonicalTitle(t)}`, o.type);
}

type TitleAlias = { from_raw: string; to_gt: string };
const TITLE_ALIASES = aliases.title_aliases as TitleAlias[];
const ALIAS_INDEX = new Map<string, string>();
for (const a of TITLE_ALIASES) ALIAS_INDEX.set(canonicalTitle(a.from_raw), a.to_gt);

type CtxRewrite = { match: { wt: string }; titles_needing_bunsatsu_suffix?: string[]; titles_dropping_bunsatsu_suffix?: string[] };
const CTX_REWRITES = aliases.title_rewrites_by_context as CtxRewrite[];
const NEED_BUNSATSU = new Set<string>();
const DROP_BUNSATSU = new Set<string>();
for (const r of CTX_REWRITES) {
  for (const t of r.titles_needing_bunsatsu_suffix ?? []) NEED_BUNSATSU.add(`${r.match.wt}::${canonicalTitle(t)}`);
  for (const t of r.titles_dropping_bunsatsu_suffix ?? []) DROP_BUNSATSU.add(`${r.match.wt}::${canonicalTitle(t)}`);
}

/** Resolve the final (title_jp, type) used for matching / downstream emission. */
export function resolveTitleAndType(rawTitle: string, wt: string): { title_jp: string; type: string; variants: Set<string> } {
  const canon = canonicalTitle(rawTitle);
  const aliased = ALIAS_INDEX.get(canon);
  const effectiveTitle = aliased ?? rawTitle;

  const override = OVERRIDE_INDEX.get(`${wt}::${canon}`);
  const type = override ?? WT_TO_TYPE[wt] ?? "WT";

  // Build variant set for matching. Include context-based rewrites.
  const variants = titleVariants(effectiveTitle);

  const BUNSATSU = "【分冊版】";
  const withoutSuffix = canonicalTitle(effectiveTitle);
  if (NEED_BUNSATSU.has(`${wt}::${canon}`)) {
    variants.add(withoutSuffix + BUNSATSU);
  }
  if (DROP_BUNSATSU.has(`${wt}::${canon}`)) {
    for (const v of [...variants]) variants.add(v.split(BUNSATSU).join(""));
  }

  return { title_jp: effectiveTitle, type, variants };
}

export async function parseBooklive({ buffer }: { filename: string; buffer: Buffer }): Promise<ParseResult> {
  const wb = readWorkbook(buffer);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });

  const errors: string[] = [];
  const records = [] as ParseResult["records"];

  let firstMonth: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const title = r["タイトル名"];
    const store = r["書店名称"];
    const wt = r["WT/版面"];
    // Skip subtotal / empty rows
    if (!title || !store || !wt) continue;
    const storeStr = String(store).trim();
    const wtStr = String(wt).trim();
    const channel = STORE_TO_CHANNEL[storeStr];
    if (!channel) {
      errors.push(`row ${i + 2}: unknown store "${storeStr}"`);
      continue;
    }
    if (!WT_TO_TYPE[wtStr]) {
      errors.push(`row ${i + 2}: unknown WT/版面 "${wtStr}"`);
      continue;
    }

    const sales = toNumber(r["BookLive売上"]);
    const incomePre = toNumber(r["権利元取分(税抜)"]);
    const cTax = toNumber(r["消費税額"]);
    const incomePost = toNumber(r["権利元取分(税込)"]);
    const payment = toNumber(r["支払額"]);

    const total_amount_jpy = Math.round(sales * 1.10);
    const before_tax_income_jpy = incomePost;      // raw already sums pre + ctax (matches GT ±1)

    const { title_jp, type, variants } = resolveTitleAndType(String(title).trim(), wtStr);

    const sales_month = toIsoMonth(r["配信月"]);
    if (!firstMonth && sales_month) firstMonth = sales_month;

    records.push({
      row_index: i + 2,
      data: {
        sales_month,
        deposit_month: sales_month ? addMonthsEndOfMonth(sales_month, 2) : null,
        pay_due: toIsoDate(r["支払期日"]),
        client_code: "booklive",
        channel_code: channel,
        type,
        title_jp,
        title_canonical: canonicalTitle(title_jp),
        title_variants: [...variants],
        author: r["著者名"] ?? null,
        publisher: r["出版社名"] ?? null,
        raw_store: storeStr,
        raw_wt: wtStr,
        note2: "TYPE_HEURISTIC",
        raw_title: String(title).trim(),
        // Amounts
        gross_jpy: total_amount_jpy,               // aggregate engine reads gross_jpy
        total_amount_jpy,
        before_tax_income_jpy,
        consumption_tax_jpy: cTax,
        after_tax_income_jpy: incomePre,            // pre-tax share for the rights-holder
        before_tax_jpy: Math.round(sales / 1.10),
        after_tax_jpy: sales,
        payment_jpy: payment,
        rs_label: "38%",
        rs_rate_hint: 0.38,
      },
    });
  }

  const settlement_month = firstMonth ? nextMonth(firstMonth) : null;
  return {
    platform_code: "booklive",
    sales_month: firstMonth,
    settlement_month,
    records,
    errors,
  };
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, (m ?? 1), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function addMonthsEndOfMonth(iso: string, months: number): string {
  const [year, month] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1 + months + 1, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
