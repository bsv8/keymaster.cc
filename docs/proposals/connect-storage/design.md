# Keymaster Connect Storage 设计文档

## 1. 文档目的

本文定义计划中的 App Identity Session 扩展、Storage 平台插件、S3 Provider、Connect `storage.*` 方法、命名空间、安全门禁和数据持久化。它不改变现行 Protocol V1；实现完成并通过施工单验收后，再把稳定契约合入正式协议文档。

相关文档：

- [需求文档](./requirements.md)
- [施工单](./implementation-plan.md)
- [S3 Settings 专项施工单](./settings-implementation-plan.md)
- `KeymasterAppPackCore/docs/design.md`
- `S3Disk/src/lib/storageTypes.ts` 与 provider/object store 实现（行为参考，不作为运行时依赖）

## 2. 总体架构

```text
Decentralized App
  - 从 hash index 读取 AppIdentityProof
  - postMessage connect.login(appIdentity)
                    │
                    ▼
plugin-protocol
  - exact event.origin transport 校验
  - App Identity JCS/secp256k1 验签
  - ConnectSession 绑定 Publisher/App
  - storage.* contract adapter
                    │ internal capability only
                    ▼
plugin-storage / storage.service
  - path + namespace 二次门禁
  - range/multipart/cursor lifecycle
  - provider config + sealed credentials
                    │
                    ▼
AWS SDK S3Client
  - AWS S3 / Cloudflare R2 / S3-compatible
```

关键分层：

- `plugin-protocol` 不直接 import AWS SDK，不保存 S3 config。
- `plugin-storage` 不接触 `MessageEvent`，只接收已验证的内部 App Storage Context。
- App 无法直接取得 `storage.service` capability；只有平台插件消费。
- 两层都做路径与 namespace 验证，避免 adapter 漏检直接变成越权。

## 3. 包与文件建议

```text
packages/contracts/src/appIdentity.ts
packages/contracts/src/storage.ts
packages/contracts/src/protocol.ts              # method mapping/session extension

packages/plugin-storage/
  src/storageService.ts
  src/storageDb.ts
  src/storagePath.ts
  src/providerConfig.ts
  src/s3ObjectStore.ts
  src/providers/awsS3.ts
  src/providers/cloudflareR2.ts
  src/providers/s3Compatible.ts
  src/StorageSettings.tsx
  src/manifest.ts

packages/plugin-protocol/
  src/appIdentity.ts                             # 或复用独立纯实现包
  src/protocolValidation.ts
  src/protocolService.ts
```

新增内部 capability：

```ts
export const STORAGE_SERVICE_CAPABILITY = "storage.service";
```

## 4. App Identity

### 4.1 Contract

```ts
export interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
  signature: string;
}

export interface VerifiedAppIdentity {
  version: 1;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}
```

验证规则必须与 KeymasterAppPackCore 完全一致，并共享黄金向量：

```text
payload = { version, publisherPublicKey, app }
bytes   = UTF8("keymaster-app-identity:v1") || 0x00 || UTF8(JCS(payload))
digest  = SHA256(bytes)
verify compact signature with publisherPublicKey
```

Keymaster可以在 contracts 只放类型，验证实现放 protocol 或一个无 React 的公共包；不得通过网络调用 KeymasterAppPackCore 服务。

### 4.2 Connect 输入兼容

为避免硬切现有 App：

```ts
interface ConnectLoginParams {
  text: string;
  claims?: string[];
  appIdentity?: AppIdentityProofV1;
}
```

- 未传 `appIdentity`：现有 Connect 行为不变，但 session 没有 Storage eligibility。
- 已传且验签失败：`connect.login` 直接 `invalid_request`，不能降级成无 Identity session，避免 caller 误以为获得了 App 身份。
- 已传且成功：把 verified snapshot 写入 session。

`connect.launch` 路径通过 launcher/bootstrap 传同一 Identity Proof；旧 catalog App 没有 proof 时仍可使用非 Storage 方法。

### 4.3 Session

```ts
interface ConnectSessionRecord {
  // 现有字段
  sessionId: string;
  origin: string;
  ownerPublicKeyHex: string;
  // ...

  // 新字段；老 session 可缺省
  publisherPublicKeyHex?: string;
  appId?: string;
  appName?: string;
  appIdentityDigestHex?: string;
}
```

Storage 方法要求四字段全部存在且格式合法。Session 中的 Owner 与 Publisher 是独立概念：Owner 承载 Keymaster 用户认证；Publisher/App 决定 S3 namespace。

建议 Connect login/resume/launch 成功结果增加可选只读快照：

```ts
appIdentity?: {
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}
```

## 5. Storage Namespace

### 5.1 Provider Prefix

配置 prefix 规范化：

```text
""          -> ""
"keymaster" -> "keymaster/"
"a/b/"      -> "a/b/"
```

同 relative path 规则禁止绝对路径、反斜杠和 dot segments。

### 5.2 Root

```ts
function buildNamespaceRoot(configPrefix: string, identity: VerifiedAppIdentity): string {
  return `${configPrefix}${identity.publisherPublicKeyHex}/${identity.appId}/`;
}
```

示例：

```text
configured prefix = keymaster/
publisher          = 02aaaa...
app id             = s3disk

keymaster/02aaaa.../s3disk/
```

S3 Key 没有概念上的前导 `/`。对 App 文档可显示 `/publisher/app/`，但 adapter 统一使用无前导 slash 的真实 Key。

### 5.3 App 不得控制的字段

公开 `storage.*` params 中严禁出现：

```text
publisherPublicKeyHex
appId
namespaceRoot
bucket
endpoint
providerId
s3Key
s3UploadId
```

`StorageAppContext` 只能由 protocol 从 session 构建：

```ts
interface StorageAppContext {
  connectSessionId: string;
  transportOrigin: string;
  publisherPublicKeyHex: string;
  appId: string;
  appIdentityDigestHex: string;
}
```

## 6. 公共协议方法

所有方法属于已有 `connectSessionId`。Storage grant 是 Connect Session 级全能力，不增加 permissions 数组；有效 verified App Identity session 自动具有全部方法。

### 6.1 `storage.list`

```ts
interface StorageListParams {
  connectSessionId: string;
  prefix?: string;               // "" = app root
  cursor?: string;               // Keymaster opaque cursor
  limit?: number;                // 1..1000，默认 200
}

interface StorageListResult {
  prefix: string;
  parentPrefix: string;
  directories: Array<{ path: string; name: string }>;
  files: Array<{
    path: string;
    name: string;
    size: number;
    etag?: string;
    lastModified?: string;
  }>;
  markerPath?: string;
  nextCursor?: string;
}
```

内部用 `ListObjectsV2 + Delimiter="/"`。cursor server-side map：

```ts
cursor -> {
  connectSessionId,
  origin,
  namespaceRoot,
  relativePrefix,
  s3ContinuationToken,
  expiresAt
}
```

cursor 随 Session Window 结束可失效；客户端从头重新 list。

### 6.2 `storage.directory.create`

```ts
{ connectSessionId, path, overwrite?: boolean }
-> { path, created: true }
```

写零字节对象：

```text
Content-Type: application/x-directory
Key: namespaceRoot + normalizedPath + "/"
```

### 6.3 `storage.directory.delete`

只删除 marker，不递归删除子树：

```ts
{ connectSessionId, path }
-> { path, deleted: true }
```

递归删除不进入 V1 protocol，避免误删和长事务。

### 6.4 `storage.put`

```ts
interface StoragePutParams {
  connectSessionId: string;
  path: string;
  content: BinaryField;          // <= 16 MiB
  contentType?: string;
  overwrite?: boolean;           // 默认 true
}

interface StoragePutResult {
  path: string;
  size: number;
  etag?: string;
  updatedAt: number;
}
```

`overwrite=false` 优先映射 `IfNoneMatch="*"`。若 Provider 对该条件请求明确返回
HTTP `501` + `NotImplemented`，adapter 按 9.4 节降级为 best-effort
`HEAD -> PUT`；Protocol 仍返回相同的 `storage_conflict`，不向 App 暴露 Provider
能力差异。

### 6.5 `storage.get`

```ts
interface StorageGetParams {
  connectSessionId: string;
  path: string;
  offset?: number;               // 默认 0
  length?: number;               // 1..16 MiB，默认 16 MiB
  ifMatch?: string;
}

interface StorageGetResult {
  path: string;
  content: BinaryField;
  contentType?: string;
  offset: number;
  totalSize: number;
  eof: boolean;
  etag?: string;
  lastModified?: string;
}
```

内部发送 `Range: bytes=start-end`。offset/totalSize 使用 JS safe integer；超出安全范围 V1 拒绝，未来如需超大对象另升 contract。

### 6.6 `storage.delete`

```ts
{ connectSessionId, path }
-> { path, deleted: true, updatedAt: number }
```

幂等映射 S3 DeleteObject；不额外 GET/HEAD。

### 6.7 Multipart

```ts
storage.upload.begin
{
  connectSessionId,
  path,
  contentType?,
  size,
  overwrite?
}
-> {
  uploadId,                       // Keymaster UUID
  partSize: 16777216,
  maxParts: 10000
}

storage.upload.part
{
  connectSessionId,
  uploadId,
  partNumber,
  content: BinaryField
}
-> { uploadId, partNumber, size }

storage.upload.complete
{ connectSessionId, uploadId }
-> { path, size, etag?, updatedAt }

storage.upload.abort
{ connectSessionId, uploadId }
-> { uploadId, aborted: true }
```

Part 规则：除最后 part 外推荐 16 MiB；Keymaster验证 partNumber、累计 size 和最大 parts。S3 ETag 和 S3 UploadId 只保存在内部 record。

## 7. 请求生命周期

Storage 方法属于 session-bound auto-execute 方法：

- Connect Session 无 verified App Identity：fail fast。
- Vault unlocked且 Provider ready：直接 queued/executing，不逐文件弹确认。
- Vault locked：进入 `waiting_unlock_auto`；解锁后执行。
- Provider 未配置/解密失败：fail closed。
- logout/revoke 后旧 Storage request 在执行阶段二次校验并失败。

文件正文和 Secret 不写 Protocol command history。历史只记录 method、相对 path 的安全摘要（建议 basename 或 Hash）、size、状态和本地 failure reason。

## 8. 内部 Storage Service

```ts
interface StorageService {
  status(): StorageServiceStatus;
  subscribe(listener: () => void): () => void;

  getProviderSummary(): Promise<StorageProviderSummary | null>;
  activateProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult>;
  clearProviderConfig(): Promise<void>;
  probeProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult>;

  list(ctx: StorageAppContext, input: StorageListInput): Promise<StorageListOutput>;
  createDirectory(ctx: StorageAppContext, input: StorageDirectoryInput): Promise<void>;
  deleteDirectoryMarker(ctx: StorageAppContext, input: StorageDirectoryInput): Promise<void>;
  put(ctx: StorageAppContext, input: StoragePutInput): Promise<StoragePutOutput>;
  getRange(ctx: StorageAppContext, input: StorageGetRangeInput): Promise<StorageGetRangeOutput>;
  delete(ctx: StorageAppContext, input: StorageDeleteInput): Promise<void>;
  beginUpload(ctx: StorageAppContext, input: StorageUploadBeginInput): Promise<StorageUploadState>;
  uploadPart(ctx: StorageAppContext, input: StorageUploadPartInput): Promise<void>;
  completeUpload(ctx: StorageAppContext, input: StorageUploadCompleteInput): Promise<StoragePutOutput>;
  abortUpload(ctx: StorageAppContext, input: StorageUploadAbortInput): Promise<void>;
}
```

每个 public I/O method 的第一步都是 `resolveNamespace(ctx)`，最后一步在 adapter 前执行 `assertKeyInRoot(root, key)`。

## 9. Provider Config

### 9.1 公共类型

与 S3Disk 行为对齐：

```ts
type StorageProviderId = "cloudflare-r2" | "aws-s3" | "s3-compatible";

interface StorageAccessKeyAuth {
  kind: "access-key";
  accessKeyId: string;
  secretAccessKey: string;
}

interface R2Connection {
  accountId: string;
  endpointVariant: "default" | "eu" | "fedramp";
  bucket: string;
  prefix: string;
}

interface AwsConnection {
  region: string;
  bucket: string;
  prefix: string;
}

interface CompatibleConnection {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
}
```

### 9.2 Adapter

- AWS：SDK 默认 endpoint，显式 region/credentials。
- R2：`https://{accountId}.{variant?}.r2.cloudflarestorage.com`，region=`auto`。
- Compatible：严格 HTTPS endpoint、region、forcePathStyle。
- 所有 adapter 使用 `@aws-sdk/client-s3`。
- Client `dispose()` 调 `destroy()`。

### 9.3 S3Disk 参考边界

可移植以下已验证行为和测试思想：

- profile/endpoint/prefix normalizer；
- `ListObjectsV2` delimiter 目录语义；
- zero-byte directory marker；
- `IfNoneMatch="*"`；
- multipart 16 MiB part、10,000 parts、异常 abort；
- R2/AWS/compatible client 构造；
- `MaxKeys=1` probe；
- 缺 ETag expose 的 CORS 诊断。

不得从 `keymaster.cc` import `S3Disk/src/*`。需要的代码在 `plugin-storage` 重新建立，后续若稳定可抽独立 package。

### 9.4 条件写入能力与 best-effort 降级

Storage Service 为当前激活 Provider Config generation 维护运行时全局能力档案，并
注入该 generation 创建的 `S3ObjectStore`：

```text
putIfNoneMatch:               unknown | native | best-effort
completeMultipartIfNoneMatch: unknown | native | best-effort
```

- 两项能力独立；PUT 的判断不得改变 Complete，Complete 的判断也不得改变 PUT。
- `unknown` 首次发送带 `If-None-Match: *` 的原生请求；2xx 成功后单向锁定为
  `native`。
- `409 ConditionalRequestConflict` / `412 PreconditionFailed` 证明 Provider 已理解
  条件语义：先锁定 `native`，再返回 `storage_conflict`。
- 只有条件请求的原始 Provider 错误同时满足 HTTP `501` 与
  `NotImplemented`，且当前状态仍为 `unknown`，才单向锁定 `best-effort`；不能从
  归一化后的泛化错误猜测能力。
- `unknown` 遇到鉴权、网络、CORS、限流、其他 5xx 或未知错误时保持 `unknown` 并
  原样失败，后续请求可以重新探测。
- `native` 一经锁定不可降级；后续即使出现 `501 NotImplemented` 也按 Provider/系统
  错误处理，不执行 `HEAD` 或无条件重试。
- `best-effort` 小对象流程为 `HEAD`：存在则 `storage_conflict`，不存在则移除
  条件头后 `PUT`。
- `best-effort` multipart 流程在 Complete 前执行同样的 `HEAD`，不存在才发送
  不带条件头的 `CompleteMultipartUpload`。
- 同一能力处于 `unknown` 时使用首次探测门禁：一个请求负责分类，其他并发请求等待
  分类后再按锁定模式执行；PUT 与 Complete 不互相阻塞，普通无条件 I/O 不进入门禁。
- 能力由同一 Storage Service 内的当前配置 generation 全局共享，所有 App/Session
  共用；Vault lock/unlock 重建 client 不清除。Provider activate/replace/clear 产生新
  generation 时重置。V1 不写数据库，页面/进程重启后允许重新探测。
- 能力状态不通过 Provider summary 或 Connect API 暴露给 App；可信 Settings 可通过
  `storage.service` 的内部只读快照显示当前 generation 的运行时状态。
- `HEAD` 与最终写入不是原子事务，两个 Keymaster 客户端仍可能同时观察到不存在并
  覆盖。V1 将其定义为个人低并发 Provider 的兼容模式，不得在文档或 UI 中表述为
  原子创建。
- 非条件写入不经过能力探测或额外 `HEAD`。错误信息不得包含 Secret、完整物理 Key
  或原始 Provider response body。

### 9.5 Settings 手动条件能力检测

“测试连接”和“检测写入能力”是两个不同操作：前者继续只对当前表单候选配置执行
有界 `ListObjectsV2`；后者只对当前已保存、已激活且 `ready` 的配置执行真实写入，
不读取或隐式保存表单草稿。

可信 Settings 使用的内部契约建议为：

```ts
type StorageConditionalWriteMode = "unknown" | "native" | "best-effort";
type StorageCapabilitySource = "automatic" | "manual";

interface StorageConditionalCapabilityView {
  mode: StorageConditionalWriteMode;
  source?: StorageCapabilitySource;
  updatedAt?: number;
}

interface StorageConditionalCapabilitiesView {
  generation: number;
  put: StorageConditionalCapabilityView;
  complete: StorageConditionalCapabilityView;
}

interface StorageConditionalCapabilityProbeResult {
  generation: number;
  put: "native" | "best-effort" | "inconclusive";
  complete: "native" | "best-effort" | "inconclusive";
  cleanupWarning: boolean;
}
```

`StorageService` 增加获取快照和执行手动检测的方法；它们属于平台内部 capability，
Protocol adapter 不注册对应 `storage.*` method。运行时状态改变时发布内部 resource
更新，使 Settings 能看到首次真实使用的自动判断结果。

检测使用独立临时 `S3ObjectStore` 和独立能力状态，不先修改 active 状态：

```text
root = {normalizedProviderPrefix}.keymaster-system/capability-probe/{uuid}/

PUT:
  conditional PUT unique key
  ├─ precise 501 + NotImplemented -> best-effort
  ├─ other failure                -> inconclusive
  └─ success -> conditional PUT same key
             ├─ 409/412 -> native
             ├─ success -> best-effort (conditional header was ignored)
             └─ other   -> inconclusive

Complete:
  create/upload/conditional-complete unique key
  ├─ precise 501 + NotImplemented -> best-effort
  ├─ other failure                -> inconclusive
  └─ success -> create/upload/conditional-complete same key
             ├─ 409/412 -> native
             ├─ success -> best-effort (conditional header was ignored)
             └─ other   -> inconclusive
```

PUT 与 Complete 独立提交结论；某项 `inconclusive` 保留该项旧状态，不能清为
`unknown`，也不能根据另一项推断。手动检测是唯一允许把当前 generation 已锁定的
`native` 或 `best-effort` 显式改判的入口。结论提交前必须同时核对 active record
generation、active capability state 对象身份、Vault unlocked 与 service ready；任一
变化都丢弃结果。

手动提交需要递增该能力的运行时 revision。自动首次探测开始时捕获 revision，结束时
只有 revision 未变化才可写回，从而避免较早启动的自动探测覆盖较晚完成的人工结论。
已经发出的实际请求允许按其开始时模式结束，新的请求使用手动结论。配置 activate、
replace、clear/reset 仍创建或清除整个状态对象。

两个 Key 的对象删除、第二个 multipart upload 的 abort 及临时 client dispose 都放在
`finally`，并聚合清理错误，不能覆盖主检测结论。清理失败只产生脱敏 warning；已得到
的能力结论仍可提交。支持版本保留的 Provider 即使 DELETE 成功也可能保留历史版本，
UI 需提示请求费用与 lifecycle 影响。检测不得记录 Bucket、Secret、完整 Key、原始
Provider body 或 S3 UploadId。

## 10. 凭据存储

### 10.1 独立 DB

```text
DB: keymaster.storage
version: 1

stores:
  providerConfig   key="active"
  multipartUploads key=internalUploadId
```

Provider record：

```ts
interface StoredProviderConfigV1 {
  version: 1;
  key: "active";
  providerId: StorageProviderId;
  publicSummary: {
    // UI 可展示的非 Secret 摘要；不包含完整 accessKeyId
    bucketHint: string;
    endpointHint?: string;
    prefix: string;
  };
  sealedConfig: VaultSealedSecret;
  updatedAt: number;
}
```

完整 connection/auth 一起 sealed，避免 Bucket/Endpoint 在 App 可读同源环境中到处散落。设置 UI 通过 storage.service 读 summary，不直接读 DB。

### 10.2 Vault Capability

新增最小内部能力，命名可在实现时与 Vault 负责人确认：

```ts
interface VaultLocalSecretService {
  seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret>;
  open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array>;
}
```

固定 scope：

```text
keymaster.storage.provider-config.v1
```

这不是 Connect API，不暴露给 App。Vault locked 时 `open` 失败；storage service 不缓存跨 lock 的 plaintext。

### 10.3 Multipart Record

```ts
interface StoredMultipartUploadV1 {
  internalUploadId: string;
  connectSessionId: string;
  transportOrigin: string;
  publisherPublicKeyHex: string;
  appId: string;
  relativePath: string;
  physicalKey: string;
  sealedS3UploadId: VaultSealedSecret;
  parts: Array<{ partNumber: number; etag: string; size: number }>;
  expectedSize: number;
  expiresAt: number;
  createdAt: number;
}
```

S3 UploadId 与 ETag 不回 App。过期记录在下次 storage service 启动/unlock 时 best-effort abort；无法 abort 时保留可诊断状态并按有限次数重试。

## 11. 设置 UI

### 11.1 接入现有设置系统

`plugin-storage` 不注册独立顶层路由，而是在 attach 时向现有
`system-settings.registry` 注册：

```ts
systemSettings.register({
  id: "storage.system-settings.provider",
  group: {
    id: "storage",
    label: { key: "storage.settings.group", fallback: "S3 Storage" },
    order: 60
  },
  label: { key: "storage.settings.provider", fallback: "Provider" },
  component: StorageSettings,
  order: 10,
  visibleWhen: ({ unlocked }) => unlocked
});
```

因此用户入口固定为 `Settings -> System -> S3 Storage`。插件 teardown 时由现有
ownership 回收 registry item。Vault locked 时该表单不可挂载，也不能通过 UI
触发 secret 解密、Probe 或保存。

### 11.2 表单字段

公共字段：Provider、Bucket、Root Prefix、Access Key ID、Secret Access Key。
Provider 专属字段：

| Provider | 专属字段 | 默认值/规则 |
|---|---|---|
| AWS S3 | Region | 必填，不允许自定义 endpoint |
| Cloudflare R2 | Account ID、Endpoint Variant | variant=`default`；endpoint 只由 Keymaster 派生 |
| S3-compatible | HTTPS Endpoint、Region、Force Path Style | endpoint 禁止 URL credential；`forcePathStyle=false` |

Prefix 为空表示 Bucket root；非空时保存规范化的 trailing `/`。UI 可预览
`prefix/{publisherPublicKeyHex}/{appId}/`，但必须明确 Publisher/App 部分由
Keymaster 运行时派生，不是可编辑字段。

### 11.3 Secret 更新语义

候选配置使用显式 union，不能靠空字符串在 service 内猜测：

```ts
type StorageSecretUpdate =
  | { mode: "retain" }
  | { mode: "replace"; accessKeyId: string; secretAccessKey: string };

interface StorageProviderConfigDraft {
  providerId: StorageProviderId;
  connection: R2Connection | AwsConnection | CompatibleConnection;
  credentials: StorageSecretUpdate;
}
```

- 初次配置只允许 `replace`，两项凭据都必填。
- 编辑已有配置时默认 `retain`；DOM 中两个 secret input 始终为空。
- 用户勾选“替换凭据”后切到 `replace`，两项都必须重新输入。
- Provider 类型改变时强制 `replace`，不能把旧 Provider 凭据隐式复用。
- UI 只能读取 `****ABCD` 形式的 Access Key hint 和 `secretConfigured=true`；不得读取
  完整 Access Key 或 Secret。

### 11.4 Test Connection

Test 对当前表单中的候选配置执行：

```text
normalize -> merge retained secret inside service -> temporary S3Client
          -> ListObjectsV2(Prefix=normalizedPrefix, MaxKeys=1)
          -> destroy temporary client
```

Test 不写对象、不保存配置。成功状态绑定候选配置的稳定 fingerprint；任何字段
变化都立即使该成功状态失效。结果只显示 provider、耗时和脱敏诊断，不显示
endpoint response body、Authorization、S3 request id 或 Secret。

### 11.5 Save and Activate

保存按钮的产品语义是“Save and activate”。执行顺序：

1. 锁定 reconfiguration gate，拒绝新的 Storage I/O。
2. 规范化候选配置，并在 service 内合并需要保留的 sealed credential。
3. 用临时 client 执行只读 Probe；失败则解除 gate，旧配置继续服务。
4. 用 Vault sealing capability 加密完整配置。
5. 在单个 IndexedDB transaction 中替换 `providerConfig["active"]`。
6. 增加 provider generation，把已通过 Probe 的 client 提升为 active client。
7. 取消旧 generation 的在途请求、使 cursor/upload context 失效并销毁旧 client。
8. 发布 `ready` 状态并刷新脱敏 summary。

步骤 1 至 5 任一步失败不得更换旧 active client。事务提交后若发生不可恢复的
client 提升异常，service 进入 `degraded`，不允许向 App 假报可用。

### 11.6 Clear and Disable

Clear 是独立危险操作，需要二次确认并提示在途传输会中止。确认后先进入
reconfiguration gate，best-effort abort multipart，再以事务删除 active record，
清 cursor/upload context、销毁 client，最终状态为 `unconfigured`。DB 删除失败时
保留当前配置和 client，不得出现“UI 显示已清除但服务仍在运行”的分裂状态。

### 11.7 运行状态

设置页订阅 `storage.service`，至少呈现：

```text
unconfigured | locked | checking | ready | reconfiguring | degraded
```

`ready` 是 Connect `storage.*` 可执行的唯一 Provider 状态。页面同时显示最后成功
Probe 时间、Provider 类型、Bucket hint、Prefix 和脱敏 Access Key hint。CORS
诊断区提供当前 Keymaster origin 对应的可复制模板，但不自动修改 Bucket。

## 12. CORS

浏览器中的 Keymaster origin 直接调用 S3。Bucket CORS 至少允许：

```text
Origins: Keymaster 的实际 https origin
Methods: GET, HEAD, PUT, DELETE, POST
AllowedHeaders: authorization, content-type, range, if-match,
                if-none-match, x-amz-*, x-amz-content-sha256, x-amz-date
ExposeHeaders: ETag, Content-Length, Content-Range, Last-Modified
```

不同 Provider 的控制台格式不同，设置页提供说明链接/可复制模板，但不自动修改 Bucket CORS。

## 13. 错误模型

建议新增公开 Protocol error code：

```text
storage_not_configured
storage_not_found
storage_conflict
storage_invalid_cursor
storage_upload_invalid
storage_payload_too_large
storage_unavailable
```

内部 failure reason 可更细：

```text
storage_identity_missing
storage_namespace_invalid
storage_credentials_locked
storage_provider_config_invalid
storage_cors_error
storage_io_error
storage_multipart_cleanup_failed
```

原始 S3 body/XML 不对外。设置 UI 的 probe 可以显示脱敏后的 Provider 状态码和建议。

## 14. 生命周期与并发

本节由 [KMS3-016 Storage SharedWorker Runtime 硬切换施工单](./shared-worker-runtime-plan.md)
收口。Storage 逻辑上是独立 runtime，物理上归属现有 Keymaster Session Coordinator
SharedWorker；页面/plugin host 不再拥有 active Provider runtime。

- Provider 配置、状态、S3 client、cursor、multipart runtime 和 Provider I/O 只有一个
  Worker 内真值。
- Storage data request 不进入 Coordinator 全局 FIFO；mutation lane 串行，data lane
  有界并发，Vault lock 可抢占并 abort data lane。
- caller cancel 使用 request id 对应的 Worker cancel RPC；port disconnect、Session end、
  provider replacement 和 Vault lock 也会取消各自作用域请求。
- binary payload 通过 transferable `ArrayBuffer` 过 MessagePort，避免复制 16 MiB chunk。
- 每个请求绑定 session epoch 与 provider generation；旧世代迟到结果必须失败。
- 状态通过带 revision 和原子 baseline 的 `storage.state` topic 向所有 tab/window 发布。
- list cursor 和 multipart record 绑定 Connect session 与 provider generation；配置切换、
  lock、session abort 后失效或清理。
- Storage 凭据由 Worker 内的 Vault storage secret key 解密，不返回页面。

## 15. S3Disk 迁移接口映射

后续 S3Disk 的 Connect-backed `ObjectStore`：

| S3Disk ObjectStore | Connect Storage |
|---|---|
| `listDirectory` | `storage.list` |
| `hasAnyObject` | `storage.list(limit=1)` |
| `iterateDirectoryTree` | 多次 list 或后续 recursive list 扩展 |
| `createDirectory` | `storage.directory.create` |
| `putObject` 小文件 | `storage.put` |
| `putObject` 大文件 | `storage.upload.*` |
| `getObjectStream` | 循环 `storage.get(offset,length)` 生成 ReadableStream |
| `deleteObject` | `storage.delete` |
| `deleteDirectoryMarker` | `storage.directory.delete` |
| `probe` | Keymaster 设置页负责；App 不获得 provider probe |

S3Disk 迁移后删除自己的 Access Key/profile 管理，不再直接依赖 AWS SDK；其 UI/传输调度继续依赖 ObjectStore facade。

## 16. 安全不变量

```text
caller controls:
  connectSessionId, relative path, bytes, content type, range, overwrite

Keymaster controls:
  verified publisher, appId, namespace root, provider, bucket,
  endpoint, credentials, S3 upload id, continuation token
```

任何代码路径只要允许 caller 提交物理 S3 Key、Publisher 或 App ID，即违反本设计。
