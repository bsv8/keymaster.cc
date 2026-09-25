import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";
import { loadE2ETestnetKeysConfig } from "../config/loader.js";
import type { E2ETestnetKeysConfig } from "../config/types.js";
import { deriveTestnetP2pkhAddressFromPrivateKey } from "../testnet/fundingResource.js";

export const BITFS_E2E_FILE_RELATIVE_PATH = "data/16944946-uhd_3840_2160_60fps.mp4";
export const BITFS_E2E_SEED_PRICE_SATOSHIS = 1n;
export const BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS = 1n;
export const BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB = 100n;
export const BITFS_E2E_FUNDING_MAX_FEE_SATOSHIS = 1_000n;

export interface BitfsKeyMaterial {
  readonly config: E2ETestnetKeysConfig;
  readonly buyerPublicKeyHex: string;
  readonly sellerPublicKeyHex: string;
  readonly buyerAddress: string;
  readonly sellerAddress: string;
}

export interface BitfsBuyerBudget {
  readonly fileSizeBytes: bigint;
  readonly blockCount: bigint;
  readonly openingAmountSatoshis: bigint;
  readonly minimumFundingSatoshis: bigint;
  readonly targetFundingSatoshis: bigint;
  readonly buyerFundingSatoshis: bigint;
}

function publicKeyHexFromPrivateKey(privateKeyHex: string): string {
  return bytesToHex(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(privateKeyHex, "hex")))).toLowerCase();
}

export async function loadBitfsKeyMaterial(options: { readonly workspaceRoot?: string; readonly configDir?: string } = {}): Promise<BitfsKeyMaterial> {
  const config = await loadE2ETestnetKeysConfig(options);
  const buyerPrivateKeyHex = config.key01PrivateKeyHex.read();
  const sellerPrivateKeyHex = config.key02PrivateKeyHex.read();
  const buyerPublicKeyHex = publicKeyHexFromPrivateKey(buyerPrivateKeyHex);
  const sellerPublicKeyHex = publicKeyHexFromPrivateKey(sellerPrivateKeyHex);
  if (buyerPublicKeyHex === sellerPublicKeyHex) throw new Error("BitFS 买方与卖方公钥不能相同");
  return {
    config,
    buyerPublicKeyHex,
    sellerPublicKeyHex,
    buyerAddress: deriveTestnetP2pkhAddressFromPrivateKey(buyerPrivateKeyHex),
    sellerAddress: deriveTestnetP2pkhAddressFromPrivateKey(sellerPrivateKeyHex),
  };
}

export function bitfsFilePath(config: Pick<E2ETestnetKeysConfig, "directory">): string {
  return process.env.BITFS_E2E_FILE_PATH?.trim() || join(config.directory, BITFS_E2E_FILE_RELATIVE_PATH);
}

export async function readBitfsSeedHash(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) throw new Error("BitFS E2E 文件不存在或为空");
  const bytes = await readFile(filePath);
  const digests: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 262144) {
    digests.push(createHash("sha256").update(bytes.subarray(offset, Math.min(offset + 262144, bytes.byteLength))).digest());
  }
  return createHash("sha256").update(Buffer.concat(digests)).digest("hex");
}

export function calculateBitfsBuyerBudget(fileSizeBytes: bigint): BitfsBuyerBudget {
  if (fileSizeBytes <= 0n) throw new Error("BitFS E2E 文件大小必须大于 0");
  const blockCount = (fileSizeBytes + 262143n) / 262144n;
  const openingAmountSatoshis = BITFS_E2E_SEED_PRICE_SATOSHIS
    + BITFS_E2E_FULL_BLOCK_PRICE_SATOSHIS * blockCount
    + BITFS_E2E_POOL_FEE_RATE_SATOSHIS_PER_KB * 2n;
  const minimumFundingSatoshis = openingAmountSatoshis + BITFS_E2E_FUNDING_MAX_FEE_SATOSHIS;
  const targetFundingSatoshis = (minimumFundingSatoshis * 120n + 99n) / 100n;
  const buyerFundingSatoshis = targetFundingSatoshis + BITFS_E2E_FUNDING_MAX_FEE_SATOSHIS;
  return {
    fileSizeBytes,
    blockCount,
    openingAmountSatoshis,
    minimumFundingSatoshis,
    targetFundingSatoshis,
    buyerFundingSatoshis,
  };
}
