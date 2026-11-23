import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { APPLICATION_OPERATION_LABELS, applicationCommandStatus, applicationCommandTerminal, type ApplicationConnections, type ApplicationConnectionsSnapshot, type ProtocolMethod } from "@keymaster/contracts";
import { ApplicationRequestDetails } from "./ConnectCommandFeed.js";
import { APPROVAL_METHODS, applicationCommandApprovalDetail, applicationPermissionDetail } from "./applicationPermissions.js";

const EVENTS = { connected: "建立会话", disconnected: "断开会话", "permission-granted": "开启永久授权", "permission-revoked": "取消永久授权" };

/** 设置以应用公钥为主体，离线及无会话时仍可读取和撤销。 */
export function AppDetails({ applicationKey, host, snapshot }: { applicationKey: string; host: ApplicationConnections; snapshot: ApplicationConnectionsSnapshot }) {
  const [tab, setTab] = useState<"settings" | "sessions" | "history">("settings");
  const [permissions, setPermissions] = useState<ProtocolMethod[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const permissionRevision = snapshot.events.filter(event => event.applicationKey === applicationKey && event.kind.startsWith("permission-")).map(event => event.id).join("|");
  useEffect(() => {
    let active = true;
    setPermissions(undefined); setError(undefined);
    void host.permissions(applicationKey).then(value => { if (active) setPermissions(value); }, () => { if (active) setError("授权设置读取失败，请关闭详情后重试。"); });
    return () => { active = false; };
  }, [host, applicationKey, permissionRevision]);
  const connections = snapshot.connections.filter(connection => connection.applicationKey === applicationKey);
  const events = snapshot.events.filter(event => event.applicationKey === applicationKey);
  const archived = events.filter(event => event.kind === "connected" && !connections.some(connection => connection.id === event.connectionId));
  const timeline = [
    ...snapshot.commands.filter(command => command.applicationKey === applicationKey).map(command => ({
      id: `command:${command.id}`, at: command.updatedAt, title: APPLICATION_OPERATION_LABELS[command.method] ?? "应用操作",
      status: applicationCommandStatus(command), detail: applicationCommandApprovalDetail(command), command,
    })),
    ...events.map(event => {
      const permission = event.method ? applicationPermissionDetail(event.method) : undefined;
      return {
        id: `event:${event.id}`, at: event.at, title: EVENTS[event.kind],
        status: event.method ? APPLICATION_OPERATION_LABELS[event.method] ?? "应用操作" : "",
        detail: event.kind === "permission-revoked" && permission ? `已取消的许可内容 · ${permission}` : permission,
        command: undefined,
      };
    }),
  ].sort((a, b) => b.at - a.at).filter(item => `${item.title} ${item.status} ${item.detail ?? ""} ${new Date(item.at).toLocaleString()}`.includes(filter));
  return <div className="app-details" data-testid="app-details">
    <div className="app-details__tabs" role="group" aria-label="应用详情分类">
      {([["settings", "永久授权"], ["sessions", "会话"], ["history", "授权与处理历史"]] as const).map(([value, label]) => <Button key={value} variant="ghost" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</Button>)}
    </div>
    {(!snapshot.historyAvailable || snapshot.error) && <p role="alert">应用记录暂时不可用，显示内容可能不完整。</p>}
    {error && <p role="alert">{error}</p>}
    {tab === "settings" && <>
      <p className="apps-muted">这些首选设置属于此应用，关闭或重新打开应用后仍然有效。</p>
      {APPROVAL_METHODS.map(method => <div className="app-details__row" key={method}>
        <div><strong>{APPLICATION_OPERATION_LABELS[method]}</strong>{method === "payment.pay" && permissions?.includes(method) && <p className="apps-muted">自动付款不设金额上限。</p>}</div>
        <span>{permissions === undefined ? "读取中" : permissions.includes(method) ? "以后自动同意" : "每次询问"}</span>
        {permissions?.includes(method) && <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
          setBusy(true); setError(undefined);
          try { await host.revokePermission(applicationKey, method); setPermissions(await host.permissions(applicationKey)); }
          catch { setError("取消授权失败，请重试。"); }
          finally { setBusy(false); }
        }}>取消自动同意</Button>}
      </div>)}
      <p className="apps-muted">在实际请求中勾选“以后自动同意”可授予永久授权。取消后，新的请求会再次询问；已执行或在途的操作不会撤销。</p>
    </>}
    {tab === "sessions" && <>
      {connections.some(connection => !connection.closedAt) && <Button variant="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError(undefined);
        try { await host.disconnect(applicationKey); } catch { setError("断开连接失败，请重试。"); } finally { setBusy(false); }
      }}>断开此应用的全部连接</Button>}
      {connections.map(connection => <div className="app-details__row" key={connection.id}>
        <div><strong>{connection.closedAt ? "已断开" : "当前会话"}</strong><p className="apps-muted">{new Date(connection.createdAt).toLocaleString()} 建立{connection.closedAt ? ` · ${new Date(connection.closedAt).toLocaleString()} 断开` : ""}</p></div>
        {!connection.closedAt && <Button variant="ghost" onClick={() => { try { host.focus(connection.id); } catch { setError("应用已关闭，无法切回。"); } }}>切回应用</Button>}
      </div>)}
      {archived.map(event => <div className="app-details__row" key={event.id}><div><strong>历史会话</strong><p className="apps-muted">{new Date(event.at).toLocaleString()} 建立</p></div><span>已结束</span></div>)}
      {!connections.length && !archived.length && <p className="apps-muted">还没有会话记录。</p>}
    </>}
    {tab === "history" && <>
      <label className="app-details__filter">筛选记录<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="操作、状态或时间" /></label>
      {timeline.map(item => <details className="app-details__history" key={item.id}>
        <summary><span>{item.title}</span><span>{item.status}</span><time>{new Date(item.at).toLocaleString()}</time></summary>
        {item.detail && <p className="apps-muted">{item.detail}</p>}
        {item.command && <>
          {item.status === "付款待核实" && <p className="apps-muted">付款结果尚未确认，请勿重复付款。</p>}
          {!applicationCommandTerminal(item.command) && <p className="apps-muted">需要处理的申请请从顶栏“待审批”打开。</p>}
          <ApplicationRequestDetails command={item.command} />
        </>}
      </details>)}
      {!timeline.length && <p className="apps-muted">没有符合条件的记录。</p>}
    </>}
  </div>;
}
