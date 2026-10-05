// token provider 注册表回归测试。

import { describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "@keymaster/contracts";
import { createTokenRegistry } from "./tokenRegistry.js";

function provider(id: string): TokenProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    id,
    name: { key: `${id}.name`, fallback: id },
    listTokens: vi.fn(async () => []),
    getToken: vi.fn(async () => undefined),
    listActivity: vi.fn(async () => []),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn()
  };
}

describe("createTokenRegistry", () => {
  it("unregister calls provider.dispose when available", () => {
    const registry = createTokenRegistry();
    const p = provider("bsv21");
    registry.register(p);

    registry.unregister("bsv21");

    expect(p.dispose).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });
});
