// vitest.setup.ts：为 node 环境注入 fake-indexeddb + 浏览器 API shim。
// 设计缘由：plugin-p2pkh / plugin-woc 大量依赖浏览器 API（indexeddb、fetch、
// localStorage、AbortController、navigator.locks）。在 node 单测里需要
// fake-indexeddb 替代真 indexeddb，并自己 mock fetch / navigator.locks。

import "fake-indexeddb/auto";
import * as secp from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

// @noble/secp256k1 v2 需要同步 hmac。
(secp.etc as { hmacSha256Sync: (k: Uint8Array, ...m: Uint8Array[]) => Uint8Array }).hmacSha256Sync = (
  k: Uint8Array,
  ...m: Uint8Array[]
) => hmac(sha256, k, secp.etc.concatBytes(...m));

// localStorage / BroadcastChannel 在 node 中不存在，提供最简实现。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
if (typeof (globalThis as { localStorage?: Storage }).localStorage === "undefined") {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
}
if (typeof (globalThis as { sessionStorage?: Storage }).sessionStorage === "undefined") {
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage();
}
if (typeof (globalThis as { fetch?: unknown }).fetch === "undefined") {
  (globalThis as { fetch: typeof fetch }).fetch = (() => {
    throw new Error("fetch not mocked; use vi.fn() to override");
  }) as never;
}

