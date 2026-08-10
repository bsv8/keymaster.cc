import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const smokeEnvDirectory = fileURLToPath(new URL("./.storage-smoke/", import.meta.url));
const smokeFileEnv = loadEnv("storage-smoke", smokeEnvDirectory, "KEYMASTER_STORAGE_SMOKE_");

// Explicit shell/CI variables take precedence over the developer-only file.
// Only the Storage smoke prefix is loaded so unrelated local values never enter
// the test process through this directory.
for (const [name, value] of Object.entries(smokeFileEnv)) {
  if (process.env[name] === undefined) process.env[name] = value;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/plugin-storage/src/s3ProviderSmoke.ts"]
  }
});
