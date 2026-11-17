// 官方 KeyHold 只加密私钥；钱包封装另存并认证创建时的网络，不修改 SDK 格式。
import { exportPrivateKey, parseDocument, recommendedParameters, serializeDocument, unlockDocument } from "keyhold";
import { KEYHOLD_LIMITS, validateBsvNetwork, type BsvNetwork, type NetworkKeyHoldDocument } from "@keymaster/contracts";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

function authentication(privateKey: Uint8Array, network: BsvNetwork, publicKeyHex: string): string {
  return bytesToHex(hmac(sha256, privateKey, new TextEncoder().encode(`keymaster.network-identity.v1:${network}:${publicKeyHex}`)));
}
function hold(document: NetworkKeyHoldDocument) {
  const { bsvNetwork: _network, networkAuthenticationHex: _authentication, walletGeneration: _generation, ...keyHold } = document;
  return keyHold;
}
export function parseKeyHoldDocument(input: string | Uint8Array): NetworkKeyHoldDocument {
  const raw = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (raw.startsWith("\ufeff")) throw new TypeError("KeyHold BOM is not allowed");
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  if (envelope.format !== "keymaster.network-keyhold" || envelope.version !== 1
    || !["bsvNetwork", "format", "keyHold", "networkAuthenticationHex", "version"].every(key => Object.hasOwn(envelope, key))
    || Object.keys(envelope).some(key => !["bsvNetwork", "format", "keyHold", "networkAuthenticationHex", "version", "backend", "walletGeneration"].includes(key))
    || (envelope.backend !== undefined && envelope.backend !== "software")) throw new TypeError("Wallet network is missing; explicit identity upgrade is required");
  if (envelope.walletGeneration !== undefined && (typeof envelope.walletGeneration !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(envelope.walletGeneration))) {
    throw new TypeError("Wallet generation is invalid");
  }
  const bsvNetwork = validateBsvNetwork(envelope.bsvNetwork);
  if (typeof envelope.networkAuthenticationHex !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.networkAuthenticationHex)) throw new TypeError("Wallet network authentication is invalid");
  return { ...parseDocument(JSON.stringify(envelope.keyHold)), bsvNetwork, networkAuthenticationHex: envelope.networkAuthenticationHex, ...(envelope.walletGeneration === undefined ? {} : { walletGeneration: envelope.walletGeneration as string }) };
}
export function exportPortableKeyHoldDocument(document: NetworkKeyHoldDocument): string {
  return serializeDocument(hold(document));
}
export function serializeKeyHoldDocument(document: NetworkKeyHoldDocument): string {
  return JSON.stringify({ format: "keymaster.network-keyhold", version: 1, backend: "software", ...(document.walletGeneration === undefined ? {} : { walletGeneration: document.walletGeneration }), bsvNetwork: validateBsvNetwork(document.bsvNetwork), networkAuthenticationHex: document.networkAuthenticationHex, keyHold: JSON.parse(serializeDocument(hold(document))) });
}
export async function decryptKeyHoldDocument(document: NetworkKeyHoldDocument, password: string): Promise<{ label: string; publicKeyHex: string; privateKey: Uint8Array }> {
  const result = await unlockDocument(hold(document), password);
  const expected = hexToBytes(authentication(result.privateKey, document.bsvNetwork, result.publicKeyHex));
  const actual = hexToBytes(document.networkAuthenticationHex);
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= expected[i]! ^ (actual[i] ?? 0);
  if (difference !== 0 || result.publicKeyHex !== document.publicKeyHex) {
    result.privateKey.fill(0);
    throw new TypeError("Wallet network identity authentication failed");
  }
  return { label: document.label, publicKeyHex: result.publicKeyHex, privateKey: result.privateKey };
}
export async function createKeyHoldDocument(input: { label: string; privateKey: Uint8Array; bsvNetwork: BsvNetwork }, password: string, options?: { iterations?: number }): Promise<NetworkKeyHoldDocument & { walletGeneration: string }> {
  const bsvNetwork = validateBsvNetwork(input.bsvNetwork);
  const recommended = recommendedParameters();
  const parameters = options?.iterations === undefined ? recommended : { ...recommended, keyDerivation: { ...recommended.keyDerivation, iterations: options.iterations } };
  const keyHold = parseDocument(await exportPrivateKey({ privateKey: input.privateKey, password, label: input.label, parameters }));
  return { ...keyHold, walletGeneration: crypto.randomUUID(), bsvNetwork, networkAuthenticationHex: authentication(input.privateKey, bsvNetwork, keyHold.publicKeyHex) };
}

export function serializeVaultFiles(document: NetworkKeyHoldDocument): import("@keymaster/contracts/storage-internal").WalletVaultFiles {
  const envelope = JSON.parse(serializeKeyHoldDocument(document));
  const { keyHold, ...network } = envelope;
  return { key: new TextEncoder().encode(JSON.stringify(keyHold)), network: new TextEncoder().encode(JSON.stringify({ ...network, format: "keymaster.network", publicKeyHex: document.publicKeyHex })) };
}
export function parseVaultFiles(key: Uint8Array, network: Uint8Array): NetworkKeyHoldDocument {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (key.byteLength > KEYHOLD_LIMITS.maxSerializedBytes || network.byteLength > 16 * 1024) throw new TypeError("Wallet bootstrap file exceeds its limit");
  const metadata = JSON.parse(decoder.decode(network));
  if (!metadata || metadata.format !== "keymaster.network" || typeof metadata.walletGeneration !== "string") throw new TypeError("Wallet network file is invalid");
  const { publicKeyHex, ...envelope } = metadata;
  const document = parseKeyHoldDocument(JSON.stringify({ ...envelope, format: "keymaster.network-keyhold", keyHold: JSON.parse(decoder.decode(key)) }));
  if (publicKeyHex !== document.publicKeyHex) throw new TypeError("Wallet bootstrap identity mismatch");
  return document;
}
