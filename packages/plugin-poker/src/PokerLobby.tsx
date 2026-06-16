// packages/plugin-poker/src/PokerLobby.tsx
// 扑克大厅：展示当前 online presence 与已 observe 到的桌列表。
//
// 设计缘由：
//   - 硬切换文档要求 "不变量 6：plugin-poker 不能把 poker 的网络会话
//     状态放进 apps/web 的全局 React state 里乱传"。本页面只读
//     PokerService 暴露的 listPresences / listTables，不维护本地副
//     本；订阅由 PokerService 内部 handler 维护。
//   - 状态为空时不渲染报错：硬切换文档要求 "fallback broadcast 到来的
//     raw tx 不会导致 UI 崩溃；识别不了的 tx 被安全忽略"。本页面也
//     同样：proxy 未连接时只显示"未连接"占位。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCapability } from "@keymaster/runtime";
import { POKER_SERVICE_CAPABILITY, type PokerService, type PokerPresence, type PokerTable } from "@keymaster/contracts";

export function PokerLobby(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [presences, setPresences] = useState<PokerPresence[]>(() => service ? service.listPresences() : []);
  const [tables, setTables] = useState<PokerTable[]>(() => service ? service.listTables() : []);

  useEffect(() => {
    if (!service) return;
    const offP = service.onPresenceChange(() => setPresences(service.listPresences()));
    const offT = service.onTablesChange((next) => setTables(next));
    return () => { offP(); offT(); };
  }, [service]);

  if (!service) {
    return <div className="poker-empty">{t("poker.home.empty")}</div>;
  }

  return (
    <div className="poker-lobby">
      <h1>{t("poker.lobby.title")}</h1>
      <section>
        <h2>{t("poker.lobby.presences")}</h2>
        {presences.length === 0 ? <p>{t("poker.lobby.noPresences")}</p> : (
          <ul>
            {presences.map((p) => (
              <li key={p.publicKeyHex}>{p.nick ?? p.publicKeyHex.slice(0, 8)}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>{t("poker.lobby.tables")}</h2>
        {tables.length === 0 ? <p>{t("poker.lobby.noTables")}</p> : (
          <ul>
            {tables.map((tbl) => (
              <li key={tbl.tableId}>{tbl.tableId} · {tbl.variant} · p{tbl.seats}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
