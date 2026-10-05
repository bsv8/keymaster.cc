import { createContext, useContext, type ReactNode } from "react";
import type { OwnedResourceReader } from "@keymaster/contracts";
const PriceResources = createContext<OwnedResourceReader | undefined>(undefined);
/** 仅 setup 捕获的实例资源视图进入本插件 UI，不导出到包公共入口。 */
export function PriceResourceProvider({ reader, children }: { reader: OwnedResourceReader; children: ReactNode }) {
  return <PriceResources.Provider value={reader}>{children}</PriceResources.Provider>;
}
export function usePriceResources(): OwnedResourceReader {
  const reader = useContext(PriceResources);
  if (!reader) throw new Error("Price UI requires its contributing instance resource view");
  return reader;
}
