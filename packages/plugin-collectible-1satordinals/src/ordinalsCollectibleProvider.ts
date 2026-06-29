// packages/plugin-collectible-1satordinals/src/ordinalsCollectibleProvider.ts
// 1Sat Ordinals CollectibleProvider：聚合 ordinalsService 的 listActiveKeyCollectibles
// 为 CollectibleSummary / CollectibleDetail，注入 collectible.registry。
//
// 关键不变量：
//   - 1Sat outpoint 查询 404 / not-found 视为"普通 P2PKH UTXO，不是
//     collectible"，绝不记成 provider 错误。
//   - listCollectibles 整体抛错（非 404 类）才会被 plugin-collectibles
//     显示成 provider 错误；单 UTXO 404 不应让 provider 失败。

import type {
  CollectibleActivity,
  CollectibleAttribute,
  CollectibleDetail,
  CollectiblePreview,
  CollectibleProvider,
  CollectibleSummary
} from "@keymaster/contracts";
import type { OrdinalsOutpointHit, OrdinalsServiceHandle } from "./ordinalsService.js";

export interface OrdinalsCollectibleProviderOptions {
  service: OrdinalsServiceHandle;
}

export function createOrdinalsCollectibleProvider(
  options: OrdinalsCollectibleProviderOptions
): CollectibleProvider {
  if (!options || !options.service) {
    throw new Error("createOrdinalsCollectibleProvider: service is required");
  }
  const service = options.service;
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  function previewOf(hit: OrdinalsOutpointHit): CollectiblePreview {
    return {
      url: hit.inscription.preview,
      contentType: hit.inscription.contentType,
      text: hit.inscription.origin
    };
  }

  function summaryOf(hit: OrdinalsOutpointHit): CollectibleSummary {
    return {
      collectibleId: hit.outpoint,
      providerId: "1satordinals",
      name: hit.inscription.inscriptionId,
      collection: "1Sat Ordinals",
      ownerRef: hit.inscription.owner ?? hit.address,
      preview: previewOf(hit),
      status: "ready",
      tags: ["1satordinals", hit.network]
    };
  }

  function attributesOf(hit: OrdinalsOutpointHit): CollectibleAttribute[] {
    return [
      { key: "outpoint", value: hit.outpoint },
      { key: "inscriptionId", value: hit.inscription.inscriptionId },
      ...(hit.inscription.contentType ? [{ key: "contentType", value: hit.inscription.contentType }] : []),
      ...(hit.inscription.owner ? [{ key: "owner", value: hit.inscription.owner }] : [])
    ];
  }

  return {
    id: "1satordinals",
    name: { key: "oneSat.provider.name", fallback: "1Sat Ordinals" },
    order: 10,

    async listCollectibles(): Promise<CollectibleSummary[]> {
      const items = await service.listActiveKeyCollectibles();
      // listActiveKeyCollectibles 内部已经把 404 翻译成 null（跳过），
      // 因此这里到达的 items 全是命中 outpoint；整体抛错才会到这里抛。
      const out = items.map(summaryOf);
      out.sort((a, b) => a.collectibleId.localeCompare(b.collectibleId));
      return out;
    },

    async getCollectible(collectibleId): Promise<CollectibleDetail | undefined> {
      // collectibleId 即 "txid:vout" outpoint。
      const hit = await service.getOutpoint(collectibleId);
      if (!hit) return undefined;
      return {
        summary: summaryOf(hit),
        preview: previewOf(hit),
        attributes: attributesOf(hit),
        activities: [],
        extras: { inscription: hit.inscription }
      };
    },

    async listActivity(): Promise<CollectibleActivity[]> {
      // phase 1：1Sat activity 端点未稳定，返回空。
      return [];
    },

    async sync(): Promise<void> {
      emit();
    },

    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}