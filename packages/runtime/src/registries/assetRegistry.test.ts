// asset provider 注册表回归测试。

import { describe, expect, it, vi } from "vitest";
import type { AssetProvider } from "@keymaster/contracts";
import { createAssetRegistry } from "./assetRegistry.js";

function provider(id: string): AssetProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    id,
    name: { key: `${id}.name`, fallback: id },
    kind: "coin",
    listAssets: vi.fn(async () => []),
    getAsset: vi.fn(async () => undefined),
    listActivity: vi.fn(async () => []),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn()
  };
}

describe("createAssetRegistry", () => {
  it("unregister calls provider.dispose when available", () => {
    const registry = createAssetRegistry();
    const p = provider("p2pkh");
    registry.register(p);

    registry.unregister("p2pkh");

    expect(p.dispose).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });
});
