import { describe, expect, it } from "vitest";
import { defaultDeviceStorage, listStorageKeys, type DeviceLocalStorage } from "./deviceStorage.js";

class MemoryStorage implements DeviceLocalStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
}

describe("device local storage", () => {
  it("列出全部键", () => {
    const storage = new MemoryStorage();
    storage.setItem("b", "1");
    storage.setItem("a", "2");
    expect(listStorageKeys(storage).sort()).toEqual(["a", "b"]);
  });

  it("全局 localStorage 不可用时抛错", () => {
    expect(() => defaultDeviceStorage()).not.toThrow();
  });
});
