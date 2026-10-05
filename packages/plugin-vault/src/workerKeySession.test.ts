import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerKeySession, type WorkerKeyIdentity } from "./workerKeySession.js";
import { hexToBytes } from "./sessionCryptoCore.js";
const publicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const privateKeyHex = "0".repeat(63) + "1";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  let identity: WorkerKeyIdentity = { unlocked: true, publicKeyHex, sessionEpoch: "session:1" };
  const session = createWorkerKeySession(() => identity);
  const bytes = hexToBytes(privateKeyHex);
  session.replace(bytes);
  return { session, bytes, update: (next: WorkerKeyIdentity) => { identity = next; } };
}
describe("Vault Worker key owner", () => {
  it("wipes the adopted buffer on replacement and lock, and exposes operations without key readers", async () => {
    const { session, bytes } = fixture();
    expect(await session.execute({ type: "deriveP2pkhAddress", network: "main" })).toEqual({ type: "deriveP2pkhAddress", address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" });
    expect(Object.keys(session).some(key => /bytes|privateKey|getKey/i.test(key))).toBe(false);
    const next = hexToBytes(privateKeyHex);
    session.replace(next); expect(bytes.every(value => value === 0)).toBe(true);
    session.clear(); expect(next.every(value => value === 0)).toBe(true);
    await expect(session.execute({ type: "deriveP2pkhAddress", network: "main" })).rejects.toThrow(/locked/);
  });
  it("rejects a digest result when the session changes during signing", async () => {
    const { session, update } = fixture();
    const pending = session.signDigest(new Uint8Array(32).fill(7), "compact", publicKeyHex);
    update({ unlocked: true, publicKeyHex, sessionEpoch: "session:2" });
    await expect(pending).rejects.toThrow(/changed/);
  });
  it("keeps local secret derivation compatible and rejects a cached operation after lock", async () => {
    const { session, update } = fixture();
    const key = await session.deriveLocalSecretKey("storage.bucket-password");
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe("AES-GCM");
    const cached = session.signDigest;
    update({ unlocked: false, sessionEpoch: "session:locked" });
    await expect(cached(new Uint8Array(32), "der")).rejects.toThrow(/locked/);
  });
});
