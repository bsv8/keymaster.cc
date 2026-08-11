import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const heavyFiles = new Set([
  "apps/web/src/keymasterSessionCoordinator.worker.test.ts",
  "packages/plugin-vault/src/vaultService.test.ts"
]);
const batchSize = 12;

function runVitest(args) {
  const result = spawnSync("pnpm", ["exec", "vitest", ...args], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const listed = spawnSync("pnpm", ["exec", "vitest", "list", "--json", "--filesOnly"], {
  cwd: root,
  encoding: "utf8"
});
if (listed.error) throw listed.error;
if (listed.status !== 0) process.exit(listed.status ?? 1);

const entries = JSON.parse(listed.stdout);
if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.file !== "string")) {
  throw new Error("Vitest list returned an invalid file manifest");
}
const files = entries.map((entry) => {
  const file = relative(root, resolve(entry.file));
  if (!file || file.startsWith("..") || file.includes("\\")) {
    throw new Error(`Vitest listed a file outside the repository: ${entry.file}`);
  }
  return file;
});
const uniqueFiles = new Set(files);
if (uniqueFiles.size !== files.length) {
  throw new Error("Vitest list returned duplicate test files");
}

const regular = files.filter((file) => !heavyFiles.has(file));
const heavy = files.filter((file) => heavyFiles.has(file));
if (heavy.length !== heavyFiles.size) {
  throw new Error(`Expected heavy test files were not discovered (${heavy.join(", ")})`);
}

const batches = [];
for (let index = 0; index < regular.length; index += batchSize) {
  batches.push(regular.slice(index, index + batchSize));
}
for (const batch of batches) runVitest(["run", ...batch]);
for (const file of heavy) runVitest(["run", file]);

const executed = [...batches.flat(), ...heavy];
if (executed.length !== files.length || new Set(executed).size !== files.length) {
  throw new Error("Vitest batch plan did not execute every discovered file exactly once");
}
console.log(`Vitest batch plan passed: ${files.length} files (${batches.length} regular batches + ${heavy.length} isolated heavy files)`);
