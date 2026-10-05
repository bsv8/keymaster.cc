import { expect, it } from "vitest";
import { PROTOCOL_METHODS, type ProtocolMethod } from "@keymaster/contracts";
import { createProviderDispatch } from "./providerDispatch.js";
const handlers = Object.fromEntries(PROTOCOL_METHODS.map(method => [method, async () => method])) as Record<ProtocolMethod, () => Promise<string>>;
it("publishes exactly the declared V1 methods from the release catalog", async () => {
  const dispatch = createProviderDispatch(handlers);
  expect([...dispatch.keys()].sort()).toEqual([...PROTOCOL_METHODS].sort());
  expect(await dispatch.get("storage.list")!(undefined)).toBe("storage.list");
});
it("rejects undeclared, duplicate and internal method publication", () => {
  expect(() => createProviderDispatch(handlers, [])).toThrow(/Missing Connect provider/);
  expect(() => createProviderDispatch(handlers, [{ id: "storage", units: [{ connect: { providerMethods: ["storage.browse"] } }] }])).toThrow(/Unknown Connect method/);
  expect(() => createProviderDispatch(handlers, [{ id: "a", units: [{ connect: { providerMethods: ["identity.get", "identity.get"] } }] }])).toThrow(/Duplicate Connect provider/);
});
