# 001 `poker-proxy` + `plugin-poker` 协议保真接入硬切换施工单

## 目标

一次性把 `/home/david/Workspaces/Projects/bsv-poker` 的网络协议接入到当前体系中：

```txt
外部真值
  = bsv-poker 现有协议与消息语义
  = 不改协议
  = 不增删字段
  = 不重写发现 / 桌内广播 / TxLink 语义

中间层
  = /home/david/Workspaces/Projects/poker-proxy
  = Go 编写
  = 对外表现为协议保真的代理入口
  = 对内承载多 web client 多租户复用

前端侧
  = keymaster 内新增 packages/plugin-poker
  = 以 bsv-blockchain/ts-stack 作为 TypeScript 真值底座
  = 私钥、签名、验签、状态推进仍在 web
  = plugin 通过 contracts/runtime 接入现有插件宿主
```

本次是硬切换，不接受“先做半套 topic 转发、先不管 TxLink、先手搓一个简化协议、后面再慢慢补齐”这类中间态。

## 简述缘由

1. `bsv-poker` 的真值不在当前仓库，而在外部原始项目。当前项目只能做“协议保真接入”，不能一边说移植，一边擅自删改原始协议能力。

2. 浏览器天然不能像桌面程序那样直接提供可拨入 TCP endpoint，因此必须引入代理层，把“一个公网入口”复用给多个 web client。

3. 但原始协议并不只有 `P2PNode` 的 topic 广播，还有 `TxLink` 直推 raw Bitcoin tx 的第二网络平面。只代理 topic、不承接 TxLink，不是保真接入。

4. `bsv-poker` 的真值实现当前在 C#/.NET 中，而本次要求签名、验签、状态推进尽量留在 web，所以“真值逻辑”不能悬空。这里的技术路线明确为：

```txt
以 ts-stack 作为 TypeScript 真值底座
  - 复用其 SDK / wallet / messaging / conformance 能力
  - 替代 C# 里的加解密、脚本、交易、消息解析基础设施

在 plugin-poker 内补齐扑克专属协议引擎
  - NetGame / NetBlackjack 对等状态机
  - Ingest 语义
  - typed tx / chat / announce / seed 解析
  - 与 bsv-poker 行为对拍测试
```

5. 审计结论已经明确：

```txt
能精确路由的
  就精确路由

不能精确路由的
  就广播给当前代理入口下的在线 web client
  由各 client 本地按原始 Ingest / wallet / decrypt 语义自行判定是否消费
```

6. 正确目标不是“把代理做成一个共享身份的大节点”，而是：

```txt
一个物理入口
  承载多个虚拟节点会话

每个会话
  代表一个真实 web player
  保持自己的公钥身份 / presence / table ownership / 本地状态
```

## 硬切换结论

本次统一采用下面这套明确架构：

```txt
Projects/poker-proxy
  对外：
    - 承接 bsv-poker 外部网络入口集合
    - 保留 P2PNode topic 入口语义
    - 保留 TxLink raw tx 入口语义
    - 不把两类真值入口错误压成一个协议端口语义

  对内：
    - browser session = 一个虚拟节点会话
    - 维护 topic 订阅、player pubkey、owned tables、presence、最近已签名公告
    - 能定向的消息定向
    - 不能定向的 raw tx 广播给在线相关租户集合

keymaster/plugin-poker
  - 持有 poker 能力契约与 UI
  - 以 ts-stack 为协议真值底座
  - 在 TS 中承接扑克专属协议引擎
  - 与 proxy 建立 WSS 会话
  - 本地完成签名、验签、状态推进、钱包调用
  - 不在浏览器内假造简化协议
```

本次切换后，必须满足下面的不变量：

1. `plugin-poker` 不直接实现一个“浏览器版私有协议”，而是消费 `bsv-poker` 真值协议。
2. `poker-proxy` 不能代签、不能伪造 presence/table/game 消息。
3. `poker-proxy` 可以缓存并重放**客户端已经签好的** presence / table announce / table close。
4. `poker-proxy` 对 `TxLink` 不能识别归属的原始 tx，必须走广播兜底；不能静默丢弃。
5. `plugin-poker` 不能把私钥、明文种子、长期签名材料泄露到 proxy。
6. `plugin-poker` 的稳定玩家身份不能跟随当前 active key 漂移；必须有独立的 poker identity 绑定。
7. `plugin-poker` 必须作为独立业务插件接入，不允许把扑克逻辑散落到 `apps/web/src/shell/`。
8. `plugin-poker` 不能只做 UI + socket 壳；必须实际承接 TS 真值协议引擎。

## 不能怎么做

1. 不能把 `poker-proxy` 做成“一个共享 `P2PNode` 身份”的超级节点，然后把多个 web client 藏在后面。原始协议里 presence、table announce、聊天收发、公钥身份都会被压扁，语义直接错。

2. 不能只代理 `tableId` 广播，不承接 `TxLink`。原始项目里聊天、announce、payment、refund、move 冗余直推都可能走 `TxLink`，少承接就是少协议。

3. 不能让 proxy 代做签名、seat 判定、状态推进、动作合法性裁决。那些都属于 client 本地真值逻辑。

4. 不能把“无法判定归属”的 raw tx 直接丢弃，理由不能是“现在先不支持钱包路径”。保真代理必须兜底广播。

5. 不能把 `plugin-poker` 直接 import 其他业务插件内部实现，尤其不能直接 import `plugin-vault` 内部模块、`plugin-p2pkh` 内部 signer、`apps/web` shell 代码。

6. 不能把 poker 的网络会话状态放进 `apps/web` 的全局 React state 里乱传。会话、topic 订阅、重连、目录缓存、桌局状态应收敛在 `plugin-poker` 服务层。

7. 不能为了实现简单，就要求用户额外安装本地 sidecar 或桌面桥接程序。本次目标就是浏览器 + 远端代理。

8. 不能先做“topic 精确路由版”，把广播兜底留到以后。那样上线后会出现“某些 tx 永远收不到”的协议破损，不是硬切换。

9. 不能让 `plugin-poker` 自己直接 `fetch` 任意 proxy URL 字符串并在各组件散落调用。必须收敛成平台能力/服务。

10. 不能把 `TxLink` 广播兜底理解成“全平台所有在线用户都广播”。兜底广播必须限定在**当前代理入口、当前网络、当前在线会话集合**，且要有资源上限与背压策略。

11. 不能把 `ts-stack` 当作现成的 `NetGame` / `NetBlackjack` 实现直接引用后就宣称“真值逻辑完成”。`ts-stack` 是底座，不是现成扑克状态机。

12. 不能把 poker identity 直接定义成“当前 active key”。那会导致用户切 active key 后，presence、聊天、桌子 owner、断线重连身份全部漂移。

## 应该怎么做

### 总体策略

采用“双平面 + 多租户虚拟节点 + 分层路由”：

```txt
proxy 外侧平面
  1. P2PNode topic 入口
  2. TxLink raw tx 入口
  3. 两类入口分别暴露、分别保真

proxy 内侧平面
  1. browser session 管理
  2. topic router
  3. tx classifier
  4. tx fallback broadcaster
  5. presence/table reannounce scheduler

plugin-poker 内部
  1. proxy transport 适配层
  2. ts-stack adapter 层
  3. poker protocol engine
  4. 本地 ingest / tx parser / chat parser
  5. UI 与持久化层
```

### 精确路由与广播兜底规则

#### 第一类：必须精确路由

1. `P2PNode` topic：
   - `bsvp/dir`
   - `bsvp/presence`
   - `bsvp/dir?`
   - 各 `tableId`

2. `ChatDirect`
   - 明文带 `recipientPub`

3. `ChatGroup`
   - envelope 明文带 `Members[].PubHex`

4. `Announce`
   - 明文带 `playerPub` 与 `endpoint`

5. `NodeSeed`
   - 明文带 `pub` 与 `endpoint`

#### 第二类：无法可靠归属时必须广播兜底

1. 普通 `Payment`
2. 退款 / 退款回补 / bot refund
3. 钱包任意 incoming tx
4. 未建立 `handId -> session` 映射时的 game move tx
5. 无法从脚本模板稳定提取目标会话的其他 raw tx

#### 第三类：精确路由优先，缺少上下文时广播

1. `Bet`
2. `PotEscrow`
3. `Settlement`
4. `Recovery`
5. `Deal/BoardReveal/Showdown`
6. `TableGenesis/GameStart/HandStart`

这类 tx 若 proxy 已建立：

```txt
tableId -> gameId -> handId -> session
```

则定向；否则广播兜底，不允许因为索引未就绪而丢弃。

## 特殊情况提前约定

### 情况 1：同一个公网入口下有多个 web client 使用同一个 endpoint

处理原则：

```txt
endpoint 可复用
身份不可复用
```

应该这样做：

1. proxy 内每个 browser 连接是独立 session。
2. session 认证后绑定 `playerPubKey`。
3. presence/table ownership 按 `playerPubKey` 区分，不按 endpoint 区分。
4. 对外发布的 endpoint 可以相同；对内状态绝不能合并成一个节点身份。
5. 这里的“endpoint 可复用”是**按入口类型分别复用**：
   - `P2PNode` 入口可复用
   - `TxLink` 入口可复用
   - 但不能把两类入口错误合并成同一真值语义

不能这样做：

1. 不能把多个玩家共用一个 `_ownPresence`。
2. 不能把多个玩家的桌子都挂到一个“代理节点 owner”名下。

### 情况 1.5：原始项目存在两类外部 endpoint

处理原则：

```txt
两类入口都可以由同一代理服务承载
但语义不能混
```

应该这样做：

1. `P2PNode` 相关发现 / topic 流量保留独立入口语义。
2. `TxLink` 相关 gossip/chat/raw tx 流量保留独立入口语义。
3. proxy 配置、公告、日志、健康检查里都要分别命名这两类入口。

不能这样做：

1. 不能在设计文档里把它们笼统写成“一个 host:port endpoint”而不注明语义差异。
2. 不能把 node seed 与 presence/chat 广播到错误入口。

### 情况 2：raw tx 无法从脚本中判断接收方

处理原则：

```txt
无法判定
就广播
```

应该这样做：

1. proxy 标记该 tx 为 `route=fallback-broadcast`。
2. 广播给当前代理入口下、当前网络的在线会话。
3. 由各自 `plugin-poker` 本地执行原始 ingest 语义。

不能这样做：

1. 不能静默丢弃。
2. 不能猜一个最像的接收者定向发过去。

### 情况 3：`tableId -> handId` 索引丢失，但桌局还在线

处理原则：

```txt
服务可降级
协议不可丢
```

应该这样做：

1. proxy 对该桌 raw tx 退化到广播兜底。
2. 同时在后台重新从后续 topic / typed tx 事件重建索引。
3. 一旦索引恢复，再回到精确路由。

不能这样做：

1. 不能因为缺索引就断桌。
2. 不能要求玩家手工重进桌子才能恢复。

### 情况 4：presence / table announce 已签名内容过期，需要重发

处理原则：

```txt
proxy 只重发已签 payload
不代签
```

应该这样做：

1. `plugin-poker` 首次提交已签名 presence / table announce payload。
2. proxy 缓存 payload 原文与 TTL。
3. proxy 按原始重公告节奏定时重发。

不能这样做：

1. 不能由 proxy 用自己的密钥重签。
2. 不能由 proxy 修改 payload 中任何字段后重发。

### 情况 5：浏览器断线重连

处理原则：

```txt
session 可以变
player identity 不能变
```

应该这样做：

1. `plugin-poker` 重连后重新认证当前 `playerPubKey`。
2. 恢复 topic 订阅、owned table、presence heartbeat。
3. 对于断线期间未命中的 tx，由链上与后续 gossip/tx 重放补齐。
4. 这里的 `playerPubKey` 指的是已绑定的稳定 poker identity，不是“当前 active key 快照”。

不能这样做：

1. 不能把断线后的新连接当作新玩家身份。
2. 不能要求用户重新导入或重新生成 poker key。

## 文件级一次性迭代施工单

下面按仓库拆分，只列本次硬切换应该落地的文件，不接受“先落几份 TODO stub”。

### 一、`/home/david/Workspaces/Projects/poker-proxy`

#### 1. 仓库与入口

1. `go.mod`
   - 初始化模块。
   - 固定 Go 版本。
   - 只引入必要依赖：
     - WebSocket
     - 配置
     - 日志
     - 如需 typed tx 解析的 BSV 基础库则收敛在单独包

2. `cmd/poker-proxy/main.go`
   - 读取配置。
   - 启动：
     - browser WSS server
     - mesh TCP listener
     - TxLink TCP listener
     - reannounce scheduler
     - metrics/health

#### 2. 配置与模型

3. `internal/config/config.go`
   - 代理监听地址
   - browser WSS 地址
   - `P2PNode` 入口监听地址
   - `TxLink` 入口监听地址
   - 对外公告用 `P2PNode` 地址
   - 对外公告用 `TxLink` 地址
   - 网络类型
   - TTL / heartbeat / backpressure / broadcast fanout 上限

4. `internal/model/session.go`
   - `Session`
   - `PlayerIdentity`
   - `OwnedTable`
   - `PresenceState`

5. `internal/model/frame.go`
   - `P2PNodeFrame`
   - `TxLinkFrame`
   - `BrowserEnvelope`
   - `TxRouteDecision`

#### 3. Browser 接入面

6. `internal/browser/server.go`
   - WSS listener
   - browser 连接建立/关闭

7. `internal/browser/auth.go`
   - challenge / response
   - 基于浏览器提交的签名认证 `playerPubKey`
   - 不能保存私钥

8. `internal/browser/protocol.go`
   - browser 与 proxy 之间的内部协议
   - 至少包括：
     - `auth.challenge`
     - `auth.response`
     - `topic.subscribe`
     - `topic.unsubscribe`
     - `presence.publish`
     - `table.publish`
     - `table.close`
     - `frame.publish`
     - `tx.publish`
     - `route.deliver`
     - `health.ping`

#### 4. 外部 mesh 平面

9. `internal/mesh/p2pnode_server.go`
   - 对外承接 P2PNode topic frame
   - 维持 flood + dedup 基本语义

10. `internal/mesh/peer_registry.go`
    - 外部 peer 列表
    - seen id
    - 连接状态

11. `internal/mesh/topic_router.go`
    - `bsvp/dir`
    - `bsvp/presence`
    - `bsvp/dir?`
    - `tableId`
    的订阅与分发

12. `internal/mesh/announce_router.go`
    - `P2PNode` 入口相关公告与重放
    - 与 `TxLink` 入口公告区分

#### 5. 外部 TxLink 平面

13. `internal/txlink/server.go`
    - 对外承接 Bitcoin wire `tx`
    - 只负责收 raw tx

14. `internal/tx/classifier.go`
    - 解析 typed output
    - 判断：
      - `ChatDirect`
      - `ChatGroup`
      - `Announce`
      - `NodeSeed`
      - `TableGenesis`
      - `GameStart`
      - `HandStart`
      - `Bet`
      - `PotEscrow`
      - `Settlement`
      - `Recovery`
      - 其他
    - 明确区分：
      - 可单条 tx 决定路由
      - 依赖 `tableId -> gameId -> handId` 上下文决定路由
      - 无法决定时 fallback broadcast

15. `internal/tx/router.go`
    - 能精确路由的定向发给 session
    - 无法归属的走 fallback broadcast

16. `internal/tx/fallback_broadcast.go`
    - 广播兜底
    - 限定在线会话集合
    - 控制资源上限与背压

#### 6. 状态与重放

17. `internal/state/session_registry.go`
    - `sessionId -> session`
    - `playerPubKey -> sessions`
    - `topic -> sessions`

18. `internal/state/table_registry.go`
    - `tableId -> owner/player/session`
    - `tableId -> subscribers`
    - `tableId -> gameId -> handId -> sessions`

19. `internal/state/presence_registry.go`
    - 当前 online player
    - 最新已签名 presence payload

20. `internal/state/identity_registry.go`
    - 稳定 `poker identity` 绑定
    - `playerPubKey -> sessions`
    - `playerPubKey -> owned tables / presence`

21. `internal/reannounce/scheduler.go`
    - 定时重发 cached presence/table announce
    - 仅重放原 payload

#### 7. 健康与观测

22. `internal/health/http.go`
    - `/healthz`
    - `/readyz`

23. `internal/metrics/metrics.go`
    - 精确路由数
    - fallback 广播数
    - 未识别 tx 数
    - session 数
    - topic 数

#### 8. 测试

24. `internal/tx/classifier_test.go`
25. `internal/tx/router_test.go`
26. `internal/mesh/topic_router_test.go`
27. `internal/browser/auth_test.go`
28. `internal/state/table_registry_test.go`
29. `internal/state/identity_registry_test.go`
30. `internal/reannounce/scheduler_test.go`
31. `e2e/multi-tenant-routing_test.go`
32. `e2e/dual-endpoint-semantics_test.go`

测试重点：

1. 两个 player 共用一个公网 proxy endpoint。
2. `ChatDirect` 精确路由。
3. `ChatGroup` 只投递给 envelope 成员。
4. `tableId` 广播只投递给订阅该桌的会话。
5. 无法识别的 raw tx 进入 fallback broadcast。
6. presence/table close/reannounce 不代签。
7. `P2PNode` 与 `TxLink` 两类入口不会互相串线。

### 二、`/home/david/Workspaces/keymaster.cc`

#### 1. contracts 层

1. `packages/contracts/src/poker.ts`
   - 定义 `poker.service` capability
   - 定义 browser <-> proxy 事件/请求契约
   - 定义 poker session / table / route / tx ingest 类型

2. `packages/contracts/src/index.ts`
   - 导出 `poker.ts`

#### 2. 新增插件

3. `packages/plugin-poker/package.json`
   - workspace 包定义
   - 引入 `ts-stack` 相关依赖（至少 `@bsv/sdk`；其余按实际适配面收敛）

4. `packages/plugin-poker/src/index.ts`
   - 统一导出

5. `packages/plugin-poker/src/manifest.ts`
   - 注册 capability / route / menu / settings / i18n

6. `packages/plugin-poker/src/pokerService.ts`
   - 核心服务
   - 管理：
     - proxy 连接
     - session auth
     - topic subscribe/unsubscribe
     - presence publish
     - table publish/close
     - frame publish
     - tx ingest

7. `packages/plugin-poker/src/pokerDb.ts`
   - key-scoped 本地缓存：
     - 当前 player 的 poker 资料
     - 稳定 poker identity 绑定
     - proxy endpoint 设置
     - 最近 tables / sessions / pending tx ingest

8. `packages/plugin-poker/src/pokerMessages.ts`
   - 统一消息类型常量

9. `packages/plugin-poker/src/pokerCrypto.ts`
   - 通过 `vault.withPrivateKey(...)` 受控借用私钥完成签名
   - 明文只在闭包中存在

10. `packages/plugin-poker/src/pokerIdentityBinding.ts`
    - 绑定稳定 poker identity
    - 允许用户显式选择一把 vault key 作为 poker 身份
    - 绑定结果独立于当前 active key 切换

11. `packages/plugin-poker/src/pokerIdentity.ts`
    - 在已有稳定绑定下，解析对应的 vault/keyspace 身份
    - 明确区分 poker identity 与普通 P2PKH 资产身份的使用边界

12. `packages/plugin-poker/src/tsstack/adapter.ts`
    - `ts-stack` 统一适配入口
    - 对外暴露 sdk / wallet / messaging 所需最小包装

13. `packages/plugin-poker/src/engine/pokerProtocolEngine.ts`
    - 承接 TS 真值协议引擎主入口
    - 组合：
      - topic frame 消费
      - tx ingest
      - 状态推进
      - 重连恢复

14. `packages/plugin-poker/src/engine/netGameEngine.ts`
    - `bsv-poker` `NetGame` 的 TS 对等实现
    - 以 `ts-stack` 为加密/脚本/交易底座

15. `packages/plugin-poker/src/engine/netBlackjackEngine.ts`
    - `bsv-poker` `NetBlackjack` 的 TS 对等实现
    - 以 `ts-stack` 为加密/脚本/交易底座

16. `packages/plugin-poker/src/engine/txIngest.ts`
    - 对等实现原始 `Ingest(tx)` 语义
    - 识别：
      - NodeSeed
      - Announce
      - ChatDirect
      - ChatGroup
      - incoming payment
      - game move typed tx

17. `packages/plugin-poker/src/engine/txTemplates.ts`
    - 基于 `ts-stack` 的 typed tx 解析与生成适配

18. `packages/plugin-poker/src/engine/chat.ts`
    - 基于 `ts-stack` 的 direct/group chat 构建与解析

19. `packages/plugin-poker/src/conformance/`
    - 与 `bsv-poker` 行为对拍的测试夹具与向量
    - 不变量：
      - digest/canonicalization 对齐
      - chat parse/build 对齐
      - typed tx parse/build 对齐
      - 桌内状态推进对齐

20. `packages/plugin-poker/src/PokerPage.tsx`
    - 主页面

21. `packages/plugin-poker/src/PokerLobby.tsx`
    - presence / tables / join / host

22. `packages/plugin-poker/src/PokerTable.tsx`
    - 局内视图

23. `packages/plugin-poker/src/PokerSettingsPage.tsx`
    - proxy endpoint
    - 稳定 poker identity 绑定
    - 网络状态
    - 诊断

24. `packages/plugin-poker/src/*.test.ts`
    - 至少覆盖：
      - auth challenge 签名
      - 稳定 poker identity 不随 active key 漂移
      - `ts-stack` adapter 与对拍 fixture
      - topic 订阅恢复
      - fallback tx ingest
      - lock/unlock 下的 fail-closed 行为

#### 3. 装配层

25. `apps/web/src/bootstrapPlugins.ts`
    - 按依赖顺序装配 `plugin-poker`
    - 不允许在 shell 中直接 import 其内部实现

#### 4. 包边界与脚本

26. `scripts/check-boundaries.mjs`
    - 增加 `plugin-poker` 可执行边界规则

建议新增硬边界：

```txt
plugin-poker
  不 import plugin-vault 内部文件
  不 import plugin-p2pkh 内部文件
  不 import apps/web shell
  不直接 import 无边界约束的网络散件
  只通过 contracts capability 使用 vault/keyspace/messageBus
```

脚本层面必须把上面的约束落成“可失败”的检查规则，而不只是备注说明。最低要求：

```txt
发现 packages/plugin-poker/src/** 直接 import:
  - packages/plugin-vault/src/**
  - packages/plugin-p2pkh/src/**
  - apps/web/src/**
则 check-boundaries 直接失败

发现 plugin-poker 绕过 contracts/runtime，
直接依赖宿主侧未声明边界模块，
则 check-boundaries 直接失败
```

#### 5. 文档

27. `README.md`
    - 包结构增加 `plugin-poker`
    - 简述 `poker-proxy` 依赖关系

### 三、跨仓约定

1. `plugin-poker` 与 `poker-proxy` 的内部浏览器协议必须有版本号。
2. 版本不兼容时：
   - 明确报错
   - 不进入半可用状态
3. `plugin-poker` 不能假设 proxy 永远在线；所有 publish/subscribe 都要有重连恢复。
4. `plugin-poker` 的 TS 真值实现必须以 `ts-stack` 为基础设施底座，并通过对拍测试与 `bsv-poker` 对齐。
5. 不能把“对齐测试”理解成只测 happy path；至少要覆盖 bad signature、seat mismatch、stale hand、group decrypt miss、fallback broadcast miss。

## 施工顺序（一次性迭代内的工程顺序，不是分阶段上线）

虽然本次是硬切换，但工程落笔顺序仍应固定，避免互相返工：

1. 先起 `poker-proxy` 仓库骨架、browser 协议、session registry。
2. 再把 `P2PNode` 与 `TxLink` 两类外部入口语义分别落稳。
3. 再做 `P2PNode` topic 平面与精确 topic 路由。
4. 再做 `TxLink` 平面与 tx classifier / fallback broadcaster。
5. 再做 reannounce scheduler。
6. 再在 `keymaster` 增加 `contracts/poker.ts`。
7. 再落 `ts-stack` adapter 与 `plugin-poker` 真值协议引擎。
8. 再落稳定 poker identity 绑定与 settings。
9. 再做 `plugin-poker` service 与 UI。
10. 最后补对拍测试、文档、边界脚本、装配。

这里的“顺序”只是同一迭代里的开发依赖顺序，不表示允许先上线半套。

## 最终验收清单

### 代理侧验收

1. `poker-proxy` 可以启动并同时监听：
   - browser WSS
   - `P2PNode` TCP
   - `TxLink` TCP

2. 两个不同 `playerPubKey` 的 web client 可以共用同一个 proxy 公网入口。

3. 对外 `P2PNode` 与 `TxLink` 两类入口语义保持独立，不会互相串线。

4. presence / table announce 由各自玩家身份签名，对外可见为两个独立玩家，不被压成一个身份。

5. `bsvp/dir`、`bsvp/presence`、`bsvp/dir?`、`tableId` topic 路由正确。

6. `ChatDirect` 精确投递到 `recipientPub` 对应 session。

7. `ChatGroup` 只投递到 envelope `Members[].PubHex` 对应 sessions。

8. `Announce` / `NodeSeed` 被代理识别并进入控制面处理。

9. 无法归属的 raw tx 不会丢失，会进入 fallback broadcast。

10. proxy 不持有任何浏览器私钥、seed、明文签名材料。

11. proxy 断点重启后，不会代签恢复；但浏览器重连后可以重新发布 presence/table 并恢复桌局订阅。

### 前端插件侧验收

1. `plugin-poker` 成功装配到 `apps/web`。

2. vault 锁定时，扑克签名能力 fail-closed：
   - 不允许发送需要签名的消息
   - 不泄露明文材料

3. `plugin-poker` 已绑定稳定 poker identity，切换 active key 不会隐式改变玩家身份。

4. 解锁后，可完成：
   - proxy auth
   - presence publish
   - host table
   - join table
   - table topic 收发

5. `plugin-poker` 的 TS 真值协议引擎通过对拍测试与 `bsv-poker` 对齐：
   - digest/canonicalization
   - typed tx parse/build
   - chat parse/build
   - 关键桌内状态推进

6. 浏览器刷新或网络闪断后，`plugin-poker` 能自动重连并恢复订阅。

7. fallback broadcast 到来的 raw tx，不会导致 UI 崩溃；识别不了的 tx 被安全忽略。

8. `plugin-poker` 不破坏现有 vault / keyspace / p2pkh 行为。

### 集成验收

1. 一张桌由 A 建立，B 加入，二者都通过同一个 proxy 服务连入，且 `P2PNode` 与 `TxLink` 两类入口都工作正常，桌内消息正常。

2. A/B 的聊天直推可达；群聊只送到成员。

3. 一个无法精确归属的 raw payment tx 到达 proxy 后：
   - proxy 执行 fallback broadcast
   - 只有真正相关的 client 本地识别并消费

4. 桌主关闭桌子后，目录里该桌被及时移除，不依赖 TTL 自然过期。

5. 整个流程中没有出现：
   - proxy 代签
   - proxy 静默丢弃未知 tx
   - 多玩家身份被压扁成一个 presence/table owner
   - active key 切换导致 poker 玩家身份漂移

## 交付判定

只有同时满足下面三条，本次施工才算完成：

1. `poker-proxy` 与 `plugin-poker` 均已落代码，不是只有文档或 stub。
2. 精确路由与广播兜底两条路径都有自动化测试覆盖。
3. 实机验证“同一 proxy 入口承载多个 web client”成功，且对外协议行为仍符合 `bsv-poker` 真值语义。
