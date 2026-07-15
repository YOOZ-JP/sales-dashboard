/**
 * Unit test for the pure INPUT v2 source-family completeness gate.
 * Run: node --import tsx scripts/test-input-v2-source-gates.ts
 */

import assert from "node:assert/strict";

import {
  validateRequiredSourceFamilies,
  type SourceUploadStatus,
} from "../src/features/settlement/lib/export/load-input-v2-records";

const parsedBooklive: SourceUploadStatus = {
  id: "up-booklive",
  platform_code: "booklive",
  status: "parsed",
  parsed_rows: 12,
};
const aggregatedBooklive: SourceUploadStatus = {
  id: "up-booklive-agg",
  platform_code: "booklive",
  status: "aggregated",
  parsed_rows: 12,
};
const parsedDmm: SourceUploadStatus = {
  id: "up-dmm",
  platform_code: "dmm",
  status: "parsed",
  parsed_rows: 3,
};

// --- Without a detail set (pure metadata-only mode) ---

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["booklive", "mechacomic"]), [parsedBooklive]),
  [],
  "booklive baseline with a successful booklive upload passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["bookcomi"]), [parsedBooklive]),
  [],
  "bookcomi baseline is satisfied by the shared booklive source file",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["booklive"]), []),
  ["booklive"],
  "missing upload reports the booklive family",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["bookcomi"]), [
    { id: "up-1", platform_code: "booklive", status: "failed", parsed_rows: 0, parse_error: "boom" },
  ]),
  ["booklive"],
  "failed upload does not satisfy the family",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["booklive"]), [
    { id: "up-1", platform_code: "booklive", status: "parsed", parsed_rows: 0 },
  ]),
  ["booklive"],
  "zero-row parsed upload does not satisfy the family",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["dmm"]), [parsedDmm]),
  [],
  "dmm baseline with a successful dmm upload passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["dmm", "booklive"]), [parsedDmm]),
  ["booklive"],
  "only the unsatisfied family is reported",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["dmm"]), [parsedBooklive]),
  ["dmm"],
  "an upload from another family never satisfies dmm",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["mechacomic", "mediado"]), []),
  [],
  "unrelated cadence channels are never gated",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(), [parsedBooklive]),
  [],
  "empty baseline requires nothing",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["booklive"]), [
    { id: "up-1", platform_code: " BookLive ", status: " PARSED ", parsed_rows: 5 },
  ]),
  [],
  "platform code and status match case- and whitespace-insensitively",
);

// --- With a detail set (production mode: upload must have produced
// current-batch non-summary sales_records) ---

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [aggregatedBooklive],
    new Set(["up-booklive-agg"]),
  ),
  [],
  "aggregated upload backed by detail records passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [parsedBooklive],
    new Set(["up-booklive"]),
  ),
  [],
  "parsed upload backed by detail records passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [parsedBooklive],
    new Set(["up-other"]),
  ),
  ["booklive"],
  "parsed upload without current-batch detail records fails",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [aggregatedBooklive],
    new Set<string>(),
  ),
  ["booklive"],
  "aggregated upload without current-batch detail records fails",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [
      { id: "up-fail", platform_code: "booklive", status: "failed", parsed_rows: 5, parse_error: "boom" },
      { id: "up-zero", platform_code: "booklive", status: "parsed", parsed_rows: 0 },
    ],
    new Set(["up-fail", "up-zero"]),
  ),
  ["booklive"],
  "failed and zero-row uploads fail even when their ids appear in the detail set",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["mechacomic", "mediado"]),
    [],
    new Set<string>(),
  ),
  [],
  "unrelated cadence channels are never gated even with an empty detail set",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["bookcomi"]),
    [parsedBooklive],
    new Set(["up-booklive"]),
  ),
  [],
  "bookcomi baseline is satisfied by the shared booklive upload with detail records",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["dmm"]),
    [parsedDmm],
    new Set(["up-dmm"]),
  ),
  [],
  "dmm parsed upload backed by current-batch detail records passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["dmm"]),
    [parsedDmm],
    new Set<string>(),
  ),
  ["dmm"],
  "dmm summary-only upload cannot satisfy the production detail gate",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["renta"]),
    [{ id: "up-renta", platform_code: "renta", status: "aggregated", parsed_rows: 7 }],
    new Set(["up-renta"]),
  ),
  [],
  "renta upload backed by current detail records passes",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["renta"]),
    [{ id: "up-renta", platform_code: "renta", status: "aggregated", parsed_rows: 7 }],
    new Set<string>(),
  ),
  ["renta"],
  "renta summary-only upload cannot satisfy the detail gate",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["Jumptoon", "Manga Mee"]),
    [{ id: "up-shueisha", platform_code: "shueisha", status: "parsed", parsed_rows: 2 }],
    new Set(["up-shueisha"]),
  ),
  [],
  "Shueisha detail upload satisfies Jumptoon and Manga Mee regardless of case/spacing",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["jumptoon"]),
    [{ id: "up-shueisha", platform_code: "shueisha", status: "parsed", parsed_rows: 1 }],
    new Set<string>(),
  ),
  ["shueisha"],
  "Shueisha summary-only upload cannot satisfy the detail gate",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["manga mee"]),
    [],
    new Set<string>(),
  ),
  ["shueisha"],
  "missing Shueisha upload is reported for Manga Mee baseline rows",
);

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["booklive"]),
    [{ platform_code: "booklive", status: "parsed", parsed_rows: 5 }],
    new Set(["up-booklive"]),
  ),
  ["booklive"],
  "upload without a valid id cannot satisfy the family when a detail set is given",
);

// --- 202606 inventory-audit families: kadokawa, piccoma_ads, u_next, cmoa, comico ---

const newFamilies: ReadonlyArray<{
  family: string;
  baselineChannel: string;
  platform: string;
}> = [
  { family: "kadokawa", baselineChannel: "kadokawa", platform: "kadokawa" },
  { family: "piccoma_ads", baselineChannel: "piccoma_ads", platform: "piccoma_ads" },
  { family: "u_next", baselineChannel: "u-next", platform: "u_next" },
  { family: "cmoa", baselineChannel: "cmoa", platform: "cmoa" },
  { family: "comico", baselineChannel: "comico jp", platform: "comico" },
];

for (const { family, baselineChannel, platform } of newFamilies) {
  const detailUpload: SourceUploadStatus = {
    id: `up-${family}`,
    platform_code: platform,
    status: "parsed",
    parsed_rows: 4,
  };

  assert.deepEqual(
    validateRequiredSourceFamilies(new Set([baselineChannel]), []),
    [family],
    `${family}: baseline channel "${baselineChannel}" with no upload reports the family missing`,
  );

  assert.deepEqual(
    validateRequiredSourceFamilies(
      new Set([baselineChannel]),
      [detailUpload],
      new Set([`up-${family}`]),
    ),
    [],
    `${family}: parsed detail upload of platform "${platform}" satisfies the family`,
  );

  assert.deepEqual(
    validateRequiredSourceFamilies(
      new Set([baselineChannel]),
      [detailUpload],
      new Set<string>(),
    ),
    [family],
    `${family}: summary-only upload cannot satisfy the detail gate`,
  );

  assert.deepEqual(
    validateRequiredSourceFamilies(
      new Set(["mechacomic", "mediado"]),
      [],
      new Set<string>(),
    ),
    [],
    `${family}: unrelated baseline channels never require a ${family} upload`,
  );
}

assert.deepEqual(
  validateRequiredSourceFamilies(
    new Set(["comico_ads"]),
    [{ id: "up-comico", platform_code: "comico", status: "parsed", parsed_rows: 2 }],
    new Set(["up-comico"]),
  ),
  [],
  "comico_ads baseline is satisfied by the shared comico detail upload",
);

assert.deepEqual(
  validateRequiredSourceFamilies(new Set(["comico_ads"]), []),
  ["comico"],
  "missing comico upload is reported for comico_ads baseline rows",
);

console.log("OK: source-family completeness gate passed");
