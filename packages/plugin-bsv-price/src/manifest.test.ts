// packages/plugin-bsv-price/src/manifest.test.ts
// `plugin-bsv-price` 配置边界回归测试。
//
// 目标：
//   - 空配置时，插件只进入 `not_configured`，**不**订阅 broadcast.core；
//   - 显式配置时，插件只读取 `ctx.config`，**不**依赖全局隐式注入；
//   - 这些断言锁住 manifest.config → ctx.config 这条显式配置链路。

import { afterEach, describe, expect, it } from "vitest";
import type {
  BroadcastCore,
  BroadcastMessage,
  BroadcastSubscribeInput,
  BroadcastUnsubscribe,
  PluginContext
} from "@keymaster/contracts";
import { BROADCAST_CORE_CAPABILITY } from "@keymaster/contracts";
import {
  BSV_PRICE_CONFIG_KEY,
  buildPriceChannelId
} from "./constants.js";
import {
  BSV_PRICE_SERVICE_CAPABILITY,
  bsvPricePlugin
} from "./manifest.js";
import type { BsvPriceService } from "./bsvPriceService.js";

interface FakeRegistry {
  register: (input: unknown) => void;
}

class FakeBroadcastCore implements BroadcastCore {
  subscribeCalls: BroadcastSubscribeInput[] = [];
  private state: "idle" | "connecting" | "bound" | "closed" = "bound";

  providers(): never {
    throw new Error("not used");
  }
  async connectForOwner(): Promise<never> {
    throw new Error("not used");
  }
  async disconnect(): Promise<void> {}
  markStructurallyOffline(): void {}
  setNextReconnectAtMs(): void {}
  getNextReconnectAtMs(): null {
    return null;
  }
  isReady(): boolean {
    return true;
  }
  async publish(): Promise<BroadcastMessage> {
    throw new Error("not used");
  }
  subscribe(input: BroadcastSubscribeInput): BroadcastUnsubscribe {
    this.subscribeCalls.push(input);
    return () => {
      // no-op
    };
  }
  listSubscribedChannels(): string[] {
    return [];
  }
  inspect() {
    return {
      state: this.state,
      providerId: "fake",
      ownerPublicKeyHex: "02",
      lastError: null,
      subscribedChannels: [],
      nextReconnectAtMs: null
    };
  }
  onStateChange(): BroadcastUnsubscribe {
    return () => {
      // no-op
    };
  }
  currentHandle(): null {
    return null;
  }
  setActiveProviderId(): Promise<void> {
    return Promise.resolve();
  }
  getActiveProviderId(): string | null {
    return "fake";
  }
}

function makeContext(core: BroadcastCore, config: Record<string, unknown>): PluginContext & {
  provided: Map<string, unknown>;
  registries: Record<string, FakeRegistry>;
} {
  const provided = new Map<string, unknown>();
  const registries: Record<string, FakeRegistry> = {
    "route.registry": { register: () => undefined },
    "menu.registry": { register: () => undefined },
    "breadcrumb.registry": { register: () => undefined }
  };
  const logger: {
    debug: () => void;
    info: () => void;
    warn: () => void;
    error: () => void;
    child: () => unknown;
  } = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger
  };
  return {
    provided,
    registries,
    config,
    provide(key: string, value: unknown) {
      provided.set(key, value);
    },
    get<T>(key: string): T {
      if (key === BROADCAST_CORE_CAPABILITY) return core as T;
      if (key in registries) return registries[key] as T;
      if (provided.has(key)) return provided.get(key) as T;
      throw new Error(`missing capability: ${key}`);
    },
    has(key: string): boolean {
      return key === BROADCAST_CORE_CAPABILITY || key in registries || provided.has(key);
    },
    require(key: string): void {
      if (key !== BROADCAST_CORE_CAPABILITY && !(key in registries) && !provided.has(key)) {
        throw new Error(`missing capability: ${key}`);
      }
    },
    messageBus: {} as never,
    logger: logger as never
  };
}

afterEach(() => {
  delete (globalThis as { __PRICECAST_PUBLISHER_PUBKEY__?: string }).__PRICECAST_PUBLISHER_PUBKEY__;
});

describe("plugin-bsv-price manifest config boundary", () => {
  it("empty config keeps service in not_configured and does not subscribe broadcast.core", () => {
    (globalThis as { __PRICECAST_PUBLISHER_PUBKEY__?: string }).__PRICECAST_PUBLISHER_PUBKEY__ =
      "wrong-global-value";
    const core = new FakeBroadcastCore();
    const ctx = makeContext(core, {});

    const teardown = bsvPricePlugin.setup(ctx);
    expect(typeof teardown).toBe("function");

    const service = ctx.provided.get(BSV_PRICE_SERVICE_CAPABILITY) as BsvPriceService | undefined;
    expect(service).toBeDefined();
    expect(core.subscribeCalls).toHaveLength(0);
    expect(service?.snapshot()).toMatchObject({
      channelId: "(not configured)",
      status: "not_configured",
      configured: false
    });
  });

  it("manifest.config wins and produces the exact subscription channel", () => {
    (globalThis as { __PRICECAST_PUBLISHER_PUBKEY__?: string }).__PRICECAST_PUBLISHER_PUBKEY__ =
      "wrong-global-value";
    const core = new FakeBroadcastCore();
    const publisherHex = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ctx = makeContext(core, {
      [BSV_PRICE_CONFIG_KEY]: publisherHex
    });

    bsvPricePlugin.setup(ctx);

    const service = ctx.provided.get(BSV_PRICE_SERVICE_CAPABILITY) as BsvPriceService | undefined;
    expect(service).toBeDefined();
    expect(core.subscribeCalls).toHaveLength(1);
    expect(core.subscribeCalls[0]?.channelIds).toEqual([buildPriceChannelId(publisherHex)]);
    expect(service?.snapshot()).toMatchObject({
      channelId: buildPriceChannelId(publisherHex),
      configured: true
    });
  });
});
