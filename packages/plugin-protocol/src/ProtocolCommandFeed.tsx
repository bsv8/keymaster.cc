// packages/plugin-protocol/src/ProtocolCommandFeed.tsx
// popup 命令流 feed 组件（单列流 + sticky 顶栏）。
//
// 设计缘由（施工单 003 硬切换：confirm 收口到历史卡 + 外部 cancel + 超时）：
//   - 当前请求的交互**只**在最新卡片里呈现：解锁表单 / 确认按钮 / 取消
//     按钮 / 倒计时都内联在卡片 body。
//   - 历史卡片保持只读 summary；不允许出现第二套"当前请求" UI。
//   - 同一时刻最多一张"活"卡片可交互（事实上就是最新一张）。
//   - 终态：`approved` / `rejected` / `failed` / `timed_out` 走同一个
//     decision 渲染分支；`status = "timed_out"` 单独显示"超时"文案。
//   - auto-approve 命中时 currentRequestAutoApproved() === true，卡片仍
//     渲染但 body 显示"自动通过 / 处理中"，没有确认按钮。
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
  ProtocolSessionPhase,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { useCapability } from "@keymaster/runtime";

/* ============== 公开 props ============== */

export interface ProtocolCommandFeedProps {
  t: (key: string, values?: { defaultValue?: string }) => string;
  feed: ProtocolCommandFeedState;
  service: ProtocolService;
  snap: ProtocolSessionSnapshot;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null;
  /** 剩余秒数（service 倒计时推算）；null = 没在计时。 */
  remainingSeconds: number | null;
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
  // 历史不可用时**始终**显示顶部横幅——即便内存里已经有当前命令卡，
  // 也必须告诉用户"本次操作不会持久化"。原先把 `!feed.commands.length`
  // 叠加在判断里会让"内存有卡 + DB 不可用"这种最需要提示的场景被
  // 静默吞掉。
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
  // 最新命令 = feed.commands[0]（service 已按 updatedAt desc 排序）。
  const head = feed.commands[0];
  const isHeadLive =
    !!head &&
    !!props.snap.requestId &&
    !!props.snap.boundOrigin &&
    head.requestId === props.snap.requestId;
  return (
    <ul className="protocol-feed__list" aria-label={t("protocol.feed.list.aria", { defaultValue: "命令流历史" })}>
      {feed.commands.map((c, i) => (
        <CommandCard
          key={c.id}
          t={t}
          command={c}
          initiallyExpanded={i === 0}
          // 仅当本卡片就是当前正在处理的 request 时才走交互视图。
          isLive={isHeadLive && i === 0}
          service={props.service}
          snap={props.snap}
          request={props.request}
          remainingSeconds={props.remainingSeconds}
        />
      ))}
    </ul>
  );
}

function CommandCard({
  t,
  command,
  initiallyExpanded,
  isLive,
  service,
  snap,
  request,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
  initiallyExpanded: boolean;
  isLive: boolean;
  service: ProtocolService;
  snap: ProtocolSessionSnapshot;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null;
  remainingSeconds: number | null;
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
    isLive ? "protocol-feed__card--live" : ""
  ].join(" ");
  return (
    <li
      className={cardClass}
      data-record-id={command.id}
      data-status={command.status}
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
        <span className="protocol-feed__card-time">
          {new Date(command.updatedAt).toLocaleString()}
        </span>
      </button>
      {expanded ? (
        <div className="protocol-feed__card-body">
          <CardBody
            t={t}
            command={command}
            isLive={isLive}
            service={service}
            snap={snap}
            request={request}
            remainingSeconds={remainingSeconds}
          />
        </div>
      ) : null}
    </li>
  );
}

/* ============== 卡片 body：交互视图（isLive=true）或只读 summary ============== */

function CardBody({
  t,
  command,
  isLive,
  service,
  snap,
  request,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
  isLive: boolean;
  service: ProtocolService;
  snap: ProtocolSessionSnapshot;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null;
  remainingSeconds: number | null;
}) {
  // 历史卡片：只读 summary。
  if (!isLive) {
    return <ReadOnlyBody t={t} command={command} />;
  }
  // 当前正在处理的 request：按 phase 渲染交互体。
  const phase: ProtocolSessionPhase = snap.phase;
  if (phase === "unlocking") {
    return (
      <UnlockCardBody
        t={t}
        service={service}
        command={command}
        remainingSeconds={remainingSeconds}
      />
    );
  }
  if (phase === "executing") {
    return <ExecutingCardBody t={t} command={command} />;
  }
  if (phase === "confirming") {
    return (
      <ConfirmCardBody
        t={t}
        service={service}
        command={command}
        request={request}
        remainingSeconds={remainingSeconds}
      />
    );
  }
  // phase = waiting / closing / error 等：当前 request 实际已不在交互态，
  // 但 command 还在 feed 顶。等 service 推完终态后，这里会切到只读 summary。
  return <ReadOnlyBody t={t} command={command} />;
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

/* ============== 解锁卡 ============== */

function UnlockCardBody({
  t,
  service,
  command,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  service: ProtocolService;
  command: ProtocolCommandRecord;
  remainingSeconds: number | null;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vault = useCapability<{
    status(): "booting" | "uninitialized" | "locked" | "unlocked";
    onStatusChange(handler: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void): () => void;
    unlock(password: string): Promise<void>;
  }>("vault.service");
  useEffect(() => {
    return vault.onStatusChange((s) => {
      if (s === "unlocked") {
        (service as unknown as { resumeAfterUnlock?: () => void }).resumeAfterUnlock?.();
      }
    });
  }, [vault, service]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protocol.unlock.err.failed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  async function cancel() {
    await service.rejectByUser();
  }
  return (
    <>
      <PageHeader
        title={t("protocol.unlock.title", { defaultValue: "解锁后继续" })}
        description={t("protocol.unlock.desc", {
          defaultValue: "此协议请求需要先解锁本地 Vault。解锁成功后请求会自动继续。"
        })}
      />
      <RequestSummary t={t} command={command} />
      <form onSubmit={submit} className="protocol-popup__form">
        <TextInput
          label={t("protocol.unlock.password", { defaultValue: "密码" })}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          error={error ?? undefined}
        />
        <div className="protocol-popup__actions">
          <Button type="submit" loading={busy} disabled={!password}>
            {t("protocol.unlock.submit", { defaultValue: "解锁" })}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t("protocol.unlock.cancel", { defaultValue: "取消" })}
          </Button>
          <CountdownBadge t={t} remainingSeconds={remainingSeconds} />
        </div>
      </form>
    </>
  );
}

/* ============== 确认卡 ============== */

function ConfirmCardBody({
  t,
  service,
  command,
  request,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  service: ProtocolService;
  command: ProtocolCommandRecord;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null;
  remainingSeconds: number | null;
}) {
  if (!request) {
    return null;
  }
  return (
    <>
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t(`protocol.confirm.method.${request.method}`, { defaultValue: request.method })}
      />
      <ConfirmDetails t={t} command={command} request={request} />
      <div className="protocol-popup__actions">
        <Button onClick={() => service.confirmByUser()}>
          {t("protocol.confirm.confirm", { defaultValue: "确认" })}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await service.rejectByUser();
          }}
        >
          {t("protocol.confirm.cancel", { defaultValue: "取消" })}
        </Button>
        <CountdownBadge t={t} remainingSeconds={remainingSeconds} />
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

/* ============== 倒计时 badge ============== */

function CountdownBadge({
  t,
  remainingSeconds
}: {
  t: (key: string, values?: { defaultValue?: string; seconds?: number }) => string;
  remainingSeconds: number | null;
}) {
  if (remainingSeconds === null) return null;
  // i18n key 在 en / zh-CN 资源里都通过 `{{seconds}}` 插值；
  // 关键：把 `seconds` 也传给 i18n service，让有 key 命中的语言
  // 走真正的占位符替换（不是 `defaultValue` 兜底）。否则英文界面
  // 会直接渲染 `"{{seconds}}s remaining"`。
  return (
    <span className="protocol-popup__countdown" aria-live="polite">
      {t("protocol.countdown.remaining", {
        defaultValue: `剩余 ${remainingSeconds} 秒`,
        seconds: remainingSeconds
      })}
    </span>
  );
}

/* ============== 命令摘要（解锁 / 执行中 共享） ============== */

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
  command,
  request
}: {
  t: (key: string, values?: { defaultValue?: string }) => string;
  command: ProtocolCommandRecord;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> };
}) {
  const identity = request.method === "identity.get" ? (request.params as IdentityGetParams) : null;
  const sign = request.method === "intent.sign" ? (request.params as IntentSignParams) : null;
  const enc = request.method === "cipher.encrypt" ? (request.params as CipherEncryptParams) : null;
  const dec = request.method === "cipher.decrypt" ? (request.params as CipherDecryptParams) : null;
  const p2pkh = request.method === "p2pkh.transfer" ? (request.params as P2pkhTransferParams) : null;
  const feepoolPrepare =
    request.method === "feepool.prepare" ? (request.params as FeepoolPrepareParams) : null;
  const feepoolCommit =
    request.method === "feepool.commit" ? (request.params as FeepoolCommitParams) : null;
  const aud = identity?.aud ?? sign?.aud ?? null;
  const text = identity?.text ?? sign?.text ?? enc?.text ?? dec?.text ?? "";
  const claims = identity?.claims ?? [];
  const iat = identity?.iat ?? sign?.iat;
  const exp = identity?.exp ?? sign?.exp;
  const contentType = sign?.contentType ?? enc?.contentType;
  const contentBytes =
    sign?.content?.bytes.byteLength ?? enc?.content?.bytes.byteLength ?? dec?.cipherbytes?.bytes.byteLength ?? 0;
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
        {p2pkh ? (
          <>
            <dt>{t("protocol.confirm.p2pkh.recipient", { defaultValue: "收款地址" })}</dt>
            <dd>
              <code>{p2pkh.recipientAddress}</code>
            </dd>
            <dt>{t("protocol.confirm.p2pkh.amount", { defaultValue: "金额" })}</dt>
            <dd>
              <code>{p2pkh.amountSatoshis}</code> sats
            </dd>
            {p2pkh.feeRateSatoshisPerKb ? (
              <>
                <dt>{t("protocol.confirm.p2pkh.feeRate", { defaultValue: "费率 (sat/kB)" })}</dt>
                <dd>
                  <code>{p2pkh.feeRateSatoshisPerKb}</code>
                </dd>
              </>
            ) : null}
          </>
        ) : null}
        {feepoolPrepare ? (
          <>
            <dt>{t("protocol.confirm.feepool.counterparty", { defaultValue: "对端公钥" })}</dt>
            <dd>
              <code>{shortHex(feepoolPrepare.counterpartyPublicKeyHex, 12)}</code>
            </dd>
            <dt>{t("protocol.confirm.feepool.amount", { defaultValue: "金额" })}</dt>
            <dd>
              <code>{feepoolPrepare.amountSatoshis}</code> sats
            </dd>
          </>
        ) : null}
        {feepoolCommit ? (
          <>
            <dt>{t("protocol.confirm.feepool.operationId", { defaultValue: "操作 id" })}</dt>
            <dd>
              <code>{feepoolCommit.operationId}</code>
            </dd>
            <dt>{t("protocol.confirm.feepool.counterparty", { defaultValue: "对端公钥" })}</dt>
            <dd>
              <code>{shortHex(feepoolCommit.counterpartyPublicKeyHex, 12)}</code>
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