// collectible provider 注册表回归测试。

import { describe, expect, it, vi } from "vitest";
import type { CollectibleProvider } from "@keymaster/contracts";
import { createCollectibleRegistry } from "./collectibleRegistry.js";

function provider(id: string): CollectibleProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    id,
    name: { key: `${id}.name`, fallback: id },
    listCollectibles: vi.fn(async () => []),
    getCollectible: vi.fn(async () => undefined),
    listActivity: vi.fn(async () => []),
    sync: vi.fn(async () => {}),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn()
  };
}

describe("createCollectibleRegistry", () => {
  it("unregister calls provider.dispose when available", () => {
    const registry = createCollectibleRegistry();
    const p = provider("one");
    registry.register(p);

    registry.unregister("one");

    expect(p.dispose).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });
});
