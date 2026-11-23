import { deriveP2pkhAddress } from "@keymaster/contracts";
import type { LifecycleScope } from "webloom-framework";
import type { ActiveKeyCrypto, KeyIdentity, SessionEpoch } from "@keymaster/contracts";

import type { createWorkerKeySession } from "./workerKeySession.js";

export interface WorkerActiveKeyCryptoDependencies {
  summary(): KeyIdentity | undefined;
  sessionEpoch(): SessionEpoch;
  keySession: Pick<ReturnType<typeof createWorkerKeySession>, "assert" | "signDigest" | "deriveCipherSiteKey" | "signApplicationDigests">;
  withIoLease<T>(operation: "sign" | "derive-address" | "derive-cipher", execute: () => Promise<T>): Promise<T>;
  signConnectEnvelope?(input: Parameters<NonNullable<ActiveKeyCrypto["signConnectEnvelope"]>>[0] & { publicKeyHex: string }): ReturnType<NonNullable<ActiveKeyCrypto["signConnectEnvelope"]>>;
  signBitfsWire?(input: Parameters<NonNullable<ActiveKeyCrypto["signBitfsWire"]>>[0] & { publicKeyHex: string }, signal?: AbortSignal): ReturnType<NonNullable<ActiveKeyCrypto["signBitfsWire"]>>;
}

/** Internal session operations; published handles must also capture their provider Scope. */
export function createWorkerActiveKeyCryptoFactory(deps: WorkerActiveKeyCryptoDependencies) {
  return async (publicKeyHex: string, providerScope?: LifecycleScope): Promise<ActiveKeyCrypto> => {
    providerScope?.assertActive();
    const summary = deps.summary();
    if (!summary || summary.publicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase() || (summary.bsvNetwork !== "main" && summary.bsvNetwork !== "test")) throw new Error(`Unknown key identity ${publicKeyHex}`);
    const identity = { ...summary, capabilities: [...summary.capabilities], sessionId: deps.sessionEpoch() };
    let disposed = false;
    const lifetime=new AbortController();
    const assert = () => {
      providerScope?.assertActive();
      if (disposed) throw new Error("Vault crypto view is disposed");
      deps.keySession.assert(publicKeyHex, identity.sessionId);
      const current = deps.summary();
      if (current?.publicKeyHex !== identity.publicKeyHex || current?.bsvNetwork !== identity.bsvNetwork) throw new Error("Vault crypto identity changed");
    };
    let offRevoke = () => {};
    const dispose = () => { disposed = true; lifetime.abort(); offRevoke(); };
    assert();
    if (providerScope) offRevoke = providerScope.onRevoke(dispose);
    return Object.freeze({
      getIdentity() { assert(); return { ...identity, capabilities: [...identity.capabilities] }; },
      ...(deps.signBitfsWire ? {async signBitfsWire(input:Parameters<NonNullable<ActiveKeyCrypto["signBitfsWire"]>>[0],signal?:AbortSignal) {
        assert();if(Object.keys(input).some(key => !["kind", "document"].includes(key)))throw Error("Wallet selectors and unknown fields are not accepted");const frozen={...structuredClone(input),publicKeyHex},cancel=new AbortController();
        const abort=()=>cancel.abort();signal?.addEventListener("abort",abort,{once:true});lifetime.signal.addEventListener("abort",abort,{once:true});
        if(signal?.aborted||lifetime.signal.aborted)cancel.abort();
        try{const result=await deps.withIoLease("sign",async()=>{assert();const value=await deps.signBitfsWire!(frozen,cancel.signal);assert();return value;});assert();return result;}
        finally{signal?.removeEventListener("abort",abort);lifetime.signal.removeEventListener("abort",abort);}
      }} : {}),
      ...(deps.signConnectEnvelope ? {async signConnectEnvelope(input: Parameters<NonNullable<ActiveKeyCrypto["signConnectEnvelope"]>>[0]) {
        assert(); if(Object.keys(input).some(key => !["kind", "envelope", "content", "appSessionId"].includes(key)))throw new Error("Wallet selectors and unknown fields are not accepted");
        const frozen={...structuredClone(input),publicKeyHex};
        const result=await deps.withIoLease("sign",async()=>{assert();const value=await deps.signConnectEnvelope!(frozen);assert();return value;});
        assert();return result;
      }} : {}),
      async signApplicationDigests(purpose: string, digests: ArrayBuffer[], format: "der" | "compact") {
        assert();
        if (digests.length === 0 || digests.some(digest => !(digest instanceof ArrayBuffer) || digest.byteLength !== 32)) {
          throw new Error("Invalid application signing request");
        }
        const frozen = digests.map(digest => digest.slice(0));
        return deps.withIoLease("sign", async () => {
          assert();
          const result = await deps.keySession.signApplicationDigests(purpose, frozen, format, publicKeyHex);
          assert();
          return result;
        });
      },
      async signDigest(input) {
        assert();
        if (Object.keys(input).some(key => !["digest", "format"].includes(key))) throw new Error("Wallet selectors and unknown fields are not accepted");
        if (!(input.digest instanceof ArrayBuffer) || input.digest.byteLength !== 32) throw new Error("Digest must be exactly 32 bytes");
        if (input.format !== "der" && input.format !== "compact") throw new Error("Unknown signature format");
        const digest = new Uint8Array(input.digest).slice();
        if (digest.length !== 32) throw new Error("Digest must be 32 bytes");
        const format = input.format;
        const signature = await deps.withIoLease("sign", async () => {
          assert();
          const signature = await deps.keySession.signDigest(digest, format, publicKeyHex);
          assert();
          return signature;
        });
        assert();
        return { publicKeyHex, format, signature: signature.slice().buffer as ArrayBuffer };
      },
      async deriveP2pkhAddress(...args: []) {
        assert();
        if (args.length) throw new Error("Wallet selectors are not accepted");
        const result = await deps.withIoLease("derive-address", async () => {
          assert();
          return { publicKeyHex, address: deriveP2pkhAddress(publicKeyHex, identity.bsvNetwork) };
        });
        assert();
        return result;
      },
      async deriveCipherSiteKey(input) {
        assert();
        if (!input || typeof input !== "object" || Object.keys(input).some(key => !["origin", "bsvNetwork", "appPublicKeyHex"].includes(key))) throw new Error("Unknown cipher derivation field");
        if (typeof input.origin !== "string" || !input.origin) throw new Error("Invalid origin");
        if (input.bsvNetwork !== "main" && input.bsvNetwork !== "test") throw new Error("Unknown network");
        if (input.appPublicKeyHex !== undefined && (typeof input.appPublicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/.test(input.appPublicKeyHex))) throw new Error("Invalid app public key");
        const siteKey = await deps.withIoLease("derive-cipher", async () => {
          assert();
          const key = await deps.keySession.deriveCipherSiteKey(input.origin, input.bsvNetwork, input.appPublicKeyHex);
          assert();
          return key;
        });
        assert();
        const copy = new Uint8Array(siteKey).slice();
        if (copy.length !== 32) throw new Error("Cipher derivation failed");
        return { publicKeyHex, siteKey: copy.buffer as ArrayBuffer };
      },
      dispose,
    } satisfies ActiveKeyCrypto);
  };
}
