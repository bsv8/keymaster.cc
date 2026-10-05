import { createElement } from "react";
import { observeOptionalCapability } from "@keymaster/runtime";
import { URI_ACTION_REGISTRY_CAPABILITY, parsePublicKeyUri, type PluginContext } from "@keymaster/contracts";
import { ContactUriAction } from "./ContactUriAction.js";
import { bindContactsUi } from "./ContactsResourceContext.js";
export function setupContactUriActions(ctx: PluginContext) {
 const Contact = bindContactsUi(ctx, ContactUriAction);
 observeOptionalCapability(ctx, URI_ACTION_REGISTRY_CAPABILITY, registry => {
   const bound = registry.bind(ctx.consumer, ctx.scope);
   bound.view.register({ id: "contacts.public-key", order: 10,
     resolve: input => parsePublicKeyUri(input) ? [{ id: "contact", label: { key: "contacts.uri.action", fallback: "View or save contact" } }] : [],
     render: (_actionId, input, close) => { const publicKeyHex = parsePublicKeyUri(input); return publicKeyHex ? createElement(Contact, { publicKeyHex, close }) : null; },
   });
   return () => { try { bound.view.unregister("contacts.public-key"); } catch { /* 提供方或实例已撤销。 */ } };
 });
}
