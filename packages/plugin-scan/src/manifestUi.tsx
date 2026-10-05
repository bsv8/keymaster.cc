import { createElement } from "react";
import { ScanLine } from "lucide-react";
import { createUriRouter } from "./uriRouter.js";
import { ScanFrame, ScanContextProvider } from "./ScanUi.js";
import { URI_ACTION_REGISTRY_CAPABILITY, URI_ACTION_RESOLVER_CAPABILITY, SCAN_UI_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, type PluginSetup } from "@keymaster/contracts";
import { usePluginI18n } from "@keymaster/runtime";
export const scanSetup: PluginSetup = ctx => {
 const router = createUriRouter(ctx.scope);
 ctx.provide(URI_ACTION_REGISTRY_CAPABILITY, router.registry);
 ctx.provide(URI_ACTION_RESOLVER_CAPABILITY, router.resolver);
 ctx.provide(SCAN_UI_CAPABILITY, router.scanUi);
 const resolver = router.resolver.bind(ctx.consumer, ctx.scope), scan = router.scanUi.bind(ctx.consumer, ctx.scope);
 function HomeButton() { const { t } = usePluginI18n(); return <section className="home-actions"><div className="home-actions__grid"><button type="button" className="home-actions__shortcut" onClick={() => scan.open()} data-testid="home-scan-button"><span className="home-actions__icon"><ScanLine size={28} /></span><span>{t("scan.home")}</span></button></div></section>; }
 const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
 pages.register({ id: "scan.home", kind: "home", slot: "main", order: -1000, label: "Scan", render: () => createElement(HomeButton) });
 pages.register({ id: "scan.frame", kind: "frame", slot: "uri-action", label: "URI action", render: () => createElement(ScanContextProvider, { value: { router, resolver }, children: createElement(ScanFrame) }) });
};
