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
  const handlers = useMemo(() => transferRegistry.listSupporting({ providerId, collectibleId }).filter((handler) => {
    if (!recipientPublicKeyHex) return true;
    return handler.supportsRecipientPublicKeyHex?.(recipientPublicKeyHex) === true;
  }), [collectibleId, providerId, recipientPublicKeyHex, transferRegistry]);
  const chosen = pickHandler(handlers);

  useEffect(() => {
    const p = collectibles.get(providerId);
    setProvider(p);
    if (!p) return;
    void p.getCollectible(collectibleId).then((item) => setDetail(item ?? undefined));
  }, [collectibles, collectibleId, providerId]);

  if (!provider || !detail) {
    return <EmptyState title={t("collectibleTransfer.page.loading", { defaultValue: "正在加载…" })} />;
  }
  if (!chosen) {
    return <EmptyState title={t("collectibleTransfer.page.empty.title", { defaultValue: "暂无可用转移处理器" })} />;
  }

  const Widget = chosen.component;
  const ref: CollectibleRef = { providerId, collectibleId };
  return (
    <div className="collectible-transfer-page">
      <PageHeader title={host.i18n.text(detail.summary.name)} description={host.i18n.text(chosen.name)} />
      <Widget
        collectibleRef={ref}
        detail={detail}
        recipientPublicKeyHex={recipientPublicKeyHex}
        onCompleted={() => undefined}
      />
    </div>
  );
}
