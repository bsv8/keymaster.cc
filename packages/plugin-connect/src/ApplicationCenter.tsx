import { useConnectApps } from "./AppContext.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { APPLICATION_OPERATION_LABELS, applicationCommandStatus, applicationCommandTerminal, type ApplicationConnection, type ApplicationConnectionsSnapshot, type ProtocolCommandRecord, type MsFilePendingApprovalView } from "@keymaster/contracts";
import { useConnectResources, useConnectWalletState } from "./ConnectResourceContext.js";
import { AppIcon } from "@keymaster/ui";
import { Inbox } from "lucide-react";
import { ApplicationRequestDetails, CommandCard } from "./ConnectCommandFeed.js";
import { ApplicationAuthentication, MsFileApprovalSection } from "./ApplicationApprovals.js";
import { applicationCommandApprovalDetail } from "./applicationPermissions.js";
import "./applicationCenter.css";
import { useApplicationReminders } from "./applicationReminders.js";

const EMPTY: ApplicationConnectionsSnapshot = { applications: [], connections: [], commands: [], events: [], historyAvailable: true };
const terminal = applicationCommandTerminal;
const needsAttention = (command: ProtocolCommandRecord) => command.phase === "confirming" || command.phase === "waiting_unlock_manual";
function useApplications() {
  const { host } = useConnectApps();
  const state = useResourceView<ApplicationConnectionsSnapshot>(useConnectResources(), "connect.applications", []);
  return { host, snapshot: state.data ?? EMPTY };
}
function connectionFor(snapshot: ApplicationConnectionsSnapshot, command: ProtocolCommandRecord): ApplicationConnection | undefined {
  return snapshot.connections.find(connection => !connection.closedAt && connection.service.feedSnapshot().commands.some(value => value.id === command.id));
}
function Command({ connection, command }: { connection: ApplicationConnection; command: ProtocolCommandRecord }) {
  const { t } = usePluginI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const auth = connection.service.connectAuthSnapshot();
  if (auth?.recordId === command.id) {
    return <ApplicationAuthentication key={command.id} service={connection.service} auth={auth} t={t} />;
  }
  return <ul className="application-command"><CommandCard t={t} service={connection.service} command={command} now={now} initiallyExpanded kind="live" showHeader={false} /></ul>;
}

export function ApplicationConnectionControls() {
  const { host, snapshot } = useApplications();
  const wallet = useConnectWalletState();
  const masked = useSyncExternalStore(listener => wallet.subscribe(listener), () => wallet.snapshot().screenMasked === true);
  // 完整钱包壳层装配后才接纳 App 主动拉起钱包的真实 opener。
  useEffect(() => { host.acceptOpener(window.opener); }, [host]);
  const msfile = useResourceView<{ approvals: MsFilePendingApprovalView[] }>(useConnectResources(), "connect.msfile-approvals", []);
  const msApprovals = msfile.data?.approvals ?? [];
  const pending = snapshot.commands.filter(needsAttention).filter(command => connectionFor(snapshot, command));
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
  function review() {
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
        notice.onclick = () => { window.focus(); review(); notice.close(); };
      } catch { reminders.notificationFailed(); }
    }
  }, [pendingKey]);
  useEffect(() => {
    const ids = snapshot.commands.filter(command => command.autoApproved && command.applicationKey && terminal(command) && !automatic.current.has(command.id));
    for (const command of ids) automatic.current.add(command.id);
    if (ids.length) { setReminder(`自动处理 ${ids.length} 项；请在应用日志查看实际结果。`); void reminders.play(false); }
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
  return <>
    <span className="application-controls"><button type="button" aria-label={`待审批 ${count}`} aria-haspopup="dialog" aria-expanded={open && !masked} aria-controls="application-activity-dialog" onClick={() => review()}><span className="application-controls__icon"><Inbox size={16} aria-hidden="true" />{count > 0 ? <span className="application-controls__badge" aria-hidden="true">{count}</span> : null}</span><span className="application-controls__label">待审批</span></button></span>
    {createPortal(<>
      {count && !masked ? <aside className={`application-alert ${seen ? "" : "is-unseen"}`} aria-label="待处理应用授权"><strong><i />待授权 {count} 项</strong><span>{[...pending.map(value => APPLICATION_OPERATION_LABELS[value.method] ?? "应用操作"), ...msApprovals.map(() => "MSFile 价格确认")].join(" · ")}</span><button type="button" onClick={() => review()}>查看并处理 →</button>{sound === "failed" ? <small role="status">提示音未播放</small> : null}</aside> : null}
      {reminder && !masked ? <aside className="application-automatic" role="status">{reminder}<button type="button" onClick={() => setReminder("")}>关闭</button></aside> : null}
      <dialog ref={dialog} id="application-activity-dialog" data-application-approval className="application-drawer" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="application-approval-title">
        <header><h2 id="application-approval-title">应用处理记录 <small>待处理 {count}</small></h2><button type="button" aria-label="关闭审批，返回原工作" onClick={() => setOpen(false)}>✕</button></header>
        <div className="application-drawer-body">
          {(!snapshot.historyAvailable || snapshot.error) && <p role="alert">历史记录暂时不可用，显示内容可能不完整。</p>}
          {open && !masked && <ApplicationActivityGroups snapshot={snapshot} approvals={msApprovals} onInteraction={() => setSeen(true)} />}
        </div>
      </dialog>
    </>, document.body)}
  </>;
}
/** 按真实 App 身份分组；未验证的连接请求单独归组，不借用同来源 App 的身份。 */
function ApplicationActivityGroups({ snapshot, approvals, onInteraction }: { snapshot: ApplicationConnectionsSnapshot; approvals: MsFilePendingApprovalView[]; onInteraction(): void }) {
  const { t } = usePluginI18n();
  type Group = { id: string; name: string; icon?: string; url?: string; commands: ProtocolCommandRecord[]; approvals: MsFilePendingApprovalView[] };
  const groups = new Map<string, Group>();
  const connectedApps = new Set(snapshot.connections.filter(connection => !connection.closedAt && connection.applicationKey).map(connection => connection.applicationKey));
  for (const command of snapshot.commands) {
    const id = command.applicationKey ?? `unverified:${command.origin}`;
    const app = snapshot.applications.find(app => app.key === command.applicationKey);
    const group = groups.get(id) ?? { id, name: app?.display?.name ?? app?.name ?? "应用连接申请", icon: app?.display?.icon, url: app?.verifiedUrl ?? command.origin, commands: [], approvals: [] };
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
    {ordered.map(group => {
      const connected = connectedApps.has(group.id);
      const status = connected ? "已连接" : "未连接";
      return <section className="application-activity-group" key={group.id}>
        <header>
          <AppIcon icon={group.icon} url={group.url} name={group.name} size={36} />
          <h3>{group.name}</h3>
          <span className="application-connection-light" data-connected={connected} role="img" aria-label={status} title={status} />
        </header>
        <ul>
          {group.approvals.map(approval => <ActivityRow key={approval.approvalId} title="调整文件价格上限" status="等待授权" pending onInteraction={onInteraction}>
            <MsFileApprovalSection t={t} approvalId={approval.approvalId} />
          </ActivityRow>)}
          {[...group.commands].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.updatedAt - a.updatedAt).map(command => {
            const connection = connectionFor(snapshot, command);
            const title = APPLICATION_OPERATION_LABELS[command.method] ?? "应用操作";
            const ended = !connection && !terminal(command);
            const status = ended ? "连接已结束" : applicationCommandStatus(command);
            const approvalDetail = applicationCommandApprovalDetail(command);
            return <ActivityRow key={command.id} id={command.id} title={title} status={status} origin={command.origin}
              updatedAt={command.updatedAt} pending={Boolean(connection && needsAttention(command))} onInteraction={onInteraction}>
              {connection && !terminal(command)
                ? <Command command={command} connection={connection} />
                : <>
                  {approvalDetail && <p>{approvalDetail}</p>}
                  {ended && <p>此连接已失效，不能继续批准旧请求。</p>}
                  {command.paymentStatus && <p>付款结果：{applicationCommandStatus(command)}</p>}
                  <ApplicationRequestDetails command={command} />
                </>}
            </ActivityRow>;
          })}
        </ul>
      </section>;
    })}
  </div>;
}

function ActivityRow({ id, title, status, origin, updatedAt, pending, onInteraction, children }: {
  id?: string;
  title: string;
  status: string;
  origin?: string;
  updatedAt?: number;
  pending: boolean;
  onInteraction(): void;
  children: ReactNode;
}) {
  const detailId = useId();
  const [expandedOverride, setExpandedOverride] = useState<boolean>();
  const expanded = expandedOverride ?? pending;
  return <li className="application-activity-row">
    <button type="button" className="application-activity-toggle" data-activity-id={id} aria-expanded={expanded} aria-controls={detailId} onClick={() => {
      setExpandedOverride(!expanded);
      onInteraction();
    }}>
      <span className="application-activity-title">{title}</span><span className="application-activity-status">{status}</span>
      {origin && <span className="application-activity-origin">{origin}</span>}
      {updatedAt !== undefined && <time>{new Date(updatedAt).toLocaleString()}</time>}
    </button>
    <div id={detailId} className="application-review" hidden={!expanded}>{expanded && children}</div>
  </li>;
}

/** Read-only contribution inside the privacy mask; no application details or actions. */
export function ApplicationMaskStatus() {
  const { snapshot } = useApplications();
  const msfile = useResourceView<{ approvals: MsFilePendingApprovalView[] }>(useConnectResources(), "connect.msfile-approvals", []);
  const count = snapshot.commands.filter(needsAttention).filter(command => connectionFor(snapshot, command)).length + (msfile.data?.approvals.length ?? 0);
  return <p className="wallet-screen-mask__pending" role="status" data-testid="mask-pending-count">待审批 <strong>{count}</strong> 项</p>;
}
