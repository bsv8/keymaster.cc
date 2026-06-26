import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const tailscaleHost = "usops01.degu-danio.ts.net";

export default defineConfig({
  plugins: [react()],
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
  server: {
    // 只监听本机地址，外部访问统一通过 Tailscale HTTPS 转发到 localhost。
    host: "127.0.0.1",
    // 允许 Tailscale HTTPS 反向代理使用该 Host 访问 dev server。
    allowedHosts: [tailscaleHost],
    // 设计缘由：页面通过 Tailscale HTTPS 5173 打开时，HMR 客户端也需要连接同一 HTTPS 端口。
    hmr: {
      host: tailscaleHost,
      protocol: "wss",
      clientPort: 5173
    }
  },
  resolve: {
    alias: {
      // `keymaster-multisig-pool` 当前发布包直接 import Node `crypto`。
      // 浏览器构建只补它实际用到的 `createHmac` 最小能力，不引入整套 polyfill。
      crypto: fileURLToPath(new URL("./src/shims/crypto.ts", import.meta.url))
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
