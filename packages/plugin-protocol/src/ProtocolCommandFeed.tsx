// packages/plugin-protocol/src/ProtocolCommandFeed.tsx
// popup 命令流 feed 组件（单列流 + sticky 顶栏）。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流）：
//   - 最新命令永远在最上面；按 `updatedAt desc` 排序；
//   - 最新命令默认展开，历史命令默认折叠；
//   - 点击卡片可展开/折叠；
//   - 新命令出现时自动滚回顶部（页面层控制）；
//   - 历史不可用时显示顶部提示（status bar）；
//   - 单页 + 一个 feed 组件，不拆更碎。
//
// 视图层**不**参与 service 业务：所有状态都通过 props 传入。

import { useState } from "react";
import type { ProtocolCommandFeedState, ProtocolCommandRecord } from "@keymaster/contracts";

export interface ProtocolCommandFeedProps {
  t: (key: string, values?: { defaultValue?: string }) => string;
  feed: ProtocolCommandFeedState;
}

const DECISION_LABEL_KEY: Record<ProtocolCommandRecord["decision"], string> = {
  pending: "protocol.feed.decision.pending",
  approved: "protocol.feed.decision.approved",
  rejected: "protocol.feed.decision.rejected",
  failed: "protocol.feed.decision.failed"
};

export function ProtocolCommandFeed({ t, feed }: ProtocolCommandFeedProps) {
  if (!feed.currentOrigin) {
    return (
      <div className="protocol-feed protocol-feed--empty">
        <p className="protocol-feed__hint">
          {t("protocol.feed.empty.waitingOrigin", {
            defaultValue: "等待来自外部站点的第一条请求。命令历史会按该站点的 origin 归档。"
          })}
        </p>
      </div>
    );
  }
  if (!feed.historyAvailable) {
    return (
      <div className="protocol-feed protocol-feed--no-history">
        <div className="protocol-feed__notice protocol-feed__notice--warn">
          {t("protocol.feed.historyUnavailable", {
            defaultValue: "历史不可用：本地数据库读取失败。当前命令仍可正常执行，但不会持久化。"
          })}
        </div>
        <FeedList t={t} commands={feed.commands} />
      </div>
    );
  }
  if (feed.commands.length === 0) {
    return (
      <div className="protocol-feed protocol-feed--empty">
        <p className="protocol-feed__hint">
          {t("protocol.feed.empty", {
            defaultValue: "当前站点尚无命令历史。第一条请求完成后会出现在这里。"
          })}
        </p>
      </div>
    );
  }
  return <FeedList t={t} commands={feed.commands} />;
}

function FeedList({
  t,
  commands
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  commands: ProtocolCommandRecord[];
}) {
  return (
    <ul className="protocol-feed__list" aria-label={t("protocol.feed.list.aria", { defaultValue: "命令流历史" })}>
      {commands.map((c, i) => (
        <CommandCard key={c.id} t={t} command={c} initiallyExpanded={i === 0} />
      ))}
    </ul>
  );
}

function CommandCard({
  t,
  command,
  initiallyExpanded
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
  initiallyExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);
  const decisionKey = DECISION_LABEL_KEY[command.decision];
  const decisionLabel = t(decisionKey, { defaultValue: command.decision });
  return (
    <li className={`protocol-feed__card protocol-feed__card--${command.decision}`} data-record-id={command.id}>
      <button
        type="button"
        className="protocol-feed__card-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="protocol-feed__card-method">
          <code>{command.method}</code>
        </span>
        <span className={`protocol-feed__card-decision protocol-feed__card-decision--${command.decision}`}>
          {decisionLabel}
        </span>
        <span className="protocol-feed__card-time">
          {new Date(command.updatedAt).toLocaleString()}
        </span>
      </button>
      {expanded ? (
        <div className="protocol-feed__card-body">
          <dl>
            <dt>{t("protocol.feed.origin", { defaultValue: "来源站点" })}</dt>
            <dd>
              <code>{command.origin}</code>
            </dd>
            <dt>{t("protocol.feed.requestId", { defaultValue: "请求 id" })}</dt>
            <dd>
              <code>{command.requestId}</code>
            </dd>
            {command.textSummary ? (
              <>
                <dt>{t("protocol.feed.text", { defaultValue: "提示文案" })}</dt>
                <dd>{command.textSummary}</dd>
              </>
            ) : null}
            {command.claimsSummary.length > 0 ? (
              <>
                <dt>{t("protocol.feed.claims", { defaultValue: "请求的 claims" })}</dt>
                <dd>
                  <ul>
                    {command.claimsSummary.map((c) => (
                      <li key={c}>
                        <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
            {command.contentType ? (
              <>
                <dt>{t("protocol.feed.contentType", { defaultValue: "内容类型" })}</dt>
                <dd>
                  <code>{command.contentType}</code>（{command.payloadSize} bytes）
                </dd>
              </>
            ) : null}
            <dt>{t("protocol.feed.activeKey", { defaultValue: "签名公钥" })}</dt>
            <dd>
              <code>{command.activePublicKeyHex || "n/a"}</code>
            </dd>
            {command.errorCode ? (
              <>
                <dt>{t("protocol.feed.error", { defaultValue: "错误" })}</dt>
                <dd>
                  <code>{command.errorCode}</code>: {command.errorMessage}
                </dd>
              </>
            ) : null}
            <dt>{t("protocol.feed.timeline", { defaultValue: "时间" })}</dt>
            <dd>
              created: {new Date(command.createdAt).toLocaleString()}
              <br />
              updated: {new Date(command.updatedAt).toLocaleString()}
              {command.finishedAt > 0 ? (
                <>
                  <br />
                  finished: {new Date(command.finishedAt).toLocaleString()}
                </>
              ) : null}
            </dd>
          </dl>
        </div>
      ) : null}
    </li>
  );
}
