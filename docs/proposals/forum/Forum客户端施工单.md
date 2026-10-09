# Forum 客户端施工单

> 状态：**施工代码已落实，本地回归、真实 Chromium 双页、HTTPS 联合发布及双客户端 BitFS 帖子购买冒烟通过；完整资源矩阵部分验收**。阶段 1 的受限网络、阶段 2 的 P2PKH Worker 协议资金/提交观测、阶段 3 的 Forum owner-session Worker 权威与 Window 代理均已接线。
> 原取消、回收和自有输出链路的代码阻断已修。真实广播、Go 索引 A、MSFile 他人取用已有最小冒烟证据；WSS/Direct、回收/归集及其余验收仍保留待执行。
> 不以单元测试替代真实验收，以下未完成验收项继续保留 `[ ]`。
> 日期：2026-10-09（Worker 施工与本地验证）。
> 依据：[Forum 客户端需求](./Forum客户端需求.md)。
> 实现位置：`packages/plugin-forum`、`packages/contracts/src/forum.ts`、
> `packages/contracts/src/msfileContent.ts`、`packages/plugin-msfile/src/msfileContentService.ts`。

此前 Worker 施工验证：`test:types`（107 契约、285 Worker 模块）、全量测试（302 个文件、2672 项）、发行构建、三类 lint、覆盖矩阵与 `git diff --check` 通过。真实 Chromium 的 `J-LOCAL-FORUM-WORKER` 通过，包含同 Worker 实例、双页共享配置、锁定/恢复及清理断言。阶段 2/3 的本地回归使用生产工厂、仓储与真实 MessagePort 框架，外部钱包/网络资源仍为夹具。

补充服务端检查：Go `internal/protocol` 测试通过；全仓 Go 测试的 `cmd/forum-genesis` 在本机 Go 1.25.7 出现 `signal_recv: inconsistent state` 运行时失败，重跑复现。本次未改服务端代码，不将此检查宣称为完整服务端验收。真实部署、资金、广播和实际索引证据继续保留待验收。

## 1. 施工目标与原则

新增 `packages/plugin-forum`，提供论坛浏览阅读与符合当前 BSV8 Forum 的签名发布。
服务端协议按工作区实现冻结，MSFile 统一持有正文，Vault 保持私钥边界，P2PKH 保持资金权威。
不在接入过程中顺带修改 Forum 签名对象、允许找零、添加未授权的服务器业务 API。
新契约与服务在真正实现前标记为提案，不能把本文方法名描述成现有 API。

## 2. 基线与改动归属

| 位置 | 本期工作 |
| --- | --- |
| `BSV8_Forum/internal/service/service.go` | 只读核对六种 op、参数类型、响应字段与错误码 |
| `BSV8_Forum/internal/protocol/{messages,signature,layout,uint}.go` | 只读核对签名、脚本及整数编码；制作互操作向量 |
| `BSV8_Forum/internal/indexer/{quote,validate}.go`、`internal/pricing` | 核对报价、索引发现、父价格和有效高度规则 |
| `packages/plugin-forum`（新增） | Forum 领域协议、任务、仓储、服务、UI 和网络 lane |
| `packages/contracts/src` | Forum 能力/运行单元/任务投影；MSFile 内容能力与无找零 spend 契约 |
| `packages/plugin-msfile` | 内容获取归档、完整内容读取、任务进度、失效事件与发布准备能力 |
| `packages/plugin-vault` | 复用 Worker signDigest；仅按实际需要增加受控签名绑定 |
| `packages/plugin-window-p2p` | 复用 Host 与 lease；注册 Forum lane，不另造身份 signer |
| `packages/plugin-p2pkh` | 专用资金、无找零构建、claim/广播恢复、特殊输出保护和归集 |
| `packages/platform-storage` | 复用受限存储绑定，不新增论坛文件仓库 |
| `apps/web` 的装配与 Coordinator 入口 | 注册产品、运行单元、真实能力依赖及授权 |
| `docs/集成测试/覆盖矩阵.yaml` | 新增协议、内容、浏览器、资金和恢复证据条目 |

装配遵循当前 WebLoom 0.6 的 units.runtime、scopeKind、consumer 和 Scope 校验。
不要复活旧插件开关、全局 Host 对象或私钥导出路径。

## 3. 运行结构与接口设计

Window 单元负责页面、Markdown renderer、必须在浏览器运行的网络 executor 和资源 URL。
owner-session Worker 单元负责请求与业务签名、配置/任务仓储、最终 raw 校验和跨页面状态。
配置编辑所需存储单元按现有 storage Scope 建立，不让配置 UI 获取完整钱包存储权限。

建议提供以下结构化能力，最终名字在契约阶段统一：

| 能力 | 语义 |
| --- | --- |
| Forum 配置与连接 | 保存配置、验证根、建立/关闭连接、读取状态 |
| Forum 索引 | listBoards/listPosts/listReplies/getNode；校验后的领域结果 |
| Forum 阅读 | 请求 MSFile 内容任务、读取已验证正文、返回展示状态 |
| Forum 发布 | 准备 reply/changetip、确认预算、提交、取消未派发任务、对账与恢复 |
| MSFile 内容 | ensureContent/openVerifiedContent/importContent；名字为提案 |
| MSFile 内容状态 | 按 hash 订阅任务、删除/损坏失效、发布可达性状态 |
| P2PKH 协议资金 | 专用 UTXO 准备、带费用上限的无找零 spend、归集 |

MSFile 能力不返回 OwnerFileStore、原始私有路径或供应商私钥。
openVerifiedContent 返回受 Scope 约束的流/读取句柄、经核对的大小和内容身份。
Forum 网络 signer 只接受已校验的 roundtrip 请求与允许的六种业务 op，Worker 内用 SDK
重建规范字节；reply/changetip signer 只接受结构化字段并构造固定 CBOR 数组。

## 4. 分阶段实施

> 勾选含义：**代码已落地**；不代表该阶段的真实网络/浏览器验收已完成。
> 真实资源验收统一记在 `docs/集成测试/覆盖矩阵.yaml` 的 `KM-FORUM-001`/`KM-FORUM-002`，
> 状态为「部分覆盖」。

### F01：协议与互操作基线

- [x] 从当前 Go 实现提取根、reply、changetip 的黄金向量：参数、CBOR hex、单次 SHA-256、DER、脚本和 raw。
- [x] 明确 txid 展示字节顺序、input raw 反向字节、脚本整数与 CBOR 整数的区别。
- [x] TS 编码器/解析器独立实现 Forum 固定数组与脚本，验证 DER/low-S，拒绝非规范编码。
- [x] 固定 roundtrip TS/Go 兼容版本，验证 JCS 外壳与 Forum CBOR 业务签名分别使用正确编码。
- [x] 做浏览器 bundle 检查，不能把 Node HTTP server 适配依赖带入浏览器入口。

完成条件：TS 签名能由 Go 验证，Go 向量能由 TS 验证，TS raw 能由 Go parser 解析。
不得只用 TS 自己签自己验代替跨语言证据。

实施结果：`interopVectors.test.ts` 用服务端 `internal/protocol/messages_test.go`
里的黄金向量做断言——四项 forumSig 的 CBOR hex 与 RFC 6979 DER 与 Go 逐字节一致；
非最短 head、high-S、错误字节序、旧三项形式全部被拒绝。`browserBoundary.test.ts`
把「JCS 外壳与 CBOR 业务签名分别使用正确编码」「浏览器入口不带入 Node server 适配」
变成可执行检查。真实 Chromium 已加载生产构建并运行 Forum 页面；服务端 `internal/protocol` Go 测试通过。**未完成**：真实部署服务端的端到端验签。

### F02：插件、配置、信任与网络

- [x] 新增 Forum manifest、产品目录、Worker/Window units、受限仓储绑定和页面贡献。（**代码已实现，真实资源未验收**：Worker 独占 Forum 配置、缓存、任务仓储、规范业务签名、报价复核、raw 校验与派发仲裁；Window 仅注册唯一 Host 的 Forum lane、消费必需 RPC/附件 stream 并展示页面，不提供本地发布回退。受限 roundtrip 复用现有 executor bridge，按请求 hex 字符数 × 2 计 UTF-16 字节，并预留最大响应；请求与提供方 Scope 撤销分别中止在途请求。附件通过 256 KiB transfer 分块传递，保持原 32 MiB 上限，不提高全局 RPC 预算。）

**阶段 2/3 实施归属**：P2PKH Worker 复用 transfer runtime 的同一中心广播服务、钱包文件根、选币快照与 claim 数据模型。专用资金仍保存在既有 `p2pkh/funding/`；快照与广播每次从记录读取保护投影，损坏即拒绝花费。Worker 内注册表只缓存 provider 投影，不提供第二份持久资金真值或独立派发裁决。既有协议提交/claim 原来仅在内存，现补齐 `p2pkh/protocol/<id摘要>.json` 写前证据（原提交和关联 claim、条件写），供重启对账；广播前先写 `unknown`，明确接受后才更新结果。普通 raw 不得绕过保护；仅与持久提交的 owner/network/txid/完整输入顺序及 active claim 全部匹配的协议提交可花费。BitFS 的既有保护门禁继续独立拒绝，不因 Forum 例外放行。

Forum Worker 通过必需 `p2pkh.worker-protocol`、MSFile 内容和 Vault Worker crypto 能力工作。`forum.worker-service` 仅接受声明的结构化领域方法，页面没有任意 digest、广播或文件句柄入口；提供方、owner/epoch、调用 peer 会话与取消信号共同约束调用。跨 Runtime 依赖允许在清单阶段声明，实际启动仍需服务就绪。Forum RPC/stream 随已提交 peer 会话及 Worker 实例就绪动态暴露，使用独立 exposure group，不因 Forum 启停旋转存储/crypto grant；锁定和实例撤销围栏旧 proxy。

本地实测：`J-LOCAL-FORUM-WORKER` 在真实 Chromium 两页保存/读取同一配置，断言两页看到同一 Worker instanceId；锁定后两页撤权，同 Key 解锁后重新进入 Forum，配置保留且两页 cleanup 完整。证据：`e2e/runs/local-integration/local-integration-mv0dul8y-1209a7a14c6e`。页面翻译改用已声明的 I18n 能力；注册贡献由 Scope 自动注销，避免 teardown 调用已撤权 registry。钱包专用资金保护恢复读取全部分页，后页损坏记录同样阻止花费；被拒/丢弃提交与链数据源无观测均保持未知，不作为取消释放依据。

- [x] 实现论坛配置、根 raw 下载与四项 forumSig 验证，保存验证证据和基线版本。
- [x] 实现 roundtrip typed signer、from/to/reply_to 和业务结果严格解析。
- [x] 接入 HTTPS；核对服务部署的 CORS/OPTIONS/TLS，失败保持传输错误语义。
- [x] 注册 Forum libp2p lane，复用 Window P2P lease 和 Host，核对本地/远程身份。
- [x] 适配 WSS 和 WebRTC Direct，真实地址/certhash 从部署配置取得。（地址按**完整 multiaddr** 校验，含 `/p2p/` 与 `/certhash/`）
- [x] 锁定、切 Key、Scope 撤销、迟到响应和跨页主 executor 切换处理。

完成条件：同一论坛配置可经三种入口取得同语义签名结果，错误服务器公钥和请求关联被拒绝。

实施结果：rootTrust 验证与索引客户端有单元测试；HTTPS 走 roundtrip SDK 的
`httpExchange`，WSS/Direct 走 Forum 注册到唯一 Window Host 的 lane，两条路径共用
同一套响应校验。**未完成**：真实部署的 CORS/TLS/locator 配置与三种真实连接的浏览器验证。

### F03：索引浏览与分页

- [x] 六种业务操作使用统一领域 client；先实现四种查询。
- [x] 页面实现论坛列表、板块、帖子、节点详情和按需展开回复树。（列表内部的路径已修正：第一段是本地 `configId`；板块行进板块帖子列表，发布入口针对当前节点。**首页进入浏览的入口**：配置卡片在根验证通过后给出 `/forum/:configId` 链接，且验证成功后把新证据上报首页（否则链接要刷新页面才出现），见 `pages.test.tsx` 的渲染断言与「新增配置 → 验证 → 进入论坛」连续操作测试）
- [x] 每个列表持有 forum/op/parent/pageGeneration/snapshot/cursor；取消后结果不可交付。
- [x] cursor 请求省略 snapshot_height，严格保留服务端顺序。
- [x] SNAPSHOT_INVALIDATED 替换整组页；INVALID_CURSOR 报错并清理该游标，不无限重试。
- [x] NODE_NOT_FOUND、INVALID_PARENT、未就绪、网络超时与合法空页分别展示。
- [x] 离线缓存标注旧视图，根名称与价格来自固定根 get_node 的声明视图。

完成条件：真实服务端多页浏览、并发展开、父节点切换和内存池 revision 变化没有串页或混快照。

实施结果：分页状态机 15 项单元测试覆盖游标绑定、世代纪律、SNAPSHOT_INVALIDATED
整组替换、INVALID_CURSOR 清理、连续失效停止自动循环与同快照检查。**未完成**：真实服务端多页浏览。

### F04：MSFile 内容能力与唯一归档

- [x] 盘点现有 stat/readSeed/readBlock、bucket service、BitFS 任务和实际已实现的本地优先路径。
- [x] 由 MSFile 提供跨插件内容获取、导入、完整读取和进度能力，不公开其内部仓储。
- [x] 本地完整命中不走远程；不完整命中复用已验证块，缺失部分由 MSFile 调度。
- [x] 校验 seed hash、块 hash/顺序/长度、sourceSize 与 MasterSeed 的对应关系，限额防止资源耗尽。
- [x] 将获取结果写入现有 seeds/storage/meta，由 MSFile 完成提交与列表可见性。
- [x] meta 不能充当完整性证据；崩溃/取消后部分文件可恢复，未完整时不得返回完整正文。
- [x] 同 hash 多消费者任务合并，取消引用与全任务取消区分；遵循全局 MSFile 价格/并发策略。
- [x] 加入内容删除/损坏失效通知，Forum 投影失效但不删除内容替代用户操作。
- [x] 打通内容发布准备和可达性证据；若渠道尚未实现，列为该阶段未完成，不伪造发布成功。（远程获取复用 BitFS 买方通道并轮询等待报价与购买终态。**发布渠道已接线，并已有双客户端真实购买冒烟证据**：判据取自 MSFile 卖方运行单元的真实状态（`createMsFileSellerPublicationEvidence`），只有 `ready`/`selling` 报已发布，`indexing`/`degraded`/`configuration-error`/未开启一律报 `published: false`；`publication` 缺席时同样报不可达。Forum 侧 `publicationReachability`/`preparePublishContent` 消费该证据并在发布页作为**第四套状态**展示。**最小真实验收通过**：另一独立 Chromium 从论坛取得 hash，经 MSFile 全网发现该卖方，完成 BitFS 开池、购买、关池与正文展示，卖方实际收到 2 sat；完整渠道和正式部署验收仍待执行）

完成条件：远程取得的帖子在 MSFile 页面可见；关闭重启后本地阅读，Forum 存储没有正文副本。
此阶段与现有 MSFile/BitFS 提案共享能力和同一仓库，不同时建立两套 content API。

实施结果：新增 `msfile.content@1` 能力（`ensureContent`/`openVerifiedContent`/
`importContent`/状态订阅/发布可达性），17 项单元测试覆盖唯一归档、损坏块、缺失块、
部分写入、同 hash 合并、独立取消与渠道缺失如实报告。**发布渠道已接线**：
`createMsFileSellerPublicationEvidence` 直接读 MSFile 卖方运行单元的真实状态，
只有 `ready`/`selling` 报 `published: true`，`indexing`/`degraded`/
`configuration-error`/未开启一律报不可达，判据与 manifest 装配的是同一份代码。
**最小真实验收通过**：`J-REAL-FORUM-PURCHASE` 已验证远程正文购买、唯一 MSFile 归档、实际下载字节一致、Forum 展示，以及卖方离线后本地阅读且不新增付款。浏览器重启命中、MSFile 列表页面可见性与完整渠道验收仍待执行。

### F05：Markdown 阅读与附件

- [x] 实现 UTF-8 Markdown 解码、1 MiB 限额、标题/摘要投影和解析版本。
- [x] 新内容 LF/无 BOM；已存字节不重新归一化，不因解析产生新 hash。
- [x] 关闭 raw HTML，过滤危险 URL，远程图片不自动加载。
- [ ] 实现 msfile:seedhash 附件解析；通过 MSFile 获取和读取，附件失败不阻塞正文。（**部分**：解析、`openVerifiedAttachment`（独立 32 MiB 上限）、图片 MIME 白名单内联展示与下载出口、**远程获取后的完整性验证走附件限额**（`ensureContent({ asAttachment: true })`，否则 2 MiB 图片会被正文 1 MiB 限额判成 too-large）均已实现并有单元测试；**远程附件获取依赖真实 BitFS 买方通道，未在真实环境验证**，浏览器内的图片渲染与下载也未做真实验收）
- [x] 优先当前阅读与展开回复；列表只自动使用本地正文投影，远程付费获取遵循用户动作/策略。
- [x] 展示正文进度、不可达、验证失败、超限文件入口和离线状态。（附件逐项独立显示状态；读到字节才给图片/下载入口）
- [x] 离开页面和身份撤销时释放流、URL、订阅；MSFile 删除后不继续呈现过时可用标记。

完成条件：真实正文与图片可读；恶意 Markdown、损坏块、离线和缺失文件行为符合需求。

实施结果：24 项单元测试覆盖 1 MiB 限额、BOM/非法 UTF-8、标题摘要投影、`msfile:`
附件引用、raw HTML 不执行、协议白名单与远程图片不自动加载；附件字节读取另有 4 项测试覆盖
字节上限独立、完整性核对与非法 hash 拒绝；渲染层 5 项断言图片确实内联出现在 DOM 里、
配置卡片给出浏览入口。**未完成**：真实正文与图片的浏览器验收。

### F06：资金准备与协议交易

- [x] 在现有 P2PKH claim/提交中心增加专用资金用途与持久任务关联，跨页选币排除已占用输入。（新增 `p2pkh.protocol-funding@1`：选币、资金准备交易、找零与专用 UTXO 保护登记都在 P2PKH 内完成）
- [x] 普通资金准备交易生成专用 P2PKH UTXO 和正常找零，记录资金 txid/vout、raw 和预算。（记录**每条一个文件**落在 `p2pkh/funding/<fundingId>.json`，派发之前用 `ifNoneMatch` 条件写入 fundingId/submissionId/raw/outpoint/**owner/network**。按记录分文件是必需的：单文件承载全部记录时两个标签页处理不同任务会互相覆盖写前日志）
- [x] 新增受控无找零构建模式：固定输出、最大 minerFee、最大费率及明确剩余金额处理。（`ProtocolSpendPrepareInput.noChangeRule`：余额差必须精确成为矿工费、不得超过 `maxMinerFeeSatoshis`、不产生找零输出；与 `changeAddress` 互斥；固定输出与费率由调用方给出）
- [x] 按 DER 输入长度上界估算预算；最终签名后检查输入总额、输出总额、实际大小和实际费用。
- [x] 不沿用当前“无 changeAddress 且有余款即拒绝”的通用逻辑，不通过增索引费/打赏费解决余额差。（改为显式的 `noChangeRule`：余额差必须精确成为矿工费且不超过确认预算；未声明该规则的调用方仍走原来的余款拒绝）
- [x] 适配零值索引输出；输出 value、金额累计和 number 转换处做安全整数检查。（Forum 侧与 P2PKH 两侧都完成：零值输出需 `noChangeRule.allowZeroValueOutputs` 显式开启，其余路径继续拒绝；安全整数闸门在两侧都存在）
- [x] 从真实 prevout 核对输入金额与脚本，不信调用方给出的输入 value。
- [x] 处理资金准备未派发/未知/已观测/已花费；未确认子交易失败时先对账父交易。（恢复时按记录状态分支：明确未派发才重备，链上已成立才复用，其余拒绝。存在**读不出来**的记录时 fail closed；创建竞态由 `ifAbsent` 条件写分出胜负，输的一方释放自己的预签名且不派发）
- [x] 报价改变时重新确认和重算资金；多余专用资金提供回收操作。（**代码已实现、本地验证，真实未验收**：报价变化后回到 `budget-confirmed`、清空旧预算并要求重新确认已接线；**显式回收已实现**——回收前先判依据（`supersededBy` 须与记录一致，或调用方仲裁后声明 `unused`）、拒绝 `unknown`/`rejected` 派发状态、按 **outpoint** 核验 UTXO 未被花费、矿工费有上限；广播结果按 `accepted`/`not-broadcast`/`uncertain` 三分，只有 `accepted` 才删记录与保护，拒绝与不确定一律保留记录。Forum 侧 `recoverFunding` 在不可逆动作**之前**完成 owner、已派发、阶段与**完整资金坐标（txid+vout）**检查，锁外与租约内用同一份判据各判一次；**取消、发布、回收共用同一把派发租约**，因此回收不会把并发取消写下的 `failed` 覆盖成 `budget-confirmed`。**已取消（`failed`+`cancelled`）且确定未派发的任务可以回收**，回收后保持取消状态并只清资金引用，不把用户已取消的发布重新激活。**未完成**：真实广播与真实链上验收未跑）
- [x] 识别、保护自有 Forum data/tip 输出，归集使用完整 scriptCode，解锁脚本只提供正确签名。（**代码已实现，本地验证，真实未验收**：`signMixedInputs` 按输入选择裸公钥或 P2PKH 解锁；`forumSelfOutputs` 负责识别、保护与显式归集，归集只接受 (txid, vout) 并在归集当时重新取原交易、核验 txid/归属/金额/完整锁定脚本后才签名，拒绝重复坐标与超限批量；保护集合按 owner 会话复用实例、通过 `onChange` 通知注册表、锁定/切 Key/Scope 撤销/卸载时撤销。**未完成**：真实脚本执行与真实广播仍未验证）

完成条件：reply 与 changetip 输出数严格符合 Go parser，大额钱包 UTXO 不直接变为大额矿工费。
特殊输出归集通过脚本执行与真实网络验收；不能复用仅支持 P2PKH prevout 的签名代码冒充支持。

实施结果：输出布局、零/非零父价格、零索引费、费用明细、矿工费预算与复核、最终 raw
自检共 22 项单元测试；受控无找零与零值输出 8 项、专用资金写前日志与恢复 11 项、
矿工费估算 3 项；完整发布流程 9 项（含真实 roundtrip 与受控无找零资金替身）。
**未完成**：真实资金准备、真实广播，以及自有特殊输出的真实脚本执行验收（识别、
保护与归集已实现，`FT05` 仍未验证）。

### F07：发布、报价与索引跟踪

- [x] 实现正文导入 MSFile、可达性准备、父节点解析、结构化 operatorSig 和报价请求。
- [x] 验证完整 roundtrip 响应及 indexSig；parent_tip_price 从关联响应取得，不混用缓存初始价。
- [x] 费用确认列出正文获取/发布费用（如有）、资金准备矿工费、索引费、父作者金额、协议矿工费预算。（两笔交易的矿工费都由当前报价算出：协议矿工费按固定输出数估算，资金准备矿工费取 P2PKH 同源估算；不再从尚不存在的 budget 读值）
- [x] 资金准备后重新询价；费用或父状态变化回到确认，迟到 quote 不覆盖当前任务。（复核走与首次报价完全相同的请求与 indexSig 验证路径；费用变化时清空预算并回到 `budget-confirmed`）
- [x] 创建固定布局 raw，完成输入签名后从 raw 重建并验证 operator/index 对象和所有输出。
- [x] 通过统一广播中心提交，保存 txid/raw/submission ID，不调用不存在的 Forum submit 接口。
- [x] reply 查询 get_node(txid)；changetip 查询目标视图与链上证据，不把事件 txid 当节点。
- [x] 展示广播/链上/索引三套状态，查无节点显示待发现或无法判断，不伪造拒绝原因。
- [x] 对父价格链序变化、last_block_height 超期规则、撤销及依赖子树变化实现状态刷新。

完成条件：板块、帖子、回复和作者改价可通过真实服务端使用；最终 raw 独立满足索引规则。

实施结果：quote 请求/响应解析、indexSig 用**将要上链的输出**重建验签、发布任务
写前日志、广播/链上/索引三套状态与「查无节点显示等待发现、changetip 接受证据不可查询」
都有实现与单元测试。**未完成**：真实服务端报价与广播、真实 Go 索引器观测。

### F08：恢复、完整验收与文档收口

- [x] 任务写前日志覆盖资金、协议签名、广播派发、最终结果，每次不可逆动作前保存证据。（`funding-prepared`/`quote-rechecked`/`raw-prepared` 逐步落盘；每次写入都是 `ifRevision` 条件写并保留栅栏元数据；资金准备记录在 P2PKH 派发前按 fundingId 条件写落盘）
- [x] 重启、窗口关闭、网络超时、广播已成功但响应丢失时只对账原提交。
- [x] 用户选择重试前检查原交易；未知/已派发 claim 不释放，明确未派发才可取消释放。（**代码已实现，本地验证，真实未验收**：取消判据改为**持久提交的实际派发状态**——锁外看任务 `broadcastState`，租约内再向钱包查同一个 submission，只有 `not-dispatched`/`definitely-not-dispatched` 才释放并标记取消，其余（含 `unknown` 与无观察能力）一律拒绝；派发租约辅助函数退化为纯互斥，拿不到租约时只有发布才退化为对账，取消与回收明确拒绝，不再被改写成 `reconciling`；**有预签名提交时释放能力必须可用且释放成功才能标记取消**，能力缺失或释放失败都明确失败并保留任务原状态（无提交的草稿可直接取消）。已取消任务的资金回收按同一提交的实际派发状态放行，保留 `submissionId` 历史证据。**未完成**：真实浏览器多标签页下「预签名 → 取消 → 回收」与「取消撞上他人租约」的端到端验收未跑，因此保持未勾选）
- [ ] 多页竞争、锁定和切 Key 下任务保持原 owner，不把旧 raw 提交成新用户操作。（**部分**：进程内任务互斥锁 + 阶段推进守卫 + 跨标签页派发租约 + 取得租约后重读任务 + 续租 + 派发前持有权核对 + 按 revision 条件删除租约；任务写入全部是 `ifRevision` 条件写（含无令牌的 `rollbackToBudget`/`confirmBudget` 路径，并保留栅栏元数据）；栅栏令牌取自**任务记录**而非租约文件，因此租约释放后重新取得不会退回旧值。Worker 权威现已接线，所有 Window 共用同一任务实例；持久租约继续负责中断恢复。多设备/多浏览器不共享本地钱包仓储，本计划不新增远端仲裁。真实发布、取消与资金回收的浏览器组合验收仍待执行）
- [ ] 执行下表协议、浏览器、MSFile 和资金验收，记录环境、基线 commit 和实际 txid。（**未执行**：真实服务端、资金广播与索引观测未验证；真实 Chromium 双页配置共享与锁定恢复已通过，不能替代本表发布/取消/回收验收）
- [x] 补充依赖图、功能调用元数据与必要装配门禁，执行项目要求的静态检查和相关测试。
- [x] 更新覆盖矩阵与现行文档；未通过的真实网络项继续标为未验证。

## 4.1 与施工计划的已知偏离

| 项 | 计划 | 实际 | 后果与兜底 |
| --- | --- | --- | --- |
| 发布权威归属 | owner-session Worker 统一执行任务状态转换、签名校验与提交仲裁 | 阶段 1/2/3 代码已接线；Window 仅消费必需 RPC，无本地发布回退 | 真实 MessagePort 双窗口共享配置/取消状态、旧 owner 拒绝和 32 MiB 附件传输已有测试；真实资金发布、Go 索引 A 和双客户端购买的最小冒烟已通过；完整资金边界与交错验收仍待执行 |
| P2PKH 无找零通用模式 | 新增受控无找零构建模式 | 已在 P2PKH 侧实现 `noChangeRule`（`ProtocolSpendPrepareInput`），未声明该规则的调用方保持原行为 | 其它协议插件仍需显式声明才能走无找零；「余款拒绝」是默认保护，不是缺陷 |
| 零值索引输出 | 适配 wallet 构建校验 | Forum 侧生成零值 vout 0；P2PKH 侧经 `noChangeRule.allowZeroValueOutputs` 允许 | 真实广播结果**未验证** |
| 专用资金跨页持久化 | 单一权威存储，按记录分文件 + 条件写 | 已按记录分文件并支持条件写；首次创建用 `ifAbsent`，冲突方释放自己的预签名且不派发 | 两个标签页写不同 fundingId 不再互相覆盖；同一编号的重复创建由条件写挡住（单元测试覆盖） |
| 专用资金保护恢复 | 启动时在允许选币前重建保护登记 | `restoreProtections` 的 promise 被 `allocateUtxos` 与转账的 `loadSpendableUtxos` **await**（恢复失败则选币失败）；按每条记录自带的 `network` 观察，只有明确已花费才解除保护，链上未知继续保护 | 真实重启顺序（先普通转账、再恢复任务）**未在浏览器验证** |
| 同插件多个保护 provider | 刷新/注销一个 provider 不清除另一个 provider 的在途占用 claim | claim 回收判据改为**所有存活 provider 输出集合的并集**；`protectedOutpointRegistry` 按 provider 维度维护，两个实现（生产与 test-support）保持字节一致 | 专用资金 claim 在自有输出 provider 登记/刷新/注销后仍在，第二次 claim 被 `already claimed` 挡住；真正无保护时才释放（单元测试覆盖） |
| 资金额度不足时的重准备 | 保留旧记录与保护，新资金用独立编号 | 旧记录标 `supersededBy` 保留，新编号 `<fundingId>+1`；旧输出保护保持到显式回收 | 重启后新旧两笔都有记录与保护（单元测试覆盖）；显式回收覆盖「已被替代」与「确定不再使用」两种依据，并拒绝链上/outpoint/派发状态不可判定与广播非 `accepted` 的情形，**真实广播未验收** |
| 归集（FT05） | 识别、保护并显式归集自有特殊输出 | 代码已实现、本地验证 | 保持未完成：真实脚本执行与网络验收未做 |


本轮阻断修复（2026-10-08）：

- 保护 provider 在同一服务实例内只注册一次，更新数据时刷新 provider 并保留 claim；资金文件保存 `ownerPluginId`，恢复保持 Forum 归属。已有缺少该字段的 `forum:` 记录按既有编号恢复归属。
- 任务内容、栅栏令牌与 revision 来自同一次 `get`；带令牌与普通任务更新均以该快照执行条件写，不借用另一次读取的新 revision。
- 报价上涨后沿 `supersededBy` 查找并对账后继；重复调用和重启不跳过已存在或未知的后继。Forum 保存实际 `fundingId`，核对与观测使用该编号。
- 损坏资金记录使保护恢复和选币门禁失败；可读但链上未知的资金继续受保护。

新增组合回归使用实际保护注册表验证准备/复用/恢复和 Forum claim；覆盖内容读取后被插队、后继重复调用/重启/未知结果，以及实际编号在 Forum 两侧传递。以上为代码级修复证据，真实资源验收仍未执行。

## 5. 领域记录与状态机

Forum 仓储至少保存：配置、根验证证据、索引缓存、阅读位置、展示投影和发布任务。
记录绑定当前钱包存储，金额存规范十进制字符串，raw/hash 不经重新编码改变。
冻结后的正文保存于 MSFile，发布任务只存 hash；未冻结的编辑草稿可以保存于 Forum，
完成冻结后不得再把正文复制进发布记录或索引缓存。

发布任务字段至少包含：taskId、ownerPublicKeyHex、network、forum 配置快照/根/服务公钥、
kind、target、正文 hash、未来回复价、operatorSig、报价、预算确认版本、资金提交 ID 与 outpoint、
协议 submission ID、最终 raw/txid、派发证据、广播状态、链上观测、索引观测和可判定错误。
不能持久化私钥、签名 capability、lease、运行句柄或把旧 connectSession 当恢复授权。

```text
草稿 → MSFile 冻结/发布准备 → 作者签名/报价 → 预算确认
     → 资金准备 → 报价复核 → 协议 raw 准备 → 广播派发
     → 对账原交易 → 等待索引 → 暂时已索引 → 已确认索引
```

失败分支保留阶段证据；费用变化回预算确认，网络未知进入对账，内容缺失回 MSFile 任务。
changetip 终态单独描述：链上观测 + 当前价格视图，接受证据不可查询时保持明确限制。
索引结果变动不得覆盖原交易证据；状态刷新必须绑定记录 owner 和当前观测世代。

## 6. 验收矩阵

所有条目初始状态为待验证，证据写入统一覆盖矩阵，不用本文复选框冒充测试通过。

所有条目初始状态为**待验证**；下面标注的是本轮代码级证据，真实验收见覆盖矩阵。

| ID | 验证场景 | 判定条件 | 本轮证据 |
| --- | --- | --- | --- |
| FP01 | TS/Go CBOR、DER、raw 互操作 | 两端接受同一合法向量；非规范 CBOR/high-S/错误字节序被拒绝 | 黄金 hex/DER 向量与 Go 逐字节一致；非规范编码与 high-S 被拒绝（单元测试） |
| FP02 | 根四项签名 | 正确 input 顺序通过；旧三项/错根/错公钥失败 | 已实现并通过：换根/换公钥/换 input 顺序/找零付给别人/旧三项形式全部失败 |
| FP03 | 请求和身份绑定 | 错 from/to/reply_to、libp2p 身份不一致被拒绝 | 身份方向已由 SDK 强制（from=当前 Key、to=论坛公钥）并加断言；真实 HTTPS 联合冒烟已通过，WSS/Direct 未验收 |
| FP04 | 输出布局 | reply 2/3 输出、changetip 2 输出正确；额外找零与错 vout 失败 | 已实现并通过单元测试 |
| FP05 | 金额边界 | 零索引、零父价格、uint64、number 边界不截断；实际零输出广播结果有证据 | 编码与解析边界已通过单元测试；**真实零输出广播结果无证据** |
| FB01 | 板块/帖子/回复分页 | 真实多页、空页、末页、展开回复正确且按服务端排序 | 顺序/末页/空页/游标纪律已通过单元测试；**未连真实服务端** |
| FB02 | 视图失效和竞态 | revision 更新/切父节点/迟到响应不混页、不无限刷新 | 已实现并通过单元测试 |
| FC01 | MSFile 获取与归档 | 远程正文保存至同一 msfiles；重启本地命中；Forum 无副本 | 双独立 Chromium 的真实 Forum → Hash 发现 → BitFS 购买 → MSFile 保存/下载/论坛展示通过；卖方离线后本地阅读且无新增付款通过。**浏览器重启命中仍未验证** |
| FC05 | 发布可达性 | 渠道缺失时如实报 `published: false`；Forum 消费该证据 | 保留原发布可达性单元证据；真实卖方 `ready`、另一独立客户端通过论坛 Hash 需求发现该卖方并完成 BitFS 开池/购买/关池已通过，卖方实际收到 2 sat。完整渠道与部署验收仍待执行 |
| FC02 | 完整性与恢复 | 损坏 seed/块/长度/部分写入不能返回完整正文，可恢复或明确失败 | 已实现并通过单元测试 |
| FC03 | 同 hash 与删除 | 多消费者去重、独立取消、删除失效、重新获取正确 | 已实现并通过单元测试 |
| FC04 | Markdown 与附件 | XSS/危险 URL 不执行；附件通过 MSFile；超限与不可达保留索引 | 已实现并通过单元测试（附件字节读取 4 项、2 MiB 本地大附件与用户触发远程获取 3 项、渲染 3 项、路由 4 项、存储路径 9 项）；**浏览器内图片展示与下载未验证** |
| FN01 | 三种真实连接 | Chromium 的 HTTPS/WSS/Direct 成功，CORS/TLS/locator 配置记录完整 | **未验证**：需要真实部署 |
| FT01 | 资金准备与费用 | 专用 UTXO/找零/无找零预算正确，费用超限拒绝 | 受控无找零 8 项、资金记录文件 10 项、写前日志/创建竞态/恢复 36 项、选币门禁 3 项、报价上涨后换新编号重备 5 项；真实资金准备和原输出恢复/复用已通过本次冒烟；完整资金边界和多页竞态未验收 |
| FT02 | 实际签名广播索引 | 板块、帖子、回复 raw 成功观测并被 Go Forum 索引 | 根节点 reply 的真实签名、广播、Go 索引为 A 与正文展示通过；其他层级和 changetip 未验收 |
| FT03 | changetip | 仅作者成功；目标价格刷新，不伪造事件接受查询 | 事件接受证据不可查询的限制已在代码与 UI 表达；**未验证真实链路** |
| FT04 | 价格变化 | 父价格链序变化与报价超期按当前服务器规则重新判断 | 资金准备后重新询价、费用变化回到确认已通过单元测试；**未验证**（服务端规则为真值，客户端只按报价响应构造） |
| FT05 | 自有特殊输出归集 | 完整 scriptCode 签名通过，自有资产可回收，帖子不因花费而被当作删除 | **未验证**：识别、保护与归集已实现并装配，归集前重新核验真实 prevout，FORKID sighash 用完整 scriptCode 签名；真实脚本执行与真实广播未跑，保持未验证 |
| FR01 | 广播响应丢失/重启 | 对账原 txid，不二次付款，不释放已派发 claim | 任务写前日志、资金记录落盘、拒绝/未知不得当作可用资金与只对账不重付已通过单元测试；**重启恢复未执行** |
| FR02 | 多页/切 Key/锁定 | 签名、网络、资源 URL 与迟到写回不串身份 | 会话世代 fence、owner 断言、派发租约、`ifRevision` 任务写入（含真正交错两个写）、栅栏令牌与持有权核对已有单元测试；真实 Chromium 双页配置共享、同 Worker 实例、锁定与恢复通过。**带真实资金的发布/取消/回收交错尚未验收**，不覆盖多设备场景 |

互操作测试可以用本地 Go 服务与数据库夹具；真实浏览器、真实广播和实际索引必须另有证据。
仅钱包观测 confirmed 不能代表 Forum confirmed，MSFile 供应商返回成功不能代表完整性通过。

## 7. 实施交付检查

每阶段交付可 review 的领域实现、必要契约、针对真实风险的测试和证据状态。
按现有脚本执行 typecheck、边界 lint、产品目录/依赖图检查、相关测试与 build，
真实网络测试由集成测试说明规定，不因默认单元测试通过就勾选真实验收。
完成后更新架构、P2PKH、MSFile 文档，并建立 Forum 现行主题文档及索引；
只有实际实现并验证的行为进入现行文档，提案和未解决服务器接口限制保留未完成标记。

## 2026-10-09：A/B 状态与高度驱动对齐施工

本次范围：Go 服务端统一高度 Monitor、独立 A 发现与高度事件确认扫描、真实区块逐交易发现、A 首次接纳高度和超过 10 个区块移除、超时交易入块恢复 B、B 终态、未确认创世根启动和未确认创世资金。数据库通过幂等 schema 初始化增加生命周期证据，旧 A 首次成功扫描建立期限。

Keymaster 发布任务 `indexed-confirmed` 改为终态，停止重复对账；A 的 `indexed-mempool` 保持继续观测。联合冒烟 E2E 已开始执行，以广播后帖子可展示/读取为通过条件，不等待入块。

状态：A/B 对齐代码已实现，真实测试网联合冒烟已通过。本次 Go `go test ./...` 在真实 PostgreSQL 下通过；Keymaster Forum 领域 131 项，会话与活动快照回归 157 项，`test:types`、生产构建及 E2E 类型检查通过。此前客户端全量测试数字仍为历史证据，不冒充本次全量验证。

### 真实联合冒烟结果

- 证据：`e2e/runs/forum/forum-mv0of670-55fbfb30ce12/state/smoke.json`，Playwright **1 passed**（约 1.7 分钟）。
- 前序运行已通过正式 UI 创建任务、取得真实报价、确认预算并广播专用资金准备交易。本轮恢复的是同一任务 `fefeaf21e6b3eb60a65755bcc53d5ba4` 的真实公开写前记录，通过生产存储授权写回，没有伪造阶段、claim 或索引。
- 复用原 4 sat 输出 `380c5542e958cfdf8080f8232e1eac78232c1122354a1e1e4ef3345dd0816b52:0`。原正文经 MSFile 重新导入后 hash 与任务的冻结 hash 一致；生产 Worker 重新取得真实报价并签名、广播同一任务，没有新增资金准备交易。
- 帖子交易：`55b570d49823daf86b0f61c651b1b7088a4b6d8a7ac778762330364716b99138`。真实 Go 索引器自主发现，PostgreSQL 只读核验为 **`mempool`（A）**；没有等待区块确认，没有往数据库插入测试帖子。
- 浏览器重新进入公开帖子路由，论坛节点读取成功，MSFile 本地归档正文展示原标记。签名/广播/Go 索引/本机 MSFile 读取展示的最小链路通过。

阻断根因及修复：Worker 的 256 条事件队列中，246 条是连续存储活动计数快照。现在只合并相邻且 session、wallet、status、summary 和 recovery 对象相同的活动快照；身份变化、真实存储状态变化及其他业务事件保序，队列上限不变。修复后真实运行未再中断，并通过 157 项回归。旧恢复档案若缺提交证据且原资金已花费，恢复入口明确拒绝，避免重新拆钱付款；后续运行成功或失败都保存公开提交/资金记录。

边界：本次只验收用户要求的最小 HTTPS 联合冒烟和状态 A。证书是本机临时自签证书，隔离 Chromium 放行它，协议身份与签名仍实际校验。WSS/Direct、正式部署 TLS、多页资金竞态、changetip、FT05 归集、真实 B/超时后入块补回、外部用户 BitFS 取用与完整分页边界仍按原矩阵保留待验证。正文是当前作者的本机 MSFile 内容，不能冒充远端读者下载验收。


### 2026-10-09：双客户端帖子购买冒烟结果

保留原 `J-REAL-FORUM-SMOKE`，新增独立的 `J-REAL-FORUM-PURCHASE`。最终运行 `forum-mv0t0fwj-8c2c3c7835dc` 的 Playwright 结果为 **1 passed（3.5 分钟）**；公开证据保存在 `e2e/runs/forum/forum-mv0t0fwj-8c2c3c7835dc/state/purchase.json`，协议与资金归档同时保留可复核的原始 Base64 字节。

- 两个独立 Chromium 进程、不同 Key/钱包、IndexedDB、Worker 与 Host；不是同一页面或同一客户端内部购买。
- 每次运行使用官方 Go genesis 程序创建并真实广播临时论坛根，避免空数据库回放旧根历史影响最小冒烟；不写入虚假索引、不跳过高度扫描。
- 卖方正常 UI 发布帖子；交易 `62bb38a08bb522c6c71cf598eb9587366ac4c230aaf879af0ad3742d89e8890e` 由真实 Go 服务自主索引为 **mempool（A）**，无需等入块。
- 买方从真实论坛页面取得 hash，再用已有 MSFile Hash 需求发现卖方并购买；没有向买方指定卖方地址或直接传正文。卖方是此次网络内唯一持有该文件的节点。
- 买方完成、卖方关闭、资金池关闭；关池交易 `302427055d24c28a165b3f10a14080bb245fba3b7d23f48d6a83480aea1265d3` 的真实输出核验卖方收到 **2 sat**。
- 下载正文与原始 Markdown 逐字节一致。关闭卖方浏览器后，买方在正常 SPA 路由内重新阅读本地 MSFile，未新增付款计划；不把背景对账标志变化当作重复付款。

实际链路中修复了 P2P lane 注册标识冲突、MSFile Worker 缺失 BitFS 控制接线、DER 签名长度导致费用迭代震荡，以及关池记录与背景输入对账的 revision 冲突。修复复用现有 Host、买方执行队列、资金账本及 CAS，不建立另一套资金或内容仓储；重试只覆盖本地 CAS 和只读观测，不自动重复付款。

最终验证：`test:types`（107 契约、287 Worker 模块）、全量单元测试（305 个文件）、生产构建与生产产物检查、边界/React/存储命名检查、覆盖矩阵和 `git diff --check` 通过。

范围仍是最小真实冒烟。当前证明的是正常 SPA 导航和卖方离线后的本地命中，未证明浏览器硬刷新或重启恢复；附件、完整分页、FT05、资金交错、真实 B/超时后入块补回和正式部署等仍按原矩阵保留待验收。历史失败运行保留原结果与对账证据，不改写成通过。
