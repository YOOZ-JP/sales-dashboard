/**
 * Verify the prebuilt Vercel output before deploying it.
 *
 * Runs after `vercel build --prod` and before `vercel deploy --prebuilt`.
 * `vercel deploy --prebuilt` uploads exactly the files listed in each
 * function's .vc-config.json filePathMap, so this checks that the
 * settlement upload function bundles the assets its OCR pipeline needs
 * at runtime: the @napi-rs/canvas Linux binding matching the function's
 * CPU architecture (vendored by ensure-canvas-linux-binding.mjs) and
 * the jpn/eng tesseract traineddata files. A miss here would only
 * surface as a production runtime crash, so fail the deploy instead.
 *
 * Error messages reference only bundle-relative paths, never local
 * filesystem paths or filePathMap values.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SUPPORTED_ARCHITECTURES = ["x64", "arm64"];

export const CONFIG_RELATIVE_PATH =
  ".vercel/output/functions/api/settlement/upload.func/.vc-config.json";

export function linuxBindingEntry(architecture) {
  return `node_modules/@napi-rs/canvas-linux-${architecture}-gnu/skia.linux-${architecture}-gnu.node`;
}

export function hasTraineddataEntry(bundledPaths, lang) {
  return bundledPaths.some(
    (p) => p.startsWith(`node_modules/@tesseract.js-data/${lang}/`) && p.includes(".traineddata"),
  );
}

export function collectBundleErrors(config) {
  const errors = [];
  const architecture = config?.architecture;
  if (!SUPPORTED_ARCHITECTURES.includes(architecture)) {
    errors.push(
      `unsupported function architecture ${JSON.stringify(architecture ?? null)} (expected "x64" or "arm64")`,
    );
    return errors;
  }
  const bundledPaths = Object.keys(config.filePathMap ?? {});
  if (bundledPaths.length === 0) {
    errors.push("filePathMap is missing or empty");
    return errors;
  }
  const binding = linuxBindingEntry(architecture);
  if (!bundledPaths.includes(binding)) {
    errors.push(`missing Linux canvas binding for ${architecture}: ${binding}`);
  }
  for (const lang of ["jpn", "eng"]) {
    if (!hasTraineddataEntry(bundledPaths, lang)) {
      errors.push(`missing ${lang} traineddata under node_modules/@tesseract.js-data/${lang}/`);
    }
  }
  return errors;
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    console.error(
      `[verify-canvas-vercel-bundle] ${CONFIG_RELATIVE_PATH} not found — run \`vercel build\` first`,
    );
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    console.error(`[verify-canvas-vercel-bundle] ${CONFIG_RELATIVE_PATH} is not valid JSON`);
    process.exit(1);
  }
  const errors = collectBundleErrors(config);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[verify-canvas-vercel-bundle] ${error}`);
    }
    console.error(
      "[verify-canvas-vercel-bundle] refusing to deploy — the settlement OCR function would fail at runtime",
    );
    process.exit(1);
  }
  console.log(
    `[verify-canvas-vercel-bundle] OK — ${config.architecture} canvas binding and jpn/eng traineddata are bundled`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
