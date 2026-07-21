// packages/plugin-webrtc/src/manifest.ts
// WebRTC 业务插件 manifest（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - plugin-webrtc 是**极薄业务插件**，appId = `keymaster.webrtc`，
//     **不**再感知 owner / provider / 任何 provider 细节；
//   - **不**订阅 keyspace.onActiveChange / vault.onStatusChange；
//   - **不**直接订阅 `appmsg.core.subscribeUnfilteredMessages`；
//   - 在自己的 `setup` 阶段：
//       * `ctx.get<...>("appmsg.endpoint.registry").forEndpoint(...)` 拿到
//         稳定长寿的 `AppMsgEndpointService`（endpoint = plugin endpoint
//         `keymaster.webrtc`）；
//       * service 内部自动处理 owner / provider 变化；本插件**不**关心；
//       * 页面 = `/settings/webrtc`（STUN 设置）；
//   - `/system/webrtc` 工作台已退出主流程，不再注册 route / menu / breadcrumb；
//   - settings 走 `settings.registry` 单一真值。
//   - i18n namespace：`webrtc`。

import type {
  AppMsgEndpointId,
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  I18nPluginResources,
  KeyspaceService,
  PluginManifest,
  NoticeRegistry,
  SettingsRegistry
  ,ResourceRegistry
} from "@keymaster/contracts";
import { APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import {
  KEYMASTER_WEBRTC_APP_ID,
  WEBRTC_ENDPOINT_ID,
  WEBRTC_PLUGIN_ID,
  WEBRTC_SERVICE_CAPABILITY,
  WEBRTC_SETTINGS_PATH
} from "./constants.js";
import { WebrtcSettingsPage } from "./WebrtcSettingsPage.js";
import type { WebrtcService, WebrtcSessionSnapshot } from "./webrtcService.js";
import type { WebrtcHistoryItem } from "./webrtcHistoryService.js";
import {
  createLocalStorageWebrtcConfigStore,
  getDefaultWebrtcLocalStorage
} from "./webrtcConfig.js";
import { createWebrtcHistoryService } from "./webrtcHistoryService.js";
import { createWebrtcService } from "./webrtcService.js";

const webrtcResources: I18nPluginResources = {
  namespace: "webrtc",
  resources: {
    en: {
      "webrtc.menu": "WebRTC",
      "webrtc.breadcrumb.workbench": "WebRTC",
      "webrtc.breadcrumb.settings": "WebRTC",
      "webrtc.page.workbench.title": "WebRTC",
      "webrtc.page.workbench.desc":
        "Real-time audio / video chat over STUN-only WebRTC. Direct calls require the other party to be online.",
      "webrtc.page.workbench.target.label": "Recipient publicKeyHex",
      "webrtc.page.workbench.target.placeholder":
        "02... (66 hex chars)",
      "webrtc.page.workbench.target.mode.audio": "Audio chat",
      "webrtc.page.workbench.target.mode.video": "Video chat",
      "webrtc.page.workbench.block.service_not_ready":
        "webrtc service not ready (vault locked or no active provider)",
      "webrtc.page.workbench.block.invalid_target":
        "recipient publicKeyHex must be 66 hex chars",
      "webrtc.page.workbench.block.target_offline":
        "peer is currently offline; dial is blocked",
      "webrtc.page.workbench.block.target_unknown":
        "cannot confirm peer online status; dial is blocked",
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
      "webrtc.page.settings.title": "WebRTC settings",
      "webrtc.page.settings.desc":
        "Configure STUN servers. STUN-only; no TURN. Changes auto-save on blur.",
      "webrtc.page.settings.field.stun.label": "STUN servers",
      "webrtc.page.settings.field.stun.add": "Add",
      "webrtc.page.settings.field.stun.remove": "Remove",
      "webrtc.page.settings.field.stun.placeholder": "stun:host:port",
      "webrtc.page.settings.actions.testAll": "Test all STUN",
      "webrtc.page.settings.actions.testAll.running": "Testing…",
      "webrtc.page.settings.actions.testAll.done": "Done",
      "webrtc.page.settings.diag.ok": "ok",
      "webrtc.page.settings.diag.timeout": "timeout",
      "webrtc.page.settings.diag.error": "error",
      "webrtc.page.settings.diag.note":
        "this only verifies STUN availability locally; it does not guarantee an audio/video path between arbitrary peers"
    },
    "zh-CN": {
      "webrtc.menu": "WebRTC",
      "webrtc.breadcrumb.workbench": "WebRTC",
      "webrtc.breadcrumb.settings": "WebRTC",
      "webrtc.page.workbench.title": "WebRTC",
      "webrtc.page.workbench.desc":
        "实时音视频通话（仅 STUN，不含 TURN）。直接拨号需要对方当前在线。",
      "webrtc.page.workbench.target.label": "对方 publicKeyHex",
      "webrtc.page.workbench.target.placeholder": "02...（66 个 hex）",
      "webrtc.page.workbench.target.mode.audio": "音频聊天",
      "webrtc.page.workbench.target.mode.video": "视频聊天",
      "webrtc.page.workbench.block.service_not_ready":
        "webrtc service 未就绪（vault 未解锁或未启用 provider）",
      "webrtc.page.workbench.block.invalid_target":
        "对方 publicKeyHex 必须为 66 个 hex 字符",
      "webrtc.page.workbench.block.target_offline": "对方当前离线，已阻断拨号",
      "webrtc.page.workbench.block.target_unknown": "无法确认对方在线，已阻断拨号",
      "webrtc.page.workbench.block.busy_local": "当前已有活动会话",
      "webrtc.page.workbench.block.device_unavailable": "本地设备不可用",
      "webrtc.page.workbench.block.send_invite_failed": "发送邀请失败",
      "webrtc.page.workbench.block.create_offer_failed": "创建 offer 失败",
      "webrtc.page.workbench.block.invalid_state": "会话状态非法",
      "webrtc.page.workbench.block.transfer_too_large": "附件超过 16 MiB",
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
      "webrtc.page.settings.title": "WebRTC 设置",
      "webrtc.page.settings.desc":
        "配置 STUN 服务器列表。仅 STUN，不含 TURN。字段失焦后自动保存。",
      "webrtc.page.settings.field.stun.label": "STUN 服务器",
      "webrtc.page.settings.field.stun.add": "新增",
      "webrtc.page.settings.field.stun.remove": "删除",
      "webrtc.page.settings.field.stun.placeholder": "stun:host:port",
      "webrtc.page.settings.actions.testAll": "测试全部 STUN",
      "webrtc.page.settings.actions.testAll.running": "测试中…",
      "webrtc.page.settings.actions.testAll.done": "完成",
      "webrtc.page.settings.diag.ok": "可用",
      "webrtc.page.settings.diag.timeout": "超时",
      "webrtc.page.settings.diag.error": "错误",
      "webrtc.page.settings.diag.note":
        "此测试只在本地验证 STUN 可用性，不保证任意两端一定能建立音视频通话"
    }
  }
};

/**
 * plugin-webrtc 的固定 endpoint。
 */
const PLUGIN_WEBRTC_ENDPOINT: AppMsgEndpointId = WEBRTC_ENDPOINT_ID;
void KEYMASTER_WEBRTC_APP_ID; // 文档引用：见 ./constants.ts

/**
 * WebRTC 业务插件 manifest。
 */
export const webrtcPlugin: PluginManifest = {
  id: WEBRTC_PLUGIN_ID,
  name: "WebRTC",
  description:
    "Keymaster WebRTC business plugin: STUN-only audio/video calls over AppMsg signalling, online-gated dialing, single-session state machine.",
  meta: {
    kind: "business",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [WEBRTC_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  i18n: webrtcResources,
  keyScopedStorages: [{ storageId: "history", description: "WebRTC 本地历史（通话 / 传输）" }],
  appMessageEndpoint: {
    endpointId: WEBRTC_ENDPOINT_ID.id,
    description: "keymaster.webrtc business app"
  },
  dependencies: [
    {
      capability: APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY,
      reason: "拿 endpoint service（plugin-appmsg 提供）"
    },
    { capability: "keyspace.service", reason: "打开 key-scoped 历史库" },
    { capability: "notice.registry", reason: "投递全局紧急 notice" },
    { capability: "settings.registry", reason: "注册 /settings/webrtc 设置详情页" }
  ],
  setup(ctx) {
    const registry = ctx.get<AppMsgEndpointServiceRegistry>(
      APPMESSAGE_ENDPOINT_REGISTRY_CAPABILITY
    );
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");
    const noticeRegistry = ctx.get<NoticeRegistry>("notice.registry");
    const endpointService: AppMsgEndpointService =
      registry.forEndpoint(PLUGIN_WEBRTC_ENDPOINT);
    const configStore = createLocalStorageWebrtcConfigStore(
      getDefaultWebrtcLocalStorage()
    );
    const historyService = createWebrtcHistoryService({
      keyspace,
      ownerPublicKeyHex: () => keyspace.active().activePublicKeyHex ?? null
    });
    const service = createWebrtcService({
      endpointId: PLUGIN_WEBRTC_ENDPOINT,
      endpointService,
      keyspace,
      historyService,
      noticeRegistry,
      configStore,
      logger: {
        info: (scope, msg, data) => {
          ctx.logger.info({
            scope,
            event: msg,
            message: "",
            data:
              data && typeof data === "object"
                ? (data as Record<string, unknown>)
                : undefined
          });
        },
        warn: (scope, msg, err) =>
          ctx.logger.warn({
            scope,
            event: msg,
            message: "",
            data: { err: err instanceof Error ? err.message : String(err) }
          }),
        error: (scope, msg, err) =>
          ctx.logger.error({
            scope,
            event: msg,
            message: "",
            data: { err: err instanceof Error ? err.message : String(err) }
          })
      }
    });
    ctx.provide(WEBRTC_SERVICE_CAPABILITY, service);
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);
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

    const breadcrumbs = ctx.get<{
      register(input: {
        id: string;
        order?: number;
        match: (path: string) => boolean;
        resolve: () => Array<{ label: { key: string; fallback: string } }>;
      }): void;
    }>("breadcrumb.registry");
    breadcrumbs.register({
      id: "webrtc.settings.crumbs",
      order: 60,
      match: (path) => path === WEBRTC_SETTINGS_PATH,
      resolve: () => [
        { label: { key: "webrtc.breadcrumb.settings", fallback: "WebRTC" } }
      ]
    });

    // settings
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "webrtc.settings",
      path: WEBRTC_SETTINGS_PATH,
      label: { key: "webrtc.page.settings.title", fallback: "WebRTC settings" },
      description: {
        key: "webrtc.page.settings.desc",
        fallback: "STUN-only config; no TURN."
      },
      component: WebrtcSettingsPage,
      order: 130,
      icon: "Radio",
      visibleWhen: ({ unlocked }) => unlocked
    });

    return () => {
      service.dispose();
      registry.releaseEndpoint(PLUGIN_WEBRTC_ENDPOINT);
    };
  }
};
