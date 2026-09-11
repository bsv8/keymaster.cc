import { describe, expect, it } from "vitest";
import { defineCapability } from "webloom-framework";
import { createWindowAppFromHost, registerPlugins } from "webloom-framework/advanced";
import type { PluginSetup } from "@keymaster/contracts";
import { createKeymasterPluginHost } from "./keymasterHostAdapter.js";
import { getWebLoomHost } from "./pluginHostContract.js";

const LOCAL_CAPABILITY = defineCapability<{ ok: boolean }>({
  kind: "local",
  id: "adapter.local",
  version: "1",
});

describe("Keymaster WebLoom v4 adapter", () => {
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
      instanceId: string;
      state: "ready" | "starting" | "failed";
    }[] = [{
      productId: "split-plugin",
      unitId: "split-plugin.worker",
      runtime: "shared-worker",
      scopeKind: "root",
      snapshotRevision: 1,
      serviceIds: [],
      taskIds: [],
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
});
