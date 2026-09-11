// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupRecoveryResult, InitialSetupResult } from "@keymaster/contracts";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import type { S3ConfigMode } from "@keymaster/platform-storage";
import { InitialSetupPage } from "./InitialSetupPage.js";

type InitialSetupSuccess = Extract<InitialSetupResult, { ok: true }>;

const state = vi.hoisted(() => ({
  initialSetup: vi.fn(async (_plan: InitialSetupPlan): Promise<InitialSetupResult> => ({
    ok: true as const,
    bucket: { bucketId: "bucket-created" } as InitialSetupSuccess["bucket"],
    firstKey: {
      publicKeyHex: "02abc",
      label: "主 Key",
      address: "1abc",
      format: "generated-secp256k1",
      capabilities: ["p2pkh"],
      createdAt: "2026-09-08T00:00:00.000Z"
    }
  })),
  getInitialSetupResult: vi.fn(async (_transactionId: string): Promise<InitialSetupResult | undefined> => undefined),
  listInitialSetupRecoveries: vi.fn(async (): Promise<InitialSetupRecoveryRecordV1[]> => []),
  retryInitialSetupCleanup: vi.fn(async (_transactionId: string): Promise<InitialSetupRecoveryResult> => ({ status: "cleanup-confirmed" })),
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
    const storageCapability = {
      initialSetup: state.initialSetup,
      getInitialSetupResult: state.getInitialSetupResult,
      listInitialSetupRecoveries: state.listInitialSetupRecoveries,
      retryInitialSetupCleanup: state.retryInitialSetupCleanup,
      status: () => "ready",
      subscribe: () => () => undefined
    };
    return (capability: string | { id: string }) => {
      const capabilityId = typeof capability === "string" ? capability : capability.id;
      return capabilityId === STORAGE_RUNTIME_CONTROLLER_CAPABILITY.id ? storageCapability : undefined;
    };
  })()
}));

vi.mock("@keymaster/platform-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keymaster/platform-storage")>();
  return {
    ...actual,
    // 真实渲染 BucketConnectionFields；只替换网络探测，避免测试访问外部 S3。
    createBucketProvider: state.createProvider
  };
});

vi.mock("./OnboardingShell.js", () => ({ OnboardingShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("./StepProgress.js", () => ({ StepProgress: () => <div data-testid="setup-progress" /> }));
vi.mock("./FirstTimeImportWizard.js", () => ({
  FirstTimeImportWizard: ({ onComplete }: { onComplete(draft: { label: string; material: { hex: string }; format: string; capabilities: string[] }): void }) => (
    <button type="button" onClick={() => onComplete({ label: "导入 Key", material: { hex: "11".repeat(32) }, format: "hex", capabilities: ["p2pkh"] })}>完成单 Key 导入</button>
  )
}));

beforeEach(() => {
  state.initialSetup.mockClear();
  state.getInitialSetupResult.mockClear();
  state.listInitialSetupRecoveries.mockClear();
  state.retryInitialSetupCleanup.mockClear();
  state.probe.mockClear();
  state.createProvider.mockClear();
  state.routerPush.mockClear();
});

afterEach(() => cleanup());

async function reachKeyChoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Local/ }));
  await user.type(screen.getByLabelText(/本机显示名称/), "工作桶");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText(/密码（至少 8 位）/), "password-123");
  await user.type(screen.getByLabelText("确认密码"), "password-123");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await screen.findByRole("heading", { name: "设置第一把 Key" });
}

async function reachS3Parameters(user: ReturnType<typeof userEvent.setup>) {
  render(<InitialSetupPage />);
  await user.click(await screen.findByRole("button", { name: /^S3\b/ }));
  await screen.findByRole("heading", { name: "填写桶参数" });
}

async function fillRequiredS3Fields(user: ReturnType<typeof userEvent.setup>, mode: S3ConfigMode = "aws-s3") {
  await user.type(screen.getByLabelText(/本机显示名称/), "工作 S3 桶");
  if (mode !== "aws-s3") await user.selectOptions(screen.getByLabelText(/配置方式/), mode);
  if (mode === "aws-s3") {
    await user.type(screen.getByRole("textbox", { name: /Region/ }), "us-east-1");
  } else if (mode === "cloudflare-r2") {
    await user.type(screen.getByLabelText(/Account ID/), "a".repeat(32));
    await user.selectOptions(screen.getByLabelText(/Endpoint Variant/), "us");
  } else {
    await user.type(screen.getByLabelText(/Endpoint/), "https://objects.example.test");
    await user.type(screen.getByRole("textbox", { name: /Region/ }), "custom-region");
  }
  await user.type(screen.getByLabelText(/Bucket/), "workspace");
  await user.type(screen.getByLabelText(/Access Key ID/), "access-key");
  await user.type(screen.getByLabelText(/Secret Access Key/), "secret-key");
}

describe("InitialSetupPage", () => {
  it("真实渲染 AWS、R2 和普通 S3 三种配置方式的字段", async () => {
    const user = userEvent.setup();
    await reachS3Parameters(user);

    const mode = screen.getByLabelText(/配置方式/) as HTMLSelectElement;
    expect(mode.value).toBe("aws-s3");
    expect(screen.getByRole("textbox", { name: /Region/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Endpoint/ })).toBeNull();

    await user.selectOptions(mode, "cloudflare-r2");
    expect(screen.getByRole("textbox", { name: /Account ID/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Endpoint Variant/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /US/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /^Region/ })).toBeNull();

    await user.selectOptions(mode, "s3-compatible");
    expect(screen.getByRole("textbox", { name: /Endpoint/ })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Region/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Force Path Style/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Account ID/ })).toBeNull();
  });

  it("完整 AWS 表单使用草稿构造 Provider，并通过 native CAS 后进入密码步骤", async () => {
    const user = userEvent.setup();
    await reachS3Parameters(user);
    await fillRequiredS3Fields(user);
    await user.click(screen.getByRole("button", { name: "测试连接并继续" }));

    expect(state.probe).toHaveBeenCalledTimes(1);
    expect(state.createProvider).toHaveBeenCalledWith(expect.objectContaining({ backend: "s3", s3ConfigMode: "aws-s3" }), expect.any(String));
    expect(await screen.findByRole("heading", { name: "设置密码" })).toBeTruthy();
  });

  it("AWS 缺少 Region 或凭据时只做本地校验，不调用 probe", async () => {
    const user = userEvent.setup();
    await reachS3Parameters(user);
    await user.type(screen.getByLabelText(/本机显示名称/), "不完整 AWS 桶");
    await user.click(screen.getByRole("button", { name: "测试连接并继续" }));

    expect(state.probe).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("R2 最终提交使用通用 S3 连接并在确认页隐藏完整 Account ID 和 Endpoint", async () => {
    const user = userEvent.setup();
    const accountId = "abcdef0123456789abcdef0123456789";
    await reachS3Parameters(user);
    await user.type(screen.getByLabelText(/本机显示名称/), "R2 工作桶");
    await user.selectOptions(screen.getByLabelText(/配置方式/), "cloudflare-r2");
    await user.type(screen.getByLabelText(/Account ID/), accountId);
    await user.selectOptions(screen.getByLabelText(/Endpoint Variant/), "eu");
    await user.type(screen.getByLabelText(/Bucket/), "workspace");
    await user.type(screen.getByLabelText(/Access Key ID/), "r2-access");
    await user.type(screen.getByLabelText(/Secret Access Key/), "r2-secret");
    expect((screen.getByLabelText(/Access Key ID/) as HTMLInputElement).value).toBe("r2-access");
    expect((screen.getByLabelText(/Secret Access Key/) as HTMLInputElement).value).toBe("r2-secret");
    await user.click(screen.getByRole("button", { name: "测试连接并继续" }));
    expect(state.createProvider).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: "r2-access", secretAccessKey: "r2-secret" }), expect.any(String));
    await user.type(await screen.findByLabelText(/密码（至少 8 位）/), "password-123");
    await user.type(screen.getByLabelText("确认密码"), "password-123");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Tag Name/), "R2 首 Key");
    await user.click(screen.getByRole("button", { name: "继续确认" }));

    expect(screen.getByText(`R2 / ${accountId.slice(0, 2)}••••${accountId.slice(-2)} / workspace`)).toBeTruthy();
    expect(screen.queryByText(accountId)).toBeNull();
    expect(screen.queryByText(`https://${accountId}.eu.r2.cloudflarestorage.com`)).toBeNull();

    await user.click(screen.getByRole("button", { name: /创建桶和第一把 Key/ }));
    expect(state.initialSetup).toHaveBeenCalledWith(expect.objectContaining({
      backend: "s3",
      connection: {
        kind: "s3",
        endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`,
        region: "auto",
        bucket: "workspace",
        accessKeyId: "r2-access",
        secretAccessKey: "r2-secret",
        forcePathStyle: false
      }
    }));
  });

  it.each(["aws-s3", "cloudflare-r2", "s3-compatible"] as const)("%s 配置的 probe 都拒绝 best-effort CAS", async (mode) => {
    const user = userEvent.setup();
    state.probe.mockResolvedValueOnce({ ok: true, conditionalWrites: "best-effort" });
    await reachS3Parameters(user);
    await fillRequiredS3Fields(user, mode);
    await user.click(screen.getByRole("button", { name: "测试连接并继续" }));
    expect(state.createProvider).toHaveBeenCalledWith(expect.objectContaining({ backend: "s3", s3ConfigMode: mode }), expect.any(String));
    expect(screen.getByRole("heading", { name: "填写桶参数" })).toBeTruthy();
    await user.click(screen.getByText("查看脱敏技术诊断"));
    expect(screen.getByText(/原子条件写入/)).toBeTruthy();
  });

  it("只在最终确认时提交包含第一把 Key 的完整计划", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await reachKeyChoice(user);

    expect(state.initialSetup).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Tag Name/), "主 Key");
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));

    expect(state.initialSetup).toHaveBeenCalledTimes(1);
    const [plan] = state.initialSetup.mock.calls[0] ?? [];
    expect(plan).toMatchObject({
      bucketLabel: "工作桶",
      backend: "local",
      connection: { kind: "local" },
      bucketPassword: "password-123",
      firstKey: { kind: "generate", label: "主 Key", capabilities: ["p2pkh"] }
    });
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
  });

  it("导入路径把解析后的首 Key 放进同一份最终计划", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await reachKeyChoice(user);
    await user.click(screen.getByRole("button", { name: /导入 Key/ }));
    await user.click(screen.getByRole("button", { name: "完成单 Key 导入" }));
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));

    expect(state.initialSetup).toHaveBeenCalledTimes(1);
    expect(state.initialSetup.mock.calls[0]?.[0]).toMatchObject({
      firstKey: { kind: "import", label: "导入 Key", format: "hex", material: { hex: "11".repeat(32) } }
    });
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
  });

  it("响应丢失时查询同一 transactionId，不重新提交第二次", async () => {
    const user = userEvent.setup();
    state.initialSetup.mockRejectedValueOnce(new Error("transport timeout"));
    state.getInitialSetupResult.mockResolvedValueOnce({
      ok: true as const,
      bucket: { bucketId: "bucket-created" } as InitialSetupSuccess["bucket"],
      firstKey: {
        publicKeyHex: "02abc",
        label: "主 Key",
        address: "1abc",
        format: "generated-secp256k1",
        capabilities: ["p2pkh"],
        createdAt: "2026-09-08T00:00:00.000Z"
      }
    });
    render(<InitialSetupPage />);
    await reachKeyChoice(user);
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Tag Name/), "主 Key");
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));

    expect(state.initialSetup).toHaveBeenCalledTimes(1);
    expect(state.getInitialSetupResult).toHaveBeenCalledWith(expect.any(String));
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
  });

  it("确认回滚后下一次提交生成新的 transactionId", async () => {
    const user = userEvent.setup();
    const failed = {
      ok: false as const,
      error: {
        title: "无法完成初始化",
        summary: "初始化未完成，本次暂存数据已回滚，可以修改表单后重试。",
        action: "检查参数和存储权限后重试。",
        code: "storage_provider_error",
        incidentId: "initial-failure",
        diagnostic: "diagnostic",
        phase: "stage" as const,
        rollback: "confirmed" as const
      }
    };
    state.initialSetup.mockResolvedValueOnce(failed);
    render(<InitialSetupPage />);
    await reachKeyChoice(user);
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Tag Name/), "主 Key");
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));
    await screen.findByRole("heading", { name: "设置密码" });

    await user.type(screen.getByLabelText(/密码（至少 8 位）/), "password-123");
    await user.type(screen.getByLabelText("确认密码"), "password-123");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    await user.click(screen.getByRole("button", { name: "创建桶和第一把 Key" }));

    expect(state.initialSetup).toHaveBeenCalledTimes(2);
    const first = state.initialSetup.mock.calls[0]?.[0];
    const second = state.initialSetup.mock.calls[1]?.[0];
    expect(first?.transactionId).toBeDefined();
    expect(second?.transactionId).toBeDefined();
    expect(second?.transactionId).not.toBe(first?.transactionId);
  });

  it("刷新进入时不从目录恢复未完成的初始化", async () => {
    render(<InitialSetupPage />);
    expect(await screen.findByRole("heading", { name: "选择桶类型" })).toBeTruthy();
  });

  it("恢复账本不可读时保持 recoveryUnavailable，不允许开始新事务", async () => {
    state.listInitialSetupRecoveries.mockRejectedValueOnce(new Error("storage_provider_error"));
    render(<InitialSetupPage />);

    expect(await screen.findByRole("heading", { name: "无法确认初始化状态" })).toBeTruthy();
    expect(screen.getByText(/恢复记录暂时不可读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Local/ })).toBeNull();
    expect(state.initialSetup).not.toHaveBeenCalled();
  });

  it("刷新后发现待清理事务时禁止创建新事务，并使用独立清理结果", async () => {
    const record: InitialSetupRecoveryRecordV1 = {
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId: "initial-setup-page-recovery-001",
      bucketId: "setup-page-recovery-001",
      configRevision: 1,
      snapshotRevision: 0,
      backend: "local",
      phase: "rollback",
      catalog: "empty",
      runtimeInstalled: false,
      cleanup: "unconfirmed",
      status: "failed",
      error: {
        title: "无法完成初始化",
        summary: "候选数据尚未清理",
        action: "请重试清理",
        code: "storage_provider_error",
        incidentId: "page-recovery-incident",
        transactionId: "initial-setup-page-recovery-001",
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt: Date.now(),
    };
    state.listInitialSetupRecoveries.mockResolvedValueOnce([record]);
    render(<InitialSetupPage />);

    expect(await screen.findByText(/恢复未完成的初始化/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Local/ })).toBeNull();
    await userEvent.setup().type(screen.getByLabelText(/重试清理所需的桶密码/), "recovery-password");
    await userEvent.setup().click(screen.getByRole("button", { name: "重试清理本次初始化" }));

    expect(state.retryInitialSetupCleanup).toHaveBeenCalledWith("initial-setup-page-recovery-001", {
      password: "recovery-password",
      connection: { kind: "local" },
    });
    expect(await screen.findByRole("heading", { name: "选择桶类型" })).toBeTruthy();
    expect(state.initialSetup).not.toHaveBeenCalled();
  });

  it("S3 恢复清理使用 R2 US 表单转换出的完整通用连接", async () => {
    const user = userEvent.setup();
    const transactionId = "initial-setup-page-r2-recovery-001";
    const accountId = "abcdef0123456789abcdef0123456789";
    const record: InitialSetupRecoveryRecordV1 = {
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId,
      bucketId: "setup-page-r2-recovery-001",
      configRevision: 1,
      snapshotRevision: 0,
      backend: "s3",
      connectionFingerprint: "a".repeat(64),
      phase: "rollback",
      catalog: "empty",
      runtimeInstalled: false,
      cleanup: "unconfirmed",
      status: "failed",
      error: {
        title: "无法完成初始化",
        summary: "候选数据尚未清理",
        action: "请重新确认目标后重试清理",
        code: "storage_provider_error",
        incidentId: "page-r2-recovery-incident",
        transactionId,
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt: Date.now(),
    };
    state.listInitialSetupRecoveries.mockResolvedValueOnce([record]);
    render(<InitialSetupPage />);

    expect(await screen.findByText(/恢复未完成的初始化/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(/配置方式/), "cloudflare-r2");
    await user.type(screen.getByLabelText(/Account ID/), accountId);
    await user.selectOptions(screen.getByLabelText(/Endpoint Variant/), "us");
    await user.type(screen.getByLabelText(/Bucket/), "recovery-bucket");
    await user.type(screen.getByLabelText(/Access Key ID/), "r2-recovery-access");
    await user.type(screen.getByLabelText(/Secret Access Key/), "r2-recovery-secret");
    await user.type(screen.getByLabelText(/Prefix/), "team-a");
    await user.type(screen.getByLabelText(/重试清理所需的桶密码/), "recovery-password");
    await user.click(screen.getByRole("button", { name: "重试清理本次初始化" }));

    expect(state.retryInitialSetupCleanup).toHaveBeenCalledWith(transactionId, {
      password: "recovery-password",
      connection: {
        kind: "s3",
        endpoint: `https://${accountId}.us.r2.cloudflarestorage.com`,
        region: "auto",
        bucket: "recovery-bucket",
        accessKeyId: "r2-recovery-access",
        secretAccessKey: "r2-recovery-secret",
        prefix: "team-a/",
        forcePathStyle: false,
      },
    });
    expect(await screen.findByRole("heading", { name: "选择桶类型" })).toBeTruthy();
    expect(state.initialSetup).not.toHaveBeenCalled();
  });

  it("连续存在两条恢复记录时，清理第一条后自动加载下一条", async () => {
    const makePendingRecord = (transactionId: string, updatedAt: number): InitialSetupRecoveryRecordV1 => ({
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId,
      bucketId: "setup-" + transactionId,
      configRevision: 1,
      snapshotRevision: 0,
      backend: "local",
      phase: "rollback",
      catalog: "empty",
      runtimeInstalled: false,
      cleanup: "unconfirmed",
      status: "failed",
      error: {
        title: "无法完成初始化",
        summary: "候选数据尚未清理",
        action: "请重试清理",
        code: "storage_provider_error",
        incidentId: transactionId + "-incident",
        transactionId,
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt,
    });
    const first = makePendingRecord("initial-setup-page-queue-first", 2);
    const second = makePendingRecord("initial-setup-page-queue-second", 1);
    state.listInitialSetupRecoveries
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    state.retryInitialSetupCleanup.mockResolvedValueOnce({ status: "cleanup-confirmed" });
    render(<InitialSetupPage />);

    expect(await screen.findByText(first.transactionId)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试清理本次初始化" }));

    expect(await screen.findByText(second.transactionId)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Local/ })).toBeNull();
    expect(state.listInitialSetupRecoveries).toHaveBeenCalledTimes(2);
  });

  it("刷新后已提交事务可验证时进入 Vault，不重新开始初始化", async () => {
    const transactionId = "initial-setup-page-success-001";
    const record: InitialSetupRecoveryRecordV1 = {
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId,
      bucketId: "setup-page-success-001",
      configRevision: 1,
      snapshotRevision: 1,
      backend: "local",
      phase: "complete",
      catalog: "committed",
      runtimeInstalled: true,
      cleanup: "confirmed",
      status: "succeeded",
      success: {
        bucketLabel: "恢复桶",
        publicKeyHex: "02abc",
        label: "主 Key",
        address: "1abc",
        format: "generated-secp256k1",
        capabilities: ["p2pkh"],
        createdAt: "2026-09-08T00:00:00.000Z",
      },
      updatedAt: Date.now(),
    };
    state.listInitialSetupRecoveries.mockResolvedValueOnce([record]);
    state.getInitialSetupResult.mockResolvedValueOnce({
      ok: true as const,
      bucket: { bucketId: record.bucketId } as InitialSetupSuccess["bucket"],
      firstKey: {
        publicKeyHex: "02abc",
        label: "主 Key",
        address: "1abc",
        format: "generated-secp256k1",
        capabilities: ["p2pkh"],
        createdAt: "2026-09-08T00:00:00.000Z",
      },
    });
    render(<InitialSetupPage />);

    await vi.waitFor(() => expect(state.getInitialSetupResult).toHaveBeenCalledWith(transactionId));
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
    expect(state.initialSetup).not.toHaveBeenCalled();
  });
});
