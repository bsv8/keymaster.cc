import type { ReactNode } from "react";
import type { StorageRuntimeSnapshot } from "../runtime/storageRuntimeController.js";
import { useCapability, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { StorageRuntimeController } from "@keymaster/contracts";
import { StorageOnboardingPage } from "./StorageOnboardingPage.js";

/** 全局存储门禁：未 ready 时不渲染 Vault、Keyspace 或业务页面。 */
export function StorageUnavailableGuard({ children }: { children: ReactNode }) {
  const host = usePluginHost();
  const service = useCapability<StorageRuntimeController>("storage.runtime-controller");
  const healthStatus = (service as unknown as { healthStatus?: () => import("@keymaster/contracts").StorageRuntimeStatus }).healthStatus?.() ?? "degraded";
  const snapshot = useResourceSelector<StorageRuntimeSnapshot, StorageRuntimeSnapshot>(
    host.resourceStore,
    "storage.status",
    [],
    (value) => value.data ?? { status: service.status(), healthStatus, summary: null, capabilities: service.getConditionalCapabilities() },
    (left, right) => left.status === right.status && left.healthStatus === right.healthStatus && JSON.stringify(left.summary) === JSON.stringify(right.summary) && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
  if (snapshot.status !== "ready" || snapshot.healthStatus !== "ready") return <StorageOnboardingPage />;
  return <>{children}</>;
}
