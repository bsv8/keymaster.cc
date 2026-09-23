import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createSellerQuote, parse, type Signer } from "go-bitfs";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { BitfsTransactionBroadcaster, createBitfsTransactionJournal } from "./broadcast.js";
import { BitfsSellerProtocol, persistSellerKind7BeforeSigning } from "./sellerProtocol.js";
import { createBitfsSessionJournal, type BitfsSessionJournal } from "./sessionJournal.js";

const KIND2 = hex("88010258990100000001accc6415d60fa302ce4cadc28e8de6e263e2fef908f43a3700b6cbf189851336000000000002000000031f4e0000000000001976a91469e88a7a115208c28b96456ce9fc80200a054af388ac00000000000000001976a914150ad53b527c17121d3a6610e10dba337dab155d88ac00000000000000001976a91438406f79a0e51a78acd275d6a12fc3f1b6c5f68b88ac00943577582103eb2774617e6f89a5ac18dfcfda98ceb51d4610497f2cf09ef8810cbaf71e3313582103dc7e9e4a972a5b805b842998a734bd3bb5cb388be401cdc089e210cea325ef0d58210296a0b0f825e67323a9f807237acd5d95ba21108e38b5930ce06206decc601741015847304402205aa7658942e266be6716d0f3b706429e2d476d095cbd371ddc96cf36b2177f4b02206ded55c1c88e1acfeb735c41472d638efaedb3cfe7f12b0809495cf9e2bbeed841");

function fixedSigner(byte: number): Signer {
  const nibble = byte.toString(16).padStart(2, "0");
  const scalar = BigInt(`0x${nibble.repeat(64)}`) % 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const privateKey = hex(scalar.toString(16).padStart(64, "0"));
  return {
    publicKey: () => secp256k1.getPublicKey(privateKey, true),
    async sign(request) { return secp256k1.sign(request.digest, privateKey, { prehash: false, lowS: true, format: "der" }); },
  };
}

describe("BitFS 卖方协议端口", () => {
  it("在返回 Kind 3 前先保存 Kind 2/3，重复 Kind 2 重放同一 exact bytes", async () => {
    const store = createInMemoryOwnerFileStore();
    const sessions = createBitfsSessionJournal(store);
    const txJournal = createBitfsTransactionJournal(store);
    const broadcaster = new BitfsTransactionBroadcaster({
      journal: txJournal,
      chain: { broadcast: vi.fn(async () => ({ outcome: "accepted" as const })), lookupTransaction: vi.fn(async () => "unknown" as const) },
      nowMs: () => 1_000,
    });
    const seller = fixedSigner(0x22);
    const buyer = fixedSigner(0x44);
    const quote = await createSellerQuote({ nowUnixSeconds: 1n }, seller, {
      seedHash: new Uint8Array(32).fill(1), buyerPublicKey: buyer.publicKey(), seedPriceSatoshis: 1n,
      fullBlockPriceSatoshis: 1n, fileSizeBytes: 1n, quoteExpiresAtUnixSeconds: 2_000_000_000n,
      supportedArbiterPublicKeys: [fixedSigner(0x33).publicKey()], recommendedFilename: "fixture.bin",
    });
    const protocol = new BitfsSellerProtocol({
      signer: seller,
      sessions,
      content: { ready: true, async resolve() { throw new Error("not used"); } },
      broadcaster,
      ownerPublicKeyHex: toHex(seller.publicKey()),
      generation: () => 1,
      nowMs: () => 1_000,
      blockHeight: async () => 900_000,
    });
    await protocol.openSession({ sessionId: "sale-1", quoteBytes: quote.outbound.bytes(), seedHashHex: "01".repeat(32), counterpartyPublicKeyHex: toHex(buyer.publicKey()) });
    const first = await protocol.onFrame({ sessionId: "sale-1", kind: 2, bytes: KIND2 });
    expect(first.type).toBe("send");
    const firstBytes = first.type === "send" ? first.frames[0]! : new Uint8Array();
    expect(parse(firstBytes).kind).toBe(3);
    await expect(sessions.get("sale-1")).resolves.toMatchObject({ phase: "opening-presigned", evidence: expect.arrayContaining(["kind1-quote", "kind2-opening-request", "kind3-opening-response"]) });
    const replay = await protocol.onFrame({ sessionId: "sale-1", kind: 2, bytes: KIND2 });
    expect(replay.type === "send" ? replay.frames[0] : undefined).toEqual(firstBytes);
  });

  it("先落盘 Kind 7，并在恢复时重用已保存的交易签名", async () => {
    const sessions = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    const baseSigner = fixedSigner(0x22);
    let record = await sessions.create({
      sessionId: "seller-payment-resume", role: "seller", ownerPublicKeyHex: toHex(baseSigner.publicKey()),
      counterpartyPublicKeyHex: toHex(fixedSigner(0x44).publicKey()), seedHashHex: "cc".repeat(32), generation: 4,
      phase: "delivery-prepared",
    }, 1_000);
    const authorizationIdHex = "ab".repeat(32);
    const kind7 = new Uint8Array([7, 1, 2, 3]);
    const underlyingSign = vi.fn(async (request: Parameters<Signer["sign"]>[0]) => {
      expect(await sessions.getEvidence(record.sessionId, `kind7-payment-update-${authorizationIdHex}`)).toEqual(kind7);
      return baseSigner.sign(request);
    });
    const signer: Signer = { publicKey: () => baseSigner.publicKey(), sign: underlyingSign };
    const prepared = await persistSellerKind7BeforeSigning({ sessions, record, authorizationIdHex, kind7Bytes: kind7, signer, nowMs: 2_000 });
    record = prepared.record;
    expect(record.phase).toBe("payment-signing");

    const request = { purpose: "transaction" as const, wireKind: 0, digest: new Uint8Array(32).fill(0x77) };
    const firstSignature = await prepared.signer.sign(request);
    record = (await sessions.get(record.sessionId))!;
    const restored = await persistSellerKind7BeforeSigning({ sessions, record, authorizationIdHex, kind7Bytes: kind7, signer, nowMs: 3_000 });
    const replayedSignature = await restored.signer.sign(request);

    expect(replayedSignature).toEqual(firstSignature);
    expect(underlyingSign).toHaveBeenCalledTimes(1);
    expect(await sessions.getEvidence(record.sessionId, `kind7-payment-sign-digest-${authorizationIdHex}`)).toEqual(request.digest);
    expect(await sessions.getEvidence(record.sessionId, `kind7-payment-signature-${authorizationIdHex}`)).toEqual(firstSignature);
  });

  it("签名结果落盘前崩溃后，恢复路径拒绝再次调用签名器", async () => {
    const storedSessions = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    const baseSigner = fixedSigner(0x22);
    const authorizationIdHex = "cd".repeat(32);
    const signatureName = `kind7-payment-signature-${authorizationIdHex}` as const;
    let interruptSignatureWrite = true;
    const sessions: BitfsSessionJournal = {
      ...storedSessions,
      async putEvidence(...args) {
        if (interruptSignatureWrite && args[2] === signatureName) {
          interruptSignatureWrite = false;
          throw new Error("simulated crash before signature persistence");
        }
        return storedSessions.putEvidence(...args);
      },
    };
    const record = await sessions.create({
      sessionId: "seller-payment-signing", role: "seller", ownerPublicKeyHex: toHex(baseSigner.publicKey()),
      counterpartyPublicKeyHex: toHex(fixedSigner(0x44).publicKey()), seedHashHex: "dd".repeat(32), generation: 1,
      phase: "delivery-prepared",
    }, 1_000);
    const validSigner = fixedSigner(0x22);
    const signing = vi.fn(async (request: Parameters<Signer["sign"]>[0]) => {
      expect(await sessions.getEvidence(record.sessionId, `kind7-payment-update-${authorizationIdHex}`)).toEqual(new Uint8Array([7, 9]));
      return validSigner.sign(request);
    });
    const interrupted = await persistSellerKind7BeforeSigning({
      sessions, record, authorizationIdHex, kind7Bytes: new Uint8Array([7, 9]),
      signer: { publicKey: () => baseSigner.publicKey(), sign: signing }, nowMs: 2_000,
    });
    const request = { purpose: "transaction" as const, wireKind: 0, digest: new Uint8Array(32).fill(0x55) };
    await expect(interrupted.signer.sign(request)).rejects.toThrow(/simulated crash before signature persistence/u);
    expect(signing).toHaveBeenCalledTimes(1);
    expect(await sessions.getEvidence(record.sessionId, `kind7-payment-sign-digest-${authorizationIdHex}`)).toEqual(request.digest);
    expect(await sessions.getEvidence(record.sessionId, signatureName)).toBeUndefined();
    const latest = (await sessions.get(record.sessionId))!;
    const recovered = await persistSellerKind7BeforeSigning({
      sessions, record: latest, authorizationIdHex, kind7Bytes: new Uint8Array([7, 9]),
      signer: { publicKey: () => baseSigner.publicKey(), sign: signing }, nowMs: 3_000,
    });
    await expect(recovered.signer.sign(request)).rejects.toThrow(/恢复路径禁止再次调用签名器/u);
    expect(signing).toHaveBeenCalledTimes(1);
    await expect(sessions.getEvidence(record.sessionId, signatureName)).resolves.toBeUndefined();
    await expect(sessions.get(record.sessionId)).resolves.toMatchObject({ phase: "payment-signing" });
  });
});

function hex(value: string): Uint8Array { return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16)); }
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
