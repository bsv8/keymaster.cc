// BitFS journal 的 exact outbox 与恢复语义；网络层只能发送已经可靠回读的字节。

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createSellerQuote, parse, type Signer } from "go-bitfs";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsJournal } from "./journal.js";

function signer(privateByte: number): Signer {
  const privateKey = new Uint8Array(32);
  privateKey[31] = privateByte;
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return {
    publicKey: () => publicKey.slice(),
    async sign(request) {
      return secp256k1.sign(request.digest, privateKey, { prehash: false, lowS: true, format: "der" });
    },
  };
}

async function quote(seedByte: number) {
  return (await createSellerQuote({ nowUnixSeconds: 1n }, signer(1), {
    seedHash: new Uint8Array(32).fill(seedByte),
    buyerPublicKey: signer(2).publicKey(),
    seedPriceSatoshis: 1n,
    fullBlockPriceSatoshis: 2n,
    fileSizeBytes: 3n,
    quoteExpiresAtUnixSeconds: 2_000_000_000n,
    supportedArbiterPublicKeys: [signer(3).publicKey()],
    recommendedFilename: "fixture.bin",
  })).outbound;
}

describe("BitFS journal", () => {
  it("先保存并回读 exact outbox，重启后恢复同一字节", async () => {
    const store = createInMemoryOwnerFileStore();
    const journal = createBitfsJournal(store);
    const artifact = await quote(0x11);
    const id = "aa".repeat(32);
    const prepared = await journal.prepareOutbound(id, "seller", artifact, 1_000);
    expect(prepared).toEqual(artifact.bytes());
    prepared[0] = prepared[0]! ^ 0xff;

    const restored = await createBitfsJournal(store).restoreOutbound(id);
    expect(restored?.bytes()).toEqual(artifact.bytes());
    expect(parse(restored!.bytes()).kind).toBe(1);
    await journal.markOutbound(id, "result-unknown", 2_000);
    await expect(journal.getRecord(id)).resolves.toMatchObject({ role: "seller", outboxKind: 1, outboxState: "result-unknown" });
  });

  it("同一业务 ID 不得覆盖为另一份签名报文，并保留独立 checkpoint", async () => {
    const store = createInMemoryOwnerFileStore();
    const journal = createBitfsJournal(store);
    const id = "bb".repeat(32);
    await journal.prepareOutbound(id, "seller", await quote(0x11), 1_000);
    await expect(journal.prepareOutbound(id, "seller", await quote(0x22), 2_000)).rejects.toThrow(/不同 exact bytes/u);
    const checkpoint = new Uint8Array([1, 2, 3]);
    await journal.putCheckpoint(id, "seller", checkpoint, 3_000);
    checkpoint[0] = 9;
    await expect(journal.getCheckpoint(id)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
