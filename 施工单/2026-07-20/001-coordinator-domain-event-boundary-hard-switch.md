# 001 Coordinator 分域事件、UI 快照与广播副作用隔离硬切换一次性迭代施工单

## 0. 决策、范围与硬切原则

本单将 SharedWorker Coordinator 的页面侧观察模型硬切换为**分域事件**：Vault、
Keyspace、Background、data-changed 各自拥有独立的事件契约、revision 和 facade。
`MessagePort` 仍是唯一的跨 tab 传输；本单不为每个领域新建 Worker 或新开物理 port。

这是一次性硬切换。完成后，业务模块不得订阅泛化的 Coordinator `onStateChange`，
也不得把一个领域的快照更新重新解释为另一个领域的生命周期变化。不得保留旧事件
adapter、双订阅、feature flag、fallback 或“仅为兼容旧插件”的全局状态回调。

本单覆盖：

- `apps/web` SharedWorker Coordinator 与 client transport；
- Vault、Keyspace、Background 的 tab facade；
- Broadcast 重连生命周期；
- Coordinator event 到 Runtime Resource Store 的桥接；
- 与上述边界有关的自动化测试和静态检查。

本单不改变：私钥只在 SharedWorker 内存、epoch/generation 栅栏、后台同步唯一执行者、
后台命令 ack、WOC/DB 事务、HubCast wire 协议或 React 的视觉 UI。它只收紧“谁能因
什么事件产生副作用”的架构边界。

与下列施工单冲突时，本单优先于其中关于 Coordinator 的全局 state listener、tab
facade 订阅和广播重连触发来源的描述；其余定义继续有效：

- `施工单/2026-07-18/002-shared-vault-session-and-sync-coordinator-hard-switch.md`
- `施工单/2026-07-19/002-async-command-result-and-fatal-boundary-hard-switch.md`
- `施工单/2026-07-19/003-runtime-resource-store-reactive-boundary-hard-switch.md`

---

## 1. 简述缘由

目前 Coordinator client 在收到任意 topic 的事件后会更新一个聚合 state，并通知同一组
`onStateChange` listener。Vault facade 订阅该泛化 listener；Broadcast 重连协调器又订阅
Vault facade 的 `onStatusChange`。

因此一次完全正常的路径会越过领域边界：

```text
BackgroundTray 点击“立即同步”
  -> MessagePort: background.run-now
  -> SharedWorker: background.snapshot-updated
  -> Coordinator client: 泛化 state listener
  -> Vault facade: 误报 Vault 状态更新
  -> Broadcast reconnect coordinator: 误认为 Vault 又可用
  -> connectForOwner() / HubCastProvider.bind()
  -> 关闭旧 HubCast socket，再重绑
```

根因不是 `postMessage`、SharedWorker 或 HubCast 本身。根因是一个**无领域含义的总线
通知被允许驱动安全和网络副作用**。局部的“值相等才通知”能止住当前症状，却仍允许未来
的 topic、缓存字段或事件顺序造成同类越界。

正确模型必须让 Background 消息只能更新 Background；Vault 生命周期只能由 Vault 真值
转换产生；Broadcast 只能对明确的 Vault/Keyspace transition 或自身 socket 事件作出反应。

---

## 2. 最终模型与不可变约束

### 2.1 一条传输，四个逻辑域

```text
UI command ── request/response ──> SharedWorker Coordinator
                                      │
                                      ├─ vault event ─────> Vault facade ────┐
                                      ├─ keyspace event ──> Keyspace facade ─┼─> Broadcast lifecycle
                                      ├─ background event ─> Background facade -> Resource Store -> UI
                                      └─ data-changed event -> Asset notifier -> Resource Store -> UI

HubCast socket close / bind failure ─────────────────────────────────────────> Broadcast lifecycle
```

- `MessagePort` 只负责可靠地收发结构化消息，不携带“收到即重连”的业务语义。
- 每个 event 必须有稳定 `topic`、该 topic 自己的递增 `revision` 和 `sessionEpoch`。
- Worker 仅在该领域公开真值发生变化时发布该领域事件；不允许因为命令 received、
  task progress、UI 订阅变更而重发无关领域事件。
- client 可以有一个私有聚合 cache 供 `hello`/诊断使用，但不得将它作为业务订阅 API
  导出。跨领域业务副作用不得从聚合 cache 的“任意变更”触发。

### 2.2 领域责任表

| 领域 | 公开事件真值 | 唯一合法消费者 | 明确不允许的消费者/效果 |
|---|---|---|---|
| Vault | `status`、active public key、`sessionEpoch` | Vault facade、锁屏/UI resource、Broadcast lifecycle | Background 不因它复制任务状态；页面不得持有私钥或自行重建 session |
| Keyspace | active public key、generation | Keyspace facade、Broadcast lifecycle、active-key resource | 不触发 Vault unlock；不以 Background task 更新推断 key 改变 |
| Background | task snapshot、schedule settings | Background facade、后台托盘/设置 resource | Vault facade、Broadcast lifecycle、HubCast provider |
| data-changed | provider/key/revision/kinds 的失效通知 | Asset notifier、只读 DB resource | Vault 生命周期、任务调度、直接网络 fetch |
| Broadcast socket | socket close、bind result、provider state | BroadcastCore + reconnect coordinator | Coordinator/Vault/Background facade |

### 2.3 Broadcast 重连状态机

Broadcast lifecycle 的输入只能是：

1. Vault 从 `unlocked` 之外的状态转换为 `unlocked`；
2. `unlocked` 下 active public key 实际改变；
3. Vault 变为不可用（只执行结构化断开，不重试）；
4. Keyspace generation/active key 实际改变；
5. HubCast 的 close、bind 失败和既有固定延迟重试 timer。

即使收到合法输入，也必须先与已应用的 `(sessionEpoch, activePublicKeyHex,
keyspaceGeneration)` 比较；三元组未变时不得再次 `connectForOwner()`，更不得调用
provider `bind()` 或关闭已有 socket。

`background.snapshot-updated`、`data-changed`、UI 打开/关闭托盘、Resource Store reload、
命令 ack、普通 Coordinator client reconnect 都不是 Broadcast 状态机输入。

---

## 3. Coordinator 协议与 facade 的最终契约

### 3.1 命令、快照、事件三分

同一 port 上的消息严格分为三类：

| 类别 | 方向 | 用途 | 是否允许产生跨领域副作用 |
|---|---|---|---|
| command / response | tab ↔ Worker | `background.run-now`、unlock、lock、activate-key、设置更新等 | 仅 Worker 自己处理对应命令；response 不驱动其他领域 |
| initial snapshot | Worker → 单个订阅 port | `hello`/订阅时建立该 topic 的初始视图 | 仅更新该 topic facade/resource |
| domain event | Worker → 订阅该 topic 的 port | 该领域真值发生变化后的增量 | 仅该 topic 的明确消费者可处理 |

`hello` 只返回启动所需的公开总体状态；它不是持续订阅。每个 `subscribe(topics)`
response 必须原子包含所订阅 topic 的当前 snapshot/revision。Worker 从确认该订阅后才向
该 port 投递 revision 更大的 event，避免“先拿 snapshot、后注册订阅”丢失中间变化。

不得把 request response 伪装成 event，也不得给 event 附加一个可与 pending request
混淆的 `requestId`。

### 3.2 分域事件

`packages/contracts/src/sessionCoordinator.ts` 中只保留可判别的分域 event。其字段名称可
按既有代码风格调整，但语义必须等价：

| topic | event 内容 | 何时发布 |
|---|---|---|
| `vault` | vault status、active public key（仅公开值）、session epoch、vault revision | 状态、active key 或 epoch 真正改变 |
| `keyspace` | active public key、generation、keyspace revision | active key/generation 真正改变 |
| `background` | task snapshots、schedule settings、background revision | 任务状态、进度、错误、next run 或设置真正改变 |
| `data-changed` | provider id、public key、kinds、data revision | 成功原子 DB commit 后 |

同一领域可选择发布完整小型 snapshot 或受控 patch，但不可发布整个 Coordinator state。
event payload 不得含密码、私钥、`CryptoKey`、签名 digest、可复用 capability、完整资产
数据或未脱敏错误对象。

### 3.3 Client 与 facade

Coordinator client 必须提供按 topic 注册的内部订阅器；禁止向业务插件暴露全局
`onStateChange(listener)`。如果 client 为 shell 保留一个聚合 snapshot read API，它只能
用于首次渲染和诊断，且不得有 `subscribe` 副作用入口。

- `VaultServiceCoordinator` 只消费 `vault` topic。它只在 Vault 对外可观察的 tuple 改变
  时调用 `onStatusChange`；Background/Data event 绝不可到达此处。
- `KeyspaceServiceCoordinator` 只消费 `keyspace` topic；active key 未改变时不得通知。
- `BackgroundServiceCoordinator` 只消费 `background` topic，并向后台 Resource Store 发布
  snapshot；它不调用 Vault/Keyspace/Broadcast callback。
- `AssetDataNotifier` 只消费 `data-changed` topic，再按既有资源失效语义分发。
- Broadcast manifest/reconnect coordinator 只能从 Vault/Keyspace facade 的窄生命周期
  API 与 core socket event 获取输入，不能 import Coordinator client 或订阅 port。

所有 facade 在初始化期间必须先用其 topic snapshot 填充 cache，再接收该 revision 之后的
事件。收到过期 revision、不同 sessionEpoch 的旧事件，或 active key/generation 不匹配的
事件时必须丢弃并写非致命诊断；不得补发“也许需要重连”的猜测性操作。

### 3.4 UI 与 Resource Store

UI 只读取已分域的 resource：Vault shell resource、后台任务 resource、广播状态 resource、
资产 resource。组件可保存本地交互状态（例如按钮 pending、面板开关），但不得直接订阅
Coordinator transport，不得用 `useEffect` 将任意 state update 翻译成 Vault/Broadcast 命令。

“立即同步”完整且唯一的 UI 路径为：

```text
点击 -> BackgroundService.runNow(taskId) -> command ack
     -> background topic snapshot -> Background Resource Store -> 托盘 UI
```

ack 只说明请求是否接收；queued/running/completed/failed 的展示真值只来自 Background
snapshot。该路径与 Vault/Broadcast 没有输出边，因此从类型、订阅和调用图上都无法触发
HubCast 重绑。

---

## 4. 必须怎样做与绝对不能怎样做

### 4.1 必须怎样做

1. Worker 内为每个 topic 维护独立 revision；先更新领域真值，再构造该 topic event。
2. client 必须以 `topic + revision + epoch` 去重和排序；tab reconnect 后按订阅 response
   的 revision 重新建立基线。
3. facade 必须将输入收窄为明确 topic，向外只暴露自身领域的方法和监听器。
4. Broadcast lifecycle 必须显式保存最近已处理的 Vault/Keyspace identity，并仅在合法
   transition 下连接、断开或重连。
5. 任何网络/资源副作用都必须有明确 owner：HubCast 只由 BroadcastCore owner 管理，
   后台网络只由 Worker task runtime 管理，UI 不拥有两者。
6. 对每一个领域事件均写结构化日志：topic、revision、epoch、来源和是否被去重；禁止
   日志记录敏感原料。
7. 各 topic snapshot 的 equality 必须包含其 UI 可见字段。尤其 Background 的 error、
   attempt/completion time、blocked reason、progress、next run 变化必须刷新 UI；不能只比
   `id/state`。

### 4.2 绝对不能怎样做

完成后，以下模式在生产代码中必须为零：

```text
Coordinator client onStateChange -> VaultServiceCoordinator
Coordinator client onStateChange -> Keyspace/Background/Broadcast 任何业务 facade
background.snapshot-updated -> vault.onStatusChange
background.snapshot-updated -> connectForOwner / provider.bind / provider.close
data-changed -> connectForOwner / provider.bind / provider.close
任意 UI resource / React effect -> 直接监听 MessagePort
任意 facade -> import apps/web/src/keymasterSessionCoordinatorClient 的 transport internals
```

禁止用下列方式“修好”本问题：

- 不得仅在 Broadcast 层忽略某些时间窗口内的重复 bind；这会掩盖错误输入，且会误伤
  真正的 key switch/remote close。
- 不得在 BackgroundTray 点击后临时暂停 Broadcast 或把 HubCast 连接标为“脏”。
- 不得继续保留泛化 `onStateChange`，再要求每个消费者自行判断字段是否变化；字段和
  副作用会继续随功能增长而漏判。
- 不得为 Vault/Background 分别创建两个 SharedWorker，再经 tab、BroadcastChannel 或
  storage 转发状态。Coordinator 的 Vault 与唯一同步执行权边界保持不变。
- 不得引入将 background event 转成 Vault event 的 adapter、兼容 callback 或 fallback。
- 不得把失序/未知 event 当成“安全起见重连”。它们应丢弃、记录、必要时重新订阅该 topic。

---

## 5. 特殊情况与预定处理

| 情况 | 规定处理 |
|---|---|
| 首次连接、订阅与事件并发 | `subscribe` 在 Worker 内原子登记 subscription 并回传该 topic baseline revision；client 仅应用 revision 更大的 event，避免丢事件或重复副作用。 |
| tab 断线后重连 | client 清除各 facade 的可订阅 cache，重新 hello/subscribe；新的 topic snapshot 是基线。只有 Vault/Keyspace 真值实际改变才会使 Broadcast state machine 运行。 |
| Worker 重启或 session epoch 改变 | client 丢弃旧 epoch event/capability；Vault 依既有规则收敛至 locked/booting。Broadcast 因合法 Vault transition 结构化断开或重新连接一次，不能因每个 topic snapshot 重连。 |
| Background 在执行中更新 progress/failed | 只提升 background revision 和后台 resource；绝不触发 Vault status、active key、keyspace generation 或 Broadcast bind。 |
| Vault unlock 与 keyspace active-key event 连续到达 | Broadcast lifecycle 合并同一 microtask/同一 identity 的两个输入，并对已应用三元组去重；最终至多一次 bind。若 identity 不完整，保持 structurally offline，等待明确合法输入。 |
| Vault lock、key switch、删除 key | 按既有 epoch/generation 栅栏 abort 任务并撤销 crypto。Broadcast 立即结构化断开；迟到的旧 event/request 不得重连或写入。 |
| HubCast 自己断开 | 这是 Broadcast 私有输入。core 写 closed/nextReconnectAt，固定延迟重试；不发布或伪造 Vault/Background 状态变化。 |
| Unknown topic、无效 payload、revision 倒退 | client/facade 不抛进全局 fatal、不猜测副作用；记录脱敏诊断，丢弃消息，并对该 topic 请求一次重新订阅/snapshot。协议不兼容则 fail closed 到 booting/locked。 |
| 多 tab 同时 runNow/cancel | 仍由 Worker 的任务 runtime 串行化，返回 `accepted`/`already-running`/`blocked`；每个 tab 只消费同一 background snapshot。该竞争不影响 Broadcast。 |
| Resource Store 在 StrictMode 重订阅 | 只会重新订阅对应 resource/facade；不得重新调用 Worker command、Vault lifecycle 或 Broadcast bind。 |

---

## 6. 命名硬切：名称必须表达领域与副作用

本单不接受只替换实现、保留旧宽泛名称的做法。`state`、`change`、`connect`、
`broadcast` 等名称若没有领域和动作限定，会让后续调用者误以为它们可以处理任意
Coordinator 更新。本节列出的旧生产 API、方法和关键字段必须删除或改名；不保留别名。

### 6.1 Coordinator transport 与事件命名

| 删除的宽泛名称 | 硬切后的名称 | 意图 |
|---|---|---|
| `CoordinatorClientState`（作为可订阅总状态） | `CoordinatorBootstrapSnapshot`（仅 hello/诊断读模型） | 明确它不是业务事件源。 |
| `onStateChange` | 删除；client 私有 `subscribeTopic` | 禁止任意领域消费总状态。 |
| `CoordinatorEvent`（未分域的大 union） | `CoordinatorTopicEvent`，其成员命名为 `VaultLifecycleEvent`、`KeyspaceActiveKeyEvent`、`BackgroundSnapshotEvent`、`AssetDataChangedEvent` | event 的领域从名称上可见。 |
| `subscribe(topics)` 的不透明返回 | `subscribeTopicsAndReadBaselines` | 明确订阅同时建立 revision baseline，而不是普通回调注册。 |
| `broadcastToSubscribers` | `publishTopicEvent` | 避免和 Broadcast/HubCast 业务混淆；只能发布指定 topic。 |
| `state`（client 内聚合可变字段） | `bootstrapSnapshotCache` | 明确该 cache 不能驱动业务副作用。 |

`topic` 字符串必须固定为 `vault.lifecycle`、`keyspace.active-key`、
`background.snapshot`、`asset.data-changed`，而不是含义过宽的 `vault`、
`background` 或 `state`。topic revision 相应命名为 `vaultLifecycleRevision`、
`activeKeyRevision`、`backgroundSnapshotRevision`、`assetDataRevision`；禁止使用没有
领域前缀的 `revision` 作为跨域比较依据。

### 6.2 facade 与 UI 命名

| 现有/禁止名称 | 硬切后的名称 | 意图 |
|---|---|---|
| `VaultService.onStatusChange` | `VaultService.onLifecycleChange`，参数为完整 `VaultLifecycleSnapshot` | active key、epoch 和 status 都是 Vault 生命周期，不再用“status”掩盖额外语义。 |
| `VaultService.getSessionState` | `VaultService.getLifecycleSnapshot` | 返回公开生命周期快照，不暗示页面持有可用 crypto session。 |
| `KeyspaceService.onActiveChange` | `KeyspaceService.onActiveKeyChanged` | 明确变化对象是 active key，而非任意 keyspace 数据。 |
| `BackgroundService.onChange` | `BackgroundService.onTaskSnapshotsChanged` | 明确只能订阅任务快照。 |
| `listSnapshots` | `listTaskSnapshots` | 避免与 Vault、Broadcast 或 Coordinator snapshot 混淆。 |
| `cachedSnapshots` / `notifyChange` | `taskSnapshotsCache` / `emitTaskSnapshotsChanged` | 与 facade 对外契约一致。 |
| `background.taskSnapshots`（可保留 resource id） | resource 的 TypeScript 常量命名为 `BACKGROUND_TASK_SNAPSHOTS_RESOURCE_ID` | 字符串保持稳定，代码标识符表达内容。 |

Vault lifecycle snapshot 只含公开的 `status`、`activePublicKeyHex?`、`sessionEpoch`、
`vaultLifecycleRevision`。名称中不得出现 `session` 而实际承载 private key、密码、
`CryptoKey` 或可复用签名能力。

### 6.3 Broadcast 生命周期命名

| 删除的宽泛名称 | 硬切后的名称 | 意图 |
|---|---|---|
| `createReconnectCoordinator` | `createBroadcastConnectionLifecycle` | 此组件不只是 timer；它是连接的唯一生命周期 owner。 |
| `tryConnect` | `reconcileBroadcastConnection` | 输入是观察到的 identity，输出是“保持、断开或连接”的协调结果。 |
| `onVaultStatusChange` | `onVaultLifecycleChanged` | 只能接受 Vault lifecycle snapshot。 |
| `onKeyspaceChange` | `onActiveKeyChanged` | 只能接受 active-key snapshot。 |
| `onCoreStateChange` | `onBroadcastConnectionStateChanged` | 只处理 BroadcastCore 的 socket/provider 状态。 |
| `connectForOwner` | `reconcileOwnerConnection` | 该方法要先检查目标 identity；不是无条件发起一次连接。 |
| `currentOwnerPublicKeyHex` | `desiredConnectionOwnerPublicKeyHex` | 区分“期望绑定身份”与实际 bound handle。 |
| `connectEpochValue` | `connectionAttemptEpoch` | 不得与 Vault 的 `sessionEpoch` 混为同一世代。 |
| `currentBound` | `boundConnection` | 明确它代表已经成功的连接，而不是一般 current state。 |

新增且必须使用的值对象为 `BroadcastConnectionIdentity`：
`sessionEpoch + activePublicKeyHex + keyspaceGeneration`。生命周期只可对这个对象做
reconcile；不得传入任意 event、裸 public key 或全局 client state。已应用 identity 应命名
为 `lastReconciledConnectionIdentity`，以说明它用于去重，而不是错误地代表远端连接真值。

### 6.4 命名禁止项与审查规则

以下名称不得再出现在生产 facade/生命周期代码中（测试描述和历史施工单除外）：

```text
onStateChange
notifyChange
onChange                 # 除框架内部泛型 utility 外
tryConnect
onVaultStatusChange
onKeyspaceChange
connectForOwner
currentOwnerPublicKeyHex
connectEpochValue
broadcastToSubscribers
```

不允许通过 `@deprecated`、转发方法或别名保留这些名字。类型、变量、日志 event 名称也必须
随概念更新：例如 `broadcast.reconnect.*` 改为 `broadcast.connection.lifecycle.*`，但 HubCast
wire/protocol event（例如 `hubcast.connect.failed`）不因本单改名。

---

## 7. 文件级施工清单

| 文件 | 必做修改 |
|---|---|
| `packages/contracts/src/sessionCoordinator.ts` | 删除/收口泛化 state-change 订阅语义；定义 `CoordinatorBootstrapSnapshot`、分域 topic、topic snapshot、revision、`CoordinatorTopicEvent` 和原子 subscribe response。明确 payload 的无敏感数据约束。 |
| `packages/contracts/src/index.ts` | 导出新的分域 Coordinator contract；删除旧全局业务订阅类型出口。 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 将当前 `broadcastToSubscribers(topic, event)` 改为 `publishTopicEvent`；每个 topic 保持具名 revision，只在该领域真值改变时发 event。实现原子 subscribe baseline；不得生成“总状态已改变”事件。 |
| `apps/web/src/keymasterSessionCoordinatorClient.ts` | 保留 port、pending request、hello/reconnect；删除面向业务的 `onStateChange`。新增私有 `subscribeTopic` router、baseline/revision gate 和供 facade 使用的窄 topic subscription API。background event 不得通知 Vault/Keyspace 监听器。 |
| `packages/plugin-vault/src/vaultServiceCoordinator.ts` | 删除对 client 全局 state 的依赖；以 `VaultLifecycleSnapshot` 仅订阅 `vault.lifecycle`，并将 `onStatusChange`/`getSessionState` 硬切为 `onLifecycleChange`/`getLifecycleSnapshot`。保留 active crypto revoke 规则。 |
| `packages/plugin-vault/src/keyspaceServiceCoordinator.ts` | 仅订阅 `keyspace.active-key`；以 `onActiveKeyChanged` 按 active key/generation/revision 更新。删除从聚合 client state 推导 active key 的路径。 |
| `packages/plugin-background/src/backgroundServiceCoordinator.ts` | 仅订阅 `background.snapshot`，以 `taskSnapshotsCache` 维护 task/settings；将 `onChange`/`listSnapshots` 硬切为 `onTaskSnapshotsChanged`/`listTaskSnapshots`。命令仍走显式 RPC ack。不得对 Vault/Keyspace/Broadcast 发任何回调。 |
| `packages/plugin-background/src/BackgroundTray.tsx` | 继续只读 `background.taskSnapshots` resource；确认 selector 使用完整 UI 语义比较。不得导入 Coordinator client、Vault 或 Broadcast service。 |
| `packages/plugin-background/src/BackgroundSettingsPage.tsx` | 只通过 BackgroundService 读取/提交 settings，并消费 ack + background snapshot；不得监听全局 Coordinator 状态。 |
| `packages/plugin-broadcast/src/broadcastConnectionLifecycle.ts` | 导出 `createBroadcastConnectionLifecycle`。将输入显式收窄为 Vault/Keyspace transition 与 core state；保存 `lastReconciledConnectionIdentity` 并去重，同一 identity 下不得重复 `reconcileOwnerConnection()`。 |
| `packages/plugin-broadcast/src/manifest.ts` | 只能通过 VaultService 与 KeyspaceService 装配 Broadcast connection lifecycle；禁止取得 Coordinator client 或订阅 UI/Background topic。同步所有 lifecycle 日志 event 名。 |
| `packages/plugin-broadcast/src/broadcastCore.ts` | 将 `connectForOwner` 硬切为 `reconcileOwnerConnection`，将含混字段改为 connection identity 命名；保持 provider/socket owner。增加/保持相同 identity 的 no-op 防线，但不得把它当作替代分域订阅的唯一修复。socket close 只进入 core/lifecycle 路径。 |
| `packages/runtime/src/createPluginHost.ts` | Coordinator `data-changed` bridge 只转给 AssetDataNotifier/Resource Store；不得作为全局 plugin host version 或 Vault/Broadcast 失效信号。 |
| `apps/web/src/bootstrapPlugins.ts` | 只负责注入 Coordinator client 与分域 facade，不得在装配层合并 topic、将任何 event 重发为 Vault 变化，或直接触发 Broadcast connect。 |
| `apps/web/src/shell/shellResources.ts`、`apps/web/src/shell/AppShell.tsx` | shell 只订阅 Vault/UI resource；删除通过 Coordinator 聚合 state 或 Background 更新刷新 vault shell 的路径。 |
| `packages/plugin-vault/src/vaultServiceCoordinator.test.ts` | 替换全局 state mock 为 topic mock；覆盖 Background/Data 更新不会调用 Vault status listener。 |
| `apps/web/src/keymasterSessionCoordinatorClient.test.ts`（新增或扩充） | 覆盖 subscribe baseline、revision gate、topic 隔离、重连和失序 event。 |
| `apps/web/src/keymasterSessionCoordinator.worker.test.ts` | 覆盖只向订阅 topic 发 event、revision 递增、原子订阅和无敏感 payload。 |
| `packages/plugin-broadcast/src/broadcastConnectionLifecycle.test.ts` | 只覆盖合法 Vault/Keyspace transition 的 reconcile/bind/close 去重；Coordinator topic 路由由 apps/web 组合测试覆盖。 |
| `packages/plugin-background/src/backgroundServiceCoordinator.test.ts` | 覆盖 runNow/progress/error 只更新 Background facade/resource，不触及 Vault/Broadcast spy。 |

如实施发现 additional file 仍使用泛化 Coordinator state listener，必须同一次迭代迁移到
对应 topic；不得以“非关键消费者”为由保留旧 API。

---

## 8. 测试与最终验收清单

### 8.1 自动化测试

- [ ] 一个 port 只订阅 `background` 时，Worker 只向它发送 background baseline/event；
  Vault/Keyspace/Data event 不得到达该 facade。
- [ ] Worker 发布 `background.snapshot-updated`（queued、running、progress、failed、idle
  任一状态）后，Vault facade 的 `onStatusChange` 调用次数为零，Keyspace listener 调用
  次数为零。
- [ ] 同一前提下，Broadcast reconnect coordinator 的 `connectForOwner`、HubCast provider
  的 `bind` 与 `close` 调用计数均不变。这是本单针对“立即同步断广播”的强制回归测试。
- [ ] `apps/web/src/keymasterSessionCoordinatorClient.test.ts` 使用真实 client、SharedWorker
  fake port 与 Hub，证明 `background.snapshot` 只通知 Background topic listener。
- [ ] `packages/plugin-vault/src/vaultServiceCoordinator.test.ts` 使用 topic publish harness，
  证明 Background event 不触发 Vault lifecycle listener。
- [ ] `packages/plugin-background/src/backgroundServiceCoordinator.test.ts` 证明 Background
  facade 保留 error、progress、attempt/nextRun 等完整 UI 字段。
- [ ] `apps/web/src/coordinatorDomainIsolation.test.ts` 组合真实 client、三类 facade 与
  Broadcast lifecycle；只有该组合测试通过，才勾选“后台更新不重绑 HubCast”。
- [ ] Vault `locked -> unlocked` 加上相同 active key 的 keyspace event 最终只产生一次 bind；
  之后任意 background/data event 不增加 bind 数。
- [ ] active key 真正变更时，旧 HubCast session 至多关闭一次，新 identity 至多 bind 一次；
  相同 key/generation/revision 的重复 event 不产生操作。
- [ ] HubCast remote close 只触发固定延迟重连，不生成 Vault/Background event。
- [ ] `subscribe` 与发布并发时，client 最终得到严格连续的 topic revision；不丢更新、不重复
  副作用。断线、重连、Worker restart、旧 epoch event 都有测试。
- [ ] BackgroundTray 的快速失败最终能显示 last error/attempt；selector 不得因 state 回到
  `idle` 而吞掉更新。
- [ ] `pnpm typecheck`、相关 Vitest 集、`pnpm test`、`pnpm lint:boundaries` 必须通过。

### 8.2 最终行为验收

- [ ] 已解锁且 HubCast bound 时，任一 tab 连续点击任一后台任务“立即同步一次”、等待完成、
  失败、取消、查看托盘或修改同步设置，HubCast websocket 不关闭、不重绑，广播订阅持续有效。
- [ ] 同时打开多个 tab 并在任意 tab 发起上述操作，所有 tab 收到一致的 Background UI
  状态；没有一次操作引起 Vault 状态、active key 或 Broadcast 状态改变。
- [ ] 在任一 tab 正常 unlock、lock、切换 active key、删除 active key 时，所有 tab 的
  Vault/Broadcast 行为仍符合既有会话和 epoch/generation 安全规则。
- [ ] HubCast 服务端主动断开时，只有 Broadcast 页面显示短暂 reconnect；后台托盘、Vault
  状态和 active key 保持不变。
- [ ] Vault 锁定时点击“立即同步”仍返回明确 blocked，且不触发网络请求、Broadcast bind 或
  全局 fatal。

### 8.3 静态验收

- [ ] 除 client 内部仅供启动/诊断的私有 cache 外，生产代码不存在可供 facade/插件订阅的
  Coordinator `onStateChange`。
- [ ] `rg` 扫描不命中第 4.2 节列出的跨域链路；任何命中必须是历史施工单或测试中明确的
  负向断言。
- [ ] `packages/plugin-background` 不导入 BroadcastCore/HubCast/Coordinator transport internals；
  `packages/plugin-broadcast` 不导入 Background facade 或 Coordinator transport internals。
- [ ] protocol schema、日志测试与类型检查证明 event/snapshot payload 不含敏感材料。
- [ ] 第 6.4 节禁止的旧名在生产代码中零命中；新导出的 API、变量和日志 event 名能从
  名称直接辨认领域、状态对象和副作用 owner。

验收结论只能在上述自动化、行为、静态与全量构建检查全部通过后给出。任何“保留全局
state listener 再靠调用方 if 判断”“Background event 上仍能到达 Vault facade”“用重连
节流掩盖重复 bind”“为旧 API 留 adapter”的实现，均不符合本单。
