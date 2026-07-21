/**
 * Heartbeat-streamed JSON responses for long prepared-upload processing.
 *
 * HTTP/1.1 intermediaries drop responses that stay byte-idle for ~5-6 minutes
 * (ECONNRESET before maxDuration=800 is reached), so the route streams JSON
 * whitespace every few seconds and appends the real JSON body at the end.
 * JSON.parse ignores leading whitespace, so response.json() keeps working.
 */

export const SETTLEMENT_HEARTBEAT_HEADER = "x-settlement-heartbeat";
export const SETTLEMENT_HEARTBEAT_INTERVAL_MS = 12_000;
export const GENERIC_STREAM_ERROR_BODY = JSON.stringify({
  error: "settlement upload processing failed",
});

// Newline is insignificant JSON whitespace; it carries no upload metadata.
const HEARTBEAT_BYTE = "\n";

export function wantsHeartbeatStream(request: Request): boolean {
  return request.headers.get(SETTLEMENT_HEARTBEAT_HEADER) === "1";
}

/**
 * Returns a stream that emits heartbeat whitespace every intervalMs until
 * produceFinalJson settles, then appends the final JSON body and closes.
 * Cancelling the stream stops the heartbeats but never aborts the task, so
 * the raw_upload row still reaches a terminal status after a disconnect.
 */
export function createHeartbeatJsonStream(
  produceFinalJson: () => Promise<string>,
  options?: { intervalMs?: number; onTaskError?: (error: unknown) => void },
): ReadableStream<Uint8Array> {
  const intervalMs = options?.intervalMs ?? SETTLEMENT_HEARTBEAT_INTERVAL_MS;
  const onTaskError =
    options?.onTaskError ??
    ((error: unknown) => {
      console.error("[upload] heartbeat stream task failed", error);
    });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const clearHeartbeat = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueueSafely = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Consumer went away between cancel() and this tick; keep the task
          // running but stop touching the controller.
          closed = true;
        }
      };
      const finish = (finalJson: string) => {
        clearHeartbeat();
        enqueueSafely(finalJson);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };
      timer = setInterval(() => enqueueSafely(HEARTBEAT_BYTE), intervalMs);
      // Unexpected failures must not leak details into the fixed-200 stream;
      // the generic error body keeps client-side failure semantics intact.
      produceFinalJson().then(finish, (error) => {
        onTaskError(error);
        finish(GENERIC_STREAM_ERROR_BODY);
      });
    },
    cancel() {
      closed = true;
      clearHeartbeat();
    },
  });
}
