import { usePluginCapability } from "webloom-framework/react";
import { VAULT_WALLET_STATE_CAPABILITY, type VaultWalletState } from "@keymaster/contracts";
import { issuedConsumerScope } from "../consumerAuthority.js";
import { useScopedPluginConsumer } from "./ScopedPluginConsumerProvider.js";
export function useWalletState(): VaultWalletState {
  const consumer = useScopedPluginConsumer();
  const access = usePluginCapability(VAULT_WALLET_STATE_CAPABILITY);
  return access.bind(consumer, issuedConsumerScope(consumer));
}
