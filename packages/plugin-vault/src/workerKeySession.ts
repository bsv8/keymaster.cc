import type { CoordinatorCryptoOperation, CoordinatorCryptoResult, EcdsaSignatureFormat } from "@keymaster/contracts";
import { parsePrivateKey, parsePublicKey, publicKeyFromPrivate, inboxChannel, parseMessageID } from "bsv8-channel-protocol";
import { sign as signPublic } from "bsv8-channel-protocol/public-message";
import { sign as signHash } from "bsv8-channel-protocol/hash-request";
import { signPrivateMessage, sealSigned, open, privateMessageMaxLifetimeMs, type UnsignedPrivateMessage, type SignedPrivateMessage } from "bsv8-channel-protocol/inbox";
import { bytesToHex, hexToBytes, signEcdsaDigest, deriveP2pkhAddress, verifySessionKeyPair } from "./sessionCryptoCore.js";

export interface WorkerKeyIdentity { unlocked: boolean; publicKeyHex?: string; sessionEpoch: string }
export interface PrivateMessageSigningInput {
  recipientPublicKeyHex: string;
  protocol: UnsignedPrivateMessage["protocol"];
  body: UnsignedPrivateMessage["body"];
  messageId: string;
  nowMs: number;
}

function signPrivate(input: PrivateMessageSigningInput, privateKey: Uint8Array): SignedPrivateMessage {
  const recipient = parsePublicKey(input.recipientPublicKeyHex);
  return signPrivateMessage({
    channel: inboxChannel(recipient), from_public_key: publicKeyFromPrivate(privateKey),
    message_id: parseMessageID(input.messageId), issued_at_ms: input.nowMs,
    expires_at_ms: input.nowMs + privateMessageMaxLifetimeMs(input.protocol),
    protocol: input.protocol, body: input.body,
  } as UnsignedPrivateMessage, privateKey);
}

/** Worker-only key owner. Operations never return key bytes or a key object. */
export function createWorkerKeySession(identity: () => WorkerKeyIdentity) {
  let privateKeyBytes: Uint8Array | undefined;
  let generation = 0;
  const assert = (expected?: { publicKeyHex?: string; sessionEpoch?: string; generation?: number }) => {
    const current = identity();
    if (!privateKeyBytes || !current.unlocked || !current.publicKeyHex
      || expected?.publicKeyHex !== undefined && expected.publicKeyHex !== current.publicKeyHex
      || expected?.sessionEpoch !== undefined && expected.sessionEpoch !== current.sessionEpoch
      || expected?.generation !== undefined && expected.generation !== generation) throw new Error("Vault is locked or active key changed");
    verifySessionKeyPair({ publicKeyHex: current.publicKeyHex, privateKeyBytes });
    return { ...current, generation };
  };
  const key = () => { assert(); return parsePrivateKey(privateKeyBytes!); };
  const session = {
    replace(next: Uint8Array | undefined) {
      if (privateKeyBytes && privateKeyBytes !== next) privateKeyBytes.fill(0);
      privateKeyBytes = next; generation++;
    },
    clear() { session.replace(undefined); },
    hasKey: () => privateKeyBytes !== undefined,
    assert(publicKeyHex?: string, sessionEpoch?: string) { assert({ publicKeyHex, sessionEpoch }); },
    async signDigest(digest: Uint8Array, format: EcdsaSignatureFormat, publicKeyHex?: string) {
      const captured = assert({ publicKeyHex });
      const signature = await signEcdsaDigest({ privateKeyBytes: privateKeyBytes!, digest, format });
      assert(captured); return signature;
    },
    async execute(operation: CoordinatorCryptoOperation): Promise<CoordinatorCryptoResult> {
      const current = assert();
      if (operation.type === "deriveP2pkhAddress") return { type: operation.type, address: deriveP2pkhAddress(current.publicKeyHex!, operation.network) };
      if (operation.type === "signDigest") {
        const signature = await session.signDigest(hexToBytes(operation.digestHex), operation.format, current.publicKeyHex);
        assert(current); return { type: operation.type, signatureHex: bytesToHex(signature), format: operation.format };
      }
      throw new Error("Unsupported coordinator crypto operation");
    },
    signPublic(input: Omit<Parameters<typeof signPublic>[0], "from_public_key">) {
      const privateKey = key(); return signPublic({ ...input, from_public_key: publicKeyFromPrivate(privateKey) }, privateKey);
    },
    signHash(input: Omit<Parameters<typeof signHash>[0], "from_public_key">) {
      const privateKey = key(); return signHash({ ...input, from_public_key: publicKeyFromPrivate(privateKey) }, privateKey);
    },
    signPrivate(input: PrivateMessageSigningInput) { return signPrivate(input, key()); },
    async seal(signed: SignedPrivateMessage) {
      const captured = assert();
      if (signed.from_public_key !== captured.publicKeyHex) throw new Error("Channel owner key mismatch");
      const result = await sealSigned(signed, key()); assert(captured); return result;
    },
    async open(channel: Parameters<typeof open>[0], envelope: Parameters<typeof open>[1]) {
      const captured = assert(); const result = await open(channel, envelope, key()); assert(captured); return result;
    },
    async deriveLocalSecretKey(scope: string): Promise<CryptoKey> {
      const captured = assert();
      const baseKey = await crypto.subtle.importKey("raw", privateKeyBytes! as BufferSource, "HKDF", false, ["deriveBits"]);
      assert(captured);
      const rawBits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
        salt: new TextEncoder().encode("keymaster.vault.local-secret.v3"),
        info: new TextEncoder().encode(`${captured.publicKeyHex!.toLowerCase()}\0${scope}`),
      }, baseKey, 256));
      try {
        assert(captured);
        const result = await crypto.subtle.importKey("raw", rawBits as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        assert(captured); return result;
      } finally { rawBits.fill(0); }
    },
  };
  return Object.freeze(session);
}

/** Deterministic protocol fixtures use the same signing implementation as the Worker owner. */
export function signPrivateMessageForFixture(input: PrivateMessageSigningInput & { privateKeyHex: string }): SignedPrivateMessage {
  const bytes = hexToBytes(input.privateKeyHex);
  try { return signPrivate(input, parsePrivateKey(bytes)); } finally { bytes.fill(0); }
}
