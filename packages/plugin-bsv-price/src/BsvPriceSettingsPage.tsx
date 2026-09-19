// packages/plugin-bsv-price/src/BsvPriceSettingsPage.tsx
// BSV Price 设置详情页。
//
// 设计缘由：
//   - 管理价格发布服务器（名称 + 公钥）与激活的「供应商-交易所-交易对」；
//   - 交易对选项只来自当前激活服务器已收到的行情列表；
//   - 只订阅激活服务器的频道；切换服务器立即重订阅，切换交易对只改展示；
//   - 「恢复原始设置」回到缺省 bsv8 服务器 + gate/bsvusdt；没有"清空公钥"；
//   - 保存按钮显式提交，便于严格校验与回滚。

import { useEffect, useState, type ReactElement } from "react";
import { Button, PageHeader, Select, TextInput } from "@keymaster/ui";
import { useOptionalCapability, useResource } from "webloom-framework/react";
import type { I18nValues } from "@keymaster/contracts";
import { useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type { BsvPriceService, BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { deriveUnitFromPair } from "./bsvPriceSettings.js";
import { DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX } from "./constants.js";

import { BSV_PRICE_SERVICE_CAPABILITY } from "./manifest.js";

/**
 * BSV Price 设置页根组件。
 *
 * 设计缘由：capability 不存在时仍要给出可读空态，避免 host 外调用直接炸。
 */
export function BsvPriceSettingsPage(): ReactElement {
  const { t } = useI18n();
  const service = useBsvPriceServiceOrNull();
  if (!service) {
    return (
      <section
        className="km-bsv-price-settings-page km-bsv-price-settings-page--missing"
        data-bsv-price-settings="missing-service"
      >
        <h1 className="km-bsv-price-settings-page__title">
          {t("bsv-price.settings.title")}
        </h1>
        <p className="km-bsv-price-settings-page__empty">
          bsv-price.service is not available.
        </p>
      </section>
    );
  }
  return <BsvPriceSettingsPageInner service={service} />;
}

/** capability 不存在时返回 null，避免页面直接抛错。 */
function useBsvPriceServiceOrNull(): BsvPriceService | null {
  return useOptionalCapability(BSV_PRICE_SERVICE_CAPABILITY) ?? null;
}

function BsvPriceSettingsPageInner({ service }: { service: BsvPriceService }): ReactElement {
  const { t } = useI18n();
  const locale = useLocale();
  const host = usePluginHost();
  const snapshot = useResource<BsvPriceServiceSnapshot>(host.resourceStore, "bsv-price.snapshot", []);
  const snap = snapshot.data ?? service.snapshot();

  const [serverDraft, setServerDraft] = useState(snap.active.publisherPublicKeyHex);
  const [marketDraft, setMarketDraft] = useState(snap.active.market);
  const [pairDraft, setPairDraft] = useState(snap.active.pair);
  const [nameDraft, setNameDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setServerDraft(snap.active.publisherPublicKeyHex);
    setMarketDraft(snap.active.market);
    setPairDraft(snap.active.pair);
  }, [snap.active.publisherPublicKeyHex, snap.active.market, snap.active.pair]);

  const marketOptions = collectIdentifiers(
    Object.keys(snap.snapshot?.markets ?? {}),
    marketDraft
  );
  const pairOptions = collectIdentifiers(
    Object.keys(snap.snapshot?.markets[marketDraft] ?? {}),
    pairDraft
  );
  const unit = deriveUnitFromPair(pairDraft);
  const channelPreview = snap.configured ? snap.channelId : NOT_CONFIGURED_LABEL;
  const statusLabel = statusText(snap.status, t);

  async function run(action: () => Promise<unknown>, successMessage: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(successMessage);
    } catch (err) {
      setError(describeActionError(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function onApplyOption(): Promise<void> {
    await run(
      () => service.setActiveOption({
        publisherPublicKeyHex: serverDraft,
        market: marketDraft,
        pair: pairDraft
      }),
      t("bsv-price.settings.activeSaved", { defaultValue: "已保存激活选项" })
    );
  }

  async function onAddServer(): Promise<void> {
    await run(async () => {
      await service.addServer({ name: nameDraft, publisherPublicKeyHex: keyDraft });
      setNameDraft("");
      setKeyDraft("");
    }, t("bsv-price.settings.serverAdded", { defaultValue: "已添加服务器" }));
  }

  async function onRemoveServer(publisherPublicKeyHex: string): Promise<void> {
    await run(
      () => service.removeServer(publisherPublicKeyHex),
      t("bsv-price.settings.serverRemoved", { defaultValue: "已删除服务器" })
    );
  }

  async function onRestore(): Promise<void> {
    await run(
      () => service.restoreOriginalSettings(),
      t("bsv-price.settings.restored", { defaultValue: "已恢复原始设置" })
    );
  }

  return (
    <section className="km-bsv-price-settings-page" data-bsv-price-settings="main">
      <PageHeader
        title={t("bsv-price.settings.title", { defaultValue: "BSV Price settings" })}
        description={t("bsv-price.settings.desc", {
          defaultValue: "Manage price publisher servers and the active quote. The price is display-only and never used for business decisions."
        })}
        actions={
          <Button onClick={() => void onRestore()} loading={busy}>
            {t("bsv-price.settings.restore", { defaultValue: "恢复原始设置" })}
          </Button>
        }
      />

      <div className="km-bsv-price-settings-page__card">
        <h2 className="km-bsv-price-settings-page__section-title">
          {t("bsv-price.settings.servers.label", { defaultValue: "价格发布服务器" })}
        </h2>
        <p className="km-bsv-price-settings-page__hint">
          {t("bsv-price.settings.servers.desc", {
            defaultValue: "只订阅当前激活的服务器；价格频道为 `bsvprice.<发布器公钥>`。"
          })}
        </p>

        <ul className="km-bsv-price-settings-page__servers" data-bsv-price-servers>
          {snap.servers.map((server) => {
            const active = server.publisherPublicKeyHex === snap.active.publisherPublicKeyHex;
            const isDefault = server.publisherPublicKeyHex === DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX;
            return (
              <li
                key={server.publisherPublicKeyHex}
                className={`km-bsv-price-settings-page__server${active ? " is-active" : ""}`}
                data-bsv-price-server
              >
                <label className="km-bsv-price-settings-page__server-main">
                  <input
                    type="radio"
                    name="bsv-price-active-server"
                    checked={active}
                    disabled={busy}
                    onChange={() => setServerDraft(server.publisherPublicKeyHex)}
                  />
                  <span className="km-bsv-price-settings-page__server-name">{server.name}</span>
                  {isDefault ? (
                    <span className="km-bsv-price-settings-page__server-badge">
                      {t("bsv-price.settings.server.default", { defaultValue: "默认" })}
                    </span>
                  ) : null}
                </label>
                {isDefault ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-bsv-price-server-delete
                    onClick={() => void onRemoveServer(server.publisherPublicKeyHex)}
                  >
                    {t("bsv-price.settings.server.delete", { defaultValue: "删除" })}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="km-bsv-price-settings-page__add-server">
          <TextInput
            label={t("bsv-price.settings.server.name", { defaultValue: "名称" })}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.currentTarget.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-bsv-price-server-name
          />
          <TextInput
            label={t("bsv-price.settings.server.key", { defaultValue: "发布器公钥 hex" })}
            placeholder="02... (66 hex chars)"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.currentTarget.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-bsv-price-server-key
          />
          <Button onClick={() => void onAddServer()} loading={busy} data-bsv-price-server-add>
            {t("bsv-price.settings.server.add", { defaultValue: "添加服务器" })}
          </Button>
        </div>
      </div>

      <div className="km-bsv-price-settings-page__card">
        <h2 className="km-bsv-price-settings-page__section-title">
          {t("bsv-price.settings.active.label", { defaultValue: "激活选项" })}
        </h2>

        <div className="km-bsv-price-settings-page__grid">
          <Select
            label={t("bsv-price.settings.active.server", { defaultValue: "服务器" })}
            value={serverDraft}
            onChange={(e) => setServerDraft(e.currentTarget.value)}
            options={snap.servers.map((server) => ({
              value: server.publisherPublicKeyHex,
              label: server.name
            }))}
            data-bsv-price-active-server
          />
          <Select
            label={t("bsv-price.settings.active.market", { defaultValue: "交易所" })}
            value={marketDraft}
            onChange={(e) => {
              const market = e.currentTarget.value;
              setMarketDraft(market);
              const pairs = Object.keys(snap.snapshot?.markets[market] ?? {});
              if (pairs.length > 0) setPairDraft(pairs[0]!);
            }}
            options={marketOptions.map((market) => ({ value: market, label: market }))}
            data-bsv-price-active-market
          />
          <Select
            label={t("bsv-price.settings.active.pair", { defaultValue: "交易对" })}
            value={pairDraft}
            onChange={(e) => setPairDraft(e.currentTarget.value)}
            options={pairOptions.map((pair) => ({ value: pair, label: pair }))}
            data-bsv-price-active-pair
          />
          <div className="km-bsv-price-settings-page__unit">
            <span className="ui-field__label">
              {t("bsv-price.settings.active.unit", { defaultValue: "单位" })}
            </span>
            <span
              className="km-bsv-price-settings-page__value km-bsv-price-settings-page__mono"
              data-bsv-price-active-unit
            >
              {unit || "—"}
            </span>
          </div>
        </div>
        {snap.snapshot === null ? (
          <p className="km-bsv-price-settings-page__hint" data-bsv-price-active-waiting>
            {t("bsv-price.settings.active.waiting", { defaultValue: "（等待激活服务器收到行情列表）" })}
          </p>
        ) : null}
        <Button onClick={() => void onApplyOption()} loading={busy} data-bsv-price-active-apply>
          {t("bsv-price.settings.active.apply", { defaultValue: "应用选项" })}
        </Button>
      </div>

      <div className="km-bsv-price-settings-page__card">
        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.price.label", { defaultValue: "当前价格" })}
          </div>
          <div className="km-bsv-price-settings-page__value km-bsv-price-settings-page__mono" data-bsv-price-settings-price>
            {snap.price.amount} {snap.price.unit}
          </div>
        </div>
        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.channel.label", { defaultValue: "当前订阅频道" })}
          </div>
          <div
            className="km-bsv-price-settings-page__value km-bsv-price-settings-page__mono"
            data-bsv-price-settings-channel
          >
            {channelPreview}
          </div>
        </div>
        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.status.label", { defaultValue: "当前状态" })}
          </div>
          <div className="km-bsv-price-settings-page__value" data-bsv-price-settings-status>
            {statusLabel}
          </div>
        </div>
        <div className="km-bsv-price-settings-page__row">
          <div className="km-bsv-price-settings-page__label">
            {t("bsv-price.settings.snapshotAt.label", { defaultValue: "快照时间" })}
          </div>
          <div className="km-bsv-price-settings-page__value" data-bsv-price-settings-snapshot-at>
            {formatTimestamp(snap.price.updatedAtMs, locale)}
          </div>
        </div>

        <p className="km-bsv-price-settings-page__hint">
          {t("bsv-price.settings.clearHint", {
            defaultValue: "价格只用于和 sats 相乘做参考显示，不作为业务输入。"
          })}
        </p>

        {message ? (
          <p className="km-bsv-price-settings-page__message" data-bsv-price-settings-message>
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="km-bsv-price-settings-page__error" data-bsv-price-settings-error>
            {error}
          </p>
        ) : null}
        {snap.subscriptionErrorCode ? (
          <p className="km-bsv-price-settings-page__error" data-bsv-price-subscription-error>
            {t("bsv-price.settings.subscriptionError", { defaultValue: "订阅错误" })} ({snap.subscriptionErrorCode})
            {snap.subscriptionErrorMessage ? `: ${snap.subscriptionErrorMessage}` : ""}
          </p>
        ) : null}
        {snap.status === "sat_balance_required" ? (
          <p className="km-bsv-price-settings-page__hint" data-bsv-price-settings-balance-hint>
            {t("bsv-price.settings.balanceHint", { defaultValue: "请先为 SatSubscription 充值。" })}
          </p>
        ) : null}
        {snap.status === "subscription_unknown" ? (
          <p className="km-bsv-price-settings-page__hint" data-bsv-price-settings-unknown-hint>
            {t("bsv-price.settings.unknownHint", { defaultValue: "请勿手动重复扣费，等待系统对账。" })}
          </p>
        ) : null}
      </div>
    </section>
  );
}

const NOT_CONFIGURED_LABEL = "(not configured)";

/** 把当前值并入收到的标识符列表，保证下拉永远能显示当前选择。 */
function collectIdentifiers(received: string[], current: string): string[] {
  const values = [...received];
  if (current && !values.includes(current)) values.push(current);
  return values.sort();
}

function statusText(
  status: string,
  t: (key: string, values?: I18nValues) => string
): string {
  switch (status) {
    case "offline": return t("bsv-price.settings.status.offline", { defaultValue: "已断开" });
    case "idle": return t("bsv-price.settings.status.idle", { defaultValue: "空闲" });
    case "not_configured": return t("bsv-price.settings.status.notConfigured", { defaultValue: "未配置" });
    case "sat_not_configured": return t("bsv-price.settings.status.satNotConfigured", { defaultValue: "SatSubscription 未配置" });
    case "sat_connecting": return t("bsv-price.settings.status.satConnecting", { defaultValue: "正在连接 SatSubscription" });
    case "sat_balance_required": return t("bsv-price.settings.status.satBalanceRequired", { defaultValue: "SatSubscription 余额不足" });
    case "sat_identity_error": return t("bsv-price.settings.status.satIdentityError", { defaultValue: "SatSubscription 身份错误" });
    case "sat_subscription_error": return t("bsv-price.settings.status.satSubscriptionError", { defaultValue: "SatSubscription 订阅失败" });
    case "subscription_unknown": return t("bsv-price.settings.status.subscriptionUnknown", { defaultValue: "订阅结果未知，请等待重试" });
    case "waiting_snapshot": return t("bsv-price.settings.status.waitingSnapshot", { defaultValue: "等待 BSV 价格快照" });
    case "receiving": return t("bsv-price.settings.status.receiving", { defaultValue: "正在接收" });
    default: return status;
  }
}

function describeActionError(
  t: (key: string, values?: I18nValues) => string,
  err: unknown
): string {
  const code = err instanceof Error ? err.message : String(err);
  const known = new Set([
    "invalid_type", "invalid_empty", "invalid_length", "invalid_hex", "invalid_prefix",
    "invalid_public_key", "invalid_identifier", "invalid_character", "server_exists",
    "server_not_found", "default_server_required", "last_server_required",
    "invalid_bsv_price_config"
  ]);
  if (known.has(code)) {
    return t(`bsv-price.settings.error.${code}`, { defaultValue: code });
  }
  return code;
}

function formatTimestamp(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString(locale);
  } catch {
    return new Date(ms).toISOString();
  }
}
