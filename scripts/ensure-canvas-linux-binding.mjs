/**
 * Ensure the Linux native binding of @napi-rs/canvas is present in
 * node_modules before a prebuilt Vercel deploy.
 *
 * `vercel build` on macOS traces only the darwin binding into the
 * function bundle (npm installs just the host-platform optional
 * dependency), so the deployed Linux function fails to load
 * skia.linux-<arch>-gnu.node and the Shueisha OCR parser dies at
 * runtime. Vendoring the Linux binding here lets the
 * `./node_modules/@napi-rs/**` tracing include in next.config.ts pick
 * it up. Prebuilt functions keep the build machine's CPU architecture,
 * so the binding for `process.arch` is the one the runtime will load.
 * On Vercel's own Linux builders npm installs it natively and this
 * script is a no-op.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function linuxBindingPackage(arch) {
  return `@napi-rs/canvas-linux-${arch}-gnu`;
}

export function linuxBindingFile(arch) {
  return `skia.linux-${arch}-gnu.node`;
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const canvasVersion = JSON.parse(
    fs.readFileSync(path.join(root, "node_modules/@napi-rs/canvas/package.json"), "utf8"),
  ).version;
  const pkg = linuxBindingPackage(process.arch);
  const bindingFile = linuxBindingFile(process.arch);
  const destDir = path.join(root, "node_modules", pkg);
  const bindingPath = path.join(destDir, bindingFile);

  if (fs.existsSync(bindingPath)) {
    const installed = JSON.parse(fs.readFileSync(path.join(destDir, "package.json"), "utf8")).version;
    if (installed === canvasVersion) {
      console.log(`[ensure-canvas-linux-binding] ${pkg}@${installed} already present`);
      return;
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-linux-"));
  const tarball = execFileSync(
    "npm",
    ["pack", `${pkg}@${canvasVersion}`, "--pack-destination", tmp],
    { encoding: "utf8" },
  ).trim().split("\n").pop();
  const unpackDir = path.join(tmp, "unpacked");
  fs.mkdirSync(unpackDir);
  execFileSync("tar", ["-xzf", path.join(tmp, tarball), "-C", unpackDir]);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(path.join(unpackDir, "package"), destDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!fs.existsSync(bindingPath)) {
    throw new Error(`[ensure-canvas-linux-binding] ${bindingFile} missing after vendoring ${pkg}@${canvasVersion}`);
  }
  console.log(`[ensure-canvas-linux-binding] vendored ${pkg}@${canvasVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
