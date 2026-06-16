// packages/plugin-poker/src/PokerSettingsPage.tsx
// 设置页：proxy endpoint / 双平面 endpoint 公告 / 允许 fallback broadcast /
// 当前扑克身份展示 / 连接控制。
//
// 设计缘由（硬切换 004）：
//   - Poker 不再维护独立的"稳定 poker identity 绑定"；身份真值永远跟随
//     keyspace.active()。本页**不再**提供 key 选择器 / 绑定按钮 / 解绑按钮。
//   - 页面只展示业务语义"当前扑克身份"，不向用户暴露 active key /
//     vault locked / all mode 这类系统内部概念。
//   - 会话不可用时仅显示"扑克当前不可用"之类的业务结果，不提示用户在
//     Poker 页里执行 key / wallet 操作；这些动作属于系统层。
//   - 网络配置（proxy endpoint / 双平面 announce / fallback 开关）属于
//     全局配置，切 key 不丢。表单直接编辑 service.getSettings()。
//   - 硬切换 002：本页是 Poker 唯一正式设置页；/settings 不再展示字段
//     拼盘版 Poker 配置。组件全部使用 @keymaster/ui 提供的原子组件，
//     不直接写裸 <input>/<select>/<button>。

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability } from "@keymaster/runtime";
import {
  POKER_SERVICE_CAPABILITY,
  type PokerConnectionStatus,
  type PokerService,
  type PokerSessionKeyState
} from "@keymaster/contracts";
import { adapterSelfCheck } from "./tsstack/adapter.js";

type StatusKind = PokerConnectionStatus;

function statusClass(s: StatusKind): string {
  return `poker-settings__status-badge poker-settings__status-badge--${s}`;
}

function describeSession(state: PokerSessionKeyState): {
  tone: "ok" | "fail";
  text: string;
} {
  switch (state.kind) {
    case "ready":
      return {
        tone: "ok",
        text: `${state.key.label} · ${shortHex(state.key.publicKeyHex ?? "")}`
      };
    default:
      return { tone: "fail", text: "unavailable" };
  }
}

function shortHex(hex: string): string {
  if (!hex) return "";
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 16)}…`;
}

export function PokerSettingsPage(): React.ReactElement {
  const { t } = useTranslation("poker");
  const service = useCapability<PokerService>(POKER_SERVICE_CAPABILITY);
  const [endpoint, setEndpoint] = useState("");
  const [p2pNodeAnnounce, setP2pNodeAnnounce] = useState("");
  const [txLinkAnnounce, setTxLinkAnnounce] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [status, setStatus] = useState<StatusKind>("idle");
  const [session, setSession] = useState<PokerSessionKeyState>({ kind: "vaultLocked" });
  const [saved, setSaved] = useState(false);

  // 加载 settings + 订阅 status / session / settings 变化。
  //
  // 设计缘由（硬切换 004）：
  //   - settings 来自全局 pokerGlobalConfig；订阅 onSettingsChange 让 hydrate
  //     或 updateSettings 都能同步到表单。
  //   - 订阅 onActivePokerKeyChange，让 active key 切换时表单立即反映
  //     "Connect 是否禁用 / 当前身份"。
  useEffect(() => {
    if (!service) return;
    const apply = (s: ReturnType<PokerService["getSettings"]>) => {
      setEndpoint(s.proxyEndpoint);
      setP2pNodeAnnounce(s.announceP2PNodeEndpoint ?? "");
      setTxLinkAnnounce(s.announceTxLinkEndpoint ?? "");
      setAllowFallback(s.allowFallbackBroadcast);
    };
    apply(service.getSettings());
    setSession(service.getActivePokerKey());
    const offStatus = service.onStatusChange((next) => setStatus(next));
    const offSession = service.onActivePokerKeyChange((next) => setSession(next));
    const offSettings = service.onSettingsChange(apply);
    return () => {
      offStatus();
      offSession();
      offSettings();
    };
  }, [service]);

  if (!service) {
    return (
      <div className="poker-settings poker-settings--empty">
        <PageHeader
          title={t("poker.settings.label", { defaultValue: "Poker" })}
          description={t("poker.settings.description", {
            defaultValue: "Proxy endpoint and broadcast policy."
          })}
        />
        <div className="poker-settings__empty">{t("poker.err.notReady")}</div>
      </div>
    );
  }

  const statusKey = `poker.status.${status}`;
  const diag = adapterSelfCheck();
  const endpointReady = endpoint.trim().length > 0;
  const sessionReady = session.kind === "ready";
  const sessionDesc = describeSession(session);
  const connectDisabled = !endpointReady || !sessionReady;

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

  return (
    <div className="poker-settings">
      <PageHeader
        title={t("poker.settings.label", { defaultValue: "Poker" })}
        description={t("poker.settings.description", {
          defaultValue: "Proxy endpoint and broadcast policy."
        })}
      />
      <div className="poker-settings__status-bar">
        <span className="poker-settings__status-label">
          {t("poker.settings.status.label", { defaultValue: "Status" })}
        </span>
        <span className={statusClass(status)}>{t(statusKey, { defaultValue: status })}</span>
        {sessionReady ? (
          <span
            className={`poker-settings__active-key poker-settings__active-key--${sessionDesc.tone}`}
          >
            {t("poker.settings.identity.label", { defaultValue: "Current poker identity" })}:{" "}
            <code>{sessionDesc.text}</code>
          </span>
        ) : null}
      </div>

      <section className="poker-settings__section poker-settings-active-key">
        <h2>
          {t("poker.settings.identity.section", { defaultValue: "Poker identity" })}
        </h2>
        {sessionReady ? (
          <p className="poker-settings-active-key__hint">
            {t("poker.settings.identity.hint", {
              defaultValue:
                "Poker uses the current identity for this session. If the identity changes, the current session will be rebuilt automatically."
            })}
          </p>
        ) : (
          <p className="poker-settings-active-key__warn">
            {t("poker.settings.identity.unavailable", {
              defaultValue: "Poker is currently unavailable."
            })}
          </p>
        )}
      </section>

      <section className="poker-settings__section poker-settings-endpoint">
        <h2>{t("poker.settings.network", { defaultValue: "Network" })}</h2>
        <TextInput
          label={t("poker.settings.endpoint", { defaultValue: "Proxy WSS endpoint" })}
          hint={t("poker.settings.endpointHint", {
            defaultValue: "e.g. wss://poker-proxy.example.com"
          })}
          placeholder="wss://poker-proxy.example.com"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
        <TextInput
          label={t("poker.settings.announceP2PNode", {
            defaultValue: "Announced P2PNode endpoint"
          })}
          hint={t("poker.settings.announceP2PNodeHint", {
            defaultValue: "host:port for the P2PNode plane (mesh)"
          })}
          value={p2pNodeAnnounce}
          onChange={(e) => setP2pNodeAnnounce(e.target.value)}
        />
        <TextInput
          label={t("poker.settings.announceTxLink", {
            defaultValue: "Announced TxLink endpoint"
          })}
          hint={t("poker.settings.announceTxLinkHint", {
            defaultValue: "host:port for the TxLink plane (raw tx)"
          })}
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
          <Button size="sm" onClick={onConnect} disabled={connectDisabled}>
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
