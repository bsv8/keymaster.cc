# Keymaster Connect Storage 需求文档

## 1. 文档信息

- 产品：Keymaster Connect Storage
- 仓库：`keymaster.cc`
- 状态：需求已确认；仓库已有原型实现，真实 Provider 与迁移验收仍未完成
- 关联项目：`KeymasterAppPackCore`、`MasterSeed`、`S3Disk`
- 文档性质：新能力提案；现行 Protocol V1 仍不包含 `storage.*`

本文定义 Keymaster 管理 S3-compatible 凭据、验证去中心化 App Identity，并通过 Connect 为每个 Publisher/App 提供严格隔离对象存储的需求。架构和协议见[设计文档](./design.md)，任务见[施工单](./implementation-plan.md)。

## 2. 背景

第三方 App 目前通过 Keymaster Connect 建立持续 Session。新能力要求用户在 Keymaster 内配置 S3 API Key，App 只能通过 Connect API 访问自己的远端目录，永远不能获得 S3 凭据、Bucket 真值或其他 App 数据。

App 由 Publisher 私钥签署公开 Identity Proof。相同 Publisher 可发布多个 App：

```text
Publisher A
  app-a
  app-b
  app-c

Publisher B
  app-a
```

物理隔离：

```text
{configuredRootPrefix}/{publisherPublicKeyHex}/{appId}/{relativePath}
```

同一 Publisher 下的 App 由 `appId` 分隔；不同 Publisher 即使复用同一 `appId` 也不会冲突。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Owner | Keymaster Connect 登录时用户选择的钱包 owner key |
| Publisher | App 开发者，其公钥来自已验证的 App Identity Proof |
| App ID | Publisher 命名空间内稳定唯一的 App 标识 |
| App Identity | `publisherPublicKeyHex + appId + appName` 及开发者签名 |
| Transport Origin | 当前 `postMessage` caller 的 exact `event.origin`，只保护当前 Session transport，不构成 App 身份 |
| Namespace Root | Keymaster内部派生的 S3 固定前缀 |
| Relative Path | App 可见、位于其 Namespace Root 下的对象路径 |
| Storage Provider Config | Keymaster 本地的 AWS S3、Cloudflare R2 或 S3-compatible 连接与凭据 |

## 4. 已确认决策

1. App Identity 不绑定 origin；任何部署者可以部署相同签名 App。
2. `event.origin` 仍绑定 Connect Session，防止其他 origin 直接复用 sessionId。
3. App 首次连接时通过 Connect 传递 `KeymasterAppPackCore` 生成的 Identity Proof；Keymaster不读取部署后的 `.keymaster.json`。
4. Keymaster必须验证 Identity Proof 的开发者签名。
5. 存储一级隔离是真实 Publisher 公钥，二级隔离是 `appId`。
6. App 请求不得携带或覆盖 Publisher、公钥前缀、App ID、Bucket、Endpoint 或 S3 Key。
7. V1 不定义 per-method 权限；已授权的有效 App Session 可使用全部 `storage.*` 方法。
8. S3 API Key 只配置在 Keymaster，第三方 App 永远不可读取。
9. V1 先支持一套全局激活 Provider Config；多 profile 不进入本期。
10. S3 连接行为参考已运行的 S3Disk，但 Keymaster不得运行时依赖 S3Disk 项目。
11. 为 S3Disk 后续迁移预留目录、分页、范围读取和 multipart 上传能力。
12. V1 不透明加密 App 对象内容；对象字节按 App 提交内容写入 S3。凭据本身必须加密落盘。
13. `overwrite=false` 优先使用 Provider 原生原子条件写入；Provider 明确不支持
    `If-None-Match: *` 时，个人低并发场景允许降级为 `HEAD` 后写入。该降级是
    best-effort，不宣称提供跨客户端原子性。能力判断由当前激活 Provider Config
    generation 全局共享，PUT 与 Multipart Complete 分别判断，并在 generation 内
    单向锁定。
14. 设置页为当前已激活配置提供独立的“检测写入能力”操作。手动检测可以显式重新
    判定当前 generation 的 PUT/Multipart Complete 状态；未执行时仍由首次真实条件
    写入自动判定。连接测试继续保持只读，不能与写入能力检测合并。

## 5. 产品目标

- Keymaster 设置页支持 AWS S3、Cloudflare R2 和通用 S3-compatible 配置。
- Connect Session 持久绑定经过签名验证的 Publisher/App Identity。
- 所有对象操作强制位于 `{publisher}/{appId}/` 下。
- 支持文件列表、目录标记、范围读取、小对象写入、删除和 multipart 上传。
- 对 App 只暴露相对路径和必要元数据。
- 支持取消、条件写入、分页和大文件传输。
- S3Disk 能在后续阶段用 Connect Storage Adapter 替换当前直连 S3 `ObjectStore`。

## 6. 非目标

- 不让 App 获得 S3 Access Key、Secret、Endpoint、Bucket 或 Presigned URL。
- 不按 origin 作为存储目录。
- 不按 Keymaster owner public key 作为 App 存储目录。
- 不在本期实现多个 Storage Profile。
- 不在本期迁移 S3Disk 代码。
- 不验证去中心化部署的实际 App 文件；Keymaster只验证公开 Identity Proof，文件一致性由部署者承担。
- 不提供对象版本管理、SSE-KMS 管理、跨 Bucket 复制或生命周期规则配置。
- 不把对象内容备份到 IndexedDB。

## 7. 功能需求

### FR-001 App Identity 输入与验证

`connect.login` 必须接收：

```ts
interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: { id: string; name: string };
  signature: string;
}
```

Keymaster必须按 KeymasterAppPackCore V1 的 JCS、domain separation、SHA-256 和 secp256k1 compact signature 规则验证。验证失败不得建立可用 Storage Session。

### FR-002 Session 持久绑定

Connect Session 必须新增：

```ts
publisherPublicKeyHex: string;
appId: string;
appName: string;
appIdentityDigestHex: string;
```

这些字段创建后不可由 caller 修改。`connect.resume` 复用原 Identity；App 更新名称或身份签名后需要重新 login 才能更新 session 快照。历史 session 缺少这些字段时不得使用 `storage.*`。

### FR-003 Namespace

Keymaster内部派生：

```text
namespaceRoot =
  normalizedProviderPrefix
  + lowercase(publisherPublicKeyHex) + "/"
  + appId + "/"
```

所有 S3 命令必须在同一个模块再次验证最终 Key 以该 root 开头。List 只使用该 root 作为固定 Prefix；返回结果必须剥离 root。

### FR-004 路径

Relative Path 必须：

- 使用 `/`；
- 不以 `/` 开头；
- 不含反斜杠、NUL、控制字符；
- 不含空段、`.` 或 `..`；
- 总长不超过 1024 字符，单段不超过 255 字符。

普通对象 path 不以 `/` 结尾；目录 marker 方法使用规范化的 trailing `/`。

### FR-005 列表与目录

必须支持当前目录分页：

- 固定 S3 `Prefix = namespaceRoot + relativePrefix`；
- `Delimiter = "/"`；
- 返回 directories、files、marker、opaque cursor；
- cursor 必须与 session/namespace/prefix 绑定，App 不获得可用于更换 Prefix 的原始能力。

必须支持创建和删除零字节 directory marker。

### FR-006 小对象写入

- 单次 Connect payload 上限 16 MiB；更大文件走 multipart。
- 支持 `contentType`。
- 支持 `overwrite=false`。默认映射 S3 `IfNoneMatch: "*"`；仅当 Provider 对带该
  条件的请求明确返回 HTTP `501` 且错误码为 `NotImplemented` 时，当前激活配置的
  PUT 条件能力锁定为“不支持原生条件写入”，并降级为
  `HEAD -> conflict 或无条件 PUT`。
- 首次条件 PUT 成功，或返回能证明条件语义已被识别的 `409/412` 后，PUT 能力锁定
  为原生支持；同一配置 generation 后续的 `501` 必须作为 Provider/系统错误返回，
  禁止从 native 再降级。
- 降级不能由鉴权、权限、网络、CORS、限流、普通 5xx 或未知错误触发。
- 降级流程在 `HEAD` 和 `PUT` 之间存在竞态，只提供 best-effort 防覆盖；这是 V1
  针对个人低并发使用接受的限制。AWS S3/R2 等支持条件头的 Provider 继续使用
  原子条件写入。
- 返回相对 path、size、etag 和 updatedAt；不返回物理 Key。

### FR-007 范围读取

`storage.get` 必须支持 offset/length，单次最多返回 16 MiB。结果包含：

- BinaryField content；
- contentType；
- totalSize；
- offset；
- eof；
- etag/lastModified（可用时）。

S3Disk 可通过循环 range read 组装 Web Stream，不要求 Keymaster一次把大文件载入内存。

### FR-008 Multipart 上传

必须提供 Keymaster抽象的 begin/part/complete/abort：

- 默认/最小 part size 16 MiB；
- 最大 10,000 parts；
- Keymaster返回自己的 opaque uploadId，不暴露 S3 UploadId；
- upload record 绑定 connectSessionId、transport origin、Publisher/App、path；
- ETag 只在 Keymaster内部完成 S3 complete；
- `overwrite=false` 的 Complete 优先发送原生条件头；Provider 明确不支持时按
  `HEAD -> conflict 或无条件 CompleteMultipartUpload` 降级，并接受相同竞态限制；
- Complete 的能力状态与小对象 PUT 独立；一方的成功或降级不能替另一方完成判断；
- 失败/取消 best-effort AbortMultipartUpload；
- stale upload 有可恢复清理策略。

### FR-009 删除

删除只接受 relative path。S3 DELETE 的幂等语义可映射为 `deleted=true`；如果产品需要严格 not-found，必须先 HEAD且文档说明额外请求成本。V1 默认幂等删除。

### FR-010 Provider 配置

V1 支持：

```text
cloudflare-r2
aws-s3
s3-compatible
```

连接字段与 S3Disk 已验证模型保持一致：

- R2：accountId、endpointVariant、bucket、prefix；region=`auto`。
- AWS：region、bucket、prefix。
- Compatible：HTTPS endpoint、region、bucket、prefix、forcePathStyle。
- Auth：accessKeyId、secretAccessKey。

通用 endpoint 禁止 URL username/password，V1 只接受 HTTPS（localhost 测试例外由开发开关控制）。

配置必须从 Keymaster 的 `/settings/system` 进入，由 `plugin-storage` 通过现有
`system-settings.registry` 注册，不新增平行设置系统。设置项仅在 Vault unlocked
时可用，并必须提供以下完整生命周期：

- 根据 Provider 动态显示并校验字段；
- 测试尚未保存的候选配置；
- 保存并激活一套全局配置；
- 展示脱敏后的当前配置和运行状态；
- 更新配置时保留或显式替换 Secret；
- 清除配置并立即停用 Storage Service；
- 给出浏览器直连 S3 所需的 CORS 模板和诊断。

“保存并激活”不是单纯写 IndexedDB：候选配置必须先完成本地校验和只读
Provider Probe，成功后才允许原子替换当前可用配置。候选配置失败时，旧配置和
旧 S3Client 必须继续工作。

### FR-011 凭据持久化

- Secret 不得进入 localStorage、日志、protocol command history 或 App result。
- Provider Config 使用独立 `keymaster.storage` IndexedDB。
- Access Key/Secret 必须由 Vault 拥有的本地 secret sealing capability 加密后落盘。
- Keymaster locked 时明文凭据不可用。
- vault lock、配置切换、插件 teardown 时销毁 S3Client 并清空内存 secret。
- 设置页不回显已有 Secret，只允许保留或替换。

### FR-012 Provider Probe

保存配置前/后提供显式测试：

```text
ListObjectsV2(Prefix=normalizedRootPrefix, MaxKeys=1)
```

Probe 不上传测试对象。错误对设置 UI 可诊断，对第三方 App 只映射稳定 Storage 错误。

设置页另提供“检测写入能力”，只使用当前已保存并激活的配置，在配置根 Prefix 下的
`.keymaster-system/capability-probe/{uuid}/` 临时目录执行 PUT、HEAD、DELETE 与
multipart 请求。PUT 与 Multipart Complete 分别检测：第一次对唯一 Key 条件写入，
第二次对同一 Key 再次条件写入；第二次 `409/412` 判定为 `native`，第一次精确
`501 + NotImplemented` 或第二次仍成功（Provider 静默忽略条件头）判定为
`best-effort`。其他鉴权、权限、网络、CORS、限流或 Provider 错误为“不确定”，保留
该能力原状态。临时对象和未完成 upload 必须在 `finally` 中清理；清理失败要显示脱敏
警告。该操作有真实请求、费用及版本保留影响，UI 必须明确提示。

手动检测是可信设置 UI 对当前运行时状态的显式重新判定，不改变普通请求中
`native` 不自动降级的规则。结果必须绑定检测开始时的 Provider generation；配置
切换、清除、Vault lock 或密码轮换后不得提交过期结果。未手动检测时，FR-006/FR-008
定义的首次使用自动判定保持不变。

### FR-013 S3 CORS

文档必须给出浏览器直连所需 CORS：GET、HEAD、PUT、DELETE、multipart 所需请求，允许 Keymaster origin，并 expose `ETag`、`Content-Length`、`Content-Range`、`Last-Modified`。缺少 multipart ETag expose 必须产生明确诊断。

### FR-014 App API 隐私

App 结果不得包含：

- Provider ID/config；
- Endpoint、Bucket、root prefix；
- accessKeyId/secretAccessKey；
- 物理 S3 Key；
- 其他 App 是否存在；
- 原始 S3 XML/body 或内部 uploadId。

## 8. 非功能需求

### NFR-001 安全

- App Identity、公钥、路径、session 和 origin 都必须在接收与执行阶段双重校验。
- Storage service 本身必须再次执行 namespace/path 门禁，不能只信 Protocol adapter。
- S3 请求禁止跟随跨 origin redirect。
- 日志只记录 provider 类型、状态码和 request correlation，不记录 secret 或完整用户文件路径。

### NFR-002 内存

- 单次 protocol 二进制 payload 最大 16 MiB。
- 大对象上传和下载必须分块。
- Provider adapter 不得在 list 时读取对象 body。

### NFR-003 兼容性

- 现有非 Storage Connect 方法行为不变。
- 新 Storage 能力缺 Provider 时 fail closed。
- 老 session 继续用于现有业务方法，但不能使用 Storage。

### NFR-004 可测试性

- Provider I/O 有内部 `ObjectStore` 抽象和 fake adapter。
- Namespace/path/identity 为纯函数测试。
- AWS/R2/compatible 有 opt-in smoke test，环境变量沿用 S3Disk 风格但使用 Keymaster 前缀。

### NFR-005 可取消性

所有 list/get/put/multipart 操作支持取消。取消必须停止后续分块，并 best-effort 清理 multipart。

## 9. 验收标准

1. 相同 Publisher 的 app-a/app-b 写入不同物理前缀，互不可见。
2. 不同 Publisher 的同名 app-a 互不可见。
3. caller 不能通过 path、cursor、uploadId 或伪造字段越过 namespace。
4. 伪造 Publisher 公钥但无对应签名时 login/Storage 被拒绝。
5. 同一个签名 App 从不同 origin 分别 login 后进入相同 Publisher/App namespace，但 sessionId 不能跨 origin 复用。
6. S3 Key 和凭据从不出现在 App result。
7. AWS S3、R2、通用 S3 的 probe/list/put/get/delete smoke 通过。
8. 16 MiB 边界、multipart、range read 和取消测试通过。
9. vault lock 后新 Storage 操作不能取得凭据，已有 S3Client 被销毁。
10. S3Disk ObjectStore 所需的 list、put、range download、delete、directory marker 能力均可由 Connect Adapter 映射。

## 10. 信任边界

公开 Identity Proof 可被任意部署者复制。Keymaster验证开发者签名并不证明当前网页字节等于 Publisher 签署的 Bundle；部署文件验证由部署服务器负责，用户信任所选择的部署者。Keymaster仍把当前 `event.origin` 固定到 Connect Session，避免一个 origin 直接复用另一个 origin 的 sessionId。
