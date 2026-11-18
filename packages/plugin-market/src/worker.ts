import { defineBuiltinWorkerPlugin, APP_MARKET_SYNC_CAPABILITY } from "@keymaster/contracts";
import { createMarketSync } from "./sync.js";
export function createMarketWorkerPlugin() { return defineBuiltinWorkerPlugin("apps", [APP_MARKET_SYNC_CAPABILITY], ctx => { ctx.provide(APP_MARKET_SYNC_CAPABILITY, createMarketSync(ctx.scope.signal)); }); }
