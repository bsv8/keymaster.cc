import { createContext, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { RuntimeDiagnosticsView } from "@keymaster/contracts";
type DiagnosticsBinding = { view: RuntimeDiagnosticsView; isActive: () => boolean };
const Diagnostics = createContext<DiagnosticsBinding | undefined>(undefined);
export function SettingsDiagnosticsProvider({ view, isActive, children }: DiagnosticsBinding & { children: ReactNode }) {
  return <Diagnostics.Provider value={{ view, isActive }}>{children}</Diagnostics.Provider>;
}
export function useSettingsDiagnostics() {
  const binding = useContext(Diagnostics);
  if (!binding) throw new Error("Plugin diagnostics requires the settings instance view");
  const { view, isActive } = binding;
  // React may check a child snapshot while the owner's Scope is stopping, before unmount.
  // Keep this private UI boundary inert; the public diagnostics view remains strictly scoped.
  const subscribe = useCallback((listener: () => void) => isActive() ? view.subscribe(listener) : () => {}, [view, isActive]);
  const revision = useCallback(() => isActive() ? view.revision() : -1, [view, isActive]);
  useSyncExternalStore(subscribe, revision, revision);
  const last = useRef<ReturnType<RuntimeDiagnosticsView["snapshot"]>>();
  if (isActive()) last.current = view.snapshot();
  if (!last.current) throw new Error("Plugin diagnostics has no active snapshot");
  return { ...view, ...last.current };
}
