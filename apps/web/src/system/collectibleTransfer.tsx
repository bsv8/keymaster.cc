import { useEffect, useMemo, useState } from "react";
import type { CollectibleDetail, CollectibleProvider, CollectibleRef, CollectibleRegistry, CollectibleTransferHandler, CollectibleTransferRegistry } from "@keymaster/contracts";
import { useCapability, useCurrentPath, useI18n, usePluginHost } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function pickHandler(handlers: CollectibleTransferHandler[]): CollectibleTransferHandler | undefined {
  if (handlers.length === 0) return undefined;
  return [...handlers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
}

function observationLabel(observation: "unconfirmed" | "confirmed" | undefined, t: (key: string, values?: { defaultValue?: string }) => string): string | undefined {
  if (observation === "unconfirmed") return t("collectibleTransfer.observation.unconfirmed", { defaultValue: "WOC 已观察（未确认）" });
  if (observation === "confirmed") return t("collectibleTransfer.observation.confirmed", { defaultValue: "WOC 已确认" });
  return undefined;
}

export function CollectibleTransferPage() {
  useCurrentPath();
  const { t } = useI18n();
  const providerId = readQuery("providerId");
  const collectibleId = readQuery("collectibleId");
  const recipientPublicKeyHex = readQuery("recipientPublicKeyHex") || undefined;
  const normalizedRecipient = recipientPublicKeyHex?.trim().toLowerCase();
  const validRecipient = normalizedRecipient && /^(02|03)[0-9a-f]{64}$/.test(normalizedRecipient) ? normalizedRecipient : undefined;
  if (!providerId || !collectibleId) {
    return <EmptyState title={t("collectibleTransfer.page.invalid.title", { defaultValue: "无法开始转移" })} />;
  }
  if (recipientPublicKeyHex && !validRecipient) {
    return <EmptyState title={t("collectibleTransfer.page.invalidRecipient", { defaultValue: "联系人转账目标无效" })} />;
  }
  return <CollectibleTransferBody providerId={providerId} collectibleId={collectibleId} recipientPublicKeyHex={validRecipient} />;
}

function CollectibleTransferBody({ providerId, collectibleId, recipientPublicKeyHex }: { providerId: string; collectibleId: string; recipientPublicKeyHex?: string }) {
  const { t } = useI18n();
  const host = usePluginHost();
  const collectibles = useCapability<CollectibleRegistry>("collectible.registry");
  const transferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const [provider, setProvider] = useState<CollectibleProvider | undefined>();
  const [detail, setDetail] = useState<CollectibleDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const handlers = useMemo(() => transferRegistry.listSupporting({ providerId, collectibleId }).filter((handler) => {
    if (!recipientPublicKeyHex) return true;
    return handler.supportsRecipientPublicKeyHex?.(recipientPublicKeyHex) === true;
  }), [collectibleId, providerId, recipientPublicKeyHex, transferRegistry]);
  const chosen = pickHandler(handlers);

  useEffect(() => {
    setLoaded(false);
    setDetail(undefined);
    setError(undefined);
    const p = collectibles.get(providerId);
    setProvider(p);
    if (!p) return;
    void p.getCollectible(collectibleId)
      .then((item) => {
        setDetail(item ?? undefined);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
  }, [collectibles, collectibleId, providerId]);

  if (!provider) {
    return <EmptyState title={t("collectibleTransfer.page.loading", { defaultValue: "正在加载…" })} />;
  }
  if (error) {
    return <EmptyState title={t("collectibleTransfer.page.error.title", { defaultValue: "载入藏品失败" })} description={error} />;
  }
  if (loaded && !detail) {
    return <EmptyState title={t("collectibleTransfer.page.missing.title", { defaultValue: "该藏品已不可用" })} description={t("collectibleTransfer.page.missing.desc", { defaultValue: "WOC 最终状态已将其从当前持仓中移除，请返回后重新选择。" })} />;
  }
  if (!detail) {
    return <EmptyState title={t("collectibleTransfer.page.loading", { defaultValue: "正在加载…" })} />;
  }
  if (!chosen) {
    return <EmptyState title={t("collectibleTransfer.page.empty.title", { defaultValue: "暂无可用转移处理器" })} />;
  }

  const Widget = chosen.component;
  const ref: CollectibleRef = { providerId, collectibleId };
  return (
    <div className="collectible-transfer-page">
      <PageHeader
        title={host.i18n.text(detail.summary.name)}
        description={
          detail.summary.observation
            ? `${host.i18n.text(chosen.name)} · ${observationLabel(detail.summary.observation, t)}`
            : host.i18n.text(chosen.name)
        }
      />
      <Widget
        collectibleRef={ref}
        detail={detail}
        recipientPublicKeyHex={recipientPublicKeyHex}
        onCompleted={() => undefined}
      />
    </div>
  );
}
