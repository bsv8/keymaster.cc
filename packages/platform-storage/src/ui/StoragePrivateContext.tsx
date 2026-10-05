import type { StorageRuntimeController } from "@keymaster/contracts";
type StorageUiController = StorageRuntimeController & { activity?(): { reads: number; writes: number } };
import type { StorageBrowseService } from "../runtime/storageBrowsePrivate.js";
import { createContext, useContext, type ReactNode } from "react";

// 只在 Storage 自己的组件树中传递，不发布为公共 capability。
const StoragePrivateContext = createContext<{ browse: StorageBrowseService; controller?: StorageUiController } | undefined>(undefined);

export function StoragePrivateProvider({ service, controller, children }: {
  service: StorageBrowseService;
  controller?: StorageUiController;
  children: ReactNode;
}) {
  return <StoragePrivateContext.Provider value={{ browse: service, controller }}>{children}</StoragePrivateContext.Provider>;
}

export function useStoragePrivateBrowse(): StorageBrowseService | undefined {
  return useContext(StoragePrivateContext)?.browse;
}

export function useStoragePrivateController(): StorageUiController | undefined {
  return useContext(StoragePrivateContext)?.controller;
}
