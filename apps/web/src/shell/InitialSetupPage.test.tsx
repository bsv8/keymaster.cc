// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupRecoveryResult, InitialSetupResult } from "@keymaster/contracts";
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
    return (id: string) => id === "storage.runtime-controller" ? storageCapability : undefined;
  })()
}));

vi.mock("@keymaster/platform-storage", () => ({
  EMPTY_BUCKET_DRAFT: {
    label: "", backend: "local", password: "", passwordConfirm: "", endpoint: "", region: "",
    bucket: "", accessKeyId: "", secretAccessKey: "", sessionToken: "", prefix: "", forcePathStyle: false
  },
  connectionFromBucketDraft: (draft: { backend: string }) => draft.backend === "local" ? { kind: "local" } : {
    kind: "s3", endpoint: "https://s3.example.test", region: "us-east-1", bucket: "demo",
    accessKeyId: "access", secretAccessKey: "secret"
  },
  createBucketProvider: () => ({ probe: state.probe, dispose: () => undefined }),
  BucketConnectionFields: ({ draft, onChange, section }: { draft: Record<string, string>; onChange(key: string, value: string): void; section: string }) => <div>
    {section === "parameters" ? <label>桶名称（本机显示名称）<input value={draft.label} onChange={(event) => onChange("label", event.currentTarget.value)} /></label> : null}
    {section === "password" ? <><label>密码（至少 8 位）<input type="password" value={draft.password} onChange={(event) => onChange("password", event.currentTarget.value)} /></label><label>确认密码<input type="password" value={draft.passwordConfirm} onChange={(event) => onChange("passwordConfirm", event.currentTarget.value)} /></label></> : null}
  </div>
}));

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
  state.routerPush.mockClear();
});

afterEach(() => cleanup());

async function reachKeyChoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Local/ }));
  await user.type(screen.getByLabelText(/桶名称/), "工作桶");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText(/密码（至少 8 位）/), "password-123");
  await user.type(screen.getByLabelText("确认密码"), "password-123");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await screen.findByRole("heading", { name: "设置第一把 Key" });
}

describe("InitialSetupPage", () => {
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
