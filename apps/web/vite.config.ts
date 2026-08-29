import react from "@vitejs/plugin-react";
import appPackage from "../../package.json";
import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appVersion = appPackage.version;
const MSFILE_E2E_VIRTUAL_ID = "virtual:keymaster-msfile-e2e-hooks";
const MSFILE_E2E_RESOLVED_ID = `\0${MSFILE_E2E_VIRTUAL_ID}`;
const MSFILE_SPIKE_VIRTUAL_ID = "virtual:keymaster-msfile-spike-hooks";
const MSFILE_SPIKE_RESOLVED_ID = `\0${MSFILE_SPIKE_VIRTUAL_ID}`;
const MSFILE_E2E_OLD_SW_PATH = fileURLToPath(new URL("../../e2e/fixtures/e2e-old-root-sw.js", import.meta.url));
const MSFILE_E2E_MISMATCH_SW_PATH = fileURLToPath(new URL("../../e2e/fixtures/e2e-mismatch-sw.js", import.meta.url));

/** 只在显式 E2E 构建产出旧 SW 模拟器，普通 dist 不包含测试控制器。 */
function msFileE2EOldServiceWorker(): Plugin {
  const enabled = process.env.VITE_MSFILE_E2E === "1";
  return {
    name: "keymaster-msfile-e2e-old-service-worker",
    generateBundle() {
      if (!enabled) return;
      this.emitFile({
        type: "asset",
        fileName: "e2e-old-root-sw.js",
        source: readFileSync(MSFILE_E2E_OLD_SW_PATH, "utf8"),
      });
    },
  };
}

/** 只在显式 E2E 构建产出协议不匹配模拟器，普通 dist 不包含测试控制器。 */
function msFileE2EMismatchServiceWorker(): Plugin {
  const enabled = process.env.VITE_MSFILE_E2E === "1";
  return {
    name: "keymaster-msfile-e2e-mismatch-service-worker",
    generateBundle() {
      if (!enabled) return;
      this.emitFile({
        type: "asset",
        fileName: "e2e-mismatch-sw.js",
        source: readFileSync(MSFILE_E2E_MISMATCH_SW_PATH, "utf8"),
      });
    },
  };
}

/** Vite preview 不读取 Pages 的 `_headers` 文件；仅给真实媒体 SW 补部署响应头。 */
function msFilePreviewHeaders(): Plugin {
  return {
    name: "keymaster-msfile-preview-headers",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname === "/msfile-media-sw.js") {
          response.setHeader("Content-Type", "application/javascript; charset=utf-8");
          response.setHeader("Service-Worker-Allowed", "/");
          response.setHeader("Cache-Control", "no-cache");
        }
        next();
      });
    },
  };
}

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

/**
 * 旧 executor spike 只在显式隔离构建中进入模块图；spikeMode.ts 的查询参数
 * 由下方 compile-time define 关闭，避免普通生产包保留旧控制器路径。
 */
function msFileSpikeVirtualModule(): Plugin {
  const enabled = process.env.VITE_MSFILE_SPIKE === "1";
  return {
    name: "keymaster-msfile-spike-virtual-module",
    resolveId(id) {
      if (id === MSFILE_SPIKE_VIRTUAL_ID) return MSFILE_SPIKE_RESOLVED_ID;
      return undefined;
    },
    load(id) {
      if (id === MSFILE_SPIKE_RESOLVED_ID) {
        return enabled
          ? 'export { installMsFileSpikeHooks } from "/src/msfileSpike/windowHooks.ts";'
          : "export function installMsFileSpikeHooks() {}";
      }
      return undefined;
    },
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
  define: {
    // 旧 spike 仅由 Playwright 的 VITE_MSFILE_SPIKE=1 隔离构建启用；普通
    // 生产包把该全局固定为 false，连同查询参数分支一起由构建器删除。
    __KEYMASTER_MSFILE_SPIKE__: JSON.stringify(process.env.VITE_MSFILE_SPIKE === "1"),
  },
  // 应用使用 history 路由。资源必须从站点根路径加载；相对 URL 会在
  // `/settings/system-status` 等深层路由被解析为 `/settings/_static/*`。
  base: "/",
  plugins: [
    react(),
    injectAppVersionMeta(),
    msFileE2EVirtualModule(),
    msFileSpikeVirtualModule(),
    msFileE2EOldServiceWorker(),
    msFileE2EMismatchServiceWorker(),
    msFilePreviewHeaders(),
  ],
  build: {
    rollupOptions: {
      // Service Worker 必须是站点根路径下的独立、稳定脚本，才能申请 `/`
      // scope。它不进入应用主 chunk，也不通过 SPA fallback 返回 index.html。
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        "msfile-media-sw": fileURLToPath(new URL("./src/msfileMediaServiceWorker.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "msfile-media-sw"
          ? "msfile-media-sw.js"
          : "_static/[name]-[hash].js",
        chunkFileNames: "_static/[name]-[hash].js",
        assetFileNames: "_static/[name]-[hash][extname]",
      },
    },
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
    allowedHosts: true,
    headers: {
      // 开发服务器从 /src 提供 module SW 时也允许根 scope；生产由
      // apps/web/public/_headers 为 Pages 提供同一响应头。
      "Service-Worker-Allowed": "/",
    },
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
