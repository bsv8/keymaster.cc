// packages/plugin-p2pkh/src/manifest.ts
// P2PKH 业务包（硬切换后）：
//   - 注入 woc.service / background.registry / background.service。
//   - 注册 P2PKH AssetProvider、TransferProvider（Offer/Widget）。
//   - 注册页面：总览、历史、UTXO、设置。
//   - 不再自己创建 interval；不再自己向 Topbar 写组件。
//   - 监听 vault 事件自动同步。
//
// 硬切换 003：route / menu / home widget / settings / breadcrumb 全部走 I18nText。

import type {
  AssetRegistry,
  BackgroundRegistry,
  BackgroundService,
  BreadcrumbProvider,
  BreadcrumbRegistry,
  HomeRegistry,
  I18nPluginResources,
  KeyspaceService,
  MenuItem,
  MenuRegistry,
  MessageBus,
  PluginManifest,
  RouteRegistry,
  SettingsRegistry,
  VaultService,
  WocService
} from "@keymaster/contracts";
import {
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  WOC_CAPABILITY
} from "@keymaster/contracts";
import { createP2pkhService } from "./p2pkhService.js";
import { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
import { createP2pkhAssetProvider } from "./p2pkhAssetProvider.js";
import { createP2pkhTransferProvider } from "./p2pkhTransferProvider.js";
import { P2pkhOverviewPage } from "./pages/P2pkhOverviewPage.js";
import { P2pkhHistoryPage } from "./pages/P2pkhHistoryPage.js";
import { P2pkhUtxosPage } from "./pages/P2pkhUtxosPage.js";
import { P2pkhSettingsPage } from "./pages/P2pkhSettingsPage.js";
import { P2pkhBalanceWidget } from "./widgets/P2pkhBalanceWidget.js";

export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";

/** P2PKH i18n 资源：覆盖 route/menu/home/settings/breadcrumb 展示与 P2PKH 业务文案。 */
export const p2pkhResources: I18nPluginResources = {
  namespace: "p2pkh",
  resources: {
    en: {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH transfers: bsv / bsvtest networks (testnet is gated by the includeTestnet setting).",
      "p2pkh.route.overview": "P2PKH overview",
      "p2pkh.route.history": "P2PKH history",
      "p2pkh.route.utxos": "P2PKH UTXOs",
      "p2pkh.route.settings": "P2PKH settings",
      "p2pkh.menu.overview": "P2PKH",
      "p2pkh.menu.history": "P2PKH history",
      "p2pkh.menu.utxos": "P2PKH UTXOs",
      "p2pkh.crumb.settings": "Settings",
      "p2pkh.crumb.wallet": "Wallets",
      "p2pkh.crumb.p2pkh": "P2PKH",
      "p2pkh.crumb.history": "History",
      "p2pkh.crumb.utxos": "UTXOs",
      "p2pkh.settings.label": "P2PKH",
      "p2pkh.settings.description": "P2PKH product settings (includeTestnet, etc.). WOC settings are on the WOC page.",
      "p2pkh.home.balance": "P2PKH balance",
      "p2pkh.task.recent.label": "P2PKH recent sync",
      "p2pkh.task.recent.description": "Replace the active key's UTXO snapshot from WOC; reconcile local input claims and local submissions.",
      "p2pkh.task.backfill.label": "P2PKH history backfill",
      "p2pkh.task.backfill.description": "Paginated sync of full confirmed history (by active key namespace).",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "On-chain tx",
      "p2pkh.activity.unconfirmed": "Unconfirmed tx",
      "p2pkh.activity.localSubmission": "Local submission",
      "p2pkh.activity.dropped": "Dropped",
      "p2pkh.activity.info": "On-chain event",
      "p2pkh.col.label": "Label",
      "p2pkh.col.address": "Address",
      "p2pkh.col.network": "Network",
      "p2pkh.col.keyId": "keyId",
      "p2pkh.col.resourceId": "resourceId",
      "p2pkh.col.lastSync": "Last sync",
      "p2pkh.col.neverSynced": "Never synced",
      "p2pkh.col.txid": "txid",
      "p2pkh.col.height": "Block height",
      "p2pkh.col.status": "Status",
      "p2pkh.col.source": "Source",
      "p2pkh.col.syncedAt": "Synced at",
      "p2pkh.col.txidVout": "txid:vout",
      "p2pkh.col.value": "Value",
      "p2pkh.col.wocStatus": "WOC status",
      "p2pkh.col.inputClaim": "Local input claim",
      "p2pkh.col.spendable": "Spendable",
      "p2pkh.col.spendable.yes": "Yes",
      "p2pkh.col.spendable.no": "No",
      "p2pkh.col.inputClaim.empty": "None",
      "p2pkh.col.inputClaim.submission": " (submission ",
      "p2pkh.col.inputClaim.ellipsis": "…)",
      "p2pkh.empty.initializing": "Initializing key",
      "p2pkh.empty.wait": "Please wait…",
      "p2pkh.empty.noActiveKey": "Pick an active key",
      "p2pkh.empty.noActiveKeyDesc": "Choose a key from the topbar, or go to Import to add one.",
      "p2pkh.empty.loadFailed": "Failed to load P2PKH resources",
      "p2pkh.empty.noResource": "No P2PKH resources yet",
      "p2pkh.empty.noResourceDesc": "Go to Import to import a WIF/HEX private key first.",
      "p2pkh.empty.noHistory": "No history yet",
      "p2pkh.empty.noHistoryDesc": "Run a sync or wait for history-backfill to complete.",
      "p2pkh.empty.noUtxo": "No UTXOs yet",
      "p2pkh.action.triggerSync": "Trigger sync",
      "p2pkh.action.triggerBackfill": "Trigger backfill",
      "p2pkh.action.refillBackfill": "Re-backfill",
      "p2pkh.action.refresh": "Refresh",
      "p2pkh.action.save": "Save",
      "p2pkh.action.saved": "Saved",
      "p2pkh.action.resetDefault": "Reset to default",
      "p2pkh.action.submit": "Submit",
      "p2pkh.section.backfill": "History backfill",
      "p2pkh.unit.pages": "pages",
      "p2pkh.unit.records": "records",
      "p2pkh.unit.sats": "sats",
      "p2pkh.unit.satsPerKb": "sats/kB",
      "p2pkh.asset.bsvMain": "BSV / main",
      "p2pkh.asset.bsvTest": "BSV / test",
      "p2pkh.asset.all": "All",
      "p2pkh.overview.titleWithAsset": "P2PKH / {{label}}",
      "p2pkh.overview.descWithAsset": "BSV {{network}} ({{assetId}}) resources.",
      "p2pkh.overview.descDefault": "BSV P2PKH resources overview.",
      "p2pkh.balance.line": "Balance: {{total}}",
      "p2pkh.history.title": "P2PKH history",
      "p2pkh.history.desc": "On-chain history aggregated by address. syncedAt is the time the entry was last observed locally, not the on-chain time.",
      "p2pkh.history.backfillStatus": "Backfill status",
      "p2pkh.history.backfillLine": " · pages synced {{pages}} / records {{records}}",
      "p2pkh.history.backfillErr": " · error: {{err}}",
      "p2pkh.utxos.title": "P2PKH UTXOs",
      "p2pkh.utxos.desc": "WOC UTXO snapshot + local input claim overlay. Claimed UTXOs are excluded from allocation.",
      "p2pkh.settings.title": "P2PKH settings",
      "p2pkh.settings.desc": "P2PKH product settings. WOC endpoint, rate limit, and broadcast are configured on the WOC settings page.",
      "p2pkh.settings.includeTestnet": "Include testnet assets",
      "p2pkh.settings.includeTestnet.yes": "Yes",
      "p2pkh.settings.includeTestnet.no": "No (recommended)",
      "p2pkh.settings.includeTestnetHint": "When off, testnet assets, transfer offers, the home balance row, and the testnet toggle buttons are hidden; background sync also stops touching testnet. Turning it back on re-runs rehydrate + recent-sync and the WOC snapshot overwrites any dormant cache.",
      "p2pkh.settings.wocHint": "WOC endpoint, rate limit, and queue status are on the ",
      "p2pkh.settings.wocLink": "WOC settings",
      "p2pkh.balanceWidget.title": "P2PKH balance",
      "p2pkh.balanceWidget.refreshAll": "Refresh all",
      "p2pkh.balanceWidget.bsvMain": "BSV (main)",
      "p2pkh.balanceWidget.bsvTest": "BSV Testnet (test)",
      "p2pkh.balanceWidget.statusLabel": "Status: ",
      "p2pkh.balanceWidget.staleHint": " (data may be stale)",
      "p2pkh.balanceWidget.status.initializing": "Key initializing",
      "p2pkh.balanceWidget.status.noActiveKey": "Pick an active key",
      "p2pkh.balanceWidget.status.loadFailed": "Read failed",
      "p2pkh.balanceWidget.status.withError": "{{sync}} ({{error}})",
      "p2pkh.transfer.titleSuffix": " transfer",
      "p2pkh.transfer.networkDesc": "Network: {{network}} ({{assetId}})",
      "p2pkh.transfer.currentKey": "Current key: ",
      "p2pkh.transfer.noActiveKey": " No active key: shell guard has blocked; go to Key management to repair",
      "p2pkh.transfer.unnamed": "Unnamed",
      "p2pkh.transfer.identityMissing": "Identity not available",
      "p2pkh.transfer.loading": "Loading…",
      "p2pkh.transfer.changeAddress": "Current change address: ",
      "p2pkh.transfer.result.title": "Broadcast result",
      "p2pkh.transfer.result.status": "Status: ",
      "p2pkh.transfer.result.txid": "txid: ",
      "p2pkh.transfer.result.rejected": "Broadcast was rejected by the network. No local input claim was written.",
      "p2pkh.transfer.result.unknown": "Broadcast result is unknown. The inputs have been claimed locally.",
      "p2pkh.transfer.result.providerInconsistent": "Broadcast receipt does not match the local canonical txid. Marked as provider-inconsistent.",
      "p2pkh.transfer.result.broadcast": "The final preview transaction was broadcast and claimed locally.",
      "p2pkh.transfer.result.confirmClose": "Confirm and close",
      "p2pkh.transfer.result.again": "Start over",
      "p2pkh.transfer.noActiveKeyWarning": "No active key available. Repair the failed / uninitialized keys in Key management first.",
      "p2pkh.transfer.form.recipient": "Recipient address",
      "p2pkh.transfer.form.contactSelect": "Pick from contacts",
      "p2pkh.transfer.form.contactPlaceholder": "Unselected",
      "p2pkh.transfer.form.amount": "Amount (sats)",
      "p2pkh.transfer.form.feeRate": "Fee rate (sats/kB)",
      "p2pkh.transfer.form.prepare": "Generate final transaction",
      "p2pkh.transfer.form.sign": "Broadcast transaction",
      "p2pkh.transfer.preview.title": "Final transaction preview",
      "p2pkh.transfer.preview.inputs": "Inputs: {{count}}",
      "p2pkh.transfer.preview.totalSats": " total, ",
      "p2pkh.transfer.preview.recipient": "Recipient output: ",
      "p2pkh.transfer.preview.change": "Change output: ",
      "p2pkh.transfer.preview.noChange": "None",
      "p2pkh.transfer.preview.fee": "Final fee: ",
      "p2pkh.transfer.preview.size": "Serialized size: ",
      "p2pkh.transfer.preview.txid": "Final txid: ",
      "p2pkh.transfer.preview.rawTxHex": "Final rawTxHex: ",
      "p2pkh.transfer.preview.copyHex": "Copy rawTxHex",
      "p2pkh.transfer.preview.copied": "Copied",
      "p2pkh.transfer.err.recipient": "Please enter a recipient address",
      "p2pkh.transfer.err.amount": "Amount must be a positive integer",
      "p2pkh.transfer.err.feeMin": "Fee rate must be at least 1 sats/kB",
      "p2pkh.transfer.err.prepare": "Prepare failed",
      "p2pkh.transfer.err.submit": "Submit failed",
      "p2pkh.transfer.err.keyChanged": "Active key switched. Please prepare the preview again",
      "p2pkh.transfer.err.copyHex": "Failed to copy rawTxHex",
      "p2pkh.transfer.description.bsv": "Final signed BSV mainnet transfer preview. Broadcast uses the exact rawTxHex shown here.",
      "p2pkh.transfer.description.bsvtest": "Final signed BSV testnet transfer preview. Broadcast uses the exact rawTxHex shown here."
    },
    "zh-CN": {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH 转移：bsv / bsvtest 两个网络（testnet 受 includeTestnet 设置控制）。",
      "p2pkh.route.overview": "P2PKH 总览",
      "p2pkh.route.history": "P2PKH 历史",
      "p2pkh.route.utxos": "P2PKH UTXO",
      "p2pkh.route.settings": "P2PKH 设置",
      "p2pkh.menu.overview": "P2PKH",
      "p2pkh.menu.history": "P2PKH 历史",
      "p2pkh.menu.utxos": "P2PKH UTXO",
      "p2pkh.crumb.settings": "设置",
      "p2pkh.crumb.wallet": "钱包",
      "p2pkh.crumb.p2pkh": "P2PKH",
      "p2pkh.crumb.history": "历史",
      "p2pkh.crumb.utxos": "UTXO",
      "p2pkh.settings.label": "P2PKH",
      "p2pkh.settings.description": "P2PKH 产品设置（includeTestnet 等）。WOC 设置请到独立 WOC 设置页。",
      "p2pkh.home.balance": "P2PKH 余额",
      "p2pkh.task.recent.label": "P2PKH 近期同步",
      "p2pkh.task.recent.description": "用 WOC 替换 active key 的 UTXO 快照；对账本地输入占用与本地提交。",
      "p2pkh.task.backfill.label": "P2PKH 历史回填",
      "p2pkh.task.backfill.description": "分页同步完整确认历史（按 active key namespace）。",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "链上交易",
      "p2pkh.activity.unconfirmed": "未确认交易",
      "p2pkh.activity.localSubmission": "本地提交",
      "p2pkh.activity.dropped": "已丢弃",
      "p2pkh.activity.info": "链上事件",
      "p2pkh.col.label": "标签",
      "p2pkh.col.address": "地址",
      "p2pkh.col.network": "网络",
      "p2pkh.col.keyId": "keyId",
      "p2pkh.col.resourceId": "resourceId",
      "p2pkh.col.lastSync": "最近同步",
      "p2pkh.col.neverSynced": "未同步",
      "p2pkh.col.txid": "txid",
      "p2pkh.col.height": "区块高度",
      "p2pkh.col.status": "状态",
      "p2pkh.col.source": "来源",
      "p2pkh.col.syncedAt": "同步时间",
      "p2pkh.col.txidVout": "txid:vout",
      "p2pkh.col.value": "金额",
      "p2pkh.col.wocStatus": "WOC 状态",
      "p2pkh.col.inputClaim": "本地输入占用",
      "p2pkh.col.spendable": "可花费",
      "p2pkh.col.spendable.yes": "是",
      "p2pkh.col.spendable.no": "否",
      "p2pkh.col.inputClaim.empty": "无",
      "p2pkh.col.inputClaim.submission": " (submission ",
      "p2pkh.col.inputClaim.ellipsis": "…)",
      "p2pkh.empty.initializing": "Key 正在初始化",
      "p2pkh.empty.wait": "请稍候…",
      "p2pkh.empty.noActiveKey": "请选择一个 active key",
      "p2pkh.empty.noActiveKeyDesc": "在顶栏选择一把 key，或前往 导入 添加。",
      "p2pkh.empty.loadFailed": "加载 P2PKH 资源失败",
      "p2pkh.empty.noResource": "还没有 P2PKH 资源",
      "p2pkh.empty.noResourceDesc": "先到 导入 页面导入 WIF/HEX 私钥。",
      "p2pkh.empty.noHistory": "暂无历史",
      "p2pkh.empty.noHistoryDesc": "执行一次同步或等待 history-backfill 完成后这里会显示交易记录。",
      "p2pkh.empty.noUtxo": "暂无 UTXO",
      "p2pkh.action.triggerSync": "触发同步",
      "p2pkh.action.triggerBackfill": "触发回填",
      "p2pkh.action.refillBackfill": "重新回填",
      "p2pkh.action.refresh": "刷新",
      "p2pkh.action.save": "保存",
      "p2pkh.action.saved": "已保存",
      "p2pkh.action.resetDefault": "恢复缺省",
      "p2pkh.action.submit": "提交",
      "p2pkh.section.backfill": "历史回填",
      "p2pkh.unit.pages": "页",
      "p2pkh.unit.records": "条",
      "p2pkh.unit.sats": "sats",
      "p2pkh.unit.satsPerKb": "sats/kB",
      "p2pkh.asset.bsvMain": "BSV / main",
      "p2pkh.asset.bsvTest": "BSV / test",
      "p2pkh.asset.all": "全部",
      "p2pkh.overview.titleWithAsset": "P2PKH / {{label}}",
      "p2pkh.overview.descWithAsset": "BSV {{network}} ({{assetId}}) 资源。",
      "p2pkh.overview.descDefault": "BSV P2PKH 资源总览。",
      "p2pkh.balance.line": "余额：{{total}}",
      "p2pkh.history.title": "P2PKH 历史",
      "p2pkh.history.desc": "按地址汇总的链上交易记录。syncedAt 表示最近一次观察到该记录的时间，不是交易发生时间。",
      "p2pkh.history.backfillStatus": "历史回填状态",
      "p2pkh.history.backfillLine": " · 已同步 {{pages}} 页 / {{records}} 条",
      "p2pkh.history.backfillErr": " · 错误：{{err}}",
      "p2pkh.utxos.title": "P2PKH UTXO",
      "p2pkh.utxos.desc": "WOC UTXO 真值快照 + 本地输入占用覆盖层。已占用的 UTXO 不会参与分配。",
      "p2pkh.settings.title": "P2PKH 设置",
      "p2pkh.settings.desc": "P2PKH 产品设置。WOC endpoint、限流、广播在 WOC 设置页配置。",
      "p2pkh.settings.includeTestnet": "包含 testnet 货币",
      "p2pkh.settings.includeTestnet.yes": "是",
      "p2pkh.settings.includeTestnet.no": "否（推荐）",
      "p2pkh.settings.includeTestnetHint": "关闭后 testnet 资产、转账入口、首页余额行与后台同步都会停止；再次打开会重新触发 testnet rehydrate + recent-sync，并由最新 WOC 覆盖旧缓存。",
      "p2pkh.settings.wocHint": "WOC endpoint、限流与队列状态请到 ",
      "p2pkh.settings.wocLink": "WOC 设置",
      "p2pkh.balanceWidget.title": "P2PKH 余额",
      "p2pkh.balanceWidget.refreshAll": "刷新全部",
      "p2pkh.balanceWidget.bsvMain": "BSV (main)",
      "p2pkh.balanceWidget.bsvTest": "BSV Testnet (test)",
      "p2pkh.balanceWidget.statusLabel": "状态：",
      "p2pkh.balanceWidget.staleHint": " (数据可能陈旧)",
      "p2pkh.balanceWidget.status.initializing": "Key 正在初始化",
      "p2pkh.balanceWidget.status.noActiveKey": "请选择一个 active key",
      "p2pkh.balanceWidget.status.loadFailed": "读取失败",
      "p2pkh.balanceWidget.status.withError": "{{sync}}（{{error}}）",
      "p2pkh.transfer.titleSuffix": " 转账",
      "p2pkh.transfer.networkDesc": "网络：{{network}}（{{assetId}}）",
      "p2pkh.transfer.currentKey": "当前 key：",
      "p2pkh.transfer.noActiveKey": " 无 active key：壳层守卫已阻断，请到 Key 管理处理",
      "p2pkh.transfer.unnamed": "未命名",
      "p2pkh.transfer.identityMissing": "身份不可用",
      "p2pkh.transfer.loading": "加载中…",
      "p2pkh.transfer.changeAddress": "当前找零地址：",
      "p2pkh.transfer.result.title": "广播结果",
      "p2pkh.transfer.result.status": "状态：",
      "p2pkh.transfer.result.txid": "txid：",
      "p2pkh.transfer.result.rejected": "广播被网络拒绝，未写入本地输入占用。",
      "p2pkh.transfer.result.unknown": "广播结果未知，已为本次输入写入本地输入占用。",
      "p2pkh.transfer.result.providerInconsistent": "广播回执与本地 canonical txid 不一致，已标记为 provider-inconsistent。",
      "p2pkh.transfer.result.broadcast": "已广播最终预览交易，并写入本地输入占用。",
      "p2pkh.transfer.result.confirmClose": "确认并关闭",
      "p2pkh.transfer.result.again": "再来一次",
      "p2pkh.transfer.noActiveKeyWarning": "当前没有可用的 active key。请先到 Key 管理处理失败 / 未初始化的 key 后再转账。",
      "p2pkh.transfer.form.recipient": "接收方地址",
      "p2pkh.transfer.form.contactSelect": "从联系人选择",
      "p2pkh.transfer.form.contactPlaceholder": "未选择",
      "p2pkh.transfer.form.amount": "金额 (sats)",
      "p2pkh.transfer.form.feeRate": "矿工费 (sats/kB)",
      "p2pkh.transfer.form.prepare": "生成最终交易",
      "p2pkh.transfer.form.sign": "广播交易",
      "p2pkh.transfer.preview.title": "最终交易预览",
      "p2pkh.transfer.preview.inputs": "输入数量：{{count}} 个",
      "p2pkh.transfer.preview.totalSats": "，合计 ",
      "p2pkh.transfer.preview.recipient": "收款输出：",
      "p2pkh.transfer.preview.change": "找零输出：",
      "p2pkh.transfer.preview.noChange": "无",
      "p2pkh.transfer.preview.fee": "最终矿工费：",
      "p2pkh.transfer.preview.size": "序列化大小：",
      "p2pkh.transfer.preview.txid": "最终 txid：",
      "p2pkh.transfer.preview.rawTxHex": "最终 rawTxHex：",
      "p2pkh.transfer.preview.copyHex": "复制 rawTxHex",
      "p2pkh.transfer.preview.copied": "已复制",
      "p2pkh.transfer.err.recipient": "请输入接收方地址",
      "p2pkh.transfer.err.amount": "金额必须为正整数",
      "p2pkh.transfer.err.feeMin": "矿工费费率必须至少为 1 sats/kB",
      "p2pkh.transfer.err.prepare": "准备失败",
      "p2pkh.transfer.err.submit": "提交失败",
      "p2pkh.transfer.err.keyChanged": "当前 key 已切换，请重新准备预览",
      "p2pkh.transfer.err.copyHex": "复制 rawTxHex 失败",
      "p2pkh.transfer.description.bsv": "最终已签名的 BSV 主网转账预览。广播时直接使用这里展示的 rawTxHex。",
      "p2pkh.transfer.description.bsvtest": "最终已签名的 BSV Testnet 转账预览。广播时直接使用这里展示的 rawTxHex。"
    }
  }
};

export const p2pkhPlugin: PluginManifest = {
  id: "p2pkh",
  name: "P2PKH",
  description: "BSV P2PKH 资产实现：通过 woc.service 读取链上真值；通过 background 调度 recent-sync 与 history-backfill。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [P2PKH_CAPABILITY],
    displayGroup: "business"
  },
  i18n: p2pkhResources,
  keyScopedStorages: [
    { storageId: "state", description: "P2PKH 资源 / 余额 / UTXO / 历史 / 回填 / 本地提交 / 本地输入占用" }
  ],
  dependencies: [
    { capability: "vault.service", reason: "需要 vault 提供私钥与 key 管理" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "active key 与 key-scoped storage" },
    { capability: WOC_CAPABILITY, reason: "通过 woc.service 读取链上数据" },
    { capability: BACKGROUND_REGISTRY_CAPABILITY, reason: "注册 P2PKH 后台任务" },
    { capability: BACKGROUND_SERVICE_CAPABILITY, reason: "调度 P2PKH 后台任务" },
    { capability: "asset.registry", reason: "注册 P2PKH AssetProvider" },
    { capability: "transfer.registry", reason: "注册 P2PKH TransferProvider" },
    { capability: "route.registry", reason: "注册 P2PKH 页面" },
    { capability: "menu.registry", reason: "注册 P2PKH 菜单" },
    { capability: "settings.registry", reason: "注册 P2PKH 设置" },
    { capability: "home.registry", reason: "注册 P2PKH 首页 widget" },
    { capability: "breadcrumb.registry", reason: "注册 P2PKH 面包屑" }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const woc = ctx.get<WocService>(WOC_CAPABILITY);
    const messageBus = ctx.get<MessageBus>("runtime.messageBus");
    const backgroundRegistry = ctx.get<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY);
    const backgroundService = ctx.get<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY);

    const service = createP2pkhService({
      vault,
      woc,
      messageBus,
      backgroundRegistry,
      backgroundService,
      keyspace,
      logger: ctx.logger
    });
    ctx.provide(P2PKH_CAPABILITY, service);

    void service.rehydrate();

    const keyCreatedUnsub = messageBus.subscribe<{ keyId: string; publicKeyHex: string; label: string }>("key.created", async (payload) => {
      if (!payload.keyId) return;
      await service.onKeyImported(payload.keyId);
    });

    const assets = ctx.get<AssetRegistry>("asset.registry");
    const assetProvider = createP2pkhAssetProvider({ service, messageBus, keyspace });
    assets.register(assetProvider);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "p2pkh.overview",
      path: "/p2pkh",
      label: { key: "p2pkh.route.overview", fallback: "P2PKH overview" },
      component: P2pkhOverviewPage,
      inMenu: true,
      menuGroup: "wallets",
      order: 25,
      icon: "Wallet"
    });
    routes.register({
      id: "p2pkh.history",
      path: "/p2pkh/history",
      label: { key: "p2pkh.route.history", fallback: "P2PKH history" },
      component: P2pkhHistoryPage,
      inMenu: false
    });
    routes.register({
      id: "p2pkh.utxos",
      path: "/p2pkh/utxos",
      label: { key: "p2pkh.route.utxos", fallback: "P2PKH UTXOs" },
      component: P2pkhUtxosPage,
      inMenu: false
    });

    const menus = ctx.get<MenuRegistry>("menu.registry");
    const items: MenuItem[] = [
      { id: "menu.p2pkh.overview", label: { key: "p2pkh.menu.overview", fallback: "P2PKH" }, routeId: "p2pkh.overview", group: "wallets", order: 25, icon: "Wallet", visibleWhen: ({ unlocked }) => unlocked },
      { id: "menu.p2pkh.history", label: { key: "p2pkh.menu.history", fallback: "P2PKH history" }, routeId: "p2pkh.history", group: "wallets", order: 26, visibleWhen: ({ unlocked }) => unlocked },
      { id: "menu.p2pkh.utxos", label: { key: "p2pkh.menu.utxos", fallback: "P2PKH UTXOs" }, routeId: "p2pkh.utxos", group: "wallets", order: 27, visibleWhen: ({ unlocked }) => unlocked }
    ];
    for (const item of items) menus.register(item);

    // 硬切换 003：/settings/p2pkh 由 settings.registry 单一真值提供。
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "p2pkh.settings",
      path: "/settings/p2pkh",
      label: { key: "p2pkh.settings.label", fallback: "P2PKH" },
      description: { key: "p2pkh.settings.description", fallback: "P2PKH asset policies." },
      component: P2pkhSettingsPage,
      order: 110,
      icon: "Cog",
      visibleWhen: ({ unlocked }) => unlocked
    });

    const home = ctx.get<HomeRegistry>("home.registry");
    home.register({
      id: "p2pkh.balance",
      title: { key: "p2pkh.home.balance", fallback: "P2PKH balance" },
      component: P2pkhBalanceWidget,
      order: 20,
      slot: "main",
      refreshHint: "manual"
    });

    const transferReg = ctx.get<import("@keymaster/contracts").TransferRegistry>("transfer.registry");
    const transferProvider = createP2pkhTransferProvider({ service, messageBus, keyspace });
    transferReg.register(transferProvider);

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const crumbProvider: BreadcrumbProvider = {
      id: "p2pkh.crumbs",
      order: 200,
      match: (path) => path.startsWith("/p2pkh") || path.startsWith("/settings/p2pkh"),
      resolve: (path) => {
        if (path.startsWith("/settings/p2pkh")) {
          return [
            { label: { key: "p2pkh.crumb.settings", fallback: "Settings" } },
            { label: { key: "p2pkh.crumb.p2pkh", fallback: "P2PKH" } }
          ];
        }
        if (path === "/p2pkh/history") {
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: "p2pkh.crumb.p2pkh", fallback: "P2PKH" }, path: "/p2pkh" },
            { label: { key: "p2pkh.crumb.history", fallback: "History" } }
          ];
        }
        if (path === "/p2pkh/utxos") {
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: "p2pkh.crumb.p2pkh", fallback: "P2PKH" }, path: "/p2pkh" },
            { label: { key: "p2pkh.crumb.utxos", fallback: "UTXOs" } }
          ];
        }
        return [
          { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
          { label: { key: "p2pkh.crumb.p2pkh", fallback: "P2PKH" } }
        ];
      }
    };
    breadcrumbs.register(crumbProvider);

    // 硬切换 001：teardown 桥接到 service.dispose() 并取消 manifest 内挂载的
    // messageBus 订阅（key.created）；service 内部订阅由 service.dispose 收尾。
    // providers 也必须 dispose，否则它们仍会被 messageBus / keyspace 持续回调。
    return () => {
      try {
        keyCreatedUnsub();
      } catch {
        // swallow
      }
      try {
        assetProvider.dispose();
      } catch {
        // swallow
      }
      try {
        transferProvider.dispose();
      } catch {
        // swallow
      }
      service.dispose?.();
    };
  }
};
