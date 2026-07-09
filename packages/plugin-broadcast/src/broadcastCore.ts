// packages/plugin-broadcast/src/broadcastCore.ts
// 广播 core 单例实现（施工单 2026-07-06 001 硬切换）。
//
// 设计缘由（施工单 §4.1 + §4.3 + §6.2）：
//   - core 是浏览器侧广播系统唯一逻辑中心；
//   - 持有真值：active provider / owner publicKeyHex / 本地订阅 union
//     / provider 连接状态 / 最近错误；
//   - **不**持有：广播历史库 / 频道目录库 / 历史游标 / 离线补发队列；
//   - core 内部完成 owner 真值切换、active provider 切换、本地 union
//     重算、远端推送 → verify → 本地分发；
//   - 业务插件**唯一**允许消费的入口是 `BroadcastCore`，不接触 wire
//     或 provider。
//
// 关键边界（施工单 §6.4）：
//   - plugin-broadcast 是浏览器侧**唯一**允许做 envelope 签名 / 验签
//     的边界；
//   - 业务方发布时只传明文字段；core 组 envelope → SHA-256 + 签名 →
//     上传 [envelopeBytes, signatureBytes]；
//   - 远端推送时 core 拿 [envelopeBytes, signatureBytes] → verify →
//     按本地 exact channel 订阅分发；`channelId` 前缀与 publisher 一致
//     由 HubCast 服务端在 publish 阶段强制（属于 HubCast provider / 服
//     务端契约,不属于 broadcast core provider-generic 抽象），本侧
//     不重复校验。

import type {
  ActiveBroadcastProviderSnapshot,
  BroadcastConnectOutcome,
  BroadcastCore,
  BroadcastCoreOps,
  BroadcastCoreSnapshot,
  BroadcastCoreState,
  BroadcastMessage,
  BroadcastProvider,
  BroadcastProviderHandle,
  BroadcastProviderHealth,
  BroadcastProviderOperations,
  BroadcastProviderRegistry,
  BroadcastProviderSigner,
  BroadcastPublishInput,
  BroadcastSubscribeInput,
  BroadcastUnsubscribe,
  HubCastEnvelopeV1,
  KeyspaceService,
  ProviderBroadcastEvent,
  ProviderReplaceSubscriptionsInput,
  SignedHubCastEnvelopeV1,
  VaultService
} from "@keymaster/contracts";
import {
  BROADCAST_ACTIVE_PROVIDER_ID_STORAGE_KEY,
  BROADCAST_DEFAULT_RECONNECT_DELAY_MS,
  HUBCAST_ENVELOPE_VERSION_V1,
  cborDecode,
  cborEncode
} from "@keymaster/contracts";
import { bytesToHexUpper, signBroadcastEnvelope, verifyBroadcastEnvelope } from "./signer.js";

/* ============== 内部类型 ============== */

interface SubscribeHandle {
  channelIds: Set<string>;
  handler: (msg: BroadcastMessage) => void;
}

interface BoundSession {
  ownerPublicKeyHex: string;
  privKeyHex: string;
  handle: BroadcastProviderOperations;
  /** 推送订阅清理函数（handle.subscribeBroadcasts 返回）。 */
  offReceive: BroadcastUnsubscribe | null;
  /** 远端断线订阅清理函数。 */
  offClose: BroadcastUnsubscribe | null;
}

/* ============== 配置 ============== */

export interface BroadcastCoreConfig {
  /** 给 active provider 的 owner signer 工厂；null = 不可用。 */
  signerProvider: () => Promise<BroadcastSignerContext | null>;
  /** keyspace service（plugin-broadcast 直接用）。 */
  keyspace: KeyspaceService;
  /** vault service（plugin-broadcast 借私钥时查询 vault 状态）。 */
  vault: VaultService;
  /** 重连延迟（毫秒）；缺省 5000。 */
  reconnectDelayMs?: number;
  /** 日志出口；缺省 no-op。 */
  logger?: {
    info?: (input: unknown) => void;
    warn?: (input: unknown) => void;
    error?: (input: unknown) => void;
  };
  /**
   * localStorage 句柄（用于 active provider id 持久化）。
   *
   * 设计缘由：
   *   - SSR / Node 测试下 localStorage 不存在；装配层注入 fallback
   *     （内存 map）保证核心不致空指针；
   *   - 装配层**不**直接读写 storage key；统一走 core 注入。
   */
  storage?: StorageLike;
}

/**
 * Storage 句柄的最小抽象（装配层注入）。
 *
 * 实现要点：
 *   - 浏览器环境注入真实 `window.localStorage`；
 *   - 测试 / Node 环境注入内存 `Map<string,string>` 替代实现；
 *   - 任何异常（disabled / quota）返回 `null` / silently no-op。
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 给 provider 用的 owner signer 闭包（plugin-broadcast 内部类型）。
 *
 * 与 `AppMsgBindSigner` 同构风格：
 *   - `publicKeyHex` / `privateKeyHex`：闭包内短暂存在的明文；
 *   - `signChallenge`：通用 secp256k1 签名原语；
 *   - **不**夹带具体 provider 的协议字段；HubCast provider 内部
 *     自己决定 challenge 内容（bind 阶段四元组拼接下沉到 provider）。
 */
export interface BroadcastSignerContext {
  publicKeyHex: string;
  privateKeyHex: string;
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

/* ============== 日志 ============== */

function emitLog(
  logger: BroadcastCoreConfig["logger"] | undefined,
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>
): void {
  if (!logger) return;
  const fn = logger[level];
  if (!fn) return;
  const safe: Record<string, unknown> = { event };
  if (data) {
    for (const k of Object.keys(data)) {
      if (k === "body") continue;
      safe[k] = data[k];
    }
  }
  try {
    fn(safe);
  } catch {
    // ignore
  }
}

/* ============== 注册表实现 ============== */

/**
 * BroadcastProviderRegistryImpl——由 BroadcastCoreImpl 内部持有。
 *
 * 设计缘由：注册表**不**归 provider 自己拥有。core 在 setActive 成功
 * 后调用 `core.bindActiveProvider()` 触发重连；handler 由 core 内部
 * 自行安装（在 setup 阶段），业务侧**不**直接订阅本注册表。
 */
class BroadcastProviderRegistryImpl implements BroadcastProviderRegistry {
  private readonly providers = new Map<string, BroadcastProvider>();
  private activeId: string | null = null;
  private readonly handlers = new Set<(snap: ActiveBroadcastProviderSnapshot) => void>();
  /** 由 core 注入的"active 变化时执行 rebind"回调。 */
  private rebindHook: (() => void | Promise<void>) | null = null;
  /** 由 core 注入的"provider 注册完成"回调；用于自动激活决策。 */
  private registerHook: ((provider: BroadcastProvider) => void) | null = null;

  setRebindHook(hook: (() => void | Promise<void>) | null): void {
    this.rebindHook = hook;
  }

  setRegisterHook(hook: ((provider: BroadcastProvider) => void) | null): void {
    this.registerHook = hook;
  }

  register(provider: BroadcastProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `BroadcastProviderRegistry: provider id "${provider.id}" already registered`
      );
    }
    this.providers.set(provider.id, provider);
    // 通知 core 让它运行"自动激活决策"——见 `BroadcastCoreImpl` 内部
    // 注册的 registerHook。
    if (this.registerHook) {
      try {
        this.registerHook(provider);
      } catch {
        // ignore
      }
    }
  }

  unregister(providerId: string): void {
    const p = this.providers.get(providerId);
    if (!p) return;
    this.providers.delete(providerId);
    if (this.activeId === providerId) {
      this.activeId = null;
      this.emitAndRebind();
    }
  }

  list(): readonly BroadcastProvider[] {
    return [...this.providers.values()];
  }

  async setActive(providerId: string | null): Promise<void> {
    if (providerId === null) {
      this.activeId = null;
      this.emitAndRebind();
      return;
    }
    if (!this.providers.has(providerId)) {
      throw new Error(
        `BroadcastProviderRegistry: provider id "${providerId}" is not registered`
      );
    }
    this.activeId = providerId;
    this.emitAndRebind();
  }

  active(): BroadcastProvider | null {
    if (this.activeId === null) return null;
    return this.providers.get(this.activeId) ?? null;
  }

  activeSnapshot(): ActiveBroadcastProviderSnapshot {
    const active = this.active();
    if (!active) {
      return {
        providerId: null,
        displayName: null,
        isHealthy: false,
        lastError: null
      };
    }
    const h = active.health();
    return {
      providerId: active.id,
      displayName: active.displayName,
      isHealthy: h.isHealthy,
      lastError: h.lastError
    };
  }

  onActiveChange(handler: (snap: ActiveBroadcastProviderSnapshot) => void): BroadcastUnsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emitAndRebind(): void {
    const snap = this.activeSnapshot();
    for (const h of this.handlers) {
      try {
        h(snap);
      } catch {
        // ignore
      }
    }
    if (this.rebindHook) {
      // 异步 rebind；不阻塞 setActive 调用者。
      Promise.resolve()
        .then(() => this.rebindHook?.())
        .catch(() => {
          // ignore
        });
    }
  }
}

/* ============== Core 实现 ============== */

/**
 * 广播 core 单例实现。
 *
 * 设计缘由：
 *   - 本类是浏览器端广播系统的唯一逻辑中心；
 *   - 内部持有 BroadcastProviderRegistryImpl + 本地订阅 union +
 *     当前 bound session + 连接状态机；
 *   - 不持有历史 / 不持久化订阅；
 *   - 重连策略固定为"远端断开 5 秒后重试"，不做指数退避。
 */
export class BroadcastCoreImpl implements BroadcastCore, BroadcastCoreOps {
  private readonly cfg: BroadcastCoreConfig;
  private readonly registry = new BroadcastProviderRegistryImpl();
  /** 当前 bound session。null = 未连接。 */
  private currentBound: BoundSession | null = null;
  /** 本地订阅 union。key = exact channelId；value = Set<SubscribeHandle>。 */
  private readonly subsByChannel = new Map<string, Set<SubscribeHandle>>();
  /** 本地订阅顺序信息（handle → 自身 channelIds 集合）。 */
  private readonly handlesByRef = new WeakMap<object, SubscribeHandle>();
  /** 状态变更订阅。 */
  private readonly stateChangeHandlers = new Set<() => void>();
  /** 最近一次错误 message。 */
  private lastErrorValue: string | null = null;
  /** 当前 owner publicKeyHex（structural 视角）。null = 未就绪。 */
  private currentOwnerPublicKeyHex: string | null = null;
  /** 当前 owner privateKeyHex（闭包内短暂持有；调用结束后清）。 */
  private currentPrivKeyHex: string | null = null;
  /** 当前 core 状态。 */
  private stateValue: BroadcastCoreState = "idle";
  /** 下一次自动重连截止时间戳。null = 不等待。 */
  private nextReconnectAtMsValue: number | null = null;
  /** connectForOwner 内部 epoch；自增代表"被同实例另一次 connectForOwner 抢占"。 */
  private connectEpochValue = 0;
  /**
   * 用户主动清空信号（true = 显式 setActive(null) 已发生）。
   *
   * 设计缘由（施工单 2026-07-08 001 §4.5 + §8.四）：
   *   - 用户在管理页主动 setActive(null) 后，**不**允许"默认自动
   *     抢回"覆盖用户意愿；
   *   - 只在用户切换到另一个 provider 时才清；
   *   - 装配层在 setup 阶段按"持久值匹配 → 自动激活 / 否则等显式
   *     选择"决定是否立刻 activate。
   */
  private userCleared = false;

  constructor(cfg: BroadcastCoreConfig) {
    this.cfg = cfg;
    this.registry.setRebindHook(() => this.rebindForCurrentOwner());
    // 注册 hook：每当新 provider 注册，立即评估默认激活路径。
    // 见 `onProviderRegistered()`。
    this.registry.setRegisterHook((p) => this.onProviderRegistered(p));
  }

  /* ============== registry ============== */

  providers(): BroadcastProviderRegistry {
    return this.registry;
  }

  /* ============== active provider ops ============== */

  /**
   * 切换 active provider；写入持久化 + 完成内部 setActive。
   *
   * 关键语义（施工单 §8.四）：
   *   - providerId === null = 显式清空；写入 storage + 设 userCleared；
   *   - providerId !== null = 切换；写入 storage + 清 userCleared；
   *   - providerId 不在已注册集合里 → reject；
   *   - 注册表 setActive 后 core 内部会触发 rebind；本方法不在内部
   *     做额外 bind 等待。
   */
  async setActiveProviderId(providerId: string | null): Promise<void> {
    await this.registry.setActive(providerId);
    if (providerId === null) {
      this.userCleared = true;
      try {
        this.cfg.storage?.removeItem(BROADCAST_ACTIVE_PROVIDER_ID_STORAGE_KEY);
      } catch {
        // ignore
      }
    } else {
      this.userCleared = false;
      try {
        this.cfg.storage?.setItem(
          BROADCAST_ACTIVE_PROVIDER_ID_STORAGE_KEY,
          providerId
        );
      } catch {
        // ignore
      }
    }
  }

  /**
   * 当前 active provider id；未选择或正等待默认激活时返回 null。
   */
  getActiveProviderId(): string | null {
    return this.registry.activeSnapshot().providerId;
  }

  /**
   * 装配层在 setup 阶段决定初始 active provider 时调用。
   *
   * 语义：
   *   - 若 storage 中已有持久值且对应 provider 已在注册表中 → 激活；
   *   - 否则若 userCleared === false 且当前注册表非空 → 激活注册表中
   *     第一个 provider（按 register 顺序）；
   *   - 显式清空过一次（userCleared === true）→ **不**自动激活；
   *   - 注册表为空 → 直接 no-op。
   *
   * 设计缘由（施工单 §4.5）：
   *   - 缺省行为必须与"显式清空"严格区分：装配层 boot 时如果 storage
   *     没值，按"用户没表达过偏好"处理 → 给一个默认值；
   *   - 用户主动 setActive(null) 后即使 storage 也有值（因为被显式
   *     清空 → removeItem），下一次启动也按 userCleared=true 处理
   *     → 不默认激活。
   */
  bootstrapActiveProvider(): boolean {
    const stored = readPersistedProviderId(this.cfg.storage);
    if (stored !== null) {
      const all = this.registry.list();
      const p = all.find((pp) => pp.id === stored);
      if (p) {
        void this.setActiveProviderId(p.id);
        return true;
      }
    }
    if (this.userCleared) return false;
    const all = this.registry.list();
    if (all.length === 0) return false;
    const first = all[0];
    if (!first) return false;
    void this.setActiveProviderId(first.id);
    return true;
  }

  /**
   * 标记"用户在管理页显式 setActive(null) 过一次"。
   *
   * 用法：本方法由 core 内部在 setActiveProviderId(null) 路径调用；
   * 也供装配层在测试 / 跨场景注入（例如 plugin 重启但 storage 被清理）。
   */
  markUserCleared(): void {
    this.userCleared = true;
  }

  /** 当前是否显式清空过（仅诊断 / 测试使用）。 */
  hasUserCleared(): boolean {
    return this.userCleared;
  }

  /**
   * 默认激活决策：每当新 provider 注册时调用一次。
   *
   * 语义（施工单 §4.5 + §8.四）：
   *   - 若当前 active 已确定（持久值命中或用户显式选过） → 不动；
   *   - 若 storage 里有持久值且该 provider 已在注册表 → 激活；
   *   - 否则若 userCleared === true → **不**自动激活（尊重用户清空）；
   *   - 否则若这是注册表里第一个 provider 且 userCleared === false →
   *     自动激活为 active。
   *
   * 失败语义：本方法只触发 setActive；setActive 内部不抛错。
   */
  private onProviderRegistered(provider: BroadcastProvider): void {
    if (this.userCleared) return;
    if (this.registry.activeSnapshot().providerId !== null) return;
    const stored = readPersistedProviderId(this.cfg.storage);
    if (stored !== null) {
      if (stored === provider.id) {
        void this.setActiveProviderId(provider.id);
        return;
      }
      // 持久值不匹配当前 provider：不动；让其它路径决定。
      return;
    }
    // 无持久值、用户没有显式清空、当前无 active →
    // 把当前 provider 自动激活为默认值。
    void this.setActiveProviderId(provider.id);
  }

  /* ============== 连接管理 ============== */

  async connectForOwner(
    ownerPublicKeyHex: string,
    callerEpoch?: number
  ): Promise<BroadcastConnectOutcome> {
    const myEpoch = ++this.connectEpochValue;
    void callerEpoch; // caller 端用来做"await 后自检"；core 内部不读不校验
    this.currentOwnerPublicKeyHex = ownerPublicKeyHex;
    const ctx = await this.cfg.signerProvider();
    if (!ctx) {
      this.lastErrorValue = "no_signer";
      this.markStructurallyOffline();
      return { kind: "structurallyOffline", reason: "no_signer" };
    }
    if (this.connectEpochValue !== myEpoch) {
      return { kind: "stale" };
    }
    this.currentPrivKeyHex = ctx.privateKeyHex;
    const active = this.registry.active();
    if (!active) {
      this.lastErrorValue = "no_active_provider";
      this.markStructurallyOffline();
      return { kind: "structurallyOffline", reason: "no_active_provider" };
    }
    if (this.connectEpochValue !== myEpoch) {
      return { kind: "stale" };
    }
    this.stateValue = "connecting";
    this.fireStateChange();
    try {
      const handle = (await active.bind({
        signer: this.makeProviderSigner(ctx)
      })) as BroadcastProviderOperations;
      if (this.connectEpochValue !== myEpoch) {
        try {
          handle.close();
        } catch {
          // ignore
        }
        return { kind: "stale" };
      }
      // 旧 session 关闭
      await this.disposeCurrentSession();
      const offReceive = handle.subscribeBroadcasts((ev) => this.onProviderBroadcast(ev));
      const offClose = handle.onClose(() => this.onProviderClose());
      this.currentBound = {
        ownerPublicKeyHex,
        privKeyHex: ctx.privateKeyHex,
        handle,
        offReceive,
        offClose
      };
      // bind 成功后下推当前本地 union
      await handle.replaceSubscriptions({
        channelIds: this.computeUnionList()
      });
      // v1 服务端 subscription.set success 不回包 channel 列表——resolve
      // 即视为服务端已接受本次提交。
      this.stateValue = "bound";
      this.lastErrorValue = null;
      this.nextReconnectAtMsValue = null;
      this.fireStateChange();
      return { kind: "connected" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorValue = msg;
      emitLog(this.cfg.logger, "warn", "broadcast.core.bind.failed", {
        ownerPublicKeyHex,
        err: msg
      });
      // 不抬 epoch：让协调器下一轮按"可重试失败"重新尝试
      this.stateValue = "closed";
      this.fireStateChange();
      return { kind: "retryableFailure", reason: msg };
    }
  }

  async disconnect(): Promise<void> {
    ++this.connectEpochValue;
    await this.disposeCurrentSession();
    this.stateValue = "idle";
    this.lastErrorValue = null;
    this.nextReconnectAtMsValue = null;
    this.currentOwnerPublicKeyHex = null;
    this.currentPrivKeyHex = null;
    this.fireStateChange();
  }

  markStructurallyOffline(): void {
    ++this.connectEpochValue;
    void this.disposeCurrentSession();
    this.stateValue = "idle";
    this.lastErrorValue = null;
    this.nextReconnectAtMsValue = null;
    this.currentOwnerPublicKeyHex = null;
    this.currentPrivKeyHex = null;
    this.fireStateChange();
  }

  setNextReconnectAtMs(value: number | null): void {
    this.nextReconnectAtMsValue = value;
    this.fireStateChange();
  }

  getNextReconnectAtMs(): number | null {
    return this.nextReconnectAtMsValue;
  }

  /* ============== 业务 facade ============== */

  isReady(): boolean {
    return this.stateValue === "bound" && this.currentBound !== null;
  }

  async publish(input: BroadcastPublishInput): Promise<BroadcastMessage> {
    if (!this.isReady() || !this.currentBound) {
      throw new Error("broadcast.core: not_ready");
    }
    if (!(input.bodyBytes instanceof Uint8Array)) {
      throw new Error("broadcast.core: bodyBytes must be Uint8Array");
    }
    const envelope: HubCastEnvelopeV1 = {
      envelopeVersion: HUBCAST_ENVELOPE_VERSION_V1,
      publisherPublicKeyBytes: hexToBytes(this.currentBound.ownerPublicKeyHex),
      channelId: input.channelId,
      protocolId: input.protocolId,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs,
      bodyBytes: input.bodyBytes
    };
    // wire 顺序与 HubCast 服务端 HubCastEnvelopeV1 严格对齐：
    //   [version, publisherPublicKey33, channelId, protocolId,
    //    clientMessageId, createdAtMs, bodyBytes]
    // **不**允许重排——envelope 真值字节就是签名对象。
    const envelopeBytes = cborEncode([
      envelope.envelopeVersion,
      envelope.publisherPublicKeyBytes,
      envelope.channelId,
      envelope.protocolId,
      envelope.clientMessageId,
      envelope.createdAtMs,
      envelope.bodyBytes
    ]);
    const signatureHex = signBroadcastEnvelope(
      this.currentBound.privKeyHex,
      envelopeBytes
    );
    const signatureBytes = hexToBytes(signatureHex);
    emitLog(this.cfg.logger, "info", "broadcast.core.publish.begin", {
      channelId: input.channelId,
      protocolId: input.protocolId,
      clientMessageId: input.clientMessageId,
      envelopeBytes: envelopeBytes.length,
      signatureBytes: signatureBytes.length
    });
    // v1 服务端 success 路径返回空数组——`resolve` 即视为服务端已接受。
    await this.currentBound.handle.publish({
      envelopeBytes,
      signatureBytes
    });
    return {
      channelId: input.channelId,
      protocolId: input.protocolId,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs,
      bodyBytes: input.bodyBytes,
      publisherPublicKeyHex: this.currentBound.ownerPublicKeyHex
    };
  }

  subscribe(input: BroadcastSubscribeInput): BroadcastUnsubscribe {
    const handle: SubscribeHandle = {
      channelIds: new Set(input.channelIds),
      handler: input.handler
    };
    this.handlesByRef.set(input.handler, handle);
    for (const ch of handle.channelIds) {
      let set = this.subsByChannel.get(ch);
      if (!set) {
        set = new Set();
        this.subsByChannel.set(ch, set);
      }
      set.add(handle);
    }
    // 触发下推 union（fire-and-forget）
    void this.pushCurrentUnion();
    return () => {
      if (!this.handlesByRef.has(input.handler)) return;
      this.handlesByRef.delete(input.handler);
      for (const ch of handle.channelIds) {
        const set = this.subsByChannel.get(ch);
        if (!set) continue;
        set.delete(handle);
        if (set.size === 0) this.subsByChannel.delete(ch);
      }
      // 触发下推 union（fire-and-forget）
      void this.pushCurrentUnion();
    };
  }

  listSubscribedChannels(): readonly string[] {
    // 返回本地期望 union——所有本地订阅句柄 channelIds 的合集副本。
    // 不发起任何 IO，不依赖 provider；已连接 / 未连接走同一条路径。
    // subscription.set 服务端 success 仅回包 void，core 不单独持有
    // "服务端确认集合"这份真值。
    return this.computeUnionList().slice();
  }

  /* ============== 状态 ============== */

  inspect(): BroadcastCoreSnapshot {
    return {
      state: this.stateValue,
      providerId: this.registry.activeSnapshot().providerId,
      ownerPublicKeyHex: this.currentOwnerPublicKeyHex,
      lastError: this.lastErrorValue,
      subscribedChannels: this.computeUnionList().slice(),
      nextReconnectAtMs: this.nextReconnectAtMsValue
    };
  }

  onStateChange(handler: () => void): BroadcastUnsubscribe {
    this.stateChangeHandlers.add(handler);
    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  currentHandle(): BroadcastProviderOperations | null {
    return this.currentBound?.handle ?? null;
  }

  /* ============== 私有方法 ============== */

  private computeUnionList(): string[] {
    return [...this.subsByChannel.keys()];
  }

  private async pushCurrentUnion(): Promise<void> {
    if (!this.isReady() || !this.currentBound) return;
    const list = this.computeUnionList();
    try {
      const input: ProviderReplaceSubscriptionsInput = { channelIds: list };
      await this.currentBound.handle.replaceSubscriptions(input);
      // v1 服务端 success 不回包——resolve 即视为服务端已接受本次提交。
      this.fireStateChange();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorValue = msg;
      emitLog(this.cfg.logger, "warn", "broadcast.core.replaceSubscriptions.failed", {
        err: msg
      });
      // 推送失败视为连接已坏：触发远端断线处理流程
      this.onProviderClose();
    }
  }

  private makeProviderSigner(ctx: BroadcastSignerContext): BroadcastProviderSigner {
    return {
      publicKeyHex: ctx.publicKeyHex,
      signChallenge: (args) => ctx.signChallenge(args)
    };
  }

  private async rebindForCurrentOwner(): Promise<void> {
    if (!this.currentOwnerPublicKeyHex) return;
    // setActive 触发的重连：owner 已在 setup 阶段被订阅过；当前
    // privKeyHex 可能已失效（vault lock 切换 key），由 connectForOwner
    // 内部重新调用 signerProvider 取最新。
    await this.connectForOwner(this.currentOwnerPublicKeyHex);
  }

  private onProviderBroadcast(ev: ProviderBroadcastEvent): void {
    if (!this.currentBound) return;
    try {
      const decoded = decodeEnvelope(ev.envelopeBytes);
      if (!decoded) {
        emitLog(this.cfg.logger, "warn", "broadcast.core.received.invalid_envelope", {
          err: "decode failed"
        });
        return;
      }
      // verify：对 envelope 真值字节 + publisher pubkey 做 secp256k1 验签
      const ok = verifyBroadcastEnvelope({
        envelopeBytes: ev.envelopeBytes,
        signatureBytes: ev.signatureBytes,
        publisherPublicKeyHex: decoded.publisherPublicKeyHex
      });
      if (!ok) {
        emitLog(this.cfg.logger, "warn", "broadcast.core.received.verify_failed", {
          channelId: decoded.channelId,
          publisherPublicKeyHex: decoded.publisherPublicKeyHex
        });
        return;
      }
      // publisher-vs-bound-owner 与 `channelId` 前缀一致性的最终校验由
      // HubCast 服务端在 publish 阶段强制（属于 HubCast provider / 服务
      // 端契约,不属于 broadcast core provider-generic 抽象）。本侧只
      // 做 verify + 本地 union 命中,不再做任何 publisher 身份过滤——
      // 订阅者可以收任意合法 publisher 的广播,验签 + 本地 union 命中
      // 已经守住"安全到达"的最小语义。
      // 按本地 exact channel 订阅分发
      const set = this.subsByChannel.get(decoded.channelId);
      if (!set || set.size === 0) return;
      const msg: BroadcastMessage = {
        channelId: decoded.channelId,
        protocolId: decoded.protocolId,
        clientMessageId: decoded.clientMessageId,
        createdAtMs: decoded.createdAtMs,
        bodyBytes: decoded.bodyBytes,
        publisherPublicKeyHex: decoded.publisherPublicKeyHex
      };
      for (const h of set) {
        try {
          h.handler(msg);
        } catch {
          // ignore handler error
        }
      }
    } catch (err) {
      emitLog(this.cfg.logger, "warn", "broadcast.core.received.decode_failed", {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private onProviderClose(): void {
    if (this.stateValue === "closed") return;
    emitLog(this.cfg.logger, "warn", "broadcast.core.provider.close", {
      providerId: this.registry.activeSnapshot().providerId,
      nextReconnectAtMs: this.nextReconnectAtMsValue
    });
    this.lastErrorValue = "remote closed";
    void this.disposeCurrentSession();
    this.stateValue = "closed";
    this.fireStateChange();
    // 固定延迟重连：写入 nextReconnectAtMs；协调器（或 host）按这个
    // 时间戳触发 connectForOwner。
    const delay = this.cfg.reconnectDelayMs ?? BROADCAST_DEFAULT_RECONNECT_DELAY_MS;
    this.nextReconnectAtMsValue = Date.now() + delay;
    this.fireStateChange();
  }

  private async disposeCurrentSession(): Promise<void> {
    const s = this.currentBound;
    this.currentBound = null;
    if (!s) return;
    try {
      s.offReceive?.();
    } catch {
      // ignore
    }
    try {
      s.offClose?.();
    } catch {
      // ignore
    }
    try {
      s.handle.close();
    } catch {
      // ignore
    }
    this.currentPrivKeyHex = null;
  }

  private fireStateChange(): void {
    for (const h of this.stateChangeHandlers) {
      try {
        h();
      } catch {
        // ignore
      }
    }
  }

  /* ============== 静态工厂（用于测试 / 集成） ============== */

  /**
   * 工厂函数。
   */
  static create(cfg: BroadcastCoreConfig): BroadcastCoreImpl {
    return new BroadcastCoreImpl(cfg);
  }
}

/* ============== 工具 ============== */

interface DecodedEnvelope {
  channelId: string;
  protocolId: string;
  clientMessageId: string;
  createdAtMs: number;
  publisherPublicKeyBytes: Uint8Array;
  bodyBytes: Uint8Array;
  publisherPublicKeyHex: string;
}

function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope | null {
  let raw: unknown;
  try {
    raw = cborDecode(bytes);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length !== 7) return null;
  // wire 顺序与 HubCast 服务端 HubCastEnvelopeV1 严格对齐：
  //   [version, publisherPublicKey33, channelId, protocolId,
  //    clientMessageId, createdAtMs, bodyBytes]
  const [
    envelopeVersion,
    publisherPublicKeyBytes,
    channelId,
    protocolId,
    clientMessageId,
    createdAtMs,
    bodyBytes
  ] = raw as unknown[];
  if (typeof envelopeVersion !== "number" || envelopeVersion !== HUBCAST_ENVELOPE_VERSION_V1) {
    return null;
  }
  if (!(publisherPublicKeyBytes instanceof Uint8Array)) return null;
  if (publisherPublicKeyBytes.length !== 33) return null;
  if (typeof channelId !== "string") return null;
  if (typeof protocolId !== "string") return null;
  if (typeof clientMessageId !== "string") return null;
  if (typeof createdAtMs !== "number") return null;
  if (!(bodyBytes instanceof Uint8Array)) return null;
  return {
    channelId,
    protocolId,
    clientMessageId,
    createdAtMs,
    publisherPublicKeyBytes,
    bodyBytes,
    publisherPublicKeyHex: bytesToHexUpper(publisherPublicKeyBytes)
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * 读取 localStorage 中的持久化 active provider id。
 *
 * 关键约束：
 *   - storage 缺失 / 抛错 → 返回 null；
 *   - 空字符串 / 非字符串 → 返回 null；
 *   - storage 里有值但对应 provider **当前未注册** 也返回该值（让
 *     调用方决定是否激活；本函数不做注册表检查）。
 */
function readPersistedProviderId(storage: StorageLike | undefined): string | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(BROADCAST_ACTIVE_PROVIDER_ID_STORAGE_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

/* ============== 重新导出（向后兼容 + 测试便捷） ============== */

export type {
  BroadcastCore,
  BroadcastProvider,
  BroadcastProviderHandle,
  BroadcastProviderOperations,
  BroadcastProviderRegistry,
  BroadcastProviderSigner,
  BroadcastMessage,
  BroadcastPublishInput,
  BroadcastSubscribeInput,
  BroadcastUnsubscribe,
  BroadcastCoreSnapshot,
  BroadcastCoreState,
  BroadcastConnectOutcome,
  ActiveBroadcastProviderSnapshot,
  BroadcastProviderHealth,
  ProviderPublishInput,
  ProviderReplaceSubscriptionsInput,
  ProviderListSubscriptionsResult,
  ProviderBroadcastEvent,
  HubCastEnvelopeV1,
  SignedHubCastEnvelopeV1
} from "@keymaster/contracts";