// apps/web/src/shims/buffer.ts
// 浏览器运行时补 `Buffer` 全局。
//
// 设计缘由：
//   - `keymaster-multisig-pool` 发布包里直接使用全局 `Buffer`，没有显式 import。
//   - Vite 不会自动为浏览器注入 Node 的 Buffer。
//   - 这里在应用入口最早阶段挂一次 `globalThis.Buffer`，只覆盖当前依赖的运行时缺口。

import { Buffer } from "buffer";

declare global {
  interface Window {
    Buffer?: typeof Buffer;
  }
}

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

