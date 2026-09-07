import { defineConfig } from "vitest/config";

const rootReact = new URL("./node_modules/react", import.meta.url).pathname;

export default defineConfig({
  resolve: {
    // WebLoom 是 link 依赖，Vite 默认会从兄弟仓库解析它自己的 peer。
    // 测试环境必须把 React 合并到 Keymaster 的同一个实例，否则 ReactDOM
    // 与 webloom-framework/react 的 Hooks 会拿到不同 dispatcher。
    alias: {
      react: rootReact,
    },
    dedupe: ["react", "react-dom"],
  },
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
