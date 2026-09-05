// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { StorageProviderConnectionView, StorageProviderSummary, StorageRuntimeController } from "@keymaster/contracts";
import { StorageProfileEditor } from "./StorageProfileEditor.js";
import type { StorageRuntimeSnapshot } from "../runtime/storageRuntimeController.js";

const state = vi.hoisted(() => ({
  service: undefined as unknown as StorageRuntimeController,
  resource: undefined as unknown as StorageRuntimeSnapshot
}));

vi.mock("@keymaster/runtime", () => ({
  useCapability: <T,>(_key: string): T => state.service as unknown as T,
  useI18n: () => ({ t: (key: string) => key }),
  usePluginHost: () => ({ resourceStore: {} }),
  useResourceSelector: () => state.resource
}));

function summary(): StorageProviderSummary {
  return { providerId: "aws-s3", bucketHint: "ex••••me", accessKeyHint: "••••last", secretConfigured: true, generation: 4, updatedAt: 1000 };
}

function makeService(connection: StorageProviderConnectionView): StorageRuntimeController {
  return {
    status: () => "ready",
    subscribe: () => () => undefined,
    getProviderSummary: vi.fn(async () => summary()),
    getProviderConnection: vi.fn(async () => connection),
    cancelProbe: vi.fn(),
    probeProvider: vi.fn(async () => ({ ok: true, providerId: "aws-s3" as const, latencyMs: 1 })),
    getConditionalCapabilities: vi.fn(() => null),
    probeConditionalCapabilities: vi.fn(async () => ({ generation: 1, put: "inconclusive" as const, complete: "inconclusive" as const, cleanupWarning: false })),
    activateProvider: vi.fn(async () => ({ ok: true, providerId: "aws-s3" as const, latencyMs: 1 })),
    clearProviderConfig: vi.fn(async () => undefined),
    resetStorage: vi.fn(async () => undefined),
    abortSession: vi.fn(async () => undefined),
    list: vi.fn(), createDirectory: vi.fn(), deleteDirectory: vi.fn(), put: vi.fn(), getRange: vi.fn(), delete: vi.fn(),
    beginUpload: vi.fn(), uploadPart: vi.fn(), completeUpload: vi.fn(), abortUpload: vi.fn()
  } as unknown as StorageRuntimeController;
}

afterEach(() => cleanup());

describe("StorageProfileEditor", () => {
  it("hydrates without reactivation, then auto-saves a changed connection with retained credentials", async () => {
    const connection: StorageProviderConnectionView = {
      providerId: "aws-s3",
      connection: { region: "eu-west-1", bucket: "existing-bucket" }
    };
    state.service = makeService(connection);
    state.resource = { status: "ready", summary: summary() };
    render(<StorageProfileEditor />);

    await waitFor(() => expect(screen.getByDisplayValue("existing-bucket")).toBeTruthy());
    expect(screen.getByDisplayValue("eu-west-1")).toBeTruthy();
    expect(screen.queryByText("storage.settings.prefix")).toBeNull();
    expect(screen.getByText("storage.settings.cors")).toBeTruthy();
    const corsTemplate = screen.getByTestId("storage-cors-template");
    expect(corsTemplate.textContent).toContain(window.location.origin);
    expect(corsTemplate.textContent).toContain("If-None-Match");
    expect(corsTemplate.textContent).toContain("x-amz-*");
    expect(corsTemplate.textContent).toContain("Content-Length");
    expect(screen.getByText("storage.settings.probeScope")).toBeTruthy();
    expect(screen.getByText("storage.settings.capabilityScope")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "storage.settings.save" })).toBeNull();
    expect(state.service.activateProvider).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue("existing-bucket"), { target: { value: "changed-bucket" } });
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalled());
    expect(vi.mocked(state.service.activateProvider).mock.calls[0]?.[0]).toMatchObject({
      providerId: "aws-s3",
      connection: { region: "eu-west-1", bucket: "changed-bucket" },
      credentials: { mode: "retain" }
    });
  });

  it("coalesces edits during activation and never overlaps provider activations", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "initial-bucket" } });
    state.resource = { status: "ready", summary: summary() };
    let resolveFirst!: (value: { ok: true; providerId: "aws-s3"; latencyMs: number }) => void;
    vi.mocked(state.service.activateProvider)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ ok: true, providerId: "aws-s3", latencyMs: 1 });
    render(<StorageProfileEditor />);

    await waitFor(() => expect(screen.getByDisplayValue("initial-bucket")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("initial-bucket"), { target: { value: "first-bucket" } });
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(1), { timeout: 2000 });

    fireEvent.change(screen.getByDisplayValue("first-bucket"), { target: { value: "middle-bucket" } });
    fireEvent.change(screen.getByDisplayValue("middle-bucket"), { target: { value: "latest-bucket" } });
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    expect(state.service.activateProvider).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, providerId: "aws-s3", latencyMs: 1 });
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(2));
    expect(vi.mocked(state.service.activateProvider).mock.calls[1]?.[0]).toMatchObject({ connection: { bucket: "latest-bucket" } });
  });

  it("does not let unrelated rerenders restart the auto-save debounce", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "initial-bucket" } });
    state.resource = { status: "ready", summary: summary() };
    const view = render(<StorageProfileEditor />);

    await waitFor(() => expect(screen.getByDisplayValue("initial-bucket")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("initial-bucket"), { target: { value: "changed-bucket" } });
    const rerender = window.setInterval(() => view.rerender(<StorageProfileEditor />), 50);
    try {
      await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(1), { timeout: 2000 });
    } finally {
      window.clearInterval(rerender);
    }
  });

  it("auto-saves a first-time configuration without waiting for a connection read", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "unused" } });
    vi.mocked(state.service.getProviderConnection).mockImplementation(() => new Promise(() => undefined));
    state.resource = { status: "locked", summary: null };
    const view = render(<StorageProfileEditor />);

    fireEvent.change(screen.getByLabelText("storage.settings.bucket"), { target: { value: "first-bucket" } });
    fireEvent.change(screen.getByLabelText("storage.settings.profilePassword"), { target: { value: "profile-pass" } });
    fireEvent.change(screen.getByLabelText("storage.settings.accessKeyId"), { target: { value: "access-key" } });
    fireEvent.change(screen.getByLabelText("storage.settings.secretAccessKey"), { target: { value: "secret-key" } });
    state.resource = { status: "unconfigured", summary: null };
    view.rerender(<StorageProfileEditor />);
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("requires every mandatory field before enabling connection test or activation", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "unused" } });
    state.resource = { status: "unconfigured", summary: null };
    render(<StorageProfileEditor />);

    const testButton = screen.getByRole("button", { name: "storage.settings.test" }) as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("storage.settings.bucket"), { target: { value: "first-bucket" } });
    fireEvent.change(screen.getByLabelText("storage.settings.profilePassword"), { target: { value: "profile-pass" } });
    fireEvent.change(screen.getByLabelText("storage.settings.accessKeyId"), { target: { value: "access-key" } });
    expect(testButton.disabled).toBe(true);
    expect(state.service.activateProvider).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("storage.settings.secretAccessKey"), { target: { value: "secret-key" } });
    await waitFor(() => expect(testButton.disabled).toBe(false));
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("advances beyond waiting after R2 activation under React Strict Mode", async () => {
    state.service = makeService({ providerId: "cloudflare-r2", connection: { accountId: "ab".repeat(16), endpointVariant: "default", bucket: "unused" } });
    state.resource = { status: "unconfigured", summary: null };
    render(<StrictMode><StorageProfileEditor /></StrictMode>);

    fireEvent.change(screen.getByLabelText("storage.settings.provider"), { target: { value: "cloudflare-r2" } });
    fireEvent.change(screen.getByLabelText("storage.settings.accountId"), { target: { value: "ab".repeat(16) } });
    fireEvent.change(screen.getByLabelText("storage.settings.bucket"), { target: { value: "r2-bucket" } });
    fireEvent.change(screen.getByLabelText("storage.settings.profilePassword"), { target: { value: "profile-pass" } });
    fireEvent.change(screen.getByLabelText("storage.settings.accessKeyId"), { target: { value: "r2-access-key" } });
    fireEvent.change(screen.getByLabelText("storage.settings.secretAccessKey"), { target: { value: "r2-secret-key" } });

    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText("storage.settings.autoSaveSaved")).toBeTruthy());
  });

  it("renders the Cloudflare dashboard CORS shape with signed-request headers", async () => {
    const connection: StorageProviderConnectionView = {
      providerId: "cloudflare-r2",
      connection: { accountId: "ab".repeat(16), endpointVariant: "default", bucket: "r2-bucket" }
    };
    state.service = makeService(connection);
    state.resource = { status: "ready", summary: { ...summary(), providerId: "cloudflare-r2" } };
    render(<StorageProfileEditor />);

    await waitFor(() => expect(screen.getByDisplayValue("r2-bucket")).toBeTruthy());
    const template = screen.getByTestId("storage-cors-template").textContent ?? "";
    expect(template.trimStart().startsWith("[")).toBe(true);
    expect(template).not.toContain("CORSRules");
    expect(template).toContain("Authorization");
    expect(template).toContain("amz-sdk-*");
    expect(template).toContain("x-amz-*");
    expect(template).toContain(window.location.origin);
  });

  it("cancels an in-flight probe", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "ready", summary: summary() };
    let resolveProbe!: (value: { ok: true; providerId: "aws-s3"; latencyMs: number }) => void;
    vi.mocked(state.service.probeProvider).mockImplementation(() => new Promise((resolve) => { resolveProbe = resolve; }));
    render(<StorageProfileEditor />);
    await waitFor(() => expect((screen.getByRole("button", { name: "storage.settings.test" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.test" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "storage.settings.cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.cancel" }));
    expect(state.service.cancelProbe).toHaveBeenCalledTimes(1);
    resolveProbe({ ok: true, providerId: "aws-s3", latencyMs: 1 });
  });

  it("turns a provider network diagnostic into actionable browser CORS guidance", async () => {
    state.service = makeService({ providerId: "cloudflare-r2", connection: { accountId: "ab".repeat(16), endpointVariant: "default", bucket: "bucket" } });
    state.resource = { status: "ready", summary: { ...summary(), providerId: "cloudflare-r2" } };
    vi.mocked(state.service.probeProvider).mockResolvedValue({ ok: false, providerId: "cloudflare-r2", latencyMs: 1, diagnostic: "network" });
    render(<StorageProfileEditor />);

    await waitFor(() => expect(screen.getByDisplayValue("bucket")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.test" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("storage.settings.networkOrCors"));
  });

  it("shows independent capability status and cancels capability detection", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = {
      status: "ready", summary: summary(), capabilities: {
        generation: 4,
        put: { mode: "native", source: "automatic", updatedAt: 1000 },
        complete: { mode: "best-effort", source: "manual", updatedAt: 2000 }
      }
    };
    vi.mocked(state.service.probeConditionalCapabilities).mockImplementation(() => new Promise(() => undefined));
    render(<StorageProfileEditor />);
    expect(screen.getByTestId("storage-capability-put").textContent).toContain("storage.settings.capabilityNative");
    expect(screen.getByTestId("storage-capability-complete").textContent).toContain("storage.settings.capabilityBestEffort");
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.capability" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "storage.settings.cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.cancel" }));
    expect(state.service.cancelProbe).toHaveBeenCalled();
  });

  it("disables capability detection when the provider is not ready", () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "locked", summary: summary(), capabilities: null };
    render(<StorageProfileEditor />);
    expect((screen.getByRole("button", { name: "storage.settings.capability" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the inconclusive message while retaining the prior capability view", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "ready", summary: summary(), capabilities: { generation: 4, put: { mode: "native", source: "manual", updatedAt: 1000 }, complete: { mode: "unknown" } } };
    render(<StorageProfileEditor />);
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.capability" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("storage.settings.capabilityInconclusive"));
  });

  it("keeps the Storage settings entry available while Vault is locked", () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "locked", summary: summary() };
    render(<StorageProfileEditor />);
    expect(screen.getByRole("button", { name: "storage.settings.test" })).toBeTruthy();
  });

  it("offers an explicit reset when Storage is degraded", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "degraded", summary: null };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageProfileEditor />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(vi.mocked(state.service.resetStorage)).toHaveBeenCalledTimes(1));
    expect(state.service.clearProviderConfig).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("uses guarded Clear for a healthy provider", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "ready", summary: summary() };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageProfileEditor />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(vi.mocked(state.service.clearProviderConfig)).toHaveBeenCalledTimes(1));
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not use destructive reset during a live reconfiguration", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "reconfiguring", summary: summary() };
    vi.mocked(state.service.clearProviderConfig).mockRejectedValue(new Error("Storage is temporarily unavailable"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageProfileEditor />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(state.service.clearProviderConfig).toHaveBeenCalledTimes(1));
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("keeps the configured view when guarded Clear fails", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket" } });
    state.resource = { status: "ready", summary: summary() };
    vi.mocked(state.service.clearProviderConfig).mockRejectedValue(new Error("clear failed"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageProfileEditor />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("clear failed"));
    expect(screen.getByText("storage.settings.credentialsConfigured")).toBeTruthy();
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
