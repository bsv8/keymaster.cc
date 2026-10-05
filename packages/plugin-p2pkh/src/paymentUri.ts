import { parsePublicKeyUri } from "@keymaster/contracts";
import { parseP2pkhAddress } from "./p2pkhTransactionParser.js";
export interface PaymentUri { address?: string; publicKeyHex?: string; network?: "main" | "test"; amount?: string; label?: string }
export function parsePaymentUri(raw: string): PaymentUri | undefined {
 const value = raw.trim(), publicKeyHex = parsePublicKeyUri(value);
 if (publicKeyHex) return { publicKeyHex };
 const address = parseP2pkhAddress(value);
 if (address) return { address: value, network: address.network };
 try {
   const uri = new URL(value);
   if (uri.protocol !== "bsv:" || uri.hostname || uri.hash || /[\/%]/.test(uri.pathname)) return undefined;
   const parsed = parseP2pkhAddress(uri.pathname); if (!parsed) return undefined;
   if ([...uri.searchParams.keys()].some(key => !["amount", "label"].includes(key)) || ["amount", "label"].some(key => uri.searchParams.getAll(key).length > 1)) return undefined;
   const amount = uri.searchParams.get("amount") ?? undefined, label = uri.searchParams.get("label") ?? undefined;
   if (amount !== undefined && (!/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,8})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 21000000)) return undefined;
   if (label && label.length > 200) return undefined;
   return { address: uri.pathname, network: parsed.network, ...(amount ? { amount } : {}), ...(label ? { label } : {}) };
 } catch { return undefined; }
}
