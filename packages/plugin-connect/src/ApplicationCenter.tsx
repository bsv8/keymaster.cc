import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { APPLICATION_OPERATION_LABELS, applicationCommandStatus, applicationCommandTerminal, APPLICATION_CONNECTIONS_CAPABILITY, type ApplicationConnection, type ApplicationConnectionsSnapshot, type ProtocolCommandRecord, type MsFilePendingApprovalView } from "@keymaster/contracts";
import { useConnectResources, useConnectWalletState } from "./ConnectResourceContext.js";
import { AppIcon } from "@keymaster/ui";
import { Inbox } from "lucide-react";
const METHOD_LABELS = APPLICATION_OPERATION_LABELS;
import { CommandCard } from "./ConnectCommandFeed.js";
import { ApplicationAuthentication, MsFileApprovalSection } from "./ApplicationApprovals.js";
import "./applicationCenter.css";
import { useApplicationReminders } from "./applicationReminders.js";

const EMPTY: ApplicationConnectionsSnapshot = { applications: [], connections: [], commands: [], events: [], historyAvailable: true };
const terminal = applicationCommandTerminal;
const needsAttention = (command: ProtocolCommandRecord) => command.phase === "confirming" || command.phase === "waiting_unlock_manual";
function useApplications() {
  const host = usePluginCapability(APPLICATION_CONNECTIONS_CAPABILITY);
  const state = useResourceView<ApplicationConnectionsSnapshot>(useConnectResources(), "connect.applications", []);
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
  const wallet = useConnectWalletState();
  const masked = useSyncExternalStore(listener => wallet.subscribe(listener), () => wallet.snapshot().screenMasked === true);
  // 完整钱包壳层装配后才接纳 App 主动拉起钱包的真实 opener。
  useEffect(() => { host.acceptOpener(window.opener); }, [host]);
  const { t } = usePluginI18n();
  const msfile = useResourceView<{ approvals: MsFilePendingApprovalView[] }>(useConnectResources(), "connect.msfile-approvals", []);
  const msApprovals = msfile.data?.approvals ?? [];
  const pending = snapshot.commands.filter(needsAttention).filter(command => connectionFor(snapshot, command));
  const [reviewing, setReviewing] = useState<string>();
  const [open, setOpen] = useState(false);
  const { controller: reminders, sound } = useApplicationReminders();
  const [seen, setSeen] = useState(false);
  const [reminder, setReminder] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const notified = useRef(new Set<string>());
  const automatic = useRef(new Set<string>());
  const notifications = useRef<Notification[]>([]);
  const originalTitle = useRef(document.title);
  const originalIcon = useRef<string | null>(null);
  const attention = [...pending.map(value => ({ id: value.id })), ...msApprovals.map(value => ({ id: `msfile:${value.approvalId}` }))];
  const count = attention.length;
  const pendingKey = attention.map(value => value.id).join("|");
  function review(id?: string) {
    setReviewing(id ?? attention[0]?.id);
    setSeen(true);
    if (!wallet.snapshot().screenMasked) setOpen(true);
  }
  useEffect(() => {
    const newPending = attention.filter(value => !notified.current.has(value.id));
    for (const command of newPending) notified.current.add(command.id);
    if (!newPending.length) return;
    setSeen(false);
    void reminders.play(true);
    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const notice = new Notification("Keymaster · 新的应用授权请求", { body: `有 ${count} 项待处理，请回到钱包核对来源和请求。`, tag: "keymaster-application-approval" });
        notifications.current.push(notice);
        notice.onclick = () => { window.focus(); review(newPending[0]!.id); notice.close(); };
      } catch { reminders.notificationFailed(); }
    }
  }, [pendingKey]);
  useEffect(() => {
    const ids = snapshot.commands.filter(command => command.autoApproved && command.applicationKey && terminal(command) && !automatic.current.has(command.id));
    for (const command of ids) automatic.current.add(command.id);
    if (ids.length) { setReminder(`已有许可自动执行 ${ids.length} 项；请在应用日志查看实际结果。`); void reminders.play(false); }
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
    if (open && !masked && dialog.current && !dialog.current.open) dialog.current.showModal();
    if ((!open || masked) && dialog.current?.open) dialog.current.close();
  }, [open, masked]);
  useEffect(() => () => { reminders.dispose(); notifications.current.forEach(value => value.close()); }, []);
  const command = snapshot.commands.find(value => value.id === reviewing);
  const connection = command ? connectionFor(snapshot, command) : undefined;
  const msApproval = msApprovals.find(value => `msfile:${value.approvalId}` === reviewing);
  return <>
    <span className="application-controls"><button type="button" aria-label={`待审批 ${count}`} aria-haspopup="dialog" aria-expanded={open && !masked} aria-controls="application-activity-dialog" onClick={() => review()}><span className="application-controls__icon"><Inbox size={16} aria-hidden="true" />{count > 0 ? <span className="application-controls__badge" aria-hidden="true">{count}</span> : null}</span><span className="application-controls__label">待审批</span></button></span>
    {createPortal(<>
      {count && !masked ? <aside className={`application-alert ${seen ? "" : "is-unseen"}`} aria-label="待处理应用授权"><strong><i />待授权 {count} 项</strong><span>{[...pending.map(value => METHOD_LABELS[value.method] ?? "应用操作"), ...msApprovals.map(() => "MSFile 价格确认")].join(" · ")}</span><button type="button" onClick={() => review()}>查看并处理 →</button>{sound === "failed" ? <small role="status">提示音未播放</small> : null}</aside> : null}
      {reminder && !masked ? <aside className="application-automatic" role="status">{reminder}<button type="button" onClick={() => setReminder("")}>关闭</button></aside> : null}
      <dialog ref={dialog} id="application-activity-dialog" data-application-approval className="application-drawer" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="application-approval-title">
        <header><h2 id="application-approval-title">应用处理记录 <small>待处理 {count}</small></h2><button type="button" aria-label="关闭审批，返回原工作" onClick={() => setOpen(false)}>✕</button></header>
        <div className="application-drawer-body">
          {(!snapshot.historyAvailable || snapshot.error) && <p role="alert">历史记录暂时不可用，显示内容可能不完整。</p>}
          <ApplicationActivityGroups snapshot={snapshot} approvals={msApprovals} selected={reviewing} onSelect={setReviewing} />
          {command && <section className="application-review" aria-label="所选操作详情">
            <h3>{METHOD_LABELS[command.method] ?? "应用操作"} · {applicationCommandStatus(command)}</h3>
            {connection && !terminal(command)
              ? <Command key={command.id} command={command} connection={connection} kind="live" />
              : <><p>{command.manualApprovedAt ? "本次由你批准" : command.autoApproved ? "使用已有永久授权" : "未取得人工批准"}</p><p>{new Date(command.updatedAt).toLocaleString()}</p>{!terminal(command) && <p>此连接已失效，不能继续批准旧请求。</p>}{command.paymentStatus && <p>付款结果：{applicationCommandStatus(command)}</p>}</>}
          </section>}
          {msApproval && <MsFileApprovalSection key={msApproval.approvalId} t={t} approvalId={msApproval.approvalId} />}
        </div>
      </dialog>
    </>, document.body)}
  </>;
}


/** 按真实 App 身份分组；未验证的连接请求单独归组，不借用同来源 App 的身份。 */
function ApplicationActivityGroups({ snapshot, approvals, selected, onSelect }: { snapshot: ApplicationConnectionsSnapshot; approvals: MsFilePendingApprovalView[]; selected?: string; onSelect(id: string): void }) {
  type Group = { id: string; name: string; icon?: string; url?: string; commands: ProtocolCommandRecord[]; approvals: MsFilePendingApprovalView[] };
  const groups = new Map<string, Group>();
  for (const command of snapshot.commands) {
    const id = command.applicationKey ?? `unverified:${command.origin}`;
    const app = snapshot.applications.find(app => app.key === command.applicationKey);
    let site = "应用连接申请";
    try { site = new URL(command.origin).hostname; } catch { /* 无有效来源时不猜测应用身份。 */ }
    const group = groups.get(id) ?? { id, name: app?.display?.name ?? app?.name ?? site, icon: app?.display?.icon, url: app?.verifiedUrl ?? command.origin, commands: [], approvals: [] };
    group.commands.push(command); groups.set(id, group);
  }
  for (const approval of approvals) {
    // 内部文件价格审批没有经过 Connect 发布身份，不按 appId 认领某个 App 公钥。
    const id = `msfile:${approval.appId}`;
    const group = groups.get(id) ?? { id, name: approval.appName, commands: [], approvals: [] };
    group.approvals.push(approval); groups.set(id, group);
  }
  const latest = (group: Group) => Math.max(0, ...group.commands.map(command => command.updatedAt));
  const waiting = (group: Group) => group.approvals.length > 0 || group.commands.some(command => needsAttention(command) && connectionFor(snapshot, command));
  const ordered = [...groups.values()].sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || latest(b) - latest(a));
  return <div className="application-activity-groups">
    {!ordered.length && <p className="application-note">还没有应用处理记录。</p>}
    {ordered.map(group => <section className="application-activity-group" key={group.id}>
      <header><AppIcon icon={group.icon} url={group.url} name={group.name} size={36} /><h3>{group.name}</h3></header>
      <ul>{group.approvals.map(approval => <li key={approval.approvalId}><button type="button" aria-pressed={selected === `msfile:${approval.approvalId}`} onClick={() => onSelect(`msfile:${approval.approvalId}`)}><span>调整文件价格上限</span><span>等待授权</span></button></li>)}
      {[...group.commands].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.updatedAt - a.updatedAt).map(command => <li key={command.id}><button type="button" data-activity-id={command.id} aria-pressed={selected === command.id} onClick={() => onSelect(command.id)}><span>{METHOD_LABELS[command.method] ?? "应用操作"}</span><span>{!terminal(command) && !connectionFor(snapshot, command) ? "连接已结束" : applicationCommandStatus(command)}</span><time>{new Date(command.updatedAt).toLocaleString()}</time></button></li>)}</ul>
    </section>)}
  </div>;
}
