import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePluginCapability } from "webloom-framework/react";
import { navigateTo, usePluginI18n, useResourceView } from "@keymaster/runtime";
import { APPLICATION_CONNECTIONS_CAPABILITY, type ApplicationConnection, type ApplicationConnectionsSnapshot, type ProtocolCommandRecord, type ProtocolMethod, type MsFilePendingApprovalView } from "@keymaster/contracts";
import { useProtocolResources } from "./ProtocolResourceContext.js";
import { APPROVAL_METHODS, METHOD_LABELS } from "./applicationPermissions.js";
import { CommandCard } from "./ProtocolCommandFeed.js";
import { ApplicationAuthentication, MsFileApprovalSection } from "./ApplicationApprovals.js";
import "./applicationCenter.css";

const EMPTY: ApplicationConnectionsSnapshot = { applications: [], connections: [], commands: [], events: [], historyAvailable: true };
const terminal = (command: ProtocolCommandRecord) => ["approved", "rejected", "failed", "timed_out"].includes(command.phase);
const needsAttention = (command: ProtocolCommandRecord) => command.phase === "confirming" || command.phase === "waiting_unlock_manual";
function useApplications() {
  const host = usePluginCapability(APPLICATION_CONNECTIONS_CAPABILITY);
  const state = useResourceView<ApplicationConnectionsSnapshot>(useProtocolResources(), "protocol.applications", []);
  return { host, snapshot: state.data ?? EMPTY };
}
function connectionFor(snapshot: ApplicationConnectionsSnapshot, command: ProtocolCommandRecord): ApplicationConnection | undefined {
  return snapshot.connections.find(connection => !connection.closedAt && connection.service.feedSnapshot().commands.some(value => value.id === command.id));
}
function Command({ connection, command, kind }: { connection: ApplicationConnection; command: ProtocolCommandRecord; kind: "live" | "history" }) {
  const { t } = usePluginI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const auth = connection.service.connectAuthSnapshot();
  if (kind === "live" && auth?.recordId === command.id) {
    return <ApplicationAuthentication key={command.id} service={connection.service} auth={auth} t={t} />;
  }
  return <ul className="application-command"><CommandCard key={command.id} t={t} service={connection.service} command={command} now={now} initiallyExpanded kind={kind} /></ul>;
}

export function ApplicationConnectionControls() {
  const { host, snapshot } = useApplications();
  // 只在完整钱包壳层装配完成后发 ready；不能在首次 unlock 的代际重绑中提前握手。
  useEffect(() => { host.acceptOpener(window.opener); }, [host]);
  const { t } = usePluginI18n();
  const msfile = useResourceView<{ approvals: MsFilePendingApprovalView[] }>(useProtocolResources(), "protocol.msfile-approvals", []);
  const msApprovals = msfile.data?.approvals ?? [];
  const pending = snapshot.commands.filter(needsAttention).filter(command => connectionFor(snapshot, command));
  const [reviewing, setReviewing] = useState<string>();
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState<"off" | "ready" | "failed">("off");
  const [notification, setNotification] = useState<string>("未开启");
  const [seen, setSeen] = useState(false);
  const [reminder, setReminder] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const audio = useRef<AudioContext>();
  const notified = useRef(new Set<string>());
  const automatic = useRef(new Set<string>());
  const soundAt = useRef(0);
  const notifications = useRef<Notification[]>([]);
  const originalTitle = useRef(document.title);
  const originalIcon = useRef<string | null>(null);
  const attention = [...pending.map(value => ({ id: value.id })), ...msApprovals.map(value => ({ id: `msfile:${value.approvalId}` }))];
  const count = attention.length;
  const pendingKey = attention.map(value => value.id).join("|");
  function review(id?: string) {
    setReviewing(id ?? attention[0]?.id);
    setSeen(true);
    setOpen(true);
  }
  async function play(manual: boolean) {
    if (!audio.current || audio.current.state !== "running") { if (sound !== "off") setSound("failed"); return; }
    if (Date.now() - soundAt.current < 1200) return;
    soundAt.current = Date.now();
    try {
      const oscillator = audio.current.createOscillator(), gain = audio.current.createGain();
      oscillator.connect(gain); gain.connect(audio.current.destination);
      oscillator.frequency.setValueAtTime(manual ? 740 : 440, audio.current.currentTime);
      if (manual) oscillator.frequency.setValueAtTime(550, audio.current.currentTime + .13);
      gain.gain.setValueAtTime(.075, audio.current.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audio.current.currentTime + .35);
      oscillator.start(); oscillator.stop(audio.current.currentTime + .35);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch { setSound("failed"); }
  }
  useEffect(() => {
    const newPending = attention.filter(value => !notified.current.has(value.id));
    for (const command of newPending) notified.current.add(command.id);
    if (!newPending.length) return;
    setSeen(false);
    void play(true);
    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const notice = new Notification("Keymaster · 新的应用授权请求", { body: `有 ${count} 项待处理，请回到钱包核对来源和请求。`, tag: "keymaster-application-approval" });
        notifications.current.push(notice);
        notice.onclick = () => { window.focus(); review(newPending[0]!.id); notice.close(); };
      } catch { setNotification("系统通知发送失败"); }
    }
  }, [pendingKey]);
  useEffect(() => {
    const ids = snapshot.commands.filter(command => command.autoApproved && command.applicationKey && terminal(command) && !automatic.current.has(command.id));
    for (const command of ids) automatic.current.add(command.id);
    if (ids.length) { setReminder(`已有许可自动执行 ${ids.length} 项；请在应用日志查看实际结果。`); void play(false); }
  }, [snapshot.commands]);
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (originalIcon.current === null && icon) originalIcon.current = icon.href;
    document.title = count ? `(${count} 待授权) Keymaster` : originalTitle.current;
    document.body.toggleAttribute("data-application-pending", count > 0);
    if (icon) icon.href = count ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#126451"/><text x="7" y="24" fill="white" font-size="23">K</text><circle cx="26" cy="6" r="6" fill="#eba53b"/></svg>') : originalIcon.current ?? icon.href;
    return () => { document.body.removeAttribute("data-application-pending"); document.title = originalTitle.current; if (icon && originalIcon.current) icon.href = originalIcon.current; };
  }, [count]);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => () => { void audio.current?.close(); notifications.current.forEach(value => value.close()); }, []);
  const command = snapshot.commands.find(value => value.id === reviewing);
  const connection = command ? connectionFor(snapshot, command) : undefined;
  const app = snapshot.applications.find(value => value.key === command?.applicationKey);
  const msApproval = msApprovals.find(value => `msfile:${value.approvalId}` === reviewing);
  return <>
    <span className="application-controls"><button type="button" onClick={() => navigateTo("/apps/connections")}>应用连接 {snapshot.connections.filter(value => !value.closedAt).length}</button>
    <button type="button" disabled={!count} onClick={() => review()}>待处理 {count}</button>
    <button type="button" onClick={async () => { try { audio.current ??= new AudioContext(); await audio.current.resume(); if (audio.current.state !== "running") throw new Error(); setSound("ready"); await play(true); } catch { setSound("failed"); } }}>{sound === "off" ? "启用 / 试听提示音" : sound === "failed" ? "声音未启用 · 重试" : "试听提示音"}</button>
    <button type="button" title="浏览器可能限制后台发声和系统通知；静音、勿扰与挂起无法绕过" onClick={async () => { try { if (typeof Notification === "undefined") { setNotification("浏览器不支持"); return; } const permission = await Notification.requestPermission(); setNotification(permission === "granted" ? "已允许" : "未获允许"); } catch { setNotification("开启失败"); } }}>系统通知：{notification}</button></span>
    {createPortal(<>
      {count ? <aside className={`application-alert ${seen ? "" : "is-unseen"}`} aria-label="待处理应用授权"><strong><i />待授权 {count} 项</strong><span>{[...pending.map(value => METHOD_LABELS[value.method] ?? value.method), ...msApprovals.map(() => "MSFile 价格确认")].join(" · ")}</span><button type="button" onClick={() => review()}>查看并处理 →</button>{sound === "failed" ? <small role="status">提示音未播放</small> : null}</aside> : null}
      {reminder ? <aside className="application-automatic" role="status">{reminder}<button type="button" onClick={() => setReminder("")}>关闭</button></aside> : null}
      <dialog ref={dialog} data-application-approval className="application-drawer" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="application-approval-title">
        <header><h2 id="application-approval-title">应用授权 · 待处理 {count} 项</h2><button type="button" aria-label="关闭审批，返回原工作" onClick={() => setOpen(false)}>✕</button></header>
        <div className="application-drawer-body">
          {app ? <div className="application-identity"><h3>{app.name}</h3><code>{app.origin}</code><small>{app.identity ? "发行人身份已验证" : "未提供发行人身份"}</small></div> : null}
          {connection && command ? <Command key={command.id} command={command} connection={connection} kind={terminal(command) ? "history" : "live"} /> : msApproval ? <MsFileApprovalSection key={msApproval.approvalId} t={t} approvalId={msApproval.approvalId} /> : <p>当前申请已结束或连接已失效。没有可批准的请求。</p>}
          <p className="application-note">逐项核对；新请求不会替换当前申请。批准不等于执行成功。</p>
          <h3>其他待处理申请</h3>{pending.filter(value => value.id !== reviewing).map(value => <button type="button" className="application-queue-item" key={value.id} onClick={() => setReviewing(value.id)}>{snapshot.applications.find(app => app.key === value.applicationKey)?.name ?? value.origin} · {METHOD_LABELS[value.method] ?? value.method}</button>)}{msApprovals.filter(value => `msfile:${value.approvalId}` !== reviewing).map(value => <button type="button" className="application-queue-item" key={value.approvalId} onClick={() => setReviewing(`msfile:${value.approvalId}`)}>{value.appName} · MSFile 价格确认</button>)}
        </div>
      </dialog>
    </>, document.body)}
  </>;
}

export function ApplicationCenterPage() {
  const { host, snapshot } = useApplications();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<"activity" | "settings" | "history" | "sessions">("activity");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const app = snapshot.applications.find(value => value.key === selected) ?? snapshot.applications[0];
  const connections = snapshot.connections.filter(value => value.applicationKey === app?.key);
  const archivedConnections = snapshot.events.filter(event => event.applicationKey === app?.key && event.kind === "connected" && !connections.some(connection => connection.id === event.connectionId));
  const commands = snapshot.commands.filter(value => value.applicationKey === app?.key);
  return <section className="application-center"><header><div><h1>应用连接</h1><p>按应用管理许可和历史，会话是应用下面的连接实例。</p></div><button type="button" onClick={() => navigateTo("/apps")}>启动应用</button></header>
    {!snapshot.historyAvailable || snapshot.error ? <p role="alert" className="application-warning">{snapshot.error ?? "历史存储不可用，当前显示可能不完整。"}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="application-workspace"><aside className="application-list">{snapshot.applications.length === 0 ? <p>还没有应用连接。从应用目录启动后会显示在这里。</p> : snapshot.applications.map(value => <button type="button" className={value.key === app?.key ? "selected" : ""} key={value.key} onClick={() => { setSelected(value.key); setError(undefined); }}><strong>{value.name}</strong><code>{value.origin}</code><small>{snapshot.connections.filter(c => c.applicationKey === value.key && !c.closedAt).length} 个在线会话 · {snapshot.commands.filter(c => c.applicationKey === value.key && needsAttention(c)).length} 项待处理</small></button>)}</aside>
      <article>{app ? <><div className="application-identity"><h2>{app.name}</h2><code>{app.origin}</code><small>{app.identity ? `已验证发行人 · ${app.identity.publisherPublicKeyHex}` : "未提供发行人身份"}</small></div>
        <div className="application-tabs">{([["activity", "活动"], ["sessions", "会话"], ["settings", "设置"], ["history", "日志历史"]] as const).map(([value, label]) => <button type="button" className={tab === value ? "selected" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</div>
        {tab === "settings" ? <ApplicationPermissionSettings key={app.key} applicationKey={app.key} /> : null}
        {tab === "sessions" ? <><p className="application-note">重新启动同来源应用会显式断开旧运行连接；不会删除应用许可。钱包刷新后不恢复可执行会话。</p>{archivedConnections.map(event => <div className="application-session" key={event.id}><div><strong>历史会话 · 当前不可执行</strong><small>建立于 {new Date(event.at).toLocaleString()}</small><code>{event.connectionId}</code></div><small>{snapshot.events.some(value => value.connectionId === event.connectionId && value.kind === "disconnected") ? "已断开" : "上次运行已结束，不从历史恢复连接"}</small></div>)}{connections.length ? connections.map(connection => <div className="application-session" key={connection.id}><div><strong>{connection.closedAt ? "已断开" : "已连接"}</strong><small>建立于 {new Date(connection.createdAt).toLocaleString()}</small><code>{connection.id}</code></div>{!connection.closedAt ? <><button type="button" onClick={() => { try { host.focus(connection.id); } catch { setError("无法切回应用，窗口可能已关闭或浏览器阻止切换。"); } }}>切回应用 ↗</button><button type="button" onClick={() => host.disconnect(connection.id)}>断开会话</button></> : null}</div>) : <p>没有当前运行期的会话。持久许可仍可在设置中管理。</p>}</> : null}
        {tab === "activity" ? <><p className="application-note">为避免重复审批，逐次请求统一从顶部「待处理」面板处理。切换应用不会隐藏其他应用的待办。</p>{commands.filter(value => !terminal(value)).map(value => <div className="application-session" key={value.id}><strong>{METHOD_LABELS[value.method] ?? value.method}</strong><span>{value.phase === "confirming" ? "等待授权" : value.phase === "executing" ? "执行中" : value.phase}</span></div>)}{!commands.some(value => !terminal(value)) ? <p>当前没有活跃请求。</p> : null}</> : null}
        {tab === "history" ? <><input className="application-filter" placeholder="筛选操作、状态或时间" value={filter} onChange={event => setFilter(event.target.value)} aria-label="筛选应用历史" />{commands.filter(terminal).filter(value => `${value.method} ${value.phase} ${value.paymentStatus ?? ""} ${new Date(value.createdAt).toLocaleString()}`.includes(filter)).sort((a,b) => b.updatedAt - a.updatedAt).map(value => <details className="application-history" key={value.id}><summary>{METHOD_LABELS[value.method] ?? value.method} · {value.paymentStatus ? ["accepted", "already_known"].includes(value.paymentStatus) ? "节点已接受" : value.paymentStatus === "not_signed" ? "未签名" : "待核实 / " + value.paymentStatus : value.phase} · {new Date(value.updatedAt).toLocaleString()}</summary><p>授权方式：{value.manualApprovedAt ? "本次人工批准" : value.autoApproved ? "既有许可 / 自动执行" : value.failureReason === "user_canceled" ? "人工拒绝" : value.method === "connect.launch" ? "启动时确认连接" : "未取得人工批准 / 见操作结果"}</p><code>{value.origin} · {value.method}</code><p>{value.errorCode || value.failureReason || "请求已完成；付款结果以付款状态为准。"}</p></details>)}{snapshot.events.filter(event => event.applicationKey === app.key).filter(event => `${event.kind} ${event.method ?? ""} ${new Date(event.at).toLocaleString()}`.includes(filter)).sort((a, b) => b.at - a.at).map(event => <div className="application-history" key={event.id}><strong>{{ connected: "会话已建立", disconnected: "会话已断开", "permission-granted": "已开启应用自动许可", "permission-revoked": "已取消应用自动许可" }[event.kind]}</strong><p>{event.method ? METHOD_LABELS[event.method] ?? event.method : event.connectionId} · {new Date(event.at).toLocaleString()}</p></div>)}<p className="application-note">日志不展示密钥、token、解密明文或完整原始报文。断开连接不删除历史与未核实资金责任。</p></> : null}
      </> : null}</article></div>
  </section>;
}

function ApplicationPermissionSettings({ applicationKey }: { applicationKey: string }) {
  const { host, snapshot } = useApplications();
  const grantActivity = snapshot.events.filter(event => event.applicationKey === applicationKey).map(event => event.id).join("|");
  const [permissions, setPermissions] = useState<ProtocolMethod[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void host.permissions(applicationKey).then(value => { if (active) setPermissions(value); }, () => { if (active) setError("许可读取失败，不能把未知状态当成未开启。"); }); return () => { active = false; }; }, [host, applicationKey, grantActivity]);
  return <><p className="application-note">许可属于应用，不属于某次会话。按发行人 + App 编号 + 精确来源隔离，刷新和重连后仍有效；不同操作互不通用。</p>{error ? <p role="alert">{error}</p> : null}{APPROVAL_METHODS.map(method => <div className="application-setting" key={method}><div><strong>{METHOD_LABELS[method]}</strong><code>{method}</code>{method === "payment.pay" && permissions?.includes(method) ? <small className="application-warning">已允许自动付款，不设金额上限。</small> : null}</div><span>{permissions === undefined ? "读取中 / 未知" : permissions.includes(method) ? "以后自动同意" : "每次询问"}</span>{permissions?.includes(method) ? <button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(undefined); try { await host.revokePermission(applicationKey, method); setPermissions(await host.permissions(applicationKey)); } catch { setError("取消许可失败，请重试；未将失败伪装为成功。"); } finally { setBusy(false); } }}>取消自动同意</button> : null}</div>)}<p className="application-note">只能在实际审批中勾选「以后自动同意」授予许可。取消后，新请求恢复逐次询问；已经签名或执行中的操作不会因此被撤销。</p></>;
}
