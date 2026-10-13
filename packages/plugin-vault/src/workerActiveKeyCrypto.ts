import type { LifecycleScope } from "webloom-framework";
import type { ActiveKeyCrypto, KeyIdentity, SessionEpoch } from "@keymaster/contracts";
import { deriveP2pkhAddress } from "./sessionCryptoCore.js";
import type { createWorkerKeySession } from "./workerKeySession.js";

export interface WorkerActiveKeyCryptoDependencies {
  summary(): KeyIdentity | undefined;
  sessionEpoch(): SessionEpoch;
  keySession: Pick<ReturnType<typeof createWorkerKeySession>, "assert" | "signDigest">;
  withIoLease<T>(operation: "sign" | "derive-address", execute: () => Promise<T>): Promise<T>;
  signConnectEnvelope?: NonNullable<ActiveKeyCrypto["signConnectEnvelope"]>;
  signBitfsWire?: NonNullable<ActiveKeyCrypto["signBitfsWire"]>;
}

/** Internal session operations; published handles must also capture their provider Scope. */
export function createWorkerActiveKeyCryptoFactory(deps: WorkerActiveKeyCryptoDependencies) {
  return async (publicKeyHex: string, providerScope?: LifecycleScope): Promise<ActiveKeyCrypto> => {
    providerScope?.assertActive();
    const summary = deps.summary();
    if (!summary || summary.publicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase()) throw new Error(`Unknown key ${publicKeyHex}`);
    const identity = { ...summary, capabilities: [...summary.capabilities], sessionId: deps.sessionEpoch() };
    let disposed = false;
    const lifetime=new AbortController();
    const assert = () => {
      providerScope?.assertActive();
      if (disposed) throw new Error("Vault crypto view is disposed");
      deps.keySession.assert(publicKeyHex, identity.sessionId);
    };
    let offRevoke = () => {};
    const dispose = () => { disposed = true; lifetime.abort(); offRevoke(); };
    assert();
    if (providerScope) offRevoke = providerScope.onRevoke(dispose);
    return Object.freeze({
      getIdentity() { assert(); return { ...identity, capabilities: [...identity.capabilities] }; },
      ...(deps.signBitfsWire ? {async signBitfsWire(input:Parameters<NonNullable<ActiveKeyCrypto["signBitfsWire"]>>[0],signal?:AbortSignal) {
        assert();if(input.publicKeyHex!==publicKeyHex)throw Error("session_key_mismatch");const frozen=structuredClone(input),cancel=new AbortController();
        const abort=()=>cancel.abort();signal?.addEventListener("abort",abort,{once:true});lifetime.signal.addEventListener("abort",abort,{once:true});
        if(signal?.aborted||lifetime.signal.aborted)cancel.abort();
        try{const result=await deps.withIoLease("sign",async()=>{assert();const value=await deps.signBitfsWire!(frozen,cancel.signal);assert();return value;});assert();return result;}
        finally{signal?.removeEventListener("abort",abort);lifetime.signal.removeEventListener("abort",abort);}
      }} : {}),
      ...(deps.signConnectEnvelope ? {async signConnectEnvelope(input: Parameters<NonNullable<ActiveKeyCrypto["signConnectEnvelope"]>>[0]) {
        assert(); if(input.publicKeyHex!==publicKeyHex)throw new Error("session_key_mismatch");
        const frozen=structuredClone(input);
        const result=await deps.withIoLease("sign",async()=>{assert();const value=await deps.signConnectEnvelope!(frozen);assert();return value;});
        assert();return result;
      }} : {}),
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
