import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WalletLockDetails } from "./VaultLockCleanup.js";

afterEach(cleanup);

describe("lock error details", () => {
  it("starts collapsed and keeps the expanded first-failure log visible when retry details update", () => {
    const first = "attempt=1 source=price\nError: first-exit-failed\nresource=channel-runtime";
    const view = render(<WalletLockDetails title="锁定错误详情" details={first} />);
    const details = view.container.querySelector("details")!;
    expect(details.open).toBe(false);
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("first-exit-failed");
    view.rerender(<WalletLockDetails title="锁定错误详情" details={`${first}\n\nattempt=2 source=price\nError: retry-exit-failed`} />);
    expect(view.container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("first-exit-failed");
    expect(details.textContent).toContain("retry-exit-failed");
  });
});
