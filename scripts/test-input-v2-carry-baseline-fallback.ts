/**
 * Unit tests for the private carry-baseline fallback: previous-month
 * derivation, the buffer-based baseline parser, the storage fetch guard, and
 * the fail-closed baseline source decision. All workbook data is synthetic.
 * Run: node --import tsx scripts/test-input-v2-carry-baseline-fallback.ts
 */

import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { loadCarryForwardBaselineRowsFromBuffer } from "../src/features/settlement/lib/export/input-v2-carry-forward";
import {
  CARRY_BASELINE_MAX_BYTES,
  carryBaselineStoragePath,
  decideCarryBaseline,
  fetchPrivateCarryBaseline,
  previousSettlementMonth,
  type StorageDownloadClient,
} from "../src/features/settlement/lib/export/load-input-v2-records";

const BASELINE_SHEET = "input_電子_6月";
const COL = { channel_title_jp: 2, title_kr: 3, channel: 15, type: 16, total_amount_jpy: 20 };

async function buildWorkbook(
  sheetName: string,
  rows: Array<Record<keyof typeof COL, string | number>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  // Real baselines have 5 header rows before the first data row; they also
  // keep ExcelJS's actualRowCount covering the data range.
  for (let r = 1; r <= 5; r += 1) ws.getRow(r).getCell(1).value = `header ${r}`;
  rows.forEach((row, i) => {
    const r = ws.getRow(6 + i);
    for (const [field, col] of Object.entries(COL)) {
      r.getCell(col).value = row[field as keyof typeof COL];
    }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function stubClient(
  respond: (path: string) => { data: Blob | null; error: { message?: string } | null },
  seenPaths: string[] = [],
): StorageDownloadClient {
  return {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          assert.equal(bucket, "upload-debug", "fallback reads the private archive bucket");
          seenPaths.push(path);
          return respond(path);
        },
      }),
    },
  };
}

async function main() {
  // --- previous-month derivation ---

  assert.equal(previousSettlementMonth("202606"), "202605", "mid-year month steps back one");
  assert.equal(previousSettlementMonth("202601"), "202512", "January wraps to prior December");
  assert.equal(previousSettlementMonth("202612"), "202611", "December stays in-year");
  assert.equal(previousSettlementMonth("202600"), null, "month 00 is invalid");
  assert.equal(previousSettlementMonth("202613"), null, "month 13 is invalid");
  assert.equal(previousSettlementMonth("2026-06"), null, "non-YYYYMM input is rejected");
  assert.equal(previousSettlementMonth(""), null, "empty input is rejected");

  assert.equal(
    carryBaselineStoragePath("209912"),
    "settlement-baselines/209912/input-jp-fin.xlsx",
    "storage path is derived from the baseline month, never hardcoded",
  );

  // --- buffer-based baseline parser ---

  {
    const buffer = await buildWorkbook(BASELINE_SHEET, [
      { channel_title_jp: "SYNTH TITLE A", title_kr: "synth-a", channel: "mechacomic", type: "WT", total_amount_jpy: 111 },
      { channel_title_jp: "SYNTH TITLE B", title_kr: "synth-b", channel: "Jumptoon", type: "WR", total_amount_jpy: 222 },
    ]);
    const rows = await loadCarryForwardBaselineRowsFromBuffer(buffer);
    assert.equal(rows.length, 2, "both synthetic data rows parse");
    assert.equal(rows[0].channel_title_jp, "SYNTH TITLE A");
    assert.equal(rows[0].channel, "mechacomic");
    assert.equal(rows[0].type, "WT");
    assert.equal(rows[0].total_amount_jpy, 111);
    assert.equal(rows[1].channel, "Jumptoon");
  }

  {
    const buffer = await buildWorkbook("wrong_sheet", [
      { channel_title_jp: "SYNTH TITLE A", title_kr: "synth-a", channel: "mechacomic", type: "WT", total_amount_jpy: 1 },
    ]);
    await assert.rejects(
      () => loadCarryForwardBaselineRowsFromBuffer(buffer),
      /input_電子/,
      "workbook without the electronic INPUT sheet is rejected",
    );
  }

  {
    const buffer = await buildWorkbook(BASELINE_SHEET, []);
    const rows = await loadCarryForwardBaselineRowsFromBuffer(buffer);
    assert.equal(rows.length, 0, "sheet with no data rows parses to zero rows");
  }

  // --- storage fetch guard (stub client, no network) ---

  {
    const validBuffer = await buildWorkbook(BASELINE_SHEET, [
      { channel_title_jp: "SYNTH TITLE C", title_kr: "synth-c", channel: "renta", type: "WT", total_amount_jpy: 9 },
    ]);
    const seenPaths: string[] = [];
    const result = await fetchPrivateCarryBaseline(
      "202606",
      stubClient(() => ({ data: new Blob([new Uint8Array(validBuffer)]), error: null }), seenPaths),
    );
    assert.deepEqual(seenPaths, ["settlement-baselines/202605/input-jp-fin.xlsx"],
      "202606 downloads the dynamically derived 202605 baseline path");
    assert.ok(result.ok, "valid private workbook is accepted");
    if (result.ok) assert.equal(result.rows.length, 1);
  }

  {
    const result = await fetchPrivateCarryBaseline(
      "202606",
      stubClient(() => ({ data: null, error: { message: "Object not found" } })),
    );
    assert.deepEqual(result, { ok: false, reason: "baseline object missing" });
  }

  {
    const oversized = { size: CARRY_BASELINE_MAX_BYTES + 1 } as Blob;
    const result = await fetchPrivateCarryBaseline(
      "202606",
      stubClient(() => ({ data: oversized, error: null })),
    );
    assert.deepEqual(result, { ok: false, reason: "baseline object too large" });
  }

  {
    const result = await fetchPrivateCarryBaseline(
      "202606",
      stubClient(() => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null })),
    );
    assert.deepEqual(result, { ok: false, reason: "baseline workbook unreadable" });
  }

  {
    const emptyBuffer = await buildWorkbook(BASELINE_SHEET, []);
    const result = await fetchPrivateCarryBaseline(
      "202606",
      stubClient(() => ({ data: new Blob([new Uint8Array(emptyBuffer)]), error: null })),
    );
    assert.deepEqual(result, { ok: false, reason: "baseline sheet has no rows" });
  }

  {
    const result = await fetchPrivateCarryBaseline("bogus", stubClient(() => {
      throw new Error("must not download for an underivable month");
    }));
    assert.deepEqual(result, { ok: false, reason: "previous month underivable" });
  }

  // --- baseline source decision / fail-closed ---

  const syntheticRow = { channel_title_jp: "SYNTH TITLE D", channel: "dmm", type: "EB" };

  assert.deepEqual(
    decideCarryBaseline(1469, null),
    { ok: true, source: "db" },
    "existing DB baseline wins without touching Storage",
  );

  assert.deepEqual(
    decideCarryBaseline(3, { ok: true, rows: [syntheticRow] }),
    { ok: true, source: "db" },
    "DB baseline stays preferred even when a private baseline exists",
  );

  assert.deepEqual(
    decideCarryBaseline(0, { ok: true, rows: [syntheticRow] }),
    { ok: true, source: "private" },
    "empty DB baseline falls back to a non-empty private baseline",
  );

  {
    const decision = decideCarryBaseline(0, { ok: false, reason: "baseline object missing" });
    assert.equal(decision.ok, false, "missing private baseline fails closed");
    if (!decision.ok) {
      assert.equal(decision.loadError.status, 409);
      assert.equal(decision.loadError.error, "missing_carry_baseline");
      assert.match(decision.loadError.details, /baseline object missing/);
      assert.doesNotMatch(decision.loadError.details, /SYNTH TITLE/, "details never carry workbook content");
    }
  }

  {
    const decision = decideCarryBaseline(
      0,
      { ok: false, reason: "baseline object missing" },
      { allowIncompleteSources: true },
    );
    assert.equal(decision.ok, false, "comparison audit mode cannot bypass a missing carry baseline");
    if (!decision.ok) assert.equal(decision.loadError.error, "missing_carry_baseline");
  }

  {
    const decision = decideCarryBaseline(0, { ok: true, rows: [] });
    assert.equal(decision.ok, false, "empty private baseline fails closed");
  }

  {
    const decision = decideCarryBaseline(0, null, { allowIncompleteSources: true });
    assert.equal(decision.ok, false, "no baseline at all fails closed regardless of audit mode");
    if (!decision.ok) assert.equal(decision.loadError.status, 409);
  }

  console.log("OK: private carry-baseline fallback passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
