import { useEffect, useSyncExternalStore } from "react";
import type { WindowAppDirectory, AppDirectorySnapshot } from "./catalog.js";
export function useAppDirectory(service: WindowAppDirectory): AppDirectorySnapshot {
 const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
 useEffect(() => { void service.list(); }, [service]);
 return snapshot;
}
