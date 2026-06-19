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
    exclude: ["**/node_modules/**", "**/dist/**"],
    // 兼容依赖 jsdom 的 React 组件测试：默认 node，
    // 组件测试用 `// @vitest-environment jsdom` 注释按文件覆盖。
    environmentMatchGlobs: [
      ["packages/**/*.test.tsx", "jsdom"],
      ["apps/**/*.test.tsx", "jsdom"]
    ]
  }
});
