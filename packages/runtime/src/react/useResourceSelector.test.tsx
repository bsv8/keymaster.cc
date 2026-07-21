import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResourceSnapshot } from "@keymaster/contracts";
import type { ResourceStoreApi } from "../resources/resourceStore.js";
import { useResourceSelector } from "./useResourceSelector.js";

describe("useResourceSelector", () => {
  it("caches an allocating selector result while the resource snapshot is unchanged", () => {
    const snapshot: ResourceSnapshot<readonly string[]> = {
      key: ["contacts.list"],
      status: "ready",
      data: ["Ada", "Bob"],
      revision: 1
    };
    const store = {
      ensure: vi.fn(() => snapshot),
      subscribe: () => () => undefined
    } as unknown as ResourceStoreApi;
    const select = vi.fn((value: ResourceSnapshot<readonly string[]>) => [...(value.data ?? [])]);

    function Fixture() {
      const rows = useResourceSelector(store, "contacts.list", [], select, (a, b) => a === b);
      return <output>{rows.join(",")}</output>;
    }

    render(<Fixture />);

    expect(screen.getByText("Ada,Bob")).toBeTruthy();
    // useSyncExternalStore asks more than once during mount; the selector must
    // not allocate a different snapshot result for those reads.
    expect(select).toHaveBeenCalledTimes(1);
  });
});
