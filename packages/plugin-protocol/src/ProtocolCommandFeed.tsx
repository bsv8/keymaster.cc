// packages/plugin-protocol/src/ProtocolCommandFeed.tsx
// popup 命令流 feed 组件（单列流 + 多活动卡片）。
//
// 设计缘由（施工单 2026-06-27 001 硬切换：锁屏 + 多 request 并存 +
// 全局串行执行）：
//   - 不再有"全局当前 request"概念；多张 `confirming` / `queued` /
//     `executing` 卡片可同时存在。
//   - 每张卡片按自己的 `recordId` 调 service 交互 API
//     （`confirmByUser(recordId)` / `rejectByUser(recordId)`）。
//   - 每张 `confirming` 卡独立显示倒计时（deadline 由 service 按
//     recordId 暴露）。
//   - 历史卡片保持只读 summary；不允许出现"对历史 request 再点确认"。
//   - `queued` 显示"已确认，等待执行"。
//   - `executing` 显示"处理中"。
//   - `timed_out` 单独显示"超时"（与 `failed` 平级）。
//   - auto-approve 命中时 card.autoApproved=true，body 显示
//     "自动通过 / 处理中"，没有确认按钮。
//   - 视图层**不**参与 service 业务：所有状态都通过 props 传入。

import { useEffect, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import type {
  CipherDecryptParams,
  CipherEncryptParams,
  FeepoolCommitParams,
  FeepoolPrepareParams,
  IdentityGetParams,
  IntentSignParams,
  MethodParams,
  P2pkhTransferParams,
  ProtocolCommandFeedState,
  ProtocolCommandRecord,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";

/* ============== 公开 props ============== */

export interface ProtocolCommandFeedProps {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  feed: ProtocolCommandFeedState;
  service: ProtocolService;
  snap: ProtocolSessionSnapshot;
  /** 当前 wall-clock（epoch ms）；由父组件 1s 滴答推进；用于倒计时渲染。 */
  now: number;
}

const DECISION_LABEL_KEY: Record<ProtocolCommandRecord["decision"], string> = {
  pending: "protocol.feed.decision.pending",
  approved: "protocol.feed.decision.approved",
  rejected: "protocol.feed.decision.rejected",
  failed: "protocol.feed.decision.failed"
};

export function ProtocolCommandFeed(props: ProtocolCommandFeedProps) {
  const { t, feed } = props;
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
  const historyWarning = !feed.historyAvailable ? (
    <div className="protocol-feed__notice protocol-feed__notice--warn">
      {t("protocol.feed.historyUnavailable", {
        defaultValue: "历史不可用：本地数据库读取失败。当前命令仍可正常执行，但不会持久化。"
      })}
    </div>
  ) : null;
  if (!feed.commands.length) {
    return (
      <div className="protocol-feed protocol-feed--no-history">
        {historyWarning}
      </div>
    );
  }
  if (historyWarning) {
    return (
      <div className="protocol-feed protocol-feed--no-history">
        {historyWarning}
        <FeedList {...props} />
      </div>
    );
  }
  return <FeedList {...props} />;
}

function FeedList(props: ProtocolCommandFeedProps) {
  const { t, feed } = props;
  return (
    <ul className="protocol-feed__list" aria-label={t("protocol.feed.list.aria", { defaultValue: "命令流历史" })}>
      {feed.commands.map((c, i) => (
        <CommandCard
          key={c.id}
          t={t}
          command={c}
          initiallyExpanded={i === 0}
          service={props.service}
          now={props.now}
        />
      ))}
    </ul>
  );
}

/**
 * 单张命令卡：按 record.id 独立交互；不再假设"最新一张才是活卡"。
 */
function CommandCard({
  t,
  command,
  initiallyExpanded,
  service,
  now
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  command: ProtocolCommandRecord;
  initiallyExpanded: boolean;
  service: ProtocolService;
  now: number;
}) {
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);
  const decisionKey = DECISION_LABEL_KEY[command.decision];
  const decisionLabel = t(decisionKey, { defaultValue: command.decision });
  // 终态：status = "timed_out" 单独显示"超时"文案。
  const statusLabel =
    command.status === "timed_out"
      ? t("protocol.feed.status.timed_out", { defaultValue: "超时" })
      : command.status;
  const cardClass = [
    "protocol-feed__card",
    `protocol-feed__card--${command.decision}`,
    `protocol-feed__card--phase-${command.phase}`
  ].join(" ");
  return (
    <li
      className={cardClass}
      data-record-id={command.id}
      data-status={command.status}
      data-phase={command.phase}
    >
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
        {command.status === "timed_out" ? (
          <span className="protocol-feed__card-status protocol-feed__card-status--timed_out">
            {statusLabel}
          </span>
        ) : null}
        {command.phase === "queued" ? (
          <span className="protocol-feed__card-status protocol-feed__card-status--queued">
            {t("protocol.feed.status.queued", { defaultValue: "已确认，等待执行" })}
          </span>
        ) : null}
        {command.phase === "executing" ? (
          <span className="protocol-feed__card-status protocol-feed__card-status--executing">
            {t("protocol.feed.status.executing", { defaultValue: "处理中" })}
          </span>
        ) : null}
        {command.phase === "waiting_unlock_manual" ? (
          <span className="protocol-feed__card-status protocol-feed__card-status--waiting_unlock">
            {t("protocol.feed.status.waiting_unlock_manual", { defaultValue: "等待解锁（人工）" })}
          </span>
        ) : null}
        {command.phase === "waiting_unlock_auto" ? (
          <span className="protocol-feed__card-status protocol-feed__card-status--waiting_unlock">
            {t("protocol.feed.status.waiting_unlock_auto", { defaultValue: "等待解锁（自动）" })}
          </span>
        ) : null}
        <span className="protocol-feed__card-time">
          {new Date(command.updatedAt).toLocaleString()}
        </span>
      </button>
      {expanded ? (
        <div className="protocol-feed__card-body">
          <CardBody
            t={t}
            command={command}
            service={service}
            now={now}
          />
        </div>
      ) : null}
    </li>
  );
}

/* ============== 卡片 body：按 phase 渲染交互体 ============== */

function CardBody({
  t,
  command,
  service,
  now
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  command: ProtocolCommandRecord;
  service: ProtocolService;
  now: number;
}) {
  // 历史卡片：只读 summary。
  const isTerminal =
    command.decision === "approved" ||
    command.decision === "rejected" ||
    command.decision === "failed";
  if (isTerminal) {
    return <ReadOnlyBody t={t} command={command} />;
  }

  if (command.phase === "waiting_unlock_manual") {
    return (
      <WaitingUnlockCardBody
        t={t}
        command={command}
      />
    );
  }
  if (command.phase === "waiting_unlock_auto") {
    return (
      <WaitingUnlockAutoCardBody t={t} command={command} />
    );
  }
  if (command.phase === "confirming") {
    return (
      <ConfirmCardBody
        t={t}
        command={command}
        service={service}
        now={now}
      />
    );
  }
  if (command.phase === "queued") {
    return <QueuedCardBody t={t} command={command} service={service} />;
  }
  if (command.phase === "executing") {
    return <ExecutingCardBody t={t} command={command} />;
  }
  return <ReadOnlyBody t={t} command={command} />;
}

/* ============== 等待解锁（人工确认） ============== */

function WaitingUnlockCardBody({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  return (
    <>
      <PageHeader
        title={t("protocol.feed.waitingUnlock.title", { defaultValue: "等待解锁" })}
        description={t("protocol.feed.waitingUnlock.manualDesc", {
          defaultValue: "此请求需要解锁 Keymaster。解锁后会进入确认页。"
        })}
      />
      <RequestSummary t={t} command={command} />
    </>
  );
}

function WaitingUnlockAutoCardBody({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  return (
    <>
      <PageHeader
        title={t("protocol.feed.waitingUnlock.title", { defaultValue: "等待解锁" })}
        description={t("protocol.feed.waitingUnlock.autoDesc", {
          defaultValue: "此请求会在解锁后自动执行。"
        })}
      />
      <RequestSummary t={t} command={command} />
    </>
  );
}

/* ============== 确认卡（解锁后人工确认阶段） ============== */

function ConfirmCardBody({
  t,
  service,
  command,
  now
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  service: ProtocolService;
  command: ProtocolCommandRecord;
  now: number;
}) {
  const deadline = service.confirmDeadlineMs(command.id);
  const remainingSeconds = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <>
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t(`protocol.confirm.method.${command.method}`, { defaultValue: command.method })}
      />
      <ConfirmDetails t={t} command={command} />
      <div className="protocol-popup__actions">
        <Button onClick={() => service.confirmByUser(command.id)}>
          {t("protocol.confirm.confirm", { defaultValue: "确认" })}
        </Button>
        <Button
          variant="ghost"
          onClick={() => service.rejectByUser(command.id)}
        >
          {t("protocol.confirm.cancel", { defaultValue: "取消" })}
        </Button>
        <CountdownBadge t={t} remainingSeconds={remainingSeconds} />
      </div>
    </>
  );
}

/* ============== queued 卡（已确认，等待执行） ============== */

function QueuedCardBody({
  t,
  command,
  service
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
  service: ProtocolService;
}) {
  return (
    <>
      <PageHeader
        title={t("protocol.feed.queued.title", { defaultValue: "已确认，等待执行" })}
        description={t(`protocol.confirm.method.${command.method}`, { defaultValue: command.method })}
      />
      <RequestSummary t={t} command={command} />
      <div className="protocol-popup__actions">
        <Button variant="ghost" onClick={() => service.rejectByUser(command.id)}>
          {t("protocol.feed.queued.cancel", { defaultValue: "取消排队" })}
        </Button>
      </div>
    </>
  );
}

/* ============== 执行中卡 ============== */

function ExecutingCardBody({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  return (
    <>
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t("protocol.executing", { defaultValue: "处理中…" })}
      />
      <RequestSummary t={t} command={command} />
    </>
  );
}

/* ============== 只读 summary（历史卡片 + 终态卡片） ============== */

function ReadOnlyBody({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  return (
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
      {command.recipientAddress ? (
        <>
          <dt>{t("protocol.feed.recipient", { defaultValue: "收款地址" })}</dt>
          <dd>
            <code>{command.recipientAddress}</code>
          </dd>
        </>
      ) : null}
      {command.amountSatoshis !== undefined ? (
        <>
          <dt>{t("protocol.feed.amount", { defaultValue: "金额" })}</dt>
          <dd>
            <code>{command.amountSatoshis}</code> sats
          </dd>
        </>
      ) : null}
      {command.action ? (
        <>
          <dt>{t("protocol.feed.action", { defaultValue: "动作" })}</dt>
          <dd>
            <code>{command.action}</code>
          </dd>
        </>
      ) : null}
      {command.counterpartyPublicKeyHex ? (
        <>
          <dt>{t("protocol.feed.counterparty", { defaultValue: "对端公钥" })}</dt>
          <dd>
            <code>
              {command.counterpartyPublicKeyHex.length > 30
                ? `${command.counterpartyPublicKeyHex.slice(0, 14)}…${command.counterpartyPublicKeyHex.slice(-12)}`
                : command.counterpartyPublicKeyHex}
            </code>
          </dd>
        </>
      ) : null}
      {command.operationId ? (
        <>
          <dt>{t("protocol.feed.operationId", { defaultValue: "操作 id" })}</dt>
          <dd>
            <code>{command.operationId}</code>
          </dd>
        </>
      ) : null}
      {command.autoApproved ? (
        <>
          <dt>{t("protocol.feed.autoApproved", { defaultValue: "自动通过" })}</dt>
          <dd>
            <code>yes</code>
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
      {command.failureReason ? (
        <>
          <dt>{t("protocol.feed.failureReason", { defaultValue: "本地失败原因" })}</dt>
          <dd>
            <code>{command.failureReason}</code>
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
  );
}

/* ============== 倒计时 badge ============== */

function CountdownBadge({
  t,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  remainingSeconds: number | null;
}) {
  if (remainingSeconds === null) return null;
  return (
    <span className="protocol-popup__countdown" aria-live="polite">
      {t("protocol.countdown.remaining", {
        defaultValue: `剩余 ${remainingSeconds} 秒`,
        seconds: remainingSeconds
      })}
    </span>
  );
}

/* ============== 命令摘要 ============== */

function RequestSummary({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  return (
    <dl className="protocol-popup__list">
      <dt>{t("protocol.feed.method", { defaultValue: "方法" })}</dt>
      <dd>
        <code>{command.method}</code>
      </dd>
      <dt>{t("protocol.feed.origin", { defaultValue: "来源站点" })}</dt>
      <dd>
        <code>{command.origin}</code>
      </dd>
      {command.textSummary ? (
        <>
          <dt>{t("protocol.feed.text", { defaultValue: "提示文案" })}</dt>
          <dd>{command.textSummary}</dd>
        </>
      ) : null}
    </dl>
  );
}

/* ============== 确认详情（方法特定） ============== */

function ConfirmDetails({
  t,
  command
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
}) {
  // 历史持久化的 command 不带 params（安全），所以读 params 的 detail 路径
  // 仅适用于活跃卡。这里直接复用 summary 文本与摘要字段。
  const params = command as unknown as { params?: Record<string, unknown> };
  const p = (params.params ?? {}) as Record<string, unknown>;
  const method = command.method;
  const aud = (p.aud as string | undefined) ?? null;
  const text = (p.text as string | undefined) ?? "";
  const claims = Array.isArray(p.claims)
    ? (p.claims as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const iat = (p.iat as number | undefined) ?? undefined;
  const exp = (p.exp as number | undefined) ?? undefined;
  const contentType = (p.contentType as string | undefined) ?? undefined;
  const contentField = p.content as { bytes?: { byteLength?: number } } | undefined;
  const cipherField = p.cipherbytes as { bytes?: { byteLength?: number } } | undefined;
  const contentBytes =
    typeof contentField?.bytes?.byteLength === "number"
      ? contentField.bytes.byteLength
      : typeof cipherField?.bytes?.byteLength === "number"
      ? cipherField.bytes.byteLength
      : 0;
  return (
    <>
      <RequestSummary t={t} command={command} />
      <dl className="protocol-popup__list">
        {aud ? (
          <>
            <dt>{t("protocol.confirm.origin", { defaultValue: "来源站点" })}</dt>
            <dd>
              <code>{aud}</code>
            </dd>
          </>
        ) : null}
        {text ? (
          <>
            <dt>{t("protocol.confirm.text", { defaultValue: "提示文案" })}</dt>
            <dd>{text}</dd>
          </>
        ) : null}
        {claims.length > 0 ? (
          <>
            <dt>{t("protocol.confirm.claims", { defaultValue: "请求的 claims" })}</dt>
            <dd>
              <ul>
                {claims.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {contentType ? (
          <>
            <dt>{t("protocol.confirm.contentType", { defaultValue: "内容类型" })}</dt>
            <dd>
              <code>{contentType}</code>（{contentBytes} bytes）
            </dd>
          </>
        ) : null}
        {iat !== undefined && exp !== undefined ? (
          <>
            <dt>{t("protocol.confirm.window", { defaultValue: "有效期" })}</dt>
            <dd>
              <code>
                {iat} → {exp}
              </code>
            </dd>
          </>
        ) : null}
        {command.recipientAddress ? (
          <>
            <dt>{t("protocol.confirm.p2pkh.recipient", { defaultValue: "收款地址" })}</dt>
            <dd>
              <code>{command.recipientAddress}</code>
            </dd>
          </>
        ) : null}
        {command.amountSatoshis !== undefined ? (
          <>
            <dt>{t("protocol.confirm.p2pkh.amount", { defaultValue: "金额" })}</dt>
            <dd>
              <code>{command.amountSatoshis}</code> sats
            </dd>
          </>
        ) : null}
        {method.startsWith("feepool.") && command.counterpartyPublicKeyHex ? (
          <>
            <dt>{t("protocol.confirm.feepool.counterparty", { defaultValue: "对端公钥" })}</dt>
            <dd>
              <code>{shortHex(command.counterpartyPublicKeyHex, 12)}</code>
            </dd>
          </>
        ) : null}
      </dl>
    </>
  );
}

/** 截短 hex 显示（feepool 公钥 66 字符太长）。 */
function shortHex(hex: string, head: number): string {
  if (hex.length <= head * 2 + 3) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-head)}`;
}