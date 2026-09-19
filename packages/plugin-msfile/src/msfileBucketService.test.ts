// 桶存储服务的块写入通道：块经 Coordinator 控制面直写，种子与元数据仍走
// owner 文件句柄；控制面返回 locked/stale-epoch 时按取消处理。

import { describe, expect, it, vi } from "vitest";
import type { MsFileCoordinatorControl } from "@keymaster/contracts";
import { createMsFileBucketService } from "./msfileBucketService.js";
import { createInMemoryOwnerFileStore } from "./storage/inMemoryOwnerFileStore.testutil.js";
import type { MsFileSeedSource } from "./storage/msfileSeedStore.js";

const ABC_SEED_HASH = "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358";
const ABC_BLOCK_HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function source(bytes: Uint8Array): MsFileSeedSource {
  return {
    name: "abc.txt",
    mediaType: "text/plain",
    size: BigInt(bytes.byteLength),
    async *stream() { yield bytes; },
    async read(offset, length) {
      const start = Number(offset);
      return bytes.slice(start, start + length);
    },
  };
}

function coordinatorControl(handler: () => Promise<{ status: string; value?: unknown; message?: string }>): { control: ReturnType<typeof vi.fn>; coordinator: MsFileCoordinatorControl } {
  const control = vi.fn(handler);
  return { control, coordinator: { msfileControl: control } as unknown as MsFileCoordinatorControl };
}

describe("MSFile bucket service block channel", () => {
  it("forwards every block to the Coordinator control channel", async () => {
    const store = createInMemoryOwnerFileStore();
    const { control, coordinator } = coordinatorControl(async () => ({ status: "ok", value: null, sessionEpoch: "epoch-1" }));
    const service = createMsFileBucketService({ store, coordinator });
    const result = await service.upload(source(new TextEncoder().encode("abc")));
    expect(result.entry.seedHashHex).toBe(ABC_SEED_HASH);
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]![0]).toMatchObject({
      type: "bucket.put-block",
      seedHashHex: ABC_SEED_HASH,
      blockHashHex: ABC_BLOCK_HASH,
    });
    expect(store.objects.has(`seeds/${ABC_SEED_HASH}.ms`)).toBe(true);
    expect(store.objects.has(`meta/${ABC_SEED_HASH}.json`)).toBe(true);
    expect(store.objects.has(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`)).toBe(false);
  });

  it("maps locked and stale control results to a cancelled block write", async () => {
    const store = createInMemoryOwnerFileStore();
    const { coordinator } = coordinatorControl(async () => ({ status: "stale-epoch" }));
    const service = createMsFileBucketService({ store, coordinator });
    await expect(service.upload(source(new TextEncoder().encode("abc")))).rejects.toMatchObject({ code: "cancelled" });
    expect(store.objects.has(`seeds/${ABC_SEED_HASH}.ms`)).toBe(false);
  });

  it("maps control failures to a storage error", async () => {
    const store = createInMemoryOwnerFileStore();
    const { coordinator } = coordinatorControl(async () => ({ status: "transport-error", message: "coordinator offline" }));
    const service = createMsFileBucketService({ store, coordinator });
    await expect(service.upload(source(new TextEncoder().encode("abc")))).rejects.toMatchObject({ code: "storage" });
  });

  it("forwards block reads to the Coordinator control channel", async () => {
    const store = createInMemoryOwnerFileStore();
    const blockBytes = new TextEncoder().encode("abc");
    const control = vi.fn(async (request: { type: string }) => {
      if (request.type === "bucket.put-block") return { status: "ok", value: null, sessionEpoch: "epoch-1" };
      if (request.type === "bucket.get-block") return { status: "ok", value: blockBytes.slice().buffer, sessionEpoch: "epoch-1" };
      return { status: "error", message: "unexpected control" };
    });
    const coordinator = { msfileControl: control } as unknown as MsFileCoordinatorControl;
    const service = createMsFileBucketService({ store, coordinator });
    await service.upload(source(blockBytes));
    // 上传后删除句柄中的块，内容必须来自 get-block 控制面。
    store.objects.delete(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`);
    const read = await service.read(ABC_SEED_HASH);
    expect(read.parts).toHaveLength(1);
    expect(new TextDecoder().decode(read.parts[0]!)).toBe("abc");
  });
});
