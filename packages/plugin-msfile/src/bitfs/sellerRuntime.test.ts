// Channel → 卖方匹配边界：只接受 SDK 品牌化请求，按库存、locator、身份与去重键决定是否报价。

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HASH_REQUEST_CHANNEL, messageIDFromBytes, parsePrivateKey, parsePublicKey, parseSHA256Hash } from "bsv8-channel-protocol";
import { marshal, newMultiaddrLocator, newWebRTCSDPLocator, parseAndVerify, sign } from "bsv8-channel-protocol/hash-request";
import { parse, type Artifact, type Signer } from "go-bitfs";
import { deriveSupplierPeerId } from "../supplierConfig.js";
import type { BitfsJournal } from "./journal.js";
import type { BitfsSeedIndex } from "./seedIndex.js";
import { BitfsSellerRuntime } from "./sellerRuntime.js";

const SEED_HASH = "11".repeat(32);
const NOW = 1_000;

function verifiedRequest(locator: ReturnType<typeof newMultiaddrLocator> | ReturnType<typeof newWebRTCSDPLocator>, messageByte = 0x44) {
  const privateBytes = new Uint8Array(32);
  privateBytes[31] = 2;
  const privateKey = parsePrivateKey(privateBytes);
  const publicKeyHex = Array.from(secp256k1.getPublicKey(privateBytes, true), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signed = sign({
    from_public_key: parsePublicKey(publicKeyHex),
    message_id: messageIDFromBytes(new Uint8Array(32).fill(messageByte)),
    issued_at_ms: NOW - 100,
    expires_at_ms: NOW + 10_000,
    body: { hash: parseSHA256Hash(SEED_HASH), locators: [locator] },
  }, privateKey);
  return parseAndVerify(HASH_REQUEST_CHANNEL, marshal(signed));
}

function fixture() {
  const prepareOutbound = vi.fn(async (_id: string, _role: "seller", _artifact: Artifact, _nowMs: number) => new Uint8Array([1, 2, 3]));
  const privateKey = new Uint8Array(32);
  privateKey[31] = 1;
  const signer: Signer = {
    publicKey: () => secp256k1.getPublicKey(privateKey, true),
    async sign(request) {
      return secp256k1.sign(request.digest, privateKey, { prehash: false, lowS: true, format: "der" });
    },
  };
  const index = {
    get: (seedHashHex: string) => seedHashHex === SEED_HASH
      ? { seedHashHex, fileName: "fixture.bin", mediaType: "application/octet-stream", fileSizeBytes: "3", blockCount: 1, availability: "available" as const }
      : undefined,
  } as BitfsSeedIndex;
  const runtime = new BitfsSellerRuntime({
    signer,
    index,
    journal: { prepareOutbound } as unknown as BitfsJournal,
    settings: () => ({ sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 300, maxConcurrentSales: 1, supportedArbiterPublicKeys: [] }),
    nowMs: () => NOW,
  });
  return { runtime, prepareOutbound };
}

describe("BitFS 卖方 Channel 匹配", () => {
  it("命中库存且 locator 的 PeerId 与已验证公钥一致时创建并先持久化报价", async () => {
    const privateBytes = new Uint8Array(32);
    privateBytes[31] = 2;
    const publicKeyHex = Array.from(secp256k1.getPublicKey(privateBytes, true), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const peerId = deriveSupplierPeerId(publicKeyHex);
    const request = verifiedRequest(newMultiaddrLocator(`/dns4/buyer.example/tcp/443/tls/ws/p2p/${peerId}`));
    const { runtime, prepareOutbound } = fixture();
    await expect(runtime.match(request)).resolves.toMatchObject({ addresses: [`/dns4/buyer.example/tcp/443/tls/ws/p2p/${peerId}`], quoteBytes: new Uint8Array([1, 2, 3]) });
    expect(prepareOutbound).toHaveBeenCalledTimes(1);
    expect(parse((prepareOutbound.mock.calls[0]?.[2] as { bytes(): Uint8Array }).bytes()).kind).toBe(1);
    await expect(runtime.match(request)).resolves.toBeNull();
  });

  it("未命中、webrtc-sdp 和伪造未品牌化对象均不会被当作可销售请求", async () => {
    const { runtime, prepareOutbound } = fixture();
    const noLocator = verifiedRequest(newWebRTCSDPLocator());
    await expect(runtime.match(noLocator)).resolves.toBeNull();
    expect(prepareOutbound).not.toHaveBeenCalled();
    await expect(runtime.match({ ...noLocator })).rejects.toThrow(/VerifiedHashRequest/u);
  });
});
