# 002 同浏览器多标签共享 Vault 会话与唯一同步协调器硬切换一次性迭代施工单

## 0. 决策、范围与优先级

本单把同一浏览器 profile、同一 origin 下所有 **Keymaster 主页面 tab** 的 Vault 解锁状态与后台同步，硬切换为一个 `SharedWorker` 中的单一运行时：

```text
Keymaster tab A ─┐
Keymaster tab B ─┼─ MessagePort RPC ─> Keymaster Session Coordinator SharedWorker
Keymaster tab C ─┘                         ├─ 唯一 Vault 解锁会话 / active key / 私钥内存
                                            ├─ 唯一 keyspace 真值
                                            ├─ 唯一后台任务队列、定时器与执行器
                                            └─ 唯一任务快照与 sessionEpoch
                                                        │
                                                        └─ IndexedDB 原子提交 -> data-changed 通知 -> tab 只读重绘
```

这是一次性**硬切换**，不是兼容层，也不是把现有 tab leader 选举再包一层。完成时不得保留“每个 tab 一份 Vault 会话 / 一份 BackgroundService / 一套 leader 选举”的生产路径。

本单优先于下列施工单中与多 tab 会话、background leader 或 Worker 生命周期相冲突的定义：

- `施工单/2026-07-17/001-vault-crypto-worker-session-hard-switch.md`
- `施工单/2026-07-17/002-unified-asset-background-sync-hard-switch.md`
- `施工单/2026-07-18/001-background-sync-two-actions-hard-switch.md`

前述施工单关于“私钥不进入页面 JS、页面零网络、provider DB snapshot 是数据真值、原子提交与 key generation 防迟到写入”的定义继续有效。

本单只覆盖 Keymaster 主页面的多 tab。独立 `appView` / protocol session 仍按其专属、显式授权的会话 Worker 运行，**不得**连接本单的 Keymaster coordinator，更不得继承主页面的全局解锁态或 active-key capability。

## 1. 简述缘由

现在的 `sessionCryptoWorker` 已将单把私钥放进 Worker 内存，但 `createSessionCryptoEngine()` 每次都 `new Worker()`；`vaultService`、`keyspaceService`、`BackgroundService` 和任务队列仍各自属于一个 tab。于是“锁定的 leader tab”与“已解锁的当前 tab”可以同时存在，系统只能靠 follower 本地执行、快照覆盖优先级、心跳和 mailbox 例外来止血。

这不符合产品语义：用户打开多个 Keymaster tab 时，期待的是同一个钱包会话、同一个锁定状态和同一轮同步，而不是多个近似一致的会话。同步一旦有多个执行者，还会重复拉取、并发写库、让状态和错误彼此覆盖。

正确的边界不是跨 tab 复制内存，而是让所有 tab 连接到同一个 SharedWorker。私钥只保留在这一份 Worker 内存中；同步执行器也在同一运行时，因此既不重复运行，也不需要将私钥、密码或“解锁 token”交给另一个 worker 或另一个 tab。

## 2. 最终模型与不可变约束

### 2.1 单一真值

Coordinator 内唯一保存如下运行时状态：

```ts
interface CoordinatorState {
  sessionEpoch: string;              // 每次解锁、锁定、Worker 重建均变更
  vaultStatus: "booting" | "uninitialized" | "locked" | "unlocked" | "fatal";
  activePublicKeyHex?: string;
  activePrivateKeyBytes?: Uint8Array; // 仅 Worker 内；锁定时覆盖清零
  passwordKey?: CryptoKey;            // 仅有明确受控操作确实需要时存在；不得在 tab 留存
  keyspaceGeneration: number;
  taskRuntimes: Map<string, TaskRuntime>;
  scheduleSettings: BackgroundSyncSettings;
}
```

`sessionEpoch` 是每个异步 RPC、任务执行、DB 提交与推送快照的世代栅栏。客户端请求须带其观察到的 epoch；Worker 在执行及提交前复验。epoch 不同则拒绝或丢弃旧结果，绝不可把锁定前/旧 active key 的结果写回当前会话。

页面侧的 `VaultService`、`KeyspaceService`、`BackgroundService` 都是连接 Coordinator 的 facade。它们可以有短暂 UI cache，但不得拥有独立状态真值、私钥、任务队列、timer 或网络执行权。

### 2.2 解锁、锁定、active key

- 任一 Keymaster tab 正确解锁后，Coordinator 创建新 epoch、在自身内存装入 active key，并向全部 port 发布 `vault.unlocked`；所有 tab 立即呈现 unlocked。
- 任一 tab 发起手动锁定、全局自动锁定、密码修改完成或 Coordinator 自检失败时，均是全局锁定：停止新 crypto/sync 请求，abort 所有 session-bound task，等待安全退出屏障，覆盖私钥 buffer、撤销 capability、清空 active key、递增 epoch，最后广播 `vault.locked`。
- active key 切换是 Coordinator 内的唯一事务，沿用“密码校验失败时旧 key 仍有效；开始不可逆提交后失败则收敛到全局 locked”的规则。成功后递增 epoch 与 keyspace generation，取消旧 key 的任务并广播新的 active key。
- 单个 tab 刷新、关闭、隐藏、失焦或 port 短暂沉默都**不是**锁定理由。最后一个 port 断开时 Worker 的生命周期结束即内存消失；若浏览器提前回收或重启 Worker，也必须按 locked 处理，禁止恢复为 unlocked。

### 2.3 同步

Coordinator 是所有后台同步任务唯一注册表、唯一 scheduler、唯一网络执行者、唯一进度/错误快照来源。任务 handler 必须是 Worker 可运行模块：不得依赖 `window`、DOM、React、页面 MessageBus handler 或某个 tab 的内存 service。

所有 Keymaster tab 只可以：订阅任务快照、调用 `runNow(taskId)` / `cancel(taskId)`、读取本地 DB。`runNow` 返回明确接收结果（`accepted`、`already-running`、`blocked`、`rejected-stale-epoch`），随后由统一 snapshot 展示 queued/running/blocked/idle；不得 fire-and-forget 后由页面猜测。

当前 DB 原子提交与 data-changed 规则继续保留。Coordinator 成功提交后向连接的 tab 发布无敏感数据的失效通知；tab 重新读取 DB。跨 tab 不再以 `BroadcastChannel` 作为任务状态、操作投递或 leader 身份通道。

### 2.4 连接、授权和数据边界

- Coordinator 使用固定名字和固定 module URL，例如 `keymaster.session-coordinator.v1`；同 origin 的 Keymaster 主页面建立 `SharedWorker` 后对 `port.start()`、`hello`、`subscribe` 完成握手。
- RPC 必须有 `clientId`、`requestId`、`expectedSessionEpoch` 与 discriminated `kind`；response 包含 `sessionEpoch`。所有推送是明确 event，不与 request response 混用。
- Worker 对每个 port 保留订阅集合与客户端生命周期，不把 port 当作“拥有 Vault”的主体；关闭一个 port 只释放其订阅与待处理 UI 请求。
- 私钥 bytes、密码字符串、`CryptoKey`、可复用解锁 token、签名原料或完整资产数据不得通过 BroadcastChannel、localStorage、sessionStorage、IndexedDB、日志、URL 或普通状态推送传递。解锁请求的密码只从发起 tab 的 UI 通过一次 RPC 输入，成功后立即由 tab 清空；私钥永不离开 Worker。
- 同源 XSS 不是 Worker 能独立解决的威胁。现有 Protocol/appView 的 origin 授权、用户确认、session binding 与 operation capability 必须继续在 Coordinator 的受控 operation 层校验；不得因为“所有主 tab 已解锁”而扩大 app 或网页签名权限。

## 3. 明确禁止项

完成后，生产代码不得存在以下设计或降级路径：

1. `new Worker("sessionCryptoWorker")` 为每个 Keymaster tab 建独立 crypto session，或 `VaultService` 自己保存 `vaultSession` / active crypto / password key。
2. `navigator.locks`、BroadcastChannel、localStorage mailbox 或 tabId 选举用于决定 BackgroundService 的唯一执行者；`background.leader`、leader heartbeat、follower action 转发、leader snapshot merge 必须删除。
3. 锁定 leader 时让已解锁 follower “例外本地执行”的补丁；共享会话下不存在 unlock 不一致的 leader/follower。
4. 将 Vault 和 sync 做成两个隔离 SharedWorker，再经 tab、BroadcastChannel 或 storage 传递解锁态、私钥、密码 key 或可复用 session token。两者必须处在**同一个** Coordinator 运行时；内部模块可拆分，内存边界不可拆分。
5. 为不支持 `SharedWorker` 的浏览器回退到多 tab 独立 Vault 或多个同步执行者。运行环境不支持时应用必须 fail closed 并显示“此浏览器不支持共享钱包会话”，不允许悄悄降级破坏安全/一致性。
6. 页面、widget、provider read API 直接 fetch/WOC、创建 timer、执行同步，或把完整 DB 内容塞进 Worker 推送消息。
7. port 断开时调用全局 `lock()`；用 visibility、focus、单 tab heartbeat 超时判定全局会话死亡；把任一普通 tab 的 `dispose()` 映射为清零 Worker。
8. Worker 重启后从 IndexedDB/localStorage 恢复已解锁状态，或持久化密码/私钥/解锁 token。

## 4. 特殊情况与预定处理

| 情况 | 规定处理 |
|---|---|
| 两个 tab 同时解锁 | Coordinator 将 unlock 串行化；第一个成功者创建 epoch，第二个完成前发现 epoch 已改变则返回 `already-unlocked`（不得再初始化或替换私钥）。密码输入立即清空。 |
| 一个 tab 锁定，另一个 tab 正在同步/签名 | 先停止接收新 operation，abort session-bound task；正在执行的 handler 在 abort 与 epoch 栅栏处退出。任何迟到 response/DB commit 都因 epoch 不匹配丢弃；之后清零并广播 locked。 |
| 一个 tab 关闭/刷新 | 仅断开该 port 和拒绝其未完成 UI response；不锁 Vault、不取消全局同步。仍有其他 port 时会话与任务继续。 |
| 最后一个 tab 关闭 | 不安排“后台继续同步”。Worker 被浏览器销毁即丢失内存；下次打开必须 locked。浏览器没有及时销毁时，全局自动锁定仍按 Coordinator 的无用户活动时间运行。 |
| tab 被后台冻结或短暂失联 | 不因该 tab 失联锁定全局；它重新连上后先 `hello` 并拿完整 status/snapshot。旧 epoch 请求一律失败后由 UI 按当前状态刷新。 |
| Worker 崩溃、浏览器回收、HMR/部署更新 | client 监听 `error` / port 失效，丢弃本地 facade cache，重新建立连接；Coordinator 无持久解锁态，所以新连接必为 locked（或 uninitialized/fatal），所有 UI 回锁屏。 |
| Vault 已锁定时点击立即同步 | 返回 `blocked` 并有 `background.blocked.unlock`；不产生网络请求、timer 或本地例外执行。解锁后由 Coordinator 统一触发受影响任务。 |
| 多个 tab 同时点立即同步/取消 | Worker 以 task id 串行化。running/queued 的 `runNow` 返回 `already-running`，不排第二个 manual run；cancel abort 同一个运行实例并等待退出。 |
| active key 切换、删除 key、网络切换 | Coordinator 递增 keyspace generation，`cancelByKey()` 等待旧 task 退出；所有 provider 写入都校验 `publicKeyHex + generation + epoch`。删除后绝不可由迟到请求重建 namespace。 |
| 网络失败、429、超时 | 仅 Worker scheduler 更新 error/退避/nextRunAt；保留最后原子提交 snapshot。各 tab 显示同一份状态，不得各自重试或轮询。 |
| Coordinator 尚未完成 worker-safe 初始化 | status 为 booting；客户端只能订阅，所有 crypto/sync 命令回复明确 `not-ready`。初始化失败进入 fatal 并显示可诊断错误；不得临时回退到页面运行。 |
| appView / Protocol 请求 | 使用专属 session worker 与现有授权模型，不得附着 `keymaster.session-coordinator.v1`。主窗口全局 lock 不可被 appView 误解释为继承解锁。 |

## 5. 必须怎么做

### 5.1 Coordinator RPC 与状态机

新建独立的 protocol，至少包含：

```ts
type ClientRequest =
  | { kind: "hello"; clientId: string }
  | { kind: "subscribe"; topics: Array<"vault" | "keyspace" | "background" | "data-changed"> }
  | { kind: "unlock"; password: string; publicKeyHex?: string; expectedSessionEpoch: string }
  | { kind: "lock"; expectedSessionEpoch: string }
  | { kind: "activate-key"; password: string; publicKeyHex: string; expectedSessionEpoch: string }
  | { kind: "crypto"; operation: AllowedCryptoOperation; expectedSessionEpoch: string }
  | { kind: "background.run-now"; taskId: string; expectedSessionEpoch: string }
  | { kind: "background.cancel"; taskId: string; expectedSessionEpoch: string }
  | { kind: "background.settings.update"; settings: BackgroundSyncSettings; expectedSessionEpoch: string };
```

`unlock` 允许 `expectedSessionEpoch` 为 boot/locked 已知值；其他会话绑定请求必须精确匹配。response 必须是可判别结果，不能只有 `void`：例如 `accepted`、`blocked`、`already-running`、`stale-epoch`、`locked`、`validation-error`。

Worker 启动时从 DB 读取仅公开的 Vault metadata，状态为 `uninitialized` 或 `locked`；绝不读取/解密私钥直到 unlock RPC。全部 port 在 `hello` 后立即获得完整公开 status、active key（若 unlocked）和任务 snapshot；晚加入 tab 不依赖错过的 event。

### 5.2 将 Vault、keyspace 与 crypto 收进同一 Worker

将当前 `sessionCryptoWorker` 的 operation dispatcher 改为 Coordinator 内部模块而非独立 Dedicated Worker。它保留 singleton 私钥 state 和显式 operation 白名单，但 response 必须回到发起 port；绝不能 `globalThis.postMessage` 广播给所有 tab。

`VaultService` 被改为异步 client facade：`status()`/`getSessionState()` 返回最后一次 Coordinator snapshot，`onStatusChange()` 订阅 Worker event；所有会改变状态或需 crypto 的方法通过 RPC。`KeyspaceService` 同样只读取/订阅 Coordinator 的 active key 与 generation，不能在每个 tab 自己 set active。

原有 `ActiveKeyCrypto` 对业务插件仍可保留同样的受控接口，但实现改为 port RPC，并在每个调用附带创建该 capability 时的 `sessionEpoch + publicKeyHex`。Coordinator 必须验证其与当前 session 一致。旧 lease 和 appView 专属 capability 不得误连主 Coordinator。

### 5.3 将同步执行器收进同一 Worker

将 BackgroundService 的状态机、scheduler、冷却、退避、`runNow`、`cancel`、settings 与 task snapshot 移入 Coordinator 内部。任务注册不能再从 tab 把含闭包的 `BackgroundTaskDefinition.run` 传到 Worker；每个同步任务要改为显式、静态 import 的 worker-safe task module，并由 Worker entry 的唯一 `registerCoordinatorTasks()` 注册。

P2PKH recent/history、BSV-21 与 STAS handler 必须抽离页面依赖：通过 Worker 内的 Vault/keyspace capability、WOC client、IndexedDB 与 notifier 执行。禁止在 tab manifest setup 内创建它们的 task runtime，也禁止 task handler 依赖 React、`window`、页面 MessageBus 或 tab-local service。

Coordinator 在成功 DB transaction 后，向所有订阅 port 推送仅含 `providerId`、`publicKeyHex`、`revision`、`kinds` 的 `data-changed` event；客户端 bridge 回 runtime 本 tab notifier 以驱动只读 DB 重渲染。这样不需要跨 tab `BroadcastChannel`，也不发送余额/UTXO/token/错误详情。

### 5.4 自动锁定与可观测性

自动锁定 timer 必须在 Coordinator 内统一持有。任何已连接 Keymaster 主页面的真实用户活动通过节流 `activity` RPC 刷新全局 idle deadline；单个 tab 的 AppShell 不再拥有会导致仅本 tab 锁定的 timer。页面 hidden、blur、暂停不应立即 lock；无任意用户活动达到配置时长才全局 lock。

Coordinator 应通过既有 `PluginLogger` 写结构化轨迹：connect/disconnect、unlock 成功或失败、epoch 变化、lock 原因、task accepted/blocked/cancelled/completed/failed、Worker 初始化失败。日志只携带 public key 的安全显示值或 hash，禁止密码、私钥、签名 digest、完整资产/错误 payload。

## 6. 文件级施工清单

| 文件 | 必做修改 |
|---|---|
| `apps/web/src/keymasterSessionCoordinator.worker.ts`（新增） | 唯一 SharedWorker entry。创建 Coordinator，静态装配 Vault、keyspace、worker-safe WOC/provider task modules，注册唯一同步任务；只暴露 `onconnect` / MessagePort 协议。不得 import React、页面 shell 或 plugin manifest。 |
| `apps/web/src/keymasterSessionCoordinatorClient.ts`（新增） | SharedWorker client transport：固定名称与 URL、port 生命周期、`hello` 重连、requestId pending map、epoch cache、subscription event 分发。port 断开仅拒绝本 tab pending request，不发全局 lock。 |
| `apps/web/src/bootstrapPlugins.ts` | bootstrap 时先创建/注入 coordinator client capability；Coordinator 未 ready 时 shell 只显示 booting/locked。删除以页面拥有后台实例为前提的初始化。 |
| `packages/contracts/src/sessionCoordinator.ts`（新增）与 `packages/contracts/src/index.ts` | 定义 RPC discriminated union、公开 Coordinator snapshot、epoch、command acknowledgement、event 及 capability key。所有 payload 明确可 structured-clone；不导出私钥/密码类型。 |
| `packages/contracts/src/vault.ts` | 更新 VaultService 文档和异步会话语义：真值来自 coordinator；新增/调整 status snapshot epoch 的必要字段。删除“当前 tab Worker / dispose 即结束 Keymaster 会话”的表述，不改弱化受控 crypto 边界。 |
| `packages/contracts/src/keyspace.ts` | active key 与 generation 的真值改为 coordinator snapshot；删除每 tab 本地 active 切换的隐含假设。 |
| `packages/contracts/src/background.ts` | 保持页面只拥有 `runNow`/`cancel`/snapshot/setting facade；新增 command acknowledgement 类型和 sessionEpoch。删除任何 leader/follower、跨 tab action、tab-local register/run 的接口描述。 |
| `packages/plugin-vault/src/sessionCryptoProtocol.ts` | 删除 Dedicated Worker `init`/`dispose` transport message；将显式 crypto operation 纳入 Coordinator protocol 的内部 dispatcher，保留 operation 级类型与 public-key/session 校验输入。 |
| `packages/plugin-vault/src/sessionCryptoWorker.ts` | 删除作为 Dedicated Worker entry 的 `addEventListener("message")`、`postMessage`、`closeWorkerScope` 与 tab 级 dispose；重命名/重构为可被 Coordinator 调用的 `createSessionCryptoDispatcher(stateRef)`，仅在 Coordinator 内持有 key material。 |
| `packages/plugin-vault/src/sessionCryptoClient.ts` | 删除 `new Worker()`、`worker.terminate()`、50ms dispose timer 与 local production fallback；改为 Coordinator crypto RPC client。测试专用 local fake 可留在 test helper，不能被生产构建导入。 |
| `packages/plugin-vault/src/vaultCoordinator.ts` | 把 vault unlock/lock/activate/password-change 的事务状态收敛为 Coordinator-owned state machine；确保密码与临时解密 buffer 使用后清零，global lock 先 abort/epoch 栅栏再清零。 |
| `packages/plugin-vault/src/vaultService.ts` | 重写为 client facade，删除 tab-local `status`、`vaultSession`、`keyCache`、`activeKeyCryptoLeases`、`appViewSessions` 作为 Keymaster 真值的实现；所有变更操作走 RPC，收到 event 后更新只读 cache/listener。appView 专属会话另设明确 client，不可混用。 |
| `packages/plugin-vault/src/keyspaceService.ts` | 重写为 Coordinator keyspace facade；`setActive`/delete 生命周期经 Worker 原子执行，消费 Worker 广播的 generation 及 active key，不再各 tab 维护订阅/取消屏障。 |
| `packages/plugin-vault/src/manifest.ts` | 提供由 coordinator client 支撑的 vault/keyspace facade，删除每 tab `createVaultService()` 的独立会话初始化及 tab teardown 的全局清理假设。 |
| `packages/plugin-background/src/sessionCoordinatorBackground.ts`（新增） | 从现有 service 提取无 DOM、无 tab 通道的唯一 scheduler/task runtime。接收 Coordinator vault/keyspace/WOC/notifier capability，拥有 timer、队列、abort、退避、snapshot。 |
| `packages/plugin-background/src/backgroundService.ts` | 删除 `createLeaderContext`、`LEADER_LOCK_NAME`、Web Locks、BroadcastChannel election/heartbeat/mailbox、leaderSnapshots、follower 转发、已解锁 follower 本地运行例外及所有相关 merge 逻辑；替换为 client facade 或仅保留并迁移出的纯 scheduler。 |
| `packages/plugin-background/src/manifest.ts`、`packages/plugin-background/src/BackgroundTray.tsx`、`packages/plugin-background/src/BackgroundSettingsPage.tsx` | 使用 Coordinator-provided service/snapshot/ack；UI 不再表达 leader/follower、也不做 optimistic running。设置更新由 coordinator 持久化并广播。 |
| `packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.ts`（新增） | 抽取 recent-sync 与 history-backfill 为静态 Worker task factory；仅依赖 Worker-safe WOC、Vault crypto RPC、keyspace snapshot、IndexedDB、AbortSignal/notifier。完整保留 generation/abort/原子提交检查。 |
| `packages/plugin-p2pkh/src/p2pkhService.ts`、`packages/plugin-p2pkh/src/manifest.ts` | 删除在 tab 内 `backgroundRegistry.register()` 和本地任务执行实例；领域事件改为发给 Coordinator 的 trigger command，页面/service 保持 DB read 与本地业务事务。 |
| `packages/plugin-token-bsv21/src/bsv21CoordinatorTask.ts`（新增）、`packages/plugin-token-stas/src/stasCoordinatorTask.ts`（新增） | 将各 token sync handler 做成静态 Worker task factory；不得依赖 manifest setup 或 tab-local Vault/BackgroundService。保留 active key/generation/abort/失败保留旧 snapshot 规则。 |
| `packages/plugin-token-bsv21/src/manifest.ts`、`packages/plugin-token-stas/src/manifest.ts`、`packages/plugin-token-bsv21/src/bsv21Sync.ts`、`packages/plugin-token-stas/src/stasSync.ts` | manifest 只注册 provider/read UI 与领域 trigger client；删除每 tab background task 注册/执行。同步实现按新增 worker task 模块收口。 |
| `packages/runtime/src/createPluginHost.ts` | 保留/调整 `asset.data.changed` 为本 tab event bridge；删除把它当跨 tab BroadcastChannel 真值通道的要求。Coordinator event 到达后再 emit，DB 仍是读取真值。 |
| `apps/web/src/shell/AppShell.tsx`、`apps/web/src/shell/LockedShell.tsx` | 自动锁定改为向 Coordinator 发送节流 activity，不在 tab 侧计时/锁定；UI 仅按全局 vault status/epoch 切换。 |
| `packages/plugin-woc/src/**`（按 worker 兼容性审计实际涉及文件） | 删除/隔离任何 `window`、DOM、页面 MessageBus 依赖，使 WOC queue/rate limit 可由 Coordinator 唯一实例使用；不得为 tab 保留第二个请求队列。 |
| `docs/architecture/code-architecture.md` | 更新 Vault、Keyspace、Background、跨 tab 关系图，明确 Coordinator 是唯一 runtime；记录 appView 不附着主 Coordinator 与不支持 SharedWorker 时 fail-closed。 |

### 必须删除的生产残留

以下扫描结果必须为零（测试 fake、历史施工单文本除外）：

```text
new Worker(new URL("./sessionCryptoWorker"
background.leader
createLeaderContext
leaderSnapshots
runLocallyIfEligible
shouldUseLocalSession
forwardAction
broadcastSnapshots
BroadcastChannel("background
navigator.locks.*background.leader
```

`BroadcastChannel("asset.data.changed")` 也应在本单后删除或不再由 runtime 建立；Coordinator port event 是唯一跨 tab 数据失效分发路径。

## 7. 测试、模拟与最终验收清单

### 自动化测试

新增/改造下列测试，所有 SharedWorker 测试使用可控的多 `MessagePort` fake；不得只以单 tab unit test 推断多 tab 正确性。

| 文件 | 必测内容 |
|---|---|
| `apps/web/src/keymasterSessionCoordinatorClient.test.ts`（新增） | 多 client hello/订阅、request response 路由、worker crash 后 cache 失效与重连 locked、port dispose 不发送 lock。 |
| `apps/web/src/keymasterSessionCoordinator.worker.test.ts`（新增） | 并发 unlock 只产生一个 epoch/单份 key；global lock 清零/广播/abort；switch/delete 的 epoch + generation 防迟到写；last-port 后无恢复解锁。 |
| `packages/plugin-vault/src/sessionCryptoWorker.test.ts`、`sessionCryptoClient.test.ts`、`vaultService.test.ts`、`keyspaceService.test.ts` | 改为 Dispatcher/Coordinator RPC 测试；断言生产路径不构造 Dedicated Worker，任一 facade 看见同一 status/active key，tab dispose 不毁会话，Worker restart 必 locked。 |
| `packages/plugin-background/src/backgroundService.test.ts` 与 `sessionCoordinatorBackground.test.ts`（新增） | 删除 leader 测试；验证多 client 同时 runNow 只执行一次、cancel 只取消唯一实例、locked 全局 blocked 且零网络、snapshot 对所有 client 一致、失败/退避/设置仅一份。 |
| `packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.test.ts`（新增）及现有 P2PKH tests | task 在无 `window` 环境运行；相同 key/epoch 只拉取一次；abort、key switch、lock 后迟到结果不写库/不通知。 |
| `packages/plugin-token-bsv21/src/bsv21CoordinatorTask.test.ts`、`packages/plugin-token-stas/src/stasCoordinatorTask.test.ts`（新增） | 同上：唯一执行、worker-safe、epoch/generation/abort、失败保留旧 snapshot。 |
| `apps/web/src/shell/AppShell.autoLock.test.tsx` | 多 tab activity 刷新同一全局 deadline；关闭/隐藏某一个 tab 不 lock；达到全局 idle 后全部 tab 同时 lock。 |

### 最终行为验收

- [ ] 打开两个 Keymaster tab，tab A 解锁后 tab B 无刷新即显示相同 active key 的 unlocked 状态；没有第二次密码输入、没有 key material 离开 Coordinator。
- [ ] 任一 tab 手动锁定后，所有 tab 同时回锁屏；后续签名、加解密、同步均被拒绝，Worker 内 active key buffer 已被覆盖清零。
- [ ] 关闭、刷新或隐藏任一个 tab 时，其余 tab 不锁定、不丢 active key，唯一同步继续且不会重启一轮。
- [ ] 全部 tab 关闭后再打开，应用为 locked；模拟 Worker crash/restart 也为 locked，绝不存在内存会话恢复。
- [ ] 两个 tab 同时点击同一“立即同步一次”，网络 handler 严格执行一次；两个 UI 都得到同一 queued/running/completed snapshot。
- [ ] 同步期间在任一 tab 点击取消，唯一任务被 abort；所有 tab 同步显示取消后的 idle/nextRunAt，且没有迟到 DB 写/成功通知。
- [ ] Vault 锁定时任一 tab 请求立即同步得到明确 waiting-for-unlock，不发生 WOC/fetch 请求；解锁后由唯一 Coordinator 继续调度。
- [ ] active key 切换、删除 key、网络切换、锁定四类并发边界均无法让旧 epoch 或旧 generation 的任务写入当前/新 namespace。
- [ ] 页面、widget 与 provider read API 在所有 tab 中只读 DB；打开页面、切换页面、收到任务快照均不直接发网络。
- [ ] appView/protocol session 不会因主 Keymaster tab 解锁而自动获得 Coordinator 会话或签名能力。

### 静态与构建验收

- [ ] 生产构建中只有 `apps/web/src/keymasterSessionCoordinator.worker.ts` 创建命名 SharedWorker；不存在 Vault Dedicated Worker、Background Web Lock leader 或 background BroadcastChannel election。
- [ ] 全仓生产 `rg` 不命中第 6 节“必须删除的生产残留”；不以 adapter、feature flag、fallback 或隐藏代码保留旧模型。
- [ ] Coordinator worker bundle 不依赖 React、DOM 或 `window`；P2PKH/BSV-21/STAS task handler 在 Worker test environment 可加载并执行。
- [ ] RPC contract 和日志静态检查证明没有 `privateKeyHex`、密码、`CryptoKey`、解锁 token、完整资产 snapshot 出现在 event payload、storage、logger 或 URL。
- [ ] `pnpm typecheck`。
- [ ] `pnpm vitest run apps/web/src/keymasterSessionCoordinatorClient.test.ts apps/web/src/keymasterSessionCoordinator.worker.test.ts packages/plugin-vault/src/sessionCryptoWorker.test.ts packages/plugin-vault/src/sessionCryptoClient.test.ts packages/plugin-vault/src/vaultService.test.ts packages/plugin-vault/src/keyspaceService.test.ts packages/plugin-background/src/backgroundService.test.ts packages/plugin-background/src/sessionCoordinatorBackground.test.ts packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.test.ts packages/plugin-token-bsv21/src/bsv21CoordinatorTask.test.ts packages/plugin-token-stas/src/stasCoordinatorTask.test.ts apps/web/src/shell/AppShell.autoLock.test.tsx`。
- [ ] `pnpm test` 与 `pnpm lint:boundaries`。若有失败，必须区分本单新增问题与既有问题；不得为通过测试恢复旧多 tab leader 路径。

验收结论只有在上述行为、静态扫描、Worker 环境测试、类型检查和全量测试全部通过后才能给出。任何“多个 tab 各自解锁、再广播状态”“锁定 leader / 解锁 follower 的例外执行”“SharedWorker 不可用时回退独立 tab sync”的实现都不符合本单。
