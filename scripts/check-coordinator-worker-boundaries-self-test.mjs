// Regression tests for check-coordinator-worker-boundaries.mjs.
//
// Every fixture is written below a fresh OS temporary directory. The real
// workspace source graph is never changed; the directory is removed in the
// finally block even when a fixture or child process fails.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checker = resolve(scriptDirectory, "check-coordinator-worker-boundaries.mjs");

const baseFiles = {
  "package.json": JSON.stringify({ name: "worker-boundary-fixture", private: true }),
  "apps/web/package.json": JSON.stringify({ name: "worker-boundary-fixture-web", private: true }),
  "node_modules/@keymaster/runtime/package.json": JSON.stringify({
    name: "@keymaster/runtime",
    exports: {
      ".": "./src/index.js",
      "./storage": "./src/storage/index.js",
    },
  }),
  "node_modules/@keymaster/runtime/src/index.js": "export const windowRuntime = true;\n",
  "node_modules/@keymaster/runtime/src/storage/index.js": "export const workerSafeRuntime = true;\n",
  "apps/web/src/keymasterSessionCoordinator.worker.ts": "export {};\n",
};

function runFixture(files) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "keymaster-worker-boundary-"));
  try {
    for (const [relativePath, content] of Object.entries({ ...baseFiles, ...files })) {
      const target = join(fixtureRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const result = spawnSync(process.execPath, [checker], {
      cwd: fixtureRoot,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGTERM",
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      spawnError: result.error,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function expectRejected(name, files, expectedText) {
  const result = runFixture(files);
  if (result.spawnError || result.status === 0 || !result.output.includes(expectedText)) {
    throw new Error(`${name} did not reject as expected (status=${String(result.status)}):\n${result.output}`);
  }
}

function expectAccepted(name, files) {
  const result = runFixture(files);
  if (result.spawnError || result.status !== 0) {
    throw new Error(`${name} was rejected unexpectedly (status=${String(result.status)}):\n${result.output}`);
  }
}

expectRejected(
  "side-effect Window runtime barrel",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'import "@keymaster/runtime";\n',
  },
  "never the Window runtime barrel",
);

expectRejected(
  "side-effect TSX module",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'import "./react-entry.tsx";\n',
    "apps/web/src/react-entry.tsx": "export const view = <div />;\n",
  },
  "Worker runtime reached a JSX module",
);

expectRejected(
  "side-effect React module",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'import "./react-side-effect.ts";\n',
    "apps/web/src/react-side-effect.ts": 'import "react";\n',
  },
  "Worker runtime code must not import react",
);

expectRejected(
  "non-static dynamic import",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'const suffix = "entry"; import("./" + suffix);\n',
  },
  "non-static dynamic import()",
);

expectRejected(
  "non-static require",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'const suffix = "entry"; require("./" + suffix);\n',
  },
  "non-static require()",
);

expectRejected(
  "non-static import-equals external module reference",
  {
    "apps/web/src/keymasterSessionCoordinator.worker.ts": 'const path = "./entry"; import dependency = require(path);\n',
  },
  "non-static import-equals external module reference",
);

expectAccepted("type-only and worker-safe graph", {
  "apps/web/src/keymasterSessionCoordinator.worker.ts": [
    'import type { FixtureType } from "./types.ts";',
    'import { workerSafeRuntime } from "@keymaster/runtime/storage";',
    'import "./worker-side-effect.ts";',
    'export async function load(): Promise<typeof workerSafeRuntime | FixtureType> {',
    '  return import("./worker-leaf.ts");',
    "}",
  ].join("\n"),
  "apps/web/src/types.ts": "export interface FixtureType { ok: true }\n",
  "apps/web/src/worker-side-effect.ts": "export const sideEffect = true;\n",
  "apps/web/src/worker-leaf.ts": "export const workerLeaf = true;\n",
});

// Keep this read so a future accidental empty/missing checker path fails with
// an explicit self-test error instead of silently testing another command.
if (!readFileSync(checker, "utf8").includes("Coordinator SharedWorker module boundary")) {
  throw new Error(`Boundary checker source is missing: ${checker}`);
}

console.log("Coordinator SharedWorker boundary self-test passed (side effects, dynamic edges, ImportEquals, and safe graph).");
