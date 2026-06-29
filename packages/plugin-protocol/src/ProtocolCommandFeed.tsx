// packages/plugin-protocol/src/ProtocolCommandFeed.tsx
// popup 命令流 feed 组件（活请求区 + 历史区 两段渲染）。
//
// 设计缘由（施工单 2026-06-27 002 硬切换：活请求区固定槽位 +
// 历史区分离 + 同类请求不复用卡位）：
//   - 活请求区：未终态 request（waiting_unlock_manual / waiting_unlock_auto /
//     confirming / queued / executing），按 service 投影的 `commands`
//     前段（createdAt asc，recordId 次级稳定）渲染。
//   - 历史区：终态 request（approved / rejected / failed / timed_out），
//     按 service 投影的 `commands` 后段（updatedAt desc）渲染。
//   - 两个区块有明确视觉分组（活请求区视觉重点突出；历史区视觉弱化）。
//   - 活请求卡**全部默认展开**，并按 `recordId` 稳定绑定展开态。
//   - 历史卡默认折叠，用户手动展开看详情；不允许出现确认 / 取消按钮。
//   - 不再用 `i === 0` 决定唯一展开卡——活请求卡按 recordId 独立状态。
//   - 视图层**不**参与 service 业务：所有状态都通过 props 传入；不做
//     任何排序、不做 id 去重、不改写任何 record。

import { useState } from "react";
import { Button, PageHeader } from "@keymaster/ui";
import type {
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

const DECISION_LABEL_KEY: Record<Exclude<ProtocolCommandRecord["decision"], "rejected">, string> = {
  pending: "protocol.feed.decision.pending",
  approved: "protocol.feed.decision.approved",
  failed: "protocol.feed.decision.failed"
};

/**
 * rejected 终态在 popup 内部要尽量反映本地真相：
 *   - user_canceled：用户本地点取消；
 *   - client_canceled：client web 发 cancel 命中；
 *   - 旧记录 / 其它未知值：回退到通用"已拒绝"。
 */
function decisionLabelForCommand(
  command: ProtocolCommandRecord,
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string
): string {
  if (command.decision === "rejected") {
    if (command.failureReason === "user_canceled") {
      return t("protocol.feed.decision.rejected.user_canceled", {
        defaultValue: "你已取消"
      });
    }
    if (command.failureReason === "client_canceled") {
      return t("protocol.feed.decision.rejected.client_canceled", {
        defaultValue: "对方主动取消"
      });
    }
    return t("protocol.feed.decision.rejected", { defaultValue: "已拒绝" });
  }
  const decisionKey = DECISION_LABEL_KEY[command.decision];
  const defaultValue =
    command.decision === "pending"
      ? "等待"
      : command.decision === "approved"
      ? "已批准"
      : "执行失败";
  return t(decisionKey, { defaultValue });
}

/**
 * 顶层：根据 service 投影的 `commands` 把活请求区 / 历史区分别渲染。
 *
 * service 已按"活请求区 createdAt asc + 历史区 updatedAt desc"投影；
 * 本组件只负责分两段渲染，**不**再做排序。
 */
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
  const split = splitFeedByTerminal(feed.commands);
  return (
    <div className="protocol-feed">
      {historyWarning}
      {split.live.length > 0 ? (
        <FeedSection
          kind="live"
          t={t}
          commands={split.live}
          service={props.service}
          now={props.now}
          defaultExpanded
        />
      ) : null}
      {split.history.length > 0 ? (
        <FeedSection
          kind="history"
          t={t}
          commands={split.history}
          service={props.service}
          now={props.now}
          defaultExpanded={false}
        />
      ) : null}
    </div>
  );
}

/**
 * 把 service 投影后的 commands 拆为活请求区 + 历史区。
 *
 * 注意：这里不**重排**——service 已经按"活请求区 + 历史区"投影好；
 * 只按 phase 是否终态切片分组。终态判定与 service 的 `isTerminalPhase`
 * 保持一致。
 */
function splitFeedByTerminal(commands: ProtocolCommandRecord[]): {
  live: ProtocolCommandRecord[];
  history: ProtocolCommandRecord[];
} {
  const live: ProtocolCommandRecord[] = [];
  const history: ProtocolCommandRecord[] = [];
  for (const c of commands) {
    if (isTerminalPhase(c.phase)) history.push(c);
    else live.push(c);
  }
  return { live, history };
}

function isTerminalPhase(phase: ProtocolCommandRecord["phase"]): boolean {
  return (
    phase === "approved" ||
    phase === "rejected" ||
    phase === "failed" ||
    phase === "timed_out"
  );
}

/* ============== 区块（活请求区 / 历史区） ============== */

/**
 * 单个区块（活请求区或历史区）。
 *
 * 设计要点：
 *   - 区块标题清楚区分"待处理请求"vs"历史"。
 *   - 区块内的卡片都用 `CommandCard`，但用 `kind` 控制默认展开态 +
 *     区块样式（活请求卡视觉重点突出，历史卡视觉弱化）。
 *   - 区块标题挂 `id` 给顶栏"回到最新"锚点用。
 */
function FeedSection({
  kind,
  t,
  commands,
  service,
  now,
  defaultExpanded
}: {
  kind: "live" | "history";
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  commands: ProtocolCommandRecord[];
  service: ProtocolService;
  now: number;
  defaultExpanded: boolean;
}) {
  const sectionClass = `protocol-feed__section protocol-feed__section--${kind}`;
  const title =
    kind === "live"
      ? t("protocol.feed.section.live", { defaultValue: "待处理请求" })
      : t("protocol.feed.section.history", { defaultValue: "历史" });
  const anchorId = kind === "live" ? "protocol-feed-live-top" : "protocol-feed-history-top";
  return (
    <section className={sectionClass} aria-label={title}>
      <h2 className="protocol-feed__section-title" id={anchorId}>
        {title}
        <span className="protocol-feed__section-count">
          <code>{commands.length}</code>
        </span>
      </h2>
      <ul className="protocol-feed__list">
        {commands.map((c) => (
          <CommandCard
            key={c.id}
            t={t}
            command={c}
            initiallyExpanded={defaultExpanded}
            service={service}
            now={now}
            kind={kind}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * 单张命令卡：按 record.id 独立交互；不再假设"最新一张才是活卡"。
 *
 * 活请求区 / 历史区共用同一个组件，区别：
 *   - 活请求区：默认展开，按 recordId 稳定 key；卡片内可呈现
 *     `confirming` / `waiting_unlock_*` / `queued` / `executing` 的交互体。
 *   - 历史区：默认折叠；卡片内只显示 summary，不显示交互按钮。
 */
function CommandCard({
  t,
  command,
  initiallyExpanded,
  service,
  now,
  kind
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  command: ProtocolCommandRecord;
  initiallyExpanded: boolean;
  service: ProtocolService;
  now: number;
  kind: "live" | "history";
}) {
  // 展开态**必须**按 recordId 稳定绑定：组件 key={c.id} 由 React 保证，
  // 这里只在自己状态机内维护 expanded 布尔值。
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);
  const decisionLabel = decisionLabelForCommand(command, t);
  // 终态：status = "timed_out" 单独显示"超时"文案。
  const statusLabel =
    command.status === "timed_out"
      ? t("protocol.feed.status.timed_out", { defaultValue: "超时" })
      : command.status;
  const cardClass = [
    "protocol-feed__card",
    `protocol-feed__card--${command.decision}`,
    `protocol-feed__card--phase-${command.phase}`,
    kind === "history" ? "protocol-feed__card--history" : "protocol-feed__card--live"
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
            kind={kind}
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
  now,
  kind
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  command: ProtocolCommandRecord;
  service: ProtocolService;
  now: number;
  kind: "live" | "history";
}) {
  // 历史区块的卡片：直接走只读 summary，不显示任何交互按钮。
  if (kind === "history") {
    return <ReadOnlyBody t={t} command={command} />;
  }
  // 活请求区块内，终态卡片虽然被划到 history 段，但 service 内部终态
  // 路径里仍可能短暂进入活请求区（state 推进的中间瞬间）。这种卡也
  // 走只读 summary——交互已不可用。
  if (
    command.decision === "approved" ||
    command.decision === "rejected" ||
    command.decision === "failed"
  ) {
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
      {/* 施工单 2026-06-28 002 硬切换：owner 唯一真值 = `ownerPublicKeyHex`。
          业务方法（除 connect.login）展示"该 request 所属 session owner 公钥"；
          connect.login 记录上 ownerPublicKeyHex 在用户点确认时落定。 */}
      <dt>{t("protocol.feed.ownerKey", { defaultValue: "owner 公钥" })}</dt>
      <dd>
        <code>{command.ownerPublicKeyHex || "n/a"}</code>
      </dd>
      {command.connectSessionId ? (
        <>
          <dt>{t("protocol.feed.connectSessionId", { defaultValue: "session id" })}</dt>
          <dd>
            <code>{command.connectSessionId}</code>
          </dd>
        </>
      ) : null}
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
          <dt>{t("protocol.feed.failureReason", { defaultValue: "本地原因" })}</dt>
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
