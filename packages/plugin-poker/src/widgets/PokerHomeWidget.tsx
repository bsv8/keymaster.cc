// packages/plugin-poker/src/widgets/PokerHomeWidget.tsx
// Home widget：展示连接状态 + 在线 player 数 + 当前扑克身份。
//
// 设计缘由（硬切换 004）：
//   - 旧 widget 在 binding 解绑时显示"未绑定"。现在 binding 概念已删
//     除；当会话不可用时只显示业务结果"扑克当前不可用"，不暴露 active key /
//     vault locked 这类系统内部概念。
//   - 会话切换时 widget 状态必须跟随新 session；不允许展示旧
//     key 的"在线玩家"计数。
//   - 硬切换 002：使用 home-widget / home-widget__head / home-widget__status
//     这套共享 class，业务专属细节走 poker-home-widget* 修饰类。

import React from "react";
import { countRender, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import {
  formatShortPublicKey,
  type PokerConnectionStatus,
  type PokerSessionKeyState
} from "@keymaster/contracts";

export function PokerHomeWidget(): React.ReactElement {
  countRender("plugin-poker/PokerHomeWidget");
  const { t } = useI18n();
  const host = usePluginHost();
  const status = useResourceSelector<PokerConnectionStatus, PokerConnectionStatus>(host.resourceStore, "poker.connection", [], (s) => s.data ?? "idle");
  const session = useResourceSelector<PokerSessionKeyState, PokerSessionKeyState>(host.resourceStore, "poker.session", [], (s) => s.data ?? ({ kind: "vaultLocked" } as PokerSessionKeyState));
  const count = useResourceSelector<unknown[], number>(host.resourceStore, "poker.presences", [], (s) => s.data?.length ?? 0);

  return (
    <div className="home-widget poker-home-widget">
      <header className="home-widget__head">
        <h3>{t("poker.home.title", { defaultValue: "Poker" })}</h3>
        <span className={`poker-home-widget__status-badge poker-home-widget__status-badge--${status}`}>
          {t(`poker.status.${status}`, { defaultValue: status })}
        </span>
      </header>
      {session.kind === "vaultLocked" ? (
        <p className="home-widget__status poker-home-widget__hint">
          {t("poker.home.empty", { defaultValue: "Not connected" })}
          <span className="poker-home-widget__hint-sub">
            {t("poker.home.connectHint", {
              defaultValue: "Open Poker settings to configure the proxy endpoint."
            })}
          </span>
        </p>
      ) : session.kind !== "ready" ? (
        <p className="home-widget__status poker-home-widget__hint">
          {t("poker.home.unavailable", {
            defaultValue: "Poker is currently unavailable."
          })}
          <span className="poker-home-widget__hint-sub">
            {t("poker.home.unavailableHint", {
              defaultValue: "The current session is unavailable."
            })}
          </span>
        </p>
      ) : (
        <ul className="home-widget__list poker-home-widget__list">
          <li>
            <span>{t("poker.home.presences", { defaultValue: "Online players" })}</span>
            <span className="addr">{count}</span>
          </li>
          <li>
            <span>{t("poker.home.identity", { defaultValue: "Current poker identity" })}</span>
            <span className="addr">
              <code>
                {session.key.label} · {formatShortPublicKey(session.key.publicKeyHex)}
              </code>
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}
