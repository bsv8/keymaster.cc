// packages/plugin-bsv-price/src/BsvPriceSettingsPage.test.tsx
// 设置页交互测试：保存、清空、校验错误提示。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";

interface ActiveTestService {
  service: BsvPriceService;
}

const activeTestService: ActiveTestService = {
  service: undefined as unknown as BsvPriceService
};

vi.mock("@keymaster/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    useCapability: <T,>(_key: string): T =>
      activeTestService.service as unknown as T,
    useI18n: () => ({
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
      text: (input: unknown) =>
        typeof input === "string"
          ? input
          : (input as { fallback?: string })?.fallback ?? "",
      language: () => "en" as const,
      mode: () => "manual" as const,
      setLanguage: async () => undefined,
      setAuto: async () => undefined
    })
  };
});

function makeSnapshot(partial: Partial<BsvPriceServiceSnapshot>): BsvPriceServiceSnapshot {
  return {
    channelId: "(not configured)",
    coreState: "bound",
    status: "not_configured",
    snapshot: null,
    lastError: null,
    configured: false,
    ...partial
  };
}

function makeFakeService(): BsvPriceService {
  let currentHex = "";
  let currentSnap = makeSnapshot({ status: "not_configured" });
  const subs = new Set<() => void>();
  return {
    snapshot: () => currentSnap,
    subscribe: (handler) => {
      subs.add(handler);
      return () => {
        subs.delete(handler);
      };
    },
    currentQuotes: () => [],
    getPublisherPublicKeyHex: () => currentHex,
    configured: () => currentHex.length > 0,
    savePublisherPublicKeyHex: (input) => {
      const next = input.trim().toLowerCase();
      if (next.length > 0 && next.length !== 66) {
        throw new Error("invalid_length");
      }
      if (next.length > 0 && !next.startsWith("02") && !next.startsWith("03")) {
        throw new Error("invalid_prefix");
      }
      currentHex = next;
      currentSnap = makeSnapshot({
        channelId: next.length > 0 ? `${next}.pricecast.bsvusdt` : "(not configured)",
        status: next.length > 0 ? "ready" : "not_configured",
        configured: next.length > 0
      });
      for (const handler of subs) handler();
    },
    dispose: () => undefined
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPriceSettingsPage", () => {
  it("renders and saves the normalized publisher key", async () => {
    activeTestService.service = makeFakeService();
    render(<BsvPriceSettingsPage />);

    const input = screen.getByDisplayValue("") as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        value: " 02AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(screen.getByText("已保存")).toBeTruthy();
    });
    expect(screen.getByDisplayValue(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )).toBeTruthy();
    expect(screen.getByText(
      "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pricecast.bsvusdt"
    )).toBeTruthy();
  });

  it("saving empty string clears the channel preview", async () => {
    activeTestService.service = makeFakeService();
    render(<BsvPriceSettingsPage />);

    const input = screen.getByDisplayValue("") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(screen.getByText("已清空配置")).toBeTruthy();
    });
    expect(screen.getByText("(not configured)")).toBeTruthy();
  });

  it("invalid input shows validation error", async () => {
    activeTestService.service = makeFakeService();
    render(<BsvPriceSettingsPage />);

    const input = screen.getByDisplayValue("") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => {
      expect(screen.getByText("公钥必须是 66 位压缩 hex")).toBeTruthy();
    });
  });
});
