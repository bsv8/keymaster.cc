import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.spec.ts",
      "apps/**/*.test.ts",
      "apps/**/*.spec.ts"
    ],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
