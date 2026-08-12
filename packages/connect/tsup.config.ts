import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.lib.json",
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  dts: {
    resolve: true,
    compilerOptions: {
      baseUrl: "../..",
      paths: {
        "@keymaster/contracts/connect-public": ["packages/contracts/src/connectPublic.ts"]
      }
    }
  },
  noExternal: ["@keymaster/contracts"],
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true
});
