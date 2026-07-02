// packages/plugin-appmsg/src/AppMsgSystemPage.tsx
// 应用消息系统级诊断页（`/system/messages`，施工单 2026-07-02 001）。
//
// 设计缘由：
//   - 这是 Keymaster **系统管理页**，归属 plugin-appmsg；它看的是
//     "当前 owner + 全部 channel"的真值总览，**不**是某个 app 的 inbox。
//   - 只展示数量、连接状态、最近一次错误；**不**展示任何 message body /
//     markdown / 明细列表。诊断页不替代产品页。
//   - 锁定 / 无 active key 状态下允许打开：状态卡显示 disconnected /
//     no owner，刷新按钮禁用；保留上次成功快照 + stale 标识。
//   - 单个 channel 刷新失败时只标记该行；其它 channel 继续展示结果。
//   - 数据真值来源：appmsg.core.inspectConnection / listKnownPluginEndpoints
//     / listKnownOrigins / countScopes——**全部**走 HubMsg 内部 RPC
//     （message.origins / message.counts），**不**通过 `message.list`
//     拉明细再本地计数。
//   - 页面**不**记录任何 message body / markdown / 私钥相关字段。

import { useCallback, useEffect, useState } from "react";
import { Button, PageHeader } from "@keymaster/ui";
import {
  APPMESSAGE_CORE_CAPABILITY,
  type AppMsgAddress,
  type AppMsgChannelCountBox,
  type AppMsgConnectionSnapshot,
  type AppMsgCore,
  type AppMsgEndpoint
} from "@keymaster/contracts";
import { useCapability, useI18n, useRuntimeStatus } from "@keymaster/runtime";

/* ============== 内部 row 状态 ============== */

interface ChannelRow {
  /** 全局稳定 key：用于 React list key 与 state map key。 */
  key: string;
  kind: "origin" | "plugin";
  channelId: string;
  /**
   * 数据真值来源：
   *   - `hubmsg-origins` —— 通过 HubMsg `message.origins` 内部 RPC
   *     从 owner 级 `app_messages` 历史派生；
   *   - `plugin-endpoint` —— 来自 `appmsg.core.listKnownPluginEndpoints()`
   *     本地注册表（plugin manifest 声明的 `appMessageEndpoint.endpointId`）。
   */
  source: "hubmsg-origins" | "plugin-endpoint";
  counts: { inbox: number; sent: number; all: number } | null;
  lastRefreshedAtMs: number;
  rowStatus: "ok" | "failed";
  rowError: string | null;
  /** 来自上一次成功刷新的快照；锁定态下仍展示。 */
  stale: boolean;
}

type RefreshStatus = "ok" | "partial_failed" | "failed" | "idle";

/* ============== 页面 ============== */

export function AppMsgSystemPage(): JSX.Element {
  const { text } = useI18n();
  const core = useCapability<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
  const { vault } = useRuntimeStatus();
  const unlocked = vault === "unlocked";

  const [conn, setConn] = useState<AppMsgConnectionSnapshot>(() => core.inspectConnection());
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>("idle");

  /**
   * 加载流程：
   *   1. inspectConnection 同步更新 conn。
   *   2. 锁定 / 无 owner → 标 stale，写 `appmsg.diagnostics.refresh.failed`
   *      系统日志，**不**调 HubMsg。
   *   3. 解锁态 → best-effort `reconnectIfNeeded()`（**不**直接调
   *      `connectForOwner`，让 `appmsg.reconnect.*` 走日志通道）→
   *      `listKnownOrigins` → 组合 channels → `countScopes`。
   *   4. 任一步失败都写 `appmsg.diagnostics.refresh.failed`；UI 状态卡
   *      只反映最终结果（"OK" / "部分" / "失败"）。
   *   5. 单 channel 失败：只标该行；总状态根据失败率定。
   */
  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    const startedAt = Date.now();
    try {
      const snap = core.inspectConnection();
      setConn(snap);

      if (!unlocked || !snap.ownerPublicKeyHex) {
        setRows((prev) => prev.map((r) => ({ ...r, stale: true })));
        setRefreshStatus("failed");
        // 系统日志：锁定 / 无 owner 时本次 refresh 也算失败，
        // 写一条 page-level `appmsg.diagnostics.refresh.failed`，
        // 让 `/settings/logs` 能检索到"为什么这次刷新失败 / 是因为
        // 锁定"。
        try {
          await core.logDiagnosticsRefreshFailed({
            stage: "locked_or_no_owner",
            err: unlocked ? "no bound owner" : "vault locked",
            durationMs: Date.now() - startedAt
          });
        } catch {
          // ignore：logDiagnosticsRefreshFailed 自身不应再抛
        }
        return;
      }

      // 1. best-effort reconnect：走 reconnectIfNeeded 让
      // `appmsg.reconnect.begin / .failed` 落到系统日志。
      if (snap.state !== "bound") {
        try {
          await core.reconnectIfNeeded();
        } catch {
          // 忽略：下面 countScopes 会再失败一次
        }
        // 关键：reconnect 之后必须再抓一次快照，让 connection 卡
        // 显示最新 state / lastBoundAt / lastError。否则会"页面仍
        // 显示旧 state=closed"——和施工单"当前连接状态"验收项
        // 不一致。
        setConn(core.inspectConnection());
      }

      // 2. 拉 origins
      let origins: string[] = [];
      try {
        origins = await core.listKnownOrigins();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setRows((prev) =>
          prev.map((r) => ({ ...r, rowStatus: "failed", rowError: msg, stale: true }))
        );
        setRefreshStatus("failed");
        // 系统日志：listKnownOrigins 失败 → 本次 refresh 失败
        // （虽然 countScopes 内部已经写过 diagnostics.refresh.failed，
        // 这里再补一条 page-level "listKnownOrigins failed"，便于
        // 在 /settings/logs 里精确定位失败阶段）。
        try {
          await core.logDiagnosticsRefreshFailed({
            stage: "list_known_origins",
            err: msg,
            durationMs: Date.now() - startedAt
          });
        } catch {
          // ignore：logDiagnosticsRefreshFailed 自身不应再抛
        }
        // 失败后也再抓一次 snapshot，捕捉 lastError
        setConn(core.inspectConnection());
        return;
      }

      // 3. 组合 channels（plugin endpoints 来自本地注册表）
      const plugins = core.listKnownPluginEndpoints();
      const owner = snap.ownerPublicKeyHex;
      const channels: Array<{
        key: string;
        kind: "origin" | "plugin";
        channelId: string;
        source: ChannelRow["source"];
        scope: AppMsgAddress;
      }> = [];
      for (const origin of origins) {
        const ep: AppMsgEndpoint = { kind: "origin", id: origin };
        channels.push({
          key: `origin::${origin}`,
          kind: "origin",
          channelId: origin,
          source: "hubmsg-origins",
          scope: { ownerPublicKeyHex: owner, endpoint: ep }
        });
      }
      for (const id of plugins) {
        const ep: AppMsgEndpoint = { kind: "plugin", id };
        channels.push({
          key: `plugin::${id}`,
          kind: "plugin",
          channelId: id,
          source: "plugin-endpoint",
          scope: { ownerPublicKeyHex: owner, endpoint: ep }
        });
      }

      // 4. 批量取数
      if (channels.length === 0) {
        setRows([]);
        setRefreshStatus("ok");
        // 即使没有 channel 也再抓一次 snapshot（lastReceivedAt / lastError 可能
        // 已被 RPC 更新）
        setConn(core.inspectConnection());
        return;
      }
      const results = await core.countScopes(channels.map((c) => c.scope));
      const byKey = new Map<string, AppMsgChannelCountBox>();
      for (const r of results) {
        byKey.set(`${r.scope.endpoint.kind}::${r.scope.endpoint.id}`, r);
      }
      const now = Date.now();
      const newRows: ChannelRow[] = channels.map((c) => {
        const k = `${c.scope.endpoint.kind}::${c.scope.endpoint.id}`;
        const r = byKey.get(k);
        if (!r || r.error || !r.counts) {
          return {
            key: c.key,
            kind: c.kind,
            channelId: c.channelId,
            source: c.source,
            counts: null,
            lastRefreshedAtMs: now,
            rowStatus: "failed",
            rowError: r?.error ?? "no_result",
            stale: false
          };
        }
        return {
          key: c.key,
          kind: c.kind,
          channelId: c.channelId,
          source: c.source,
          counts: r.counts,
          lastRefreshedAtMs: now,
          rowStatus: "ok",
          rowError: null,
          stale: false
        };
      });
      setRows(newRows);
      const failed = newRows.filter((r) => r.rowStatus === "failed").length;
      if (failed === 0) setRefreshStatus("ok");
      else if (failed < newRows.length) setRefreshStatus("partial_failed");
      else setRefreshStatus("failed");
      // 关键：RPC 成功后再抓一次 snapshot，让 connection 卡显示
      // 最新 state / lastBoundAt / lastReceivedAt / lastError
      // （例如 listKnownOrigins 内部若触碰了 connect 状态，lastBoundAt
      // 也会被更新；countScopes 失败会更新 lastError）。
      setConn(core.inspectConnection());
    } finally {
      setRefreshing(false);
    }
  }, [core, unlocked]);

  // mount + 解锁态变化时各拉一次
  useEffect(() => {
    void load();
  }, [load]);

  // 刷新按钮：锁定 / refreshing 时禁用
  const refreshDisabled = refreshing || !unlocked;

  return (
    <div className="appmsg-system-page">
      <PageHeader
        title={text({ key: "appmsg.system.title", fallback: "Message system" })}
        description={text({
          key: "appmsg.system.description",
          fallback: "Connection status and per-channel message counts. Read-only diagnostics; no message body is shown here."
        })}
      />
      <ConnectionCard conn={conn} unlocked={unlocked} />
      <div className="appmsg-system-page__actions">
        <Button
          type="button"
          onClick={() => void load()}
          disabled={refreshDisabled}
        >
          {refreshing
            ? text({ key: "appmsg.system.counts.refreshing", fallback: "Refreshing…" })
            : text({ key: "appmsg.system.counts.refresh", fallback: "Refresh" })}
        </Button>
        <RefreshStatusLabel status={refreshStatus} />
      </div>
      {rows.length > 0 && <ChannelTable rows={rows} />}
      {rows.length === 0 && !refreshing && (
        <div className="appmsg-system-page__empty">
          {unlocked
            ? text({ key: "appmsg.system.empty", fallback: "No known channels for the current owner." })
            : text({
                key: "appmsg.system.lockedHint",
                fallback: "Unlock the Vault to see per-channel counts. The last successful snapshot, if any, is shown with a stale marker."
              })}
        </div>
      )}
    </div>
  );
}

/* ============== 子组件 ============== */

function ConnectionCard({ conn, unlocked }: { conn: AppMsgConnectionSnapshot; unlocked: boolean }): JSX.Element {
  const { text } = useI18n();
  let stateLabel: string;
  if (!unlocked) {
    stateLabel = text({ key: "appmsg.system.status.no_owner", fallback: "no owner (vault locked)" });
  } else if (conn.state === "bound") {
    stateLabel = text({ key: "appmsg.system.status.bound", fallback: "bound" });
  } else if (conn.state === "connecting") {
    stateLabel = text({ key: "appmsg.system.status.connecting", fallback: "connecting" });
  } else if (conn.state === "closed") {
    stateLabel = text({ key: "appmsg.system.status.closed", fallback: "closed" });
  } else {
    stateLabel = text({ key: "appmsg.system.status.disconnected", fallback: "disconnected" });
  }
  return (
    <div className="appmsg-system-page__card">
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.status.label", fallback: "State" })}
        </span>
        <span className="appmsg-system-page__value">{stateLabel}</span>
      </div>
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.owner", fallback: "Owner" })}
        </span>
        <span className="appmsg-system-page__value">
          {conn.ownerPublicKeyHex ?? "—"}
        </span>
      </div>
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.url", fallback: "HubMsg URL" })}
        </span>
        <span className="appmsg-system-page__value">{conn.url}</span>
      </div>
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.lastBoundAt", fallback: "Last bound at" })}
        </span>
        <span className="appmsg-system-page__value">{formatMs(conn.lastBoundAtMs)}</span>
      </div>
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.lastReceivedAt", fallback: "Last received at" })}
        </span>
        <span className="appmsg-system-page__value">{formatMs(conn.lastReceivedAtMs)}</span>
      </div>
      <div className="appmsg-system-page__row">
        <span className="appmsg-system-page__label">
          {text({ key: "appmsg.system.lastError", fallback: "Last error" })}
        </span>
        <span className="appmsg-system-page__value appmsg-system-page__value--mono">
          {conn.lastError ?? "—"}
        </span>
      </div>
    </div>
  );
}

function ChannelTable({ rows }: { rows: ChannelRow[] }): JSX.Element {
  const { text } = useI18n();
  return (
    <table className="appmsg-system-page__table">
      <thead>
        <tr>
          <th>{text({ key: "appmsg.system.counts.kind", fallback: "Kind" })}</th>
          <th>{text({ key: "appmsg.system.counts.channel", fallback: "Channel" })}</th>
          <th>{text({ key: "appmsg.system.counts.source", fallback: "Source" })}</th>
          <th>{text({ key: "appmsg.system.counts.inbox", fallback: "Inbox" })}</th>
          <th>{text({ key: "appmsg.system.counts.sent", fallback: "Sent" })}</th>
          <th>{text({ key: "appmsg.system.counts.all", fallback: "All" })}</th>
          <th>{text({ key: "appmsg.system.counts.lastRefreshed", fallback: "Last refreshed" })}</th>
          <th>{text({ key: "appmsg.system.counts.status", fallback: "Status" })}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.stale ? "is-stale" : undefined}>
            <td>{r.kind}</td>
            <td className="appmsg-system-page__value--mono">{r.channelId}</td>
            <td>
              {r.source === "hubmsg-origins"
                ? text({
                    key: "appmsg.system.counts.source.hubmsg-origins",
                    fallback: "HubMsg origin history"
                  })
                : text({
                    key: "appmsg.system.counts.source.plugin-endpoint",
                    fallback: "Plugin endpoint"
                  })}
            </td>
            <td>{r.counts?.inbox ?? "—"}</td>
            <td>{r.counts?.sent ?? "—"}</td>
            <td>{r.counts?.all ?? "—"}</td>
            <td>{formatMs(r.lastRefreshedAtMs)}</td>
            <td>
              {r.stale
                ? text({ key: "appmsg.system.rowStatus.stale", fallback: "stale" })
                : r.rowStatus === "ok"
                  ? text({ key: "appmsg.system.rowStatus.ok", fallback: "ok" })
                  : text({
                      key: "appmsg.system.rowStatus.failed",
                      fallback: `failed: ${r.rowError ?? "unknown"}`,
                      values: { error: r.rowError ?? "unknown" }
                    })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RefreshStatusLabel({ status }: { status: RefreshStatus }): JSX.Element {
  const { text } = useI18n();
  if (status === "ok")
    return <span className="appmsg-system-page__status is-ok">{text({ key: "appmsg.system.status.ok", fallback: "OK" })}</span>;
  if (status === "partial_failed")
    return (
      <span className="appmsg-system-page__status is-partial">
        {text({ key: "appmsg.system.status.partialFailed", fallback: "Partial" })}
      </span>
    );
  if (status === "failed")
    return (
      <span className="appmsg-system-page__status is-failed">
        {text({ key: "appmsg.system.status.failed", fallback: "Failed" })}
      </span>
    );
  return <span />;
}

function formatMs(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
