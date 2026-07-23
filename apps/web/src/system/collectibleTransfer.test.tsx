// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { CollectibleTransferPage } from "./collectibleTransfer.js";

const mocks = vi.hoisted(() => {
  const provider = {
    id: "1satordinals",
    name: { key: "oneSat.provider.name", fallback: "1Sat Ordinals" },
    getCollectible: vi.fn(async () => undefined)
  };
  const collectibles = {
    get: vi.fn(() => provider)
  };
  const transferRegistry = {
    listSupporting: vi.fn(() => [])
  };
  return { provider, collectibles, transferRegistry };
});

vi.mock("@keymaster/runtime", () => ({
  useCurrentPath: () => {},
  useI18n: () => ({
    t: (_key: string, values?: { defaultValue?: string }) => values?.defaultValue ?? _key
  }),
  usePluginHost: () => ({
    i18n: {
      text: (value: { fallback?: string } | string) => typeof value === "string" ? value : value.fallback ?? ""
    }
  }),
  useCapability: (capability: string) => {
    if (capability === "collectible.registry") {
      return mocks.collectibles;
    }
    if (capability === "collectible-transfer.registry") {
      return mocks.transferRegistry;
    }
    throw new Error(`unexpected capability ${capability}`);
  }
}));

vi.mock("@keymaster/ui", () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <header>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  )
}));

  afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("CollectibleTransferPage", () => {
  it("shows a final unavailable state when the collectible has been removed by WOC", async () => {
    window.history.replaceState(null, "", "/collectibles/transfer?providerId=1satordinals&collectibleId=tx1%3A0");

    render(<CollectibleTransferPage />);

    await waitFor(() => {
      expect(screen.getByText("该藏品已不可用")).toBeTruthy();
    });
    expect(screen.getByText("WOC 最终状态已将其从当前持仓中移除，请返回后重新选择。")).toBeTruthy();
    expect(mocks.provider.getCollectible).toHaveBeenCalledWith("tx1:0");
  });

  it("shows an error state when collectible loading fails", async () => {
    mocks.provider.getCollectible.mockRejectedValueOnce(new Error("boom"));
    window.history.replaceState(null, "", "/collectibles/transfer?providerId=1satordinals&collectibleId=tx1%3A0");

    render(<CollectibleTransferPage />);

    await waitFor(() => {
      expect(screen.getByText("载入藏品失败")).toBeTruthy();
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
