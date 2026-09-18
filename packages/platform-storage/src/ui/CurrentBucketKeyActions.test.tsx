// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurrentBucketKeyActions } from "./CurrentBucketKeyActions.js";

const state = vi.hoisted(() => {
  const generateKey = vi.fn();
  const importPrivateKey = vi.fn();
  return {
    generateKey,
    importPrivateKey,
    vaultCapability: { status: () => "unlocked", generateKey, importPrivateKey },
    registry: { list: () => [] }
  };
});

vi.mock("webloom-framework/react", () => ({
  useCapability: (requested: { id: string }) => {
    if (requested.id === "importer.registry") return state.registry;
    throw new Error(`unexpected capability ${requested.id}`);
  },
  useOptionalCapability: (requested: { id: string }) => {
    if (requested.id === "vault.service") return state.vaultCapability;
    return undefined;
  }
}));

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key }),
  usePluginHost: () => ({
    i18n: {
      text: (value: string | { fallback: string }) => typeof value === "string" ? value : value.fallback,
      language: () => "zh-CN"
    }
  })
}));

beforeEach(() => {
  state.generateKey.mockReset();
  state.importPrivateKey.mockReset();
});

afterEach(() => cleanup());

describe("当前桶 Key 操作", () => {
  it("新建 Key 会调用 vault.generateKey 并提示已激活", async () => {
    state.generateKey.mockResolvedValue({
      publicKeyHex: "02" + "ab".repeat(32),
      label: "主 Key",
      format: "generated",
      capabilities: ["p2pkh"],
      createdAt: "2026-09-18T00:00:00.000Z"
    });
    const user = userEvent.setup();
    render(<CurrentBucketKeyActions bucketLabel="工作桶" unlocked />);

    await user.click(screen.getByRole("button", { name: "新建 Key" }));
    const labelInput = await screen.findByLabelText(/Key 标签/);
    await user.clear(labelInput);
    await user.type(labelInput, "主 Key");
    await user.type(screen.getByLabelText(/^Key 密码（至少 8 位）/), "key-password-1");
    await user.type(screen.getByLabelText("再输入一次 Key 密码"), "key-password-1");
    await user.click(screen.getByRole("button", { name: "创建 Key" }));

    await waitFor(() => expect(state.generateKey).toHaveBeenCalledWith({
      password: "key-password-1",
      label: "主 Key",
      capabilities: ["p2pkh"]
    }));
    expect(await screen.findByText(/已创建并设为 active/)).toBeTruthy();
    expect(state.importPrivateKey).not.toHaveBeenCalled();
  });

  it("Key 密码不一致时拒绝提交", async () => {
    const user = userEvent.setup();
    render(<CurrentBucketKeyActions bucketLabel="工作桶" unlocked />);

    await user.click(screen.getByRole("button", { name: "新建 Key" }));
    await user.type(screen.getByLabelText(/^Key 密码（至少 8 位）/), "key-password-1");
    await user.type(screen.getByLabelText("再输入一次 Key 密码"), "key-password-2");
    await user.click(screen.getByRole("button", { name: "创建 Key" }));

    expect(await screen.findByText(/两次输入的 Key 密码不一致/)).toBeTruthy();
    expect(state.generateKey).not.toHaveBeenCalled();
  });

  it("未解锁时禁用 Key 操作", () => {
    render(<CurrentBucketKeyActions bucketLabel="工作桶" unlocked={false} />);
    expect((screen.getByRole("button", { name: "新建 Key" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "导入 Key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("导入 Key 复用共享导入向导（draft 模式）", async () => {
    const user = userEvent.setup();
    render(<CurrentBucketKeyActions bucketLabel="工作桶" unlocked />);

    await user.click(screen.getByRole("button", { name: "导入 Key" }));
    expect(await screen.findByText("导入私钥：1. 选择导入方式")).toBeTruthy();
    expect(state.importPrivateKey).not.toHaveBeenCalled();
  });
});
