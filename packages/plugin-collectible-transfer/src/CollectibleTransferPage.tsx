// packages/plugin-collectible-transfer/src/CollectibleTransferPage.tsx
// collectible transfer 平台页面。
//
// 设计缘由：
//   - 从 ?providerId=&collectibleId= 读取目标 collectible ref。
//   - 读取 collectible.registry 拿 CollectibleDetail。
//   - 读取 collectible-transfer.registry 选择 handler。
//   - 选择规则（硬切换）：
//       0 个 supports：空态，不白屏。
//       1 个 supports：直接挂载。
//       多个 supports：按 order 升序选最小者；order 冲突抛英文错误并
//         记日志，禁止静默随机挑选。
//   - 平台不解释 outpoint / raw tx / 手续费 / 脚本；widget 由 handler
//     自己提供。

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type {
  CollectibleDetail,
  CollectibleProvider,
  CollectibleRef,
  CollectibleRegistry,
  CollectibleTransferHandler,
  CollectibleTransferRegistry,
  LogWriteInput
} from "@keymaster/contracts";

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

export function CollectibleTransferPage() {
  const { t } = useI18n();
  useI18n().language();
  const providerId = readQuery("providerId");
  const collectibleId = readQuery("collectibleId");

  if (!providerId || !collectibleId) {
    return (
      <div className="collectible-transfer-page">
        <PageHeader
          title={t("collectibleTransfer.page.title", { defaultValue: "转移藏品" })}
        />
        <EmptyState
          title={t("collectibleTransfer.page.invalid.title", { defaultValue: "无法开始转移" })}
          description={t("collectibleTransfer.page.invalid.desc", { defaultValue: "缺少 providerId/collectibleId 参数。" })}
        />
      </div>
    );
  }

  return <CollectibleTransferBody providerId={providerId} collectibleId={collectibleId} />;
}

interface BodyProps {
  providerId: string;
  collectibleId: string;
}

function CollectibleTransferBody({ providerId, collectibleId }: BodyProps) {
  const ref: CollectibleRef = { providerId, collectibleId };
  const collectibles = useCapability<CollectibleRegistry>("collectible.registry");
  const transferRegistry = useCapability<CollectibleTransferRegistry>("collectible-transfer.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();

  const [provider, setProvider] = useState<CollectibleProvider | undefined>(undefined);
  const [detail, setDetail] = useState<CollectibleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = collectibles.get(providerId);
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
  }, [collectibles, providerId, collectibleId]);

  const handlers = useMemo(() => transferRegistry.listSupporting(ref), [transferRegistry, providerId, collectibleId]);

  if (error) {
    return (
      <div className="collectible-transfer-page">
        <PageHeader title={t("collectibleTransfer.page.title", { defaultValue: "转移藏品" })} />
        <EmptyState
          title={t("collectibleTransfer.page.notFound.title", { defaultValue: "藏品未找到" })}
          description={error}
        />
      </div>
    );
  }

  if (!provider || !detail) {
    return (
      <div className="collectible-transfer-page">
        <PageHeader
          title={t("collectibleTransfer.page.title", { defaultValue: "转移藏品" })}
          description={t("collectibleTransfer.page.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  if (handlers.length === 0) {
    return (
      <div className="collectible-transfer-page">
        <PageHeader title={t("collectibleTransfer.page.title", { defaultValue: "转移藏品" })} />
        <EmptyState
          title={t("collectibleTransfer.page.empty.title", { defaultValue: "暂无可用转移处理器" })}
          description={t("collectibleTransfer.page.empty.desc", {
            defaultValue: "当前藏品没有可用的转移处理器；请安装对应协议的转移 handler 插件。"
          })}
        />
      </div>
    );
  }

  // 1 个 handler：直接挂载；多 handler：按 order 选最小者，冲突抛英文错误。
  const chosen = pickHandler(handlers, host.log.forPlugin("collectible-transfer"));
  const Widget = chosen.component;

  return (
    <div className="collectible-transfer-page">
      <PageHeader
        title={host.i18n.text(detail.summary.name)}
        description={host.i18n.text(chosen.name)}
      />
      <Widget
        ref={ref}
        detail={detail}
        onCompleted={(result) => {
          host.log.forPlugin("collectible-transfer").info({
            scope: "plugin-collectible-transfer",
            event: "transfer.completed",
            message: `Collectible transfer completed: ${provider.id}/${result.ref.collectibleId}`,
            data: { providerId: result.ref.providerId, collectibleId: result.ref.collectibleId, reference: result.reference }
          });
        }}
      />
    </div>
  );
}

function pickHandler(
  handlers: CollectibleTransferHandler[],
  logger: { error?: (input: LogWriteInput) => void } | undefined
): CollectibleTransferHandler {
  if (handlers.length === 1) return handlers[0]!;
  const sorted = [...handlers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const top = sorted[0]!;
  const conflict = sorted.slice(1).some((h) => (h.order ?? 0) === (top.order ?? 0));
  if (conflict) {
    const msg = `Multiple collectible transfer handlers with the same order are registered; refusing to pick one silently. handlers=${sorted.map((h) => h.id).join(",")}`;
    logger?.error?.({
      scope: "plugin-collectible-transfer",
      event: "transfer.handler.conflict",
      message: msg,
      data: { handlerIds: sorted.map((h) => h.id) }
    });
    throw new Error(msg);
  }
  return top;
}