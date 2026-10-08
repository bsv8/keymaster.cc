# Forum 客户端需求

> 状态：已确认需求；实现见[施工单](./Forum客户端施工单.md)与其状态更新。
> 本文的范围与协议基线保持不变；已被实现推翻或细化的判断只在施工单里记录。
> 日期：2026-10-05。
> 配套文档：[Forum 客户端施工单](./Forum客户端施工单.md)。
> 服务端基线：`/home/david/Workspaces/BSV8_Forum` 当前工作区的协议解析、业务服务与索引实现。
> 实现完成后将稳定行为合并到现行主题文档，提案过程由 Git 历史保留。

## 1. 目标

Keymaster 作为 BSV8 Forum 的客户端，连接论坛服务器获取板块、帖子、回复的索引和分页信息，
通过 MSFile 获取具体内容并统一存入 MSFile，由 Forum 插件解析、展示和提供发帖操作。
客户端生成符合服务端协议的作者签名和链上交易，使 Forum 能独立从 raw 交易恢复数据并正确索引。

职责固定为：

| 模块 | 职责 |
| --- | --- |
| Forum 服务器 | 论坛树索引、分页、节点元数据、回复价格、索引报价与索引状态 |
| Forum 插件 | 论坛配置、浏览、阅读、Markdown 解析展示、草稿、签名发布与状态协调 |
| MSFile 插件 | 正文和附件的查找、获取、完整性验证、统一存储和本地读取 |
| Vault | Worker 内受控签名和会话失效处理 |
| P2PKH | 资金准备、输入占用、交易输入签名与统一广播 |
| Window P2P | 唯一浏览器 libp2p Host 与 Forum 网络 lane |

Forum 不建立第二套正文、种子或文件块仓库，不直接读取 MSFile 私有路径，不取得私钥。

## 2. 范围

本期包含：

1. 多论坛配置、创世根与服务身份核对。
2. HTTPS、libp2p WSS、WebRTC Direct 连接适配，同一套 roundtrip 请求与响应校验。
3. 板块、帖子、回复树分页浏览和单节点查询。
4. 通过 MSFile 获取正文、统一保存、验证后解析展示；本地已存内容可离线阅读。
5. 创建板块、发帖、回复和作者修改节点回复价。
6. 专用资金准备、无找零协议交易、广播、索引跟踪和重启恢复。
7. 自有 Forum 数据输出与打赏输出的识别、保护和显式归集能力。

本期不包含全文搜索、链上正文、帖子原地编辑、替用户创建论坛创世、论坛管理声明、
自动无限读取付费正文、改变 BSV8 Forum 的签名对象或放宽服务端输出数量。
链上正文 hash 不可修改，后续补充内容通过新回复发布。

## 3. 协议基线与字段

服务端真值优先采用当前实现：`internal/service/service.go`、`internal/protocol/layout.go`、
`internal/protocol/messages.go`、`internal/protocol/signature.go`、`internal/indexer/validate.go`。
原始需求中的旧 JSON 数字示例和“待实施”文字不能替代当前解析规则。

| 字段 | 中文含义与规则 |
| --- | --- |
| `forum_txid` | 固定创世根 txid；后续论坛声明不替换此 ID |
| `forumpublickey` | 配置的论坛服务公钥，用于响应和 indexSig 验证 |
| `parent_txid` | 新节点的父交易 ID；changetip 中为被改价节点 ID |
| `parent_publickey` | 父节点作者的压缩公钥 |
| `clientpublickey` | 当前发帖作者公钥，写入数据输出末尾 |
| `reply_masterseedhash` | 种子文件的 SHA-256，非正文的直接 SHA-256 |
| `tip_price` | 新节点初始未来回复价；changetip 中为目标的新价格 |
| `parent_tip_price` | quote_reply 响应中的本次父作者付款金额 |
| `payto_publickey` | 本次报价指定的索引费收款公钥，可与论坛服务公钥不同 |
| `index_price` | 本次索引费，单位 sat |
| `last_block_height` | 原索引报价适用的最高区块高度 |
| `operatorSig` / `indexSig` | 作者业务签名 / 论坛索引报价签名 |
| `snapshot_height` | 列表确认部分的快照高度 |
| `mempool_revision` | 列表内存池视图版本 |
| `next_cursor` | 服务端不透明分页游标，null 表示当前视图已读完 |

金额和业务高度按接口约定使用规范十进制字符串；内部金额用 bigint。
txid/hash 使用 64 字符小写 hex，公钥使用 33 字节压缩 SEC1。

## 4. 配置、连接和信任

论坛配置至少包含本地配置 ID、网络、固定根 txid、论坛公钥、启用的连接地址及显示别名。
同一网络下相同根和服务公钥可以配置多个地址；地址不替代身份，更新公钥须重新验证根。

首次连接下载根 raw，检查 txid、固定输出结构和 forumSig，核对两个输出中的论坛公钥。
forumSig 从当前声明的名称、价格和全部 input outpoint 顺序重建，采用当前四项数组规则，
拒绝旧三项形式。网络配置必须与资金和广播网络一致。

HTTP 入口为 `POST /roundtrip`；libp2p protocol ID 为 `/roundtrip/1`。
WSS 是 libp2p transport，不使用普通 WebSocket JSON；WebRTC Direct 地址包含实际部署的
PeerId 与 certhash，并按 SDK 完成认证。复用 Window P2P 的 Host，Forum 不另建 Host。
HTTPS 部署需要允许 Keymaster 来源的 CORS/OPTIONS；WSS/TLS 与 Direct locator 由部署提供。

客户端采用完整 roundtrip 响应，校验签名、from、to 和 reply_to，禁止只以 HTTP 200 判断成功。
libp2p 对端 PeerId 必须对应配置的论坛公钥；本地连接身份须与 roundtrip from 一致。
请求过期、nonce 和重放规则由同版本 roundtrip SDK 处理。

锁定、切 Key、重置或撤销 Scope 时中止连接与新签名，迟到结果不得写入新会话。
已有发布任务保留公开证据，恢复时重新取得当前身份的能力，不恢复旧授权句柄。

## 5. 浏览、分页和索引展示

| 操作 | 参数及展示 |
| --- | --- |
| `list_boards` | forum_txid；根的直接子节点，深度 1 |
| `list_posts` | board_txid；板块的直接子节点，深度 2 |
| `list_replies` | parent_txid；深度至少 2 节点的直接子节点 |
| `get_node` | txid；节点详情、论坛归属和最新索引状态 |

页面提供论坛列表、板块列表、帖子列表、帖子阅读与按需展开的回复树。
默认页大小 20，上限 100；保留服务端顺序，不按本地时间重新排序。
确认节点按链位置排序，内存池节点位于其后，内存池顺序不解释为确认先后。

游标绑定论坛、操作、父节点与页面世代，不解析、不修改、不跨父节点复用。
有 cursor 时不再传 snapshot_height。各层默认独立视图，同一列表不能混拼不同快照。
收到 SNAPSHOT_INVALIDATED 后撤销该列表旧请求，重新读取第一页并替换旧页集合；
用户阅读位置可以保留，但不得把旧游标续接到新视图。
连续失效时停止自动循环并提供刷新入口。末页不表示未来不会出现新回复。

索引信息包括作者、初始/确认/有效回复价、内容 hash、has_children、链上状态与位置。
根通过 get_node 获取当前名称及声明来源，始终使用固定根 txid 导航。
本地保存的索引缓存须标明离线或旧快照，不能作为当前报价与付款的真值。

## 6. MSFile 正文获取与唯一存储

阅读链路：Forum 索引 → reply_masterseedhash → MSFile 内容任务 → 本地可读内容 → Forum 解析。

MSFile 先检查当前钱包已有内容，缺失时经现有供应商/已实现来源获取。
来源选择、价格策略、网络并发、失败重试和内容落盘属于 MSFile；Forum 只持有任务引用及状态。
新增能力必须与 [BitFS/MSFile 提案](../msfile/BitFS本地代理与卖方模式需求.md) 协同，
不能把该提案中未验收的路径当作本功能已具备的能力。

统一使用现有 msfiles 的 seeds、storage、meta 布局，由 MSFile 内部写入。
种子 hash、块 hash、块顺序、长度及完整源文件与种子对应关系全部验证通过后才标记完整。
供应商文件名、MIME 与长度声明只是元数据；不得凭 metadata 或任务成功标志绕过内容验证。
块可渐进保存，但不完整文件不能作为已验证的完整 Markdown 返回。
相同 hash 的并发请求合并；多个节点共享当前钱包同一份内容。
取消一个消费者不应终止其他消费者仍需要的任务。

Forum 不复制正文，不保存 HTML 渲染结果作为内容真值。允许保存可重建的标题/摘要投影，
必须绑定内容 hash 和解析版本。删除 Forum 配置不删除 MSFile 内容；用户在 MSFile 删除内容后，
Forum 的可用状态和投影须失效，下一次阅读可重新获取。

正文状态至少有：未获取、获取中、部分已存、完整且已验证、暂时不可达、验证失败。
索引失败与正文失败分别显示；正文不可达时仍显示节点和回复结构。
本地完整正文断网后仍可阅读，展示的价格和索引状态标为缓存。
点击阅读可能触发付费获取，执行现有 MSFile 用户价格策略；列表不得自动无限购买正文。

## 7. Markdown 内容规范和展示

第一版正文定义为 UTF-8 Markdown，无 BOM；新建内容发布时统一换行为 LF。
发布后原始字节冻结，读取时不通过换行或 Unicode 归一化重新定义内容 hash。
第一版正文上限建议定为 1 MiB（正文文件，不含附件）；超限内容保留索引并提供文件入口，
不直接送入 Markdown renderer。读取前和读取过程中都执行体积限制。

标题取首个一级标题，缺失时使用首个非空文本行的截断投影，再缺失时显示短 txid。
摘要来自已验证正文；未取得正文的列表项显示作者、hash 和获取入口。
读取优先级为当前打开的正文、用户展开的回复、可见列表项的本地投影。

关闭 raw HTML 与脚本执行；链接采用协议白名单，外链由用户打开。
不得因远程 Markdown 自动请求任意 HTTP 图片。正文中的 MSFile 附件采用
`msfile:<64字符小写seedhash>` 引用，图片和附件统一经过 MSFile 获取、验证与读取。
该语法是客户端内容约定，不改变 Forum 链上协议；附件价格和大小限制由 MSFile 执行。
资源 URL、订阅和解析结果绑定页面 Scope，退出或身份失效时释放。
附件未获取不阻塞正文，展示独立占位和获取入口。

## 8. 作者签名、报价和链上布局

roundtrip 请求身份、operatorSig 签名身份和 vout 1 的 clientpublickey 必须相同。
作者业务签名采用确定性 CBOR 固定数组、单次 SHA-256、严格 DER 与 low-S；
不使用 Connect intent.sign 的信封，也不把其 compact 签名转换后冒充业务签名。
Worker 接收结构化参数，内部重建和校验签名字节，页面不能提交任意 digest 要求签名。

reply 的签名对象：

```text
operatorSig = ["bsv8.reply.1", parent_txid, parent_publickey,
               reply_masterseedhash, tip_price]
indexSig    = ["bsv8.reply.1", parent_txid, parent_publickey,
               reply_masterseedhash, tip_price, operatorSig,
               payto_publickey, index_price, last_block_height]
```

CBOR 中 txid/hash 为展示顺序的原始 32 字节 byte string、公钥为 33 字节、签名为 DER 字节、
整数为 uint64。链上整数采用最短无符号大端字节，零为单字节 0x00；push 必须符合 Go 解析器。
业务 DER 不追加 sighash 字节；交易输入签名采用 BSV SIGHASH_ALL | FORKID（0x41）。

| 输出 | 金额 | 脚本 |
| --- | --- | --- |
| vout 0 | index_price | payto_publickey OP_CHECKSIG |
| vout 1 | 固定 1 sat | reply 数据及 clientpublickey OP_CHECKSIG |
| vout 2 | 父节点生效回复价 | bsv8.tip.1 OP_DROP、parent_txid OP_DROP、parent_publickey OP_CHECKSIG |

vout 1 依次 push：kind、parent_txid、parent_publickey、reply_masterseedhash、tip_price、
operatorSig、last_block_height、indexSig、clientpublickey；最后一项接 OP_CHECKSIG，其余接 OP_DROP。
父价格为零时省略 vout 2，第一版不生成零值打赏。reply 无普通找零输出，最多三个输出。
索引费为零仍保留 vout 0，不能因此改变固定输出位置。

修改回复价使用 quote_changetip，仅目标作者可操作：

```text
operatorSig = ["bsv8.changetip.1", parent_txid, tip_price]
indexSig    = ["bsv8.changetip.1", parent_txid, tip_price,
               payto_publickey, index_price, last_block_height]
```

changetip 恰好两个输出，vout 0 为索引费，vout 1 固定 1 sat。
数据顺序为 kind、parent_txid、tip_price、last_block_height、operatorSig、indexSig、clientpublickey，
同样逐字段 OP_DROP 后接作者锁。它是价格事件，不创建新的回复树节点。

## 9. 发布、资金和恢复

发布顺序：冻结正文 → MSFile 保存与可达性准备 → 获取父节点 → operatorSig → quote_reply
→ 验响应与 indexSig → 确认费用 → 专用资金准备 → 报价复核 → 无找零交易 → 广播 → 索引跟踪。
内容只存本地不等于读者可取得；展示当前发布来源/可达性证据，渠道缺失时保留草稿并说明状态。
MSFile 的发布/供应能力通过其自身服务提供，Forum 不自行上传到另一套内容服务。

专用资金 UTXO 来自普通 P2PKH 资金准备交易，该交易可以找零。
Forum 交易消费专用资金，不把钱包大额余额差直接给矿工。
资金金额为固定输出总额加保守矿工费预算；实际差额只在用户确认的预算内成为矿工费。
按输入签名长度上界计算预算，完成签名后复核实际费率和总额，禁止追加找零或增加索引费消化余款。
报价/父价格变化需要重新确认；资金不足时重新准备，剩余专用资金可显式回收。

协议金额支持 uint64；现有钱包 number 边界超出安全整数时明确拒绝，不截断、不隐式转换。
支持零值索引输出所需的 wallet 构建校验需显式适配，是否被实际矿工接受以真实网络验收为准。

所有资金交易和协议交易通过同一个输入 claim/广播中心，持久化最终 raw 与 canonical txid。
广播结果未知时先对账原交易，不自动构建重复付款；已派发/未知的输入不得提前释放。
恢复不能仅用页面内存的 operation ID，任务必须引用持久 submission ID。

自有 1 sat 数据输出和 tip 输出采用特殊脚本识别，普通 P2PKH 选币不能误花。
归集取回真实 prevout raw，使用完整锁定脚本作为 scriptCode，不能只保留末尾公钥锁。
花费一个有效帖子的数据输出不解释为删除帖子；Forum 索引跟随交易有效性而非输出是否已花费。

## 10. 索引状态与协议限制

Forum 当前没有 submit/broadcast 业务操作，客户端广播后服务端扫描报价收款公钥发现交易。
发布 UI 分别保存广播状态、链上观测状态和 Forum 索引状态。
reply 通过 get_node(发布 txid) 跟踪；返回 mempool 为暂时已索引，confirmed 为已确认索引。
未找到不能直接判定无效或未广播；可显示等待发现、重试和交易证据。
changetip 不是节点，不用 get_node(changetip txid) 查询成功；结合链上观测和目标节点价格刷新，
当前接口不能精确证明某一修改事件被接受，应标为“事件接受证据不可查询”，不伪造结果。

父价格在报价后可变化；确认按真实链序重验，不符时服务端可撤销回复及依赖子树。
超过 last_block_height 后，实际确认高度价格高于已付索引费才无效，持平/下降仍可能有效。
客户端广播前复核可缩小窗口，不能承诺报价保证最终索引。
对需要精确事件/拒绝原因的后续功能，另设计服务端查询扩展，本期不调用不存在的接口。

## 11. 验收标准

1. TS 作者签名及最终 raw 被当前 Go Forum 正确验签、解析和索引。
2. 实际从服务器分页获取板块/帖子/回复，失效游标刷新后无混页和串父节点。
3. 正文经 MSFile 获取并出现在 MSFile 存储；Forum 无正文副本；重启后可本地读取。
4. 错误种子/块、部分文件、危险 Markdown 和不可达来源有明确状态，不渲染未验证正文。
5. 板块、帖子、回复及作者 changetip 流程可执行，费用项和三种回复价格含义清楚。
6. 零/非零父价格、零索引费、无找零资金、真实 FORKID 输入签名通过互操作验收。
7. 锁定/切 Key/多页面/重启和广播未知不串身份、不重复付款、不释放已派发输入。
8. 真实浏览器验证 HTTPS/WSS/Direct 配置、CORS/TLS、内容读取与广播索引全过程。
9. 自有特殊输出可正确识别并显式归集，索引保持符合服务端规则。

验收证据统一写入现有集成测试覆盖矩阵；未通过项明确保持未完成。
