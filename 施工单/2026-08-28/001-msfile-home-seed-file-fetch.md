# 001 MSFile 首页 Seed 文件获取与安全预览施工单

> 状态：✅ 已完成并验收通过（2026-08-28）。
>
> 验收证据：H01–H20 已覆盖；TypeScript、插件边界、生产构建和全仓
> 190 个测试文件通过；真实无头 Chromium + Go supplier 互操作 9/9 通过。
>
> 本单只实现受信任 `msfile` 插件在首页提供的单文件获取入口：用户输入
> Seed Hash，选择供应商后重组原文件；安全类型在页面预览，其余类型按
> `recommendedFilename` 下载。本单不改变 MSFile wire/network、金额授权模型，
> 也不实现 Connect App 测试页。

## 1. 已冻结产品决定

1. 首页出现一个由 `msfile` 插件自行注册的“通过 Seed 获取文件”模块；
2. 模块位于联系人首页空间之后，不在 `plugin-home` 或 `HomePage` 中硬编码；
3. 输入只需要一个 Seed Hash，不增加文件 ID、路径、Block Index 或 access/grant；
4. 先执行 `Stat`，以供应商返回的文件名、媒体类型、文件大小和状态决定后续 UI；
5. 可安全预览的类型在用户发起获取后自动 Read 并展示；不可预览类型先显示文件信息，用户点击“下载”后才 Read；
6. Seed 和 Block 在 Keymaster 层显式区分，但 wire 继续使用统一 `Read(content_hash, max_price_satoshis)`；
7. 首页模块属于受信任插件调用，只使用全局 Seed/Block 金额上限，不接收 `maxPriceSatoshis`，不生成 Connect App 单次授权；
8. 自动预览最大 32 MiB；普通 Blob 下载最大 256 MiB；超过 256 MiB 暂不读取，留给后续流式下载施工单；
9. HTML 只能作为不受信任静态内容在隔离 iframe 中展示，禁止进入 Keymaster DOM 或取得 Keymaster origin 权限；
10. 下载文件名使用 Stat 的 `recommendedFilename`，但必须安全化；浏览器本地 Blob 下载使用 `a.download`，不得伪造不存在的 HTTP `Content-Disposition` 响应头。

## 2. 前置条件与 Gate

- [002 MSFile 生产 Runtime](../2026-08-26/002-msfile-production-runtime.md) 已 PASS；
- `msfile.service` 的 `stat/readSeed/readBlock` 继续作为本模块唯一数据入口；
- MSFile 设置必须能提供已经显式保存的全局 Seed/Block 金额和至少一个启用的供应商；
- `bitcoin-libp2p` 继续只读，不得为首页功能修改、复制或绕过；
- 相邻 `MSFile-Proxy-Protocol` 的 Seed 格式、Block 大小和 `/msfile/1.0.0` 不因本单改变。

当前 `msfile` 插件若因 `defaultEnabled:false` 没有加载，首页模块和设置都会不可见。
该“插件加载 / 数据面启用 / 设置入口”问题必须按独立设置需求解决；本单不得通过下列方式绕过：

- 在 `HomePage` 直接 import `MsFileHomeWidget`；
- 在首页写死供应商、公钥、地址、金额或测试 Seed；
- 把 E2E hook、固定密码或 session 注入带入生产构建；
- 让首页直接访问 MSFile DB、Coordinator 内部对象或 Window executor。

## 3. 首页注册与布局

联系人首页模块当前通过 `BusinessFeatureRegistry` 注册：

```text
contacts.shortcuts  space order: 500
```

MSFile 必须使用同一套 Business Home Projection 机制，而不是 legacy
`home.registry`：

```text
owner plugin: msfile
domain: home
feature id: home.msfile-file
projection id: msfile.file-fetch
space id: msfile.files
space order: 600
projection order: 10
```

要求：

- `msfilePlugin.dependencies` 显式声明 `business.registry`；
- setup 时注册 projection，插件 teardown 由 registry/plugin host 正常回收；
- 模块只在 Vault unlocked 时允许读取；locked 状态不得保留文件、Blob URL 或进行中的请求；
- 插件已加载但 MSFile 未配置/停用时，模块展示规范状态和设置入口，不发起网络请求；
- 不改变联系人模块的 order，不依赖注册先后决定位置。

## 4. 页面状态机

```text
idle
  -> validating
  -> stat-loading
       -> not-found / discovering / unavailable / quoted-or-available
  -> supplier-selection（多个候选）
  -> preview-decision
       -> ready-to-download（不可安全预览或超过 32 MiB）
       -> seed-reading
            -> block-reading
            -> assembling
            -> preview-ready
  -> downloading（按钮触发且尚未读取）
       -> seed-reading -> block-reading -> assembling -> download-ready
  -> failed / cancelled
```

状态要求：

- Hash 非法时停在本地校验，不调用 `Stat`；
- 新一次查询必须取消并彻底作废旧查询；
- 页面卸载、Vault lock、active key 切换、插件禁用和 supplier generation 变化均取消旧请求；
- 旧请求即使迟到也不得覆盖新查询的元数据、进度、预览或下载链接；
- 错误信息使用中文可理解语义，同时保留规范 MSFile error code 供诊断；
- 不向页面展示 supplier 原始内部异常、付款原文或 transport stack。

## 5. Stat 与供应商选择

### 5.1 输入

- 输入必须通过 `isValidMsFileHashHex`；
- 只接受 64 位小写 hex；不得静默 trim 后修改非规范 Hash；
- 输入框、按钮和错误提示需要可访问 label，并支持 Enter 发起查询。

### 5.2 Stat 聚合

调用：

```text
msfile.service.stat({ seedHashHex, signal })
```

展示并区分：

- `available`：供应商可以直接提供文件；
- `quoted`：展示 Seed 与完整 Block 的价格范围，实际 Read 仍由全局金额上限裁决；
- `absent`：该供应商没有文件；
- `discovering`：展示可重试状态与 `retryAfterMs`；
- `network-error`：显示供应商暂时不可用，不伪装成 absent。

### 5.3 选择规则

- 只有一个 `available/quoted` 候选时自动选中；
- 多个候选时必须显示供应商名称、公钥短标识、状态、文件名、大小、媒体类型和报价摘要，由用户明确选择；
- 不按数组第一项、连接速度或未知价格暗中选择付费供应商；
- 不允许 Seed 来自 A 供应商、Block 默默切到 B 供应商；一次文件获取固定一个 `supplierPublicKeyHex`；
- 用户选定供应商后，以该条 Stat 的 `recommendedFilename/fileSizeBytes/mediaType` 作为本次快照；配置世代变化后必须重新 Stat。

## 6. Seed 解析与文件重组

选定供应商后：

1. 调用 `readSeed({ supplierPublicKeyHex, seedHashHex, signal })`；
2. 断言返回 `contentHashHex` 等于请求 Seed Hash；
3. Seed 字节长度必须是 32 的整数倍；
4. 每 32 字节按原顺序解析为一个 Block Hash；
5. `fileSizeBytes` 是规范 uint64 十进制字符串；大小比较和 Block 数计算必须先使用 `BigInt`，只有确认落入本模块 32/256 MiB 边界后才能安全转换为 JS number；
6. 根据 `fileSizeBytes` 与 256 KiB Block 大小计算预期 Block 数；Seed 中的 Block 数必须完全一致；
7. 使用固定上限 8 并发调用 `readBlock`，不得为每个 Block 建立无界 Promise；
8. 每个响应的 `contentHashHex` 必须等于对应 Block Hash；
9. 非最后一块必须恰好 256 KiB；最后一块必须与文件剩余长度一致；文件大小正好整除 256 KiB 时，最后一块仍应为完整 256 KiB；
10. 零字节文件允许空 Seed，最终生成零字节文件；
11. 重复 Block Hash 必须按 Seed 中出现的每个位置参与重组，不能用 Set 去重后改变文件；
12. 总字节数必须严格等于 Stat 的 `fileSizeBytes`；
13. 任一 Hash、尺寸、数量、epoch、generation 或供应商失配，整个结果 fail closed，不展示/下载部分文件。

`msfile.service` 已负责单对象 SHA-256 和内容硬上限。首页模块不复制另一套
wire/hash 实现，只负责文件级顺序、块数和总长度约束。

## 7. 并发、进度与取消

- Block worker pool 固定最多 8 个 active Read；
- 进度按“已验证 Block 数 / 总 Block 数”和“已验证字节 / 文件字节”展示；
- Abort 后不再调度新 Block，已经返回的旧 Block 不进入新任务；
- 同一 Seed 新查询覆盖旧查询时必须遵守现有 ReadCancelled 语义；
- 任何失败取消同一文件的其余读取；
- 不自动无限重试；用户可在错误后明确重试；
- 不把完整文件、Seed、Block 或中间 attachment 写入 IndexedDB、localStorage、日志或 Resource Store；
- 组件只持有当前任务所需的内存，完成/取消/卸载后释放引用。

## 8. 安全预览策略

### 8.1 MIME 规范化

- MIME 来自供应商，属于不可信元数据；
- 比较前只做规范的小写和参数拆分，例如 `text/html; charset=utf-8` 取主类型 `text/html`；
- 读取完成后进行浏览器解码/基本签名校验；不能确认时只能降级为下载，不能扩大预览类型；
- 文件扩展名不能决定 MIME。

### 8.2 V1 自动预览白名单

允许自动预览：

- 图片：`image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/avif`；
- 音频：`audio/mpeg`、`audio/wav`、`audio/ogg`、`audio/flac`；
- 视频：`video/mp4`、`video/webm`、`video/ogg`；
- 文本：`text/plain`；
- 文档：`application/pdf`；
- HTML：`text/html`，但只能走第 8.3 节隔离预览。

SVG、XML、JavaScript、未知 `text/*`、Office、压缩包、可执行文件、
`application/octet-stream` 和未列出的类型不得自动预览，只提供下载。

### 8.3 HTML 隔离

禁止使用 `dangerouslySetInnerHTML` 把文件内容写入 Keymaster DOM。HTML 预览必须：

- 使用独立 iframe，`sandbox` 不授予 `allow-scripts`、`allow-same-origin`、`allow-forms`、`allow-popups`、`allow-top-navigation` 或下载权限；
- iframe 使用 opaque origin；
- 内容最前面施加限制性 CSP：默认禁止网络、脚本、连接、frame、object、base 和 form，仅按需允许内联样式及 `data:/blob:` 媒体；
- 移除或禁用可导航链接、表单、meta refresh 和外部资源入口；
- 不允许读取父页面、Vault、session、cookie、IndexedDB、localStorage 或 Keymaster capability；
- 不保证依赖外部 JS/CSS/图片的 HTML 完整显示，并在 UI 明示“安全静态预览”。

PDF 也应放在隔离容器中；浏览器无法安全解码时降级为下载。

## 9. 预览与下载大小边界

### 9.1 自动预览

- `fileSizeBytes <= 32 MiB` 且 MIME 在白名单：用户提交查询并选定供应商后自动读取；
- 大于 32 MiB：不自动读取，展示文件信息与下载按钮；
- 32 MiB 是首页资源保护线，不改变协议文件大小或 Seed/Block 上限。

### 9.2 Blob 下载

- `fileSizeBytes <= 256 MiB`：点击下载后允许读取并以 Blob 生成下载链接；
- 已经完成预览的文件必须复用同一份已验证内容，不得再次付费 Read；
- `fileSizeBytes > 256 MiB`：不得开始读取，提示“当前浏览器版本需要流式下载支持”；
- 不在本单引入 File System Access API、Service Worker StreamSaver、OPFS 临时文件或浏览器专属降级链路。

## 10. 文件名与 Blob URL

Stat 的 `recommendedFilename` 只作为不可信建议：

- 转换为 basename，删除 `/`、`\\`、NUL、控制字符和路径片段；
- 拒绝 `.`、`..` 和清理后的空名称；
- 空/非法名称回退为 `<seedHashHex>`；
- 继续执行 wire 的 UTF-8 255 字节上限，不能让超长文件名破坏 UI；
- 不自动附加与供应商 MIME 猜测出的扩展名。

下载使用：

```text
Blob(parts, { type: normalizedMediaType })
URL.createObjectURL(blob)
<a download="safeFilename" href="blobUrl">
```

这等价于浏览器本地指定下载文件名，不存在 HTTP response，故不得宣称设置了
`Content-Disposition`。新文件、取消、失败、组件卸载、lock/key switch 时必须
`URL.revokeObjectURL`。

## 11. 金额与授权边界

- 本模块通过受信任 `msfile.service` 调用；
- Seed Read 使用全局 `seedMaxPriceSatoshis`；
- 每个 Block Read 使用全局 `blockMaxPriceSatoshis`；
- API 和组件 props 中都不得出现调用方传入的 `maxPriceSatoshis`；
- `0` 继续表示设置中显式“不限金额”，组件不自行解释空值为 0；
- 超过全局上限时显示金额超限并引导用户前往 MSFile 设置，不在首页临时提高额度；
- 不创建 App policy、grant、Connect session 或“仅本次授权”；
- 多 Block 文件仍按既有“每个对象最高金额”裁决，不增加文件累计预算。

## 12. 建议文件边界

实施者应优先在 `packages/plugin-msfile` 内完成：

- `src/MsFileHomeFileWidget.tsx`：状态机和 UI；
- `src/fileAssembly.ts`：无 React、可单测的 Seed 解析、块计划、长度校验和文件名安全化；
- `src/filePreviewPolicy.ts`：MIME 白名单、大小边界和预览决策；
- `src/manifest.ts`：i18n、`business.registry` 依赖与首页 projection 注册；
- `src/styles.css`：组件样式；
- 对应单元/组件测试。

边界要求：

- 不修改 `packages/plugin-home/src/HomePage.tsx`；
- 不在 `apps/web` 写 MSFile 首页业务逻辑；
- 不让 React 组件 import Coordinator/DB/transport/windowExecutor 内部模块；
- 不把 React、Blob、DOM 或预览策略带入 SharedWorker；
- 如果现有公开 contracts 已足够，不为了组件再增加重复 DTO。

## 13. 明确不做

- MSFile 设置页整体重构或 `defaultEnabled` 最终发布裁决；
- Connect SDK/App Identity/付费审批页面；
- 测试专用插件路由；
- 上传、删除、目录浏览、文件历史或最近下载列表；
- 跨供应商拼接同一文件；
- 文件级授权、累计预算或供应商自动竞价；
- 256 MiB 以上流式保存；
- 在浏览器中执行下载到的 HTML/JavaScript；
- 修改 MSFile wire/network、Go NAS 或 `bitcoin-libp2p`。

## 14. 必测矩阵

| ID | 场景 | 通过条件 |
|---|---|---|
| H01 | 首页挂载 | 使用 business projection，空间 order 600，稳定位于联系人之后 |
| H02 | 插件边界 | 禁用/teardown MSFile 后模块消失且资源全部释放；HomePage 无硬编码 |
| H03 | 非规范 Hash | 不发网络请求，显示中文字段错误 |
| H04 | Stat 状态 | available/quoted/absent/discovering/network-error 不互相混淆 |
| H05 | 多供应商 | 多候选必须由用户选择；一次文件固定同一供应商 |
| H06 | Seed 解析 | 32 字节对齐、Block 数与 fileSize 严格一致，空文件合法 |
| H07 | 文件顺序 | 重复 Block Hash 保留全部位置，重组字节顺序正确 |
| H08 | Block 并发 | 最多 8 个 active Read，无无界 Promise/队列 |
| H09 | 完整性 | 错 hash、非末块短读、末块长度错误、总长度错误全部 fail closed |
| H10 | 进度 | Block/字节进度只统计已验证内容，失败后不显示完成 |
| H11 | 覆盖取消 | 新 Hash、Abort、lock、key switch、generation 变化使旧结果无效 |
| H12 | 安全 MIME | 只有明确白名单自动预览，未知/SVG/可执行类型降级下载 |
| H13 | HTML 隔离 | script、parent/storage、外部网络、表单、导航均不可用 |
| H14 | 预览上限 | 32 MiB 以内可自动预览；超过后不自动 Read |
| H15 | 下载上限 | 256 MiB 以内 Blob 下载；超过后不 Read 并提示流式能力缺失 |
| H16 | 文件名 | 路径、控制字符、空名和超长名被安全化，`a.download` 正确 |
| H17 | Blob 生命周期 | 新任务/卸载/lock 后 URL 被 revoke，不保留旧文件 |
| H18 | 金额策略 | 只用全局 Seed/Block 上限；组件/API 无 maxPrice 输入或 App grant |
| H19 | 真实数据面 | Chromium 本地生产构建经真实 `msfile.service` 重组并预览/下载正式 Go supplier 文件，不注入 fake transport |
| H20 | 敏感数据 | 文件内容、Seed/Block attachment、私钥和付款原文不进入日志/DB/Resource Store |

## 15. 验收建议

至少执行：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/plugin-msfile/src
pnpm exec playwright test <MSFile 首页文件获取 E2E> --project=chromium --workers=1
pnpm build
pnpm test
git diff --check
```

浏览器 E2E 使用本地 `http://127.0.0.1` 的生产构建和正式 Go
`/msfile/1.0.0` supplier；localhost 属于可信上下文，可以连接 WSS/WebRTC Direct。
不得为了验收修改线上 `keymaster.cc`，也不得把测试 hook 编入普通生产构建。

## 16. 完成定义

- H01–H20 全部通过；
- 首页联系人下方稳定出现 MSFile 文件获取模块；
- 用户只输入 Seed Hash 即可完成 Stat、供应商选择、Seed/Block 重组；
- 安全类型正确预览，HTML 与 Keymaster 完全隔离；
- 不可预览类型以安全文件名下载；
- 32 MiB/256 MiB 边界在发起 Read 前执行；
- 所有 lifecycle/取消/迟到结果和 Blob URL 均正确收口；
- 不改变金额模型、Connect API、wire/network 或私钥隔离；
- 普通生产构建不包含任何为本功能验收新增的固定测试身份、密码或 session 注入能力。
