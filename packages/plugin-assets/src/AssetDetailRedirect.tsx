// packages/plugin-assets/src/AssetDetailRedirect.tsx
// 通用资产详情入口：从 URL 查询参数 ?providerId=&assetId= 渲染通用详情页。

import { useI18n } from "@keymaster/runtime";
import { AssetDetailPage } from "./AssetDetailPage.js";

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/**
 * 解析当前 URL ?providerId=&assetId= 渲染通用资产详情。
 * 设计缘由：通用资产详情页不展示 UTXO 等具体字段；具体资产 UI 由该资产插件自己提供。
 */
export function AssetDetailRedirect() {
  const { t } = useI18n();
  useI18n().language();
  const providerId = readQuery("providerId");
  const assetId = readQuery("assetId");
  if (!providerId || !assetId) {
    return (
      <div className="asset-detail">
        <p>{t("assets.redirect.missing", { defaultValue: "缺少 providerId/assetId 参数。" })}</p>
      </div>
    );
  }
  return <AssetDetailPage providerId={providerId} assetId={assetId} />;
}
