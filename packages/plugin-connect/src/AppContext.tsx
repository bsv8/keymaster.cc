import { createContext, useContext, type ReactNode } from "react";
import type { ConnectService, ApplicationConnections } from "@keymaster/contracts";
import type { WindowAppDirectory } from "./catalog.js";
export interface ConnectApps { host: ApplicationConnections; connect: Pick<ConnectService, "launchAppView">; directory: WindowAppDirectory }
const Context = createContext<ConnectApps | undefined>(undefined);
export function ConnectAppsProvider({ value, children }: { value: ConnectApps; children: ReactNode }) { return <Context.Provider value={value}>{children}</Context.Provider>; }
export function useConnectApps(): ConnectApps { const value = useContext(Context); if (!value) throw new Error("Connect application context unavailable"); return value; }
