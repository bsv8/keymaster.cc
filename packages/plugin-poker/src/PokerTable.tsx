// packages/plugin-poker/src/PokerTable.tsx
// 单桌视图：从 route param 拿 tableId，订阅 topic。
//
// 设计缘由：
//   - 硬切换文档验收清单要求 "host / join table 后能进入局内视图"；本
//     期仅完成 topic 订阅与 frame 接收骨架，详细牌局逻辑留到后续硬切换。
//   - 硬切换 002：使用 @keymaster/ui 的 PageHeader / EmptyState；本视图
//     是当前阶段的协议页，不强装成完整牌桌。layout 走 poker-table* 专
//     属 CSS。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, PageHeader } from "@keymaster/ui";
import { router, useCapability } from "@keymaster/runtime";
import { useParams } from "react-router";
import { POKER_SERVICE_CAPABILITY, type PokerService } from "@keymaster/contracts";

export function PokerTable(): React.ReactElement {
  const { t } = useTranslation("poker");
  const { tableId } = useParams<{ tableId: string }>();
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [joined, setJoined] = useState(false);
  const [frames, setFrames] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!service || !tableId) return;
    let cancelled = false;
    setError(null);
    void service
      .subscribeTopics([tableId])
      .then(() => {
        if (!cancelled) setJoined(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    const off = service.onTxEvent(() => {
      setFrames((n) => n + 1);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [service, tableId]);

  if (!tableId) {
    return (
      <div className="poker-table poker-table--empty">
        <PageHeader
          title={t("poker.table.title", { defaultValue: "Poker table" })}
        />
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
              defaultValue: "Protocol-only view. Game-state rendering will land in a later hard switch."
            })}
          </p>
        </section>
      </div>
    </div>
  );
}
