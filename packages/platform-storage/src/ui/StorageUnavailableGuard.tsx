import { useRef, type ReactNode } from "react";
import type { StorageRuntimeSnapshot } from "../runtime/storageRuntimeController.js";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { usePluginHost } from "@keymaster/runtime";
import type { StorageRuntimeController } from "@keymaster/contracts";
import { StorageOnboardingPage } from "./StorageOnboardingPage.js";

/**
 * 启动阶段的存储门禁。
 *
 * 一旦本次页面已经完成过启动，后续 Provider/业务 I/O 失败只应由原请求
 * 就地展示；不能卸载业务页面并把用户送回桶设置，从而丢失正在编辑的表单。
 */
export function StorageUnavailableGuard({ children }: { children: ReactNode }) {
  const wasReady = useRef(false);
  const host = usePluginHost();
  const service = useCapability<StorageRuntimeController>("storage.runtime-controller");
  const healthStatus = (service as unknown as { healthStatus?: () => import("@keymaster/contracts").StorageRuntimeStatus }).healthStatus?.() ?? "degraded";
  const snapshot = useResourceSelector<StorageRuntimeSnapshot, StorageRuntimeSnapshot>(
    host.resourceStore,
    "storage.status",
    [],
    (value) => value.data ?? { status: service.status(), healthStatus, authorityRecovery: (service as typeof service & { authorityRecovery?: () => import("@keymaster/contracts").CoordinatorAuthorityRecovery }).authorityRecovery?.(), summary: null, capabilities: service.getConditionalCapabilities() },
    (left, right) => left.status === right.status && left.healthStatus === right.healthStatus && JSON.stringify(left.authorityRecovery) === JSON.stringify(right.authorityRecovery) && JSON.stringify(left.summary) === JSON.stringify(right.summary) && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
  const ready = snapshot.status === "ready" && snapshot.healthStatus === "ready";
  if (ready) wasReady.current = true;
  if (!wasReady.current && !ready) return <StorageOnboardingPage />;
  return <>{children}</>;
}
