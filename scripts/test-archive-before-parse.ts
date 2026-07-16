/**
 * Assertions for the upload route's archive-before-parse coordinator.
 * Run: node --import tsx scripts/test-archive-before-parse.ts
 *
 * Proves the durability contract: bytes reach the archive and the audit row
 * records the real storage path BEFORE any parser runs; archive failure
 * means no parse; parse failure keeps the archived file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  archiveBeforeParse,
  sha256Hex,
} from "../src/features/settlement/lib/storage/archive-before-parse";

const buffer = Buffer.from("raw settlement bytes");
const expectedSha = createHash("sha256").update(buffer).digest("hex");

assert.equal(sha256Hex(buffer), expectedSha);

async function run() {
  // Happy path: strict ordering archive → record → parse, sha propagated.
  {
    const calls: string[] = [];
    const result = await archiveBeforeParse(buffer, {
      archive: async () => {
        calls.push("archive");
        return { path: "uploads/2026-05/1_file.xlsx" };
      },
      recordArchived: async (path, sha256) => {
        calls.push("record");
        assert.equal(path, "uploads/2026-05/1_file.xlsx");
        assert.equal(sha256, expectedSha);
      },
      parse: async () => {
        calls.push("parse");
        return { rows: 3 };
      },
    });
    assert.deepEqual(calls, ["archive", "record", "parse"], "parse must run last");
    assert.deepEqual(result, {
      ok: true,
      archivePath: "uploads/2026-05/1_file.xlsx",
      sha256: expectedSha,
      parsed: { rows: 3 },
    });
  }

  // Archive failure: upload is failed, parse is NEVER called.
  {
    const calls: string[] = [];
    const result = await archiveBeforeParse(buffer, {
      archive: async () => {
        calls.push("archive");
        throw new Error("bucket unavailable");
      },
      recordArchived: async () => {
        calls.push("record");
      },
      parse: async () => {
        calls.push("parse");
        return {};
      },
    });
    assert.deepEqual(calls, ["archive"], "nothing may run after a failed archive");
    assert.deepEqual(result, {
      ok: false,
      stage: "archive",
      archivePath: null,
      sha256: expectedSha,
      error: "bucket unavailable",
    });
  }

  // Audit-row update failure: file is archived but parse still must not run.
  {
    const calls: string[] = [];
    const result = await archiveBeforeParse(buffer, {
      archive: async () => {
        calls.push("archive");
        return { path: "uploads/undated/2_file.xlsx" };
      },
      recordArchived: async () => {
        calls.push("record");
        throw new Error("row update failed");
      },
      parse: async () => {
        calls.push("parse");
        return {};
      },
    });
    assert.deepEqual(calls, ["archive", "record"]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.stage === "record");
    assert.ok(!result.ok && result.archivePath === "uploads/undated/2_file.xlsx",
      "archived path survives the failure");
  }

  // Parse failure: the archived file remains and the result still points at it.
  {
    const result = await archiveBeforeParse(buffer, {
      archive: async () => ({ path: "uploads/2026-05/3_file.xlsx" }),
      recordArchived: async () => {},
      parse: async () => {
        throw new Error("unreadable workbook");
      },
    });
    assert.deepEqual(result, {
      ok: false,
      stage: "parse",
      archivePath: "uploads/2026-05/3_file.xlsx",
      sha256: expectedSha,
      error: "unreadable workbook",
    });
  }

  console.log("archive-before-parse: all assertions passed");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
