// packages/plugin-protocol/src/manifest.ts
// 对外协议插件：popup 路由 + service capability + 协议页 i18n +
// 命令流 IndexedDB。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流）：
//   - 协议页是常驻 popup：单条 request 完成后 popup 不自动关闭；
//     `closing` 由 pageUnloading 路径发出。
//   - 命令流历史走 `keymaster.protocol` IndexedDB：store=commands，
//     索引 origin / updatedAt / [origin, updatedAt]。
//   - service 收到第一条合法 request 时按 `event.origin` 拉历史；
//     切换 origin 时重新载入；DB 失败时 `historyAvailable=false` 降级。
//   - popup 入口路径只有一条 `/protocol/v1/popup`，**不**注册到
//     `route.registry`（与施工单 001 公共语义保持一致）。

import type {
  I18nPluginResources,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import {
  createProtocolService
} from "./protocolService.js";
import { openProtocolStorageDb } from "./protocolStorageDb.js";

export const PROTOCOL_PLUGIN_ID = "protocol";

/** 协议页 i18n 资源。 */
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
      "protocol.feed.decision.failed": "Failed",
      "protocol.feed.origin": "Origin",
      "protocol.feed.requestId": "Request id",
      "protocol.feed.text": "Message",
      "protocol.feed.claims": "Requested claims",
      "protocol.feed.contentType": "Content type",
      "protocol.feed.activeKey": "Signer public key",
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
      "protocol.originSettings.save": "Save",
      "protocol.originSettings.saved": "Saved",
      "protocol.originSettings.err.saveFailed": "Failed to save settings",
      "protocol.feed.recipient": "Recipient address",
      "protocol.feed.amount": "Amount",
      "protocol.feed.action": "Action",
      "protocol.feed.operationId": "Operation id",
      "protocol.feed.counterparty": "Counterparty public key",
      "protocol.feed.failureReason": "Local failure reason",
      "protocol.feed.autoApproved": "Auto-approved",
      "protocol.originSettings.feePoolDefaultFundSatoshis.label":
        "Fee-pool default initial fund (satoshis). 0 = unconfigured.",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "protocol.topbar.wallet": "Open wallet",
      "protocol.originSettings.identityAutoApprove.label": "Always allow identity.get",
      "protocol.originSettings.cipherAutoApprove.label": "Always allow cipher.encrypt / cipher.decrypt"
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
      "protocol.feed.decision.failed": "执行失败",
      "protocol.feed.origin": "来源站点",
      "protocol.feed.requestId": "请求 id",
      "protocol.feed.text": "提示文案",
      "protocol.feed.claims": "请求的 claims",
      "protocol.feed.contentType": "内容类型",
      "protocol.feed.activeKey": "签名公钥",
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
      "protocol.originSettings.save": "保存",
      "protocol.originSettings.saved": "已保存",
      "protocol.originSettings.err.saveFailed": "保存失败",
      "protocol.feed.recipient": "收款地址",
      "protocol.feed.amount": "金额",
      "protocol.feed.action": "动作",
      "protocol.feed.operationId": "操作 id",
      "protocol.feed.counterparty": "对端公钥",
      "protocol.feed.failureReason": "本地失败原因",
      "protocol.feed.autoApproved": "已自动通过",
      "protocol.originSettings.feePoolDefaultFundSatoshis.label":
        "费用池缺省初始金额（satoshis）。0 = 未配置。",
      /* ============== 施工单 001：钱包入口 + identity / cipher auto-approve ============== */
      "protocol.topbar.wallet": "进入钱包",
      "protocol.originSettings.identityAutoApprove.label": "始终同意 账户信息获取",
      "protocol.originSettings.cipherAutoApprove.label": "始终同意 加密解密"
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
    { capability: "vault.service", reason: "协议需要 active key 与 withPrivateKey" },
    { capability: "keyspace.service", reason: "协议需要 active key 状态" }
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
      let p2pkhService:
        | {
            listUtxos(filter?: { assetId?: string }): Promise<
              Array<{ txid: string; vout: number; value: number }>
            >;
            prepareTransfer(input: {
              assetId: "bsv";
              recipientAddress: string;
              amountSatoshis: number;
              feeRateSatoshisPerKb: number;
            }): Promise<unknown>;
            submitTransfer(preview: unknown): Promise<unknown>;
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

      const service = createProtocolService({
        vault: vaultService,
        keyspace: keyspaceService,
        storageDb,
        p2pkhService: p2pkhService as never,
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
