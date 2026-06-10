// packages/plugin-woc/src/pages/WocSettingsPage.tsx
// WOC 设置页面：URL、频率、队列快照。
// 设计缘由：WOC 配置是 WOC 服务配置，必须独立于 P2PKH 设置页。
// 错误信息使用英文（validateWocBaseUrl/validateRequestsPerSecond 抛英文错），
// 页面展示文案走 i18n。

import { useEffect, useMemo, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, useLocale } from "@keymaster/runtime";
import type { WocConfig, WocQueueSnapshot, WocService } from "@keymaster/contracts";
import { DEFAULT_WOC_CONFIG, validateRequestsPerSecond, validateWocBaseUrl } from "../wocSettings.js";

export function WocSettingsPage() {
  const service = useCapability<WocService>("woc.service");
  const { t } = useI18n();
  useI18n().language();
  const locale = useLocale();
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }),
    [locale]
  );
  const [draft, setDraft] = useState<WocConfig>(service.getConfig());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WocQueueSnapshot>(service.getQueueSnapshot());

  useEffect(() => {
    setDraft(service.getConfig());
  }, [service]);

  useEffect(() => {
    return service.onConfigChange((c) => setDraft(c));
  }, [service]);

  useEffect(() => {
    return service.onQueueChange((s) => setSnapshot(s));
  }, [service]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  function save() {
    setError(null);
    const urlCheck = validateWocBaseUrl(draft.baseUrl);
    if (!urlCheck.ok) {
      setError(urlCheck.error);
      return;
    }
    const rateCheck = validateRequestsPerSecond(draft.requestsPerSecond);
    if (!rateCheck.ok) {
      setError(rateCheck.error);
      return;
    }
    try {
      service.updateConfig({ baseUrl: urlCheck.value, requestsPerSecond: rateCheck.value });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    setDraft({ ...DEFAULT_WOC_CONFIG });
    setError(null);
  }

  return (
    <div className="woc-settings">
      <PageHeader
        title={t("woc.page.title", { defaultValue: "WOC 设置" })}
        description={t("woc.page.desc", { defaultValue: "配置 WhatsOnChain 访问入口与每秒请求数。修改后对后续请求立即生效。" })}
      />
      <TextInput
        label={t("woc.field.baseUrl", { defaultValue: "WOC base URL" })}
        description={t("woc.field.baseUrlDesc", { defaultValue: "网络路径之前的根 URL；缺省 https://api.whatsonchain.com/v1/bsv" })}
        value={draft.baseUrl}
        onChange={(e) => setDraft({ ...draft, baseUrl: e.currentTarget.value })}
      />
      <TextInput
        label={t("woc.field.rps", { defaultValue: "每秒请求数" })}
        description={t("woc.field.rpsDesc", { defaultValue: "公共 API 建议默认 2；自定义代理可提高。" })}
        type="number"
        value={String(draft.requestsPerSecond)}
        onChange={(e) => setDraft({ ...draft, requestsPerSecond: Number(e.currentTarget.value) })}
      />
      {error ? <p className="woc-settings__error">{error}</p> : null}
      <div className="woc-settings__actions">
        <Button onClick={save}>{t("woc.action.save", { defaultValue: "保存" })}</Button>
        <Button variant="ghost" onClick={reset}>
          {t("woc.action.reset", { defaultValue: "恢复缺省" })}
        </Button>
        {saved ? <span className="woc-settings__saved">{t("woc.action.saved", { defaultValue: "已保存" })}</span> : null}
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
