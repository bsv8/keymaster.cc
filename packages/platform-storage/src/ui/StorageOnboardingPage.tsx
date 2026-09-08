import type { StorageRuntimeController } from "@keymaster/contracts";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import type { StorageRuntimeSnapshot } from "../runtime/storageRuntimeController.js";

/** 已配置存储的恢复页；首次设置由 Web 层 InitialSetupPage 独立负责。 */
export function StorageOnboardingPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const service = useCapability<StorageRuntimeController>("storage.runtime-controller");
  const hasRetry = typeof (service as StorageRuntimeController & { retry?: () => Promise<unknown> }).retry === "function";
  const snapshot = useResourceSelector<StorageRuntimeSnapshot, StorageRuntimeSnapshot>(
    host.resourceStore,
    "storage.status",
    [],
    (value) => value.data ?? { status: service.status(), healthStatus: (service as StorageRuntimeController & { healthStatus?: () => import("@keymaster/contracts").StorageRuntimeStatus }).healthStatus?.(), authorityRecovery: (service as StorageRuntimeController & { authorityRecovery?: () => import("@keymaster/contracts").CoordinatorAuthorityRecovery }).authorityRecovery?.(), summary: null, capabilities: service.getConditionalCapabilities() },
    (left, right) => left.status === right.status && left.healthStatus === right.healthStatus && JSON.stringify(left.authorityRecovery) === JSON.stringify(right.authorityRecovery) && JSON.stringify(left.summary) === JSON.stringify(right.summary) && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
  );
  return (
    <div className="storage-onboarding" data-testid="storage-onboarding">
      <h1>统一存储尚未就绪</h1>
      <p>{t("storage.settings.connectionDescription", { defaultValue: "请先选择并验证统一存储，Vault 和业务数据才会启动。" })}</p>
      {snapshot.authorityRecovery ? (
        <p role="status" data-testid="storage-authority-recovery">
          旧 Coordinator Worker（{snapshot.authorityRecovery.authorityBuildId}）仍有 {snapshot.authorityRecovery.activeIoLeaseCount} 项最终 I/O 未排空（读 {snapshot.authorityRecovery.activeIoOperations.read}，写 {snapshot.authorityRecovery.activeIoOperations.write}），当前不会强制接管。请等待旧操作结束后点击“重试存储连接”。
        </p>
      ) : null}
      {hasRetry ? <button type="button" onClick={() => { void (service as StorageRuntimeController & { retry?: () => Promise<unknown> }).retry?.(); }}>重试存储连接</button> : null}
      <p>需要修改或重新选择桶时，请进入独立的“桶管理”页面。</p>
    </div>
  );
}
