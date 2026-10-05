import { useEffect, useState } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { useStoragePrivateController } from "./StoragePrivateContext.js";

/** 既有存储状态的只读展示，服务只从 Storage 自己的 Context 取得。 */
export function StorageStatusBlock() {
  const controller = useStoragePrivateController();
  const { t } = usePluginI18n();
  const status = usePrivateStatus(controller);
  return <section className="system-settings-page__group" aria-label={t("storage.status.title", { defaultValue: "Local storage" })}>
    <h2>{t("storage.status.title", { defaultValue: "Local storage" })}</h2>
    <p>{t("storage.status.medium", { defaultValue: "Wallet data is kept in this browser only." })}</p>
    <p>{t(`storage.status.${status ?? "degraded"}`, { defaultValue: status ?? "Unavailable" })}</p>
  </section>;
}

function usePrivateStatus(controller: import("@keymaster/contracts").StorageRuntimeController | undefined) {
  const [status, setStatus] = useState(() => controller?.status());
  useEffect(() => controller?.subscribe(() => setStatus(controller.status())), [controller]);
  return status;
}
