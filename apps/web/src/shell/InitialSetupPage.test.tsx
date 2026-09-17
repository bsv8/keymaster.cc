// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { BucketProbePlan, BucketProbeResult, ExistingRemoteStorageConnectPlan, ExistingRemoteStorageConnectResult, InitialSetupPlan, InitialSetupResult } from "@keymaster/contracts";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import { createDeviceRecordRepository, defaultDeviceStorage } from "@keymaster/platform-storage";
import { InitialSetupPage } from "./InitialSetupPage.js";

type SetupSuccess = Extract<InitialSetupResult, { ok: true }>;
type ConnectSuccess = Extract<ExistingRemoteStorageConnectResult, { ok: true }>;

const state = vi.hoisted(() => ({
  initialSetup: vi.fn(),
  connectExistingRemote: vi.fn(),
  getInitialSetupResult: vi.fn(async (): Promise<InitialSetupResult | undefined> => undefined),
  probeBucket: vi.fn(),
  probe: vi.fn(async () => ({ ok: true, conditionalWrites: "native" })),
  createProvider: vi.fn((_input: unknown) => ({ probe: state.probe, dispose: () => undefined })),
  routerPush: vi.fn()
}));

vi.mock("@keymaster/runtime", () => ({
  router: { push: state.routerPush },
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key })
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (() => {
    const capability = {
      initialSetup: state.initialSetup,
      connectExistingRemote: state.connectExistingRemote,
      getInitialSetupResult: state.getInitialSetupResult,
      probeBucket: state.probeBucket,
      status: () => "ready",
      subscribe: () => () => undefined
    };
    return (requested: string | { id: string }) => {
      const id = typeof requested === "string" ? requested : requested.id;
      return id === STORAGE_RUNTIME_CONTROLLER_CAPABILITY.id ? capability : undefined;
    };
  })()
}));

vi.mock("@keymaster/platform-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keymaster/platform-storage")>();
  return {
    ...actual,
    // 真实渲染 BucketConnectionFields；只替换网络探测。
    createBucketProvider: state.createProvider,
    createDeviceRecordRepository: actual.createDeviceRecordRepository,
    defaultDeviceStorage: actual.defaultDeviceStorage
  };
});

vi.mock("./OnboardingShell.js", () => ({ OnboardingShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("./StepProgress.js", () => ({ StepProgress: () => <div data-testid="setup-progress" /> }));
vi.mock("./FirstTimeImportWizard.js", () => ({
  FirstTimeImportWizard: ({ onComplete }: { onComplete(draft: { label: string; material: { hex: string }; format: string; capabilities: string[] }): void }) => (
    <button type="button" onClick={() => onComplete({ label: "导入 Key", material: { hex: "11".repeat(32) }, format: "hex", capabilities: ["p2pkh"] })}>完成单 Key 导入</button>
  )
}));

const setupSuccess: SetupSuccess = {
  ok: true,
  bucket: { bucketId: "created", backend: "local", deviceRecord: { format: "keymaster.device", version: 1, location: { providerId: "local" } } },
  firstKey: { publicKeyHex: "02abc", label: "主 Key", address: "1abc", format: "generated-secp256k1", capabilities: ["p2pkh"], createdAt: "2026-09-08T00:00:00.000Z" }
};

const connectSuccess: ConnectSuccess = {
  ok: true,
  bucket: { bucketId: "connected", backend: "local", deviceRecord: { format: "keymaster.device", version: 1, location: { providerId: "local" } } }
};

beforeEach(() => {
  const storage = defaultDeviceStorage();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("keymaster.")) storage.removeItem(key);
  }
  state.initialSetup.mockReset().mockResolvedValue(setupSuccess);
  state.connectExistingRemote.mockReset().mockResolvedValue(connectSuccess);
  state.getInitialSetupResult.mockReset().mockResolvedValue(undefined);
  state.probeBucket.mockReset().mockResolvedValue({ ok: true, state: "empty" } satisfies BucketProbeResult);
  state.probe.mockClear();
  state.createProvider.mockClear();
  state.routerPush.mockClear();
});

afterEach(() => cleanup());

async function probeLocal(user: ReturnType<typeof userEvent.setup>, name = "工作桶") {
  await user.click(await screen.findByRole("button", { name: /Local 桶/ }));
  await screen.findByRole("heading", { name: "填写桶参数" });
  await user.type(screen.getByLabelText(/本机显示名称/), name);
  await user.click(screen.getByRole("button", { name: "开始创建" }));
}

async function reachCreateConfirm(user: ReturnType<typeof userEvent.setup>, name = "工作桶") {
  await probeLocal(user, name);
  await screen.findByRole("heading", { name: "设置第一把 Key" });
  await user.click(screen.getByRole("button", { name: /新建 Key/ }));
  await user.type(screen.getByLabelText(/Key 标签名称/), "主 Key");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(screen.getByLabelText(/^Key 密码（至少 8 位）/), "key-password-1");
  await user.type(screen.getByLabelText("再输入一次 Key 密码"), "key-password-1");
  await user.click(screen.getByRole("button", { name: "继续确认" }));
  await screen.findByRole("heading", { name: /确认并初始化/ });
}

describe("InitialSetupPage（初始化流程规范）", () => {
  it("local 空桶：只填桶名称，提交计划不含 remoteStorageId 与启动密码", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await reachCreateConfirm(user);

    expect(screen.queryByLabelText(/Namespace/)).toBeNull();
    const plan = {
      transactionId: expect.any(String),
      bucketLabel: "工作桶",
      backend: "local",
      connection: { kind: "local" },
      firstKey: expect.objectContaining({ kind: "generate", label: "主 Key", password: "key-password-1" })
    } satisfies Partial<InitialSetupPlan>;
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));
    await waitFor(() => expect(state.initialSetup).toHaveBeenCalledTimes(1));
    expect(state.initialSetup.mock.calls[0]![0]).toMatchObject(plan);
    expect((state.initialSetup.mock.calls[0]![0] as InitialSetupPlan).remoteStorageId).toBeUndefined();
    expect((state.initialSetup.mock.calls[0]![0] as InitialSetupPlan).startupPassword).toBeUndefined();
    expect(state.routerPush).toHaveBeenCalledWith("/");
  });

  it("探测到已有 Key：进入解锁，提交连接计划只带该 Key 密码", async () => {
    state.probeBucket.mockResolvedValue({ ok: true, state: "has-keys", keys: [{ publicKeyHex: "02" + "ab".repeat(32), label: "旧 Key" }] } satisfies BucketProbeResult);
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await probeLocal(user, "已有钱包");

    await screen.findByRole("heading", { name: "解锁已有钱包" });
    await user.type(screen.getByLabelText(/这把 Key 自己的密码/), "key-password-1");
    await user.click(screen.getByRole("button", { name: "解锁并进入钱包" }));
    await waitFor(() => expect(state.connectExistingRemote).toHaveBeenCalledTimes(1));
    expect(state.connectExistingRemote.mock.calls[0]![0]).toMatchObject({
      backend: "local",
      connection: { kind: "local" },
      publicKeyHex: "02" + "ab".repeat(32),
      keyPassword: "key-password-1"
    } satisfies Partial<ExistingRemoteStorageConnectPlan>);
    expect((state.connectExistingRemote.mock.calls[0]![0] as ExistingRemoteStorageConnectPlan).remoteStorageId).toBeUndefined();
    expect((state.connectExistingRemote.mock.calls[0]![0] as ExistingRemoteStorageConnectPlan).startupPassword).toBeUndefined();
    expect(state.initialSetup).not.toHaveBeenCalled();
  });

  it("探测读取失败：停在参数步骤且不进入创建", async () => {
    state.probeBucket.mockResolvedValue({
      ok: false,
      error: { title: "无法完成初始化", summary: "读取 keys/ 失败", code: "storage_unavailable", incidentId: "x", diagnostic: "diag", phase: "validate", rollback: "not-started" }
    } satisfies BucketProbeResult);
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await probeLocal(user);

    await screen.findByRole("heading", { name: "填写桶参数" });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "设置第一把 Key" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /确认并初始化/ })).toBeNull();
  });

  it("本机已有同名桶时拒绝重复创建", async () => {
    createDeviceRecordRepository(defaultDeviceStorage()).put("setup-existing", {
      format: "keymaster.device",
      version: 1,
      displayName: "工作桶",
      location: { providerId: "local" }
    });
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await probeLocal(user);

    await screen.findByRole("heading", { name: "填写桶参数" });
    expect(screen.getByRole("alert").textContent).toMatch(/同名/u);
    expect(state.probeBucket).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "设置第一把 Key" })).toBeNull();
  });

  it("s3 空桶：先设启动密码，首 Key 另有自己的密码", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await user.click(await screen.findByRole("button", { name: /S3-compatible 远端/ }));
    await screen.findByRole("heading", { name: "填写桶参数" });
    await user.type(screen.getByLabelText(/本机显示名称/), "工作 S3 桶");
    await user.type(screen.getByRole("textbox", { name: /Region/ }), "us-east-1");
    await user.type(screen.getByLabelText(/Bucket/), "workspace");
    await user.type(screen.getByLabelText(/Access Key ID/), "access-key");
    await user.type(screen.getByLabelText(/Secret Access Key/), "secret-key");
    await user.click(screen.getByRole("button", { name: "测试连接并探测" }));

    await screen.findByRole("heading", { name: "设置启动密码" });
    await user.type(screen.getByLabelText(/启动密码（至少 8 位）/), "startup-password-1");
    await user.type(screen.getByLabelText("再输入一次启动密码"), "startup-password-1");
    await user.click(screen.getByRole("button", { name: "继续" }));

    await screen.findByRole("heading", { name: "设置第一把 Key" });
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Key 标签名称/), "主 Key");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.type(screen.getByLabelText(/^Key 密码（至少 8 位）/), "key-password-1");
    await user.type(screen.getByLabelText("再输入一次 Key 密码"), "key-password-1");
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    await screen.findByRole("heading", { name: /确认并初始化/ });

    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));

    await waitFor(() => expect(state.initialSetup).toHaveBeenCalledTimes(1));
    expect(state.initialSetup.mock.calls[0]![0]).toMatchObject({
      backend: "s3",
      startupPassword: "startup-password-1",
      firstKey: expect.objectContaining({ password: "key-password-1" })
    });
    expect((state.initialSetup.mock.calls[0]![0] as InitialSetupPlan).remoteStorageId).toBeUndefined();
  });
});
