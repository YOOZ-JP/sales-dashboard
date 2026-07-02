/**
 * KADOKAWA parser sanity check against a local 支払通知書 CSV.
 * Run: node --import tsx scripts/test-kadokawa-parser.ts [path-to-csv]
 *
 * Prints row count / type counts / date fields only — no titles, no amounts.
 */
import { readFileSync } from "node:fs";

import { parseKadokawa } from "../src/features/settlement/lib/parsers/kadokawa";

const DEFAULT_CSV =
  "/Volumes/SSD_MacMini_2/HermesWork/riverse_jp_settlement_drive_analysis/202605/20260531_KADOKAWA/支払通知書_20260529_2191082.csv";

async function main() {
  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const buffer = readFileSync(csvPath);
  const result = await parseKadokawa({ buffer, filename: csvPath.split("/").pop()! });

  const typeCounts = new Map<string, number>();
  const salesMonths = new Set<string>();
  const settlementMonths = new Set<string>();
  for (const r of result.records) {
    const d = r.data as Record<string, unknown>;
    const t = String(d.type ?? "(none)");
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    salesMonths.add(String(d.sales_month ?? "(none)"));
    settlementMonths.add(String(d.settlement_month ?? "(none)"));
  }

  console.log(`platform: ${result.platform_code}`);
  console.log(`records: ${result.records.length}`);
  console.log(`type counts: ${JSON.stringify(Object.fromEntries([...typeCounts.entries()].sort()))}`);
  console.log(`file sales_month: ${result.sales_month}, file settlement_month: ${result.settlement_month}`);
  console.log(`record sales_month values: ${[...salesMonths].sort().join(", ")}`);
  console.log(`record settlement_month values: ${[...settlementMonths].sort().join(", ")}`);
  console.log(`errors: ${result.errors.length === 0 ? "(none)" : result.errors.join(" | ")}`);

  const unclassified = result.errors.filter((e) => e.includes("unclassified"));
  if (unclassified.length > 0) {
    console.error(`FAIL: ${unclassified.length} unclassified-title errors`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
