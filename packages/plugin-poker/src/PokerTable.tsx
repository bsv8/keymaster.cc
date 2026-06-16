// packages/plugin-poker/src/PokerTable.tsx
// 单桌视图：从 route param 拿 tableId，订阅 topic。
//
// 设计缘由：硬切换文档验收清单要求 "host / join table 后能进入局内
// 视图"；本期仅完成 topic 订阅与 frame 接收骨架，详细牌局逻辑留到后
// 续硬切换。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useCapability } from "@keymaster/runtime";
import { POKER_SERVICE_CAPABILITY, type PokerService } from "@keymaster/contracts";

export function PokerTable(): React.ReactElement {
  const { t } = useTranslation("poker");
  const { tableId } = useParams<{ tableId: string }>();
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [joined, setJoined] = useState(false);
  const [frames, setFrames] = useState<number>(0);

  useEffect(() => {
    if (!service || !tableId) return;
    let cancelled = false;
    void service.subscribeTopics([tableId]).then(() => {
      if (!cancelled) setJoined(true);
    });
    const off = service.onTxEvent(() => {
      setFrames((n) => n + 1);
    });
    return () => { cancelled = true; off(); };
  }, [service, tableId]);

  if (!tableId) {
    return <div className="poker-table-empty">{t("poker.err.notReady")}</div>;
  }

  return (
    <div className="poker-table">
      <h1>{t("poker.table.title")}</h1>
      <p>{t("poker.table.topic")}: <code>{tableId}</code></p>
      {!joined ? <p>{t("poker.table.notJoined")}</p> : null}
      <p>tx events: {frames}</p>
    </div>
  );
}
