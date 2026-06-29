// packages/plugin-apps/src/AppsPage.tsx
// `/apps` 页面：从 `appsCatalog.json` 读取 app 清单，提供 Open App 入口。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 页面只调 `protocol.service.launchAppView(...)`；**不**直接操作
//     `protocolStorageDb` / `buildAppBootstrapPayload` /
//     `installLauncherBootstrapRegistry` / `window.open` popup URL。
//   - 校验失败的 app 在页面上显示明确错误态；**不**打崩整个 host。
//   - 启动失败按 `LaunchAppViewError.code` 映射到 i18n 文案；
//     **不**直接把 `err.message` 抛给用户（避免把"vault not unlocked"等
//     内部实现细节展示到 UI 上）。
//   - 启动失败一律 fail-closed：抛错，UI 显示错误，不补偿不重试。

import { useState } from "react";
import { useCapability, useI18n, navigateTo } from "@keymaster/runtime";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import {
  LaunchAppViewError,
  PROTOCOL_SERVICE_CAPABILITY,
  type LaunchAppViewErrorCode,
  type LaunchAppViewInput,
  type ProtocolService
} from "@keymaster/contracts";
import { loadCatalog, type AppCatalogEntry } from "./catalog.js";

/**
 * 把 `LaunchAppViewError.code` 映射到 i18n key。
 *
 * 设计缘由：内部 `error.message` 是给开发者 / 日志看的（如
 * "launchAppView: vault not unlocked"），**不**直接展示给用户；UI 按
 * `code` 字段映射到对用户友好的文案（"请先解锁 Keymaster"等）。
 */
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

export function AppsPage() {
  const protocol = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  useI18n().language();
  const validation = loadCatalog();
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

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
      // 按 LaunchAppViewError.code 映射到 i18n 文案；非 typed 错误走 internal。
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

  const goHome = () => navigateTo("/");

  return (
    <div className="apps-page">
      <PageHeader
        title={t("apps.page.title", { defaultValue: "Apps" })}
        description={t("apps.page.description", {
          defaultValue: "Open an app to start a Keymaster Session Window."
        })}
        actions={
          <Button variant="secondary" onClick={goHome}>
            {t("apps.page.backToHome", { defaultValue: "Back to home" })}
          </Button>
        }
      />
      {validation.ok.length === 0 && validation.invalid.length === 0 ? (
        <EmptyState
          title={t("apps.page.empty.title", { defaultValue: "No apps yet" })}
          description={t("apps.page.empty.description", {
            defaultValue: "Apps registered in the catalog will appear here."
          })}
        />
      ) : null}
      <div className="apps-list" data-testid="apps-list">
        {validation.ok.map((entry) => {
          const launching = launchingId === entry.id;
          const errMsg = errorById[entry.id];
          return (
            <div
              key={entry.id}
              className="apps-card"
              data-testid={`apps-card-${entry.id}`}
            >
              <div className="apps-card__title">{entry.name}</div>
              <div className="apps-card__origin" data-testid={`apps-card-origin-${entry.id}`}>
                {entry.appOrigin}
              </div>
              {entry.summary ? (
                <div className="apps-card__summary">{entry.summary}</div>
              ) : null}
              <Button
                onClick={() => void handleOpen(entry)}
                disabled={launching}
                data-testid={`apps-open-${entry.id}`}
              >
                {launching
                  ? t("apps.open.launching", { defaultValue: "Opening…" })
                  : t("apps.open.cta", { defaultValue: "Open App" })}
              </Button>
              {errMsg ? (
                <div className="apps-card__error" data-testid={`apps-card-error-${entry.id}`}>
                  {errMsg}
                </div>
              ) : null}
            </div>
          );
        })}
        {validation.invalid.map((bad, idx) => (
          <div
            key={`bad-${idx}-${bad.id ?? "?"}`}
            className="apps-card apps-card--invalid"
            data-testid={`apps-card-invalid-${idx}`}
          >
            <div className="apps-card__title">
              {bad.id ?? t("apps.invalid.unnamed", { defaultValue: "(invalid app)" })}
            </div>
            <div className="apps-card__error">
              {t("apps.invalid.configError", { defaultValue: "Configuration error: " }) + bad.reason}
            </div>
          </div>
        ))}
        {validation.duplicates.map((dup) => (
          <div
            key={`dup-${dup.id}`}
            className="apps-card apps-card--invalid"
            data-testid={`apps-card-dup-${dup.id}`}
          >
            <div className="apps-card__title">{dup.id}</div>
            <div className="apps-card__error">
              {t("apps.invalid.duplicate", { defaultValue: "Duplicate id, ignored." })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

