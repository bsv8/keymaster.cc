// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeStorageCatalog } from "../bootstrap/storageCatalogRepository.js";
import { StorageBucketManagerPage } from "./StorageBucketManagerPage.js";

const state = vi.hoisted(() => ({
  probe: vi.fn(async () => ({ ok: true as const, conditionalWrites: "native" as const, latencyMs: 1 })),
  createProvider: vi.fn((_input: unknown) => ({ probe: state.probe, dispose: vi.fn() })),
  unlockBucketConfig: vi.fn(async () => ({
    kind: "s3" as const,
    endpoint: "https://objects.example.test",
    region: "custom-region",
    bucket: "workspace",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    sessionToken: "session-token",
    prefix: "tenant/",
    forcePathStyle: true
  })),
  prepareBucketConfig: vi.fn(async () => undefined),
  managerCatalogUpdate: vi.fn(async () => undefined),
  storage: {
    status: () => "unconfigured" as const,
    subscribe: () => () => undefined
  }
}));

vi.mock("@keymaster/runtime", () => ({
  router: { push: vi.fn() },
  useI18n: () => ({ t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key })
}));

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (id: string) => id === "storage.runtime-controller" ? state.storage : undefined
}));

vi.mock("../hold/storageBucketManagement.js", () => ({
  createStorageBucketManagementService: () => ({
    prepareBucketConfig: state.prepareBucketConfig,
    unlockBucketConfig: state.unlockBucketConfig,
    catalog: { updateBucket: state.managerCatalogUpdate }
  })
}));

vi.mock("./BucketConnectionFields.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BucketConnectionFields.js")>();
  return { ...actual, createBucketProvider: state.createProvider };
});

function s3CatalogEntry() {
  return {
    bucketId: "bucket-s3",
    label: "已保存 S3 桶",
    backend: "s3" as const,
    configRevision: 1,
    keyDerivation: { algorithm: "pbkdf2-hmac-sha-256" as const, passwordEncoding: "utf-8" as const, iterations: 100_000, outputLengthBits: 256 as const, saltB64Url: "0123456789ab" },
    encryptedConfig: { cipher: { algorithm: "aes-gcm" as const, keyLengthBits: 256 as const, ivB64Url: "0123456789ab", tagLengthBits: 128 as const, ciphertextAndTagB64Url: "encrypted-config" } },
    snapshotRevision: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

function mount() {
  return render(<StorageBucketManagerPage />);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  state.probe.mockClear();
  state.createProvider.mockClear();
  state.unlockBucketConfig.mockClear();
  state.prepareBucketConfig.mockClear();
});

describe("StorageBucketManagerPage S3 configuration regression", () => {
  it("tests new AWS, R2, and ordinary S3 drafts through the shared mode-aware path", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /添加桶/ }));
    await user.selectOptions(screen.getByLabelText(/桶类型/), "s3");
    await user.type(screen.getByLabelText(/本机显示名称/), "新 S3 桶");
    await user.type(screen.getByLabelText(/密码（至少 8 位）/), "bucket-password");
    await user.type(screen.getByLabelText("确认密码"), "bucket-password");

    await user.type(screen.getByRole("textbox", { name: /Region/ }), "us-east-1");
    await user.type(screen.getByLabelText(/Bucket/), "workspace");
    await user.type(screen.getByLabelText(/Access Key ID/), "aws-access");
    await user.type(screen.getByLabelText(/Secret Access Key/), "aws-secret");
    await user.click(screen.getByRole("button", { name: /^测试连接$/ }));
    expect(state.createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ s3ConfigMode: "aws-s3" }), expect.any(String));

    const mode = screen.getByLabelText(/配置方式/) as HTMLSelectElement;
    await user.selectOptions(mode, "cloudflare-r2");
    await user.type(screen.getByLabelText(/Account ID/), "a".repeat(32));
    await user.selectOptions(screen.getByLabelText(/Endpoint Variant/), "eu");
    await user.type(screen.getByLabelText(/Bucket/), "workspace");
    await user.type(screen.getByLabelText(/Access Key ID/), "r2-access");
    await user.type(screen.getByLabelText(/Secret Access Key/), "r2-secret");
    await user.type(screen.getByLabelText(/Session Token/), "r2-session-token");
    await user.click(screen.getByRole("button", { name: /^测试连接$/ }));
    expect(state.createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ s3ConfigMode: "cloudflare-r2", accountId: "a".repeat(32), sessionToken: "r2-session-token" }), expect.any(String));

    await user.selectOptions(mode, "s3-compatible");
    await user.type(screen.getByLabelText(/Endpoint/), "https://objects.example.test");
    await user.type(screen.getByRole("textbox", { name: /Region/ }), "custom-region");
    await user.type(screen.getByLabelText(/Bucket/), "workspace");
    await user.type(screen.getByLabelText(/Access Key ID/), "s3-access");
    await user.type(screen.getByLabelText(/Secret Access Key/), "s3-secret");
    await user.click(screen.getByRole("button", { name: /^测试连接$/ }));
    expect(state.createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ s3ConfigMode: "s3-compatible", endpoint: "https://objects.example.test", forcePathStyle: false }), expect.any(String));
    expect(state.probe).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "保存桶" }));
    await waitFor(() => expect(state.prepareBucketConfig).toHaveBeenCalledWith(expect.objectContaining({
      kind: "s3",
      endpoint: "https://objects.example.test",
      region: "custom-region",
      bucket: "workspace",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      forcePathStyle: false
    }), "bucket-password", expect.objectContaining({ backend: "s3", label: "新 S3 桶" })));
  });

  it("opens every persisted S3 connection as ordinary S3-compatible instead of guessing AWS or R2", async () => {
    writeStorageCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [s3CatalogEntry()] });
    vi.spyOn(window, "prompt").mockReturnValue("bucket-password");
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByLabelText(/更多桶操作/));
    await user.click(screen.getByRole("button", { name: /编辑连接配置/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText(/配置方式/) as HTMLSelectElement).value).toBe("s3-compatible");
    expect((screen.getByLabelText(/Endpoint/) as HTMLInputElement).value).toBe("https://objects.example.test");
    expect((screen.getByRole("textbox", { name: /Region/ }) as HTMLInputElement).value).toBe("custom-region");
  });
});
