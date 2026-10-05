import { definePlugin, startSharedWorkerApp } from "webloom-framework";
import { identity } from "./capability.js";
const name = (globalThis as unknown as { name: string }).name;
startSharedWorkerApp({ id: name, plugins: [definePlugin({ id: `provider-${name}`, name,
  runtime: "shared-worker", unitId: `provider-${name}.worker`, provides: [identity],
  setup(ctx) { ctx.handle(identity, () => name); },
})], expose: [identity] });
