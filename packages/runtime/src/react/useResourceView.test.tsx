import { useLayoutEffect } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useResourceView } from "./useOptionalResource.js";

describe("scoped resource view", () => {
  it("finishes React subscription setup safely when the instance is revoked during commit", () => {
    let active = true;
    const snapshot = { key: ["wallet.state"] as const, status: "ready" as const, revision: 1, data: "wallet" };
    const subscribe = vi.fn(() => { if (!active) throw new Error("Scope revoked"); return () => {}; });
    const store = { isActive: () => active, ensure: <T,>() => { if (!active) throw new Error("Scope revoked"); return snapshot as typeof snapshot & { data: T }; }, subscribe };
    function Fixture() {
      const current = useResourceView(store, "wallet.state", []);
      useLayoutEffect(() => { active = false; }, []);
      return <output>{current.status}</output>;
    }
    render(<Fixture />);
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
