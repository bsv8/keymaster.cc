// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeBase64Url } from "@keymaster/contracts";
import { createDeviceRecordRepository, defaultDeviceStorage } from "../index.js";
import { writeSession } from "../bootstrap/sessionRecord.js";
import { StorageSwitcherWidget } from "./StorageSwitcherWidget.js";

const KEY_A = "02" + "aa".repeat(32);
const KEY_B = "02" + "bb".repeat(32);
const KEY_S3 = "02" + "cc".repeat(32);

const state = vi.hoisted(() => ({
  probeBucket: vi.fn(),
  switchBucket: vi.fn(),
  listKeys: vi.fn(),
  activateKey: vi.fn(),
  push: vi.fn()
}));

vi.mock("webloom-framework/react", () => {
  // capability 对象必须保持固定身份：组件 effect 依赖它们，不能每次渲染换引用。
  const storageCapability = {
    status: () => "ready",
    subscribe: () => () => undefined,
    probeBucket: state.probeBucket,
    switchBucket: state.switchBucket
  };
  const vaultCapability = {
    status: () => "unlocked",
    listKeys: state.listKeys,
    activateKey: state.activateKey,
    onLifecycleChange: () => () => undefined,
    getLifecycleSnapshot: () => ({ activePublicKeyHex: undefined })
  };
  const keyspaceCapability = {
    active: () => ({ activePublicKeyHex: undefined }),
    onActiveKeyChanged: () => () => undefined
  };
  return {
    useOptionalCapability: (requested: { id: string }) => {
      if (requested.id === "storage.runtime-controller") return storageCapability;
      if (requested.id === "vault.service") return vaultCapability;
      if (requested.id === "keyspace.service") return keyspaceCapability;
      return undefined;
    }
  };
});

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key }),
  router: { push: state.push }
}));

function resetStorage(): void {
  const storage = defaultDeviceStorage();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("keymaster.")) storage.removeItem(key);
  }
}

function seedLocalSession(): void {
  const storage = defaultDeviceStorage();
  createDeviceRecordRepository(storage).put("bucket-current", {
    format: "keymaster.device",
    version: 1,
    displayName: "当前桶",
    location: { providerId: "local" }
  });
  writeSession({
    format: "keymaster.session",
    version: 1,
    sessionId: "0123456789abcdef0123456789abcdef",
    activeBucketId: "bucket-current"
  }, storage);
}

function seedS3Bucket(): void {
  const storage = defaultDeviceStorage();
  createDeviceRecordRepository(storage).put("bucket-s3", {
    format: "keymaster.device",
    version: 1,
    displayName: "S3 桶",
    location: { providerId: "s3", endpoint: "https://example.com", region: "auto", bucket: "my-bucket" },
    cipher: {
      algorithm: "aes-gcm",
      keyLengthBits: 256,
      ivB64Url: encodeBase64Url(new Uint8Array(12)),
      tagLengthBits: 128,
      ciphertextAndTagB64Url: encodeBase64Url(new Uint8Array(16))
    }
  });
}

beforeEach(() => {
  resetStorage();
  seedLocalSession();
  state.probeBucket.mockReset();
  state.switchBucket.mockReset();
  state.listKeys.mockReset().mockResolvedValue([]);
  state.activateKey.mockReset();
  state.push.mockReset();
});

afterEach(() => cleanup());

describe("顶栏桶 / Key 切换", () => {
  it("local 当前桶直接列出 Key，输入 Key 密码后调用 activateKey 并进入 home", async () => {
    state.listKeys.mockResolvedValue([
      { publicKeyHex: KEY_A, label: "Key A" },
      { publicKeyHex: KEY_B, label: "Key B" }
    ]);
    state.activateKey.mockResolvedValue({ status: "accepted" });
    const user = userEvent.setup();
    render(<StorageSwitcherWidget />);

    await user.click(screen.getByRole("button", { name: "存储桶" }));
    await user.click(await screen.findByRole("button", { name: /Key B/ }));
    await user.type(await screen.findByLabelText(/Key 密码/), "key-password-1");
    await user.click(screen.getByRole("button", { name: "使用密码切换" }));

    await waitFor(() => expect(state.activateKey).toHaveBeenCalledWith({ publicKeyHex: KEY_B, password: "key-password-1" }));
    expect(state.switchBucket).not.toHaveBeenCalled();
    expect(state.push).toHaveBeenCalledWith("/");
  });

  it("s3 桶需先输入桶密码读取 Keys；Key 密码失败时不切换环境，成功后清除桶密码", async () => {
    seedS3Bucket();
    state.probeBucket.mockResolvedValue({ ok: true, state: "has-keys", keys: [{ publicKeyHex: KEY_S3, label: "S3 Key" }] });
    state.switchBucket
      .mockRejectedValueOnce(new Error("Key 密码错误"))
      .mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<StorageSwitcherWidget />);

    await user.click(screen.getByRole("button", { name: "存储桶" }));
    await user.click(await screen.findByRole("button", { name: /输入密码读取 Keys/ }));
    await user.type(await screen.findByLabelText(/桶密码/), "bucket-password-1");
    await user.click(screen.getByRole("button", { name: "读取 Keys" }));

    expect(await screen.findByRole("button", { name: /S3 Key/ })).toBeTruthy();
    expect(state.probeBucket.mock.calls[0]![0]).toMatchObject({
      backend: "s3",
      password: "bucket-password-1",
      binding: { bucketId: "bucket-s3", backend: "s3" }
    });

    // 第一次：Key 密码错误，当前环境不变。
    await user.click(screen.getByRole("button", { name: /S3 Key/ }));
    await user.type(await screen.findByLabelText(/Key 密码/), "wrong-password");
    await user.click(screen.getByRole("button", { name: "使用密码切换" }));
    expect(await screen.findByText("Key 密码错误")).toBeTruthy();
    expect(state.push).not.toHaveBeenCalled();
    expect(state.switchBucket.mock.calls[0]![1]).toBe("bucket-password-1");
    expect(state.switchBucket.mock.calls[0]![2]).toMatchObject({ keyPassword: "wrong-password", publicKeyHex: KEY_S3 });

    // 第二次：Key 密码正确，切换成功并进入 home。
    await user.type(screen.getByLabelText(/Key 密码/), "right-password");
    await user.click(screen.getByRole("button", { name: "使用密码切换" }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith("/"));
    expect(state.switchBucket).toHaveBeenCalledTimes(2);

    // 成功后桶密码被清除：再次打开面板，s3 桶重新要求输入桶密码。
    await user.click(screen.getByRole("button", { name: "存储桶" }));
    expect(await screen.findByRole("button", { name: /输入密码读取 Keys/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /S3 Key/ })).toBeNull();
  });

  it("取消桶密码弹窗不会读取也不会切换", async () => {
    seedS3Bucket();
    const user = userEvent.setup();
    render(<StorageSwitcherWidget />);

    await user.click(screen.getByRole("button", { name: "存储桶" }));
    await user.click(await screen.findByRole("button", { name: /输入密码读取 Keys/ }));
    await user.click(await screen.findByRole("button", { name: "取消" }));

    expect(state.probeBucket).not.toHaveBeenCalled();
    expect(state.switchBucket).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });
});
