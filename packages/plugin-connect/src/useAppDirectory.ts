import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { traceDev } from "@keymaster/contracts";
import type { WindowAppDirectory } from "./catalog.js";

export function useAppDirectory(service: WindowAppDirectory) {
 const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
 const [request, setRequest] = useState({ loading: true, failed: false });
 const reload = useCallback(async () => {
  setRequest({ loading: true, failed: false });
  try {
   await service.list();
   setRequest({ loading: false, failed: false });
  } catch (error) {
   traceDev("connect.relay", "directory.load.failed", () => ({ error }));
   setRequest({ loading: false, failed: true });
  }
 }, [service]);
 useEffect(() => { void reload(); }, [reload]);
 return { snapshot, reload, loading: request.loading, loadFailed: request.failed };
}
