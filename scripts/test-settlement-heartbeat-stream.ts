/**
 * Pure assertions for heartbeat-streamed prepared-upload responses.
 * Run: node --import tsx scripts/test-settlement-heartbeat-stream.ts
 */
import assert from "node:assert/strict";

import {
  GENERIC_STREAM_ERROR_BODY,
  SETTLEMENT_HEARTBEAT_HEADER,
  createHeartbeatJsonStream,
  wantsHeartbeatStream,
} from "../src/features/settlement/lib/storage/heartbeat-stream";
import { assertUploadResponsePayload } from "../src/features/settlement/lib/storage/direct-upload-client";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  // Delayed completion: at least one heartbeat is emitted before the final
  // JSON, heartbeats are pure JSON whitespace (no filename/title/amount), and
  // the original result body arrives byte-identical at the tail.
  {
    const body = { results: [{ upload_id: "u1", file: "f.pdf", sales_records_written: 3 }] };
    const finalJson = JSON.stringify(body);
    const stream = createHeartbeatJsonStream(
      async () => {
        await wait(60);
        return finalJson;
      },
      { intervalMs: 10 },
    );
    const text = await new Response(stream).text();
    const leading = text.slice(0, text.indexOf("{"));
    assert.ok(leading.length >= 1, "expected at least one heartbeat before completion");
    assert.equal(leading.trim(), "", "heartbeat bytes must be JSON whitespace only");
    assert.ok(text.endsWith(finalJson), "final JSON must be appended unmodified after heartbeats");
    assert.deepEqual(JSON.parse(text), body);
  }

  // Leading whitespace + final JSON still parses through response.json().
  {
    const stream = createHeartbeatJsonStream(
      async () => {
        await wait(30);
        return JSON.stringify({ results: [] });
      },
      { intervalMs: 5 },
    );
    assert.deepEqual(await new Response(stream).json(), { results: [] });
  }

  // Completion before the first tick emits exactly the JSON body.
  {
    const stream = createHeartbeatJsonStream(async () => JSON.stringify({ results: [] }), {
      intervalMs: 5,
    });
    assert.equal(await new Response(stream).text(), JSON.stringify({ results: [] }));
  }

  // Cancelling the stream stops heartbeats but never aborts the task.
  {
    let taskFinished = false;
    const stream = createHeartbeatJsonStream(
      async () => {
        await wait(40);
        taskFinished = true;
        return JSON.stringify({ results: [] });
      },
      { intervalMs: 5 },
    );
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel();
    assert.equal(taskFinished, false);
    await wait(80);
    assert.equal(taskFinished, true, "underlying processing must survive stream cancel");
  }

  // Unexpected task failure is reported to the error hook and serialized as a
  // generic JSON error without leaking the original message.
  {
    const seen: unknown[] = [];
    const stream = createHeartbeatJsonStream(
      async () => {
        throw new Error("secret-detail-xyz");
      },
      { intervalMs: 5, onTaskError: (error) => seen.push(error) },
    );
    const text = await new Response(stream).text();
    assert.equal(seen.length, 1);
    assert.ok(!text.includes("secret-detail-xyz"), "error details must not reach the stream");
    assert.equal(text, GENERIC_STREAM_ERROR_BODY);
    assert.equal(typeof JSON.parse(text).error, "string");
  }

  // Fixed-200 streaming: the client promotes top-level error / malformed
  // payloads to thrown failures and passes valid results through untouched.
  assert.deepEqual(assertUploadResponsePayload({ results: [{ file: "a" }] }), {
    results: [{ file: "a" }],
  });
  assert.throws(() => assertUploadResponsePayload({ error: "parse failed: boom" }), /boom/);
  assert.throws(() => assertUploadResponsePayload({}), /results/);
  assert.throws(() => assertUploadResponsePayload(null), /results/);
  assert.throws(() => assertUploadResponsePayload({ results: "nope" }), /results/);

  // Streaming stays strictly opt-in via the exact header value.
  assert.equal(
    wantsHeartbeatStream(
      new Request("http://localhost/api/settlement/upload", {
        headers: { [SETTLEMENT_HEARTBEAT_HEADER]: "1" },
      }),
    ),
    true,
  );
  assert.equal(wantsHeartbeatStream(new Request("http://localhost/api/settlement/upload")), false);
  assert.equal(
    wantsHeartbeatStream(
      new Request("http://localhost/api/settlement/upload", {
        headers: { [SETTLEMENT_HEARTBEAT_HEADER]: "0" },
      }),
    ),
    false,
  );

  console.log("test-settlement-heartbeat-stream: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
