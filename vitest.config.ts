import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "packages/**/*.spec.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "apps/**/*.spec.ts"
    ],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
