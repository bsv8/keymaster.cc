// packages/plugin-assets/src/AssetsHomeWidget.tsx
// 首页统一持仓 widget：跨 asset + token provider 聚合概览。
// 设计缘由：只使用 HoldingRow 视图模型，不展示 P2PKH UTXO 等具体字段。
//
// 硬切换 003：使用 Resource Store 替代手动 useEffect/ref/数据 state。
// - holdings 资源由 manifest.ts 注册，包含 provider 级订阅和 microtask 合并
// - 本组件只读取资源快照，不自行协调请求或订阅 provider
// - 本地交互 state 仅保留地址拷贝反馈（数据状态从资源快照派生）

import { PublicKey } from "@bsv/sdk";
import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@keymaster/ui";
import { countRender, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { KeyIdentity } from "@keymaster/contracts";
import type { HoldingsLoadResult } from "./holdingsFlow.js";
import { toHoldingRows, type HoldingRow } from "./holdingsFlow.js";

/** 空数组引用：避免每次 render 创建新数组 */
const EMPTY_ROWS: HoldingRow[] = [];

function p2pkhAddress(publicKeyHex: string | undefined, network: "mainnet" | "testnet"): string | null {
  if (!publicKeyHex) return null;
  try {
    return PublicKey.fromString(publicKeyHex).toAddress(network);
  } catch {
    return null;
  }
}

function WalletAccountGroup({
  address,
  network,
  rows
}: {
  address: string | null;
  network: "mainnet" | "testnet";
  rows: HoldingRow[];
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isTestnet = network === "testnet";
  const networkLabel = t(isTestnet ? "assets.homeWidget.testnet" : "assets.homeWidget.mainnet", { defaultValue: isTestnet ? "Testnet" : "主网" });

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is optional in embedded or non-secure contexts.
    }
  }

  return <section className={`assets-home__account ${isTestnet ? "is-testnet" : ""}`} aria-label={networkLabel}>
    <header className="assets-home__account-head">
      <span className="assets-home__network">{networkLabel}</span>
      <span className="assets-home__account-count">{t("assets.homeWidget.itemCount", { defaultValue: "{{count}} 项", count: rows.length })}</span>
    </header>
    {address ? <div className="assets-home__account-address">
      <span>{t("assets.homeWidget.address", { defaultValue: "地址" })}</span>
      <code title={address}>{address}</code>
      <Button size="sm" variant="ghost" className="assets-home__copy" onClick={() => void copyAddress()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? t("assets.homeWidget.copied", { defaultValue: "已复制" }) : t("assets.homeWidget.copy", { defaultValue: "拷贝" })}
      </Button>
    </div> : null}
    <div className="assets-home__account-holdings">
      <div className="assets-home__holdings-head"><span>{t("assets.homeWidget.holdings", { defaultValue: "资产" })}</span></div>
      {rows.length === 0 ? <p className="assets-home__empty">{t("assets.homeWidget.empty", { defaultValue: "暂无资产" })}</p> : <ul className="assets-home__list">
        {rows.map((row) => <li key={`${row.kind}:${row.providerId}:${row.itemId}`} className="assets-home__item">
          <span className={`assets-home__mark assets-home__mark--${row.kind}`} aria-hidden="true">{row.label.slice(0, 1)}</span>
          <span className="assets-home__asset">
            <span className="assets-home__asset-name">{row.label}</span>
            <span className="assets-home__asset-meta">{row.providerName}</span>
          </span>
          <strong className="assets-home__balance">{row.balanceDisplay}</strong>
        </li>)}
      </ul>}
    </div>
  </section>;
}

function WalletAccounts({ rows }: { rows: HoldingRow[] }) {
  const host = usePluginHost();
  const publicKeyHex = useResourceSelector<KeyIdentity | null, string | undefined>(
    host.resourceStore,
    "assets.active-context",
    [],
    (snapshot) => snapshot.data?.publicKeyHex
  );
  const mainnetAddress = useMemo(() => p2pkhAddress(publicKeyHex, "mainnet"), [publicKeyHex]);
  const testnetAddress = useMemo(() => p2pkhAddress(publicKeyHex, "testnet"), [publicKeyHex]);
  const mainnetRows = rows.filter((row) => row.network !== "test");
  const testnetRows = rows.filter((row) => row.network === "test");

  return <div className="assets-home__accounts">
    <WalletAccountGroup address={mainnetAddress} network="mainnet" rows={mainnetRows} />
    {testnetRows.length > 0 ? <WalletAccountGroup address={testnetAddress} network="testnet" rows={testnetRows} /> : null}
  </div>;
}

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
      <header className="assets-home__header">
        <h3>{t("assets.home.overview", { defaultValue: "资产总览" })}</h3>
        <span className="assets-home__count">{t("assets.homeWidget.itemCount", { defaultValue: "{{count}} 项", count: rows.length })}</span>
      </header>
      <WalletAccounts rows={rows} />
    </div>
  );
}
