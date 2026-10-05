import { createContext, useContext, type ReactNode } from "react";
import type { OwnedResourceReader } from "@keymaster/contracts";
const Resources = createContext<OwnedResourceReader | undefined>(undefined);
export function SatResourceProvider({ reader, children }: { reader: OwnedResourceReader; children: ReactNode }) {
  return <Resources.Provider value={reader}>{children}</Resources.Provider>;
}
export function useSatResources(): OwnedResourceReader {
  const reader = useContext(Resources);
  if (!reader) throw new Error("Sat UI requires its contributing instance resource view");
  return reader;
}
