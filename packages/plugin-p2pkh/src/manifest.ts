import { requireWocNetwork } from "@keymaster/contracts";
import { CHAIN_FEE_READER_CAPABILITY } from "@keymaster/contracts";
import { requireUnlockedWalletIdentity, bindWalletIdentity } from "@keymaster/contracts";
import { setupP2pkhUriActions } from "./setupUriActions.js";
import { IdentityHomeButton } from "./IdentityHomeButton.js";
import { identityResources } from "./identityResources.js";
import { URI_ACTION_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_TRANSFER_CAPABILITY, P2PKH_WORKER_PROTOCOL_CAPABILITY } from "@keymaster/contracts";
import { createWindowTransferBinding } from "./windowTransfer.js";
import { WOC_WORKER_BROADCAST_CAPABILITY } from "@keymaster/contracts";
import { createInstanceRegistryService } from "@keymaster/runtime";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { STORAGE_FILE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { transferResources } from "./transferResources.js";
import { registerP2pkhTransferUi } from "./pages/registerP2pkhTransferUi.js";
import { CONTACTS_PICKER_CAPABILITY, CONTACTS_SERVICE_CAPABILITY, CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { P2pkhSettingsBlock } from "./pages/P2pkhSettingsPage.js";
import { bindP2pkhUi } from "./P2pkhResourceContext.js";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-p2pkh/src/manifest.ts
// P2PKH 业务包（硬切换后）：
//   - 注入 woc.service / background.registry / background.service。
//   - 提供当前钱包余额及普通 BSV 转账，不经过资产目录或 Offer。
//   - 注册页面：链上交易、本地交易；设置通过 Page 贡献给 Workspace 的 BSV 链页面。
//   - 不再自己创建 interval；不再自己向 Topbar 写组件。
//   - 监听 vault 事件自动同步。
//
// 硬切换 003：route / business navigation / home widget / breadcrumb 全部走 I18nText。

import type {
  CentralBroadcastService,
  GlobalBalanceSnapshot,
  BusinessFeatureRegistry,
  BreadcrumbProvider,
  BreadcrumbRegistry,
  I18nPluginResources,
  VaultWalletState,
  KeyIdentity,
  PluginManifest,
  PluginSetup,
  ResourceRegistry,
  RouteRegistry,
  ProtectedOutpointRegistry,
  VaultService,
  WocService,
  P2pkhCoordinatorControl,
  P2pkhBroadcastAssemblyControl
} from "@keymaster/contracts";
import {
  CENTRAL_BROADCAST_CAPABILITY,
  BALANCE_BROADCAST_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY,
  P2PKH_PROTOCOL_SPEND_CAPABILITY,
  P2PKH_FUNDING_CAPABILITY,
  P2PKH_SUBMISSION_OBSERVER_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  RUNTIME_MESSAGE_BUS,
  VAULT_SERVICE_CAPABILITY,
  WOC_CAPABILITY,
  P2PKH_COORDINATOR_CONTROL_CAPABILITY,
  P2PKH_ADDRESS_CODEC_CAPABILITY,
  P2PKH_SETTINGS_READER_CAPABILITY,
  BSV_PRICE_READER_CAPABILITY,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import type { P2pkhGlobalSettings, P2pkhSyncStatus, P2pkhKeyResource, P2pkhHistoryRecord, P2pkhLocalTransaction, P2pkhTransactionSyncState, P2pkhUtxo } from "./p2pkhContracts.js";

type ReadinessState = "initializing" | "no-active-key" | "ready";
import { createP2pkhService } from "./p2pkhService.js";
import { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
import { p2pkhAddressCodec } from "./p2pkhAddressCodec.js";
import { createProtocolFundingService } from "./p2pkhProtocolFunding.js";
import { createWindowProtocolSpend } from "./windowProtocolSpend.js";
import { createWalletProtectedOutpoints } from "./registries/walletProtectedOutpoints.js";
import { createCentralBroadcastService } from "./centralBroadcastService.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
import { registerP2pkhNavigation } from "./pages/P2pkhNavigation.js";
import { P2pkhTransactionDetailRoute } from "./pages/P2pkhTransactionDetailPage.js";
import { transactionSourceListPath } from "./pages/p2pkhTransactionView.js";
import { P2pkhBalanceWidget } from "./widgets/P2pkhBalanceWidget.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { emptyGlobalBalanceSnapshot } from "@keymaster/contracts";

export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";

/** P2PKH i18n 资源：覆盖 route/menu/home/settings/breadcrumb 展示与 P2PKH 业务文案。 */
export const p2pkhResources: I18nPluginResources = {
  namespace: "p2pkh",
  resources: {
    en: {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH transfers: bsv / bsvtest networks (testnet is gated by the bsvNetwork setting).",
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
      "p2pkh.settings.description": "P2PKH product settings (bsvNetwork, etc.). WOC settings are on the WOC page.",
      "p2pkh.home.balance": "P2PKH balance",
      "p2pkh.task.transactions.label": "P2PKH confirmed transactions",
      "p2pkh.task.transactions.description": "Sync WoC history metadata and refresh the in-memory UTXO snapshot.",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "On-chain tx",
      "p2pkh.activity.unconfirmed": "Unconfirmed tx",
      "p2pkh.activity.localSubmission": "Local submission",
      "p2pkh.activity.failed": "Failed / isolated tx",
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
      "p2pkh.action.loadingMore": "Loading…",
      "p2pkh.action.refreshUtxos": "Refresh UTXOs",
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
      "p2pkh.settings.desc": "P2PKH product settings: network scope, fee rates and the WoC endpoint.",
      "p2pkh.settings.unavailable": "Wallet is locked or the P2PKH service is temporarily unavailable; unlock to continue configuring.",
      "p2pkh.wallet.locked.title": "Wallet is locked",
      "p2pkh.wallet.locked.description": "Unlock to view transactions again.",
      "p2pkh.detail.locked.title": "Wallet is locked",
      "p2pkh.detail.locked.description": "Unlock to view transaction details again.",
      "p2pkh.wallet.settings": "Provider settings",
      "p2pkh.wallet.loadFailed": "Wallet data unavailable",
      "p2pkh.wallet.transactions.title": "On-chain transactions",
      "p2pkh.wallet.transactions.description": "WoC history metadata (txid / height); the detail page lazily loads the raw transaction.",
      "p2pkh.wallet.localTransactions.title": "Local transactions",
      "p2pkh.wallet.localTransactions.description": "Local transaction lifecycle and chain resolution.",
      "p2pkh.wallet.balances": "BSV balances",
      "p2pkh.wallet.syncStatus": "Confirmed synchronization status",
      "p2pkh.wallet.lastCompleteSync": "Last complete sync: {{time}}",
      "p2pkh.wallet.utxoSnapshot": "UTXO snapshot: {{time}} ({{count}} outputs)",
      "p2pkh.wallet.testSync": "test {{time}}",
      "p2pkh.wallet.taskStatus": "Task status: {{status}}",
      "p2pkh.wallet.syncError": "Sync error: {{error}}",
      "p2pkh.wallet.network": "Network",
      "p2pkh.wallet.networkDisabled": "Network identity mismatch",
      "p2pkh.wallet.networkDisabledDescription": "This route belongs to a different network from the wallet identity.",
      "p2pkh.wallet.pagination": "Transaction pages",
      "p2pkh.wallet.page": "Page {{page}}",
      "p2pkh.wallet.mainnet": "Mainnet",
      "p2pkh.wallet.testnet": "Testnet",
      "p2pkh.wallet.transaction": "Transaction {{txid}}",
      "p2pkh.wallet.parents": "Parents",
      "p2pkh.wallet.inputs": "Inputs",
      "p2pkh.wallet.outputs": "Outputs",
      "p2pkh.wallet.attempts": "Broadcast attempts",
      "p2pkh.wallet.none": "None",
      "p2pkh.balance.localSpendable": "Local spendable",
      "p2pkh.balance.confirmed": "Confirmed (spendable)",
      "p2pkh.balance.unconfirmed": "Unconfirmed (spendable)",
      "p2pkh.balance.unknown": "Unknown (UTXO snapshot not available yet)",
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
      "p2pkh.txDetail.confirmedHistoryId": "Confirmed history record",
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
      "p2pkh.resolution.unresolved": "Unresolved",
      "p2pkh.resolution.chain-confirmed": "Chain confirmed",
      "p2pkh.state.available": "Available",
      "p2pkh.state.spent": "Spent",
      "p2pkh.state.claimed": "Claimed",
      "p2pkh.state.protected": "Protected",
      "p2pkh.settings.bsvNetwork": "Include testnet assets",
      "p2pkh.settings.bsvNetwork.yes": "Yes",
      "p2pkh.settings.bsvNetwork.no": "No (recommended)",
      "p2pkh.settings.bsvNetworkHint": "The network is fixed when the identity is created or imported.",
      "p2pkh.settings.feeEffective": "Effective rate",
      "p2pkh.settings.feeRecommended": "WoC recommendation",
      "p2pkh.settings.feePending": "Not received yet; using fallback",
      "p2pkh.settings.feeUpdated": "Last successful update",
      "p2pkh.settings.feeRefreshFailed": "Refresh failed; the previous recommendation is retained.",
      "p2pkh.settings.feeManual": "Custom fee rate",
      "p2pkh.settings.feeSaveManual": "Save custom rate",
      "p2pkh.settings.feeUseWoc": "Use WoC recommendation automatically",
      "p2pkh.settings.feeScheduling": "Configure refresh interval",
      "p2pkh.settings.feeSource.woc": "Automatically following WoC",
      "p2pkh.settings.feeSource.manual": "Custom rate",
      "p2pkh.settings.feeSource.fallback": "Product fallback",
      "p2pkh.settings.feeRates": "BSV miner fee rates",
      "p2pkh.settings.feeRatesHint": "Defaults to the WoC recommendation. A manual rate remains in effect until you restore automatic mode. New transactions use the current rate.",
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
      "p2pkh.transfer.result.rejected": "Broadcast was rejected by the network. No local audit row was kept.",
      "p2pkh.transfer.result.unknown": "Broadcast result is unknown. Check the local audit row before retrying.",
      "p2pkh.transfer.result.broadcast": "The final preview transaction was broadcast and recorded locally.",
      "p2pkh.transfer.result.confirmClose": "Confirm and close",
      "p2pkh.transfer.result.again": "Start over",
      "p2pkh.transfer.noActiveKeyWarning": "No active key available. Repair the failed / uninitialized keys in Key management first.",
      "p2pkh.transfer.form.recipient": "Recipient address (read-only)",
      "p2pkh.transfer.form.recipientDerived": "Derived recipient address (read-only)",
      "p2pkh.transfer.form.recipientTarget": "This address was verified by the platform and is locked. Return to step 1 to change it.",
      "p2pkh.transfer.form.contactSelect": "Pick from contacts",
      "p2pkh.transfer.form.contactPlaceholder": "Unselected",
      "p2pkh.transfer.form.amount": "Amount (sats)",
      "p2pkh.transfer.form.feeRate": "Fee rate (sats/kB)",
      "p2pkh.transfer.form.amountPlaceholder": "Enter sats or choose All",
      "p2pkh.transfer.form.sendAll": "All",
      "p2pkh.transfer.form.sendAllHint": "The final received amount automatically subtracts the actual miner fee.",
      "p2pkh.transfer.form.availableBalance": "Available balance: {{balance}} sats ({{network}})",
      "p2pkh.transfer.form.availableBalanceUnknown": "Available balance: Unknown ({{network}})",
      "p2pkh.transfer.step.addressAmount": "Amount and miner fee rate",
      "p2pkh.transfer.step.addressAmountHint": "The platform verified and locked the recipient address. Only amount and miner fee rate can be entered here.",
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
      "p2pkh.transfer.preview.unsigned": "Confirmation authorizes signing and generates the transaction ID.",
      "p2pkh.transfer.preview.rawTxHex": "Unsigned transaction: ",
      "p2pkh.transfer.preview.copyHex": "Copy unsigned transaction",
      "p2pkh.transfer.preview.copied": "Copied",
      "p2pkh.transfer.err.recipient": "Please enter a recipient address",
      "p2pkh.transfer.err.amount": "Amount must be a positive integer",
      "p2pkh.transfer.err.feeMin": "Fee rate must be at least 1 sats/kB",
      "p2pkh.transfer.err.prepare": "Prepare failed",
      "p2pkh.transfer.err.submit": "Submit failed",
      "p2pkh.transfer.err.keyChanged": "Active key switched. Please prepare the preview again",
      "p2pkh.transfer.err.copyHex": "Failed to copy rawTxHex",
      "p2pkh.transfer.description.bsv": "Unsigned BSV mainnet transfer preview. Confirm to authorize signing and broadcasting.",
      "p2pkh.transfer.description.bsvtest": "Unsigned BSV testnet transfer preview. Confirm to authorize signing and broadcasting.",
      "p2pkh.col.protected": "Protected",
      "p2pkh.col.protected.empty": "Not protected",
      "p2pkh.transfer.result.broadcastPending": "Broadcast pending",
      "p2pkh.transfer.result.confirmed": "Confirmed",
      "p2pkh.transfer.result.dropped": "Dropped",
      "p2pkh.transfer.result.observedUnconfirmed": "Observed unconfirmed"
    },
    "zh-CN": {
      "p2pkh.provider.name": "P2PKH",
      "p2pkh.provider.description": "BSV P2PKH 转移：bsv / bsvtest 两个网络（testnet 受 bsvNetwork 设置控制）。",
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
      "p2pkh.settings.description": "P2PKH 产品设置（bsvNetwork 等）。WOC 设置请到独立 WOC 设置页。",
      "p2pkh.home.balance": "P2PKH 余额",
      "p2pkh.task.transactions.label": "P2PKH 确认交易",
      "p2pkh.task.transactions.description": "同步 WoC 历史元数据并刷新内存 UTXO 快照。",
      "p2pkh.asset.bsv": "BSV",
      "p2pkh.asset.bsvtest": "BSV Testnet",
      "p2pkh.activity.confirmed": "链上交易",
      "p2pkh.activity.unconfirmed": "未确认交易",
      "p2pkh.activity.localSubmission": "本地提交",
      "p2pkh.activity.failed": "失败/已隔离交易",
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
      "p2pkh.action.loadingMore": "正在加载…",
      "p2pkh.action.refreshUtxos": "刷新 UTXO",
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
      "p2pkh.settings.desc": "P2PKH 产品设置：网络范围、矿工费率与 WoC 端点。",
      "p2pkh.settings.unavailable": "钱包已锁定或 P2PKH 服务暂不可用；解锁后可继续配置。",
      "p2pkh.wallet.locked.title": "钱包已锁定",
      "p2pkh.wallet.locked.description": "解锁后可继续查看交易。",
      "p2pkh.detail.locked.title": "钱包已锁定",
      "p2pkh.detail.locked.description": "解锁后可继续查看交易详情。",
      "p2pkh.wallet.settings": "供应商设置",
      "p2pkh.wallet.loadFailed": "钱包数据不可用",
      "p2pkh.wallet.transactions.title": "链上交易",
      "p2pkh.wallet.transactions.description": "WoC 历史元数据（txid / 高度）；详情页按需懒加载 raw transaction。",
      "p2pkh.wallet.localTransactions.title": "本地交易",
      "p2pkh.wallet.localTransactions.description": "本地交易生命周期与链上裁决。",
      "p2pkh.wallet.syncStatus": "确认交易同步状态",
      "p2pkh.wallet.balances": "BSV 余额",
      "p2pkh.wallet.lastCompleteSync": "最近完整同步：{{time}}",
      "p2pkh.wallet.utxoSnapshot": "UTXO 快照：{{time}}（{{count}} 个输出）",
      "p2pkh.wallet.testSync": "test {{time}}",
      "p2pkh.wallet.taskStatus": "任务状态：{{status}}",
      "p2pkh.wallet.syncError": "同步错误：{{error}}",
      "p2pkh.wallet.network": "网络",
      "p2pkh.wallet.networkDisabled": "身份网络不一致",
      "p2pkh.wallet.networkDisabledDescription": "此页面的网络与当前钱包身份不一致。",
      "p2pkh.wallet.pagination": "交易分页",
      "p2pkh.wallet.page": "第 {{page}} 页",
      "p2pkh.wallet.mainnet": "主网",
      "p2pkh.wallet.testnet": "测试网",
      "p2pkh.wallet.transaction": "交易 {{txid}}",
      "p2pkh.wallet.parents": "父交易",
      "p2pkh.wallet.inputs": "输入",
      "p2pkh.wallet.outputs": "输出",
      "p2pkh.wallet.attempts": "广播尝试",
      "p2pkh.wallet.none": "无",
      "p2pkh.balance.localSpendable": "本地可花",
      "p2pkh.balance.confirmed": "已确认（可花费）",
      "p2pkh.balance.unconfirmed": "未确认（可花费）",
      "p2pkh.balance.unknown": "未知（尚未取得 UTXO 快照）",
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
      "p2pkh.txDetail.confirmedHistoryId": "确认历史记录",
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
      "p2pkh.resolution.unresolved": "未裁决",
      "p2pkh.resolution.chain-confirmed": "链上确认",
      "p2pkh.state.available": "可用",
      "p2pkh.state.spent": "已花费",
      "p2pkh.state.claimed": "已占用",
      "p2pkh.state.protected": "受保护",
      "p2pkh.settings.bsvNetwork": "包含 testnet 货币",
      "p2pkh.settings.bsvNetwork.yes": "是",
      "p2pkh.settings.bsvNetwork.no": "否（推荐）",
      "p2pkh.settings.bsvNetworkHint": "网络在创建或导入身份时确定，之后不可修改。",
      "p2pkh.settings.feeEffective": "当前有效费率",
      "p2pkh.settings.feeRecommended": "WoC 建议费率",
      "p2pkh.settings.feePending": "尚未获取，使用备用值",
      "p2pkh.settings.feeUpdated": "上次成功更新",
      "p2pkh.settings.feeRefreshFailed": "刷新失败；上次建议值已过期，继续保留。",
      "p2pkh.settings.feeManual": "自定义费率",
      "p2pkh.settings.feeSaveManual": "保存自定义费率",
      "p2pkh.settings.feeUseWoc": "使用 WoC 建议值（自动跟随）",
      "p2pkh.settings.feeScheduling": "设置刷新频率",
      "p2pkh.settings.feeSource.woc": "自动跟随 WoC",
      "p2pkh.settings.feeSource.manual": "手动设置",
      "p2pkh.settings.feeSource.fallback": "产品备用值",
      "p2pkh.settings.feeRates": "BSV 矿工费率",
      "p2pkh.settings.feeRatesHint": "默认自动使用 WoC 建议值；手动保存后保持自定义费率，直到恢复自动模式。新建交易采用当前有效费率。",
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
      "p2pkh.transfer.result.rejected": "广播被网络拒绝，未保留本地审计记录。",
      "p2pkh.transfer.result.unknown": "广播结果未知，请先查看本地审计记录再重试。",
      "p2pkh.transfer.result.broadcast": "已广播最终预览交易，并写入本地审计记录。",
      "p2pkh.transfer.result.confirmClose": "确认并关闭",
      "p2pkh.transfer.result.again": "再来一次",
      "p2pkh.transfer.noActiveKeyWarning": "当前没有可用的 active key。请先到 Key 管理处理失败 / 未初始化的 key 后再转账。",
      "p2pkh.transfer.form.recipient": "收款地址（只读）",
      "p2pkh.transfer.form.recipientDerived": "派生的收款地址（只读）",
      "p2pkh.transfer.form.recipientTarget": "此地址已由平台核对并锁定。如需更换，请返回第 1 步。",
      "p2pkh.transfer.form.contactSelect": "从联系人选择",
      "p2pkh.transfer.form.contactPlaceholder": "未选择",
      "p2pkh.transfer.form.amount": "金额 (sats)",
      "p2pkh.transfer.form.feeRate": "矿工费 (sats/kB)",
      "p2pkh.transfer.form.amountPlaceholder": "输入 sats，或选择全部",
      "p2pkh.transfer.form.sendAll": "全部",
      "p2pkh.transfer.form.sendAllHint": "最终到账额会自动扣除实际矿工费。",
      "p2pkh.transfer.form.availableBalance": "可用余额：{{balance}} sats（{{network}}）",
      "p2pkh.transfer.form.availableBalanceUnknown": "可用余额未知（{{network}}）",
      "p2pkh.transfer.step.addressAmount": "金额与矿工费率",
      "p2pkh.transfer.step.addressAmountHint": "收款地址已由平台核对并锁定；这里只能输入金额和矿工费率。",
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
      "p2pkh.transfer.preview.unsigned": "确认后才会签名，生成交易编号。",
      "p2pkh.transfer.preview.rawTxHex": "未签名交易：",
      "p2pkh.transfer.preview.copyHex": "复制未签名交易",
      "p2pkh.transfer.preview.copied": "已复制",
      "p2pkh.transfer.err.recipient": "请输入接收方地址",
      "p2pkh.transfer.err.amount": "金额必须为正整数",
      "p2pkh.transfer.err.feeMin": "矿工费费率必须至少为 1 sats/kB",
      "p2pkh.transfer.err.prepare": "准备失败",
      "p2pkh.transfer.err.submit": "提交失败",
      "p2pkh.transfer.err.keyChanged": "当前 key 已切换，请重新准备预览",
      "p2pkh.transfer.err.copyHex": "复制未签名交易 失败",
      "p2pkh.transfer.description.bsv": "BSV 主网未签名转账预览。确认后才申请签名并广播。",
      "p2pkh.transfer.description.bsvtest": "BSV Testnet 未签名转账预览。确认后才申请签名并广播。",
      "p2pkh.col.protected": "已保护",
      "p2pkh.col.protected.empty": "未保护",
      "p2pkh.transfer.result.broadcastPending": "等待广播",
      "p2pkh.transfer.result.confirmed": "已确认",
      "p2pkh.transfer.result.dropped": "已丢弃",
      "p2pkh.transfer.result.observedUnconfirmed": "已观察到未确认状态"
    }
  }
};

const p2pkhPluginDefinition = {
  id: "p2pkh",
  name: "P2PKH",
  description: "BSV P2PKH 资产实现：由 Coordinator 统一调度快照、门禁与中心广播。",

  units: [
    {
      id: "p2pkh.window",
      runtime: "window-main",
    connect: { providerMethods: ["p2pkh.transfer", "payment.pay", "payment.status", "feepool.prepare", "feepool.commit"] },
      scopeKind: "owner-session",
      provides: [PROTECTED_OUTPOINT_REGISTRY_CAPABILITY, P2PKH_CAPABILITY, BALANCE_BROADCAST_CAPABILITY, P2PKH_ADDRESS_CODEC_CAPABILITY, P2PKH_SETTINGS_READER_CAPABILITY, P2PKH_PROTOCOL_SPEND_CAPABILITY, P2PKH_FUNDING_CAPABILITY, P2PKH_SUBMISSION_OBSERVER_CAPABILITY, CENTRAL_BROADCAST_CAPABILITY, P2PKH_COORDINATOR_CONTROL_CAPABILITY],
      storage: CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles,
      dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "声明存储客户端及用途授权" },
      { capability: P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main", reason: "声明本插件的受限 Coordinator 连接" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
        { capability: URI_ACTION_REGISTRY_CAPABILITY, optional: true, reason: "注册收款 URI 内部转账入口" },
        { capability: VAULT_SERVICE_CAPABILITY, reason: "需要 vault 提供私钥与 key 管理" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "active key 与 key-scoped storage" },
        { capability: WOC_CAPABILITY, reason: "读取历史与详情；广播只能走中心服务" },
            { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "接入资产业务导航" },
        { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "注册 P2PKH 面包屑" },
        { capability: BSV_PRICE_READER_CAPABILITY, optional: true, reason: "余额卡片展示参考价格" },
      { capability: CONTACTS_PICKER_CAPABILITY, optional: true },
      { capability: CONTACTS_SERVICE_CAPABILITY, optional: true },
      { capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, reason: "贡献本实例内部设置 UI" },
      { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "UI 读取所属实例资源" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "注册 P2PKH resources" },
      { capability: CHAIN_FEE_READER_CAPABILITY, reason: "消费全局有效手续费率" },
        { capability: RUNTIME_MESSAGE_BUS, reason: "订阅 key lifecycle events" },
        ]),
    },
    {
      id: "p2pkh.coordinator-worker",
      runtime: "shared-worker",
      provides: [P2PKH_WORKER_TRANSFER_CAPABILITY, P2PKH_WORKER_PROTOCOL_CAPABILITY],
      scopeKind: "owner-session",
      dependencies: defineRuntimeUnitDependencies([
        { capability: STORAGE_FILE_CLIENTS_CAPABILITY, reason: "使用本 Worker 单元声明的 Storage purpose" },
        { capability: WOC_CAPABILITY, reason: "同步链上交易与 UTXO" },
        { capability: VAULT_WORKER_CRYPTO_CAPABILITY, reason: "当前 Worker 身份的受控签名视图" },
        { capability: WOC_WORKER_BROADCAST_CAPABILITY, reason: "Worker 广播 Provider；查询能力不含派发方法" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "读取本 Worker 当前 Vault 身份" },
      ], "shared-worker"),
      storage: CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles,
    },
  ],
  i18n: { namespace: p2pkhResources.namespace, resources: {
    en: { "p2pkh.uri.action": "Transfer BSV", "p2pkh.uri.review": "Review the recipient and amount on the transfer page before signing.", "p2pkh.uri.open": "Open transfer", ...Object.fromEntries(Object.entries(identityResources.resources.en ?? {}).filter(([key]) => key.startsWith("p2pkh.identity."))), ...p2pkhResources.resources.en, ...transferResources.resources.en },
    "zh-CN": { "p2pkh.uri.action": "转账 BSV", "p2pkh.uri.review": "请在转账页面核对收款人和金额，再确认签名。", "p2pkh.uri.open": "打开转账", ...Object.fromEntries(Object.entries(identityResources.resources["zh-CN"] ?? {}).filter(([key]) => key.startsWith("p2pkh.identity."))), ...p2pkhResources.resources["zh-CN"], ...transferResources.resources["zh-CN"] },
  } },
  setup(ctx) {
    const vault = ctx.capability(VAULT_SERVICE_CAPABILITY);
    const walletState = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const walletBinding = bindWalletIdentity(walletState, ctx.scope.signal);
    const walletIdentity = walletBinding.identity;
    const protectionStore = createProtectedOutpointRegistry();
    const protectionView = createWalletProtectedOutpoints(protectionStore, walletBinding);
    ctx.provide(PROTECTED_OUTPOINT_REGISTRY_CAPABILITY, createInstanceRegistryService(protectionView, PROTECTED_OUTPOINT_REGISTRY_CAPABILITY, undefined, ctx.scope));
    const assertWalletSession = () => { ctx.scope.assertActive(); walletBinding.assertActive(); };
    const currentWalletResource = (): P2pkhKeyResource => {
      assertWalletSession();
      return {
        resourceId: `p2pkh:${walletIdentity.bsvNetwork}`, publicKeyHex: walletIdentity.publicKeyHex,
        network: walletIdentity.bsvNetwork, address: p2pkhAddressCodec.deriveAddress(walletIdentity.publicKeyHex, walletIdentity.bsvNetwork),
        label: walletIdentity.label, createdAt: walletIdentity.createdAt, generation: 0,
      };
    };
    const woc = ctx.capability(WOC_CAPABILITY);
    const chainFees = ctx.capability(CHAIN_FEE_READER_CAPABILITY);
    const coordinator = ctx.capability(P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(ctx.consumer, ctx.scope) as (P2pkhCoordinatorControl & P2pkhBroadcastAssemblyControl) | undefined;
    if (!coordinator) throw new Error("P2PKH Coordinator control is unavailable");
    // p2pkhBroadcast 只留在装配层的局部闭包中；P2PKH 公共 Coordinator
    // capability 不再把 Worker 广播 RPC 传给插件/三方。
    const { p2pkhBroadcast: assemblyBroadcast, ...publicCoordinatorFields } = coordinator;
    const publicCoordinator = Object.freeze(publicCoordinatorFields);
    ctx.provide(P2PKH_COORDINATOR_CONTROL_CAPABILITY, publicCoordinator);
    const messageBus = ctx.capability(RUNTIME_MESSAGE_BUS);
    const protectedOutpoints = ctx.capability(PROTECTED_OUTPOINT_REGISTRY_CAPABILITY);
    const storage = ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "");
    const centralBroadcastService: CentralBroadcastService = createCentralBroadcastService({
      binding: walletBinding,
      coordinator: { p2pkhBroadcast: assemblyBroadcast },
    });
    ctx.provide(CENTRAL_BROADCAST_CAPABILITY, centralBroadcastService);

    // 普通转账的 Worker 出口：Window 不持有 Worker 的本地能力（跨 Runtime 的
    // local capability 依赖被装配校验拒绝），只经受限 Coordinator 连接调用
    // Worker 的 prepare/submit。跨边界只传可序列化数据；选币、冻结、签名与
    // 广播仍全部在 Worker 的 UTXO Manager 内完成，页面无法改写事实。
    const workerTransfer = createWindowTransferBinding({ wallet: walletBinding, coordinator: publicCoordinator });

    // 选币门禁的可变游标：先声明，`createP2pkhService` 需要它，而 fundingService 在
    // 其后才装配（它依赖 P2PKH 协议 spend 与保护登记）。
    let protectionRestore: Promise<void> = Promise.resolve();
    let protectionRestoreOwner: string | undefined;
    const startProtectionRestore = (): Promise<void> => {
      if (!walletBinding.isActive()) return Promise.reject(new Error("Protocol protection authority revoked"));
      assertWalletSession();
      const normalized = walletIdentity.publicKeyHex;
      // This instance restores only its captured identity; a new wallet needs a new instance.
      if (protectionRestoreOwner === normalized) return protectionRestore;
      protectionRestoreOwner = normalized;
      protectionRestore = (fundingService.restoreProtections?.() ?? Promise.resolve({ restored: 0, unreadable: [] }))
        .then((outcome) => {
          assertWalletSession();
          if (outcome.unreadable.length > 0) throw new Error(`专用资金保护恢复失败：${outcome.unreadable.join("、")}`);
        });
      // 只观察这同一个 Promise：它保持 rejected，选币仍会被阻断。
      // 不在 catch 内新建 Promise.reject；那会产生无人观察的第二次拒绝，
      // 并可能把上一会话迟到的失败写回新会话的恢复门禁。
      void protectionRestore.catch(() => undefined);
      return protectionRestore;
    };

    const { service, balance: broadcaster } = createP2pkhService({
      signal: ctx.scope.signal,
      vault,
      workerTransfer,
      coordinator: publicCoordinator,
      messageBus,
      walletState,
      storage,
      woc,
      centralBroadcastService,
      chainFees,
      // 选币前必须等保护登记恢复：见上面 startProtectionRestore 的注释。
      awaitProtectionRestore: () => protectionRestore,
    });
    ctx.provide(P2PKH_CAPABILITY, service);
    ctx.provide(P2PKH_SETTINGS_READER_CAPABILITY, {
      bsvNetwork: () => service.getGlobalSettings().bsvNetwork,
      onChange: listener => service.onGlobalSettingsChange(listener),
    });
    ctx.provide(BALANCE_BROADCAST_CAPABILITY, broadcaster);
    ctx.provide(P2PKH_ADDRESS_CODEC_CAPABILITY, p2pkhAddressCodec);
    // Window retains the plugin interface, never a signer or a local claim
    // authority. MSFile/Token/1Sat use the same durable Worker manager path.
    const protocolSpend = createWindowProtocolSpend(publicCoordinator, walletBinding);
    ctx.provide(P2PKH_PROTOCOL_SPEND_CAPABILITY, protocolSpend);

    // 专用资金：协议插件用它拆出金额已知的单输入 UTXO，避免协议交易直接花大额余额。
    //
    // 记录必须落盘：它是资金准备交易的**写前日志**。放进 Window 内存 Map 的话，
    // 重启后既丢了「这笔 UTXO 已经存在」的事实，也丢了受保护输出登记，下次发布会
    // 再拆一次钱，而上一笔还可能在链上。
    //
    // **每条记录一个文件**：两个标签页处理不同任务时写的是不同文件，一个页面的
    // 读-改-写不会覆盖另一个页面的写前日志。单文件承载全部记录时必然出现这种覆盖。
    const fundingFileStore = async (): Promise<ReturnType<typeof createP2pkhFileRepository>> =>
      createP2pkhFileRepository((await openP2pkhStateRepository(storage)).files);
    const fundingService = createProtocolFundingService({
      binding: walletBinding,
      protocolSpend: () => ctx.capability(P2PKH_PROTOCOL_SPEND_CAPABILITY),
      protectedOutpoints,
      store: {
        async get(fundingId, ownerPublicKeyHex) {
          if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) {
            throw new Error("P2PKH funding owner key is not active");
          }
          return (await fundingFileStore()).readProtocolFunding(fundingId);
        },
        async put(record, options) {
          // owner 校验：写前日志只能写进当前 owner 的存储。
          if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== record.ownerPublicKeyHex.toLowerCase()) {
            throw new Error("P2PKH funding owner key is not active");
          }
          await (await fundingFileStore()).writeProtocolFunding(
            {
              fundingId: record.fundingId,
              txid: record.txid,
              vout: record.vout,
              rawTxHex: record.rawTxHex,
              valueSatoshis: record.valueSatoshis,
              address: record.address,
              ...(record.submissionId === undefined ? {} : { submissionId: record.submissionId }),
              ...(record.broadcastState === undefined ? {} : { broadcastState: record.broadcastState }),
              updatedAtMs: record.updatedAtMs ?? Date.now(),
              ownerPublicKeyHex: record.ownerPublicKeyHex.toLowerCase(),
              network: record.network,
              ...(record.ownerPluginId === undefined ? {} : { ownerPluginId: record.ownerPluginId }),
              ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
            },
            options,
          );
        },
        async delete(fundingId) {
          await (await fundingFileStore()).deleteProtocolFunding(fundingId);
        },
        async list(ownerPublicKeyHex) {
          const { records, unreadable } = await (await fundingFileStore()).listProtocolFunding();
          // 别的 owner 的记录不算损坏，只是不可用。
          return {
            records: records.filter((record) => record.ownerPublicKeyHex.toLowerCase() === ownerPublicKeyHex.toLowerCase()),
            unreadable,
          };
        },
      },
      allocate: async (request) => {
        const ownerPublicKeyHex = walletState.snapshot().activePublicKeyHex;
        if (!ownerPublicKeyHex) throw new Error("Protocol funding owner is not active");
        assertWalletSession();
        if (request.assetId !== (walletIdentity.bsvNetwork === "test" ? "bsvtest" : "bsv")) throw new Error("Protocol funding network mismatch");
        return protocolSpend.planFunding({ amountSatoshis: request.amountSatoshis, feeRateSatoshisPerKb: request.feeRateSatoshisPerKb });
      },
      observeChain: async (network, txid) => {
        if (woc === undefined) return "unknown";
        const observation = await requireWocNetwork(woc, network).getTransactionObservation(txid);
        // 钱包侧看到确认只说明链上成立，不代表 Forum 已确认索引。
        if (observation.observation === "confirmed") return "confirmed";
        if (observation.observation === "unconfirmed") return "mempool";
        return "unknown";
      },
      // 按 outpoint 观察：回收路径必须能区分「资金交易还在」与「这个 UTXO 还在」。
      observeOutpoint: async ({ network, txid, vout }) => {
        if (woc === undefined) return "unknown";
        try {
          const spent = await requireWocNetwork(woc, network).getSpentOutput(txid, vout);
          // null 表示这条花费记录不存在；但「链数据源查不到」与「确实没被花」无法区分，
          // 因此只在明确拿到结果时给结论。
          return spent === null ? "unspent" : "spent";
        } catch {
          return "unknown";
        }
      },
      // 恢复专用资金时先问**同一个**提交是否派发过：缺席时上层只能拒绝，不能猜。
      observeSubmission: async ({ ownerPublicKeyHex, network, txid, submissionId }) => {
        if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) return "unknown";
        const bundle = await openP2pkhStateRepository(storage);
        const record = await createP2pkhStateRepository(bundle).getProtocolSubmission(submissionId);
        if (record === undefined) return "unknown";
        if (record.canonicalTxid !== txid || record.network !== network
          || record.publicKeyHex.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) return "unknown";
        switch (record.status) {
          case "prepared":
            return "not-dispatched";
          case "broadcast-pending-woc":
          case "woc-observed-unconfirmed":
            return "observed-unconfirmed";
          case "woc-confirmed":
            return "observed-confirmed";
          default:
            return "unknown";
        }
      },
      deriveChangeAddress: async (ownerPublicKeyHex, network) => {
        const active = walletState.snapshot().activePublicKeyHex;
        if (active?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) {
          throw new Error(`P2PKH funding owner key not ready: ${ownerPublicKeyHex}`);
        }
        const { address } = await vault.createActiveKeyCrypto()
          .then((crypto) => crypto.deriveP2pkhAddress());
        return address;
      },
    });
    ctx.provide(P2PKH_FUNDING_CAPABILITY, fundingService);

    // 专用资金的保护登记必须在钱包允许选币**之前**恢复：保护是内存态，重启后若不
    // 重建，一次普通 P2PKH 转账就可能把仍挂着的专用 UTXO 当成可用余额花掉。
    //
    // 因此这不是「顺手跑一下」的后台任务，而是选币的**前置条件**：`protectionGate`
    // 保存的 promise 会被 `allocateUtxos` 与转账的 `loadSpendableUtxos` await。
    // 恢复失败时门禁保持 rejected，选币因此失败而不是放行。
    //
    // 网络按**每条记录自己保存的 network** 决定（见 `restoreProtections`），
    // 不使用 `bsvNetwork` 之类设置：那不是某笔资金的网络。
    const offRestoreFundingProtections = walletState.subscribe(() => {
      void startProtectionRestore().catch(() => undefined);
    });
    void startProtectionRestore().catch(() => undefined);

    // 协议提交观测：恢复路径据此只对账**同一个**提交，不重建、不二次派发。
    ctx.provide(P2PKH_SUBMISSION_OBSERVER_CAPABILITY, {
      async observeProtocolSubmission(input) {
        assertWalletSession();
        if ("ownerPublicKeyHex" in input || "network" in input) throw new TypeError("Submission queries cannot select a wallet");
        const bundle = await openP2pkhStateRepository(storage);
        assertWalletSession();
        const record = await createP2pkhStateRepository(bundle).getProtocolSubmission(input.submissionId);
        // 记录不存在：可能还没落盘，也可能是别的提交。两种都不猜，按 unknown 处理。
        if (record === undefined) return "unknown";
        // 四元组必须全部对上，否则说明调用方拿错了提交。
        assertWalletSession();
        if (record.canonicalTxid !== input.txid || record.network !== walletIdentity.bsvNetwork
          || record.publicKeyHex.toLowerCase() !== walletIdentity.publicKeyHex) return "unknown";
        switch (record.status) {
          case "prepared":
            return "not-dispatched";
          case "broadcast-pending-woc":
          case "woc-observed-unconfirmed":
            return "observed-unconfirmed";
          case "woc-confirmed":
            return "observed-confirmed";
          case "woc-dropped":
            return "dropped";
          case "rejected":
            return "rejected";
          default:
            return "unknown";
        }
      },
    });

    // 注册资源定义（硬切换 003）
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);

    // p2pkh.balance：所有余额消费方共用的 GlobalBalanceSnapshot。
    resources.register<GlobalBalanceSnapshot, readonly string[]>({
      id: "p2pkh.balance",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.balance", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        if (!context.activePublicKeyHex) return emptyGlobalBalanceSnapshot();
        const snapshot = broadcaster.getSnapshot();
        return snapshot.publicKeyHex === context.activePublicKeyHex.trim().toLowerCase()
          ? snapshot
          : emptyGlobalBalanceSnapshot();
      },
      subscribe: (_args, _ctx, invalidate) => broadcaster.subscribe(() => invalidate()),
      equals: (prev, next) => !prev || !next
        ? prev === next
        : prev.revision === next.revision && prev.publicKeyHex === next.publicKeyHex,
      invalidation: "microtask"
    });

    resources.register<import("@keymaster/contracts").ChainFeeSnapshot, readonly string[]>({
      id: "p2pkh.chain-fee", scope: "active-key", key: () => ["p2pkh.chain-fee"],
      load: async () => { assertWalletSession(); return chainFees.get(); },
      subscribe: (_args, _context, invalidate) => chainFees.subscribe(invalidate), invalidation: "immediate"
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
        return prev.bsvNetwork === next.bsvNetwork
          && prev.feeRateSatoshisPerKb === next.feeRateSatoshisPerKb && JSON.stringify(prev.feePolicy) === JSON.stringify(next.feePolicy);
      },
      invalidation: "immediate"
    });

    resources.register<ReadinessState, readonly string[]>({
      id: "p2pkh.readiness",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.readiness", context.activePublicKeyHex ?? "none"],
      load: async () => (walletState.snapshot().activePublicKeyHex ? "ready" : "no-active-key"),
      // 初始化状态不再是 walletState 的一部分：ready 只取决于当前唯一 Key 投影。
      subscribe: (_args, _ctx, invalidate) => walletState.subscribe(invalidate),
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
      history: P2pkhHistoryRecord[];
      locals: P2pkhLocalTransaction[];
      utxos: P2pkhUtxo[];
      utxosAvailable: boolean;
      utxosSyncedAt?: string;
      sync: P2pkhTransactionSyncState[];
      syncStatus: P2pkhSyncStatus;
      /** 最近一次完整同步成功时间（来自 Coordinator 任务快照，跨进程可见）。 */
      lastSyncedAt?: string;
      syncError?: string;
      historyCursors: Record<string, string | undefined>;
      localCursors: Record<string, string | undefined>;
    };
    const emptyWallet = (): P2pkhWalletResource => ({ resources: [], history: [], locals: [], utxos: [], utxosAvailable: false, sync: [], syncStatus: "idle", historyCursors: {}, localCursors: {} });
    const loadWalletResource = async (context: { activePublicKeyHex?: string }): Promise<P2pkhWalletResource> => {
      if (!context.activePublicKeyHex) return emptyWallet();
      const stateRepository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
      const identity = requireUnlockedWalletIdentity(walletState.snapshot());
      if (identity.publicKeyHex !== context.activePublicKeyHex) throw new Error("P2PKH resource identity revoked");
      const resourcesForKey = [currentWalletResource()];
      const resourceIds = resourcesForKey.map((resource) => resource.resourceId);
      // 钱包首屏只取有界一页；cursor 是不透明 last-key，翻页不用重读全部历史。
      const walletLimits = { history: 200, locals: 500 };
      const readPagePerResource = async <T>(reader: (resourceId: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<{ items: T[]; cursors: Record<string, string | undefined> }> => {
        const values = await Promise.all(resourceIds.map(async (resourceId) => [resourceId, await reader(resourceId)] as const));
        return { items: values.flatMap(([, page]) => page.items), cursors: Object.fromEntries(values.map(([resourceId, page]) => [resourceId, page.nextCursor])) };
      };
      const [historyPage, localsPage, sync, utxoStatuses] = await Promise.all([
        readPagePerResource(() => service.listHistory({ limit: walletLimits.history })),
        readPagePerResource(() => service.listLocalTransactions({ limit: walletLimits.locals })),
        stateRepository.listTransactionSyncStates(),
        // 每个资源单独取内存快照状态；合并时只要有一个启用网络没有可信快照，
        // 整体标记为不可用（余额未知），绝不显示 0。
        Promise.all(resourcesForKey.map(() => service.getAvailableUtxos()))
      ]);
      const utxoStatus = {
        available: utxoStatuses.length > 0 && utxoStatuses.every((status) => status.available),
        syncedAt: utxoStatuses.map((status) => status.syncedAt).filter((value): value is string => typeof value === "string").sort().at(-1),
        utxos: utxoStatuses.flatMap((status) => status.utxos),
      };
      const task = coordinator.getBootstrapSnapshot().taskSnapshots.find((snapshot) => snapshot.id === "p2pkh.transactions-sync");
      const syncStatus: P2pkhSyncStatus = !task ? "idle" : task.state === "running" ? "syncing" : task.state === "blocked" ? "blocked" : task.error ? "failed" : task.lastCompletedAt ? "ok" : "idle";
      const blockedReason = task?.blockedReason;
      const syncError = (typeof blockedReason === "string" ? blockedReason : blockedReason?.fallback) ?? task?.error ?? sync.find((row) => row.lastError)?.lastError;
      return {
        resources: resourcesForKey,
        history: historyPage.items,
        locals: localsPage.items,
        utxos: utxoStatus.utxos,
        utxosAvailable: utxoStatus.available,
        ...(utxoStatus.syncedAt === undefined ? {} : { utxosSyncedAt: utxoStatus.syncedAt }),
        sync,
        syncStatus,
        ...(task?.lastCompletedAt === undefined ? {} : { lastSyncedAt: task.lastCompletedAt }),
        ...(syncError === undefined ? {} : { syncError }),
        historyCursors: historyPage.cursors,
        localCursors: localsPage.cursors,
      };
    };
    resources.register<P2pkhWalletResource, readonly string[]>({
      id: "p2pkh.wallet",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.wallet", context.activePublicKeyHex ?? "none", String(service.getGlobalSettings().bsvNetwork)],
      load: async (_args, context) => loadWalletResource(context),
      subscribe: (_args, _ctx, invalidate) => { const offs = [service.onDataChanged(invalidate), service.onGlobalSettingsChange(invalidate), walletState.subscribe(invalidate), coordinator.subscribeTopic("background.snapshot", invalidate)]; return () => offs.forEach((off) => off()); },
      invalidation: "microtask"
    });
    resources.register<{ history: P2pkhHistoryRecord[]; locals: P2pkhLocalTransaction[]; sync: P2pkhTransactionSyncState[] }, readonly string[]>({
      id: "p2pkh.transactions",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.transactions", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => { const wallet = await loadWalletResource(context); return { history: wallet.history, locals: wallet.locals, sync: wallet.sync }; },
      subscribe: (_args, _ctx, invalidate) => { const off = service.onDataChanged(invalidate); return () => off(); },
      invalidation: "microtask"
    });
    resources.register<{ utxos: P2pkhUtxo[]; available: boolean; syncedAt?: string }, readonly string[]>({
      id: "p2pkh.coins",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.coins", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => { const wallet = await loadWalletResource(context); return { utxos: wallet.utxos, available: wallet.utxosAvailable, ...(wallet.utxosSyncedAt === undefined ? {} : { syncedAt: wallet.utxosSyncedAt }) }; },
      subscribe: (_args, _ctx, invalidate) => { const off = service.onDataChanged(invalidate); return () => off(); },
      invalidation: "microtask"
    });
    resources.register<{ activePublicKeyHex?: string; identity?: KeyIdentity; resource?: P2pkhKeyResource }, readonly string[]>({
      id: "p2pkh.transfer-context",
      scope: "active-key",
      key: (_args, context) => ["p2pkh.transfer-context", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        const publicKeyHex = context.activePublicKeyHex;
        if (!publicKeyHex) return {};
        const identity = requireUnlockedWalletIdentity(walletState.snapshot());
        if (identity.publicKeyHex !== publicKeyHex) throw new Error("P2PKH transfer identity revoked");
        return { activePublicKeyHex: publicKeyHex, identity, resource: currentWalletResource() };
      },
      subscribe: (_args, _ctx, invalidate) => {
        const off = walletState.subscribe(invalidate);
        const offData = service.onDataChanged(invalidate);
        return () => { off(); offData(); };
      },
      invalidation: "immediate"
    });

    // 首次 rehydrate 是后台补齐，不属于 setup 的同步门禁。连接切换期间
    // 失败必须留在插件健康域；未处理的 Promise 会触发全局 fatal 页面。
    void service.rehydrate().catch(() => undefined);

    // 硬切换 002 收尾：key.created payload 只携带 publicKeyHex；service 按 publicKeyHex 工作。
    const keyCreatedUnsub = messageBus.subscribe<{ publicKeyHex: string; label: string }>("key.created", async (payload) => {
      if (payload.publicKeyHex !== walletIdentity.publicKeyHex) return;
      await service.onKeyImported();
    });

    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
    const TransactionDetail = bindP2pkhUi(ctx, P2pkhTransactionDetailRoute);
    pages.register({ kind: "page", id: "p2pkh.transaction", path: "/p2pkh/tx/:txid",
      label: { key: "p2pkh.route.transaction", fallback: "P2PKH transaction" }, render: () => createElement(TransactionDetail) });

    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    const disposeNavigation = registerP2pkhNavigation({
      pages,
      context: ctx,
      business
    });
    ctx.onDispose(disposeNavigation);

    registerP2pkhTransferUi(ctx, { path: "/transfer", walletState });
    setupP2pkhUriActions(ctx);
    const identityResources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    identityResources.register({ id: "p2pkh.identity-key", scope: "global", key: () => ["p2pkh.identity-key"], load: async () => walletState.snapshot(), subscribe: (_args, _context, invalidate) => walletState.subscribe(invalidate), invalidation: "immediate" });
    const Identity = bindP2pkhUi(ctx, IdentityHomeButton);
    pages.register({ kind: "home", id: "p2pkh.identity", slot: "main", order: -990, label: "Identity", render: () => createElement(Identity) });


    const SettingsBlock = bindP2pkhUi(ctx, P2pkhSettingsBlock);
    ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
      id: "p2pkh.settings", label: { key: "p2pkh.settings.title", fallback: "P2PKH" }, kind: "settings-block", path: "/settings/bsv-chain", order: 10,
      render: () => createElement(SettingsBlock),
    });
    ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view.register({
      kind: "home",
      id: "p2pkh.balance",
      label: { key: "p2pkh.balanceWidget.title", fallback: "P2PKH balance" },
      render: () => createElement(bindP2pkhUi(ctx, P2pkhBalanceWidget)),
      order: 10,
      slot: "aside",
    });

    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    const crumbProvider: BreadcrumbProvider = {
      id: "p2pkh.crumbs",
      order: 200,
      match: (path) => path.startsWith("/p2pkh"),
      resolve: (path) => {
        if (path === "/p2pkh/transactions") {
          return [
            { label: { key: "p2pkh.crumb.wallet", fallback: "Wallets" }, path: "/" },
            { label: { key: "p2pkh.crumb.transactions", fallback: "On-chain transactions" }, path }
          ];
        }
        if (path === "/p2pkh/local-transactions") {
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
    // providers 也必须 dispose，否则它们仍会被 messageBus / walletState 持续回调。
    return () => {
      try {
        keyCreatedUnsub();
      } catch {
        // swallow
      }
      try {
        offRestoreFundingProtections();
      } catch {
        // swallow
      }
      service.dispose?.();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: p2pkhSetup, ...p2pkhPlugin } = p2pkhPluginDefinition;
export { p2pkhSetup, p2pkhPlugin };
