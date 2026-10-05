import { expect, it } from "vitest";
import type { ProtocolService } from "@keymaster/contracts";
import { createPublicProtocolService } from "./publicProtocolService.js";
it("publishes contract methods without inherited dependencies, execution internals or disposal", () => {
  let active = true;
  const service = Object.assign(Object.create({ deps: { secret: "internal" }, execute: () => {} }), { snapshot: () => ({ phase: "waiting" }), dispose: () => {} }) as ProtocolService;
  const publicView = createPublicProtocolService(service, () => { if (!active) throw new Error("revoked"); });
  expect(Object.getPrototypeOf(publicView)).toBeNull(); expect(Object.isFrozen(publicView)).toBe(true);
  for (const key of ["deps", "dispose", "execute"]) expect(publicView).not.toHaveProperty(key);
  expect(publicView.snapshot()).toEqual({ phase: "waiting" });
  active = false; expect(() => publicView.snapshot()).toThrow("revoked");
});
