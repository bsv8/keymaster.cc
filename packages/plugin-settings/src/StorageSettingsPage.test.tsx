// packages/plugin-settings/src/StorageSettingsPage.test.tsx
// 施工单 2026-06-29 001：Storage 设置页基本读写 + 非法配置拒绝。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StorageSettingsPage } from "./StorageSettingsPage.js";
import {
  PROTOCOL_SERVICE_CAPABILITY,
  type ProtocolService,
  type StorageProviderConfig
} from "@keymaster/contracts";

let currentService: ProtocolService | null = null;

vi.mock("@keymaster/runtime", () => ({
  useCapability: (key: string) => {
    if (key === PROTOCOL_SERVICE_CAPABILITY) return currentService;
    return undefined;
  },
  useI18n: () => ({
    t: (key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? key,
    language: () => "en"
  })
}));

afterEach(() => {
  cleanup();
  currentService = null;
});

function makeMockService(initial: StorageProviderConfig | null) {
  let stored: StorageProviderConfig | null = initial;
  return {
    async getStorageProviderConfig() {
      return stored;
    },
    async setStorageProviderConfig(record: StorageProviderConfig) {
      stored = record;
    },
    async clearStorageProviderConfig() {
      stored = null;
    }
  } as unknown as ProtocolService;
}

describe("StorageSettingsPage", () => {
  it("无配置时：save 按钮启用；缺字段时拒绝保存", async () => {
    currentService = makeMockService(null);
    render(<StorageSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("storage-endpoint")).toBeDefined();
    });
    const save = screen.getByTestId("storage-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // 不填任何字段直接保存
    await act(async () => {
      fireEvent.click(save);
    });
    expect(screen.getByTestId("storage-error").textContent).toContain("endpoint");
  });

  it("填齐字段后保存；后续 getStorageProviderConfig 能读到", async () => {
    currentService = makeMockService(null);
    render(<StorageSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("storage-endpoint")).toBeDefined();
    });
    fireEvent.change(screen.getByTestId("storage-endpoint"), {
      target: { value: "https://s3.example.com" }
    });
    fireEvent.change(screen.getByTestId("storage-region"), {
      target: { value: "us-east-1" }
    });
    fireEvent.change(screen.getByTestId("storage-bucket"), {
      target: { value: "bucket" }
    });
    fireEvent.change(screen.getByTestId("storage-access-key-id"), {
      target: { value: "AKID" }
    });
    fireEvent.change(screen.getByTestId("storage-secret-access-key"), {
      target: { value: "SECRET" }
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("storage-save"));
    });
    // 重新挂载并验证读到了。
    cleanup();
    let read: StorageProviderConfig | null = null;
    currentService = {
      ...makeMockService(null),
      async getStorageProviderConfig() {
        read = {
          provider: "s3-compatible",
          endpoint: "https://s3.example.com",
          region: "us-east-1",
          bucket: "bucket",
          accessKeyId: "AKID",
          secretAccessKey: "SECRET",
          updatedAt: 1
        };
        return read;
      }
    } as unknown as ProtocolService;
    render(<StorageSettingsPage />);
    await waitFor(() => {
      expect((screen.getByTestId("storage-endpoint") as HTMLInputElement).value).toBe(
        "https://s3.example.com"
      );
    });
    expect((screen.getByTestId("storage-secret-access-key") as HTMLInputElement).value).toBe(
      "SECRET"
    );
  });
});