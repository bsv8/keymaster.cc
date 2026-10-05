import { createElement } from "react";
import { Button } from "@keymaster/ui";
import { observeOptionalCapability, router, usePluginI18n } from "@keymaster/runtime";
import { URI_ACTION_REGISTRY_CAPABILITY, parsePublicKeyUri, type PluginContext } from "@keymaster/contracts";
function MessageAction({ publicKeyHex, close }: { publicKeyHex: string; close: () => void }) {
 const { t } = usePluginI18n();
 return <section data-testid="message-uri-action"><code>{publicKeyHex}</code><Button onClick={() => { close(); router.push(`/message/${encodeURIComponent(publicKeyHex)}`); }}>{t("message.action.toContact", { defaultValue: "Open conversation" })}</Button></section>;
}
export function setupMessageUriActions(ctx: PluginContext) {
 observeOptionalCapability(ctx, URI_ACTION_REGISTRY_CAPABILITY, registry => {
   const bound = registry.bind(ctx.consumer, ctx.scope);
   bound.view.register({ id: "message.public-key", order: 30,
     resolve: input => parsePublicKeyUri(input) ? [{ id: "conversation", label: { key: "message.action.toContact", fallback: "Open conversation" } }] : [],
     render: (_actionId, input, close) => { const publicKeyHex = parsePublicKeyUri(input); return publicKeyHex ? createElement(MessageAction, { publicKeyHex, close }) : null; },
   });
   return () => { try { bound.view.unregister("message.public-key"); } catch { /* 旧实例的动作不能保留。 */ } };
 });
}
