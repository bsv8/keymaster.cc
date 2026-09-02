// 施工单 001：Window TypedSigner bridge 的最小接口测试。
import { describe, expect, it } from "vitest";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { KeymasterWindowP2pIdentitySigner } from "./identitySigner.js";

const PUBLIC_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const DER = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]).buffer;

function rpc() {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    windowP2pExecutorSignNoiseStaticKey: async (input: Record<string, unknown>) => {
      calls.push({ kind: "noise", input });
      return { status: "ok", value: { signatureDer: DER.slice(0) } };
    },
    windowP2pExecutorSignPeerRecord: async (input: Record<string, unknown>) => {
      calls.push({ kind: "peer-record", input });
      return { status: "ok", value: { signatureDer: DER.slice(0) } };
    }
  };
}

describe("KeymasterWindowP2pIdentitySigner", () => {
  it("implements only the two typed signing methods and keeps identity public", async () => {
    const bridge = rpc();
    const signer = new KeymasterWindowP2pIdentitySigner({ leaseId: "lease-1", sessionEpoch: "epoch-1", activePublicKeyHex: PUBLIC_KEY_HEX, rpc: bridge });
    const noise = await signer.signNoiseStaticKey(new Uint8Array(32).fill(1));
    const peerId = peerIdFromPublicKeyBytes(hexToBytes(PUBLIC_KEY_HEX));
    const peerRecord = await signer.signPeerRecord({ peerId, addresses: [], sequence: 0n });
    expect(noise.byteLength).toBeGreaterThan(0);
    expect(peerRecord.byteLength).toBeGreaterThan(0);
    expect(signer.publicKey()).toEqual(hexToBytes(PUBLIC_KEY_HEX));
    expect(bridge.calls.map((call) => call.kind)).toEqual(["noise", "peer-record"]);
    expect(bridge.calls[0]!.input).toMatchObject({ leaseId: "lease-1", expectedSessionEpoch: "epoch-1" });
    expect(bridge.calls[0]!.input.noiseStaticPublicKey).toBeInstanceOf(ArrayBuffer);
    expect(bridge.calls[1]!.input).toMatchObject({ leaseId: "lease-1", expectedSessionEpoch: "epoch-1", peerId: peerId.toString(), addresses: [], sequence: "0" });
  });

  it("rejects short Noise keys, non-empty addresses, and a PeerId for another key", async () => {
    const signer = new KeymasterWindowP2pIdentitySigner({ leaseId: "lease-1", sessionEpoch: "epoch-1", activePublicKeyHex: PUBLIC_KEY_HEX, rpc: rpc() });
    await expect(signer.signNoiseStaticKey(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    await expect(signer.signPeerRecord({ peerId: signer.peerId, addresses: [{ toString: () => "/ip4/127.0.0.1/tcp/1" }] as never[], sequence: 0n })).rejects.toThrow(/addresses must be empty/);
    const other = peerIdFromPublicKeyBytes(hexToBytes("035f3d296df6e017c017270bfc0293dc7d197ff9e04a25c096260420644d86d21a"));
    await expect(signer.signPeerRecord({ peerId: other, addresses: [], sequence: 0n })).rejects.toThrow(/does not match/);
  });

  it("propagates AbortSignal to the dedicated RPC", async () => {
    let sawAbort = false;
    const controller = new AbortController();
    const bridge = new KeymasterWindowP2pIdentitySigner({
      leaseId: "lease-1",
      sessionEpoch: "epoch-1",
      activePublicKeyHex: PUBLIC_KEY_HEX,
      rpc: {
        windowP2pExecutorSignNoiseStaticKey: (_input, signal) => new Promise((_, reject) => {
          signal?.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
        }),
        windowP2pExecutorSignPeerRecord: async () => ({ status: "ok", value: { signatureDer: DER.slice(0) } })
      }
    });
    const pending = bridge.signNoiseStaticKey(new Uint8Array(32), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(sawAbort).toBe(true);
    expect(bridge.pendingRequestCount).toBe(0);
  });
});


