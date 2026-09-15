// @vitest-environment jsdom

import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPricePage } from "./BsvPricePage.js";

const PUBLISHER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const activeTestService: { service: BsvPriceService } = {
  service: undefined as unknown as BsvPriceService
};

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useI18n: () => ({
      t: (key: string) => ({
        "bsv-price.page.title": "BSV 价格",
        "bsv-price.page.connection.label": "连接状态",
        "bsv-price.page.connection.receiving": "正在接收",
        "bsv-price.page.empty.receiving": "当前快照没有报价",
        "bsv-price.page.channel.label": "订阅频道",
        "bsv-price.page.quotes.label": "报价",
        "bsv-price.page.empty": "等待报价",
        "bsv-price.page.table.market": "市场",
        "bsv-price.page.table.pair": "交易对",
        "bsv-price.page.table.price": "价格"
      }[key] ?? key)
    })
  };
});

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: <T,>(): T | undefined => activeTestService.service as unknown as T,
  useResource: () => {
    const service = activeTestService.service;
    const snapshot = useSyncExternalStore(service.subscribe, service.snapshot, service.snapshot);
    return { data: snapshot };
  }
}));

function makeSnapshot(overrides: Partial<BsvPriceServiceSnapshot> = {}): BsvPriceServiceSnapshot {
  return {
    channelId: `bsvprice.${PUBLISHER}`,
    coreState: "ready",
    status: "receiving",
    snapshot: {
      protocol: "bsv8.bsv-price.v1",
      snapshotAtMs: 1_000,
      markets: {}
    },
    lastError: null,
    subscriptionErrorCode: null,
    subscriptionErrorMessage: null,
    configured: true,
    ...overrides
  };
}

function makeService(initial: BsvPriceServiceSnapshot): {
  service: BsvPriceService;
  setSnapshot: (next: BsvPriceServiceSnapshot) => void;
} {
  let current = initial;
  const listeners = new Set<() => void>();
  const service: BsvPriceService = {
    snapshot: () => current,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    currentMarkets: () => current.snapshot?.markets ?? {},
    getPublisherPublicKeyHex: () => PUBLISHER,
    configured: () => true,
    savePublisherPublicKeyHex: async () => undefined,
    dispose: () => undefined
  };
  return {
    service,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener();
    }
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPricePage", () => {
  it("renders every market and trading pair in a complete snapshot", () => {
    const fake = makeService(makeSnapshot({
      snapshot: {
        protocol: "bsv8.bsv-price.v1",
        snapshotAtMs: 1_000,
        markets: {
          gate: { bsvusdt: "45.1200", bsvcny: "321.85" },
          okx: { bsvusdt: "45.0900" }
        }
      }
    }));
    activeTestService.service = fake.service;

    render(<BsvPricePage />);

    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByText("gate")).toHaveLength(2);
    expect(screen.getByText("okx")).toBeTruthy();
    expect(screen.getByText("bsvcny")).toBeTruthy();
    expect(screen.getByText("321.85")).toBeTruthy();
    expect(screen.getAllByText("bsvusdt")).toHaveLength(2);
  });

  it("shows the waiting state after an empty full snapshot clears quotes", async () => {
    const fake = makeService(makeSnapshot({
      snapshot: {
        protocol: "bsv8.bsv-price.v1",
        snapshotAtMs: 1_000,
        markets: { gate: { bsvusdt: "45.1200" } }
      }
    }));
    activeTestService.service = fake.service;

    render(<BsvPricePage />);
    expect(screen.getByRole("table")).toBeTruthy();

    fake.setSnapshot(makeSnapshot({
      status: "receiving",
      snapshot: {
        protocol: "bsv8.bsv-price.v1",
        snapshotAtMs: 1_001,
        markets: {}
      }
    }));

    await waitFor(() => {
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText("当前快照没有报价")).toBeTruthy();
    });
    expect(screen.queryByText("45.1200")).toBeNull();
  });
});
