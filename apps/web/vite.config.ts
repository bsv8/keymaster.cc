import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const tailscaleHost = "usops01.degu-danio.ts.net";

export default defineConfig({
  plugins: [react()],
  build: {
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
