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
//   - 会话不可用时显示业务结果，不在 Poker 页面暴露系统内部状态名称。
//   - 硬切换 002：使用 @keymaster/ui 的 PageHeader / EmptyState 原子
//     组件，layout 走 poker-lobby* 专属 CSS（不再依赖 apps/web 全局
//     样式）。

import React from "react";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { router, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import {
  formatShortPublicKey,
  type PokerPresence,
  type PokerSessionKeyState,
  type PokerTable
} from "@keymaster/contracts";

export function PokerLobby(): React.ReactElement {
  const { t } = useI18n();
  const host = usePluginHost();
  const presences = useResourceSelector<PokerPresence[], PokerPresence[]>(host.resourceStore, "poker.presences", [], (s) => s.data ?? []);
  const tables = useResourceSelector<PokerTable[], PokerTable[]>(host.resourceStore, "poker.tables", [], (s) => s.data ?? []);
  const session = useResourceSelector<PokerSessionKeyState, PokerSessionKeyState>(host.resourceStore, "poker.session", [], (s) => s.data ?? ({ kind: "vaultLocked" } as PokerSessionKeyState));

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
              defaultValue: "Poker is currently unavailable"
            })
          })}
          description={t(`poker.lobby.sessionUnavailable.${session.kind}.hint`, {
            defaultValue: t("poker.lobby.sessionUnavailable.default.hint", {
              defaultValue: "The current session is unavailable."
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
                    {p.nick ?? formatShortPublicKey(p.publicKeyHex)}
                  </span>
                  <span className="poker-lobby__presence-pubkey">
                    <code>{formatShortPublicKey(p.publicKeyHex)}</code>
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
