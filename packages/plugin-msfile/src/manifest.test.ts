// MSFile manifest 的发布与生命周期证据：默认加载、正式路由、首页投影
// 和 host disable 时的 owner 回收必须使用同一条真实注册路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCoordinatorClient } from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY, MSFILE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { createPluginHost } from "@keymaster/runtime";
import { msfilePlugin } from "./manifest.js";

vi.mock("./windowExecutor.js", () => ({
  installMsFileWindowExecutor: vi.fn(() => () => undefined),
}));

function coordinator(): SessionCoordinatorClient {
  return {
    subscribeTopic: vi.fn(() => () => undefined),
    getBootstrapSnapshot: vi.fn(() => ({ vaultStatus: "locked", sessionEpoch: "test" })),
  } as unknown as SessionCoordinatorClient;
}

describe("msfilePlugin manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is enabled by default while retaining the user disable switch", () => {
    expect(msfilePlugin.meta).toMatchObject({ defaultEnabled: true, canDisable: true });
  });

  it("registers the formal file route and removes all owned surfaces on disable", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide("session-coordinator.client", coordinator());
    host.provide(KEYSPACE_SERVICE_CAPABILITY, {
      active: () => ({ activePublicKeyHex: undefined, generation: undefined }),
      onActiveKeyChanged: () => () => undefined,
    });
    host.provide("vault.service", {});
    host.business.register("home", {
      id: "home",
      label: { key: "test.home", fallback: "Home" },
      order: 0,
      features: [],
    });

    await host.register(msfilePlugin);

    expect(host.state("msfile").kind).toBe("enabled");
    expect(host.routes.byId("msfile.home.file")?.path).toBe("/msfile/files");
    expect(host.business.listHomeProjections().map((projection) => projection.id)).toContain("msfile.file-fetch");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(true);

    await host.disable("msfile");

    expect(host.routes.byId("msfile.home.file")).toBeUndefined();
    expect(host.business.listHomeProjections().map((projection) => projection.id)).not.toContain("msfile.file-fetch");
    expect(host.capabilities.has(MSFILE_SERVICE_CAPABILITY)).toBe(false);
  });
});
