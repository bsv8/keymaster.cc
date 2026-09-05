import type { StorageRuntimeController } from "@keymaster/contracts";
import { useCapability, useI18n } from "@keymaster/runtime";
import { StorageProfileEditor } from "./StorageProfileEditor.js";

/** 存储未就绪时的唯一入口；Vault/业务插件不会在这个页面之前启动。 */
export function StorageOnboardingPage() {
  const { t } = useI18n();
  const service = useCapability<StorageRuntimeController>("storage.runtime-controller");
  const hasRetry = typeof (service as StorageRuntimeController & { retry?: () => Promise<unknown> }).retry === "function";
  return (
    <main className="storage-onboarding" data-testid="storage-onboarding">
      <h1>统一存储尚未就绪</h1>
      <p>{t("storage.settings.connectionDescription", { defaultValue: "请先选择并验证统一存储，Vault 和业务数据才会启动。" })}</p>
      {hasRetry ? <button type="button" onClick={() => { void (service as StorageRuntimeController & { retry?: () => Promise<unknown> }).retry?.(); }}>重新探测存储</button> : null}
      <StorageProfileEditor />
    </main>
  );
}
