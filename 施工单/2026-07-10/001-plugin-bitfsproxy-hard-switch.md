# plugin-bitfsproxy 硬切换一次性迭代施工单

## 目的与硬切换缘由

在 Keymaster 新建 `plugin-bitfsproxy`，作为 BitFSProxy 的唯一管理客户端。浏览器无法承担 BitFS P2P，因此插件只管理远端节点的钱包、文件和下载；不实现 BitFS、CastMessage、AppMsg 或 HubCast 客户端。

本次一次性新增正式插件，不创建临时 IPFS 名称、兼容 capability、旧页面或双入口。插件名称固定为 `plugin-bitfsproxy`，避免 BitFS 与 IPFS 混淆。

## 文件级改动

| 文件/目录 | 一次性改动 |
| --- | --- |
| `packages/contracts/src/bitfsproxy.ts` | 新建 Proxy 管理协议类型、状态、目录、下载、价格、删除、块读取与错误码契约。 |
| `packages/contracts/src/index.ts` | 导出 BitFSProxy 契约。 |
| `packages/plugin-bitfsproxy/package.json`、`tsconfig.json` | 新建插件包与依赖边界。 |
| `packages/plugin-bitfsproxy/src/manifest.ts` | 注册设置、导航、页面和所需 P2PKH/vault capability。 |
| `packages/plugin-bitfsproxy/src/bitfsproxyConnection.ts` | 管理 WSS 二进制帧、挑战签名认证、请求关联、断线状态；不含自动命令重放。 |
| `packages/plugin-bitfsproxy/src/bitfsproxyService.ts` | 节点信息、充值、sweep、下载、目录、价格、删除和块读取的 typed facade。 |
| `packages/plugin-bitfsproxy/src/bitfsproxySigner.ts` | 只经 vault 闭包对挑战签名，禁止导出私钥。 |
| `packages/plugin-bitfsproxy/src/bitfsproxyStore.ts` | 保存非敏感 Proxy 地址与界面状态；不保存私钥、管理员签名、文件字节或钱包余额真值。 |
| `packages/plugin-bitfsproxy/src/pages/` | 节点概览、库存搜索、下载状态、价格与危险操作确认页面。 |
| `packages/plugin-bitfsproxy/src/blockReader.ts` | 请求 256 KiB block，供 Keymaster 自己缓存、拼接和渲染。 |
| `packages/plugin-bitfsproxy/src/*.test.ts` | 认证、断线、P2PKH 充值、目录分页、价格、删除确认和块等待测试。 |
| `apps/web/src/bootstrapPlugins.ts` | 装配新插件。 |
| `apps/web/package.json`、`apps/web/src/styles/plugins.css` | 声明插件依赖并接入最小样式入口。 |

## 必须做到

- 管理 WSS 认证使用当前 Keymaster 管理员私钥签挑战，不泄露私钥；
- `node.info` 展示节点公钥与充值地址，充值经既有 P2PKH 用户确认流程发起；
- sweep、删除文件和价格变更必须在插件 UI 中显式确认；
- 文件搜索使用 Proxy 会话/游标，空关键词可列全库；
- 文件读取走 `file.block.read`，插件自行缓存与拼接，不走 HTTPS；
- 块未就绪时展示等待/下载状态，支持按目标块读取以服务视频跳转；
- 插件不连接 CastMessage、AppMsg 或 HubCast，不保存 BitFS 业务真值。

## 禁止做法

- 以 `ipfs-plugin`、`plugin-ipfs` 或旧名字注册任何入口；
- 在浏览器实现 BitFS P2P、消息发现、支付、仲裁或文件报价；
- 直接 fetch Proxy 文件路径、提供 HTTPS 播放 URL 或将文件内容落入持久化 DB；
- 断线后自动重放 sweep、删除、定价或下载命令；
- 绕过 P2PKH 服务自行构造 Keymaster 充值交易。

## 特殊情况

- Proxy 未就绪：只展示状态，禁止资金和文件操作。
- 管理员不在 allowlist：认证失败，清除会话，不重复尝试业务命令。
- 充值已提交但 Proxy 未见余额：以链上同步为准，插件不伪造到账成功。
- sweep/删除/定价操作断线：用户重新查询 Proxy 真值，不自动猜测结果。
- 搜索会话过期：保留关键词，回到第一页。
- 块读取断线或超时：丢弃本次读取，用户或播放器按同一块重新请求；不重复创建下载任务。

## 最终验收清单

- [ ] `plugin-bitfsproxy` 被 web 装配，且不存在 IPFS 旧入口。
- [ ] 管理员挑战签名成功；非管理员、错误签名、过期挑战被拒绝。
- [ ] 节点信息与充值地址可见；充值只能经 Keymaster P2PKH 确认流程提交。
- [ ] sweep、价格设置与文件删除均有明确确认，断线后不自动重放。
- [ ] 文件搜索支持空关键词、分页及会话过期恢复。
- [ ] 单文件零价、默认价回退与价格来源均被正确展示。
- [ ] 下载状态能展示发现、报价、传输、支付、仲裁和终态失败。
- [ ] 已有块可返回；缺块只在已有下载任务下等待并返回，播放器可请求中间块。
- [ ] 插件不连接 CastMessage/AppMsg/HubCast，不含 BitFS P2P 实现。

## 插件职责、边界与用户流程

`plugin-bitfsproxy` 是管理员桌面客户端，不是 BitFS 节点。它只连接用户明确配置的 Proxy 管理 WSS；不连接 CastMessage、AppMsg、HubCast，也不缓存或转发发现需求。插件没有自己的 BSV 热钱包，节点链上付款由 Proxy 完成；Keymaster P2PKH 只用于用户向 Proxy 收款地址充值。

正式用户流必须如下：

1. 用户在插件设置页填入 Proxy WSS URL，插件不从网页、广播或联系人自动发现 URL。
2. 用户选定当前 Keymaster key；连接层收到 Proxy challenge 后只通过 vault 闭包签名，提交公钥与签名。
3. `node.info` 成功后显示 node 公钥、主网 P2PKH 地址、节点 P2P IP/port、sweep reserve、目录/下载摘要和连接状态。
4. 用户点击充值，插件调用既有 P2PKH service，显示 Proxy 地址、金额和手续费，由用户确认后提交；Proxy 是否到账只由其后续 `node.info`/钱包状态决定。
5. 下载必须由用户填写 seedHash、总预算、seed/block 单价上限和仲裁点。插件不能因播放或读取自动创建下载任务。
6. 读取文件时，播放器/查看器按需请求 `file.block.read`；本地把字节保存在短生命周期内存缓存，自己处理拼接、视频跳转、图片/文档解析。
7. sweep、单文件调价、默认调价、删除文件都必须显示不可逆影响并由用户确认；任一断线都回到查询真值，绝不重发。

## 管理 WSS 契约要求

管理 WSS 是本次新协议，必须由 `packages/contracts/src/bitfsproxy.ts` 作为 Keymaster 内唯一 TypeScript 真值。该文件至少定义：

- `BitfsProxyInfo`：ready、主网、node 公钥、收款地址、公告 IP/port、sweep reserve、wallet/目录/下载摘要；
- `BitfsProxyDownloadStartInput`：seedHash、`maxTotalSatoshis`、`maxSeedPriceSat`、`maxBlockPriceSat`、arbiter 公钥、deadline；
- `BitfsProxyDownloadStatus`：阶段、预算、已付、报价、块可用位图、失败码；
- `BitfsProxyFileItem`：seedHash、displayName、mime、size、blockCount、available blocks、effective block price、price source；
- `BitfsProxySearchPage`：session、items、next cursor、catalog version；
- `BitfsProxyBlockReadResult`：seedHash、block index、raw bytes、实际长度、协议 hash、是否从等待下载获得；
- 固定错误码：`not_ready`、`not_authorized`、`invalid_request`、`search_session_expired`、`file_not_found`、`file_busy`、`download_not_found`、`block_wait_timeout`、`budget_exceeded`、`insufficient_sweep_balance`。

`bitfsproxyConnection.ts` 必须把 wire decode 与业务 service 分开：wire 层只收发 binary CBOR 固定数组、管理 pending request 和 close；service 层只暴露 typed 方法，不允许页面拼字符串 method 名或直接操作 WebSocket。二进制文件块必须经专门的 result/event 类型进入 `blockReader.ts`，不允许 Base64、JSON 数组或 IndexedDB 持久化。

## Keymaster 内部依赖和权限

manifest 只可依赖以下既有能力：vault（挑战签名）、keyspace（非敏感设置）、P2PKH service（充值）、navigation/setting registry、notice/log service。不得 import `plugin-p2pkh`、`plugin-appmsg`、`plugin-hubmsg`、`plugin-hubcast` 的内部源码；通过 contracts capability 交互。

当前 active key 不是 Proxy 权限真值。Proxy allowlist 是唯一授权源；插件可以用任何当前可用 Keymaster key 尝试 bind，但 bind 失败后只显示“该 key 不在管理员列表”，不能改写 Proxy 配置或切换 Keymaster active key。

## 页面与状态要求

| 页面 | 必须显示/允许 | 不允许 |
| --- | --- | --- |
| 设置页 | WSS URL、连接状态、当前签名 key、node 信息只读摘要 | 保存私钥、CastMessage 配置或发现频道。 |
| 节点概览 | 充值地址、余额摘要、reserve、sweep 入口、下载摘要 | 将 Proxy 余额冒充 Keymaster 钱包余额。 |
| 库存页 | 空关键词搜索、分页、文件元数据、默认/覆盖价格、删除入口 | 显示 workspace 路径、目录树或任意本机文件。 |
| 下载页 | 明确预算与状态、报价/支付/争议阶段 | 静默下载、自动提价、无预算读取。 |
| 文件查看器 | block 等待、缓存、连续读取和跳转请求 | HTTPS URL、全文件强制先下载、把 byte 持久化到插件 DB。 |

## 参考项目与阅读清单

以下是接口/协议的对照资料，不是可 import 的实现：

| 路径 | 施工者应提取的事实 |
| --- | --- |
| `packages/contracts/src/plugin.ts`、`settings.ts`、`navigation.ts` | 插件 manifest、设置与导航注册边界。 |
| `packages/plugin-hubmsg/src/hubmsgConnection.ts` | 二进制 WSS、pending request、bind、close 和 ping/pong 的浏览器实现风格；管理 WSS 需独立实现，不复用其业务协议。 |
| `packages/plugin-p2pkh/src/p2pkhService.ts` 与其 contracts | 充值只能经 capability 调用而非直接构造交易。 |
| `packages/plugin-poker/src/` | 外部代理插件的连接、身份签名、状态展示、断线不重放的分层参考。 |
| `/home/david/Workspaces/BitFSProxy/docs/需求.md` | Proxy 管理方法、错误语义、block 读取和安全边界的唯一产品输入。 |

## 更细的文件级测试要求

| 测试文件 | 最低覆盖 |
| --- | --- |
| `bitfsproxyConnection.test.ts` | 正确/错误/过期 challenge、单连接多 request、close 清空 pending、无业务重放。 |
| `bitfsproxyService.test.ts` | 所有 typed input/output 与错误码映射；禁止未认证调用。 |
| `bitfsproxySigner.test.ts` | vault 闭包收到正确 challenge，私钥不从接口返回。 |
| `blockReader.test.ts` | 已有块、等待块、跳转块、timeout、断线、内存缓存淘汰。 |
| `BitfsProxyInventoryPage.test.tsx` | 空搜索、分页、session 过期、零价、默认价回退、删除确认。 |
| `BitfsProxyNodePage.test.tsx` | 充值确认、sweep 保留额提示、断线后重新查询。 |

## 提交前附加验收

- [ ] `packages/contracts/src/bitfsproxy.ts` 是唯一跨包类型来源，页面没有重复 wire 类型。
- [ ] 插件全仓库搜索不到 `CastMessage`、`HubCast`、`AppMsg` 客户端连接代码或 BitFS P2P protocol ID。
- [ ] 全仓库搜索不到 `ipfs-plugin` / `plugin-ipfs` 正式注册项。
- [ ] 读取大文件不会把所有 block 写入 IndexedDB；内存缓存可释放。
- [ ] 管理 WSS 断线期间没有定时重试资金/删除/价格/下载请求，只有用户显式操作或连接恢复后的只读状态刷新。
