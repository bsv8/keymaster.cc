// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StorageProviderConnectionView, StorageProviderSummary, StorageService } from "@keymaster/contracts";
import { StorageSettings } from "./StorageSettings.js";
import type { StorageResourceSnapshot } from "./storageService.js";

const state = vi.hoisted(() => ({
  service: undefined as unknown as StorageService,
  resource: undefined as unknown as StorageResourceSnapshot,
  vault: "unlocked" as "unlocked" | "locked"
}));

vi.mock("@keymaster/runtime", () => ({
  useCapability: <T,>(_key: string): T => state.service as unknown as T,
  useI18n: () => ({ t: (key: string) => key }),
  usePluginHost: () => ({ resourceStore: {} }),
  useRuntimeStatus: () => ({ vault: state.vault }),
  useResourceSelector: () => state.resource
}));

function summary(): StorageProviderSummary {
  return { providerId: "aws-s3", bucketHint: "ex••••me", prefix: "tenant/", accessKeyHint: "••••last", secretConfigured: true, generation: 4, updatedAt: 1000 };
}

function makeService(connection: StorageProviderConnectionView): StorageService {
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
  } as unknown as StorageService;
}

afterEach(() => cleanup());

describe("StorageSettings", () => {
  it("restores all non-secret connection fields and retains credentials on save", async () => {
    const connection: StorageProviderConnectionView = {
      providerId: "aws-s3",
      connection: { region: "eu-west-1", bucket: "existing-bucket", prefix: "tenant/" }
    };
    state.service = makeService(connection);
    state.resource = { status: "ready", summary: summary() };
    render(<StorageSettings />);

    await waitFor(() => expect(screen.getByDisplayValue("existing-bucket")).toBeTruthy());
    expect(screen.getByDisplayValue("eu-west-1")).toBeTruthy();
    expect(screen.getByDisplayValue("tenant/")).toBeTruthy();
    expect(screen.getByText("storage.settings.cors")).toBeTruthy();
    const corsTemplate = screen.getByTestId("storage-cors-template");
    expect(corsTemplate.textContent).toContain(window.location.origin);
    expect(corsTemplate.textContent).toContain("If-None-Match");
    expect(corsTemplate.textContent).toContain("x-amz-*");
    expect(corsTemplate.textContent).toContain("Content-Length");
    expect(screen.getByText("storage.settings.probeScope")).toBeTruthy();
    expect(screen.getByText("storage.settings.capabilityScope")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.save" }));
    await waitFor(() => expect(state.service.activateProvider).toHaveBeenCalled());
    expect(vi.mocked(state.service.activateProvider).mock.calls[0]?.[0]).toMatchObject({
      providerId: "aws-s3",
      connection: connection.connection,
      credentials: { mode: "retain" }
    });
  });

  it("cancels an in-flight probe", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "ready", summary: summary() };
    let resolveProbe!: (value: { ok: true; providerId: "aws-s3"; latencyMs: number }) => void;
    vi.mocked(state.service.probeProvider).mockImplementation(() => new Promise((resolve) => { resolveProbe = resolve; }));
    render(<StorageSettings />);
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.test" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "storage.settings.cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.cancel" }));
    expect(state.service.cancelProbe).toHaveBeenCalledTimes(1);
    resolveProbe({ ok: true, providerId: "aws-s3", latencyMs: 1 });
  });

  it("shows independent capability status and cancels capability detection", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = {
      status: "ready", summary: summary(), capabilities: {
        generation: 4,
        put: { mode: "native", source: "automatic", updatedAt: 1000 },
        complete: { mode: "best-effort", source: "manual", updatedAt: 2000 }
      }
    };
    vi.mocked(state.service.probeConditionalCapabilities).mockImplementation(() => new Promise(() => undefined));
    render(<StorageSettings />);
    expect(screen.getByTestId("storage-capability-put").textContent).toContain("storage.settings.capabilityNative");
    expect(screen.getByTestId("storage-capability-complete").textContent).toContain("storage.settings.capabilityBestEffort");
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.capability" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "storage.settings.cancel" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.cancel" }));
    expect(state.service.cancelProbe).toHaveBeenCalled();
  });

  it("disables capability detection when the provider is not ready", () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "locked", summary: summary(), capabilities: null };
    render(<StorageSettings />);
    expect((screen.getByRole("button", { name: "storage.settings.capability" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the inconclusive message while retaining the prior capability view", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "ready", summary: summary(), capabilities: { generation: 4, put: { mode: "native", source: "manual", updatedAt: 1000 }, complete: { mode: "unknown" } } };
    render(<StorageSettings />);
    fireEvent.click(screen.getByRole("button", { name: "storage.settings.capability" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("storage.settings.capabilityInconclusive"));
  });

  it("does not expose editable controls while Vault is locked", () => {
    state.vault = "locked";
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "locked", summary: summary() };
    render(<StorageSettings />);
    expect(screen.getByText("storage.settings.locked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "storage.settings.save" })).toBeNull();
    state.vault = "unlocked";
  });

  it("offers an explicit reset when Storage is degraded", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "degraded", summary: null };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageSettings />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(vi.mocked(state.service.resetStorage)).toHaveBeenCalledTimes(1));
    expect(state.service.clearProviderConfig).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("uses guarded Clear for a healthy provider", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "ready", summary: summary() };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageSettings />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(vi.mocked(state.service.clearProviderConfig)).toHaveBeenCalledTimes(1));
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not use destructive reset during a live reconfiguration", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "reconfiguring", summary: summary() };
    vi.mocked(state.service.clearProviderConfig).mockRejectedValue(new Error("Storage is temporarily unavailable"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageSettings />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(state.service.clearProviderConfig).toHaveBeenCalledTimes(1));
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("keeps the configured view when guarded Clear fails", async () => {
    state.service = makeService({ providerId: "aws-s3", connection: { region: "us-east-1", bucket: "bucket", prefix: "" } });
    state.resource = { status: "ready", summary: summary() };
    vi.mocked(state.service.clearProviderConfig).mockRejectedValue(new Error("clear failed"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StorageSettings />);

    fireEvent.click(screen.getByRole("button", { name: "storage.settings.clear" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("clear failed"));
    expect(screen.getByText("storage.settings.credentialsConfigured")).toBeTruthy();
    expect(state.service.resetStorage).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
