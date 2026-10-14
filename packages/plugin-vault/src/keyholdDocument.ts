// 官方 KeyHold 只加密私钥；钱包封装另存并认证创建时的网络，不修改 SDK 格式。
import { exportPrivateKey, parseDocument, recommendedParameters, serializeDocument, unlockDocument } from "keyhold";
import { validateBsvNetwork, type BsvNetwork, type NetworkKeyHoldDocument } from "@keymaster/contracts";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

function authentication(privateKey: Uint8Array, network: BsvNetwork, publicKeyHex: string): string {
  return bytesToHex(hmac(sha256, privateKey, new TextEncoder().encode(`keymaster.network-identity.v1:${network}:${publicKeyHex}`)));
}
function hold(document: NetworkKeyHoldDocument) {
  const { bsvNetwork: _network, networkAuthenticationHex: _authentication, ...keyHold } = document;
  return keyHold;
}
export function parseKeyHoldDocument(input: string | Uint8Array): NetworkKeyHoldDocument {
  const raw = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (raw.startsWith("\ufeff")) throw new TypeError("KeyHold BOM is not allowed");
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  if (envelope.format !== "keymaster.network-keyhold" || envelope.version !== 1 || !["bsvNetwork,format,keyHold,networkAuthenticationHex,version", "backend,bsvNetwork,format,keyHold,networkAuthenticationHex,version"].includes(Object.keys(envelope).sort().join(",")) || (envelope.backend !== undefined && envelope.backend !== "software")) throw new TypeError("Wallet network is missing; explicit identity upgrade is required");
  const bsvNetwork = validateBsvNetwork(envelope.bsvNetwork);
  if (typeof envelope.networkAuthenticationHex !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.networkAuthenticationHex)) throw new TypeError("Wallet network authentication is invalid");
  return { ...parseDocument(JSON.stringify(envelope.keyHold)), bsvNetwork, networkAuthenticationHex: envelope.networkAuthenticationHex };
}
export function exportPortableKeyHoldDocument(document: NetworkKeyHoldDocument): string {
  return serializeDocument(hold(document));
}
export function serializeKeyHoldDocument(document: NetworkKeyHoldDocument): string {
  return JSON.stringify({ format: "keymaster.network-keyhold", version: 1, backend: "software", bsvNetwork: validateBsvNetwork(document.bsvNetwork), networkAuthenticationHex: document.networkAuthenticationHex, keyHold: JSON.parse(serializeDocument(hold(document))) });
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
export async function createKeyHoldDocument(input: { label: string; privateKey: Uint8Array; bsvNetwork: BsvNetwork }, password: string, options?: { iterations?: number }): Promise<NetworkKeyHoldDocument> {
  const bsvNetwork = validateBsvNetwork(input.bsvNetwork);
  const recommended = recommendedParameters();
  const parameters = options?.iterations === undefined ? recommended : { ...recommended, keyDerivation: { ...recommended.keyDerivation, iterations: options.iterations } };
  const keyHold = parseDocument(await exportPrivateKey({ privateKey: input.privateKey, password, label: input.label, parameters }));
  return { ...keyHold, bsvNetwork, networkAuthenticationHex: authentication(input.privateKey, bsvNetwork, keyHold.publicKeyHex) };
}
