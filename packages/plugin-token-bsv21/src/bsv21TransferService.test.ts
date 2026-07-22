import { describe, expect, it, vi } from "vitest";
import { createBsv21TransferService } from "./bsv21TransferService.js";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { getPublicKey } from "@noble/secp256k1";

describe("createBsv21TransferService", () => {
  it("uses BSV-21 unspent UTXOs and produces token change", async () => {
    const ownerAddress = deriveP2pkhAddress("1".repeat(64), "main");
    const recipientA = deriveP2pkhAddress("2".repeat(64), "main");
    const recipientB = deriveP2pkhAddress("3".repeat(64), "main");
    const changeAddress = deriveP2pkhAddress("4".repeat(64), "main");

    const service = {
      listActiveKeyUnspentTokens: vi.fn(async () => [
        {
          network: "main" as const,
          outpoint: "tx0_0",
          tokenId: "tok1",
          amount: "2",
          ownerAddress: ownerAddress.address,
          current: { txid: "tx0", txIndex: 0 }
        },
        {
          network: "main" as const,
          outpoint: "tx1_0",
          tokenId: "tok1",
          amount: "8",
          ownerAddress: ownerAddress.address,
          current: { txid: "tx1", txIndex: 0 }
        }
      ])
    };
    const p2pkh = {
      listResources: vi.fn(async () => [{ publicKeyHex: "02".padEnd(66, "0"), address: ownerAddress.address }]),
      listUtxos: vi.fn(async () => [{ txid: "fund1", vout: 0, value: 5000, address: ownerAddress.address }])
    };
    const protocolSpend = {
      prepare: vi.fn(async (input) => ({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        inputs: input.inputs,
        outputs: input.outputs,
        changeAddress: input.changeAddress,
        changeSatoshis: 0,
        estimatedFeeSatoshis: 1,
        serializedSizeBytes: 1,
        txid: "tx-prep",
        rawTxHex: "00"
      })),
      submit: vi.fn(async (preview) => ({ status: "broadcast" as const, txid: preview.txid, rawTxHex: preview.rawTxHex }))
    };

    const transfer = createBsv21TransferService({
      service: service as never,
      p2pkh: p2pkh as never,
      protocolSpend: protocolSpend as never
    });

    const preview = await transfer.prepare({
      tokenId: "tok1",
      recipientAddress: recipientA.address,
      amount: "3",
      outputs: [
        { recipientAddress: recipientA.address, amount: "1" },
        { recipientAddress: recipientB.address, amount: "2" }
      ],
      network: "main",
      feeRateSatoshisPerKb: 1000,
      changeAddress: changeAddress.address
    });

    expect(preview.outputs).toEqual([
      { address: recipientA.address, amt: "1" },
      { address: recipientB.address, amt: "2" }
    ]);
    expect(protocolSpend.prepare).toHaveBeenCalled();
    const lastCall = protocolSpend.prepare.mock.calls[protocolSpend.prepare.mock.calls.length - 1];
    expect(lastCall?.[0].inputs[0]).toMatchObject({ txid: "tx0", vout: 0 });
    expect(lastCall?.[0].inputs[1]).toMatchObject({ txid: "tx1", vout: 0 });
    expect(preview.spend.outputs).toHaveLength(3);
  });
});

function deriveP2pkhAddress(keyHex: string, network: "main" | "test" = "main"): { publicKeyHex: string; address: string } {
  const key = hexToBytes(keyHex);
  const pub = key.length === 32 ? getPublicKey(key, true) : key;
  if (pub.length !== 33) throw new Error("Public key must be 33 bytes (compressed)");
  const ripe = ripemd160(sha256(pub));
  const versionByte = network === "main" ? 0x00 : 0x6f;
  const payload = concatBytes(new Uint8Array([versionByte]), ripe);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return { publicKeyHex: bytesToHex(pub), address: base58Encode(concatBytes(payload, checksum)) };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i]! * 256 + carry;
      digits[i] = v % 58;
      carry = (v / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return "1".repeat(leadingZeros) + digits.reverse().map((d) => alphabet[d]!).join("");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
