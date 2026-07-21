// packages/plugin-assets/src/AssetsHomeWidget.tsx
// 首页统一持仓 widget：跨 asset + token provider 聚合概览。
// 设计缘由：只使用 HoldingRow 视图模型，不展示 P2PKH UTXO 等具体字段。
//
// 硬切换 003：使用 Resource Store 替代手动 useEffect/ref/数据 state。
// - holdings 资源由 manifest.ts 注册，包含 provider 级订阅和 microtask 合并
// - 本组件只读取资源快照，不自行协调请求或订阅 provider
// - 本地交互 state 仅保留 stale 标记（从资源错误状态派生）

import { countRender, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { HoldingsLoadResult } from "./holdingsFlow.js";
import { toHoldingRows, type HoldingRow } from "./holdingsFlow.js";

/** 空数组引用：避免每次 render 创建新数组 */
const EMPTY_ROWS: HoldingRow[] = [];

export function AssetsHomeWidget() {
  countRender("plugin-assets/AssetsHomeWidget");
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

  // 从资源快照派生 stale 状态
  const stale = useResourceSelector<HoldingsLoadResult, boolean>(
    store,
    "assets.holdings",
    [],
    (snapshot) => snapshot.status === "stale" || snapshot.status === "error"
  );

  return (
    <div className={`home-widget home-widget--assets ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("assets.home.overview", { defaultValue: "Asset overview" })}</h3>
      </header>
      {rows.length === 0 ? (
        <p className="home-widget__empty">
          {t("assets.homeWidget.empty", { defaultValue: "暂无资产" })}
        </p>
      ) : (
        <ul className="home-widget__list">
          {rows.map((r) => (
            <li
              key={`${r.kind}:${r.providerId}:${r.itemId}`}
              className="home-widget__item"
            >
              <span className="home-widget__name">{r.label}</span>
              <span className="home-widget__balance">{r.balanceDisplay}</span>
              <span className="home-widget__status">{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
