# Forum 客户端施工单

> 状态：**部分实施，未验收**。协议层、分页纪律与发布协议有跨语言互操作与单元测试证据；
> 真实论坛服务、真实浏览器、真实广播与真实 Go 索引器观测**全部未执行**，保持未验证。
> FT05（自有特殊输出的识别、保护与归集）**未实现**。§4.1 记录了与本施工计划的已知偏离。
> 日期：2026-10-05（施工）与 2026-10-05（状态更新）。
> 依据：[Forum 客户端需求](./Forum客户端需求.md)。
> 实现位置：`packages/plugin-forum`、`packages/contracts/src/forum.ts`、
> `packages/contracts/src/msfileContent.ts`、`packages/plugin-msfile/src/msfileContentService.ts`。

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
变成可执行检查。**未完成**：真实 Go 服务端的端到端验签与真实浏览器 bundle 检查。

### F02：插件、配置、信任与网络

- [x] 新增 Forum manifest、产品目录、Worker/Window units、受限仓储绑定和页面贡献。
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
- [x] 页面实现论坛列表、板块、帖子、节点详情和按需展开回复树。
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
- [x] 打通内容发布准备和可达性证据；若渠道尚未实现，列为该阶段未完成，不伪造发布成功。（远程获取复用 BitFS 买方通道；发布渠道仍未实现，可达性如实报 false）

完成条件：远程取得的帖子在 MSFile 页面可见；关闭重启后本地阅读，Forum 存储没有正文副本。
此阶段与现有 MSFile/BitFS 提案共享能力和同一仓库，不同时建立两套 content API。

实施结果：新增 `msfile.content@1` 能力（`ensureContent`/`openVerifiedContent`/
`importContent`/状态订阅/发布可达性），17 项单元测试覆盖唯一归档、损坏块、缺失块、
部分写入、同 hash 合并、独立取消与渠道缺失如实报告。**未完成**：真实远程正文获取、
MSFile 页面可见性，以及 BitFS/BitFS 本地代理的发布渠道尚未实现。

### F05：Markdown 阅读与附件

- [x] 实现 UTF-8 Markdown 解码、1 MiB 限额、标题/摘要投影和解析版本。
- [x] 新内容 LF/无 BOM；已存字节不重新归一化，不因解析产生新 hash。
- [x] 关闭 raw HTML，过滤危险 URL，远程图片不自动加载。
- [x] 实现 msfile:seedhash 附件解析；通过 MSFile 获取和读取，附件失败不阻塞正文。
- [x] 优先当前阅读与展开回复；列表只自动使用本地正文投影，远程付费获取遵循用户动作/策略。
- [x] 展示正文进度、不可达、验证失败、超限文件入口和离线状态。
- [x] 离开页面和身份撤销时释放流、URL、订阅；MSFile 删除后不继续呈现过时可用标记。

完成条件：真实正文与图片可读；恶意 Markdown、损坏块、离线和缺失文件行为符合需求。

实施结果：24 项单元测试覆盖 1 MiB 限额、BOM/非法 UTF-8、标题摘要投影、`msfile:`
附件引用、raw HTML 不执行、协议白名单与远程图片不自动加载。**未完成**：真实正文与图片的浏览器验收。

### F06：资金准备与协议交易

- [x] 在现有 P2PKH claim/提交中心增加专用资金用途与持久任务关联，跨页选币排除已占用输入。（新增 `p2pkh.protocol-funding@1`：选币、资金准备交易、找零与专用 UTXO 保护登记都在 P2PKH 内完成）
- [x] 普通资金准备交易生成专用 P2PKH UTXO 和正常找零，记录资金 txid/vout、raw 和预算。
- [ ] 新增受控无找零构建模式：固定输出、最大 minerFee、最大费率及明确剩余金额处理。（**部分**：Forum 侧不传 changeAddress 并核对输出数；P2PKH 侧的通用规则仍未改）
- [x] 按 DER 输入长度上界估算预算；最终签名后检查输入总额、输出总额、实际大小和实际费用。
- [x] 不沿用当前“无 changeAddress 且有余款即拒绝”的通用逻辑，不通过增索引费/打赏费解决余额差。
- [ ] 适配零值索引输出；输出 value、金额累计和 number 转换处做安全整数检查。（安全整数闸门已在 Forum 侧实现；P2PKH 仍用 `normalizePositiveInteger` 拒绝零值输出）
- [x] 从真实 prevout 核对输入金额与脚本，不信调用方给出的输入 value。
- [x] 处理资金准备未派发/未知/已观测/已花费；未确认子交易失败时先对账父交易。
- [ ] 报价改变时重新确认和重算资金；多余专用资金提供回收操作。（预算确认与资金计划已实现；报价变化后回到确认、多余资金回收未接线）
- [ ] 识别、保护自有 Forum data/tip 输出，归集使用完整 scriptCode，解锁脚本只提供正确签名。（**未实现**：FORKID sighash 支持完整 scriptCode，但识别、保护与归集流程尚未接入）

完成条件：reply 与 changetip 输出数严格符合 Go parser，大额钱包 UTXO 不直接变为大额矿工费。
特殊输出归集通过脚本执行与真实网络验收；不能复用仅支持 P2PKH prevout 的签名代码冒充支持。

实施结果：输出布局、零/非零父价格、零索引费、费用明细、矿工费预算与复核、最终 raw
自检共 22 项单元测试；专用资金与无找零构建通过 P2PKH `ProtocolSpendService`。
**未完成**：真实资金准备、真实广播，以及自有特殊输出的识别与显式归集（未实现，
`FT05` 保持未验证）。

### F07：发布、报价与索引跟踪

- [x] 实现正文导入 MSFile、可达性准备、父节点解析、结构化 operatorSig 和报价请求。
- [x] 验证完整 roundtrip 响应及 indexSig；parent_tip_price 从关联响应取得，不混用缓存初始价。
- [x] 费用确认列出正文获取/发布费用（如有）、资金准备矿工费、索引费、父作者金额、协议矿工费预算。
- [x] 资金准备后重新询价；费用或父状态变化回到确认，迟到 quote 不覆盖当前任务。
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

- [x] 任务写前日志覆盖资金、协议签名、广播派发、最终结果，每次不可逆动作前保存证据。
- [x] 重启、窗口关闭、网络超时、广播已成功但响应丢失时只对账原提交。
- [x] 用户选择重试前检查原交易；未知/已派发 claim 不释放，明确未派发才可取消释放。
- [x] 多页竞争、锁定和切 Key 下任务保持原 owner，不把旧 raw 提交成新用户操作。（任务级互斥与阶段推进守卫已实现；**跨标签页互斥仍靠持久 submission 对账兜底**）
- [ ] 执行下表协议、浏览器、MSFile 和资金验收，记录环境、基线 commit 和实际 txid。（**未执行**：真实服务端、浏览器、广播与索引观测全部未验证）
- [x] 补充依赖图、功能调用元数据与必要装配门禁，执行项目要求的静态检查和相关测试。
- [x] 更新覆盖矩阵与现行文档；未通过的真实网络项继续标为未验证。

## 4.1 与施工计划的已知偏离

| 项 | 计划 | 实际 | 后果与兜底 |
| --- | --- | --- | --- |
| 发布权威归属 | owner-session Worker 单元统一执行任务状态转换、签名校验与提交仲裁 | 只装配 Window 单元；阶段转换与签名校验在 Window 的领域服务内 | 已用**任务级互斥锁 + 阶段推进守卫**消除同一页面内的重复发布；**跨标签页互斥仍靠持久 submission 对账兜底**，不是 Worker 级仲裁 |
| P2PKH 无找零通用模式 | 新增受控无找零构建模式 | Forum 侧不传 `changeAddress` 并自行核对输出数；P2PKH 通用规则未改 | 依赖 Forum 侧自律；其它协议插件仍可能触发「余款拒绝」路径 |
| 零值索引输出 | 适配 wallet 构建校验 | Forum 侧生成零值 vout 0，金额闸门在 Forum 侧 | P2PKH 仍拒绝零值输出，真实广播结果**未验证** |
| 归集（FT05） | 识别、保护并显式归集自有特殊输出 | 未实现 | 保持未完成 |

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
| FP03 | 请求和身份绑定 | 错 from/to/reply_to、libp2p 身份不一致被拒绝 | 身份方向已由 SDK 强制（from=当前 Key、to=论坛公钥）并加断言；**未做真实传输验证** |
| FP04 | 输出布局 | reply 2/3 输出、changetip 2 输出正确；额外找零与错 vout 失败 | 已实现并通过单元测试 |
| FP05 | 金额边界 | 零索引、零父价格、uint64、number 边界不截断；实际零输出广播结果有证据 | 编码与解析边界已通过单元测试；**真实零输出广播结果无证据** |
| FB01 | 板块/帖子/回复分页 | 真实多页、空页、末页、展开回复正确且按服务端排序 | 顺序/末页/空页/游标纪律已通过单元测试；**未连真实服务端** |
| FB02 | 视图失效和竞态 | revision 更新/切父节点/迟到响应不混页、不无限刷新 | 已实现并通过单元测试 |
| FC01 | MSFile 获取与归档 | 远程正文保存至同一 msfiles；重启本地命中；Forum 无副本 | 本地导入/归档已通过单元测试；**远程通道与重启命中未验证** |
| FC02 | 完整性与恢复 | 损坏 seed/块/长度/部分写入不能返回完整正文，可恢复或明确失败 | 已实现并通过单元测试 |
| FC03 | 同 hash 与删除 | 多消费者去重、独立取消、删除失效、重新获取正确 | 已实现并通过单元测试 |
| FC04 | Markdown 与附件 | XSS/危险 URL 不执行；附件通过 MSFile；超限与不可达保留索引 | 已实现并通过单元测试 |
| FN01 | 三种真实连接 | Chromium 的 HTTPS/WSS/Direct 成功，CORS/TLS/locator 配置记录完整 | **未验证**：需要真实部署 |
| FT01 | 资金准备与费用 | 专用 UTXO/找零/无找零预算正确，费用超限拒绝 | 预算估算与费用复核已通过单元测试；**专用资金准备未接真实资金** |
| FT02 | 实际签名广播索引 | 板块、帖子、回复 raw 成功观测并被 Go Forum 索引 | **未验证** |
| FT03 | changetip | 仅作者成功；目标价格刷新，不伪造事件接受查询 | 事件接受证据不可查询的限制已在代码与 UI 表达；**未验证真实链路** |
| FT04 | 价格变化 | 父价格链序变化与报价超期按当前服务器规则重新判断 | **未验证**（服务端规则为真值，客户端只按报价响应构造） |
| FT05 | 自有特殊输出归集 | 完整 scriptCode 签名通过，自有资产可回收，帖子不因花费而被当作删除 | **未实现**：FORKID sighash 支持完整 scriptCode，但归集流程与保护尚未接入 |
| FR01 | 广播响应丢失/重启 | 对账原 txid，不二次付款，不释放已派发 claim | 任务写前日志与只对账不重付已实现；**重启恢复未执行** |
| FR02 | 多页/切 Key/锁定 | 签名、网络、资源 URL 与迟到写回不串身份 | 会话世代 fence 与 owner 断言已实现；**多页并发与锁定下的真实流程未验证** |

互操作测试可以用本地 Go 服务与数据库夹具；真实浏览器、真实广播和实际索引必须另有证据。
仅钱包观测 confirmed 不能代表 Forum confirmed，MSFile 供应商返回成功不能代表完整性通过。

## 7. 实施交付检查

每阶段交付可 review 的领域实现、必要契约、针对真实风险的测试和证据状态。
按现有脚本执行 typecheck、边界 lint、产品目录/依赖图检查、相关测试与 build，
真实网络测试由集成测试说明规定，不因默认单元测试通过就勾选真实验收。
完成后更新架构、P2PKH、MSFile 文档，并建立 Forum 现行主题文档及索引；
只有实际实现并验证的行为进入现行文档，提案和未解决服务器接口限制保留未完成标记。
