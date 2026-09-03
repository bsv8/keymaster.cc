# HubMsg、HubCast 移除与 Channel 通讯录在线能力施工单

> 状态：阻断整改中（代码整改已落地；外部协议发布与真实多参与方 E2E 仍阻断发布）
>
> 优先级：P0
>
> 目标：彻底删除 HubMsg、HubCast 及其 Provider 中间层；以
> `SatSubscriptionProtocol + ChannelProtocol` 建立唯一频道运行时；向内部插件和
> Keymaster Connect App 开放受 Session Window 控制的任意精确频道；使用
> `bsv8.ping.v1` 为通讯录提供“在线 / 失联”能力。

关联项目：

- `/home/david/Workspaces/SatSubscriptionProtocol`
- `/home/david/Workspaces/ChannelProtocol`
- `/home/david/Workspaces/keymaster.cc`

本单是以下旧结论的后续硬切换真值：

- 废弃“继续保留 HubMsg、由用户选择 active MessageProvider”；
- 废弃“Connect App 只能使用 `appmsg.*`，不能使用频道”；
- 废弃 HubCast/BroadcastProvider 与 HubMsg/MessageProvider 双轨架构；
- 与 `施工单/2026-08-31/001-sat-subscription-channel-appmsg-spi-capability.md`、
  `施工单/2026-09-02/002-SatSubscription移除外部适配层与资源闭环返工.md`
  冲突时，以本单为准。

## 1. 已冻结需求

以下结论已经对齐，施工中不得自行恢复旧语义。

### 1.1 删除 HubMsg 和 HubCast

1. 删除 HubMsg 连接、Wire、Provider、设置、健康检查和在线查询。
2. 删除 HubCast 连接、Wire、Provider、设置和广播签名壳。
3. 删除 MessageProvider、BroadcastProvider、active provider 选择及对应 registry。
4. 不建立 HubMsg/HubCast 到新 Channel API 的兼容适配器。
5. 不保留旧方法 alias、旧事件 alias、旧配置迁移或“双写一段时间”。

### 1.2 历史和在线查询边界

1. SatSubscription 不支持远端历史，也不支持离线补拉。
2. 消息历史只来自 Keymaster 本地数据库。
3. 删除通用 transport/provider 的 `list/get remote history` 能力。
4. 删除 HubMsg/AppMsg 通用 `checkOnline`、批量在线查询和
   `MessageProvider.features.onlineQuery`。
5. 通讯录 Ping/Pong 是新的本地业务能力，不恢复 Provider 在线查询抽象。

### 1.3 Connect App 身份边界

Connect App 的所有 Channel 调用都使用当前 Keymaster owner 公钥身份：

- owner 公钥只从已经验证的 Connect session 取得；
- App 不得传入 owner、sender、publisher、payer 或签名者身份；
- App 不得传入私钥、签名、CP `message_id`、签名时间、SSP `request_id`；
- App 不得选择 Supplier，也不得看到 Supplier 余额、扣费或连接细节；
- App 只传应用参数；Session Window 负责 exact origin 权限、频道范围、订阅数量、
  Publish 频率、字节量和并发量控制；
- owner 切换、Vault lock、session 关闭或 session epoch 变化后，旧调用和旧订阅立即失效。

### 1.4 任意频道

1. 内部插件和 Connect App 可以使用任意合法的 SSP **精确频道**。
2. 第一版不向 App 开放 SSP `*` 通配订阅。
3. App 不接触原始 SSP Wire；Keymaster 使用 ChannelProtocol 创建和验证可独立验真的
   Channel 内容。
4. App 自定义协议放在应用 `content` 中；Keymaster 不为每个 App 协议建立 registry。
5. `bsv8.inbox.*` 是平台私密收件箱命名空间，由固定 inbox 路由器处理；普通 App
   不得提交已经封装好的私密信封绕过 Keymaster 身份和加密边界。

## 2. 最终最小架构

```text
内部插件 / Connect App
  ├─ channel.publish(channel, content)
  └─ channel.subscription_set(channels)
             │
             ▼
Session Window
  └─ owner 身份、exact origin ACL、频率/字节/数量限制
             │
             ▼
Coordinator SharedWorker
  ├─ Channel 公共消息签名与验签
  ├─ 私密 owner inbox 固定协议路由
  ├─ ChannelSubscriptionMux
  └─ 当前 owner / session epoch / Vault 门禁
             │
             ▼
plugin-sat-subscription
  └─ SSP Publish / Subscribe / Unsubscribe / Supplier / SPI
```

只保留以下运行时概念：

1. 一个 Coordinator Channel runtime；
2. 一个 `ChannelSubscriptionMux`；
3. 一个固定 owner inbox 路由器；
4. SatSubscription 已有 Supplier/SSP/SPI 运行时；
5. 各业务插件自己的本地数据库和业务状态。

禁止新增：

- ChannelProvider、PresenceProvider 或 OnlineProvider registry；
- 每种 App 协议一个 transport adapter；
- 第二套订阅状态机；
- 通用 Command/Handler/Lifecycle 框架；
- Contacts 专用网络进程；
- 页面组件中的轮询 `setInterval`。

## 3. Connect Channel API 硬切换

删除以下 Connect 方法和事件：

```text
appmsg.send
appmsg.list
appmsg.get
appmsg.message_received
broadcast.publish
broadcast.subscription_set
broadcast.subscription_list
broadcast.message_received
```

新增且只新增：

```ts
interface ChannelPublishParams {
  /** 要发布到的 SSP 精确频道；不能是通配符。 */
  channel: string;

  /** App 自己定义的 JSON 内容；协议标识如有需要也放在这里。 */
  content: JSONValue;
}

interface ChannelPublishResult {
  /** Keymaster 生成的 ChannelProtocol 消息编号。 */
  messageId: string;
}

interface ChannelSubscriptionSetParams {
  /** 替换当前 caller 的完整精确频道集合；空数组表示全部释放。 */
  channels: string[];
}

interface ChannelSubscriptionSetResult {
  /** 通过校验并属于当前 caller 的期望频道集合。 */
  channels: string[];
}

interface ChannelMessageReceivedEventData {
  /** 实际收到消息的精确频道。 */
  channel: string;

  /** ChannelProtocol 验签得到的作者公钥，不接受 Supplier 或 App 自报。 */
  publisherPublicKeyHex: string;

  /** ChannelProtocol 消息编号。 */
  messageId: string;

  /** 已验签的 App JSON 内容。 */
  content: JSONValue;
}
```

对外方法和事件名：

```text
channel.publish
channel.subscription_set
channel.message_received
```

消融决定：

- 不提供 `channel.subscription_list`；App 自己持有最后一次 set 的集合；
- 不提供远端历史 `list/get`；
- 不提供 `channel.checkOnline`；
- 不返回 `supplierId`、`requestId` 或 `chargedAmount`；
- `messageId`、时间、公钥和签名全部由 Keymaster/ChannelProtocol 产生；
- `connectSessionId` 属于 SDK 与 Session Window 的传输上下文，不进入 App 业务参数；
- 同一 origin 的事件只投递给当前 session 已订阅的 exact channel。

如果 ChannelProtocol 当前 SDK 不能为任意公开精确频道构造和验证统一签名消息，应先在
`/home/david/Workspaces/ChannelProtocol` 增加最小公共原语并完成 Go/TypeScript 固定向量；
不得在 Keymaster 内复制签名格式，也不得恢复 HubCast envelope。

## 4. ChannelSubscriptionMux

### 4.1 所有权

`ChannelSubscriptionMux` 位于 Coordinator SharedWorker，是唯一订阅协调者。
App、插件和业务页面看到的是虚拟订阅，不直接调用 Supplier Subscribe/Unsubscribe。

调用方标识由平台产生：

```text
Connect App  → owner epoch + exact origin + connect session
内部插件     → owner epoch + plugin id
系统消费者   → owner epoch + 固定 system id
```

调用方不得传 `consumerId`、owner 或 Supplier。

### 4.2 Replace 与 union 语义

每个 caller 只有一个频道集合：

```text
desiredByConsumer[consumerId] = Set<channel>
physicalDesired = union(desiredByConsumer.values())
```

状态变化规则：

- 频道引用数 `0 → 1`：对当前 owner 的 receive Suppliers 发起一次真实 Subscribe；
- 引用数 `1 → 0`：发起一次真实 Unsubscribe；
- 引用数保持大于零：不得重复收费 Subscribe；
- 一个 App 释放频道时，不影响仍在使用该频道的其它 App/插件；
- session 关闭、超时、origin 撤权、Vault lock、切 owner 时自动释放该 caller 全部集合；
- `subscription_set([])` 等价于释放当前 caller 的全部集合。

### 4.3 持久化消融

- per-caller 虚拟集合只保存在 SharedWorker 内存；
- 物理订阅真值放在当前 owner key-scoped Sat DB，按
  `(ownerPublicKeyHex, supplierId, channel)` 保存 desired/observed/status 等对账状态；
- 每个 Supplier × 频道三元组独立确认成功或失败，部分成功不得回滚已成功的三元组；
- `unknown_result` 必须先查询远端真值，再决定是否补发 Subscribe/Unsubscribe，禁止盲目重扣；
- Worker 重启后 Connect App 必须重新执行 `subscription_set`；
- 重启恢复不得伪造旧 Connect session；
- 复用 SatSubscription 已有 desired/observed/reconcile 状态，不新建第二套远端订阅状态机。

## 5. 固定 owner inbox 路由器

owner inbox 先完成 ChannelProtocol 解密、时间检查和验签，再按固定协议显式分派：

```text
bsv8.message.v1        → 本地消息 Deliver / ACK 处理器
bsv8.webrtc.signal.v1  → WebRTC 信令处理器
bsv8.ping.v1           → Contacts Ping / Pong 处理器
未知私密协议           → UNSUPPORTED_PROTOCOL，明确拒绝
```

约束：

- 使用 `switch`/固定联合类型，不建立 runtime protocol registry；
- 去重键遵守 ChannelProtocol：`(protocol, from_public_key, message_id)`；
- 所有业务处理发生在解密、时间检查和验签之后；
- 不从 body 字段猜测协议；
- owner inbox 只需要一个系统级虚拟订阅，不为每个联系人或子协议建立订阅。
- WebRTC V1 只在线上传输文件传输所需的 `offer`、`answer`、`ice-candidate`、
  `end-of-candidates`；音视频呼叫在正式呼叫会合协议发布前关闭。reject/busy/hangup
  不伪造 ChannelProtocol wire 分支，文件传输元数据和分片走已建立的 DataChannel。

## 6. `bsv8.message.v1` 与本地历史重构

`bsv8.message.v1` 继续作为 ChannelProtocol 已冻结的私密 Deliver/ACK 子协议，但不再是
HubMsg/AppMsg Provider 的传输壳。

施工要求：

1. `plugin-message` 成为 Keymaster 本地消息历史的业务 owner。
2. 发出的 Deliver 写入当前 owner 的本地历史；接收的有效 Deliver 也写入本地历史。
3. ACK 是一条独立的新 CP 私密消息，发布到原发送者 owner inbox；不得依赖 Supplier
   返回路径。
4. ACK 只证明对方 Keymaster 在线接收并完成本地落库，不代表远端历史服务。
5. 接收者离线时没有远端补拉；后续重新上线不会从 Supplier 取回旧 Deliver。
6. 删除 provider `listMessages/getMessage/checkOnline/connect/disconnect` 语义。
7. 内部所有使用 AppMsg endpoint/provider 的应用逐一改为直接使用固定 inbox 路由和自己的
   本地业务服务。
8. WebRTC 不再用在线查询作为建连门禁；直接尝试建连，通讯录在线状态只能作为 UI 提示。

## 7. 通讯录 Ping/Pong 在线能力

### 7.1 产品语义

通讯录只公开两个状态：

```ts
type ContactPresenceState = "online" | "offline";
```

中文含义：

- `online`：有效时间窗口内收到过解密、验签且关系校验正确的 Pong；
- `offline`：当前没有有效 Pong 证据，UI 固定显示“失联”。

以下情况全部属于 `offline`，不再向通讯录区分 `no_response` 和 `unknown`：

- 尚未探测；
- Ping 超时；
- Publish 失败或结果不确定；
- SatSubscription 未连接；
- Vault 锁定；
- 在线证据过期；
- SharedWorker 重启导致内存证据丢失。

不把 `state` 写进联系人实体。只保存运行期证据：

```ts
interface ContactPresence {
  /** 联系人压缩公钥 hex。 */
  publicKeyHex: string;

  /** 最近一次收到有效 Pong 的本地时间；没有或过期均为失联。 */
  lastPongAtMs?: number;
}
```

状态按 `lastPongAtMs` 与 `onlineTtlMs` 现算；第一版不持久化 Presence。Worker 重启后全部
联系人从“失联”开始。

### 7.2 后台探测任务

使用现有 Coordinator background runtime 注册：

```text
task id   = contacts.presence-probe
plugin id = contacts
key scope = 当前 active owner publicKeyHex
```

初始调度参数：

```ts
{
  probeIntervalMs: 5 * 60_000, // 每五分钟启动一轮
  probeTimeoutMs: 60_000,      // 与 bsv8.ping.v1 最大有效期一致
  maxProbePerRound: 32,        // 每轮最多探测的联系人数量
  maxConcurrentPublish: 4,     // 同时进行的 Publish 数量
  onlineTtlMs: 10 * 60_000     // 在线证据最多保留两个探测周期
}
```

联系人超过单轮上限时按有界游标轮转；不得每轮永远只探测排序靠前的联系人。任务必须响应
`AbortSignal`，并在所有状态提交前检查 owner epoch/key generation。

后台任务只负责决定“探测哪些联系人”和创建 Pending Ping；它不创建订阅，也不建立新网络
连接。当前 owner inbox 的系统订阅由 `ChannelSubscriptionMux` 统一持有。

### 7.3 Ping 发起

1. 从当前 owner key-scoped Contacts DB 读取联系人公钥；
2. 使用 ChannelProtocol `newPing()` 创建 `bsv8.ping.v1` Ping；
3. Keymaster 使用当前 owner 私钥签名并加密；
4. 发布到 `bsv8.inbox.<联系人公钥>`；
5. 内存 Pending Map 保存 owner epoch、联系人公钥、Ping CP `message_id`、本地单调时钟起点
   和过期时间；
6. Pending 不写数据库；lock、切 owner、Worker teardown 时全部清空；
7. 第一版不自动重试，不进行多 Supplier 扇出。

### 7.4 自动 Pong

Pong 不是 SSP response，也不存在“沿 ingress Supplier 返回”。正确流程：

```text
接收方 owner inbox 路由器
  → 从已验签 Ping 取得 from_public_key
  → 创建新的 bsv8.ping.v1 Pong
  → channel = bsv8.inbox.<Ping 发起方公钥>
  → 作为一次独立 SatSubscription Publish
  → 发起方 owner inbox 路由器
```

硬约束：

- Pong 的接收者只从已验签 `ping.from_public_key` 推导；
- Pong body 只包含 `type: "pong"` 和 `ping_message_id`；
- 不读取、不保存、不携带 `ingressSupplierId`；
- 不复用 Ping 的 SSP request/response、连接或入站路径；
- Supplier 由正常的 SatSubscription 出站策略选择；Contacts 不理解 Supplier 路由；
- 对重复 Ping 按作者公钥 + `message_id` 去重；
- 自动响应按发送者和全局两级限流，避免远端触发无限付费 Pong；
- 通讯录决定主动探测谁；自动 Pong 不要求发送者已经存在于本地通讯录，避免形成“双方必须
  互加联系人”的隐藏条件。

### 7.5 Pong 接收

1. inbox 路由器先完成解密、时间检查和签名验证；
2. 用 ChannelProtocol `validatePongRelation(ping, pong)` 校验发送者、接收者、协议和
   `ping_message_id`；
3. 只有 Pending Map 中存在同一 owner epoch、同一联系人和同一 Ping 时才接受；
4. 使用本地单调时钟计算 RTT，RTT 只用于诊断，不进入通讯录公开状态；
5. 校验成功后更新 `lastPongAtMs` 并发布 Contacts presence resource 变化；
6. 伪造、迟到、重复、错误方向或关联错误的 Pong 不得把联系人改为在线。

### 7.6 运行边界

这里的“在线”准确含义是：

> 对方 Keymaster 在最近有效窗口内能够接收 Ping、解锁 owner、处理 ChannelProtocol 并发布
> 有效 Pong。

它不证明对方业务应用健康，也不保证下一条消息可达。当前 Web 架构依赖 Coordinator
SharedWorker；所有 Keymaster 页面关闭或浏览器挂起后，不承诺继续探测或响应。

## 8. 建议修改和删除范围

### 8.1 新增或重构

- `packages/contracts/src/protocol.ts`：`channel.*` 方法和事件、删除旧方法；
- `packages/connect/src/client.ts`：新 Channel SDK；
- `packages/plugin-protocol/src/protocolService.ts`：Session Window 校验、额度和事件隔离；
- `packages/plugin-sat-subscription/src/satProvider.ts`：通用已验证 Channel 入站、固定 inbox
  分派；
- `packages/plugin-sat-subscription/src/satState.ts`：物理订阅恢复所需最小状态；
- `apps/web/src/keymasterSessionCoordinator.worker.ts`：Channel runtime、SubscriptionMux、
  inbox 路由、Contacts 后台任务和 Pending Ping；
- `apps/web/src/keymasterSessionCoordinatorClient.ts`：受控 Channel/Presence snapshot RPC；
- `packages/contracts/src/contacts.ts`：`ContactPresence` 只读资源类型；
- `packages/plugin-contacts/src/*`：在线/失联展示，不在页面创建 timer；
- `packages/plugin-message/src/*`：本地历史与 `bsv8.message.v1` handler；
- `packages/plugin-webrtc/src/*`：删除 `checkPeerOnline` 依赖；
- `apps/connect-docs`、`docs/protocol`：Channel API、身份和无历史边界。

### 8.2 最终删除

完成调用方迁移后删除：

```text
packages/plugin-hubmsg
packages/plugin-hubcast
packages/plugin-broadcast
packages/plugin-appmsg
packages/contracts/src/messageProvider.ts
packages/contracts/src/broadcast.ts
```

`packages/contracts/src/appmsg.ts` 中只允许暂时保留尚未迁移的本地消息业务类型；最终应把仍
有价值的类型移动到 `plugin-message` 或更小的 contracts 文件，然后删除 Provider、endpoint、
HubMsg envelope 和在线查询类型。

同时清理：

- workspace package、依赖和 lockfile 条目；
- plugin catalog/bootstrap/ownership 顺序；
- capability 常量和 registry；
- HubMsg/HubCast 设置项、localStorage/IndexedDB 配置；
- Connect SDK 方法、事件联合、生成 API 文档；
- 测试 fixture、mock、文案、状态模块和图标；
- 所有 `HubMsg`、`HubCast`、`MessageProvider`、`BroadcastProvider`、
  `AppMsgOnlineStatus`、`checkPeerOnline` 引用。

禁止为了让旧测试通过而留下空实现或固定返回值。

## 9. 施工阶段

### CH-000：冻结基线与跨仓 Gate

- 固定 SatSubscriptionProtocol channel/content/resource limits；
- 固定 ChannelProtocol public message、Inbox、Deliver/ACK、WebRTC、Ping/Pong 向量；
- 验证任意公开精确频道签名能力；缺失时先在 ChannelProtocol 最小补齐；
- 为所有旧 AppMsg/Broadcast 消费者建立迁移清单；
- 更新旧施工单顶部状态，指向本单。

### CH-001：Channel contracts 与 Connect SDK

- 加入三项 `channel.*` 契约；
- 为所有英文字段补充中文说明；
- 加入禁止身份字段的 exact-object 校验；
- 为 Session Window 增加频道、数量、字节、频率和并发额度；
- 删除旧 `appmsg.*`、`broadcast.*` 外部契约和 SDK 方法。

### CH-002：Coordinator Channel runtime

- 把公共签名、私密 seal/open 保持在 SharedWorker；
- 将当前只接受 AppMessage 的 `channel.open` 改为固定协议联合；
- 建立公共频道验证和 owner inbox 固定分派；
- 所有异步边界检查 session epoch、owner 和 key generation。

### CH-003：ChannelSubscriptionMux

- 实现 per-caller replace 集合与引用计数 union；
- 对所有 receive Suppliers 应用真实订阅差量；
- 处理 unknown result、重连和已持久化物理集合对账；
- session/lifecycle 结束自动释放；
- 订阅事件只投递给仍有虚拟订阅的 caller。

### CH-004：Contacts Ping/Pong

- 注册 `contacts.presence-probe` Coordinator task；
- 接入 Ping Pending Map、Pong responder、关系验证和限流；
- 增加 Contacts presence resource；
- UI 只显示“在线 / 失联”；
- 删除 AppMsg/WebRTC 在线查询。

### CH-005：内部消息与 WebRTC 迁移

- `plugin-message` 接管本地历史；
- `bsv8.message.v1` 直接进入固定 inbox handler；
- ACK 改为到发送者 owner inbox 的独立 Publish；
- WebRTC 直接使用 `bsv8.webrtc.signal.v1`，不经过 AppMsg 在线状态；
- 迁移其它内部 AppMsg endpoint 消费者。

### CH-006：删除旧系统

- 删除 HubMsg、HubCast、plugin-appmsg、plugin-broadcast；
- 删除 Provider registries、active provider 和旧配置；
- 删除旧 Connect 方法、文档、测试和生成产物；
- 使用 `rg` 证明没有有效运行时代码残留。

### CH-007：真实验收

- 两个 owner、两个 Connect origin、真实 Chromium；
- 真实 Go SatSubscription Server；
- 相同频道多 caller 的订阅合并；
- 公共频道发布与事件隔离；
- 私密 Deliver/ACK、WebRTC、Ping/Pong；
- Vault lock、切 owner、session close、Worker 重启和 Supplier 重连；
- 费用次数与物理 Subscribe/Unsubscribe/Publish 次数一致。

## 10. 必测场景

### 10.1 身份与权限

- App 请求加入 `ownerPublicKeyHex`、`publisherPublicKeyHex`、签名、Supplier 等未知字段时
  fail closed；
- 发布消息作者只能是当前 session owner；
- App A 不能接收 App B 未订阅频道的事件；
- 同 origin 不同 session 的虚拟集合不互相覆盖；
- lock/切 key 后旧 epoch 的 Publish、订阅结果和事件全部丢弃。

### 10.2 订阅合并

- App A、App B 同时订阅频道 C，只产生一次物理 Subscribe；
- App A 清空后 App B 仍可接收，不能产生物理 Unsubscribe；
- 最后一个 caller 释放 C 时只产生一次物理 Unsubscribe；
- session 异常关闭能释放自己的集合；
- Worker 重启后清理旧物理订阅，并等待 App 重新 set；
- Subscribe/Unsubscribe unknown result 不造成无限重试或重复收费；双 Supplier 部分成功、
  Supplier 启停和 owner-scoped 物理记录按三元组对账；设置页只修改 `receiveSupplierIds`，
  不直接发起物理 Subscribe/Unsubscribe。

### 10.3 历史边界

- Connect contracts 中不存在远端 list/get；
- Supplier 离线期间产生的消息不会在重连后伪装成可补拉；
- Keymaster 本地消息历史不依赖 Supplier list/get；
- 删除本地 DB 后不能从远端恢复历史。

### 10.4 Ping/Pong

- Ping/Pong 最大有效期 60 秒；
- Pong 发布到 `bsv8.inbox.<Ping 发起方公钥>`；
- 不存在 ingress Supplier reply 逻辑；
- 正确 Pong 把联系人置为在线；
- 未探测、超时、断线、锁定、证据过期和 Worker 重启都显示失联；
- 错误发送者、错误接收者、错误 `ping_message_id`、过期和重复 Pong 不能置为在线；
- responder 限流达到上限后不继续产生付费 Pong；
- Contacts 数量超过单轮上限时最终每个联系人都能被轮转探测。

### 10.5 删除证明

以下搜索不得命中有效运行时代码、导出或文档真值：

```text
plugin-hubmsg
plugin-hubcast
MessageProvider
BroadcastProvider
HUBMSG_
HUBCAST_
AppMsgOnlineStatus
checkPeerOnline
appmsg.send
broadcast.publish
```

允许旧施工单或 Git 历史说明中以“已废弃”文字出现，但不得被当前入口引用。

## 11. 验收命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm test
pnpm build
pnpm docs:connect:build
git diff --check
```

相邻协议仓库如有修改，分别执行：

```bash
go test -count=1 ./...
go test -race -count=1 ./...
```

ChannelProtocol TypeScript 还必须通过其固定向量、类型检查和 npm 构建；
SatSubscriptionProtocol 必须通过 Go/TypeScript 互操作测试。

## 12. 完成定义

- [x] HubMsg、HubCast package 和运行时入口已经删除。
- [x] MessageProvider/BroadcastProvider/active provider/registry 已经删除。
- [x] Connect 对外只剩 `channel.publish`、`channel.subscription_set` 和
      `channel.message_received`。
- [x] App 输入中不存在 owner、publisher、payer、签名、Supplier 或协议编号字段。
- [x] Session Window 已执行权限、数量、频率、字节和并发限制。
- [x] 多 caller 同频道只产生一个物理订阅，最后一个 caller 释放才真实退订。
- [x] 任意合法精确频道可以发布和订阅，通配符不对 App 开放。
- [x] owner inbox 能固定分派 Message、WebRTC 文件传输信令和 Ping/Pong，未知协议明确拒绝；
      未有正式会合协议的音视频呼叫 fail closed。
- [x] WebRTC 入站文件请求先经过当前 owner 通讯录准入并进入有界用户确认队列；确认前不签名、
      不发布 Hash、不创建 PeerConnection；待确认请求具备发送者限流、TTL 和总量上限。
- [x] WebRTC 文件传输限制 `byteLength`、分片大小/数量/连续序号和累计字节数；接收端计算
      SHA-256 与 Hash 请求比较，发送端只在收到 `transfer_complete` 后记录成功，成功/失败/超时
      均关闭 DataChannel/RTCPeerConnection 并清理分片。
- [x] WebRTC 出站传输在文件读取/Hash 前同步占用单一 transfer 槽，捕获 owner generation，
      owner 切换或 service dispose 后的迟到 Hash 结果不得发布请求或建立会话；入站通讯录准入
      具备全局/单发送者在途上限、AbortSignal、超时和 generation 门禁。
- [x] WebRTC 出站 DataChannel 按 bufferedAmount 高低水位发送，单时刻只允许一个入站确认进入
      Hash Publish，避免发送缓冲或多请求同时占用远端资源。
- [x] `bsv8.message.v1` 只使用 Keymaster 本地历史，不存在远端历史或离线补拉。
- [x] 通用在线查询 API 已删除，WebRTC 不再依赖它。
- [x] Contacts 后台任务由 Coordinator 运行，没有页面 timer。
- [x] Pong 是到发起方 owner inbox 的独立 Publish，不依赖 ingress Supplier 返回能力。
- [x] Contacts 只呈现在线/失联，状态由运行期 `lastPongAtMs` 证据计算。
- [x] lock、切 owner、session close、Worker 重启和迟到结果均通过 epoch 门禁。
- [x] 两次全仓 `pnpm test`、生产构建和 Connect 文档构建通过。
- [ ] 真实双 owner/双 origin、Chromium 与 Go SSP 的多参与方 E2E 通过。

说明：代码级回归已通过；当前工作区没有双 owner/双 origin、真实 Chromium 和 Go SSP
多参与方 E2E 的执行环境，因此本轮不宣称该项通过。它是具备环境后的发布验收项，不能由
本地单元测试冒充完成；当前发布状态仍为“阻断整改中”，不标记为“已完成”。

本次自动化验收还包括：

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint:boundaries`
- `pnpm lint:react-boundaries`
- ChannelProtocol TypeScript 构建与 9 项测试
- ChannelProtocol `go test -race -count=1 ./...`
- `git diff --check`

## 13. 本轮审查整改结论

已完成的代码整改：

- WebRTC 已直接使用 `bsv8.webrtc.signal.v1` 的
  `{request_message_id, session_id, signal}` 结构，并通过真实 ChannelProtocol parser；
  私密消息 TTL 复用 ChannelProtocol 导出的协议上限（Ping 60 秒、WebRTC 120 秒、普通消息
  24 小时）；由于上游尚无呼叫会合协议，音视频呼叫不生成自定义 Hash，当前明确关闭，文件
  传输仍使用真实文件 SHA-256 Hash 请求；
- WebRTC relation 使用 `(request_message_id, offerer_public_key, session_id)` 完整键；
  没有前置 Hash 请求的媒体 offer 直接丢弃；
- 订阅对账按 owner、Supplier、精确频道三元组保存和确认，支持多 Supplier 部分成功，串行化
  物理变更，并在 `unknown_result` 时先查询远端；重连与订阅真值收敛分开退避重试；
- 插件本地订阅过滤只提交 Coordinator 返回的已接受逻辑集合；非法 owner inbox 订阅不会
  污染全局事件过滤，也不会让插件收到私信；
- Ping Pending 在 Publish 前登记，由 Coordinator 唯一管理，具备 TTL、容量上限和 owner epoch
  门禁；Contacts 只消费 Coordinator 已验证的 Pong；
- owner 切换、Vault lock、passkey 激活和 Runtime 关闭均不跨 owner 清理；消息 DB 显式接收
  owner，升级不删除既有 `messages` store；
- 动态 key-scoped 后台任务在 owner 切换时按启动时捕获的 owner 取消并等待完成，避免旧任务
  越过新 owner 继续发起操作；
- BSV Price 严格校验 ChannelProtocol 验签得到的发布者公钥；Connect caller 在发布后复核，
  插件 caller 由 Host 绑定，`bsv8.inbox.*` 只保留给固定内部路由；
- 解锁后保留 Sat/owner inbox 订阅意图，断线后继续对账；中文状态统一为“在线 / 失联”。
- 出站 WebRTC 文件传输在首次异步操作前占用 transfer 槽，并以 owner generation / dispose
  栅栏复查；通讯录准入查询有全局及单发送者并发上限、超时取消，迟到结果不再创建 pending
  或 notice；DataChannel 发送具备 bufferedAmount 背压，入站 Hash Publish 具备全局串行槽。
- 入站传输请求清理按 `PendingTransferRequest` 对象身份和 owner generation 核对；通知动作与
  Hash 接受占位使用不可混淆的 token，旧 owner 的迟到成功/失败/拒绝回调不能删除新 owner
  复用同一 `sessionId` 的请求或清除其接受占位。
- 文件传输 notice 的接受/拒绝动作不再由 Shell 按旧 notice id 自动关闭；只有 service 在请求
  对象身份校验成功后主动 dismiss，且有经过 AppShell action 流程的跨 owner 同 `sessionId`
  回归测试。

补充：Connect 公开消息签名时间只读取一次 `Date.now()`，有效期直接复用
ChannelProtocol 导出的 `PUBLIC_MESSAGE_MAX_LIFETIME_MS`，并有跨毫秒回归测试。

当前仍阻断发布的事项：

1. `/home/david/Workspaces/ChannelProtocol` 的 Public Message/Ping 相关实现仍是未提交修改，
   Keymaster 当前使用本地 `file:` 依赖；发布前必须在协议仓提交、打版本并锁定依赖。
2. 尚未具备真实双 owner、双 Connect origin、Chromium、Go SatSubscription Server 的多参与方
   E2E 执行环境。本地不执行该外部环境测试，也不把它伪造为已通过；环境具备后需要验证
   公共消息事件隔离、私信 Deliver/ACK、WebRTC 文件传输、Ping/Pong、切 owner、重连和
   精确扣费次数。

因此本施工单保持“阻断整改中”，不能标记为“已完成”。
