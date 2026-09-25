import { describe, expect, it } from "vitest";
import { defineCapability } from "webloom-framework";
import { createPluginIntentController, createWindowAppFromHost, registerPlugins } from "webloom-framework/advanced";
import type { PluginIntentCoordinator } from "webloom-framework";
import { defineRuntimeUnitDependencies, type CoordinatorUnitUnavailableReason, type PluginSetup } from "@keymaster/contracts";
import { createKeymasterPluginHost } from "./keymasterHostAdapter.js";
import { getWebLoomHost } from "./pluginHostContract.js";

const LOCAL_CAPABILITY = defineCapability<{ ok: boolean }>({
  kind: "local",
  id: "adapter.local",
  version: "1",
});
const DEPENDENCY_CAPABILITY = defineCapability<{ ready: boolean }>({
  kind: "local",
  id: "adapter.dependency",
  version: "1",
});

describe("Keymaster WebLoom v4 adapter", () => {
  it("重新装配已有实例时不重复提交插件启停意图", async () => {
    const intentController = createPluginIntentController({
      authorityInstanceId: "authority:adapter-test",
      initial: { revision: 0, desiredEnabled: {}, desiredRevision: {} },
    });
    const pluginIntent: PluginIntentCoordinator = {
      authorityInstanceId: intentController.authorityInstanceId,
      snapshot: intentController.snapshot,
      subscribe: intentController.subscribe,
      submit: intentController.submit,
    };
    let setupCount = 0;
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      disableConfigPersistence: true,
      pluginIntentCoordinator: pluginIntent,
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: "02" + "11".repeat(32),
        sessionEpoch: "adapter-test:1",
        bucketGeneration: 1,
      },
      runtimeUnitImplementationRegistry: {
        get: () => (context) => {
          setupCount += 1;
          context.provide(LOCAL_CAPABILITY, { ok: true });
        },
      },
    });
    const plugin = {
      id: "adapter-reassembly",
      name: "Adapter reassembly",
      kind: "platform" as const,
      startup: "optional" as const,
      defaultEnabled: true,
      canDisable: true,
      bootstrapStage: "vault-selection" as const,
      displayGroup: "platform" as const,
      units: [{
        id: "adapter-reassembly.window",
        runtime: "window-main" as const,
        scopeKind: "storage" as const,
        dependencies: defineRuntimeUnitDependencies([{ capability: DEPENDENCY_CAPABILITY }]),
        provides: [LOCAL_CAPABILITY],
      }],
    };

    // 第一次因依赖未注册而 blocked；依赖恢复后重新 register 只应
    // 重试本地实例，不能把“启用”再次写入 Coordinator。
    await host.register(plugin);
    expect(host.state(plugin.id).kind).toBe("blocked");
    host.provide(DEPENDENCY_CAPABILITY, { ready: true });
    await host.register(plugin);
    expect(host.state(plugin.id).kind).toBe("enabled");
    expect(intentController.snapshot().revision).toBe(0);

    // 桶世代变化会销毁并重建 storage Scope，同样不能改变持久化意图。
    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      sessionEpoch: "adapter-test:1",
      bucketGeneration: 1,
    });
    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: "02" + "11".repeat(32),
      sessionEpoch: "adapter-test:1",
      bucketGeneration: 2,
    });
    expect(host.state(plugin.id).kind).toBe("enabled");
    expect(setupCount).toBe(2);
    expect(intentController.snapshot().revision).toBe(0);

    await host.dispose("test");
  });

  it("allows staged native WebLoom implementations after WindowApp takes ownership", async () => {
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: { get: () => undefined },
    });
    const app = await createWindowAppFromHost({
      id: "adapter-window",
      host: getWebLoomHost(host),
    });

    await registerPlugins(app, [{
      manifest: {
        id: "native-staged-plugin",
        name: "Native staged plugin",
        startup: "required",
        defaultEnabled: true,
        canDisable: false,
        units: [{
          id: "native-staged-plugin.window",
          runtime: "window-main",
          provides: [LOCAL_CAPABILITY],
        }],
      },
      unitId: "native-staged-plugin.window",
      capabilities: [LOCAL_CAPABILITY],
      setup(context) {
        context.provide(LOCAL_CAPABILITY, { ok: true });
      },
    }]);

    expect(app.pluginState?.("native-staged-plugin")?.kind).toBe("enabled");
    expect(app.capability(LOCAL_CAPABILITY)).toEqual({ ok: true });
    await app.dispose("test");
  });

  it("converts a typed Keymaster manifest and binds setup to a scoped capability", async () => {
    let seenPluginId: string | undefined;
    let seenUnitId: string | undefined;
    const setup: PluginSetup = (context) => {
      seenPluginId = context.pluginId;
      seenUnitId = context.unitId;
      context.provide(LOCAL_CAPABILITY, { ok: true });
    };
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: { get: () => setup },
    });

    await host.register({
      id: "adapter-plugin",
      name: "Adapter plugin",
      kind: "business",
      startup: "optional",
      defaultEnabled: true,
      canDisable: true,
      bootstrapStage: "owner-apps-ready",
      displayGroup: "business",
      units: [{
        id: "adapter-plugin.window",
        runtime: "window-main",
        scopeKind: "root",
        provides: [LOCAL_CAPABILITY],
      }],
    });

    expect(seenPluginId).toBe("adapter-plugin");
    expect(seenUnitId).toBe("adapter-plugin.window");
    expect(host.capabilities.get(LOCAL_CAPABILITY)).toEqual({ ok: true });
    expect(host.state("adapter-plugin").kind).toBe("enabled");

    await host.disable("adapter-plugin");
    expect(host.capabilities.has(LOCAL_CAPABILITY)).toBe(false);
    await host.dispose("test");
  });

  it("projects Coordinator unit snapshots without treating an unavailable remote unit as local", async () => {
    let snapshots: readonly {
      productId: string;
      unitId: string;
      runtime: "shared-worker";
      scopeKind: "root";
      snapshotRevision: number;
      serviceIds: string[];
      taskIds: string[];
      dependsOn: string[];
      reasons: CoordinatorUnitUnavailableReason[];
      instanceId: string;
      state: "ready" | "failed";
    }[] = [{
      productId: "split-plugin",
      unitId: "split-plugin.worker",
      runtime: "shared-worker",
      scopeKind: "root",
      snapshotRevision: 1,
      serviceIds: [],
      taskIds: [],
      dependsOn: [],
      reasons: [],
      instanceId: "worker-instance:1",
      state: "ready",
    }];
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      runtimeUnitSnapshots: () => snapshots,
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: { get: () => (context) => {
        context.provide(LOCAL_CAPABILITY, { ok: true });
      } },
    });

    await host.register({
      id: "split-plugin",
      name: "Split plugin",
      kind: "business",
      startup: "optional",
      defaultEnabled: true,
      canDisable: true,
      bootstrapStage: "owner-apps-ready",
      displayGroup: "business",
      units: [
        {
          id: "split-plugin.worker",
          runtime: "shared-worker",
          scopeKind: "root",
        },
        {
          id: "split-plugin.window",
          runtime: "window-main",
          scopeKind: "root",
          provides: [LOCAL_CAPABILITY],
        },
      ],
    });

    expect(host.state("split-plugin").units).toEqual(expect.arrayContaining([
      expect.objectContaining({ unitId: "split-plugin.worker", runtime: "shared-worker", instanceId: "worker-instance:1", kind: "enabled" }),
      expect.objectContaining({ unitId: "split-plugin.window", runtime: "window-main", kind: "enabled" }),
    ]));

    snapshots = [];
    host.refreshRuntimeUnitSnapshots();
    expect(host.state("split-plugin").units).toEqual(expect.arrayContaining([
      expect.objectContaining({ unitId: "split-plugin.worker", kind: "unknown", error: expect.stringContaining("快照不可用") }),
    ]));
    await host.dispose("test");
  });

  it("keeps required owner-session units blocked while a lock transition settles", async () => {
    const owner = "02" + "44".repeat(32);
    let setupCount = 0;
    const host = createKeymasterPluginHost({
      runtime: "window-main",
      initialRuntimeIdentity: {
        vaultStatus: "unlocked",
        ownerPublicKeyHex: owner,
        sessionEpoch: "session:lock-test:1",
        bucketGeneration: 1,
      },
      disableConfigPersistence: true,
      runtimeUnitImplementationRegistry: {
        get: () => (context) => {
          setupCount += 1;
          context.provide(LOCAL_CAPABILITY, { ok: true });
        },
      },
    });

    await host.register({
      id: "required-owner-session",
      name: "Required owner session",
      kind: "business",
      startup: "optional",
      defaultEnabled: true,
      canDisable: false,
      bootstrapStage: "owner-apps-ready",
      displayGroup: "business",
      units: [{
        id: "required-owner-session.window",
        runtime: "window-main",
        scopeKind: "owner-session",
        provides: [LOCAL_CAPABILITY],
      }],
    });
    expect(host.state("required-owner-session").kind).toBe("enabled");

    await expect(host.transitionRuntimeIdentity({
      vaultStatus: "locked",
      sessionEpoch: "session:lock-test:2",
      bucketGeneration: 1,
    })).resolves.toBeUndefined();
    expect(host.state("required-owner-session")).toMatchObject({
      kind: "blocked",
      desiredEnabled: true,
      blockedBy: ["runtime:owner-session-unavailable"],
    });
    expect(host.capabilities.has(LOCAL_CAPABILITY)).toBe(false);

    await host.transitionRuntimeIdentity({
      vaultStatus: "unlocked",
      ownerPublicKeyHex: owner,
      sessionEpoch: "session:lock-test:3",
      bucketGeneration: 1,
    });
    expect(host.state("required-owner-session").kind).toBe("enabled");
    expect(setupCount).toBe(2);
    await host.dispose("test");
  });
});
