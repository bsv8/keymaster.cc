import { describe, expect, it } from "vitest";
import { networkIdentityStorageRoot, sameNetworkIdentity, validateNetworkIdentity } from "./networkIdentity.js";
import { buildStorageNamespaceRoot } from "./storage/access.js";
const publicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
describe("NetworkIdentity", () => {
  it("separates the same public key across main and test", () => {
    const main = validateNetworkIdentity({ bsvNetwork: "main", publicKeyHex });
    const test = validateNetworkIdentity({ bsvNetwork: "test", publicKeyHex });
    expect(sameNetworkIdentity(main, test)).toBe(false);
    expect(networkIdentityStorageRoot(main)).toBe(`main/${publicKeyHex}/`);
    expect(networkIdentityStorageRoot(test)).toBe(`test/${publicKeyHex}/`);
    const binding = {bsvNetwork: "main" as const, publicKeyHex: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",  moduleId: "p2pkh", purposeId: "", authority: "built-in-module" as const, model: "files" as const, schemaVersion: 1, walletGeneration: "wallet", sessionEpoch: "session", runGeneration: "run" };
    expect(buildStorageNamespaceRoot({ ...binding, ...main })).toBe(`main/${publicKeyHex}/p2pkh/`);
    expect(buildStorageNamespaceRoot({ ...binding, ...test })).toBe(`test/${publicKeyHex}/p2pkh/`);
  });
  it("rejects unbound and invalid identities instead of guessing mainnet", () => {
    expect(() => validateNetworkIdentity({ publicKeyHex })).toThrow();
    expect(() => validateNetworkIdentity({ bsvNetwork: "dev", publicKeyHex })).toThrow();
    expect(() => validateNetworkIdentity({ bsvNetwork: "main", publicKeyHex: "../key" })).toThrow();
  });
});
