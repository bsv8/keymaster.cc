// packages/plugin-vault/src/keyIdentity.ts
// 公钥身份工具：派生 compressed public key、计算 publicKeyHash、生成短 fingerprint。
// 设计缘由：
//   - 平台公开的 key 身份只能来自公钥（publicKeyHex / publicKeyHash / fingerprint），
//     不使用私钥、地址或网络作为根 id。
//   - 本模块不保存私钥、不打开 P2PKH DB、不派生网络地址。
//   - publicKeyHash 取 sha256(compressed public key) 的 hex；这样可以稳定跨插件
//     表达"同一把 key"。
//   - 重复导入同一 publicKeyHash 时，vault 必须拒绝并给出英文错误信息。
//
// 硬切换 002：本模块同时承担"在 Vault 内部安全生成 secp256k1 私钥"的
// 局部职责。私钥字节由 noble secp256k1 的 randomPrivateKey 生成，调用方
// （vaultService.generateKey）只接收 hex 字符串并立即按 importPrivateKey
// 一样的加密流程写入 vault；不在 React state、MessageBus 或 IndexedDB
// 普通字段中保留明文。

import { sha256 } from "@noble/hashes/sha256";
import { getPublicKey, utils as secp256k1Utils } from "@noble/secp256k1";

/** 派生公钥身份。 */
export interface KeyIdentityFields {
  publicKeyHex: string;
  publicKeyHash: string;
  fingerprint: string;
}

/** 从 32 字节私钥派生公钥身份。 */
export function deriveKeyIdentity(privateKeyHex: string): KeyIdentityFields {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) throw new Error("Private key must be 32 bytes");
  const pub = getPublicKey(priv, true);
  const publicKeyHex = bytesToHex(pub);
  const publicKeyHash = bytesToHex(sha256(pub));
  const fingerprint = makeFingerprint(publicKeyHash);
  return { publicKeyHex, publicKeyHash, fingerprint };
}

/** 从公钥 hex 计算 identity。用于 import 时没有私钥（如备份导入解析中）的兜底。 */
export function identityFromPublicKeyHex(publicKeyHex: string): KeyIdentityFields {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 33) throw new Error("Public key must be 33 bytes (compressed)");
  const publicKeyHash = bytesToHex(sha256(pub));
  const fingerprint = makeFingerprint(publicKeyHash);
  return { publicKeyHex, publicKeyHash, fingerprint };
}

/**
 * 在 Vault 内部生成合法的 32 字节 secp256k1 私钥，并返回 lowercase hex。
 *
 * 设计缘由（硬切换 002）：
 *   - 使用 noble secp256k1 的 `utils.randomPrivateKey()`，其内部走
 *     `crypto.getRandomValues`，符合密码学安全随机源要求。
 *   - 不使用 `Math.random()`、时间戳、UUID、用户输入或 hash 拼私钥。
 *   - 字节数组由调用方（vaultService.generateKey）立即在闭包内消费，
 *     不会出现在返回 heap 上：本函数只返回 hex 字符串，调用结束后
 *     引用链断开由 GC 回收。
 *   - 不派生地址、不写 IndexedDB。地址与持久化由 vaultService 负责。
 */
export function generatePrivateKeyHex(): string {
  const priv = secp256k1Utils.randomPrivateKey();
  return bytesToHex(priv);
}

/**
 * 短展示指纹：取 publicKeyHash 前后 4 字节拼成 8 字符 base16。
 * 设计缘由：key switch widget 顶栏只显示短指纹，hash 全长太占地方。
 */
export function makeFingerprint(publicKeyHash: string): string {
  if (publicKeyHash.length < 8) throw new Error("publicKeyHash too short");
  return `${publicKeyHash.slice(0, 4)}…${publicKeyHash.slice(-4)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
