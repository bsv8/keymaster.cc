import { createContext, useContext, type ReactNode } from "react";
import { PluginConsumerProvider, WebLoomContext } from "webloom-framework/react";
import type { PluginConsumer } from "webloom-framework";
import { PluginHostContext } from "./PluginHostProvider.js";
const ScopedConsumer = createContext<PluginConsumer | undefined>(undefined);
export function useScopedPluginConsumer(): PluginConsumer {
  const consumer = useContext(ScopedConsumer);
  if (!consumer) throw new Error("Wallet state requires a scoped plugin consumer");
  return consumer;
}
/** A contribution receives only its issued consumer, even beneath trusted host UI. */
export function ScopedPluginConsumerProvider({ consumer, children }: { consumer: PluginConsumer; children: ReactNode }) {
  return <PluginHostContext.Provider value={undefined}>
    <WebLoomContext.Provider value={undefined}>
      <ScopedConsumer.Provider value={consumer}><PluginConsumerProvider consumer={consumer}>{children}</PluginConsumerProvider></ScopedConsumer.Provider>
    </WebLoomContext.Provider>
  </PluginHostContext.Provider>;
}
