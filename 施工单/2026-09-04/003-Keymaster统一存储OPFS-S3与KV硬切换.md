# 003：Keymaster 统一存储、OPFS/S3 与 K-V 硬切换

> 日期：2026-09-04
>
> 状态：待实施
>
> 优先级：P0
>
> 真值文档：`docs/存储结构.md`

## 1. 目标与冻结结论

本单把 Storage 提升为 Keymaster 的一号基础设施，硬切换启动顺序：

```text
选择/导入抽象桶
  -> 验证 OPFS/S3 可用性与事务能力
  -> 从桶的 keys/ 读取 Key/Vault
  -> 选择、导入或新建 Key
  -> 启动受限于当前 publicKeyHex 的系统 App
  -> 允许三方 App 建立受限存储会话
```

冻结结论：

1. 不做旧 IndexedDB/localStorage 数据迁移；
2. 一个抽象桶中容纳多把 Key，不是一 Key 一桶；
3. 系统 App 和三方 App 都受限于“当前桶 + owner public key + App”；
4. 只有平台 App/API 可以使用桶级全局权限；
5. 系统 App 必须在 manifest 中自声明 `UTXOS`、`Contacts` 等存储；
6. 业务数据全部 K-V 化，业务层不得获得 OPFS handle、S3 client 或物理路径；
7. 存储不可用时 fail closed，不回落到浏览器 DB；
8. S3 恢复探测由 Coordinator 全局管理，不由各页面或插件各自轮询。

## 2. 权限不变式

| 调用者 | 可见根 | 中文说明 |
|---|---|---|
| Storage/Vault/Keyspace 平台 API | 抽象桶根 | 只用于启动、`keys/`、Key 删除和 schema 管理 |
| `UTXOS` 系统 App | `<ownerPublicKeyHex>/UTXOS/` | 不得看到 Contacts、其他 Key 或桶根 |
| `Contacts` 系统 App | `<ownerPublicKeyHex>/Contacts/` | 不得看到 UTXOS、其他 Key 或桶根 |
| 三方 App | `<ownerPublicKeyHex>/<derivedAppUuid>/` | UUID 由 verified identity 派生，caller 不可指定 |

系统 App 不因为 `core/platform/business` 分类自动获得更大存储权限。
权限由 Host 依据装配时绑定的 manifest declaration 发放。

生命周期必须满足：

- 未选择存储：只渲染 Storage Onboarding；
- 存储未 `ready`：不打开 Vault/Keyspace，不启动业务插件；
- 切换桶：先 quiesce 当前 Key 任务和所有句柄，再丢弃旧世代运行时；
- 切换 Key：先 quiesce 旧 Key 任务和句柄，再发放新 Key 句柄；
- 迟到的旧 `bucketGeneration/keyGeneration` 请求一律拒绝；
- 不可用期间不建立本地离线写队列。

## 3. 契约改造

### 3.1 Storage contracts

修改 `packages/contracts/src/storage.ts`，将当前“Connect S3 文件 API”拆成三层：

```ts
/** Provider 层：只有 Storage 运行时可见。 */
interface StorageBucketProvider { /* OPFS/S3 物理对象操作 */ }

/** 平台层：可访问 keys/ 和桶管理区。 */
interface PlatformStorageService { /* root-scoped KV + lifecycle */ }

/** App 层：Host 已绑定 bucket/owner/app。 */
interface KeyValueStore { /* get/list/put/delete/commit */ }
```

关键字段必须带中文注释：

| 字段 | 中文含义 |
|---|---|
| `bucketId` | 抽象桶身份，不是 S3 bucket name |
| `bucketGeneration` | 当前选中桶的运行世代 |
| `ownerPublicKeyHex` | 当前 Key/owner 的压缩公钥 |
| `applicationStorageId` | 平台已验证并绑定的 App 存储 ID |
| `partition` | 需要一起原子发布的 K-V 集合 |
| `revision/ifRevision` | 乐观并发版本及写入条件 |

### 3.2 Plugin manifest 自声明

用新声明替换 `keyScopedStorages`：

```ts
interface PluginStorageDeclaration {
  /** key：受限于当前 owner；platform：仅可由装配层授权。 */
  scope: "key" | "platform";
  /** 稳定的 App 存储目录 ID。 */
  applicationStorageId: string;
  /** 数据 schema 版本。 */
  schemaVersion: number;
}
```

规则：

- Contacts 自声明 `scope=key, applicationStorageId=Contacts`；
- P2PKH/UTXO owner 自声明 `scope=key, applicationStorageId=UTXOS`；
- 其他系统 App 使用各自稳定的 storage ID；
- 三方 App UUID 由 `publisherPublicKeyHex + appId` 固定派生；
- 普通插件声明 `scope=platform` 必须被 manifest validation 拒绝；
- 装配层维护最小平台授权白名单，不按插件名或 kind 自动推断。

### 3.3 Keyspace

删除 `KeyScopedStorageOpenInput.upgrade(IDBDatabase, ...)` 和 `KeyScopedStorageHandle.db`。
`KeyspaceService.openKeyStorage` 只返回受限 `KeyValueStore`，不向插件交付
`IDBDatabase`、物理根路或 Provider 客户端。

## 4. Provider 与 K-V 引擎

### 4.1 OPFS Provider

新增 `packages/plugin-storage/src/providers/opfsBucket.ts`：

- 使用 `navigator.storage.getDirectory()`；
- 实现 bytes get/list/put/delete 和条件替换；
- Coordinator 是唯一 writer，并用 `navigator.locks` 防止旧 Worker 与新 Worker 并发；
- 探测 `persist()` 结果、quota 和可写性；
- 用临时文件 + close + head 替换发布 commit；
- 不存在 IndexedDB fallback。

### 4.2 S3 Provider

复用并收缩当前 `s3ObjectStore.ts`：

- 保留 AWS/R2/S3-compatible endpoint 和 CORS 门禁；
- 增加 `If-Match` 更新 head 和 `If-None-Match` 初始化 head；
- 激活前必须验证原生条件写；
- Connect Storage 现有 best-effort 降级不能用于平台、Vault、UTXO 或 Contacts 数据；
- 所有 Provider 错误映射到稳定、脱敏的 Storage 错误。

### 4.3 K-V commit 引擎

每个 App 命名空间使用保留区：

```text
<scope-root>/.keymaster/heads/<partition>
<scope-root>/.keymaster/commits/<partition>/<revision>-<commitId>
<scope-root>/.keymaster/values/<sha256>
```

提交流程：

1. 读取 partition head 和 Provider revision/ETag；
2. 验证 `ifRevision`；
3. 先写入 content-addressed values 和不可变 commit；
4. OPFS 替换 head，或 S3 通过 ETag 条件更新 head；
5. head 冲突则整个 commit 失败，不对副作用自动重试；
6. 读者只承认 head 可达的 commit/value；
7. Coordinator 低优先级执行 snapshot/compaction 和不可达对象 GC。

`.keymaster/` 对 App 不可见。这一层必须给 `put/delete/commit/list`
提供 OPFS 与 S3 一致的可观察语义。

## 5. 启动与全局状态机

### 5.1 新启动门禁

`apps/web/src/main.tsx` 不再先 bootstrap 全部插件。启动拆成：

```text
Phase 1: storage bootstrap + Storage Onboarding
Phase 2: platform storage ready + Vault/Keyspace bootstrap
Phase 3: selected/active Key ready + system/business plugins
Phase 4: third-party Connect Apps
```

`WEB_PLUGIN_CATALOG` 按 phase 激活，Storage 先于 Vault。当前
`vaultPlugin -> storagePlugin` 的顺序以及 Storage 对 Vault local-secret 的依赖一次性删除。

### 5.2 Storage Onboarding

新增存储首屏：

- 选择本地 OPFS；
- 新建 S3 Profile；
- 导入加密的 S3 Profile；
- 输入存储密码解锁 Profile；
- 展示 Provider、抽象桶 ID、脱敏位置和实时探测结果；
- 只有状态为 `ready` 才能进入 Key/Vault 页面。

旧 Storage Settings 不再是解锁后的 S3 附加页，而是平台启动必经入口与
解锁后管理入口共用同一个 profile editor。

### 5.3 S3 凭据 bootstrap

当前 `keymaster.storage` DB + `VaultLocalSecretService` 形成循环依赖，必须删除。
S3 Profile 使用独立存储密码加密，导出文件和本机 bootstrap envelope
共用一个版本化格式。该 envelope 是连接器，不是业务数据。

本机 bootstrap 只能保存：

```text
selectedProfileId
encryptedStorageProfileEnvelope
first-paint language/theme
```

严禁保存 Key/Vault、Contacts、P2PKH、App 配置、会话或业务队列。

### 5.4 健康与恢复探测

Coordinator 持有唯一 Storage Health Controller：

- 记录 `status/diagnostic/lastSuccessAt/lastFailureAt/nextProbeAt/latencyMs`；
- 对 network/CORS/provider 使用 1s 起始、最大 60s 的指数退避 + jitter；
- auth/config/schema 错误不无限自动重试，等待用户修复；
- `online`、页面恢复可见、用户手动重试可绕过当前 delay；
- 同时最多一个 probe，所有 Tab 共享结果；
- 业务 I/O 失败也必须反馈全局状态；
- 恢复 `ready` 后统一重载 keys/active-key resources，再重启后台任务。

UI 在 Storage 不可用期间显示全局阻断页/横幅、脱敏诊断、上次成功时间和
手动重试。不在各业务页面重复拼装 Storage 错误。

## 6. 数据硬切换清单

本节是“生产路径去 IndexedDB/localStorage”的最低清单，不代表要导入旧数据。

### 6.1 平台全局数据

| 现有位置 | 新 K-V 归属 | 处理 |
|---|---|---|
| `plugin-vault/vaultDb.ts` | `keys/` | Vault meta、加密 KeyHold、WebAuthn sidecar 改用平台 K-V |
| Coordinator session DB | 平台 session 区 | 只将需持久快照进 K-V；纯运行时状态保持内存 |
| `plugin-protocol/protocolStorageDb.ts` | 平台 protocol 区 | command/origin/fee-pool/session/token K-V 化，按安全边界分 partition |
| `plugin-storage/storageDb.ts` | bootstrap + 桶系统区 | 只保留允许的加密连接器；multipart/commit 真值在桶内 |
| runtime plugin config | 平台 settings 区 | 插件启停配置进 K-V |
| runtime logs | 平台 logs 区 | 有界日志 K-V 化，保持脱敏/清理策略 |

### 6.2 Key 受限系统 App

| 现有位置 | 新自声明目录 | 中文说明 |
|---|---|---|
| `plugin-contacts/contactsDb.ts` | `Contacts` | 联系人、索引和必要的 presence 持久证据 |
| `plugin-p2pkh/p2pkhDb.ts` | `UTXOS` | 交易事实、owned outpoint、本地交易、claim、sync state |
| `plugin-sat-subscription/satDb.ts` | `SatSubscription` | 订阅、账户、任务和必要审计状态 |
| `plugin-message/messageDb.ts` | `Messages` | 消息历史 |
| `plugin-webrtc/webrtcHistoryDb.ts` | `WebRTC` | 通话/传输记录和 blob |
| `plugin-token-bsv21/*Db.ts` | `BSV21` | token snapshot 与 mint history |
| `plugin-token-stas/stasDb.ts` | `STAS` | token snapshot |
| `plugin-collectible-1satordinals/*Db.ts` | `1SatOrdinals` | mint history |
| `plugin-poker/pokerDb.ts` | `Poker` | table/presence/transaction ingest |

### 6.3 配置与其他数据

- P2PKH、WOC、WebRTC、Background、Poker、BSV Price 的 localStorage 配置改为对应
  平台或 Key/App K-V；
- active/selected public key 改为桶内平台 K-V；
- MSFile global settings/suppliers/app policies/app usage 按数据 owner 拆到平台区或
  `<publicKeyHex>/MSFile/`；
- theme/language 在存储就绪后写入平台 settings；本地只保留首帧镜像；
- 临时 AbortController、cursor cache、session crypto key、resource cache 只位于内存，
  不为了“全部存储”而错误持久化。

### 6.4 无迁移硬切换

- 新代码不读取旧 DB/localStorage 业务 key；
- 不写 migration runner、双读、双写或 fallback adapter；
- 不在启动时自动删除旧数据；
- 新桶为空时必须表现为新 Keymaster，不从本地旧 Vault “恢复”；
- 如需清理，另提供明确的本机旧数据清理操作。

## 7. 代码结构硬切换

### 7.1 目标目录

删除“一个 `plugin-storage/src` 同时装下 Provider、平台权限、Connect 协议、
DB 和 UI”的混合结构。目标结构固定为：

```text
packages/
├─ contracts/src/storage/
│  ├─ bucket.ts                  # 抽象桶 Provider 契约
│  ├─ kv.ts                      # K-V、commit、revision 契约
│  ├─ access.ts                  # 平台/受限权限契约
│  ├─ profile.ts                 # OPFS/S3 Profile 与加密 envelope
│  └─ runtime.ts                 # 全局状态和诊断
└─ platform-storage/
   └─ src/
      ├─ bucket-providers/
      │  ├─ bucketObjectStore.ts
      │  ├─ opfs/
      │  │  └─ opfsBucketObjectStore.ts
      │  └─ s3/
      │     ├─ s3BucketObjectStore.ts
      │     ├─ s3ClientFactory.ts
      │     └─ s3ErrorMapping.ts
      ├─ kv-engine/
      │  ├─ partitionedKvEngine.ts
      │  ├─ kvCommitPublisher.ts
      │  ├─ kvSnapshotCompactor.ts
      │  └─ unreachableObjectCollector.ts
      ├─ storage-access/
      │  ├─ platform-root/
      │  │  └─ platformRootStore.ts
      │  └─ owner-app/
      │     ├─ ownerAppStore.ts
      │     ├─ ownerAppNamespace.ts
      │     └─ thirdPartyAppNamespaceId.ts
      ├─ bootstrap/
      │  ├─ storageProfileEnvelope.ts
      │  ├─ storageProfileRepository.ts
      │  └─ selectedStorageProfile.ts
      ├─ runtime/
      │  ├─ storageRuntimeController.ts
      │  ├─ storageHealthController.ts
      │  └─ storageGenerationFence.ts
      ├─ coordinator/
      │  ├─ storageRpcHandler.ts
      │  └─ storageGrantRegistry.ts
      └─ ui/
         ├─ StorageOnboardingPage.tsx
         ├─ StorageProfileEditor.tsx
         └─ StorageUnavailableGuard.tsx
```

包名从 `@keymaster/plugin-storage` 改为
`@keymaster/platform-storage`。它是平台基础设施，不是可选业务插件。
其 manifest 名称使用 `storagePlatformPlugin`，不再使用含义过宽的
`storagePlugin`。

### 7.2 Coordinator 目录

当前 Storage 逻辑散落在
`apps/web/src/keymasterSessionCoordinator.worker.ts` 中，必须抽出：

```text
apps/web/src/session-coordinator/
├─ keymasterSessionCoordinator.worker.ts
└─ storage/
   ├─ storageRuntimeOwner.ts
   ├─ storageRpcRouter.ts
   ├─ storageRequestRegistry.ts
   └─ storageStatePublisher.ts
```

Worker 根文件只负责组装和路由，不再持有 S3/OPFS/K-V 具体逻辑。

### 7.3 业务插件目录

业务持久化统一放到插件的 `storage/` 目录，且名字表达业务责任：

```text
packages/plugin-contacts/src/storage/
├─ contactsRepository.ts
├─ contactStorageKeys.ts
└─ contactIndexes.ts

packages/plugin-p2pkh/src/storage/
├─ p2pkhStateRepository.ts
├─ p2pkhStorageKeys.ts
├─ p2pkhPartitions.ts
└─ p2pkhIndexes.ts

packages/plugin-vault/src/storage/
├─ vaultKeyRepository.ts
├─ vaultMetadataRepository.ts
└─ webAuthnProtectionRepository.ts
```

其他插件遵守同一结构，不保留 `*Db.ts`、`open*Db`、
`getDb()` 或 `IDBDatabase` 相关命名。

### 7.4 强制重命名表

| 旧名字 | 新名字 | 原因 |
|---|---|---|
| `StorageService` | `StorageRuntimeController` | 原名无法区分运行时、K-V 和 Connect API |
| `S3ObjectStore` | `BucketObjectStore` | 同一契约需要支持 OPFS/S3 |
| `StorageAppContext` | `OwnerAppStorageGrant` | 新对象是已绑定权限，不是普通 context |
| `buildNamespaceRoot` | `buildOwnerAppNamespaceRoot` | 明确包含 owner 和 App 两级 |
| `KeyScopedStorageHandle` | `OwnerAppStore` | 它不再是 DB handle |
| `openKeyStorage` | `openOwnerAppStore` | 新函数打开的是 owner/App K-V 权限 |
| `keyScopedStorages` | `ownerStorageDeclarations` | 明确这是 App 自声明清单 |
| `storageDb.ts` | 拆分后删除 | 它混合了 Profile 和 multipart 责任 |
| `vaultDb.ts` | `storage/vaultKeyRepository.ts` 等 | 不再使用 DB 实现 |
| `contactsDb.ts` | `storage/contactsRepository.ts` | 名字表达业务 repository |
| `p2pkhDb.ts` | `storage/p2pkhStateRepository.ts` | 存储内容不只是 DB 表 |

新函数禁止使用 `openStorage`、`getStorage`、`saveData`、`loadData`
这类无法体现对象、scope 和副作用的宽泛命名。

### 7.5 不保留兼容层

- 不保留旧 package 的 re-export；
- 不保留旧 type alias；
- 不用 deprecated annotation 拖延删除；
- 不建立“新 repository 内部仍然打开旧 DB”的过渡实现；
- 生产 import 和测试 fixture 一次性更新到新路径和新名称。

## 8. 实施顺序

### KMSTORE-001：契约、命名空间与权限纯函数

- 增加 bucket/platform/key/app/K-V contracts；
- 增加 system manifest storage declaration；
- 实现第三方 App UUID 稳定派生；
- 实现 root builder 和最终 namespace guard；
- 测试系统 App 也无法越过 bucket/owner/app 边界。

### KMSTORE-002：OPFS/S3 Provider 统一契约

- 新增 OPFS Provider；
- 将 S3 ObjectStore 收敛到通用 bucket provider；
- 完成 read/write/delete/CAS/list 一致性测试；
- 真实 Chromium OPFS smoke；
- AWS/R2/S3-compatible opt-in smoke。

### KMSTORE-003：K-V commit 引擎

- 实现 partition head、immutable commit/value、CAS 和 conflict；
- 实现分页 list、snapshot、compaction 和 GC；
- 注入 crash point，验证 commit 每一步崩溃后只能看到旧版或新版；
- 两个客户端并发更新同一 head 时只有一个成功。

### KMSTORE-004：Storage-first 启动与 Profile

- 实现独立加密 S3 Profile 格式；
- 重排 plugin bootstrap phase；
- 实现 Storage Onboarding 和 global guard；
- 实现桶切换、generation fence 和 quiesce；
- 证明未 ready 时 Vault/Keyspace 代码根本未执行。

### KMSTORE-005：Vault/Keys 平台 K-V

- 重写 Vault DB adapter 为 `keys/` K-V；
- 加密私钥、Vault meta、WebAuthn sidecar 全部位于抽象桶；
- 选中 Key 也位于平台 K-V；
- 从空桶新建/导入，从非空桶解锁/选择；
- 删除 Key 时平台统一删除对应 owner root。

### KMSTORE-006：Contacts 与 P2PKH/UTXOS

- `Contacts` 自声明 key-scoped storage；
- `UTXOS` 自声明 key-scoped storage；
- Contacts 索引显式 K-V 化；
- P2PKH 交易、outpoint、claim、sync 索引显式 K-V 化；
- P2PKH 广播前持久化使用单个 partition commit；
- 切 Key、切桶、S3 失联和 CAS conflict 全部 fail closed。

### KMSTORE-007：其余持久化点收口

- 按第 6 节清单逐一替换；
- 删除 `KeyScopedStorageHandle.db`；
- 删除生产业务路径的 IndexedDB/localStorage 使用；
- 对二进制 blob 使用 K-V binary value，不 Base64 放大后再存 JSON；
- 更新边界 lint，只允许 Storage bootstrap 和首帧偏好访问浏览器持久化。

### KMSTORE-008：全局可用性与恢复

- 实现 Coordinator health controller 与退避；
- 实现所有 Tab 共享的 `storage.state` baseline/event；
- 业务 I/O 错误推进全局状态；
- 实现阻断页/横幅、手动重试与恢复后 resource invalidation；
- 实现背景任务暂停/恢复，不在页面轮询。

## 9. 边界门禁

新增/更新脚本，至少拒绝：

- Storage Provider 之外 import `@aws-sdk/client-s3`；
- Storage Provider 之外调用 `navigator.storage.getDirectory()`；
- 生产业务路径调用 `indexedDB.open`；
- 除白名单启动/首帧文件外调用 `localStorage`；
- 系统 App 获取 platform/root storage capability；
- App API 入参出现 bucket、owner root、physical key 或 Provider credential；
- 任何将 `storage_unavailable` catch 后写入本地 DB 的 fallback。
- 生产代码继续出现 `StorageService`、`KeyScopedStorageHandle`、
  `openKeyStorage`、`S3ObjectStore` 或 `*Db.ts` 旧符号/旧文件；
- 新目录反向 import 旧 `plugin-storage` 作为实现依赖。

## 10. 测试与验收

### 10.1 权限

- 同一桶两把 Key 同名 App 的数据完全隔离；
- 同一 Key 的 UTXOS/Contacts/三方 App 完全隔离；
- 系统 App 无法 list/get/put `keys/`、父目录或兄弟 App；
- 三方 App 无法伪造 owner public key、App UUID 或 bucket ID；
- 旧 Key/bucket generation 的迟到请求不能写入。

### 10.2 一致性

- OPFS 与 S3 通过同一 K-V conformance suite；
- commit 任一 crash point 后不出现部分可见；
- 并发 CAS 只有一个成功；
- S3 不支持原生条件写时不能进入 `ready`；
- P2PKH claim/local transaction/output 在同一 commit 可见。

### 10.3 启动与恢复

- 空桶进入 Key 新建/导入，非空桶列出桶内 Keys；
- 未选桶、Profile 未解锁、S3 失联时不启动 Vault 和业务 App；
- 更换浏览器后导入同一 S3 Profile 可看到同一批 Keys 和 App 数据；
- S3 断网进入 degraded，恢复后由单一全局 probe 回到 ready；
- degraded 期间没有隐式本地写入，恢后不会覆盖远端。

### 10.4 无迁移

- 旧 Vault/Contacts/P2PKH/Protocol 等 IndexedDB 即使存在，新系统也不读取；
- 旧 localStorage 业务配置不会 seed 新桶；
- 新系统不双写旧持久化；
- 边界 lint 对新违反直接失败。

### 10.5 结构与命名

- 从 package 和目录即可判断 Provider、K-V 引擎、权限、运行时和 UI 从属；
- 公开类型名即可判断是平台全局权限还是 owner/App 受限权限；
- 业务 repository 名字能表达保存的业务实体，不暴露底层 Provider；
- 仓库搜索不存在第 7.4 节的旧名字和兼容 re-export；
- architecture docs、protocol docs、注释和测试名同步使用新术语。

## 11. 完成定义

- Storage 是 Web 启动的第一个 required platform，Vault 不再早于 Storage；
- OPFS 和 S3 都能承载同一 K-V 数据模型；
- 加密后私钥、Contacts、P2PKH/UTXO 和其他持久化真值都经由统一存储；
- 一个桶可正确隔离多把 Key 及各自的系统/三方 App；
- 系统 App 也只持有自己的 bucket/key/app 受限句柄；
- 只有显式授权的平台 App/API 可见全局区；
- package、目录、文件、类型和函数名已完成语义化硬切换，无旧名兼容层；
- 生产业务代码不再直接使用 IndexedDB/localStorage/OPFS/S3；
- S3 故障、恢复和冲突有全局、可观测、fail-closed 语义；
- 全量 typecheck、单测、真实 Chromium OPFS e2e 和 opt-in S3 smoke 通过。
