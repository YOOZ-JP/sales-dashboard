/**
 * Pure assertions for direct-to-private-Storage settlement uploads.
 * Run: node --import tsx scripts/test-direct-upload.ts
 */
import assert from "node:assert/strict";

import {
  buildCleanupPreparedUploadRequest,
} from "../src/features/settlement/lib/storage/direct-upload-client";
import {
  buildDirectUploadPath,
  parseProcessUploadPayload,
  prepareDirectUploadForParse,
  statusAfterParseMetadata,
  validateCleanupUploadPayload,
  validateFolderHint,
  validatePrepareUploadPayload,
  type DirectUploadRow,
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
    assert.equal(path.path, `uploads/2026-05/${uploadId}_bad_name.xlsx`);
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

  console.log("direct-upload: all assertions passed");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
