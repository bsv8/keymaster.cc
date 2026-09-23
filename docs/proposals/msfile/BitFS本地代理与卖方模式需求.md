# BitFS 本地 MSFile 与卖方模式需求

> 状态：未完成，本文是实施前的需求冻结稿，不描述当前已经具备的能力。
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
6. WebSocket/WSS 与 WebRTC Direct 的浏览器 transport 准入检查。

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
- 部分购买内容只有在 Seed、全部 Block 和元数据提交完成后才进入可见列表。

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
- local 缺失时，只有调用方明确选择 local BitFS 来源才进入购买。

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

必须保存报价、开池证据、授权、交付、付款、原始交易、规范 txid、outbox 和结果未知记录。
网络超时重发已保存的 exact bytes，不能重新签名生成另一份报文。内容必须先验证并可靠写入，才允许
推进相应付款。广播结果未知时按 txid/outpoint 对账，不盲目重签或推进状态。

报价发现不是 go-bitfs SDK 的职责。本功能上线前必须冻结 Seed Hash 如何发现卖方、如何接收多个报价、
如何验证与选择报价的应用协议；未完成时 local Stat 只能返回本地结果，不能假装具备公网发现能力。

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
5. 检查 locator 与当前浏览器可用 bitcoin-libp2p transport 的交集；
6. 拨号并完成身份 pin 与 `/bitfs/wire/1.0.0` 协商后，才建立销售会话和发送报价。

Channel 的 Hash 是通用文件 Hash，没有 BitFS 类型字段。Keymaster 只以“是否命中完整 Seed 索引”决定是否响应，
不能响应普通 Block Hash 或任意文件 Hash。

## 11. 浏览器连接准入

销售请求可用的条件是：`对方 locator ∩ 本浏览器可用 transport` 非空，不要求对方同时提供两种连接。

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
