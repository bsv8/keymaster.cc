// packages/plugin-webrtc/src/manifest.ts
// WebRTC 业务插件 manifest（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - plugin-webrtc 是极薄业务插件，只通过 Coordinator Channel 私信收发信令；
//   - STUN 设置作为模块挂到「设置 → 广播网关」；
//   - 模块注册走 `system-status.registry` 单一真值。
//   - i18n namespace：`webrtc`。

import type {
  ContactsService,
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
} from "@keymaster/contracts";
import {
  BREADCRUMB_REGISTRY_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  CONTACTS_COORDINATOR_CONTROL_CAPABILITY,
  CONTACTS_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  NOTICE_REGISTRY_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  SYSTEM_STATUS_REGISTRY_CAPABILITY,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import {
  WEBRTC_PLUGIN_ID,
  WEBRTC_SERVICE_CAPABILITY,
  WEBRTC_SETTINGS_PATH
} from "./constants.js";
import { WebrtcSettingsPage } from "./WebrtcSettingsPage.js";
import type { WebrtcService, WebrtcSessionSnapshot } from "./webrtcService.js";
import type { WebrtcHistoryItem } from "./webrtcHistoryService.js";
import {
  createFileWebrtcConfigStore
} from "./storage/p2pSettingFileRepository.js";
import { createWebrtcHistoryService } from "./webrtcHistoryService.js";
import { createWebrtcService } from "./webrtcService.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

const webrtcResources: I18nPluginResources = {
  namespace: "webrtc",
  resources: {
    en: {
      "webrtc.menu": "WebRTC",
      "webrtc.breadcrumb.workbench": "WebRTC",
      "webrtc.breadcrumb.settings": "WebRTC",
      "webrtc.page.workbench.title": "WebRTC",
      "webrtc.page.workbench.desc":
        "Audio/video calls and file transfer over ChannelProtocol (Hash rendezvous + webrtc-signal). Only online contacts can be dialed.",
      "webrtc.page.workbench.target.label": "Recipient publicKeyHex",
      "webrtc.page.workbench.target.placeholder":
        "02... (66 hex chars)",
      "webrtc.page.workbench.target.mode.audio": "Audio chat",
      "webrtc.page.workbench.target.mode.video": "Video chat",
      "webrtc.page.workbench.block.service_not_ready":
        "webrtc service not ready (vault locked or no active key)",
      "webrtc.page.workbench.block.invalid_target":
        "recipient publicKeyHex must be 66 hex chars",
      "webrtc.page.workbench.block.target_offline":
        "peer is offline (only online contacts can use WebRTC)",
      "webrtc.page.workbench.block.target_unknown":
        "peer presence unknown (wait for contact probe, only online contacts can use WebRTC)",
      "webrtc.page.workbench.block.call_protocol_unavailable":
        "audio/video calls are unavailable until the call rendezvous protocol is published",
      "webrtc.page.workbench.call_protocol_unavailable":
        "Audio/video calls are temporarily unavailable until the call rendezvous protocol is published.",
      "webrtc.page.workbench.block.busy_local":
        "there is already an active session",
      "webrtc.page.workbench.block.device_unavailable":
        "local device unavailable",
      "webrtc.page.workbench.block.send_invite_failed":
        "failed to send invite",
      "webrtc.page.workbench.block.create_offer_failed":
        "failed to create offer",
      "webrtc.page.workbench.block.invalid_state":
        "invalid session state",
      "webrtc.page.workbench.block.transfer_too_large":
        "attachment is larger than 16 MiB",
      "webrtc.page.workbench.block.transfer_timeout":
        "transfer timed out",
      "webrtc.page.workbench.block.transfer_connection_failed":
        "transfer connection failed",
      "webrtc.page.workbench.block.transfer_protocol_unavailable":
        "attachment transfer protocol is unavailable",
      "webrtc.page.workbench.direction.outgoing": "outgoing",
      "webrtc.page.workbench.direction.incoming": "incoming",
      "webrtc.page.workbench.phase.idle": "idle",
      "webrtc.page.workbench.phase.inviting": "inviting",
      "webrtc.page.workbench.phase.incoming": "incoming",
      "webrtc.page.workbench.phase.connecting": "connecting",
      "webrtc.page.workbench.phase.connected": "connected",
      "webrtc.page.workbench.phase.ended": "ended",
      "webrtc.page.workbench.actions.accept": "Accept",
      "webrtc.page.workbench.actions.reject": "Decline",
      "webrtc.page.workbench.actions.hangup": "Hang up",
      "webrtc.page.workbench.notice.fallback_suggested":
        "peer has no video capability; you can fall back to audio chat",
      "webrtc.page.workbench.notice.rejected": "peer rejected the call",
      "webrtc.page.workbench.notice.busy": "peer is busy",
      "webrtc.page.workbench.notice.dismiss": "dismiss",
      "webrtc.notice.incoming.title": "Incoming call",
      "webrtc.notice.incoming.body": "A peer is calling you",
      "webrtc.notice.accept": "Accept",
      "webrtc.notice.reject": "Decline",
      "webrtc.notice.transfer.title": "Incoming file transfer",
      "webrtc.notice.transfer.body": "A contact wants to send you a file",
      "webrtc.notice.transfer.accept": "Accept transfer",
      "webrtc.notice.transfer.reject": "Reject transfer",
      "webrtc.page.settings.title": "WebRTC settings",
      "webrtc.page.settings.desc":
        "Configure STUN servers. STUN-only; no TURN. Changes auto-save on blur.",
      "webrtc.page.settings.field.stun.label": "STUN servers",
      "webrtc.page.settings.field.stun.add": "Add",
      "webrtc.page.settings.field.stun.remove": "Remove",
      "webrtc.page.settings.stun.add": "Add STUN server",
      "webrtc.page.settings.stun.description": "Enter a STUN server URL and test it before saving.",
      "webrtc.page.settings.stun.url": "STUN server URL",
      "webrtc.page.settings.stun.duplicate": "This STUN server is already in the list.",
      "webrtc.page.settings.stun.save": "Save STUN server",
      "webrtc.page.settings.field.stun.placeholder": "stun:host:port",
      "webrtc.page.settings.actions.test": "Test STUN server",
      "webrtc.page.settings.actions.test.running": "Testing…",
      "webrtc.page.settings.actions.testAll": "Test all STUN",
      "webrtc.page.settings.actions.testAll.running": "Testing…",
      "webrtc.page.settings.actions.testAll.done": "Done",
      "webrtc.page.settings.diag.ok": "ok",
      "webrtc.page.settings.diag.timeout": "timeout",
      "webrtc.page.settings.diag.error": "error",
      "webrtc.page.settings.diag.note":
        "this only verifies STUN availability locally; it does not guarantee an audio/video path between arbitrary peers",
      "webrtc.page.settings.invalid": "Invalid STUN server configuration"
    },
    "zh-CN": {
      "webrtc.menu": "WebRTC",
      "webrtc.breadcrumb.workbench": "WebRTC",
      "webrtc.breadcrumb.settings": "WebRTC",
      "webrtc.page.workbench.title": "WebRTC",
      "webrtc.page.workbench.desc":
        "基于 ChannelProtocol 的音视频通话与文件传输（Hash 会合 + webrtc-signal）。仅在线联系人可拨号。",
      "webrtc.page.workbench.target.label": "对方 publicKeyHex",
      "webrtc.page.workbench.target.placeholder": "02...（66 个 hex）",
      "webrtc.page.workbench.target.mode.audio": "音频聊天",
      "webrtc.page.workbench.target.mode.video": "视频聊天",
      "webrtc.page.workbench.block.service_not_ready":
        "webrtc service 未就绪（vault 未解锁或没有 active key）",
      "webrtc.page.workbench.block.invalid_target":
        "对方 publicKeyHex 必须为 66 个 hex 字符",
      "webrtc.page.workbench.block.target_offline":
        "对方离线（仅在线联系人可使用 WebRTC）",
      "webrtc.page.workbench.block.target_unknown":
        "对方在线状态未知（等待通讯录探测，仅在线联系人可使用 WebRTC）",
      "webrtc.page.workbench.block.call_protocol_unavailable":
        "正式呼叫会合协议发布前，暂不支持音视频呼叫",
      "webrtc.page.workbench.call_protocol_unavailable":
        "正式呼叫会合协议发布前，暂不支持音视频呼叫",
      "webrtc.page.workbench.block.busy_local": "当前已有活动会话",
      "webrtc.page.workbench.block.device_unavailable": "本地设备不可用",
      "webrtc.page.workbench.block.send_invite_failed": "发送邀请失败",
      "webrtc.page.workbench.block.create_offer_failed": "创建 offer 失败",
      "webrtc.page.workbench.block.invalid_state": "会话状态非法",
      "webrtc.page.workbench.block.transfer_too_large": "附件超过 16 MiB",
      "webrtc.page.workbench.block.transfer_timeout": "传输超时",
      "webrtc.page.workbench.block.transfer_connection_failed": "传输连接失败",
      "webrtc.page.workbench.block.transfer_protocol_unavailable": "附件传输协议不可用",
      "webrtc.page.workbench.direction.outgoing": "呼出",
      "webrtc.page.workbench.direction.incoming": "来电",
      "webrtc.page.workbench.phase.idle": "空闲",
      "webrtc.page.workbench.phase.inviting": "拨号中",
      "webrtc.page.workbench.phase.incoming": "来电",
      "webrtc.page.workbench.phase.connecting": "连接中",
      "webrtc.page.workbench.phase.connected": "已接通",
      "webrtc.page.workbench.phase.ended": "已结束",
      "webrtc.page.workbench.actions.accept": "接听",
      "webrtc.page.workbench.actions.reject": "拒接",
      "webrtc.page.workbench.actions.hangup": "挂断",
      "webrtc.page.workbench.notice.fallback_suggested":
        "对方没有视频能力，可以改用音频聊天",
      "webrtc.page.workbench.notice.rejected": "对方拒绝了通话",
      "webrtc.page.workbench.notice.busy": "对方忙",
      "webrtc.page.workbench.notice.dismiss": "知道了",
      "webrtc.notice.incoming.title": "来电",
      "webrtc.notice.incoming.body": "有对端正在呼叫你",
      "webrtc.notice.accept": "接听",
      "webrtc.notice.reject": "拒接",
      "webrtc.notice.transfer.title": "收到文件传输请求",
      "webrtc.notice.transfer.body": "通讯录联系人请求向你发送文件",
      "webrtc.notice.transfer.accept": "接受传输",
      "webrtc.notice.transfer.reject": "拒绝传输",
      "webrtc.page.settings.title": "WebRTC 设置",
      "webrtc.page.settings.desc":
        "配置 STUN 服务器列表。仅 STUN，不含 TURN。字段失焦后自动保存。",
      "webrtc.page.settings.field.stun.label": "STUN 服务器",
      "webrtc.page.settings.field.stun.add": "新增",
      "webrtc.page.settings.field.stun.remove": "删除",
      "webrtc.page.settings.stun.add": "新增 STUN 服务器",
      "webrtc.page.settings.stun.description": "输入 STUN 服务器地址，测试成功后才能保存。",
      "webrtc.page.settings.stun.url": "STUN 服务器地址",
      "webrtc.page.settings.stun.duplicate": "该 STUN 服务器已在列表中。",
      "webrtc.page.settings.stun.save": "保存 STUN 服务器",
      "webrtc.page.settings.field.stun.placeholder": "stun:host:port",
      "webrtc.page.settings.actions.test": "测试 STUN 服务器",
      "webrtc.page.settings.actions.test.running": "测试中…",
      "webrtc.page.settings.actions.testAll": "测试全部 STUN",
      "webrtc.page.settings.actions.testAll.running": "测试中…",
      "webrtc.page.settings.actions.testAll.done": "完成",
      "webrtc.page.settings.diag.ok": "可用",
      "webrtc.page.settings.diag.timeout": "超时",
      "webrtc.page.settings.diag.error": "错误",
      "webrtc.page.settings.diag.note":
        "此测试只在本地验证 STUN 可用性，不保证任意两端一定能建立音视频通话",
      "webrtc.page.settings.invalid": "STUN 服务器配置无效"
    }
  }
};

/**
 * WebRTC 业务插件 manifest。
 */
const webrtcPluginDefinition = {
  id: WEBRTC_PLUGIN_ID,
  name: "WebRTC",
  description:
    "Keymaster WebRTC business plugin: audio/video calls and file transfer over ChannelProtocol (Hash rendezvous + webrtc-signal + APP control), gated by contacts presence.",
  kind: "business",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "business",
  units: [{
    id: "webrtc.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [WEBRTC_SERVICE_CAPABILITY],
    storages: [CENTRAL_STORAGE_DECLARATIONS.p2pFiles, CENTRAL_STORAGE_DECLARATIONS.webrtcHistory],
    dependencies: defineRuntimeUnitDependencies([
      { capability: CHANNEL_RUNTIME_CAPABILITY, reason: "通过 Coordinator 使用 Channel 私信" },
      { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "打开 key-scoped 历史库" },
      { capability: CONTACTS_SERVICE_CAPABILITY, reason: "只允许当前 owner 通讯录中的发送者进入确认" },
      { capability: CONTACTS_COORDINATOR_CONTROL_CAPABILITY, reason: "读取 Coordinator 通讯录在线快照做拨号门禁", optional: true },
      { capability: NOTICE_REGISTRY_CAPABILITY, reason: "投递全局紧急 notice" },
      { capability: SYSTEM_STATUS_REGISTRY_CAPABILITY, reason: "注册 WebRTC 广播网关模块" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "注册 WebRTC session resources" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "注册 WebRTC 设置面包屑" },
    ]),
  }],
  i18n: webrtcResources,
  async setup(ctx) {
    const keyspace = ctx.capability(KEYSPACE_SERVICE_CAPABILITY);
    const contacts: ContactsService = ctx.capability(CONTACTS_SERVICE_CAPABILITY);
    const optionalCapability = (ctx as unknown as {
      optionalCapability?: (capability: unknown) => unknown;
    }).optionalCapability;
    const contactsControl = optionalCapability?.(CONTACTS_COORDINATOR_CONTROL_CAPABILITY) as
      | { contactsPresenceSnapshot?: () => Promise<{ status: string; value?: Record<string, { state?: string }> }> }
      | undefined;
    const noticeRegistry = ctx.capability(NOTICE_REGISTRY_CAPABILITY);
    const channel = ctx.capability(CHANNEL_RUNTIME_CAPABILITY).forPlugin(WEBRTC_PLUGIN_ID);
    const configStore = createFileWebrtcConfigStore(ctx.filesFor(""));
    await configStore.ready();
    const historyStorage = ctx.storageFor("history");
    const historyService = createWebrtcHistoryService({
      keyspace,
      ownerPublicKeyHex: () => keyspace.active().activePublicKeyHex ?? null,
      storage: historyStorage
    });
    const isContactAllowed = async (publicKeyHex: string, signal?: AbortSignal) => {
      if (signal?.aborted) return false;
      const contact = await contacts.findByPublicKeyHex(publicKeyHex);
      return !signal?.aborted && Boolean(contact);
    };
    const service = createWebrtcService({
      channel,
      keyspace,
      historyService,
      noticeRegistry,
      configStore,
      isTransferSenderAllowed: isContactAllowed,
      isCallSenderAllowed: isContactAllowed,
      getPeerPresence: async (publicKeyHex) => {
        const normalized = publicKeyHex.trim().toLowerCase();
        // 非联系人直接 offline，不泄露探测细节。
        const contact = await contacts.findByPublicKeyHex(normalized).catch(() => undefined);
        if (!contact) return "offline";
        // 优先 Coordinator 快照（Ping/Pong 真值）；缺失时回落到窗口 service 内存。
        try {
          const snapshot = await contactsControl?.contactsPresenceSnapshot?.();
          const value = (snapshot as { status?: string; value?: Record<string, { state?: string }> } | undefined);
          if (value?.status === "ok" && value.value) {
            const presence = value.value[normalized];
            if (presence?.state === "online") return "online";
            if (presence?.state === "offline") return "offline";
          }
        } catch {
          // ignore，回落到本地 service。
        }
        try {
          const local = contacts.getPresence?.(normalized);
          if (local?.state === "online") return "online";
          return "offline";
        } catch {
          return "unknown";
        }
      },
    });
    ctx.provide(WEBRTC_SERVICE_CAPABILITY, service);
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    resources.register<WebrtcSessionSnapshot, readonly string[]>({
      id: "webrtc.session",
      scope: "global",
      key: () => ["webrtc.session"],
      load: async (_args, context) => context.getCapability<WebrtcService>(WEBRTC_SERVICE_CAPABILITY)!.snapshot(),
      subscribe: (_args, context, invalidate) => context.getCapability<WebrtcService>(WEBRTC_SERVICE_CAPABILITY)?.subscribe(() => invalidate()) ?? (() => {}),
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      invalidation: "immediate"
    });
    resources.register<WebrtcHistoryItem[], readonly string[]>({
      id: "webrtc.peer-history",
      scope: "global",
      key: (args) => ["webrtc.peer-history", args[0] ?? ""],
      load: async (args, context) => {
        const peer = args[0] ?? "";
        if (!peer) return [];
        return context.getCapability<WebrtcService>(WEBRTC_SERVICE_CAPABILITY)?.listHistoryForPeer(peer) ?? [];
      },
      subscribe: (_args, context, invalidate) => context.getCapability<WebrtcService>(WEBRTC_SERVICE_CAPABILITY)?.subscribe(() => invalidate()) ?? (() => {}),
      invalidation: "immediate"
    });

    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    breadcrumbs.register({
      id: "webrtc.settings.crumbs",
      order: 60,
      match: (path) => path === WEBRTC_SETTINGS_PATH,
      resolve: () => [
        { label: { key: "webrtc.breadcrumb.settings", fallback: "WebRTC" } }
      ]
    });

    const systemStatus = ctx.capability(SYSTEM_STATUS_REGISTRY_CAPABILITY);
    const statusId = "webrtc.system-status";
    systemStatus.register({
      id: statusId,
      path: "/settings/system-status",
      label: { key: "webrtc.menu", fallback: "WebRTC" },
      description: {
        key: "webrtc.page.settings.desc",
        fallback: "STUN-only config; no TURN."
      },
      component: WebrtcSettingsPage,
      order: 50
    });

    return async () => {
      systemStatus.unregister(statusId);
      await service.dispose();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: webrtcSetup, ...webrtcPlugin } = webrtcPluginDefinition;

export { webrtcPlugin, webrtcSetup };
