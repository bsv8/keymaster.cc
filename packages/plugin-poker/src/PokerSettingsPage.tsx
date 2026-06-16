// packages/plugin-poker/src/PokerSettingsPage.tsx
// 设置页：proxy endpoint / 双平面 endpoint 公告 / 稳定 poker identity
// 绑定 / 允许 fallback broadcast / 主动连接断开 / adapter 诊断。
//
// 设计缘由（硬切换 001 + 002 修订版）：
//   - 643 行要求 settings 页暴露：proxy endpoint、稳定 poker identity
//     绑定、网络状态、诊断。
//   - vault 锁定时禁用所有操作（fail-closed）。
//   - 双平面：P2PNode endpoint 与 TxLink endpoint 分别保存，UI 里也
//     分别命名，避免压成"一个 endpoint"。
//   - identity binding 选择器：从 service.listIdentityCandidates 拉
//     可用 key，绑定后立即生效；切换 binding 会主动 disconnect 旧 session。
//   - 硬切换 002：本页是 Poker 唯一正式设置页；/settings 不再展示字段
//     拼盘版 Poker 配置。组件全部使用 @keymaster/ui 提供的原子组件，
//     不直接写裸 <input>/<select>/<button>。

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, PageHeader, Select, TextInput } from "@keymaster/ui";
import { useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerIdentityBindingState,
  type PokerIdentityCandidate,
  type PokerService
} from "@keymaster/contracts";
import { adapterSelfCheck } from "./tsstack/adapter.js";

type StatusKind = PokerConnectionStatus;

function statusClass(s: StatusKind): string {
  return `poker-settings__status-badge poker-settings__status-badge--${s}`;
}

export function PokerSettingsPage(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [endpoint, setEndpoint] = useState("");
  const [p2pNodeAnnounce, setP2pNodeAnnounce] = useState("");
  const [txLinkAnnounce, setTxLinkAnnounce] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [status, setStatus] = useState<StatusKind>("idle");
  const [binding, setBinding] = useState<PokerIdentityBindingState>(null);
  const [candidates, setCandidates] = useState<PokerIdentityCandidate[]>([]);
  const [selectedHash, setSelectedHash] = useState<string>("");
  const [saved, setSaved] = useState(false);

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
    return () => {
      offStatus();
      offBinding();
      offSettings();
    };
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

  useEffect(() => {
    void refreshCandidates();
  }, [refreshCandidates]);

  if (!service) {
    return (
      <div className="poker-settings poker-settings--empty">
        <PageHeader
          title={t("poker.settings.label", { defaultValue: "Poker" })}
          description={t("poker.settings.description", { defaultValue: "Proxy endpoint and broadcast policy." })}
        />
        <div className="poker-settings__empty">{t("poker.err.notReady")}</div>
      </div>
    );
  }

  const statusKey = `poker.status.${status}`;
  const diag = adapterSelfCheck();
  const endpointReady = endpoint.trim().length > 0;

  const onSave = async () => {
    if (!endpointReady) return;
    await service.updateSettings({
      proxyEndpoint: endpoint.trim(),
      announceP2PNodeEndpoint: p2pNodeAnnounce.trim() || undefined,
      announceTxLinkEndpoint: txLinkAnnounce.trim() || undefined,
      allowFallbackBroadcast: allowFallback
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const onConnect = async () => {
    try {
      await service.connect();
    } catch {
      /* status will reflect */
    }
  };
  const onDisconnect = () => service.disconnect();
  const onBind = async () => {
    if (!selectedHash) return;
    try {
      await service.bindIdentity({ publicKeyHash: selectedHash });
    } catch {
      /* UI 不抛红；status / binding 已自动更新 */
    }
  };
  const onUnbind = async () => {
    try {
      await service.unbindIdentity();
    } catch {
      /* swallow */
    }
  };

  const candidateOptions = [
    {
      label: { key: "poker.settings.identity.selectPlaceholder", fallback: "—" },
      value: ""
    },
    ...candidates.map((c) => ({
      label: {
        key: `poker.candidate.${c.publicKeyHash}`,
        fallback: `${c.label}${c.isActive ? " (active)" : ""}`
      },
      value: c.publicKeyHash
    }))
  ];

  return (
    <div className="poker-settings">
      <PageHeader
        title={t("poker.settings.label", { defaultValue: "Poker" })}
        description={t("poker.settings.description", { defaultValue: "Proxy endpoint and broadcast policy." })}
      />
      <div className="poker-settings__status-bar">
        <span className="poker-settings__status-label">{t("poker.settings.status.label", { defaultValue: "Status" })}</span>
        <span className={statusClass(status)}>{t(statusKey, { defaultValue: status })}</span>
        {binding ? (
          <span className="poker-settings__status-binding">
            {t("poker.settings.identity.bound", { defaultValue: "Bound to" })}:{" "}
            <code>{binding.label}</code> · <code>{binding.publicKeyHex.slice(0, 16)}…</code>
          </span>
        ) : (
          <span className="poker-settings__status-binding poker-settings__status-binding--unbound">
            {t("poker.settings.identity.unbound", { defaultValue: "No poker identity bound (fail-closed)" })}
          </span>
        )}
      </div>

      <section className="poker-settings__section poker-settings-identity">
        <h2>{t("poker.settings.identity.section", { defaultValue: "Identity binding" })}</h2>
        <div className="poker-settings-identity__row">
          <Select
            label={t("poker.settings.identity.select", { defaultValue: "Select vault key" })}
            value={selectedHash}
            onChange={(e) => setSelectedHash(e.currentTarget.value)}
            options={candidateOptions}
          />
          <div className="poker-settings-identity__actions">
            <Button size="sm" onClick={onBind} disabled={!selectedHash}>
              {t("poker.settings.identity.bind", { defaultValue: "Bind" })}
            </Button>
            <Button size="sm" variant="ghost" onClick={onUnbind} disabled={!binding}>
              {t("poker.settings.identity.unbind", { defaultValue: "Unbind" })}
            </Button>
          </div>
        </div>
      </section>

      <section className="poker-settings__section poker-settings-endpoint">
        <h2>{t("poker.settings.network", { defaultValue: "Network" })}</h2>
        <TextInput
          label={t("poker.settings.endpoint", { defaultValue: "Proxy WSS endpoint" })}
          hint={t("poker.settings.endpointHint", { defaultValue: "e.g. wss://poker-proxy.example.com" })}
          placeholder="wss://poker-proxy.example.com"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
        <TextInput
          label={t("poker.settings.announceP2PNode", { defaultValue: "Announced P2PNode endpoint" })}
          hint={t("poker.settings.announceP2PNodeHint", { defaultValue: "host:port for the P2PNode plane (mesh)" })}
          value={p2pNodeAnnounce}
          onChange={(e) => setP2pNodeAnnounce(e.target.value)}
        />
        <TextInput
          label={t("poker.settings.announceTxLink", { defaultValue: "Announced TxLink endpoint" })}
          hint={t("poker.settings.announceTxLinkHint", { defaultValue: "host:port for the TxLink plane (raw tx)" })}
          value={txLinkAnnounce}
          onChange={(e) => setTxLinkAnnounce(e.target.value)}
        />
        <label className="poker-settings__fallback">
          <input
            type="checkbox"
            checked={allowFallback}
            onChange={(e) => setAllowFallback(e.target.checked)}
          />
          <span>{t("poker.settings.allowFallback", { defaultValue: "Allow fallback broadcast" })}</span>
        </label>
      </section>

      <section className="poker-settings__section poker-settings-actions">
        <h2>{t("poker.settings.actions.section", { defaultValue: "Actions" })}</h2>
        <div className="poker-settings-actions__row">
          <Button size="sm" onClick={onSave} disabled={!endpointReady}>
            {t("poker.settings.save", { defaultValue: "Save" })}
          </Button>
          <Button size="sm" onClick={onConnect} disabled={!endpointReady || !binding}>
            {t("poker.settings.connect", { defaultValue: "Connect" })}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDisconnect}>
            {t("poker.settings.disconnect", { defaultValue: "Disconnect" })}
          </Button>
          {saved ? (
            <span className="poker-settings-actions__saved">
              {t("poker.settings.saved", { defaultValue: "Saved" })}
            </span>
          ) : null}
        </div>
      </section>

      <section className="poker-settings__section poker-settings-diag">
        <h2>{t("poker.settings.diag", { defaultValue: "Diagnostics" })}</h2>
        <p className="poker-settings-diag__line">
          ts-stack adapter: <strong>{diag.ok ? "ok" : "fail"}</strong>{" "}
          (sha256("ping") = <code>{diag.sample.slice(0, 16)}…</code>)
        </p>
      </section>
    </div>
  );
}
