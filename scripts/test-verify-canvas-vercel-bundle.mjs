/**
 * Synthetic unit tests for the prebuilt-bundle verifier helpers.
 *
 * Feeds hand-built .vc-config.json shapes into collectBundleErrors to
 * pin the deploy gate's behavior: passes only when the function
 * architecture is x64/arm64 and the filePathMap bundles the matching
 * Linux canvas binding plus jpn/eng traineddata. Also pins the deploy
 * script ordering (build → verify → deploy) so the gate cannot be
 * silently dropped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  collectBundleErrors,
  hasTraineddataEntry,
  linuxBindingEntry,
} from "./verify-canvas-vercel-bundle.mjs";

function validConfig(architecture) {
  return {
    architecture,
    filePathMap: {
      [linuxBindingEntry(architecture)]: "/build/binding.node",
      [`node_modules/@tesseract.js-data/jpn/4.0.0/jpn.traineddata.gz`]: "/build/jpn",
      [`node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz`]: "/build/eng",
    },
  };
}

for (const arch of ["x64", "arm64"]) {
  assert.equal(
    linuxBindingEntry(arch),
    `node_modules/@napi-rs/canvas-linux-${arch}-gnu/skia.linux-${arch}-gnu.node`,
  );
  assert.deepEqual(collectBundleErrors(validConfig(arch)), [], `${arch} valid config must pass`);
}

// Architecture gate: missing/unknown architectures fail before any map checks.
for (const architecture of [undefined, "arm", "x86", "linux-arm64"]) {
  const errors = collectBundleErrors({ ...validConfig("arm64"), architecture });
  assert.equal(errors.length, 1, `architecture ${architecture} must fail`);
  assert.match(errors[0], /unsupported function architecture/);
}

// Empty or absent filePathMap fails loudly rather than passing vacuously.
for (const filePathMap of [undefined, {}]) {
  const errors = collectBundleErrors({ architecture: "arm64", filePathMap });
  assert.deepEqual(errors, ["filePathMap is missing or empty"]);
}

// The darwin binding alone (a mac build without vendoring) must not pass,
// and the binding architecture must match the function architecture.
{
  const config = validConfig("arm64");
  delete config.filePathMap[linuxBindingEntry("arm64")];
  config.filePathMap["node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node"] = "/b";
  config.filePathMap[linuxBindingEntry("x64")] = "/b";
  const errors = collectBundleErrors(config);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing Linux canvas binding for arm64/);
}

// Each traineddata language is required independently.
for (const lang of ["jpn", "eng"]) {
  const config = validConfig("arm64");
  delete config.filePathMap[`node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`];
  const errors = collectBundleErrors(config);
  assert.deepEqual(errors, [
    `missing ${lang} traineddata under node_modules/@tesseract.js-data/${lang}/`,
  ]);
}

// traineddata matching is scoped to the language's own package directory.
assert.equal(
  hasTraineddataEntry(["node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"], "jpn"),
  false,
);
assert.equal(
  hasTraineddataEntry(["node_modules/@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz"], "jpn"),
  true,
);

// Deploy ordering: vendor binding → vercel build → verify bundle → deploy.
{
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const deploy = scripts.deploy ?? "";
  const order = [
    "ensure-canvas-linux-binding.mjs",
    "vercel build",
    "verify-canvas-vercel-bundle.mjs",
    "vercel deploy",
  ].map((step) => deploy.indexOf(step));
  assert.ok(
    order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])),
    "deploy script must run ensure → vercel build → verify → vercel deploy",
  );
}

console.log("test-verify-canvas-vercel-bundle: all assertions passed");
