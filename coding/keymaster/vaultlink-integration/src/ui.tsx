import { playSpendSound } from "./spend-sound.js";
import { useEffect, useId, useRef, useState } from "react";
export { HardwareConnectionPanel } from "./hardware-connection-ui.js";
import { Button } from "@keymaster/ui";
import type { WalletPaymentCommand } from "./wallet-payments.js";
export interface PaymentUIProps {
  execute(command: WalletPaymentCommand): Promise<unknown>;
  text(key: string, fallback: string): string;
}
export { PaymentChannelSettings } from "./payment-channel-settings.js";

interface Pending {
  historyId?: string;
  automatic?: boolean;
  wallet?: string;
  network?: string;
  paymentType?: string;
  businessAmount?: string;
  id: string;
  channelId: string;
  owner: string;
  kind: "app" | "plugin";
  amount: string;
  used: string;
  singleLimit: string;
  sessionLimit: string | null;
  reasons: string[];
  recipients: string[];
  fee: string;
  change: string;
  purpose?: "registration" | "signature";
  operation?: string;
  mode?: string;
  facts?: Record<string, string>;
  pool?: { family: string; stage: string; paid: string; locked: string };
  connectPayment?: {
    appId: string; appName: string; origin: string; publisherPublicKeyHex: string;
    recipientOwnership: "app-publisher" | "third-party" | "unknown";
    paymentType: "p2pkh" | "p2pk"; businessKind: string; recipientLabel: string;
  };
}
function ApprovalRequest({ request, execute, text, onAnswered }: PaymentUIProps & { request: Pending; onAnswered(id: string): void }) {
  const [expanded, setExpanded] = useState(!request.purpose);
  const detailsId = useId();
  const [sound, setSound] = useState("pending");
  const [soundError, setSoundError] = useState("");
  async function soundNotice() {
    setSoundError("");setSound("pending");
    try { await playSpendSound(request.automatic === true);setSound("scheduled"); }
    catch(e) {setSound("unavailable");setSoundError(String(e));}
  }
  useEffect(() => {if(!request.purpose) void soundNotice();}, [request.id]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function answer(allow: boolean) {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await execute({
        action: "answer",
        id: request.id,
        allow,
      });
      onAnswered(request.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const title = request.purpose
    ? text(request.purpose === "registration" ? "signing.register" : "signing.approve",
        request.purpose === "registration" ? "注册签名渠道" : "请求签名授权")
    : request.automatic ? text("payment.automaticNotice", "额度内自动花费签名") : text("payment.spendApproval", "花费签名确认");
  const summary = [title, request.owner, request.channelId, request.purpose ? undefined : `${request.amount} sat`].filter(Boolean).join(" · ");
  return (
    <article className="wallet-notifications__item wallet-notifications__item--pending">
      <h3><button type="button" className="wallet-notifications__summary" aria-expanded={expanded} aria-controls={detailsId}
        title={summary} onClick={() => setExpanded(value => !value)}>
        <span>{summary}</span><span className="wallet-notifications__chevron" aria-hidden="true">▾</span>
      </button></h3>
      {!request.purpose ? <div aria-live="polite">
        {sound === "unavailable" ? <p role="alert">{text("payment.soundUnavailable", "提示音未播放；检查浏览器音频权限或输出设备。签名策略不因此改变。")} {soundError}
          <Button size="sm" onClick={() => void soundNotice()}>{text("payment.retrySound", "重试提示音")}</Button></p> :
          <p role="status">{text(sound === "scheduled" ? "payment.soundScheduled" : "payment.soundPending", sound === "scheduled" ? "已请求播放提示音（不代表实体扬声器已发声）" : "正在请求播放提示音…")}</p>}
      </div> : null}
      <div className="wallet-notifications__actions">
        {request.automatic ? <Button size="sm" variant="ghost" onClick={() => {void execute({action:"notice-dismiss",id:request.id}).then(() => onAnswered(request.id)).catch(e => setError(String(e)));}}>{text("payment.dismissNotice", "关闭提示")}</Button> : <>
          <Button size="sm" disabled={busy} onClick={() => void answer(true)}>{text("notifications.approve", "批准")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>{text("notifications.deny", "不批准")}</Button>
        </>}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {expanded ? <div id={detailsId} className="wallet-notifications__details">
      <p>
        {request.owner} · {request.channelId}
      </p>
      {!request.purpose ? <div><p>{text("payment.wallet", "当前钱包")}: {request.wallet}</p><p>{text("payment.network", "网络")}: {request.network} · {request.paymentType}</p>
        <p>{text("payment.businessAmount", "业务金额（不含矿工费，聪）")}: {request.businessAmount}</p></div> : null}
      {request.connectPayment ? (
        <div>
          <p>{text("payment.app", "App")}: {request.connectPayment.appName} ({request.connectPayment.appId})</p>
          <p style={{ overflowWrap: "anywhere" }}>{text("payment.origin", "调用来源")}: {request.connectPayment.origin}</p>
          <p>{text("payment.type", "支付类型")}: {request.connectPayment.paymentType}</p>
          <p>{text("payment.publisher", "App 发布者公钥")}:  {request.connectPayment.publisherPublicKeyHex}</p>
          <p>{text("payment.businessKind", "业务种类")}: {request.connectPayment.businessKind}</p>
          <p>{text("payment.recipient", "收款材料")}: {request.connectPayment.recipientLabel}</p>
          <p role="alert">
            {request.connectPayment.recipientOwnership === "app-publisher"
              ? text("payment.publisherMatch", "收款脚本对应本 App 已验证发布者公钥；公钥对应不代表用途真实或无风险。")
              : text("payment.thirdParty", "收款方不对应本 App 发布者公钥，无法仅凭 App 身份确认归属，请核实。")}
          </p>
        </div>
      ) : null}
      {request.purpose ? (
        <div>
          <p>
            {request.operation} · {request.mode}
          </p>
          {Object.entries(request.facts ?? {}).map(([k, v]) => (
            <p key={k} style={{ overflowWrap: "anywhere" }}>
              {k}: {v}
            </p>
          ))}
        </div>
      ) : (
        <>
          <p>
            {text("payment.actualSpend", "实际花费（含矿工费，聪）")}：{request.amount}
          </p>
          <p>
            {text("payment.ownReturn", "本钱包所有 P2PKH 返还（聪）")}：{request.change}
          </p>
          <p>
            {text("payment.feeIncluded", "矿工费（聪，已计入实际花费）")}：{request.fee}
          </p>
          {request.pool ? (
            <div>
              <p>
                {text("payment.pool", "费用池")}：
                {request.pool.family === "connect" ? "Connect" : "BitFS"} ·{" "}
                {request.pool.stage === "fund"
                  ? text("payment.poolFund", "资金存入")
                  : text("payment.poolState", "累计状态交易")}
              </p>
              <p>
                {text("payment.poolPaid", "池内累计对外付款（聪）")}：
                {request.pool.paid}
              </p>
              <p>
                {text("payment.poolLocked", "本次存入池内金额（聪）")}：
                {request.pool.locked}
              </p>
            </div>
          ) : null}
          <p>
            {text("payment.single", "单笔免确认额度（聪）")}：
            {request.singleLimit}
          </p>
          <p>
            {request.reasons
              .map((r) =>
                r === "single-limit"
                  ? text("payment.singleExceeded", "超过单笔额度")
                  : text("payment.disabled", "免确认未设置或已关闭"),
              )
              .join("；")}
          </p>
          <p>{text("payment.outputs", "实际交易输出（含找零）")}</p>
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              overflowWrap: "anywhere",
            }}
          >
            {request.recipients.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        </>
      )}
      </div> : null}
    </article>
  );
}

function HistoryNotification({record: r, text, stateText}: {
  record: import("./signature-history.js").SignatureRecord;
  text: PaymentUIProps["text"];
  stateText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const title = r.operation === "signing.register" || r.operation === "payment.register"
    ? text("notifications.registration", "渠道注册") : r.amount !== undefined
      ? text("notifications.payment", "支付请求") : text("notifications.signature", "签名请求");
  const modeText = r.mode === "automatic" ? text("notifications.modeAutomatic", "自动")
    : r.mode === "manual" ? text("notifications.modeManual", "手动")
      : text("notifications.modeUnknown", "方式未报告");
  const resultText = `${stateText} · ${modeText}`;
  const summary = [title, r.owner, r.channelId, r.amount !== undefined ? `${r.amount} sat` : undefined].filter(Boolean).join(" · ");
  return <article className="wallet-notifications__item">
    <h3><button type="button" className="wallet-notifications__summary" title={`${summary} · ${resultText}`} aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(value => !value)}>
      <span>{summary}</span><span className="wallet-notifications__state">{resultText}</span><span className="wallet-notifications__chevron" aria-hidden="true">▾</span>
    </button></h3>
    {expanded ? <div id={detailsId} className="wallet-notifications__details">
      <p>{r.owner} · {r.channelId}</p>
      <p>{r.operation}{r.amount !== undefined ? ` · ${r.amount} sat` : ""}</p>
      <p>{r.backend === "hardware" && r.state === "pending" ? text("notifications.device", "请在 RocKey 上批准或拒绝") : stateText} · {modeText}</p>
      <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time>
    </div> : null}
  </article>;
}

export function PaymentNotificationList({ execute, text, onPending, onSpendNotices, visible = true }: PaymentUIProps & {
  onPending?(ids: string[]): void;
  onSpendNotices?(ids: string[]): void;
  visible?: boolean;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [notices, setNotices] = useState<Pending[]>([]);
  const [history, setHistory] = useState<import("./signature-history.js").SignatureRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const answeredIds = useRef(new Set<string>());
  const notify = useRef(onPending);
  notify.current = onPending;
  const notifySpend = useRef(onSpendNotices);notifySpend.current = onSpendNotices;
  useEffect(() => {
    let live = true, fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [requestsResult, historyResult, noticesResult] = await Promise.allSettled([execute({ action: "pending" }), execute({ action: "signature-history" }), execute({action:"spend-notices"})]);
        if (!live) return;
        const errors: string[] = [];
        if (requestsResult.status === "fulfilled" && Array.isArray(requestsResult.value)) {
          const incoming = requestsResult.value as Pending[];
          const incomingIds = new Set(incoming.map(r => r.id));
          for (const id of answeredIds.current) if (!incomingIds.has(id)) answeredIds.current.delete(id);
          const requests = incoming.filter(r => !answeredIds.current.has(r.id));
          setPending(requests);
          const hardwareIds = historyResult.status === "fulfilled" && Array.isArray(historyResult.value)
            ? historyResult.value.filter(r => r.backend === "hardware" && r.state === "pending").map(r => r.id) : [];
          notify.current?.([...requests.map(r => r.id), ...hardwareIds]);
        } else errors.push(requestsResult.status === "rejected" ? String(requestsResult.reason) : "invalid-pending-list");
        if (historyResult.status === "fulfilled" && Array.isArray(historyResult.value)) setHistory(historyResult.value);
        else errors.push(historyResult.status === "rejected" ? String(historyResult.reason) : "invalid-notification-history");
        if(noticesResult.status === "fulfilled" && Array.isArray(noticesResult.value)) {setNotices(noticesResult.value);notifySpend.current?.(noticesResult.value.map(r => r.id));}
        else errors.push(noticesResult.status === "rejected" ? String(noticesResult.reason) : "invalid-spend-notices");
        setError(errors.join("; "));
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
      finally { fetching = false; if (live) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => { live = false; clearInterval(timer); };
  }, [execute]);
  const activeHistory = new Set([...pending,...notices].map(r => r.historyId).filter(Boolean));
  const records = history.filter(r => !activeHistory.has(r.id));
  const states = {
    pending: text("notifications.processing", "正在处理"), completed: text("notifications.approved", "已批准"),
    denied: text("notifications.denied", "已拒绝"), cancelled: text("notifications.cancelled", "已取消"),
    failed: text("notifications.failed", "失败"), unknown: text("notifications.unknown", "结果未知"),
  };
  return <section className="wallet-notifications" hidden={!visible} aria-label={text("notifications.title", "通知历史")}>
    <h2>{text("notifications.title", "通知历史")}{pending.length ? <span className="wallet-notifications__waiting" role="status">{text("notifications.waiting", "等待批准")} · {pending.length}</span> : null}</h2>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">{text("notifications.loading", "正在读取通知…")}</p> : null}
    {!loading && !pending.length && !notices.length && !records.length && !error ? <p>{text("notifications.empty", "暂无通知")}</p> : null}
    {notices.map(request => <ApprovalRequest key={request.id} request={request} execute={execute} text={text}
      onAnswered={id => setNotices(rows => rows.filter(r => r.id !== id))}/>)}
    {pending.map(request => <ApprovalRequest key={request.id} request={request} execute={execute} text={text}
      onAnswered={id => { answeredIds.current.add(id); setPending(rows => rows.filter(r => r.id !== id)); }}/>)}
    {records.map(r => <HistoryNotification key={r.id} record={r} text={text} stateText={states[r.state]}/>)}
  </section>;
}

export { SignatureHistoryPanel } from "./signature-history-ui.js";
