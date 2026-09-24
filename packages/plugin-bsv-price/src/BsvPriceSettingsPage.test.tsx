// packages/plugin-bsv-price/src/BsvPriceSettingsPage.test.tsx
// 设置页交互测试：服务器管理、激活选项、恢复原始设置与校验错误。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";
import type { PriceValue } from "@keymaster/contracts";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { createDefaultBsvPriceConfig, deriveUnitFromPair } from "./bsvPriceSettings.js";
import type { BsvPriceGlobalConfig } from "./bsvPriceSettings.js";

interface ActiveTestService {
  service: BsvPriceService;
}

const DEFAULT_KEY = "03c95123471587fbb4690fe85e748b39bd09d97a7c92ebe539530d454b2b8ef53a";
const PUBLISHER_A = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBLISHER_B = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

const activeTestService: ActiveTestService = {
  service: undefined as unknown as BsvPriceService
};

/** 只翻译本测试断言的校验错误键；其余走 defaultValue。 */
const ERROR_TEXT: Record<string, string> = {
  "bsv-price.settings.error.invalid_length": "输入过长",
  "bsv-price.settings.error.invalid_empty": "该字段必填",
  "bsv-price.settings.error.server_exists": "该公钥的服务器已存在"
};

vi.mock("@keymaster/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@keymaster/runtime")>("@keymaster/runtime");
  return {
    ...actual,
    usePluginHost: () => ({ resourceStore: {} }),
    useLocale: () => "zh-CN",
    useI18n: () => ({
      t: (key: string, opts?: { defaultValue?: string }) =>
        ERROR_TEXT[key] ?? opts?.defaultValue ?? key,
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

vi.mock("webloom-framework/react", () => ({
  useOptionalCapability: <T,>(): T | undefined =>
    activeTestService.service as unknown as T,
  useResource: () => {
    const service = activeTestService.service;
    const snapshot = useSyncExternalStore(service.subscribe, service.snapshot, service.snapshot);
    return { data: snapshot };
  }
}));

function makeSnapshot(config: BsvPriceGlobalConfig, partial: Partial<BsvPriceServiceSnapshot> = {}): BsvPriceServiceSnapshot {
  const server = config.servers.find(
    (item) => item.publisherPublicKeyHex === config.active.publisherPublicKeyHex
  );
  return {
    channelId: server ? `bsvprice.${server.publisherPublicKeyHex}` : "(not configured)",
    coreState: "ready",
    status: "waiting_snapshot",
    snapshot: null,
    lastError: null,
    subscriptionErrorCode: null,
    subscriptionErrorMessage: null,
    configured: server !== undefined,
    servers: config.servers.map((item) => ({ ...item })),
    active: { ...config.active },
    price: { amount: "0.00", unit: deriveUnitFromPair(config.active.pair), updatedAtMs: 0 },
    ...partial
  };
}

function makeFakeService(initial: BsvPriceGlobalConfig): BsvPriceService {
  let config: BsvPriceGlobalConfig = {
    servers: initial.servers.map((server) => ({ ...server })),
    active: { ...initial.active },
    savedAtMs: initial.savedAtMs
  };
  let snap = makeSnapshot(config);
  const subs = new Set<(price: PriceValue) => void>();
  const emit = () => {
    snap = makeSnapshot(config);
    for (const handler of subs) handler(snap.price);
  };
  return {
    snapshot: () => snap,
    get: () => snap.price,
    subscribe: (handler) => {
      subs.add(handler);
      return () => {
        subs.delete(handler);
      };
    },
    getConfig: () => config,
    async addServer(input) {
      const name = input.name.trim();
      if (name.length === 0) throw new Error("invalid_empty");
      const key = input.publisherPublicKeyHex.trim().toLowerCase();
      if (key.length !== 66) throw new Error("invalid_length");
      if (config.servers.some((server) => server.publisherPublicKeyHex === key)) {
        throw new Error("server_exists");
      }
      config = {
        servers: [...config.servers, { name, publisherPublicKeyHex: key }],
        active: { ...config.active },
        savedAtMs: config.savedAtMs + 1
      };
      emit();
      return config;
    },
    async removeServer(key) {
      if (key === "03c95123471587fbb4690fe85e748b39bd09d97a7c92ebe539530d454b2b8ef53a") {
        throw new Error("default_server_required");
      }
      config = {
        servers: config.servers.filter((server) => server.publisherPublicKeyHex !== key),
        active: { ...config.active },
        savedAtMs: config.savedAtMs + 1
      };
      emit();
      return config;
    },
    async setActiveOption(input) {
      if (!config.servers.some((server) => server.publisherPublicKeyHex === input.publisherPublicKeyHex)) {
        throw new Error("server_not_found");
      }
      config = { servers: config.servers, active: { ...input }, savedAtMs: config.savedAtMs + 1 };
      emit();
      return config;
    },
    async restoreOriginalSettings() {
      config = createDefaultBsvPriceConfig(PUBLISHER_A);
      emit();
      return config;
    },
    dispose: () => undefined
  };
}

afterEach(() => {
  cleanup();
});

describe("BsvPriceSettingsPage", () => {
  it("lists servers and applies the active option", async () => {
    activeTestService.service = makeFakeService({
      servers: [{ name: "bsv8", publisherPublicKeyHex: DEFAULT_KEY }],
      active: { publisherPublicKeyHex: DEFAULT_KEY, market: "gate", pair: "bsvusdt" },
      savedAtMs: 0
    });
    render(<BsvPriceSettingsPage />);

    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getAllByText("bsv8").length).toBeGreaterThan(0);
    expect(screen.getByText("USDT")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "应用选项" }));
    await waitFor(() => {
      expect(screen.getByText("已保存激活选项")).toBeTruthy();
    });
  });

  it("adds a server with a name and public key", async () => {
    activeTestService.service = makeFakeService({
      servers: [{ name: "bsv8", publisherPublicKeyHex: DEFAULT_KEY }],
      active: { publisherPublicKeyHex: DEFAULT_KEY, market: "gate", pair: "bsvusdt" },
      savedAtMs: 0
    });
    render(<BsvPriceSettingsPage />);

    fireEvent.change(document.querySelector("[data-bsv-price-server-name]") as HTMLInputElement, {
      target: { value: "alt" }
    });
    fireEvent.change(document.querySelector("[data-bsv-price-server-key]") as HTMLInputElement, {
      target: { value: PUBLISHER_B.toUpperCase() }
    });
    fireEvent.click(document.querySelector("[data-bsv-price-server-add]") as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("已添加服务器")).toBeTruthy();
    });
    expect(screen.getAllByText("alt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bsv8").length).toBeGreaterThan(0);
  });

  it("maps validation failures to readable messages", async () => {
    activeTestService.service = makeFakeService({
      servers: [{ name: "bsv8", publisherPublicKeyHex: DEFAULT_KEY }],
      active: { publisherPublicKeyHex: DEFAULT_KEY, market: "gate", pair: "bsvusdt" },
      savedAtMs: 0
    });
    render(<BsvPriceSettingsPage />);

    fireEvent.change(document.querySelector("[data-bsv-price-server-name]") as HTMLInputElement, {
      target: { value: "alt" }
    });
    fireEvent.change(document.querySelector("[data-bsv-price-server-key]") as HTMLInputElement, {
      target: { value: "bad" }
    });
    fireEvent.click(document.querySelector("[data-bsv-price-server-add]") as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("输入过长")).toBeTruthy();
    });
  });

  it("restores the original settings", async () => {
    activeTestService.service = makeFakeService({
      servers: [
        { name: "bsv8", publisherPublicKeyHex: PUBLISHER_A },
        { name: "alt", publisherPublicKeyHex: PUBLISHER_B }
      ],
      active: { publisherPublicKeyHex: PUBLISHER_B, market: "okx", pair: "bsvusdt" },
      savedAtMs: 0
    });
    render(<BsvPriceSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "恢复原始设置" }));

    await waitFor(() => {
      expect(screen.getByText("已恢复原始设置")).toBeTruthy();
    });
    expect(screen.queryByText("alt")).toBeNull();
  });

  it("hides the delete action for the default server only", async () => {
    activeTestService.service = makeFakeService({
      servers: [
        { name: "bsv8", publisherPublicKeyHex: DEFAULT_KEY },
        { name: "alt", publisherPublicKeyHex: PUBLISHER_B }
      ],
      active: { publisherPublicKeyHex: DEFAULT_KEY, market: "gate", pair: "bsvusdt" },
      savedAtMs: 0
    });
    render(<BsvPriceSettingsPage />);

    const rows = Array.from(document.querySelectorAll("[data-bsv-price-server]"));
    expect(rows).toHaveLength(2);
    const deleteButtons = document.querySelectorAll("[data-bsv-price-server-delete]");
    // 缺省 bsv8 服务器不提供删除操作，用户添加的服务器才有。
    expect(deleteButtons).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("bsv8");
    expect(rows[0]?.querySelector("[data-bsv-price-server-delete]")).toBeNull();
    expect(rows[1]?.textContent).toContain("alt");
    expect(rows[1]?.querySelector("[data-bsv-price-server-delete]")).not.toBeNull();
  });

  it("shows every received field: server keys, runtime state, snapshot and all quotes", async () => {
    const full: BsvPriceServiceSnapshot = makeSnapshot(
      {
        servers: [{ name: "bsv8", publisherPublicKeyHex: DEFAULT_KEY }],
        active: { publisherPublicKeyHex: DEFAULT_KEY, market: "gate", pair: "bsvusdt" },
        savedAtMs: 0
      },
      {
        coreState: "ready",
        status: "receiving",
        configured: true,
        snapshot: {
          protocol: "bsv8.bsv-price.v1",
          snapshotAtMs: 1_000,
          markets: {
            gate: { bsvusdt: "45.1200", bsvcny: "321.85" },
            okx: { bsvusdt: "45.0900" }
          }
        },
        lastError: "invalid_body",
        subscriptionErrorCode: null,
        subscriptionErrorMessage: null,
        price: { amount: "45.12", unit: "USDT", updatedAtMs: 1_000 }
      }
    );
    const subs = new Set<(price: PriceValue) => void>();
    activeTestService.service = {
      snapshot: () => full,
      get: () => full.price,
      subscribe: (handler) => {
        subs.add(handler);
        return () => {
          subs.delete(handler);
        };
      },
      getConfig: () => ({
        servers: full.servers,
        active: full.active,
        savedAtMs: 0
      }),
      addServer: async () => { throw new Error("unused"); },
      removeServer: async () => { throw new Error("unused"); },
      setActiveOption: async () => { throw new Error("unused"); },
      restoreOriginalSettings: async () => { throw new Error("unused"); },
      dispose: () => undefined
    };
    render(<BsvPriceSettingsPage />);

    // 服务器行带公钥 hex。
    expect(document.querySelector("[data-bsv-price-server-pubkey]")?.textContent).toContain(DEFAULT_KEY);
    // 运行状态与配置。
    expect(document.querySelector("[data-bsv-price-settings-core-state]")?.textContent).toBe("ready");
    expect(document.querySelector("[data-bsv-price-settings-configured]")?.textContent).toBe("是");
    expect(document.querySelector("[data-bsv-price-settings-active-key]")?.textContent).toContain(DEFAULT_KEY);
    // 快照协议与解析错误。
    expect(document.querySelector("[data-bsv-price-settings-protocol]")?.textContent).toBe("bsv8.bsv-price.v1");
    expect(document.querySelector("[data-bsv-price-settings-last-error]")?.textContent).toBe("invalid_body");
    // 全部行情逐行展示，激活行高亮。
    const table = document.querySelector("[data-bsv-price-settings-quotes]");
    expect(table?.textContent).toContain("gate");
    expect(table?.textContent).toContain("bsvcny");
    expect(table?.textContent).toContain("45.1200");
    expect(table?.querySelectorAll("[data-bsv-price-settings-quote-active='true']")).toHaveLength(1);
  });
});
