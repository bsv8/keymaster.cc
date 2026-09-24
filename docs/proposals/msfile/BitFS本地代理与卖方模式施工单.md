# BitFS 本地 MSFile 与卖方模式施工单

> 状态：施工中（K1–K3 已完成；K4 卖方 Kind 1–7 主流程、K5 ChannelProtocol 需求与 WebRTC 信令已接通；K6 买方购买、分批验收付款、文件入库、Kind 12/13 关池回收、取消与到期退款恢复已接入；买方设置、单文件最高价滑块、未完成任务视图、解锁恢复和已付款 Block 速度样本已接入。当前已实现同 Seed 多卖家共享 Block 归属、分池预算和有界并发；尚未做静态验证或真实浏览器互操作）。本文服务于一次性实施；稳定需求见
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

本期按 ChannelProtocol 的 Hash 请求与 WebRTC SDP/ICE 协议实施：Hash 请求发布需求，私密信令关联卖方 offer，BitFS DataChannel 传报价与后续 Artifact。报价本身仍须由 go-bitfs 验签；locator 不能当作报价。

### G0.5 WebRTC 口径

按项目方最新决定，本期使用 `/home/david/Workspaces/ChannelProtocol` 已定义的
`bsv8.hash.request.v1` 与 `bsv8.webrtc.signal.v1` 完成需求发布和 WebRTC SDP/ICE 会合。
`webrtc-sdp` 是独立 locator，不得解释成 bitcoin-libp2p `webrtc-direct` multiaddr；
WebRTC DataChannel 建立后承载 go-bitfs 的精确 Artifact 字节。只处理 ChannelProtocol
生成的 `VerifiedHashRequest`，offer/answer/ICE 必须通过其 Inbox 验签和关系校验。

## 3. 预计改造单元

| 单元 | 施工职责 |
| --- | --- |
| `packages/contracts/src/msfile.ts` | local/remote 来源、卖方设置、运行状态、带 Seed 上下文的 Block 读取契约 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 发布/接收已验证 Hash 请求与 Inbox 信令；只向 BitFS 转交验证后的关系和原始 Artifact |
| `packages/plugin-msfile/src/storage/` | 复用现有 Seed/Block/meta 布局，增加 Worker 可用的索引读取与完整性结果 |
| `packages/plugin-msfile/src/msfileService.ts` | 来源聚合、local 优先读取、single-flight、价格与取消语义 |
| `packages/plugin-msfile/src/coordinator.ts` | 导出 Worker-safe 的 local BitFS 与卖方运行单元 |
| 新增 `packages/plugin-msfile/src/bitfs/` | buyer/seller 编排、journal、outbox、restore、错误映射；不放 React |
| `packages/plugin-msfile/src/MsFileSettings.tsx` | 卖方开关、价格、仲裁方、并发及安全提示 |
| `packages/plugin-msfile/src/MsFileBucketPage.tsx` | 只展示销售可用性/状态；继续复用现有存储操作 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 唯一卖方运行态、Seed 内存索引、Channel 匹配、Vault 自动锁抑制、世代撤销 |
| Window P2P executor | WS/WSS 或 ChannelProtocol SDP WebRTC DataChannel 承载 BitFS wire；不把私钥交给页面插件 |
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
4. 只接受已签名 Hash 请求声明的受支持 locator；本期必须支持 `webrtc-sdp`，不能将它改写成 multiaddr。
5. WebRTC 信令只关联同一 `request_message_id`、`session_id` 和已验签 Inbox 对端；SDP/ICE 字段由 ChannelProtocol 校验。
6. ChannelProtocol WebRTC offer/answer 关系校验通过且 `bitfs` DataChannel 打开后创建卖方会话；DataChannel 内逐条解析 go-bitfs Artifact，连接失败不改变本地 Seed 可用性。

门禁：WebRTC offer/answer/ICE 与 BitFS DataChannel 各有至少一组浏览器互操作证据；`webrtc-sdp` 不得伪装成 WebRTC Direct multiaddr。

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
| S07 | `webrtc-sdp` locator | 通过 ChannelProtocol 私信 offer/answer/ICE 建立 DataChannel 后可销售 |
| S08 | offer/answer/ICE 关联 | 错误的请求编号、会话编号或信封身份不得进入 BitFS 会话 |
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
  ChannelProtocol 已验签请求及 WebRTC 信令关系校验后才建立会话；
- Window lane 使用 ChannelProtocol SDP WebRTC 建立 `bitfs` DataChannel，严格解析 go-bitfs Artifact 并执行世代关闭；
- `BitfsSellerSessionManager` 提供 persist-before-send 会话边界、容量上限、
  空闲超时与迟到帧丢弃；协议端口未就绪时状态为 `degraded` 且不对外报价。

验证命令：`pnpm test:types`、`pnpm test`（245 个测试文件）、`pnpm build` 通过。

当时记录的剩余（后续进展见 §16–17）：

- `go-bitfs` 纯函数边界已在上游工作区完成实现并有联合测试记录；Keymaster 需要把
  `bitfs/sdk.ts` 从已删除的 `BuyerWorkflow`/`SellerWorkflow` 迁移到纯步骤函数。
- 阶段 F 生产协议端口尚未实现；当前仍使用 unavailable 端口，因此不会对外报价。
- journal 和交易 outbox 已有基础实现，但尚未存储完整的买卖会话状态、plain evidence、
  入库提交阶段和恢复索引。
- BitFS 广播/对账类已实现并有单元测试，但尚未接到 Worker 的生产广播、WoC txid 查询、
  区块高度和启动恢复。
- 阶段 C 买方当时尚未实现；当前已由 §16–17 接入需求发布和报价接收，不代表购买闭环完成。
- 开发期允许 `file:` 依赖、版本隔离和不以许可证文档为阻断；仍需用共享 fixture、
  Worker bundle 和端到端交易原文测试防止依赖行为分叉。

## 15. 2026-09-23 后续 Keymaster 施工步骤

以下属于 Keymaster 仓库内的剩余工作；报价发现使用 ChannelProtocol 的既定协议。

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

### K5：报价发现协议接线与验收

本期采用 ChannelProtocol 规定的 WebRTC SDP 会合，而不是要求浏览器提供
bitcoin-libp2p WebRTC Direct 入站 multiaddr。Channel Hash 请求负责广播需求，
私密 WebRTC 信令负责 offer/answer/ICE，DataChannel 负责承载 BitFS Artifact。

冻结为“买方发布需求、卖家主动连接买家”：

1. 买方发布带 `webrtc-sdp` locator 的已签名 Hash 请求，保存真实 `message_id`、Seed Hash、买方身份与期限；
2. 卖家只响应命中本地完整 Seed 的 `VerifiedHashRequest`，发送引用该请求的已签名 WebRTC offer；
3. 双方通过 `bsv8.webrtc.signal.v1` 完成 answer/ICE 交换，再在 DataChannel 上传输 go-bitfs 精确 Artifact；
4. 买方验签、去重、统计报价，按单块最高价决定是否开始下载；没有合格报价时继续等待。

### K6：买方状态机与内容入库

1. “通过 Seed 获取文件”发现 local absent 时创建按 Key + Seed Hash single-flight 的需求任务；此时只发需求、收报价，不动资金。
2. 合格单块报价出现或用户按文件强制下载后，先对普通余额 UTXO 聚合拆分并保护，再执行开池预签、FundingTx 构建与广播。
3. FundingTx 对账确认后交付 Kind 4，再按批请求 Seed/Block。
4. 验证 Kind 6 的 payload、Seed 归属、价格、序号和池容量后才签 Kind 7。
5. 内容按“Block → Seed → 元数据”提交；中途失败不得报告 available，重启后可确定继续或清理。
6. 对放弃的卖家逐池关池、回收；取消时联系全部已开池卖家，离线卖家保留待超时退款证据，所有广播未知按 txid 恢复；买方不以仲裁作为回收路径。

### K7：Vault 生命周期与最终验收

1. 手动锁定按“禁止新准入 → 持久化不可逆证据 → 关闭连接 → 清索引/私钥”执行。
2. Worker 重启后不自动解锁；解锁后先恢复与对账，再开放新买卖会话。
3. 切 Key、切存储、关闭卖方和运行单元停用均推进 generation，拒绝迟到结果。
4. 补齐每个 persist-before-send 崩溃点、重复/乱序报文、广播未知、多 Tab、10,000 Seed、
   ChannelProtocol SDP WebRTC/DataChannel 真实浏览器互操作与最终 Worker bundle 门禁。

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

K5 已按 ChannelProtocol 冻结并接入需求发布、报价接收及摘要展示；它不再是跨仓库协议决策阻断。卖方 Kind 5 内容视图已由 go-bitfs v0.3.1 提供并接入。单卖家手动购买入口已接通，完整购买仍需完成关池回收、恢复和真实浏览器互操作。

## 16. 2026-09-23 实施结果与阻断

### 已完成

- K1：已删除 `BuyerWorkflow`/`SellerWorkflow` 依赖，改用纯步骤函数、显式
  `PureFunctionFacts` 和受限 Vault `Signer`。
- K2：已实现 Keymaster 自有买卖阶段、会话身份/generation、revision CAS、
  exact evidence 独立存储、按授权 ID 分批命名与恢复扫描。
- K3：已接入 Worker 唯一交易 outbox/广播器；WoC 增加明确区块高度、
  txid 观测、outpoint spender 和 raw transaction 查询；启动恢复只先对账，
  HTTP 2xx 不再被当作业务完成。
- K4：已实现 Kind 1 会话建立、Kind 2/3 先持久化再发送及确定重放、
  Kind 4 验资、Kind 5/6 交付、Kind 7 收款与 outbox；已使用 go-bitfs v0.3.1
  `inspectSellerDeliveryRequest` 验证 exact Kind 5，再从本地存储按授权顺序读取 Seed/Block。
  签发 Kind 6 前仍由 SDK 再次验证 payload、Seed 归属、价格与资金池状态。
- K6（入库原语）：已实现购入内容的 Seed/Block 全量验证，并按
  `Block → Seed → meta` 提交；损坏内容不会写入 meta。
- K6（单卖家买方主流程）：页面可选已验签报价并显示文件大小、内容价估算、
  开池金额和退款锁提示；Worker 使用现有专款账本准备 Kind 2/3 与 FundingTx，
  对账确认后发送 Kind 4，再按序请求 Seed/Block。Kind 6 经过 go-bitfs 验证，
  Kind 7 的签名意图、签名结果和精确报文先落入 journal；观察到与 Kind 5 授权一致的
  卖方池交易后才提交完整文件。开池 FundingTx 仍由既有 outbox 对账。相同 Kind 6
  重复到达时只重发已保存的 Kind 7，不再次签署付款。
- K6（付款后入库恢复）：报价验签后固定文件大小与推荐文件名；如果 Worker 在
  链上付款已核对、但本地 `Block → Seed → meta` 提交期间退出，下一次恢复该 Seed
  购买摘要时会重新校验暂存 Seed/Block 并幂等完成入库，不签名、不广播。买方池交易
  不再由卖方通用 outbox 对账器直接推进阶段，避免把开池交易误认成文件付款或完成。
- K6（开池对账恢复）：重新加载同一 Seed 的买方任务时，对 `funding-unknown` 会话只查
  原 FundingTx 的 txid；观察到后补齐专款账本与 Kind 4 并保留在 journal，未确认时继续
  保留资金占用。此步骤不重播 FundingTx，也不自动恢复 DataChannel。
- 买方 UI 会披露约 30 天退款锁；空文件报价不可购买。Worker 重启后再次查询同一 Seed 时会
  从 journal 恢复购买摘要，不自动广播或重签。买方任务可重新发布 ChannelProtocol Hash
  需求；卖方若能按买方公钥、Seed 和原报价唯一找到未结资金会话，会在新 WebRTC 通道
  重用原会话，买方按 journal 重发原 Kind 2/5/7/12。报价已过期、卖方没有原日志或匹配不唯一时，不能自动续接，资金继续由关池/退款恢复流程保护。

已验证：此前 BitFS、MSFile 入库与 WoC 定向测试共 91 项通过；本次买方 UI、
签名 journal 与 Worker 改动通过 `pnpm typecheck` 和 `pnpm --filter @keymaster/web build`。
本次未运行测试。

### 尚未完成的购买与验收项

1. **买方关池与资金回收**：单卖家及多卖家费用池均通过 Kind 12/13 逐池关池；到期退款、解锁时全量会话扫描及已保存关池/退款交易对账已接入。尚未做静态验证或运行验收。
2. **崩溃恢复与重连**：解锁后扫描买方会话并恢复可处理的开池、关池、退款和本地入库状态；付款后的本地入库可幂等续写。已接入通过新 Hash 需求和新 WebRTC DataChannel 续接唯一匹配的原卖方会话，并按 journal 重放原 Kind 2/5/7/12。若原 Kind 1 已过期、卖方日志缺失或存在多笔同一买卖双方/Seed 的未结池，仍不能自动判定目标；该情况下 UI 保留资金状态并依赖关池/到期退款。
3. **自动/多卖家下载**：自动购买设置、单块价上限、强制价滑块、最近已付款 Block 速度样本、跨 Seed 任务并发上限，以及同 Seed 多池预算、Block 去重和优先级调度已接入代码；尚未做静态验证或运行验收。
4. **真实浏览器互操作**：类型检查和生产构建不能证明 NAT 环境下 SDP WebRTC 建连成功；仍需验证 offer/answer、DataChannel、断线和重连。

go-bitfs v0.3.1 已解除 Kind 5 内容视图阻断，Keymaster 已接入该预检和本地内容读取。ChannelProtocol 的需求发布、SDP/ICE 信令、DataChannel 报价接收和报价摘要页面已接线；买方购买、恢复、共享下载计划和有界多卖家调度已接入代码。真实浏览器互操作与静态验证仍未完成，因此尚不能把 BitFS 购买标记为完整可用。

## 17. Keymaster 仓库内剩余施工设计（2026-09-23）

本节记录本仓库剩余工作。go-bitfs v0.3.1 Kind 5 内容视图已由卖方本地内容解析端口接入；ChannelProtocol Hash 请求及 SDP/ICE 信令已接入 Worker 与现有文件获取页面。买方购买、关池回收、解锁恢复扫描、唯一匹配会话续接及多卖家共享调度已接入代码；完整验收仍待完成。

### 17.1 F1：BitFS 专用 FundingTx 端口

先新增“单文件专用资金”步骤，作为开始下载的第一步：

1. Worker 按 `当前 Key + Seed Hash` 建资金账本。收到合格单块报价或用户强制下载之前，需求与报价任务不能拆分或保护 UTXO。
2. 从余额服务读取可用普通 UTXO，按 MSFile 自有规则把多个输入聚合、拆为若干回到**当前 Key 地址**的专用输出；拆分笔数与卖家数无关，不派生私钥或地址。拆分交易先持久化 exact raw/txid 和输入占用，再广播、对账；识别实际输出后逐个登记到受保护 outpoint provider。恢复时在保护视图就绪前禁止普通余额选币，避免拆分已入链、保护尚未重建的窗口。
3. 首次拆分依据该文件下一段预计需要购买的内容，缺钱时再拆；每次追加目标为下一段预计金额的 120%，多出的 20% 是余量而非已消费。所有金额、手续费和可用余额用整数聪计算；余额不足时暂停任务并保留已开池的恢复责任。
4. 专用 UTXO 状态至少区分“拆分待确认、可供开池、已被池占用、回收待确认、已解除保护”。同一 UTXO 的占用必须跨 Tab 原子化；拆分或回收结果未知时只查原 txid，不重新构造交易。未开池资金可解除保护；池内资金须等关池或到期退款事实确认后才重新可用。

门禁：多输入聚合与多输出拆分、重启恢复保护、并发开池抢占、拆分广播未知和取消后余额回收均有定向测试。

在此基础上构建开池 FundingTx：

1. 在 Worker 所有的买方编排层定义 `prepareFunding`（准备资金交易）端口：输入为会话 ID、当前 Key、公链网络、已验证的开池输出脚本与金额、费用上限；输出为 exact raw transaction、txid、输入 outpoint、找零金额及脚本、实际手续费。金额使用整数 satoshi，网络与当前 Key 必须一致；输出不得接受页面传入的任意收款脚本。
2. 复用 P2PKH 已有的 UTXO 快照、受保护 outpoint 检查、输入占用和受限 Vault 签名能力。新增 BitFS 适配层只从**本文件已登记的专用 UTXO** 选取资金，并把开池脚本作为**固定第一输出**；找零只回当前 Key 且继续纳入本文件的保护账本。选币后再次核对 UTXO 状态及占用，避免多 Tab 或其它协议交易同时使用同一输入。
3. `prepareFunding` 只构造与占用，不广播。先把 raw、txid、输入列表和输出校验结果持久化；回读并确认开池输出的脚本、金额、索引与 SDK 的 opening evidence 一致，再经既有 BitFS outbox 广播。资金交易结果未知时保留输入占用，按 txid 对账；只有明确未派发且可安全作废时才释放，重试只能重发同一 raw。
4. 用协议 spend 的签名与占用原语时，明确分离“准备”和“广播”；不可调用会自行广播的快捷路径。BitFS outbox 与 P2PKH 输入占用必须共用同一个 canonical txid，恢复时互相对照。费用不收敛、找零尘额、余额不足、输入已被占用、Vault 锁定均返回稳定错误码及中文提示。

门禁：固定开池输出不被找零或手续费改写；并发购买只能占用同一 UTXO 一次；准备后崩溃不广播新交易；广播未知只按同一 txid 恢复。

### 17.2 B1：买方购买会话

1. **本地缺失自动发需求。** “通过 Seed 获取文件”发现 `local-bitfs=absent` 时，Worker 按 `当前 Key + Seed Hash` 复用单一需求任务，发布或复用未过期的 ChannelProtocol Hash 请求，并显示真实 `message_id` 与收到的已验签报价；此阶段不拆资金。页面刷新复用当前 SharedWorker 内的请求。通用 `stat/readSeed/readBlock` 保持只读，远程 MSFile 路径不变。
2. **卖家主动连接报价。** 卖家命中完整 Seed 后，通过 ChannelProtocol 已验签的 WebRTC offer/answer/ICE 建立 DataChannel，并在其中给出签名报价。Worker 持续验签、去重、保存有效报价；过期或身份不符拒绝。无合格块价时任务持续等待，并允许后续卖家进入。
3. **设置与强制下载。** 新增 `buyerAutoPurchaseEnabled`（自动购买开关，旧配置缺省关闭）、`maxFullBlockPriceSatoshis`（自动购买最高完整块价）、`sellerSelectionPriority`（价格优先/最近速度优先）和传输并发上限；不设置单文件总价上限。`/msfile/storage` 每个任务提供独立的“强制下载”滑块：不同报价时范围为有效报价最低至最高，初值为区间的 20% 位置；单报价或同价时范围为报价至报价的 120%，初值为 120%。按整数聪取整。新报价更新滑块范围，不自动提高已选上限。强制上限适用于本文件所有卖家，与速度偏好无关。
4. **触发资金与开池。** 首个符合自动块价的报价出现，或用户按文件强制下载，才调用 F1 聚合拆分并保护资金。Worker 按文件 Block 数和卖家并发上限分配各池 Block 预算；尚未购买 Seed 时，各候选池还预留自己的 Seed 报价，供 Seed 池故障并完成回收后接替。每池开池金额固定为 Seed 预留、该池 Block 预算和两笔池内手续费预留之和；不为每家卖家重复预留整份文件的 Block 预算。FundingTx 证据及 raw 回读后经既有 outbox 广播，按 txid 确认资金事实后才发送 Kind 4。
5. **正式传输与动态调度。** 完整 Block 单价不超过当前上限且有活动 DataChannel 的卖家进入有界并发队列；Worker 持久记录一个 Seed 的唯一付款归属和各 Block 的单池认领。Kind 6 验货、Kind 7 付款及对应链上付款均确认后，才把 Block 标记为全局完成；调度器按价格优先或最近已付款速度优先分配后续 Block，并遵守每池固定 Block 预算。同一 Block 不得从多池重复购买。池预算用尽后停止领取并通过 Kind 12/13 关池回收，释放资金后才为后续卖家准备新池。
6. **入库、进度与取消。** Seed 和全部 Block 验证后调用已有 `Block → Seed → meta` 入库原语，local Stat 返回 `available` 后才显示完成。`/msfile/storage` 合并显示购买任务和完成文件，展示已验证块/字节、当前上限、报价、最近速度、专款、各池占用、已付金额、矿工费和待回收金额；未知总数不显示假百分比。取消立即停止新请求，联系本文件全部已开池卖家关池；联系失败或结果未知保留逐池证据与到期时间，超时后执行买方退款并对账。未开池专款解除保护，池内资金确认回收后才恢复可用。买方不以仲裁作为取消回收路径。

**入站传输接线条件：** 使用 ChannelProtocol 的 Hash 请求和 WebRTC SDP/ICE；实现时将 go-bitfs Artifact 放入受限 WebRTC DataChannel，offer 必须引用已验签需求。不得把 `webrtc-sdp` 当作 WebRTC Direct 地址。上线前仍须完成真实浏览器互操作证据。

门禁：单一 Seed 并发请求只购买一次；报价失效不会扣款；交付损坏不会签付款；入库中断不会报告可用；重启后不重复开池或付款。

### 17.3 L1：生命周期与验收

1. 手动锁定、切 Key、切存储、关闭运行单元时先禁止新会话并递增 generation；保存已生成的不可逆证据后关闭连接，清除内存索引和私钥引用。迟到的拨号、验签、签名与存储结果须核对 generation 后丢弃。
2. Worker 重启后维持锁定；解锁后先扫描会话、交易 outbox 和输入占用，按 txid 与 outpoint 对账并恢复 exact 报文，完成恢复前禁止新买卖会话。未知状态不能自动释放资金输入或再次签名。
3. 验收矩阵覆盖所有“保存前、保存后发送前、发送后结果未知”崩溃点，重复与乱序报文，多 Tab 竞争，10,000 Seed 索引，以及 ChannelProtocol WebRTC SDP/ICE 和 BitFS DataChannel 浏览器互操作。真实外部协议互操作的验收项保留独立待办，不计入本仓库内实现完成。

建议施工顺序：报价选择与买方操作入口 → F1 端口及占用恢复 → B1 状态机与内容交付 → L1 生命周期 → ChannelProtocol SDP WebRTC 的真实浏览器全链路验收。每一步分别提交可运行测试和中文用户提示；只有最后一步通过，才把 BitFS 购买标为可用。

### 17.4 U1：任务视图、记录与定向验收

1. 扩展 `packages/contracts/src/msfile.ts`、Worker 控制端口和 `packages/plugin-msfile/src/MsFileSettings.tsx`：买方设置逐字段写中文说明，旧设置迁移为自动购买关闭；设置中的自动块价与单文件强制块价必须分开保存。
2. 在 `packages/plugin-msfile/src/bitfs/` 为单文件任务、有效报价、逐卖家最近速度样本、块归属、资金拆分交易、专用 UTXO、逐池占用/付款/回收建立可恢复记录。会话 `journal` 只保存精确证据和状态引用；速度可由持久化的最近已验证交付样本重建，不把页面计时器当成资金或进度真值。
3. 扩展 `packages/plugin-msfile/src/MsFileBucketPage.tsx` 使用 Worker 任务视图：已完成文件仍按 `meta/` 列表，未完成任务按 Seed Hash 单独列出；显示阶段、进度、报价范围、强制滑块、每卖家最近速度、已付款、矿工费、受保护专款与待回收池，并提供取消。页面关闭、刷新或切 Tab 后由 Worker 记录重建。
4. 滑块测试覆盖报价 200–1000 初值 360、单报价 200 范围 200–240 且初值 240、同价报价、整数取整、新高价报价不提高已选上限。调度测试覆盖速度未知时的正式首块、最近窗口胜过历史均速、两种优先模式、价格上限硬约束、新卖家进入和不重复购买块。
5. 取消与恢复测试覆盖：未拆资金、拆分广播未知、已拆未开池、多个卖家池并存、卖家离线、关池广播未知、到期退款、重启后逐池继续观察，以及资金确认回收前不得解除保护。余额服务的普通转账测试必须证明受保护 UTXO 不会被选中。

## 18. 2026-09-24 关池协议接入进展

- 已按 go-bitfs 新增的正式 Kind 12/13 接入关池；Keymaster 不另造关池报文。
- 买方完成内容验收、付款和本地入库后，持久化并发送 Kind 12。卖方按本池最新付款证据验签、补签，持久化完整交易与 Kind 13 后回传。
- 卖方若在保存 Kind 13 后、保存关池交易索引前退出，收到相同 Kind 12 时会从已保存响应重建原交易并恢复 outbox；节点明确查不到关池交易时，双方只重放已保存的同一组双签字节。
- 买方重新验收 Kind 13 中的完整关闭交易，再登记交易 outbox 和专款账本；只有节点观察到该交易后才把费用池余款恢复为可用。账本按关闭交易原文核对实际输入（当前 go-bitfs 状态交易花费开池输出），只把回到当前买方 Key 的输出计入买方专款。付款状态也会持续查询该开池输出的当前 spender，以识别替换后的累计付款状态。
- Worker 重启时，如已持久化双方完整签名的 Kind 13，会恢复并继续同一笔 exact 交易，不重签、不生成新交易。入库完成但还未拿到 Kind 13 时，买方会话保持关池待处理，池内资金继续受账本保护。
- 买方页面已增加“正在协商关池”和“正在核对关池交易”状态；文件入库本身不再被当成整个购买流程完成。
- 单卖家当前批次尚未生成 Kind 7 付款签名时，买方可以取消并复用 Kind 12/13 关池；卖方允许在已准备交付但尚未收到付款签名时处理该关池请求。取消意图先写入 journal，之后到达的 Kind 6 不会触发付款签名；只有链上观察到关池交易、专款账本确认回收后才显示“已取消”。结果未知时仍保留资金保护。
- 页面需求取消只停止收新报价；已有购买会话仍保留 DataChannel，以便完成交付、关池或取消响应。

本节记录时，多卖家调度尚未实现；该状态由第 23 节更新。真实浏览器互操作仍未完成。新需求收到原 Kind 1 后可续接唯一匹配的卖方 journal，并重放买方已保存的 exact 报文；若 Kind 12 发出后连接断开，重新连接后可继续发送同一请求。无法匹配卖家日志时，解锁扫描仍会恢复已保存的关池交易，退款锁到期后尝试已预签退款；未到期或链上状态不明时继续保护资金。

## 19. 2026-09-24 买方到期退款恢复接入

- 买方任务读取已固定的 Kind 2/3 与 FundingTx 证据，再向 WoC 查询当前开池状态，并由 go-bitfs 以显式区块高度和 UTC 时间验证退款锁到期；退款交易由已保存的买卖双方退款签名合并，不调用私钥签名。
- 到期退款先写入会话证据和交易 outbox，再记入专款账本并广播。未知结果只按原 txid 对账，允许重放的也只能是同一 exact 退款交易；只有节点观察到交易后才把余款转回可用专款。
- 已收到 Kind 13 的会话优先恢复原关池交易；链上发现最终关闭状态时跳过到期退款，避免与最终结算争抢同一池输入。退款输出必须全部归当前买方 Key。
- 对应 Seed 买方任务重载和 Worker 解锁时的买方全量扫描都会运行该恢复入口；当前没有后台定时重试。Kind 5/6 断线续传现可通过重新发布需求、找到原卖方 journal 并重放 exact Kind 5 接续；多卖家池调度已由第 23 节接入；真实浏览器互操作仍待验证。

本次未运行类型检查、构建或测试。

## 20. 2026-09-24 买方设置与未完成任务页

- 当前 Key 的买方策略单独保存到 `msfiles/bitfs-buyer-settings.json`；文件缺失或旧代理没有该能力时，自动购买默认为关闭。设置含自动购买开关、完整 Block 单价上限、卖家优先偏好和同时购买文件任务上限，字段均有中文说明。
- 自动购买开启后，报价入库约 750 ms 后检查当前已连接且价格合格的报价，按并发设置启动多个卖家池；后续到达的新报价可补入未占满的并发名额。卖家按价格或最近已付款速度排序；没有样本时按价格排序。
- 首页当前 Seed 的报价区增加了按整数聪工作的“本文件完整 Block 最高价”滑块：不同价报价范围为最低至最高、初值为 20% 位置；单报价或同价报价范围为报价至 120%、初值为 120%。报价刷新只更新范围，不提高用户已选金额。购买开始后，同一上限写入各卖家会话日志并用于整个卖家批次。
- 每个 Kind 5/6 批次在 SDK 验收且对应 Kind 7 付款已观察后，记录不含 Seed 的有效 Block 字节数和传输耗时；报价页显示该卖家的最近速度，自动购买的“最近速度优先”使用样本排序，无样本时回退到价格优先。速度样本不参与资金、付款或验货判定。
- Worker 在购买准入时读取跨 Seed 的未完成会话，执行设置中的文件任务并发上限。受保护资金仍以 journal 和账本为准；页面状态只是摘要。
- `/msfile/storage` 现在逐卖家显示已保存的未完成购买：文件名、Seed、阶段、已验收 Block、报价、开池金额、已付金额、可识别矿工费、受保护金额、待回收金额；从任一共享池取消会停止整份文件的新内容请求，并逐池回收；页面锁定后会清空内存展示，每 5 秒从 Worker 日志和账本刷新。

`/msfile/storage` 已逐卖家显示当前 Worker 的待报价需求、有效报价、未开池购买和已开池购买；报价展示最近速度或“未知”，每池任务卡展示验收进度和专款账本摘要。买方下载计划现记录每池 Seed/Block 预算、已付款累计、活动状态和唯一 Block 归属。真实浏览器互操作需要浏览器与网络环境证据，当前不能据此宣称完成。

本次未运行类型检查、构建或测试。

## 21. 2026-09-24 买方全量恢复与未开池取消收尾

- Worker 解锁后先扫描当前 Key 的买方会话，再启动 Coordinator 运行单元；同一 Seed 下每条有开池配置、FundingTx 或 Kind 2 的会话都会按 session ID 单独恢复。
- 恢复会对账未知 FundingTx、续做已保存 Kind 13 关池交易、处理到期退款、重试已付款文件的本地幂等入库，并恢复未派发的专款拆分状态。单条恢复失败会保留原交易和专款保护，同时阻止新的买方需求或开池；再次触发买方任务时可重试。
- 修复了准备 Kind 2 前退出的边界：已保存开池配置或 FundingTx 的 `quote-selected` 会话也会被扫描。取消时先写入取消意图，核对 outbox 与 P2PKH 输入占用并释放后，才把会话记为“已取消”；迟到的 Kind 3 仍会被忽略。
- 解锁扫描本身不重建 DataChannel；后续可由任务页显式发布新需求，续接唯一匹配的卖方会话并恢复 Kind 5/6。尚未确认 Kind 3、未到退款时间且无 Kind 13 的费用池继续受保护，等待卖方重连或到期退款。

本次未运行类型检查、构建或测试。

## 22. 2026-09-24 BitFS 买方 DataChannel 断线续接

- `/msfile/storage` 对已开池且没有活动 DataChannel 的买方会话提供“重新连接卖家”操作；操作会发布新的 ChannelProtocol Hash 需求，不改变原费用池或报价证据。
- 卖方收到新需求后，以买方公钥、Seed 和持久化的 Kind 2 证据查找原会话。只有唯一匹配时才在新 DataChannel 重用原 Kind 1 与原卖方 session ID；匹配多条时静默拒绝，避免把买方的池内交易路由错池。
- 买方验收重连报价时要求 Kind 1 与原 journal 中的 exact bytes 完全相同，再续接原 session ID。恢复阶段只重发已保存的 Kind 2、Kind 5、Kind 7 或 Kind 12，并从链上按原授权继续对账；不会重新签名或为旧池创建第二份报价/付款。
- 同 Seed 的所有已开池任务会分别出现在任务列表。共享计划继续约束不同池的 Block 认领；重连依赖卖方仍在线、卖方 journal 可用且原报价未过期。
- 本次未运行类型检查、构建或测试。真实浏览器 NAT 环境的断线后重连仍需互操作验证。

## 23. 2026-09-24 多卖家调度与池预算实现

检查 go-bitfs `prepareBuyerContentRequest` 与 `checkPaymentCapacity` 后确认：每个费用池的累计卖家收款不能超过该池开池输出；开池后没有追加资金的 wire/API。因此多个卖家池必须在开池前固定各自可付金额，不能为每家卖家重复预留整份文件的 Block 预算。

Keymaster 已增加持久化的同 Seed 下载计划，记录报价文件信息、各池身份和固定预算、已确认累计付款、Seed 状态，以及每个唯一 Block 的认领或已付款归属。Seed 只会由一个池认领和付款；为允许未能交付 Seed 的池先关池回收、再由其它卖家接替，每个尚未购买 Seed 的候选池会预留自己的 Seed 报价金额。没有实际支付 Seed 的池在关池时会退回这笔预留。

买方按文件 Block 数与卖家并发上限分配每池 Block 预算。Kind 6 验货、Kind 7 付款和对应链上付款状态全部确认后，才把 Block 标记为全局完成；超时、断线或付款未知时保留原认领，直到原会话恢复或费用池已确认关闭/退款。预算用尽的池停止请求并进入关池回收；确认回收后可为尚未分配的 Block 新建卖家池。

整文件取消会先在下载计划中持久化停止标记，禁止所有池继续认领 Seed/Block，再逐池通过 Kind 12/13 回收。卖家连接离线、付款已签名或关池交易结果未知时，计划保持停止，未关闭费用池继续保留资金保护。只有所有旧池确认关闭后，用户手动重新开始下载才会清除停止标记；自动补池不会解除取消状态。

实现已接入 Worker 与买方协议层，不要求扩展 go-bitfs Artifact。尚未运行类型检查、构建或测试；真实浏览器 WebRTC 互操作仍须单独提供运行环境证据。
