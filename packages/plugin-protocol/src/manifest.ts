// packages/plugin-protocol/src/manifest.ts
// 对外协议插件：popup 路由 + service capability + 协议页 i18n +
// 命令流 IndexedDB。
//
// 设计缘由（施工单 002 硬切换 + 2026-06-28 002 + 2026-06-29 001 +
// 2026-06-30 002 + 2026-07-01 001 + 2026-07-01 002）：
//   - 协议页是常驻 popup：单条 request 完成后 popup 不自动关闭；
//     `closing` 由 pageUnloading 路径发出。
//   - 命令流历史走 `keymaster.protocol` IndexedDB：store=commands，
//     索引 origin / updatedAt / [origin, updatedAt]。
//   - service 收到第一条合法 request 时按 `event.origin` 拉历史；
//     切换 origin 时重新载入；DB 失败时 `historyAvailable=false` 降级。
//   - popup 入口路径只有一条 `/protocol/v1/popup`，**不**注册到
//     `route.registry`（与施工单 001 公共语义保持一致）。
//   - 施工单 2026-06-29 001 硬切换：popup 语义统一为 Session Window；
//     `boot=appView` 模式下额外挂一次性 bootstrap listener。
//   - 施工单 2026-06-30 002 硬切换：appView Session Window 改为
//     `owner execution runtime`——签名 / 加解密 / p2pkh / feepool
//     走同一套 `resolveOwnerRuntime` resolver；**不**再 import unlock
//     runtime 交接包。plugin-protocol 的能力依赖描述从"协议需要
//     active key 与 withPrivateKey"改成"connect mode 需要 vault；
//     appView mode 可走 owner runtime bootstrap"。
//   - 施工单 2026-07-01 001 硬切换：彻底移除 `storage.*` / S3 provider
//     配置能力；现行协议族 = identity.* / intent.sign / cipher.* /
//     p2pkh.transfer / feepool.* / connect.*（含 connect.launch）。
//   - 施工单 2026-07-01 002 硬切换：新增 `appmsg.*` 三个 method（origin
//     endpoint）；plugin-protocol 自身**不**持有 HubMsg 连接真值；
//     service 通过 capability `appmsg.core` 反向消费 plugin-appmsg
//     平台单例。

import type {
  AppMsgCore,
  I18nPluginResources,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import { APPMESSAGE_CORE_CAPABILITY, PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import {
  createProtocolService
} from "./protocolService.js";
import { openProtocolStorageDb } from "./protocolStorageDb.js";
import { parseBootMode, parseBootstrapToken } from "./sessionWindowBootstrap.js";

export const PROTOCOL_PLUGIN_ID = "protocol";
const protocolResources: I18nPluginResources = {
  namespace: "protocol",
  resources: {
    en: {
      "protocol.route.popup": "Protocol",
      "protocol.opener.missing":
        "This page must be opened by a third-party site via window.open. The opener window is no longer available.",
      "protocol.topbar.origin": "Current site",
      "protocol.topbar.origin.none": "Not bound",
      "protocol.topbar.status": "Status",
      "protocol.topbar.backToTop": "Back to latest",
      "protocol.topbar.close": "Close",
      "protocol.phase.waiting": "Waiting for next request",
      "protocol.phase.unlocking": "Waiting for unlock",
      "protocol.phase.confirming": "Waiting for confirmation",
      "protocol.phase.executing": "Processing",
      "protocol.phase.closing": "Closing",
      "protocol.phase.error": "Error",
      "protocol.waiting.title": "Waiting for request",
      "protocol.waiting.desc":
        "A third-party site should send a request through postMessage. You can close this window if it opened by accident.",
      "protocol.unlock.title": "Unlock to continue",
      "protocol.unlock.desc":
        "This protocol request requires you to unlock the local Vault. Once unlocked, the request will continue automatically.",
      "protocol.unlock.password": "Password",
      "protocol.unlock.submit": "Unlock",
      "protocol.unlock.cancel": "Cancel",
      "protocol.unlock.err.failed": "Unlock failed",
      "protocol.confirm.title": "Confirm request",
      "protocol.confirm.origin": "Origin",
      "protocol.confirm.method.identity.get": "Share your identity",
      "protocol.confirm.method.intent.sign": "Sign the following content",
      "protocol.confirm.method.cipher.encrypt": "Encrypt the following content",
      "protocol.confirm.method.cipher.decrypt": "Decrypt the following content",
      "protocol.confirm.text": "Message",
      "protocol.confirm.claims": "Requested claims",
      "protocol.confirm.contentType": "Content type",
      "protocol.confirm.window": "Valid until",
      "protocol.confirm.cancel": "Cancel",
      "protocol.confirm.confirm": "Confirm",
      "protocol.executing": "Processing…",
      "protocol.done.title": "Result delivered",
      "protocol.done": "Done. You can close this window.",
      "protocol.error": "Request failed",
      "protocol.error.user_rejected": "You rejected the request.",
      "protocol.error.active_key_unavailable": "No active key is available.",
      "protocol.error.invalid_request": "Invalid request.",
      "protocol.error.invalid_origin": "The request origin does not match the declared aud.",
      "protocol.error.decrypt_failed": "Decryption failed.",
      "protocol.error.internal_error": "Internal error.",
      "protocol.feed.empty":
        "No command history for this site yet. The first request will appear here after it completes.",
      "protocol.feed.empty.waitingOrigin":
        "Waiting for the first request from an external site. Command history will be archived by that site's exact origin.",
      "protocol.feed.historyUnavailable":
        "History unavailable: local database read failed. The current command still works, but it won't be persisted.",
      "protocol.feed.list.aria": "Command flow history",
      "protocol.feed.decision.pending": "Pending",
      "protocol.feed.decision.approved": "Approved",
      "protocol.feed.decision.rejected": "Rejected",
      "protocol.feed.decision.rejected.user_canceled": "You canceled",
      "protocol.feed.decision.rejected.client_canceled": "Canceled by client",
      "protocol.feed.decision.failed": "Failed",
      "protocol.feed.origin": "Origin",
      "protocol.feed.requestId": "Request id",
      "protocol.feed.text": "Message",
      "protocol.feed.claims": "Requested claims",
      "protocol.feed.contentType": "Content type",
      "protocol.feed.activeKey": "Signer public key (legacy)",
      "protocol.feed.ownerKey": "Session owner public key",
      "protocol.feed.connectSessionId": "Connect session id",
      "protocol.feed.error": "Error",
      "protocol.feed.timeline": "Timeline",
      /* ============== 施工单 002 硬切换：新增 i18n key ============== */
      "protocol.topbar.originSettings": "Site settings",
      "protocol.confirm.method.p2pkh.transfer": "Transfer satoshis",
      "protocol.confirm.method.feepool.prepare": "Prepare a fee-pool transaction",
      "protocol.confirm.method.feepool.commit": "Commit a fee-pool transaction",
      "protocol.confirm.p2pkh.recipient": "Recipient address",
      "protocol.confirm.p2pkh.amount": "Amount",
      "protocol.confirm.p2pkh.feeRate": "Fee rate (sat/kB)",
      "protocol.confirm.feepool.action": "Action",
      "protocol.confirm.feepool.counterparty": "Counterparty public key",
      "protocol.confirm.feepool.operationId": "Operation id",
      "protocol.confirm.feepool.amount": "Amount",
      "protocol.confirm.originSettingsBadge.off": "Auto-approve is off for this site",
      "protocol.confirm.originSettingsBadge.on": "Auto-approve is on up to {{max}} sats",
      "protocol.originSettings.title": "Per-origin settings",
      "protocol.originSettings.p2pkhAutoApprove.label": "Auto-approve p2pkh.transfer when amount ≤ max",
      "protocol.originSettings.p2pkhAutoApproveMax.label": "Max satoshis for auto-approve (0 = off)",
      "protocol.originSettings.feepoolAutoSignMax.label": "Max satoshis for fee-pool auto-sign (0 = off)",
      "protocol.originSettings.saving": "Saving…",
      "protocol.originSettings.err.saveFailed": "Failed to save this change",
      "protocol.feed.recipient": "Recipient address",
      "protocol.feed.amount": "Amount",
      "protocol.feed.action": "Action",
      "protocol.feed.operationId": "Operation id",
      "protocol.feed.counterparty": "Counterparty public key",
      "protocol.feed.failureReason": "Local reason",
      "protocol.feed.autoApproved": "Auto-approved",
      "protocol.originSettings.feePoolDefaultFundSatoshis.label":
        "Fee-pool default initial fund (satoshis). 0 = unconfigured.",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "protocol.topbar.wallet": "Open wallet",
      "protocol.originSettings.identityAutoApprove.label": "Always allow identity.get",
      "protocol.originSettings.cipherAutoApprove.label": "Always allow cipher.encrypt / cipher.decrypt",
      /* ============== 施工单 003：confirm 收口到历史卡 + 外部 cancel + 超时 ============== */
      "protocol.originSettings.confirmTimeoutSeconds.label":
        "Confirmation timeout (seconds, default 30)",
      "protocol.originSettings.confirmTimeoutSeconds.help":
        "This timeout only applies to the manual confirmation phase after the wallet is unlocked. Lock-screen waiting does not count down; queued / executing requests are not affected by this timeout.",
      "protocol.feed.status.timed_out": "Timed out",
      "protocol.feed.status.queued": "Confirmed, waiting to execute",
      "protocol.feed.status.executing": "Processing",
      "protocol.feed.status.waiting_unlock_manual": "Waiting for unlock (manual)",
      "protocol.feed.status.waiting_unlock_auto": "Waiting for unlock (auto)",
      "protocol.feed.waitingUnlock.title": "Waiting for unlock",
      "protocol.feed.waitingUnlock.manualDesc":
        "This request needs the wallet to be unlocked. After unlock it will enter the confirmation page.",
      "protocol.feed.waitingUnlock.autoDesc":
        "This request will execute automatically after the wallet is unlocked.",
      "protocol.feed.queued.title": "Confirmed, waiting to execute",
      "protocol.feed.queued.cancel": "Cancel queue",
      "protocol.feed.method": "Method",
      "protocol.sessionError.banner":
        "Cannot reach the external site. Please check the site console for details.",
      "protocol.countdown.remaining": "{{seconds}}s remaining",
      /* ============== 施工单 2026-06-27 001：锁屏页文案 ============== */
      "protocol.lockscreen.title": "Unlock to continue",
      "protocol.lockscreen.desc":
        "Keymaster is locked. The current site has pending requests; they will continue automatically after unlock.",
      "protocol.lockscreen.pendingTotal": "pending",
      "protocol.lockscreen.manual": "Waiting for unlock (manual confirmation)",
      "protocol.lockscreen.auto": "Auto-execute after unlock",
      "protocol.lockscreen.queued": "Confirmed, waiting to execute",
      "protocol.lockscreen.executing": "Executing",
      "protocol.lockscreen.byMethod": "By method",
      "protocol.lockscreen.unlockHint":
        "After unlock, {{total}} pending request(s) will automatically enter the confirmation / execution flow.",
      /* ============== 施工单 2026-06-28 001：connect 视图文案 ============== */
      "protocol.connect.login.title": "Re-authenticate and create a new session",
      "protocol.connect.login.desc":
        "This site is asking for re-authentication. Pick a key and enter your password again. A successful login will create a new connect session and revoke the old one for the same origin.",
      "protocol.connect.login.empty":
        "No ready key is available in this wallet. Please create or import one in Keymaster first.",
      "protocol.connect.login.confirm": "Re-authenticate and create session",
      "protocol.connect.resume.title": "Resume current session",
      "protocol.connect.resume.desc":
        "This site still has a valid session. Enter your password to resume the current session without choosing a key again.",
      "protocol.connect.resume.ownerLabel": "Bound key",
      "protocol.connect.resume.confirm": "Resume current session",
      "protocol.connect.logout.title": "Log out connect session",
      "protocol.connect.logout.desc":
        "This site is asking to log out the current connect session. After this, resume / cipher with the same sessionId will fail; you will need to log in again.",
      "protocol.connect.logout.confirm": "Confirm logout",
      "protocol.connect.cancel": "Cancel",
      "protocol.connect.sessionExpired":
        "This session has expired or its key is no longer available. Please ask the site to log in again.",
      /* ============== 施工单 2026-06-29 001：Session Window / storage ============== */
      "protocol.sessionWindow.title": "Session Window",
      "protocol.sessionWindow.appView.waiting.title": "Waiting for launcher",
      "protocol.sessionWindow.appView.waiting.desc":
        "Keymaster is starting this app. Keep this window open — it will hand off the session to the app and then you can close this tab.",
      "protocol.sessionWindow.appView.signerMissing.title": "Session owner missing",
      "protocol.sessionWindow.appView.signerMissing.desc":
        "The app session owner is no longer available. Please reopen the app from the Keymaster app store.",
      "protocol.sessionWindow.appView.signerMismatch.title": "Could not start the app",
      "protocol.sessionWindow.appView.signerMismatch.desc":
        "The app session owner does not match this session. Please reopen the app from the Keymaster app store.",
      "protocol.sessionWindow.appView.failed.title": "Could not start the app",
      "protocol.sessionWindow.appView.failed.desc":
        "Launcher failed to hand off the session. Please try starting the app again from the Keymaster app store.",
      "protocol.sessionWindow.appView.openingClientApp": "Opening the app…",
      "protocol.connect.launch.title": "App sign-in",
      "protocol.connect.launch.desc":
        "The app is asking Keymaster to confirm this session. You can close this window after the app loads."
    },
    "zh-CN": {
      "protocol.route.popup": "协议页",
      "protocol.opener.missing": "该页面必须由第三方站点通过 window.open 打开。opener 窗口已不可用。",
      "protocol.topbar.origin": "当前站点",
      "protocol.topbar.origin.none": "未绑定",
      "protocol.topbar.status": "状态",
      "protocol.topbar.backToTop": "回到最新",
      "protocol.topbar.close": "关闭",
      "protocol.phase.waiting": "等待下一条请求",
      "protocol.phase.unlocking": "等待解锁",
      "protocol.phase.confirming": "等待确认",
      "protocol.phase.executing": "处理中",
      "protocol.phase.closing": "收尾",
      "protocol.phase.error": "错误",
      "protocol.waiting.title": "等待请求",
      "protocol.waiting.desc": "第三方站点应当通过 postMessage 发送请求。如果是误打开的，可以直接关闭。",
      "protocol.unlock.title": "解锁后继续",
      "protocol.unlock.desc": "此协议请求需要先解锁本地 Vault。解锁成功后请求会自动继续。",
      "protocol.unlock.password": "密码",
      "protocol.unlock.submit": "解锁",
      "protocol.unlock.cancel": "取消",
      "protocol.unlock.err.failed": "解锁失败",
      "protocol.confirm.title": "确认请求",
      "protocol.confirm.origin": "来源站点",
      "protocol.confirm.method.identity.get": "分享你的身份",
      "protocol.confirm.method.intent.sign": "签名以下内容",
      "protocol.confirm.method.cipher.encrypt": "加密以下内容",
      "protocol.confirm.method.cipher.decrypt": "解密以下内容",
      "protocol.confirm.text": "提示文案",
      "protocol.confirm.claims": "请求的 claims",
      "protocol.confirm.contentType": "内容类型",
      "protocol.confirm.window": "有效期",
      "protocol.confirm.cancel": "取消",
      "protocol.confirm.confirm": "确认",
      "protocol.executing": "处理中…",
      "protocol.done.title": "结果已回传",
      "protocol.done": "已完成。可以关闭此窗口。",
      "protocol.error": "请求失败",
      "protocol.error.user_rejected": "你已取消请求。",
      "protocol.error.active_key_unavailable": "当前没有可用的 active key。",
      "protocol.error.invalid_request": "请求格式不合法。",
      "protocol.error.invalid_origin": "请求来源与声明的 aud 不一致。",
      "protocol.error.decrypt_failed": "解密失败。",
      "protocol.error.internal_error": "内部错误。",
      "protocol.feed.empty": "当前站点尚无命令历史。第一条请求完成后会出现在这里。",
      "protocol.feed.empty.waitingOrigin": "等待来自外部站点的第一条请求。命令历史会按该站点的 origin 归档。",
      "protocol.feed.historyUnavailable": "历史不可用：本地数据库读取失败。当前命令仍可正常执行，但不会持久化。",
      "protocol.feed.list.aria": "命令流历史",
      "protocol.feed.decision.pending": "等待",
      "protocol.feed.decision.approved": "已批准",
      "protocol.feed.decision.rejected": "已拒绝",
      "protocol.feed.decision.rejected.user_canceled": "你已取消",
      "protocol.feed.decision.rejected.client_canceled": "对方主动取消",
      "protocol.feed.decision.failed": "执行失败",
      "protocol.feed.origin": "来源站点",
      "protocol.feed.requestId": "请求 id",
      "protocol.feed.text": "提示文案",
      "protocol.feed.claims": "请求的 claims",
      "protocol.feed.contentType": "内容类型",
      "protocol.feed.activeKey": "签名公钥（兼容）",
      "protocol.feed.ownerKey": "会话 owner 公钥",
      "protocol.feed.connectSessionId": "connect session id",
      "protocol.feed.error": "错误",
      "protocol.feed.timeline": "时间",
      /* ============== 施工单 002 硬切换：新增 i18n key ============== */
      "protocol.topbar.originSettings": "站点配置",
      "protocol.confirm.method.p2pkh.transfer": "转账 satoshis",
      "protocol.confirm.method.feepool.prepare": "准备一笔费用池交易",
      "protocol.confirm.method.feepool.commit": "提交一笔费用池交易",
      "protocol.confirm.p2pkh.recipient": "收款地址",
      "protocol.confirm.p2pkh.amount": "金额",
      "protocol.confirm.p2pkh.feeRate": "费率 (sat/kB)",
      "protocol.confirm.feepool.action": "动作",
      "protocol.confirm.feepool.counterparty": "对端公钥",
      "protocol.confirm.feepool.operationId": "操作 id",
      "protocol.confirm.feepool.amount": "金额",
      "protocol.confirm.originSettingsBadge.off": "该站点自动确认未开启",
      "protocol.confirm.originSettingsBadge.on": "自动确认已开启，上限 {{max}} sat",
      "protocol.originSettings.title": "站点级配置",
      "protocol.originSettings.p2pkhAutoApprove.label": "p2pkh.transfer 自动确认（金额 ≤ 上限）",
      "protocol.originSettings.p2pkhAutoApproveMax.label": "自动确认上限（0 = 关闭）",
      "protocol.originSettings.feepoolAutoSignMax.label": "费用池自动签名上限（0 = 关闭）",
      "protocol.originSettings.saving": "保存中…",
      "protocol.originSettings.err.saveFailed": "本次修改未生效",
      "protocol.feed.recipient": "收款地址",
      "protocol.feed.amount": "金额",
      "protocol.feed.action": "动作",
      "protocol.feed.operationId": "操作 id",
      "protocol.feed.counterparty": "对端公钥",
      "protocol.feed.failureReason": "本地原因",
      "protocol.feed.autoApproved": "已自动通过",
      "protocol.originSettings.feePoolDefaultFundSatoshis.label":
        "费用池缺省初始金额（satoshis）。0 = 未配置。",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "protocol.topbar.wallet": "进入钱包",
      "protocol.originSettings.identityAutoApprove.label": "始终同意 账户信息获取",
      "protocol.originSettings.cipherAutoApprove.label": "始终同意 加密解密",
      /* ============== 施工单 003：confirm 收口到历史卡 + 外部 cancel + 超时 ============== */
      "protocol.originSettings.confirmTimeoutSeconds.label":
        "确认超时（秒，默认 30）",
      "protocol.originSettings.confirmTimeoutSeconds.help":
        "该超时只作用于解锁后的人工确认阶段。锁屏等待阶段不计时；queued / executing 也不会被这个超时命中。",
      "protocol.feed.status.timed_out": "超时",
      "protocol.feed.status.queued": "已确认，等待执行",
      "protocol.feed.status.executing": "处理中",
      "protocol.feed.status.waiting_unlock_manual": "等待解锁（人工）",
      "protocol.feed.status.waiting_unlock_auto": "等待解锁（自动）",
      "protocol.feed.waitingUnlock.title": "等待解锁",
      "protocol.feed.waitingUnlock.manualDesc":
        "此请求需要解锁钱包。解锁后会进入确认页。",
      "protocol.feed.waitingUnlock.autoDesc":
        "此请求会在解锁后自动执行。",
      "protocol.feed.queued.title": "已确认，等待执行",
      "protocol.feed.queued.cancel": "取消排队",
      "protocol.feed.method": "方法",
      "protocol.sessionError.banner":
        "无法连接到外部站点。请回到来源站点查看控制台日志。",
      "protocol.countdown.remaining": "剩余 {{seconds}} 秒",
      /* ============== 施工单 2026-06-27 001：锁屏页文案 ============== */
      "protocol.lockscreen.title": "解锁后继续",
      "protocol.lockscreen.desc":
        "Keymaster 当前处于锁定状态。当前站点已有请求；解锁后会自动继续处理。",
      "protocol.lockscreen.pendingTotal": "条待处理",
      "protocol.lockscreen.manual": "待解锁后人工确认",
      "protocol.lockscreen.auto": "解锁后自动执行",
      "protocol.lockscreen.queued": "已确认待执行",
      "protocol.lockscreen.executing": "执行中",
      "protocol.lockscreen.byMethod": "按 method 聚合",
      "protocol.lockscreen.unlockHint":
        "解锁后，{{total}} 条待处理请求会自动进入确认 / 执行流程。",
      /* ============== 施工单 2026-06-28 001：connect 视图文案 ============== */
      "protocol.connect.login.title": "重新认证并建立新会话",
      "protocol.connect.login.desc":
        "该站点请求重新认证。请选择一把 key，并再次输入密码。成功后会创建新的 connect session，并吊销同 origin 的旧 session。",
      "protocol.connect.login.empty":
        "当前钱包没有 ready 的 key。请先回到 Keymaster 创建或导入一把 key。",
      "protocol.connect.login.confirm": "重新认证并建立会话",
      "protocol.connect.resume.title": "恢复当前会话",
      "protocol.connect.resume.desc":
        "该站点的 session 仍然有效。输入密码后即可恢复当前会话，不会重新选择 key。",
      "protocol.connect.resume.ownerLabel": "绑定 key",
      "protocol.connect.resume.confirm": "恢复当前会话",
      "protocol.connect.logout.title": "注销 connect 会话",
      "protocol.connect.logout.desc":
        "该站点请求注销本次 connect 会话。注销后该 sessionId 的 resume / cipher 将全部失败，需要重新 login。",
      "protocol.connect.logout.confirm": "确认注销",
      "protocol.connect.cancel": "取消",
      "protocol.connect.sessionExpired":
        "该会话已失效或绑定 key 不可用。请回到站点重新登录。",
      /* ============== 施工单 2026-06-29 001：Session Window / storage ============== */
      "protocol.sessionWindow.title": "Session Window",
      "protocol.sessionWindow.appView.waiting.title": "等待 launcher 启动",
      "protocol.sessionWindow.appView.waiting.desc":
        "Keymaster 正在启动此 app。请保持本窗口打开 — 它会把会话交给 app，然后你可以关闭此标签页。",
      "protocol.sessionWindow.appView.signerMissing.title": "session owner 已失效",
      "protocol.sessionWindow.appView.signerMissing.desc":
        "app 的 session owner 不可用，请回到 Keymaster 应用商店重新启动该 app。",
      "protocol.sessionWindow.appView.signerMismatch.title": "无法启动 app",
      "protocol.sessionWindow.appView.signerMismatch.desc":
        "app 的 session owner 与本次会话不匹配，请回到 Keymaster 应用商店重新启动该 app。",
      "protocol.sessionWindow.appView.failed.title": "无法启动 app",
      "protocol.sessionWindow.appView.failed.desc":
        "Launcher 未成功完成会话交接。请回到 Keymaster 应用商店重新启动该 app。",
      "protocol.sessionWindow.appView.openingClientApp": "正在打开 app…",
      "protocol.connect.launch.title": "App 登录",
      "protocol.connect.launch.desc":
        "App 正在请求 Keymaster 确认本次会话。App 加载完成后即可关闭此窗口。"
    }
  }
};

export const protocolPlugin: PluginManifest = {
  id: PROTOCOL_PLUGIN_ID,
  name: "Protocol",
  description: "对外协议 V1：identity.get / intent.sign / cipher.encrypt / cipher.decrypt + p2pkh.transfer + feepool.prepare / feepool.commit。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [PROTOCOL_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  i18n: protocolResources,
  dependencies: [
    {
      capability: "vault.service",
      reason: "connect mode 需要 vault（withPrivateKey 借 owner 私钥）；appView mode 可走 owner runtime bootstrap"
    },
    { capability: "keyspace.service", reason: "协议需要 owner key 状态" }
  ],
  setup(ctx: PluginContext) {
    // 取依赖（plugin-vault 必须先装载）。
    const vaultService = ctx.get<VaultService>("vault.service");
    const keyspaceService = ctx.get<KeyspaceService>("keyspace.service");

    // 命令流 IndexedDB：best-effort 打开；失败时 service 走"historyAvailable=false"
    // 降级，主协议流程不受影响（p2pkh 仍可用 manual confirm；feepool fail-closed）。
    // `setup` 允许返回 Promise；这里 await 让 service 在拿到 DB 引用后才被构造，
    // 避免 late-binding 复杂度。
    return (async () => {
      let storageDb: Awaited<ReturnType<typeof openProtocolStorageDb>> | undefined;
      try {
        storageDb = await openProtocolStorageDb();
      } catch (err) {
        ctx.logger.error({
          scope: "protocol.lifecycle",
          event: "storageDb.open.failed",
          message: "storageDb failed to open",
          data: { err: err instanceof Error ? err.message : String(err) }
        });
      }

      // p2pkh service 是 optional 能力：**不**放进 manifest.dependencies，
      // 否则 host.enable() 会在 protocolPlugin 早于 plugin-p2pkh 装载时直接
      // 把本插件打成 blocked，导致 `protocol.service` capability 根本
      // 不会 provide。这里保留运行时 best-effort 获取；缺时对应方法走
      // internal_error / fail-closed。
      //
      // 边界检查禁止 plugin-protocol 直接 import plugin-p2pkh；这里通过
      // capability key 拿值，类型断言为最小适配接口。
      //
      // 硬切换 002：listUtxos / prepareTransfer / submitTransfer 全部
      // 接受 `ownerPublicKeyHex`（session 绑定 owner）。plugin-protocol
      // 在 `executeP2pkhTransferAndFinalize` / `buildAndMaybeBuildBaseTx`
      // 内从 session 取 owner 后传入。plugin-p2pkh 内部按 owner 解析
      // keyId 走选币 + 签名，**不**走全局 active key。
      let p2pkhService:
        | {
            listUtxos(filter?: {
              assetId?: string;
              ownerPublicKeyHex?: string;
            }): Promise<Array<{ txid: string; vout: number; value: number }>>;
            prepareTransfer(input: {
              assetId: "bsv";
              ownerPublicKeyHex: string;
              recipientAddress: string;
              amountSatoshis: number;
              feeRateSatoshisPerKb: number;
            }): Promise<unknown>;
            submitTransfer(preview: {
              assetId: "bsv";
              network: "main";
              ownerPublicKeyHex?: string;
              keyId?: string;
              recipientAddress: string;
              amountSatoshis: number;
              feeRateSatoshisPerKb: number;
              allocation: unknown;
              changeAddress: string;
              outputs: Array<{ address: string; value: number }>;
              estimatedFeeSatoshis: number;
              serializedSizeBytes: number;
              txid: string;
              rawTxHex: string;
            }): Promise<unknown>;
          }
        | undefined;
      try {
        p2pkhService = ctx.get<typeof p2pkhService extends infer T ? T : never>(
          "p2pkh.service"
        );
      } catch {
        // 缺 p2pkh.service capability 时不阻塞 setup；service 内部
        // 在 p2pkh.transfer 路径上走 internal_error 降级。
        p2pkhService = undefined;
      }

      // 施工单 2026-07-01 002 硬切换：protocolService 通过 capability 总线
      // 反向消费 `appmsg.core`（plugin-appmsg 平台单例）。缺时 `appmsg.*`
      // 三个 method 走 internal_error 降级（与 p2pkhService 缺时同语义）。
      let appMsgCore: AppMsgCore | undefined;
      try {
        appMsgCore = ctx.get<AppMsgCore>(APPMESSAGE_CORE_CAPABILITY);
      } catch {
        appMsgCore = undefined;
      }

      const service = createProtocolService({
        vault: vaultService,
        keyspace: keyspaceService,
        storageDb,
        p2pkhService: p2pkhService as never,
        appMsgCore,
        // 施工单 2026-06-29 001：从 URL `?boot=appView` 解析当前模式。
        // 仅在 popup 挂载时解析一次；session 启动后不再变动。
        bootMode: typeof window !== "undefined" ? parseBootMode(window.location.search) : "connect",
        logger: {
          info: (input) =>
            ctx.logger.info({
              scope: "protocol.lifecycle",
              event: "info",
              message: "",
              data: input as Record<string, unknown>
            }),
          warn: (input) =>
            ctx.logger.warn({
              scope: "protocol.lifecycle",
              event: "warn",
              message: "",
              data: input as Record<string, unknown>
            }),
          error: (input) =>
            ctx.logger.error({
              scope: "protocol.lifecycle",
              event: "error",
              message: "",
              data: input as Record<string, unknown>
            })
        }
      });
      ctx.provide(PROTOCOL_SERVICE_CAPABILITY, service);

      // 注意：协议页**不**注册到 `route.registry`。
      // 设计缘由：施工单 001 收口反馈——页面"单一 owner"意味着入口路径
      // 也只有一条。`apps/web/src/App.tsx` 已经把
      // `/protocol/v1/popup` 作为顶层特例在 LockedShell / UnlockedShell
      // **之前**直接渲染 `ProtocolPopupPage`；若再在 route.registry 里
      // 注册，会让 RouteRenderer 多一条可匹配路径，破坏"路径 → 组件"
      // 的单映射。其它路径仍走 `RouteRenderer`，与协议路径互不干扰。
      //
      // 施工单 002 收尾反馈：`/settings/protocol` 这一**系统级**设置页
      // 已被删除；fee pool 默认 fund 收回到 per-origin
      // `ProtocolOriginSettingsRecord.feePoolDefaultFundSatoshis`，
      // 通过 popup 顶栏"站点配置"按钮内联配置。

      return () => {
        // 幂等 teardown：service 内部状态在 endSession 后清空。
        try {
          service.endSession();
        } catch {
          // ignore
        }
      };
    })();
  }
};
