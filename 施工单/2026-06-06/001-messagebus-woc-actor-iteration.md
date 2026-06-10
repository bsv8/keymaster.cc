# 001 统一 MessageBus 与 WOC Actor 一次性迭代施工单

## 目标

把系统消息基础设施统一为 `MessageBus`，并以 WOC 为第一个 actor 化落地点。

本次方向不是保留 `EventBus` 再旁路新增一套系统，而是直接把旧 `EventBus` API 替换为 `MessageBus` API。替换后：

```txt
事件通知      -> messageBus.publish / subscribe
命令投递      -> messageBus.dispatch
请求响应      -> messageBus.request
actor mailbox -> target + handler 策略
后台任务触发  -> BackgroundService 定时 dispatch 消息
持久状态      -> IndexedDB 只保存必须恢复的消息或业务状态
```

第一轮落地必须保持系统可运行，不能一次性把所有业务都改成持久消息系统。正确顺序是先统一总线 API，再把 WOC 内部改成 mailbox actor，最后逐步把 P2PKH / Transfer / Background 迁移为消息驱动。

## 设计缘由

1. 当前系统已经天然是异步系统：Vault 解锁、key 删除、P2PKH 同步、WOC 查询、后台回填、转账广播都不是单一同步调用能安全表达的流程。
2. `EventBus` 只有同步广播语义，不能表达请求响应、命令生命周期、优先级、目标 actor、取消、超时和持久化。
3. 直接并存 `EventBus + CommandBus + ActorBus` 会让调用方需要理解多套入口，后续插件容易选错入口。
4. 统一 `MessageBus` 可以保留细分语义，但底层只有一套 message envelope、订阅、handler、快照和测试模型。
5. WOC 当前已经有队列、优先级、限流、429 backoff 和跨标签页协调，天然就是 actor，只是还没有明确建模。
6. WOC 官方公共 API 的每秒 3 次上限过紧。默认值必须保守改为每秒 2 次，给服务端窗口、同 IP 其它请求、浏览器调度误差和 429 backoff 留余量。

## 核心不变量

1. 不保留旧 `EventBus` API。代码中不能继续出现 `events.emit(...)`、`events.on(...)`、`EventBus` 作为运行时消息契约。
2. 第一阶段 `publish / subscribe` 的 handler 调用顺序必须与旧 `EventBus` 保持等价：同一 tick 内同步调用订阅者。异步化只能通过显式 `dispatch / request / target actor` 引入。
3. `MessageBus` 是统一入口，但消息语义必须通过字段表达，不能把事件、命令、请求混成无法区分的字符串调用。
4. actor 是 `MessageBus` 的 handler 策略，不是另一套总线。
5. WOC 所有请求仍必须经过 `woc.service` capability。业务插件禁止直接 `fetch` WOC，也禁止绕过 WOC actor。
6. WOC 默认 `requestsPerSecond` 必须改为 `2`。
7. 广播优先级最高，但不能绕过 WOC 限流和 backoff。
8. 只有需要刷新后恢复的消息或业务状态才能进入 IndexedDB。普通 WOC 查询不持久化。
9. BackgroundService 不直接承载业务逻辑。它负责按时间、在线状态、页面可见性或用户动作投递消息。
10. 代码里的错误信息使用英文；文档、注释和页面文案使用中文。

## 统一术语

### Message

统一消息 envelope：

```ts
export type MessageMode = "event" | "command" | "request";

export interface Message<TPayload = unknown> {
  id: string;
  type: string;
  mode: MessageMode;
  payload: TPayload;
  target?: string;
  priority?: number;
  durable?: boolean;
  scheduledAt?: number;
  timeoutMs?: number;
  correlationId?: string;
  causationId?: string;
  createdAt: number;
}
```

设计缘由：

```txt
type 表达业务含义。
mode 表达调用语义。
target 表达由哪个 actor mailbox 消费。
priority 给 WOC / Transfer / 后台任务等调度策略使用。
durable 决定是否进入 IndexedDB。
correlationId / causationId 用来串起一次转账、同步或删除 key 触发的后续消息。
```

### MessageBus

```ts
export interface MessageBus {
  publish<TPayload>(type: string, payload: TPayload, options?: PublishOptions): string;
  subscribe<TPayload>(type: string, handler: MessageHandler<TPayload>): () => void;

  dispatch<TPayload>(type: string, payload: TPayload, options?: DispatchOptions): string;

  request<TPayload, TResult>(
    type: string,
    payload: TPayload,
    options?: RequestOptions
  ): Promise<TResult>;

  handle<TPayload, TResult>(
    type: string,
    handler: MessageHandler<TPayload, TResult>,
    options?: HandlerOptions
  ): () => void;

  snapshot(): MessageBusSnapshot;
  onSnapshot(handler: (snapshot: MessageBusSnapshot) => void): () => void;
}
```

约束：

1. `publish` 只用于“已经发生”的事件，不等待业务完成。
2. `dispatch` 用于“请系统做某事”，返回 `messageId`。
3. `request` 用于需要结果的请求，返回 `Promise<TResult>`。
4. `handle` 注册消息处理器。带 `target` 的 handler 进入对应 actor mailbox。
5. `subscribe` 是事件订阅便利 API，只订阅 `mode = event` 的消息。

### Actor Mailbox

actor 不是独立服务，而是 `MessageBus` 内部按 `target` 分组的 mailbox：

```txt
target = woc
  WOC 请求排队、优先级、限流、429 backoff、fetch、取消、超时。

target = p2pkh.sync
  P2PKH 资源同步、回填协调、写入本地缓存。

target = transfer
  转账准备、广播、pending 状态、未知结果恢复。
```

第一轮只要求落地 `target = woc`。

## 实施总顺序

本施工单分 5 个阶段。可以分多个 commit 做，但阶段顺序不能颠倒。

```txt
阶段 1：新增 MessageBus 契约与 runtime 实现，删除 EventBus API。
阶段 2：机械迁移旧 events.emit/on 到 messageBus.publish/subscribe。
阶段 3：WOC 默认频率改为 2，并修正 429 backoff 前后调度。
阶段 4：WOC service 内部改为 MessageBus request + target=woc actor mailbox。
阶段 5：BackgroundService 和 P2PKH 只做轻量接入，不做全系统持久消息化。
```

## 阶段 1：新增 MessageBus，替换 EventBus 契约

### 文件级改动

新增：

```txt
packages/contracts/src/messageBus.ts
packages/runtime/src/messageBus.ts
packages/runtime/src/messageBus.test.ts
```

修改：

```txt
packages/contracts/src/index.ts
packages/runtime/src/createPluginHost.ts
packages/runtime/src/index.ts
```

删除或停止导出：

```txt
packages/contracts/src/eventBus.ts
packages/runtime/src/eventBus.ts
```

### 怎么做

1. 在 `contracts` 中定义 `MessageBus`、`Message`、`MessageMode`、`PublishOptions`、`DispatchOptions`、`RequestOptions`、`HandlerOptions`、`MessageBusSnapshot`。
2. 在 `runtime` 中实现 `createMessageBus()`。
3. `createPluginHost` 中 provide：

```txt
runtime.messageBus
```

4. `PluginContext` 暴露的 `events` 字段必须移除，或者改为 `messageBus` 字段。不能让 manifest 同时拿到两套总线。
5. 第一阶段 `publish / subscribe` 必须同步调用 handler，保持旧行为。

### 不能怎么做

1. 不能保留 `runtime.events` capability 作为兼容层。
2. 不能把 `publish` 做成异步队列后直接替换旧 `emit`。这会改变 `vault.unlocked`、`key.deleted`、UI notify 的时序。
3. 不能让 `MessageBus` 依赖 React。
4. 不能在 `contracts` 中引入 runtime 实现类型。

### 特殊情况

1. 如果某个旧 handler 是 `async` 函数，`publish` 不等待它完成。旧 `EventBus` 也不等待，保持一致。
2. 如果 handler 抛错，`publish` 不应阻断后续 handler。记录 `lastError` 到 snapshot，并继续调用其它 handler。
3. 如果 handler 内取消订阅自己，当前 publish 应使用 handler 快照，避免迭代集合被修改。

### 阶段验收

1. 项目中不再有 `createEventBus`。
2. `contracts` 不再导出 `EventBus`。
3. `runtime.messageBus` capability 存在。
4. `messageBus.publish/subscribe` 单测覆盖同步调用、取消订阅、handler 抛错不影响其它 handler。

## 阶段 2：机械迁移旧 EventBus 调用

### 文件级改动

修改：

```txt
packages/plugin-vault/src/manifest.ts
packages/plugin-vault/src/vaultService.ts
packages/plugin-vault/src/keyspaceService.ts
packages/plugin-vault/src/KeySwitchWidget.tsx
packages/plugin-vault/src/vaultService.test.ts
packages/plugin-vault/src/keyspaceService.test.ts

packages/plugin-p2pkh/src/manifest.ts
packages/plugin-p2pkh/src/p2pkhService.ts
packages/plugin-p2pkh/src/p2pkhRecentSync.ts
packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts
packages/plugin-p2pkh/src/p2pkhTransferService.ts
packages/plugin-p2pkh/src/p2pkhAssetProvider.ts
packages/plugin-p2pkh/src/p2pkhTransferProvider.ts

packages/plugin-key-import/src/ImportPage.tsx
```

### 怎么做

替换规则：

```txt
ctx.get<EventBus>("runtime.events")
  -> ctx.get<MessageBus>("runtime.messageBus")

useCapability<EventBus>("runtime.events")
  -> useCapability<MessageBus>("runtime.messageBus")

events.emit("x.y", payload)
  -> messageBus.publish("x.y", payload)

events.on("x.y", handler)
  -> messageBus.subscribe("x.y", handler)
```

变量命名统一从 `events` 改成 `messages` 或 `messageBus`。

### 不能怎么做

1. 不能为了少改代码继续把变量命名为 `events`。
2. 不能把所有 `publish` 改成 `dispatch`。旧事件只是通知，不是命令。
3. 不能在这个阶段改变业务事件名，例如 `vault.unlocked`、`p2pkh.sync`、`key.deleted` 必须保持原字符串。

### 特殊情况

1. UI provider 里原本用事件触发 `notify()`，继续用 `subscribe`。
2. `key.deleting` / `key.deleted` 的清理时序敏感，迁移后必须补测或保留原测试。
3. 测试中的手写 fake bus 应实现 `publish`、`subscribe`，并记录消息。

### 阶段验收

1. `rg "events\\.(emit|on|off)|EventBus|runtime.events|createEventBus" packages apps` 无业务引用。
2. Vault、Keyspace、P2PKH 原有事件相关测试通过。
3. 导入 key、删除 key、切换 active key、广播后触发 recent-sync 的路径仍可运行。

## 阶段 3：WOC 默认限流改为 2，并修正 429 调度

### 文件级改动

修改：

```txt
packages/plugin-woc/src/wocSettings.ts
packages/plugin-woc/src/pages/WocSettingsPage.tsx
packages/plugin-woc/src/wocService.ts
packages/plugin-woc/src/wocService.test.ts
施工单/2026-06-05/004-woc-background-transfer-widget-hard-switch.md
```

### 怎么做

1. `DEFAULT_WOC_CONFIG.requestsPerSecond` 从 `3` 改成 `2`。
2. WOC 设置页文案改为“公共 API 建议默认 2；自定义代理可提高”。
3. `wocService` 在 `acquireSlot()` 返回后、真正 `fetch` 前必须重新检查 `backoffUntil`。
4. 如果等待 slot 期间已有请求返回 429 并设置 backoff，当前 entry 不能继续发出，应回到队列或继续等待 backoff。
5. 新增测试覆盖：

```txt
默认配置为 2。
slot 等待期间触发 429 后，不继续发下一条请求。
backoff 解除后队列能继续消费。
```

### 不能怎么做

1. 不能只改 UI 文案不改默认值。
2. 不能只依赖服务端 429 再 backoff。公共 API 默认必须主动保守。
3. 不能让 broadcast 绕过限流。
4. 不能在 P2PKH 层手动 sleep 来“辅助限流”。限流必须集中在 WOC。

### 特殊情况

1. 已存在用户本地 `woc.settings` 且保存了 `requestsPerSecond = 3` 时，不强行覆盖用户设置。
2. 如果用户点“恢复缺省”，必须恢复到 `2`。
3. 自定义 WOC 代理可以设置大于 2 的频率，但仍必须走同一个队列和 backoff。

### 阶段验收

1. 新安装默认 WOC 频率为 2。
2. 旧用户显式设置不被静默覆盖。
3. 触发 429 后，队列进入全局 backoff，backoff 期间不发新请求。
4. `npm test -- packages/plugin-woc/src/wocService.test.ts` 通过。

## 阶段 4：WOC service 内部 actor 化

### 文件级改动

新增：

```txt
packages/plugin-woc/src/wocMessages.ts
packages/plugin-woc/src/wocActor.ts
packages/plugin-woc/src/wocActor.test.ts
```

修改：

```txt
packages/plugin-woc/src/wocService.ts
packages/plugin-woc/src/manifest.ts
packages/plugin-woc/src/pages/WocSettingsPage.tsx
packages/plugin-woc/src/wocService.test.ts
```

### 怎么做

1. 定义 WOC 消息类型：

```txt
woc.balance.confirmed
woc.balance.unconfirmed
woc.utxos.confirmed
woc.utxos.unconfirmed
woc.history.confirmed
woc.history.unconfirmed
woc.tx.broadcast
```

2. `wocService` 的 public API 保持不变，但内部从直接 `enqueue` 改为：

```txt
woc method -> messageBus.request(type, payload, { target: "woc", priority, signal, timeoutMs })
```

3. `wocActor` 注册 `target = "woc"` 的 handler，统一处理：

```txt
优先级选择
连续窗口限流
Web Locks 协调
429 backoff
fetchJson
404 空结果 endpoint 翻译
取消
超时
snapshot 通知
```

4. `woc.service` 仍是业务插件唯一依赖的 capability。业务插件不直接拿 `messageBus.request("woc.*")`。
5. WOC actor 的 mailbox 使用内存消息，不做 IndexedDB 持久化。

### 不能怎么做

1. 不能让 P2PKH 直接发 `woc.*` 消息。P2PKH 仍通过 `WocService` 类型化方法访问 WOC。
2. 不能把 WOC actor 放进 runtime。WOC endpoint、WOC 响应结构、429 策略属于 `plugin-woc`。
3. 不能把普通 WOC 查询持久化到 IndexedDB。
4. 不能在 actor 外部重复实现限流。
5. 不能因为使用 MessageBus 就丢掉 `WocService` 的类型化契约。

### 特殊情况

1. Web Locks 不可用时，继续声明 `coordinated = false`，只能保证单标签页限流。
2. request 被取消时，未开始的消息标记为 `canceled`；已开始 fetch 的请求通过 AbortController 取消。
3. 404 空结果仍只在 UTXO / history endpoint 层翻译，不扩大到 broadcast。
4. 429 必须设置全局 backoff，并通知 WOC snapshot。

### 阶段验收

1. `WocService` 外部 TypeScript API 未破坏。
2. `plugin-p2pkh` 不需要知道 WOC 消息类型。
3. WOC 队列 snapshot 能显示 queued、inFlight、backoffUntil、lastError、coordinated。
4. WOC actor 单测覆盖优先级、取消、429、默认 2/s、Web Locks 协调。

## 阶段 5：Background 与 P2PKH 轻量接入

### 文件级改动

修改：

```txt
packages/plugin-background/src/backgroundService.ts
packages/plugin-p2pkh/src/p2pkhService.ts
packages/plugin-p2pkh/src/p2pkhRecentSync.ts
packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts
```

可选新增：

```txt
packages/plugin-p2pkh/src/p2pkhMessages.ts
```

### 怎么做

1. BackgroundService 第一轮不重写为 actor，只把未来职责边界写入注释：

```txt
BackgroundService 负责触发消息，不直接拥有业务状态。
```

2. P2PKH 仍可直接调用 `woc.service`，不强制改成 `messageBus.dispatch("p2pkh.sync.*")`。
3. 可以新增 P2PKH 消息类型常量，但不要求完成 P2PKH actor 化。
4. 保证现有 recent-sync / backfill / transfer broadcast 流程在 MessageBus API 替换后不退化。

### 不能怎么做

1. 不能在本阶段同时把 P2PKH recent-sync、backfill、transfer 全部改成持久 actor。范围过大。
2. 不能让 BackgroundService 直接理解 WOC、UTXO、history、transfer。
3. 不能把 `p2pkh.transfer.broadcast` 这类通知误改成 command 后导致 UI 不刷新。

### 特殊情况

1. 如果替换 MessageBus 后发现 key 删除或 unlock 时序变化，优先保持 `publish` 同步语义，不要临时加 sleep。
2. 如果 P2PKH 同步触发过多，先通过 WOC actor 限流和 Background 合并 rerun 处理，不在 UI 层防抖。

### 阶段验收

1. Vault 解锁后 P2PKH 能 rehydrate 并触发 recent/backfill。
2. 转账广播后 `p2pkh.transfer.broadcast` 仍触发 recent-sync 和 provider notify。
3. 删除 key 时 P2PKH 任务取消、DB handle 释放、资源不复活。
4. Background 托盘状态仍能显示运行、排队、失败、暂停。

## 最终目标结构

```txt
packages/
  contracts/
    src/
      messageBus.ts
      woc.ts
      background.ts
      keyspace.ts
      vault.ts
      plugin.ts
      index.ts

  runtime/
    src/
      messageBus.ts
      createPluginHost.ts
      index.ts

  plugin-woc/
    src/
      wocMessages.ts
      wocActor.ts
      wocService.ts
      wocSettings.ts
      pages/
        WocSettingsPage.tsx

  plugin-background/
    src/
      backgroundService.ts

  plugin-p2pkh/
    src/
      p2pkhService.ts
      p2pkhRecentSync.ts
      p2pkhHistoryBackfill.ts
      p2pkhTransferService.ts
```

最终不应继续存在：

```txt
packages/contracts/src/eventBus.ts
packages/runtime/src/eventBus.ts
runtime.events capability
EventBus 类型引用
events.emit / events.on 调用
```

## 最终验收清单

### 静态检查

1. `rg "EventBus|runtime.events|createEventBus|events\\.(emit|on|off)" packages apps` 无业务引用。
2. `rg "api\\.whatsonchain\\.com|fetch\\(" packages/plugin-p2pkh packages/plugin-transfer packages/plugin-assets` 不出现 WOC 直连。
3. `packages/contracts/src/index.ts` 导出 `messageBus.ts`，不导出 `eventBus.ts`。
4. `packages/runtime/src/createPluginHost.ts` provide `runtime.messageBus`。
5. `packages/plugin-woc/src/wocSettings.ts` 默认 `requestsPerSecond` 为 `2`。

### 单测与类型检查

必须通过：

```txt
npm run typecheck
npm test -- packages/plugin-woc/src/wocService.test.ts
npm test -- packages/plugin-woc/src/wocActor.test.ts
npm test -- packages/runtime/src/messageBus.test.ts
npm test -- packages/plugin-vault/src/vaultService.test.ts
npm test -- packages/plugin-vault/src/keyspaceService.test.ts
```

如果某个测试文件尚未存在，应在对应阶段新增。

### 行为验收

1. 新用户打开 WOC 设置页，每秒请求数显示为 2。
2. 手动保存 WOC 频率后刷新页面，用户设置保持不被默认值覆盖。
3. WOC 多个请求同时提交时，实际发起请求受 WOC actor 统一限流。
4. WOC 收到 429 后进入全局 backoff，backoff 期间不继续发新请求。
5. Broadcast 优先级高于 backfill，但仍遵守限流。
6. Vault 解锁后，P2PKH recent-sync 和 backfill 仍按原规则触发。
7. Vault 锁定后，P2PKH 后台任务被取消，不继续读取 key-scoped storage。
8. key 删除期间，`key.deleting` / `key.deleted` 相关清理顺序不退化。
9. 转账广播成功后，资产 provider 和转账 provider 能刷新状态。
10. 多标签页下，支持 Web Locks 的浏览器仍显示 WOC coordinated=true；不支持时显示 false。

## 后续迭代方向

本施工单完成后，才进入下一轮：

```txt
002 P2PKH Sync Actor 化
003 Transfer Durable Command 化
004 BackgroundService 改为纯消息调度器
005 Durable MessageStore 与恢复机制
```

后续迭代不能反向恢复 `EventBus` API，也不能让业务插件绕过 `MessageBus` 和 capability 边界。
