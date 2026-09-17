import { describe, expect, it } from "vitest";
import type {
  PluginStorageDeclaration,
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider,
  StorageBucketWriteCondition,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../../runtime/storageError.js";
import { createOwnerFileStore } from "./ownerFileStore.js";

const OWNER = `02${"11".repeat(32)}`;

/** 只模拟桶对象、分页和原生条件写；不引入第二套持久化模型。 */
class MemoryBucketProvider implements StorageBucketProvider {
  readonly provider = "local" as const;
  readonly bucketId = "file-store-test";
  readonly writes: Array<{ path: string; condition: StorageBucketWriteCondition }> = [];
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  private sequence = 0;

  async probe(): Promise<StorageBucketProbeResult> {
    return { ok: true, conditionalWrites: "native", latencyMs: 0 };
  }

  async get(path: string): Promise<StorageBucketObject | undefined> {
    const value = this.objects.get(path);
    return value === undefined
      ? undefined
      : { path, bytes: value.bytes.slice(), size: value.bytes.byteLength, etag: value.etag };
  }

  async list(input: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageBucketListPage> {
    const prefix = input.prefix ?? "";
    const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
    const limit = input.limit ?? 1000;
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const selected = paths.slice(offset, offset + limit).map((path) => {
      const value = this.objects.get(path)!;
      return { path, bytes: new Uint8Array(), size: value.bytes.byteLength, etag: value.etag };
    });
    return {
      objects: selected,
      ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
    };
  }

  async put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition = {}): Promise<{ etag: string }> {
    const current = this.objects.get(path);
    if (condition.ifNoneMatch === "*" && current !== undefined) {
      throw new StorageRuntimeError("storage_conflict", "目标已存在");
    }
    if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) {
      throw new StorageRuntimeError("storage_conflict", "版本已变化");
    }
    this.writes.push({ path, condition: { ...condition } });
    const etag = `etag-${++this.sequence}`;
    this.objects.set(path, { bytes: bytes.slice(), etag });
    return { etag };
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<void> {
    const current = this.objects.get(path);
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
      throw new StorageRuntimeError("storage_conflict", "版本已变化");
    }
    this.objects.delete(path);
  }

  dispose(): void {}
}

const CONTACTS_DECLARATION: PluginStorageDeclaration = {
  moduleId: "contacts",
  purposeId: "address-book",
  scope: "owner",
  authority: "built-in-module",
  model: "files",
  schemaVersion: 1,
};

function makeStore(overrides: { provider?: MemoryBucketProvider; isCurrent?: () => boolean; declaration?: PluginStorageDeclaration } = {}) {
  const provider = overrides.provider ?? new MemoryBucketProvider();
  const store = createOwnerFileStore({
    provider,
    bucket: { bucketId: provider.bucketId, bucketGeneration: 1, provider: "local" },
    declaration: overrides.declaration ?? CONTACTS_DECLARATION,
    ownerPublicKeyHex: OWNER,
    ...(overrides.isCurrent === undefined ? {} : { isCurrent: overrides.isCurrent }),
  });
  return { provider, store };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("owner file store", () => {
  it("在扁平 owner 根下读写文件并回报相对路径", async () => {
    const { provider, store } = makeStore();
    const root = `${OWNER}/contacts/address-book/`;
    const contact = `02${"ab".repeat(32)}`;

    await expect(store.put(`${contact}.json`, encode("{\"name\":\"小明\"}"), { ifNoneMatch: "*" })).resolves.toEqual({ etag: "etag-1" });
    expect(provider.objects.has(`${root}${contact}.json`)).toBe(true);

    const object = await store.get(`${contact}.json`);
    expect(object?.path).toBe(`${contact}.json`);
    expect(decode(object!.bytes)).toBe("{\"name\":\"小明\"}");

    const page = await store.list();
    expect(page.files.map((file) => file.path)).toEqual([`${contact}.json`]);
    expect(page.files[0]).toMatchObject({ size: 17, etag: "etag-1" });

    await store.delete(`${contact}.json`);
    await expect(store.get(`${contact}.json`)).resolves.toBeUndefined();
    await expect(store.delete(`${contact}.json`)).resolves.toBeUndefined();
  });

  it("把 ifNoneMatch 冲突原样上抛,不覆盖已存在文件", async () => {
    const { store } = makeStore();
    await store.put("a.json", encode("1"), { ifNoneMatch: "*" });
    await expect(store.put("a.json", encode("2"), { ifNoneMatch: "*" })).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(store.get("a.json")).resolves.toMatchObject({ bytes: encode("1") });
  });

  it("list 只看模块根且分页游标可用", async () => {
    const { store } = makeStore();
    for (const name of ["b.json", "a.json", "c.json"]) await store.put(name, encode(name));
    const first = await store.list({ prefix: "", limit: 2 });
    expect(first.files.map((file) => file.path)).toEqual(["a.json", "b.json"]);
    expect(first.nextCursor).toBe("2");
    const second = await store.list({ limit: 2, cursor: first.nextCursor });
    expect(second.files.map((file) => file.path)).toEqual(["c.json"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("拒绝越出模块根或触碰保留段的路径", async () => {
    const { provider, store } = makeStore();
    await expect(store.put("../escape.json", encode("x"))).rejects.toMatchObject({ code: "storage_provider_error" });
    await expect(store.put(".keymaster/secret.json", encode("x"))).rejects.toMatchObject({ code: "storage_provider_error" });
    await expect(store.get("a/../../b.json")).rejects.toMatchObject({ code: "storage_provider_error" });
    await expect(store.list({ prefix: "../" })).rejects.toMatchObject({ code: "storage_provider_error" });
    expect(provider.objects.size).toBe(0);
  });

  it("拒绝 K-V 声明和失效句柄", async () => {
    expect(() => makeStore({ declaration: { ...CONTACTS_DECLARATION, model: "kv" } })).toThrow(StorageRuntimeError);
    const { store } = makeStore({ isCurrent: () => false });
    await expect(store.list()).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(store.put("a.json", encode("x"))).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
