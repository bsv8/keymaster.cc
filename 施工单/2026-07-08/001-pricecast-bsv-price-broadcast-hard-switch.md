# 001 PriceCast / BSV Price / Broadcast 管理面硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下文件与文档为准：

- `packages/contracts/src/broadcast.ts`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-broadcast/src/broadcastCore.ts`
- `packages/plugin-broadcast/src/manifest.ts`
- `packages/plugin-hubcast/src/manifest.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `apps/web/src/bootstrapPlugins.ts`
- `施工单/2026-07-06/001-broadcast-core-and-plugin-hubcast-hard-switch.md`
- `施工单/2026-07-06/002-broadcast-client-channelId-prefix-delegated-to-hubcast.md`
- `/home/david/Workspaces/PriceCast/README.md`

发生冲突时，按以下优先级：

1. 本单关于“广播是纯在线 fanout、PriceCast 不做历史、不做 DB、不做补同步”的定义优先。
2. 广播系统与消息系统硬隔离优先；不能为了复用 `appmsg` 既有能力把价格广播伪装成消息。
3. 本单是硬切换；不保留“先接 `appmsg` 再拆”“先做两套协议并存再迁移”的过渡尾巴。

---

## 1. 文档定位

这不是“再加一个页面”。

这次要一次性完成三件此前分离但现在必须合并落地的事情：

1. `PriceCast` 从空仓直接落成一个最小 Go 广播发布端。
2. `keymaster.cc` 把广播系统补齐到可运营状态：
   - active provider 真值闭环
   - `/system/broadcast` 管理页
   - protocol 对外接入
   - provider 选择与持久化
3. `keymaster.cc` 增加一个真实业务承载方 `plugin-bsv-price`，消费 PriceCast 广播并展示交易所价格。

本单回答：

- 为什么这次要硬切换，不做分步过渡
- PriceCast 最小协议怎么定义
- keymaster 广播系统这次到底补哪些，不补哪些
- BSV 价格插件怎么接，不怎么接
- 特殊情况提前怎么收口

本单不回答：

- 未来是否支持除 `BSVUSDT` 外的其他交易对
- 未来是否支持多 publisher、多 PriceCast 实例自动聚合
- 未来是否支持历史价格、K 线、深度、成交量

这些都不是本次目标。

---

## 2. 简述缘由

### 2.1 为什么必须硬切换

当前广播系统已经有 core / provider 分层，但还停留在“内核半成品”状态：

- 生产装配里没有 active provider 真值闭环；
- 没有系统管理页；
- 没有真实业务插件消费它；
- 没有 protocol 对外入口；
- 没有 provider 选择 / 持久化 UX。

如果先补其中一半，剩下一半以后再补，会产生两类坏结果：

1. 业务插件先自己绕过管理面和 protocol，直接捏着 `broadcast.core` 临时跑。
2. 广播系统先被某个业务协议绑死，后面再补通用层时又要回头拆。

这两条都不值得走。

所以这次应该一次把“平台层缺口 + 第一个真实业务 + 对外 protocol 形状”一起钉死。

### 2.2 为什么不能走 `appmsg`

BSV 实时价格不是离线消息，也不是本地真值。

它的语义是：

- PriceCast 当前在线抓取多个交易所的最新价格；
- 汇总成一个快照；
- 通过广播频道扇出给当前在线订阅者；
- 订阅者断线期间不要求补历史。

如果塞进 `appmsg`：

- 会被强行套上 DB / sync / list / get / inbox / endpoint / ACL；
- 价格会被误建模成“历史可补的消息”；
- 广播系统的单纯在线语义会被污染。

这是错路。

### 2.3 为什么 PriceCast 协议要极小

用户要的是“交易所以及实时价格信息”，不是行情平台。

所以协议只需要表达：

- 哪些交易所有有效价格
- 每个交易所当前最新价格是多少

不需要：

- K 线
- 深度
- 盘口
- 成交量
- 序列号
- 签名嵌套业务字段
- 历史重放

广播 envelope 自己已经有 `createdAtMs` 和签名，不需要在 body 里再造一套复杂控制字段。

### 2.4 为什么 PriceCast 不做自动发现

“哪些交易所有 BSVUSDT”是外部世界真值，会变。

本次不做“运行时自动发现所有支持 BSVUSDT 的交易所”。

理由很直接：

- 自动发现本身就依赖外部网站 / API / HTML / 文档，太脆；
- 自动发现失败会把“源站变了”误解释成“系统坏了”；
- 这不是价格广播核心能力。

本次只做：

- 一组静态配置的交易所适配器；
- 只有配置进去的交易所才尝试连接；
- 某个适配器跑不通，只影响自己，不拖垮整个服务。

### 2.5 首批交易所为什么就定这 3 家

本次不做“大而全”。

PriceCast 首批固定只接 3 家：

1. Gate
2. Bitget
3. HTX

选择标准只有三条：

- 不要 API key
- 2026-07-08 已核实仍有 `BSVUSDT` / `BSV_USDT` 现货市场
- 官方文档与公开市场接口足够清楚，实施者不用再海搜

为什么是这 3 家：

- Gate：现货 websocket `spot.tickers` / `spot.trades` 都是纯 JSON，结构最直白；
- Bitget：现货 websocket `ticker` 频道就是单对单快照，字段够用；
- HTX：现货 websocket `market.$symbol.ticker` / `trade.detail` 清楚，且公开 market trade 已核实有 `bsvusdt`；

为什么这次**不**先接 Binance / MEXC：

- Binance：官方 websocket 文档清楚，但本次在美国区域网络核实时，`GET /api/v3/ticker/price?symbol=BSVUSDT` 返回 HTTP `451`；这对首批接入不是“最省事”。
- MEXC：公开 REST 价格接口可用，`BSVUSDT` 也存在；但现货 websocket 首批推荐文档落在 protobuf 聚合频道，接入成本高于 Gate / Bitget / HTX。本次不作为第一批。

这不是说它们永远不接，而是这次要优先最简单的 2-3 家。

---

## 3. 本次硬切换最终目标

本次完成后，两个仓库必须同时达到以下最终状态：

### 3.1 PriceCast

1. `/home/david/Workspaces/PriceCast` 变成可运行的 Go 应用。
2. PriceCast 通过静态配置启用若干交易所适配器。
3. PriceCast 只采集 `BSVUSDT` 实时价格。
4. PriceCast 对外只发布一条广播频道：
   - `<publisherPublicKeyHex>.pricecast.bsvusdt`
5. PriceCast 配置文件必须配置运营私钥 `publisherPrivateKeyHex`。
6. `publisherPublicKeyHex` 由这把运营私钥唯一导出，不能再额外接受第二份独立真值配置。
7. 广播频道名前缀固定取这把运营私钥导出的公钥 hex。
8. PriceCast body 协议固定为“完整快照”，不是增量 patch。
9. PriceCast 不落 DB，不缓存历史，不暴露 HTTP 管理后台。
10. PriceCast 以固定小延迟合并高频价格变化，避免疯狂刷广播。

### 3.2 keymaster 广播系统

1. `broadcast` 有默认 active provider 真值闭环。
2. `broadcast` 的 active provider 可切换、可持久化。
3. `broadcast` 有 `/system/broadcast` 管理页。
4. 管理页至少能看：
   - 当前 active provider
   - provider 列表与切换
   - 连接状态
   - owner publicKeyHex
   - 最近错误
   - 下一次自动重连时间
   - 当前本地订阅 union
5. `broadcast` 进入 `plugin-protocol`，对外提供最小 request/event 形状。

### 3.3 keymaster 业务层

1. 仓内新增 `plugin-bsv-price`。
2. 该插件直接消费 `broadcast.core`，不经 `appmsg` 中转。
3. 该插件必须显式配置 PriceCast publisher 公钥 hex，暂定配置名：
   - `pricePublisherPublicKeyHex`
4. 插件实际订阅频道名固定由该配置值拼出：
   - `<pricePublisherPublicKeyHex>.pricecast.bsvusdt`
5. 该配置不跟随当前钱包 active key 变化，不从 vault / keyspace 推导。
6. 插件提供一个业务页，展示：
   - 交易所名称
   - 最新价格
   - 当前广播连接状态
7. 业务页不建本地 DB；刷新后等待下一次快照即可。

---

## 4. 最小协议与系统边界

### 4.1 PriceCast 频道与 protocolId

PriceCast v1 固定使用：

- `channelId = <publisherPublicKeyHex>.pricecast.bsvusdt`
- `protocolId = "pricecast.bsv_price.v1"`

设计缘由：

- `channelId` 绑定单 publisher 与单交易对；
- 未来如果要做别的交易对，直接换 path，不改当前 body；
- `protocolId` 只描述 body 的解释规则，不承载订阅语义；
- `publisherPublicKeyHex` 是 PriceCast 运营真值，不是 keymaster 当前用户真值。

### 4.1.1 PriceCast 运营私钥与 keymaster 订阅公钥边界

这次必须把“谁在发布价格”和“谁在订阅价格”钉死：

1. PriceCast 服务端必须持有一把运营私钥。
2. 这把私钥只用于：
   - HubCast bind
   - 广播 envelope 签名
   - 决定 `channelId` 前缀中的 `publisherPublicKeyHex`
3. keymaster 的 `plugin-bsv-price` 不能拿当前用户钱包的 active key 去拼价格频道。
4. `plugin-bsv-price` 必须读取显式配置的 `pricePublisherPublicKeyHex`，再订阅：
   - `<pricePublisherPublicKeyHex>.pricecast.bsvusdt`

设计缘由：

- 价格发布方是 PriceCast 运营方，不是 keymaster 当前用户；
- 如果把频道前缀绑到当前 active key，用户只会订阅到“自己名下的一条不存在频道”；
- PriceCast 持有私钥、keymaster 只持有对应公钥配置，是最简单也最清晰的职责边界。

### 4.1.2 首批交易所 API 形状（已核实，实施者不要再查）

以下内容是本次实现的**冻结输入面**。如果后续真实实现偏离，必须先改施工单，不允许实现者临时自己换交易所或换频道。

#### A. Gate：主选 1

用途：

- websocket 实时价格主流入源之一
- REST 只用于启动自检，不用于持续轮询

官方 websocket：

- URL：`wss://api.gateio.ws/ws/v4/`
- 订阅频道：`spot.tickers`
- 订阅报文：

```json
{
  "time": 1710000000,
  "channel": "spot.tickers",
  "event": "subscribe",
  "payload": ["BSV_USDT"]
}
```

推送报文关键字段：

```json
{
  "channel": "spot.tickers",
  "event": "update",
  "result": {
    "currency_pair": "BSV_USDT",
    "last": "13.07",
    "lowest_ask": "13.08",
    "highest_bid": "13.06"
  }
}
```

PriceCast 取值规则：

- 直接取 `result.last` 作为该交易所当前价格。

官方公开 REST 自检：

- `GET https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BSV_USDT`
- 2026-07-08 实测返回 `last = "13.07"`

设计决定：

- Gate 不订阅 `spot.trades` 作为主路径；
- `spot.tickers` 已经直接给出 `last`，比 trade stream 更省解析。

#### B. Bitget：主选 2

用途：

- websocket 实时价格主流入源之一
- REST 只用于启动自检，不用于持续轮询

官方 websocket：

- 文档名：Spot Websocket Public `Market Channel`
- 订阅报文：

```json
{
  "op": "subscribe",
  "args": [
    {
      "instType": "SPOT",
      "channel": "ticker",
      "instId": "BSVUSDT"
    }
  ]
}
```

推送报文关键字段：

```json
{
  "action": "snapshot",
  "arg": {
    "instType": "SPOT",
    "channel": "ticker",
    "instId": "BSVUSDT"
  },
  "data": [
    {
      "instId": "BSVUSDT",
      "lastPr": "13.02",
      "bidPr": "13.06",
      "askPr": "13.08",
      "ts": "1783518074004"
    }
  ]
}
```

PriceCast 取值规则：

- 直接取 `data[0].lastPr` 作为该交易所当前价格。

官方公开 REST 自检：

- `GET https://api.bitget.com/api/v2/spot/market/tickers?symbol=BSVUSDT`
- 2026-07-08 实测返回：
  - `lastPr = "13.02"`
  - `bidPr = "13.06"`
  - `askPr = "13.08"`

设计决定：

- Bitget 首批只接 `ticker` 频道；
- 不接 order book / trades，避免多路消息合并。

#### C. HTX：备选 3，但同样纳入首批

用途：

- 第三路实时价格源；
- 结构清楚，但消息体与 Gate / Bitget 风格不同，需要单独适配；

官方 websocket：

- URL：`wss://api.huobi.pro/ws`
- 注意：market websocket 返回是 `GZIP` 压缩，客户端必须先解压。
- 订阅 topic：

```json
{
  "sub": "market.bsvusdt.ticker",
  "id": "pricecast-1"
}
```

或使用 trade 细节：

```json
{
  "sub": "market.bsvusdt.trade.detail",
  "id": "pricecast-2"
}
```

两种可选实现里，本次固定选：

- `market.bsvusdt.ticker`

原因：

- 它直接给 24h 滚动 `close`（最新价）；
- 不需要自己从 trade list 里取第一条。

ticker 推送关键字段：

- `ch = "market.bsvusdt.ticker"`
- `tick.close` = 最新价

公开 REST / market 自检：

- `GET https://api.huobi.pro/market/trade?symbol=bsvusdt`
- 2026-07-08 实测返回：
  - `ch = "market.bsvusdt.trade.detail"`
  - `tick.data[0].price = 13.122`

设计决定：

- 启动自检可以走 `market/trade`；
- 实时订阅固定走 `market.$symbol.ticker`。

#### D. MEXC：本次明确不纳入首批

虽然以下事实已经核实：

- `GET https://api.mexc.com/api/v3/ticker/price?symbol=BSVUSDT`
- 2026-07-08 实测返回：
  - `{"symbol":"BSVUSDT","price":"13.07"}`

但 websocket 首批不选它，理由是：

- 文档主线落在 `spot@public.*.v3.api.pb` protobuf 公共频道；
- 例如 book ticker 订阅参数是：
  - `spot@public.aggre.bookTicker.v3.api.pb@100ms@BSVUSDT`
- 这会把首批接入复杂度抬高；
- 本次目标不是多接一家，而是先把 2-3 家最顺手的跑通。

### 4.2 PriceCast body 形状

PriceCast body 使用 UTF-8 JSON，固定完整快照：

```json
{
  "quotes": [
    { "exchange": "binance", "price": "31.42" },
    { "exchange": "mexc", "price": "31.39" }
  ]
}
```

约束：

- `quotes` 必填，允许为空数组；
- `exchange` 是稳定小写 id；
- `price` 是十进制字符串，不用浮点数；
- body 不再重复带 `pair`、`timestamp`、`version`；
- 快照时间统一用广播 envelope 的 `createdAtMs`。

这次故意不用“每条交易所一条广播”的增量协议。

理由：

- keymaster 业务页只要“当前每家多少钱”，完整快照最简单；
- 订阅端不需要自己处理增量合并、删除、断线补齐；
- 空快照可以直接表达“现在没有任何有效价格”。

### 4.3 PriceCast 发布策略

PriceCast 内部维护一份内存快照：

- key = `exchange`
- value = `price`

任一交易所价格变化时：

1. 更新内存快照；
2. 触发一次固定窗口合并；
3. 到窗口截止时，把最新整份快照广播出去。

窗口固定建议值：

- `500ms`

这是固定值，不做自适应。

设计缘由：

- 直接逐 tick 广播太吵；
- 500ms 级别仍然算实时；
- 固定窗口容易测，也容易推断。

### 4.4 keymaster 广播 protocol 形状

本次给 `plugin-protocol` 增加最小广播接口：

- `broadcast.publish`
- `broadcast.subscription_set`
- `broadcast.subscription_list`
- `broadcast.message_received` event

其中：

1. `broadcast.publish`
   - 入参：`channelId` / `protocolId` / `clientMessageId` / `createdAtMs` / `bodyBase64`
   - 语义：用当前授权 owner 经 `broadcast.core.publish(...)` 发一条广播
2. `broadcast.subscription_set`
   - 入参：`channelIds: string[]`
   - 语义：替换当前 caller 的订阅集合
3. `broadcast.subscription_list`
   - 返回当前 caller 的订阅集合
4. `broadcast.message_received`
   - data：标准化 `BroadcastMessage`，`bodyBytes` 走 base64

关键约束：

- protocol 层按“每个 caller 一份订阅集合”建模，不暴露底层 handler 句柄；
- caller 断开 / popup 关闭 / session 销毁时，自动清掉该 caller 的订阅集合；
- protocol 层不自己做重连，不自己持有 provider handle；
- 真值仍然只在 `broadcast.core`。

### 4.5 `plugin-bsv-price` 的边界

`plugin-bsv-price` 是第一个真实广播业务插件，但它不能把 broadcast 做窄。

它只负责：

- 订阅固定 `PriceCast` 频道
- 校验 `protocolId === "pricecast.bsv_price.v1"`
- 解析 JSON 快照
- 维护内存态
- 提供页面展示

它不负责：

- provider 选择
- 广播管理诊断
- 历史存储
- 协议窗口管理
- 任何 `appmsg` 兼容层

---

## 5. 不能怎么做

### 5.1 不能把 PriceCast 伪装成 `appmsg`

不能做：

- 用 `appmsg.send/list/get` 承载价格
- 把价格快照落进消息本地库
- 做一个“价格消息页面”去读 `plugin-message`

理由：

- 价格是在线广播，不是离线消息；
- 这么做会把系统复杂度错误地拉进 DB / sync 路径。

### 5.2 不能把广播系统做成“价格专用层”

不能做：

- 在 `broadcast.core` 里 hardcode `pricecast.bsv_price.v1`
- 在 `broadcast.core` 里解析价格 JSON
- 在 `plugin-hubcast` 里认识 `quotes`

理由：

- 这些都属于业务协议；
- core / provider 必须保持 provider-generic。

### 5.3 不能上来就做“通用市场数据平台”

不能做：

- 多交易对目录
- 交易所自动发现
- 历史缓存
- K 线接口
- 价格告警
- 用户自定义频道编辑器

理由：

- 这次目标只是“把第一条真实业务跑通，并把广播系统补成完整平台”；
- 不是做行情产品。

### 5.4 不能做双协议并存迁移

不能做：

- PriceCast 同时往旧通道和新通道双发
- keymaster 同时订阅旧通道和新通道再做 merge
- 价格插件先走 `appmsg`，以后再切 `broadcast`

理由：

- 没有现网包袱；
- 双写双读只会制造不必要复杂度。

### 5.5 不能把 publisher key 轮换做成复杂迁移流

不能做：

- 双 publisher 并行发布
- keymaster 同时信任两把 PriceCast publisher key
- 运行时自动切换 publisher 来源

这次直接按硬切换处理：

- PriceCast 换 key
- keymaster 改 `pricePublisherPublicKeyHex` 配置
- 两边一起重启

---

## 6. 特殊情况与处理规则

### 6.1 PriceCast 启动时没有任何可用交易所

规则：

- 如果配置列表为空，进程直接启动失败并退出；
- 如果配置不为空但所有适配器初始化失败，进程直接启动失败并退出。

理由：

- 这不是临时网络抖动，而是部署 / 配置错误；
- 不值得让一个“什么也发不出来”的进程空跑。

### 6.2 运行中只有部分交易所可用

规则：

- 保留可用交易所；
- 不可用交易所从当前快照里移除；
- 继续发布“部分可用”的完整快照；
- 每个适配器自己固定 5 秒重连。

不做：

- 因单个交易所失败而暂停全局发布；
- 页面上额外展示复杂状态枚举。

### 6.3 运行中全部交易所暂时不可用

规则：

- 当最后一个有效价格消失时，PriceCast 发布一次空快照：

```json
{ "quotes": [] }
```

- 之后继续保活并等待适配器恢复；
- 恢复后再次发布完整快照。

理由：

- 否则 keymaster 会一直显示旧价格，无法知道当前已无有效报价。

### 6.4 PriceCast 收到价格乱序或抖动

规则：

- PriceCast 内部“最新收到者覆盖旧值”；
- keymaster `plugin-bsv-price` 只接受 `createdAtMs >= currentSnapshot.createdAtMs` 的快照；
- 更老的快照直接丢弃。

这次不做：

- 业务层 sequence number
- 交易所级去重账本

### 6.5 keymaster 侧 vault 锁定 / 无 active key

规则：

- `broadcast.core` 按既有机制进入结构性离线；
- `/system/broadcast` 展示 idle / not ready；
- `plugin-bsv-price` 不自己拉重试循环，只订阅 core 状态变化；
- 解锁后由 core 协调器重新 bind。

### 6.6 protocol caller 订阅为空

规则：

- `broadcast.subscription_set([])` 表示清空当前 caller 的订阅；
- 清空后 protocol 层撤销自己在 `broadcast.core` 上对应的本地订阅；
- 不保留空句柄。

### 6.7 protocol caller 异常退出

规则：

- popup 关闭 / session 销毁 / caller 被清理时，必须同步清掉它的订阅集合；
- 不能让“已退出 caller 的频道”残留在 union 里。

### 6.8 PriceCast publisher key 轮换

规则：

1. 先停旧 PriceCast；
2. 更新 PriceCast 发布私钥；
3. 从新私钥导出新 `publisherPublicKeyHex`；
4. 更新 keymaster 里的 `pricePublisherPublicKeyHex` 配置；
5. `plugin-bsv-price` 按新公钥重新拼频道名：
   - `<newPublisherPublicKeyHex>.pricecast.bsvusdt`
6. 重新部署 keymaster 与 PriceCast；
7. 不保留双 key 兼容窗口。

这条是硬切换纪律，不例外。

### 6.10 keymaster 配错 publisher 公钥

规则：

- `plugin-bsv-price` 允许启动；
- 但它会持续订阅一条错误频道，因此页面表现为“无数据”；
- 页面必须能展示当前订阅频道名；
- `/system/broadcast` 必须能看到 union 里实际订阅的频道名；
- 不做自动扫描或自动猜测“正确 publisher 公钥”。

理由：

- 这是部署配置错误，不是协议层错误；
- 自动扫别的频道只会扩大系统复杂度并破坏显式配置边界。

### 6.9 收到非法 body

规则：

- `broadcast.core` 只负责验签和 exact channel 分发；
- `plugin-bsv-price` 如果发现：
  - `protocolId` 不匹配
  - JSON 解析失败
  - `quotes` 结构非法
  - `price` 不是十进制字符串
- 只记日志并忽略该条消息；
- 页面保持上一份合法快照；
- 不让页面崩溃，不让 core 崩溃。

---

## 7. 文件级一次性迭代施工单

以下是本次必须落地的文件级改动范围。实现时允许补测试文件，但主边界不应漂移。

### 7.1 `/home/david/Workspaces/PriceCast`

#### 7.1.1 Go 模块与入口

- `go.mod`
  - 初始化 Go 模块；
  - 引入最少依赖：
    - WebSocket client
    - JSON
    - secp256k1 / 签名所需库
- `cmd/pricecast/main.go`
  - 启动配置读取；
  - 启动交易所适配器；
  - 启动 HubCast 发布循环；
  - 处理退出与日志。

#### 7.1.2 配置

- `internal/config/config.go`
  - 定义最小配置：
    - `hubcastWsURL`
    - `publisherPrivateKeyHex`
    - `enabledExchanges`
    - `publishIntervalMs`
  - 启动时校验配置；
  - 从 `publisherPrivateKeyHex` 唯一导出 `publisherPublicKeyHex`；
  - 生成固定 `channelId` 与 `protocolId`。

- `configs/pricecast.example.env`
  - 示例配置；
  - 明确 `BSVUSDT` 是固定交易对；
  - 明确运营私钥是必填；
  - 不提供多交易对配置。

#### 7.1.3 交易所适配层

- `internal/exchange/types.go`
  - 统一 `QuoteUpdate` / adapter 接口。
- `internal/exchange/runner.go`
  - 启停适配器；
  - 汇总 update；
  - 固定 5 秒重连。
- `internal/exchange/factory.go`
  - 按配置启用适配器。
- `internal/exchange/<exchange>.go`
  - 每个已确认支持 `BSVUSDT` 的交易所一个文件；
  - 只做实时 ticker 订阅与价格提取；
  - 不做历史回补。

首批固定 3 个文件：

- `internal/exchange/gate.go`
  - 连接 `wss://api.gateio.ws/ws/v4/`
  - 订阅 `spot.tickers`
  - `payload = ["BSV_USDT"]`
  - 从 `result.last` 取价格

- `internal/exchange/bitget.go`
  - 连接 Bitget spot public websocket
  - 订阅：
    - `instType = "SPOT"`
    - `channel = "ticker"`
    - `instId = "BSVUSDT"`
  - 从 `data[0].lastPr` 取价格

- `internal/exchange/htx.go`
  - 连接 `wss://api.huobi.pro/ws`
  - 先做 GZIP 解压
  - 订阅 `market.bsvusdt.ticker`
  - 从 `tick.close` 取价格

本次明确不创建：

- `internal/exchange/binance.go`
- `internal/exchange/mexc.go`

理由已经在 §4.1.2 说明，不再重复。

#### 7.1.4 快照与发布

- `internal/price/snapshot.go`
  - 维护内存快照；
  - 支持更新 / 删除交易所价格；
  - 生成排序稳定的完整快照。
- `internal/protocol/body.go`
  - 定义 `pricecast.bsv_price.v1` body 结构；
  - JSON encode / decode；
  - 校验 `exchange` / `price`。
- `internal/publish/coalescer.go`
  - 固定窗口合并（默认 500ms）；
  - 只保留最新快照。
- `internal/hubcast/client.go`
  - 建立 HubCast 连接；
  - bind；
  - `broadcast.publish`。
- `internal/publish/publisher.go`
  - 把快照编码成 body；
  - 写入 `channelId` / `protocolId` / `createdAtMs`；
  - 发布到 HubCast。

#### 7.1.5 测试

- `internal/protocol/body_test.go`
  - 编解码与非法字段测试。
- `internal/price/snapshot_test.go`
  - 增删改与排序稳定性测试。
- `internal/publish/coalescer_test.go`
  - 高频 update 合并测试。
- `internal/hubcast/client_test.go`
  - publish 参数形状测试。

### 7.2 `keymaster.cc` 广播平台补齐

#### 7.2.1 contracts

- `packages/contracts/src/broadcast.ts`
  - 增补 active provider 持久化相关注释与快照约束；
  - 确认 `inspect()` / provider snapshot 足够支撑管理页；
  - 如缺失，补充对 protocol / 管理页需要的最小 typed 公开形状。

- `packages/contracts/src/protocol.ts`
  - 增加：
    - `broadcast.publish`
    - `broadcast.subscription_set`
    - `broadcast.subscription_list`
    - `broadcast.message_received`
  - 定义 request params / result / event data；
  - `bodyBytes` 用 base64 表达。

- `packages/contracts/src/index.ts`
  - 补导出。

#### 7.2.2 broadcast core 与 manifest

- `packages/plugin-broadcast/src/broadcastCore.ts`
  - 增加 `broadcast.activeProviderId` 持久化；
  - 缺省 provider 语义与 `appmsg` 对齐：
    - 初次无持久值且 `hubcast` 注册时自动激活；
    - 用户显式 `setActive(null)` 后不再自动默认；
  - 保持现有 reconnect / union / verify 逻辑不被业务协议侵入。

- `packages/plugin-broadcast/src/manifest.ts`
  - 从 `localStorage` 读取 / 写入 `broadcast.activeProviderId`；
  - 注册 `/system/broadcast` 路由、菜单、面包屑；
  - i18n 增加管理页文案；
  - 不引入业务价格协议。

- `packages/plugin-broadcast/src/broadcastService.ts`
  - 管理页 service；
  - 聚合：
    - active provider snapshot
    - provider list
    - setActiveProvider
    - `core.inspect()`

- `packages/plugin-broadcast/src/BroadcastPage.tsx`
  - 广播系统管理页；
  - 展示：
    - 当前 active provider
    - 已注册 provider 列表
    - 连接状态 / owner / lastError / nextReconnect
    - 当前 union 频道列表

- `packages/plugin-broadcast/src/styles.css`
  - 管理页样式。

- `packages/plugin-broadcast/src/index.ts`
  - 导出页面 / service。

- `packages/plugin-broadcast/src/broadcastCore.test.ts`
  - 补 active provider 持久化、默认激活、显式置空、unregister 行为测试。

- `packages/plugin-broadcast/src/BroadcastPage.test.tsx`
  - 管理页渲染、状态切换、provider 切换测试。

#### 7.2.3 web 装配

- `apps/web/src/bootstrapPlugins.ts`
  - 保持 `broadcast -> hubcast` 顺序；
  - 增加 `plugin-bsv-price`；
  - 不再把 hubcast 只停留在“注册了但未激活”的状态。

- `apps/web/src/styles/plugins.css`
  - 引入 `@keymaster/plugin-broadcast/styles.css`
  - 引入 `@keymaster/plugin-bsv-price/styles.css`

- `apps/web/package.json`
  - 增加 `@keymaster/plugin-bsv-price`

- `tsconfig.json`
  - 增加 `packages/plugin-bsv-price` project reference。

### 7.3 `plugin-protocol` 广播接入

- `packages/plugin-protocol/src/protocolService.ts`
  - 接入 `broadcast.core`；
  - 维护“每个 caller 一份订阅集合”；
  - 实现：
    - `broadcast.publish`
    - `broadcast.subscription_set`
    - `broadcast.subscription_list`
  - 把收到的 `BroadcastMessage` 推成 `broadcast.message_received` event；
  - caller 销毁时清理订阅。

- `packages/plugin-protocol/src/protocolService.broadcast.test.ts`
  - 新增广播 protocol 测试；
  - 覆盖：
    - publish 参数校验
    - subscription_set 替换语义
    - 多 caller 订阅 union
    - caller 销毁后清理
    - event 下发

### 7.4 新增 `packages/plugin-bsv-price`

#### 7.4.1 包结构

- `packages/plugin-bsv-price/package.json`
- `packages/plugin-bsv-price/tsconfig.json`
- `packages/plugin-bsv-price/src/index.ts`

#### 7.4.2 业务协议常量

- `packages/plugin-bsv-price/src/constants.ts`
  - 固定：
    - `PRICECAST_PROTOCOL_ID = "pricecast.bsv_price.v1"`
  - 频道名不直接写死为完整常量，而是由：
    - `pricePublisherPublicKeyHex`
    - `".pricecast.bsvusdt"`
    拼出
  - 本次默认走代码配置或构建注入；
  - 不做运行时用户编辑器。

#### 7.4.3 service

- `packages/plugin-bsv-price/src/bsvPriceService.ts`
  - 直接消费 `broadcast.core`；
  - 订阅由 `pricePublisherPublicKeyHex` 拼出的固定频道；
  - 校验 protocolId；
  - 解析 body；
  - 维护内存态：
    - `status`
    - `quotes`
    - `lastSnapshotAtMs`
    - `lastError`
  - 只接受更新时间不倒退的快照。

- `packages/plugin-bsv-price/src/bsvPriceProtocol.ts`
  - `pricecast.bsv_price.v1` body 解码与校验。

#### 7.4.4 页面

- `packages/plugin-bsv-price/src/BsvPricePage.tsx`
  - 业务页；
  - 展示交易所与价格；
  - 展示当前连接状态；
  - 无历史、无图表、无告警。

- `packages/plugin-bsv-price/src/styles.css`
  - 页面样式。

- `packages/plugin-bsv-price/src/manifest.ts`
  - 注册：
    - capability：`bsv-price.service`
    - route：`/bsv-price`
    - menu：`tools`
    - i18n 文案
  - 组装 `pricePublisherPublicKeyHex` 配置并注入 service；
  - 不注册首页 widget；
  - 理由：这次先收口成单页面，避免多表面状态分叉。

#### 7.4.5 测试

- `packages/plugin-bsv-price/src/bsvPriceProtocol.test.ts`
  - body 解析与非法数据测试。
- `packages/plugin-bsv-price/src/bsvPriceService.test.ts`
  - 快照替换、旧快照丢弃、非法 body 忽略测试。
- `packages/plugin-bsv-price/src/BsvPricePage.test.tsx`
  - 页面空态 / 有数据态 / 错误态测试。

### 7.5 其它边界文件

- `apps/web/src/bootstrapPlugins.test.ts`
  - 增加 `plugin-bsv-price` 装配断言。

- `packages/plugin-hubcast/src/manifest.ts`
  - 注释与测试若需更新，明确其只 register provider，不承担管理页与业务协议。

---

## 8. 最终验收清单

### 一、PriceCast 基础验收

- [ ] `/home/david/Workspaces/PriceCast` 是一个可运行 Go 模块。
- [ ] PriceCast 首批固定只接：
  - [ ] Gate
  - [ ] Bitget
  - [ ] HTX
- [ ] PriceCast 首批不接：
  - [ ] Binance
  - [ ] MEXC
- [ ] PriceCast 启动时必须读取配置并校验：
  - [ ] HubCast URL
  - [ ] publisher 私钥
  - [ ] enabled exchanges
- [ ] `publisherPublicKeyHex` 由 `publisherPrivateKeyHex` 唯一导出，不单独接受第二份独立配置真值。
- [ ] 没有配置任何交易所时，PriceCast 启动失败并退出。
- [ ] 有配置但所有交易所适配器初始化失败时，PriceCast 启动失败并退出。

### 二、PriceCast 协议验收

- [ ] PriceCast 只发布到一个固定频道：
  - [ ] `<publisherPublicKeyHex>.pricecast.bsvusdt`
- [ ] `protocolId` 固定为 `pricecast.bsv_price.v1`。
- [ ] body 是 UTF-8 JSON 完整快照，不是增量 patch。
- [ ] `quotes` 中每项都只有：
  - [ ] `exchange`
  - [ ] `price`
- [ ] `price` 使用十进制字符串，不是 JSON number。
- [ ] 当全部报价消失时，PriceCast 会发一次空快照 `{ "quotes": [] }`。

### 三、PriceCast 运行时验收

- [ ] Gate 价格从 websocket `spot.tickers.result.last` 取值。
- [ ] Bitget 价格从 websocket `ticker.data[0].lastPr` 取值。
- [ ] HTX 价格从 websocket `market.bsvusdt.ticker.tick.close` 取值。
- [ ] HTX websocket 消息在解析前已做 GZIP 解压。
- [ ] 单个交易所断线不会拖垮整个进程。
- [ ] 单个交易所恢复后会重新进入下一次快照。
- [ ] 高频价格更新会被固定窗口合并，不会逐 tick 直接广播。
- [ ] 固定窗口值为常量，不做指数退避或动态调速。

### 四、keymaster 广播平台验收

- [ ] `broadcast` 存在默认 active provider 真值闭环。
- [ ] `hubcast` 注册后，在默认语义下可进入 active provider。
- [ ] `broadcast.activeProviderId` 会持久化。
- [ ] 用户显式清空 active provider 后，不会被默认值立即抢回。
- [ ] `/system/broadcast` 可访问。
- [ ] 管理页能展示：
  - [ ] 当前 active provider
  - [ ] 已注册 provider 列表
  - [ ] 当前连接状态
  - [ ] owner publicKeyHex
  - [ ] 最近错误
  - [ ] 下一次自动重连时间
  - [ ] 当前本地订阅 union
- [ ] 管理页可手动切换 active provider。

### 五、protocol 广播验收

- [ ] protocol 对外新增：
  - [ ] `broadcast.publish`
  - [ ] `broadcast.subscription_set`
  - [ ] `broadcast.subscription_list`
  - [ ] `broadcast.message_received`
- [ ] `broadcast.subscription_set` 是替换语义，不是增量 add/remove。
- [ ] 多个 caller 并存时，本地 union 正确。
- [ ] 某个 caller 销毁后，它的频道会从 union 中去掉。
- [ ] `broadcast.message_received` 能把 base64 body 正确推给 caller。

### 六、`plugin-bsv-price` 业务验收

- [ ] 存在独立 `plugin-bsv-price` 包。
- [ ] 插件必须配置 `pricePublisherPublicKeyHex`。
- [ ] 插件实际订阅频道名为：
  - [ ] `<pricePublisherPublicKeyHex>.pricecast.bsvusdt`
- [ ] 插件订阅频道名不跟随当前 active key 变化。
- [ ] 页面路由可访问：
  - [ ] `/bsv-price`
- [ ] 页面能展示：
  - [ ] 交易所名称
  - [ ] 最新价格
  - [ ] 当前广播连接状态
  - [ ] 当前订阅频道名
- [ ] 页面不依赖 `appmsg`。
- [ ] 页面不建本地 DB。
- [ ] 刷新页面后，如果尚未收到新快照，展示空态而不是旧缓存。
- [ ] 收到合法快照后，页面能整体替换当前列表。
- [ ] 收到更旧的快照时，页面不会回退到旧值。
- [ ] 收到非法 body 时，页面不崩溃，上一份合法快照仍保留。

### 七、边界验收

- [ ] `broadcast.core` 不认识 `pricecast.bsv_price.v1`。
- [ ] `plugin-hubcast` 不解析价格 JSON。
- [ ] `plugin-bsv-price` 不接触 provider handle / wire event。
- [ ] 系统里没有任何“价格走 appmsg”的旁路实现。
- [ ] 没有双频道 / 双 publisher / 双协议并存迁移代码。

### 八、特殊情况验收

- [ ] PriceCast 全部交易所暂时不可用时，keymaster 最终能看到空快照状态。
- [ ] keymaster vault 锁定后，`plugin-bsv-price` 不自建重试循环。
- [ ] keymaster 解锁后，由 `broadcast.core` 重新恢复连接。
- [ ] protocol caller 退出后不会遗留幽灵订阅。
- [ ] publisher key 轮换按硬切换处理，不存在双 key 兼容窗口。
- [ ] keymaster 配错 `pricePublisherPublicKeyHex` 时，页面不会崩溃，且 `/system/broadcast` 能看见错误订阅频道名。

---

## 9. 本次明确不做

- 不做历史价格库
- 不做图表
- 不做多交易对选择器
- 不做交易所自动发现
- 不做用户可编辑的 PriceCast publisher 配置页
- 不做首页 widget
- 不做 `appmsg` fallback
- 不做复杂重试和迁移编排

这些都不是遗漏，是本次为了系统简单而故意不做。
