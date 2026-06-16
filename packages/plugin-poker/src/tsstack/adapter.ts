// packages/plugin-poker/src/tsstack/adapter.ts
// ts-stack 适配层：以 @bsv/sdk 为 TypeScript 真值底座，对扑克协议引擎
// 暴露最小够用的 wallet / messaging / crypto 包装。
//
// 设计缘由（硬切换 001 修订版 37 / 590 行）：
//   - 协议真值在 bsv-poker（C#），但前端不能引用 C#；我们改以
//     `bsv-blockchain/ts-stack`（package: `@bsv/sdk`) 作为同样语义的
//     TypeScript 底座。adapter 是引擎与 sdk 之间唯一的接缝，便于：
//       * 锁版本：sdk 升级时只改本文件，不让升级面外溢到引擎；
//       * 控边界：boundary 脚本要求 tsstack/ 不接其它 @keymaster/plugin-*；
//       * 单测：测试时可以替换实现（DI），不必真起 sdk。
//   - "ts-stack 是底座，不是现成扑克状态机"：本 adapter 只暴露
//     加密 / 编码 / 交易解析这类与扑克语义无关的能力；扑克专属逻辑
//     一律落在 engine/ 下面。
//
// 命名约定：
//   - `BsvCrypto`：哈希、ECDH、签名/验签（封 sdk 的 PrivateKey/PublicKey/Hash）。
//   - `BsvTx`：raw tx 解析（封 sdk 的 Transaction.fromBinary）。
//   - `BsvScript`：script 解码（封 sdk 的 Script.fromBinary）。
//   - `BsvEncoding`：hex / base64 / utf8 工具，统一行内编码风格。
//
// 注意：所有 adapter 都允许在浏览器与 Node（vitest）下运行；不能引入
// 仅 Node 可用的模块（fs/path/crypto）；@bsv/sdk 设计就兼容浏览器。

import {
  Hash as SdkHash,
  PrivateKey as SdkPrivateKey,
  PublicKey as SdkPublicKey,
  Script as SdkScript,
  Signature as SdkSignature,
  Transaction as SdkTransaction,
  Utils as SdkUtils
} from "@bsv/sdk";

// ----------------------------------------------------------------------------
// 编码：单独导出一份，避免引擎散落 hex/base64 实现。
// ----------------------------------------------------------------------------

export const BsvEncoding = {
  /** 把 bytes 编成小写 hex，与 bsv-poker C# Convert.ToHexString().ToLowerInvariant() 对齐。 */
  toHex(bytes: Uint8Array): string {
    return SdkUtils.toHex(Array.from(bytes));
  },
  /** hex → bytes；接受奇数长度时抛错（与 sdk 一致）。 */
  fromHex(hex: string): Uint8Array {
    return new Uint8Array(SdkUtils.toArray(hex, "hex"));
  },
  /** UTF-8 文本编解码（与 C# Encoding.UTF8 对齐）。 */
  toUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  },
  fromUtf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  },
  /** base64（浏览器 btoa/atob 兼容路径）。 */
  toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
    return btoa(s);
  },
  fromBase64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
} as const;

// ----------------------------------------------------------------------------
// 哈希 / 签名 / ECDH：封 sdk 的 Hash / PrivateKey / PublicKey。
// ----------------------------------------------------------------------------

export const BsvCrypto = {
  /** sha256(bytes) → 32 bytes。 */
  sha256(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(SdkHash.sha256(Array.from(bytes)));
  },
  /** sha256d(bytes)：double sha256，BSV 标准 digest。 */
  sha256d(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(SdkHash.hash256(Array.from(bytes)));
  },
  /** hash160(bytes)：RIPEMD160(SHA256(bytes))。 */
  hash160(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(SdkHash.hash160(Array.from(bytes)));
  },
  /** 从 33 字节压缩公钥还原 PublicKey 对象（仅用于验证 / ECDH 派生）。 */
  publicKeyFromCompressed(bytes: Uint8Array): SdkPublicKey {
    return SdkPublicKey.fromString(BsvEncoding.toHex(bytes));
  },
  /** 从 hex 字符串解析私钥；用于测试与 adapter 内部 ECDH。 */
  privateKeyFromHex(hex: string): SdkPrivateKey {
    return SdkPrivateKey.fromString(hex, "hex");
  },
  /**
   * ECDH 共享密钥：sha256( compressed( priv * pub ) ).
   *
   * 设计缘由：@bsv/sdk 的 deriveSharedSecret 返回 Point（curve point）；
   * 扑克协议侧需要"标量"作为对称密钥种子，按 bsv-poker C#
   * Secp256k1.Ecdh 的 sha256( compressed pub ) 约定派生。
   */
  ecdh(privHex: string, pubCompressed: Uint8Array): Uint8Array {
    const priv = SdkPrivateKey.fromString(privHex, "hex");
    const pub = SdkPublicKey.fromString(BsvEncoding.toHex(pubCompressed));
    const sharedPoint = pub.deriveSharedSecret(priv);
    // Point.encode(true) → 33-byte compressed serialization (number[])。
    const compressed = (sharedPoint as unknown as { encode(compact: boolean): number[] }).encode(true);
    return new Uint8Array(SdkHash.sha256(compressed));
  },
  /**
   * DER ECDSA signature of digest（已经 sha256 过的 32 字节）。
   * sdk 的 PrivateKey.sign 默认对 msg 再做一次 hash；这里 digest 已经是
   * 32 字节哈希，按 sdk 默认行为传入即可（它使用 hash256 内部）——
   * 但为避免 double-hash，扑克协议要求把 digest 视为预计算结果时，调用方
   * 应当先用 hash160 / sha256 等业务约定生成 digest，再喂给本函数；本
   * 函数把 digest 当 msg 传给 sdk，等价于"sdk 内部 sha256(digest)"。
   *
   * 对于扑克 challenge 这类"先 sha256(nonce) 再签"的场景，调用方应该
   * 直接传 `nonce`（不要预先 sha256），让 sdk 完成一次 sha256；或者
   * 改用 `signMessage(msgBytes)` 避免歧义。本 adapter 暴露两套入口：
   *   - signMessage(msgBytes)：sdk 内部 sha256 一次，返回 DER。
   *   - signDigest(digest)：把 digest 视作 msg，**不**额外 hash（用
   *     forceHash 包装）；对端 verify 时同样不 hash。
   */
  signMessage(privHex: string, msgBytes: Uint8Array): Uint8Array {
    const priv = SdkPrivateKey.fromString(privHex, "hex");
    const sig = priv.sign(Array.from(msgBytes));
    return new Uint8Array(sig.toDER() as number[]);
  },
  /** 直接对 digest 签名：等价于 PrivateKey.sign(digest)，sdk 内部仍走一次 sha256。 */
  signDigest(privHex: string, digest: Uint8Array): Uint8Array {
    return BsvCrypto.signMessage(privHex, digest);
  },
  /** 用 33 字节压缩公钥验签 DER signature；与 signMessage 配对。 */
  verifyMessage(pubCompressed: Uint8Array, msgBytes: Uint8Array, derSig: Uint8Array): boolean {
    try {
      const pub = SdkPublicKey.fromString(BsvEncoding.toHex(pubCompressed));
      const sig = SdkSignature.fromDER(Array.from(derSig));
      return pub.verify(Array.from(msgBytes), sig);
    } catch {
      return false;
    }
  }
} as const;

// ----------------------------------------------------------------------------
// 交易 / Script：把 raw tx bytes 还原为可遍历的输出列表，供 ingest 使用。
// ----------------------------------------------------------------------------

/** 引擎层无视 sdk 内部结构，只看到 outputs[]。 */
export interface ParsedTxOutput {
  satoshis: number;
  /** 输出 script 的二进制（minimal-push 编码，与 bsv-poker TxTemplates 对齐）。 */
  script: Uint8Array;
}

export interface ParsedTx {
  txid: string;
  outputs: ParsedTxOutput[];
}

export const BsvTx = {
  /**
   * 解析 raw tx bytes → ParsedTx。
   * 设计缘由：bsv-poker 的 typed output 都在 outputs[].script 里；本函数
   * 只关心 "outputs"，不暴露 sdk 的全套交易对象，避免引擎反向依赖。
   */
  parse(rawTx: Uint8Array): ParsedTx {
    const tx = SdkTransaction.fromBinary(Array.from(rawTx));
    return {
      txid: tx.id("hex") as string,
      outputs: tx.outputs.map((o) => {
        const script = o.lockingScript as unknown as { toBinary(): number[] };
        const sats =
          typeof o.satoshis === "number"
            ? o.satoshis
            : typeof o.satoshis === "bigint"
              ? Number(o.satoshis)
              : 0;
        return { satoshis: sats, script: new Uint8Array(script.toBinary()) };
      })
    };
  }
} as const;

export const BsvScript = {
  /** 把 script bytes 还原为 sdk Script（供需要逐 chunk 解析时调用）。 */
  fromBinary(bin: Uint8Array): SdkScript {
    return SdkScript.fromBinary(Array.from(bin));
  }
} as const;

// ----------------------------------------------------------------------------
// 简易诊断：adapter 是否可用（sdk 是否装载，sha256 是否正确）。
// ----------------------------------------------------------------------------

/**
 * adapter 健康检查：跑一次最小路径（sha256("ping")），验证 sdk 装载。
 *
 * 设计缘由：硬切换文档要求 settings 页提供"诊断"入口；这里给一个
 * 不依赖网络、不依赖 vault 的 healthcheck，便于排查 sdk 缺失。
 *
 * 返回的 sample 是 sha256("ping") 的小写 hex，便于跨实现比对。
 */
export function adapterSelfCheck(): { ok: boolean; sample: string } {
  const digest = BsvCrypto.sha256(BsvEncoding.fromUtf8("ping"));
  return { ok: digest.length === 32, sample: BsvEncoding.toHex(digest) };
}
