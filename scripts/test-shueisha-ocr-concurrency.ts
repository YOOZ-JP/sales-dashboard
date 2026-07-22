/**
 * Shueisha OCR concurrency / resource-cleanup regression (synthetic — no
 * private scans, no titles, no amounts).
 *
 * extractShueishaFromPdf runs page 1 and page 2 concurrently, each with an
 * independent text+amount worker pair created via createLocalOcrWorkers.
 * These assertions pin the pool contract that keeps that safe inside a
 * serverless function:
 *   1. every worker creation starts before any single creation resolves
 *      (concurrent, not one-after-another),
 *   2. workers come back in spec order (page-1 pair, then page-2 pair),
 *   3. a partial creation failure terminates every worker that did come up
 *      and rethrows the creation error — no leaked WASM workers,
 *   4. terminateOcrWorkers tolerates individual terminate() failures.
 */
import assert from "node:assert/strict";

import { SHUEISHA_OCR_WORKER_LANGS } from "../src/features/settlement/lib/parsers/shueisha";
import {
  createLocalOcrWorkers,
  terminateOcrWorkers,
  type OcrWorker,
} from "../src/features/settlement/lib/parsers/ocr-pdf";

interface FakeWorker {
  langs: string;
  terminated: boolean;
  terminate: () => Promise<void>;
}

function makeFake(langs: string, opts: { failTerminate?: boolean } = {}): FakeWorker {
  const fake: FakeWorker = {
    langs,
    terminated: false,
    terminate: async () => {
      fake.terminated = true;
      if (opts.failTerminate) throw new Error("synthetic terminate failure");
    },
  };
  return fake;
}

const asWorker = (fake: FakeWorker): OcrWorker => fake as unknown as OcrWorker;
const SPECS = [...SHUEISHA_OCR_WORKER_LANGS];

async function main() {
  assert.deepEqual(SPECS, ["jpn", "eng", "jpn", "eng"]);
  // --- 1+2: concurrent start, spec-ordered result ---
  const started: string[] = [];
  const resolvers: Array<() => void> = [];
  const poolPromise = createLocalOcrWorkers(SPECS, (langs) => {
    started.push(langs);
    return new Promise<OcrWorker>((resolve) => {
      resolvers.push(() => resolve(asWorker(makeFake(langs))));
    });
  });
  assert.deepEqual(started, SPECS, "all worker creations must start before any resolves");
  // Resolve out of order; result order must still follow the specs.
  [...resolvers].reverse().forEach((resolve) => resolve());
  const workers = await poolPromise;
  assert.deepEqual(
    (workers as unknown as FakeWorker[]).map((w) => w.langs),
    SPECS,
    "workers must be returned in spec order",
  );

  // --- 3: partial creation failure leaks nothing and rethrows ---
  const created: FakeWorker[] = [];
  let calls = 0;
  await assert.rejects(
    createLocalOcrWorkers(SPECS, async (langs) => {
      const index = calls++;
      if (index === 2) throw new Error("synthetic worker boot failure");
      // First terminate() rejecting must not stop cleanup of the others.
      const fake = makeFake(langs, { failTerminate: index === 0 });
      created.push(fake);
      return asWorker(fake);
    }),
    /synthetic worker boot failure/,
    "a partial creation failure must rethrow the creation error",
  );
  assert.equal(created.length, 3, "only the failing spec is missing from the created set");
  for (const fake of created) {
    assert.equal(fake.terminated, true, "every created worker must be terminated on partial failure");
  }

  // --- 4: terminateOcrWorkers never throws, terminates every worker ---
  const mixed = [makeFake("jpn", { failTerminate: true }), makeFake("eng")];
  await terminateOcrWorkers(mixed.map(asWorker));
  for (const fake of mixed) {
    assert.equal(fake.terminated, true, "terminateOcrWorkers must reach every worker");
  }

  console.log("test-shueisha-ocr-concurrency: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
