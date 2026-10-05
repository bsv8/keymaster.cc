import { useEffect, useState } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { useStoragePrivateController } from "./StoragePrivateContext.js";
/** Bounded live aggregate; this component never receives a file path or contents. */
export function StorageActivityIndicator() {
  const controller = useStoragePrivateController();
  const { t } = usePluginI18n();
  const [activity, setActivity] = useState(() => controller?.activity?.() ?? { reads: 0, writes: 0 });
  useEffect(() => controller?.subscribe(() => setActivity(controller.activity?.() ?? { reads: 0, writes: 0 })), [controller]);
  return <span className="storage-activity" aria-label={t("storage.activity.title", { defaultValue: "Storage activity" })}>
    <span className={activity.reads ? "storage-activity__read is-active" : "storage-activity__read"} title={t("storage.activity.read", { defaultValue: "Reading" })} aria-label={t(activity.reads ? "storage.activity.reading" : "storage.activity.readIdle", { defaultValue: activity.reads ? "Storage reading" : "Storage reads idle" })} />
    <span className={activity.writes ? "storage-activity__write is-active" : "storage-activity__write"} title={t("storage.activity.write", { defaultValue: "Writing" })} aria-label={t(activity.writes ? "storage.activity.writing" : "storage.activity.writeIdle", { defaultValue: activity.writes ? "Storage writing" : "Storage writes idle" })} />
  </span>;
}
