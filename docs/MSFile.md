# MSFile

MSFile 通过受控 P2P 网络按内容哈希查询和读取 Seed/Block。插件默认包含并启用官方 BSV8
供应商，local 来源也始终参与统一查询；用户自建供应商和金额策略才需要额外配置。没有可用
transport 时远程读取会安全失败，但不会为未配置的用户供应商建立隐式连接。

## 架构

```text
页面或 Connect App
→ Coordinator 中的 MSFile 服务、额度与公平队列
   ├─ remote-proxy → Window P2P 唯一 Host 的 MSFile lane → 已固定身份的 Go Supplier
   └─ local-bitfs  → 当前 Key 的 OwnerFileStore（不经 Window lane 或 Supplier wire）
```

Supplier 的 Noise 身份必须与配置的压缩公钥一致。Vault 锁定、切 Key、供应商变化或页面
释放时，排队和执行中的请求一起取消；迟到结果不能进入新会话。

## 对外能力

| 方法 | 中文用途 |
| --- | --- |
| `msfile.stat` | 查询哪些 Supplier 有目标 Seed、文件大小和报价 |
| `msfile.seed.read` | 读取并校验最多 16 MiB 的 Seed |
| `msfile.block.read` | 读取并校验最多 256 KiB 的 Block |

读取请求不接受调用方提供金额上限。全局价格和 App 单独额度由 Keymaster 管理；超额时用户可
拒绝、仅本次允许或保存新的 App 上限。`0` 表示明确不限金额，不表示字段缺失。

## 桶存储文件

`/msfile/storage`（首页「MSFile 文件」空间）列出当前 Key 桶内 `msfiles/` 下按 MasterSeed
生成的条目，支持单文件上传、下载、预览、校验与删除。页面只拿受限文件句柄，真实读写由
Coordinator SharedWorker 执行。

布局与格式以 KeymasterFormats 为准：

- 种子：`<owner>/msfiles/seeds/<seedhash>.ms`，内容为 `keymaster-seed-v1` 原始种子字节；
- 块：`<owner>/msfiles/storage/<seedhash>/<blockhash>`，文件名为块 SHA-256 小写 hex，重复可覆盖；
- 元数据：`<owner>/msfiles/meta/<seedhash>.json`，保存文件名、媒体类型、源文件大小、块数、写入时间。

上传先流式计算种子（`masterseed` 官方 SDK），再按种子摘要逐块重算并写入；写入顺序是块 →
种子 → 元数据，删除顺序相反。下载与预览从本桶读回并逐块校验 SHA-256，复用首页的预览白名单和
32 MiB / 256 MiB 上限；缺元数据的种子只显示哈希，不提供下载与预览。

## 并发设置

| 字段 | 中文含义 | 建议值 | 硬上限 |
| --- | --- | ---: | ---: |
| `mediaBlockReadConcurrency` | 单个媒体同时读取的 Block 数 | 2 | 16 |
| `globalSeedReadConcurrency` | 全局 Seed 读取数 | 4 | 8 |
| `globalBlockReadConcurrency` | 全局 Block 读取数 | 8 | 32 |
| `globalStatConcurrency` | 全局 Stat 查询数 | 4 | 16 |

媒体值不能大于全局 Block 值。调低设置不取消已经开始的请求，只限制后续任务；队列有界、
可取消，并避免播放器、下载和 Connect App 长期互相饿死。

## 文件和媒体

- 首页按 Seed Hash 查询，校验文件大小、Block Hash 和实际字节后才展示或下载。
- 小文件可安全预览；HTML 隔离脚本、网络、表单和导航，超限文件不先读入 Blob。
- 对 `remote-proxy` 来源，音视频使用根作用域 Service Worker 提供临时同源 URL，浏览器原生 Range 请求再映射到 256 KiB Block。
- 当前 Native Range 播放器要求有效的供应商公钥；`local-bitfs` 的媒体 source 映射尚未接通。local 的 Seed/Block 读取和购买入库可用，但不要把 local 音视频播放当作当前已支持能力。
- 临时 URL 随机且绑定页面，不包含 Hash、Supplier、金额或身份；锁定和 dispose 会撤销。
- Keymaster 不维护已完成 Block 缓存，也不预测播放时间；浏览器不支持的格式回退为下载。

旧 MSE/转封装源码只作为暂存兼容代码存在，当前首页生产路径使用 Native Range。

## 验收状态

Chromium 与本机正式 Go Supplier 的身份、读取、Range、取消和压力测试已有自动化证据。
Firefox、Safari、公共 CA/公网网络、目标 NAS 和真实部署 smoke 仍需对应环境验证；以
[覆盖矩阵](./集成测试/覆盖矩阵.md)为准。

## BitFS 本地来源与卖方模式

Keymaster 当前已经把 local msfile、BitFS 买方、BitFS 卖方、专款账本、交易 outbox 和恢复路径接入 Coordinator。完整的业务流程、资金流、Kind 1–13 对照、签名边界和状态机见 [BitFS 文件买卖文档](./bitfs/README.md)。

当前代码行为：

- 统一 MSFile API 使用 `sourceId` / `sourceKind` 区分 `local-bitfs` 与 `remote-proxy`；local 直接访问当前 Key 的 `/msfile/storage`，不编码 `/msfile/1.0.0`，也不伪造供应商公钥；
- local Stat 在报告 `available` 前校验元数据、Seed Hash、长度、块数和全部 Block 存在性；读取失败会撤销可用性并映射为稳定错误码；
- 卖方模式建立派生的 Seed 内存索引，消费已验签的 `bsv8.hash.request.v1`，通过 `webrtc-sdp` 或验证通过的 multiaddr 建立销售会话；未命中或 transport 未就绪时保持静默；
- 买方通过 Kind 1/2/3/4 开池，Kind 5/6/7 串行交付和累计付款，Kind 12/13 关池；Kind 7 正常路径不逐笔提交 WOC，FundingTx 由买方广播，最终关池交易由卖方广播；
- 买方面向同一 Seed 的多卖家计划保证 Seed 唯一归属和 Block 独占认领；结果未知的交易按原 txid 对账，文件内容验证后写入同一 OwnerFileStore；
- Vault 只通过受限 DER digest signer 提供签名；session journal、交易 outbox 和 exact evidence 在发送或广播前持久化，迟到结果受 owner/generation fence 拒绝。

尚未接线的业务分支包括 Kind 8–11 仲裁与取回流程；真实浏览器、网络和部署环境验收以[集成测试覆盖矩阵](./集成测试/覆盖矩阵.md)为准。需求与施工背景见 [BitFS 本地代理与卖方模式需求](./proposals/msfile/BitFS本地代理与卖方模式需求.md) 和 [施工单](./proposals/msfile/BitFS本地代理与卖方模式施工单.md)。
