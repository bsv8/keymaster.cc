import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // 兼容依赖 jsdom 的 React 组件测试：按项目拆分环境，避免继续依赖
    // 已弃用的 environmentMatchGlobs。
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/**/*.test.ts",
            "packages/**/*.spec.ts",
            "apps/**/*.test.ts",
            "apps/**/*.spec.ts"
          ]
        }
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: [
            "packages/**/*.test.tsx",
            "packages/**/*.spec.tsx",
            "apps/**/*.test.tsx",
            "apps/**/*.spec.tsx"
          ]
        }
      }
    ]
  }
});
