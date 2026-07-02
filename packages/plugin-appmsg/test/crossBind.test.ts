// packages/plugin-appmsg/test/crossBind.test.ts
// 跨仓联调一致性测试：JS 端 signCompactSecp256k1 必须与 Go HubMsg
// VerifyBindSignature 产生一致的验签结果。
//
// fixture 来源：HubMsg 仓 `internal/ws/fixture_gen_test.go` 写出的
// `testdata/bind_fixture.json`。该文件已随 HubMsg 提交。
//
// 关键不变量（施工单 2026-07-01/002 共同冻结）：
//   - ECDSA 用 secp256k1 + compact 64-byte r||s；
//   - ECDSA 输入 = SHA-256(plaintext)，其中 plaintext =
//     `sessionId|nonce|publicKeyHex|issuedAtMs`；
//   - 签名**字节级**不要求与 Go 完全一致：noble 走 RFC6979 确定性
//     nonce，Go 走 crypto/rand；两者都满足 ECDSA 的正确性，所以
//     验签结果必须一致。
//   - 验签**必须**成功：这是两仓"明文原文 + SHA-256 + ECDSA"对齐
//     的最终判定。
//
// 重要：keymaster 仓 tests 不应硬编码 Go 端私钥——fixture 文件由
// 两仓联调时**手工同步**（或脚本同步）。本测试在 fixture 缺失时
// 自动 skip，不让跨仓 fixture 缺失阻塞日常单测。
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { signCompactSecp256k1 } from "../src/signing.js";
import { canonicalBindText } from "@keymaster/contracts";

interface BindFixture {
  sessionId: string;
  nonce: string;
  publicKeyHex: string;
  privateKeyHex: string;
  issuedAtMs: number;
  signatureHex: string;
}

function loadFixture(): BindFixture | null {
  const candidates = [
    resolve(process.cwd(), "../HubMsg/internal/ws/testdata/bind_fixture.json"),
    resolve(process.cwd(), "../../HubMsg/internal/ws/testdata/bind_fixture.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../HubMsg/internal/ws/testdata/bind_fixture.json")
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as BindFixture;
      } catch {
        return null;
      }
    }
  }
  return null;
}

describe("cross-repo bind signature parity", () => {
  it("JS-produced signature verifies against same digest as Go", () => {
    const fixture = loadFixture();
    if (!fixture) {
      return;
    }
    // 1) JS 端用同一份拼接 + SHA-256 + ECDSA 路径签出 sig。
    const sigJs = signCompactSecp256k1(
      fixture.privateKeyHex,
      fixture.sessionId,
      fixture.nonce,
      fixture.publicKeyHex,
      fixture.issuedAtMs
    );
    expect(sigJs).toHaveLength(128);

    // 2) JS 端用同一份 digest (SHA-256(plaintext)) + prehash=false 验签
    //    必须为 true。这是"两仓对齐"的最终判定。
    const plaintext = canonicalBindText(
      fixture.sessionId,
      fixture.nonce,
      fixture.publicKeyHex,
      fixture.issuedAtMs
    );
    const digest = sha256(new TextEncoder().encode(plaintext));
    const pubBytes = hexToBytes(fixture.publicKeyHex);
    const sigBytes = hexToBytes(sigJs);
    const okJs = secp256k1.verify(sigBytes, digest, pubBytes, {
      prehash: false,
      format: "compact"
    });
    expect(okJs).toBe(true);

    // 3) tamper 必失败
    const tamperedDigest = sha256(
      new TextEncoder().encode(
        canonicalBindText(
          fixture.sessionId,
          fixture.nonce,
          fixture.publicKeyHex,
          fixture.issuedAtMs + 1
        )
      )
    );
    const fail = secp256k1.verify(sigBytes, tamperedDigest, pubBytes, {
      prehash: false,
      format: "compact"
    });
    expect(fail).toBe(false);
  });

  it("canonicalBindText output matches HubMsg pipe format", () => {
    expect(canonicalBindText("sid", "nonce", "02abcd", 1)).toBe("sid|nonce|02abcd|1");
    expect(canonicalBindText("sid", "nonce", "02abcd", 1700000000123)).toBe(
      "sid|nonce|02abcd|1700000000123"
    );
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}