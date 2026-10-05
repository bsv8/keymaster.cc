import { defineCapability } from "webloom-framework";
export const identity = defineCapability<null, string>({ kind: "rpc", id: "webloom06.slot.identity", version: "1",
  request: { parse(value) { if (value !== null) throw new TypeError("Expected null"); return null; } },
  response: { parse(value) { if (typeof value !== "string") throw new TypeError("Expected string"); return value; } },
});
