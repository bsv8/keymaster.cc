import { ApplicationDisplaySettings } from "./ApplicationDisplaySettings.js";
import { ApplicationConnectionHost } from "./applicationConnectionHost.js";
import { ApplicationConnectionControls } from "./ApplicationCenter.js";
import { APPLICATION_AI_TOOLS_CAPABILITY, APPLICATION_CONNECTIONS_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, type ApplicationConnectionsSnapshot } from "@keymaster/contracts";
import { createPublicConnectService } from "./publicConnectService.js";
import { STORAGE_FILE_CLIENTS_CAPABILITY } from "@keymaster/contracts";
import { CONNECT_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { bindConnectUi } from "./ConnectResourceContext.js";
import { PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY, OWNED_RESOURCE_ACCESS_CAPABILITY } from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-connect/src/manifest.ts
// 对外连接插件（显示名 Connect，持久身份仍为 protocol）：完整钱包应用连接中心、逐操作外部许可与受限业务网关。
// 两个连接方向统一由主钱包宿主登记窗口；不注册专用连接页或跨窗口 bootstrap。
// 应用设置与审计走 durable-policy，连接事实与命令历史各用独立 purpose。
// 钱包身份、私钥和资金责任仍留在各自业务权威；SDK Receiver 只拥有连接绑定。

import type {
  I18nPluginResources,
  VaultWalletState,
  PluginContext,
  PluginManifest,
  PluginSetup,
  VaultService,
  ResourceRegistry,
  VaultStatus,
  ConnectSessionSnapshot,
  ConnectCommandFeedState,
  ConnectService,
  SessionCoordinatorClient,
  P2pkhProtocolAdapter
} from "@keymaster/contracts";
import { defineCapability } from "webloom-framework";
import {
  MSFILE_SERVICE_CAPABILITY,
  CONNECT_SERVICE_CAPABILITY,
  CONNECT_STORAGE_REPOSITORY_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  CONNECT_COORDINATOR_CONTROL_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  type ConnectCoordinatorControl,
} from "@keymaster/contracts";
import { defineRuntimeUnitDependencies } from "@keymaster/contracts";
import {
  createConnectService
} from "./connectService.js";
import { openConnectStorageRepository } from "./storage/protocolStorageRepository.js";
import { createConnectChannelRuntime } from "./channelRuntime.js";
import { CONNECT_STORAGE_DECLARATIONS, CONNECT_STORAGE_PURPOSES } from "./storage/protocolStorageDeclarations.js";

export const CONNECT_PLUGIN_ID = "protocol";
// 兼容说明：显示名已统一为 Connect，但 pluginId/moduleId/unitId 仍保留 protocol/protocol.window，
// 存储布局与数据不变（本次 A 方案硬切换，不做迁移）。Coordinator 绑定中的 "protocol" 保留，对应持久身份。
/** Connect only needs the stable adapter subset exposed by P2PKH. */
const P2PKH_SERVICE_CAPABILITY = defineCapability<P2pkhProtocolAdapter>({
  kind: "local",
  id: "p2pkh.service",
  version: "1",
});
const connectResources: I18nPluginResources = {
  namespace: "connect",
  resources: {
    en: {
      "connect.applicationDisplay.title": "Application settings",
      "connect.applicationDisplay.description": "Manage application opening, reminder sounds and system notifications.",
      "connect.applicationDisplay.opening": "Application opening",
      "connect.applicationDisplay.mode": "Open applications in",
      "connect.applicationDisplay.iframe": "Embedded iframe (default)",
      "connect.applicationDisplay.popup": "New window",
      "connect.applicationDisplay.note": "Only applies to applications opened next. Existing applications stay where they are. Apps can still open the wallet directly.",
      "connect.route.popup": "Connect",
      "connect.opener.missing":
        "This page must be opened by a third-party site via window.open. The opener window is no longer available.",
      "connect.topbar.origin": "Current site",
      "connect.topbar.origin.none": "Not bound",
      "connect.topbar.status": "Status",
      "connect.topbar.backToTop": "Back to latest",
      "connect.topbar.close": "Close",
      "connect.phase.waiting": "Waiting for next request",
      "connect.phase.unlocking": "Waiting for unlock",
      "connect.phase.confirming": "Waiting for confirmation",
      "connect.phase.executing": "Processing",
      "connect.phase.closing": "Closing",
      "connect.phase.error": "Error",
      "connect.waiting.title": "Waiting for request",
      "connect.waiting.desc":
        "A third-party site should send a request through postMessage. You can close this window if it opened by accident.",
      "connect.unlock.title": "Unlock to continue",
      "connect.unlock.desc":
        "This protocol request requires you to unlock the local Vault. Once unlocked, the request will continue automatically.",
      "connect.unlock.password": "Password",
      "connect.unlock.submit": "Unlock",
      "connect.unlock.cancel": "Cancel",
      "connect.unlock.err.failed": "Unlock failed",
      "connect.confirm.title": "Confirm request",
      "connect.confirm.origin": "Origin",
      "connect.confirm.method.identity.get": "Share your identity",
      "connect.confirm.method.intent.sign": "Sign the following content",
      "connect.confirm.method.cipher.encrypt": "Encrypt the following content",
      "connect.confirm.method.cipher.decrypt": "Decrypt the following content",
      "connect.confirm.method.connect.launch": "Start an app session",
      "connect.confirm.text": "Message",
      "connect.confirm.claims": "Requested claims",
      "connect.confirm.contentType": "Content type",
      "connect.confirm.window": "Valid until",
      "connect.confirm.cancel": "Cancel",
      "connect.confirm.confirm": "Confirm",
      "connect.executing": "Processing…",
      "connect.done.title": "Result delivered",
      "connect.done": "Done. You can close this window.",
      "connect.error": "Request failed",
      "connect.error.user_rejected": "You rejected the request.",
      "connect.error.active_key_unavailable": "No active key is available.",
      "connect.error.invalid_request": "Invalid request.",
      "connect.error.invalid_origin": "The request origin does not match the declared aud.",
      "connect.error.decrypt_failed": "Decryption failed.",
      "connect.error.internal_error": "Internal error.",
      "connect.feed.empty":
        "No command history for this site yet. The first request will appear here after it completes.",
      "connect.feed.empty.waitingOrigin":
        "Waiting for the first request from an external site. Command history will be archived by that site's exact origin.",
      "connect.feed.historyUnavailable":
        "History unavailable: local repository read failed. The current command still works, but it won't be persisted.",
      "connect.feed.list.aria": "Command flow history",
      "connect.feed.decision.pending": "Pending",
      "connect.feed.decision.approved": "Approved",
      "connect.feed.decision.rejected": "Rejected",
      "connect.feed.decision.rejected.user_canceled": "You canceled",
      "connect.feed.decision.rejected.client_canceled": "Canceled by client",
      "connect.feed.decision.failed": "Failed",
      "connect.feed.origin": "Origin",
      "connect.feed.requestId": "Request id",
      "connect.feed.text": "Message",
      "connect.feed.claims": "Requested claims",
      "connect.feed.contentType": "Content type",
      "connect.feed.activeKey": "Signer public key (legacy)",
      "connect.feed.ownerKey": "Session owner public key",
      "connect.feed.walletPublicKeyHex": "Connect session id",
      "connect.feed.error": "Error",
      "connect.feed.timeline": "Timeline",
      /* ============== 施工单 002 硬切换：新增 i18n key ============== */
      "connect.topbar.originSettings": "Site settings",
      "connect.confirm.method.p2pkh.transfer": "Transfer satoshis",
      "connect.confirm.method.feepool.prepare": "Prepare a fee-pool transaction",
      "connect.confirm.method.feepool.commit": "Commit a fee-pool transaction",
      "connect.confirm.p2pkh.asset": "Asset",
      "connect.confirm.p2pkh.recipient": "Recipient address",
      "connect.confirm.p2pkh.amount": "Amount",
      "connect.confirm.p2pkh.feeRate": "Fee rate (sat/kB)",
      "connect.confirm.feepool.action": "Action",
      "connect.confirm.feepool.counterparty": "Counterparty public key",
      "connect.confirm.feepool.operationId": "Operation id",
      "connect.confirm.feepool.amount": "Amount",
      "connect.confirm.originSettingsBadge.off": "Auto-approve is off for this site",
      "connect.confirm.originSettingsBadge.on": "Auto-approve is on up to {{max}} sats",
      "connect.originSettings.title": "Per-origin settings",
      "connect.originSettings.paymentPolicyHint": "Set payment limits in the wallet top bar's payment channels. The wallet confirms payments exceeding a single or App session limit.",
      "connect.originSettings.saving": "Saving…",
      "connect.originSettings.err.saveFailed": "Failed to save this change",
      "connect.feed.asset": "Asset",
      "connect.feed.recipient": "Recipient address",
      "connect.feed.amount": "Amount",
      "connect.feed.action": "Action",
      "connect.feed.operationId": "Operation id",
      "connect.feed.counterparty": "Counterparty public key",
      "connect.feed.failureReason": "Local reason",
      "connect.feed.autoApproved": "Auto-approved",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "connect.topbar.wallet": "Open wallet",
      "connect.originSettings.identityAutoApprove.label": "Always allow identity.get",
      "connect.originSettings.cipherAutoApprove.label": "Always allow cipher.encrypt / cipher.decrypt",
      /* ============== 施工单 003：confirm 收口到历史卡 + 外部 cancel + 超时 ============== */
      "connect.originSettings.confirmTimeoutSeconds.label":
        "Confirmation timeout (seconds, default 30)",
      "connect.originSettings.confirmTimeoutSeconds.help":
        "This timeout only applies to the manual confirmation phase after the wallet is unlocked. Lock-screen waiting does not count down; queued / executing requests are not affected by this timeout.",
      "connect.feed.status.timed_out": "Timed out",
      "connect.feed.status.queued": "Confirmed, waiting to execute",
      "connect.feed.status.executing": "Processing",
      "connect.feed.status.waiting_unlock_manual": "Waiting for unlock (manual)",
      "connect.feed.status.waiting_unlock_auto": "Waiting for unlock (auto)",
      "connect.feed.waitingUnlock.title": "Waiting for unlock",
      "connect.feed.waitingUnlock.manualDesc":
        "This request needs the wallet to be unlocked. After unlock it will enter the confirmation page.",
      "connect.feed.waitingUnlock.autoDesc":
        "This request will execute automatically after the wallet is unlocked.",
      "connect.feed.queued.title": "Confirmed, waiting to execute",
      "connect.feed.queued.cancel": "Cancel queue",
      "connect.feed.method": "Method",
      "connect.sessionError.banner":
        "Cannot reach the external site. Please check the site console for details.",
      "connect.countdown.remaining": "{{seconds}}s remaining",
      /* ============== 施工单 2026-06-27 001：锁屏页文案 ============== */
      "connect.lockscreen.title": "Unlock to continue",
      "connect.lockscreen.desc":
        "Keymaster is locked. The current site has pending requests; they will continue automatically after unlock.",
      "connect.lockscreen.pendingTotal": "pending",
      "connect.lockscreen.manual": "Waiting for unlock (manual confirmation)",
      "connect.lockscreen.auto": "Auto-execute after unlock",
      "connect.lockscreen.queued": "Confirmed, waiting to execute",
      "connect.lockscreen.executing": "Executing",
      "connect.lockscreen.byMethod": "By method",
      "connect.lockscreen.unlockHint":
        "After unlock, {{total}} pending request(s) will automatically enter the confirmation / execution flow.",
      /* ============== 施工单 2026-06-28 001：connect 视图文案 ============== */
      "connect.connect.login.title": "Re-authenticate and create a new session",
      "connect.connect.hardware.desc": "Use the currently connected RocKey, unlocked on the device. Enter the PIN only on the device; payments exceeding limits require device approval.",
      "connect.connect.login.desc":
        "This site is asking for re-authentication. Pick a key and enter your password again. A successful login will create a new connect session and revoke the old one for the same origin.",
      "connect.connect.login.empty":
        "No ready key is available in this wallet. Please create or import one in Keymaster first.",
      "connect.connect.login.confirm": "Re-authenticate and create session",
      "connect.connect.logout.title": "Log out connect session",
      "connect.connect.logout.desc":
        "This site is asking to log out the current connect session. After this, business calls with the same sessionId will fail; you will need to log in again.",
      "connect.connect.logout.confirm": "Confirm logout",
      "connect.connect.cancel": "Cancel",
      "connect.connect.sessionExpired":
        "This session has expired or its key is no longer available. Please ask the site to log in again.",
      /* ============== 施工单 2026-06-29 001：Session Window / storage ============== */
      "connect.sessionWindow.title": "Session Window",
      "connect.sessionWindow.appView.waiting.title": "Waiting for launcher",
      "connect.sessionWindow.appView.waiting.desc":
        "Keymaster is starting this app. Keep this window open — it will hand off the session to the app and then you can close this tab.",
      "connect.sessionWindow.appView.signerMissing.title": "Session owner missing",
      "connect.sessionWindow.appView.signerMissing.desc":
        "The app session owner is no longer available. Please reopen the app from the Keymaster app store.",
      "connect.sessionWindow.appView.signerMismatch.title": "Could not start the app",
      "connect.sessionWindow.appView.signerMismatch.desc":
        "The app session owner does not match this session. Please reopen the app from the Keymaster app store.",
      "connect.sessionWindow.appView.failed.title": "Could not start the app",
      "connect.sessionWindow.appView.failed.desc":
        "Launcher failed to hand off the session. Please try starting the app again from the Keymaster app store.",
      "connect.sessionWindow.appView.openingClientApp": "Opening the app…",
      "connect.connect.launch.title": "App sign-in",
      "connect.connect.launch.desc":
        "The app is asking Keymaster to confirm this session. You can close this window after the app loads.",
      "connect.auth.login.eyebrow": "Sign in",
      "connect.feed.section.history": "History",
      "connect.feed.section.live": "Live request",
      "connect.sessionWindow.appView.connectTimeout.soft": "The app is taking longer than expected to connect.",
      "connect.sessionWindow.appView.openApp": "Open app",
      "connect.sessionWindow.appView.ready": "Session ready"
    },
    "zh-CN": {
      "connect.applicationDisplay.title": "应用设置",
      "connect.applicationDisplay.description": "管理应用打开方式、提示音和系统通知。应用打开方式在整个钱包统一使用，并持久保存。",
      "connect.applicationDisplay.opening": "应用打开方式",
      "connect.applicationDisplay.mode": "打开应用时使用",
      "connect.applicationDisplay.iframe": "iframe 内嵌（默认）",
      "connect.applicationDisplay.popup": "新窗口",
      "connect.applicationDisplay.note": "仅影响之后启动的应用，已打开的应用保持原样；不影响 App 主动拉起钱包。",
      "connect.route.popup": "连接页",
      "connect.opener.missing": "该页面必须由第三方站点通过 window.open 打开。opener 窗口已不可用。",
      "connect.topbar.origin": "当前站点",
      "connect.topbar.origin.none": "未绑定",
      "connect.topbar.status": "状态",
      "connect.topbar.backToTop": "回到最新",
      "connect.topbar.close": "关闭",
      "connect.phase.waiting": "等待下一条请求",
      "connect.phase.unlocking": "等待解锁",
      "connect.phase.confirming": "等待确认",
      "connect.phase.executing": "处理中",
      "connect.phase.closing": "收尾",
      "connect.phase.error": "错误",
      "connect.waiting.title": "等待请求",
      "connect.waiting.desc": "第三方站点应当通过 postMessage 发送请求。如果是误打开的，可以直接关闭。",
      "connect.unlock.title": "解锁后继续",
      "connect.unlock.desc": "此协议请求需要先解锁本地 Vault。解锁成功后请求会自动继续。",
      "connect.unlock.password": "密码",
      "connect.unlock.submit": "解锁",
      "connect.unlock.cancel": "取消",
      "connect.unlock.err.failed": "解锁失败",
      "connect.confirm.title": "确认请求",
      "connect.confirm.origin": "来源站点",
      "connect.confirm.method.identity.get": "分享你的身份",
      "connect.confirm.method.intent.sign": "签名以下内容",
      "connect.confirm.method.cipher.encrypt": "加密以下内容",
      "connect.confirm.method.cipher.decrypt": "解密以下内容",
      "connect.confirm.method.connect.launch": "启动应用会话",
      "connect.confirm.text": "提示文案",
      "connect.confirm.claims": "请求的 claims",
      "connect.confirm.contentType": "内容类型",
      "connect.confirm.window": "有效期",
      "connect.confirm.cancel": "取消",
      "connect.confirm.confirm": "确认",
      "connect.executing": "处理中…",
      "connect.done.title": "结果已回传",
      "connect.done": "已完成。可以关闭此窗口。",
      "connect.error": "请求失败",
      "connect.error.user_rejected": "你已取消请求。",
      "connect.error.active_key_unavailable": "当前没有可用的 active key。",
      "connect.error.invalid_request": "请求格式不合法。",
      "connect.error.invalid_origin": "请求来源与声明的 aud 不一致。",
      "connect.error.decrypt_failed": "解密失败。",
      "connect.error.internal_error": "内部错误。",
      "connect.feed.empty": "当前站点尚无命令历史。第一条请求完成后会出现在这里。",
      "connect.feed.empty.waitingOrigin": "等待来自外部站点的第一条请求。命令历史会按该站点的 origin 归档。",
      "connect.feed.historyUnavailable": "历史不可用：本地数据库读取失败。当前命令仍可正常执行，但不会持久化。",
      "connect.feed.list.aria": "命令流历史",
      "connect.feed.decision.pending": "等待",
      "connect.feed.decision.approved": "已批准",
      "connect.feed.decision.rejected": "已拒绝",
      "connect.feed.decision.rejected.user_canceled": "你已取消",
      "connect.feed.decision.rejected.client_canceled": "对方主动取消",
      "connect.feed.decision.failed": "执行失败",
      "connect.feed.origin": "来源站点",
      "connect.feed.requestId": "请求 id",
      "connect.feed.text": "提示文案",
      "connect.feed.claims": "请求的 claims",
      "connect.feed.contentType": "内容类型",
      "connect.feed.activeKey": "签名公钥（兼容）",
      "connect.feed.ownerKey": "会话 owner 公钥",
      "connect.feed.walletPublicKeyHex": "connect session id",
      "connect.feed.error": "错误",
      "connect.feed.timeline": "时间",
      /* ============== 施工单 002 硬切换：新增 i18n key ============== */
      "connect.topbar.originSettings": "站点配置",
      "connect.confirm.method.p2pkh.transfer": "转账 satoshis",
      "connect.confirm.method.feepool.prepare": "准备一笔费用池交易",
      "connect.confirm.method.feepool.commit": "提交一笔费用池交易",
      "connect.confirm.p2pkh.asset": "资产",
      "connect.confirm.p2pkh.recipient": "收款地址",
      "connect.confirm.p2pkh.amount": "金额",
      "connect.confirm.p2pkh.feeRate": "费率 (sat/kB)",
      "connect.confirm.feepool.action": "动作",
      "connect.confirm.feepool.counterparty": "对端公钥",
      "connect.confirm.feepool.operationId": "操作 id",
      "connect.confirm.feepool.amount": "金额",
      "connect.confirm.originSettingsBadge.off": "该站点自动确认未开启",
      "connect.confirm.originSettingsBadge.on": "自动确认已开启，上限 {{max}} sat",
      "connect.originSettings.title": "站点级配置",
      "connect.originSettings.paymentPolicyHint": "付款额度统一在钱包顶栏的支付渠道设置；超过单笔或 App 会话累计额度时由钱包确认。",
      "connect.originSettings.saving": "保存中…",
      "connect.originSettings.err.saveFailed": "本次修改未生效",
      "connect.feed.asset": "资产",
      "connect.feed.recipient": "收款地址",
      "connect.feed.amount": "金额",
      "connect.feed.action": "动作",
      "connect.feed.operationId": "操作 id",
      "connect.feed.counterparty": "对端公钥",
      "connect.feed.failureReason": "本地原因",
      "connect.feed.autoApproved": "已自动通过",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "connect.topbar.wallet": "进入钱包",
      "connect.originSettings.identityAutoApprove.label": "始终同意 账户信息获取",
      "connect.originSettings.cipherAutoApprove.label": "始终同意 加密解密",
      /* ============== 施工单 003：confirm 收口到历史卡 + 外部 cancel + 超时 ============== */
      "connect.originSettings.confirmTimeoutSeconds.label":
        "确认超时（秒，默认 30）",
      "connect.originSettings.confirmTimeoutSeconds.help":
        "该超时只作用于解锁后的人工确认阶段。锁屏等待阶段不计时；queued / executing 也不会被这个超时命中。",
      "connect.feed.status.timed_out": "超时",
      "connect.feed.status.queued": "已确认，等待执行",
      "connect.feed.status.executing": "处理中",
      "connect.feed.status.waiting_unlock_manual": "等待解锁（人工）",
      "connect.feed.status.waiting_unlock_auto": "等待解锁（自动）",
      "connect.feed.waitingUnlock.title": "等待解锁",
      "connect.feed.waitingUnlock.manualDesc":
        "此请求需要解锁钱包。解锁后会进入确认页。",
      "connect.feed.waitingUnlock.autoDesc":
        "此请求会在解锁后自动执行。",
      "connect.feed.queued.title": "已确认，等待执行",
      "connect.feed.queued.cancel": "取消排队",
      "connect.feed.method": "方法",
      "connect.sessionError.banner":
        "无法连接到外部站点。请回到来源站点查看控制台日志。",
      "connect.countdown.remaining": "剩余 {{seconds}} 秒",
      /* ============== 施工单 2026-06-27 001：锁屏页文案 ============== */
      "connect.lockscreen.title": "解锁后继续",
      "connect.lockscreen.desc":
        "Keymaster 当前处于锁定状态。当前站点已有请求；解锁后会自动继续处理。",
      "connect.lockscreen.pendingTotal": "条待处理",
      "connect.lockscreen.manual": "待解锁后人工确认",
      "connect.lockscreen.auto": "解锁后自动执行",
      "connect.lockscreen.queued": "已确认待执行",
      "connect.lockscreen.executing": "执行中",
      "connect.lockscreen.byMethod": "按 method 聚合",
      "connect.lockscreen.unlockHint":
        "解锁后，{{total}} 条待处理请求会自动进入确认 / 执行流程。",
      /* ============== 施工单 2026-06-28 001：connect 视图文案 ============== */
      "connect.connect.login.title": "重新认证并建立新会话",
      "connect.connect.hardware.desc": "使用当前已连接并在设备上解锁的 RocKey。PIN 只在设备上输入；后续超额度支付由设备确认。",
      "connect.connect.login.desc":
        "该站点请求重新认证。请选择一把 key，并再次输入密码。成功后会创建新的 connect session，并吊销同 origin 的旧 session。",
      "connect.connect.login.empty":
        "当前钱包没有 ready 的 key。请先回到 Keymaster 创建或导入一把 key。",
      "connect.connect.login.confirm": "重新认证并建立会话",
      "connect.connect.logout.title": "注销 connect 会话",
      "connect.connect.logout.desc":
        "该站点请求注销本次 connect 会话。注销后该 sessionId 的业务调用将全部失败，需要重新 login。",
      "connect.connect.logout.confirm": "确认注销",
      "connect.connect.cancel": "取消",
      "connect.connect.sessionExpired":
        "该会话已失效或绑定 key 不可用。请回到站点重新登录。",
      /* ============== 施工单 2026-06-29 001：Session Window / storage ============== */
      "connect.sessionWindow.title": "Session Window",
      "connect.sessionWindow.appView.waiting.title": "等待 launcher 启动",
      "connect.sessionWindow.appView.waiting.desc":
        "Keymaster 正在启动此 app。请保持本窗口打开 — 它会把会话交给 app，然后你可以关闭此标签页。",
      "connect.sessionWindow.appView.signerMissing.title": "session owner 已失效",
      "connect.sessionWindow.appView.signerMissing.desc":
        "app 的 session owner 不可用，请回到 Keymaster 应用商店重新启动该 app。",
      "connect.sessionWindow.appView.signerMismatch.title": "无法启动 app",
      "connect.sessionWindow.appView.signerMismatch.desc":
        "app 的 session owner 与本次会话不匹配，请回到 Keymaster 应用商店重新启动该 app。",
      "connect.sessionWindow.appView.failed.title": "无法启动 app",
      "connect.sessionWindow.appView.failed.desc":
        "Launcher 未成功完成会话交接。请回到 Keymaster 应用商店重新启动该 app。",
      "connect.sessionWindow.appView.openingClientApp": "正在打开 app…",
      "connect.connect.launch.title": "App 登录",
      "connect.connect.launch.desc":
        "App 正在请求 Keymaster 确认本次会话。App 加载完成后即可关闭此窗口。",
      "connect.auth.login.eyebrow": "登录",
      "connect.feed.section.history": "历史",
      "connect.feed.section.live": "实时请求",
      "connect.sessionWindow.appView.connectTimeout.soft": "应用连接时间较长，请稍候。",
      "connect.sessionWindow.appView.openApp": "打开应用",
      "connect.sessionWindow.appView.ready": "会话已就绪"
    }
  }
};

const connectPluginDefinition = {
  id: CONNECT_PLUGIN_ID,
  name: "Connect",
  description: "对外连接 V1（显示名 Connect，持久身份 protocol）：identity.get / intent.sign / cipher.encrypt / cipher.decrypt + p2pkh.transfer + feepool.prepare / feepool.commit。",


  // 连接 popup 是锁屏/未初始化时仍需可打开的系统入口；它只依赖
  // Vault + WalletState，在 vault-selection 阶段先注册。真正依赖 active
  // owner 的 Connect App 仍由 connect-apps-ready 阶段装配。

  units: [{
    id: "protocol.window",
    runtime: "window-main",
    connect: { providerMethods: ["connect.login", "connect.logout", "connect.launch"] },
    scopeKind: "storage",
    provides: [CONNECT_SERVICE_CAPABILITY, CONNECT_STORAGE_REPOSITORY_CAPABILITY, CONNECT_COORDINATOR_CONTROL_CAPABILITY, APPLICATION_CONNECTIONS_CAPABILITY, APPLICATION_AI_TOOLS_CAPABILITY],
    storages: [
      CONNECT_STORAGE_DECLARATIONS.files
    ],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "声明存储客户端及用途授权" },
      { capability: CONNECT_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main", reason: "声明本插件的受限 Coordinator 连接" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, reason: "注册 Connect 与应用连接中心" },
      { capability: PAGE_UI_RENDERER_CAPABILITY, reason: "钱包内的跨源应用工作区" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "应用连接管理入口" },
      { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "Connect 自有资源" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "本单元的 setup 或 UI 使用" },
      {
        capability: VAULT_SERVICE_CAPABILITY,
        reason: "connect mode 需要 vault（受控 capability 取 owner runtime）；appView mode 可走 owner runtime bootstrap"
      },
      { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "连接需要 owner key 状态" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "注册 connect 资源" },
      { capability: MSFILE_SERVICE_CAPABILITY, optional: true, reason: "可选 MSFile 方法" },
      { capability: P2PKH_SERVICE_CAPABILITY, optional: true, reason: "可选 P2PKH 方法" },
    ]),
  }],
  i18n: connectResources,
  async setup(ctx: PluginContext) {
    // 取依赖（plugin-vault 必须先装载）。
    const vaultService = ctx.capability(VAULT_SERVICE_CAPABILITY);
    const walletStateService = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
    const coordinatorClient = ctx.capability(CONNECT_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(ctx.consumer, ctx.scope) as ConnectCoordinatorControl | undefined;
    if (!coordinatorClient) throw new Error("Connect Coordinator control is unavailable");
    ctx.provide(CONNECT_COORDINATOR_CONTROL_CAPABILITY, coordinatorClient);
    const connectChannelRuntime = createConnectChannelRuntime(coordinatorClient);
    // MSFile 是可选平台能力：缺失时只让
    // `msfile.*` 三个方法 fail closed（msfile_unavailable），不阻塞连接页。
    let msfileService: import("@keymaster/contracts").MsFileService | undefined;
    try {
      msfileService = ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY);
    } catch {
      msfileService = undefined;
    }

    // Bind the three declared Storage purposes explicitly during setup.
    // Keep optional services as resolvers so replacement instances are observed.
    const getP2pkhService = (): P2pkhProtocolAdapter | undefined => {
      try {
        return ctx.optionalCapability(P2PKH_SERVICE_CAPABILITY);
      } catch {
        return undefined;
      }
    };

    let applicationHost: ApplicationConnectionHost;
    const serviceDeps: import("./connectService.js").ConnectServiceDeps = {
        vault: vaultService,
        walletState: walletStateService,
        runtimeSignal: ctx.scope.signal,
        msfileService,
        getMsfileService: () => {
          try {
            return ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY);
          } catch {
            return undefined;
          }
        },
        getP2pkhService,
        connectChannelRuntime,
        // 根服务只作为钱包内启动器；连接实例的方向由主钱包宿主装配。
        bootMode: "connect",
        focusExistingApplication: input => applicationHost.focusExistingApplication(input),
        getApplicationOpenMode: () => applicationHost.applicationOpenMode(),
        reserveApplicationView: input => ctx.capability(PAGE_UI_RENDERER_CAPABILITY).openApplication(input),
        acceptApplicationLaunch: (payload, source, view) => applicationHost.acceptLaunch(payload, source, view),
        closeApplicationView: source => applicationHost.closeView(source),
      };
    const service = createConnectService(serviceDeps);
      ctx.provide(CONNECT_SERVICE_CAPABILITY, createPublicConnectService(service, () => ctx.scope.assertActive()));
      const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);

      const storageRepository = openConnectStorageRepository({
        durablePolicy: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, CONNECT_STORAGE_PURPOSES.files),
        sessions: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, CONNECT_STORAGE_PURPOSES.files),
        commandHistory: ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, CONNECT_STORAGE_PURPOSES.files)
      });
      ctx.provide(CONNECT_STORAGE_REPOSITORY_CAPABILITY, storageRepository);
      await service.attachConnectStorageRepository(storageRepository);
      applicationHost = new ApplicationConnectionHost(serviceDeps, storageRepository);
      ctx.provide(APPLICATION_CONNECTIONS_CAPABILITY, applicationHost);
      ctx.provide(APPLICATION_AI_TOOLS_CAPABILITY, applicationHost.aiTools);
      await applicationHost.initialize();
      const onApplicationMessage = (event: MessageEvent) => {
        void applicationHost.handleMessage(event).catch(() => console.error("[connect] Application request handling failed"));
      };
      const onApplicationUnload = () => applicationHost.dispose();
      // A BFCache restoration must rebuild a stopped host, not silently revive old connection authority.
      const onApplicationRestore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
      window.addEventListener("message", onApplicationMessage);
      window.addEventListener("pagehide", onApplicationUnload);
      window.addEventListener("pageshow", onApplicationRestore);
      resources.register<ApplicationConnectionsSnapshot, readonly string[]>({
        id: "connect.applications", scope: "global", key: () => ["connect.applications"],
        load: async () => applicationHost.snapshot(),
        subscribe: (_args, _context, invalidate) => applicationHost.subscribe(invalidate), invalidation: "immediate"
      });

      resources.register({ id: "connect.msfile-approvals", scope: "active-key", key: (_args, context) => ["connect.msfile-approvals", context.activePublicKeyHex ?? "none"],
        load: async () => ({ approvals: ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY)?.listPendingApprovals() ?? [] }),
        subscribe: (_args, _context, invalidate) => {
          let current = ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY);
          let off = current?.subscribe(invalidate) ?? (() => {});
          const offConsumer = ctx.consumer.subscribe(() => {
            if (ctx.consumer.status !== "active") return;
            const next = ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY);
            if (next === current) return;
            off(); current = next; off = next?.subscribe(invalidate) ?? (() => {}); invalidate();
          });
          return () => { offConsumer(); off(); };
        }, invalidation: "immediate" });
      const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
      const DisplaySettings = bindConnectUi(ctx, ApplicationDisplaySettings);
      pages.register({ kind: "page", path: "/settings/application-display", id: "connect.application-display", label: { key: "connect.applicationDisplay.title", fallback: "Application settings" }, render: () => createElement(DisplaySettings) });
      ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("protocol", "settings", {
        id: "settings.application-display", label: { key: "connect.applicationDisplay.title", fallback: "Application settings" }, order: 30, icon: "PanelsTopLeft", entry: { path: "/settings/application-display", routeId: "connect.application-display" },
      });
      const Controls = bindConnectUi(ctx, ApplicationConnectionControls);
      pages.register({ kind: "header", slot: "topbar", id: "connect.application-controls", order: 900, label: "应用处理记录", render: () => createElement(Controls) });

      return () => {
        window.removeEventListener("message", onApplicationMessage);
        window.removeEventListener("pagehide", onApplicationUnload);
        window.removeEventListener("pageshow", onApplicationRestore);
        applicationHost.dispose();
        // 幂等 teardown：service 内部状态在 endSession 后清空。
        try {
          service.dispose();
        } catch {
          // ignore
        }
      };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: connectSetup, ...connectPlugin } = connectPluginDefinition;
export { connectSetup, connectPlugin };
