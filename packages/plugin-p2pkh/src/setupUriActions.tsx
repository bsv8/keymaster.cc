import { createElement } from "react";
import { observeOptionalCapability, router, usePluginI18n } from "@keymaster/runtime";
import { URI_ACTION_REGISTRY_CAPABILITY, type PluginContext } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";
import { parsePaymentUri, type PaymentUri } from "./paymentUri.js";
function PaymentAction({ payment, close }: { payment: PaymentUri; close: () => void }) {
 const { t } = usePluginI18n();
 return <section data-testid="payment-uri-action"><code>{payment.address ?? payment.publicKeyHex}</code>
   {payment.label ? <p>{payment.label}</p> : null}{payment.amount ? <p>{payment.amount} BSV</p> : null}
   <p>{t("p2pkh.uri.review")}</p><Button onClick={() => {
     const query = new URLSearchParams();
     if (payment.publicKeyHex) query.set("recipientPublicKeyHex", payment.publicKeyHex);
     if (payment.address) query.set("recipientAddress", payment.address);
     if (payment.network) query.set("network", payment.network);
     if (payment.amount) query.set("requestedAmountBsv", payment.amount);
     close(); router.push(`/transfer?${query}`);
   }}>{t("p2pkh.uri.open")}</Button></section>;
}
export function setupP2pkhUriActions(ctx: PluginContext) {
 observeOptionalCapability(ctx, URI_ACTION_REGISTRY_CAPABILITY, registry => {
   const bound = registry.bind(ctx.consumer, ctx.scope);
   bound.view.register({ id: "p2pkh.payment", order: 20,
     resolve: input => parsePaymentUri(input) ? [{ id: "transfer", label: { key: "p2pkh.uri.action", fallback: "Transfer BSV" } }] : [],
     render: (_actionId, input, close) => { const payment = parsePaymentUri(input); return payment ? createElement(PaymentAction, { payment, close }) : null; },
   });
   return () => { try { bound.view.unregister("p2pkh.payment"); } catch { /* 撤销后旧处理器不可执行。 */ } };
 });
}
