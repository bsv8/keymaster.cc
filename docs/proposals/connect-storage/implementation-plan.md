# Keymaster Connect Storage 施工单

## 1. 施工目标

在不破坏现有 Connect、Channel、P2PKH 和 FeePool 行为的前提下，新增经过签名的 App Identity Session、独立 Storage 平台插件、Keymaster S3 设置和隔离的 `storage.*` 方法族。

本施工单不修改 S3Disk；S3Disk 只作为 Provider 行为和未来 ObjectStore 迁移的参考。

## 2. 实施原则

1. 先契约和纯函数，后 Provider，再协议适配和 UI。
2. `plugin-protocol` 不 import AWS SDK。
3. `plugin-storage` 不接触外部 `MessageEvent`。
4. 两层 namespace/path 校验。
5. Secret 先完成 Vault sealing 设计再允许配置落盘。
6. 所有新方法缺配置/缺身份时 fail closed。
7. 老 Connect Session 的非 Storage 能力保持可用。
8. 每个工单完成独立测试，禁止最后一次性补安全测试。

## 3. 里程碑

```text
M1 App Identity contract + session
M2 Storage platform + sealed config
M3 S3 provider parity
M4 Connect object API
M5 Range + multipart
M6 Settings + real provider smoke
M7 S3Disk adapter contract readiness
```

## 4. 工单 KMS3-001：契约与协议文档基线

### 修改范围

- `packages/contracts/src/appIdentity.ts`
- `packages/contracts/src/storage.ts`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/index.ts`
- 正式 protocol docs（实现完成前仍以 proposal 标记）

### 工作

- 增加 AppIdentityProof/VerifiedAppIdentity 类型。
- 增加 Storage provider/internal service 类型。
- 增加 `storage.*` params/result/error code/method mapping。
- Connect login params 增加可选 `appIdentity`。
- Connect session/result 增加可选 verified App snapshot。
- 固化 16 MiB、part size、limit 等常量位置。

### 验收

- contracts typecheck。
- 老 caller 不传 App Identity 时类型与运行兼容。
- Storage params 不存在 Publisher/App/Provider/S3 key 字段。

## 5. 工单 KMS3-002：App Identity 纯验证器

### 修改范围

- `packages/plugin-protocol/src/appIdentity.ts` 或新公共纯包
- `packages/plugin-protocol/src/protocolValidation.ts`

### 工作

- 严格 shape、公钥、app id/name、signature 校验。
- JCS + domain-separated digest。
- secp256k1 compact verify。
- 引入 KeymasterAppPackCore 黄金向量副本或跨仓 fixture 同步脚本。
- 记录 `identityDigestHex`。

### 测试

- 合法向量。
- 修改 name/id/key/signature/version。
- JSON 字段顺序不影响验证。
- 大小写/长度/控制字符/重复 key 边界。

### 验收

- 不需要 Publisher 私钥。
- 验证实现与 KeymasterAppPackCore 逐字节一致。

## 6. 工单 KMS3-003：Connect Session Identity 绑定

### 修改范围

- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
- Connect 单测与 appView 单测

### 工作

- `connect.login` accept 阶段验证 Identity，失败不降级。
- session 创建时持久化 snapshot。
- resume/logout 保持 snapshot 不变。
- launcher/appView bootstrap 支持 Identity Proof。
- 老 session 缺字段时非 Storage 方法照常；Storage eligibility=false。
- origin 仍按 event.origin 绑定 transport。

### 验收

- 同 Identity 不同 origin 可分别 login。
- sessionId 跨 origin 继续失败。
- caller 后续 request 自报 App Identity 不影响 session 真值。

## 7. 工单 KMS3-004：Vault Local Secret capability

### 修改范围

- `packages/contracts/src/vault.ts` 或独立内部 secret contract
- `packages/plugin-vault/src/*`
- Vault 单测

### 工作

- 设计 `seal/open(scope, bytes)` 受控能力。
- 使用 Vault master secret 的独立 domain/key derivation。
- sealed envelope 带 version、salt/nonce/ciphertext/tag 所需字段。
- locked 时 open fail closed。
- lock 时清理 plaintext lease。
- capability 不向外部 protocol 暴露。

### 安全验收

- IndexedDB 只看到密文。
- scope 改变无法解密。
- nonce 每次随机。
- 错密码/篡改统一失败。
- 日志无 plaintext/secret。

## 8. 工单 KMS3-005：plugin-storage 骨架与 DB

### 修改范围

- 新建 `packages/plugin-storage`
- App/web plugin assembly

### 工作

- manifest、capability、service lifecycle。
- `keymaster.storage` DB v1：providerConfig、multipartUploads。
- provider generation 状态机。
- attach/unlock/lock/teardown 行为。
- Storage Settings registry contribution 骨架。
- protocol optional consume `storage.service`，缺失时 Storage fail closed但 protocol 不 blocked。

### 验收

- 插件可单独启停。
- protocol 在 storage plugin 缺失时其余方法正常。
- lock/teardown 清 client 和 plaintext。

## 9. 工单 KMS3-006：路径和 Namespace 核心

### 修改范围

- `packages/plugin-storage/src/storagePath.ts`
- `packages/plugin-storage/src/storageNamespace.ts`

### 工作

- Provider prefix normalizer。
- app id/publisher revalidation。
- object path、directory path normalizer。
- build root/key/strip root。
- 最终 `assertKeyInRoot`。
- cursor/upload context binding helpers。

### 必测攻击

```text
../app-b/x
/publisher/app-b/x
a//b
a/./b
a\b
NUL/control
publisher prefix collision
app-a vs app-aa
Unicode slash lookalike
```

### 验收

- 所有函数纯测试。
- 不存在“自动修好”危险路径；非法输入直接失败。

## 10. 工单 KMS3-007：Provider Config 与 normalizer

### 参考

- `S3Disk/src/lib/storageTypes.ts`
- `S3Disk/src/lib/storageProfile.ts`
- `S3Disk/src/lib/providers/*`

### 工作

- AWS/R2/compatible 配置类型。
- HTTPS endpoint 与 URL credential 门禁。
- prefix、bucket、region/accountId normalizer。
- sealed config CRUD。
- summary 脱敏。
- config generation 与 client cache。

### 验收

- 与 S3Disk normalizer 共享等价测试用例。
- 修改配置原子替换；失败保留旧配置。
- Secret 永不通过 get summary 返回。

## 11. 工单 KMS3-008：S3 ObjectStore Adapter

### 参考

- `S3Disk/src/lib/s3ObjectStore.ts`
- `S3Disk/src/lib/providers/awsS3.ts`
- `cloudflareR2.ts`
- `s3Compatible.ts`

### 工作

- `@aws-sdk/client-s3` 最小命令集。
- list delimiter/pagination。
- put/get range/delete/directory marker。
- IfNoneMatch。
- provider probe。
- dispose/AbortSignal。
- 错误归一化，不泄漏 response body。

### 单测

- fake S3Client command snapshot。
- Prefix 始终包含 namespace root。
- list 输出剥离 root。
- Range/ContentRange/ETag 解析。
- 403/404/412/CORS/网络失败映射。

### 补充工单 KMS3-008A：非原子条件写入兼容模式

#### 背景

真实 Backblaze B2 S3-compatible 验证中，鉴权和 `ListObjectsV2` 成功，但带
`If-None-Match: *` 的 `PutObject` 返回 HTTP `501 NotImplemented`。业务确认
Keymaster 以个人低并发为主，允许对此类 Provider 使用 best-effort
`HEAD -> PUT/CompleteMultipartUpload`，同时保留 AWS S3/R2 的原子路径。

#### 工作

- 在原始 S3 错误归一化前识别“条件请求 + HTTP 501 + NotImplemented”。
- 每个 ObjectStore 实例缓存 `unknown/native/best-effort` 能力；不持久化。
- 首次 501 后执行 `HEAD`；不存在则移除条件头并重试，小对象和 multipart
  complete 都要覆盖。
- best-effort 已缓存后直接 `HEAD`，目标存在统一返回 `storage_conflict`。
- 非条件写入不增加请求；401/403/404/409/412、网络、CORS、限流与其他 5xx
  原样归一化，禁止降级。
- 保留 namespace final guard、AbortSignal 和错误脱敏。

#### 单测

- 小对象首次 501 的命令序列为 `conditional PUT -> HEAD -> plain PUT`。
- 缓存后命令序列为 `HEAD -> plain PUT`，不再发送条件头。
- `HEAD` 已存在返回 conflict 且不写入。
- multipart 首次 501 与缓存后的降级路径。
- 409/412 仍为 conflict；任意非 501/NotImplemented 不重试。
- sibling namespace 在任何探测/降级请求之前被拒绝。

#### 验收

- 不修改 smoke 用例绕过条件语义。
- AWS S3、Cloudflare R2 仍走原生条件头且 smoke 通过。
- Backblaze B2 通过原样 S3-compatible smoke。
- 文档明确 best-effort 模式的竞态，不将其描述为原子写入。

### 补充工单 KMS3-008B：配置级能力锁定与独立探测

#### 背景

KMS3-008A 已缓存 best-effort，但原生请求成功后仍可能因后续 501 被错误降级，且
PUT/Multipart Complete 共用一个粗粒度状态。业务要求首次有效判断成为当前 Provider
Config generation 的全局结论：成功也必须锁定，后续异常按系统错误处理。

#### 状态机

PUT 与 Complete 各自维护 `unknown | native | best-effort`：

- `unknown + 2xx`：锁 `native`。
- `unknown + 409/412`：锁 `native` 后返回 conflict。
- `unknown + HTTP 501 + NotImplemented`：锁 `best-effort` 后执行 HEAD 降级。
- `unknown + 其他错误`：保持 unknown，原样失败。
- `native + 任意错误`：保持 native，禁止降级。
- `best-effort + 后续请求`：不再发送条件头。

#### 工作

- 将单一条件模式拆为 PUT 与 Complete 两项独立能力。
- 为两项 unknown 首次探测分别增加并发门禁；只串行化能力分类，不串行化已分类或
  无条件 I/O。
- Storage Service 持有当前 active generation 的共享运行时能力并注入 store。
- Vault lock/unlock 后复用同 generation 状态；activate/replace/clear 后创建新状态。
- 不持久化 DB，不修改 Connect contract 或公开 Provider summary。

#### 单测

- 首次成功锁 native；后续 501 只报错，不 HEAD、不降级。
- 首次 409 与 412 都锁 native；后续 501 不降级。
- unknown 普通错误不锁，下一请求仍可成为探测者。
- PUT/Complete 状态互不污染。
- 同一能力两个并发 unknown 请求只有一个执行 capability probe。
- 同 generation lock/unlock 共享状态；Provider replacement/reset 使用新状态。

#### 验收

- KMS3-008A 的 best-effort 行为与 namespace/error 门禁不回归。
- 三 Provider 使用未放宽的同一 smoke 通过。
- native 状态绝不发生运行时降级。

### 补充工单 KMS3-012A：Settings 手动条件写入能力检测

#### 产品边界

- 保留现有“测试连接”：测试当前表单候选配置，只执行有界 List，不写对象。
- 新增“检测写入能力”：只测试当前已保存且 ready 的 active generation，明确提示会
  产生 PUT/HEAD/DELETE/multipart 请求、费用及 Provider 版本保留影响。
- 不新增 Connect method，不向第三方 App 暴露能力状态或检测入口。
- 用户不执行手动检测时，继续由首次真实条件 PUT/Complete 自动判定。

#### Contracts 与运行时状态

- 为平台内部 `StorageService` 增加能力快照与手动检测结果类型、getter 和 probe 方法。
- PUT/Complete 快照分别包含 `unknown | native | best-effort`、`automatic | manual`
  来源和更新时间；结果绑定 Provider generation，不持久化 DB。
- 自动判定和人工改判都触发 `storage.status` resource 刷新，Settings 显示两项状态、
  来源和最近更新时间。
- 每项能力增加 revision；人工提交递增 revision，较早启动的自动探测不得覆盖人工
  结论。PUT 与 Complete 独立处理。

#### 手动检测流程

- 使用 active config 创建临时 store 与独立能力状态，临时 namespace 固定为
  `{prefix}.keymaster-system/capability-probe/{uuid}/`，所有 adapter 调用继续经过
  `assertKeyInRoot`。
- PUT 与 Complete 各用唯一 Key 执行两次条件创建：第二次 `409/412` 为 native；
  精确 `501 + NotImplemented` 或第二次成功为 best-effort；其他错误为 inconclusive。
- multipart 每次创建独立 upload，并用最小单 part 完成；失败或 conflict 后 abort 尚未
  完成的 upload。
- 某项 inconclusive 保留旧值；另一项有结论时允许独立提交。
- 提交前复核 active generation、capability state identity、Vault unlocked、ready 与
  未取消状态。配置切换、clear/reset、lock 或轮换时丢弃过期结果。
- 所有对象 DELETE、upload abort 与 client dispose 在 finally 聚合清理；清理失败不得
  覆盖主错误或泄漏内部标识，并以 cleanup warning 呈现。

#### 并发与取消测试

- native 与 best-effort 均可被一次成功的人工检测显式重新分类。
- 人工提交后，先前启动、后完成的自动 probe 不得覆盖结果。
- 检测期间 Provider replacement/clear 串行或使结果因 generation 不符被丢弃。
- Vault lock、密码轮换及 UI cancel 可中止检测，且不提交部分/过期结论。
- PUT 一项 inconclusive 不阻止 Complete 的确定结论，反之亦然。

#### Provider 行为与 UI 测试

- 原生 Provider：两项第二次创建均 conflict，显示“原生原子”。
- 明确不支持条件头：精确 501 路径显示“Best-effort”。
- 静默忽略条件头：第二次成功，强制显示“Best-effort”。
- 403、网络、CORS、限流、其他 5xx：显示检测失败/不确定，保留旧状态。
- Settings 明确区分只读连接测试和有副作用能力检测；未激活、locked、非 ready 或
  busy 时禁用写入检测。
- 测试断言临时 Key 位于保留 namespace，所有可能创建的对象/upload 均尝试清理。

#### 验收

- `plugin-storage` 单测、contracts/typecheck、build 和 boundary lint 通过。
- AWS S3、Cloudflare R2、Backblaze B2 原有 smoke 不放宽且继续通过。
- 能力状态仍不持久化，Connect API surface 不变化，日志与 UI 不泄漏凭据和完整 Key。

#### 2026-08-10 实施核查记录

- 已实现可信 Settings 的独立“检测写入能力”入口；原“测试连接”仍只执行 List。
- PUT/Complete 分别显示 mode、automatic/manual 来源与更新时间；人工检测可双向改判，
  未手动检测时仍由首次真实请求自动判定。
- 已实现 revision 门禁、active generation/state identity 校验、取消、Vault lock、密码轮换
  和 Provider replacement 的过期结果保护。
- 已覆盖 native、精确不支持条件写入后的 best-effort、静默忽略条件头、partial
  inconclusive、清理 warning、人工双向改判、旧自动 probe 竞态、resource 更新、UI
  状态与取消。
- 临时请求的 namespace、两对象 DELETE、conflict multipart abort 均有直接断言。
- 主代理独立复验：`plugin-storage` 6 files / 69 tests、全仓 typecheck、Web build、两项
  boundary lint 全部通过；build 只有既有的大 chunk warning。
- 使用未放宽的同一真实 smoke 再次复验 AWS S3、Cloudflare R2 与 Backblaze B2，
  3 项全部通过。真实凭据仍只存在于 Git 忽略的本地文件，核查记录不包含连接详情。

## 12. 工单 KMS3-009：Storage Service CRUD 与 cursor

### 工作

- 实现 list/directory/put/getRange/delete。
- 内存 opaque cursor store，绑定 session/origin/root/prefix/generation/expiry。
- 单次 payload 16 MiB 门禁。
- 每次执行重验 session context generation。
- history/log 脱敏。

### 验收

- app-a cursor 不能用于 app-b。
- 配置切换使旧 cursor 失效。
- list 永远无法改变 S3 Prefix 到 namespace 外。
- 16 MiB+1 被协议层和 service 层同时拒绝。

## 13. 工单 KMS3-010：Multipart Manager

### 工作

- begin/part/complete/abort。
- internal UUID -> sealed S3 UploadId。
- 16 MiB part，10,000 part 限制。
- parts/ETag/size 持久化。
- session/origin/namespace/provider generation 绑定。
- startup/unlock stale cleanup。
- cancel/endSession/config change best-effort abort。

### 验收

- App 看不到 S3 UploadId/ETag list。
- uploadId 跨 App/Session/origin/config 均失败。
- part 失败后可重试同 part；complete 使用最新 part record。
- abort 和 stale cleanup 的失败可诊断但不泄密。

## 14. 工单 KMS3-011：Protocol `storage.*` 适配

### 修改范围

- `packages/plugin-protocol/src/protocolValidation.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- Protocol feed/UI i18n 摘要

### 工作

- 注册全部 storage methods。
- accept 阶段 require session + exact origin + verified App Identity。
- 构建 StorageAppContext；不接受 caller identity 字段。
- Storage 方法设为 auto-execute-after-unlock。
- dispatch 到 storage.service。
- 二次 require session 防 logout race。
- 稳定 error mapping。

### 验收

- 每个方法有 success/validation/session/provider/error 单测。
- 伪造 method params 无法覆盖 namespace。
- 非 Storage protocol 回归测试全部通过。

## 15. 工单 KMS3-012：Storage 设置 UI

本工单按 [S3 Settings 专项施工单](./settings-implementation-plan.md) 执行，不能只完成
一张 Provider 表单就视为结束。范围包含 registry 接入、候选配置模型、Probe、凭据
sealing、原子激活、状态机、Clear/Disable、CORS 指引和端到端测试。

### 关键验收

- `plugin-storage` 通过 `system-settings.registry` 出现在
  `Settings -> System -> S3 Storage`，不创建平行设置入口。
- 新配置必须 Probe 成功后才能成为 active；Probe 和保存都不写测试对象。
- 保存失败不替换可用旧配置，成功后 `storage.service.status()` 为 `ready`。
- Secret 从不回显 DOM value；retain/replace 是显式操作，切换 Provider 强制替换。
- 配置切换/清除会推进 generation、取消旧请求并使旧 cursor/uploadId 失效。
- Vault locked 时设置不可编辑/测试，Storage API fail closed。
- AWS、R2、S3-compatible 分别有 UI/service 集成测试；中英文 i18n 齐全。

## 16. 工单 KMS3-013：IndexedDB 迁移和旧 Storage 痕迹审计

### 背景

仓库历史 DB v6 曾有 `storageProviderConfig`，v9 已物理删除。本次不能简单恢复旧 plaintext store。

### 工作

- 新建独立 `keymaster.storage`，不复用旧 store。
- 审计旧代码/注释/测试中 storage removal 断言。
- 更新正式文档时明确“新设计不是旧 v6 回滚”。
- 不尝试恢复历史已删除 S3 secret。

### 验收

- 升级用户不会读取旧 plaintext/不存在 store。
- 老 protocol DB upgrade 测试仍通过。

## 17. 工单 KMS3-014：真实 Provider smoke

### 参考

沿用 S3Disk smoke 的环境变量组织和独立 run prefix，改用：

```text
keymaster-smoke/{runId}/{publisherFixture}/{appFixture}/
```

### Provider

- AWS S3。
- Cloudflare R2。
- 通用 S3-compatible。

### 场景

- probe。
- directory/list pagination。
- conditional put：原生 Provider 验证原子 conflict；明确不支持条件头的 Provider
  验证 KMS3-008A 的 best-effort conflict 与后续流程。
- range get。
- delete。
- multipart complete/abort。
- cancellation。
- cleanup error aggregation。

### 验收

- 默认 CI 不要求真实 credential；opt-in job 运行。
- 所有 smoke 创建对象在 finally 清理。
- CORS 缺 ETag 时报告明确。

### 最近真实 Provider 验收记录

2026-08-10 使用同一份未放宽的 `s3ProviderSmoke.ts` 完成：

- AWS S3（`us-east-1`）：通过原生条件写入路径。
- Cloudflare R2：通过原生条件写入路径。
- Backblaze B2（`us-west-004`，通用 S3-compatible）：首次条件 PUT 返回
  `501 NotImplemented` 后按 KMS3-008A 切换到 best-effort 路径并通过。

三者均覆盖 probe、directory/list pagination、重复创建 conflict、range get、
multipart complete/abort、cancellation 和 finally cleanup。凭据只存在于被 Git 忽略且
权限为 `0600` 的 `.storage-smoke/.env`，验收记录不得包含 Bucket、Access Key 或
Secret。Provider 自身的版本保留/Lifecycle 仍由测试账户负责，不属于 finally 删除请求
能够保证的物理版本清理范围。

KMS3-008B 完成后同日复验：54 项 `plugin-storage` 测试、全仓 typecheck、Web build、
boundary lint 全部通过；AWS S3、Cloudflare R2、Backblaze B2 再次使用同一 smoke
全部通过。PUT 与 Multipart Complete 的能力状态独立，2xx/409/412 锁定 native，
native 后续 501 不降级，并发首次探测及等待者取消均有回归测试。

## 18. 工单 KMS3-015：S3Disk 迁移契约验收

本工单只在 Keymaster 仓库建立 fake client adapter fixture，不修改 S3Disk。

### 工作

- 用 Connect Storage methods 实现测试版 S3Disk ObjectStore facade。
- 验证 listDirectory、createDirectory、putObject、range stream、delete。
- 大文件模拟 multipart + progress + cancel。
- 列出 S3Disk 后续需要删除/替换的 AWS SDK/profile 模块。

### 验收

- S3Disk ObjectStore contract 测试可由 fake Connect adapter 通过。
- 不向 S3Disk 暴露 Provider Config 或 S3 credential。

## 19. 工单 KMS3-016：安全审计与正式协议合入

### 工作

- namespace fuzz/property tests。
- MessageEvent source/origin/session race。
- cursor/upload ID guessing与跨域测试。
- secret/log/command history扫描。
- CSP/CORS/redirect检查。
- 更新正式 Protocol 总览、Common、Connect 和 Storage 文档。
- 删除“当前不支持 storage”的过时正式描述，仅在实现与验收全部完成后执行。

### 完成定义

- 需求文档 10 条验收标准全部通过。
- 全仓 typecheck、boundary lint、unit/integration 通过。
- 三 Provider smoke 有最近成功记录。
- 安全审计无高危问题。
- 文档、contracts 和实现 method 列表一致。

## 20. 建议实施顺序与依赖

```text
KMS3-001
  ├─ KMS3-002 ─ KMS3-003
  └─ KMS3-004 ─ KMS3-005 ─ KMS3-007 ─ KMS3-008
                       └──── KMS3-006 ─ KMS3-009 ─ KMS3-010
KMS3-003 + KMS3-009 + KMS3-010
  └─ KMS3-011 ─ KMS3-012 ─ KMS3-014 ─ KMS3-015 ─ KMS3-016
KMS3-013 可与 KMS3-007~010 并行，但必须在正式合入前完成。
```

## 21. 不在本施工单

- KeymasterAppPackCore 实现。
- S3Disk 正式迁移。
- 多 Storage Profile。
- App 对象透明加密。
- Presigned URL。
- 递归批量删除。
- 多 part 并行上传。
