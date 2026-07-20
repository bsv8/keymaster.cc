// packages/plugin-assets/src/AssetsPage.tsx
// 统一持仓页：聚合 asset.registry + token.registry。
//
// 设计缘由：
//   - 单 provider 失败不影响其他 provider；通用资产页不展示 UTXO 等
//     具体字段。
//   - 排序不变量：asset 组整体在 token 组前；组内先按 provider 名称，
//     再按 label（platform 二次稳定排序）。
//   - 详情入口仍由各 provider 自行声明 detailRoute；未声明时表格
//     "详情" 列展示 "-"，引导用户回到 provider 自带详情页或 detail 平台。
//
// 硬切换 003：使用 Resource Store 替代手动 useEffect/ref/数据 state。
// - holdings 资源由 manifest.ts 注册，包含 provider 级订阅和 microtask 合并
// - 本组件只读取资源快照，不自行协调请求或订阅 provider
// - activeContext 仍使用 keyspace 服务获取（这是本地交互 state）

import { useMemo } from "react";
import { DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { AppLink, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { AssetRegistry, KeyIdentity, TokenRegistry } from "@keymaster/contracts";
import type { HoldingsLoadResult } from "./holdingsFlow.js";
import { toHoldingRows, type HoldingRow } from "./holdingsFlow.js";

/** 空数组引用：避免每次 render 创建新数组 */
const EMPTY_ROWS: HoldingRow[] = [];
const EMPTY_ERRORS: Array<{ provider: string; error: string; kind: "asset" | "token" }> = [];

export function AssetsPage() {
  const assetsRegistry = useCapability<AssetRegistry>("asset.registry");
  const tokensRegistry = useCapability<TokenRegistry>("token.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  const store = host.resourceStore;

  // 使用 Resource Store 读取 holdings 数据
  // selector 只在 rows 语义变化时重渲染
  const rows = useResourceSelector<HoldingsLoadResult, HoldingRow[]>(
    store,
    "assets.holdings",
    [],
    (snapshot) => {
      if (snapshot.data) {
        return toHoldingRows(host, snapshot.data);
      }
      return EMPTY_ROWS;
    },
    (a, b) => {
      // 语义相等：比较数组长度和每个元素的关键字段
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const rowA = a[i];
        const rowB = b[i];
        if (!rowA || !rowB) return rowA === rowB;
        if (
          rowA.providerId !== rowB.providerId ||
          rowA.itemId !== rowB.itemId ||
          rowA.balanceDisplay !== rowB.balanceDisplay ||
          rowA.status !== rowB.status
        ) {
          return false;
        }
      }
      return true;
    }
  );

  // 从资源快照派生错误状态
  const errors = useResourceSelector<HoldingsLoadResult, Array<{ provider: string; error: string; kind: "asset" | "token" }>>(
    store,
    "assets.holdings",
    [],
    (snapshot) => {
      if (!snapshot.data) return EMPTY_ERRORS;
      const collected: Array<{ provider: string; error: string; kind: "asset" | "token" }> = [];
      for (const r of snapshot.data.assets) {
        if (r.error) collected.push({ provider: r.provider.id, error: r.error, kind: "asset" });
      }
      for (const r of snapshot.data.tokens) {
        if (r.error) collected.push({ provider: r.provider.id, error: r.error, kind: "token" });
      }
      return collected;
    },
    (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const errA = a[i];
        const errB = b[i];
        if (!errA || !errB) return errA === errB;
        if (errA.provider !== errB.provider || errA.error !== errB.error) return false;
      }
      return true;
    }
  );

  // activeContext 仍使用 keyspace 服务获取（这是本地交互 state）
  const activeIdentity = useResourceSelector<KeyIdentity | null, KeyIdentity | null>(
    store,
    "assets.active-context",
    [],
    (snapshot) => snapshot.data ?? null
  );
  const activeDescription = useMemo(() => {
    if (!activeIdentity) return host.i18n.t("assets.context.noKey", { defaultValue: "无 key" });
    const label = activeIdentity.label || host.i18n.t("assets.context.unnamed", { defaultValue: "未命名" });
    const shortPubkey = activeIdentity.publicKeyHex
      ? formatShortPublicKey(activeIdentity.publicKeyHex)
      : host.i18n.t("assets.context.identityMissing", { defaultValue: "身份不可用" });
    return `${label}（${shortPubkey}）`;
  }, [activeIdentity, host]);

  // 资源状态
  const resourceStatus = useResourceSelector<HoldingsLoadResult, string>(
    store,
    "assets.holdings",
    [],
    (snapshot) => snapshot.status
  );

  if (resourceStatus === "pending") {
    return (
      <div className="assets-page">
        <PageHeader
          title={t("assets.page.title", { defaultValue: "资产" })}
          description={t("assets.page.loading", { defaultValue: "正在加载…" })}
        />
      </div>
    );
  }

  if (rows.length === 0 && errors.length === 0) {
    const hasProviders = assetsRegistry.list().length > 0 || tokensRegistry.list().length > 0;
    if (!hasProviders) {
      return (
        <div className="assets-page">
          <PageHeader
            title={t("assets.page.title", { defaultValue: "资产" })}
            description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeDescription}`}
          />
          <EmptyState
            title={t("assets.page.empty.providers.title", { defaultValue: "暂无资产 provider" })}
            description={t("assets.page.empty.providers.desc", {
              defaultValue: "安装至少一个资产或 token provider 后这里会出现选项。"
            })}
          />
        </div>
      );
    }
  }

  const columns: DataTableColumn<HoldingRow>[] = [
    { key: "label", header: t("assets.table.col.name", { defaultValue: "名称" }), render: (r) => r.label },
    {
      key: "kind",
      header: t("assets.table.col.kind", { defaultValue: "类别" }),
      render: (r) => (r.kind === "asset" ? r.symbolOrKind : "token")
    },
    { key: "provider", header: t("assets.table.col.provider", { defaultValue: "Provider" }), render: (r) => r.providerName },
    { key: "network", header: t("assets.table.col.network", { defaultValue: "网络" }), render: (r) => r.network ?? "-" },
    {
      key: "balance",
      header: t("assets.table.col.balance", { defaultValue: "余额" }),
      render: (r) => r.balanceDisplay
    },
    { key: "status", header: t("assets.table.col.status", { defaultValue: "状态" }), render: (r) => r.status },
    {
      key: "detail",
      header: t("assets.table.col.detail", { defaultValue: "详情" }),
      render: (r) =>
        r.detailRoute ? <AppLink to={r.detailRoute}>{t("assets.table.open", { defaultValue: "进入" })}</AppLink> : "-"
    }
  ];

  return (
    <div className="assets-page">
      <PageHeader
        title={t("assets.page.title", { defaultValue: "资产" })}
          description={`${t("assets.page.descriptionPrefix", { defaultValue: "跨 provider 聚合展示 · " })}${activeDescription}`}
      />
      {errors.length > 0 ? (
        <ul className="assets-page__errors">
          {errors.map((e) => (
            <li key={`${e.kind}:${e.provider}`}>
              {e.provider}
              {t("assets.page.error.load", { defaultValue: " 加载失败：" })}
              {e.error}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t("assets.page.empty.assets.title", { defaultValue: "暂无资产" })}
          description={t("assets.page.empty.assets.desc", { defaultValue: "导入或解锁钱包后这里会显示资产。" })}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.kind}:${r.providerId}:${r.itemId}`} />
      )}
    </div>
  );
}
