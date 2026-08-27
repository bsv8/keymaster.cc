# Keymaster MSFile V1 硬切换施工单

> 状态：KMMF-001/002/003/005/006/007 已实施（含审查修复）；架构 Spike、KMMF-004 与发布验收尚未实施，数据面经 `MsFileTransport` 接缝 fail closed。分项状态见 [README 状态矩阵](./README.md#实施状态矩阵)。
>
> 本施工单只定义 Keymaster 客户端、插件 capability、Connect 方法、价格授权和设置页面；
> 不修改 MSFile Proxy wire/network 协议，也不实现供应商/NAS 服务端。

后续执行已经拆为三个可独立派发和验收的施工单：

1. [001 Remote Signer 与 Window Executor 架构 Spike](../../../施工单/2026-08-26/001-msfile-remote-signer-window-executor-spike.md)：生产 Runtime 的唯一编码前门禁；
2. [002 生产 Runtime 与真实数据面](../../../施工单/2026-08-26/002-msfile-production-runtime.md)：实现 KMMF-004 和本机真实协议 E2E；
3. [003 跨环境互操作与正式发布验收](../../../施工单/2026-08-26/003-msfile-interop-release-acceptance.md)：只阻止正式启用，不阻止 002 编码。

## 1. 施工目标

在不破坏现有 Connect、Storage、AppMsg、Broadcast、P2PKH 和 Vault 行为的前提下，新增：

```text
受信任内部插件
  -> msfile.service
  -> stat / readSeed / readBlock

不受信任 Connect App
  -> Connect session + verified App Identity
  -> msfile.stat / msfile.seed.read / msfile.block.read
  -> App 级 Seed/Block 金额策略
  -> 必要时由 Keymaster 用户确认提额

MSFile 设置
  -> 全局 Seed/Block 最高金额
  -> 供应商配置页面
  -> Connect App 单独金额覆盖
```

所有 Read 最终映射为 `/msfile/1.0.0` 的统一 `ReadRequest`。Seed/Block 区分只负责选择
金额策略和内容校验规则，不进入 wire，也不重新引入文件、blockIndex 或 Acquire 生命周期。

## 2. 已冻结设计

### 2.1 方法命名

内部 capability 使用一个平台对象，避免再造第二套 MSFile runtime。受信任业务插件只消费
`stat/readSeed/readBlock`；设置页使用 control 方法；`plugin-protocol` 只能进入显式的
`connect` gateway：

```ts
export interface MsFileConnectAppContext {
  connectSessionId: string;
  transportOrigin: string;
  ownerPublicKeyHex: string;
  appIdentity: AppIdentitySnapshot;
}

export interface MsFileConnectGateway {
  stat(ctx: MsFileConnectAppContext, input: MsFileStatInput): Promise<MsFileStatResult>;
  readSeed(ctx: MsFileConnectAppContext, input: MsFileReadSeedInput): Promise<MsFileReadResult>;
  readBlock(ctx: MsFileConnectAppContext, input: MsFileReadBlockInput): Promise<MsFileReadResult>;
}

export interface MsFileService {
  status(): MsFileServiceStatus;
  subscribe(listener: () => void): () => void;

  getSettingsSnapshot(): Promise<MsFileSettingsSnapshot>;
  updateGlobalPriceSettings(input: MsFileGlobalPriceSettings): Promise<void>;
  upsertSupplier(input: MsFileSupplierConfig): Promise<void>;
  deleteSupplier(supplierPublicKeyHex: string): Promise<void>;
  probeSupplier(supplierPublicKeyHex: string, signal?: AbortSignal): Promise<MsFileSupplierProbeResult>;
  updateAppPriceOverride(input: MsFileAppPriceOverrideUpdate): Promise<void>;
  clearAppPriceOverride(input: MsFileAppIdentityKey): Promise<void>;

  stat(input: MsFileStatInput): Promise<MsFileStatResult>;
  readSeed(input: MsFileReadSeedInput): Promise<MsFileReadResult>;
  readBlock(input: MsFileReadBlockInput): Promise<MsFileReadResult>;

  readonly connect: MsFileConnectGateway;
}

export const MSFILE_SERVICE_CAPABILITY = "msfile.service";
```

Connect protocol：

```text
msfile.stat
msfile.seed.read
msfile.block.read
```

Connect SDK：

```ts
keymaster.msfileStat(params, options?)
keymaster.msfileReadSeed(params, options?)
keymaster.msfileReadBlock(params, options?)
```

不得提供含义相同的 `msfile.read`、`seed.read`、`block.read` 别名，避免形成两套公开真值。

### 2.2 Read 参数

```ts
export interface MsFileReadSeedInput {
  supplierPublicKeyHex: string;
  seedHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileReadBlockInput {
  supplierPublicKeyHex: string;
  blockHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileSeedReadParams {
  connectSessionId: string;
  supplierPublicKeyHex: string;
  seedHashHex: string;
}

export interface MsFileBlockReadParams {
  connectSessionId: string;
  supplierPublicKeyHex: string;
  blockHashHex: string;
}
```

所有 Read 接口都不得出现：

```text
maxPriceSatoshis
contentKind
fileId
accessId
seedAccessId
blockIndex
```

`supplierPublicKeyHex` 必须保留。Network V1 规定 Stat 广播给全部启用供应商，而 Read 必须按
已认证供应商公钥定向，hash 本身不能承担路由职责。

### 2.3 Stat 参数和结果

```ts
export interface MsFileStatInput {
  seedHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileStatParams {
  connectSessionId: string;
  seedHashHex: string;
}
```

Stat 对所有启用供应商并发，结果按供应商分别返回
`available | absent | discovering | quoted | network-error`。网络错误不得折叠成 `absent`。
Quoted 中四个价格使用规范十进制字符串，
避免 JavaScript `number` 丢失 uint64 精度。

### 2.4 Read 结果

```ts
export interface MsFileReadResult {
  contentHashHex: string;
  content: BinaryField;
}
```

结果不返回成交价。Wire V1 的 `ReadResponse` 本身不携带实际成交价，Keymaster 不得伪造或
推断该字段。返回 App 或插件前必须完成 hash 与尺寸校验。

### 2.5 价格设置

金额是单个内容对象的上限，不是文件总预算、App 累计预算或 session 预算：

```ts
export type MsFileSatoshiAmount = string;

export interface MsFileGlobalPriceSettings {
  seedMaxPriceSatoshis: MsFileSatoshiAmount;
  blockMaxPriceSatoshis: MsFileSatoshiAmount;
}

export interface MsFileAppPriceOverride {
  seedMaxPriceSatoshis?: MsFileSatoshiAmount;
  blockMaxPriceSatoshis?: MsFileSatoshiAmount;
}
```

规范化规则：

- 只接受 `0` 或不带前导零的十进制正整数；
- 范围是 `0..2^64-1`；
- `"0"` 明确表示不限金额；
- App override 字段缺失表示继承全局设置；
- 缺失、空字符串、解析失败和旧数据不得转换为 `"0"`；
- 初次安装在用户尚未明确保存两项全局设置前，Read fail closed；不得用默认 `0` 自动开成不限；
- Stat 不购买内容，因此不受金额设置阻断。

有效额度：

```text
trusted readSeed  -> global.seed
trusted readBlock -> global.block

Connect readSeed  -> app.seed override  ?? global.seed
Connect readBlock -> app.block override ?? global.block
```

App 策略键固定为：

```text
(ownerPublicKeyHex, publisherPublicKeyHex, appId)
```

不使用 origin 作为 App Identity，也不使用 `identityDigestHex` 作为长期策略主键。Origin 仍用于
session transport 绑定；identity digest 仍用于证明当前 session 快照未被替换。这样已签名 App
更新名称或 proof 后不会意外丢失原有额度策略。

### 2.6 超额授权

Connect App 不能提交建议金额。正常流程始终先用有效 App 额度发送 wire Read：

```text
Connect Read
  -> resolve effective App cap
  -> wire Read(content_hash, effective cap)
  -> success: return verified bytes
  -> price_limit_exceeded: open Keymaster approval
```

确认界面只允许用户选择：

1. 拒绝；
2. 输入新额度并仅本次允许；
3. 输入新额度并始终允许该 App 的同类内容到此额度。

“仅本次”只存在于当前 request 内存中，重新发送同一 hash 的更大 request ID，不落库；“始终”
只更新当前 App 的 Seed 或 Block 对应字段，然后重新发送。一次 Connect 调用最多进入一次确认，
重新发送后仍超额则返回稳定错误，禁止无限确认/重试循环。

Wire `price_limit_exceeded` 不报告所需实际价格：

- 对 matching Seed Stat，可以把最近价格范围作为非承诺提示；
- Block Read 没有 seedHash/file/blockIndex 上下文，不保证能显示对应报价；
- 用户输入的是新的最高授权，不是“实际成交价”；
- 不得为了获得报价而向 SDK 增加金额、文件或 blockIndex 参数。

用户拒绝返回现有 `user_rejected`；用户未完成确认、窗口关闭或 session 失效时也不发送提额 Read。

### 2.7 受信任插件边界

内部插件属于受信任代码，直接消费 `msfile.service`，不需要 Connect session、App Identity 或
App 级授权。它仍不能通过方法参数改变价格：`readSeed` 和 `readBlock` 分别读取全局额度。

受信任调用超过全局额度时直接返回 `msfile_price_limit_exceeded`。内部插件若需要更高额度，
由用户进入 MSFile 设置修改全局值；本阶段不为后台插件增加隐式确认弹窗。

### 2.8 明确删除的模型

本施工单不实现：

- 文件级 access/grant/open/release；
- 对某个文件的授权记录；
- `blockIndex`、range 或文件重组 API；
- App 自报 Seed/Block 价格；
- App 访问 libp2p host、PeerId signer、WebRTC、WebSocket 或供应商配置写接口；
- Keymaster 内部 Acquire、quote_id 或 acquisition_id。

## 3. 设置与供应商配置页面

### 3.1 设置入口

`plugin-msfile` 向 `system-settings.registry` 注册一个独立 `MSFile` group，由
`MsFileSettings` 组件在 `/settings/system` 渲染。`plugin-settings` 只负责宿主渲染，不硬编码
MSFile 字段，不再增加重复的 `/settings/msfile` 路由。

页面只在 Vault unlocked 时可编辑，包含三个明确区域：

```text
MSFile
  1. 价格限制
  2. 供应商配置
  3. Connect App 授权
```

### 3.2 全局价格区域

- Seed 单个对象最大金额；
- Block 单个对象最大金额；
- 每项都有显式“不限金额”开关，开启后保存 `"0"`；
- 普通输入框不把空值解释为零；
- 展示单位为 satoshis，并明确“每个 Seed/每个 Block，不是整个文件”；
- 保存只影响之后创建的 Read；已经发送或已经产生不可逆付款承诺的 Read 不被回滚。

### 3.3 供应商配置区域

供应商记录：

```ts
export interface MsFileSupplierConfig {
  name: string;
  supplierPublicKeyHex: string;
  addresses: string[];
  enabled: boolean;
}
```

页面必须支持：

- 列出多个供应商及其 enabled、截断公钥、地址数和当前连接状态；
- 新增供应商；
- 编辑名称、地址顺序和 enabled；
- 删除供应商并二次确认；
- 对单个供应商执行“测试连接”；
- 展示从公钥派生的 PeerId，帮助用户核对 multiaddr；
- 一个供应商配置多个 WebRTC Direct/WSS 地址，按用户保存顺序尝试。

校验规则：

- 公钥必须是 33 字节压缩 secp256k1 公钥的 66 字符小写 hex；
- 每个地址末尾 `/p2p/<peer-id>` 必须与公钥派生 PeerId 一致；
- 只接受 `webrtc-direct`、`tls/ws`，以及开发策略明确允许的 loopback `ws`；
- `/wss` 输入可以接受，但持久化前规范化为 `/tls/ws`；
- WebRTC Direct 必须包含合法 `/certhash`；
- name 只是本地显示值，不进入 wire；
- 编辑时不允许原地更换供应商公钥；身份变化必须新增供应商并删除旧记录。

测试连接只执行：地址拨号、libp2p 身份认证、公钥/PeerId pin 和 `/msfile/1.0.0` 协商，随后关闭
测试 stream。它不发送 Read、不产生购买，也不声称内容可用。

配置变化语义：

- disable/delete：立即关闭该供应商连接，该供应商未终结请求失败；
- 地址变化：关闭旧 connection，下次操作按新地址重拨；
- 单个地址失败：本次操作继续尝试该供应商的下一个配置地址；
- 所有地址失败：本次返回网络错误，不启动永久后台重试；
- 一个供应商失败不影响其他供应商 Stat 结果。

### 3.4 Connect App 授权区域

只显示当前 active owner 下已经调用过 MSFile 的 verified App，以及已有 override 的历史 App。
首次 MSFile 调用只记录脱敏 App 摘要与 `lastSeenAt`，不创建文件许可。

每个 App 展示：

- App name、appId、截断 publisher public key；
- Seed 当前有效额度及“继承/单独设置”状态；
- Block 当前有效额度及“继承/单独设置”状态；
- 编辑两项 override；
- 单独恢复继承或一次清除全部 override。

App name 只用于显示；策略查找始终使用 owner、publisher public key 和 appId。删除 override 后
立即回到全局额度，不写入 `0`。

### 3.5 持久化

新增 `keymaster.msfile` IndexedDB，至少包含：

```text
globalSettings   // singleton，Seed/Block 全局额度
suppliers        // key = supplierPublicKeyHex
appPolicies      // key = ownerPublicKeyHex + publisherPublicKeyHex + appId
appUsage         // 同一稳定 App key 的脱敏展示摘要与 lastSeenAt
```

这些记录不含私钥、付款凭证或内容字节，不写 localStorage。所有写入在 Coordinator
SharedWorker 中串行并使用单事务替换；页面只通过 `msfile.service` 控制方法读写，不直接打开 DB。

## 4. 运行时架构与前置门禁

### 4.1 不能直接照搬 Storage SharedWorker

Storage 的网络 client 可以完整运行在 SharedWorker。MSFile 的 WebRTC Direct 依赖
`RTCPeerConnection`，正式实现前不能假设目标浏览器已把它暴露给 SharedWorker。因此采用：

```text
Coordinator SharedWorker
  - raw private key 唯一持有者
  - MSFile 设置/App 策略真值
  - sessionEpoch 与 active owner 真值
  - 选出一个受信任 Keymaster Window executor
  - 在请求 tab 与 executor 之间路由有界 RPC/ArrayBuffer

唯一 Window executor
  - 一个 js-libp2p host
  - WebRTC Direct + WSS
  - 每供应商一个 active connection
  - 每 connection 一条 Stat stream + 一条按需 Read stream
  - Frame codec、背压、hash/尺寸校验
```

私钥不得从 Worker 发送给 Window。Window 只实现 `bitcoin-libp2p@0.1.0` 的 `TypedSigner` bridge；SDK 独占 non-extractable adapter、Noise/Peer Record payload、PeerId 与签名校验实现。允许的 Coordinator RPC 只有：

- `msfile.executor.identity.sign-noise`：Window 只能提交 lease、epoch 与恰好 32-byte 的 Noise static public key；
- `msfile.executor.identity.sign-peer-record`：Window 只能提交匹配 active key 的 PeerId、空地址数组与单调不减的 uint64 sequence。

Worker 使用 `bitcoin-libp2p` 导出的标准构造函数重建 payload/digest，再以 active business key 返回严格 DER。Window 不得传入任意 message、digest、domain、算法或签名格式，也不保留通用 `sign(data)`/`signDigest` 接口。Worker 在签名前后均复核实际 port/client、lease、sessionEpoch、active owner 与 active public key；SDK adapter 的 `raw` 必须明确抛出 non-extractable 错误。

### 4.2 架构 Gate：生产 Runtime 编码前必须通过

在 `plugin-msfile` 生产 Runtime 实现前建立最小 Spike，逐项证明：

1. 目标 js-libp2p 版本接受不暴露 raw private key 的 secp256k1 remote signer，且实际选择的 service map 在启动、PeerId、Noise handshake 和销毁路径均不读取 `raw`；
2. Noise/PeerId 身份结果与 active business public key 一致；
3. Window 只暴露 SDK `TypedSigner` 的 Noise Static Key 与受限 Signed Peer Record 两种方法；Worker RPC 只接受业务字段并调用 SDK 标准构造，不会退化为跨业务的无约束通用签名 oracle；
4. Window executor 丢失后，Coordinator 能让下一窗口取得新 lease；旧请求明确失败，不悬挂；
5. Vault lock、active key 切换和 sessionEpoch 变化会拒绝旧 signer 请求并关闭旧 host；
6. 两个 tab 竞争时最多一个 executor 获得当前 epoch lease；
7. 16 MiB Seed 和并发 256 KiB Block 通过 transferable/背压传递，内存有明确上限；
8. Chromium Window executor 与相邻 Go supplier 完成真实 Noise authenticated handshake，证明 remote DER signer 跨语言互操作。

本 Gate 必须用 Chromium 的真实 SharedWorker/多页面测试证明，不能只用 mock。Firefox、Safari、公共
CA WSS 与指定目标 NAS 属于 KMMF-008 发布验收；缺少这些外部环境只阻止默认启用，不阻止
KMMF-004 生产 Runtime 编码。

实验版本先使用 MSFile lab 已审计基线，不在第一次施工中顺手升级：

```text
libp2p                 3.3.9
@libp2p/webrtc         6.0.30
@libp2p/websockets     10.1.20
@libp2p/crypto         5.1.23
@libp2p/peer-id        6.0.15
@chainsafe/libp2p-noise 17.0.0
@chainsafe/libp2p-yamux 8.0.1
```

不得把 lab 中已退出 V1 的 relay-signaled `webRTC()`、Circuit Relay 或 TURN 路径带入正式包。
相邻仓库的能力与互操作报告可能独立推进，进入每个分单前必须重新核对最新 commit 和自动化能力；
不得继续复制过期的“I01-only”状态，也不得把“依赖可构建”写成“WebRTC Direct/WSS 已跨语言验收”。

若 remote signer 失败，不得通过把 raw private key 复制到 Window、伪造 `raw` 字节或用 type assertion 隐藏实际读取来绕过 Gate。该门禁失败时停止正式运行时施工，只能重新裁决“对锁定依赖做最小、可审计的 non-extractable identity patch”或“重选 host 所在运行时”。

### 4.3 简单恢复原则

- executor/connection/stream 失败时让当前业务请求失败；
- 后续新请求再重建，不维护无限后台重试状态机；
- stream Reset 可以在同一业务调用内重建一次，仍失败则返回；
- connection 重建形成新的 request ID 作用域；
- lock/key switch 不恢复旧请求；调用方在新 session ready 后自行重发；
- 已经不可逆的供应商付款不能因断线假装撤销。

## 5. 包与边界

### 5.1 新包 `packages/plugin-msfile`

预计文件：

```text
packages/plugin-msfile/
  package.json
  src/manifest.ts
  src/msfileService.ts
  src/msfileServiceProxy.ts
  src/msfileDb.ts
  src/msfileSettings.ts
  src/supplierConfig.ts
  src/libp2pHost.ts
  src/supplierConnection.ts
  src/statStream.ts
  src/readStream.ts
  src/frameCodec.ts
  src/contentValidation.ts
  src/MsFileSettings.tsx
  src/styles.css
  src/*.test.ts(x)
```

职责：

- 提供 `msfile.service`；
- 管理 Window executor 与 Coordinator RPC proxy；
- 实现 libp2p 客户端、双长驻 stream 和 Frame codec；
- 实现全局/App 价格策略；
- 注册 MSFile system settings group；
- 不接触外部 `MessageEvent`，不自行信任 Connect App params。

### 5.2 `packages/contracts`

新增 `src/msfile.ts` 并从 `index.ts`、`connectPublic.ts` 导出；修改：

- `protocol.ts`：方法名、params/result map、公开错误码；
- `sessionCoordinator.ts`：MSFile control/data/executor/signer RPC、状态事件；
- 必要的 manifest capability 常量。

金额在 contract/DB/Connect JSON 中使用 string，只在 Frame codec 边界转换为 `bigint`/CBOR
uint64。内容使用现有 `BinaryField`，跨 Window/Worker 使用 transferable `ArrayBuffer`。

### 5.3 `packages/plugin-protocol`

- optional consume `msfile.service`；缺失时只让 `msfile.*` fail closed；
- 对三个公开方法执行 strict shape 校验；
- 所有方法必须要求有效 session；
- 所有方法必须要求 session 中的 verified App Identity；
- App context 只能由持久 session snapshot 与 `MessageEvent.origin` 构造；
- 调用 MSFile 的 Connect gateway，由 gateway 解析 App 策略与确认；
- SDK 传入 `maxPriceSatoshis` 或任意未知字段必须返回 `invalid_request`；
- logout/session revoke 时取消该 session 未决 MSFile 请求和确认。

内部 trusted API 与 Connect gateway 可以由同一个 capability 对象实现，但 contract 中必须使用
不同入口，禁止 `plugin-protocol` 调用 trusted Read 绕过 App 策略。

### 5.4 `packages/connect`

- 增加三个强类型 wrapper；
- 从 public barrel 导出 Stat/Read 类型；
- 文档明确调用方只能选择 supplier/hash，不能指定价格；
- `AbortSignal` 取消等待并发送现有 Connect cancel；
- 不导出供应商写配置、App policy 写配置或 libp2p 原语。

### 5.5 `apps/web`

- `pluginCatalog.ts` 增加 `plugin-msfile`，保持唯一 catalog 真值；
- `bootstrapPlugins.ts` 只负责 assembly，不硬编码业务表单；
- Coordinator client/worker 增加 MSFile RPC、topic、executor lease 与 signer handler；
- lock、active key switch、worker restart 时统一销毁 MSFile runtime；
- Session Window 增加价格确认视图；确认视图不得由 Connect App HTML 覆盖或伪装。

## 6. 错误模型

新增稳定公开错误码至少包括：

```text
msfile_not_configured
msfile_unavailable
msfile_identity_required
msfile_supplier_not_found
msfile_supplier_disabled
msfile_invalid_hash
msfile_price_limit_exceeded
msfile_integrity_error
msfile_transport_error
msfile_protocol_error
```

规则：

- Connect 用户拒绝沿用 `user_rejected`；
- supplier wire error code 保留为内部诊断，不把任意远端字符串直接变成公开 code；
- transport timeout/EOF/Reset 不转换为 `absent` 或 `content_not_found`；
- 错误 message 使用英文且不得包含私钥、完整内容、付款原文、完整内部地址历史或堆栈；
- `price_limit_exceeded` 不附会一个不存在的实际价格。

## 7. 分阶段工单

### KMMF-000：架构 Spike 与依赖冻结

工作：

- 按 [001 架构 Spike 施工单](../../../施工单/2026-08-26/001-msfile-remote-signer-window-executor-spike.md) 实现最小 remote signer/Window executor；
- 完成第 4.2 节架构门禁；
- 用真实 Chromium 证明 signer、lease、epoch 失效和 transferable；
- 将允许依赖锁到 `plugin-msfile/package.json`，排除 relay/circuit 包。

验收：架构 Gate 全通过并留下浏览器版本、PeerId/public key、signer/lease 和内存证据；否则不进入
KMMF-004。公共 WSS、Firefox、Safari 和目标 NAS 不属于本门禁。

### KMMF-001：Contracts 与公开协议基线

工作：

- 新增 `msfile.ts` 类型、常量、service capability；
- 增加三个 Connect 方法与 SDK public exports；
- 固化 hash/public key/金额规范化纯函数接口；
- 固化 Stat union、Read binary result 和错误码。

测试：contracts typecheck；method params/result inference；Read params 的 unknown field 反向用例。

### KMMF-002：Frame codec 与内容校验

工作：

- 实现最短 uvarint、deterministic CBOR fixed array、raw attachment 增量 decoder；
- 实现 Stat/Read 两类 request ID 计数器；
- 实现 response 乱序关联、stale 淘汰、ReadCancelled；
- Seed/Block 分别执行协议规定的尺寸/hash 校验。

必须覆盖：Header 上限、uvarint 溢出/非最短、attachment 截断、额外字段、uint64 边界、错误
UTF-8、乱序响应、同 hash 覆盖、响应开始后的竞态。

### KMMF-003：DB、设置 service 与供应商页面

工作：

- 建立 `keymaster.msfile` schema；
- 实现全局金额、supplier CRUD、App override CRUD；
- 实现供应商 pure normalizer 与 PeerId pin 校验；
- 实现 `/settings/system` 的 MSFile group 和第 3 节全部页面交互；
- 保存/删除/disable 通过 generation 使旧连接失效。

验收：reload 后设置恢复；空金额不变成 0；供应商公钥/address 不匹配无法保存；测试连接不发送
Read；插件 disable/teardown 后设置项与订阅释放。

### KMMF-004：libp2p host 与多供应商连接

执行真值：[002 生产 Runtime 与真实数据面施工单](../../../施工单/2026-08-26/002-msfile-production-runtime.md)。
它只依赖 KMMF-000 架构 Spike PASS，不依赖 KMMF-008 的外部发布环境。

工作：

- 实现唯一 Window executor、Worker signer 和 epoch lease；
- 装配 WebRTC Direct、WebSocket/WSS、Noise、Yamux；
- 每供应商只保留一个 active connection；
- 每 connection 一条 Stat stream、一条按需 Read stream；
- Stat 广播、Read 定向、地址顺序 fallback、背压和资源上限。

验收：身份 pin、错误 PeerId/certhash/TLS、双 stream 隔离、4/8 并发、lock/key switch、executor
丢失和重建全部通过。

### KMMF-005：Trusted `msfile.service`

工作：

- 暴露 `stat/readSeed/readBlock`；
- 从全局设置解析对应 wire cap；
- trusted Read 超额直接失败；
- 使用 transferable 返回验证后的 `BinaryField`；
- AbortSignal 终止本地等待并按协议安全结束/覆盖请求。

验收：内部测试插件无需 session/App Identity；无法从 params 注入价格；Seed/Block 走不同金额与
校验；缺设置、lock、disabled supplier 均 fail closed。

### KMMF-006：Connect gateway 与价格确认

工作：

- session/App Identity 门禁；
- 按稳定 App key 解析 override/global；
- 首次使用写入脱敏 appUsage；
- 处理一次性的超额确认和“始终允许”持久化；
- session revoke/窗口关闭/epoch 改变时取消未决确认。

验收：伪造 origin/App 字段不能换策略；两个 App/两个 owner 完全隔离；Seed 提额不修改 Block；
once 不落库；always reload 后仍生效；拒绝时不发送提额 Read。

### KMMF-007：Protocol 与 Connect SDK

工作：

- `PROTOCOL_METHODS`、validation、dispatch、params/result maps；
- 三个 SDK wrapper、类型导出、SDK 文档和单测；
- Connect cancel 与二进制 result 接线。

验收：无 identity session 被拒绝但其他 Connect 方法不回归；`maxPriceSatoshis`、fileId、
blockIndex 等额外字段全部拒绝；SDK API surface snapshot 只有三个 MSFile 方法。

### KMMF-008：集成、互操作与正式文档

执行真值：[003 跨环境互操作与正式发布验收施工单](../../../施工单/2026-08-26/003-msfile-interop-release-acceptance.md)。
本项是 `defaultEnabled: true` 的发布门禁，不是 KMMF-004 的编码前门禁。

工作：

- fake supplier 完整协议集成测试；
- 与目标 Go/NAS 供应商跑 WebRTC Direct 与 WSS E2E；
- Chrome/Firefox/Safari 验收；
- 更新 Keymaster Connect 正式协议文档与 SDK docs；
- 在实现完成前保留 proposal 标记，完成后再迁移为正式文档。

验收：第 9 节完成定义全部满足。

## 8. 必测矩阵

### 8.1 设置与身份

- 全局 Seed/Block 独立保存，`0` 只能由显式不限操作产生；
- App override 的 inherit、finite、unlimited 三态；
- publisher 相同但 appId 不同、appId 相同但 publisher 不同、owner 不同；
- App proof digest 更新但稳定 App key 相同；
- supplier public key、PeerId、address 三重不匹配；
- disable/delete/address replacement 对旧连接的失效。

### 8.2 授权

- App 不能通过 params 设置金额；
- 有限额度内直接成功；
- 全局/App `0` 发送 wire 0；
- 超额拒绝、本次有限提额、本次不限、always 有限、always 不限；
- 第二次仍超额不循环确认；
- Seed 授权不污染 Block，反之亦然；
- trusted plugin 只使用 global，不读取 App override。

### 8.3 协议与内容

- available/absent/discovering/quoted/network-error 聚合；
- Seed 最大 16 MiB、32 字节整除、已知 file size 时精确 Seed 长度；
- Block 最大 256 KiB；
- 所有内容 SHA-256 必须等于请求 hash；
- 本 API 不掌握 blockIndex/file size 时，不声称校验最后块精确长度；
- ReadCancelled 正常终态；connection/stream 错误与业务 absent 分离。

### 8.4 生命周期

- reload、多个 Keymaster tab、executor tab 关闭；
- Vault lock/unlock、active key switch、Worker restart；
- supplier config 与 price setting 在 Read 中途变化；
- session logout/revoke 与确认界面并发；
- plugin disable/enable；
- 所有失败后新请求可以粗暴重建继续，不留下永远 pending 的 Promise。

## 9. 完成定义

- 内部插件能通过 `msfile.service` 完成 Stat、Seed Read、Block Read；
- Connect SDK 只暴露 `msfileStat/msfileReadSeed/msfileReadBlock`，Read 无金额参数；
- Connect 三个方法全部经过 session、verified App Identity 和 App 级金额策略；
- `/settings/system` 有可用的 MSFile 页面，包含全局金额、供应商配置和 App 授权；
- 多供应商 Stat 并发、按公钥 Read 定向符合 Network V1；
- wire Frame、双 stream、覆盖取消、hash/尺寸校验符合 Wire Messages V1；
- raw private key 从未离开 Coordinator SharedWorker；
- WebRTC Direct 与 WSS 在目标浏览器和目标 Go/NAS 上通过真实互操作；
- lock/key switch/配置删除后旧 host、连接和未决授权均不可继续使用；
- 全仓 `typecheck`、boundary lint、unit/integration/E2E 通过；
- 日志、DB、Connect result 和错误中没有私钥、内容 attachment、付款原文或未脱敏内部状态。

## 10. 不在本施工单

- MSFile NAS/供应商服务端实现；
- 文件上传、删除、重命名、目录或文件系统挂载；
- 文件级授权、累计预算、订阅或钱包账务审计；
- 实际成交价回传；
- App 选择 transport、地址或连接参数；
- DHT、mDNS、二维码、配对码和自动路由器配置；
- Circuit Relay、relay-signaled WebRTC、TURN 数据路径；
- 自动后台无限重试或跨重启恢复未完成购买；
- 最后一块精确长度校验所需的 file/blockIndex 上下文。
