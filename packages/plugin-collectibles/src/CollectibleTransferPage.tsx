import { useCollectiblesResources } from "./CollectiblesResourceContext.js";
import { useMemo } from "react";
import type { CollectibleDetail, CollectibleRef, CollectibleTransferHandler } from "@keymaster/contracts";
import { COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";

function readQuery(name: string, path: string): string {
  return new URLSearchParams(path.split("?", 2)[1]?.split("#", 1)[0] ?? "").get(name) ?? "";
}

function pickHandler(handlers: CollectibleTransferHandler[]): CollectibleTransferHandler | undefined {
  if (handlers.length === 0) return undefined;
  return [...handlers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
}

function observationLabel(observation: "unconfirmed" | "confirmed" | undefined, t: (key: string, values?: { defaultValue?: string }) => string): string | undefined {
  if (observation === "unconfirmed") return t("collectibles.transfer.observation.unconfirmed", { defaultValue: "WOC 已观察（未确认）" });
  if (observation === "confirmed") return t("collectibles.transfer.observation.confirmed", { defaultValue: "WOC 已确认" });
  return undefined;
}

export function CollectibleTransferPage({ location }: { location: import("@keymaster/contracts").PageUiLocation }) {
  const { t } = usePluginI18n();
  const providerId = readQuery("providerId", location.path);
  const collectibleId = readQuery("collectibleId", location.path);
  const recipientPublicKeyHex = readQuery("recipientPublicKeyHex", location.path) || undefined;
  const normalizedRecipient = recipientPublicKeyHex?.trim().toLowerCase();
  const validRecipient = normalizedRecipient && /^(02|03)[0-9a-f]{64}$/.test(normalizedRecipient) ? normalizedRecipient : undefined;
  if (!providerId || !collectibleId) {
    return <EmptyState title={t("collectibles.transfer.page.invalid.title", { defaultValue: "无法开始转移" })} />;
  }
  if (recipientPublicKeyHex && !validRecipient) {
    return <EmptyState title={t("collectibles.transfer.page.invalidRecipient", { defaultValue: "联系人转账目标无效" })} />;
  }
  return <CollectibleTransferBody providerId={providerId} collectibleId={collectibleId} recipientPublicKeyHex={validRecipient} />;
}

function CollectibleTransferBody({ providerId, collectibleId, recipientPublicKeyHex }: { providerId: string; collectibleId: string; recipientPublicKeyHex?: string }) {
  const { t, text } = usePluginI18n();
  const reader = useCollectiblesResources();
  const transferRegistry = usePluginCapability(COLLECTIBLE_TRANSFER_REGISTRY_CAPABILITY);
  const snapshot = useResourceView<{ provider: { id: string; name: import("@keymaster/contracts").I18nText }; detail: CollectibleDetail | null } | null>(reader, "collectible-transfer.detail", [providerId, collectibleId]);
  const detail = snapshot.data?.detail;
  const handlers = useMemo(() => transferRegistry.listSupporting({ providerId, collectibleId }).filter((handler) => {
    if (!recipientPublicKeyHex) return true;
    return handler.supportsRecipientPublicKeyHex?.(recipientPublicKeyHex) === true;
  }), [collectibleId, providerId, recipientPublicKeyHex, transferRegistry]);
  const chosen = pickHandler(handlers);

  if (snapshot.error) {
    return <EmptyState title={t("collectibles.transfer.page.error.title", { defaultValue: "载入藏品失败" })} description={snapshot.error.message} />;
  }
  if (snapshot.status === "ready" && !detail) {
    return <EmptyState title={t("collectibles.transfer.page.missing.title", { defaultValue: "该藏品已不可用" })} description={t("collectibles.transfer.page.missing.desc", { defaultValue: "WOC 最终状态已将其从当前持仓中移除，请返回后重新选择。" })} />;
  }
  if (!detail) {
    return <EmptyState title={t("collectibles.transfer.page.loading", { defaultValue: "正在加载…" })} />;
  }
  if (!chosen) {
    return <EmptyState title={t("collectibles.transfer.page.empty.title", { defaultValue: "暂无可用转移处理器" })} />;
  }

  const Widget = chosen.component;
  const ref: CollectibleRef = { providerId, collectibleId };
  return (
    <div className="collectible-transfer-page">
      <PageHeader
        title={text(detail.summary.name)}
        description={
          detail.summary.observation
            ? `${text(chosen.name)} · ${observationLabel(detail.summary.observation, t)}`
            : text(chosen.name)
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
