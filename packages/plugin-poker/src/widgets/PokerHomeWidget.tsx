// packages/plugin-poker/src/widgets/PokerHomeWidget.tsx
// Home widget：展示连接状态 + 在线 player 数 + active key 提示。
//
// 设计缘由（硬切换 004）：
//   - 旧 widget 在 binding 解绑时显示"未绑定"。现在 binding 概念已删
//     除，改为显示当前 active key 状态：all 模式 / vault locked / 未就绪
//     时分别给出对应提示，而不是显示笼统的"未连接"。
//   - active key 切换时 widget 状态必须跟随新 session；不允许展示旧
//     key 的"在线玩家"计数。
//   - 硬切换 002：使用 home-widget / home-widget__head / home-widget__status
//     这套共享 class，业务专属细节走 poker-home-widget* 修饰类。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerService,
  type PokerSessionKeyState
} from "@keymaster/contracts";

export function PokerHomeWidget(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [status, setStatus] = useState<PokerConnectionStatus>("idle");
  const [count, setCount] = useState(0);
  const [session, setSession] = useState<PokerSessionKeyState>(() =>
    service ? service.getActivePokerKey() : { kind: "vaultLocked" }
  );

  useEffect(() => {
    if (!service) return;
    const off = service.onStatusChange((next) => setStatus(next));
    setCount(service.listPresences().length);
    const offP = service.onPresenceChange(() => setCount(service.listPresences().length));
    const offS = service.onActivePokerKeyChange((next) => {
      setSession(next);
      // 切 key 后 service 已清空内存 presences；这里再读一次保证 UI 一致。
      setCount(service.listPresences().length);
    });
    return () => {
      off();
      offP();
      offS();
    };
  }, [service]);

  const sessionHintKey = `poker.home.sessionUnavailable.${session.kind}`;
  const sessionHint = t(sessionHintKey, {
    defaultValue: t("poker.home.empty", { defaultValue: "Not connected" })
  });

  return (
    <div className="home-widget poker-home-widget">
      <header className="home-widget__head">
        <h3>{t("poker.home.title", { defaultValue: "Poker" })}</h3>
        <span className={`poker-home-widget__status-badge poker-home-widget__status-badge--${status}`}>
          {t(`poker.status.${status}`, { defaultValue: status })}
        </span>
      </header>
      {!service ? (
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
          {sessionHint}
          <span className="poker-home-widget__hint-sub">
            {t("poker.home.sessionUnavailable.subHint", {
              defaultValue:
                "Poker needs a single active key. Switch back from all-keys mode or unlock the vault."
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
            <span>{t("poker.home.activeKey", { defaultValue: "Active key" })}</span>
            <span className="addr">
              <code>
                {session.key.label} · {(session.key.publicKeyHex ?? "").slice(0, 12)}…
              </code>
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}
