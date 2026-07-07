# 001 Broadcast Core / plugin-hubcast V1 硬切换一次性迭代施工单

> **附记**：本单 v1 实际落地时，`channelId` 前缀与 `publisherPublicKeyHex` 一致性的最终校验被下放至 HubCast 服务端在 publish 阶段强制，broadcast core 不再重复。详见 follow-up [002-broadcast-client-channelId-prefix-delegated-to-hubcast.md](./002-broadcast-client-channelId-prefix-delegated-to-hubcast.md)。本施工单 §3 目标 8.iii、§6.4 接收流程第 4 步保留为历史决策记录；§10 验收清单中对应条目已撤回（见条目内的 [x] 标记与指针）。

## 参考文件

本单设计、评审、实现、联调、验收以下文件与文档为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/messageProvider.ts`
- `packages/contracts/src/appmsgBind.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
- `packages/plugin-hubmsg/src/hubmsgProvider.ts`
- `packages/plugin-hubmsg/src/manifest.ts`
- `apps/web/src/bootstrapPlugins.ts`
- `../HubCast/docs/hubcast-broadcast-v1-requirements.md`
- `../HubCast/施工单/2026-07-06/001-hubcast-broadcast-v1-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“广播不是消息、广播不进本地 DB、广播 core / provider 分层独立”的定义优先。
2. `HubCast` 的需求文档优先于 `HubMsg` 的现有消息语义；只复用握手和二进制 frame 形状，不复用消息系统的 DB / sync / endpoint 语义。
3. 本次是硬切换设计：不保留“先挂到 appmsg 下面再拆”的过渡方案，不保留“先做全局频道目录再裁掉”的尾巴方案。

---

## 1. 文档定位

这不是一次“再加一个 provider 插件”的小扩展。

本单要定义的是 `keymaster.cc` 侧一套**独立广播子系统**的最终分层：

- `broadcast core` 是平台逻辑中心；
- `plugin-hubcast` 是 `HubCast` 服务对应的 provider；
- 广播与 `appmsg` 并列，不共享消息真值、消息本地库、消息 endpoint service。

本文回答：

- 为什么广播不能塞进 `appmsg`
- `keymaster.cc` 侧广播 core 应该暴露什么能力
- `plugin-hubcast` 负责什么、不负责什么
- 浏览器端本地订阅与远端订阅如何收口
- 装配层应该如何装载新的 broadcast 系统

本文不回答：

- `HubCast` 服务端 Go 代码怎么拆
- 具体业务协议（例如 `TradingPairPrice`）的 body 编码细节
- 最终 UI 页面长什么样

这些属于 `HubCast` 仓的需求 / 施工单，或后续业务插件施工单。

---

## 2. 简述缘由

### 2.1 广播不是消息

`appmsg` 的核心问题是：

- 离线代收
- 本地真值
- list / get / sync
- 远端只是暂存与在线转发

广播的问题不是这些。

广播要解决的是：

- 当前在线连接向某个频道发布一条签名报文
- 服务器把这条报文扇出给当前订阅该频道的连接
- 不要求历史、补拉、重放、离线保存

如果把广播塞进 `appmsg`：

- 会把 DB / sync / endpoint / scope / local truth 一整套复杂度拖进来；
- 会迫使“纯在线 fanout”假装成“可补历史消息系统”；
- 以后任何广播业务都要背消息系统那层沉重语义。

这条路是错的。

### 2.2 provider 仍然要拆开

`HubCast` 只是某一种广播服务，不应该成为广播系统本身。

因此分层必须和 `appmsg / hubmsg` 一样收口成两层：

- `broadcast core`：当前 owner、active provider、订阅聚合、验签分发
- `plugin-hubcast`：WSS 连接、bind、`subscription.set/list`、`broadcast.publish`

这样以后即使出现第二种广播服务，也不会把 owner 生命周期和业务语义漏进 provider。

### 2.3 广播系统不需要 DB，但仍需要 core

“不做 DB”不等于“不要 core”。

即使没有本地持久化，浏览器端仍然需要一个统一中心去处理：

- 当前 owner 变化
- vault 锁定 / 解锁
- active provider 选择
- 多个业务方本地订阅的 union 聚合
- 远端断线后的简单重绑
- 收到广播后的统一验签与本地分发

这些都不应该散落在业务插件里。

### 2.4 本次要坚持简单

本次广播系统只做最小在线能力：

- 没有 DB
- 没有 replay
- 没有 wildcard
- 没有 prefix subscribe
- 没有 channel create/delete
- 没有“服务器看到过哪些频道”的全局目录

频道是否存在，完全由“当前是否有人订阅 / 发布到了哪个字符串”决定。

---

## 3. 本次硬切换最终目标

本次完成后，`keymaster.cc` 必须达到以下最终状态：

1. 仓内新增独立广播契约文件，不复用 `appmsg` 类型。
2. 仓内新增独立广播平台插件，暂定包名 `plugin-broadcast`。
3. 仓内新增 `plugin-hubcast` provider 插件。
4. `broadcast core` 提供 capability：
   - `broadcast.core`
   - `broadcast.provider.registry`
5. `plugin-hubcast` 只负责 register 自身，不提供页面、不提供业务路由。
6. 广播业务插件通过 `broadcast.core` 完成：
   - 发布广播
   - 订阅一组频道
   - 查询当前有效订阅频道列表
7. 本地订阅模型采用“多个本地订阅句柄的 union”，由 core 汇总后下推远端 `subscription.set`。
8. 收到远端广播后，由 core 统一：
   - 解包
   - 验签
   - 校验 `channelId` 前缀 owner 与 publisher 一致
   - 按本地 exact channel 订阅分发
9. 广播系统不建立本地 DB，不建立游标，不做补同步。
10. 远端断线后采用**固定延迟重连**的简单策略，不做指数退避。

---

## 4. 单真值与能力边界

### 4.1 `broadcast core` 的单真值

`broadcast core` 是浏览器端广播系统唯一逻辑中心。

它持有的真值只有：

- 当前 active provider
- 当前 owner publicKeyHex
- 当前本地订阅 union
- 当前 provider 连接状态
- 最近一次错误

它**不**持有：

- 广播历史消息库
- 频道目录库
- 历史游标
- 离线补发队列

### 4.2 `plugin-hubcast` 的边界

`plugin-hubcast` 只负责：

- 建立 `wss://.../ws/v1`
- 复用 `server_open -> client_bind -> bind_ready`
- 发送二进制 CBOR request
- 处理 result / event / ping / pong / close
- 暴露 provider typed 方法：
  - `publish`
  - `replaceSubscriptions`
  - `listSubscriptions`
  - `subscribeBroadcasts`

它不负责：

- owner 真值跟随
- 本地多订阅者聚合
- 本地验签后的业务分发
- 页面 UI
- 业务协议 body 解码

### 4.3 业务插件看到的公开模型

业务插件不看 wire，也不看 provider。

业务插件只应该通过 `broadcast.core` 看到：

- `publish(input)`
- `subscribe({ channelIds, handler })`
- `listSubscribedChannels()`
- `state()` / `onStateChange(...)`（如后续业务需要状态感知）

其中：

- `channelId` 固定是 exact string；
- `protocolId` 是独立字段；
- `bodyBytes` 是协议自己的 opaque bytes；
- 广播系统本身不做 body 解释。

---

## 5. 广播契约规划

### 5.1 新增 contracts 文件

本次应新增独立契约文件，暂定：

```txt
packages/contracts/src/broadcast.ts
```

最少需要定义：

- capability key：
  - `broadcast.core`
  - `broadcast.provider.registry`
- 公开消息模型：
  - `BroadcastMessage`
  - `BroadcastPublishInput`
  - `BroadcastCore`
- provider 契约：
  - `BroadcastProvider`
  - `BroadcastProviderOperations`
  - `BroadcastProviderRegistry`
- wire 常量：
  - `HUBCAST_METHOD`
  - `HUBCAST_EVENT`
  - `HubCastEnvelopeV1`
  - `SignedHubCastEnvelopeV1`

### 5.2 公开发布模型

公开发布模型必须是：

```txt
publish({
  channelId,
  protocolId,
  clientMessageId,
  createdAtMs,
  bodyBytes
})
```

约束：

- 不允许业务方自己传 `publisherPublicKeyHex`
- 不允许业务方自己传签名
- `publisherPublicKeyHex` 由 core 按当前 owner 真值补齐并签名

### 5.3 公开订阅模型

公开订阅模型固定为：

```txt
subscribe({
  channelIds,
  handler
})
```

语义：

- 一个订阅句柄声明自己关注的一组 exact channel
- core 维护所有订阅句柄的 union
- 远端只看到 union，不知道本地有几个业务订阅者
- 本地取消订阅后重新计算 union，再下推新的 `subscription.set`

### 5.4 `listSubscribedChannels`

`listSubscribedChannels()` 的语义固定为：

- 已连接时：返回当前 provider 连接上的有效 exact channel 列表
- 未连接时：返回 core 当前本地期望 union

它**不**表示：

- 服务器全局频道目录
- 进程启动以来见过的频道列表
- 某个 publisher 曾经发布过的全部频道

---

## 6. `plugin-broadcast` 规划

### 6.1 预计文件

本次应新增：

```txt
packages/plugin-broadcast/
  package.json
  tsconfig.json
  src/
    index.ts
    manifest.ts
    broadcastCore.ts
    signer.ts
    broadcastCore.test.ts
```

### 6.2 manifest 职责

`plugin-broadcast` manifest 负责：

- 依赖：
  - `vault.service`
  - `keyspace.service`
- provide：
  - `broadcast.core`
  - `broadcast.provider.registry`
- 在 setup 时：
  - 创建 `BroadcastCoreImpl`
  - 订阅 `vault` 状态变化
  - 订阅 `keyspace` active key 变化
  - 驱动 core 绑定 / 断开 / 重绑

它不注册：

- route
- menu
- breadcrumb

本次广播系统先不带管理页。

### 6.3 连接策略

本次重连策略固定为简单模型：

- 当前 owner 或 active provider 变化：立即重绑
- provider 连接断开：固定延迟重试
- 不做指数退避
- 不做多阶段 backoff
- 不做 replay / resubscribe journal

推荐固定延迟：

```txt
5000ms
```

理由：

- 符合“简单优先”
- 断线后自动回来
- 不为在线广播系统引入复杂重试状态机

### 6.4 签名边界

`plugin-broadcast` 是浏览器侧唯一允许做广播 envelope 签名与验签的边界。

发布时：

1. 业务层给明文字段 `channelId / protocolId / clientMessageId / createdAtMs / bodyBytes`
2. core 组 `HubCastEnvelopeV1`
3. core 对 `SHA-256(envelopeBytes)` 做 secp256k1 compact 64-byte 签名
4. provider 上传 `[envelopeBytes, signature64]`

接收时：

1. provider 收到 `SignedHubCastEnvelopeV1`
2. core decode envelope
3. core 验签
4. core 校验 `channelId` 前缀 owner 与 publisher 一致
5. 分发给本地匹配 exact channel 的 handler

---

## 7. `plugin-hubcast` 规划

### 7.1 预计文件

本次应新增：

```txt
packages/plugin-hubcast/
  package.json
  tsconfig.json
  src/
    index.ts
    manifest.ts
    hubcastConnection.ts
    hubcastProvider.ts
    hubcastConnection.test.ts
```

### 7.2 provider typed 方法

`plugin-hubcast` 最少应暴露：

- `publish(input)`
- `replaceSubscriptions(input)`
- `listSubscriptions()`
- `subscribeBroadcasts(handler)`
- `onClose(handler)`

其中：

- `replaceSubscriptions` 是全量替换
- 不做 `subscribeChannel(...)` / `unsubscribeChannel(...)` 增量接口

### 7.3 与 `plugin-hubmsg` 的关系

`plugin-hubcast` 可以参考 `plugin-hubmsg` 的 frame 编码、握手和 request/result/event 流程，但必须保持以下硬边界：

- 不 import `plugin-appmsg`
- 不 import `plugin-hubmsg` 的业务类型
- 不复用 `MessageProvider`
- 不借用 `appmsg` 的 sealed message record

它只共享：

- `canonicalBindText`
- binary frame 风格
- CBOR 编码原则

---

## 8. 装配层改动规划

### 8.1 bootstrap 顺序

`apps/web/src/bootstrapPlugins.ts` 需要新增新的装配顺序：

```txt
vault
broadcast
hubcast
appmsg
hubmsg
protocol
message
...
```

关键约束：

- `plugin-broadcast` 必须早于 `plugin-hubcast`
- `plugin-hubcast` 只依赖 `broadcast.provider.registry`
- `broadcast` 与 `appmsg` 互不依赖，不允许互相 import

### 8.2 包依赖

应更新：

- 根 `tsconfig.json` references
- `apps/web/package.json`
- 需要的话更新根 `package.json` 工作区引用（如包已自动命中则不需额外字段）

---

## 9. 明确不做

本次 `keymaster.cc` 广播系统明确不做：

- 广播本地 DB
- 广播历史页
- 频道目录页
- wildcard 订阅
- prefix 订阅
- 全局频道发现
- 业务 body JSON schema 校验
- 业务 body 解码
- 与 `appmsg` 的统一 facade
- 让 `plugin-hubcast` 兼做 core

---

## 10. 验收标准

完成本单后，应满足以下验收条件：

- [ ] 仓内存在独立 `broadcast` 契约文件，不再把广播类型塞进 `appmsg.ts`
- [ ] 仓内存在独立 `plugin-broadcast` 平台插件
- [ ] 仓内存在独立 `plugin-hubcast` provider 插件
- [ ] `plugin-hubcast` 不提供 UI 路由，只 register provider
- [ ] `broadcast.core` 能提供发布、订阅、列当前订阅频道能力
- [ ] 本地订阅 union 由 core 收口，不泄漏给业务插件
- [x] ~~原计划：接收广播后由 core 统一验签与 channel/publisher 一致性校验~~（**已撤回**）→ 验收口径调整为：核心 client 端只做 verify + exact channel 分发；`channelId` 前缀与 publisher 一致性由 HubCast 服务端在 publish 阶段强制，详见 [002](./002-broadcast-client-channelId-prefix-delegated-to-hubcast.md)
- [ ] 广播系统不建立本地 DB，不建立补同步游标
- [ ] 装配层已把 `broadcast -> hubcast` 顺序接入
- [ ] 文档中没有把广播偷偷变成“另一套 appmsg”

---

## 11. 后续工作边界

本单完成后，后续如果要继续演进，必须另开施工单讨论：

- 广播管理页
- 频道统计页
- 某类业务协议的 body 解释器
- 业务插件如何声明“我需要哪些广播频道”
- 多 provider 并存时的 UI 选择
- 是否需要跨窗口共享订阅 union

这些都不属于本单。
