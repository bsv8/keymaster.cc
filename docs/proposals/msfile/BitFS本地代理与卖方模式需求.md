# BitFS 本地 MSFile 与卖方模式需求

> 状态：需求已对齐，实施未完成；第 7 节及第 10–11 节采用卖家主动连接买家的下载流程。
>
> 相关真值：MSFile 对外语义以 `MSFile-Proxy-Protocol` V1 为准；BitFS 交易与证据语义以
> `go-bitfs` Wire Protocol v1 为准；文件内容布局沿用 Keymaster `/msfile/storage`。

## 1. 目标

Keymaster 内置一个不经过 MSFile 网络的 `local msfile`。页面、可信插件和 Connect App 仍只调用
统一的 MSFile `stat`、`readSeed`、`readBlock` 能力：

- 本地已有内容时，从 `/msfile/storage` 对应存储直接读取；
- 本地没有内容时，local msfile 可以作为 BitFS 买方购买并写入同一存储；
- 用户开启卖方模式后，Keymaster 可以把同一存储中的完整文件作为 BitFS 卖方出售；
- 远程 MSFile Proxy 继续通过 `/msfile/1.0.0` 工作，并与 local msfile 作为并列来源协同。

```text
页面 / Connect App
        │ 统一 MSFile API
        ▼
Coordinator MSFile 调度器
        ├── local msfile（进程内调用，不编码 MSFile wire）
        │     ├── /msfile/storage 内容仓库
        │     └── BitFS 买方 / 卖方工作流
        └── remote msfile proxy（libp2p /msfile/1.0.0）
```

## 2. 范围

### 2.1 本期包含

1. MSFile 来源从“只用供应商公钥标识”扩展为 local 与 remote 两类来源。
2. local 的 Stat、Seed 读取、Block 读取。
3. BitFS 买方购买、支付池、恢复、广播对账及购买结果入库。
4. BitFS 卖方开关、Seed 内存索引、Channel Hash 请求匹配、报价、交付和收款。
5. 卖方模式运行时禁止 Vault 自动锁；手动锁仍然有效。
6. ChannelProtocol 文件需求广播、WebRTC SDP/ICE 信令和 BitFS DataChannel transport；保留独立的 WebSocket/WSS transport 准入。

### 2.2 本期不包含

- Keymaster 充当 BitFS 仲裁方；
- 自建新的 MSFile 内容仓库或 BitFS 专用内容副本；
- 把 `webrtc-sdp` 误当作 bitcoin-libp2p WebRTC Direct；
- 通过 Circuit Relay 承载文件或 BitFS wire；
- Vault 自动解锁或跨 Worker/浏览器重启保存明文私钥；
- 未经用户开启卖方模式自动发布报价。

## 3. 名词和字段

| 字段 | 中文含义 |
| --- | --- |
| `sourceId` | MSFile 来源的稳定路由标识 |
| `sourceKind` | 来源类型：`local-bitfs` 或 `remote-proxy` |
| `supplierPublicKeyHex` | 远程 Proxy 经 libp2p 认证的压缩公钥；local 不伪造该字段 |
| `seedHashHex` | MasterSeed 原始字节的 SHA-256 小写 hex |
| `blockHashHex` | 单个文件块的 SHA-256 小写 hex |
| `sellerEnabled` | 用户是否允许当前 Key 作为 BitFS 卖方 |
| `sellerRuntimeStatus` | 卖方当前运行状态，不等于用户开关 |

## 4. 唯一内容存储

local 买方、local 卖方与 `/msfile/storage` 页面必须共用当前 Key 的同一份 `OwnerFileStore`：

```text
<owner>/msfiles/seeds/<seedHash>.ms
<owner>/msfiles/storage/<seedHash>/<blockHash>
<owner>/msfiles/meta/<seedHash>.json
```

- 页面上传的内容可以直接出售；
- BitFS 购买成功的内容按“Block → Seed → 元数据”顺序写入后，立即成为普通本地 MSFile 文件；
- 页面下载、预览、校验和删除继续复用现有服务；
- 不建立 BitFS cache、临时永久副本或第二套元数据真值；
- 部分购买内容只有在 Seed、全部 Block 和元数据提交完成后才进入**已存储文件列表**；购买任务及其进度、花费另行显示在同一页面。

## 5. 统一 MSFile 来源

local 调用直接走 Coordinator 内的方法调用，不建立虚假 libp2p connection，不生成 MSFile request ID，
也不编码 `/msfile/1.0.0` CBOR Frame。local 与 remote 必须保持相同业务结果：

- `available`：内容已就绪；
- `absent`：没有内容且没有可报告的发现状态；
- `discovering`：正在发现 BitFS 报价；
- `quoted`：已有可验证报价；
- `network-error`：发现或传输失败，不能折叠为 `absent`。

统一 Block 读取上下文必须包含 `sourceId + seedHashHex + blockHashHex`。local 用 Seed Hash 精确定位
`storage/<seedHash>/<blockHash>`；remote wire 仍只发送 Block Hash，Seed Hash 留作 Keymaster 本地关系校验，
不修改 MSFile Proxy Protocol V1。

## 6. local 读取与完整性

### 6.1 Stat

local 报告 `available` 前至少确认：

1. 元数据严格合法；
2. Seed 存在且 `SHA-256(seedBytes) == seedHash`；
3. Seed 长度、文件大小和块数相互一致；
4. Seed 引用的全部 Block 均存在；
5. 当前记录没有已知的完整性失败标记。

完整 Block 的实际字节 Hash 仍在每次读取或完整校验时验证。发现损坏后必须立即撤销 `available`，
不得返回错误字节；允许通过 BitFS 或 remote 来源重新获取。

### 6.2 Read

- `readSeed` 必须校验 Seed Hash、长度和结构；
- `readBlock` 必须校验 Block Hash，并在掌握文件大小时校验末块精确长度；
- 同一内容的并发 local 获取使用 single-flight，不能重复购买；
- 本地已有且验证通过的内容直接返回，价格为零；
- “通过 Seed 获取文件”界面发现 local 缺失时自动创建或复用本 Key、该 Seed 的需求任务；查询和发布需求不划拨资金。
- `stat`、`readSeed`、`readBlock` 的只读调用不隐式开池或付款；其它调用方不得仅因 local 缺失就触发购买。

## 7. BitFS 买方

购买遵循固定顺序：

```text
加载已保存状态
→ 发现并验证报价
→ 检查本次价格授权
→ 角色工作流计算/验证
→ 持久化 checkpoint 与 exact outbox bytes
→ 发送或广播
→ 记录结果
```

必须保存报价、开池证据、授权、交付、买方签名、卖方本地补签结果，以及实际广播交易的原文、规范 txid、outbox 和结果未知记录。
网络超时重发已保存的 exact bytes，不能重新签名生成另一份报文。内容必须先验证并可靠写入，才允许
签署相应付款。广播结果未知时按 txid/outpoint 对账，不盲目重签或推进状态；这只适用于实际广播的开池、关池、退款或仲裁交易，池内递进付款不提交 WOC。

报价发现不是 go-bitfs SDK 的职责。本期应用协议使用 ChannelProtocol 的 `bsv8.hash.request.v1` 发布需求，
并通过 `bsv8.webrtc.signal.v1` 接收关联 offer。Keymaster 负责把验签后的 BitFS Kind 1 展示为报价；
报价选择、购买和资金流程未实现前不得把网络报价标成已下载，也不得开池或付款。

### 7.1 需求、报价与开始下载

1. 本地缺失即发布 `bsv8.hash.request.v1`，绑定 Seed Hash、买方身份、真实 `message_id`、过期时间和 `webrtc-sdp` 能力声明。该 locator 表示买方接受 SDP 信令，不是可拨地址。卖家引用该请求发送已签名 offer；买方通过私密 Inbox 回答并持续统计已验签报价。无符合条件的报价时任务保持“等待合适报价”，不预先拆分余额。
2. MSFile 设置提供 `buyerAutoPurchaseEnabled`（自动购买开关，旧设置缺省关闭）、`maxFullBlockPriceSatoshis`（自动下载最高完整块价，聪）、`sellerSelectionPriority`（卖家选择偏好：价格优先或最近速度优先）和 `blocksPerBatch`（每次请求的 Block 数，默认 10，可设 1–16）。**便宜与否只按单块报价判断**；不设单文件最高花费，也不因文件总价而拒绝合格块。自动购买开启时，只接受单块报价不高于设置上限的卖家；关闭时仍可收集报价并由用户按文件强制下载。
3. `/msfile/storage` 的每个待下载文件提供“强制下载”及独立滑块。滑块设定该文件所有卖家的最高可接受块价，覆盖自动下载块价上限；即使选择网速优先，也不能购买超过该上限的块。多个不同报价时，滑块范围为当前有效报价的最低价至最高价，初始值为 `最低价 + (最高价 − 最低价) × 20%`，金额按整数聪取整；只有一个有效报价或所有报价相同，范围为报价至报价的 120%，初始值为报价的 120%。新报价可更新滑块范围，但不得自动提高用户已经选定的上限；需要用户再次拖动才允许更高价格。实际付款始终按已验证报价，不按滑块上限计费。
4. 第一个合格报价出现或用户强制下载后，任务进入“开始下载”：此时才为**这一个文件**按 MSFile 的资金规则拆分余额。资金划拨是开始下载的第一步，与卖家数量无关；卖家后续涌入或离开不要求按人数重拆。

### 7.2 资金与卖家调度

1. MSFile 可从普通余额的多个 UTXO 聚合，并拆出若干回到当前 Key 地址的专用 UTXO；这些 UTXO 由余额服务的受保护 outpoint 机制隔离普通转账。MSFile 记录每笔资金的来源交易、归属文件、可用/占用/待回收状态，不派生新私钥或地址。拆分交易的广播结果未知时先按原 txid 对账，不得再次构造拆分交易。
2. 首次拆分按该文件下一段预计购买所需金额规划；后续金额不足时才再次拆分，目标为下一段预计需求的 120%，留下 20% 余量。120% 是**划拨量规则**，不是售价加成或单文件价格上限。拆分数量由 MSFile 的 UTXO 管理规则决定，不按卖家数确定。专用 UTXO 未花部分仍属于用户资金。
3. 所有单块报价不高于当前任务上限的卖家都有正式传输的机会；首次交付就是正式购买并按协议付款，没有免费试传或“试传”阶段。对未曾交付的卖家标记“速度未知”。限制同时连接、开池和传输数；新卖家排队进入，差的卖家退出后让出名额。
4. 下载中按每个卖家**最近已验证块**的有效字节和耗时评估速度，不使用整个任务的全局平均。价格优先时先比较块价，价格接近再比较最近速度；网速优先时先比较最近速度，速度接近再比较块价。对样本不足、超时与断线有确定规则；只有表现持续明显更好才重分配**后续**块，避免频繁切换。已有请求、交付与付款保留原卖家归属，不能重复买同一块。
5. 卖家表现合适且仍有内容要买时，可以继续建立后续费用池；不再采用的卖家停止接收新请求，关闭其费用池并回收未使用资金。多个卖家的池、付款和回收分别记账。

### 7.2.1 费用池交易与交付顺序

1. 买方取得 Kind 3 退款预签后构造 FundingTx，先保存原文与资金占用，再提交 WOC。WOC 明确返回广播成功，即可继续发送 Kind 4；不等待出块，也不以查询索引是否已经显示交易作为成功条件。广播返回未知时只按原 txid 对账，不把未知当成功。
2. 开池证明包含双方预签的远期退款交易。正常购买使用花费同一开池输出的近期累计付款候选：**同一费用池严格串行**，每轮 seq 恰好为上一轮加一，卖方金额是该池迄今的累计付款额；本轮应付价格等于本轮累计金额减去上一轮累计金额。不同 node 的不同费用池可以并行，各池分别记账。普通池内候选的 sequence 不是最终值 `0xffffffff`，它们是双方本地保存的递进状态，**不逐笔提交 WOC，也不要求在 WOC 显示**。
3. 每轮严格按 Kind 5 买方授权、Kind 6 卖方交付、买方验货及可靠暂存、Kind 7 买方交易签名的顺序进行。卖方收到 Kind 7 后依据自己的已保存状态核对授权、序号、累计金额与买方签名，补签并保存完整交易。买方不需要取得这份卖方补签交易，使用自己保存的 Kind 5/7 重新验签并计算下一轮候选。
4. 同一连接上的下一轮 Kind 5 按序排在上一轮 Kind 7 之后。卖方继续返回下一轮 Kind 6，表示卖方接受上一轮递进并继续交付；如果卖方拒绝或断开，买方停止向该卖方签署新付款，保留既有内容与签名证据，并可切换其他卖方。买方先拿到并验证内容才签付款，**买方不发起仲裁**；卖方对已交付但未获认可的付款可按 BitFS 既有 Kind 8/9 仲裁路径主张权利。
5. 内容完成或停止使用该池时，买方从本地最新已签序号和累计金额构造最终 `sequence = 0xffffffff` 的 Kind 12 关池请求，卖方核对本地最新双签状态后回 Kind 13，并由**卖方**向 WOC 广播最终完整关池交易。买方只保存 Kind 13 和完整关池交易，按 txid 观察卖方的广播以确认余款回收；正常购买中买方向 WOC 提交的交易只有 FundingTx。WOC 明确广播成功后可推进卖方关池结果，不等待出块。无法协商关池时保留开池占用与原证据，按远期退款规则处理，不能把本地池内付款误作已经上链。
6. 重连只重放已保存的 exact Kind 5/7/12，不生成不同签名；买方本地状态的 Kind 5/7 必须先验签、验开池绑定、序号和金额，再供下一轮或关池使用。卖方重放 Kind 7 只能复用同一份已保存补签交易，不能重复广播池内候选。BitFS wire Kind 1–13 的格式不因这些应用状态规则而改变。
7. 同一会话在内存中可复用已经验签的开池与历史付款状态，每轮只验证新增付款并检查 seq 恰好加一、累计金额不倒退；进程重启或发现证据不连续时从持久化日志完整重建。新费用池的退款锁使用 UTC 时间，逐块验货无需反复查询 WoC 区块高度；到期退款等确实需要高度的步骤只读取 Coordinator 统一同步的同网络高度快照，高度未同步或网络不匹配时停止该步骤，不由 BitFS 自行查询 WoC。
8. 买方设置每次请求的 Block 数，默认 10，可设 1–16。同一池的一批 Block 共用一轮 Kind 5/6/7；必须逐块验货和可靠暂存，随后才签该批的一次付款。该轮 seq 仅加一，卖方累计金额的增量等于批内所有 Block 价格之和。Seed 单独请求和付款。多个卖家的池可并行，但同一 Seed 的下载计划须原子分配互不重叠的 Block 批次；已认领的块不能重复购买，池关闭后释放其尚未付款的整批认领。批次大小只改变应用调度，不改 BitFS wire 格式。

### 7.3 进度、取消与资金回收

`/msfile/storage` 同时展示进行中的购买任务和已完成文件。任务至少显示 Seed Hash、当前阶段、已验证块数/总块数、已验证字节数、报价范围、当前最高块价、卖家最近速度、受保护未花资金、各池占用、已付卖家金额、矿工费及待回收金额。总数尚未知时显示“未知”，不显示假百分比；完成入库后保留该 Seed 的购买花费记录。

取消时立即停止新块请求，并尝试联系**该文件全部已开池卖家**关池和回收。未开池的专用 UTXO 可解除保护；已开池资金在链上确认回收前继续受保护。卖家联系不上或关池结果未知时，保留该池的证据、金额和到期时间，持续观察并在允许的超时点执行买方退款、按 txid 对账。买方不以“发起仲裁”作为取消回收路径；卖家对已交付内容的既有权利不能因取消而抹掉。界面逐池显示“关池中、待到期、退款中、已回收”，不得将点击取消显示为资金已全部返回。

## 8. BitFS 卖方设置

MSFile 设置增加以下用户配置，所有字段必须有中文说明：

| 字段 | 中文含义 |
| --- | --- |
| `sellerEnabled` | 是否允许当前 Key 作为 BitFS 卖方 |
| `seedPriceSatoshis` | 单个 Seed 的售价（聪） |
| `fullBlockPriceSatoshis` | 一个完整 256 KiB Block 的售价（聪） |
| `quoteLifetimeSeconds` | 报价有效时间（秒） |
| `supportedArbiterPublicKeys` | 卖方接受的仲裁方压缩公钥列表 |
| `maxConcurrentSales` | 当前 Key 同时处理的销售会话上限 |

`sellerEnabled` 是持久化用户意图，不代表运行成功。`sellerRuntimeStatus` 至少包含：

- `disabled`：用户关闭；
- `waiting-unlock`：已开启但 Vault 未解锁；
- `indexing`：正在建立本地 Seed 索引；
- `configuration-error`：价格、仲裁方或依赖配置不完整；
- `ready`：可以匹配请求；
- `selling`：存在进行中的销售；
- `degraded`：Channel、transport 或链上依赖暂时不可用。

## 9. Seed 内存索引

仅在以下条件同时满足时加载：Vault 已解锁、当前 Owner 已确定、MSFile 运行单元已激活、
`sellerEnabled = true`。

索引是 Worker 内存中的有界派生视图：

```text
Map<seedHashHex, {
  fileName,
  mediaType,
  fileSizeBytes,
  blockCount,
  availability
}>
```

`availability` 至少区分 `indexing / available / invalid / missing`。索引从 `meta/` 分页加载，并对候选项执行
第 6 节的可用性检查。它不能成为存储真值，Worker 重启后必须重建。

以下事件必须增量更新或失效索引：页面上传完成、BitFS 购买提交完成、用户删除、校验失败、远程存储
版本变化。Vault 锁定、切 Key、切存储或 MSFile 停用时立即清空；旧世代异步结果不得写入新索引。

## 10. Channel 请求匹配

卖方只处理 `bsv8.hash.request.v1` 的已验证消息：

1. 使用 ChannelProtocol 严格解析、验签、过期检查和去重；
2. 将 `body.hash` 按 Seed Hash 查询内存索引；
3. 未命中或不是 `available` 时保持静默，避免暴露库存；
4. 使用已验证的 `from_public_key` 作为 BitFS 报价绑定的买方公钥；
5. 只接受请求声明且本地支持的 locator；本期通过 `webrtc-sdp` 表示买方接受 SDP 信令连接；
6. 卖方引用已验证请求的 `message_id` 发送 offer，双方完成私密 Inbox 信令和身份关系校验后建立 DataChannel，再发送报价。

Channel 的 Hash 是通用文件 Hash，没有 BitFS 类型字段。Keymaster 只以“是否命中完整 Seed 索引”决定是否响应，
不能响应普通 Block Hash 或任意文件 Hash。

## 11. 浏览器连接准入

销售请求可用的条件是：买方声明的 locator 与卖方支持的连接方式相符。使用 `webrtc-sdp` 时，买方通过 ChannelProtocol 私密 Inbox 接收卖方 offer 并回传 answer；买方不需要发布 libp2p 入站地址。发布需求只表示愿意建立该连接，不表示连接已经成功。

### 11.1 WebSocket

- 生产公网只接受 `/tls/ws` 或规范化后的 `/wss`；
- 明文 `/ws` 只允许 loopback 或明确配置的可信开发环境；
- multiaddr 末尾 PeerId 必须与请求者已验证公钥派生结果一致；
- Noise 认证出的远端身份必须再次一致。

### 11.2 WebRTC Direct

- 必须是完整 `.../webrtc-direct/certhash/<hash>/p2p/<PeerId>` multiaddr；
- 校验 certhash、PeerId、公钥绑定和浏览器运行时能力；
- 禁止把 ChannelProtocol 的 `{kind: "webrtc-sdp"}` 当成 WebRTC Direct；后者是 SDP 信令声明，
  不是 bitcoin-libp2p WebRTC Direct 地址。
- 本期 BitFS 购买不使用该 locator；它是与 SDP 信令 WebRTC 分离的另一种传输方式。

### 11.3 ChannelProtocol SDP WebRTC

- 买方在 `bsv8.hash.request.v1` 中发布 Seed Hash 和 `webrtc-sdp` locator；该公开请求由 ChannelProtocol 验签、过期检查并按 `(from_public_key, message_id)` 去重。
- 卖方只在该已验证 Hash 命中完整可用 Seed 时响应，并在 `bsv8.webrtc.signal.v1` offer 中带回同一 `request_message_id` 与新 `session_id`。
- answer 和后续信令必须由 ChannelProtocol 检查对端身份及请求/会话关系；SDP 连接中的 DataChannel 标签固定为 `bitfs`，承载 go-bitfs exact Artifact 字节。
- `webrtc-sdp` 是愿意接受 SDP WebRTC 信令的能力声明，不是地址，也不能改写成 WebRTC Direct multiaddr。候选连接失败时不影响本地 Seed 可用性。

没有可用 locator 时不启动销售。拨号失败只产生本次连接失败，不得把 Seed 从本地索引删除。

## 12. Vault 锁定规则

当 `sellerEnabled = true` 且 Vault 已解锁时，Coordinator 必须暂停自动锁定计时器；用户手动锁定仍立即有效。

| 场景 | 规定行为 |
| --- | --- |
| 开启卖方模式但 Vault 已锁定 | 不自动解锁，状态为 `waiting-unlock` |
| 开启时已经解锁 | 停止自动锁计时器并启动卖方运行态 |
| 页面长期无操作 | 不自动锁定 |
| 用户手动锁定 | 停止新销售、保存可恢复状态、关闭连接、清索引、清私钥 |
| 关闭卖方模式 | 停止销售，从关闭时刻重新开始正常自动锁计时 |
| Worker 或浏览器重启 | 不恢复明文私钥，必须重新手动解锁 |

手动锁定时，尚未产生付款承诺的操作可以取消；已经交付内容或产生不可逆付款权利的会话必须持久化为
待恢复/对账状态，不能作为普通取消删除。

设置界面必须醒目提示：卖方模式会让 Vault 在本次解锁运行期内保持解锁，但不会自动解锁，也不会让页面、
插件或 Connect App 获得私钥。

## 13. 生命周期和权限

全部请求、索引和销售会话绑定 `storage generation + owner session + active key + runtime instance + request generation`。
私钥只通过 Vault 的受限签名能力使用；业务模块不能读取私钥字节。多 Tab 只共享 Coordinator 的单一卖方运行态，
不得各自监听和重复报价。

## 14. 完成标准

满足以下条件才可把需求状态改为已完成：

1. local 与 remote 能通过统一来源接口被 UI 和 Connect App 使用；
2. `/msfile/storage` 是买入、卖出和页面管理的唯一内容仓库；
3. 卖方只响应命中完整 Seed 索引且 transport 兼容的已验证请求；
4. 自动锁在卖方解锁运行期暂停，手动锁和重启锁定保持有效；
5. 买卖双方所有不可逆动作均具备 persist-before-send、幂等与恢复证据；
6. 锁定、切 Key、切存储、多 Tab、迟到响应和广播未知结果通过集成测试；
7. go-bitfs TypeScript 角色 API、依赖版本和许可证边界已经完成发布审查。
8. 自动报价收集、单块价格门槛、逐卖家最近速度调度、单文件强制下载滑块与多池回收通过端到端验收；`/msfile/storage` 在完成前展示可恢复的任务、进度和真实资金状态。
