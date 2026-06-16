// packages/plugin-poker/src/PokerLobby.tsx
// 扑克大厅：展示当前 online presence 与已 observe 到的桌列表。
//
// 设计缘由：
//   - 硬切换 004：presences / tables 必须只反映当前 active key 对应会话
//     观察到的数据。切 active key 后旧列表应立即清空或切到新 key hydrate
//     后的列表；不允许短暂显示旧 key 的桌局。
//   - service 切 key 时已主动清空 in-memory presences / tables；本组件
//     只需订阅 service 的 onPresenceChange / onTablesChange，列表会自动
//     跟随切换。
//   - all 模式 / vault locked / 未就绪 → 显示只读提示而不是"未连接"。
//   - 硬切换 002：使用 @keymaster/ui 的 PageHeader / EmptyState 原子
//     组件，layout 走 poker-lobby* 专属 CSS（不再依赖 apps/web 全局
//     样式）。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { router, useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerService,
  type PokerPresence,
  type PokerSessionKeyState,
  type PokerTable
} from "@keymaster/contracts";

export function PokerLobby(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [presences, setPresences] = useState<PokerPresence[]>(() =>
    service ? service.listPresences() : []
  );
  const [tables, setTables] = useState<PokerTable[]>(() => (service ? service.listTables() : []));
  const [session, setSession] = useState<PokerSessionKeyState>(() =>
    service ? service.getActivePokerKey() : { kind: "vaultLocked" }
  );

  useEffect(() => {
    if (!service) return;
    const offP = service.onPresenceChange(() => setPresences(service.listPresences()));
    const offT = service.onTablesChange((next) => setTables(next));
    const offS = service.onActivePokerKeyChange((next) => {
      setSession(next);
      // 切 key 时 service 已清空内存 cache；这里再读一次以保证 UI 与
      // service 完全一致（哪怕 service 未来在某些路径只通知不清理）。
      setPresences(service.listPresences());
      setTables(service.listTables());
    });
    return () => {
      offP();
      offT();
      offS();
    };
  }, [service]);

  if (!service) {
    return (
      <div className="poker-lobby poker-lobby--empty">
        <PageHeader
          title={t("poker.lobby.title", { defaultValue: "Poker lobby" })}
          description={t("poker.lobby.description", {
            defaultValue:
              "Tables and online players observed by the local poker-proxy connection."
          })}
        />
        <EmptyState
          title={t("poker.home.empty", { defaultValue: "Not connected" })}
          description={t("poker.home.connectHint", {
            defaultValue: "Open Poker settings to configure the proxy endpoint."
          })}
        />
      </div>
    );
  }

  // session 不可用 → 显示降级提示（不展示旧桌局数据）。
  if (session.kind !== "ready") {
    return (
      <div className="poker-lobby poker-lobby--empty">
        <PageHeader
          title={t("poker.lobby.title", { defaultValue: "Poker lobby" })}
          description={t("poker.lobby.description", {
            defaultValue:
              "Tables and online players observed by the local poker-proxy connection."
          })}
        />
        <EmptyState
          title={t(`poker.lobby.sessionUnavailable.${session.kind}.title`, {
            defaultValue: t("poker.lobby.sessionUnavailable.default.title", {
              defaultValue: "Poker session unavailable"
            })
          })}
          description={t(`poker.lobby.sessionUnavailable.${session.kind}.hint`, {
            defaultValue: t("poker.lobby.sessionUnavailable.default.hint", {
              defaultValue:
                "Switch to a single active key to see tables and online players."
            })
          })}
        />
      </div>
    );
  }

  return (
    <div className="poker-lobby">
      <PageHeader
        title={t("poker.lobby.title", { defaultValue: "Poker lobby" })}
        description={t("poker.lobby.description", {
          defaultValue:
            "Tables and online players observed by the local poker-proxy connection."
        })}
      />
      <div className="poker-lobby__panes">
        <section className="poker-lobby__pane poker-lobby__pane--tables">
          <h2>{t("poker.lobby.tables", { defaultValue: "Tables" })}</h2>
          {tables.length === 0 ? (
            <EmptyState
              title={t("poker.lobby.noTables", { defaultValue: "No tables yet" })}
              description={t("poker.lobby.noTablesHint", {
                defaultValue:
                  "Tables appear here once a host announces them on the proxy."
              })}
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
              description={t("poker.lobby.noPresencesHint", {
                defaultValue:
                  "Online players will show up once the proxy connection is established."
              })}
            />
          ) : (
            <ul className="poker-lobby__presence-list">
              {presences.map((p) => (
                <li key={p.publicKeyHex} className="poker-lobby__presence">
                  <span className="poker-lobby__presence-nick">
                    {p.nick ?? p.publicKeyHex.slice(0, 8)}
                  </span>
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
