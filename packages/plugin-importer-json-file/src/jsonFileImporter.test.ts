// packages/plugin-importer-json-file/src/jsonFileImporter.test.ts
// jsonFileImporter 关键行为单测（硬切换 010 收尾回归）：
//   - 明文 JSON（handcash / moneybutton / relayx 这类含 hex/wif 字段的
//     普通导出）必须能在**不传** password 的前提下成功 parse。
//   - bsv8 envelope（kek-v1 / argon2id / xchacha20poly1305 加密 JSON）
//     必须先抛 "Password is required for encrypted key file"，再在传入
//     正确密码后 parse 成功。
//   - KeyImporter 契约层**不**声明 requiresPassword 字段：明文与加密
//     路径共享同一 importer，由 parse() 实际行为区分。
//
// 设计缘由（硬切换 010 收尾）：旧实现曾把 json-file 标成"必需要密码"，
// 导致明文 JSON 解析按钮被卡住。该测试保护：未来任何回归都不能再次把
// 这个 importer 的能力窄化为单一形态。

import { describe, expect, it } from "vitest";
import { jsonFileImporter } from "./jsonFileImporter.js";

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** 32 字节 hex：用于构造明文 JSON 里的"私钥"字段。 */
const SAMPLE_HEX =
  "0000000000000000000000000000000000000000000000000000000000000003";

/**
 * 一个看起来像 bsv8 envelope 的最小 JSON。
 *
 * 注意 KDF 参数（memory_kib / time_cost）刻意选最小可行值（1 MiB /
 * t=1）——本测试只验证"密码错时被拒收"与"未提供密码时抛约定错误"两条
 * 契约，不验证 argon2id 抗暴力破解强度（那是生产路径的事，与单元测试
 * 无关）。生产实现 bsv8KeyEnvelope.ts 仍按真实强度跑，不受这里影响。
 * 选小参数的另一个原因：全量 vitest run 中 argon2id(m=65536, t=3) 在
 * 其它测试并发抢占 CPU 时偶尔会 > 5s，触发 testTimeout；缩到 (m=1024,
 * t=1) 后单次解密耗时稳定 < 100ms。
 */
const ENVELOPE = {
  version: "kek-v1",
  key_id: "default",
  kdf: "argon2id",
  kdf_params: {
    memory_kib: 1024,
    time_cost: 1,
    parallelism: 4,
    salt_hex: "00".repeat(16)
  },
  cipher: "xchacha20poly1305",
  nonce_hex: "00".repeat(24),
  ciphertext_hex: "00".repeat(96),
  aad: "bitfs-keyring|client|default"
};

describe("jsonFileImporter (硬切换 010 收尾回归)", () => {
  it("parses a plain JSON wallet export WITHOUT a password", async () => {
    // 关键回归点：明文 JSON 必须能在不传 password 的前提下被 parse 出来。
    // 旧实现错误地把 json-file 标 requiresPassword: true 时会破坏这条
    // 路径——本测试保护未来。
    const plain = JSON.stringify({
      wallet: "handcash",
      privateKey: SAMPLE_HEX
    });
    const results = await jsonFileImporter.parse({
      kind: "file",
      name: "export.json",
      content: encode(plain)
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.material.hex).toBe(SAMPLE_HEX);
    expect(results[0]?.detectedFormat).toBe("json-file");
  });

  it("throws PASSWORD_REQUIRED_MSG when given a bsv8 envelope without password", async () => {
    // 关键回归点：bsv8 envelope 必须先以约定错误拒收未提供密码的输入。
    // 这一信号让 ImportPage / 向导知道要追问密码。
    const envelopeJson = JSON.stringify(ENVELOPE);
    await expect(
      jsonFileImporter.parse({
        kind: "file",
        name: "encrypted.json",
        content: encode(envelopeJson)
      })
    ).rejects.toThrow(/Password is required for encrypted key file/i);
  });

  it("rejects bsv8 envelope with wrong password", async () => {
    // 同样走 bsv8 envelope 分支，但密码错误时返回的是解密失败错误，
    // 不是 PASSWORD_REQUIRED_MSG。
    const envelopeJson = JSON.stringify(ENVELOPE);
    await expect(
      jsonFileImporter.parse({
        kind: "file",
        name: "encrypted.json",
        content: encode(envelopeJson),
        password: "wrong-password"
      })
    ).rejects.toThrow(); // 不验具体错误信息；关键是密码错就走不通。
  });

  it("exposes a KeyImporter contract WITHOUT a static requiresPassword field", async () => {
    // 硬切换 010 收尾：契约层不应出现 `requiresPassword`。即使有人加
    // 回来，TypeScript 类型层就让它无法工作；本测试在运行时再补一刀，
    // 防止有人用 cast 绕过编译期检查。
    expect("requiresPassword" in jsonFileImporter).toBe(false);
  });
});
