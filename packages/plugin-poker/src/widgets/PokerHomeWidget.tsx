// packages/plugin-poker/src/widgets/PokerHomeWidget.tsx
// Home widget：展示连接状态 + 在线 player 数。
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
    return () => { off(); offP(); };
  }, [service]);

  if (!service) {
    return (
      <div className="poker-home-widget">
        <p>{t("poker.home.empty")}</p>
        <p>{t("poker.home.connectHint")}</p>
      </div>
    );
  }
  return (
    <div className="poker-home-widget">
      <h3>{t("poker.home.title")}</h3>
      <p>{t(`poker.status.${status}`)}</p>
      <p>{t("poker.home.presences")}: {count}</p>
    </div>
  );
}
