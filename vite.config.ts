import react from "@vitejs/plugin-react";
import appPackage from "./package.json";
import { defineConfig, type Plugin } from "vite";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const appVersion = appPackage.version;
const storagePrivateGrant = randomBytes(32).toString("hex");
/** Vite preview 不读取 Pages 的 `_headers` 文件；仅给真实媒体 SW 补部署响应头。 */
function msFilePreviewHeaders(): Plugin {
  return {
    name: "keymaster-msfile-preview-headers",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        response.setHeader("X-Frame-Options", "DENY");
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
    __KEYMASTER_PRODUCT_SERVICES__: "true",
    __KEYMASTER_STORAGE_PRIVATE_GRANT__: JSON.stringify(storagePrivateGrant),

  },
  // 应用使用 history 路由。资源必须从站点根路径加载；相对 URL 会在
  // `/settings/system-status` 等深层路由被解析为 `/settings/_static/*`。
  base: "/",
  plugins: [
    react(),
    injectAppVersionMeta(),
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
      // public/_headers 为 Pages 提供同一响应头。
      "Service-Worker-Allowed": "/",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  },
  resolve: {
    alias: {
      // WebLoom 在开发阶段通过 link 接入；所有 React Hook 必须解析到
      // Keymaster 应用的同一份 React，避免 peer 依赖产生第二份 dispatcher。
      react: new URL("./node_modules/react", import.meta.url).pathname,
      // `keymaster-multisig-pool` 当前发布包直接 import Node `crypto`。
      // 浏览器构建只补它实际用到的 `createHmac` 最小能力，不引入整套 polyfill。
      // 用通用全局 URL 取绝对路径，避免依赖 node:url（本项目不引入 node 类型）。
      crypto: new URL("./src/shims/crypto.ts", import.meta.url).pathname
    },
    dedupe: ["react", "react-dom"],
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
