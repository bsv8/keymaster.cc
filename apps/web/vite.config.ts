import react from "@vitejs/plugin-react";
import appPackage from "../../package.json";
import { defineConfig } from "vite";

const appVersion = appPackage.version;
const MSFILE_E2E_VIRTUAL_ID = "virtual:keymaster-msfile-e2e-hooks";
const MSFILE_E2E_RESOLVED_ID = `\0${MSFILE_E2E_VIRTUAL_ID}`;

/**
 * E2E hook 含测试 Vault/session 注入能力，不能仅靠运行时 if 隐藏。
 * 普通构建把 virtual module 解析为空实现，从模块图上就不引用
 * windowHooks.ts；只有显式 VITE_MSFILE_E2E=1 的隔离构建才引入它。
 */
function msFileE2EVirtualModule(): { name: string; resolveId(id: string): string | undefined; load(id: string): string | undefined } {
  const enabled = process.env.VITE_MSFILE_E2E === "1";
  return {
    name: "keymaster-msfile-e2e-virtual-module",
    resolveId(id) {
      return id === MSFILE_E2E_VIRTUAL_ID ? MSFILE_E2E_RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== MSFILE_E2E_RESOLVED_ID) return undefined;
      return enabled
        ? 'export { installMsFileProductionE2EHooks } from "/src/msfileE2E/windowHooks.ts";'
        : 'export function installMsFileProductionE2EHooks() { throw new Error("MSFile E2E hooks are excluded from this build"); }';
    }
  };
}

function injectAppVersionMeta(): { name: string; transformIndexHtml: (html: string) => string } {
  return {
    name: "keymaster-version-meta",
    transformIndexHtml(html) {
      return html.replace(
        /(<meta name="keymaster:version" content=")[^"]*("\s*\/>)/,
        `$1${appVersion}$2`
      );
    }
  };
}

export default defineConfig({
  // 应用使用 history 路由。资源必须从站点根路径加载；相对 URL 会在
  // `/settings/system-status` 等深层路由被解析为 `/settings/_static/*`。
  base: "/",
  plugins: [react(), injectAppVersionMeta(), msFileE2EVirtualModule()],
  build: {
    // 设计缘由：
    //   - 应用本身已经占用了业务路由 `/assets`（plugin-assets）。
    //   - Vite 默认把构建产物发到 `/assets/*`，部署到 Cloudflare Pages 时，
    //     这会让"业务路由前缀"与"静态资源前缀"同名，排障与规则配置都别扭。
    //   - 改成独立静态前缀后，Pages 上的资源路径会是 `/_static/*`，
    //     与应用路由彻底解耦。
    assetsDir: "_static",
    // 设计缘由：当前首包稳定略高于 Vite 默认 500 kB，项目初期先以降低构建噪音为主，
    // 暂不引入额外分包策略；保留一个略高于现状的阈值，避免无效告警。
    chunkSizeWarningLimit: 1024
  },
  worker: {
    format: "es"
  },
  server: {
    // 只监听本机地址，外部访问统一通过 Tailscale HTTPS 转发到 localhost。
    host: "127.0.0.1",
    // 允许所有主机访问 dev server（避免需要逐个添加域名到白名单）。
    allowedHosts: true
  },
  resolve: {
    alias: {
      // `keymaster-multisig-pool` 当前发布包直接 import Node `crypto`。
      // 浏览器构建只补它实际用到的 `createHmac` 最小能力，不引入整套 polyfill。
      // 用通用全局 URL 取绝对路径，避免依赖 node:url（本项目不引入 node 类型）。
      crypto: new URL("./src/shims/crypto.ts", import.meta.url).pathname
    },
    // 让 Vite 直接消费 packages/* 源码（与 tsc 行为一致）。
    preserveSymlinks: false
  },
  optimizeDeps: {
    include: [
      "@noble/hashes/ripemd160",
      "@noble/hashes/sha256",
      "@noble/hashes/argon2",
      "@noble/ciphers/chacha.js",
      "@noble/secp256k1"
    ]
  }
});
