// packages/plugin-poker/src/widgets/PokerHomeWidget.tsx
// Home widget：展示连接状态 + 在线 player 数。
//
// 设计缘由（硬切换 002）：
//   - 平台已提供 home-widget 壳层（apps/web/src/styles/global.css），
//     其他 widget 都复用这套语义。Poker widget 直接输出了
//     "poker-home-widget" 自造壳，导致视觉与首页其它 widget 撕裂。
//   - 现在改用 home-widget / home-widget__head / home-widget__status 这
//     些共享 class，业务专属的细节（连接状态、presence 计数、空状态引导）
//     走 poker-home-widget* 修饰类。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerService
} from "@keymaster/contracts";

export function PokerHomeWidget(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [status, setStatus] = useState<PokerConnectionStatus>("idle");
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!service) return;
    const off = service.onStatusChange((next) => setStatus(next));
    setCount(service.listPresences().length);
    const offP = service.onPresenceChange(() => setCount(service.listPresences().length));
    return () => {
      off();
      offP();
    };
  }, [service]);

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
            {t("poker.home.connectHint", { defaultValue: "Open Poker settings to configure the proxy endpoint." })}
          </span>
        </p>
      ) : (
        <ul className="home-widget__list poker-home-widget__list">
          <li>
            <span>{t("poker.home.presences", { defaultValue: "Online players" })}</span>
            <span className="addr">{count}</span>
          </li>
        </ul>
      )}
    </div>
  );
}
