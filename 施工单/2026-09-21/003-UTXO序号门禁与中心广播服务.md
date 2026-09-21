# 003：UTXO 序号门禁与中心广播服务

> 日期：2026-09-21
>
> 状态：已实施（含 Worker 内中心广播实例；原 4 项待确认决策已按 §12.1 落地）
>
> 优先级：P1（涉及资金安全：防多花、防重复付款）
>
> 上游约束：[P2PKH](../../docs/P2PKH.md) 的「UTXO 快照规则 / 转账边界 / 本地交易」；
> [002 全局余额广播](./002-全局余额广播.md)（同区域改动，实施顺序需协调）

## 1. 背景与问题

1. **快速连打会撞同一组 UTXO**：A、B 两个程序在很短时间内各自 `prepare`，拿到的是
   同一份 UTXO 快照；A 先广播成功，B 仍按旧快照组合，广播时输入已被花掉 → 第二笔失败。
   现有防线只有本地 input claim（同一进程内、提交时才写），挡不住两次 prepare 之间的空窗。
2. **广播出口分散，可被绕过**：目前有三条路能广播：
   - 普通转账 → Worker `p2pkh.broadcast`（半中心，但入口暴露给插件）；
   - 协议花费（BSV-21 / STAS / 1Sat 等代币的 gas）→ `p2pkhProtocolSpend` 直接调用
     `WocService.broadcast`，**完全绕过 Worker**；
   - `WocService.broadcast` 是公开契约方法，任何拿到 WOC 能力的插件都能广播。
3. **失败自动重试无处安放**：交易 build 散落在普通转账、协议花费、各代币插件和三方模块里，
   无法集中 build；但"被门禁拒绝后等待新快照、重新组合、再提交"的重试循环必须集中在
   一个地方，否则每个调用方都要自己实现。

## 2. 目标

1. 每个资源的 UTXO 快照带**序号 seq**（内容不变的同步不换号，内容变化才换号）。
2. 组合交易时捕获序号；提交时 Worker **原子核对序号并消费**，不匹配就拒绝并等待同步；
   消费后该序号作废，`get` 拿不到 UTXO、任何提交失败，只有"内容变化"的同步才能解封。
3. 失败自动重试集中在**页面侧中心广播服务**；业务只提供"重新准备一次"的能力，
   apps（页面、代币插件、三方）看到的 API 不变、看不到 rebuild。
4. **广播出口唯一化**：唯一物理出口在 Worker；插件/页面/三方唯一的广播入口是中心广播服务；
   `WocService.broadcast` 不再对插件暴露。
5. `asset.data-changed` 事件携带各网络最新序号，作为重试方"新数据已到"的唯一唤醒信号（v1 不带清单状态）。
6. 代币 gas 只要花了钱包 P2PKH UTXO，同样纳入序号门禁与消费。

## 3. 冻结的不变量

### 3.1 序号（seq）

- [ ] 序号只存在于 Coordinator Worker 内存，不落盘；资源 = `owner + network + address + generation`。
- [ ] 序号由 Worker 全局单调发号器发放，同一次 Worker 会话内不同快照的序号都不同。
- [ ] 一次成功刷新，归一化后的 UTXO 集合与当前完全一致 → **沿用旧序号**（只更新 `syncedAt`）。
- [ ] 集合内容有任何差异（含 `isSpentInMempoolTx` 翻转）→ 发新序号，严格大于旧序号。
- [ ] 内容相等的判定字段：`txid / vout / value / height / status / isSpentInMempoolTx / script`，
      沿用现有归一化与排序实现。
- [ ] 首次取得可信快照 → 发新序号；锁定钱包 / 切换 owner / Worker 重启 / 销毁会话 → 快照清空、序号消失。
- [ ] v1 **不做钞票级状态管理**：不记录每张 UTXO 的分配、预拆分或逐币状态，只在快照级记录 `state`。

### 3.2 提交门禁与消费

- [ ] 组合交易时必须捕获 `utxoBinding = { resourceId, seq }`，随 preview 一起提交。
- [ ] Worker 出口在**同一个无 await 的同步块**内完成：核对 `state===fresh`、`binding.seq===当前 seq`、
      输入归属校验、置 `consumed`；原子性由 Worker 单线程保证，并发同序号提交只能有一个成功。
- [ ] `binding.seq < 当前 seq` → 拒绝（`snapshot-stale`），要求重新读快照、重新组合；
      v1 不做"输入仍在就放行"的宽松判断。
- [ ] 交易花了钱包 P2PKH UTXO（输入命中当前快照）却没带 binding → 拒绝（`snapshot-binding-required`）。
- [ ] 命中快照的输入若 `isSpentInMempoolTx=true` 或已不在当前快照 → 拒绝（`snapshot-input-invalid`）。
- [ ] 交易完全不花钱包 P2PKH UTXO（例如纯代币 UTXO）→ 不要求序号，走其原有保护机制。
- [ ] 成功消费后：`get` 返回 `state="consumed"` 且 `items` 为空（拿不到 UTXO）；
      任何新提交一律拒绝（`snapshot-consumed`）。
- [ ] 消费后的**唯一解封路径**：一次在该消费之后发起、且内容发生变化的成功刷新 → 新序号、`state="fresh"`。
      内容未变的刷新、刷新失败都**不能**解封。
- [ ] 广播前发出的在途刷新，返回后不得覆盖/解封消费状态（消费使在途刷新作废）。
- [ ] 广播结果未知（`isolated`）时不得自动重试、不得用超时 TTL 解封。
- [ ] 广播被判定为"确定未派发"（provider 不存在、payload 非法、会话失效、门禁拒绝）→ 不消费，序号保持可用。
- [ ] 本地 input claim 保留为第二道防线（持久化），覆盖"新快照内容已变但被花输入仍未消失"的窗口。

### 3.3 重试红线与预算

- [ ] 只有**确定未派发**的失败允许自动重试；`isolated`（可能已广播）必须立即停止。
- [ ] 重试预算（已定）：最多 5 次（含第一次）、总时长不超过 2 分钟；退避
      `1s → 2s → 4s（上限 5s）+ 抖动`，收到新序号事件可提前唤醒。
- [ ] 每次重试都是完整重来：重新刷新、新序号、重新选币、重新签名、新 `submissionId`、新 claims。
- [ ] 重试前必须确认上一次尝试的本地 submission/claims 已释放，否则不得进入下一轮。
- [ ] 终态停止条件：余额不够 / 无可用 UTXO / 地址金额非法 / 钱包锁定 / owner 变更 /
      用户取消 / 超出重试预算。
- [ ] `sendAll`（全部）不自动重试：金额会随余额变化，必须让用户重新确认（`requires-reconfirm`）。
- [ ] 超时停止与余额不足必须区分：超时提示"上一笔交易状态未确认"，不得报"余额不足"。
- [ ] 重试可能改变输入与找零，但收款地址与金额（非 sendAll）不变；`sendAll` 金额变化必须重新确认。

### 3.4 广播出口

- [ ] 唯一物理出口：Coordinator Worker 内的 `provider.broadcast`；页面/插件 realm 拿不到 provider。
- [ ] `p2pkh.broadcast` 从插件可见的 `P2pkhCoordinatorControl` 中移除，只由装配层注入给中心广播服务。
- [ ] `WocService.broadcast` 不再出现在插件可见的 WOC 能力上（拆成只读契约）；Worker 内部保留完整句柄。
- [ ] `ProtocolSpendService` 不再依赖 `woc.broadcast`，改为经由中心广播服务提交。
- [ ] 门禁兜底：即使有人拿到 Worker 广播 RPC，不带合法 binding 也一律拒绝——靠机制，不靠约定。
- [ ] 中心广播服务是插件/页面/三方**唯一**能拿到的广播能力；不提供第二种调用方式。

### 3.5 事件

- [ ] 复用 `asset.data-changed` topic，不新增 Coordinator topic。
- [ ] 事件新增可选字段 `utxoSeqs`：按网络给出最新序号；没有可信快照的网络省略。
- [ ] v1 **事件不携带清单状态**（可用/已作废），也不携带消费交易号；状态只存在于快照 RPC 结果。
- [ ] 同一 provider+owner 的微任务合并：`utxoSeqs` 各网络取最大序号（单调不回退）。
- [ ] 事件 revision 由现有 client 保证单调；旧 Worker / 乱序事件不得覆盖新序号。
- [ ] 发布点必须携带 `utxoSeqs`：手动刷新成功、后台快照任务刷新成功、广播后刷新成功。
      历史同步、提交/claim 变更等不产生新版本的事件不携带。

### 3.6 兼容与分层

- [ ] apps 现有 API 不变：转账仍是 `prepareTransfer / submitTransfer`，
      代币仍是 `protocolSpend.prepare / submit`；重试与 rebuild 对 apps 不可见。
- [ ] 中心广播服务不感知交易类型，只处理 `{ txid, rawTxHex, utxoBinding, resourceId }`。
- [ ] 业务服务（转账、协议花费）向中心广播服务注册"一次完整尝试"，只有业务知道怎么重新组合。
- [ ] 重启后没有内存快照：必须先成功刷新取得新序号才能组合；旧 preview 因会话/序号不一致被拒绝。

## 4. 数据模型（contracts）

### 4.1 快照结果（`packages/contracts/src/bsvP2pkhProviders.ts`）

```ts
/** 快照状态（只在快照级记录，不记录每张钞票的状态）。 */
export type P2pkhUtxoSnapshotState =
  | "fresh"       // 可用于新的组合与提交
  | "consumed"    // 已被一次提交消费，等待同步；不可读、不可提交
  | "unavailable"; // 尚无可信快照（冷启动 / 刷新失败后保留旧数据的对外表现）

export interface P2pkhUtxoSnapshotResult {
  /** 是否有可信且可用的快照数据；consumed / unavailable 时为 false。 */
  available: boolean;
  /** 快照序号（版本号）：同一资源内严格递增；内容不变则保持不变。 */
  seq?: number;
  /** 快照状态；旧快照在刷新失败时仍以旧 seq + 旧状态对外，只是 available=false。 */
  state: P2pkhUtxoSnapshotState;
  /** 最近一次成功同步时间（ISO 8601）。 */
  syncedAt?: string;
  /** UTXO 列表；consumed / unavailable 时必须为空数组。 */
  items: P2pkhUtxoSnapshotItem[];
}
```

- `get`：`fresh` 返回完整 items；`consumed` / `unavailable` 返回 `available:false`、`items:[]`，
  不抛 RPC 错误，让 UI 能显示"正在同步，请稍候"而不是错误弹窗。
- `refresh`：
  - 未消费 + 内容同 → `fresh`，旧 seq；
  - 未消费 + 内容变 → `fresh`，新 seq；
  - 已消费 + 内容同 → `consumed`，保持；
  - 已消费 + 内容变 → `fresh`，新 seq（解封）；
  - 请求失败 → RPC error，保留旧快照与状态，绝不清零。

### 4.2 序号绑定

```ts
/** 组合交易时捕获的 UTXO 快照版本绑定。 */
export interface P2pkhUtxoBinding {
  /** 资源 ID：主网 p2pkh:main，测试网 p2pkh:test。 */
  resourceId: string;
  /** 组合时看到的快照序号；提交时必须在 Worker 出口与当前序号一致。 */
  seq: number;
}
```

- `P2pkhTransferPreview` 增加 `utxoBinding?: P2pkhUtxoBinding`（随快照刷新结果一起捕获，
  测试夹具可省略）与 `previewId: string`（本次准备的内存标识，用于区分每一轮提交）。
  重试所需的原始输入直接取自 preview 字段（金额/收款人/费率），不额外维护 intent 缓存。
- `ProtocolSpendPreview` 增加 `utxoSeq?: number`（该次准备捕获的序号；无 P2PKH 输入时可省略）。

### 4.3 广播请求与结果

`P2pkhBroadcastSubmission` 增加：

```ts
/** 组合阶段捕获的序号绑定；花了钱包 P2PKH UTXO 时必填。 */
readonly utxoBinding?: P2pkhUtxoBinding;
```

`CoordinatorP2pkhBroadcastResult` 的 `not-dispatched` 原因扩展：

```ts
{
  status: "not-dispatched";
  reason:
    | "stale-provider-generation"
    | "broadcast-provider-unavailable"
    | "coordinator-not-dispatched"
    | "stale-session-epoch"
    | "snapshot-stale"           // 序号与当前不一致（内容已变），需重新组合
    | "snapshot-consumed"        // 快照已被消费，等待同步
    | "snapshot-binding-required" // 花了钱包 P2PKH UTXO 却没带序号
    | "snapshot-input-invalid";  // 输入已不在快照或已标记 mempool 花掉
  /** 当前快照序号；仅 snapshot-stale / snapshot-consumed 携带，便于立即重试。 */
  currentSeq?: number;
}
```

### 4.4 事件字段

`AssetDataInvalidationEvent`（runtime notifier）与 `AssetDataChangedEvent`（Coordinator topic）同步增加：

```ts
/**
 * P2PKH 快照序号表：按网络给出最新序号。
 * 中文：main=主网，test=测试网；没有可信快照的网络省略该键。
 * v1 不携带清单状态（可用/已作废），消费方只用它判断"是否出现了新版本"。
 */
utxoSeqs?: { main?: number; test?: number };
```

### 4.5 页面侧中心广播服务（新增 contracts）

```ts
/** 唯一广播入口能力；插件/页面/三方只能拿到本能力，不能拿到 Worker RPC。 */
export const CENTRAL_BROADCAST_CAPABILITY = defineCapability<CentralBroadcastService>({
  kind: "local",
  id: "tx.broadcast",
  version: "1",
});

/** 一次提交的输入。 */
export interface OneShotBroadcastInput {
  /** 所有者压缩公钥 hex（小写）。 */
  ownerPublicKeyHex: string;
  /** 网络：主网 main / 测试网 test。 */
  network: BsvNetwork;
  /** 本地提交 ID（每次尝试都必须新生成）。 */
  submissionId: string;
  /** 资源 ID：p2pkh:main / p2pkh:test。 */
  resourceId: string;
  /** 交易 ID（64 位小写 hex）。 */
  txid: string;
  /** 已签名原始交易 hex。 */
  rawTxHex: string;
  /** 组合阶段捕获的序号绑定；花了钱包 P2PKH UTXO 时必须提供。 */
  utxoBinding?: P2pkhUtxoBinding;
}

/** 广播终态。 */
export interface BroadcastOutcome {
  /** local-confirmed=已确定广播；isolated=结果未知（绝不重试）；failed=确定未派发且已停止重试。 */
  status: "local-confirmed" | "isolated" | "failed";
  /** 交易 ID。 */
  txid?: string;
  /** 原始交易 hex。 */
  rawTxHex?: string;
  /** 已尝试次数（含第一次）。 */
  attempts: number;
  /** 终止原因（中文含义见 CentralBroadcastFailureReason）。 */
  reason?: CentralBroadcastFailureReason;
  /** 最近一次错误的可读文本，仅用于诊断，不作为逻辑判断依据。 */
  error?: string;
}

export interface CentralBroadcastService {
  /** 单次提交（不重试）；业务服务内部使用，apps 不直接调用。 */
  submitOnce(input: OneShotBroadcastInput): Promise<CoordinatorP2pkhBroadcastResult>;

  /**
   * 自动重试提交。
   * - 业务提供"一次完整尝试"闭包：重新读快照 → 组合签名 → 写本地记录 → 调用闭包参数里的 submitOnce；
   * - 中心服务负责等新序号、按预算重试、判定终态；
   * - 闭包拿不到独立广播句柄，apps 也拿不到本能力。
   */
  submitWithRetry(input: {
    /** 序号下界：只有出现大于它的新序号才会重试（首次尝试不等待）。 */
    boundSeq?: number;
    /** 一次完整尝试；返回单次提交结果。 */
    attempt: (context: {
      submitOnce: (input: OneShotBroadcastInput) => Promise<CoordinatorP2pkhBroadcastResult>;
    }) => Promise<{ submissionId: string; result: CoordinatorP2pkhBroadcastResult }>;
    /** 取消信号：锁钱包、切 owner、用户取消。 */
    signal?: AbortSignal;
  }): Promise<BroadcastOutcome>;
}
```

### 4.6 转账失败原因（`plugin-p2pkh`）

```ts
/** 广播重试的终止原因（机器可判，UI 映射成中文文案）；定义在 contracts。 */
export type CentralBroadcastFailureReason =
  | "insufficient"         // 余额不足（金额 + 矿工费）
  | "no-utxos"             // 没有可用 UTXO
  | "policy-denied"        // 地址 / 金额 / 设置 / 网络校验失败
  | "snapshot-timeout"     // 等待新快照超过预算，上一笔状态未确认
  | "snapshot-binding"     // 序号绑定非法（程序错误）
  | "rebuild-unavailable"  // 无法自动重建（prepare 输入已丢失，如页面刷新）
  | "requires-reconfirm"   // sendAll 金额已变化，需要用户重新确认
  | "isolated"             // 广播结果未知，绝不自动重试
  | "cancelled";           // 用户取消 / 锁钱包 / 切 owner
```

`P2pkhTransferResult` 增加 `attempts: number`（已尝试次数）与
`reason?: CentralBroadcastFailureReason`（终态原因），现有 `status`
（`local-confirmed / isolated / not-dispatched`）保持不变。

## 5. 状态机与 Worker 出口

### 5.1 快照状态机

```text
EMPTY ──refresh(有内容)──▶ FRESH(seq=发号)
FRESH ──refresh(内容同)──▶ FRESH(seq 不变)
FRESH ──refresh(内容变)──▶ FRESH(newSeq)
FRESH ──submit(binding.seq 相等)──▶ CONSUMED(seq)   ← 原子：核对 + 消费，无 await
FRESH ──submit(seq 不等 / 未带 / 输入非法)──▶ 拒绝，状态不变
CONSUMED ──get──▶ state=consumed，items 为空（拿不到 UTXO）
CONSUMED ──submit(任意)──▶ 拒绝
CONSUMED ──refresh(内容同)──▶ 保持 CONSUMED
CONSUMED ──refresh(内容变)──▶ FRESH(newSeq)          ← 唯一解封路径
CONSUMED ──交易同步判定链上没有这笔（超时后）──▶ FRESH(seq 不变，复用旧序号)
任意 ──锁钱包 / 切 owner / Worker 重启──▶ EMPTY
```

### 5.2 Worker 出口算法

```text
输入：ownerPublicKeyHex、network、rawTxHex、utxoBinding?
1. 解析交易，得到 inputs（outpoint 列表）
2. 取该 owner + network 的内存快照 snapshot
3. touched = inputs ∩ snapshot.items
4. touched 为空：不要求序号 → 写审计 → 广播（纯代币 UTXO 路径）
5. touched 非空：
   a. binding 缺失或 resourceId 不匹配 → not-dispatched: snapshot-binding-required
   b. snapshot.state !== "fresh" → not-dispatched: snapshot-consumed（带 currentSeq）
   c. binding.seq !== snapshot.seq → not-dispatched: snapshot-stale（带 currentSeq）
   d. touched 中存在 isSpentInMempoolTx=true → not-dispatched: snapshot-input-invalid
   e. 全部通过 → 同 tick 内置 CONSUMED（记录 consumedByTxid / consumedAt）→ 写审计 → provider.broadcast
6. 广播返回：
   - accepted / already-known → local-confirmed，并触发一次后台刷新
   - isolated（超时/网络异常）→ isolated，保持 CONSUMED
   - 明确未派发（provider 缺失、payload 非法、会话失效）→ 不消费，回滚本地记录
```

### 5.3 自动解封（已定）

- 对处于 CONSUMED 的资源，Worker 在同步任务里对 `consumedByTxid` 调用
  `WocService.getTransactionObservation`：
  - 返回 `confirmed` / `unconfirmed` → 保持 CONSUMED，等 `unspent/all` 内容变化自然解封；
  - 返回 `undefined` 且距 `consumedAt` 已超过阈值（建议 10 分钟）→ 判定交易被丢弃，
    清除 CONSUMED、**复用旧序号**（内容没变），发布一次带 `utxoSeqs` 的事件。
- 该检查只做 WoC 只读观察，不产生广播；失败不影响快照状态。

## 6. 中心广播服务与自动重试

### 6.1 分层

```text
apps（页面 / 代币插件 / 三方）
  └─ 只调业务 API：transfer.prepare/submit、protocolSpend.prepare/submit（签名不变）
业务服务（p2pkhTransferService / p2pkhProtocolSpendService）
  └─ 向中心广播服务提供"一次完整尝试"（内含重新选币、签名、写 claims）
中心广播服务（唯一广播能力，能力 id tx.broadcast）
  ├─ 页面实例（plugin-p2pkh window unit）：订阅 asset.data-changed.utxoSeqs 唤醒
  └─ Worker 实例（SatSubscription）：订阅 Worker 本地序号通知唤醒
Coordinator Worker（唯一物理出口）
  └─ 序号门禁（核对+消费）→ 审计 write-ahead → provider.broadcast → WoC
```

- 页面 side 与 Worker side 各装配一份中心广播服务实例，共用同一套重试/唤醒语义；
  Worker 实例只服务 Worker 内调用方（SatSubscription），不新增 capability、不跨 realm。
- 关闭页面后：页面发起的重试停止；Worker 内 SatSubscription 的重试在 Worker 存活期间继续。
- 中心广播服务放在 `plugin-p2pkh`（快照、协议花费、能力都在此）；将来需要多链/多资产时再上移 runtime。

### 6.2 重试循环

```text
attempts = 0; boundSeq = 业务给的初值
deadline = now + 2 分钟
loop:
  attempts += 1
  { submissionId, result } = await business.attempt(submitOnce)
  if result.local-confirmed → 返回成功（含 attempts）
  if result.isolated        → 立即返回 isolated（红线：绝不重试）
  if result.reason 属于终态  → 立即返回失败（含原因）
  if attempts >= 5 或 now > deadline → 返回 failed: snapshot-timeout
  if result.currentSeq > boundSeq → 立即进入下一轮（fast path）
  else await 事件唤醒（utxoSeqs[network] > boundSeq）或退避超时
  boundSeq = max(boundSeq, result.currentSeq ?? boundSeq)
```

- **首次尝试提交用户已确认的 preview 本身，不重新组合**（preview 是最终承诺对象）；只有可重试失败后的
  下一轮才按原始输入重新读快照、重新选币、重新签名。
- 每次尝试由业务闭包负责：写 claims / 本地 submission；被判定未派发时由闭包自己回滚（释放 claims、
  abort submission），中心服务只做调度与判定。
- 收到事件但序号未变大 → 忽略，继续等；事件缺失时按退避主动 `p2pkhUtxosRefresh` 探测。
- 已消费资源的 `refresh` 返回 `state=consumed`，中心服务将其视为"继续等待"，不是错误。
- 业务重建时快照仍不可用（consumed / 刷新失败）→ 抛类型化可重试错误，中心服务**不消耗尝试次数**，
  等 fresh 快照后继续。

### 6.3 结果分类

| 单次结果 | 中文 | 处置 |
| --- | --- | --- |
| `snapshot-stale` | 序号已过期（内容变了） | 可重试：等新序号后重新组合 |
| `snapshot-consumed` | 快照已被消费 | 可重试：等新序号 |
| `snapshot-binding-required` | 花了钱包 P2PKH 却没带序号 | 终态：程序错误（`snapshot-binding`） |
| `snapshot-input-invalid` | 输入已不在快照 / 已 mempool 花掉 | 终态：程序错误（`snapshot-binding`） |
| `broadcast-provider-unavailable` | 广播通道不可用 | 可重试：退避 |
| `coordinator-not-dispatched` / 传输未派发 | 确定未发出 | 可重试 |
| `stale-session-epoch` / `stale-provider-generation` | 会话 / 通道已变化 | 终态：`cancelled` |
| 余额不足 / 无 UTXO / 校验失败 | 边界不满足 | 终态：对应 `reason` |
| `isolated` | 结果未知（可能已广播） | 终态：`isolated`，绝不重试 |
| `local-confirmed` | 确定广播成功 | 成功 |

### 6.4 apps 用法不变

| 调用方 | 现在用法 | 本单后 |
| --- | --- | --- |
| 转账页 / sat-subscription | `prepareTransfer` + `submitTransfer` | 签名不变；`submit` 内部自动重试 |
| BSV-21 / STAS / 1Sat | `protocolSpend.prepare` + `submit` | 签名不变；v1 纳入序号门禁与中心出口，自动重试后续（§11） |
| 三方自建交易 | 直接调 `woc.broadcast` | 改为只拿 `CENTRAL_BROADCAST_CAPABILITY`；单次提交，失败报错 |

## 7. 触发时机

| 触发 | 位置 | 动作 |
| --- | --- | --- |
| 手动刷新 `p2pkhUtxosRefresh` 成功 | Worker handler | 事件携带该网络新 `utxoSeqs` |
| `p2pkh.utxo-snapshot` 任务刷新成功 | Worker 任务 | 事件携带各成功网络 `utxoSeqs`（需让刷新函数返回结果） |
| 广播成功后的自动刷新 | Worker 广播 handler | 刷新完成并产生新序号时补发带 `utxoSeqs` 的事件 |
| 提交消费序号 | Worker 广播 handler | 不单独发事件（v1），下一次内容变化刷新会发新序号 |
| 自动解封（判定 dropped） | Worker 同步任务 | 发布带当前序号的事件，通知等待方可以重试 |
| Worker 内快照刷新成功 | Worker `publishTopicEvent` | 除 topic 事件外，额外触发 Worker 本地序号通知，唤醒 SatSubscription 重试 |
| 历史同步 / 提交状态变更 | Worker | 沿用现有事件，不携带 `utxoSeqs` |
| 锁钱包 / 切 owner / 重启 | keyspace/session 事件 | 快照清空；页面丢弃旧 preview |

## 8. 主要代码范围

- `packages/contracts/src/bsvP2pkhProviders.ts`：快照结果 `seq/state`；`P2pkhUtxoBinding`；
  `P2pkhBroadcastSubmission.utxoBinding`。
- `packages/contracts/src/sessionCoordinator.ts`：广播请求字段；结果新增 not-dispatched 原因；
  `AssetDataChangedEvent.utxoSeqs`；`P2pkhCoordinatorControl` 移除 `p2pkhBroadcast`；
  新增（私有）广播出口接口。
- `packages/contracts/src/assets.ts`：`AssetDataInvalidationEvent.utxoSeqs`。
- `packages/contracts/src/sessionCoordinatorRuntime.ts`：请求 / 结果 / 事件 parser 同步。
- `packages/contracts/src/woc.ts`：拆分只读 `WocService` 与 Worker 内部广播出口。
- `packages/contracts/src/protocolSpend.ts`：`ProtocolSpendPreview.utxoSeq`。
- `packages/contracts/src/broadcast.ts`（新增）：`CENTRAL_BROADCAST_CAPABILITY`、
  `CentralBroadcastService`、`BroadcastOutcome`、`OneShotBroadcastInput`。
- `packages/plugin-p2pkh/src/p2pkhUtxoSnapshot.ts`：发号器、内容比较、`state`、消费、
  在途刷新失效；`refresh/get` 返回新字段。
- `packages/plugin-p2pkh/src/p2pkhService.ts`：`loadSpendableUtxos` 返回 seq/state；
  prepare 写入 binding；submit 走中心服务重试（首次提交 preview，重试按 preview 字段重建）；
  余额/列表在 consumed 时显示未知。
- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`：preview 绑定；闭包式尝试；
  `P2pkhTransferResult.attempts/reason`。
- `packages/plugin-p2pkh/src/p2pkhProtocolSpend.ts`：prepare 捕获 seq、校验输入归属；
  submit 改走中心服务，移除 `woc.broadcast`。
- `packages/plugin-p2pkh/src/manifest.ts`：提供中心广播能力；协议花费依赖改为中心服务；
  不再把广播出口暴露给其他插件。
- `apps/web/src/keymasterSessionCoordinator.worker.ts`：快照 store 接线；
  广播门禁（核对+消费+输入归属）；事件补 `utxoSeqs`；自动解封检查；
  Worker 内中心广播服务实例（SatSubscription）+ Worker 本地序号通知；
  快照 store 的 WoC 数据源包装（测试可替换 `unspent/all`）。
- `apps/web/src/keymasterSessionCoordinatorClient.ts`：无需改动——请求/响应与
  `utxoSeqs` 事件校验都在 contracts 的生产 parser 内完成，broadcast submission 原样透传。
- `packages/plugin-woc/src/`：插件可见契约去掉 `broadcast`；Worker 内部保留；
  Provider 适配器透传 `providerReturnedTxid* / txidIntegrity`（保留 txid 保真诊断）。
- 代币插件（`plugin-token-bsv21` / `plugin-token-stas` / `plugin-collectible-1satordinals`）：
  预期不改业务代码，只随协议花费自动获得序号门禁；测试同步更新。
- 测试：`p2pkhUtxoSnapshot.test.ts`、`p2pkhTransferService.test.ts`、`p2pkhProtocolSpend.test.ts`、
  `p2pkhService.test.ts`、`sessionCoordinatorRuntime.test.ts`、worker 门禁用例、e2e 连打场景。

## 9. 自动化验证矩阵

| ID | 场景 | 通过标准 |
| --- | --- | --- |
| T01 | 连续两次同步内容完全一致 | `seq` 相同；只更新 `syncedAt` |
| T02 | 同步内容变化（多/少/状态翻转） | 新 `seq` 严格递增；会话内不同快照序号不重复 |
| T03 | consumed 期间 `get` | `available=false`、`state=consumed`、`items=[]`，不显示 0 |
| T04 | consumed 期间提交 | 拒绝 `snapshot-consumed`，不调用 provider |
| T05 | consumed + 内容相同的刷新 | 保持 consumed，不解封 |
| T06 | consumed + 内容变化的刷新 | 解封，`state=fresh`、新 `seq` |
| T07 | 广播前在途刷新晚到 | 不得覆盖/解封 consumed |
| T08 | 并发两个同序号提交 | 恰好一个成功消费并广播，另一个被拒 |
| T09 | 提交 `binding.seq` 小于当前 | 拒绝 `snapshot-stale`，带 `currentSeq`，不广播 |
| T10 | 花了钱包 P2PKH 但未带 binding | 拒绝 `snapshot-binding-required` |
| T11 | 纯代币 UTXO 交易不带序号 | 放行（不触发 P2PKH 门禁） |
| T12 | 广播前失败（provider 缺失 / payload 非法） | 不消费，序号仍 fresh，claims 已回滚 |
| T13 | A/B 连打，余额足够 | 都在预算内成功；A/B 的 attempts 均为 1（B 无需重试）或 B 重试后成功 |
| T14 | A/B 连打，余额只够一笔 | A 成功；B 重试后 `insufficient` 终态并停止 |
| T15 | 某次尝试返回 isolated | 立即停止，provider 只被调用一次，reason=`isolated` |
| T16 | 重试预算 | 最多 5 次 / 2 分钟；超时原因 `snapshot-timeout`，不是 `insufficient` |
| T17 | `sendAll` 遇 stale | 不自动重试，`requires-reconfirm` |
| T18 | 事件 `utxoSeqs` | 携带各网络新序号；旧序号/乱序事件被忽略 |
| T19 | 自动解封 | 超时后 observation=undefined → 解封（序号复用）；unconfirmed/confirmed → 保持 |
| T20 | 插件可见面 | 全库不存在插件直接调用 `woc.broadcast` / `p2pkhBroadcast` 的路径 |
| T21 | 代币 gas | BSV-21 转账的 P2PKH 输入导致对应资源 consumed |
| T22 | apps API 兼容 | `prepare/submit` 签名不变；三方只拿到中心广播能力也能提交 |
| T23 | 锁钱包 / 切 owner | 重试立即取消，旧 preview 拒绝，不产生第二轮广播 |
| T24 | 代币 gas 门禁拒绝（deterministic not-dispatched） | 立刻释放 protected/本地 claims，按 `rejected` 收口，不写成 unknown |
| T25 | 带 binding 但输入全不在快照 | 拒绝 `snapshot-input-invalid`，不放行为"纯代币"交易 |
| T26 | Worker 内 SatSubscription 连打 | A 成功后快照内容变化；B 自动重试并成功（attempts=2），provider 只广播两次 |

## 10. 发布门禁

```bash
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm build
```

- [ ] T01～T26 有自动化结果；
- [ ] 全库 grep 确认：不存在绕过中心广播服务的广播调用；不存在插件可见的 `woc.broadcast`；
- [ ] 不通过放宽断言或保留旧广播路径让测试变绿；
- [ ] 字段中文说明齐全，错误文案含"正在同步，请稍候"与"上一笔交易状态未确认"两类区分；
- [ ] `docs/P2PKH.md` 的「转账边界 / 本地交易 / 安全边界」按本单更新（提交前刷新改为序号门禁）。

### 实施证据（2026-09-21）

- `p2pkhUtxoSnapshot.test.ts`：T01～T12（序号复用/变化、consumed 语义、在途刷新、
  并发消费、绑定校验、输入失效、回滚消费、丢弃解封、观察失败不解封）。
- `centralBroadcastService.test.ts`：T13～T17（新序号才重试、isolated 立即停止、预算耗尽、
  同序号解封重试、可重试错误不消耗次数、取消等待）。
- `p2pkhTransferService.test.ts`：sendAll 可重试失败后不再重建（`requires-reconfirm`）+ 旧路径兼容。
- `p2pkhProtocolSpend.test.ts`：T24（门禁拒绝立即释放 protected/本地 claims 并按 rejected 收口）。
- `broadcast.test.ts`（新增）：HTTP 4xx / 超时 / 网络一律按“结果未知”，只有结构化标记或
  节点明确拒绝交易本体才允许回滚。
- `sessionCoordinatorRuntime.test.ts`：T18（`asset.data-changed.utxoSeqs` 解析与非法值拒绝）。
- `keymasterSessionCoordinator.worker.test.ts`：T26（Worker 内 SatSubscription 连打自动重试）
  以及既有门禁用例（provider 缺失 not-dispatched、provider 失败 isolated、claims 保留、payload 校验）。
- 仍缺自动化：T20 广播出口 grep 门禁（靠 `lint:boundaries` + 人工 grep）、T21 代币 gas 的
  Worker 级集成用例（机制由快照 store 单测 + T26 门禁消费覆盖）、T22 的 API 兼容属类型层、
  T23 锁仓中断 Worker 重试的时序；`keymasterHostAdapter` 的 `utxoSeqs` 合并无单测。

## 11. 非目标

- 不做钞票级状态管理（逐币分配、预拆分、逐币通知）；
- 事件不携带清单状态 / 消费交易号（v1 已定）；
- 不做代币路径的自动重试（gas 需要重选，v1 只做序号门禁与中心出口；自动重试列 v1.5）；
- 不做"页面关闭后继续重试"（需要数据化计划 + Worker 重建，方案乙）；
- 不做 sendAll 自动重试；
- 不改 UTXO 数据源、历史同步与余额广播带值（后者属 002）；
- 不做多链 / 多资产广播协议抽象。

## 12. 开放风险与待确认决策

### 12.1 已定决策（本轮实施）

1. **中心广播能力归属**：v1 放 `plugin-p2pkh`；Worker 内 SatSubscription 装配第二份实例，
   不新增 capability、不跨 realm。
2. **三方自建交易**：v1 只提供单次提交（失败报错，不重试）；要自动重试必须用我们的
   业务服务或提供"一次完整尝试"闭包。
3. **页面刷新后重试信息丢失**：preview 在内存中，页面刷新即丢失；首次提交不重组合，
   重试由业务服务重新 prepare，不存在需要用户处理的 `rebuild-unavailable` 路径。
4. **自动解封阈值**：10 分钟（`consumedAt` 起算）；`getTransactionObservation`
   返回 `undefined` 才解封。

### 12.2 风险

1. **与 002 的改动重叠**：002（未实施）与 003 都改 `p2pkhService` / worker 事件 /
   运行时 parser。建议先落 003（资金安全），002 在其上叠加；实施顺序需明确。
2. **consumed 窗口的余额显示**：按设计会短暂显示"未知/同步中"（可能 1～3 秒）。
   需确认 UI 文案与"余额不足"提示区分清楚。
3. **自动解封依赖 WoC 观察**：若 WoC 长时间对已丢弃交易返回 `unconfirmed`（罕见），
   consumed 不会自动解除，需要手动"强制重新同步"兜底（v1 可先不做，记录在案）。
4. **`sendAll` 重试语义**：不自动重试意味着用户在余额变化后必须重新确认一次；
   体验变慢，但避免"金额悄悄变小"。
5. **协议花费的自动重试**：gas 重选需要调用方（BSV-21 等）配合，v1 只保证门禁与
   中心出口；撞车时代币交易会失败一次，用户重试即可。

## 13. 交付物

- 本设计文档（状态：已实施；含 Worker 内中心广播实例）。
- contracts：快照序号/状态、绑定、广播请求结果、事件 `utxoSeqs`、中心广播能力。
- plugin-p2pkh：序号发号与消费、转账绑定与重试、协议花费接入中心出口。
- Worker：广播门禁、事件发布、自动解封检查、出口收口。
- 插件可见面的广播收口（`WocService.broadcast` / `p2pkhBroadcast` 不再暴露）。
- T01～T26 验证证据与发布门禁记录。
