// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { InitialSetupPage } from "./InitialSetupPage.js";

const state = vi.hoisted(() => ({
  prepared: false,
  routerPush: vi.fn(),
  prepareBucket: vi.fn(async () => undefined),
  unlockBucket: vi.fn(async () => ({ ok: true })),
  createInitialKey: vi.fn(async () => undefined),
  probe: vi.fn(async () => ({ ok: true, conditionalWrites: "native" }))
}));

vi.mock("@keymaster/runtime", () => ({
  router: { push: state.routerPush },
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key })
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (id: string) => id === "storage.runtime-controller"
    ? { unlockBucket: state.unlockBucket, status: () => "ready", subscribe: () => () => undefined }
    : { createVaultWithInitialKey: state.createInitialKey }
}));

vi.mock("@keymaster/platform-storage", () => ({
  EMPTY_BUCKET_DRAFT: { label: "", backend: "local", password: "", passwordConfirm: "", endpoint: "", region: "", bucket: "", accessKeyId: "", secretAccessKey: "", sessionToken: "", prefix: "", forcePathStyle: false },
  readStorageCatalog: () => state.prepared
    ? { format: "keymaster.storage.catalog", version: 2, selectedBucketId: "bucket-a", buckets: [{ bucketId: "bucket-a" }] }
    : { format: "keymaster.storage.catalog", version: 2, buckets: [] },
  createStorageBucketManagementService: () => ({ prepareBucketConfig: state.prepareBucket }),
  connectionFromBucketDraft: (draft: { backend: string }) => draft.backend === "local" ? { kind: "local" } : { kind: "s3" },
  createBucketProvider: () => ({ probe: state.probe, dispose: () => undefined }),
  BucketConnectionFields: ({ draft, onChange, section }: { draft: Record<string, string>; onChange(key: string, value: string): void; section: string }) => <div>
    {section === "parameters" ? <label>桶名称（本机显示名称）<input value={draft.label} onChange={(event) => onChange("label", event.currentTarget.value)} /></label> : null}
    {section === "password" ? <><label>密码（至少 8 位）<input type="password" value={draft.password} onChange={(event) => onChange("password", event.currentTarget.value)} /></label><label>确认密码<input type="password" value={draft.passwordConfirm} onChange={(event) => onChange("passwordConfirm", event.currentTarget.value)} /></label></> : null}
  </div>
}));

vi.mock("./OnboardingShell.js", () => ({ OnboardingShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("./StepProgress.js", () => ({ StepProgress: () => <div data-testid="setup-progress" /> }));
vi.mock("./FirstTimeImportWizard.js", () => ({ FirstTimeImportWizard: ({ onComplete }: { onComplete(): void }) => <button type="button" onClick={onComplete}>完成单 Key 导入</button> }));

beforeEach(() => {
  state.prepared = false;
  state.routerPush.mockClear();
  state.prepareBucket.mockClear();
  state.unlockBucket.mockClear();
  state.createInitialKey.mockClear();
  state.probe.mockClear();
});

afterEach(() => cleanup());

async function reachKeyChoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Local/ }));
  await user.type(screen.getByLabelText(/桶名称/), "工作桶");
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.type(await screen.findByLabelText(/密码（至少 8 位）/), "password-123");
  await user.type(screen.getByLabelText("确认密码"), "password-123");
  await user.click(screen.getByRole("button", { name: "保存并继续" }));
  await screen.findByRole("heading", { name: "设置第一把 Key" });
}

describe("InitialSetupPage", () => {
  it("按桶类型、参数、密码、新建 Key 的顺序完成初始设置", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await reachKeyChoice(user);
    expect(state.prepareBucket).toHaveBeenCalledTimes(1);
    expect(state.unlockBucket).toHaveBeenCalledWith("password-123");

    await user.click(screen.getByRole("button", { name: /新建 Key/ }));
    await user.type(screen.getByLabelText(/Tag Name/), "主 Key");
    await user.click(screen.getByRole("button", { name: /创建并进入 Key 管理/ }));
    expect(state.createInitialKey).toHaveBeenCalledWith({ password: "password-123", label: "主 Key" });
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
  });

  it("导入路径复用初始密码并在一把 Key 完成后进入 Key 管理", async () => {
    const user = userEvent.setup();
    render(<InitialSetupPage />);
    await reachKeyChoice(user);
    await user.click(screen.getByRole("button", { name: /导入 Key/ }));
    await user.click(screen.getByRole("button", { name: "完成单 Key 导入" }));
    expect(state.routerPush).toHaveBeenCalledWith("/settings/vault");
  });

  it("已有但未完成 Key 设置的桶从密码步骤恢复", () => {
    state.prepared = true;
    render(<InitialSetupPage />);
    expect(screen.getByRole("heading", { name: "输入密码继续初始设置" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "选择桶类型" })).toBeNull();
  });
});
