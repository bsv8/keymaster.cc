// @vitest-environment jsdom

import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PriceValue } from "@keymaster/contracts";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPricePage } from "./BsvPricePage.js";

const PUBLISHER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const activeTestService: { service: BsvPriceService } = {
  service: undefined as unknown as BsvPriceService
};

const KEY_MAP: Record<string, string> = {
  "bsv-price.page.title": "BSV 价格",
  "bsv-price.page.connection.label": "连接状态",
  "bsv-price.page.connection.receiving": "正在接收",
  "bsv-price.page.publisher.label": "发布服务器",
  "bsv-price.page.channel.label": "订阅频道",
  "bsv-price.page.quote.label": "激活选项",
  "bsv-price.page.price.label": "当前显示价格",
  "bsv-price.page.snapshotAt.label": "快照时间",
  "bsv-price.page.quotes.label": "收到的行情",
  "bsv-price.page.empty.receiving": "当前快照没有激活选项的报价",
  "bsv-price.page.table.market": "市场",
  "bsv-price.page.table.pair": "交易对",
  "bsv-price.page.table.price": "价格"
};

vi.mock("@keymaster/runtime", async () => {
  const actual = await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useLocale: () => "zh-CN",
    useI18n: () => ({
      t: (key: string, options?: { defaultValue?: string }) => KEY_MAP[key] ?? options?.defaultValue ?? key
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
    servers: [{ name: "bsv8", publisherPublicKeyHex: PUBLISHER }],
    active: { publisherPublicKeyHex: PUBLISHER, market: "gate", pair: "bsvusdt" },
    price: { amount: "45.12", unit: "USDT", updatedAtMs: 1_000 },
    ...overrides
  };
}

function makeService(initial: BsvPriceServiceSnapshot): {
  service: BsvPriceService;
  setSnapshot: (next: BsvPriceServiceSnapshot) => void;
} {
  let current = initial;
  const listeners = new Set<(price: PriceValue) => void>();
  const service: BsvPriceService = {
    snapshot: () => current,
    get: () => current.price,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    getConfig: () => ({ servers: current.servers, active: current.active, savedAtMs: 0 }),
    addServer: async () => { throw new Error("unused"); },
    removeServer: async () => { throw new Error("unused"); },
    setActiveOption: async () => { throw new Error("unused"); },
    restoreOriginalSettings: async () => { throw new Error("unused"); },
    dispose: () => undefined
  };
  return {
    service,
    setSnapshot(next) {
      current = next;
      for (const listener of listeners) listener(next.price);
    }
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPricePage", () => {
  it("renders subscription info, every market pair, and highlights the active quote", () => {
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
    expect(screen.getByText("45.12 USDT")).toBeTruthy();
    expect(screen.getByText(`bsv8 · ${PUBLISHER}`)).toBeTruthy();
    expect(screen.getByText(`bsv8 · gate · bsvusdt`)).toBeTruthy();
    expect(screen.getAllByText("gate")).toHaveLength(2);
    expect(screen.getByText("okx")).toBeTruthy();
    expect(screen.getByText("bsvcny")).toBeTruthy();
    expect(screen.getByText("321.85")).toBeTruthy();
    expect(screen.getAllByText("bsvusdt")).toHaveLength(2);
    const activeRows = document.querySelectorAll("[data-bsv-price-quote-active='true']");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.textContent).toContain("45.1200");
  });

  it("shows the empty state after an empty full snapshot clears quotes", async () => {
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
      },
      price: { amount: "0.00", unit: "USDT", updatedAtMs: 0 }
    }));

    await waitFor(() => {
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByText("当前快照没有激活选项的报价")).toBeTruthy();
    });
    expect(screen.queryByText("45.1200")).toBeNull();
  });
});
