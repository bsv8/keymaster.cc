// Window P2P 基础系统插件的 TypedSigner bridge。
//
// 这里不构造 Noise / Peer Record payload，也不接受通用 bytes 或 digest；
// payload/digest 由 bitcoin-libp2p SDK 与 Coordinator Worker 共同完成。

import type { PeerRecordInput } from "bitcoin-libp2p/identity";
import type { TypedSigner } from "bitcoin-libp2p/signer";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import type {
  WindowP2pIdentitySignResult,
  WindowP2pNoiseSignRequest,
  WindowP2pPeerRecordSignRequest,
  SessionEpoch,
} from "@keymaster/contracts";

const UINT64_MAX = (1n << 64n) - 1n;

export interface WindowP2pIdentitySignerRpc {
  windowP2pExecutorSignNoiseStaticKey(
    request: Omit<WindowP2pNoiseSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: SessionEpoch },
    signal?: AbortSignal
  ): Promise<{ status: string; value?: WindowP2pIdentitySignResult; message?: string }>;
  windowP2pExecutorSignPeerRecord(
    request: Omit<WindowP2pPeerRecordSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: SessionEpoch },
    signal?: AbortSignal
  ): Promise<{ status: string; value?: WindowP2pIdentitySignResult; message?: string }>;
}

function assertUint64(sequence: bigint): string {
  if (sequence < 0n || sequence > UINT64_MAX) throw new Error("Peer Record sequence must be a uint64");
  return sequence.toString(10);
}

function signatureFromResult(result: { status: string; value?: WindowP2pIdentitySignResult; message?: string }, purpose: string): Uint8Array {
  if (result.status !== "ok" || !result.value) {
    throw new Error(`${purpose} signer RPC failed${result.message ? `: ${result.message}` : ""}`);
  }
  const signature = new Uint8Array(result.value.signatureDer);
  if (signature.byteLength === 0) throw new Error(`${purpose} signer RPC returned an empty DER signature`);
  return signature.slice();
}

/**
 * bitcoin-libp2p TypedSigner 的 Window 实现。
 *
 * 该对象只保存 active public key、lease 与 RPC 引用。private key/raw 不在
 * Window 类型、字段或返回值中出现；真正签名只在 Coordinator SharedWorker。
 */
export class KeymasterWindowP2pIdentitySigner implements TypedSigner {
  private readonly activePublicKeyBytes: Uint8Array;
  private readonly activePublicKeyHex: string;
  private readonly leaseId: string;
  private readonly sessionEpoch: SessionEpoch;
  private readonly rpc: WindowP2pIdentitySignerRpc;
  private closed = false;
  private pending = 0;
  private noiseSigns = 0;
  private peerRecordSigns = 0;

  constructor(input: {
    leaseId: string;
    sessionEpoch: SessionEpoch;
    activePublicKeyHex: string;
    rpc: WindowP2pIdentitySignerRpc;
  }) {
    this.leaseId = input.leaseId;
    this.sessionEpoch = input.sessionEpoch;
    this.activePublicKeyHex = input.activePublicKeyHex;
    this.rpc = input.rpc;
    const bytes = new Uint8Array(input.activePublicKeyHex.length / 2);
    if (!/^(02|03)[0-9a-f]{64}$/.test(input.activePublicKeyHex)) {
      throw new Error("active public key must be compressed secp256k1 hex");
    }
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(input.activePublicKeyHex.slice(index * 2, index * 2 + 2), 16);
    }
    this.activePublicKeyBytes = bytes;
  }

  publicKey(): Uint8Array {
    this.assertOpen();
    return this.activePublicKeyBytes.slice();
  }

  get peerId(): ReturnType<typeof peerIdFromPublicKeyBytes> {
    return peerIdFromPublicKeyBytes(this.activePublicKeyBytes);
  }

  get activeOwnerPublicKeyHex(): string {
    return this.activePublicKeyHex;
  }

  get pendingRequestCount(): number {
    return this.pending;
  }

  get noiseSignCount(): number {
    return this.noiseSigns;
  }

  get peerRecordSignCount(): number {
    return this.peerRecordSigns;
  }

  close(): void {
    this.closed = true;
  }

  async signNoiseStaticKey(staticKey32: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    if (staticKey32.byteLength !== 32) throw new Error("Noise static public key must be exactly 32 bytes");
    this.pending += 1;
    try {
      this.noiseSigns += 1;
      const result = await this.rpc.windowP2pExecutorSignNoiseStaticKey({
        leaseId: this.leaseId,
        expectedSessionEpoch: this.sessionEpoch,
        noiseStaticPublicKey: staticKey32.slice().buffer
      }, signal);
      if (this.closed) throw new Error("Window P2P identity signer is closed");
      return signatureFromResult(result, "Noise");
    } finally {
      this.pending = Math.max(0, this.pending - 1);
    }
  }

  async signPeerRecord(record: PeerRecordInput, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    if (record.addresses.length !== 0) throw new Error("Window P2P Signed Peer Record addresses must be empty");
    if (record.peerId.toString() !== this.peerId.toString()) throw new Error("Peer Record PeerId does not match the active public key");
    const sequence = assertUint64(record.sequence);
    this.pending += 1;
    try {
      this.peerRecordSigns += 1;
      const result = await this.rpc.windowP2pExecutorSignPeerRecord({
        leaseId: this.leaseId,
        expectedSessionEpoch: this.sessionEpoch,
        peerId: record.peerId.toString(),
        addresses: [],
        sequence
      }, signal);
      if (this.closed) throw new Error("Window P2P identity signer is closed");
      return signatureFromResult(result, "Peer Record");
    } finally {
      this.pending = Math.max(0, this.pending - 1);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Window P2P identity signer is closed");
  }
}

