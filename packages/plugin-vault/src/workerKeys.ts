import { type CoordinatorCryptoOperation, type CoordinatorCryptoResult } from "@keymaster/contracts";
import type { LifecycleScope } from "webloom-framework";
import {
  WalletMigrationFence,
  createWorkerKeySession,
  createWorkerIdentityProjection,
  createWorkerActiveKeyCryptoFactory,
} from "./coordinator.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { wireSignatureDigest, type WireKind } from "go-bitfs";

export interface VaultWorkerKeyPorts {
  session(): { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string; runGeneration: string };
  storage: { ready(): boolean; token(): object | undefined; unavailable(message: string): Error };
  lock(reason: string): Promise<void>;
  providerScope(): LifecycleScope | undefined;
  allowUnscopedCrypto(): boolean;
  io: { run<T>(operation: "write", signal: AbortSignal | undefined, execute: () => Promise<T>, options: { auditOperation: "vault.digest.sign" | "vault.address.derive" }): Promise<T> };
}

/** Vault 所有权：私钥只存在此实例，软件密钥会话直接签名，无审批、无硬件分派。 */
export function createVaultWorkerKeys(ports: VaultWorkerKeyPorts) {
  const migrationFence = new WalletMigrationFence();

  const vaultKeySession = createWorkerKeySession(() => ({
    unlocked: ports.session().vaultStatus === "unlocked",
    publicKeyHex: ports.session().activePublicKeyHex,
    sessionEpoch: ports.session().sessionEpoch,
  }));

  function replaceActivePrivateKey(next: Uint8Array | undefined): void { vaultKeySession.replace(next); }

  function dropActivePrivateKey(): void { vaultKeySession.clear(); }

  const workerIdentityProjection = createWorkerIdentityProjection();

  const coordinatorActiveKeySummary = workerIdentityProjection.summary;

  function requireCoordinatorNetworkIdentity(): import("@keymaster/contracts").NetworkIdentity {
    const identity = coordinatorActiveKeySummary();
    if (!identity || ports.session().vaultStatus !== "unlocked") throw new Error("Network identity is unavailable");
    return { bsvNetwork: identity.bsvNetwork, publicKeyHex: identity.publicKeyHex };
  }

  const setCoordinatorActiveKeySummary = workerIdentityProjection.setSummary;

  function assertActiveWalletIdentity(publicKeyHex?: string, sessionEpoch?: string): void {
    const session = ports.session();
    if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex
      || (publicKeyHex !== undefined && publicKeyHex.toLowerCase() !== session.activePublicKeyHex?.toLowerCase())
      || (sessionEpoch !== undefined && sessionEpoch !== ports.session().sessionEpoch)) throw new Error("Wallet identity is stale");
    vaultKeySession.assert(publicKeyHex, sessionEpoch);
  }

  const workerSessionCryptoFactory = createWorkerActiveKeyCryptoFactory({
    summary: coordinatorActiveKeySummary,
    async signBitfsWire(input, signal) {
      void signal;
      assertActiveWalletIdentity(input.publicKeyHex);
      const kind = (input as { kind: number }).kind;
      const document = new Uint8Array((input as { document: ArrayBuffer }).document);
      if (document.length === 0) throw new Error("BitFS document is empty");
      // BitFS 协议摘要：与 go-bitfs wireSignatureDigest 一致，Kind 6 等需协议级摘要而非裸 SHA256。
      const digest = wireSignatureDigest(kind as WireKind, document);
      const signature = await vaultKeySession.signDigest(digest, "der", input.publicKeyHex);
      assertActiveWalletIdentity(input.publicKeyHex);
      return { publicKeyHex: input.publicKeyHex, format: "der" as const, signature: new Uint8Array(signature).buffer as ArrayBuffer };
    },
    async signConnectEnvelope(input) {
      assertActiveWalletIdentity(input.publicKeyHex);
      const envelope = new Uint8Array((input as { envelope: ArrayBuffer }).envelope);
      if (envelope.length === 0) throw new Error("Connect envelope is empty");
      // Connect 既有语义：只签 SHA256(envelope)，envelope 内已含 content 承诺；不签 envelope||content。
      const signature = await vaultKeySession.signDigest(sha256(envelope), "compact", input.publicKeyHex);
      assertActiveWalletIdentity(input.publicKeyHex);
      return { publicKeyHex: input.publicKeyHex, format: "compact" as const, signature: signature.slice().buffer as ArrayBuffer };
    },
    sessionEpoch: () => ports.session().sessionEpoch,
    keySession: {
      assert: assertActiveWalletIdentity,
      signDigest: (digest, format, publicKeyHex) => {
        assertActiveWalletIdentity(publicKeyHex);
        return vaultKeySession.signDigest(digest, format, publicKeyHex);
      },
    },
    withIoLease(operation, execute) {
      return operation === "sign"
        ? ports.io.run("write", undefined, execute, { auditOperation: "vault.digest.sign" })
        : ports.io.run("write", undefined, execute, { auditOperation: "vault.address.derive" });
    },
  });

  function createWorkerActiveKeyCrypto(owner: string, providerScope = ports.providerScope()) {
    if (!providerScope && !ports.allowUnscopedCrypto()) throw new Error("Vault crypto provider is unavailable");
    return workerSessionCryptoFactory(owner, providerScope);
  }

  const channelSigner = {
    signHash: (input: Parameters<typeof vaultKeySession.signHash>[0]) => vaultKeySession.signHash(input),
    signPublic: (input: Parameters<typeof vaultKeySession.signPublic>[0]) => vaultKeySession.signPublic(input),
    signPrivate: (input: Parameters<typeof vaultKeySession.signPrivate>[0]) => vaultKeySession.signPrivate(input),
    seal: (signed: Parameters<typeof vaultKeySession.seal>[0]) => vaultKeySession.seal(signed),
  };

  const openChannelPrivate = (channel: string, envelope: string | Uint8Array) =>
    vaultKeySession.open(channel, envelope);

  function hasActiveWalletCrypto(): boolean {
    return vaultKeySession.hasKey();
  }

  async function executeActiveWalletCrypto(operation: CoordinatorCryptoOperation): Promise<CoordinatorCryptoResult> {
    assertActiveWalletIdentity();
    if (operation.type === "deriveP2pkhAddress" && operation.network !== requireCoordinatorNetworkIdentity().bsvNetwork) throw Error("network-identity-mismatch");
    return vaultKeySession.execute(operation);
  }

  return {
    migrationFence,
    vaultKeySession,
    replaceActivePrivateKey,
    dropActivePrivateKey,
    workerIdentityProjection,
    coordinatorActiveKeySummary,
    requireCoordinatorNetworkIdentity,
    setCoordinatorActiveKeySummary,
    workerSessionCryptoFactory,
    createWorkerActiveKeyCrypto,
    channelSigner,
    openChannelPrivate,
    assertActiveWalletIdentity,
    hasActiveWalletCrypto,
    executeActiveWalletCrypto,
  };
}
