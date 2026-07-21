/**
 * Runtime dependency / bundling guards for the serverless Shueisha OCR path.
 *
 * The parser needs the @napi-rs/canvas *Linux* native binding at Vercel
 * runtime. These assertions pin the three layers that make that durable:
 *   1. package-lock keeps the Linux platform packages resolvable
 *      (guards the npm optional-dependency lockfile-drop bug),
 *   2. next.config traces canvas + tesseract assets into the upload
 *      function bundle,
 *   3. the prebuilt deploy script vendors the Linux binding before
 *      `vercel build` (a darwin build otherwise ships only the darwin
 *      binding, which is exactly the production failure this covers).
 * Also pins the upload route's maxDuration so the OCR path keeps the
 * Pro-plan 800s budget instead of the 300s default.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import nextConfig from "../next.config";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs helper without type declarations
import { linuxBindingPackage, linuxBindingFile } from "./ensure-canvas-linux-binding.mjs";

const root = path.resolve(__dirname, "..");

async function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const pkgs = lock.packages as Record<string, { version?: string }>;
  const canvasVersion = pkgs["node_modules/@napi-rs/canvas"]?.version;
  assert.ok(canvasVersion, "@napi-rs/canvas must be locked");

  // 1. Linux bindings stay resolvable at the exact canvas version. Vercel
  // builders and prebuilt deploys from both mac architectures are covered.
  for (const arch of ["x64", "arm64"]) {
    const entry = pkgs[`node_modules/${linuxBindingPackage(arch)}`];
    assert.ok(entry, `${linuxBindingPackage(arch)} missing from package-lock`);
    assert.equal(
      entry.version,
      canvasVersion,
      `${linuxBindingPackage(arch)} must match @napi-rs/canvas@${canvasVersion}`,
    );
  }

  // The vendored package names/files must be ones @napi-rs/canvas actually
  // loads (its own optionalDependencies are the loader's lookup table).
  const canvasPkg = JSON.parse(
    fs.readFileSync(path.join(root, "node_modules/@napi-rs/canvas/package.json"), "utf8"),
  );
  for (const arch of ["x64", "arm64"]) {
    assert.ok(
      canvasPkg.optionalDependencies?.[linuxBindingPackage(arch)],
      `${linuxBindingPackage(arch)} is not a binding @napi-rs/canvas knows how to load`,
    );
    assert.match(linuxBindingFile(arch), /^skia\.linux-.+\.node$/);
  }

  // 2. The upload route bundle traces the runtime-loaded OCR assets.
  const includes = nextConfig.outputFileTracingIncludes?.["/api/settlement/upload"] ?? [];
  for (const needle of [
    "@napi-rs",
    "tesseract.js/",
    "tesseract.js-core",
    "@tesseract.js-data",
  ]) {
    assert.ok(
      includes.some((glob) => glob.includes(needle)),
      `outputFileTracingIncludes for /api/settlement/upload must cover ${needle}`,
    );
  }
  for (const external of ["@napi-rs/canvas", "tesseract.js"]) {
    assert.ok(
      nextConfig.serverExternalPackages?.includes(external),
      `${external} must stay in serverExternalPackages`,
    );
  }

  // 3. The upload route keeps the Pro-plan 800s timeout. Next.js statically
  // extracts the literal into the function config, so assert the source
  // export directly (importing the route would need runtime env).
  const routeSource = fs.readFileSync(
    path.join(root, "app/api/settlement/upload/route.ts"),
    "utf8",
  );
  assert.match(
    routeSource,
    /^export const maxDuration = 800;$/m,
    "settlement upload route must export maxDuration = 800 (OCR exceeds the 300s default)",
  );

  // 4. Prebuilt deploys vendor the Linux binding before building.
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const deploy: string = scripts.deploy ?? "";
  assert.ok(
    deploy.includes("ensure-canvas-linux-binding.mjs") &&
      deploy.indexOf("ensure-canvas-linux-binding.mjs") < deploy.indexOf("vercel build"),
    "deploy script must vendor the Linux canvas binding before vercel build",
  );

  console.log("test-shueisha-runtime-bundling: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
