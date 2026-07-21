// packages/plugin-broadcast/src/BroadcastPage.tsx
// 广播系统管理页（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 页面是 management UI；展示 core 当前所有诊断字段；
//   - 提供 active provider 切换按钮（写持久化 + 触发 core 内部
//     setActive）；
//   - 业务价格协议相关字段（订阅频道名等）放这里展示，**不**做编辑；
//     这是为了让"配错 publisher 公钥"在管理页直接可见（施工单 §6.10）；
//   - **不**直接持有 `BroadcastCore` 引用；走 capability 注入。
//   - **不**展示 envelope / signature 等 wire 细节。

import React, { useCallback, useMemo } from "react";
import { useCapability, useI18n, usePluginHost, useResource } from "@keymaster/runtime";
import type {
  BroadcastCoreSnapshot,
  BroadcastProvider
} from "@keymaster/contracts";
import type { BroadcastService } from "./broadcastService.js";

const BROADCAST_SERVICE_CAPABILITY = "broadcast.service";

export function BroadcastPage(): React.ReactElement {
  const i18n = useI18n();
  const service = useBroadcastServiceOrNull();
  if (!service) {
    return (
      <section
        className="km-broadcast-page km-broadcast-page--missing"
        data-broadcast-page="missing-service"
      >
        <h1 className="km-broadcast-page__title">{i18n.t("broadcast.page.title")}</h1>
        <p className="km-broadcast-page__empty">
          broadcast.service is not available.
        </p>
      </section>
    );
  }
  return <BroadcastPageInner service={service} i18n={i18n} />;
}

/**
 * 兼容版 `useCapability`：capability 不存在时返回 null（**不**抛错）。
 *
 * 设计缘由：plugin-broadcast 的 route 在 plugin enable 后才被注册；
 * 本组件一旦被路由命中，capability bus 上就一定有 `broadcast.service`。
 * 极端 host（如未通过 host 渲染）下 capability 可能没注册——这里仅做
 * 防御性兼容，**不**作为生产主路径。
 */
function useBroadcastServiceOrNull(): BroadcastService | null {
  try {
    return useCapability<BroadcastService>(BROADCAST_SERVICE_CAPABILITY);
  } catch {
    return null;
  }
}

function BroadcastPageInner({
  service,
  i18n
}: {
  service: BroadcastService;
  i18n: { t: (key: string) => string };
}): React.ReactElement {
  const host = usePluginHost();
  const state = useResource<{ snapshot: BroadcastCoreSnapshot; providers: readonly BroadcastProvider[] }>(host.resourceStore, "broadcast.state", []);
  const snap = state.data?.snapshot ?? service.snapshot();
  const providers = state.data?.providers ?? service.providers();
  const refresh = useCallback(() => host.resourceStore.invalidate("broadcast.state", []), [host]);

  const connectionLabel = useMemo(() => {
    switch (snap.state) {
      case "bound":
        return i18n.t("broadcast.page.connection.bound");
      case "connecting":
        return i18n.t("broadcast.page.connection.connecting");
      case "closed":
        return i18n.t("broadcast.page.connection.closed");
      case "idle":
      default:
        return i18n.t("broadcast.page.connection.idle");
    }
  }, [snap.state, i18n]);

  const handleSetActive = (id: string) => {
    void service.setActiveProvider(id).then(refresh);
  };
  const handleClearActive = () => {
    void service.setActiveProvider(null).then(refresh);
  };

  return (
    <section
      className="km-broadcast-page"
      data-broadcast-page="active"
      data-state={snap.state}
    >
      <h1 className="km-broadcast-page__title">{i18n.t("broadcast.page.title")}</h1>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.activeProvider")}</div>
        <div className="km-broadcast-page__value">
          {snap.providerId ?? (
            <span className="km-broadcast-page__muted">{i18n.t("broadcast.page.activeProvider.none")}</span>
          )}
        </div>
      </div>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.connection")}</div>
        <div className="km-broadcast-page__value">{connectionLabel}</div>
      </div>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.owner")}</div>
        <div className="km-broadcast-page__value km-broadcast-page__mono">
          {snap.desiredConnectionOwnerPublicKeyHex ?? (
            <span className="km-broadcast-page__muted">{i18n.t("broadcast.page.owner.none")}</span>
          )}
        </div>
      </div>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.lastError")}</div>
        <div className="km-broadcast-page__value km-broadcast-page__mono">
          {snap.lastError ?? (
            <span className="km-broadcast-page__muted">{i18n.t("broadcast.page.lastError.none")}</span>
          )}
        </div>
      </div>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.nextReconnect")}</div>
        <div className="km-broadcast-page__value km-broadcast-page__mono">
          {snap.nextReconnectAtMs ?? (
            <span className="km-broadcast-page__muted">{i18n.t("broadcast.page.nextReconnect.now")}</span>
          )}
        </div>
      </div>

      <div className="km-broadcast-page__row">
        <div className="km-broadcast-page__label">{i18n.t("broadcast.page.subscribedChannels")}</div>
        <div className="km-broadcast-page__value km-broadcast-page__channels">
          {snap.subscribedChannels.length === 0 ? (
            <span className="km-broadcast-page__muted">{i18n.t("broadcast.page.subscribedChannels.empty")}</span>
          ) : (
            <ul className="km-broadcast-page__channel-list">
              {snap.subscribedChannels.map((ch) => (
                <li key={ch} className="km-broadcast-page__channel">
                  {ch}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="km-broadcast-page__section">
        <h2 className="km-broadcast-page__section-title">
          {i18n.t("broadcast.page.providerList")}
        </h2>
        {providers.length === 0 ? (
          <p className="km-broadcast-page__empty">{i18n.t("broadcast.page.providerList.empty")}</p>
        ) : (
          <ul className="km-broadcast-page__provider-list">
            {providers.map((p) => {
              const isActive = snap.providerId === p.id;
              return (
                <li
                  key={p.id}
                  className={
                    "km-broadcast-page__provider" +
                    (isActive ? " km-broadcast-page__provider--active" : "")
                  }
                >
                  <div className="km-broadcast-page__provider-name">{p.displayName}</div>
                  <div className="km-broadcast-page__provider-id km-broadcast-page__mono">
                    {p.id}
                  </div>
                  <button
                    type="button"
                    className="km-broadcast-page__action"
                    onClick={() => handleSetActive(p.id)}
                    disabled={isActive}
                  >
                    {i18n.t("broadcast.page.action.setActive")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="km-broadcast-page__actions">
        <button
          type="button"
          className="km-broadcast-page__action km-broadcast-page__action--danger"
          onClick={handleClearActive}
          disabled={snap.providerId === null}
        >
          {i18n.t("broadcast.page.action.clearActive")}
        </button>
      </div>

      <p className="km-broadcast-page__note">{i18n.t("broadcast.page.note.keyProvider")}</p>
    </section>
  );
}
