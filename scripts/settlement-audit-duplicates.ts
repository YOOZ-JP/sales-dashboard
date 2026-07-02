/**
 * Settlement duplicate audit — summarizes, per platform and upload, how many
 * parsed/sales rows exist for a settlement month and where strict-key
 * duplicates come from (same upload vs cross-upload re-uploads).
 *
 * Run: node --import tsx scripts/settlement-audit-duplicates.ts [YYYYMM]
 *
 * Prints counts and hashed sample titles only — no monetary tables, no env
 * values.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { strictRecordKey } from "../src/features/settlement/lib/aggregation/strict-record-key";

// Run from the repo root; import.meta.dirname is unavailable under tsx CJS.
config({ path: path.resolve(process.cwd(), ".env.local") });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// `||` not `??`: .env.local may define SUPABASE_SERVICE_ROLE_KEY as empty.
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / key env vars in .env.local");
  process.exit(1);
}

const month = process.argv[2] ?? "202605";
if (!/^\d{6}$/.test(month)) {
  console.error(`invalid month: ${month} (expected YYYYMM)`);
  process.exit(1);
}
const batchIso = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;

const hashTitle = (t: unknown) =>
  createHash("sha256").update(String(t ?? "")).digest("hex").slice(0, 8);

async function fetchAll<T>(build: (offset: number, page: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, PAGE);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  const sb = createClient(url!, key!);

  const uploads = await fetchAll<Record<string, unknown>>((offset, page) =>
    sb
      .from("raw_uploads")
      .select("id, filename, platform_code, status, parsed_rows, settlement_month")
      .eq("settlement_month", batchIso)
      .range(offset, offset + page - 1),
  );
  const sales = await fetchAll<Record<string, unknown>>((offset, page) =>
    sb
      .from("sales_records")
      .select("*")
      .eq("settlement_batch", batchIso)
      .range(offset, offset + page - 1),
  );

  const platformByUpload = new Map<string, string>();
  for (const u of uploads) {
    platformByUpload.set(String(u.id), String(u.platform_code ?? "unknown"));
  }

  console.log(`# settlement duplicate audit ${month} (batch ${batchIso})`);
  console.log(`uploads: ${uploads.length}, sales_records: ${sales.length}\n`);

  console.log("## uploads");
  for (const u of uploads) {
    console.log(
      `- [${u.platform_code}] ${u.filename} status=${u.status} parsed_rows=${u.parsed_rows}` +
        (Number(u.parsed_rows) === 0 ? "  <-- parser emitted 0 rows" : ""),
    );
  }

  // Group sales rows by platform (via upload), then by strict key.
  type Group = { rows: Record<string, unknown>[]; uploads: Set<string> };
  const byPlatform = new Map<string, Map<string, Group>>();
  for (const r of sales) {
    const uploadId = typeof r.upload_id === "string" ? r.upload_id : "(no upload)";
    const platform = platformByUpload.get(uploadId) ?? "(unknown upload)";
    const k = strictRecordKey(r);
    const groups = byPlatform.get(platform) ?? new Map<string, Group>();
    byPlatform.set(platform, groups);
    const g = groups.get(k) ?? { rows: [], uploads: new Set<string>() };
    groups.set(k, g);
    g.rows.push(r);
    g.uploads.add(uploadId);
  }

  console.log("\n## per-platform strict-key summary");
  for (const [platform, groups] of [...byPlatform.entries()].sort()) {
    let rows = 0;
    let dupGroups = 0;
    let crossUploadGroups = 0;
    let sameUploadDupRows = 0;
    const samples: string[] = [];
    for (const g of groups.values()) {
      rows += g.rows.length;
      if (g.rows.length > 1) {
        dupGroups++;
        if (g.uploads.size > 1) crossUploadGroups++;
        else sameUploadDupRows += g.rows.length - 1;
        if (samples.length < 3) samples.push(hashTitle(g.rows[0]!.channel_title_jp));
      }
    }
    console.log(
      `- ${platform}: sales_rows=${rows} key_groups=${groups.size} ` +
        `dup_groups=${dupGroups} cross_upload_dup_groups=${crossUploadGroups} ` +
        `same_upload_extra_rows=${sameUploadDupRows}` +
        (samples.length ? ` sample_title_hashes=[${samples.join(", ")}]` : ""),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
