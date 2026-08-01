// apps/web/src/bootstrapPlugins.test.ts
// 启动装配层的挂死探测测试。
//
// 覆盖：
//   1. protocol 注册永久 pending 时，装配层会在时限后抛出明确错误；
//   2. 普通插件描述保持通用文案；
//   3. 正常注册不会被误判成超时。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, SessionCoordinatorClient } from "@keymaster/contracts";
import { createPluginHost, StartupCapabilityError, StartupPluginError, type PluginHost } from "@keymaster/runtime";
import {
  connectCoordinatorWithStartupRetry,
  describeBootstrapStep,
  registerPluginWithTimeout
} from "./bootstrapPlugins.js";
import { assertWebStartupContract, WEB_STARTUP_REQUIRED_CAPABILITIES } from "./bootstrapPlugins.js";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";
import { SESSION_COORDINATOR_CLIENT_CAPABILITY } from "@keymaster/contracts";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  localStorage.clear();
});

function makePlugin(id: string): PluginManifest {
  return {
    id,
    name: id,
    description: `${id} plugin`
  } as PluginManifest;
}

function makeHost(registerImpl: (plugin: PluginManifest) => Promise<void>): PluginHost {
  return {
    register: registerImpl
  } as PluginHost;
}

describe("bootstrapPlugins hang detection", () => {
  it('adds protocol-specific IndexedDB hint to startup step description', () => {
    expect(describeBootstrapStep("protocol")).toBe(
      'plugin "protocol" (opening IndexedDB "keymaster.protocol")'
    );
    expect(describeBootstrapStep("vault")).toBe('plugin "vault"');
  });

  it("turns permanently pending protocol bootstrap into explicit timeout error", async () => {
    vi.useFakeTimers();
    const host = makeHost(() => new Promise<void>(() => undefined));
    const promise = registerPluginWithTimeout(host, makePlugin("protocol"), 1_500);
    const assertion = expect(promise).rejects.toThrow(
      'Bootstrap timed out while registering plugin "protocol" (opening IndexedDB "keymaster.protocol") after 1500ms'
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
  });

  it("lets successful registration finish before timeout", async () => {
    vi.useFakeTimers();
    const host = makeHost(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        })
    );
    const promise = registerPluginWithTimeout(host, makePlugin("settings"), 1_500);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("Coordinator startup recovery", () => {
  it("disconnects a failed first attempt and retries once", async () => {
    vi.useFakeTimers();
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("worker load failed"))
      .mockResolvedValueOnce(undefined);
    const disconnect = vi.fn();

    const pending = connectCoordinatorWithStartupRetry({ connect, disconnect }, 200);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("preserves the second failure for the fatal startup path", async () => {
    vi.useFakeTimers();
    const finalError = new Error("worker still unavailable");
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("worker load failed"))
      .mockRejectedValueOnce(finalError);
    const disconnect = vi.fn();

    const pending = connectCoordinatorWithStartupRetry({ connect, disconnect }, 200);
    const assertion = expect(pending).rejects.toBe(finalError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("web startup capability contract", () => {
  it("loads the real web catalog with the message contact action", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide(SESSION_COORDINATOR_CLIENT_CAPABILITY, {
      connect: async () => undefined,
      getIsConnected: () => true,
      getBootstrapSnapshot: () => ({ keys: [], activePublicKeyHex: undefined }),
      subscribeTopic: () => () => undefined,
      unlock: async () => ({ ok: false }), lock: async () => ({ ok: false }),
      activateKey: async () => ({ ok: false }), vaultOperation: async () => ({ ok: false }),
      crypto: async () => ({ ack: { ok: false } }), backgroundCancelByKey: async () => ({ ok: false })
    } as unknown as SessionCoordinatorClient);
    await host.registerAll([...WEB_PLUGIN_CATALOG]);
    expect(host.state("message").kind).toBe("enabled");
    expect(host.contactPublicKeyActions.get("message.to-contact")).toBeDefined();
    if (host.state("message").kind !== "enabled") {
      expect(host.state("message").error).toBeTruthy();
    }
  }, 30_000);

  function vaultFixture(setup: PluginManifest["setup"] = (ctx) => {
    ctx.provide("vault.service", {});
    ctx.provide("keyspace.service", {});
  }): PluginManifest {
    return {
      id: "vault",
      name: "Vault",
      meta: {
        kind: "core",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        providesCapabilities: ["vault.service", "keyspace.service"]
      },
      setup
    };
  }

  it.each([
    { version: 1, value: { vault: false } },
    { version: 2, value: { version: 2, enabled: { vault: false } } }
  ])("keeps Vault enabled with legacy/configured false", async ({ value }) => {
    localStorage.setItem("keymaster.plugins.runtime", JSON.stringify(value));
    const host = createPluginHost();
    await host.register(vaultFixture());
    assertWebStartupContract(host);
    expect(host.capabilities.has("vault.service")).toBe(true);
    expect(host.configStore.read().vault).toBe(true);
    expect(JSON.parse(localStorage.getItem("keymaster.plugins.runtime")!).version).toBe(2);
  });

  it("rejects required setup failures before startup preflight", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await expect(host.register(vaultFixture(() => { throw new Error("sensitive setup detail"); })))
      .rejects.toBeInstanceOf(StartupPluginError);
    expect(() => assertWebStartupContract(host)).toThrow(StartupCapabilityError);
  });

  it("reports missing provider/capability and does not enter React", () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    expect(() => assertWebStartupContract(host)).toThrow(/vault\.service/);
    try {
      assertWebStartupContract(host);
    } catch (error) {
      const details = (error as StartupCapabilityError).details;
      expect(details[0]).toMatchObject({
        capability: "vault.service",
        providerPluginId: undefined,
        providerState: undefined
      });
    }
    expect(WEB_STARTUP_REQUIRED_CAPABILITIES).toEqual(["vault.service", "keyspace.service"]);
  });

  it("keeps optional failures isolated while required preflight succeeds", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    await host.register({
      id: "optional",
      name: "Optional",
      meta: { kind: "business", startup: "optional", defaultEnabled: true, canDisable: true },
      setup() { throw new Error("optional failure"); }
    });
    await host.register(vaultFixture());
    assertWebStartupContract(host);
    expect(host.state("optional").kind).toBe("error-disabled");
  });
});
