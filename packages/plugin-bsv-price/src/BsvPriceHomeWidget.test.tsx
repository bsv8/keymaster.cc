// @vitest-environment jsdom

import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPriceHomeWidget } from "./BsvPriceHomeWidget.js";

const activeTestService: { service: BsvPriceService } = {
  service: undefined as unknown as BsvPriceService
};

vi.mock("@keymaster/runtime", () => ({
  usePluginHost: () => ({
    resourceRegistry: { get: () => ({}) },
    resourceStore: {}
  }),
  useI18n: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    language: () => "en"
  })
}));

vi.mock("webloom-framework/react", () => ({
  countRender: vi.fn(),
  useOptionalCapability: <T,>(): T => activeTestService.service as unknown as T,
  useResource: () => {
    const service = activeTestService.service;
    const snapshot = useSyncExternalStore(service.subscribe, service.snapshot, service.snapshot);
    return { data: snapshot };
  }
}));

function makeSnapshot(overrides: Partial<BsvPriceServiceSnapshot> = {}): BsvPriceServiceSnapshot {
  return {
    channelId: "bsvprice.publisher",
    coreState: "ready",
    status: "sat_balance_required",
    snapshot: {
      protocol: "bsv8.bsv-price.v1",
      snapshotAtMs: 1_000,
      markets: { gate: { bsvusdt: "45.1200" } }
    },
    lastError: null,
    subscriptionErrorCode: "balance",
    subscriptionErrorMessage: "No fee balance",
    configured: true,
    ...overrides
  };
}

function makeService(initial: BsvPriceServiceSnapshot): BsvPriceService {
  const listeners = new Set<() => void>();
  return {
    snapshot: () => initial,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    currentMarkets: () => initial.snapshot?.markets ?? {},
    getPublisherPublicKeyHex: () => "publisher",
    configured: () => true,
    savePublisherPublicKeyHex: async () => undefined,
    dispose: () => undefined
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPriceHomeWidget", () => {
  it("shows stable subscription error details even when quotes are present", () => {
    activeTestService.service = makeService(makeSnapshot());
    render(<BsvPriceHomeWidget />);

    const error = document.querySelector("[data-bsv-price-home-subscription-error]");
    expect(error).not.toBeNull();
    if (!error) throw new Error("subscription error element was not rendered");
    expect(error.textContent).toContain("balance");
    expect(error.textContent).toContain("No fee balance");
    expect(screen.getByText("45.1200")).toBeTruthy();
  });
});
