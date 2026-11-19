import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { sha256Bytes } from "bitcoin-libp2p/identity";
import { Digest } from "masterseed";
import { commitPurchasedMsFileContent } from "../storage/msfileSeedStore.js";

export interface BitfsWindowContentCommit {
  seedHashHex: string;
  fileName: string;
  mediaType: string;
}

export async function prepareBitfsWindowContent(
  store: BorrowedModuleFileStore,
  input: BitfsWindowContentCommit,
  signal?: AbortSignal,
): Promise<void> {
  const { seedHashHex, fileName, mediaType } = input;
  const prefix = stagingPrefix(seedHashHex);
  const seed = await store.get(`${prefix}/seed.bin`, { signal });
  if (!seed) throw new Error("BitFS 入库缺少已验收 Seed");

  await commitPurchasedMsFileContent({
    store, seedHashHex, fileName, mediaType, seedBytes: seed.bytes, signal,
    async readBlock(_index, hash, blockSignal) {
      const block = await store.get(`${prefix}/blocks/${hash}.bin`, { signal: blockSignal });
      if (!block) throw new Error(`BitFS 入库缺少已验收 Block：${hash}`);
      return block.bytes;
    },
  });
}

export interface BitfsWindowContentPart {
  seedHashHex: string;
  blockHashHex?: string;
  wire: Uint8Array;
}

function stagingPrefix(seedHashHex: string): string {
  if (!/^[0-9a-f]{64}$/u.test(seedHashHex)) throw new Error("BitFS Seed Hash 无效");
  return `bitfs-staging/by-seed/${seedHashHex}`;
}

export async function stageBitfsWindowContent(
  store: BorrowedModuleFileStore,
  input: BitfsWindowContentPart,
  signal: AbortSignal,
): Promise<void> {
  const { wire, seedHashHex, blockHashHex } = input;
  const hash = blockHashHex ?? seedHashHex;
  if (!/^[0-9a-f]{64}$/u.test(hash) || contentHash(wire) !== hash) throw new Error("BitFS 下载内容哈希不符");
  const prefix = stagingPrefix(seedHashHex);
  const path = blockHashHex ? `${prefix}/blocks/${blockHashHex}.bin` : `${prefix}/seed.bin`;
  try {
    await store.put(path, wire, { ifNoneMatch: true, signal });
  } catch (error) {
    signal.throwIfAborted();
    const prior = await store.get(path, { signal });
    if (!prior || contentHash(prior.bytes) !== hash) throw error;
  }
}

function contentHash(bytes: Uint8Array): string {
  return Digest.fromBytes(sha256Bytes(bytes)).toHex();
}
