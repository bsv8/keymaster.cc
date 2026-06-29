// packages/plugin-collectibles/src/CollectibleDetailPage.tsx
// collectible 通用详情页：从 ?providerId=&collectibleId= 读取，渲染 preview
// / attributes / activity，并按 collectible-transfer.registry 决定
// 是否显示"转移"按钮。
//
// 设计缘由：
//   - 即使 provider 没声明 detailRoute，通用详情页也必须能完整工作。
//   - "转移"按钮只在 collectible-transfer.registry 至少有一个 supports
//     handler 时显示；否则按钮以 disabled 形态呈现，文案提示用户
//     "暂无可用转移处理器"。
//   - 列表页 / 详情页默认只用 preview / metadata / link，不自动下载
//     巨大二进制正文。

import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { router, AppLink, useCapability, useI18n, useLocale, usePluginHost } from "@keymaster/runtime";
import type {
  CollectibleActivity,
  CollectibleDetail,
  CollectibleProvider,
  CollectibleRegistry,
  CollectibleTransferHandler,
  CollectibleTransferRegistry,
  LogWriteInput
} from "@keymaster/contracts";

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

export function CollectibleDetailPage() {
  const { t } = useI18n();
  useI18n().language();
  const providerId = readQuery("providerId");
  const collectibleId = readQuery("collectibleId");

  if (!providerId || !collectibleId) {
    return (
      <div className="collectible-detail">
        <p>{t("collectibles.redirect.missing", { defaultValue: "缺少 providerId/collectibleId 参数。" })}</p>
      </div>
    );
  }

  return <CollectibleDetail providerId={providerId} collectibleId={collectibleId} />;
}

interface CollectibleDetailProps {
  providerId: string;
  collectibleId: string;
}

function CollectibleDetail({ providerId, collectibleId }: CollectibleDetailProps) {
  const registry = useCapability<CollectibleRegistry>("collectible.registry");
  const transferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const [provider, setProvider] = useState<CollectibleProvider | undefined>(undefined);
  const [detail, setDetail] = useState<CollectibleDetail | null>(null);
  const [activities, setActivities] = useState<CollectibleActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = registry.get(providerId);
    if (!p) {
      setError(`Unknown collectible provider "${providerId}"`);
      return;
    }
    setProvider(p);
    p.getCollectible(collectibleId)
      .then((d) => {
        if (!d) {
          setError(`Collectible "${collectibleId}" not found in provider "${providerId}"`);
          return;
        }
        setDetail(d);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    p.listActivity(collectibleId)
      .then(setActivities)
      .catch(() => setActivities([]));
  }, [registry, providerId, collectibleId]);

  const handlers: CollectibleTransferHandler[] = useMemo(() => {
    if (!detail) return [];
    return transferRegistry.listSupporting({ providerId, collectibleId });
  }, [transferRegistry, providerId, collectibleId, detail]);

  if (error) {
    return (
      <div className="collectible-detail">
        <PageHeader title={t("collectibles.detail.title", { defaultValue: "藏品详情" })} />
        <EmptyState
          title={t("collectibles.detail.notFound", { defaultValue: "无法显示藏品" })}
          description={error}
        />
      </div>
    );
  }

  if (!provider || !detail) {
    return (
      <div className="collectible-detail">
        <PageHeader
          title={t("collectibles.detail.title", { defaultValue: "藏品详情" })}
          description={t("collectibles.detail.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  // 转移入口：handlers 非空才允许进入；order 冲突抛英文错误并记日志。
  const transferEntry = pickTransferHandler(handlers, host.log.forPlugin("collectibles"));

  return (
    <div className="collectible-detail">
      <PageHeader
        title={host.i18n.text(detail.summary.name)}
        description={`${host.i18n.text(provider.name)} · ${detail.summary.status}`}
        actions={
          <>
            {transferEntry ? (
              <Button
                onClick={() =>
                  router.push(
                    `/collectibles/transfer?providerId=${encodeURIComponent(providerId)}&collectibleId=${encodeURIComponent(collectibleId)}`
                  )
                }
              >
                {t("collectibles.detail.transfer", { defaultValue: "转移" })}
              </Button>
            ) : (
              <Button disabled title={t("collectibles.detail.transferUnavailable", { defaultValue: "暂无可用转移处理器" })}>
                {t("collectibles.detail.transferUnavailable", { defaultValue: "暂无可用转移处理器" })}
              </Button>
            )}
            {detail.summary.detailRoute?.path ? (
              <Button onClick={() => router.push(detail.summary.detailRoute!.path!)}>
                {t("assets.detail.openSpecific", { defaultValue: "打开专属详情" })}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="collectible-detail__preview">
        {renderPreview(detail, host.i18n.text(detail.summary.name), t)}
      </div>
      <p>
        {t("collectibles.detail.loading", { defaultValue: "正在加载…" }) ? null : null}
        <code>{detail.summary.collectibleId}</code>
      </p>
      {detail.attributes && detail.attributes.length > 0 ? (
        <section>
          <h3>{t("collectibles.detail.attributes", { defaultValue: "属性" })}</h3>
          <table className="collectible-detail__attributes">
            <tbody>
              {detail.attributes.map((a) => (
                <tr key={`${a.key}:${a.value}`}>
                  <th>{a.key}</th>
                  <td>{a.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section>
        <h3>{t("collectibles.detail.activity", { defaultValue: "活动" })}</h3>
        {activities.length === 0 ? (
          <p>{t("collectibles.detail.activityEmpty", { defaultValue: "暂无活动" })}</p>
        ) : (
          <ul>
            {activities.map((a) => (
              <li key={a.id}>
                <span>{host.i18n.text(a.title)}</span>
                {a.txid ? <code>{a.txid}</code> : null}
                {a.occurredAt ? <time>{dateFmt.format(new Date(a.occurredAt))}</time> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 选择 handler：handler 数为 0 / 1 直接返回；多 handler 且 order 唯一时
 * 选最小者；order 冲突抛英文错误并记日志。
 */
function pickTransferHandler(
  handlers: CollectibleTransferHandler[],
  logger: { error?: (input: LogWriteInput) => void } | undefined
): CollectibleTransferHandler | null {
  if (handlers.length === 0) return null;
  if (handlers.length === 1) return handlers[0]!;
  // 多 handler：先按 order 升序，再检查是否冲突。
  const sorted = [...handlers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const top = sorted[0]!;
  const conflict = sorted.slice(1).some((h) => (h.order ?? 0) === (top.order ?? 0));
  if (conflict) {
    const msg = `Multiple collectible transfer handlers with the same order are registered; refusing to pick one silently. handlers=${sorted.map((h) => h.id).join(",")}`;
    logger?.error?.({
      scope: "plugin-collectibles",
      event: "transfer.handler.conflict",
      message: msg,
      data: { handlerIds: sorted.map((h) => h.id) }
    });
    throw new Error(msg);
  }
  return top;
}

function renderPreview(
  detail: CollectibleDetail,
  alt: string,
  t: (key: string, opts?: { defaultValue?: string }) => string
) {
  const preview = detail.preview ?? detail.summary.preview;
  if (!preview) {
    return <span>{t("collectibles.detail.previewMissing", { defaultValue: "暂无预览" })}</span>;
  }
  if (preview.url && preview.contentType?.startsWith("image/")) {
    return <img src={preview.url} alt={alt} loading="lazy" />;
  }
  if (preview.url) {
    // 预览媒体可能是外部 URL（http(s) / ipfs: / data: 等）；走 AppLink 让
    // runtime 的 isInternalHref 判定：内部 → SPA 跳转；外部 → 浏览器默认
    // 行为（不阻断 <a>，保持链接语义）。AppLink 自身已支持 target / rel。
    return (
      <AppLink to={preview.url} target="_blank" rel="noopener noreferrer">
        {preview.contentType ?? preview.url}
      </AppLink>
    );
  }
  return <span>{preview.text ?? t("collectibles.detail.previewMissing", { defaultValue: "暂无预览" })}</span>;
}