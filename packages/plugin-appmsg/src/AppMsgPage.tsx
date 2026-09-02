// packages/plugin-appmsg/src/AppMsgPage.tsx
// AppMsg 系统管理页（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 本页是 `/system/appmsg` 的渲染层；通过 `useCapability<AppMsgCore>`
//     直接消费 `appmsg.core` 平台 internal 能力；
//   - 路由 / 菜单 / 面包屑都从原 `HubMsg` 命名统一改为 `AppMsg` 语义——
//     管理面属于系统名 `appmsg`，**不**再绑定到具体 provider；
//   - 五个区块：
//       1. 当前 active provider（id / displayName / isHealthy / lastError）
//       2. 已注册 provider 列表 + 切换按钮
//       3. 连接态（owner / url / lastError）
//       4. 同步态（target sync states + 手动同步）
//       5. 统计 + 全局消息浏览
//   - 真值以**本地消息库**为准；远端 provider 数量 / origin 汇总**不**入页；
//   - 不为管理页扩张分页 / 协议 / 重试策略（见施工单 §6.6）；
//   - **统计与过滤同时覆盖 sender 与 recipient 两侧 endpoint**——管理页
//     要展示的是"所有 origin / appId 的消息分布"，单一目标 key 只看
//     recipient 会漏掉"我以某个 sender 维度发出去"的消息；
//   - 类名沿用 `appmsg-system-page*` 与现有 plugin-appmsg styles.css
//     契约一一对应；不在生产组件里造新命名空间。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import type {
  ActiveMessageProviderSnapshot,
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineStatus,
  AppMsgTargetSyncState
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY, formatShortPublicKey } from "@keymaster/contracts";
import { createAppMsgService } from "./appmsgService.js";
import type { AppMsgProviderDiagnostic } from "./appmsgService.js";

type AppMsgOnlineQueryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; text: string }
  | { phase: "success"; key: string; status: AppMsgOnlineStatus };

export function AppMsgPage(): React.ReactElement {
  const i18n = useI18n();
  const core = useCapabilityOrNull<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
  if (!core) {
    return (
      <section className="appmsg-system-page" data-appmsg-page="missing-core">
        <h1 className="appmsg-system-page__title">{i18n.t("appmsg.page.title")}</h1>
        <p className="appmsg-system-page__empty">{`appmsg.core capability is not available.`}</p>
      </section>
    );
  }
  return <AppMsgPageInner core={core} />;
}

function AppMsgPageInner({ core }: { core: AppMsgCore }): React.ReactElement {
  const i18n = useI18n();
  const service = useMemo(() => createAppMsgService(core), [core]);
  const [snapshot, setSnapshot] = useState<AppMsgLocalDbSnapshot>(() => service.inspectLocalDb());
  const [activeProvider, setActiveProvider] = useState<ActiveMessageProviderSnapshot>(() =>
    service.activeProviderSnapshot()
  );
  const [providerDiagnostics, setProviderDiagnostics] = useState<
    readonly AppMsgProviderDiagnostic[]
  >(() => service.providerDiagnostics());
  const [diagnosticsCapturedAtMs, setDiagnosticsCapturedAtMs] = useState(() => Date.now());
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [targets, setTargets] = useState<AppMsgTargetSyncState[]>([]);
  const [search, setSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<string>("");
  const [onlineHex, setOnlineHex] = useState("");
  const [onlineQuery, setOnlineQuery] = useState<AppMsgOnlineQueryState>({ phase: "idle" });
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "fail"; text: string } | null>(null);
  const [diagnosticMsg, setDiagnosticMsg] = useState<{
    kind: "ok" | "fail";
    text: string;
  } | null>(null);
  const [providerSwitch, setProviderSwitch] = useState<string | null>(null);
  const [providerSwitchError, setProviderSwitchError] = useState<string | null>(null);
  // UI 专用 tick：用于驱动倒计时文案逐秒刷新。**不**触发业务侧任何
  // 重连——所有重连生命周期都由 plugin-appmsg 内的协调器持有。
  const [tick, setTick] = useState(0);

  const refreshConnectionDiagnostics = useCallback(() => {
    setSnapshot(service.inspectLocalDb());
    setActiveProvider(service.activeProviderSnapshot());
    setProviderDiagnostics(service.providerDiagnostics());
    setDiagnosticsCapturedAtMs(Date.now());
  }, [service]);

  const refresh = useCallback(async () => {
    refreshConnectionDiagnostics();
    const items = await service.listAllLocalMessages({ limit: 500 });
    setMessages(items);
    setTargets(await service.listTargetSyncStates());
  }, [refreshConnectionDiagnostics, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 订阅 core 状态变化（连接 / 断开 / 重连倒计时变化 / unfiltered 推送）。
  // 不依赖收到 push 才更新连接态。
  useEffect(() => {
    const off = core.onStateChange(() => {
      refreshConnectionDiagnostics();
    });
    return () => {
      off();
    };
  }, [core, refreshConnectionDiagnostics]);

  // 订阅 unfiltered 推送：让统计 / 浏览能随推送增量更新。
  useEffect(() => {
    const off = core.subscribeUnfilteredMessages(() => {
      void refresh();
    });
    return () => {
      off();
    };
  }, [core, refresh]);

  // 1s UI tick：仅在等待重连时启动；用于倒计时文案逐秒刷新。
  useEffect(() => {
    if (snapshot.nextReconnectAtMs === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(id);
    };
  }, [snapshot.nextReconnectAtMs]);

  // 倒计时显示文案：`Math.max(1, ceil((nextReconnectAtMs - now)/1000))`。
  // tick 依赖保证文案每秒重算。
  const reconnectRemainingSec = useMemo(() => {
    void tick;
    if (snapshot.nextReconnectAtMs === null) return null;
    const diffMs = snapshot.nextReconnectAtMs - Date.now();
    return Math.max(1, Math.ceil(diffMs / 1000));
  }, [snapshot.nextReconnectAtMs, tick]);

  /**
   * 单一规则：每条消息可能同时携带 sender 端和 recipient 端 endpoint——
   * 两条都是"我以这个 endpoint 维度收 / 发"的本地真值。统计 key、过滤
   * 选项、列表展示 key 都走同一份 `collectMessageEndpoints(msg)`，避免
   * 三处分叉。
   */
  const endpointKeys = useMemo(() => {
    const out = new Set<string>();
    for (const m of messages) {
      for (const k of collectMessageEndpoints(m)) out.add(k);
    }
    return Array.from(out).sort();
  }, [messages]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (endpointFilter) {
        const keys = collectMessageEndpoints(m);
        if (!keys.includes(endpointFilter)) return false;
      }
      if (q && !(m.body ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [messages, search, endpointFilter]);

  const stats = useMemo(() => {
    const total = messages.length;
    const byKey = new Map<string, number>();
    for (const m of messages) {
      for (const k of collectMessageEndpoints(m)) {
        byKey.set(k, (byKey.get(k) ?? 0) + 1);
      }
    }
    const entries = Array.from(byKey.entries()).sort((a, b) => b[1] - a[1]);
    return { total, entries };
  }, [messages]);

  const providers = service.listProviders();
  const activateProvider = useCallback(async (providerId: string) => {
    const previousProviderId = activeProvider.providerId;
    setProviderSwitch(providerId);
    setProviderSwitchError(null);
    try {
      await service.setActiveProvider(providerId);
      refreshConnectionDiagnostics();
    } catch (cause) {
      // registry 未来若在 bind/持久化阶段失败，恢复用户原来的选择，避免
      // 页面显示的 active provider 与实际连接真值分离。
      try { await service.setActiveProvider(previousProviderId); } catch { /* best effort rollback */ }
      setProviderSwitchError(`${i18n.t("appmsg.page.providers.switch.fail")}: ${cause instanceof Error ? cause.message : String(cause)}`);
      refreshConnectionDiagnostics();
    } finally {
      setProviderSwitch(null);
    }
  }, [activeProvider.providerId, i18n, refreshConnectionDiagnostics, service]);
  const activeProviderDiagnostic = useMemo(
    () =>
      providerDiagnostics.find((provider) => provider.id === activeProvider.providerId) ??
      null,
    [activeProvider.providerId, providerDiagnostics]
  );
  const connectionProviderDiagnostic = useMemo(
    () =>
      (snapshot.boundProviderId
        ? providerDiagnostics.find((provider) => provider.id === snapshot.boundProviderId)
        : null) ?? activeProviderDiagnostic,
    [activeProviderDiagnostic, providerDiagnostics, snapshot.boundProviderId]
  );
  const connectionAssessment = useMemo(() => {
    const providerHealthy = connectionProviderDiagnostic?.isHealthy ?? false;
    if (snapshot.state === "open" && providerHealthy) return "ok" as const;
    if (snapshot.state === "open") return "coreOpenProviderUnhealthy" as const;
    if (providerHealthy) return "providerHealthyCoreOffline" as const;
    return "offline" as const;
  }, [connectionProviderDiagnostic?.isHealthy, snapshot.state]);

  const diagnosticReport = useMemo(
    () =>
      JSON.stringify(
        {
          capturedAtMs: diagnosticsCapturedAtMs,
          core: snapshot,
          activeProvider,
          providers: providerDiagnostics
        },
        null,
        2
      ),
    [activeProvider, diagnosticsCapturedAtMs, providerDiagnostics, snapshot]
  );

  const onlineFeedback = useMemo(() => {
    if (onlineQuery.phase === "idle") return null;
    if (onlineQuery.phase === "loading") {
      return {
        kind: "loading" as const,
        text: i18n.t("appmsg.page.online.loading")
      };
    }
    if (onlineQuery.phase === "error") {
      return {
        kind: "fail" as const,
        text: onlineQuery.text
      };
    }
    return {
      kind: onlineQuery.status === "unknown" ? ("partial" as const) : ("ok" as const),
      text:
        onlineQuery.status === "online"
          ? i18n.t("appmsg.page.online.online")
          : onlineQuery.status === "offline"
            ? i18n.t("appmsg.page.online.offline")
            : i18n.t("appmsg.page.online.unknown")
    };
  }, [i18n, onlineQuery]);

  const runOnlineCheck = useCallback(async () => {
    const hex = onlineHex.trim();
    if (!/^[0-9a-f]{66}$/i.test(hex)) {
      setOnlineQuery({
        phase: "error",
        text: i18n.t("appmsg.page.online.fail.invalidHex")
      });
      return;
    }
    if (activeProvider.providerId === null) {
      setOnlineQuery({
        phase: "error",
        text: `${i18n.t("appmsg.page.online.fail.notReady")}: ${i18n.t("appmsg.page.provider.none")}`
      });
      return;
    }
    if (snapshot.state !== "open") {
      setOnlineQuery({
        phase: "error",
        text: `${i18n.t("appmsg.page.online.fail.notReady")}: ${i18n.t(
          `appmsg.page.connection.state.${snapshot.state}`
        )}`
      });
      return;
    }
    if (!snapshot.ownerPublicKeyHex) {
      setOnlineQuery({
        phase: "error",
        text: `${i18n.t("appmsg.page.online.fail.notReady")}: ${i18n.t(
          "appmsg.page.online.fail.ownerMissing"
        )}`
      });
      return;
    }
    const beforeSnapshot = service.inspectLocalDb();
    setOnlineQuery({ phase: "loading" });
    try {
      const out = await service.checkOnline([hex]);
      const status: AppMsgOnlineStatus = out[hex] ?? "unknown";
      const afterSnapshot = service.inspectLocalDb();
      if (status === "unknown" && afterSnapshot.lastError) {
        const detail =
          afterSnapshot.lastError !== beforeSnapshot.lastError || !beforeSnapshot.lastError
            ? afterSnapshot.lastError
            : i18n.t("appmsg.page.online.fail.queryFailed");
        setOnlineQuery({
          phase: "error",
          text: `${i18n.t("appmsg.page.online.fail.queryFailed")}: ${detail}`
        });
        return;
      }
      setOnlineQuery({
        phase: "success",
        key: hex,
        status
      });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setOnlineQuery({
        phase: "error",
        text: `${i18n.t("appmsg.page.online.fail.queryFailed")}: ${text}`
      });
    }
  }, [activeProvider.providerId, i18n, onlineHex, service, snapshot.ownerPublicKeyHex, snapshot.state]);

  return (
    <section className="appmsg-system-page" data-appmsg-page="ok">
      <h1 className="appmsg-system-page__title">{i18n.t("appmsg.page.title")}</h1>

      {/* ===== 区块 1：当前 active provider ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--provider">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.provider.active")}
        </h2>
        {activeProvider.providerId === null ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("appmsg.page.provider.none")}
          </p>
        ) : (
          <div className="appmsg-system-page__row">
            <span className="appmsg-system-page__label">
              {i18n.t("appmsg.page.provider.id")}
            </span>
            <span className="appmsg-system-page__value appmsg-system-page__value--mono">
              {activeProvider.providerId}
            </span>
            <span className="appmsg-system-page__label">
              {i18n.t("appmsg.page.provider.name")}
            </span>
            <span className="appmsg-system-page__value">
              {activeProvider.displayName ?? "(unknown)"}
            </span>
            <span className="appmsg-system-page__label">
              {i18n.t("appmsg.page.provider.health")}
            </span>
            <span
              className={`appmsg-system-page__value appmsg-system-page__status ${
                activeProvider.isHealthy ? "is-ok" : "is-failed"
              }`}
            >
              {activeProvider.isHealthy
                ? i18n.t("appmsg.page.provider.health.ok")
                : i18n.t("appmsg.page.provider.health.fail")}
            </span>
            {activeProvider.lastError ? (
              <>
                <span className="appmsg-system-page__label">
                  {i18n.t("appmsg.page.provider.lastError")}
                </span>
                <span className="appmsg-system-page__value appmsg-system-page__value--mono">
                  {activeProvider.lastError}
                </span>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* ===== 区块 2：provider 列表（用户显式选择） ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--providers">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.providers.title")}
        </h2>
        {providerSwitchError ? <p role="alert">{providerSwitchError}</p> : null}
        {providers.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("appmsg.page.providers.empty")}
          </p>
        ) : (
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>{i18n.t("appmsg.page.providers.name")}</th>
                  <th>{i18n.t("appmsg.page.providers.active")}</th>
                  <th>{i18n.t("appmsg.page.providers.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => {
                  const isActive = p.id === activeProvider.providerId;
                  return (
                    <tr key={p.id} className="appmsg-system-page__table-row">
                      <td><code>{p.id}</code></td>
                      <td>{p.displayName}</td>
                      <td>{isActive ? i18n.t("appmsg.page.providers.active") : "—"}</td>
                      <td>
                        {isActive ? i18n.t("appmsg.page.providers.active") : (
                          <button
                            type="button"
                            className="appmsg-system-page__button"
                            disabled={providerSwitch !== null}
                            onClick={() => void activateProvider(p.id)}
                          >
                            {providerSwitch === p.id ? i18n.t("appmsg.page.providers.switching", { defaultValue: "切换中…" }) : i18n.t("appmsg.page.providers.activate")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== 区块 3：连接态 ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--connection">
        <div className="appmsg-system-page__section-heading">
          <h2 className="appmsg-system-page__section-title">
            {i18n.t("appmsg.page.connection")}
          </h2>
          <button
            type="button"
            className="appmsg-system-page__button"
            onClick={() => {
              setDiagnosticMsg(null);
              refreshConnectionDiagnostics();
            }}
          >
            {i18n.t("appmsg.page.connection.refresh")}
          </button>
          <button
            type="button"
            className="appmsg-system-page__button"
            onClick={() => {
              setDiagnosticMsg(null);
              const clipboard = navigator.clipboard;
              if (!clipboard) {
                setDiagnosticMsg({
                  kind: "fail",
                  text: i18n.t("appmsg.page.connection.copy.fail")
                });
                return;
              }
              void clipboard
                .writeText(diagnosticReport)
                .then(() => {
                  setDiagnosticMsg({
                    kind: "ok",
                    text: i18n.t("appmsg.page.connection.copy.done")
                  });
                })
                .catch(() => {
                  setDiagnosticMsg({
                    kind: "fail",
                    text: i18n.t("appmsg.page.connection.copy.fail")
                  });
                });
            }}
          >
            {i18n.t("appmsg.page.connection.copy")}
          </button>
        </div>
        {diagnosticMsg ? (
          <p
            className={`appmsg-system-page__diagnostic-msg appmsg-system-page__diagnostic-msg--${diagnosticMsg.kind}`}
            role="status"
          >
            {diagnosticMsg.text}
          </p>
        ) : null}
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.state")}
          </span>
          <span
            className={`appmsg-system-page__value appmsg-system-page__status ${connectionStatusClass(snapshot.state)}`}
            data-appmsg-state={snapshot.state}
          >
            {snapshot.state === "open"
              ? i18n.t("appmsg.page.connection.state.open")
              : snapshot.state === "closed"
                ? i18n.t("appmsg.page.connection.state.closed")
              : i18n.t("appmsg.page.connection.state.idle")}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.providerHealth")}
          </span>
          <span
            className={`appmsg-system-page__value appmsg-system-page__status ${
              connectionProviderDiagnostic?.isHealthy ? "is-ok" : "is-failed"
            }`}
            data-appmsg-provider-health={connectionProviderDiagnostic?.isHealthy ? "healthy" : "unhealthy"}
          >
            {connectionProviderDiagnostic?.isHealthy
              ? i18n.t("appmsg.page.provider.health.ok")
              : i18n.t("appmsg.page.provider.health.fail")}
          </span>
        </div>
        <div className="appmsg-system-page__row appmsg-system-page__row--assessment">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.assessment")}
          </span>
          <span
            className={`appmsg-system-page__value appmsg-system-page__assessment ${
              connectionAssessment === "ok" ? "is-ok" : "is-failed"
            }`}
            data-appmsg-connection-assessment={connectionAssessment}
          >
            {i18n.t(`appmsg.page.connection.assessment.${connectionAssessment}`)}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.owner")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.ownerPublicKeyHex ?? "(none)"}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.boundProvider")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.boundProviderId ?? "(none)"}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.lastError")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.lastError ?? i18n.t("appmsg.page.connection.lastError.none")}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.providerLastError")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {connectionProviderDiagnostic?.lastError ?? i18n.t("appmsg.page.connection.lastError.none")}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.providerLastConnected")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {formatDiagnosticTime(connectionProviderDiagnostic?.lastConnectedAtMs ?? 0, i18n)}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.localDbLastWrite")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {formatDiagnosticTime(snapshot.lastInsertedAtMs, i18n)}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.capturedAt")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {formatDiagnosticTime(diagnosticsCapturedAtMs, i18n)}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.connection.nextReconnect")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.nextReconnectAtMs === null
              ? i18n.t("appmsg.page.connection.notScheduled")
              : formatDiagnosticTime(snapshot.nextReconnectAtMs, i18n)}
          </span>
        </div>
        {snapshot.state === "closed" && reconnectRemainingSec !== null ? (
          <div className="appmsg-system-page__row" data-appmsg-reconnect-row>
            <span className="appmsg-system-page__label">
              {i18n.t("appmsg.page.connection.reconnect")}
            </span>
            <span
              className="appmsg-system-page__value"
              data-appmsg-reconnect-remaining={reconnectRemainingSec}
            >
              {i18n.t("appmsg.page.connection.reconnect.value", {
                seconds: reconnectRemainingSec
              })}
            </span>
          </div>
        ) : null}
        <div className="appmsg-system-page__diagnostic-table">
          <h3 className="appmsg-system-page__sub-title">
            {i18n.t("appmsg.page.connection.providers")}
          </h3>
          <span className="appmsg-system-page__diagnostic-count">
            {i18n.t("appmsg.page.connection.providers.count")}: {providerDiagnostics.length}
          </span>
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>{i18n.t("appmsg.page.providers.name")}</th>
                  <th>{i18n.t("appmsg.page.connection.providers.active")}</th>
                  <th>{i18n.t("appmsg.page.provider.health")}</th>
                  <th>{i18n.t("appmsg.page.connection.providerLastConnected")}</th>
                  <th>{i18n.t("appmsg.page.connection.providerLastError")}</th>
                  <th>{i18n.t("appmsg.page.connection.providers.probeError")}</th>
                </tr>
              </thead>
              <tbody>
                {providerDiagnostics.map((provider) => (
                  <tr key={provider.id}>
                    <td><code>{provider.id}</code></td>
                    <td>{provider.displayName}</td>
                    <td>{provider.isActive ? i18n.t("appmsg.page.providers.active") : "—"}</td>
                    <td>{provider.isHealthy ? i18n.t("appmsg.page.provider.health.ok") : i18n.t("appmsg.page.provider.health.fail")}</td>
                    <td className="appmsg-system-page__value--mono">{formatDiagnosticTime(provider.lastConnectedAtMs, i18n)}</td>
                    <td className="appmsg-system-page__value--mono">{provider.lastError ?? i18n.t("appmsg.page.connection.lastError.none")}</td>
                    <td className="appmsg-system-page__value--mono">{provider.healthProbeError ?? i18n.t("appmsg.page.connection.lastError.none")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ===== 区块 4：同步态 ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--sync">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.sync")}
        </h2>
        <div className="appmsg-system-page__sync-row">
          <button
            type="button"
            className="appmsg-system-page__button"
            onClick={() => {
              setSyncMsg(null);
              void service
                .triggerSync()
                .then(async () => {
                  setSyncMsg({ kind: "ok", text: i18n.t("appmsg.page.sync.trigger.done") });
                  await refresh();
                })
                .catch((err: unknown) => {
                  const text = err instanceof Error ? err.message : String(err);
                  setSyncMsg({
                    kind: "fail",
                    text: `${i18n.t("appmsg.page.sync.trigger.fail")}: ${text}`
                  });
                });
            }}
          >
            {i18n.t("appmsg.page.sync.trigger")}
          </button>
          {syncMsg ? (
            <span
              className={`appmsg-system-page__sync-msg appmsg-system-page__sync-msg--${syncMsg.kind}`}
              data-appmsg-sync={syncMsg.kind}
            >
              {syncMsg.text}
            </span>
          ) : null}
        </div>
        <h3 className="appmsg-system-page__sub-title">
          {i18n.t("appmsg.page.sync.targets")}
        </h3>
        {targets.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("appmsg.page.sync.targets.empty")}
          </p>
        ) : (
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>targetKey</th>
                  <th>{i18n.t("appmsg.page.sync.target.lastSynced")}</th>
                  <th>{i18n.t("appmsg.page.sync.target.lastReceived")}</th>
                  <th>{i18n.t("appmsg.page.sync.target.error")}</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr
                    key={t.targetKey}
                    className={`appmsg-system-page__table-row${
                      t.lastSyncError ? " is-failed" : ""
                    }`}
                  >
                    <td><code>{t.targetKey}</code></td>
                    <td><code>{t.lastSyncedMessageId || "(none)"}</code></td>
                    <td>{t.lastReceivedAtMs ? new Date(t.lastReceivedAtMs).toISOString() : "(none)"}</td>
                    <td>{t.lastSyncError ?? i18n.t("appmsg.page.sync.target.error.none")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== 区块 5：统计 ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--stats">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.stats")}
        </h2>
        <div className="appmsg-system-page__stats-row">
          <span className="appmsg-system-page__label">
            {i18n.t("appmsg.page.stats.total")}
          </span>
          <span className="appmsg-system-page__metric">{stats.total}</span>
        </div>
        <h3 className="appmsg-system-page__sub-title">
          {i18n.t("appmsg.page.stats.byKey")}
        </h3>
        {stats.entries.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("appmsg.page.stats.byKey.empty")}
          </p>
        ) : (
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>endpoint</th>
                  <th>count</th>
                </tr>
              </thead>
              <tbody>
                {stats.entries.map(([k, n]) => (
                  <tr key={k} className="appmsg-system-page__table-row">
                    <td><code>{k}</code></td>
                    <td className="appmsg-system-page__metric">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== 区块 6：在线查询 ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--online">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.online.label")}
        </h2>
        <div className="appmsg-system-page__online-row">
          <input
            type="text"
            value={onlineHex}
            onChange={(e) => setOnlineHex(e.target.value)}
            placeholder={i18n.t("appmsg.page.online.placeholder")}
            className="appmsg-system-page__input"
          />
          <button
            type="button"
            className="appmsg-system-page__button"
            disabled={onlineQuery.phase === "loading"}
            aria-busy={onlineQuery.phase === "loading"}
            onClick={() => {
              void runOnlineCheck();
            }}
          >
            {i18n.t("appmsg.page.online.check")}
          </button>
        </div>
        {onlineFeedback ? (
          <span
            className={`appmsg-system-page__sync-msg appmsg-system-page__sync-msg--${onlineFeedback.kind}`}
            data-appmsg-online-feedback
            data-appmsg-online-phase={onlineQuery.phase}
            data-appmsg-online-key={
              onlineQuery.phase === "success" ? onlineQuery.key : undefined
            }
          >
            {onlineFeedback.text}
          </span>
        ) : null}
        {onlineQuery.phase === "success" ? (
          <ul className="appmsg-system-page__online-list">
            <li key={onlineQuery.key} data-appmsg-online-result={onlineQuery.status}>
              <code>{formatShortPublicKey(onlineQuery.key)}</code>:{" "}
              {onlineQuery.status === "online"
                ? i18n.t("appmsg.page.online.online")
                : onlineQuery.status === "offline"
                  ? i18n.t("appmsg.page.online.offline")
                  : i18n.t("appmsg.page.online.unknown")}
            </li>
          </ul>
        ) : null}
      </div>

      {/* ===== 区块 7：本地消息浏览 ===== */}
      <div className="appmsg-system-page__card appmsg-system-page__card--browse">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("appmsg.page.browse")}
        </h2>
        <div className="appmsg-system-page__browse-filter">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={i18n.t("appmsg.page.browse.search")}
            className="appmsg-system-page__input"
          />
          <select
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            className="appmsg-system-page__input"
          >
            <option value="">{i18n.t("appmsg.page.browse.filter.all")}</option>
            {endpointKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {filtered.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("appmsg.page.browse.empty")}
          </p>
        ) : (
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>messageId</th>
                  <th>from</th>
                  <th>to</th>
                  <th>body</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.messageId} className="appmsg-system-page__table-row">
                    <td><code>{m.messageId}</code></td>
                    <td>
                      <code>{shortHex(m.senderPublicKeyHex)}</code>
                      {m.senderOrigin ? ` (${m.senderOrigin})` : ""}
                      {m.senderAppId ? ` (${m.senderAppId})` : ""}
                    </td>
                    <td>
                      <code>{shortHex(m.recipientPublicKeyHex)}</code>
                      {m.recipientOrigin ? ` (${m.recipientOrigin})` : ""}
                      {m.recipientAppId ? ` (${m.recipientAppId})` : ""}
                    </td>
                    <td className="appmsg-system-page__body-cell">{m.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 单一统计 key 函数：把一条消息上**所有**本地 endpoint 维度抽成 key。
 *
 * 去重语义：
 *   - 用 `Set<string>` 收集；
 *   - 同一消息 `senderAppId === recipientAppId`（自发自收）只计 1。
 *
 * 规则：
 *   - 有 senderOrigin → `origin:<senderOrigin>`
 *   - 有 senderAppId   → `appId:<senderAppId>`
 *   - 有 recipientOrigin → `origin:<recipientOrigin>`
 *   - 有 recipientAppId   → `appId:<recipientAppId>`
 *   - 都缺 → 返回空数组。
 */
export function collectMessageEndpoints(m: AppMsgMessage): string[] {
  const set = new Set<string>();
  if (m.senderOrigin) set.add(`origin:${m.senderOrigin}`);
  if (m.senderAppId) set.add(`appId:${m.senderAppId}`);
  if (m.recipientOrigin) set.add(`origin:${m.recipientOrigin}`);
  if (m.recipientAppId) set.add(`appId:${m.recipientAppId}`);
  return Array.from(set);
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

/**
 * 把连接快照的 `state` 映射成 styles.css 里的状态色 class。
 *
 *   - `open`   → `is-ok`：已连上，状态正常；
 *   - `closed` → `is-failed`：明确失败态；
 *   - `idle`   → `is-partial`：未启动 / 等待中。
 */
export function connectionStatusClass(
  state: AppMsgLocalDbSnapshot["state"]
): string {
  switch (state) {
    case "open":
      return "is-ok";
    case "closed":
      return "is-failed";
    case "idle":
    default:
      return "is-partial";
  }
}

function shortHex(h: string): string {
  return formatShortPublicKey(h);
}

function formatDiagnosticTime(value: number, i18n: ReturnType<typeof useI18n>): string {
  if (!Number.isFinite(value) || value <= 0) {
    return i18n.t("appmsg.page.connection.never");
  }
  return `${new Date(value).toISOString()} (${value})`;
}
