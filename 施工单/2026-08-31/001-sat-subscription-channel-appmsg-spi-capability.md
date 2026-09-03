# 001 SatSubscription、Channel AppMsg 与 SPI 资金能力施工单

> 方案变更（2026-09-02）：本单原计划的独立 `SatSubscriptionLibp2p` adapter
> 已被 [SatSubscription 移除外部适配层与资源闭环返工单](../2026-09-02/002-SatSubscription移除外部适配层与资源闭环返工.md)
> 替代。后续实现以 Keymaster 内部 `packages/plugin-sat-subscription/src/satLibp2pTransport.ts`
> 为准；本单保留产品边界和历史设计，不应再创建独立 adapter 发布层。

> 2026-09-01 审查结论：当前实现尚未通过验收，后续实施以
> [SatSubscription 审查返工单](../2026-09-01/001-sat-subscription-review-rework.md)
> 为优先真值。本单继续保留产品边界、原始业务设计和 S01–S22 验收矩阵；与返工单冲突处以返工单为准。
>
> 状态：核心代码已落地；内部 transport、Go/TS 跨语言互操作和基础自动化已通过；KMSAT-000 正式 release 与 KMSAT-009 真实验收待完成
>
> 目标：Keymaster 使用 `bitcoin-libp2p` 建立多 SSP 供应商、多个订阅、单一默认发布和 SPI 预付费资金管理；内部系统获得完整 SSP trusted capability，外部 Connect App 只继续使用受控的 `appmsg.*` 子消息能力。
>
> 关联项目：`bitcoin-libp2p`、`SatSubscriptionProtocol`、`ChannelProtocol`、`SPI`；
> SSP 网络适配现为 Keymaster `plugin-sat-subscription` 内部模块。

> 历史实施记录（2026-09-01）：KMSAT-000 曾计划由独立项目
> `/home/david/Workspaces/SatSubscriptionLibp2p` 提供网络适配；该方案已由
> 2026-09-02 返工单废弃。当前必要实现已收回 Keymaster 内部模块，SSP 核心仍只
> 负责 Wire，Keymaster 只调用 `bitcoin-libp2p 0.3.0` 的 Stream/uvarint SDK。

当前代码状态：

| 工单 | 当前状态 | 说明 |
|---|---|---|
| KMSAT-000 SSP adapter | 代码已落地 | 内部 `satLibp2pTransport.ts`、uvarint frame、单 writer、双向 request/response 和迁移单测已落地；真实 Supplier 验收待完成 |
| KMSAT-001 Contracts | 已完成 | SharedWorker、Window lane、Sat trusted service 和错误/状态契约已加入 |
| KMSAT-002 Plugin/DB | 已完成 | owner-scoped DB 与 SharedWorker 单 owner 运行时已接入 |
| KMSAT-003 生产传输 | 代码已落地 | `bitcoin-libp2p` host/lane/SSP/SPI transport 已接入；真实 Supplier 验收待完成 |
| KMSAT-004 Trusted SSP | 代码已落地 | 入站 response、Channel 验签解密、落库后 ACK 已接入；真实 Supplier 验收待完成 |
| KMSAT-005 Channel/AppMsg | 代码已落地 | 多 Supplier 去重、冲突和 ACK 原路已修复；真实端到端验收待完成 |
| KMSAT-006 SPI | 代码已落地 | `collectNew`/`retryCollect` 分离并保留完整 Wire；真实链路验收待完成 |
| KMSAT-007 Settings | 代码已落地 | 编辑、启停、订阅同步、Provider 选择、充值预览和 Collect 确认已加入 |
| KMSAT-008 Connect | 兼容代码已完成 | 对外仍只有 `appmsg.*`；文档已补充 Provider 透明性边界 |
| KMSAT-009 真实验收 | 未开始 | S01-S22、正式发布和跨仓证据仍待执行 |

本单设计基线版本：

| npm 包 | 基线版本 | 中文责任 |
|---|---:|---|
| `bitcoin-libp2p` | `0.2.0` | secp256k1 身份、Noise、Yamux、Connection/Stream 与 TypedSigner |
| `sat-subscription-protocol` | `0.1.0` | SSP Wire、请求响应、订阅与精确扣费规则 |
| `bsv8-channel-protocol` | `0.1.0` | 私密 inbox、`bsv8.message.v1`、ACK、签名与加密 |
| `satoshi-payment-interface` | `0.1.0` | SPI Information、Collect 和 `/spi/1.0.0` 适配 |

KMSAT-000 不再产生独立 npm adapter；正式发布对象只剩 Keymaster 与 Go SatSubscription Server。两者仍必须固定 `bitcoin-libp2p 0.3.0` 并完成真实互操作验收。

## 1. 已冻结产品决策

以下是本单硬边界，实施中不得自行改变：

1. SSP 的身份、Noise、Yamux、Connection 和 Stream 使用 `bitcoin-libp2p`，Keymaster 不实现第二套 libp2p 身份或握手。
2. SSP 是预付费消费模型。消费上限就是供应商账户中的 SPI 充值余额，不再增加独立预算协议。
3. Connect App V1 不设置金额上限、累计额度或频率限制；协议固有限制和浏览器安全资源上限仍必须执行。
4. Keymaster 内部 trusted caller 不设置 App 级限制，但同样受供应商余额和协议硬限制约束。
5. 同一 Keymaster owner 下的 App A、App B 在 SSP 供应商侧使用同一个 `remote_public_key`。该值必须等于当前 owner 的压缩 secp256k1 公钥。
6. App 身份和路由不得塞进 SSP 身份层。SSP 身份是 owner；外部 App V1 继续按现有 exact origin 路由，内部插件继续按现有 appId 路由。
7. SSP 原始 Publish、Subscribe、Unsubscribe、SubscriptionsRequest、供应商、余额和扣费信息不得暴露给 Connect App。
8. Connect App 继续使用现有 `appmsg.send/list/get` 与 `appmsg.message_received`，不新增 `satSubscription.*` 对外协议方法。
9. 可以配置多个 SSP 供应商，也可以在多个供应商上建立多个订阅；普通发布只使用一个默认供应商。
10. 默认供应商不可用时普通发布直接失败。V1 不静默切换供应商，不隐藏费用和信任边界变化。
11. 每个供应商都通过 SPI 提供查询余额、充值地址和余额回收。充值使用 Keymaster P2PKH 钱包链上打款；回收使用 SPI Collect。
12. V1 资金操作先支持 Keymaster 已有钱包能力覆盖的 BSV mainnet。测试网后续只跟随已有全局 testnet 设置开放。
13. V1 不把 `sat-subscription` 自动替换成现有 AppMsg active provider。保留 HubMsg，用户在设置中显式选择后才切换。

## 2. 目标架构

```text
Connect App A / B
  -> appmsg.send / list / get / message_received
  -> plugin-protocol（session + exact origin ACL）
  -> plugin-appmsg（现有 seal、verify、local DB）
  -> sat-subscription MessageProvider（一个聚合 provider）
  -> ChannelProtocol bsv8.message.v1 + 私密 inbox
  -> 默认 SSP 供应商 Publish / 多 SSP 供应商 Subscribe
  -> bitcoin-libp2p Noise + Yamux

Settings
  -> Supplier 配置与默认发布选择
  -> SPI Information
  -> p2pkh.service 充值
  -> SPI Collect 回收
```

`sat-subscription` 在 `message.provider.registry` 中只注册为一个 provider。多个 SSP 供应商由该 provider 内部聚合，不能把每个供应商注册成独立 MessageProvider，否则会与现有单 active provider 模型冲突。

## 3. Runtime 所有权与私钥边界

### 3.1 Coordinator SharedWorker

SharedWorker 是以下真值的唯一 owner：

- raw private key；
- active owner、owner epoch 和 Vault lock 状态；
- Supplier 配置、owner 维度的默认发布和接收配置；
- SSP 请求协调、订阅目标、扣费审计和不确定结果；
- ChannelProtocol 私密消息签名、ECDH、加密、解密和验签；
- SPI Information/Collect 请求状态；
- Window executor lease、取消和迟到结果裁决。

ChannelProtocol TypeScript SDK 如果仍要求 raw private key，只能在 SharedWorker/Vault 受信任边界内调用。不得把 raw private key、通用 ECDH 或通用签名能力转发给 Window 或 Connect App。

### 3.2 Window executor

Window executor 只负责浏览器网络执行：

- 当前 owner epoch 唯一的 `bitcoin-libp2p` host；
- 使用受限 TypedSigner bridge 完成 Noise/Peer Record 身份签名；
- 按 Supplier 建立和复用 authenticated Connection；
- SSP 长 Stream 和 SPI 单次 Stream；
- SSP Frame 编解码、单 writer、请求响应关联、背压和超时；
- 把完整 SSP/SPI Wire 作为 transferable 返回 SharedWorker。

Window 不读取业务消息明文，不持久化供应商账户，不解析 App endpoint，不持有 AppMsg/Channel 私钥操作能力。

### 3.3 生命周期

- Vault lock、active key 切换、plugin disable、executor lease 丢失、Window unload：立即关闭 host、所有 Connection/Stream，取消旧 epoch pending。
- 新 epoch 不恢复旧 SSP request；旧结果到达也必须丢弃。
- Supplier generation 改变时关闭该 Supplier 的旧连接，迟到结果不能进入新配置。
- App 页面退出只结束该 Connect session，不影响同 owner 的共享 SSP 连接。

## 4. 工单 KMSAT-000：上游 SSP libp2p 适配 Gate

> 历史方案说明：本节原定的独立 `SatSubscriptionLibp2p` adapter 已被
> 2026-09-02 返工单废弃。当前实现不再发布或依赖该 npm 包；必要的 SSP
> transport 已收回 `plugin-sat-subscription` 内部，并继续以
> `bitcoin-libp2p 0.3.0` 的 Stream/uvarint SDK 为唯一分帧真值。

### 4.1 原责任仓库（历史）

`/home/david/Workspaces/SatSubscriptionLibp2p`

该项目是独立的薄适配器项目，依赖 `sat-subscription-protocol`、
`bitcoin-libp2p` 和 SPI Wire 包。`SatSubscriptionProtocol` 核心仓库不承担
libp2p、分帧或网络发送，也不应被 Keymaster fork。

### 4.2 原交付要求（历史）

参照 SPI `/spi/1.0.0` 适配方式，在独立 adapter 项目提供 Go/TypeScript 薄适配：

```text
SSP_PROTOCOL = /ssp/1.0.0
Frame        = unsigned-varint(payload_length) + 完整 SSP Wire
```

要求：

- 使用 `bitcoin-libp2p` 创建或接收已认证 Connection，不复制 Noise、PeerId 或公钥解析；
- 服务端只从 authenticated Connection 取得 `remote_public_key`，不信任 SSP payload 自报身份；
- 一个 SSP Stream 支持长期双向通信、多个并发 request_id、乱序响应和服务端入站 Publish；
- 每个 Stream 只有一个串行 Frame writer；请求和响应不得交错破坏边界；
- Frame 最大值不得超过 SSP `MaxWireBytes`；长度越界、截断和非规范 varint 立即 reset；
- 入站 Publish 必须走 SSP SDK 规定的双向请求/响应语义，不能把它降格成无响应的自定义 push；
- timeout、Abort、Reset、半关闭、Connection 关闭和 pending 清理都有稳定测试；
- Go server ↔ TypeScript client、TypeScript server ↔ Go client 都完成真实 Noise/Yamux 互操作；
- npm/Go release 固定版本后，Keymaster 只依赖正式 release，不使用长期 `file:` 依赖。

### 4.3 当前 Gate

当前内部 transport 已完成长流单 writer、并发乱序响应、入站 Publish 双向响应、
身份 pin 与迁移单测；Go/TypeScript 真实 Noise/Yamux、供应商 E2E 和 Go Server
正式发布仍按新返工单验收。不得重新创建独立 adapter，也不得在 Keymaster 内 fork
另一份 SSP Wire/分帧实现。

## 5. 工单 KMSAT-001：Contracts 与 provider 能力基线

### 5.1 建议修改范围

- `packages/contracts/src/satSubscription.ts`（新增）
- `packages/contracts/src/messageProvider.ts`
- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/settings.ts`（仅复用/补充必要类型）
- `packages/contracts/src/index.ts`

### 5.2 Supplier 配置

```ts
interface SatSupplierConfigV1 {
  supplierId: string;              // Keymaster 本地稳定编号
  name: string;                    // 设置页显示名称
  supplierPublicKeyHex: string;    // Noise 认证后的供应商公钥 pin
  multiaddrs: string[];            // 按保存顺序尝试的 libp2p 地址
  enabled: boolean;                // 是否允许建立连接和执行操作
}

interface SatOwnerSupplierSettingsV1 {
  ownerPublicKeyHex: string;              // 当前 owner；不由 App 传入
  defaultPublishSupplierId: string | null;// 唯一普通发布供应商
  receiveSupplierIds: string[];           // 需要订阅 owner inbox 的供应商
}
```

Supplier catalog 可以全局保存；默认发布、接收供应商和订阅状态必须按 owner 隔离，因为供应商账户由 `remote_public_key` 区分。

### 5.3 MessageProvider capability

给 provider 增加明确的能力声明，禁止用空结果伪装协议能力：

```ts
interface MessageProviderFeatures {
  remoteHistory: boolean; // 是否支持远端 list/get 历史
  onlineQuery: boolean;   // 是否支持在线状态查询
  deliveryAck: boolean;   // 是否支持传输层之上的可靠接收 ACK
}
```

SatSubscription provider 固定：

```ts
{
  remoteHistory: false,
  onlineQuery: false,
  deliveryAck: true
}
```

`plugin-appmsg` 对 `remoteHistory=false` 的 provider 只使用本地 DB 完成 `list/get`，不调用伪造的远端空 list/get；`checkOnline` 规范返回 `unknown`。

### 5.4 Trusted capability

```ts
interface SatSubscriptionService {
  publish(input: {
    channel: string;               // SSP 精确频道名
    contentJson: Uint8Array;       // 完整合法 JSON UTF-8 原始字节
  }): Promise<{
    requestIdHex: string;          // 本 Stream 请求编号
    chargedAmount: string;         // 精确十进制扣费字符串
  }>;

  subscribe(input: {
    supplierId: string;            // 要修改订阅的供应商
    channel: string;               // 普通频道或 SSP 允许的通配语义
  }): Promise<SatActionResult>;

  unsubscribe(input: {
    supplierId: string;
    channel: string;
  }): Promise<SatActionResult>;

  refreshSubscriptions(input: {
    supplierId: string;
  }): Promise<{
    channels: string[];
    chargedAmount: string;
  }>;

  subscribeEvents(handler: (event: SatIncomingPublish) => void): () => void;
}
```

`publish()` 不接受 `supplierId`，始终读取当前 owner 的默认发布供应商。需要原路发送的 Channel ACK 使用单独的 platform-internal reply 接口，不开放给普通 trusted caller。

### 5.5 验收

- 所有金额字段均为字符串或 `bigint`，没有 `number`/浮点转换；
- App 可见 contracts 中没有 Supplier、SSP channel、SPI balance 或 `chargedAmount`；
- `remote_public_key` 不出现在任何 caller input；
- contracts 的所有英文字段都有中文注释；
- provider feature 的兼容默认值不会破坏现有 HubMsg。

## 6. 工单 KMSAT-002：plugin、DB 与设置状态骨架

### 6.1 建议修改范围

- 新建 `packages/plugin-sat-subscription`
- `packages/runtime/src/pluginOwnership.ts`
- `apps/web/src/pluginCatalog.ts`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.ts`
- `apps/web/src/keymasterSessionCoordinatorClient.ts`

### 6.2 插件能力

新插件至少提供或注册：

```text
sat-subscription.service          # trusted SSP capability
sat-subscription.spi.service      # platform internal SPI 管理
message.provider.registry         # 注册 id=sat-subscription
system-settings.registry          # 供应商、订阅和资金设置页
system-status.registry            # 汇总运行状态
```

### 6.3 本地 DB

新增 owner-aware `keymaster.sat-subscription` DB，至少保存：

- Supplier catalog 与配置 generation；
- 每个 owner 的默认发布 Supplier；
- 每个 owner 的 receive Supplier 集合；
- 每个 Supplier 的本地 desired subscription 集合；
- 最近一次已观察 subscription 集合、时间和来源；
- 有界 SSP 扣费审计：动作、Supplier、channel、`chargedAmount`、结果、时间；
- SPI Information 的有界缓存；
- Collect 幂等 request_id 与未决/终态；
- Channel Deliver/ACK 状态和去重关系中 AppMsg 未覆盖的字段。

禁止：

- 把本地 desired subscription 当作供应商远端真值；
- 持久化 raw private key、ECDH shared secret、AES key 或 App 明文副本；
- 无限增长扣费、网络错误或 Frame 日志；
- 在 active owner 之间复用余额和订阅状态。

### 6.4 状态模型

Supplier 连接状态：

```text
disabled -> connecting -> online
                     \-> degraded
online/degraded -> disconnected
```

订阅状态：

```text
unknown | subscribing | subscribed | unsubscribing | unsubscribed | unknown_result
```

`unknown_result` 表示请求可能已执行但响应丢失。不得自动重复收费操作；用户可显式执行可能收费的 SubscriptionsRequest 同步真值。

### 6.5 验收

- 插件可以独立启停，缺插件时 AppMsg/HubMsg 和其他 Connect 能力不受影响；
- DB 迁移、损坏、旧字段缺失和 owner 切换均 fail closed；
- Settings 未配置 Supplier 时显示结构性离线，不启动后台重试风暴；
- 插件 teardown 后 capability、registry、timer、listener 和 executor 请求全部释放。

## 7. 工单 KMSAT-003：生产 bitcoin-libp2p executor 与多 Supplier 传输

### 7.1 连接模型

- 当前 owner epoch 只有一个 Window `bitcoin-libp2p` host；
- 每个 enabled Supplier 最多一个 authenticated Connection；
- 每个 Supplier 最多一条 SSP 长 Stream；
- SPI 请求复用同一 authenticated Connection，但每次打开独立 `/spi/1.0.0` Stream；
- 地址只允许在同一 `supplierPublicKeyHex` 下按保存顺序 fallback；
- 默认 Supplier 和 receive Supplier 可以重合，不能因此建立重复 Connection。

### 7.2 身份校验

- 连接后调用 `bitcoin-libp2p.authenticateConnection()`；
- authenticated public key 必须等于配置的 `supplierPublicKeyHex`；
- PeerId、multiaddr `/p2p` 部分和 authenticated key 必须一致；
- Supplier 服务端观察到的客户端 `remote_public_key` 必须等于 active owner public key；
- App A/B 并发使用时不得创建 App 维度 libp2p 身份或连接。

### 7.3 SSP Stream

- 使用上游 `/ssp/1.0.0` adapter；
- 多个 request_id 可并发，响应按 request_id 关联；
- 入站 Publish 与响应共享一个串行 writer；
- pending map、writer queue、Frame bytes 和入站速率必须有浏览器安全硬上限；
- 这些硬上限是 DoS/资源保护，不得解释成 App 消费预算；
- Stream/Connection 中断让所有未决调用得到稳定 `unknown_result` 或明确未发送结果；
- 只有能证明 Frame 尚未交给 stream 时才可在同一调用内安全重试；发送边界不确定时禁止自动重试。

### 7.4 重连

- 只做有界指数退避和抖动；
- locked、disabled、无 executor、无地址或身份 pin 失败时不重试；
- identity pin 失败是配置/安全错误，不得 fallback 到另一身份；
- 重连只恢复 Connection/Stream，不重发旧 SSP request，不自动执行 Subscribe 或 SubscriptionsRequest。

### 7.5 验收

- 多 App 并发时 Supplier 服务端只看到一个 owner identity；
- 两个以上 Supplier 可以同时在线并接收入站 Publish；
- 默认 Supplier 切换只影响新普通 Publish；
- lock、key switch、Supplier mutation、executor 接管不会让旧结果写入新 epoch；
- 私钥、Channel 明文、SPI/SSP Wire、充值地址以外的敏感字段不进入日志。

## 8. 工单 KMSAT-004：内部 SSP trusted capability

### 8.1 行为

- `publish()` 只走当前 owner 的 default Supplier；无默认值、未启用、未连接或余额不足时返回稳定错误；
- `subscribe/unsubscribe/refreshSubscriptions` 必须显式指定 Supplier；
- `subscribeEvents` 可以聚合所有 receive Supplier 的入站 Publish，并携带 platform-internal `ingressSupplierId`；
- SSP `charged_amount` 原样保存和返回；禁止浮点格式化；
- 普通 channel 精确匹配、区分大小写，不裁剪、不做 Unicode 归一化；
- SSP SDK 的最大 JSON、channel、subscription 数量和 request_id 数量全部保留。

### 8.2 付费动作规则

- Settings 中启用接收时，由用户显式触发对 `bsv8.inbox.<ownerPublicKeyHex>` 的 Subscribe；
- reconnect 不自动重复 Subscribe；
- `refreshSubscriptions` 可能收费，UI 必须在执行前说明；
- 任何已写入 Stream 但未获得响应的动作记为 `unknown_result`；
- V1 不提供后台余额阈值、自动充值或自动回收。

### 8.3 验收

- trusted plugin 可在默认 Supplier 发布任意合法 SSP channel；
- trusted plugin 可分别管理多个 Supplier 的多个订阅；
- Connect App 无法取得或调用该 capability；
- 同一 Supplier 同一 owner 的重复本地调用不会被 UI 假装成远端幂等；
- 错误能区分配置、连接、身份、协议、余额拒绝和结果未知。

## 9. 工单 KMSAT-005：ChannelProtocol 与 AppMsg provider

### 9.1 AppMsg 封装

`bsv8.message.v1` Deliver 的 `content` 固定为：

```ts
interface KeymasterAppMessageContentV1 {
  version: 1;                 // Keymaster AppMsg 封装版本
  envelopeBase64Url: string;  // SignedAppMsgEnvelopeV1.envelopeBytes
  signatureBase64Url: string; // SignedAppMsgEnvelopeV1.signatureBytes
}
```

不得在 content 外重复加入 sender、recipient、origin、appId、message_id、时间或第二套业务签名字段。

### 9.2 发送流程

```text
appmsg.send
-> protocol session 与 exact origin ACL
-> plugin-appmsg 生成现有 SignedAppMsgEnvelopeV1
-> 包成 KeymasterAppMessageContentV1
-> Channel bsv8.message.v1 Deliver
-> 加密到 bsv8.inbox.<recipientOwnerPublicKeyHex>
-> 默认 Supplier SSP Publish
-> SSP ActionResult success
-> 返回现有 AppMsgSendResult
```

规则：

- Channel 外层 `message_id` 使用 32-byte 随机值的 canonical base64url，并作为 AppMsg provider `messageId`；
- `expires_at_ms - issued_at_ms` 不超过 Channel V1 的 24 小时；
- App 不能传 Channel `message_id`、Supplier、inbox channel、有效期或签名；
- `appmsg.send` 成功只表示 SSP 接受 Publish，不表示收到 ACK或 App 已读；
- Connect 返回类型保持现状，不暴露 `chargedAmount`。

### 9.3 接收流程

```text
任一 receive Supplier 入站 Publish
-> channel 必须精确等于当前 owner inbox
-> Channel decrypt / verify / expiry check
-> protocol 必须为 bsv8.message.v1
-> content 严格解析
-> AppMsg envelope verify / decrypt
-> owner 与 endpoint 交叉校验
-> 本地 DB 幂等持久化
-> 原路 Supplier 发送 Channel ACK
-> appmsg.message_received / appmsg.list
```

必须校验：

- AppMsg sender public key = Channel `from_public_key`；
- AppMsg recipient public key = inbox channel 的 owner key；
- AppMsg sender/recipient endpoint 结构合法；
- 外部 App 只看到 session exact origin 匹配的消息；
- 内部插件只看到其 appId scope；
- 未连接 App 的消息先持久化，再 ACK，之后可通过 `appmsg.list` 获取。

### 9.4 去重、冲突与多 Supplier

- 去重键固定为 `(protocol, from_public_key, message_id)`；
- 同一键相同已签名内容：不重复写 App 业务，只重新返回新 ACK；
- 同一键不同已签名内容：记录冲突并拒绝，不返回成功 ACK；
- 多 Supplier 收到相同 Deliver 时只产生一条 AppMsg 本地记录；
- `insertedAtMs` 使用首次可靠持久化时间，不能被后续重复投递覆盖；
- V1 不做远端历史拉取，AppMsg local DB 是 list/get 真值。

### 9.5 ACK

- ACK 只有在消息成功解密、验签并持久化后发送；
- ACK 不等于已读或业务成功；
- ACK 优先且固定通过 Deliver 的 `ingressSupplierId` 原路 Publish，不使用 App 的默认发布选择；
- 原路 Supplier 不可用或余额不足时记录 ACK 失败，V1 不跨 Supplier fallback；
- ACK 是 Keymaster internal 自动付费操作，不受 App policy 限制；设置页必须说明它会消耗该 Supplier 余额；
- 发送侧收到有效 ACK 后内部状态变为 `acknowledged`；Connect V1 暂不增加 ACK event/status API。

### 9.6 重试

- V1 不自动重发未 ACK Deliver；
- SSP 结果未知时也不自动重发；
- 未来若增加显式 retry，必须复用完全相同的已签名 Channel Deliver 和 message_id、重新生成 inbox salt/nonce，并明确提示会再次收费；
- caller 再次调用 `appmsg.send` 属于新业务消息，仍按现有 `clientMessageId` 规则处理，不能伪装成 Channel retry。

### 9.7 验收

- App A、App B 使用相同 owner 时 Supplier 只看到同一个 `remote_public_key`，但消息仍按 endpoint 隔离；
- App 不能伪造 sender owner、sender origin、Channel from key 或 recipient endpoint；
- App 离线但 Keymaster 在线时，消息可靠落本地 DB 后 ACK；
- AppMsg 双层加密不会让明文进入 Supplier、Window executor、日志或协议结果；
- WebRTC 等现有依赖 AppMsg 的功能在 SatSubscription provider 下完成回归。

## 10. 工单 KMSAT-006：SPI 账户、充值与回收

### 10.1 SPI Information

每个 Supplier 独立调用 `/spi/1.0.0`，展示：

- `currency`：货币名称；
- `network`：链网络；
- `paymentAddress`：供应商充值地址；
- `balance`：SPI 最小单位整数，代码使用 `bigint`，UI 使用十进制字符串；
- `project/project_info`：仅做受控诊断，不假设其中存在统一 SSP 小数余额字段。

SPI Information 的 Supplier authenticated identity 必须与 SSP Supplier pin 相同。

### 10.2 充值

```text
刷新 SPI Information
-> 选择 BSV mainnet currency
-> 输入正整数 satoshis
-> 调用内部 p2pkh.service 生成最终交易预览
-> 用户核对供应商地址、金额、找零和矿工费
-> 用户确认后签名广播
-> 展示 txid/unknown result
-> 用户手动刷新 SPI Information 等待到账
```

要求：

- 充值不是 SPI 请求，不能把余额字段本地直接加上金额；
- 必须复用现有 P2PKH 选币、预览、确认和广播，不实现第二套钱包；
- Settings 不能调用 Connect `p2pkh.transfer`，应使用 trusted `p2pkh.service`；
- SPI/UI 金额先保持 `bigint`；调用现有 `p2pkh.service` 前必须确认金额不大于 `Number.MAX_SAFE_INTEGER`，再在唯一 adapter 边界做无损 `number` 转换并回读校验；
- 广播结果未知时不得自动再发一笔；
- 地址、金额、网络变化后旧预览立即失效。

### 10.3 回收

```text
刷新 SPI Information
-> 选择余额和回收金额
-> 根据当前 owner + currency/network 派生自己的 P2PKH 地址
-> 用户确认
-> newCollectRequest（持久化 request_id）
-> /spi/1.0.0
-> 返回扣款后的最新 Information
```

要求：

- Collect `payment_address` 必须对应 authenticated owner 公钥；
- `amount` 是正 `bigint`，不得超过 Information 中对应余额；
- request_id 与请求内容持久化到终态；响应丢失时只允许使用相同 request_id 和完全相同内容重试；
- request_id 相同但内容变化必须 fail closed；
- 禁用、删除或切换默认 Supplier 不自动 Collect；
- V1 UI 不支持 Keymaster 钱包未覆盖的货币发起充值/回收。

### 10.4 金额边界

- SPI `balance/amount` 是整数最小单位；
- SSP `charged_amount` 是最多 18 位小数的规范字符串；
- 两者不得通过 JS `number`、四舍五入或截断合并；
- Settings 分别展示 SPI 整数余额与最近 SSP 精确扣费；
- Supplier 未通过 `project_info` 定义可验证的统一小数余额时，不显示伪造的“可用 SSP 总余额”。

### 10.5 验收

- 两个 Supplier 的余额、地址、充值和 Collect 完全隔离；
- 当前 owner 切换后不显示或操作旧 owner 账户；
- 充值必须经过真实 P2PKH 预览和确认；
- Collect 丢响应后同 request_id 重试只执行一次扣款；
- 日志和错误不包含 raw transaction 之外的私钥、签名素材或完整 SPI Wire。

## 11. 工单 KMSAT-007：Settings 与运行诊断

### 11.1 页面

通过 `system-settings.registry` 在 `/settings/system` 增加“SatSubscription”区域：

1. Supplier 列表；
2. 新增、编辑、启用、禁用、删除；
3. authenticated identity、地址和连接诊断；
4. 唯一默认发布 Supplier；
5. 每个 Supplier 的“接收 App 消息”开关；
6. 当前 owner inbox channel；
7. 本地 desired subscription 与最近远端 observed subscription；
8. 显式同步远端订阅；
9. SPI Information、充值、回收；
10. 最近 SSP 扣费与 unknown result；
11. AppMsg provider 选择与健康状态。

### 11.2 UX 规则

- 启用接收前说明 Subscribe 可能收费；
- 同步订阅前说明 SubscriptionsRequest 可能收费；
- 自动 ACK 会收费，必须在接收开关旁说明；
- 充值必须展示最终 P2PKH 交易预览；
- 回收必须展示目标 owner 地址、金额、Supplier 和网络；
- 删除 Supplier 前显示尚有 SPI 余额时只警告，不自动回收；
- 设置保存失败必须保留最后有效配置；
- 修改默认 Supplier 只影响新 Publish，不重发 pending；
- 所有字段、状态、费用和错误有中文说明及中文测试。

### 11.3 诊断脱敏

可以显示：Supplier 名称、公钥、PeerId、multiaddr、余额、payment address、channel、扣费字符串、时间和稳定错误码。

不得显示：raw private key、ECDH secret、AES key、Channel/AppMsg 明文、完整密文、签名输入、Connect session token、完整未脱敏内部异常链。

## 12. 工单 KMSAT-008：Connect 兼容与文档

### 12.1 对外协议

不新增 Connect method。必须回归：

```text
appmsg.send
appmsg.list
appmsg.get
appmsg.message_received
```

Connect App 不需要知道当前 active provider 是 HubMsg 还是 SatSubscription，也不能指定 Supplier。

### 12.2 App Identity

- V1 继续使用 session exact origin 作为外部 AppMsg endpoint；
- 已验证 `AppIdentityProofV1` 继续绑定 session，但不改变本期 AppMsg wire 路由；
- 同 origin 多 App 需要独立路由时另开 V2 设计，不能在本单中半迁移成 `(publisherPublicKeyHex, appId)`；
- App requirements 不是 SSP 额度或权限声明，V1 不增加 `sat-subscription` requirement。

### 12.3 SDK 与文档

- `@keymaster/connect` API 形状保持兼容；
- Connect 文档说明 AppMsg 可以由不同 provider 承载，但不泄漏 Supplier 配置；
- 说明 `appmsg.send` 返回不是送达/已读证明；
- 说明 V1 支持 `text/plain`、`text/markdown` 的现有范围，不借本单扩张任意 JSON public API；
- 更新安全文档：owner 身份共享、App endpoint 隔离、双层加密和本地持久化后 ACK。

## 13. 工单 KMSAT-009：跨仓真实验收与发布

### 13.1 正式夹具

使用相邻仓库正式实现，不允许 Keymaster fake transport 替代：

- `bitcoin-libp2p`：正式 TypeScript host/TypedSigner；
- `SatSubscriptionProtocol`：SSP Wire、请求响应和订阅规则核心；
- `plugin-sat-subscription`：内部 `/ssp/1.0.0` transport；只调用 `bitcoin-libp2p 0.3.0` SDK；
- `ChannelProtocol`：正式 TypeScript SDK和共用 fixture；
- `SPI`：正式 `/spi/1.0.0` client；
- 一个支持两个独立 Supplier identity 的本机 Go 测试服务；
- 两个 Keymaster owner、至少两个 Connect origin。

### 13.2 必测矩阵

| 编号 | 场景 | 通过条件 |
|---|---|---|
| S01 | SSP Go/TS 互操作 | `/ssp/1.0.0` 双向 Frame、并发和乱序通过 |
| S02 | 相同 owner 多 App | Supplier 只观察到一个相同 `remote_public_key` |
| S03 | 多 Supplier 连接 | 两个 Supplier 同时在线，identity pin 正确 |
| S04 | 默认发布 | 普通 AppMsg 只从唯一默认 Supplier 发布 |
| S05 | 默认失败 | 默认 Supplier 不可用时不自动切换、不额外扣费 |
| S06 | 多订阅接收 | owner inbox 可在多个 Supplier 建立订阅并接收 |
| S07 | App ACL | A/B endpoint 消息互不可见，伪造 sender/recipient 被拒绝 |
| S08 | 离线 App | Keymaster 在线、App 离线时先持久化后 ACK，恢复后 list 可见 |
| S09 | ACK 原路 | ACK 从 ingress Supplier 返回，发送侧状态正确 |
| S10 | 多 Supplier 去重 | 相同 Deliver 只产生一条 AppMsg 记录 |
| S11 | 冲突 | 同 key 不同签名内容拒绝且不 ACK |
| S12 | 无远端历史 | list/get 只读本地 DB，不伪造 SSP history |
| S13 | SSP 结果未知 | 断流后不自动重发、不发生隐藏二次扣费 |
| S14 | SPI Information | 两个 Supplier、两个 owner 的余额严格隔离 |
| S15 | 真实充值 | P2PKH 预览/确认/广播后 Supplier 余额最终增加 |
| S16 | Collect 幂等 | 响应丢失后同 request_id 重试只回收一次 |
| S17 | 金额精度 | 18 位 SSP 小数与 SPI bigint 全链路无浮点 |
| S18 | 生命周期 | lock/key switch/executor takeover/config mutation 使旧结果无效 |
| S19 | App 无权访问 SSP | Connect 方法表和 runtime 均无原始 SSP/SPI 入口 |
| S20 | HubMsg 回归 | 未选择 SatSubscription 时现有 HubMsg/AppMsg 行为不变 |
| S21 | WebRTC 回归 | 依赖 AppMsg 的现有 WebRTC 信令可通过 SatSubscription provider 工作 |
| S22 | 敏感数据 | 私钥、ECDH/AES key、App 明文不进入 Window、Supplier、日志和 result |

### 13.3 验收命令

Keymaster 至少执行：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/plugin-sat-subscription/src
pnpm exec vitest run packages/plugin-appmsg/src packages/plugin-protocol/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm exec vitest run packages/connect/src
pnpm exec playwright test <SatSubscription real-provider E2E>
pnpm docs:connect:build
pnpm build
pnpm test
```

相邻仓库同时执行各自正式验收：

```text
bitcoin-libp2p:          TypeScript/Go tests 与 browser worker tests
SatSubscriptionProtocol: go test -race ./...、npm test、跨语言 integration
ChannelProtocol:         Go/TypeScript tests 与共用 fixture
SPI:                     go test -race ./...、npm test、libp2p integration
```

若全仓存在无关基线失败，必须记录失败文件、复现命令和与本单无关的证据；S01-S22 不得因此跳过。

## 14. 实施顺序与 Gate

```text
KMSAT-000 Keymaster 内部 Sat SSP transport
  -> KMSAT-001 contracts/provider features
  -> KMSAT-002 plugin/DB/settings skeleton
  -> KMSAT-003 production executor/transport
  -> KMSAT-004 trusted SSP capability
  -> KMSAT-005 Channel/AppMsg provider
  -> KMSAT-006 SPI funds
  -> KMSAT-007 Settings/diagnostics
  -> KMSAT-008 Connect/docs compatibility
  -> KMSAT-009 cross-repo acceptance/release
```

允许 KMSAT-001/002 的纯类型、纯状态机和 fake codec 单测并行，但 KMSAT-003 之后的 PASS 必须依赖正式上游 adapter。不得以 mock Supplier 作为最终 Gate。

## 15. 明确不做

- Connect App 原始 SSP Publish/Subscribe/Unsubscribe；
- Connect App Supplier 选择、余额查询、充值或 Collect；
- App 金额预算、累计上限、频率限制或 policy UI；
- 自动充值、低余额自动打款、自动回收；
- 默认 Supplier 故障自动切换；
- SSP 离线队列、远端历史消息或在线状态查询；
- 未 ACK Deliver 的自动付费重试；
- Channel ACK 解释为已读或业务完成；
- App Identity 路由硬切换；
- 任意 JSON/Binary AppMsg Connect API 扩张；
- 跨 Supplier federation、复制或订阅自动同步；
- 前向安全、一次性密钥或 Channel 新协议版本；
- BTC 等 Keymaster 当前钱包未覆盖资产的充值产品化；
- 修改 SSP、SPI 或 Channel 核心 Wire；
- 在 Keymaster 内复制相邻协议 SDK。

## 16. 完成定义

只有同时满足以下条件，才能说“Keymaster 已建立 SatSubscription 能力”：

1. `/ssp/1.0.0` 正式上游 adapter 完成 Go/TypeScript 互操作；
2. Keymaster 使用 `bitcoin-libp2p` 正式生产 host 连接至少两个真实 Supplier；
3. trusted `sat-subscription.service` 完成多 Supplier、多订阅和单默认发布；
4. Connect App 不接触 SSP，但现有 `appmsg.*` 通过 ChannelProtocol + SSP 完成真实收发；
5. 同 owner 多 App 在 Supplier 侧使用相同 `remote_public_key`，App endpoint ACL 仍严格隔离；
6. 消息先可靠写本地 DB 再 ACK，多 Supplier 去重与冲突检测通过；
7. Settings 可查询 SPI、真实充值和幂等 Collect，金额全程无浮点；
8. 默认 Supplier 失败、响应未知、lock/key switch 和 executor 接管均不产生隐藏重发或旧结果污染；
9. HubMsg、AppMsg、WebRTC 和其他 Connect 能力无回归；
10. S01-S22 全部 PASS，并提交真实跨仓证据、固定依赖版本和可重复验收命令。
