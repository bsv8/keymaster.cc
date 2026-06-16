// packages/plugin-poker/src/PokerTable.tsx
// 单桌视图：从 route param 拿 tableId，订阅 topic。
//
// 设计缘由：
//   - 硬切换文档验收清单要求 "host / join table 后能进入局内视图"；本
//     期仅完成 topic 订阅与 frame 接收骨架，详细牌局逻辑留到后续硬切换。
//   - 硬切换 004：若用户正在桌里时会话身份切换，页面不能假装继续停留
//     在同一玩家身份——合理行为是：
//       * 旧订阅断开；
//       * 页内显示"当前会话已关闭"；
//       * 由用户按新身份重新进入。
//   - 硬切换 002：使用 @keymaster/ui 的 PageHeader / EmptyState；本视图
//     是当前阶段的协议页，不强装成完整牌桌。layout 走 poker-table* 专
//     属 CSS。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, PageHeader } from "@keymaster/ui";
import { router, useCapability } from "@keymaster/runtime";
import { useParams } from "react-router";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerService,
  type PokerSessionKeyState
} from "@keymaster/contracts";

export function PokerTable(): React.ReactElement {
  const { t } = useTranslation("poker");
  const { tableId } = useParams<{ tableId: string }>();
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [joined, setJoined] = useState(false);
  const [frames, setFrames] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<PokerSessionKeyState>(() =>
    service ? service.getActivePokerKey() : { kind: "vaultLocked" }
  );
  /** 当前订阅时锁定的 session key hash；若 activeKey 改变则视为失效。 */
  const [joinedKeyHash, setJoinedKeyHash] = useState<string | null>(null);

  // 会话身份切换时强制收拢：清掉旧订阅，提示用户重新进入。
  useEffect(() => {
    if (!service) return;
    const off = service.onActivePokerKeyChange((next) => {
      setSession(next);
      if (joinedKeyHash) {
        const nextHash =
          next.kind === "ready" ? next.key.publicKeyHash ?? null : null;
        if (nextHash !== joinedKeyHash) {
          setJoinedKeyHash(null);
          setJoined(false);
          setError(
            t("poker.table.sessionClosed", {
              defaultValue:
                "The current session was closed. Please re-enter."
            })
          );
        }
      }
    });
    return () => {
      off();
    };
  }, [service, joinedKeyHash, t]);

  useEffect(() => {
    if (!service || !tableId) return;
    let cancelled = false;
    setError(null);
    // 仅当 session key 可用且 ready 才订阅；其它情况显示降级提示。
    if (session.kind !== "ready") {
      setJoined(false);
      setError(
        t(`poker.table.sessionUnavailable.${session.kind}`, {
          defaultValue: t("poker.table.sessionUnavailable.default", {
            defaultValue: "Poker is currently unavailable."
          })
        })
      );
      return;
    }
    const expectedHash = session.key.publicKeyHash ?? null;
    void service
      .subscribeTopics([tableId])
      .then(() => {
        if (cancelled) return;
        setJoined(true);
        setJoinedKeyHash(expectedHash);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    const off = service.onTxEvent(() => {
      setFrames((n) => n + 1);
    });
    return () => {
      cancelled = true;
      off();
      // 离开桌时主动 unsubscribe，避免残留订阅跨 active key 漂移。
      try {
        void service.unsubscribeTopics([tableId]);
      } catch {
        /* swallow */
      }
    };
  }, [service, tableId, session, t]);

  if (!tableId) {
    return (
      <div className="poker-table poker-table--empty">
        <PageHeader title={t("poker.table.title", { defaultValue: "Poker table" })} />
        <div className="poker-table__error">{t("poker.err.notReady")}</div>
      </div>
    );
  }

  return (
    <div className="poker-table">
      <PageHeader
        title={t("poker.table.title", { defaultValue: "Poker table" })}
        actions={
          <Button size="sm" variant="ghost" onClick={() => router.push("/poker")}>
            {t("poker.table.back", { defaultValue: "Back to lobby" })}
          </Button>
        }
      />
      <div className="poker-table__panes">
        <section className="poker-table__pane poker-table__pane--meta">
          <h2>{t("poker.table.topic", { defaultValue: "Topic" })}</h2>
          <code className="poker-table__topic">{tableId}</code>
          <div className="poker-table__line">
            <span className="poker-table__line-label">
              {t("poker.table.subscribe", { defaultValue: "Subscribe" })}
            </span>
            <span className={`poker-table__state poker-table__state--${joined ? "on" : "off"}`}>
              {joined
                ? t("poker.table.joined", { defaultValue: "Joined" })
                : t("poker.table.notJoined", { defaultValue: "You have not joined this table" })}
            </span>
          </div>
          <div className="poker-table__line">
            <span className="poker-table__line-label">
              {t("poker.table.txEvents", { defaultValue: "Tx events" })}
            </span>
            <span className="poker-table__counter">{frames}</span>
          </div>
          {error ? <div className="poker-table__error">{error}</div> : null}
        </section>
        <section className="poker-table__pane poker-table__pane--frames">
          <h2>{t("poker.table.frames", { defaultValue: "Frames" })}</h2>
          <p className="poker-table__hint">
            {t("poker.table.protocolOnly", {
              defaultValue:
                "Protocol-only view. Game-state rendering will land in a later hard switch."
            })}
          </p>
        </section>
      </div>
    </div>
  );
}
