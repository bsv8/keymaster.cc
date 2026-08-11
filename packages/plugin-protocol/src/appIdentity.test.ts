import { describe, expect, it } from "vitest";
import { isVerifiedAppIdentitySnapshot, verifyAppIdentityProof } from "./appIdentity.js";

describe("本地 catalog metadata snapshot", () => {
  const proof = {
    version: 1 as const,
    publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    app: { id: "stable-app-id", name: "Stable App", description: "Description" },
    requirements: [] as ("private-key" | "storage")[],
    signature: "ba7206e5617360697c0199ffdb3c82a2728b2e46a5b48b39d405ec65009bc3c34a3a91e0acf1f37ff88654a7a60d3f4da8532875d3f333859a22c8eb9feb7af7"
  };

  it("验证签名 proof 并生成稳定 digest snapshot", () => {
    expect(verifyAppIdentityProof(proof)).toMatchObject({ appId: "stable-app-id", appName: "Stable App" });
    expect(() => verifyAppIdentityProof({ ...proof, requirements: ["storage", "private-key"] })).toThrow();
  });
  const snapshot = {
    version: 1 as const,
    publisherPublicKeyHex: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    appId: "demo.app",
    appName: "Demo App",
    identityDigestHex: "aa".repeat(32)
  };

  it("接受已由 catalog 生成的 snapshot", () => {
    expect(isVerifiedAppIdentitySnapshot(snapshot)).toBe(true);
  });

  it("拒绝伪造/损坏的 snapshot", () => {
    expect(isVerifiedAppIdentitySnapshot({ ...snapshot, publisherPublicKeyHex: "02" + "11".repeat(32) })).toBe(false);
    expect(isVerifiedAppIdentitySnapshot({ ...snapshot, identityDigestHex: "not-hex" })).toBe(false);
    expect(isVerifiedAppIdentitySnapshot({ ...snapshot, appId: "Demo App" })).toBe(false);
  });

  it("跨实现固定向量：JCS proof 在 protocol verifier 中通过", () => {
    const fixture = {
      version: 1 as const,
      publisherPublicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      app: { id: "vite-fixture", name: "Vite Fixture", description: "Fixture" },
      requirements: ["storage"] as ("private-key" | "storage")[],
      signature: "217a8c1761de074dc3c1e6e90f31f00b09f54ecb87d9ba2b1e157570033777c4373fc0281c76466ab20d04bc231b61a52ae3681c08e11f021ae6955718c1cb17"
    };
    expect(verifyAppIdentityProof(fixture)).toMatchObject({ appId: "vite-fixture", appName: "Vite Fixture" });
  });
});
