// packages/plugin-p2pkh/src/manifest.ts
// P2PKH 业务包（硬切换后）：
//   - 注入 woc.service / background.registry / background.service。
//   - 注册 P2PKH AssetProvider、TransferProvider（Offer/Widget）。
//   - 注册页面：链上交易、本地交易、设置。
//   - 不再自己创建 interval；不再自己向 Topbar 写组件。
//   - 监听 vault 事件自动同步。
//
// 硬切换 003：route / business navigation / home widget / settings / breadcrumb 全部走 I18nText。

import type {
  AssetDataNotifier,
  AssetRegistry,
  BusinessFeatureRegistry,
  BreadcrumbProvider,
  BreadcrumbRegistry,
  BsvNetwork,
  I18nPluginResources,
  KeyspaceService,
  KeyIdentity,
  MessageBus,
  PluginManifest,
  ResourceRegistry,
  RouteRegistry,
  ProtectedOutpointRegistry,
  SystemSettingsRegistry,
  VaultService,
  WocService,
  P2pkhProviderRegistrySnapshot
  , SessionCoordinatorClient
} from "@keymaster/contracts";
import {
  ASSET_DATA_NOTIFIER_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  P2PKH_PROTOCOL_SPEND_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  WOC_CAPABILITY
  , SESSION_COORDINATOR_CLIENT_CAPABILITY
} from "@keymaster/contracts";
import type { P2pkhBalance, P2pkhGlobalSettings, P2pkhSyncStatus, P2pkhKeyResource, P2pkhAssetId, P2pkhTransactionFact, P2pkhOwnedOutpointProjection, P2pkhLocalTransaction, P2pkhLocalOutpoint, P2pkhLocalInputClaim, P2pkhTransactionSyncState, P2pkhMigrationAudit } from "./p2pkhContracts.js";

type ReadinessState = "initializing" | "no-active-key" | "ready";
import { createP2pkhService } from "./p2pkhService.js";
import { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
import { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
import { createP2pkhAssetProvider } from "./p2pkhAssetProvider.js";
import { createP2pkhTransferProvider } from "./p2pkhTransferProvider.js";
import { createP2pkhDb, openP2pkhDb } from "./p2pkhDb.js";
import { P2pkhSettingsPage } from "./pages/P2pkhSettingsPage.js";
import { registerP2pkhNavigation } from "./pages/P2pkhNavigation.js";
import { P2pkhTransactionDetailRoute } from "./pages/P2pkhTransactionDetailPage.js";
import { transactionSourceListPath } from "./pages/p2pkhTransactionView.js";

export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";

/** P2PKH i18n 资源：覆盖 route/menu/home/settings/breadcrumb 展示与 P2PKH 业务文案。 */
export const p2pkhResources: I18nPluginResources = {
  namespace: "p2pkh",
  resources: {
    en: {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH transfers: bsv / bsvtest networks (testnet is gated by the includeTestnet setting).",
      "p2pkh.route.transactions": "P2PKH on-chain transactions",
      "p2pkh.route.localTransactions": "P2PKH local transactions",
      "p2pkh.route.transaction": "P2PKH transaction",
      "p2pkh.route.settings": "P2PKH settings",
      "p2pkh.menu.transactions": "On-chain transactions",
      "p2pkh.menu.localTransactions": "Local transactions",
      "p2pkh.crumb.settings": "Settings",
      "p2pkh.crumb.wallet": "Wallets",
      "p2pkh.crumb.p2pkh": "P2PKH",
      "p2pkh.crumb.transactions": "On-chain transactions",
      "p2pkh.crumb.localTransactions": "Local transactions",
      "p2pkh.crumb.transaction": "Transaction",
      "p2pkh.settings.label": "P2PKH",
      "p2pkh.settings.description": "P2PKH product settings (includeTestnet, etc.). WOC settings are on the WOC page.",
      "p2pkh.home.balance": "P2PKH balance",
      "p2pkh.task.transactions.label": "P2PKH confirmed transactions",
      "p2pkh.task.transactions.description": "Sync confirmed transaction facts and rebuild the owned-coin projection.",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "On-chain tx",
      "p2pkh.activity.unconfirmed": "Unconfirmed tx",
      "p2pkh.activity.localSubmission": "Local submission",
      "p2pkh.activity.failed": "Conflicted tx",
      "p2pkh.activity.dropped": "Dropped",
      "p2pkh.activity.info": "On-chain event",
      "p2pkh.col.label": "Label",
      "p2pkh.col.address": "Address",
      "p2pkh.col.network": "Network",
      "p2pkh.col.publicKeyHex": "Public key",
      "p2pkh.col.resourceId": "resourceId",
      "p2pkh.col.lastSync": "Last sync",
      "p2pkh.col.neverSynced": "Never synced",
      "p2pkh.col.txid": "txid",
      "p2pkh.col.height": "Block height",
      "p2pkh.col.inputAmount": "Input",
      "p2pkh.col.outputAmount": "Output",
      "p2pkh.col.balanceAtBlock": "Balance at block",
      "p2pkh.col.status": "Status",
      "p2pkh.col.source": "Source",
      "p2pkh.col.syncedAt": "Synced at",
      "p2pkh.col.txidVout": "txid:vout",
      "p2pkh.col.value": "Value",
      "p2pkh.col.direction": "Direction",
      "p2pkh.col.netChange": "Net change",
      "p2pkh.col.spentBy": "Spent by",
      "p2pkh.col.submission": "Local submission",
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
      "p2pkh.empty.noHistoryDesc": "Run confirmed transaction sync to load wallet activity.",
      "p2pkh.empty.noUtxo": "No UTXOs yet",
      "p2pkh.action.save": "Save",
      "p2pkh.action.saved": "Saved",
      "p2pkh.action.resetDefault": "Reset to default",
      "p2pkh.action.submit": "Submit",
      "p2pkh.action.details": "Details",
      "p2pkh.action.hideDetails": "Hide details",
      "p2pkh.action.rebroadcast": "Rebroadcast ancestors",
      "p2pkh.action.rebroadcastFailed": "Rebroadcast failed",
      "p2pkh.action.loadingMore": "Loading…",
      "p2pkh.action.loadMoreTransactions": "Load more transactions",
      "p2pkh.action.loadMoreCoins": "Load more coins",
      "p2pkh.action.loadMoreFailed": "Unable to load more wallet history.",
      "p2pkh.action.loadMoreUnsupported": "Local pagination is unavailable.",
      "p2pkh.action.backToTransactions": "Back to transactions",
      "p2pkh.action.previousPage": "Previous",
      "p2pkh.action.nextPage": "Next",
      "p2pkh.unit.pages": "pages",
      "p2pkh.unit.records": "records",
      "p2pkh.unit.sats": "sats",
      "p2pkh.unit.satsPerKb": "sats/kB",
      "p2pkh.asset.bsvMain": "BSV / main",
      "p2pkh.asset.bsvTest": "BSV / test",
      "p2pkh.asset.all": "All",
      "p2pkh.balance.line": "Balance: {{total}}",
      "p2pkh.settings.title": "P2PKH settings",
      "p2pkh.settings.desc": "P2PKH product settings and confirmed/broadcast provider selection.",
      "p2pkh.settings.providers": "Confirmed sync and broadcast providers",
      "p2pkh.settings.providersHint": "Provider choices are persisted by the Coordinator. Changing one revokes the current sync generation.",
      "p2pkh.settings.provider.none": "Not configured",
      "p2pkh.settings.provider.unavailable": "Unavailable (selected: {{provider}})",
      "p2pkh.settings.provider.confirmed": "Confirmed provider",
      "p2pkh.settings.provider.broadcast": "Broadcast provider",
      "p2pkh.settings.provider.blocked": "Confirmed sync is blocked: selected provider is unavailable ({{provider}}).",
      "p2pkh.settings.provider.broadcastBlocked": "Broadcast is blocked: selected provider is unavailable ({{provider}}).",
      "p2pkh.settings.provider.retry": "Provider settings changed; reload and try again.",
      "p2pkh.settings.providerConfigHint": "Provider endpoint and rate-limit settings are managed in each provider's own settings page.",
      "p2pkh.settings.providersLoading": "Loading providers…",
      "p2pkh.wallet.settings": "Provider settings",
      "p2pkh.wallet.loadFailed": "Wallet data unavailable",
      "p2pkh.wallet.transactions.title": "On-chain transactions",
      "p2pkh.wallet.transactions.description": "Confirmed transaction facts from the active chain.",
      "p2pkh.wallet.localTransactions.title": "Local transactions",
      "p2pkh.wallet.localTransactions.description": "Local transaction lifecycle and chain resolution.",
      "p2pkh.wallet.balances": "BSV balances",
      "p2pkh.wallet.syncStatus": "Confirmed synchronization status",
      "p2pkh.wallet.providers": "main — Confirmed: {{mainSync}} / Broadcast: {{mainBroadcast}} · test — Confirmed: {{testSync}} / Broadcast: {{testBroadcast}}",
      "p2pkh.wallet.lastCompleteSync": "Last complete sync: {{time}}",
      "p2pkh.wallet.testSync": "test {{time}}",
      "p2pkh.wallet.taskStatus": "Task status: {{status}}",
      "p2pkh.wallet.syncError": "Sync error: {{error}}",
      "p2pkh.wallet.network": "Network",
      "p2pkh.wallet.networkDisabled": "Testnet is disabled",
      "p2pkh.wallet.networkDisabledDescription": "Enable testnet in P2PKH settings before viewing testnet data.",
      "p2pkh.wallet.pagination": "Transaction pages",
      "p2pkh.wallet.page": "Page {{page}}",
      "p2pkh.wallet.mainnet": "Mainnet",
      "p2pkh.wallet.testnet": "Testnet",
      "p2pkh.wallet.noBroadcastProvider": "No broadcast provider is configured for this network.",
      "p2pkh.wallet.transaction": "Transaction {{txid}}",
      "p2pkh.wallet.parents": "Parents",
      "p2pkh.wallet.inputs": "Inputs",
      "p2pkh.wallet.outputs": "Outputs",
      "p2pkh.wallet.attempts": "Broadcast attempts",
      "p2pkh.wallet.none": "None",
      "p2pkh.balance.blockConfirmed": "Block confirmed",
      "p2pkh.balance.localSpendable": "Local spendable",
      "p2pkh.balance.pendingClaims": "Pending input claims",
      "p2pkh.balance.localChange": "Local confirmed change",
      "p2pkh.balance.isolated": "Isolated",
      "p2pkh.source.confirmed": "Confirmed",
      "p2pkh.source.local-confirmed": "Local confirmed",
      "p2pkh.direction.received": "Received",
      "p2pkh.direction.sent": "Sent",
      "p2pkh.direction.self": "Self transfer",
      "p2pkh.txDetail.title": "Transaction details",
      "p2pkh.txDetail.loading": "Loading local transaction",
      "p2pkh.txDetail.unavailable": "Transaction is not available locally",
      "p2pkh.txDetail.unavailableDescription": "This page only displays transaction information stored in this wallet.",
      "p2pkh.txDetail.summary": "Transaction summary",
      "p2pkh.txDetail.txid": "Transaction ID",
      "p2pkh.txDetail.network": "Network",
      "p2pkh.txDetail.blockTime": "Block time (UTC)",
      "p2pkh.txDetail.observedAt": "Observed locally",
      "p2pkh.txDetail.block": "Block",
      "p2pkh.txDetail.size": "Size",
      "p2pkh.txDetail.fee": "Fee paid",
      "p2pkh.txDetail.state": "Local state",
      "p2pkh.txDetail.chainResolution": "Chain resolution",
      "p2pkh.txDetail.isolationReason": "Isolation reason",
      "p2pkh.txDetail.conflictSources": "Conflict source txids",
      "p2pkh.txDetail.confirmedFactId": "Confirmed fact",
      "p2pkh.txDetail.resolvedAt": "Resolved at",
      "p2pkh.txDetail.inputs": "Inputs",
      "p2pkh.txDetail.outputs": "Outputs",
      "p2pkh.txDetail.totalInput": "Total input",
      "p2pkh.txDetail.totalOutput": "Total output",
      "p2pkh.txDetail.inputUnavailable": "Some input values are not stored locally.",
      "p2pkh.txDetail.partialOutputs": "Only wallet-owned outputs are available in the stored record.",
      "p2pkh.txDetail.localRecord": "Local record",
      "p2pkh.txDetail.parents": "Parent transactions",
      "p2pkh.txDetail.attempts": "Broadcast attempts",
      "p2pkh.syncStatus.idle": "Idle",
      "p2pkh.syncStatus.syncing": "Syncing",
      "p2pkh.syncStatus.ok": "Up to date",
      "p2pkh.syncStatus.failed": "Failed",
      "p2pkh.syncStatus.blocked": "Blocked",
      "p2pkh.syncStatus.rate-limited": "Rate limited",
      "p2pkh.network.main": "Mainnet",
      "p2pkh.network.test": "Testnet",
      "p2pkh.action.inProgress": "Working…",
      "p2pkh.state.chain-confirmed": "Chain confirmed",
      "p2pkh.state.local-confirmed": "Local confirmed",
      "p2pkh.state.submitting": "Submitting",
      "p2pkh.state.isolated": "Isolated",
      "p2pkh.state.conflicted": "Conflicted",
      "p2pkh.resolution.unresolved": "Unresolved",
      "p2pkh.resolution.chain-confirmed": "Chain confirmed",
      "p2pkh.resolution.conflicted": "Conflicted",
      "p2pkh.state.available": "Available",
      "p2pkh.state.spent": "Spent",
      "p2pkh.state.claimed": "Claimed",
      "p2pkh.state.protected": "Protected",
      "p2pkh.settings.includeTestnet": "Include testnet assets",
      "p2pkh.settings.includeTestnet.yes": "Yes",
      "p2pkh.settings.includeTestnet.no": "No (recommended)",
      "p2pkh.settings.includeTestnetHint": "When off, testnet assets, transfer offers, and the testnet wallet row are hidden; confirmed synchronization also skips testnet. Turning it back on rehydrates the testnet resource.",
      "p2pkh.settings.feeRates": "BSV miner fee rates",
      "p2pkh.settings.feeRatesHint": "Configure sats/kB. New transfers use Medium by default; changes apply to new transaction previews.",
      "p2pkh.settings.feeRate.low": "Low",
      "p2pkh.settings.feeRate.medium": "Medium (default)",
      "p2pkh.settings.feeRate.high": "High",
      "p2pkh.settings.feeRateInvalid": "Fee rate must be a positive integer in sats/kB.",
      "p2pkh.balanceWidget.title": "P2PKH balance",
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
      "p2pkh.transfer.result.broadcast": "The final preview transaction was broadcast and claimed locally.",
      "p2pkh.transfer.result.confirmClose": "Confirm and close",
      "p2pkh.transfer.result.again": "Start over",
      "p2pkh.transfer.noActiveKeyWarning": "No active key available. Repair the failed / uninitialized keys in Key management first.",
      "p2pkh.transfer.form.recipient": "Recipient address",
      "p2pkh.transfer.form.recipientDerived": "Derived recipient address (verify)",
      "p2pkh.transfer.form.recipientTarget": "This address was derived from the recipient public key. Verify it before continuing.",
      "p2pkh.transfer.form.contactSelect": "Pick from contacts",
      "p2pkh.transfer.form.contactPlaceholder": "Unselected",
      "p2pkh.transfer.form.amount": "Amount (sats)",
      "p2pkh.transfer.form.feeRate": "Fee rate (sats/kB)",
      "p2pkh.transfer.form.amountPlaceholder": "Enter sats or choose All",
      "p2pkh.transfer.form.sendAll": "All",
      "p2pkh.transfer.form.sendAllHint": "The final received amount automatically subtracts the actual miner fee.",
      "p2pkh.transfer.form.feeTier.low": "Low",
      "p2pkh.transfer.form.feeTier.medium": "Medium",
      "p2pkh.transfer.form.feeTier.high": "High",
      "p2pkh.transfer.step.addressAmount": "Verify addresses and enter amount",
      "p2pkh.transfer.step.addressAmountHint": "The change address belongs to the current key and cannot be edited. Carefully verify the recipient address.",
      "p2pkh.transfer.preview.stepHint": "Verify the recipient, received amount, change, and miner fee before broadcasting.",
      "p2pkh.transfer.result.stepHint": "The final transaction has been submitted to the broadcast service.",
      "p2pkh.transfer.form.prepare": "Generate final transaction",
      "p2pkh.transfer.form.sign": "Broadcast transaction",
      "p2pkh.transfer.preview.title": "Final transaction preview",
      "p2pkh.transfer.preview.inputs": "Inputs: {{count}}",
      "p2pkh.transfer.preview.totalSats": " total, ",
      "p2pkh.transfer.preview.recipient": "Recipient output: ",
      "p2pkh.transfer.preview.recipientVerify": "Recipient output — verify carefully",
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
      "p2pkh.transfer.description.bsvtest": "Final signed BSV testnet transfer preview. Broadcast uses the exact rawTxHex shown here.",
      "p2pkh.col.protected": "Protected",
      "p2pkh.col.protected.empty": "Not protected",
      "p2pkh.transfer.result.broadcastPending": "Broadcast pending",
      "p2pkh.transfer.result.confirmed": "Confirmed",
      "p2pkh.transfer.result.dropped": "Dropped",
      "p2pkh.transfer.result.observedUnconfirmed": "Observed unconfirmed"
    },
    "zh-CN": {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH 转移：bsv / bsvtest 两个网络（testnet 受 includeTestnet 设置控制）。",
      "p2pkh.route.transactions": "P2PKH 链上交易",
      "p2pkh.route.localTransactions": "P2PKH 本地交易",
      "p2pkh.route.transaction": "P2PKH 交易",
      "p2pkh.route.settings": "P2PKH 设置",
      "p2pkh.menu.transactions": "链上交易",
      "p2pkh.menu.localTransactions": "本地交易",
      "p2pkh.crumb.settings": "设置",
      "p2pkh.crumb.wallet": "钱包",
      "p2pkh.crumb.p2pkh": "P2PKH",
      "p2pkh.crumb.transactions": "链上交易",
      "p2pkh.crumb.localTransactions": "本地交易",
      "p2pkh.crumb.transaction": "交易",
      "p2pkh.settings.label": "P2PKH",
      "p2pkh.settings.description": "P2PKH 产品设置（includeTestnet 等）。WOC 设置请到独立 WOC 设置页。",
      "p2pkh.home.balance": "P2PKH 余额",
      "p2pkh.task.transactions.label": "P2PKH 确认交易",
      "p2pkh.task.transactions.description": "同步确认交易事实并重建 owned coin 投影。",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "链上交易",
      "p2pkh.activity.unconfirmed": "未确认交易",
      "p2pkh.activity.localSubmission": "本地提交",
      "p2pkh.activity.failed": "已冲突交易",
      "p2pkh.activity.dropped": "已丢弃",
      "p2pkh.activity.info": "链上事件",
      "p2pkh.col.label": "标签",
      "p2pkh.col.address": "地址",
      "p2pkh.col.network": "网络",
      "p2pkh.col.publicKeyHex": "公钥",
      "p2pkh.col.resourceId": "resourceId",
      "p2pkh.col.lastSync": "最近同步",
      "p2pkh.col.neverSynced": "未同步",
      "p2pkh.col.txid": "txid",
      "p2pkh.col.height": "区块高度",
      "p2pkh.col.inputAmount": "输入金额",
      "p2pkh.col.outputAmount": "输出金额",
      "p2pkh.col.balanceAtBlock": "区块时余额",
      "p2pkh.col.status": "状态",
      "p2pkh.col.source": "来源",
      "p2pkh.col.syncedAt": "同步时间",
      "p2pkh.col.txidVout": "txid:vout",
      "p2pkh.col.value": "金额",
      "p2pkh.col.direction": "方向",
      "p2pkh.col.netChange": "净变化",
      "p2pkh.col.spentBy": "花费交易",
      "p2pkh.col.submission": "本地提交",
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
      "p2pkh.empty.noHistoryDesc": "执行确认交易同步后，这里会显示钱包活动。",
      "p2pkh.empty.noUtxo": "暂无 UTXO",
      "p2pkh.action.save": "保存",
      "p2pkh.action.saved": "已保存",
      "p2pkh.action.resetDefault": "恢复缺省",
      "p2pkh.action.submit": "提交",
      "p2pkh.action.details": "详情",
      "p2pkh.action.hideDetails": "隐藏详情",
      "p2pkh.action.rebroadcast": "重广播祖先交易",
      "p2pkh.action.rebroadcastFailed": "重广播失败",
      "p2pkh.action.loadingMore": "正在加载…",
      "p2pkh.action.loadMoreTransactions": "加载更多交易",
      "p2pkh.action.loadMoreCoins": "加载更多币",
      "p2pkh.action.loadMoreFailed": "无法加载更多钱包历史。",
      "p2pkh.action.loadMoreUnsupported": "本地分页不可用。",
      "p2pkh.action.backToTransactions": "返回交易列表",
      "p2pkh.action.previousPage": "上一页",
      "p2pkh.action.nextPage": "下一页",
      "p2pkh.unit.pages": "页",
      "p2pkh.unit.records": "条",
      "p2pkh.unit.sats": "sats",
      "p2pkh.unit.satsPerKb": "sats/kB",
      "p2pkh.asset.bsvMain": "BSV / main",
      "p2pkh.asset.bsvTest": "BSV / test",
      "p2pkh.asset.all": "全部",
      "p2pkh.balance.line": "余额：{{total}}",
      "p2pkh.settings.title": "P2PKH 设置",
      "p2pkh.settings.desc": "P2PKH 产品设置与确认/广播供应商选择。",
      "p2pkh.settings.providers": "确认同步与广播供应商",
      "p2pkh.settings.providersHint": "供应商选择由 Coordinator 持久化；切换供应商会撤销当前同步 generation。",
      "p2pkh.settings.provider.none": "未配置",
      "p2pkh.settings.provider.unavailable": "不可用（当前选择：{{provider}}）",
      "p2pkh.settings.provider.confirmed": "确认同步供应商",
      "p2pkh.settings.provider.broadcast": "广播供应商",
      "p2pkh.settings.provider.blocked": "确认同步已阻断：当前选择的供应商不可用（{{provider}}）。",
      "p2pkh.settings.provider.broadcastBlocked": "广播已阻断：当前选择的供应商不可用（{{provider}}）。",
      "p2pkh.settings.provider.retry": "供应商设置已变化，请刷新后重试。",
      "p2pkh.settings.providerConfigHint": "供应商 endpoint 与限流设置由各供应商自己的设置页管理。",
      "p2pkh.settings.providersLoading": "正在加载供应商…",
      "p2pkh.wallet.settings": "供应商设置",
      "p2pkh.wallet.loadFailed": "钱包数据不可用",
      "p2pkh.wallet.transactions.title": "链上交易",
      "p2pkh.wallet.transactions.description": "当前有效链上的已确认交易事实。",
      "p2pkh.wallet.localTransactions.title": "本地交易",
      "p2pkh.wallet.localTransactions.description": "本地交易生命周期与链上裁决。",
      "p2pkh.wallet.syncStatus": "确认交易同步状态",
      "p2pkh.wallet.balances": "BSV 余额",
      "p2pkh.wallet.providers": "main — 确认：{{mainSync}} / 广播：{{mainBroadcast}} · test — 确认：{{testSync}} / 广播：{{testBroadcast}}",
      "p2pkh.wallet.lastCompleteSync": "最近完整同步：{{time}}",
      "p2pkh.wallet.testSync": "test {{time}}",
      "p2pkh.wallet.taskStatus": "任务状态：{{status}}",
      "p2pkh.wallet.syncError": "同步错误：{{error}}",
      "p2pkh.wallet.network": "网络",
      "p2pkh.wallet.networkDisabled": "测试网未启用",
      "p2pkh.wallet.networkDisabledDescription": "请先在 P2PKH 设置中启用测试网，再查看测试网数据。",
      "p2pkh.wallet.pagination": "交易分页",
      "p2pkh.wallet.page": "第 {{page}} 页",
      "p2pkh.wallet.mainnet": "主网",
      "p2pkh.wallet.testnet": "测试网",
      "p2pkh.wallet.noBroadcastProvider": "该网络未配置广播供应商。",
      "p2pkh.wallet.transaction": "交易 {{txid}}",
      "p2pkh.wallet.parents": "父交易",
      "p2pkh.wallet.inputs": "输入",
      "p2pkh.wallet.outputs": "输出",
      "p2pkh.wallet.attempts": "广播尝试",
      "p2pkh.wallet.none": "无",
      "p2pkh.balance.blockConfirmed": "区块确认余额",
      "p2pkh.balance.localSpendable": "本地可花",
      "p2pkh.balance.pendingClaims": "待确认输入占用",
      "p2pkh.balance.localChange": "本地确认找零",
      "p2pkh.balance.isolated": "隔离金额",
      "p2pkh.source.confirmed": "已确认",
      "p2pkh.source.local-confirmed": "本地确认",
      "p2pkh.direction.received": "收款",
      "p2pkh.direction.sent": "付款",
      "p2pkh.direction.self": "自转",
      "p2pkh.txDetail.title": "交易详情",
      "p2pkh.txDetail.loading": "正在读取本地交易",
      "p2pkh.txDetail.unavailable": "本地没有这笔交易",
      "p2pkh.txDetail.unavailableDescription": "此页面只展示本钱包已保存的交易信息。",
      "p2pkh.txDetail.summary": "交易摘要",
      "p2pkh.txDetail.txid": "交易 ID",
      "p2pkh.txDetail.network": "网络",
      "p2pkh.txDetail.blockTime": "区块时间（UTC）",
      "p2pkh.txDetail.observedAt": "本地观察时间",
      "p2pkh.txDetail.block": "区块",
      "p2pkh.txDetail.size": "大小",
      "p2pkh.txDetail.fee": "已付手续费",
      "p2pkh.txDetail.state": "本地状态",
      "p2pkh.txDetail.chainResolution": "链上裁决",
      "p2pkh.txDetail.isolationReason": "隔离原因",
      "p2pkh.txDetail.conflictSources": "冲突来源 txid",
      "p2pkh.txDetail.confirmedFactId": "确认事实 ID",
      "p2pkh.txDetail.resolvedAt": "裁决时间",
      "p2pkh.txDetail.inputs": "输入",
      "p2pkh.txDetail.outputs": "输出",
      "p2pkh.txDetail.totalInput": "输入总额",
      "p2pkh.txDetail.totalOutput": "输出总额",
      "p2pkh.txDetail.inputUnavailable": "本地没有保存全部输入金额。",
      "p2pkh.txDetail.partialOutputs": "本地记录只有钱包拥有的输出。",
      "p2pkh.txDetail.localRecord": "本地记录",
      "p2pkh.txDetail.parents": "父交易",
      "p2pkh.txDetail.attempts": "广播尝试",
      "p2pkh.syncStatus.idle": "空闲",
      "p2pkh.syncStatus.syncing": "同步中",
      "p2pkh.syncStatus.ok": "已同步",
      "p2pkh.syncStatus.failed": "失败",
      "p2pkh.syncStatus.blocked": "已阻断",
      "p2pkh.syncStatus.rate-limited": "受限流影响",
      "p2pkh.network.main": "主网",
      "p2pkh.network.test": "测试网",
      "p2pkh.action.inProgress": "处理中…",
      "p2pkh.state.chain-confirmed": "链上确认",
      "p2pkh.state.local-confirmed": "本地确认",
      "p2pkh.state.submitting": "提交中",
      "p2pkh.state.isolated": "已隔离",
      "p2pkh.state.conflicted": "已冲突",
      "p2pkh.resolution.unresolved": "未裁决",
      "p2pkh.resolution.chain-confirmed": "链上确认",
      "p2pkh.resolution.conflicted": "已冲突",
      "p2pkh.state.available": "可用",
      "p2pkh.state.spent": "已花费",
      "p2pkh.state.claimed": "已占用",
      "p2pkh.state.protected": "受保护",
      "p2pkh.settings.includeTestnet": "包含 testnet 货币",
      "p2pkh.settings.includeTestnet.yes": "是",
      "p2pkh.settings.includeTestnet.no": "否（推荐）",
      "p2pkh.settings.includeTestnetHint": "关闭后 testnet 资产、转账入口与 testnet 钱包行会隐藏，确认同步也会跳过 testnet；再次开启会补齐 testnet 资源。",
      "p2pkh.settings.feeRates": "BSV 矿工费率",
      "p2pkh.settings.feeRatesHint": "按 sats/kB 配置。转账页默认使用“中”；修改后立即应用到新建的交易预览。",
      "p2pkh.settings.feeRate.low": "低",
      "p2pkh.settings.feeRate.medium": "中（默认）",
      "p2pkh.settings.feeRate.high": "高",
      "p2pkh.settings.feeRateInvalid": "费率必须是大于 0 的整数（sats/kB）。",
      "p2pkh.balanceWidget.title": "P2PKH 余额",
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
      "p2pkh.transfer.result.broadcast": "已广播最终预览交易，并写入本地输入占用。",
      "p2pkh.transfer.result.confirmClose": "确认并关闭",
      "p2pkh.transfer.result.again": "再来一次",
      "p2pkh.transfer.noActiveKeyWarning": "当前没有可用的 active key。请先到 Key 管理处理失败 / 未初始化的 key 后再转账。",
      "p2pkh.transfer.form.recipient": "接收方地址",
      "p2pkh.transfer.form.recipientDerived": "派生的接收方地址（请核对）",
      "p2pkh.transfer.form.recipientTarget": "此地址由收款人公钥派生。确认地址无误后再继续。",
      "p2pkh.transfer.form.contactSelect": "从联系人选择",
      "p2pkh.transfer.form.contactPlaceholder": "未选择",
      "p2pkh.transfer.form.amount": "金额 (sats)",
      "p2pkh.transfer.form.feeRate": "矿工费 (sats/kB)",
      "p2pkh.transfer.form.amountPlaceholder": "输入 sats，或选择全部",
      "p2pkh.transfer.form.sendAll": "全部",
      "p2pkh.transfer.form.sendAllHint": "最终到账额会自动扣除实际矿工费。",
      "p2pkh.transfer.form.feeTier.low": "低",
      "p2pkh.transfer.form.feeTier.medium": "中",
      "p2pkh.transfer.form.feeTier.high": "高",
      "p2pkh.transfer.step.addressAmount": "核对地址与填写金额",
      "p2pkh.transfer.step.addressAmountHint": "找零地址由当前 key 决定，不能修改；请重点核对收款地址。",
      "p2pkh.transfer.preview.stepHint": "请核对收款地址、到账金额、找零与矿工费，再广播。",
      "p2pkh.transfer.result.stepHint": "最终交易已提交到广播服务。",
      "p2pkh.transfer.form.prepare": "生成最终交易",
      "p2pkh.transfer.form.sign": "广播交易",
      "p2pkh.transfer.preview.title": "最终交易预览",
      "p2pkh.transfer.preview.inputs": "输入数量：{{count}} 个",
      "p2pkh.transfer.preview.totalSats": "，合计 ",
      "p2pkh.transfer.preview.recipient": "收款输出：",
      "p2pkh.transfer.preview.recipientVerify": "收款输出（请重点核对）",
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
      "p2pkh.transfer.description.bsvtest": "最终已签名的 BSV Testnet 转账预览。广播时直接使用这里展示的 rawTxHex。",
      "p2pkh.col.protected": "已保护",
      "p2pkh.col.protected.empty": "未保护",
      "p2pkh.transfer.result.broadcastPending": "等待广播",
      "p2pkh.transfer.result.confirmed": "已确认",
      "p2pkh.transfer.result.dropped": "已丢弃",
      "p2pkh.transfer.result.observedUnconfirmed": "已观察到未确认状态"
    }
  }
};

export const p2pkhPlugin: PluginManifest = {
  id: "p2pkh",
  name: "P2PKH",
  description: "BSV P2PKH 资产实现：由 Coordinator 统一调度确认交易同步，保留旧协议 spend 的 WOC broadcaster。",
  meta: {
    kind: "business",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [P2PKH_CAPABILITY, P2PKH_PROTOCOL_SPEND_CAPABILITY],
    displayGroup: "business"
  },
  i18n: p2pkhResources,
  keyScopedStorages: [
    { storageId: "state", description: "P2PKH 地址、交易事实、owned outpoint 投影、同步游标与本地交易状态" }
  ],
  dependencies: [
    { capability: "vault.service", reason: "需要 vault 提供私钥与 key 管理" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "active key 与 key-scoped storage" },
    { capability: WOC_CAPABILITY, reason: "旧协议 spend 使用 WOC broadcaster" },
    { capability: SESSION_COORDINATOR_CLIENT_CAPABILITY, reason: "确认同步和 provider 配置由 Coordinator 管理" },
    { capability: "protected-outpoint.registry", reason: "排除协议受保护 outpoint" },
    { capability: "asset.registry", reason: "注册 P2PKH AssetProvider" },
    { capability: "transfer.registry", reason: "注册 P2PKH TransferProvider" },
    { capability: "route.registry", reason: "注册 P2PKH 页面" },
    { capability: "business.registry", reason: "接入资产业务导航" },
    { capability: "system-settings.registry", reason: "注册 Testnet 系统设置" },
    { capability: "home.registry", reason: "注册 P2PKH 首页 widget" },
    { capability: "breadcrumb.registry", reason: "注册 P2PKH 面包屑" }
  ],
  setup(ctx) {
    const vault = ctx.get<VaultService>("vault.service");
    const keyspace = ctx.get<KeyspaceService>(KEYSPACE_SERVICE_CAPABILITY);
    const woc = ctx.get<WocService>(WOC_CAPABILITY);
    const coordinator = ctx.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    const messageBus = ctx.get<MessageBus>("runtime.messageBus");
    const protectedOutpoints = ctx.get<ProtectedOutpointRegistry>("protected-outpoint.registry");
    const assetDataNotifier = ctx.has(ASSET_DATA_NOTIFIER_CAPABILITY)
      ? ctx.get<AssetDataNotifier>(ASSET_DATA_NOTIFIER_CAPABILITY)
      : undefined;

    const service = createP2pkhService({
      vault,
      coordinator,
      messageBus,
      keyspace,
      protectedOutpoints,
      assetDataNotifier,
      logger: ctx.logger
    });
    // SharedWorker cannot read the page's localStorage. Seed its durable
    // network scope from the service so an existing testnet preference is
    // honored before the first background sync.
    void coordinator.p2pkhSettingsUpdate({ includeTestnet: service.getGlobalSettings().includeTestnet });
    ctx.provide(P2PKH_CAPABILITY, service);
    ctx.provide(P2PKH_PROTOCOL_SPEND_CAPABILITY, createP2pkhProtocolSpendService({
      vault,
      woc,
      claimStore: {
        async tryClaimInputs(input) {
          const bundle = await openP2pkhDb({ keyspace, publicKeyHex: input.publicKeyHex });
          return createP2pkhDb(bundle).tryClaimInputs(input);
        },
        async releaseLocalInputClaims(input) {
          const bundle = await openP2pkhDb({ keyspace, publicKeyHex: input.publicKeyHex });
          return createP2pkhDb(bundle).releaseLocalInputClaims(input.claimIds);
        }
      },
      submissionStore: {
        async getProtocolSubmission(input) {
          const bundle = await openP2pkhDb({ keyspace, publicKeyHex: input.publicKeyHex });
          return createP2pkhDb(bundle).getProtocolSubmission(input.id);
        },
        async putProtocolSubmission(record) {
          const bundle = await openP2pkhDb({ keyspace, publicKeyHex: record.publicKeyHex });
          return createP2pkhDb(bundle).putProtocolSubmission(record);
        }
      },
      protectedOutpoints,
      getKeyForOwner: async (ownerPublicKeyHex: string) => {
        const key = await keyspace.getKey(ownerPublicKeyHex);
        if (!key || !key.publicKeyHex) {
          throw new Error(`P2PKH owner key not ready: ${ownerPublicKeyHex}`);
        }
        return { publicKeyHex: key.publicKeyHex };
      }
    }));

    // 注册资源定义（硬切换 003）
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);

    // p2pkh.balance：P2PKH 余额数据（bsv + bsvtest）
    resources.register<{ bsv: P2pkhBalance | null; bsvtest: P2pkhBalance | null }, readonly string[]>({
      id: "p2pkh.balance",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.balance", context.activePublicKeyHex ?? "none"],
      load: async (_args, context, _signal) => {
        if (!context.activePublicKeyHex) {
          return { bsv: null, bsvtest: null };
        }
        const include = service.getGlobalSettings().includeTestnet;
        const calls: Promise<P2pkhBalance>[] = [service.getAssetBalance("bsv")];
        if (include) calls.push(service.getAssetBalance("bsvtest"));
        const results = await Promise.all(calls);
        const bsv = results[0] ?? null;
        const bsvtest = include ? (results[1] ?? null) : null;
        return { bsv, bsvtest };
      },
      subscribe: (_args, _ctx, invalidate) => {
        const offData = service.onDataChanged(invalidate);
        const offSettings = service.onGlobalSettingsChange(invalidate);
        return () => { offData(); offSettings(); };
      },
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return JSON.stringify(prev) === JSON.stringify(next);
      },
      invalidation: "microtask"
    });

    // p2pkh.settings：P2PKH 全局设置
    resources.register<P2pkhGlobalSettings, readonly string[]>({
      id: "p2pkh.settings",
      scope: "global",
      key: () => ["p2pkh.settings"],
      load: async () => service.getGlobalSettings(),
      subscribe: (_args, _ctx, invalidate) => service.onGlobalSettingsChange(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return prev.includeTestnet === next.includeTestnet
          && JSON.stringify(prev.feeRateSatoshisPerKb ?? {}) === JSON.stringify(next.feeRateSatoshisPerKb ?? {});
      },
      invalidation: "immediate"
    });

    resources.register<ReadinessState, readonly string[]>({
      id: "p2pkh.readiness",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.readiness", context.activePublicKeyHex ?? "none"],
      load: async () => keyspace.isInitializing()
        ? "initializing"
        : (keyspace.active().activePublicKeyHex ? "ready" : "no-active-key"),
      subscribe: (_args, _ctx, invalidate) => {
        const offActive = keyspace.onActiveKeyChanged(invalidate);
        const offInit = keyspace.onInitializationChange(invalidate);
        return () => { offActive(); offInit(); };
      },
      invalidation: "immediate"
    });

    resources.register<P2pkhSyncStatus, readonly string[]>({
      id: "p2pkh.sync-status",
      scope: "global",
      key: () => ["p2pkh.sync-status"],
      load: async () => {
        const task = coordinator.getBootstrapSnapshot().taskSnapshots.find((snapshot) => snapshot.id === "p2pkh.transactions-sync");
        if (!task) return service.syncStatus();
        if (task.state === "running") return "syncing";
        if (task.state === "blocked") return "blocked";
        if (task.error) return "failed";
        return task.lastCompletedAt ? "ok" : "idle";
      },
      subscribe: (_args, _ctx, invalidate) => { const offService = service.onSyncStatusChange(invalidate); const offCoordinator = coordinator.subscribeTopic("background.snapshot", invalidate); return () => { offService(); offCoordinator(); }; },
      invalidation: "immediate"
    });

    type P2pkhWalletResource = {
      resources: P2pkhKeyResource[];
      facts: P2pkhTransactionFact[];
      owned: P2pkhOwnedOutpointProjection[];
      locals: P2pkhLocalTransaction[];
      localOutpoints: P2pkhLocalOutpoint[];
      claims: P2pkhLocalInputClaim[];
      migrationAudits: P2pkhMigrationAudit[];
      protectedOutpoints: Array<{ txid: string; vout: number; network: BsvNetwork }>;
      sync: P2pkhTransactionSyncState[];
      syncStatus: P2pkhSyncStatus;
      syncError?: string;
      balances: Record<string, P2pkhBalance>;
      providers: P2pkhProviderRegistrySnapshot | null;
      factCursors: Record<string, string | undefined>;
      ownedCursors: Record<string, string | undefined>;
      localCursors: Record<string, string | undefined>;
      localOutpointCursors: Record<string, string | undefined>;
      claimCursors: Record<string, string | undefined>;
      inputValues: Record<string, number>;
      inputValuesByResource: Record<string, Record<string, number>>;
    };
    const loadWalletResource = async (context: { activePublicKeyHex?: string }): Promise<P2pkhWalletResource> => {
      if (!context.activePublicKeyHex) return { resources: [], facts: [], owned: [], locals: [], localOutpoints: [], claims: [], migrationAudits: [], protectedOutpoints: [], sync: [], syncStatus: "idle", balances: {}, providers: null, factCursors: {}, ownedCursors: {}, localCursors: {}, localOutpointCursors: {}, claimCursors: {}, inputValues: {}, inputValuesByResource: {} };
      const includeTestnet = service.getGlobalSettings().includeTestnet;
      const networks = includeTestnet ? ["main", "test"] as const : ["main"] as const;
      const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: context.activePublicKeyHex }));
      const resourcesForKey = await service.listResources();
      const resourceIds = resourcesForKey.map((resource) => resource.resourceId);
      // The wallet starts with a bounded page. The returned cursors are opaque
      // IndexedDB timeline cursors; the page can continue without rereading
      // the complete history on every invalidation.
      const walletLimits = { facts: 200, owned: 500, locals: 500, localOutpoints: 500, claims: 500 };
      const readPerResource = async <T>(reader: (resourceId: string) => Promise<T[]>): Promise<T[]> => (await Promise.all(resourceIds.map(reader))).flat();
      const readPagePerResource = async <T>(reader: (resourceId: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<{ items: T[]; cursors: Record<string, string | undefined> }> => {
        const values = await Promise.all(resourceIds.map(async (resourceId) => [resourceId, await reader(resourceId)] as const));
        return { items: values.flatMap(([, page]) => page.items), cursors: Object.fromEntries(values.map(([resourceId, page]) => [resourceId, page.nextCursor])) };
      };
      const [factsPage, ownedPage, localsPage, localOutpointsPage, claimsPage, migrationAudits, sync, balances, providerResult] = await Promise.all([
        service.listTransactionFactsPage ? readPagePerResource((resourceId) => service.listTransactionFactsPage!({ resourceId, limit: walletLimits.facts })) : service.listTransactionFacts ? readPerResource((resourceId) => service.listTransactionFacts!({ resourceId, limit: walletLimits.facts })).then((items) => ({ items, cursors: {} })) : Promise.resolve({ items: [] as P2pkhTransactionFact[], cursors: {} }),
        service.listOwnedOutpointsPage ? readPagePerResource((resourceId) => service.listOwnedOutpointsPage!({ resourceId, limit: walletLimits.owned })) : service.listOwnedOutpoints ? readPerResource((resourceId) => service.listOwnedOutpoints!({ resourceId, limit: walletLimits.owned })).then((items) => ({ items, cursors: {} })) : Promise.resolve({ items: [] as P2pkhOwnedOutpointProjection[], cursors: {} }),
        service.listLocalTransactionsPage ? readPagePerResource((resourceId) => service.listLocalTransactionsPage!({ resourceId, limit: walletLimits.locals })) : service.listLocalTransactions ? readPerResource((resourceId) => service.listLocalTransactions!({ resourceId, limit: walletLimits.locals })).then((items) => ({ items, cursors: {} })) : Promise.resolve({ items: [] as P2pkhLocalTransaction[], cursors: {} }),
        service.listLocalOutpointsPage ? readPagePerResource((resourceId) => service.listLocalOutpointsPage!({ resourceId, limit: walletLimits.localOutpoints })) : service.listLocalOutpoints ? readPerResource((resourceId) => service.listLocalOutpoints!({ resourceId, limit: walletLimits.localOutpoints })).then((items) => ({ items, cursors: {} })) : Promise.resolve({ items: [] as P2pkhLocalOutpoint[], cursors: {} }),
        service.listLocalInputClaimsPage ? readPagePerResource((resourceId) => service.listLocalInputClaimsPage!({ resourceId, limit: walletLimits.claims })) : readPerResource((resourceId) => service.listLocalInputClaims(resourceId, walletLimits.claims)).then((items) => ({ items, cursors: {} })),
        db.listMigrationAudits(),
        db.listTransactionSyncStates(),
        Promise.all(networks.map(async (network) => [network, await service.getAssetBalance(network === "main" ? "bsv" : "bsvtest")] as const)),
        coordinator.p2pkhProvidersGet()
      ]);
      const facts = factsPage.items;
      const owned = ownedPage.items;
      const locals = localsPage.items;
      const localOutpoints = localOutpointsPage.items;
      const claims = claimsPage.items;
      const inputKeysByResource = new Map(resourceIds.map((resourceId) => [resourceId, new Set<string>()]));
      for (const fact of facts) for (const key of fact.inputOutpointKeys) inputKeysByResource.get(fact.resourceId)?.add(key);
      for (const local of locals) for (const key of local.inputOutpointKeys) inputKeysByResource.get(local.resourceId)?.add(key);
      const inputValuesByResource = service.listOwnedOutpointValues
        ? Object.fromEntries(await Promise.all(resourceIds.map(async (resourceId) => [resourceId, await service.listOwnedOutpointValues!(resourceId, [...(inputKeysByResource.get(resourceId) ?? [])])] as const)))
        : {};
      const inputValues = Object.assign({}, ...Object.values(inputValuesByResource));
      const task = coordinator.getBootstrapSnapshot().taskSnapshots.find((snapshot) => snapshot.id === "p2pkh.transactions-sync");
      const syncStatus: P2pkhSyncStatus = !task ? "idle" : task.state === "running" ? "syncing" : task.state === "blocked" ? "blocked" : task.error ? "failed" : task.lastCompletedAt ? "ok" : "idle";
      const blockedReason = task?.blockedReason;
      const syncError = (typeof blockedReason === "string" ? blockedReason : blockedReason?.fallback) ?? task?.error ?? sync.find((row) => row.lastError)?.lastError;
      return { resources: resourcesForKey, facts, owned, locals, localOutpoints, claims, migrationAudits, protectedOutpoints: protectedOutpoints.list({ publicKeyHex: context.activePublicKeyHex }), sync, syncStatus, syncError, balances: Object.fromEntries(balances), providers: providerResult.status === "ok" ? providerResult.value : null, factCursors: factsPage.cursors, ownedCursors: ownedPage.cursors, localCursors: localsPage.cursors, localOutpointCursors: localOutpointsPage.cursors, claimCursors: claimsPage.cursors, inputValues, inputValuesByResource };
    };
    resources.register<P2pkhWalletResource, readonly string[]>({
      id: "p2pkh.wallet",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none", String(service.getGlobalSettings().includeTestnet)],
      load: async (_args, context) => loadWalletResource(context),
      subscribe: (_args, _ctx, invalidate) => { const offs = [service.onDataChanged(invalidate), service.onGlobalSettingsChange(invalidate), keyspace.onActiveKeyChanged(invalidate), coordinator.subscribeTopic("p2pkh.providers", invalidate), coordinator.subscribeTopic("background.snapshot", invalidate)]; return () => offs.forEach((off) => off()); },
      invalidation: "microtask"
    });
    resources.register<{ facts: P2pkhTransactionFact[]; locals: P2pkhLocalTransaction[]; sync: P2pkhTransactionSyncState[] }, readonly string[]>({
      id: "p2pkh.transactions",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.transactions", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => { const wallet = await loadWalletResource(context); return { facts: wallet.facts, locals: wallet.locals, sync: wallet.sync }; },
      subscribe: (_args, _ctx, invalidate) => { const off = service.onDataChanged(invalidate); return () => off(); },
      invalidation: "microtask"
    });
    resources.register<{ owned: P2pkhOwnedOutpointProjection[]; localOutpoints: P2pkhLocalOutpoint[] }, readonly string[]>({
      id: "p2pkh.coins",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.coins", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => { const wallet = await loadWalletResource(context); return { owned: wallet.owned, localOutpoints: wallet.localOutpoints }; },
      subscribe: (_args, _ctx, invalidate) => { const off = service.onDataChanged(invalidate); return () => off(); },
      invalidation: "microtask"
    });

    resources.register<{ outpoints: Array<{ txid: string; vout: number; network: BsvNetwork; ownerPluginId: string; reason?: string; kind?: string; publicKeyHex?: string }> }, readonly string[]>({
      id: "p2pkh.protected-outpoints",
      scope: "active-key",
      key: (args, context) => ["p2pkh.protected-outpoints", context.activePublicKeyHex ?? "none", args[0] ?? "all"],
      load: async (args, context) => {
        if (!context.activePublicKeyHex) {
          return { outpoints: [] };
        }
        const network = args[0] === "bsv" || args[0] === "bsvtest" ? (args[0] === "bsv" ? "main" : "test") : undefined;
        const outpoints = protectedOutpoints.list({
          publicKeyHex: context.activePublicKeyHex,
          ...(network ? { network } : {})
        });
        return { outpoints };
      },
      subscribe: (_args, _ctx, invalidate) => {
        const off = protectedOutpoints.onChange(invalidate);
        const offKey = keyspace.onActiveKeyChanged(invalidate);
        return () => { off(); offKey(); };
      },
      invalidation: "microtask"
    });
    resources.register<{ activePublicKeyHex?: string; identity?: KeyIdentity; resource?: P2pkhKeyResource }, readonly string[]>({
      id: "p2pkh.transfer-context",
      scope: "active-key",
      key: (args, context) => ["p2pkh.transfer-context", context.activePublicKeyHex ?? "none", args[0] ?? ""],
      load: async (args, context) => {
        const publicKeyHex = context.activePublicKeyHex;
        if (!publicKeyHex) return {};
        const [identity, resourcesForKey] = await Promise.all([
          keyspace.getKey(publicKeyHex),
          service.listResources(args[0] === "bsv" || args[0] === "bsvtest" ? args[0] as P2pkhAssetId : undefined)
        ]);
        return { activePublicKeyHex: publicKeyHex, identity, resource: resourcesForKey[0] };
      },
      subscribe: (_args, _ctx, invalidate) => {
        const off = keyspace.onActiveKeyChanged(invalidate);
        const offData = service.onDataChanged(invalidate);
        return () => { off(); offData(); };
      },
      invalidation: "immediate"
    });

    void service.rehydrate();

    // 硬切换 002 收尾：key.created payload 只携带 publicKeyHex；service 按 publicKeyHex 工作。
    const keyCreatedUnsub = messageBus.subscribe<{ publicKeyHex: string; label: string }>("key.created", async (payload) => {
      if (!payload.publicKeyHex) return;
      await service.onKeyImported(payload.publicKeyHex);
    });

    const assets = ctx.get<AssetRegistry>("asset.registry");
    const assetProvider = createP2pkhAssetProvider({ service, messageBus, keyspace });
    assets.register(assetProvider);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "p2pkh.transaction",
      path: "/p2pkh/tx/:txid",
      label: { key: "p2pkh.route.transaction", fallback: "P2PKH transaction" },
      component: P2pkhTransactionDetailRoute
    });
    routes.register({
      id: "p2pkh.settings",
      path: "/p2pkh/settings",
      label: { key: "p2pkh.route.settings", fallback: "P2PKH provider settings" },
      component: P2pkhSettingsPage
    });

    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    const disposeNavigation = registerP2pkhNavigation({
      routes,
      business,
      includeTestnet: service.getGlobalSettings().includeTestnet,
      onIncludeTestnetChange: (handler) => service.onGlobalSettingsChange((settings) => handler(settings.includeTestnet))
    });
    ctx.onDispose(disposeNavigation);

    const systemSettings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    systemSettings.register({
      id: "p2pkh.system-settings.testnet",
      group: {
        id: "p2pkh",
        label: { key: "p2pkh.settings.label", fallback: "P2PKH" },
        order: 30
      },
      label: { key: "p2pkh.settings.label", fallback: "P2PKH" },
      description: { key: "p2pkh.settings.description", fallback: "P2PKH product settings." },
      component: P2pkhSettingsPage,
      order: 10,
      replacesSettingsRouteId: "p2pkh.settings",
      visibleWhen: ({ unlocked }) => unlocked
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
        if (path === "/p2pkh/mainnet/transactions" || path === "/p2pkh/testnet/transactions") {
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: "p2pkh.crumb.transactions", fallback: "On-chain transactions" }, path }
          ];
        }
        if (path === "/p2pkh/mainnet/local-transactions" || path === "/p2pkh/testnet/local-transactions") {
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: "p2pkh.crumb.localTransactions", fallback: "Local transactions" }, path }
          ];
        }
        if (path.startsWith("/p2pkh/tx/")) {
          const search = typeof window !== "undefined" ? window.location.search : "";
          const sourcePath = transactionSourceListPath(search);
          const source = sourcePath.endsWith("/local-transactions") ? "local-transactions" : "transactions";
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: source === "local-transactions" ? "p2pkh.crumb.localTransactions" : "p2pkh.crumb.transactions", fallback: source === "local-transactions" ? "Local transactions" : "On-chain transactions" }, path: sourcePath },
            { label: { key: "p2pkh.crumb.transaction", fallback: "Transaction" } }
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
