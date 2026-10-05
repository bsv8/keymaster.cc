import type { LifecycleScope } from "webloom-framework";
import type { ActiveKeyCrypto, KeyIdentity, SessionEpoch } from "@keymaster/contracts";
import { deriveP2pkhAddress } from "./sessionCryptoCore.js";
import type { createWorkerKeySession } from "./workerKeySession.js";

export interface WorkerActiveKeyCryptoDependencies {
  summary(): KeyIdentity | undefined;
  sessionEpoch(): SessionEpoch;
  keySession: ReturnType<typeof createWorkerKeySession>;
  withIoLease<T>(operation: "sign" | "derive-address", execute: () => Promise<T>): Promise<T>;
}

/** Internal session operations; published handles must also capture their provider Scope. */
export function createWorkerActiveKeyCryptoFactory(deps: WorkerActiveKeyCryptoDependencies) {
  return async (publicKeyHex: string, providerScope?: LifecycleScope): Promise<ActiveKeyCrypto> => {
    providerScope?.assertActive();
    const summary = deps.summary();
    if (!summary || summary.publicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase()) throw new Error(`Unknown key ${publicKeyHex}`);
    const identity = { ...summary, capabilities: [...summary.capabilities], sessionId: deps.sessionEpoch() };
    let disposed = false;
    const assert = () => {
      providerScope?.assertActive();
      if (disposed) throw new Error("Vault crypto view is disposed");
      deps.keySession.assert(publicKeyHex, identity.sessionId);
    };
    let offRevoke = () => {};
    const dispose = () => { disposed = true; offRevoke(); };
    assert();
    if (providerScope) offRevoke = providerScope.onRevoke(dispose);
    return Object.freeze({
      getIdentity() { assert(); return { ...identity, capabilities: [...identity.capabilities] }; },
      async signDigest(input) {
        assert();
        if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
        if (!(input.digest instanceof ArrayBuffer) || input.digest.byteLength !== 32) throw new Error("Digest must be exactly 32 bytes");
        const signature = await deps.withIoLease("sign", async () => {
          assert();
          const signature = await deps.keySession.signDigest(new Uint8Array(input.digest), input.format, publicKeyHex);
          assert();
          return signature;
        });
        assert();
        return { publicKeyHex, format: input.format, signature: signature.slice().buffer as ArrayBuffer };
      },
      async deriveP2pkhAddress(input) {
        assert();
        if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
        const result = await deps.withIoLease("derive-address", async () => {
          assert();
          return { publicKeyHex, address: deriveP2pkhAddress(publicKeyHex, input.network) };
        });
        assert();
        return result;
      },
      dispose,
    } satisfies ActiveKeyCrypto);
  };
}
