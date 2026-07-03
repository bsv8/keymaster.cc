# 001 appmsg 本地真值、完整消息推送、在线状态与系统消息应用硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/contacts.ts`
- `packages/contracts/src/keyspace.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/hubmsgConnection.ts`
- `packages/plugin-appmsg/src/pluginClient.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/plugin-contacts/src/contactsService.ts`
- `packages/plugin-contacts/src/contactsDb.ts`
- `施工单/2026-07-01/002-protocol-appmsg-bus-hard-switch.md`
- `施工单/2026-07-01/003-appmsg-v1-frozen-protocol-alignment.md`
- `施工单/2026-07-02/001-appmsg-system-log-and-system-diagnostics-hard-switch.md`
- `../HubMsg/README.md`
- `../HubMsg/internal/protocol/messages.go`
- `../HubMsg/internal/protocol/frames.go`
- `../HubMsg/internal/service/service.go`
- `../HubMsg/internal/store/store.go`
- `../HubMsg/施工单/2026-07-01/001-hubmsg-appmsg-v1-hard-switch.md`
- `../HubMsg/施工单/2026-07-01/002-keymaster-appmsg-v1-frozen-protocol-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“本地消息真值”“公开接口不暴露 owner/endpoint”“完整消息推送”“在线状态”“系统消息应用”的定义优先。
2. 旧 `appmsg` 施工单中凡是与 `inbox_dirty`、`message.origins`、`message.counts`、远端管理页、纯内存缓存相关的定义，本次全部失效。
3. HubMsg 继续只服务 keymaster 平台连接；第三方 app 不直接连 HubMsg，这一点不变。

---

## 1. 文档定位

本单不是在旧 `appmsg` 设计上继续补洞，也不是分阶段过渡方案。

本单定义的是一次**硬切换**：

- Keymaster 的消息真值从“HubMsg + 内存缓存 + dirty hint”硬切到“**Keymaster 本地 DB 真值** + HubMsg 作为远端存储与在线转发器”。
- app/plugin 的公开消息接口从“暴露地址模型/box/dirty event”硬切到“**只暴露简单消息接口与完整消息 hook**”。
- 远端系统诊断接口 `message.origins` / `message.counts` 以及对应系统页设计全部移除。
- `plugin-appmsg` 收口为平台消息内核；新增系统消息应用 `keymaster.message` 负责查看和管理本地消息。
- HubMsg 只保留三类职责：
  - 远端持久化
  - 当前在线时的实时完整消息推送
  - 当前在线状态查询

本次不做兼容别名，不保留旧路径，不允许“先保留一段时间看看”。

---

## 2. 简述缘由

### 2.1 旧模型把复杂度泄漏给了 app/plugin

现状里，消息公开模型带着以下系统内部概念：

- `ownerPublicKeyHex`
- `endpoint`
- `origin`
- `plugin endpoint`
- `box = inbox | sent | all`
- `appmsg.inbox_dirty`

这些都不是 app/plugin 真正关心的业务概念。

app/plugin 真正要的只有：

- 发一条消息
- 列出自己的消息
- 订阅收到的新消息
- 查对方当前能不能收到实时推送

所以这次要把复杂度重新收回系统内部，不再要求 app/plugin 理解 owner、endpoint、缓存、补同步、dirty 事件这些底层实现细节。

### 2.2 远端系统管理页方向错了

之前从 `message.origins` / `message.counts` 引申出来的“HubMsg 管理面”方向不对。

你已经明确：

- 管理页应该看 **Keymaster 本地缓存**
- 不应该看远端数据库统计
- HubMsg 后续还会删旧消息

这意味着系统真值必须落到 keymaster 本地 DB。否则：

- HubMsg 一删历史，本地就失忆
- 管理页看到的不是“我已经收到和缓存了什么”，而是“远端还剩什么”
- 这与“HubMsg 只是离线辅助缓存器”的定位冲突

### 2.3 `inbox_dirty` 与 box 模型没有产品价值

`dirty hint` 和 `inbox/sent/all` 都是技术实现里为了“提示刷新”“按方向切片”引入的中间概念，不是你要的用户模型。

你要的不是：

- 先收一个 dirty
- 再自己推断 scope
- 再自己拉消息

你要的是：

- app/plugin 直接收到完整消息
- 系统自己把消息落本地库
- 系统自己补同步
- app/plugin 不知道缓存和同步

所以这次不再把 `dirty` 和 `box` 当成公开协议核心。

### 2.4 HubMsg 的角色必须收窄

HubMsg 的合理定位只有三件事：

1. 对方不在线时，代收并保存消息
2. 对方在线时，把完整消息推给对方 keymaster
3. 告诉发送方“对方当前是否在线，是否能立即收到推送”

HubMsg 不是：

- 消息系统管理页真值
- app/plugin 公开地址模型的承载者
- 本地消息统计真值
- 第三方 app 的直接 API 服务

---

## 3. 本次硬切换最终目标

本次完成后，系统必须达到以下最终状态：

1. Keymaster 为每把 key 建立独立的本地消息库，本地库是消息真值。
2. HubMsg 推来的完整消息先写入本地库，再分发给 app/plugin。
3. app/plugin 都通过统一简单接口拿消息，不暴露 `ownerPublicKeyHex` / `endpoint`。
4. app/plugin 都通过完整消息 hook 收实时消息，不再以 `appmsg.inbox_dirty` 为公开主模型。
5. 外部 app 与内部插件都不知道本地缓存、补同步、游标、重连细节。
6. HubMsg 远端删除历史消息后，已同步到本地的消息仍可在 keymaster 本地继续查看。
7. 系统消息应用固定 appId 为 `keymaster.message`，能正确收到推送、查看本地消息、管理本地消息。
8. 远端 owner 级诊断接口 `message.origins` / `message.counts` 彻底删除，不留尾巴。
9. 在线能力只表达一个语义：
   - “对方当前是否连着 HubMsg，是否可以实时收到推送”
10. HubMsg 仍只服务 keymaster 平台连接；第三方 app 仍然只通过 keymaster 协议层间接使用消息能力。

---

## 4. 单真值定义

### 4.1 本地消息真值

本次固定：

- **Keymaster 本地 DB 是消息真值**
- HubMsg 是“远端持久化 + 在线转发 + 在线查询”辅助层

本地 DB 必须至少保存：

- 完整消息记录
- 每个本地收件目标的同步游标
- 最近同步时间
- 最近同步错误

本地 DB 必须按 `publicKeyHex` 分 namespace，跟联系人 DB 一样走 `keyspace.openKeyStorage(...)`。

### 4.2 HubMsg 真值边界

本次固定：

- HubMsg 负责接收、保存、推送、在线查询
- HubMsg 不再负责消息系统管理页统计真值
- HubMsg 不再提供 owner 级 origin 汇总/数量汇总

### 4.3 公开接收目标模型

系统内部仍然保留地址模型，但**不对 app/plugin 暴露 generic endpoint**。

app/plugin 面向系统的公开接收目标只允许以下两种：

- 外部 app：`origin`
- 内部插件 / 系统应用：`appId`

系统内部再映射成真正的 HubMsg endpoint：

- `origin -> { kind: "origin", id: origin }`
- `appId -> { kind: "plugin", id: appId }`

### 4.4 公开消息接口形状

本次固定：app/plugin 的公开消息接口里**不出现**以下字段：

- `ownerPublicKeyHex`
- `endpoint`
- `senderEndpoint`
- `scopeEndpoint`
- `box`
- `atMs`

对 app/plugin 公开的形状应收敛成：

- `sendMessage(...)`
- `listMessages(...)`
- `getMessage(...)`
- `subscribeMessages(handler)`
- `checkOnline(publicKeyHexes)`

其中：

- 发送时只需要业务字段和简单目标
- 读取时只读取“属于自己”的本地消息
- hook 直接给完整消息
- 系统自动处理 owner 归属、endpoint 路由、缓存、同步、重连

### 4.5 系统消息应用

本次固定：

- 系统内建一个消息应用，接收目标 id 固定为 `keymaster.message`
- 该应用是查看/管理本地消息的正式入口
- 该应用不是 HubMsg 管理页
- 该应用看的是真正的本地消息库

### 4.6 在线语义

本次固定：

```txt
在线 = 对方当前是否有 keymaster 连接已 bind 到 HubMsg
```

其产品含义固定为：

```txt
我现在发消息，对方能不能立刻收到推送
```

注意：

- 在线 != 对方有没有历史消息
- 在线 != 对方是不是曾经登录过
- 在线 != 对方以后能不能通过补同步拿到消息

离线时：

- HubMsg 仍然保存消息
- 对方现在收不到推送
- 对方以后上线后由 keymaster 自动同步到本地

---

## 5. 必须怎么做

### 5.1 推送路径

推送链路固定如下：

1. 发送方 app/plugin 调系统公开消息接口
2. keymaster 内核自动补 owner 与内部目标地址
3. HubMsg 落远端库
4. 如果收件方在线，HubMsg 把完整消息推到收件方 keymaster
5. 收件方 keymaster 先写本地 DB
6. 收件方 keymaster 按 `origin` 或 `appId` 路由给对应 app/plugin hook
7. 收件方 keymaster 异步触发一次补同步，防止漏推消息

### 5.2 同步路径

同步路径固定如下：

1. 每个本地收件目标保存自己的 `lastSyncedMessageId`
2. 重连后 / 收到推送后 / 手动刷新后，按该游标增量同步
3. 同步回来的消息先去重，再写本地库
4. 同步是系统内部行为，app/plugin 无感知

### 5.3 读取路径

读取路径固定如下：

- `listMessages / getMessage` 都先读本地库
- 不允许把 HubMsg 远端 list/get 继续当成公开读真值
- 远端同步只负责补数据，不负责充当最终读库

### 5.4 管理路径

系统消息应用 `keymaster.message` 看的必须是本地库：

- 列表
- 搜索
- 按 appId/origin 分组
- 本地统计
- 本地同步状态

都由 keymaster 本地消息库给出。

### 5.5 删除路径

本次涉及旧设计删除，必须明确删除，而不是废弃注释留着。

必须删干净：

- 公开 `appmsg.inbox_dirty` 事件
- 公开 `box = inbox|sent|all` 作为主接口语义
- HubMsg `message.origins`
- HubMsg `message.counts`
- `AppMsgSystemPage` 这一套远端诊断页模型
- `plugin-appmsg` 里的远端 owner 诊断辅助接口
- contracts 里与上述能力直接绑定的类型定义

---

## 6. 不能怎么做

### 6.1 不能保留兼容尾巴

本次是硬切换，不允许：

- 同时保留 `appmsg.inbox_dirty` 和新完整消息 hook 作为双主路径
- 同时保留本地库真值与“远端 list/get 公开读真值”双路径
- 同时保留远端系统页和本地消息应用双管理面

必须只有一条新路径。

### 6.2 不能让 app/plugin 知道系统内部地址模型

不允许让 app/plugin：

- 传 `ownerPublicKeyHex`
- 传 `endpoint`
- 传 `senderEndpoint`
- 传 `scopeEndpoint`
- 传 HubMsg 游标
- 感知本地缓存或补同步

### 6.3 不能把 UI 过滤概念抬成协议核心

不允许把：

- 收件桶
- 发件桶
- 全部桶
- dirty 提示

继续固化成公开协议根模型。

如果系统消息应用需要“收件/发件/全部”视图，这只是 message 应用自己的本地 UI 过滤，不再是全局消息协议核心。

### 6.4 不能继续让远端统计驱动管理面

不允许：

- 用 HubMsg 数量统计作为消息管理页真值
- 用 HubMsg 历史 origin 列表作为管理页真值
- 把“远端还剩多少”冒充“本地已缓存多少”

### 6.5 不能引入复杂重试/队列系统

这次仍然遵守“简单优先”：

- 不做 transport seq
- 不做 replay 队列
- 不做消息 ack
- 不做 presence 订阅流
- 不做 Redis / 多节点 fanout
- 不做复杂重试策略

失败就失败，靠重连 + 增量同步继续跑。

---

## 7. 特殊情况提前约定

### 7.1 推送到了，但本地 hook 没有人订阅

处理方式：

- 仍然写本地库
- 不因为没有订阅者而报错
- 以后用户打开 message 应用时仍能看到消息

### 7.2 收到 HubMsg 推送时，本地还没有对应 app/plugin 活跃实例

处理方式：

- 仍然写本地库
- 不阻塞
- 该 app/plugin 下次启动时从本地库读取

### 7.3 推送丢了 / 连接断了

处理方式：

- 连接恢复后按本地游标增量同步
- 同步补齐遗漏消息
- 不引入额外 replay 队列

### 7.4 推送与同步重复到达

处理方式：

- 以 `messageId` 去重
- 重复写入必须幂等
- 不允许出现一条消息在本地库重复多份

### 7.5 HubMsg 已删除旧消息

处理方式：

- 已经同步到本地的消息继续可读
- 本地库不因为远端删除而回删
- 增量同步只从本地游标之后继续

### 7.6 Vault 锁定 / active key 切换

处理方式：

- 锁定时关闭 HubMsg 连接
- 当前 key 的本地消息库保留，不删除
- 解锁后按 active key 重新建连
- 切 key 时切换到另一把 key 的本地消息库

### 7.7 key 删除

处理方式：

- 通过 `keyspace` 的 key-scoped storage 删除路径整体删掉该 key 的消息库
- 不允许残留孤儿 DB

### 7.8 在线查询失败

处理方式：

- 返回 `unknown` 或调用失败
- 不影响发消息
- 不因为在线查询失败阻塞正常消息发送

### 7.9 旧客户端仍监听 `appmsg.inbox_dirty`

处理方式：

- 本次不做兼容
- 旧监听方在硬切换后必须跟着升级
- 不能为了兼容旧监听再把旧模型留着

---

## 8. 目标实现方案

### 8.1 `plugin-appmsg` 收口为平台消息内核

`plugin-appmsg` 只做平台内核：

- HubMsg 连接
- 本地消息库
- 完整消息推送分发
- 自动补同步
- 在线查询
- 对 app/plugin 暴露简单消息接口

不再继续承担：

- 远端系统管理页
- owner 级远端统计页
- dirty event 公开协议中心

### 8.2 新增本地消息库

本地消息库按 `publicKeyHex` 分 namespace，建议新建 `storageId = "messages"`。

建议最小 schema：

- `messages`
  - key: `messageId`
  - value: 完整消息记录
- `targets`
  - key: `targetKey`
  - value:
    - `lastSyncedMessageId`
    - `lastReceivedAtMs`
    - `lastSyncStartedAtMs`
    - `lastSyncCompletedAtMs`
    - `lastSyncError`

必要索引：

- 按 `targetKey`
- 按 `createdAtMs`
- 按 `insertedAtMs`

### 8.3 公开消息接口改为简单 facade

系统内部仍保留现有底层能力，但 app/plugin 拿到的是简单 facade：

- `sendMessage`
- `listMessages`
- `getMessage`
- `subscribeMessages`
- `checkOnline`

公开参数只允许业务语义字段，例如：

- 发消息时：
  - `recipientPublicKeyHex`
  - `recipientOrigin` 或 `recipientAppId`
  - `contentType`
  - `body`
- 收消息时：
  - 直接拿完整消息
  - 看到的是 `senderPublicKeyHex` 与来源 `origin/appId`

不再看到 generic endpoint。

### 8.4 外部 app 协议层改为完整消息事件

`protocolService` 的职责改为：

- 把外部 app 的当前 `origin` 投影为内部目标
- 把外部协议请求适配到平台消息内核
- 把平台内核产生的完整消息事件投递回当前 app caller

对外事件改成完整消息事件，例如：

- `appmsg.message_received`

`appmsg.inbox_dirty` 删除，不再作为对外正式事件。

### 8.5 插件侧改为完整消息 hook

插件拿到的 `appmsg.client` 改成：

- `sendMessage`
- `listMessages`
- `getMessage`
- `subscribeMessages`

`subscribeInboxDirty` 删除。

### 8.6 新增系统消息应用 `keymaster.message`

新增正式插件/应用，固定接收目标：

```txt
appId = keymaster.message
```

职责：

- 查看本地消息
- 管理本地消息
- 显示按 appId/origin 分组后的本地消息
- 查看最近同步时间、同步错误、在线状态

它是最终的系统消息管理入口。

### 8.7 HubMsg 在线查询 API

HubMsg 新增最小内部 RPC，建议名：

- `message.online`

入参：

- `publicKeyHexes: string[]`

出参：

- `onlinePublicKeyHexes: string[]`

实现直接读取当前内存 registry 的 bound owner 集合。

不做：

- lastSeen
- 订阅式 presence
- 离线消息数量
- 多节点共享

---

## 9. 必须删除的旧设计与旧文件尾巴

### 9.1 contracts 层

必须删除或重写掉以下旧公开模型：

- `AppMsgInboxDirtyEvent`
- `AppMsgMessageReceivedEvent` 如果只是内部残留别名，需要收口为新的公开/内部事件模型
- `AppMsgListBox`
- `AppMsgListInternalParams` 中直接以 `box` 为中心的公开语义
- `AppMsgCore.subscribeInboxDirty(...)`
- `AppMsgPluginClient.subscribeInboxDirty(...)`

### 9.2 protocol 层

必须删除：

- `ProtocolEventMessage.event = "appmsg.inbox_dirty"`
- 与 dirty 事件绑定的类型和校验逻辑
- 依赖“当前 origin 最近 request source”投递 dirty 的路径

改为新的完整消息事件路径。

### 9.3 `plugin-appmsg`

必须删除：

- 远端 owner 诊断辅助接口
- `listKnownOrigins()`
- `countScopes()`
- `logDiagnosticsRefreshFailed()` 若只为旧系统页服务
- `AppMsgSystemPage`
- 纯内存 200 条缓存作为最终真值的设计说明

### 9.4 HubMsg

必须删除：

- `message.origins`
- `message.counts`
- 对应 protocol types
- 对应 README 文档说明
- 对应 service / store / db / test 代码

### 9.5 菜单与页面

必须删除旧“消息系统诊断页”入口，不允许和新系统消息应用并存。

---

## 10. 文件级改动清单

以下是本次一次性迭代的文件级施工清单。实现时允许增删测试文件，但主文件边界不应偏离。

### 10.1 `keymaster.cc` 仓

#### A. 必改文件

- `packages/contracts/src/appmsg.ts`
  - 删除 dirty/box 公开主模型
  - 定义新的简单消息 facade contract
  - 定义完整消息 hook 公开类型
- `packages/contracts/src/protocol.ts`
  - 删除对外 `appmsg.inbox_dirty`
  - 改为新的完整消息事件 contract
  - 收紧 `appmsg.*` 外部参数，不暴露 owner/endpoint
- `packages/contracts/src/plugin.ts`
  - 明确插件消息应用 target 声明语义使用 `appId`
- `packages/plugin-appmsg/src/appmsgCore.ts`
  - 删除纯内存真值设计
  - 接入本地 DB
  - 实现完整消息分发
  - 实现增量同步与在线查询
- `packages/plugin-appmsg/src/hubmsgConnection.ts`
  - 适配新的 HubMsg 在线 RPC
  - 适配新的完整消息事件解释
- `packages/plugin-appmsg/src/pluginClient.ts`
  - 删除 `subscribeInboxDirty`
  - 暴露新的完整消息 hook
- `packages/plugin-appmsg/src/manifest.ts`
  - 删除旧系统页注册
  - 收紧为平台消息内核
- `packages/plugin-protocol/src/protocolService.ts`
  - 删除 dirty event 路径
  - 对外投递完整消息事件
  - 简化 appmsg 公开读写接口适配
- `packages/runtime/src/createPluginHost.ts`
  - 继续自动注入 scoped message client，但对外只暴露简单接口

#### B. 必增文件

- `packages/plugin-appmsg/src/appmsgDb.ts`
  - key-scoped 本地消息库
- `packages/plugin-appmsg/src/appmsgSync.ts`
  - 增量同步器
- `packages/plugin-appmsg/src/messageFacade.ts`
  - app/plugin 统一简单接口收口
- `packages/plugin-message/package.json`
- `packages/plugin-message/src/index.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/messageService.test.ts`

#### C. 必删文件或必删功能

- `packages/plugin-appmsg/src/AppMsgSystemPage.tsx`
- `packages/plugin-appmsg/src/AppMsgSystemPage.test.tsx`

如果不物理删文件，也必须从构建入口、manifest 注册、路由和菜单中完全移除，不允许残留死入口。

#### D. 建议联动文件

- `packages/plugin-contacts/src/contactsService.ts`
  - 复用联系人 publicKeyHex 作为在线查询输入来源
- `packages/plugin-contacts/src/ContactsPage.tsx`
  - 如需要可增加“在线”展示入口，但不是本单硬要求

### 10.2 `HubMsg` 仓

#### A. 必改文件

- `internal/protocol/messages.go`
  - 删除 `MessageOrigins*`
  - 删除 `MessageCounts*`
  - 新增 `MessageOnlineParams`
  - 新增 `MessageOnlineResult`
- `internal/protocol/frames.go`
  - 删除 `MethodMessageOrigins`
  - 删除 `MethodMessageCounts`
  - 新增 `MethodMessageOnline`
- `internal/service/service.go`
  - 删除 `messageOrigins`
  - 删除 `messageCounts`
  - 新增 `messageOnline`
- `internal/store/store.go`
  - 删除 `ListOriginsByOwner`
  - 删除 `CountMessagesByScope`
  - 新增在线查询所需最小接口；若 service 直接查 registry，则 store 无需扩
- `README.md`
  - 删除远端诊断 API 文档
  - 增加在线查询 API 文档

#### B. 必删测试/代码

- `internal/service/service_test.go`
  - 删除 origins/counts 相关测试
  - 新增 online 相关测试
- `internal/db/pg.go`
  - 删除 origins/counts 的 SQL 与实现

如果决定在线查询直接读 registry，不落 DB，则不要再引入任何新的 SQL。

---

## 11. 最终验收清单

### 11.1 公开接口与模型

- [ ] app/plugin 公开消息接口中不再出现 `ownerPublicKeyHex`
- [ ] app/plugin 公开消息接口中不再出现 `endpoint`
- [ ] app/plugin 公开消息接口中不再出现 `box`
- [ ] app/plugin 公开事件中不再出现 `appmsg.inbox_dirty`
- [ ] app/plugin 公开事件可以直接收到完整消息

### 11.2 本地真值

- [ ] 每把 key 有独立本地消息库
- [ ] `list/get` 读取的是本地库，不是 HubMsg 远端
- [ ] HubMsg 删除历史后，本地已同步消息仍能查看
- [ ] 推送到达时先写本地库，再分发 hook
- [ ] 推送重复到达不会在本地产生重复消息

### 11.3 自动同步

- [ ] 断线重连后可按游标补同步
- [ ] 收到推送后会触发一次异步补同步
- [ ] 同步失败不会卡死系统
- [ ] 同步错误会记录到本地状态

### 11.4 系统消息应用

- [ ] 存在正式系统消息应用，appId 固定为 `keymaster.message`
- [ ] 该应用能收到发给 `keymaster.message` 的消息
- [ ] 该应用能查看本地消息
- [ ] 该应用能看到本地同步状态
- [ ] 该应用不依赖 HubMsg 远端统计页

### 11.5 HubMsg

- [ ] HubMsg 不再暴露 `message.origins`
- [ ] HubMsg 不再暴露 `message.counts`
- [ ] HubMsg 暴露最小 `message.online`
- [ ] `message.online` 的结果只表达“当前是否在线”
- [ ] 在线查询失败不阻塞正常消息发送

### 11.6 删除干净

- [ ] 代码中不存在继续被主路径调用的 `subscribeInboxDirty`
- [ ] 代码中不存在继续被主路径调用的旧系统诊断页
- [ ] README / 文档 / contract 中不再把 dirty event 当公开主模型
- [ ] README / 文档 / contract 中不再保留 origins/counts 管理 API
- [ ] 不存在“双路径并存”的兼容逻辑

---

## 12. 本次不做

本次明确不做以下事项，避免再次把系统做复杂：

- 不做群聊
- 不做附件
- 不做已读回执
- 不做撤回
- 不做消息编辑
- 不做复杂会话列表
- 不做 presence 订阅流
- 不做最后在线时间
- 不做跨节点 online 共享
- 不做服务端 replay 队列
- 不做 transport seq
- 不做复杂重试系统

---

## 13. 结论

本次硬切换的核心不是“再给 appmsg 多补几个 API”，而是把消息系统的根真值和复杂度边界重新摆正：

- **真值在 keymaster 本地**
- **HubMsg 只做远端保存、在线推送、在线查询**
- **app/plugin 只拿简单接口和完整消息 hook**
- **旧 dirty/bucket/远端诊断页设计一次删干净**

后续任何人如果想重新引入：

- dirty 公开事件
- 远端数量管理页
- owner/endpoint 暴露给 app/plugin
- 双路径兼容

都必须先回到本单修改定义，再改代码；不允许直接在实现里偷偷长回来。
