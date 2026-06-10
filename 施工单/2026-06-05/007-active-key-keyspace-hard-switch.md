# 007 Active Key 与 Key Namespace 硬切换施工单

## 目标

一次性把系统切换为以下模型：

```txt
KeyIdentity
  平台第一映射对象。
  由公钥身份标识，不由私钥、地址或网络标识。

Active Key
  当前用户操作上下文。
  顶栏提供平台级 key switch widget。
  业务页面默认只进入当前 active key namespace。

Key Namespace Storage
  插件的 key 相关持久化数据必须落在 key namespace 下。
  删除 key 时由平台删除该 key 的 namespace storage。
  插件只负责停止任务、关闭连接、清理内存，不负责 delete where key = ?。
```

本次是硬切换，不保留“全局聚合为默认主路径 + 每个操作反复选择来源 key”的旧体验，也不保留插件各自用 `keyId` 字段模拟隔离的旧存储模型。

## 硬切换缘由

1. 系统已经是多 key Vault，但如果每个转账、收款、资产详情和历史页面都要求重新选择 key，用户会不断重复同一个上下文选择，体验会非常差。
2. `active key` 是钱包产品的常见主路径：用户先选择身份，再在这个身份下看资产、收款、转账、历史和设置。
3. key 是业务数据的自然根对象。P2PKH 的地址、余额、UTXO、历史、pending transfer；联系人备注；资产缓存；后台同步 cursor 都应该归属于某个 key namespace。
4. 用 `delete from xxx where keyId = ?` 或 IndexedDB index 扫描删除，会把 key 生命周期分散到每个插件内部，后续插件越多，越容易漏删、晚删或删错。
5. 私钥不能成为映射对象。平台可以公开公钥、公钥 hash、fingerprint 和 Vault 内部 key id，但私钥明文只能留在 Vault 的受控借用闭包内。
6. 地址不能成为平台根 namespace。地址是网络和脚本类型派生结果，同一把 key 可以有 main/test、P2PKH、其他脚本或资产资源。
7. 分步骤实施会形成双路径：

```txt
旧路径：插件打开固定 DB -> store/index 里带 keyId -> 页面手动选 key
新路径：平台 active key -> key-scoped storage -> 插件天然只看到当前 key 数据
```

双路径会导致同一插件同时维护全局缓存和 key scoped 缓存，删除 key 时也不知道应该删字段、删 DB 还是两者都删，因此本次必须硬切。

## 核心不变量

1. `KeyIdentity` 是系统第一 map 对象。
2. `active key` 是平台级状态，不是 P2PKH、Transfer 或 Assets 的私有状态。
3. `active key` 使用公钥身份映射，不能使用私钥、WIF、hex、地址或网络作为根 id。
4. Vault 保存加密私钥材料；平台公开的 key identity 只能包含公钥、fingerprint、标签、创建时间和能力摘要。
5. 私钥明文只能出现在 `vault.withPrivateKey` 回调或 importer parse 的短生命周期局部变量中。
6. key 相关业务数据必须通过平台提供的 key-scoped storage 打开。
7. 插件禁止直接打开固定名称的 key 相关 IndexedDB，例如 `indexedDB.open("p2pkh")`。
8. 插件可以拥有全局配置 DB，但不能把 key 相关业务记录塞进全局配置 DB。
9. 删除 key 时，平台负责删除该 key 下所有已注册 plugin namespace storage。
10. 插件响应删除事件只做停止任务、关闭 DB handle、释放内存缓存和 UI 刷新。
11. 后台任务必须绑定 key namespace。active key 切换只影响 UI 默认上下文，不自动停止其他 key 的必要后台收尾；删除 key 才必须取消该 key 的任务。
12. `全部 key` 只能作为只读总览模式。签名、广播、导出、删除、显示收款地址等动作必须落到单个 active key。
13. 页面说明、文档和注释使用中文；代码里的错误信息使用英文。

## 核心术语

### KeyIdentity

平台公开的 key 身份：

```ts
export interface KeyIdentity {
  /** Vault 内部 key id，用于借用私钥。 */
  keyId: string;
  /** 压缩公钥 hex。 */
  publicKeyHex: string;
  /** 平台 namespace id，建议 sha256(compressed public key) 的 hex 或 base58 表达。 */
  publicKeyHash: string;
  /** 短展示指纹，例如 publicKeyHash 前后截断。 */
  fingerprint: string;
  /** 用户标签。 */
  label: string;
  /** 私钥支持能力，例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
}
```

设计缘由：

```txt
keyId 是 Vault 内部引用。
publicKeyHash 是跨插件 namespace。
publicKeyHex 用于插件派生地址或验证导入去重。
address/network 不属于 KeyIdentity 根对象。
```

### ActiveKeyState

```ts
export type ActiveKeyMode = "single" | "all";

export interface ActiveKeyState {
  mode: ActiveKeyMode;
  activePublicKeyHash?: string;
}
```

约束：

1. `mode = "single"` 时必须有 `activePublicKeyHash`。
2. `mode = "all"` 时不能执行签名、广播、导出、删除、收款地址展示。
3. 没有任何 key 时，active key 状态为空，UI 显示导入入口。

### Key Namespace

推荐 DB 命名：

```txt
web-wallet.key.<publicKeyHash>.plugin.<pluginId>.<storageId>
```

示例：

```txt
web-wallet.key.4f9a...c1.plugin.p2pkh.state
web-wallet.key.4f9a...c1.plugin.contacts.book
web-wallet.key.4f9a...c1.plugin.assets.cache
```

设计缘由：

1. IndexedDB 没有真正的嵌套 namespace，只能通过 DB name 表达归属。
2. 删除 key 时平台可以对该 key 的所有已注册 DB name 执行 `indexedDB.deleteDatabase(name)`。
3. 插件不需要也不允许按 key 字段扫描删除。

## 最终结构

```txt
packages/
  contracts/
    src/
      keyspace.ts
      vault.ts
      plugin.ts
      topbar.ts
      background.ts
      assets.ts
      transfer.ts
      index.ts

  runtime/
    src/
      createPluginHost.ts
      registries/
        keyspaceRegistry.ts

  plugin-vault/
    src/
      manifest.ts
      vaultService.ts
      vaultDb.ts
      keyIdentity.ts
      KeySwitchWidget.tsx
      VaultSettingsPage.tsx
      VaultKeyDeleteModal.tsx

  plugin-p2pkh/
    src/
      manifest.ts
      p2pkhContracts.ts
      p2pkhDb.ts
      p2pkhService.ts
      p2pkhSyncCoordinator.ts
      p2pkhAssetProvider.ts
      p2pkhTransferProvider.ts
      widgets/
        P2pkhTransferWidget.tsx
      pages/
        P2pkhOverviewPage.tsx
        P2pkhHistoryPage.tsx
        P2pkhUtxosPage.tsx

  plugin-assets/
    src/
      AssetsPage.tsx
      AssetsHomeWidget.tsx

  plugin-transfer/
    src/
      TransferPage.tsx
      TransferOfferPicker.tsx

  plugin-background/
    src/
      backgroundService.ts
      BackgroundTray.tsx

apps/
  web/
    src/
      bootstrapPlugins.ts
      shell/
        Topbar.tsx
      styles/
        global.css
```

硬切换后删除或废弃：

```txt
packages/plugin-p2pkh/src/p2pkhDb.ts 中固定 DB_NAME = "p2pkh" 的打开方式
P2PKH store 中用于删除隔离的 keyId index
Transfer Widget 中每次必选“来源 key”的主路径
Assets 聚合页把所有 key 混在同一资产行的默认主路径
key.removed 作为插件自行删除持久化数据的语义
```

## 文件级施工

### packages/contracts/src/keyspace.ts

新增 keyspace 平台契约。

必须包含：

```ts
export type ActiveKeyMode = "single" | "all";

export interface KeyIdentity {
  keyId: string;
  publicKeyHex: string;
  publicKeyHash: string;
  fingerprint: string;
  label: string;
  capabilities: string[];
  createdAt: string;
}

export interface ActiveKeyState {
  mode: ActiveKeyMode;
  activePublicKeyHash?: string;
}

export interface KeyScopedStorageOpenInput {
  publicKeyHash: string;
  pluginId: string;
  storageId: string;
  version: number;
  upgrade(db: IDBDatabase, oldVersion: number, newVersion: number | null): void;
}

export interface KeyScopedStorageHandle {
  db: IDBDatabase;
  name: string;
  close(): void;
}

export interface KeyspaceService {
  listKeys(): Promise<KeyIdentity[]>;
  getKey(publicKeyHash: string): Promise<KeyIdentity | undefined>;
  active(): ActiveKeyState;
  setActive(publicKeyHash: string): Promise<void>;
  setAll(): Promise<void>;
  requireActiveKey(): KeyIdentity;
  onActiveChange(handler: (state: ActiveKeyState) => void): () => void;
  openKeyStorage(input: KeyScopedStorageOpenInput): Promise<KeyScopedStorageHandle>;
  registerPluginStorage(input: { pluginId: string; storageId: string }): void;
  prepareDeleteKey(publicKeyHash: string): Promise<void>;
  deleteKey(publicKeyHash: string): Promise<void>;
}

export const KEYSPACE_SERVICE_CAPABILITY = "keyspace.service";
```

说明：

1. `listKeys` 返回平台 identity，不返回私钥材料。
2. `openKeyStorage` 是 key-scoped IndexedDB 唯一入口。
3. `registerPluginStorage` 用于建立可删除清单；平台不能依赖临时扫描源码或猜 DB 名。
4. `prepareDeleteKey` 负责发出删除前事件、要求插件关闭 handle。
5. `deleteKey` 负责删除 namespace DB，再删除 Vault key。

### packages/contracts/src/vault.ts

扩展 `KeyRef` 或新增 `VaultKeyRecord` 对外字段。

必须新增：

```ts
publicKeyHex: string;
publicKeyHash: string;
fingerprint: string;
```

删除或降级以下字段的根语义：

```txt
address
network
```

处理方式：

1. `address` 可以暂时保留为兼容展示字段，但不能再作为 key 身份。
2. `network` 不能再表示 key 所属网络；网络由具体 plugin/resource 派生。
3. `findByAddress` 不应作为平台身份查找主路径。P2PKH 可以在自己的 namespace 内按地址查资源。

### packages/plugin-vault/src/keyIdentity.ts

新增公钥身份工具。

职责：

1. 从 32 字节私钥派生 compressed public key。
2. 计算 `publicKeyHash`。
3. 生成短 `fingerprint`。
4. 校验导入重复 key。

不负责：

1. 不保存私钥。
2. 不打开 P2PKH DB。
3. 不派生网络地址。

重复导入规则：

```txt
同一个 publicKeyHash 已存在时，vault.importPrivateKey 必须拒绝。
错误信息使用英文，例如 "Key already exists"。
```

### packages/plugin-vault/src/vaultDb.ts

升级 Vault DB schema。

`vault_keys` 必须新增字段：

```txt
publicKeyHex
publicKeyHash
fingerprint
```

新增 index：

```txt
publicKeyHash unique
```

迁移规则：

1. 旧 key 记录没有 public key 字段时，升级不能凭空从密文推导，因为没有用户密码。
2. Vault 解锁后必须执行一次 identity backfill：逐个 `withPrivateKey` 解密，派生并回写 public key 字段。
3. backfill 完成前，key switch widget 显示“正在初始化 key 身份”，禁止进入签名和删除。
4. 如果某条 key 解密失败，Vault 保持 unlocked，但该 key 标为 identity failed，只允许导出/删除，不允许作为 active key。

### packages/plugin-vault/src/vaultService.ts

调整导入、列出、删除事件。

导入流程：

```txt
require unlocked
derive KeyIdentity from private key
check publicKeyHash unique
encrypt private material
write vault_keys with identity fields
emit key.created { keyId, publicKeyHash }
if no active key -> keyspace.setActive(publicKeyHash)
```

删除流程不再是：

```txt
vaultDb.deleteKey(id)
emit key.removed { keyId }
```

必须改为：

```txt
keyspace.deleteKey(publicKeyHash)
```

实际删除顺序见 `KeyspaceService`。

注意：

1. `vault.withPrivateKey` 仍然使用 `keyId` 借用私钥。
2. 业务插件不应该把 `keyId` 当作 namespace，只能把它作为签名时传给 Vault 的引用。
3. `key.deleted` 事件 payload 必须带 `publicKeyHash`，可选带 `keyId` 只用于诊断。

### packages/plugin-vault/src/manifest.ts

Vault 插件必须提供或注册 keyspace 能力。

推荐做法：

```txt
plugin-vault 提供 vault.service + keyspace.service + key switch topbar item
```

原因：

1. key identity 来自 Vault。
2. active key 生命周期与 Vault lock/unlock 强相关。
3. key switch widget 放在 Vault 插件内可以直接消费 `vault.service` 与 `keyspace.service`。

如果后续拆出独立 `plugin-keyspace`，也必须满足：

```txt
plugin-keyspace 依赖 vault.service
plugin-vault 不依赖业务插件
业务插件只依赖 keyspace.service
```

本次不建议先拆独立包，避免硬切换时增加插件装载顺序复杂度。

### packages/plugin-vault/src/KeySwitchWidget.tsx

新增顶栏 key switch widget，注册到 `topbar.registry`。

位置要求：

```txt
order: 90
background.tray 当前 order: 100
```

这样 key switch widget 会显示在后台任务 widget 旁边，并位于其左侧。

UI 行为：

1. Vault 未 unlocked：不显示 key switch widget。
2. 没有 key：显示“无 key”按钮或短文本，点击进入导入页。
3. identity backfill 中：显示“初始化中”，禁用切换。
4. single 模式：显示当前 key label + fingerprint。
5. all 模式：显示“全部 key”。
6. 点击后弹出菜单：

```txt
全部 key（只读总览）
---
key label / fingerprint / capabilities
key label / fingerprint / capabilities
---
导入 key
管理 key
```

交互约束：

1. 切换 key 必须清空当前页面中未提交的 provider draft。
2. 如果当前页面存在未提交转账 preview，切换时必须弹确认。
3. 切换成功后触发 `activeKey.changed`。
4. 切换失败时保留原 active key。

样式要求：

1. 与 `BackgroundTray` 同高度。
2. 使用 lucide 图标，例如 `KeyRound`、`ChevronDown`、`Check`。
3. 长 label 必须截断，fingerprint 保留可见。
4. 移动端不能挤压锁定按钮，必要时只显示图标 + fingerprint。

### packages/runtime/src/registries/keyspaceRegistry.ts

如果 `KeyspaceService` 内部需要存储插件 storage registration，可放在 runtime registry。

职责：

1. 记录 `{ pluginId, storageId }`。
2. 校验重复注册。
3. 提供稳定排序。

不负责：

1. 不打开 DB。
2. 不知道 active key。
3. 不删除 Vault key。

如果最终把 registry 内聚到 `plugin-vault`，本文件可以不新增，但 `KeyspaceService` 必须具备同等能力。

### packages/plugin.ts / PluginManifest

可选扩展插件 manifest，声明 key scoped storage。

建议新增：

```ts
export interface PluginKeyStorageDeclaration {
  storageId: string;
  description?: string;
}

export interface PluginManifest {
  keyScopedStorages?: PluginKeyStorageDeclaration[];
}
```

装载时由 runtime 自动调用：

```txt
keyspace.registerPluginStorage({ pluginId: manifest.id, storageId })
```

如果不扩展 manifest，也必须在每个插件 setup 中显式注册 storage。

硬切换推荐扩展 manifest，因为它让“插件有哪些 key namespace DB”成为声明式事实。

### apps/web/src/bootstrapPlugins.ts

调整装载顺序。

目标顺序：

```txt
runtime 内置
vault/keyspace
home
settings
assets
key-import
transfer
contacts
woc
background
p2pkh
importers
```

注意：

1. `topbar.registry` 必须在 vault 注册 key switch widget 前存在。
2. `background.tray` order 仍为 100。
3. `KeySwitchWidget` order 为 90。
4. 业务插件依赖 `keyspace.service` 后，必须保证 vault/keyspace 先装载。

### apps/web/src/shell/Topbar.tsx

原则上不直接 import key switch widget。

只保留：

```txt
读取 topbar.registry
按 order 渲染 TopbarSlot
渲染锁定按钮
```

可以调整 actions 排列样式，但不能让 shell 依赖 `plugin-vault`、`plugin-background` 或 `plugin-p2pkh`。

### packages/plugin-p2pkh/src/p2pkhDb.ts

硬切为 key-scoped DB。

旧方式：

```ts
const DB_NAME = "p2pkh";
indexedDB.open(DB_NAME, DB_VERSION);
store.createIndex("keyId", "keyId");
```

新方式：

```txt
createP2pkhDb(input: {
  keyspace: KeyspaceService;
  publicKeyHash: string;
})
```

内部通过：

```txt
keyspace.openKeyStorage({
  publicKeyHash,
  pluginId: "p2pkh",
  storageId: "state",
  version: 1,
  upgrade
})
```

store 调整：

1. `p2pkh_addresses` keyPath 仍可用 `resourceId`。
2. `resourceId` 改为不包含 Vault `keyId`，建议：

```txt
resourceId = p2pkh:<network>:<scriptType>
```

或：

```txt
resourceId = p2pkh:<assetId>
```

3. `balances/utxos/history/pending/reservations` 不再保存 `keyId` 作为隔离字段。
4. 记录中可以保留 `publicKeyHash` 作为诊断字段，但不能依赖它删除。
5. `listResourcesByKey(keyId)` 删除，改为当前 namespace 内的 `listResources()`。

迁移策略：

1. 旧 `p2pkh` 全局 DB 中数据不能继续作为主路径。
2. Vault identity backfill 完成后，可以执行一次 best-effort 迁移：按旧记录 `keyId` 找到 `publicKeyHash`，写入对应 namespace DB。
3. 迁移成功后删除旧全局 `p2pkh` DB。
4. 迁移失败时不阻断钱包解锁，但必须丢弃旧 P2PKH 缓存并重新同步；缓存不是链上真值。

### packages/plugin-p2pkh/src/p2pkhService.ts

服务必须围绕 active key 工作。

新增或调整：

```txt
getActiveResource(assetId)
listResources()
getAssetBalance(assetId)
listHistory(filter?)
listUtxos(filter?)
prepareTransfer(input)
submitTransfer(preview, input)
```

约束：

1. 默认方法只读当前 active key namespace。
2. all 模式下，读方法可以聚合全部 key，但写方法、签名方法、转账方法必须抛错。
3. 转账 input 不再要求 UI 传 `keyId`，service 从 active key 获取 `keyId`。
4. 签名时只把 active key 的 `keyId` 传给 `vault.withPrivateKey`。
5. active key 切换时，service 关闭旧 namespace DB handle，打开新 namespace DB handle。

错误信息示例：

```txt
"Active key is required"
"Cannot sign in all-keys mode"
"Key storage is not ready"
```

### packages/plugin-p2pkh/src/p2pkhSyncCoordinator.ts

后台同步必须按 key namespace 注册和执行。

规则：

1. 每个 key 的每个 asset/resource 拥有独立 lane。
2. lane id 必须包含 `publicKeyHash` 和 resource id。
3. 删除 key 前，`key.deleting` 事件必须取消该 key 所有 lane。
4. 取消完成后关闭该 key namespace 的 DB handle。
5. active key 切换不删除、不取消其他 key 的必要队列，但 UI 只展示当前 active key 任务摘要。

建议 lane id：

```txt
p2pkh:<publicKeyHash>:<assetId>:recent
p2pkh:<publicKeyHash>:<assetId>:backfill
```

### packages/plugin-p2pkh/src/p2pkhAssetProvider.ts

资产 provider 默认返回 active key 资产。

single 模式：

```txt
BSV
BSV Testnet
```

每行只代表当前 active key 的余额。

all 模式：

```txt
BSV（全部 key）
BSV Testnet（全部 key）
```

只读聚合余额，detailRoute 进入只读总览。

不能做：

1. 不能在 single 模式下把所有 key 的余额汇总到一行。
2. 不能在 all 模式下提供直接转账入口。
3. 不能把 `keyId` 暴露给资产平台作为资产 id 的一部分。

### packages/plugin-assets/src/AssetsPage.tsx

页面行为调整：

1. 页面标题或 header 附近显示当前 key 上下文。
2. single 模式展示当前 active key 的资产。
3. all 模式展示聚合只读资产，并明确禁用需要单 key 的动作。
4. provider 加载失败只影响对应 provider，不影响 key switch widget。

### packages/plugin-transfer/src/TransferPage.tsx

转账平台必须要求 single active key。

进入页面时：

```txt
无 key -> 显示导入 key
all 模式 -> 提示选择一个 key 后转账
single 模式 -> 展示当前 key 的 transfer offers
```

不能再把“来源 key”作为平台级表单字段。

### packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx

删除主路径中的“来源 key”选择。

保留并突出显示：

```txt
当前 key label
fingerprint
当前网络地址
```

危险动作确认：

1. `准备预览` 前显示当前 key 上下文。
2. `签名并广播` 按钮附近显示 key label + fingerprint。
3. 如果 active key 在 preview 后发生变化，必须清空 preview 并要求重新准备。

不能做：

1. 不能让 widget 保存旧 keyId 并在切换后继续签名。
2. 不能允许 all 模式下 prepare/submit。
3. 不能用地址反查 key 来决定签名来源。

### packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx

页面改为 active key 视角。

single 模式：

```txt
展示当前 key 的 main/test resource、地址、余额、同步状态。
```

all 模式：

```txt
展示所有 key 的只读摘要。
每行必须显示 key label + fingerprint。
不提供签名、广播、删除私钥动作。
```

### packages/plugin-vault/src/VaultSettingsPage.tsx

Key 管理页必须使用 KeyIdentity。

每行显示：

```txt
label
fingerprint
public key 折叠展示
capabilities
createdAt
导出
删除
设为 active
```

删除按钮进入 `VaultKeyDeleteModal`，不能直接删除。

### packages/plugin-vault/src/VaultKeyDeleteModal.tsx

删除流程硬切为 key namespace 删除。

步骤：

```txt
1. 展示严重风险：删除会移除该 key 的私钥和所有插件本地数据。
2. 提供导出按钮，但不强制导出。
3. 要求输入 key label 或 fingerprint 确认。
4. 调用 keyspace.deleteKey(publicKeyHash)。
5. 删除成功后，如果删除的是 active key，自动切到下一把 key；没有下一把则进入无 key 状态。
```

特殊情况：

1. 某 plugin storage deleteDatabase 被 blocked：显示“需要关闭其他标签页或稍后重试”，不得先删除 Vault 私钥。
2. 某后台任务无法取消：不得删除 namespace DB，删除流程失败。
3. Vault 私钥删除失败：不得报告成功；已经删除的 plugin namespace 需要记录 tombstone，下一次进入时不恢复旧缓存。
4. 用户取消：不做任何持久化删除。

### packages/plugin-background/src/backgroundService.ts

后台任务 snapshot 增加 key 上下文。

建议字段：

```ts
keyScope?: {
  publicKeyHash: string;
  label?: string;
  fingerprint?: string;
};
```

用途：

1. BackgroundTray 可以按 active key 过滤或分组。
2. 删除 key 时能取消指定 key 的任务。
3. 任务错误能显示属于哪个 key。

不能让 background 理解私钥、地址、UTXO 或 P2PKH 业务字段。

### packages/plugin-background/src/BackgroundTray.tsx

展示规则：

1. single 模式默认优先显示当前 active key 的任务。
2. all 模式显示所有任务并按 key 分组。
3. 删除中的 key 任务显示“正在停止”。
4. 不允许在 BackgroundTray 里切换 active key；切换只在 KeySwitchWidget。

### packages/plugin-contacts/src/contactsDb.ts

联系人是否 key-scoped 必须明确。

本次硬切建议：

```txt
contacts 是 key-scoped plugin data。
```

原因：

1. 不同 active key 可以代表不同身份。
2. 同一地址在不同身份下的备注、标签和业务关系可能不同。

施工：

1. 使用 `keyspace.openKeyStorage({ pluginId: "contacts", storageId: "book" })`。
2. 删除全局 contacts DB 主路径。
3. all 模式只读时可以显示所有 key 联系人摘要，但新增/编辑联系人必须要求 single active key。

如果产品最终要全局联系人，必须在施工前单独确认，并把 contacts 标为 platform-global storage，不得默认混入 key namespace 规则。

### packages/plugin-woc/src/wocSettings.ts

WOC 配置保持全局，不进入 key namespace。

原因：

```txt
WOC URL、限流、endpoint 是平台网络配置，不属于某个 key。
```

### packages/plugin-settings/src/SettingsPage.tsx

设置页区分：

```txt
平台设置：Vault、WOC、插件配置。
当前 key 设置：key label、P2PKH 偏好、联系人等。
```

如果当前是 all 模式，key scoped 设置页只读或要求先选择单个 key。

### packages/ui/src/Select.tsx

如现有 Select 不适合顶栏菜单，不要强行复用成难用控件。

可以新增轻量组件：

```txt
MenuButton
DropdownMenu
```

但必须保持 UI 包通用，不出现 key、wallet、p2pkh 专属文案。

### apps/web/src/styles/global.css

新增样式：

```txt
.key-switch
.key-switch__button
.key-switch__panel
.key-switch__item
.key-switch__fingerprint
.key-switch__active
```

约束：

1. 顶栏高度不能因为 key label 变长而跳动。
2. key switch panel 不能遮挡后台任务 panel 的基础交互。
3. 移动端必须可用，长文本截断。

## 删除 key 的平台流程

标准流程：

```txt
用户确认删除
  -> keyspace.prepareDeleteKey(publicKeyHash)
    -> emit key.deleting { publicKeyHash }
    -> background.cancelByKey(publicKeyHash)
    -> plugin close storage handles
  -> keyspace delete namespace DBs
  -> vault delete encrypted key material
  -> active key fallback
  -> emit key.deleted { publicKeyHash, keyId }
```

删除顺序不可反过来。

原因：

1. 如果先删 Vault 私钥，后续 namespace DB 删除被 blocked，会留下无法再验证归属的业务数据。
2. 如果后台任务未取消就删 DB，迟到写入可能重建被删除 key 的缓存。
3. 如果 active key 不先处理，UI 可能继续向已删除 namespace 写入。

## 特殊情况处理

### 没有 key

1. 顶栏显示无 key 状态。
2. 首页显示导入入口。
3. 资产、转账、收款、历史显示空状态。
4. 后台任务不启动 key scoped 任务。

### 只有一把 key

1. 解锁后自动设为 active key。
2. key switch widget 仍显示，便于导入和管理。
3. 删除后进入无 key 状态，不自动进入 all 模式。

### 多把 key

1. 解锁后恢复上次 active key。
2. 如果上次 active key 已不存在，选择最近创建或列表第一把 key。
3. 用户可以切到 all 模式做只读总览。

### all 模式

允许：

```txt
资产汇总
历史汇总
后台任务总览
key 管理列表
```

禁止：

```txt
转账
签名
广播
导出当前 key
删除当前 key
显示“当前收款地址”
编辑 key-scoped 设置
```

遇到禁止动作时，页面必须提示选择一个 key。

### active key 切换时存在未提交表单

1. 普通草稿可以直接清空。
2. 转账 preview、已选 UTXO、reservation 前置状态必须清空。
3. 如果已经进入签名/广播中，切换按钮应禁用或提示等待当前操作完成。

### 删除 active key

删除成功后：

```txt
如果还有其他 key -> 自动切到下一把 key
如果没有其他 key -> active state 为空
```

不能切到 all 模式作为删除后的默认，因为 all 模式不是可操作身份。

### 删除非 active key

1. 不改变当前 active key。
2. 刷新 all 模式和管理列表。
3. 取消该 key 的后台任务。

### 其他标签页打开同一钱包

1. keyspace 删除 DB 前必须关闭当前标签页内的 DB handle。
2. 如果 `deleteDatabase` 触发 blocked，提示用户关闭其他标签页后重试。
3. 不允许在 blocked 状态下继续删除 Vault 私钥。
4. 可以用 BroadcastChannel 通知同源标签页准备关闭 key namespace。

### identity backfill 失败

1. 失败 key 不进入 active key 候选。
2. Key 管理页显示异常状态。
3. 允许导出或删除该 key。
4. 不允许业务插件为失败 key 创建 namespace。

### 旧 P2PKH 缓存迁移失败

1. 不阻断 Vault 解锁。
2. 删除旧缓存或标记 abandoned。
3. P2PKH 重新从 WOC 同步。
4. 不得把旧全局 DB 继续作为备用读取路径。

### 插件未注册 key scoped storage

1. 如果插件写 key 相关数据但未注册 storage，视为启动错误。
2. runtime 或 keyspace 必须在开发期抛出明确错误。
3. 不允许插件临时自行 `indexedDB.open` 绕过平台。

## 不能怎么做

1. 不能把 private key、WIF、hex 私钥作为 namespace id。
2. 不能把 address 作为平台根 key。
3. 不能把 network 放在 KeyIdentity 根语义上。
4. 不能继续让 P2PKH、Contacts、Assets 等 key 相关插件打开固定全局 DB。
5. 不能用 `delete where keyId = ?` 作为删除 key 的主方案。
6. 不能保留转账页面反复选择“来源 key”的主路径。
7. 不能在 all 模式下签名、广播或导出“当前 key”。
8. 不能让 Shell 直接 import `KeySwitchWidget` 或 `BackgroundTray`。
9. 不能让 background 平台理解 P2PKH、UTXO、地址或私钥。
10. 不能先删除 Vault 私钥再删 plugin namespace DB。
11. 不能在删除 key 后让迟到的后台任务重新创建该 key namespace。
12. 不能为了迁移旧数据而永久保留旧全局 DB 读取路径。
13. 不能把 active key 存成 secret；它是公钥身份状态，但仍应走平台 keyspace 状态管理。
14. 不能在 React state 中保存私钥材料或备份密码。
15. 不能为了快速实现而在每个插件里复制一套 active key 状态。

## 推荐实施顺序

这是一次硬切换，但代码落地可以按提交顺序组织；每个提交不能让主分支保持双路径可用。

1. 新增 `keyspace.ts` 契约和 `KeyIdentity`。
2. Vault schema 增加公钥身份字段、导入去重和 unlock 后 identity backfill。
3. 实现 `KeyspaceService`、active key 状态和 key-scoped storage 打开/删除。
4. Vault 注册 `KeySwitchWidget` 到 `topbar.registry`，order 设为 90。
5. P2PKH DB 改为 key-scoped storage，移除固定 `p2pkh` DB 主路径。
6. P2PKH service、asset provider、transfer provider 改为 active key 上下文。
7. Transfer 页面禁止 all 模式转账，P2PKH Transfer Widget 删除来源 key 选择。
8. Background task 增加 keyScope，删除 key 时取消对应任务。
9. Contacts 改为 key-scoped，或在施工前明确标为全局例外。
10. Vault 删除流程改为 `keyspace.deleteKey(publicKeyHash)`。
11. 移除旧事件语义和旧全局 DB fallback。
12. 补测试、跑验收。

## 测试要求

### 单元测试

必须覆盖：

1. 同一私钥重复导入被拒绝。
2. 不同私钥导入后产生不同 `publicKeyHash`。
3. 解锁旧 Vault 后 identity backfill 成功。
4. active key 自动选择规则。
5. all 模式下 `requireActiveKey` 抛错。
6. `openKeyStorage` 生成的 DB name 包含 publicKeyHash、pluginId、storageId。
7. 删除 key 时先触发 prepare，再删除 namespace DB，再删除 Vault key。
8. namespace DB 删除 blocked 时，不删除 Vault key。
9. P2PKH single 模式只读取当前 key namespace。
10. P2PKH all 模式只读聚合，转账抛错。
11. active key 切换后转账 preview 被清空。
12. 删除 active key 后 fallback 到下一把 key或无 key 状态。

### 集成测试

必须覆盖：

1. 导入两把 key，顶栏可切换。
2. key A 和 key B 的 P2PKH 地址、余额、历史互不污染。
3. key A 转账页面不再出现来源 key selector。
4. 切到 key B 后，转账默认使用 key B。
5. all 模式下资产页只读，转账页要求选择 key。
6. 删除 key A 后，key A 的 P2PKH namespace DB 被删除，key B 数据仍存在。
7. 删除 key 时后台任务停止，不再迟到写入。
8. contacts 如果 key-scoped，key A 和 key B 联系人互不污染。

### UI 验收

必须人工检查：

1. KeySwitchWidget 位于顶栏后台任务 widget 旁边。
2. 顶栏长 key label 不挤压锁定按钮。
3. 移动端 key switch menu 可打开、可选择、可关闭。
4. identity backfill 中 UI 有明确状态。
5. 删除 key modal 明确说明会删除私钥和插件本地数据。
6. all 模式下危险动作不可点击或有明确提示。

## 最终验收清单

- [ ] `packages/contracts/src/keyspace.ts` 存在，并导出 `KEYSPACE_SERVICE_CAPABILITY`。
- [ ] `KeyIdentity` 使用公钥身份，不使用私钥、地址或网络作为根 id。
- [ ] Vault key 记录包含 `publicKeyHex`、`publicKeyHash`、`fingerprint`。
- [ ] 重复导入同一私钥会失败，错误信息为英文。
- [ ] 解锁旧 Vault 后会执行 identity backfill。
- [ ] 顶栏存在 key switch widget，order 在 background tray 前。
- [ ] Shell 仍只通过 `topbar.registry` 渲染扩展项。
- [ ] active key 状态由平台服务维护，业务插件没有各自维护 active key。
- [ ] P2PKH DB 不再使用固定 `DB_NAME = "p2pkh"` 作为主路径。
- [ ] P2PKH key 相关 store 不再依赖 `keyId` index 做删除隔离。
- [ ] Transfer 页面 single key 才能转账。
- [ ] P2PKH Transfer Widget 不再要求用户每次选择来源 key。
- [ ] 转账签名仍只通过 `vault.withPrivateKey(activeKey.keyId, ...)`。
- [ ] all 模式只读，不能签名、广播、导出当前 key 或显示当前收款地址。
- [ ] 删除 key 时平台先取消任务并关闭 DB handle。
- [ ] 删除 key 时平台删除该 key namespace 下所有注册的 plugin DB。
- [ ] namespace DB 删除失败或 blocked 时，不删除 Vault 私钥。
- [ ] 删除 active key 后自动切到下一把 key；无 key 时进入无 key 状态。
- [ ] Background task snapshot 带 keyScope，但 background 不理解业务字段。
- [ ] Contacts 的 key-scoped 或 global 归属已明确，并按归属实现。
- [ ] 旧全局 P2PKH DB 不再作为备用读取路径。
- [ ] 旧 `key.removed` 自删持久化语义被 `key.deleting/key.deleted` 替代。
- [ ] 所有新增文档、页面说明和注释使用中文。
- [ ] 所有新增代码错误信息使用英文。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 或对应 workspace 测试通过。
