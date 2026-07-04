// packages/plugin-appmsg/src/HubMsgPage.tsx
// HubMsg 管理页（施工单 2026-07-03 002 硬切换）。
//
// 设计缘由：
//   - 本页是 `/system/hubmsg` 的渲染层；通过 `useCapability<AppMsgCore>`
//     直接消费 `appmsg.core` 平台 internal 能力；
//   - 四个区块：连接 / 同步 / 统计 / 全局消息浏览；
//   - 真值以**本地消息库**为准；远端 HubMsg 数量 / origin 汇总**不**入页；
//   - 不为管理页扩张分页 / 协议 / 重试策略（见施工单 §6.6）；
//   - **统计与过滤同时覆盖 sender 与 recipient 两侧**：管理页要展示的
//     是"所有 origin / appId 的消息分布"，单一目标 key 只看 recipient
//     会漏掉"我以某个 sender 维度发出去"的消息；
//   - 类名沿用 `appmsg-system-page*` 与现有 plugin-appmsg styles.css 契约
//     一一对应；不在生产组件里造新命名空间。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import type {
  AppMsgCore,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineResult,
  AppMsgTargetSyncState
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY } from "@keymaster/contracts";
import { createHubMsgService, type HubMsgService } from "./hubmsgService.js";

/** HubMsg WSS 入口（与 plugin-appmsg manifest 同步）。 */
const DEFAULT_HUBMSG_URL = "wss://msg.keymaster.cc/ws/v1";

export function HubMsgPage(): React.ReactElement {
  const i18n = useI18n();
  const core = useCapabilityOrNull<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
  if (!core) {
    return (
      <section className="appmsg-system-page" data-hubmsg-page="missing-core">
        <h1 className="appmsg-system-page__title">{i18n.t("hubmsg.page.title")}</h1>
        <p className="appmsg-system-page__empty">{`appmsg.core capability is not available.`}</p>
      </section>
    );
  }
  return <HubMsgPageInner core={core} />;
}

function HubMsgPageInner({ core }: { core: AppMsgCore }): React.ReactElement {
  const i18n = useI18n();
  const service = useMemo(() => createHubMsgService(core), [core]);
  const [snapshot, setSnapshot] = useState<AppMsgLocalDbSnapshot>(() => service.inspectLocalDb());
  const [messages, setMessages] = useState<AppMsgMessage[]>([]);
  const [targets, setTargets] = useState<AppMsgTargetSyncState[]>([]);
  const [search, setSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<string>("");
  const [onlineHex, setOnlineHex] = useState("");
  const [onlineResult, setOnlineResult] = useState<AppMsgOnlineResult>({});
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "fail"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setSnapshot(service.inspectLocalDb());
    const items = await service.listAllLocalMessages({ limit: 500 });
    setMessages(items);
    setTargets(await service.listTargetSyncStates());
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 订阅 unfiltered 推送：让统计 / 浏览能随推送增量更新。
  useEffect(() => {
    const off = core.subscribeUnfilteredMessages(() => {
      void refresh();
    });
    return () => {
      off();
    };
  }, [core, refresh]);

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
    // **total** = 当前 owner 本地消息总数（按消息条数计，与 endpoint 维度无关）。
    //
    // **byKey** = "涉及该 endpoint 的消息数"——每条消息对其**去重后**的
    // endpoint 集合各贡献 1 次。例如一条 `senderAppId === recipientAppId`
    // 的自发自收消息只对 `appId:<id>` 贡献 1，不会因为两个端相同而算成 2。
    //
    // **不要**把 byKey 的累加和 total 视为必须相等：
    //   - 一条消息可能涉及 0 / 1 / 2 / 4 个 endpoint（sender / recipient
    //     两端独立各 1 / 2 个 key）；
    //   - byKey 总和 ≥ total × 1（去重后每条至少贡献 0，每条带 endpoint
    //     的至少贡献 1）。
    // 后续如果有人想"修正"为 sum(byKey) === total，请先回看这段注释——
    // 这是有意保留的"分布"语义，**不**是错误。
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

  return (
    <section className="appmsg-system-page" data-hubmsg-page="ok">
      <h1 className="appmsg-system-page__title">{i18n.t("hubmsg.page.title")}</h1>

      <div className="appmsg-system-page__card">
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("hubmsg.page.connection.state")}
          </span>
          <span
            className={`appmsg-system-page__value appmsg-system-page__status ${connectionStatusClass(snapshot.state)}`}
            data-hubmsg-state={snapshot.state}
          >
            {snapshot.state === "open"
              ? i18n.t("hubmsg.page.connection.state.open")
              : snapshot.state === "closed"
                ? i18n.t("hubmsg.page.connection.state.closed")
                : i18n.t("hubmsg.page.connection.state.idle")}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("hubmsg.page.connection.owner")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.ownerPublicKeyHex ?? "(none)"}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("hubmsg.page.connection.url")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {DEFAULT_HUBMSG_URL}
          </span>
        </div>
        <div className="appmsg-system-page__row">
          <span className="appmsg-system-page__label">
            {i18n.t("hubmsg.page.connection.lastError")}
          </span>
          <span className="appmsg-system-page__value appmsg-system-page__value--mono">
            {snapshot.lastError ?? i18n.t("hubmsg.page.connection.lastError.none")}
          </span>
        </div>
      </div>

      <div className="appmsg-system-page__card appmsg-system-page__card--sync">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("hubmsg.page.sync")}
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
                  setSyncMsg({ kind: "ok", text: i18n.t("hubmsg.page.sync.trigger.done") });
                  // 同步成功后立刻拉一次新数据；否则用户看到的 target 状态
                  // / 浏览列表可能仍是旧的。
                  await refresh();
                })
                .catch((err: unknown) => {
                  const text = err instanceof Error ? err.message : String(err);
                  setSyncMsg({
                    kind: "fail",
                    text: `${i18n.t("hubmsg.page.sync.trigger.fail")}: ${text}`
                  });
                });
            }}
          >
            {i18n.t("hubmsg.page.sync.trigger")}
          </button>
          {syncMsg ? (
            <span
              className={`appmsg-system-page__sync-msg appmsg-system-page__sync-msg--${syncMsg.kind}`}
              data-hubmsg-sync={syncMsg.kind}
            >
              {syncMsg.text}
            </span>
          ) : null}
        </div>
        <h3 className="appmsg-system-page__sub-title">
          {i18n.t("hubmsg.page.sync.targets")}
        </h3>
        {targets.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("hubmsg.page.sync.targets.empty")}
          </p>
        ) : (
          <div className="appmsg-system-page__table-wrap">
            <table className="appmsg-system-page__table">
              <thead>
                <tr>
                  <th>targetKey</th>
                  <th>{i18n.t("hubmsg.page.sync.target.lastSynced")}</th>
                  <th>{i18n.t("hubmsg.page.sync.target.lastReceived")}</th>
                  <th>{i18n.t("hubmsg.page.sync.target.error")}</th>
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
                    <td>{t.lastSyncError ?? i18n.t("hubmsg.page.sync.target.error.none")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="appmsg-system-page__card appmsg-system-page__card--stats">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("hubmsg.page.stats")}
        </h2>
        <div className="appmsg-system-page__stats-row">
          <span className="appmsg-system-page__label">
            {i18n.t("hubmsg.page.stats.total")}
          </span>
          <span className="appmsg-system-page__metric">{stats.total}</span>
        </div>
        <h3 className="appmsg-system-page__sub-title">
          {i18n.t("hubmsg.page.stats.byKey")}
        </h3>
        {stats.entries.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("hubmsg.page.stats.byKey.empty")}
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

      <div className="appmsg-system-page__card appmsg-system-page__card--online">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("hubmsg.page.online.label")}
        </h2>
        <div className="appmsg-system-page__online-row">
          <input
            type="text"
            value={onlineHex}
            onChange={(e) => setOnlineHex(e.target.value)}
            placeholder={i18n.t("hubmsg.page.online.placeholder")}
            className="appmsg-system-page__input"
          />
          <button
            type="button"
            className="appmsg-system-page__button"
            onClick={async () => {
              const hex = onlineHex.trim();
              if (!/^[0-9a-f]{66}$/i.test(hex)) return;
              const out = await service.checkOnline([hex]);
              setOnlineResult(out);
            }}
          >
            {i18n.t("hubmsg.page.online.check")}
          </button>
        </div>
        {Object.keys(onlineResult).length > 0 ? (
          <ul className="appmsg-system-page__online-list">
            {Object.entries(onlineResult).map(([k, v]) => (
              <li key={k}>
                <code>{k.slice(0, 8)}…</code>:{" "}
                {v === "online"
                  ? i18n.t("hubmsg.page.online.online")
                  : v === "offline"
                    ? i18n.t("hubmsg.page.online.offline")
                    : i18n.t("hubmsg.page.online.unknown")}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="appmsg-system-page__card appmsg-system-page__card--browse">
        <h2 className="appmsg-system-page__section-title">
          {i18n.t("hubmsg.page.browse")}
        </h2>
        <div className="appmsg-system-page__browse-filter">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={i18n.t("hubmsg.page.browse.search")}
            className="appmsg-system-page__input"
          />
          <select
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            className="appmsg-system-page__input"
          >
            <option value="">{i18n.t("hubmsg.page.browse.filter.all")}</option>
            {endpointKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {filtered.length === 0 ? (
          <p className="appmsg-system-page__empty">
            {i18n.t("hubmsg.page.browse.empty")}
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
 * 每条消息可能同时携带 sender 与 recipient 两侧 endpoint——
 * 两侧都属于"我以这个 endpoint 维度收 / 发"的本地真值；统计 / 过滤 /
 * 展示都走同一份 set。
 *
 * 去重语义：
 *   - 用 `Set<string>` 收集，最终 `Array.from(set)` 返回；
 *   - 这意味着同一条消息 `senderAppId === recipientAppId` 时
 *     （典型场景：`appId:keymaster.message` 自发自收）只计 1 次，
 *     **不**会在 byKey 里加 2、也不会在过滤 `<select>` 里出现两条
 *     同名 option。
 *
 * 规则：
 *   - 有 senderOrigin → `origin:<senderOrigin>`
 *   - 有 senderAppId   → `appId:<senderAppId>`
 *   - 有 recipientOrigin → `origin:<recipientOrigin>`
 *   - 有 recipientAppId   → `appId:<recipientAppId>`
 *   - 都缺 → 返回空数组（这条消息本地没有 endpoint 真值，**不**进入统计）。
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
 * 映射规则：
 *   - `open`   → `is-ok`：已连上，状态正常；
 *   - `closed` → `is-failed`：明确失败态；
 *   - `idle`   → `is-partial`：未启动 / 等待中。
 *
 * **不**新增 `is-open / is-closed / is-idle` 这套并行命名空间——CSS
 * 已用抽象色命名（`is-ok / is-partial / is-failed`）覆盖三种状态，
 * 在 JSX 里继续堆状态名只会让 styles 双套命名。`data-hubmsg-state`
 * 仍带 raw state，便于诊断；样式 class 走抽象色。
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
  if (h.length <= 12) return h;
  return `${h.slice(0, 8)}…`;
}