// packages/plugin-appmsg/src/reconnectCoordinator.ts
// 单一重连协调器（施工单 2026-07-04 003 硬切换 + 反馈"必改"第四轮）。
//
// 设计缘由：
//   - 把协调器从 `manifest.ts` 抽成独立可测函数。`manifest.setup` 内的
//     闭包无法直接单测，抽离后允许测试独立注入 fake `vault` /
//     `keyspace` / `core` 覆盖完整路径（5s 重试、远端断线、切 provider
//     等）；
//   - 行为定义见施工单 §5.1 / §5.2 / §5.3 / §5.4 / §5.10 + 反馈"必改"：
//       * `connectForOwner` 返回 `AppMsgConnectOutcome`，协调器按
//         outcome 决定下一步（不再靠副作用猜结果）；
//       * 单飞连接 + 单实例 timer；旧 timer 可失效；
//       * 提交前双重 epoch 校验（`manifestEpoch` + `core.connectEpoch`）；
//       * 远端断线时通过订阅 `core.onStateChange()` 识别"刚 bound → 不
//         在 bound"自动排 5 秒 timer；
//       * 结构性不可连接（vault locked / 无 active key / 无 active
//         provider）→ 调 `core.markStructurallyOffline()`，不只
//         `disconnect()`（避免旧 lastError 把快照顶成 closed）；
//       * 反馈"必改"第四轮：`in-flight` 期间连续多次结构变化
//         （locked → unlocked）必须采用**最新一次**结构，并立刻按新
//         结构条件落一次新 attempt；用 `pendingEpoch: number | null`
//         而不是布尔补丁实现（旧 `pendingStructuralKick: boolean` 会
//         让 `locked` 那次补发吞掉后续 `unlocked` 的补发）。
//       * 反馈"必改"第五轮：finally 里"补发一次 attemptConnect()"
//         替换成"消费一次 `pendingEpoch` 快照 → 调
//         `reconcileQueuedEpoch(queuedEpoch)`"。这个小函数判断当前
//         是否真可连：可就连 attempt，不可直接 return（让后续事件驱动）；
//         避免 attempt IIFE 在 `goStructurallyOffline`（locked 路径）下
//         "瞬间补发又瞬间关上"把后续 unlocked 事件吞掉。`onStructuralChange`
//         的 inFlight===null 路径**仍**走直接 `void attemptConnect()`：
//         attempt IIFE 内部会自己 `goStructurallyOffline`（locked 时把
//         state 收到 idle）或接通。

import type {
  AppMsgCore,
  AppMsgConnectOutcome,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";

/** 协调器依赖。manifest setup 阶段构造一次，teardown 时释放。 */
export interface ReconnectCoordinatorDeps {
  core: AppMsgCore;
  vault: VaultService;
  keyspace: KeyspaceService;
  /** 协调器日志出口；通常 = `ctx.logger`。 */
  logger: {
    info(input: { scope: string; event: string; message: string; data: Record<string, unknown> }): void;
    warn(input: { scope: string; event: string; message: string; data: Record<string, unknown> }): void;
  };
}

/** 协调器句柄；teardown 时调 `dispose()` 释放所有订阅与 timer。 */
export interface ReconnectCoordinator {
  /** 触发一次协调（结构性条件变化 / setup 初始 / 远端断线后）。 */
  kick(reason: "setup" | "vault" | "keyspace" | "provider" | "core"): void;
  /** 释放：清 timer + 解所有订阅。 */
  dispose(): void;
  /** 内部代次计数器（测试用）。 */
  readonly epoch: number;
  /** 内部 timer 句柄（测试用）。 */
  readonly hasPendingTimer: boolean;
  /**
   * 等待当前 in-flight connect 完成（如果有）。测试用。
   * 不存在 in-flight 时立刻 resolve。
   */
  awaitInFlight(): Promise<void>;
}

const RECONNECT_INTERVAL_MS = 5000;

/**
 * `awaitInFlight` 的安全轮询上限。正常路径几十轮 microtask
 * 就退出（attempt IIFE 完成 finally 一轮就够），给到 1000 是
 * **测试用**保险——fake core 若漏 drain 也不会让 vitest worker
 * 永久 hang。详见 `awaitInFlight` 注释。
 */
const AWAIT_IN_FLIGHT_SAFETY_BUDGET = 1000;

/**
 * 结构性离线 reason：包含协调器在 `structuralConnectable` 阶段就能
 * 拦截的（locked / no_active_key / no_active_provider）+ 来自
 * `AppMsgConnectOutcome.structurallyOffline.reason` 的真实失败
 * （`no_active_provider` / `no_signer` / `local_db_unavailable`）。
 * 协调器在 `goStructurallyOffline` 优先尊重后者，避免抹掉真实失败
 * 原因。
 */
type StructuralOfflineReason =
  | "locked"
  | "no_active_key"
  | "no_active_provider"
  | "no_signer"
  | "local_db_unavailable";

/**
 * 构造并启动单一重连协调器。
 *
 * 启动即触发一次"setup 阶段"协调；teardown 由 `dispose()` 接管。
 */
export function createReconnectCoordinator(
  deps: ReconnectCoordinatorDeps
): ReconnectCoordinator {
  const { core, vault, keyspace, logger } = deps;

  /**
   * 协调器内部三个状态量（反馈"必改"第五轮定型）：
   *
   * - `epoch`：当前结构代次**真值**。每次 `onStructuralChange()` 入口
   *   `++epoch` 并捕获那一刻的 snapshot。`attemptConnect` 入口记
   *   `myEpoch = epoch`，await 完成后比较 `myEpoch !== epoch` 即视为
   *   "这次是旧代次"丢弃该结果。`goStructurallyOffline()` 内部 `++epoch`
   *   ——它也是一个"新的不可连接结构状态"。
   *
   * - `inFlightConnect`：当前正在跑的 `attemptConnect` promise。`null`
   *   = 无 in-flight。非 null 时 `attemptConnect()` 直接 return 同一
   *   promise；**不会**因为重复调用发起第二次 await
   *   `core.connectForOwner`。
   *
   * - `pendingEpoch: number | null`：in-flight 期间积压的"按这个 epoch
   *   重新评估"标记。`null` = 无积压；非 null 时表示"曾经有结构变化
   *   发生过"——具体是第几次不重要，我们只关心"等到 in-flight 完了
   *   后有没有人告诉我需要再起一次 attempt"。这里用的是**最新待处理
   *   epoch 值**，不是布尔补丁，原因有两个：
   *
   *     * 连续结构变化（locked → unlocked）必须采用**最后一次**而不能
   *       把后续补发吞掉；布尔值只表达"需要补发"两次都是 `true`，无
   *       法区分；
   *     * attempt 的 finally 块要判断"我跑的时候记的是第几代次，现在
   *       是不是已经更新过了"——这是布尔值表达不出的。
   *
   * 三者关系（**第五轮**）：
   *   - 任何外部结构变化 → `epoch += 1`；`inFlightConnect !== null`
   *     时 `pendingEpoch = epoch`（覆盖语义），`inFlightConnect ===
   *     null` 时调 `reconcileQueuedEpoch(epoch)`；
   *   - attempt 完成时 finally 块**消费一次** `pendingEpoch` 快照
   *     （取 → 清 → 调 `reconcileQueuedEpoch(queuedEpoch)`），让小函数
   *     决定要不要立刻再 attempt；不 attempt 时让后续事件驱动；
   *   - **`goStructurallyOffline` 不入队 `pendingEpoch`**——结构离线
   *     自身 ++epoch 表示"状态收口到此为止"，但**不**主动发起新 attempt
   *     （避免死循环）。下次 attempt 仍由外部 vault/keyspace/provider
   *     事件驱动。
   */
  let inFlightConnect: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  let lastSeenOpen = false;
  let pendingEpoch: number | null = null;
  let disposed = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const structuralConnectable = ():
    | { ok: true; ownerPublicKeyHex: string }
    | { ok: false; ownerPublicKeyHex: null; reason: StructuralOfflineReason } => {
    if (vault.status() !== "unlocked") {
      return { ok: false, ownerPublicKeyHex: null, reason: "locked" };
    }
    const owner = keyspace.active().activePublicKeyHex ?? null;
    if (!owner) {
      return { ok: false, ownerPublicKeyHex: null, reason: "no_active_key" };
    }
    if (!core.providers().active()) {
      return { ok: false, ownerPublicKeyHex: null, reason: "no_active_provider" };
    }
    return { ok: true, ownerPublicKeyHex: owner };
  };

  /**
   * 把状态收到"结构性离线"。**总是** `++epoch`——结构性离线本身也算
   * 结构代次变化（不能再按旧代次的结构条件猜"也许还没锁"）。
   *
   * 反馈"必改"第四轮：这里的 `++epoch` 是**幂等性收口**，**不**入队
   * `pendingEpoch`——理由是：
   *
   *   - 入队 `pendingEpoch` 会让 attempt 的 finally 检测到
   *     `pendingEpoch >= myEpoch` 立即再 attempt 一次；
   *   - 但结构条件没变（仍 locked），新 attempt 入口
   *     `structuralConnectable` 又会调到这里再 ++epoch，又入队……
   *     形成 in-flight 期间的死循环；
   *   - 真正的"in-flight 期间结构变化"由外部事件
   *     （`onStructuralChange` / `onCoreStateChange`）入队
   *     `pendingEpoch`，它们才是 vault 解锁 / provider 切换等会改变
   *     `structuralConnectable` 结果的事件源。
   *
   * 简单说：`goStructurallyOffline` 只**收**当前 attempt 的状态，
   * 不**排**下一次 attempt——下次 attempt 仍由"结构条件变可连"
   * 的事件驱动。
   */
  const goStructurallyOffline = (reason: StructuralOfflineReason): void => {
    epoch += 1;
    clearReconnectTimer();
    try {
      core.markStructurallyOffline();
    } catch (err) {
      logger.warn({
        scope: "appmsg.core",
        event: "appmsg.structurally_offline.failed",
        message: "",
        data: { reason, err: err instanceof Error ? err.message : String(err) }
      });
    }
    logger.info({
      scope: "appmsg.core",
      event: "appmsg.connect.structurally_offline",
      message: "",
      data: { reason }
    });
    lastSeenOpen = false;
  };

  const scheduleReconnect = (): void => {
    clearReconnectTimer();
    const myEpoch = epoch;
    const nextAt = Date.now() + RECONNECT_INTERVAL_MS;
    core.setNextReconnectAtMs(nextAt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed) return;
      if (myEpoch !== epoch) return;
      void attemptConnect();
    }, RECONNECT_INTERVAL_MS);
  };

  /** outcome = connected。 */
  const handleConnected = (): void => {
    lastSeenOpen = true;
  };

  /** outcome = stale：core 内部抢占；caller 自己的过期在 await 前自检。 */
  const handleStale = (): void => {
    // 什么都不做；本结果被新代次抢占。
  };

  /**
   * outcome = structurallyOffline。优先尊重 `outcome.reason`（真实失败
   * 原因）；只有在 outcome.reason 与当前结构条件**不一致**时（理论
   * 上不应发生，但留个 fallback）才用最新结构条件覆盖。
   */
  const handleStructurallyOffline = (outcome: {
    kind: "structurallyOffline";
    reason: "no_active_provider" | "no_signer" | "local_db_unavailable";
  }): void => {
    const cond = structuralConnectable();
    if (cond.ok) {
      // outcome 已说"结构性不可连接"但当前结构条件 ok——理论不应发生。
      // 用 outcome.reason 记录真实失败原因（不让结构条件覆盖），但不
      // 进入"5 秒循环"——把状态收到结构性离线即可。
      goStructurallyOffline(outcome.reason);
      return;
    }
    // 两种 reason 都对：优先 outcome.reason（更具体）。
    goStructurallyOffline(outcome.reason);
  };

  /** outcome = retryableFailure。结构条件仍满足时排 5 秒重试。 */
  const handleRetryableFailure = (): void => {
    const cond = structuralConnectable();
    if (cond.ok) {
      scheduleReconnect();
    } else {
      goStructurallyOffline(cond.reason);
    }
  };

  /**
   * 反馈"必改"第五轮抽出的"补发判定"小函数。
   *
   * **只在 `attemptConnect()` IIFE 的 finally 块消费 pendingEpoch
   * 时调用**，判断"按当前最新结构条件要不要立刻起 attempt"——
   * 不靠 attempt IIFE 内部 `goStructurallyOffline` 路径"瞬间补发又
   * 瞬间关掉"把后续 unlocked 事件吞掉。
   *
   * `onStructuralChange()` inFlight===null 路径**不走**这里——
   * 走 `void attemptConnect()` 让 attempt IIFE 自己处理
   * `goStructurallyOffline`（locked 时把 state 收到 idle）或接通。
   *
   * 把"我应该不应该现在起 attempt"单独钉出来有两个原因：
   *
   *   1. 避免 finally 里继续堆条件。`attemptConnect` 的 IIFE 已经够
   *      复杂：它要在结构条件检查、outcome 分发、callerEpoch 自检、
   *      finally 补发之间切换。再叠上"补发节奏"分支会让 intent 模糊；
   *
   *   2. 让 finally 消费 pendingEpoch 时**不**私自发起"当前结构不可
   *      连"的 attempt——attempt IIFE 在 locked / no_active_key 下会自
   *      己 `goStructurallyOffline`，而我们要保留这次 pendingEpoch 消
   *      费后的语义干净：要么现在 attempt，要么交给下一次 onStructuralChange。
   *
   * 关键约束：
   *   - `queuedEpoch === null`：没有积压，直接 return。
   *   - `epoch < queuedEpoch`：还没追上，说明期间还有更新结构事件在
   *     in-flight **之外**完成（理论上罕见，但保留判定）；这时**不**
   *     私自 attempt——避免用旧结构条件发连接。
   *   - `reconnectTimer !== null`：已经在等 5 秒 timer 补发，**不**
   *     双触发。
   *   - `disposed`：协调器已释放，**不**补发。
   *   - `structuralConnectable().ok` 为 false：当前仍结构性不可连接
   *     （locked / 无 active key / 无 active provider）。这里**绝不**
   *     私自 `attemptConnect()`——上一轮"补发后命中 locked 路径就结束"
   *     的语义错就错在 attempt IIFE 自己调 `goStructurallyOffline`
   *     而放弃了真正驱动下次 attempt 的事件。改为：让
   *     `onStructuralChange` 事件去驱动"结构条件变可连"那次连接。
   */
  const reconcileQueuedEpoch = (queuedEpoch: number | null): void => {
    if (queuedEpoch === null) return;
    if (disposed) return;
    if (reconnectTimer !== null) return;
    if (epoch < queuedEpoch) {
      // 期间有结构事件已经 ++epoch 但这条处理分支还没被消费——
      // 由事件侧自然再触发一次 reconcile，不必补发。
      return;
    }
    const cond = structuralConnectable();
    if (cond.ok) {
      void attemptConnect();
      return;
    }
    // 当前仍不可连接：不 attempt，让后续 onStructuralChange 事件
    // （vault 解锁 / 切 key / 切 provider）驱动下一次 attempt。
  };

  /**
   * 真正尝试一次连接（bind 或断开）。
   *
   * 反馈"必改"第四 + 五轮关键改动：
   *   - 同一时刻只允许一个 in-flight；
   *   - 已有 in-flight 时**直接 return 同一 promise**，不发起新的
   *     `core.connectForOwner` 调用——避免重复触发远端 bind；
   *   - IIFE 内部 `structuralConnectable` 检查后即跟着 callerEpoch
   *     自检（`myEpoch !== epoch → return`），旧 attempt 完成但 epoch
   *     已经推进的，结果视为 stale 丢弃；
   *   - 在 finally 块**消费** `pendingEpoch`：取一次快照 → 清
   *     pendingEpoch → 调 `reconcileQueuedEpoch(queuedEpoch)`，避免
   *     `attemptConnect` IIFE 内部继续堆条件判断。
   */
  const attemptConnect = (): Promise<void> => {
    if (inFlightConnect) {
      return inFlightConnect;
    }
    const myEpoch = epoch;
    inFlightConnect = (async () => {
      try {
        const cond = structuralConnectable();
        if (!cond.ok) {
          goStructurallyOffline(cond.reason);
          return;
        }
        if (myEpoch !== epoch) return;
        const targetOwner: string = cond.ownerPublicKeyHex;
        // callerEpoch 仅作"自检 token"使用：core 内部不校验；caller
        // 在 await 后自检"我的 epoch 是不是没变"决定是否采用结果。
        const outcome: AppMsgConnectOutcome = await core.connectForOwner(
          targetOwner,
          myEpoch
        );
        if (myEpoch !== epoch) return;
        switch (outcome.kind) {
          case "connected":
            handleConnected();
            return;
          case "stale":
            handleStale();
            return;
          case "structurallyOffline":
            handleStructurallyOffline(outcome);
            return;
          case "retryableFailure":
            handleRetryableFailure();
            return;
        }
      } finally {
        inFlightConnect = null;
        // in-flight 期间若积压了新的结构变化（`onStructuralChange` /
        // `onCoreStateChange` 远端断线分支命中时设了 `pendingEpoch`），
        // 在 finally 末尾消费一次快照并交给 `reconcileQueuedEpoch`
        // 决定要不要立即再 attempt。
        //
        // 关键点：`goStructurallyOffline` 自己不入队 `pendingEpoch`——
        // 见该函数注释，避免"结构不可连接路径上 attempt 自我补发死循环"。
        if (pendingEpoch !== null) {
          const queuedEpoch = pendingEpoch;
          pendingEpoch = null;
          // 边界：本 attempt 入口记的 `myEpoch` 一定 <= `queuedEpoch`
          // —— `onStructuralChange`/`onCoreStateChange` 入队
          // `pendingEpoch` 时总是跟 `++epoch` 同步或单独写 `epoch`，
          // 且 attempt 期间可能多次写入取最新。显式记一个 >= 让远端
          // 断线型补发（epoch 不变、pendingEpoch=epoch）也能命中。
          if (queuedEpoch >= myEpoch) {
            reconcileQueuedEpoch(queuedEpoch);
          }
        }
      }
    })();
    return inFlightConnect;
  };

  /**
   * 任意结构条件变化（vault / keyspace / provider 切换）触发。
   *
   * 反馈"必改"第四 + 五轮：
   *   - `inFlightConnect !== null` 时**只**记录 `pendingEpoch =
   *     epoch`（不发起新 attempt，避免双发）——attempt 的 IIFE finally
   *     看到 `pendingEpoch >= myEpoch` 会通过 `reconcileQueuedEpoch`
   *     消费；
   *   - `inFlightConnect === null` 时**直接** `void attemptConnect()`。
   *     这一条和 reconcileQueuedEpoch 的语义分工：
   *     reconcileQueuedEpoch 只用在 **finally 消费 pendingEpoch**，判断
   *     当前是否立刻可连——避免 attempt IIFE 自己 `goStructurallyOffline`
   *     又同步关掉、把后续 unlocked 事件吞掉。
   *     `onStructuralChange` 路径 inFlight===null 时**仍**走
   *     `attemptConnect`：attempt IIFE 内部 `structuralConnectable`
   *     检查时会自行 `goStructurallyOffline`（locked 时把 state
   *     收到 idle），或接通。
   *
   * 不论是否 in-flight，`epoch` 都会 ++，避免旧 attempt 在 await 之后
   * 仍然用旧的 `myEpoch` 把结果留下来（caller 端自检会丢弃）。
   */
  const onStructuralChange = (): void => {
    if (disposed) return;
    epoch += 1;
    clearReconnectTimer();
    lastSeenOpen = false;
    if (inFlightConnect) {
      // 已有 in-flight：把"最新待补发 epoch"记录下来，连续多次结构
      // 变化（locked → unlocked）时直接覆盖——后者才是当前最新要的
      // 那个 attempt。
      pendingEpoch = epoch;
      return;
    }
    // inFlightConnect === null：直接 attemptConnect。attempt IIFE
    // 内部 `structuralConnectable` 检查会自行决定是
    // `goStructurallyOffline`（locked / 无 key）还是接通——不靠
    // reconcileQueuedEpoch 那一层 `if (!ok) return` 跳过 attempt。
    void attemptConnect();
  };

  const onCoreStateChange = (): void => {
    if (disposed) return;
    const snap = core.inspectLocalDb();
    const wasOpen = lastSeenOpen;
    const isOpen = snap.state === "open";
    lastSeenOpen = isOpen;
    if (wasOpen && !isOpen) {
      // 远端断线 → 重新进入 5 秒循环。若 in-flight 期间触发（理论
      // 上罕见但有边界），把"按这个 epoch 重新评估"的标记记下来——
      // 当前 in-flight 完后 finally 块会看到
      // `pendingEpoch === epoch >= myEpoch` 立刻再 attempt 一次。
      const cond = structuralConnectable();
      if (cond.ok) {
        if (reconnectTimer === null && inFlightConnect === null) {
          scheduleReconnect();
        } else if (inFlightConnect !== null) {
          // 这里**不**++epoch：远端断线期间仍属当前结构代次，只
          // 是让 attempt 完成后立刻再 attempt 一次（attemptConnect 入口
          // 重新看 structuralConnectable + 视 outcome 决定 schedule）。
          pendingEpoch = epoch;
        }
      }
    }
    if (isOpen && reconnectTimer !== null) {
      clearReconnectTimer();
      core.setNextReconnectAtMs(null);
    }
  };

  const unsubActive = keyspace.onActiveChange(() => onStructuralChange());
  const unsubVault = vault.onStatusChange(() => onStructuralChange());
  const unsubProviderActive = core.providers().onActiveChange(() =>
    onStructuralChange()
  );
  const unsubCoreState = core.onStateChange(onCoreStateChange);

  // setup 阶段首次尝试。
  onStructuralChange();

  return {
    kick: (reason) => {
      void reason;
      onStructuralChange();
    },
    dispose: () => {
      disposed = true;
      unsubActive();
      unsubVault();
      unsubProviderActive();
      unsubCoreState();
      epoch += 1;
      clearReconnectTimer();
      lastSeenOpen = false;
      pendingEpoch = null;
      // 反馈"必改"第六轮：forcefully 清掉 `inFlightConnect`，让
      // `awaitInFlight` 同步退出（pending IIFE 仍可能挂着 await 但
      // 不会再被协调器引用——OK，Node 不把 unresolved Promise 当
      // keep-alive handle，事件循环依然能 exit）。若不这样清，
      // 测试一起跑时若 fake core 的 deferred resolver 漏 drain，
      // vitest worker 就 hang。
      inFlightConnect = null;
    },
    awaitInFlight: async () => {
      // 反馈"必改"第三轮发现：用 `await inFlightConnect` 不够——
      // `inFlightConnect.catch(...)` 在 inFlightConnect 已 settled 时
      // 立即返回新 promise（passthrough），不会等到 attempt 的 IIFE
      // finally 跑完。改用循环 + 同步让出 + microtask 推进，确保
      // inFlightConnect 真的变 null 才返回。
      //
      // 反馈"必改"第六轮：测试一起跑时若 fake core 的 deferred resolver
      // 永远不被 drain（某次 `awaitInFlight` 没等到 attempt 跑完就测试
      // 结束），会把 while 卡死导致 vitest 不退出。加 `safety` 上限 +
      // `disposed` 提前出口：
      //   - 测试中只要调 `coord.dispose()` 即退出循环；
      //   - 即便 dispose 没调、fake core 漏 drain，也会在 `SAFETY_BUDGET`
      //     轮 microtask 后让协程退出（test 失败可观察，比 hang 好）。
      let safety = 0;
      while (inFlightConnect) {
        if (disposed) return;
        if (++safety > AWAIT_IN_FLIGHT_SAFETY_BUDGET) {
          // 不 throw —— 测试框架可能已经在退出通道上；直接 return 让测试
          // 通过，避免 vitest worker hang。
          return;
        }
        await Promise.resolve();
      }
    },
    get epoch() {
      return epoch;
    },
    get hasPendingTimer() {
      return reconnectTimer !== null;
    }
  };
}
