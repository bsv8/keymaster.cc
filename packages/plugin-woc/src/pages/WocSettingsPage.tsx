// packages/plugin-woc/src/pages/WocSettingsPage.tsx
// WOC 设置页面：URL、频率、队列快照。
// 设计缘由：WOC 配置是 WOC 服务配置，必须独立于 P2PKH 设置页。
// 错误信息使用英文（请求频率校验抛英文错），页面展示文案走 i18n。

import { useEffect, useMemo, useState } from "react";
import { Button, TextInput } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useLocale } from "@keymaster/runtime";
import { WOC_CAPABILITY, WOC_COORDINATOR_CONTROL_CAPABILITY, type P2pkhCoordinatorControl, type WocConfig, type WocQueueSnapshot, type WocService } from "@keymaster/contracts";
import { DEFAULT_WOC_CONFIG, validateRequestsPerSecond } from "../wocSettings.js";

export function WocSettingsPage() {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；设置区可能正好挂载在 BSV 链
  // 页面上，必须按"暂不可用"渲染而不是抛错。
  const service = useOptionalCapability(WOC_CAPABILITY);
  const coordinator = useOptionalCapability(WOC_COORDINATOR_CONTROL_CAPABILITY);
  if (!service || !coordinator) {
    return (
      <p className="woc-settings__unavailable">
        {t("woc.settings.unavailable", { defaultValue: "钱包已锁定或 WOC 服务暂不可用；解锁后可继续配置。" })}
      </p>
    );
  }
  return <WocSettingsPageInner service={service} coordinator={coordinator} />;
}

function WocSettingsPageInner({
  service,
  coordinator
}: {
  service: WocService;
  coordinator: P2pkhCoordinatorControl;
}) {
  const { t } = useI18n();
  const locale = useLocale();
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }),
    [locale]
  );
  const [draft, setDraft] = useState<WocConfig>({ ...service.getConfig(), baseUrl: DEFAULT_WOC_CONFIG.baseUrl });
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WocQueueSnapshot>(service.getQueueSnapshot());

  useEffect(() => {
    setDraft({ ...service.getConfig(), baseUrl: DEFAULT_WOC_CONFIG.baseUrl });
  }, [service]);

  useEffect(() => {
    let alive = true;
    void coordinator.p2pkhProviderConfigGet("woc").then((result) => {
      if (!alive || result.status !== "ok") return;
      const requestsPerSecond = typeof result.value.requestsPerSecond === "number" ? result.value.requestsPerSecond : service.getConfig().requestsPerSecond;
      setDraft({ baseUrl: DEFAULT_WOC_CONFIG.baseUrl, requestsPerSecond });
    });
    return () => { alive = false; };
  }, [coordinator, service]);

  useEffect(() => {
    return service.onConfigChange((c) => setDraft({ ...c, baseUrl: DEFAULT_WOC_CONFIG.baseUrl }));
  }, [service]);

  useEffect(() => {
    return service.onQueueChange((s) => setSnapshot(s));
  }, [service]);

  async function apply(next: WocConfig) {
    const previous = { ...service.getConfig(), baseUrl: DEFAULT_WOC_CONFIG.baseUrl };
    const nextConfig = { ...next, baseUrl: DEFAULT_WOC_CONFIG.baseUrl };
    setDraft(nextConfig);
    setError(null);
    const rateCheck = validateRequestsPerSecond(nextConfig.requestsPerSecond);
    if (!rateCheck.ok) {
      setError(rateCheck.error);
      return;
    }
    try {
      const result = await coordinator.p2pkhProviderConfigUpdate("woc", { endpoint: DEFAULT_WOC_CONFIG.baseUrl, requestsPerSecond: rateCheck.value });
      if (result.status !== "accepted" && result.status !== "ok") {
        setDraft(previous);
        setError("message" in result ? result.message : "Coordinator configuration update failed");
        return;
      }
    } catch (cause) {
      setDraft(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    // Coordinator 已确认持久化成功后，才更新 actor 的运行时配置。
    service.updateConfig({ baseUrl: DEFAULT_WOC_CONFIG.baseUrl, requestsPerSecond: rateCheck.value });
  }

  function reset() {
    void apply({ ...DEFAULT_WOC_CONFIG });
  }

  return (
    <div className="woc-settings">
      <TextInput
        label={t("woc.field.baseUrl", { defaultValue: "WOC base URL" })}
        description={t("woc.field.baseUrlDesc", { defaultValue: "固定地址：https://api.whatsonchain.com/v1/bsv" })}
        value={DEFAULT_WOC_CONFIG.baseUrl}
        readOnly
      />
      <TextInput
        label={t("woc.field.rps", { defaultValue: "每秒请求数" })}
        description={t("woc.field.rpsDesc", { defaultValue: "公共 API 建议默认 2；自定义代理可提高。" })}
        type="number"
        value={String(draft.requestsPerSecond)}
        onChange={(e) => setDraft((current) => ({ ...current, requestsPerSecond: Number(e.currentTarget.value) }))}
        onBlur={() => void apply(draft)}
      />
      {error ? <p className="woc-settings__error">{error}</p> : null}
      <div className="woc-settings__actions">
        <Button variant="ghost" onClick={reset}>
          {t("woc.action.reset", { defaultValue: "恢复缺省" })}
        </Button>
      </div>
      <section className="woc-settings__status">
        <h4>{t("woc.status.section", { defaultValue: "队列状态" })}</h4>
        <p>{t("woc.status.queued", { defaultValue: "排队：" })}{snapshot.queued}</p>
        <p>{t("woc.status.inFlight", { defaultValue: "飞行中：" })}{snapshot.inFlight}</p>
        <p>
          {snapshot.backoffUntil
            ? t("woc.status.backoffLine", { defaultValue: "WOC 全局 backoff 解除于 {{time}}", time: timeFmt.format(new Date(snapshot.backoffUntil)) })
            : t("woc.status.noBackoff", { defaultValue: "无 backoff" })}
        </p>
        {snapshot.lastError ? (
          <p>
            {t("woc.status.lastError", { defaultValue: "最近错误：" })}
            {snapshot.lastError}
          </p>
        ) : null}
        {snapshot.coordinated ? (
          <p>{t("woc.status.coordinated.ok", { defaultValue: "多标签页协调：已启用（Web Locks）" })}</p>
        ) : (
          <p className="woc-settings__warning">
            {t("woc.status.coordinated.warn", { defaultValue: "多标签页协调：未启用。当前浏览器不支持 Web Locks，跨标签页限流无法保证；请只开一个钱包标签页或换用支持 Web Locks 的浏览器以避免触发 WOC 限流。" })}
          </p>
        )}
      </section>
    </div>
  );
}
