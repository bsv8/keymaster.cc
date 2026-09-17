// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExistingRemoteStorageConnectPlan } from "@keymaster/contracts";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import { createDeviceRecordRepository, defaultDeviceStorage } from "../index.js";
import { writeSession } from "../bootstrap/sessionRecord.js";
import { StorageBucketManagerPage } from "./StorageBucketManagerPage.js";

const state = vi.hoisted(() => ({
  probeBucket: vi.fn(),
  connectExistingRemote: vi.fn(),
  switchBucket: vi.fn(),
  renameBucket: vi.fn(),
  // 必须固定对象身份：页面 effect 依赖 host,每次渲染换对象会导致无限重渲染。
  host: { resourceStore: { subscribe: () => () => undefined } }
}));

vi.mock("webloom-framework/react", () => ({
  useCapability: (requested: string | { id: string }) => {
    const id = typeof requested === "string" ? requested : requested.id;
    if (id !== STORAGE_RUNTIME_CONTROLLER_CAPABILITY.id) throw new Error(`unexpected capability ${id}`);
    return {
      probeBucket: state.probeBucket,
      connectExistingRemote: state.connectExistingRemote,
      switchBucket: state.switchBucket,
      renameBucket: state.renameBucket,
      status: () => "ready",
      subscribe: () => () => undefined
    };
  }
}));

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key }),
  usePluginHost: () => state.host
}));

beforeEach(() => {
  const storage = defaultDeviceStorage();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("keymaster.")) storage.removeItem(key);
  }
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
  state.probeBucket.mockReset().mockResolvedValue({ ok: true, state: "empty" });
  state.connectExistingRemote.mockReset();
  state.switchBucket.mockReset();
  state.renameBucket.mockReset();
});

afterEach(() => cleanup());

describe("桶管理页 · 连接已有桶", () => {
  it("探测到 Key 后可按该 Key 密码连接并接管", async () => {
    state.probeBucket.mockResolvedValue({
      ok: true,
      state: "has-keys",
      keys: [{ publicKeyHex: "02" + "ab".repeat(32), label: "旧 Key" }]
    });
    state.connectExistingRemote.mockResolvedValue({
      ok: true,
      bucket: { bucketId: "another", backend: "local", deviceRecord: { format: "keymaster.device", version: 1, location: { providerId: "local" } } }
    });
    const user = userEvent.setup();
    render(<StorageBucketManagerPage />);

    await user.click(await screen.findByTestId("connect-existing-toggle"));
    await screen.findByTestId("connect-existing-panel");
    await user.type(screen.getByLabelText(/桶名称/), "另一个桶");
    await user.type(screen.getByLabelText(/Namespace/), "another-bucket");
    await user.click(screen.getByTestId("probe-existing"));

    expect(await screen.findByRole("button", { name: "旧 Key" })).toBeTruthy();
    await user.type(screen.getByLabelText(/该 Key 自己的密码/), "key-password-1");
    await user.click(screen.getByTestId("submit-existing"));

    await waitFor(() => expect(state.connectExistingRemote).toHaveBeenCalledTimes(1));
    expect(state.connectExistingRemote.mock.calls[0]![0]).toMatchObject({
      remoteStorageId: "another-bucket",
      backend: "local",
      connection: { kind: "local" },
      publicKeyHex: "02" + "ab".repeat(32),
      keyPassword: "key-password-1"
    } satisfies Partial<ExistingRemoteStorageConnectPlan>);
    expect((state.connectExistingRemote.mock.calls[0]![0] as ExistingRemoteStorageConnectPlan).startupPassword).toBeUndefined();
  });

  it("探测到空桶时提示改用初始化流程,不显示连接按钮", async () => {
    const user = userEvent.setup();
    render(<StorageBucketManagerPage />);

    await user.click(await screen.findByTestId("connect-existing-toggle"));
    await user.type(screen.getByLabelText(/桶名称/), "空桶");
    await user.type(screen.getByLabelText(/Namespace/), "empty-bucket");
    await user.click(screen.getByTestId("probe-existing"));

    expect(await screen.findByText(/该桶还没有任何 Key/)).toBeTruthy();
    expect(screen.queryByTestId("submit-existing")).toBeNull();
    expect(state.connectExistingRemote).not.toHaveBeenCalled();
  });
});
