// @vitest-environment jsdom

import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PriceValue } from "@keymaster/contracts";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPriceHomeWidget } from "./BsvPriceHomeWidget.js";

const PUBLISHER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const activeTestService: { service: BsvPriceService } = {
  service: undefined as unknown as BsvPriceService
};

vi.mock("@keymaster/runtime", () => ({
  usePluginHost: () => ({
    resourceRegistry: { get: () => ({}) },
    resourceStore: {}
  }),
  useLocale: () => "en",
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
    servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER }],
    active: { publisherPublicKeyHex: PUBLISHER, market: "gate", pair: "bsvusdt" },
    price: { amount: "45.12", unit: "USDT", updatedAtMs: 1_000 },
    ...overrides
  };
}

function makeService(initial: BsvPriceServiceSnapshot): BsvPriceService {
  const listeners = new Set<(price: PriceValue) => void>();
  return {
    snapshot: () => initial,
    get: () => initial.price,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    getConfig: () => ({ servers: initial.servers, active: initial.active, savedAtMs: 0 }),
    addServer: async () => { throw new Error("unused"); },
    removeServer: async () => { throw new Error("unused"); },
    setActiveOption: async () => { throw new Error("unused"); },
    restoreOriginalSettings: async () => { throw new Error("unused"); },
    dispose: () => undefined
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPriceHomeWidget", () => {
  it("shows the display price and stable subscription error details", () => {
    activeTestService.service = makeService(makeSnapshot());
    render(<BsvPriceHomeWidget />);

    expect(screen.getByText("45.12 USDT")).toBeTruthy();
    const error = document.querySelector("[data-bsv-price-home-subscription-error]");
    expect(error).not.toBeNull();
    if (!error) throw new Error("subscription error element was not rendered");
    expect(error.textContent).toContain("balance");
    expect(error.textContent).toContain("No fee balance");
  });

  it("shows the missing-service fallback when the capability is gone", () => {
    activeTestService.service = undefined as unknown as BsvPriceService;
    render(<BsvPriceHomeWidget />);
    expect(document.querySelector("[data-bsv-price-home-widget='missing-service']")).not.toBeNull();
  });
});
