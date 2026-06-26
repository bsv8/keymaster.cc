// apps/web/src/shims/crypto.ts
// 浏览器侧最小 `crypto` 兼容层。
//
// 设计缘由：
//   - `keymaster-multisig-pool` 当前发布包直接 `import { createHmac } from "crypto"`，
//     这会让 Vite 在浏览器构建时把 Node builtin `crypto` externalize 掉并报错。
//   - 该包在当前项目里只实际用到了 `createHmac("sha256").update(...).digest()` 这一条链。
//   - 因此这里不做"完整 Node crypto polyfill"，只补当前依赖链必需的最小同步 API，
//     避免把问题扩展成一整套浏览器 Node 兼容工程。

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { Buffer } from "buffer";

type BinaryLike = string | ArrayBuffer | ArrayBufferView;

function toBytes(input: BinaryLike): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Unsupported binary input");
}

export function createHmac(algorithm: string, key: BinaryLike) {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new Error(`Unsupported hmac algorithm: ${algorithm}`);
  }

  const chunks: Uint8Array[] = [];
  return {
    update(data: BinaryLike) {
      chunks.push(toBytes(data));
      return this;
    },
    digest(encoding?: BufferEncoding) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const out = Buffer.from(hmac(sha256, toBytes(key), joined));
      if (encoding) {
        return out.toString(encoding);
      }
      return out;
    }
  };
}

