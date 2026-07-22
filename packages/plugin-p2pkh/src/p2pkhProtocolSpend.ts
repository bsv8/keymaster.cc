// P2PKH 协议 spend：受控签名 + 广播任意输出计划。

import type {
  BsvNetwork,
  ProtocolSpendInput,
  ProtocolSpendOutput,
  ProtocolSpendPrepareInput,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService,
  ProtectedOutpointRegistry,
  WocService,
  VaultService
} from "@keymaster/contracts";
import { calcTxidFromRawTxHex, rawTxHexByteLength, signP2pkhTx, type UnsignedTx } from "./p2pkhSigner.js";
import { resourceIdFor } from "./p2pkhDb.js";

type P2pkhInputOutpoint = Pick<ProtocolSpendInput, "txid" | "vout">;

export interface P2pkhProtocolSpendClaimStore {
  tryClaimInputs(input: {
    submissionId: string;
    resourceId: string;
    publicKeyHex: string;
    network: BsvNetwork;
    inputs: P2pkhInputOutpoint[];
  }): Promise<{ claimIds: string[] }>;
  releaseLocalInputClaims(input: { publicKeyHex: string; claimIds: string[] }): Promise<void>;
}

export interface P2pkhProtocolSpendDeps {
  vault: VaultService;
  woc: WocService;
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<{ publicKeyHex: string }>;
  claimStore: P2pkhProtocolSpendClaimStore;
  protectedOutpoints?: ProtectedOutpointRegistry;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function buildUnsignedTx(
  inputs: ProtocolSpendInput[],
  outputs: ProtocolSpendOutput[],
  changeAddress: string | undefined,
  changeSatoshis: number
): UnsignedTx {
  const txInputs = inputs.map((u) => ({
    prevTxid: u.txid,
    prevVout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: 0xfffffffe
  }));
  const txOutputs = [
    ...outputs.map((o) => ({ value: o.value, script: hexToBytes(o.scriptHex) })),
    ...(changeAddress && changeSatoshis > 0
      ? [{ value: changeSatoshis, script: addressToP2pkhScript(changeAddress) }]
      : [])
  ];
  return { version: 1, inputs: txInputs, outputs: txOutputs, lockTime: 0 };
}

function addressToP2pkhScript(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error("Invalid P2PKH address");
  }
  const version = decoded[0]!;
  if (version !== 0x00 && version !== 0x6f) {
    throw new Error("Unsupported P2PKH address network");
  }
  const hash160 = decoded.slice(1, 21);
  return Uint8Array.from([
    0x76,
    0xa9,
    0x14,
    ...hash160,
    0x88,
    0xac
  ]);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58 character");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = (carry / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
}

async function resolveOwnerKeyIdentity(
  deps: P2pkhProtocolSpendDeps,
  ownerPublicKeyHex: string
): Promise<{ publicKeyHex: string }> {
  const key = await deps.getKeyForOwner(ownerPublicKeyHex);
  if (!key.publicKeyHex) {
    throw new Error(`P2PKH protocol spend: owner ${ownerPublicKeyHex} is not ready`);
  }
  if (key.publicKeyHex !== ownerPublicKeyHex) {
    throw new Error(`P2PKH protocol spend: resolved key ${key.publicKeyHex} != ${ownerPublicKeyHex}`);
  }
  return key;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertUnprotectedInputs(
  registry: ProtectedOutpointRegistry | undefined,
  input: ProtocolSpendPrepareInput
): void {
  if (!registry) return;
  for (const utxo of input.inputs) {
    if (!input.requestingPluginId && registry.isProtected({
      txid: utxo.txid,
      vout: utxo.vout,
      network: input.network,
      publicKeyHex: input.ownerPublicKeyHex
    })) {
      throw new Error(`Protocol spend blocked by protected outpoint: ${utxo.txid}:${utxo.vout}`);
    }
  }
}

function isDefinitivelyRejectedError(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("network")) {
    return false;
  }
  if (/\b4\d\d\b/.test(lower) && !/\b429\b/.test(lower)) return true;
  return lower.includes("rejected") || lower.includes("invalid transaction") || lower.includes("bad-txns");
}

export function createP2pkhProtocolSpendService(deps: P2pkhProtocolSpendDeps): ProtocolSpendService {
  return {
    async prepare(input: ProtocolSpendPrepareInput): Promise<ProtocolSpendPreview> {
      let protectedClaimIds: string[] = [];
      let inputClaimIds: string[] = [];
      const submissionId = crypto.randomUUID();
      try {
        assertUnprotectedInputs(deps.protectedOutpoints, input);
        const resolvedOwner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
        if (deps.protectedOutpoints) {
          const hasProtectedInputs = input.inputs.some((u) => deps.protectedOutpoints?.isProtected({
            txid: u.txid,
            vout: u.vout,
            network: input.network,
            publicKeyHex: input.ownerPublicKeyHex
          }));
          if (hasProtectedInputs && !input.requestingPluginId) {
            throw new Error("Protocol spend requires requestingPluginId for protected inputs");
          }
          if (input.requestingPluginId) {
            protectedClaimIds = (await deps.protectedOutpoints.claimProtectedInputs({
              ownerPluginId: input.requestingPluginId,
              publicKeyHex: input.ownerPublicKeyHex,
              network: input.network,
              inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout }))
            })).claimIds;
          }
        }
        const inputs = input.inputs.map((u) => ({
          id: `${u.txid}:${u.vout}`,
          resourceId: "protocol-spend",
          publicKeyHex: resolvedOwner.publicKeyHex,
          network: input.network,
          status: "confirmed" as const,
          isSpentInMempoolTx: false,
          syncedAt: new Date().toISOString(),
          txid: u.txid,
          vout: u.vout,
          value: normalizePositiveInteger(u.value, "Input value"),
          address: u.address
        }));
        const outputs = input.outputs.map((o) => ({
          value: normalizePositiveInteger(o.value, "Output value"),
          scriptHex: o.scriptHex,
          label: o.label
        }));
        inputClaimIds = (await deps.claimStore.tryClaimInputs({
          submissionId,
          resourceId: resourceIdFor(input.network),
          publicKeyHex: resolvedOwner.publicKeyHex,
          network: input.network,
          inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout }))
        })).claimIds;
        const totalInput = inputs.reduce((sum, u) => sum + u.value, 0);
        const fixedOutput = outputs.reduce((sum, o) => sum + o.value, 0);
        let feeSatoshis = 1;
        for (let round = 0; round < 12; round++) {
          const changeSatoshis = totalInput - fixedOutput - feeSatoshis;
          if (changeSatoshis < 0) {
            throw new Error(`Protocol spend failed: insufficient inputs (${totalInput}) for outputs (${fixedOutput}) and fee (${feeSatoshis})`);
          }
          if (!input.changeAddress && changeSatoshis > 0) {
            throw new Error("Protocol spend requires changeAddress when inputs exceed outputs + fee");
          }
          const unsigned = buildUnsignedTx(inputs, outputs, input.changeAddress, changeSatoshis);
          const activeCrypto = await deps.vault.createActiveKeyCrypto(resolvedOwner.publicKeyHex);
          const rawTxHex = await signP2pkhTx(
            unsigned,
            inputs,
            async (digest) => {
              const res = await activeCrypto.signDigest({
                publicKeyHex: resolvedOwner.publicKeyHex,
                digest: new Uint8Array(digest).buffer,
                format: "der"
              });
              if (res.format !== "der") {
                throw new Error(`signDigest format mismatch: got ${res.format}`);
              }
              return new Uint8Array(res.signature);
            },
            resolvedOwner.publicKeyHex
          );
          const serializedSizeBytes = rawTxHexByteLength(rawTxHex);
          const nextFee = Math.max(1, Math.ceil((serializedSizeBytes * input.feeRateSatoshisPerKb) / 1000));
          if (nextFee === feeSatoshis || (nextFee <= feeSatoshis && !input.changeAddress)) {
            return {
              ownerPublicKeyHex: resolvedOwner.publicKeyHex,
              requestingPluginId: input.requestingPluginId,
              network: input.network,
              inputs,
              outputs,
              changeAddress: input.changeAddress,
              changeSatoshis,
              estimatedFeeSatoshis: feeSatoshis,
              serializedSizeBytes,
              txid: calcTxidFromRawTxHex(rawTxHex),
              rawTxHex,
              protectedClaimIds,
              inputClaimIds,
              submissionId
            };
          }
          feeSatoshis = nextFee;
        }
        throw new Error("Protocol spend fee failed to converge");
      } catch (err) {
        if (protectedClaimIds.length > 0 && deps.protectedOutpoints) {
          await deps.protectedOutpoints.releaseClaims(protectedClaimIds);
        }
        if (inputClaimIds.length > 0) {
          await deps.claimStore.releaseLocalInputClaims({
            publicKeyHex: input.ownerPublicKeyHex,
            claimIds: inputClaimIds
          });
        }
        throw err;
      }
    },

    async submit(preview): Promise<ProtocolSpendResult> {
      try {
        const broadcastRes = await deps.woc.broadcast(preview.network, preview.rawTxHex, { timeoutMs: 30_000 });
        return {
          status: broadcastRes.txidIntegrity === "mismatch" ? "provider-inconsistent" : "broadcast",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          inputClaimIds: preview.inputClaimIds,
          submissionId: preview.submissionId,
          canonicalTxid: broadcastRes.canonicalTxid,
          providerReturnedTxidRaw: broadcastRes.providerReturnedTxidRaw,
          providerReturnedTxidNormalized: broadcastRes.providerReturnedTxidNormalized,
          txidIntegrity: broadcastRes.txidIntegrity
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (preview.protectedClaimIds && preview.protectedClaimIds.length > 0 && deps.protectedOutpoints && isDefinitivelyRejectedError(msg)) {
          await deps.protectedOutpoints.releaseClaims(preview.protectedClaimIds);
        }
        if (preview.inputClaimIds && preview.inputClaimIds.length > 0 && isDefinitivelyRejectedError(msg)) {
          await deps.claimStore.releaseLocalInputClaims({
            publicKeyHex: preview.ownerPublicKeyHex,
            claimIds: preview.inputClaimIds
          });
        }
        if (isDefinitivelyRejectedError(msg)) {
          return {
            status: "rejected",
            txid: preview.txid,
            rawTxHex: preview.rawTxHex,
            inputClaimIds: preview.inputClaimIds,
            submissionId: preview.submissionId,
            error: msg
          };
        }
        return {
          status: "unknown",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          inputClaimIds: preview.inputClaimIds,
          submissionId: preview.submissionId,
          error: msg
        };
      }
    }
  };
}
