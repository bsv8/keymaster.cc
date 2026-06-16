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
//   - 硬切换 002：使用 @keymaster/ui 的 PageHeader / EmptyState 原
//     子组件，layout 走 poker-lobby* 专属 CSS（不再依赖 apps/web 全局
//     样式）。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { router, useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerService,
  type PokerPresence,
  type PokerTable
} from "@keymaster/contracts";

export function PokerLobby(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [presences, setPresences] = useState<PokerPresence[]>(() => (service ? service.listPresences() : []));
  const [tables, setTables] = useState<PokerTable[]>(() => (service ? service.listTables() : []));

  useEffect(() => {
    if (!service) return;
    const offP = service.onPresenceChange(() => setPresences(service.listPresences()));
    const offT = service.onTablesChange((next) => setTables(next));
    return () => {
      offP();
      offT();
    };
  }, [service]);

  if (!service) {
    return (
      <div className="poker-lobby poker-lobby--empty">
        <PageHeader
          title={t("poker.lobby.title", { defaultValue: "Poker lobby" })}
          description={t("poker.lobby.description", { defaultValue: "Tables and online players observed by the local poker-proxy connection." })}
        />
        <EmptyState
          title={t("poker.home.empty", { defaultValue: "Not connected" })}
          description={t("poker.home.connectHint", { defaultValue: "Open Poker settings to configure the proxy endpoint." })}
        />
      </div>
    );
  }

  return (
    <div className="poker-lobby">
      <PageHeader
        title={t("poker.lobby.title", { defaultValue: "Poker lobby" })}
        description={t("poker.lobby.description", { defaultValue: "Tables and online players observed by the local poker-proxy connection." })}
      />
      <div className="poker-lobby__panes">
        <section className="poker-lobby__pane poker-lobby__pane--tables">
          <h2>{t("poker.lobby.tables", { defaultValue: "Tables" })}</h2>
          {tables.length === 0 ? (
            <EmptyState
              title={t("poker.lobby.noTables", { defaultValue: "No tables yet" })}
              description={t("poker.lobby.noTablesHint", { defaultValue: "Tables appear here once a host announces them on the proxy." })}
            />
          ) : (
            <ul className="poker-lobby__list">
              {tables.map((tbl) => (
                <li key={tbl.tableId} className="poker-lobby__item">
                  <button
                    type="button"
                    className="poker-lobby__item-link"
                    onClick={() => router.push(`/poker/table/${encodeURIComponent(tbl.tableId)}`)}
                  >
                    <span className="poker-lobby__item-id">
                      <code>{tbl.tableId}</code>
                    </span>
                    <span className="poker-lobby__item-meta">
                      <span>{tbl.variant}</span>
                      <span>p{tbl.seats}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="poker-lobby__pane poker-lobby__pane--presences">
          <h2>{t("poker.lobby.presences", { defaultValue: "Online players" })}</h2>
          {presences.length === 0 ? (
            <EmptyState
              title={t("poker.lobby.noPresences", { defaultValue: "Nobody online" })}
              description={t("poker.lobby.noPresencesHint", { defaultValue: "Online players will show up once the proxy connection is established." })}
            />
          ) : (
            <ul className="poker-lobby__presence-list">
              {presences.map((p) => (
                <li key={p.publicKeyHex} className="poker-lobby__presence">
                  <span className="poker-lobby__presence-nick">{p.nick ?? p.publicKeyHex.slice(0, 8)}</span>
                  <span className="poker-lobby__presence-pubkey">
                    <code>{p.publicKeyHex.slice(0, 16)}…</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
