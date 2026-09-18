// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BucketKeyList } from "./BucketKeyList.js";
import type { BucketRow } from "./bucketCatalog.js";

const KEY_A = "02" + "aa".repeat(32);
const KEY_B = "02" + "bb".repeat(32);

const state = vi.hoisted(() => {
  const probeBucket = vi.fn();
  const deleteLocalBucketKey = vi.fn();
  const listKeys = vi.fn();
  const deleteKey = vi.fn();
  return {
    probeBucket,
    deleteLocalBucketKey,
    listKeys,
    deleteKey,
    storageCapability: { probeBucket, deleteLocalBucketKey, status: () => "ready", subscribe: () => () => undefined },
    i18n: { t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key },
    vaultCapability: { status: () => "unlocked", listKeys },
    keyspaceCapability: { deleteKey },
  };
});

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: (requested: { id: string }) => {
    if (requested.id === "storage.runtime-controller") return state.storageCapability;
    if (requested.id === "vault.service") return state.vaultCapability;
    if (requested.id === "keyspace.service") return state.keyspaceCapability;
    return undefined;
  },
}));

vi.mock("@keymaster/runtime", () => ({
  useI18n: () => state.i18n,
}));

const localRow: BucketRow = {
  bucketId: "local-1",
  label: "本地桶",
  backend: "local",
  record: { format: "keymaster.device", version: 1, displayName: "本地桶", location: { providerId: "local" } },
  current: false,
};

const currentLocalRow: BucketRow = { ...localRow, current: true };
const currentS3Row: BucketRow = {
  ...localRow,
  bucketId: "s3-1",
  label: "S3 桶",
  backend: "s3",
  record: {
    format: "keymaster.device",
    version: 1,
    displayName: "S3 桶",
    location: { providerId: "s3", endpoint: "https://example.com", region: "auto", bucket: "my-bucket" },
    cipher: { algorithm: "aes-gcm", keyLengthBits: 256, ivB64Url: "AAAAAAAAAAAAAAAA", tagLengthBits: 128, ciphertextAndTagB64Url: "AAAAAAAAAAAAAAAAAAAAAA" },
  },
  current: true,
};

beforeEach(() => {
  state.probeBucket.mockReset();
  state.deleteLocalBucketKey.mockReset();
  state.listKeys.mockReset().mockResolvedValue([]);
  state.deleteKey.mockReset();
});

afterEach(() => cleanup());

describe("桶内 Key 列表", () => {
  it("非当前 Local 桶直接列出 Key，并在标签确认后删除 Key 与本地数据", async () => {
    state.probeBucket.mockResolvedValue({
      ok: true,
      state: "has-keys",
      keys: [{ publicKeyHex: KEY_A, label: "Key A" }, { publicKeyHex: KEY_B, label: "Key B" }],
    });
    state.deleteLocalBucketKey.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<BucketKeyList row={localRow} unlocked onChanged={onChanged} />);

    expect(await screen.findByText("Key A")).toBeTruthy();
    expect(screen.getByText("Key B")).toBeTruthy();
    expect(state.probeBucket.mock.calls[0]![0]).toMatchObject({ backend: "local", binding: { bucketId: "local-1" } });

    await user.click(screen.getByTestId(`bucket-key-delete-${KEY_A}`));
    await user.type(await screen.findByLabelText(/请输入目标标签以确认/), "Key A");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(state.deleteLocalBucketKey).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "local-1", backend: "local" }),
      KEY_A,
    ));
    expect(onChanged).toHaveBeenCalled();
    expect(state.deleteKey).not.toHaveBeenCalled();
  });

  it("当前桶用 vault 列表并走 keyspace.deleteKey（local 不需要桶密码）", async () => {
    state.listKeys.mockResolvedValue([
      { publicKeyHex: KEY_A, label: "Key A", format: "generated", capabilities: ["p2pkh"], createdAt: "2026-09-18T00:00:00.000Z" },
    ]);
    state.deleteKey.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<BucketKeyList row={currentLocalRow} unlocked onChanged={vi.fn()} />);

    expect(await screen.findByText("Key A")).toBeTruthy();
    await user.click(screen.getByTestId(`bucket-key-delete-${KEY_A}`));
    await user.type(await screen.findByLabelText(/请输入目标标签以确认/), "Key A");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(state.deleteKey).toHaveBeenCalledWith({
      publicKeyHex: KEY_A,
      confirmationLabel: "Key A",
    }));
    expect(state.deleteLocalBucketKey).not.toHaveBeenCalled();
  });

  it("当前 S3 桶删除需要桶密码", async () => {
    state.listKeys.mockResolvedValue([
      { publicKeyHex: KEY_A, label: "Key A", format: "generated", capabilities: ["p2pkh"], createdAt: "2026-09-18T00:00:00.000Z" },
    ]);
    state.deleteKey.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<BucketKeyList row={currentS3Row} unlocked onChanged={vi.fn()} />);

    expect(await screen.findByText("Key A")).toBeTruthy();
    await user.click(screen.getByTestId(`bucket-key-delete-${KEY_A}`));
    await user.type(await screen.findByLabelText(/请输入目标标签以确认/), "Key A");
    await user.type(await screen.findByLabelText(/请输入当前桶密码/), "bucket-password-1");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(state.deleteKey).toHaveBeenCalledWith({
      publicKeyHex: KEY_A,
      confirmationLabel: "Key A",
      bucketPassword: "bucket-password-1",
    }));
  });

  it("非当前 S3 桶不在这里列出（读取需要桶密码）", () => {
    render(<BucketKeyList row={{ ...currentS3Row, current: false }} unlocked onChanged={vi.fn()} />);
    expect(screen.queryByTestId("bucket-key-list-s3-1")).toBeNull();
    expect(state.probeBucket).not.toHaveBeenCalled();
  });
});
