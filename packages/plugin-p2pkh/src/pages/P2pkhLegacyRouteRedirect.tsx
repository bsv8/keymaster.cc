import { useEffect } from "react";
import { router } from "@keymaster/runtime";
import { P2pkhWalletPage } from "./P2pkhWalletPage.js";

export function P2pkhLegacyRouteRedirect({ tab }: { tab: "transactions" | "coins" }) {
  useEffect(() => { router.push(`/p2pkh?tab=${tab}`); }, [tab]);
  // Render the unified workspace during the internal route transition. A
  // direct visit to a legacy URL can resume from the locked shell, and
  // returning null there otherwise leaves a blank content area until another
  // navigation event arrives.
  return <P2pkhWalletPage initialTab={tab} />;
}

export function P2pkhLegacyTransactionsRoute() { return <P2pkhLegacyRouteRedirect tab="transactions" />; }
export function P2pkhLegacyCoinsRoute() { return <P2pkhLegacyRouteRedirect tab="coins" />; }
