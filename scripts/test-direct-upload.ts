/**
 * Pure assertions for direct-to-private-Storage settlement uploads.
 * Run: node --import tsx scripts/test-direct-upload.ts
 */
import assert from "node:assert/strict";

import {
  buildCleanupPreparedUploadRequest,
  parentFolderHint,
} from "../src/features/settlement/lib/storage/direct-upload-client";
import {
  buildDirectUploadPath,
  evaluateExactSourceDuplicate,
  parseProcessUploadPayload,
  prepareDirectUploadForParse,
  statusAfterParseMetadata,
  validateCleanupUploadPayload,
  validateFolderHint,
  validatePrepareUploadPayload,
  type DirectUploadRow,
  type ExactSourceCandidate,
} from "../src/features/settlement/lib/storage/direct-upload";

const uploadId = "11111111-1111-4111-8111-111111111111";

const baseRow: DirectUploadRow = {
  id: uploadId,
  filename: "statement.xlsx",
  storage_path: "uploads/2026-05/11111111-1111-4111-8111-111111111111_statement.xlsx",
  size_bytes: 11,
  content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  settlement_month: "2026-05-01",
  status: "uploaded",
};

async function run() {
  // 5MB+ metadata is accepted without reading/allocating the file body.
  {
    const result = validatePrepareUploadPayload({
      filename: "large.xlsx",
      size_bytes: 5 * 1024 * 1024 + 1,
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      active_month: "2026-05-01",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.size_bytes, 5 * 1024 * 1024 + 1);
  }

  // Invalid month/filename/size are rejected at prepare time.
  assert.equal(validatePrepareUploadPayload({
    filename: "large.xlsx",
    size_bytes: 1,
    content_type: null,
    active_month: "2026-05-02",
  }).ok, false);
  assert.equal(validatePrepareUploadPayload({
    filename: "///",
    size_bytes: 1,
    content_type: null,
    active_month: "2026-05-01",
  }).ok, false);
  assert.equal(validatePrepareUploadPayload({
    filename: "large.xlsx",
    size_bytes: 0,
    content_type: null,
    active_month: "2026-05-01",
  }).ok, false);
  assert.equal(validatePrepareUploadPayload({
    filename: "large.xlsx",
    size_bytes: 101 * 1024 * 1024,
    content_type: null,
    active_month: "2026-05-01",
  }).ok, false);

  // Regression: each selected file carries its OWN parent directory, not the
  // selection's top-level folder — deposit dates live in per-file subfolder
  // basenames (e.g. ichijinsha), so a shared top-level hint loses them.
  assert.equal(
    parentFolderHint("202606/deposit 2026.06.05/statement.xlsx"),
    "202606/deposit 2026.06.05",
  );
  assert.equal(
    parentFolderHint("202606\\deposit 2026.06.12\\statement.xls"),
    "202606/deposit 2026.06.12",
    "backslash-separated paths must resolve the same parent",
  );
  assert.equal(parentFolderHint("202606/statement.xlsx"), "202606");
  // File-only selections (no directory) and empty paths carry no hint.
  assert.equal(parentFolderHint("statement.xlsx"), undefined);
  assert.equal(parentFolderHint(""), undefined);
  assert.equal(parentFolderHint(undefined), undefined);
  // The filename itself must never be part of the hint.
  assert.doesNotMatch(
    parentFolderHint("202606/deposit 2026.06.05/statement.xlsx") ?? "",
    /statement\.xlsx/,
  );

  assert.deepEqual(validateFolderHint(" 2026-05-statements "), {
    ok: true,
    value: "2026-05-statements",
  });
  assert.equal(validateFolderHint("a".repeat(201)).ok, false);
  assert.equal(validateFolderHint("bad\u0001folder").ok, false);
  assert.deepEqual(parseProcessUploadPayload({
    upload_id: uploadId,
    folder_hint: "top-folder",
  }), {
    uploadId,
    folderHint: { ok: true, value: "top-folder" },
  });
  assert.equal(
    statusAfterParseMetadata(3, false),
    "parsing",
    "positive-row uploads must stay non-terminal until raw/sales inserts finish",
  );
  assert.equal(statusAfterParseMetadata(0, false), "parsed");
  assert.equal(statusAfterParseMetadata(0, true), "failed");
  assert.deepEqual(validateCleanupUploadPayload({ upload_id: uploadId }), {
    ok: true,
    uploadId,
  });
  assert.equal(validateCleanupUploadPayload({ upload_id: "not-a-uuid" }).ok, false);

  {
    const cleanup = buildCleanupPreparedUploadRequest(uploadId);
    assert.equal(cleanup.method, "DELETE");
    assert.deepEqual(cleanup.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(String(cleanup.body)), { upload_id: uploadId });
  }

  // Paths are immutable, month-scoped, and filename-safe.
  {
    const path = buildDirectUploadPath("bad/name.xlsx", "2026-05-01", () => uploadId);
    assert.equal(path.path, `uploads/2026-05/${uploadId}.xlsx`);
    assert.equal(path.safeFilename, "bad_name.xlsx");
  }

  // Regression: Japanese/space/paren filenames must never leak into the
  // storage key (Supabase rejects them as "Invalid key"). The key is
  // uploads/YYYY-MM/<uuid><ascii ext>; the original name stays in safeFilename.
  {
    const original = "416829-202606-LI-54575Apple Books(Multi)-報戻-202604.xls";
    const prepared = buildDirectUploadPath(original, "2026-06-01", () => uploadId);
    assert.equal(prepared.path, `uploads/2026-06/${uploadId}.xls`);
    assert.match(
      prepared.path,
      /^uploads\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,10})?$/,
      "storage key must be uuid-only with optional ascii extension",
    );
    assert.match(prepared.path, /^[A-Za-z0-9/._-]+$/, "storage key must be ASCII storage-safe");
    assert.doesNotMatch(prepared.path, /[\s()（）-￿]/, "no spaces/parens/non-ASCII in key");
    assert.equal(prepared.safeFilename, original, "original filename must survive for the DB row");
  }

  // Extension survives only when ASCII alphanumeric and bounded; otherwise omitted.
  {
    const noExt = buildDirectUploadPath("報告書", "2026-06-01", () => uploadId);
    assert.equal(noExt.path, `uploads/2026-06/${uploadId}`);
    assert.equal(noExt.safeFilename, "報告書");
    const spacedExt = buildDirectUploadPath("data.xls x", "2026-06-01", () => uploadId);
    assert.equal(spacedExt.path, `uploads/2026-06/${uploadId}`);
    const longExt = buildDirectUploadPath(`report.${"a".repeat(11)}`, "2026-06-01", () => uploadId);
    assert.equal(longExt.path, `uploads/2026-06/${uploadId}`);
  }

  // Stored bytes are downloaded and status is moved to parsing before caller parses.
  {
    const calls: string[] = [];
    const result = await prepareDirectUploadForParse(uploadId, {
      getUpload: async () => {
        calls.push("get");
        return baseRow;
      },
      download: async (path) => {
        calls.push(`download:${path}`);
        return Buffer.from("hello world");
      },
      markParsing: async () => {
        calls.push("mark-parsing");
        return "updated";
      },
      markFailed: async () => {
        calls.push("mark-failed");
      },
    });
    calls.push("parse");
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "get",
      `download:${baseRow.storage_path}`,
      "mark-parsing",
      "parse",
    ]);
  }

  // Size mismatch fails the row and prevents parse.
  {
    const calls: string[] = [];
    const result = await prepareDirectUploadForParse(uploadId, {
      getUpload: async () => baseRow,
      download: async () => Buffer.from("short"),
      markParsing: async () => {
        calls.push("mark-parsing");
        return "updated";
      },
      markFailed: async (_id, message) => {
        calls.push(`failed:${message}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^failed:size mismatch/);
  }

  // Terminal statuses are bounded/idempotent and do not download or insert.
  {
    const result = await prepareDirectUploadForParse(uploadId, {
      getUpload: async () => ({ ...baseRow, status: "aggregated" }),
      download: async () => {
        throw new Error("download should not run");
      },
      markParsing: async () => "updated",
      markFailed: async () => {
        throw new Error("failed should not run");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.skipped, true);
  }

  // A concurrent request that wins uploaded->parsing must not be clobbered by
  // the loser. The loser returns a safe skipped result and never marks failed.
  for (const latestStatus of ["parsing", "parsed", "aggregated", "failed"] as const) {
    const calls: string[] = [];
    const result = await prepareDirectUploadForParse(uploadId, {
      getUpload: async () => {
        calls.push("get");
        return calls.length === 1 ? baseRow : { ...baseRow, status: latestStatus };
      },
      download: async () => {
        calls.push("download");
        return Buffer.from("hello world");
      },
      markParsing: async () => {
        calls.push("mark-parsing-lost");
        return "not_uploaded";
      },
      markFailed: async () => {
        calls.push("mark-failed");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.skipped, true);
    assert.equal(result.row?.status, latestStatus);
    assert.deepEqual(calls, ["get", "download", "mark-parsing-lost", "get"]);
  }

  // Exact-source duplicate gate: same settlement_month + same sha256 +
  // another terminal successful raw_upload means the reupload is skipped
  // before parsing, preserved as an audit row with the prior row count.
  {
    const sha = "a".repeat(64);
    const priorId = "22222222-2222-4222-8222-222222222222";
    const prior: ExactSourceCandidate = {
      id: priorId,
      filename: "MBJ_statement.xlsx",
      status: "aggregated",
      sha256: sha,
      settlement_month: "2026-05-01",
      parsed_rows: 42,
    };

    // Terminal same-month prior with identical sha does skip.
    const skip = evaluateExactSourceDuplicate(baseRow, sha, [prior]);
    assert.equal(skip.skip, true);
    if (skip.skip) {
      assert.equal(skip.status, "aggregated");
      assert.equal(skip.parsedRows, 42, "parsed_rows must be copied from the prior row");
      assert.equal(skip.prior.id, priorId);
      assert.match(skip.note, /동일 원본 재업로드 건너뜀/);
      assert.ok(!skip.note.includes(priorId), "user-facing note must not expose internal upload ids");
      assert.ok(skip.note.length <= 300, "note must stay bounded");
    }

    // Prior only reached "parsed" (or archived) → current is marked parsed,
    // not aggregated, and null parsed_rows copies as 0.
    for (const status of ["parsed", "archived"] as const) {
      const parsedPrior = evaluateExactSourceDuplicate(baseRow, sha, [
        { ...prior, status, parsed_rows: null },
      ]);
      assert.equal(parsedPrior.skip, true);
      if (parsedPrior.skip) {
        assert.equal(parsedPrior.status, "parsed");
        assert.equal(parsedPrior.parsedRows, 0);
      }
    }

    // Same sha but a different settlement month must not skip.
    assert.deepEqual(
      evaluateExactSourceDuplicate(baseRow, sha, [{ ...prior, settlement_month: "2026-04-01" }]),
      { skip: false },
    );
    // Failed prior rows must never block a retry.
    assert.deepEqual(
      evaluateExactSourceDuplicate(baseRow, sha, [{ ...prior, status: "failed" }]),
      { skip: false },
    );
    // Non-terminal rows (concurrent parse in flight) must not cause
    // symmetric false skips.
    for (const status of ["uploaded", "parsing"] as const) {
      assert.deepEqual(
        evaluateExactSourceDuplicate(baseRow, sha, [{ ...prior, status }]),
        { skip: false },
      );
    }
    // The row's own id must not skip itself.
    assert.deepEqual(
      evaluateExactSourceDuplicate(baseRow, sha, [{ ...prior, id: baseRow.id }]),
      { skip: false },
    );
    // sha-null prior rows (pre-fix failures never hashed) must not block.
    assert.deepEqual(
      evaluateExactSourceDuplicate(baseRow, sha, [{ ...prior, sha256: null }]),
      { skip: false },
    );
    // Different bytes, same month: no skip.
    assert.deepEqual(
      evaluateExactSourceDuplicate(baseRow, "b".repeat(64), [prior]),
      { skip: false },
    );
    // Current row without a settlement month cannot participate in the gate.
    assert.deepEqual(
      evaluateExactSourceDuplicate({ ...baseRow, settlement_month: null }, sha, [
        { ...prior, settlement_month: null },
      ]),
      { skip: false },
    );
    // Note stays bounded even with a maximum-length (180 char) filename.
    const longName = evaluateExactSourceDuplicate(baseRow, sha, [
      { ...prior, filename: "명".repeat(180) },
    ]);
    assert.equal(longName.skip, true);
    if (longName.skip) assert.ok(longName.note.length <= 300);
  }

  console.log("direct-upload: all assertions passed");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
