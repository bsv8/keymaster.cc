import { useInstanceActive } from "@keymaster/runtime";
import { createContext, useContext, createElement, type ComponentType, type ReactNode } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { VAULT_WALLET_STATE_CAPABILITY, type VaultWalletState, OWNED_RESOURCE_ACCESS_CAPABILITY, type OwnedResourceReader, type PluginContext } from "@keymaster/contracts";
const Wallet = createContext<VaultWalletState | undefined>(undefined);
export function useConnectWalletState(): VaultWalletState {
  const state = useContext(Wallet);
  if (!state) throw new Error("Connect wallet state is unavailable");
  return state;
}
const Resources = createContext<OwnedResourceReader | undefined>(undefined);
export function useConnectResources(): OwnedResourceReader {
  const reader = useContext(Resources);
  if (!reader) throw new Error("Connect UI requires its contributing instance resource view");
  return reader;
}
export function ConnectResourceProvider({ reader, children }: { reader: OwnedResourceReader; children: ReactNode }) {
  return <Resources.Provider value={reader}>{children}</Resources.Provider>;
}
export function bindConnectUi<P extends object>(ctx: PluginContext, Component: ComponentType<P>) {
  const wallet = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const reader = ctx.capability(OWNED_RESOURCE_ACCESS_CAPABILITY).bind(ctx.consumer, ctx.scope);
  return function OwnedUi(props: P) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(PluginConsumerProvider, { consumer: ctx.consumer,
      children: createElement(Wallet.Provider, { value: wallet, children: createElement(ConnectResourceProvider, { reader, children: createElement(Component, props) }) }) }) : null;
  };
}
