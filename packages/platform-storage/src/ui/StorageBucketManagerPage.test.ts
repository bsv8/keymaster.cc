import { beforeEach, describe, expect, it } from "vitest";
import { createDeviceRecordRepository, defaultDeviceStorage } from "../index.js";
import { writeSession } from "../bootstrap/sessionRecord.js";
import { loadBuckets } from "./StorageBucketManagerPage.js";

function deviceRecord(id: string, label: string) {
  return { format: "keymaster.device" as const, version: 1 as const, displayName: label, location: { providerId: "local" as const } };
}

describe("桶管理页数据投影", () => {
  beforeEach(() => {
    const storage = defaultDeviceStorage();
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith("keymaster.")) storage.removeItem(key);
    }
    const repository = createDeviceRecordRepository(storage);
    repository.put("bucket-alpha", deviceRecord("bucket-alpha", "甲桶"));
    repository.put("bucket-beta", deviceRecord("bucket-beta", "乙桶"));
    writeSession({
      format: "keymaster.session",
      version: 1,
      sessionId: "0123456789abcdef0123456789abcdef",
      activeBucketId: "bucket-beta",
    }, storage);
  });

  it("列出本机桶并标记当前桶,当前桶排在最前", () => {
    const rows = loadBuckets();
    expect(rows.map((row) => row.bucketId)).toEqual(["bucket-beta", "bucket-alpha"]);
    expect(rows[0]).toMatchObject({ label: "乙桶", backend: "local", current: true });
    expect(rows[1]).toMatchObject({ label: "甲桶", current: false });
  });

  it("session 没有 active 桶时没有当前标记", () => {
    writeSession({ format: "keymaster.session", version: 1, sessionId: "0123456789abcdef0123456789abcdef" }, defaultDeviceStorage());
    expect(loadBuckets().every((row) => !row.current)).toBe(true);
  });
});
