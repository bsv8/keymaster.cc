// local MSFile 来源验收：复用同一 msfiles 存储，不复制内容，并在完整性失败后撤销 available。

import { describe, expect, it } from "vitest";
import { createMsFileLocalContentSource } from "./localContentSource.js";
import { storeMsFileSeed, type MsFileSeedSource } from "../storage/msfileSeedStore.js";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";

const ABC = new TextEncoder().encode("abc");
const ABC_SEED_HASH = "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358";
const ABC_BLOCK_HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function source(bytes: Uint8Array): MsFileSeedSource {
  return {
    name: "abc.txt",
    mediaType: "text/plain",
    size: BigInt(bytes.byteLength),
    async *stream() { yield bytes.slice(); },
    async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length); },
  };
}

describe("BitFS local 内容来源", () => {
  it("L01/L02：直接聚合同一存储并校验 Seed 与 Block", async () => {
    const store = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store, source: source(ABC) });
    const before = new Set(store.objects.keys());
    const local = createMsFileLocalContentSource(store);

    await expect(local.stat(ABC_SEED_HASH)).resolves.toMatchObject({
      sourceId: "local-bitfs",
      sourceKind: "local-bitfs",
      status: "available",
      recommendedFilename: "abc.txt",
      fileSizeBytes: "3",
    });
    await expect(local.readSeed(ABC_SEED_HASH)).resolves.toEqual(store.objects.get(`seeds/${ABC_SEED_HASH}.ms`));
    await expect(local.readBlock(ABC_SEED_HASH, ABC_BLOCK_HASH)).resolves.toEqual(ABC);
    expect(new Set(store.objects.keys())).toEqual(before);
  });

  it("L03：缺块不报告 available，损坏块读取失败后撤销 available", async () => {
    const missingStore = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store: missingStore, source: source(ABC) });
    missingStore.objects.delete(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`);
    await expect(createMsFileLocalContentSource(missingStore).stat(ABC_SEED_HASH)).resolves.toBeNull();

    const damagedStore = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store: damagedStore, source: source(ABC) });
    const local = createMsFileLocalContentSource(damagedStore);
    await expect(local.stat(ABC_SEED_HASH)).resolves.toMatchObject({ status: "available" });
    damagedStore.objects.set(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`, new TextEncoder().encode("abd"));
    await expect(local.readBlock(ABC_SEED_HASH, ABC_BLOCK_HASH)).rejects.toBeTruthy();
    await expect(local.stat(ABC_SEED_HASH)).resolves.toBeNull();
  });
});
