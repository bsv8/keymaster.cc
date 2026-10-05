import { createElement } from "react";
import { observeOptionalCapability } from "@keymaster/runtime";
import { URI_ACTION_REGISTRY_CAPABILITY, type PluginContext } from "@keymaster/contracts";
import { bindMsFileUi } from "./MsFileResourceContext.js";
import { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";
import { parseSeedUri } from "./seedUri.js";
export function setupMsFileUriActions(ctx: PluginContext) {
 const File = bindMsFileUi<{ initialSeedHash?: string }>(ctx, MsFileHomeFileWidget);
 observeOptionalCapability(ctx, URI_ACTION_REGISTRY_CAPABILITY, registry => {
  const bound = registry.bind(ctx.consumer, ctx.scope);
  bound.view.register({ id: "msfile.seed", order: 40,
   resolve: input => parseSeedUri(input) ? [{ id: "file", label: { key: "msfile.home.title", fallback: "Get a file by Seed" } }] : [],
   render: (_actionId, input) => { const initialSeedHash = parseSeedUri(input); return initialSeedHash ? createElement(File, { initialSeedHash }) : null; },
  });
  return () => { try { bound.view.unregister("msfile.seed"); } catch { /* 实例/入口撤销后不保留候选。 */ } };
 });
}
