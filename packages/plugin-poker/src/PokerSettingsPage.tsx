// packages/plugin-poker/src/PokerSettingsPage.tsx
// 设置页：proxy endpoint / 双平面 endpoint 公告 / 稳定 poker identity
// 绑定 / 允许 fallback broadcast / 主动连接断开 / adapter 诊断。
//
// 设计缘由（硬切换 001 修订版）：
//   - 643 行要求 settings 页暴露：proxy endpoint、稳定 poker identity
//     绑定、网络状态、诊断。
//   - vault 锁定时禁用所有操作（fail-closed）。
//   - 双平面：P2PNode endpoint 与 TxLink endpoint 分别保存，UI 里也
//     分别命名，避免压成"一个 endpoint"。
//   - identity binding 选择器：从 service.listIdentityCandidates 拉
//     可用 key，绑定后立即生效；切换 binding 会主动 disconnect 旧 session。

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerIdentityBindingState,
  type PokerIdentityCandidate,
  type PokerService
} from "@keymaster/contracts";
import { adapterSelfCheck } from "./tsstack/adapter.js";

export function PokerSettingsPage(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [endpoint, setEndpoint] = useState("");
  const [p2pNodeAnnounce, setP2pNodeAnnounce] = useState("");
  const [txLinkAnnounce, setTxLinkAnnounce] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [status, setStatus] = useState<PokerConnectionStatus>("idle");
  const [binding, setBinding] = useState<PokerIdentityBindingState>(null);
  const [candidates, setCandidates] = useState<PokerIdentityCandidate[]>([]);
  const [selectedHash, setSelectedHash] = useState<string>("");

  // 加载 settings + 订阅 status / binding / settings 变化。
  //
  // 设计缘由（修复"绑定后 hydrate 出来的 settings 不会刷到表单"问题）：
  // bindIdentity 触发 service.hydrateSettingsForCurrentIdentity()，那是
  // 异步的；如果只在 mount 时读一次 service.getSettings()，表单永远是
  // 当时的快照，hydrate 出来的新值永远到不了输入框。订阅 onSettingsChange
  // 后，每次 service 内部状态变更（hydrate / updateSettings）都会把最新
  // 值同步到本地表单 state。
  useEffect(() => {
    if (!service) return;
    const apply = (s: ReturnType<PokerService["getSettings"]>) => {
      setEndpoint(s.proxyEndpoint);
      setP2pNodeAnnounce(s.announceP2PNodeEndpoint ?? "");
      setTxLinkAnnounce(s.announceTxLinkEndpoint ?? "");
      setAllowFallback(s.allowFallbackBroadcast);
    };
    apply(service.getSettings());
    const offStatus = service.onStatusChange((next) => setStatus(next));
    const offBinding = service.onIdentityBindingChange((b) => setBinding(b));
    const offSettings = service.onSettingsChange(apply);
    return () => { offStatus(); offBinding(); offSettings(); };
  }, [service]);

  // 加载 candidate 列表（vault 解锁 + binding 变化后刷新）。
  const refreshCandidates = useCallback(async () => {
    if (!service) return;
    try {
      const list = await service.listIdentityCandidates();
      setCandidates(list);
      if (!selectedHash && list.length > 0) {
        setSelectedHash(binding?.publicKeyHash ?? (list[0]?.publicKeyHash ?? ""));
      }
    } catch {
      setCandidates([]);
    }
  }, [service, binding, selectedHash]);

  useEffect(() => { void refreshCandidates(); }, [refreshCandidates]);

  if (!service) {
    return <div className="poker-settings-empty">{t("poker.err.notReady")}</div>;
  }

  const statusKey = `poker.status.${status}`;
  const diag = adapterSelfCheck();

  const onSave = async () => {
    if (!endpoint) return;
    await service.updateSettings({
      proxyEndpoint: endpoint.trim(),
      announceP2PNodeEndpoint: p2pNodeAnnounce.trim() || undefined,
      announceTxLinkEndpoint: txLinkAnnounce.trim() || undefined,
      allowFallbackBroadcast: allowFallback
    });
  };
  const onConnect = async () => {
    try { await service.connect(); } catch { /* status will reflect */ }
  };
  const onDisconnect = () => service.disconnect();
  const onBind = async () => {
    if (!selectedHash) return;
    try {
      await service.bindIdentity({ publicKeyHash: selectedHash });
    } catch {
      // UI 不抛红；status / binding 已自动更新。
    }
  };
  const onUnbind = async () => {
    try { await service.unbindIdentity(); } catch { /* swallow */ }
  };

  return (
    <div className="poker-settings">
      <h1>{t("poker.settings.label")}</h1>
      <p>{t("poker.settings.description")}</p>
      <p>status: {t(statusKey)}</p>

      <section className="poker-settings-identity">
        <h2>{t("poker.settings.identity")}</h2>
        {binding ? (
          <p>
            {t("poker.settings.identity.bound")}: <code>{binding.label}</code>
            {" · "}<code>{binding.publicKeyHex.slice(0, 16)}…</code>
          </p>
        ) : (
          <p>{t("poker.settings.identity.unbound")}</p>
        )}
        <label>
          {t("poker.settings.identity.select")}
          <select value={selectedHash} onChange={(e) => setSelectedHash(e.target.value)}>
            <option value="">--</option>
            {candidates.map((c) => (
              <option key={c.publicKeyHash} value={c.publicKeyHash}>
                {c.label} {c.isActive ? "(active)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button onClick={onBind} disabled={!selectedHash}>{t("poker.settings.identity.bind")}</button>
        <button onClick={onUnbind} disabled={!binding}>{t("poker.settings.identity.unbind")}</button>
      </section>

      <section className="poker-settings-endpoint">
        <h2>{t("poker.settings.endpoint")}</h2>
        <label>
          {t("poker.settings.endpoint")}
          <input
            type="text"
            placeholder={t("poker.settings.endpointHint")}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
        <label>
          {t("poker.settings.announceP2PNode")}
          <input
            type="text"
            placeholder={t("poker.settings.announceP2PNodeHint")}
            value={p2pNodeAnnounce}
            onChange={(e) => setP2pNodeAnnounce(e.target.value)}
          />
        </label>
        <label>
          {t("poker.settings.announceTxLink")}
          <input
            type="text"
            placeholder={t("poker.settings.announceTxLinkHint")}
            value={txLinkAnnounce}
            onChange={(e) => setTxLinkAnnounce(e.target.value)}
          />
        </label>
        <label>
          {t("poker.settings.allowFallback")}
          <input
            type="checkbox"
            checked={allowFallback}
            onChange={(e) => setAllowFallback(e.target.checked)}
          />
        </label>
      </section>

      <div className="poker-settings-actions">
        <button onClick={onSave} disabled={!endpoint}>{t("poker.settings.save")}</button>
        <button onClick={onConnect} disabled={!endpoint || !binding}>{t("poker.settings.connect")}</button>
        <button onClick={onDisconnect}>{t("poker.settings.disconnect")}</button>
      </div>

      <section className="poker-settings-diag">
        <h2>{t("poker.settings.diag")}</h2>
        <p>
          ts-stack adapter: {diag.ok ? "ok" : "fail"} (sha256(\"ping\") = <code>{diag.sample.slice(0, 16)}…</code>)
        </p>
      </section>
    </div>
  );
}
