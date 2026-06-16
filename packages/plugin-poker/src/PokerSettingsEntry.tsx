// packages/plugin-poker/src/PokerSettingsEntry.tsx
// /settings 聚合页中的 Poker 入口 section。
//
// 设计缘由（硬切换 002 唯一结论）：
//   - Poker 不是字段配置；完整配置项（endpoint / 双平面 / fallback /
//     identity / diag）只能在 /settings/poker 这一份业务页上编辑。
//   - 但 plugin-poker 是业务插件，应该在启用时出现在 /settings 聚合页
//     中，给用户一个明确入口。本组件是聚合页里 Poker 的"轻量入口"：
//     只显示简介、当前连接状态、当前 identity 状态和一个跳转按钮。
//   - 任何时候都不承载 endpoint / identity 等业务字段编辑器，避免
//     "聚合页字段版"与 "/settings/poker 完整版"两套真值并存。
//   - 组件由 settings.registry.registerPage 装配到 SettingsPage 渲染；
//     plugin 禁用时随 owner 一起回收，热消失。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@keymaster/ui";
import { router, useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerIdentityBindingState,
  type PokerService
} from "@keymaster/contracts";

function statusClass(s: PokerConnectionStatus): string {
  return `poker-settings-entry__status-badge poker-settings-entry__status-badge--${s}`;
}

export function PokerSettingsEntry(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [status, setStatus] = useState<PokerConnectionStatus>("idle");
  const [binding, setBinding] = useState<PokerIdentityBindingState>(null);

  useEffect(() => {
    if (!service) return;
    setStatus(service.status());
    setBinding(service.getIdentityBinding());
    const offStatus = service.onStatusChange((next) => setStatus(next));
    const offBinding = service.onIdentityBindingChange((b) => setBinding(b));
    return () => {
      offStatus();
      offBinding();
    };
  }, [service]);

  const goToPokerSettings = () => {
    router.push("/settings/poker");
  };

  if (!service) {
    return (
      <div className="poker-settings-entry poker-settings-entry--empty">
        <p className="poker-settings-entry__line">{t("poker.entry.noService", { defaultValue: "Poker service not available" })}</p>
        <Button size="sm" variant="ghost" onClick={goToPokerSettings}>
          {t("poker.entry.openSettings", { defaultValue: "Open Poker settings" })}
        </Button>
      </div>
    );
  }

  const statusKey = `poker.status.${status}`;

  return (
    <div className="poker-settings-entry">
      <p className="poker-settings-entry__line">
        <span className="poker-settings-entry__label">{t("poker.entry.statusLabel", { defaultValue: "Status" })}</span>
        <span className={statusClass(status)}>{t(statusKey, { defaultValue: status })}</span>
      </p>
      <p className="poker-settings-entry__line">
        <span className="poker-settings-entry__label">{t("poker.entry.identityLabel", { defaultValue: "Identity" })}</span>
        <span
          className={
            binding
              ? "poker-settings-entry__identity poker-settings-entry__identity--bound"
              : "poker-settings-entry__identity poker-settings-entry__identity--unbound"
          }
        >
          {binding
            ? `${t("poker.settings.identity.bound", { defaultValue: "Bound to" })}: ${binding.label}`
            : t("poker.settings.identity.unbound", { defaultValue: "No poker identity bound (fail-closed)" })}
        </span>
      </p>
      <p className="poker-settings-entry__summary">
        {t("poker.entry.summary", { defaultValue: "Poker entry section — opens the full configuration page." })}
      </p>
      <div className="poker-settings-entry__actions">
        <Button size="sm" onClick={goToPokerSettings}>
          {t("poker.entry.openSettings", { defaultValue: "Open Poker settings" })}
        </Button>
      </div>
    </div>
  );
}
