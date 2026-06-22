// packages/plugin-protocol/src/manifest.ts
// 对外协议插件：popup 路由 + service capability + 协议页 i18n。
//
// 设计缘由（施工单 001）：
//   - 本插件是 V1 对外协议的唯一 owner。其它插件不参与协议层。
//   - 入口路由只有一条 `/protocol/v1/popup`；不要为每个方法拆路由。
//   - popup 走独立的 React 组件 `ProtocolPopupPage`，它通过
//     `protocol.service` capability 拿到 service 实例。
//   - 依赖 `vault.service` / `keyspace.service`：协议需要 active key +
//     withPrivateKey；这两个能力由 vault 插件提供。
//   - popup 不出现在 menu.registry；它通过 window.open 由第三方站点触发。
//   - 不注册到 route.registry 普通路由表（RouteRenderer 走普通路由）：
//     apps/web 的 App.tsx 走"path 命中 /protocol/v1/popup → 渲染协议入口"
//     的硬切换特例，跳过 LockedShell / UnlockedShell。

import type {
  I18nPluginResources,
  KeyspaceService,
  PluginContext,
  PluginManifest,
  VaultService
} from "@keymaster/contracts";
import {
  PROTOCOL_SERVICE_CAPABILITY
} from "@keymaster/contracts";
import { ProtocolPopupPage } from "./ProtocolPopupPage.js";
import { createProtocolService } from "./protocolService.js";

export const PROTOCOL_PLUGIN_ID = "protocol";

/** 协议页 i18n 资源。 */
const protocolResources: I18nPluginResources = {
  namespace: "protocol",
  resources: {
    en: {
      "protocol.route.popup": "Protocol",
      "protocol.opener.missing": "This page must be opened by a third-party site via window.open. The opener window is no longer available.",
      "protocol.waiting.title": "Waiting for request",
      "protocol.waiting.desc": "A third-party site should send a request through postMessage. You can close this window if it opened by accident.",
      "protocol.unlock.title": "Unlock to continue",
      "protocol.unlock.desc": "This protocol request requires you to unlock the local Vault. Once unlocked, the request will continue automatically.",
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
      "protocol.done": "Done. You can close this window.",
      "protocol.error": "Request failed",
      "protocol.error.user_rejected": "You rejected the request.",
      "protocol.error.active_key_unavailable": "No active key is available.",
      "protocol.error.invalid_request": "Invalid request.",
      "protocol.error.invalid_origin": "The request origin does not match the declared aud.",
      "protocol.error.decrypt_failed": "Decryption failed.",
      "protocol.error.internal_error": "Internal error."
    },
    "zh-CN": {
      "protocol.route.popup": "协议页",
      "protocol.opener.missing": "该页面必须由第三方站点通过 window.open 打开。opener 窗口已不可用。",
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
      "protocol.done": "已完成。可以关闭此窗口。",
      "protocol.error": "请求失败",
      "protocol.error.user_rejected": "你已取消请求。",
      "protocol.error.active_key_unavailable": "当前没有可用的 active key。",
      "protocol.error.invalid_request": "请求格式不合法。",
      "protocol.error.invalid_origin": "请求来源与声明的 aud 不一致。",
      "protocol.error.decrypt_failed": "解密失败。",
      "protocol.error.internal_error": "内部错误。"
    }
  }
};

export const protocolPlugin: PluginManifest = {
  id: PROTOCOL_PLUGIN_ID,
  name: "Protocol",
  description: "对外协议 V1：identity.get / intent.sign / cipher.encrypt / cipher.decrypt。",
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

    const service = createProtocolService({
      vault: vaultService,
      keyspace: keyspaceService,
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

    return () => {
      // 幂等 teardown：service 内部状态在 endSession 后清空。
      try {
        service.endSession();
      } catch {
        // ignore
      }
    };
  }
};
