# BitFS 本地 MSFile 与卖方模式施工单

> 状态：施工中（K1–K3 已完成，K4/K6 因上游纯函数视图缺失而 fail closed）。本文服务于一次性实施；稳定需求见
> [BitFS 本地 MSFile 与卖方模式需求](./BitFS本地代理与卖方模式需求.md)。
>
> 本施工单不授权修改 `go-bitfs`、`ChannelProtocol` 或 `MSFile-Proxy-Protocol` 仓库；跨仓库变更应分别立项。

## 1. 施工原则

1. 先冻结跨仓库协议和 SDK/应用职责边界，再修改 Keymaster；许可证文档不作为本单阻断项。
2. 先契约、存储和恢复状态，再接 UI。
3. local 不走 `/msfile/1.0.0`；remote 不绕过 MSFile transport。
4. 所有新增字段必须有中文注释，所有设置必须有中文界面说明。
5. 不迁移或复制 `/msfile/storage` 内容；失败时不得破坏现有上传、下载和远程 MSFile 读取。

## 2. Gate 0：开工前阻断项

### G0.1 TypeScript SDK 能力

本项已按 `go-bitfs/docs/施工单/2026-09-22/002-Go-TypeScript纯函数边界硬切换施工单.md`
完成实现，目标边界不再是 SDK Workflow/checkpoint/restore，而是：

- TypeScript 与 Go 共用 wire、角色、交易和无效证据 fixture；
- SDK 提供受限 Signer、显式 Facts、content 算价/验证、buyer/seller/arbiter 纯步骤函数和稳定错误码；
- 证据包是可序列化的普通数据，SDK 不持有跨步骤进度；
- SDK 不读取时钟、不访问存储、不广播交易、不拥有网络生命周期；
- Keymaster 自己拥有状态机、journal、outbox、恢复、重试、广播与链上对账。

开工条件：`go-bitfs` 硬切换后的联合测试通过，Keymaster 能够直接消费新的
`content`、`steps`、`evidence`、`pool` 公开面。开发期可继续使用 `file:` 依赖。

### G0.2 依赖版本

`go-bitfs` TypeScript 当前依赖 `@bsv/sdk 2.0.5`、`keymaster-multisig-pool 4.0.0`，Keymaster 当前版本不同。
开发期允许两套版本在 bundle 中隔离存在，不作为开工阻断。但必须保留以下回归门禁：

- go-bitfs 共享 fixture 的交易原文和 Signer digest 不得漂移；
- Keymaster 生产 Worker bundle 能正常构建，不得将两套类型对象交叉传递；
- 所有跨边界数据只使用原始字节、基础类型和 Keymaster 自有结构。

### G0.3 许可证

项目所有者已明确本施工单不把许可证文档作为开发或验收阻断项。本节仅保留决策记录，
不再产生施工前置条件。

### G0.4 报价发现

冻结 `Seed Hash → 卖方发现 → 多报价接收 → 验签 → 选择` 流程。Channel Hash 请求可以作为需求广播，
但必须明确报价如何返回、重试、去重和绑定请求者，不能把 transport locator 当作报价。

### G0.5 WebRTC 口径

确认本期只接受 bitcoin-libp2p `webrtc-direct` multiaddr。Channel 的 `webrtc-sdp` 不算兼容能力；如需支持，
应先在 ChannelProtocol/bitcoin-libp2p 侧形成独立协议和互操作证据。

## 3. 预计改造单元

| 单元 | 施工职责 |
| --- | --- |
| `packages/contracts/src/msfile.ts` | local/remote 来源、卖方设置、运行状态、带 Seed 上下文的 Block 读取契约 |
| `packages/contracts/src/channel.ts` | 如协议冻结允许，暴露已验证 Hash 请求订阅所需的最小能力；不下放 raw 私钥或 Channel provider |
| `packages/plugin-msfile/src/storage/` | 复用现有 Seed/Block/meta 布局，增加 Worker 可用的索引读取与完整性结果 |
| `packages/plugin-msfile/src/msfileService.ts` | 来源聚合、local 优先读取、single-flight、价格与取消语义 |
| `packages/plugin-msfile/src/coordinator.ts` | 导出 Worker-safe 的 local BitFS 与卖方运行单元 |
| 新增 `packages/plugin-msfile/src/bitfs/` | buyer/seller 编排、journal、outbox、restore、错误映射；不放 React |
| `packages/plugin-msfile/src/MsFileSettings.tsx` | 卖方开关、价格、仲裁方、并发及安全提示 |
| `packages/plugin-msfile/src/MsFileBucketPage.tsx` | 只展示销售可用性/状态；继续复用现有存储操作 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 唯一卖方运行态、Seed 内存索引、Channel 匹配、Vault 自动锁抑制、世代撤销 |
| Window P2P executor | bitcoin-libp2p WS/WSS、WebRTC Direct 拨号、身份 pin 和 BitFS stream；不把私钥交给页面插件 |
| P2PKH/节点适配层 | FundingTx、显式区块高度、广播、txid/outpoint 对账 |
| `docs/集成测试/覆盖矩阵.yaml` | 增加 local 买方、卖方、锁定、恢复和 transport 的验收项 |

最终文件名可以按现有模块边界调整，但不得把 React、libp2p host、存储 Provider 和 BitFS 状态机混入同一单元。

## 4. 阶段 A：契约硬切换

1. 定义 `sourceId` 与 `sourceKind`，remote 才要求 `supplierPublicKeyHex + addresses`。
2. 将 Block 读取上下文扩展为 `sourceId + seedHashHex + blockHashHex`。
3. 增加卖方设置与 `sellerRuntimeStatus`，全部字段带中文注释。
4. 明确 Connect 公共契约是否暴露 local 来源；默认允许使用，但继续执行 App 金额策略和授权。
5. 删除任何通过假公钥、`local://` multiaddr 或虚假 MSFile Frame 表示 local 的方案。

门禁：类型检查、契约测试和旧 remote supplier 行为全部通过；不存在无中文说明的新字段。

## 5. 阶段 B：local 内容来源

1. 用 OwnerFileStore 打开当前 Owner 的 `msfiles/` 根，不向业务暴露 Provider。
2. 实现 local Stat：分页读元数据，校验 Seed 结构与 Block 存在性。
3. 实现 local Seed/Block 读取和 Hash/长度校验。
4. 为同一内容建立按 session/generation 绑定的 single-flight。
5. 上传、购买提交、删除和完整性失败发布索引失效事件。

门禁：页面上传的文件无需复制即可经统一 MSFile API 读取；损坏或缺块内容不得报告 available。

## 6. 阶段 C：BitFS 买方

1. 接入 go-bitfs TypeScript buyer 纯步骤函数，不自行重写协议密码学。
2. 建立受限 Vault Signer 适配器；签名输入和角色绑定由 SDK 验证。
3. 建立应用自有状态机与 journal/outbox，按 RefundTemplateTxID、PaymentAuthorizationID、
   txid 与购买会话 ID 索引 exact bytes、plain evidence 和应用 checkpoint。
4. 对接报价发现、FundingTx、区块高度、广播和结果未知对账。
5. Seed 与 Block 验证后写入现有 `/msfile/storage`；元数据最后提交。
6. 将 SDK 稳定错误映射为 MSFile 稳定错误，不向 UI 暴露内部交易或证据字节。

门禁：崩溃点覆盖“保存前、保存后发送前、发送后未收到结果、广播结果未知、内容保存失败”；恢复后不重复购买或付款。

## 7. 阶段 D：卖方设置与 Seed 索引

1. 在 MSFile 设置页增加卖方开关、价格、报价期限、仲裁方和并发上限。
2. 开启时显示“自动锁暂停”的明确安全提示；开关不触发自动解锁。
3. Coordinator 在已解锁且配置完整时分页构建 Seed 内存索引。
4. 只把完整候选标为 available；索引是派生缓存，Worker 重启后重建。
5. 上传、买入、删除、损坏、存储版本变化做增量更新或定向失效。
6. 多 Tab 观察同一个运行状态，不重复扫描和重复监听。

门禁：10,000 个 Seed 的分页加载、取消、切 Key 和迟到结果均有有界内存与确定行为；具体性能预算在实现前写入测试配置。

## 8. 阶段 E：Channel 匹配和 transport

1. 只消费 ChannelProtocol 产生的 VerifiedHashRequest，不解析未经验证字段。
2. 按 `(from_public_key, message_id)` 去重并遵守过期时间。
3. 仅在 `body.hash` 命中 available Seed 时继续；未命中保持静默。
4. 解析 locator 白名单：公网 WSS、受控 WS、完整 WebRTC Direct；拒绝其它 transport、Circuit Relay 和伪装地址。
5. 从已验证公钥派生 PeerId，与 multiaddr 和 Noise 认证身份三方一致。
6. 协商 `/bitfs/wire/1.0.0` 后创建卖方会话；连接失败不改变本地 Seed 可用性。

门禁：WebSocket/WSS、WebRTC Direct 各有至少一组浏览器与正式对端互操作证据；`webrtc-sdp` 被明确拒绝为 WebRTC Direct。

## 9. 阶段 F：BitFS 卖方与收款

1. 用 go-bitfs seller 纯步骤函数、已验证请求者公钥和本地设置创建绑定买方的报价。
2. 从同一 `/msfile/storage` 读取 Seed/Block，交付前逐项验证。
3. 每个出站 Artifact、plain evidence 与应用 checkpoint 先持久化再发送。
4. 同一池、授权和销售轮次串行；重复 exact 请求返回第一次的确定结果。
5. 付款交易先保存 raw 与 txid，再广播；未知结果进入对账。
6. 连接断开后不开始新的付款承诺，但不丢弃已形成的收款权利。

门禁：正常购买、重复请求、乱序、连接中断、付款超时、买方不付款及后续仲裁证据准备均有测试。

## 10. 阶段 G：Vault 生命周期

1. 自动锁控制权只在 Coordinator；页面不能单独暂停自动锁。
2. `sellerEnabled && unlocked` 时暂停自动锁计时器。
3. 关闭卖方模式后从关闭时刻重新计时，不沿用旧空闲时间立即锁定。
4. 手动锁定执行：停止接单 → 禁止新承诺 → 保存恢复状态 → 关闭连接 → 清 Seed 索引 → 清私钥。
5. 锁定、切 Key、切存储、运行单元停用均推进 generation，拒绝迟到结果。
6. Worker/浏览器重启后状态为 waiting-unlock，不恢复明文私钥。

门禁：自动锁不触发、手动锁立即生效、关闭卖方后自动锁恢复、多 Tab 手动锁一致、重启必须重解锁。

## 11. 数据迁移与回滚

- 现有 `msfiles/seeds`、`storage`、`meta` 不迁移；
- 新设置采用独立 schema 版本，缺失 `sellerEnabled` 必须解释为 `false`；
- 新 journal 使用独立 storage purpose，不和现有 MSFile app usage、设置或内容混写；
- 回滚可以停用 local BitFS 与卖方运行单元，但不能删除已买入内容、exact 协议证据或结果未知交易；
- 若契约硬切换无法兼容，应在同一发布内更新全部内部调用方，不长期保留双接口。

## 12. 验收矩阵

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| L01 | 页面上传后 local Stat | 不复制内容，返回 available |
| L02 | local 读取 Seed/Block | 路径准确，Hash 和长度验证通过 |
| L03 | 缺块/损坏块 | 不返回内容，撤销 available |
| B01 | local 缺失后买入 | 只购买一次，最终出现在 `/msfile/storage` |
| B02 | 并发读取同一 Hash | single-flight，无重复付款 |
| B03 | 广播超时 | 以 txid 对账，不盲目重签 |
| S01 | 卖方关闭 | 不建索引、不响应需求 |
| S02 | 卖方开启但锁定 | 不自动解锁，状态 waiting-unlock |
| S03 | 卖方开启并解锁 | 索引完成后 ready，自动锁暂停 |
| S04 | Channel Hash 未命中 | 静默，不泄露库存 |
| S05 | Hash 命中但无兼容 locator | 不报价、不创建销售会话 |
| S06 | WSS locator | PeerId/公钥/Noise 一致后可销售 |
| S07 | WebRTC Direct locator | certhash 与身份校验后可销售 |
| S08 | `webrtc-sdp` locator | 不当作 WebRTC Direct 使用 |
| S09 | 手动锁定 | 立即停止新销售、清索引和私钥，可恢复证据保留 |
| S10 | 关闭卖方开关 | 停止销售并从当前时刻恢复自动锁计时 |
| S11 | 切 Key/切存储 | 旧请求和迟到结果不能进入新会话 |
| S12 | 多 Tab | 只有一个 Coordinator 卖方实例和一次报价 |
| R01 | Worker 重启 | 必须重新解锁，从持久证据和内容存储恢复 |
| R02 | 销售中断恢复 | 不重复交付、签名、收款或覆盖 exact bytes |

## 13. 发布门禁

以下条件全部满足才能默认开放卖方开关：

- Gate 0 全部关闭；
- 单元、契约、边界、集成和真实浏览器互操作测试通过；
- 生产构建不包含第二套私钥、存储 Provider 或未经审查的 Node-only 依赖；
- 设置页中文说明、安全提示和运行状态完整；
- 覆盖矩阵记录目标环境证据；
- 手动锁定和异常恢复经过发布审查。

## 14. 施工进度记录

### 2026-09-22：阶段 A/B/D 与阶段 E 接线、BitFS stream 通道

已完成并验证：

- 阶段 A：`sourceId/sourceKind`、`seedHashHex` 读取上下文、卖方设置与
  `sellerRuntimeStatus`、Connect/Coordinator 解析全部切换；
- 阶段 B：`local-bitfs` 来源直接读取 `/msfile/storage`，Stat 校验元数据、Seed
  Hash、长度、块数与全部 Block 存在性；读取失败撤销可用性并映射稳定错误码；
  同一内容 local 读取有 session 级 single-flight；
- 阶段 D：卖方设置 schema v2、设置页字段与中文运行状态、`BitfsSeedIndex` 分页
  索引与 Worker 唯一卖方运行态；
- 阶段 E（接线部分）：Coordinator 消费已验证 `bsv8.hash.request.v1`，按
  `(from_public_key, message_id)` 去重与过期，命中完整 Seed 且 locator 通过
  WSS/WS/WebRTC Direct 白名单后才建立会话；PeerId 只从已验证公钥派生；
- Window lane 新增 `/bitfs/wire/1.0.0` 拨号、严格分帧收发与世代关闭；
- `BitfsSellerSessionManager` 提供 persist-before-send 会话边界、容量上限、
  空闲超时与迟到帧丢弃；协议端口未就绪时状态为 `degraded` 且不对外报价。

验证命令：`pnpm test:types`、`pnpm test`（245 个测试文件）、`pnpm build` 通过。

当前剩余：

- `go-bitfs` 纯函数边界已在上游工作区完成实现并有联合测试记录；Keymaster 需要把
  `bitfs/sdk.ts` 从已删除的 `BuyerWorkflow`/`SellerWorkflow` 迁移到纯步骤函数。
- 阶段 F 生产协议端口尚未实现；当前仍使用 unavailable 端口，因此不会对外报价。
- journal 和交易 outbox 已有基础实现，但尚未存储完整的买卖会话状态、plain evidence、
  入库提交阶段和恢复索引。
- BitFS 广播/对账类已实现并有单元测试，但尚未接到 Worker 的生产广播、WoC txid 查询、
  区块高度和启动恢复。
- 阶段 C 买方仍被 G0.4 报价发现协议阻断；local Stat 在本地缺失时仍只返回 absent，
  不会自动发起购买。
- 开发期允许 `file:` 依赖、版本隔离和不以许可证文档为阻断；仍需用共享 fixture、
  Worker bundle 和端到端交易原文测试防止依赖行为分叉。

## 15. 2026-09-23 后续 Keymaster 施工步骤

以下除报价发现协议冻结外，均属于 Keymaster 仓库内的剩余工作。

### K1：迁移 go-bitfs 纯函数端口

1. 删除 Keymaster 对 `BuyerWorkflow`、`SellerWorkflow` 和 SDK checkpoint/restore 的依赖。
2. `bitfs/sdk.ts` 只封装受限 Vault Signer、显式 Facts、纯步骤函数和稳定错误映射。
3. 跨 SDK 边界只传递 exact bytes、plain evidence 和基础类型，不保存 SDK 实例。
4. 运行 Keymaster 类型、单元、构建与 Worker 边界门禁。

### K2：应用状态机与持久化

1. 为 buyer/seller 定义 Keymaster 自有的可枚举协议阶段，每个字段带中文说明。
2. journal 增加 schema version、会话 ID、Owner/Key/generation、双方公钥、Seed Hash、
   exact 报文索引、plain evidence、交易 txid、时限/高度与内容入库阶段。
3. 一切出站 Artifact 和交易都先写入并回读校验，再发送或广播。
4. 恢复时从原始证据全量重验；不恢复 SDK 对象，不重签，不生成新字节。
5. 使用 CAS 或等价串行化手段防止同池、同授权和同销售轮次并发覆盖。

### K3：生产广播、链上事实与对账

1. 在 Coordinator 增加通用 BitFS raw transaction 广播端口，仍由 Worker 拥有唯一物理广播出口。
2. 对接 WoC 或等价节点的 txid 查询、mempool/已确认状态和明确区块高度。
3. Worker 启动时扫描 `result-unknown`；先按 txid 对账，只在确定未派发或明确允许时
   重放已持久化的 exact transaction。
4. 买卖状态只由链上/内存池事实推进，不以 SDK 函数返回或广播 HTTP 请求完成为业务完成。

### K4：卖方协议端口

1. 用纯步骤函数实现 Kind 1 报价、Kind 2/3 预签、Kind 4 验资、Kind 5/6 交付、
   Kind 7 收款、关池与 Kind 8 仲裁证据准备。
2. 交付前从同一 `/msfile/storage` 重读 Seed/Block，执行 Hash、长度、序号、容量和价格全量校验。
3. 付款/关池交易先进 outbox，再调用 K3；只有对账确认后才推进池证据。
4. 用生产实现替换 `createUnavailableBitfsSellerProtocolPort()`；未就绪、锁定或恢复失败时继续 fail closed。
5. 覆盖重复请求、乱序、断线、不付款、收款广播未知和重启恢复。

### K5：报价发现协议冻结

当前路径无法闭环：Keymaster 的 Hash 请求公共入口只发布 `webrtc-sdp`，卖方只接受
WS/WSS/WebRTC Direct locator，且浏览器买方没有 WebRTC Direct 入站监听地址。

本期默认冻结为“买方主动拨卖方”：

1. 买方发布绑定 Seed Hash 和请求者的需求；
2. 卖方返回已签名报价通知，其中携带可拨卖方 locator 或可解析的 rendezvous 引用；
3. 买方验签、去重、收集多报价并选择；
4. 买方主动拨号，在 Noise/PeerId/公钥一致后建立 `/bitfs/wire/1.0.0`；
5. 首个 BitFS 报文重新绑定需求 ID、Seed Hash、报价与双方身份。

如不采用此方案，必须另行实现 bitcoin-libp2p 浏览器 WebRTC Direct listen、certhash 地址发布
与真实浏览器入站互操作，不允许继续用 `webrtc-sdp` 伪装成 WebRTC Direct。

### K6：买方状态机与内容入库

1. local Stat 为 absent 且调用方明确选择 local BitFS 时，才创建按 Seed Hash single-flight 的购买会话。
2. 执行需求发布、多报价验签/去重/选择、开池预签、FundingTx 构建与广播。
3. FundingTx 对账确认后交付 Kind 4，再按批请求 Seed/Block。
4. 验证 Kind 6 的 payload、Seed 归属、价格、序号和池容量后才签 Kind 7。
5. 内容按“Block → Seed → 元数据”提交；中途失败不得报告 available，重启后可确定继续或清理。
6. 支持正常关池、到期退款、仲裁取回和它们的广播未知恢复。

### K7：Vault 生命周期与最终验收

1. 手动锁定按“禁止新准入 → 持久化不可逆证据 → 关闭连接 → 清索引/私钥”执行。
2. Worker 重启后不自动解锁；解锁后先恢复与对账，再开放新买卖会话。
3. 切 Key、切存储、关闭卖方和运行单元停用均推进 generation，拒绝迟到结果。
4. 补齐每个 persist-before-send 崩溃点、重复/乱序报文、广播未知、多 Tab、10,000 Seed、
   WSS/WebRTC Direct 真实浏览器互操作与最终 Worker bundle 门禁。

### 实施顺序

```text
K1 纯函数端口迁移
  → K2 状态机/journal
  → K3 广播与链上对账
  → K4 卖方协议端口
  → K5 报价发现冻结
  → K6 买方状态机
  → K7 生命周期与最终验收
```

K1–K4 不依赖报价发现决策，可立即在 Keymaster 内实施；K5 是完整买方闭环的唯一剩余
跨仓库协议决策。

## 16. 2026-09-23 实施结果与阻断

### 已完成

- K1：已删除 `BuyerWorkflow`/`SellerWorkflow` 依赖，改用纯步骤函数、显式
  `PureFunctionFacts` 和受限 Vault `Signer`。
- K2：已实现 Keymaster 自有买卖阶段、会话身份/generation、revision CAS、
  exact evidence 独立存储、按授权 ID 分批命名与恢复扫描。
- K3：已接入 Worker 唯一交易 outbox/广播器；WoC 增加明确区块高度、
  txid 观测、outpoint spender 和 raw transaction 查询；启动恢复只先对账，
  HTTP 2xx 不再被当作业务完成。
- K4（可安全实施部分）：已实现 Kind 1 会话建立、Kind 2/3 先持久化
  再发送及确定重放、Kind 4 验资、Kind 5/6 交付边界、Kind 7 收款与
  outbox；生产内容解析端口仍故障关闭。
- K6（入库原语）：已实现购入内容的 Seed/Block 全量验证，并按
  `Block → Seed → meta` 提交；损坏内容不会写入 meta。

已验证：BitFS、MSFile 入库与 WoC 定向测试共 91 项通过，`pnpm typecheck`
通过。

### 必须另行授权的跨仓阻断

1. **go-bitfs 内容请求视图**：公开 API 不能从 exact Kind 5 返回经全量
   验证的 `PaymentAuthorizationID + 有序 content hashes`。Keymaster 因此不能安全
   选取卖方 payload，也不能为买方多批证据建立稳定索引。需上游新增
   纯检查函数，不得在 Keymaster 复制私有 CBOR 字段位置。
2. **报价发现协议**：Channel Hash 请求只能携带 `webrtc-sdp`，卖方端只
   允许 WS/WSS/WebRTC Direct，且浏览器买方无 WebRTC Direct 入站地址。需在
   ChannelProtocol/bitcoin-libp2p 完成 K5 所述的“卖方签名报价 locator，
   买方主动拨号”协议，或另行实现浏览器 Direct listen。
3. **FundingTx 构建**：Keymaster 尚无 BitFS 专用的 UTXO 选币/找零端口。
   在该资金端口与上述两项闭环前，K6 生产买方不得对外宣称 ready。

上述阻断均超出本施工单对其他仓库的授权范围；Keymaster 当前保持 fail closed，
不会发出无法完整验证的报价、交付或付款。
