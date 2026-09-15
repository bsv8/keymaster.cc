// Header 桶 → Key 树的交互回归测试。
//
// 关键不变量：当前 Key 有明确标记；切换其他 Key 先要求桶密码；取消不
// 改 active；提交只调用 Vault 的统一 activateKey 事务。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { createKeymasterPluginHost, PluginHostProvider } from "@keymaster/runtime";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  deviceRemoteStorageLocationFingerprint,
  type ActiveKeyState,
  type PendingPasswordRotationViewV1,
  type KeyRef,
  type KeyspaceService,
  type StorageBucketCatalogEntryV2,
  type StorageRuntimeController,
  type VaultService,
} from "@keymaster/contracts";
import { writeDeviceBootstrap } from "../bootstrap/deviceBootstrapRepository.js";
import { StorageBucketManagerEntry, StorageBucketManagerPage } from "./StorageBucketManagerPage.js";

const KEY_A = `02${"a".repeat(64)}`;
const KEY_B = `03${"b".repeat(64)}`;

const keyA: KeyRef = { publicKeyHex: KEY_A, label: "Alpha", format: "hex", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:00.000Z" };
const keyB: KeyRef = { publicKeyHex: KEY_B, label: "Beta", format: "hex", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:01.000Z" };

function bucket(bucketId: string, label: string): StorageBucketCatalogEntryV2 {
  return {
    bucketId,
    label,
    backend: "local",
    configRevision: 1,
    keyDerivation: { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations: 100_000, outputLengthBits: 256, saltB64Url: "0123456789ab" },
    encryptedConfig: { cipher: { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url: "0123456789ab", tagLengthBits: 128, ciphertextAndTagB64Url: "encrypted-config" } },
    snapshotRevision: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

function seedBuckets(entries: StorageBucketCatalogEntryV2[], selectedBucketId = entries[0]?.bucketId): void {
  writeDeviceBootstrap({
    format: "keymaster.device-bootstrap",
    version: 1,
    ...(selectedBucketId === undefined ? {} : { selectedRemoteStorageId: selectedBucketId }),
    connections: entries.map((entry) => {
      const location = { providerId: "local" as const, namespace: entry.bucketId };
      return { remoteStorageId: entry.bucketId, displayName: entry.label, providerId: "local", location, physicalLocationFingerprint: deviceRemoteStorageLocationFingerprint(location), encryptedConfig: entry.encryptedConfig, keyDerivation: entry.keyDerivation, source: "created", createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    }),
    recoveries: [],
    workerProfileId: "profile-storage-manager-test",
  });
}

function seedBucket(entry: StorageBucketCatalogEntryV2): void {
  seedBuckets([entry]);
}

function mount() {
  const activeListeners = new Set<(state: ActiveKeyState) => void>();
  const lifecycleListeners = new Set<(snapshot: { activePublicKeyHex?: string }) => void>();
  let activePublicKeyHex = KEY_A;
  const activateKey = vi.fn(async (input: { publicKeyHex: string; password: string }) => {
    activePublicKeyHex = input.publicKeyHex;
    const active = { activePublicKeyHex } satisfies ActiveKeyState;
    for (const listener of activeListeners) listener(active);
    for (const listener of lifecycleListeners) listener({ activePublicKeyHex });
    return { status: "accepted" as const };
  });
  const keyspace = {
    active: () => ({ activePublicKeyHex }),
    onActiveKeyChanged: (listener: (state: ActiveKeyState) => void) => { activeListeners.add(listener); return () => activeListeners.delete(listener); },
    listKeys: async () => [keyA, keyB]
  } as unknown as KeyspaceService;
  const vault = {
    status: () => "unlocked" as const,
    getLifecycleSnapshot: () => ({ status: "unlocked" as const, activePublicKeyHex, sessionEpoch: "epoch-a", vaultLifecycleRevision: 1 }),
    onLifecycleChange: (listener: (snapshot: { activePublicKeyHex?: string }) => void) => { lifecycleListeners.add(listener); return () => lifecycleListeners.delete(listener); },
    listKeys: async () => [keyA, keyB],
    activateKey
  } as unknown as VaultService;
  const storage = {
    status: () => "ready" as const,
    subscribe: () => () => undefined,
    selectedBucketId: () => "bucket-a",
    isCatalogBucket: () => true
  } as unknown as StorageRuntimeController & { selectedBucketId(): string; isCatalogBucket(): boolean };

  seedBucket(bucket("bucket-a", "工作桶"));
  const host = createKeymasterPluginHost({ disableConfigPersistence: true, i18nDebug: false });
  host.provide(KEYSPACE_SERVICE_CAPABILITY, keyspace);
  host.provide(VAULT_SERVICE_CAPABILITY, vault);
  host.provide(STORAGE_RUNTIME_CONTROLLER_CAPABILITY, storage);
  return { activateKey, ...render(<PluginHostProvider host={host}><StorageBucketManagerEntry /></PluginHostProvider>) };
}

function mountManagerPage(options: { pendingRotation?: PendingPasswordRotationViewV1; buckets?: StorageBucketCatalogEntryV2[] } = {}) {
  let activePublicKeyHex = KEY_A;
  const pageBuckets = options.buckets ?? [bucket("bucket-a", "工作桶")];
  let pendingRotations = options.pendingRotation ? [options.pendingRotation] : [];
  const listPendingPasswordRotations = vi.fn(async () => pendingRotations);
  const resumeBucketPasswordRotation = vi.fn(async (_operationId: string, _oldPassword: string, _newPassword: string) => {
    pendingRotations = [];
    return { ok: true as const, outcome: "completed" as const, bucket: bucket("bucket-a", "工作桶") };
  });
  const host = createKeymasterPluginHost({ disableConfigPersistence: true, i18nDebug: false });
  const vault = {
    status: () => "unlocked" as const,
    getLifecycleSnapshot: () => ({ status: "unlocked" as const, activePublicKeyHex, sessionEpoch: "epoch-a", vaultLifecycleRevision: 1 }),
    onLifecycleChange: () => () => undefined,
    listKeys: async () => [keyA, keyB],
    activateKey: async (input: { publicKeyHex: string }) => { activePublicKeyHex = input.publicKeyHex; return { status: "accepted" as const }; }
  } as unknown as VaultService;
  const storage = {
    status: () => "ready" as const,
    subscribe: () => () => undefined,
    selectedBucketId: () => pageBuckets[0]?.bucketId,
    isCatalogBucket: () => true,
    listPendingPasswordRotations,
    resumeBucketPasswordRotation,
  } as unknown as StorageRuntimeController;
  seedBuckets(pageBuckets);
  host.provide(VAULT_SERVICE_CAPABILITY, vault);
  host.provide(STORAGE_RUNTIME_CONTROLLER_CAPABILITY, storage);
  return {
    ...render(<PluginHostProvider host={host}><StorageBucketManagerPage /></PluginHostProvider>),
    listPendingPasswordRotations,
    resumeBucketPasswordRotation,
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("StorageBucketManagerEntry key switching", () => {
  it("marks the active Key and switches through the bucket-password modal", async () => {
    const { activateKey } = mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /存储桶|Storage buckets/ }));
    const alpha = await screen.findByRole("button", { name: /Alpha/ });
    const beta = screen.getByRole("button", { name: /Beta/ });
    expect(alpha.getAttribute("aria-current")).toBe("true");
    expect(beta.getAttribute("aria-current")).toBeNull();

    await user.click(beta);
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText(/桶密码|Bucket password/), "bucket-password");
    await user.click(screen.getByRole("button", { name: /使用密码切换|Switch with password/ }));

    await waitFor(() => expect(activateKey).toHaveBeenCalledWith({ publicKeyHex: KEY_B, password: "bucket-password" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // 成功后菜单会一并关闭；重新打开后验证当前 Key 标记。
    await user.click(screen.getByRole("button", { name: /存储桶|Storage buckets/ }));
    expect(screen.getByRole("button", { name: /Beta/ }).getAttribute("aria-current")).toBe("true");
  });

  it("does not activate a Key when the modal is cancelled", async () => {
    const { activateKey } = mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /存储桶|Storage buckets/ }));
    await user.click(await screen.findByRole("button", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: /取消|Cancel/ }));

    expect(activateKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /Alpha/ }).getAttribute("aria-current")).toBe("true");
  });
});

describe("StorageBucketManagerPage structure", () => {
  it("lists current bucket Keys and opens add bucket in a modal", async () => {
    const user = userEvent.setup();
    mountManagerPage();
    expect(await screen.findByRole("button", { name: /Alpha/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Alpha/ }).getAttribute("aria-current")).toBe("true");

    await user.click(screen.getByRole("button", { name: /添加桶|Add a bucket/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText(/桶名称|Bucket name/)).toBeTruthy();
  });

  it("显示待恢复轮转并通过密码提示提交恢复", async () => {
    const rotation: PendingPasswordRotationViewV1 = {
      format: "keymaster.storage.password-rotation-view",
      version: 1,
      operationId: "rotation-ui-001",
      bucketId: "bucket-a",
      backend: "local",
      phase: "hold-published",
      createdAt: 1,
      updatedAt: 1,
    };
    const { resumeBucketPasswordRotation } = mountManagerPage({ pendingRotation: rotation });
    const prompt = vi.spyOn(window, "prompt")
      .mockReturnValueOnce("old-password")
      .mockReturnValueOnce("new-password")
      .mockReturnValueOnce("new-password");
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "待恢复的密码轮转" })).toBeTruthy();
    expect(screen.getByText(/Hold 已发布，等待收敛/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "恢复此轮转" }));

    await waitFor(() => expect(resumeBucketPasswordRotation).toHaveBeenCalledWith("rotation-ui-001", "old-password", "new-password"));
    expect(await screen.findByText(/密码轮转已恢复完成/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "待恢复的密码轮转" })).toBeNull();
    prompt.mockRestore();
  });

  it("双桶场景禁止从当前桶直接修改非当前桶密码", async () => {
    mountManagerPage({ buckets: [bucket("bucket-a", "当前桶 A"), bucket("bucket-b", "目标桶 B")] });
    const prompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("非当前桶不应弹出密码提示"); });
    const user = userEvent.setup();

    const moreMenus = screen.getAllByLabelText("更多桶操作");
    await user.click(moreMenus[1]!);
    const changeButtons = screen.getAllByRole("button", { name: "修改密码" });
    await user.click(changeButtons[1]!);

    expect((await screen.findByRole("alert")).textContent).toContain("请先切换并解锁目标桶");
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});
