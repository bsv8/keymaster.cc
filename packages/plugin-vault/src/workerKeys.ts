import { WalletMigrationFence } from "./coordinator.js";
import { type CoordinatorCryptoOperation, type CoordinatorCryptoResult } from "@keymaster/contracts";
import type { LifecycleScope } from "webloom-framework";
import {
  SignatureHistory, HardwareConnectionOwner, WalletPayments, HardwareWalletPayments, createWorkerKeySession,
  createWorkerIdentityProjection, createWorkerActiveKeyCryptoFactory, createHardwareChannelAdapter,
  bytesToHex, hexToBytes as cryptoHexToBytes, deriveP2pkhAddress,
} from "./coordinator.js";

export interface VaultWorkerKeyPorts {
  session(): { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string; runGeneration: string };
  storage: { ready(): boolean; token(): object | undefined; payments(): Parameters<typeof WalletPayments.open>[0]; unavailable(message: string): Error };
  lock(reason: string): Promise<void>;
  providerScope(): LifecycleScope | undefined;
  allowUnscopedCrypto(): boolean;
  io: { run<T>(operation: "write", signal: AbortSignal | undefined, execute: () => Promise<T>, options: { auditOperation: "vault.digest.sign" | "vault.address.derive" }): Promise<T> };
}

/** Vault 所有权：私钥、设备连接、身份摘要、支付单飞与签名记录只存在此实例。 */
export function createVaultWorkerKeys(ports: VaultWorkerKeyPorts) {
  const migrationFence = new WalletMigrationFence();
  let activeKeyBackend: "software" | "hardware" | undefined;

  let hardwareEnrollmentInProgress = false;

  let softwareMigrationFailure: { migrationId: string; message: string } | undefined;

  let hardwareRecoveryConnection: { migrationId: string; peerId: string } | undefined;

  const hardwareConnections = new HardwareConnectionOwner(() => {
    if (!ports.storage.ready() && !hardwareEnrollmentInProgress && !hardwareRecoveryConnection) throw ports.storage.unavailable("Hardware connection has no current wallet root");
  }, () => {
    hardwareRecoveryConnection = undefined;
    if (activeKeyBackend === "hardware") void ports.lock("hardware-disconnected").catch(error => console.warn("Hardware disconnect lock failed", error));
  }, meta => currentSignatureHistory().start(meta));

  const vaultKeySession = createWorkerKeySession(() => ({
    unlocked: ports.session().vaultStatus === "unlocked",
    publicKeyHex: ports.session().activePublicKeyHex,
    sessionEpoch: ports.session().sessionEpoch,
  }));

  function replaceActivePrivateKey(next: Uint8Array | undefined): void { vaultKeySession.replace(next); }

  function dropActivePrivateKey(): void { vaultKeySession.clear(); }

  let historyBinding: { token: object; session: string; history: SignatureHistory } | undefined;

  function currentSignatureHistory() {
    const identity = requireCoordinatorNetworkIdentity();
    const token = ports.storage.token();
    if (ports.session().vaultStatus !== "unlocked" || !token) throw Error("signature-history-locked");
    const session = ports.session().runGeneration + ":" + ports.session().sessionEpoch;
    if (!historyBinding || historyBinding.token !== token || historyBinding.session !== session)
      historyBinding = { token, session, history: new SignatureHistory(ports.storage.payments(), identity.bsvNetwork, identity.publicKeyHex, session) };
    return historyBinding.history;
  }

  let walletPayments: WalletPayments | HardwareWalletPayments | undefined;

  let walletPaymentsOpening: Promise<WalletPayments | HardwareWalletPayments> | undefined;

  async function currentWalletPayments(): Promise<WalletPayments | HardwareWalletPayments> {
    const owner = ports.session().activePublicKeyHex, epoch = ports.session().sessionEpoch, network = requireCoordinatorNetworkIdentity().bsvNetwork;
    const assertActive = () => {
      if (!owner || ports.session().vaultStatus !== "unlocked" || ports.session().activePublicKeyHex !== owner || ports.session().sessionEpoch !== epoch || requireCoordinatorNetworkIdentity().bsvNetwork !== network) throw new Error("Payment wallet session became stale");
    };
    assertActive();
    if (walletPayments) return walletPayments;
    if (walletPaymentsOpening) return walletPaymentsOpening;
    if (activeKeyBackend === "hardware") {
      walletPayments = new HardwareWalletPayments(hardwareConnections.backend(), assertActive);
      return walletPayments;
    }
    const pending = WalletPayments.open(ports.storage.payments(), owner!, assertActive, async digest => {
      assertActive();
      const result = await vaultKeySession.execute({ type: "signDigest", digestHex: bytesToHex(digest), format: "der" });
      assertActive();
      if (result.type !== "signDigest" || result.format !== "der") throw new Error("Invalid payment signature result");
      return cryptoHexToBytes(result.signatureHex);
    }, requireCoordinatorNetworkIdentity().bsvNetwork);
    walletPaymentsOpening = pending;
    try { const ready = await pending; assertActive(); ready.setSignatureRecorder(meta => currentSignatureHistory().start(meta)); walletPayments = ready; return ready; }
    finally { if (walletPaymentsOpening === pending) walletPaymentsOpening = undefined; }
  }

  async function authorizeSoftwareSignature<T>(operation: string, sign: () => Promise<T> | T, signal?: AbortSignal, facts: Record<string, string> = {}): Promise<T> {
    const wallet = await currentWalletPayments(); if (!(wallet instanceof WalletPayments)) throw Error("software-source-required");
    return wallet.authorizeSignature(operation, sign, signal, facts);
  }

  const workerIdentityProjection = createWorkerIdentityProjection();

  const coordinatorActiveKeySummary = workerIdentityProjection.summary;

  function requireCoordinatorNetworkIdentity(): import("@keymaster/contracts").NetworkIdentity {
    const identity = coordinatorActiveKeySummary();
    if (!identity || ports.session().vaultStatus !== "unlocked") throw new Error("Network identity is unavailable");
    return { bsvNetwork: identity.bsvNetwork, publicKeyHex: identity.publicKeyHex };
  }

  const setCoordinatorActiveKeySummary = workerIdentityProjection.setSummary;

  const workerSessionCryptoFactory = createWorkerActiveKeyCryptoFactory({
    summary: coordinatorActiveKeySummary,
    async signBitfsWire(input, signal) {
      assertActiveWalletIdentity(input.publicKeyHex);
      const wallet = await currentWalletPayments();
      const signature = await (wallet instanceof WalletPayments ? wallet.signBitfsWire(input.kind, new Uint8Array(input.document), signal) : hardwareConnections.backend().signBitfsWire(input.kind, new Uint8Array(input.document), signal));
      assertActiveWalletIdentity(input.publicKeyHex); return { publicKeyHex: input.publicKeyHex, format: "der", signature: new Uint8Array(signature).buffer };
    },
    async signConnectEnvelope(input) {
      assertActiveWalletIdentity(input.publicKeyHex);
      const wallet = await currentWalletPayments();
      const signature = await (wallet instanceof WalletPayments ? wallet.signConnectEnvelope(input.kind, new Uint8Array(input.envelope), input.content ? new Uint8Array(input.content) : undefined, input.appSessionId) : hardwareConnections.backend().signConnectEnvelope(input.kind, new Uint8Array(input.envelope), input.content ? new Uint8Array(input.content) : undefined, input.appSessionId));
      assertActiveWalletIdentity(input.publicKeyHex);
      return { publicKeyHex: input.publicKeyHex, format: "compact", signature: signature.slice().buffer as ArrayBuffer };
    },
    sessionEpoch: () => ports.session().sessionEpoch,
    keySession: {
      assert: assertActiveWalletIdentity,
      signDigest: (digest, format, publicKeyHex) => {
        assertActiveWalletIdentity(publicKeyHex);
        if (activeKeyBackend === "hardware") throw new Error("hardware-profile-required");
        return authorizeSoftwareSignature("software.digest-sign", () => vaultKeySession.signDigest(digest, format, publicKeyHex), undefined, { digest: bytesToHex(digest) });
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

  const hardwareChannel = createHardwareChannelAdapter(() => hardwareConnections.backend(), () => {
    const session = ports.session();
    if (session.vaultStatus !== "unlocked" || !session.activePublicKeyHex) throw Error("Vault locked");
    return session.activePublicKeyHex;
  });

  const channelSigner = {
    signHash: (...args: Parameters<typeof hardwareChannel.signHash>) => activeKeyBackend === "hardware" ? hardwareChannel.signHash(...args) : authorizeSoftwareSignature("channel.hash-request", () => vaultKeySession.signHash(args[0]), args[1]),
    signPublic: (...args: Parameters<typeof hardwareChannel.signPublic>) => activeKeyBackend === "hardware" ? hardwareChannel.signPublic(...args) : authorizeSoftwareSignature("channel.public-message", () => vaultKeySession.signPublic(args[0]), args[1]),
    signPrivate: (...args: Parameters<typeof hardwareChannel.signPrivate>) => activeKeyBackend === "hardware" ? hardwareChannel.signPrivate(...args) : authorizeSoftwareSignature("channel.private-message", () => vaultKeySession.signPrivate(args[0]), args[1]),
    seal: (...args: Parameters<typeof hardwareChannel.seal>) => activeKeyBackend === "hardware" ? hardwareChannel.seal(...args) : vaultKeySession.seal(args[0]),
  };

  const openChannelPrivate = (channel: string, envelope: string | Uint8Array, signal?: AbortSignal) =>
    activeKeyBackend === "hardware" ? hardwareChannel.open(channel, envelope, signal) : vaultKeySession.open(channel, envelope);

  function assertActiveWalletIdentity(publicKeyHex?: string, sessionEpoch?: string): void {
    const session = ports.session();
    if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex
      || (publicKeyHex !== undefined && publicKeyHex.toLowerCase() !== session.activePublicKeyHex?.toLowerCase())
      || (sessionEpoch !== undefined && sessionEpoch !== ports.session().sessionEpoch)) throw new Error("Wallet identity is stale");
    if (activeKeyBackend === "hardware") { if (hardwareConnections.backend().isMigrating()) throw Error("migration-pending"); }
    else vaultKeySession.assert(publicKeyHex, sessionEpoch);
  }

  function hasActiveWalletCrypto(): boolean {
    if (activeKeyBackend === "hardware") return ports.session().vaultStatus === "unlocked" && hardwareConnections.state().status === "connected";
    return vaultKeySession.hasKey();
  }

  async function executeActiveWalletCrypto(operation: CoordinatorCryptoOperation): Promise<CoordinatorCryptoResult> {
    assertActiveWalletIdentity();
    if (operation.type === "signConnectEnvelope") {
      const wallet = await currentWalletPayments();
      const signature = await (wallet instanceof WalletPayments ? wallet.signConnectEnvelope(operation.kind, operation.envelope, operation.content, operation.appSessionId) : hardwareConnections.backend().signConnectEnvelope(operation.kind, operation.envelope, operation.content, operation.appSessionId));
      assertActiveWalletIdentity();
      return { type: operation.type, signatureHex: bytesToHex(signature), format: "compact" };
    }
    if (operation.type === "deriveP2pkhAddress" && operation.network !== requireCoordinatorNetworkIdentity().bsvNetwork) throw Error("network-identity-mismatch");
    if (activeKeyBackend !== "hardware") return operation.type === "signDigest"
      ? authorizeSoftwareSignature("software.digest-sign", () => vaultKeySession.execute(operation), undefined, { digest: operation.digestHex })
      : vaultKeySession.execute(operation);
    // 地址派生只用已经核验的公钥；所有私钥运算必须走明确的设备语义 Profile。
    if (operation.type === "deriveP2pkhAddress") {
      if (operation.network !== requireCoordinatorNetworkIdentity().bsvNetwork) throw Error("network-identity-mismatch");
      return { type: operation.type, address: deriveP2pkhAddress(ports.session().activePublicKeyHex!, operation.network) };
    }
    throw new Error("hardware-profile-required");
  }
  return {
    migrationFence,
    get activeKeyBackend() { return activeKeyBackend; }, set activeKeyBackend(value: typeof activeKeyBackend) { activeKeyBackend = value; },
    get hardwareEnrollmentInProgress() { return hardwareEnrollmentInProgress; }, set hardwareEnrollmentInProgress(value: typeof hardwareEnrollmentInProgress) { hardwareEnrollmentInProgress = value; },
    get softwareMigrationFailure() { return softwareMigrationFailure; }, set softwareMigrationFailure(value: typeof softwareMigrationFailure) { softwareMigrationFailure = value; },
    get hardwareRecoveryConnection() { return hardwareRecoveryConnection; }, set hardwareRecoveryConnection(value: typeof hardwareRecoveryConnection) { hardwareRecoveryConnection = value; },
    hardwareConnections,
    vaultKeySession,
    replaceActivePrivateKey,
    dropActivePrivateKey,
    get historyBinding() { return historyBinding; }, set historyBinding(value: typeof historyBinding) { historyBinding = value; },
    currentSignatureHistory,
    get walletPayments() { return walletPayments; }, set walletPayments(value: typeof walletPayments) { walletPayments = value; },
    get walletPaymentsOpening() { return walletPaymentsOpening; }, set walletPaymentsOpening(value: typeof walletPaymentsOpening) { walletPaymentsOpening = value; },
    currentWalletPayments,
    authorizeSoftwareSignature,
    workerIdentityProjection,
    coordinatorActiveKeySummary,
    requireCoordinatorNetworkIdentity,
    setCoordinatorActiveKeySummary,
    workerSessionCryptoFactory,
    createWorkerActiveKeyCrypto,
    hardwareChannel,
    channelSigner,
    openChannelPrivate,
    assertActiveWalletIdentity,
    hasActiveWalletCrypto,
    executeActiveWalletCrypto,
  };
}
