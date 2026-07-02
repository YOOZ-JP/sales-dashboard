/**
 * Import the RIVERSE comprehensive content list workbook into Supabase.
 *
 * Idempotent: rows are upserted on (source_sheet, source_row). Each run
 * records an import batch; rows of an imported sheet that are absent from
 * the current run are soft-deleted (is_active = false), never hard-deleted.
 *
 * Usage:
 *   CONTENT_MASTER_XLSX_PATH=/path/to/RIVERSE_.xlsx npm run content-master:import
 *   npm run content-master:import -- /path/to/RIVERSE_.xlsx
 *
 * Requires Supabase env in .env.local:
 *   VITE_SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SHEET_CONFIGS, parseSheet, type ParsedContentRow } from '../src/features/content-master/lib/parse-workbook';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) in .env.local');
  process.exit(1);
}

const xlsxPath = process.argv[2] || process.env.CONTENT_MASTER_XLSX_PATH;
if (!xlsxPath) {
  console.error('Provide the workbook path via CONTENT_MASTER_XLSX_PATH or as a CLI argument.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const CHUNK = 500;

async function main() {
  console.log(`Reading ${xlsxPath} ...`);
  const wb = XLSX.readFile(xlsxPath!);

  const parsed: ParsedContentRow[] = [];
  const importedSheets: string[] = [];
  for (const { sheet, status } of SHEET_CONFIGS) {
    const ws = wb.Sheets[sheet];
    if (!ws) {
      console.warn(`  ! sheet not found, skipping: ${sheet}`);
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
    const sheetRows = parseSheet(sheet, status, rows);
    console.log(`  • ${sheet} (${status}): ${sheetRows.length} rows`);
    parsed.push(...sheetRows);
    importedSheets.push(sheet);
  }

  if (parsed.length === 0) {
    console.error('No rows parsed — nothing to import.');
    process.exit(1);
  }

  // 1) Create the import batch.
  const { data: batch, error: batchErr } = await supabase
    .from('content_master_import_batches')
    .insert({ source_file: basename(xlsxPath!), sheets: importedSheets, row_count: parsed.length })
    .select('id')
    .single();
  if (batchErr || !batch) {
    console.error('Failed to create import batch:', batchErr?.message);
    process.exit(1);
  }
  const batchId = batch.id as string;

  // 2) Upsert rows (idempotent on source_sheet + source_row).
  const now = new Date().toISOString();
  for (let i = 0; i < parsed.length; i += CHUNK) {
    const slice = parsed.slice(i, i + CHUNK).map((r) => ({
      ...r,
      import_batch_id: batchId,
      is_active: true,
      updated_at: now,
    }));
    const { error } = await supabase
      .from('content_master')
      .upsert(slice, { onConflict: 'source_sheet,source_row' });
    if (error) {
      console.error(`Upsert failed at row ${i}:`, error.message);
      process.exit(1);
    }
    console.log(`  ↑ upserted ${Math.min(i + CHUNK, parsed.length)}/${parsed.length}`);
  }

  // 3) Soft-delete rows of imported sheets that were not seen in this run.
  const { data: deactivated, error: delErr } = await supabase
    .from('content_master')
    .update({ is_active: false, updated_at: now })
    .in('source_sheet', importedSheets)
    .neq('import_batch_id', batchId)
    .select('id');
  if (delErr) {
    console.error('Soft-delete reconciliation failed:', delErr.message);
    process.exit(1);
  }

  console.log(`\nDone. batch=${batchId} upserted=${parsed.length} soft-deleted=${deactivated?.length ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
