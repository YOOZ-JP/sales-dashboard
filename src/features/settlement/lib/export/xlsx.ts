/**
 * @deprecated The SheetJS-based generator produced a visually-simple
 * xlsx that did not match the human-maintained master file. It has been
 * replaced by `excel-filler.ts`, which opens the master template via
 * Python/openpyxl and injects rows while preserving every styling
 * attribute, formula, merged range, and sibling sheet.
 *
 * This module is kept as a re-export so existing call sites don't break.
 * Prefer importing `fillTemplate` from `./excel-filler` directly.
 */
import { fillTemplate } from "./excel-filler";
import type { SalesRecord } from "@/features/settlement/lib/schema/sales";

/**
 * @deprecated Use `fillTemplate` from `./excel-filler`. Async and
 * full-fidelity, whereas this function returned a stripped-down xlsx.
 */
export async function generateInputSheet(
  records: SalesRecord[],
  settlementMonth: string,
): Promise<Buffer> {
  const month = settlementMonth.replace(/-/g, "").slice(0, 6);
  const { buffer } = await fillTemplate({
    month,
    records: records as unknown as Record<string, unknown>[],
  });
  return buffer;
}
