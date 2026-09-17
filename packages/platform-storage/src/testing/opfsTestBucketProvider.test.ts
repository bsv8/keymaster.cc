
import { describe, expect, it } from "vitest";
import { createOpfsTestBucketProvider } from "./opfsTestBucketProvider.js";

function missingFileRoot(): {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<never>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<never>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  kind: "directory";
  name: string;
} {
  return {
    async getDirectoryHandle() {
      throw { name: "NotFoundError" };
    },
    async getFileHandle() {
      // 这是浏览器缺少最终文件时抛出的 DOMException 形状；测试特意不
      // 使用 instanceof，覆盖跨 realm 的错误映射。
      throw { name: "NotFoundError" };
    },
    async removeEntry() { return undefined; },
    kind: "directory",
    name: "root",
  };
}

function existingDirectoryWithMissingFile(): {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<{
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<never>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<never>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    kind: "directory";
    name: string;
  }>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<never>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  kind: "directory";
  name: string;
} {
  const directory = {
    async getDirectoryHandle() {
      throw { name: "NotFoundError" };
    },
    async getFileHandle() {
      // 最终文件不存在时，浏览器也可能在句柄读取阶段才抛错。
      throw { name: "NotFoundError" };
    },
    async removeEntry() { return undefined; },
    kind: "directory" as const,
    name: ".keymaster",
  };
  return {
    async getDirectoryHandle() { return directory; },
    async getFileHandle() {
      throw { name: "NotFoundError" };
    },
    async removeEntry() { return undefined; },
    kind: "directory",
    name: "root",
  };
}

function existingFileWhoseReadDisappears(): {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<{
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<never>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<{ getFile(): Promise<never>; createWritable(): Promise<never>; kind: "file"; name: string }>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    kind: "directory";
    name: string;
  }>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<never>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  kind: "directory";
  name: string;
} {
  const file = {
    async getFile() {
      throw { name: "NotFoundError" };
    },
    async createWritable() {
      throw new Error("not used");
    },
    kind: "file" as const,
    name: "schema",
  };
  const directory = {
    async getDirectoryHandle() {
      throw { name: "NotFoundError" };
    },
    async getFileHandle() { return file; },
    async removeEntry() { return undefined; },
    kind: "directory" as const,
    name: ".keymaster",
  };
  return {
    async getDirectoryHandle() { return directory; },
    async getFileHandle() {
      throw { name: "NotFoundError" };
    },
    async removeEntry() { return undefined; },
    kind: "directory",
    name: "root",
  };
}

describe("OPFS bucket provider", () => {
  it("returns undefined when the final file handle is missing", async () => {
    const provider = createOpfsTestBucketProvider({ root: missingFileRoot() });

    await expect(provider.get("some/path/object.bin")).resolves.toBeUndefined();
    provider.dispose();
  });

  it("returns undefined when the file disappears while being read", async () => {
    const provider = createOpfsTestBucketProvider({ root: existingDirectoryWithMissingFile() });

    await expect(provider.get("some/path/object.bin")).resolves.toBeUndefined();
    provider.dispose();
  });

  it("maps a cross-realm not-found from getFile to an absent object", async () => {
    const provider = createOpfsTestBucketProvider({ root: existingFileWhoseReadDisappears() });

    await expect(provider.get("some/path/object.bin")).resolves.toBeUndefined();
    provider.dispose();
  });
});
