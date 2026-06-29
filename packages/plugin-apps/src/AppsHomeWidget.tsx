// packages/plugin-apps/src/AppsHomeWidget.tsx
// 首页 widget：展示前 3 张 app 卡片 + 跳转 `/apps` 入口。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 与 `/apps` 页面**共用**同一份 `appsCatalog.json` 与同一个
//     `protocol.service.launchAppView(...)` 调用；
//   - 不维护第二套启动逻辑、不维护第二套字段映射；
//   - 只展示前 3 条，UI 提示"more"；
//   - 启动失败按 `LaunchAppViewError.code` 映射到 i18n 文案，**不**直接
//     暴露 `err.message` 给用户。

import { useState } from "react";
import { useCapability, useI18n, navigateTo } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import {
  LaunchAppViewError,
  PROTOCOL_SERVICE_CAPABILITY,
  type LaunchAppViewErrorCode,
  type LaunchAppViewInput,
  type ProtocolService
} from "@keymaster/contracts";
import { loadCatalog, type AppCatalogEntry } from "./catalog.js";

const HOME_WIDGET_PREVIEW_LIMIT = 3;

/** 与 AppsPage 同步：把 LaunchAppViewError.code 映射到 i18n key。 */
function errorMessageKey(code: LaunchAppViewErrorCode | null): string {
  switch (code) {
    case "vault_locked":
      return "apps.open.error.vaultLocked";
    case "no_active_key":
      return "apps.open.error.noActiveKey";
    case "invalid_app_config":
      return "apps.open.error.invalidAppConfig";
    case "window_unavailable":
      return "apps.open.error.windowUnavailable";
    case "session_storage_unavailable":
      return "apps.open.error.sessionStorageUnavailable";
    case "export_unlock_runtime_failed":
      return "apps.open.error.exportUnlockRuntimeFailed";
    case "open_session_window_failed":
      return "apps.open.error.openSessionWindowFailed";
    case "open_session_window_blocked":
      return "apps.open.error.openSessionWindowBlocked";
    case "internal_error":
    default:
      return "apps.open.error.internal";
  }
}

export function AppsHomeWidget() {
  const protocol = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  useI18n().language();
  const validation = loadCatalog();
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  const visible = validation.ok.slice(0, HOME_WIDGET_PREVIEW_LIMIT);
  const hasMore = validation.ok.length > HOME_WIDGET_PREVIEW_LIMIT;

  const handleOpen = async (entry: AppCatalogEntry) => {
    if (launchingId) return;
    setLaunchingId(entry.id);
    setErrorById((m) => {
      const { [entry.id]: _omit, ...rest } = m;
      void _omit;
      return rest;
    });
    try {
      const input: LaunchAppViewInput = {
        appId: entry.id,
        appOrigin: entry.appOrigin,
        appUrl: entry.appUrl,
        claims: entry.claims
      };
      await protocol.launchAppView(input);
    } catch (err) {
      const code =
        err instanceof LaunchAppViewError
          ? err.code
          : "internal_error";
      const message = t(errorMessageKey(code), {
        defaultValue: t("apps.open.error.internal", { defaultValue: "Failed to open the app." })
      });
      setErrorById((m) => ({ ...m, [entry.id]: message }));
    } finally {
      setLaunchingId(null);
    }
  };

  const openAll = () => navigateTo("/apps");

  return (
    <div className="apps-home-widget" data-testid="apps-home-widget">
      <div className="apps-home-widget__title">
        {t("apps.widget.title", { defaultValue: "Apps" })}
      </div>
      {visible.length === 0 ? (
        <div className="apps-home-widget__empty">
          {t("apps.widget.empty", { defaultValue: "No apps registered yet." })}
        </div>
      ) : (
        <ul className="apps-home-widget__list">
          {visible.map((entry) => {
            const launching = launchingId === entry.id;
            const errMsg = errorById[entry.id];
            return (
              <li
                key={entry.id}
                className="apps-home-widget__row"
                data-testid={`apps-home-row-${entry.id}`}
              >
                <div className="apps-home-widget__row-name">{entry.name}</div>
                <Button
                  onClick={() => void handleOpen(entry)}
                  disabled={launching}
                  data-testid={`apps-home-open-${entry.id}`}
                >
                  {launching
                    ? t("apps.open.launching", { defaultValue: "Opening…" })
                    : t("apps.open.cta", { defaultValue: "Open App" })}
                </Button>
                {errMsg ? (
                  <div className="apps-home-widget__row-error" data-testid={`apps-home-error-${entry.id}`}>
                    {errMsg}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore ? (
        <Button variant="ghost" onClick={openAll}>
          {t("apps.widget.viewAll", { defaultValue: "View all apps" })}
        </Button>
      ) : null}
    </div>
  );
}

