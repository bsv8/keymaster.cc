// Registry-only downstream smoke for the frozen WebLoom release boundary.
//
// This intentionally runs in a fresh temporary project. It must not resolve a
// workspace link, local tarball, or the current repository's node_modules.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "webloom-framework";
const releaseVersion = "0.3.0";
const registry = process.env.WEBLOOM_NPM_REGISTRY ?? process.env.npm_config_registry ?? "https://registry.npmjs.org/";
const root = mkdtempSync(join(tmpdir(), "keymaster-webloom-registry-consumer-"));

function runNpm(args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim().replace(/\s+/gu, " ");
    throw new Error(detail || `npm exited with ${String(result.status)}`);
  }
}

try {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "webloom-framework-registry-consumer-smoke",
    private: true,
    type: "module",
    dependencies: {
      [packageName]: releaseVersion,
      react: "18.3.1",
    },
  }, null, 2)}\n`);

  runNpm([
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry",
    registry,
  ]);
  runNpm([
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry",
    registry,
  ]);

  writeFileSync(join(root, "probe.mjs"), `
import * as core from "${packageName}";
import * as react from "${packageName}/react";
import * as testing from "${packageName}/testing";

if (typeof core.connectSharedWorker !== "function" || typeof core.createServiceBridge !== "function") {
  throw new Error("registry core entry does not expose the v2 call-first API");
}
if (typeof react.usePluginRuntime !== "function" || typeof testing.connectSharedWorkerForTesting !== "function") {
  throw new Error("registry subpath exports are incomplete");
}
`);
  execFileSync(process.execPath, [join(root, "probe.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`WebLoom registry consumer smoke passed: ${packageName}@${releaseVersion} from ${registry}`);
} catch (error) {
  console.error(`WebLoom registry consumer smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
