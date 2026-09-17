import { describe, expect, it } from "vitest";
import type { DeviceRecordV1 } from "@keymaster/contracts";
import { createDeviceRecordRepository } from "./deviceRecordRepository.js";
import type { DeviceLocalStorage } from "./deviceStorage.js";

class MemoryStorage implements DeviceLocalStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
}

const cipher = {
  algorithm: "aes-gcm" as const,
  keyLengthBits: 256 as const,
  ivB64Url: "AAECAwQFBgcICQoL",
  tagLengthBits: 128 as const,
  ciphertextAndTagB64Url: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v",
};

const s3 = (bucket = "keymaster-data"): DeviceRecordV1 => ({
  format: "keymaster.device",
  version: 1,
  displayName: "团队 S3 桶",
  location: { providerId: "s3", endpoint: "https://s3.example.com", region: "auto", bucket, prefix: "team" },
  cipher,
});

describe("device record repository", () => {
  it("写入、读取、枚举与删除", () => {
    const storage = new MemoryStorage();
    const repository = createDeviceRecordRepository(storage);
    repository.put("rs_local_7a01", { format: "keymaster.device", version: 1, location: { providerId: "local" } });
    repository.put("rs_s3_9f1c", s3());
    expect(repository.read("rs_local_7a01")).toMatchObject({ location: { providerId: "local" } });
    expect(repository.list().entries.map((entry) => entry.remoteStorageId)).toEqual(["rs_local_7a01", "rs_s3_9f1c"]);
    repository.delete("rs_local_7a01");
    expect(repository.read("rs_local_7a01")).toBeUndefined();
    expect(repository.list().invalidKeys).toEqual([]);
  });

  it("已有同 ID 记录时拒绝覆盖，除非显式 replace", () => {
    const storage = new MemoryStorage();
    const repository = createDeviceRecordRepository(storage);
    repository.put("rs_s3_9f1c", s3());
    expect(() => repository.put("rs_s3_9f1c", s3("another"))).toThrowError(/already exists/u);
    repository.put("rs_s3_9f1c", s3("another"), { replace: true });
    const updated = repository.read("rs_s3_9f1c");
    expect(updated?.location.providerId).toBe("s3");
    expect(updated !== undefined && updated.location.providerId === "s3" ? updated.location.bucket : undefined).toBe("another");
  });

  it("相同的规范化 S3 位置不允许登记两次", () => {
    const storage = new MemoryStorage();
    const repository = createDeviceRecordRepository(storage);
    repository.put("rs_s3_9f1c", s3());
    expect(() => repository.put("rs_s3_other", s3())).toThrowError(/already registered/u);
  });

  it("损坏或非法的键进入 invalidKeys，不自动删除", () => {
    const storage = new MemoryStorage();
    storage.setItem("keymaster.device.rs_bad", "{broken");
    storage.setItem("keymaster.device.bad key", "{}");
    const repository = createDeviceRecordRepository(storage);
    const result = repository.list();
    expect(result.entries).toEqual([]);
    expect(result.invalidKeys.sort()).toEqual(["keymaster.device.bad key", "keymaster.device.rs_bad"]);
    expect(storage.getItem("keymaster.device.rs_bad")).toBe("{broken");
  });

  it("local 记录禁止 cipher，S3 记录必须有 cipher", () => {
    const storage = new MemoryStorage();
    const repository = createDeviceRecordRepository(storage);
    expect(() => repository.put("rs_local_7a01", { format: "keymaster.device", version: 1, location: { providerId: "local" }, cipher } as unknown as DeviceRecordV1)).toThrow();
    expect(() => repository.put("rs_s3_9f1c", { format: "keymaster.device", version: 1, location: s3().location } as unknown as DeviceRecordV1)).toThrow();
  });
});
