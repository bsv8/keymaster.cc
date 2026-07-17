# 001 Vault Crypto Worker、会话级单 Key 与锁屏密码硬切换一次性迭代施工单

## 参考、优先级与硬切范围

本单以以下现状代码为施工基线：

- `packages/contracts/src/vault.ts`
- `packages/contracts/src/keyspace.ts`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-vault/src/crypto.ts`
- `packages/plugin-vault/src/vaultDb.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/plugin-vault/src/keyspaceService.ts`
- `packages/plugin-vault/src/KeySwitchWidget.tsx`
- `packages/plugin-vault/src/VaultSettingsPage.tsx`
- `packages/plugin-vault/src/VaultUnlockPage.tsx`
- `apps/web/src/shell/LockedShell.tsx`
- `apps/web/src/shell/AppShell.tsx`
- `packages/plugin-p2pkh/src/**`
- `packages/plugin-appmsg/src/**`
- `packages/plugin-broadcast/src/**`
- `packages/plugin-protocol/src/**`
- `docs/architecture/code-architecture.md`
- `docs/protocol/keymaster-protocol-common-v1-draft.md`
- `docs/protocol/keymaster-connect-v1-draft.md`

发生冲突时，本单关于“私钥唯一持有点、Worker 会话、锁屏密码、导入导出与 appView”的定义优先。以下旧设计整体失效，禁止沿用其私钥交接结论：

- `withPrivateKey(publicKeyHex, fn)` 向调用方借出原始私钥；
- `masterKey` / `masterSalt` 作为 unlocked 会话常驻状态；
- `OwnerRuntimeBootstrap.privateKeyHex`；
- appView 在 Vault 锁定后仍依靠 bootstrap 私钥继续执行；
- `vault_keys_legacy_staging`、`legacyId`、解锁期 legacy migration；
- bsv8 单 Key 导出作为本机 Vault 备份的唯一方案。

这是一次**硬切换**，不是兼容层：不保留旧 API、旧 Worker handoff、旧 staging 或旧数据修复分支。

---

## 1. 简述缘由

当前实现虽会清空解锁表单里的密码字符串，却把由密码派生的 `masterKey` 常驻在 `vaultService` 内存。任何 `withPrivateKey(任意 publicKeyHex)` 都可用它解开任何一条 `vault_keys` 记录。它不是密码明文，但拥有等价的“全 Vault 解锁能力”。

此外，私钥 hex 已被多处业务代码缓存或跨窗口交接：AppMsg、Broadcast、Protocol appView 都存在原始私钥副本。仅在 Vault 内把某个变量设为 `null`，不能满足锁定后私钥消失的语义。

本单目标是把能力边界改成：

```text
密码派生密钥：仅在一次解锁 / 导入 / 改密码操作的局部生命周期内存在。

长期私钥：仅存在于对应 Session Crypto Worker 内。

业务代码：只能请求受控密码学操作，永远拿不到 privateKeyHex。
```

这收窄了泄露面，并让“锁定 / 注销 / Session Window 关闭”具有可验证的资源销毁语义。

---

## 2. 最终单真值与边界

### 2.1 Key 身份

系统内唯一 Key 身份仍然是：

```text
publicKeyHex
```

它是私钥推导出的压缩 secp256k1 公钥的 hex 编码，可公开、稳定且唯一。它是 `vault_keys` 主键、会话绑定 Key、AAD 绑定 Key 和重复导入判定 Key。系统中不恢复 `keyId`、uuid 或其它 Key 域 surrogate id。

### 2.2 会话级私钥规则

“单 Key”按**会话 Worker**定义，不再错误地要求整个浏览器进程全局只能有一把 Key：

```text
Keymaster 主窗口                 -> Keymaster Session Crypto Worker -> 最多一把 Key
AppView Session Window A         -> App A Session Crypto Worker     -> 最多一把 Key
AppView Session Window B         -> App B Session Crypto Worker     -> 最多一把 Key
```

每个 Worker 只保有其 session 已解锁的 `publicKeyHex + activePrivateKey`。Keymaster、App A、App B 可以使用不同私钥；任何私钥都不能进入页面 JS、React state、插件 service、日志、消息 payload、URL、IndexedDB、localStorage 或 sessionStorage。

### 2.3 Worker 角色

逻辑上分为两类，不要求由同一个脚本文件实现：

1. **Vault Coordinator**：跨窗口协调与持久化入口；可为 `SharedWorker` 或由主应用持有的等价单例。它读取 `vault_meta` / `vault_keys`，仅在操作局部派生密码密钥；不长期持有私钥或 `masterKey`。
2. **Session Crypto Worker**：一个 Keymaster 主会话或一个 appView session 对应一个 Worker。它只持有该 session 的一把 `activePrivateKey`，并只处理允许的受控密码学操作。

创建 session 时，Coordinator 解开选中的私钥后，以 transferable `ArrayBuffer` 将材料交给目标 Session Crypto Worker；转移后发送端 buffer 必须 detach。Coordinator 不缓存该私钥。

### 2.4 这不是硬件隔离

Worker 把私钥从业务 JS 堆隔离出来，但不是 HSM，也不能单独抵御同源 XSS：恶意同源代码可能试图请求签名。因此 capability 必须窄、绑定 session / publicKeyHex / 调用权限，并保留既有的用户确认和 origin 授权。Worker 的价值是杜绝原始私钥被任意插件读取、复制和长期缓存。

---

## 3. 明确禁止项

完成后，生产代码中不得存在：

```ts
vault.withPrivateKey(publicKeyHex, fn)
privateKeyHex: string // 出现在 plugin / UI / bootstrap / 对外 contract 中
masterKey // 作为 service / session / module 常驻字段
masterSalt // 作为 service / session / module 常驻字段
OwnerRuntimeBootstrap.privateKeyHex
exportUnlockRuntimeForSessionWindow(...)
importUnlockRuntimeFromLauncher(...)
vault_keys_legacy_staging
legacyId
```

尤其禁止以下“看似受控、实则泄露”的替代品：

1. `withActivePrivateKey(fn)`：回调仍可捕获私钥，不可接受。
2. `executeCrypto(fn)`：任意回调在 Worker 内执行也不可接受，必须使用显式的 discriminated operation。
3. Worker 返回 `privateKeyHex`、原始私钥 bytes、长期对称派生 key 或可复用的解锁 token。
4. AppView 从 launcher 直接接收私钥、用 `postMessage`、全局对象或 bootstrap registry 传私钥。
5. Keymaster 锁定后继续让 Keymaster Worker 或任何已撤销 capability 服务签名。
6. 遇到 `legacy staging` 残留时静默迁移、保留或删除部分记录；硬切后该 object store 根本不存在。

---

## 4. 持久化与密码学格式

### 4.1 最终 Vault 数据

```text
vault_meta
vault_keys[publicKeyHex]
```

`vault_meta` 不是缓存，也不是密码或私钥。它必须持久化：

- `id = "singleton"`；
- `cryptoVersion`；
- `kdf = "pbkdf2-sha256"`；
- PBKDF2 迭代次数与输出长度；
- 随机 KDF salt；
- verifier 的 IV、密文及版本化 AAD 标识；
- `createdAt`。

当前 PBKDF2-SHA-256、200,000 iterations 继续使用；本单不切 Argon2。密码按用户输入的 UTF-8 原样处理：不 trim、不自动 Unicode normalize。

`vault_keys` 以 `publicKeyHex` 为唯一主键，保存公开元数据及一把私钥的 AES-GCM 密文。私钥密文的 AAD 固定为可复现的 UTF-8：

```text
keymaster:v2|vault-key|{publicKeyHex}
```

verifier AAD 固定为：

```text
keymaster:v2|vault-verifier
```

AAD 必须在 `cryptoVersion` 文档化后固定，不允许临时 JSON stringify 任意对象。解密后仍须验证私钥推导出的 `publicKeyHex` 等于记录主键。

### 4.2 删除 staging 与旧格式

下一次 IndexedDB schema 升级必须无条件删除 `vault_keys_legacy_staging` object store；类型、DB helper、unlock migration、文档和测试同步删除。该动作会永久丢弃仍仅存在于 staging 的历史数据，这是本单明确接受的硬切后果。

正式 `vault_keys` 缺 `publicKeyHex` 或必要加密字段时一律视为不受支持/损坏，fail-closed，不尝试修复。

### 4.3 现有正式记录的 AAD 升级

旧 staging 与“现有正式记录尚未使用 AAD”是不同问题。为了不把正式数据误当 staging 丢弃，发布此硬切版本时必须执行一次性正式格式升级：用户输入正确锁屏密码后，Coordinator 顺序解密全部 canonical `vault_keys`，按 `cryptoVersion = v2` 和上述 AAD 重加密，再原子写回 `vault_meta + vault_keys`。成功前不创建任何 Session Worker；失败则不进入 unlocked。

该升级只接受现有 canonical `publicKeyHex` 记录，不保留 legacy fallback。升级完成后旧无 AAD 读取器删除。

---

## 5. 对外能力模型

### 5.1 删除 `withPrivateKey`

`VaultService` 不再暴露 `PrivateKeyMaterial`、`withPrivateKey` 或按任意 `publicKeyHex` 解密的能力。`KeyspaceService.setActive` 也不再是“选中即具备签名能力”的公开入口；Key 切换必须经过 session 解锁流程。

### 5.2 新的受控能力

新增 `ActiveKeyCrypto` capability。它是 session 范围对象，调用方只能拿到公开 session 状态，不能拿到私钥。接口按实际业务定义为显式方法，例如：

```text
getIdentity()
signDigest(...)
signTransaction(...)
deriveP2pkhAddress(...)
appMsgEncrypt(...) / appMsgDecrypt(...)
protocolEncrypt(...) / protocolDecrypt(...)
exportEncryptedKeyBackup(...)
```

每次调用必须同时校验：

1. session 未撤销；
2. 请求绑定的 `publicKeyHex` 等于该 Worker 的 active Key；
3. 调用方拥有该 operation 的 capability；
4. Protocol / appView 请求仍通过既有 origin、sessionId、用户确认与权限策略。

不能提供无权限“任意 digest 签名”公共接口；调用方身份及用途必须由 capability 层表达。

### 5.3 现有插件的收口

- P2PKH：改用 `signTransaction` / `deriveP2pkhAddress`，不再借私钥。
- AppMsg：删除 `currentBoundOwnerPrivateKeyHex`；provider signer 仅持有签 challenge、加解密的受控函数，内部状态只记 owner `publicKeyHex`。
- Broadcast：删除 `currentPrivKeyHex` 与 bound session 私钥副本；provider bind 只接收签名函数，session 只记 owner 公钥。
- Poker：改为 ActiveKeyCrypto 对应 operation，不再把 hex 传入 poker crypto。
- Protocol：删除 `OwnerRuntimeBootstrap.privateKeyHex`，不再使用 `bootstrap_owner` / `vault_unlock` 两路私钥 runtime。

---

## 6. 会话生命周期与流程

### 6.1 Keymaster 解锁

```text
锁屏页列出公开 Key 元数据
  -> 用户选择 publicKeyHex A，输入锁屏密码
  -> Coordinator 临时派生 K_password，校验 verifier，解密 A
  -> 私钥 buffer transfer 给新 Keymaster Session Crypto Worker
  -> 丢弃 K_password、密码、临时明文与发送端 buffer
  -> Keymaster 显示 unlocked；active = A
```

完成时不保存 `masterKey`、`masterSalt` 或“可解开其它 Key”的 token。

### 6.2 Keymaster 切换：旧 Key 在失败前仍有效

切换 B 不是直接 `setActive(B)`。固定流程：

1. 用户打开切换器并选 B 时，A Worker 不受影响；取消不改变 A。
2. 用户输入密码，Coordinator 仅临时校验密码；密码错误时 A 继续有效。
3. 校验成功后才进入不可逆提交态：停止 A 的新 operation、撤销 A capability、销毁 A Worker；再用临时密码密钥解开 B，创建 B Worker。
4. 成功后 active 变为 B；临时密码密钥立即丢弃。
5. 若 B 记录在提交态被发现损坏或创建 B Worker 失败，状态收敛到 locked，明确显示“B 无法解锁”；不得保留全库解锁能力。用户可重新输入密码解锁 A。

第 1、2 步保证误触、取消、错误密码不会把用户从 A 注销；第 5 步不做“同时保留 A、B 以自动回滚”，以维持单 session 一把私钥的边界。

### 6.3 Keymaster 锁定、注销与自动锁定

- 手动锁定或注销：撤销 Keymaster capability 并终止 Keymaster Session Crypto Worker；Keymaster active `publicKeyHex` 与私钥同时消失。
- 页面关闭：对应 Keymaster Worker 必须终止；恢复/刷新一律回到锁屏，不复用旧 session。
- 自动锁定：默认 5 分钟无用户活动后锁定 Keymaster；页面不可见持续进入该时间窗也计时。用户可将时长配置为更短，不支持“永不自动锁定”。
- 锁定只作用于 Keymaster 会话，不隐式销毁仍打开的独立 appView session；后者由自己的 Session Window 生命周期管理。

### 6.4 appView session

appView 不继承 Keymaster 的 Worker、解锁态或私钥。启动每个 appView 时：

```text
创建 connect session
  -> 用户为该 session 选择 publicKeyHex 并输入锁屏密码
  -> Coordinator 仅解开该 Key
  -> 建立该 Session Window 专属 Session Crypto Worker
  -> 该 Worker 仅服务该 sessionId + publicKeyHex
```

`publicKeyHex` 是 appView 当前 session 的运行时事实，不作为“下次默认使用哪把 Key”的持久化配置。Session Window 关闭、刷新、崩溃、显式 endSession 或 capability 被撤销时，立即终止其 Worker，`publicKeyHex` 与私钥同时失效。

appView 可以与 Keymaster 或其它 appView 使用不同 Key；但不能跨 session 调用 Worker、切 Key 或取得其它 session 的 operation port。

### 6.5 修改锁屏密码

输入：旧锁屏密码、新锁屏密码、确认新锁屏密码。

```text
进入 Vault maintenance（拒绝新的敏感操作）
  -> 临时用旧密码派生 K_old 并校验 verifier
  -> 生成新 salt，临时派生 K_new
  -> 对全部 vault_keys：K_old 解密一条 -> 验公钥 -> K_new + AAD 重加密一条
  -> 生成新 verifier
  -> 单个 IndexedDB 原子事务替换 vault_meta + 全部 vault_keys
  -> 丢弃 K_old / K_new / 全部临时明文
  -> 保持 Keymaster locked
```

改密码只处理正式 `vault_meta + vault_keys`，不读取任何 staging。事务提交前失败，旧密码与旧密文必须完整可用；提交成功后旧密码立即失效。提交后不自动重新解锁，用户必须用新密码重新解锁所需 Key。

在改密码开始时，Keymaster 必须锁定。已打开 appView session 不得再创建新 operation；本期固定为**全部 appView session 也必须被请求关闭并销毁其 Worker，maintenance 完成后由用户重新启动**，避免旧 session 私钥跨越密码根轮换。

### 6.6 新建与导入

新建首 Key：用户设置 Vault 锁屏密码，Coordinator 创建 meta、临时派生密码密钥、加密首 Key；首 Key 可直接 transfer 给新 Keymaster Worker，随后清除派生密钥。

导入必须区分两种密码：

```text
来源格式密码（可选） -> 解开导入文件 / WIF envelope，得到临时私钥
系统锁屏密码          -> 加密存入 vault_keys
```

- 新 Vault：输入或确认新的系统锁屏密码，写入 `vault_meta + vault_keys`；不得产生只有 meta、没有 Key 的空 Vault。
- 已有 Vault：必须输入当前系统锁屏密码；活动私钥不能替代该密码。验证后才加密写入新 `vault_keys`。
- 私钥导入成功后默认不切换 Key；要使用它，走独立的解锁/切换流程。
- `publicKeyHex` 已存在时一律报 `Key already exists`，不覆盖、不合并、不替换。
- 来源密码错误、系统锁屏密码错误、文件解析失败或写入失败时，均不得写任何 Key。

### 6.7 单 Key 加密备份导出与导入

导出不是 bsv8 明文/再加密导出，而是直接复制本机加密记录：

```text
Key Backup =
  backupVersion
  sourceVaultMeta = vault_meta
  keyRecord = selected vault_keys[publicKeyHex]
```

导出只读 IndexedDB：不要求 Key 已解锁、不要求再次输入锁屏密码、不创建 Worker、不产生明文私钥。备份解锁密码就是导出时的 Vault 锁屏密码。

导入该备份时：

- 到新 Vault：输入来源 Vault 锁屏密码解开备份 Key，再设置目标 Vault 锁屏密码并重加密；可以选择同一个密码，但不是强制。
- 到已有 Vault：来源 `sourceVaultMeta` 仅用于派生来源解密密钥；必须再输入目标 Vault 当前锁屏密码后，按目标 meta 重加密写入。来源 meta **绝不能覆盖**目标 meta。
- 修改锁屏密码不会重写已经导出的备份；旧备份继续由旧密码保护。需要新密码保护时，用户重新导出。

---

## 7. 特殊情况与 fail-closed 规则

| 情况 | 必须行为 |
|---|---|
| 解锁密码错误 / 取消切换 | 原 Key session 保持有效；不创建新 Worker。 |
| 切换提交后 B 记录损坏 | A 已撤销，Keymaster 收敛为 locked；不缓存密码根，不同时保留 A/B；用户可重新解锁 A。 |
| Worker 崩溃 / port 断开 | 该 session 立刻视为 locked/revoked；所有 in-flight operation 失败，不自动重建或重试。 |
| Session Window 关闭/刷新 | 销毁该 appView Worker；不持久化 `publicKeyHex` 或私钥以供恢复。 |
| Keymaster 锁定 | 仅销毁 Keymaster Worker；独立 appView 不继承该 Worker，也不能回退使用它。 |
| 改密码 | 全部 session Worker 销毁；事务失败保持旧持久数据，完成后全局无已解锁 session。 |
| DB 读取、形状校验或原子写入失败 | 进入明确错误/locked，不伪装为首次启动、不删除 canonical 数据。 |
| 发现 legacy staging store | schema 升级直接删除该 store；运行时不应看到它。 |
| canonical record 缺 publicKeyHex / AAD 验证失败 / 私钥公钥不符 | 视为损坏，拒绝该解锁/导入/改密码操作；不得推测或修复。 |
| 导入重复 publicKeyHex | 拒绝，现有记录不变。 |
| 旧备份密码错误 | 不读取目标 Vault，不写任何数据。 |
| Worker 请求其它 publicKeyHex | 拒绝 `session_key_mismatch`；绝不按请求重新解密其它 Key。 |

---

## 8. 文件级施工清单

### 8.1 新增文件

| 文件 | 工作 |
|---|---|
| `packages/contracts/src/activeKeyCrypto.ts` | 定义 `ActiveKeyCrypto`、显式 operation 输入/输出、session revoke 错误；不定义私钥材料。 |
| `packages/contracts/src/vaultSession.ts` | 定义 Keymaster/appView session、`sessionId`、公开 `publicKeyHex` 状态及生命周期 contract。 |
| `packages/plugin-vault/src/vaultCoordinator.ts` | 实现临时密码派生、单 Key 解封、导入、备份恢复、AAD 正式升级、改密码原子准备；不存常驻私钥/密码根。 |
| `packages/plugin-vault/src/sessionCryptoWorker.ts` | Worker 入口；仅在 Worker 内保有一把 active 私钥，并实现 ActiveKeyCrypto operation。 |
| `packages/plugin-vault/src/sessionCryptoProtocol.ts` | Coordinator / Worker / session port 的消息 schema、capability token 与 transfer helper；严禁私钥出现在可序列化公共 payload。 |
| `packages/plugin-vault/src/keyBackup.ts` | 单 Key 加密备份的版本化编码、解析与形状校验。 |
| `packages/plugin-vault/src/*worker*.test.ts` | Worker 销毁、单 Key、不泄露 raw material、session mismatch 的单测。 |

### 8.2 Contracts 与 Vault 基础层

| 文件 | 必须改动 |
|---|---|
| `packages/contracts/src/vault.ts` | 删除 `PrivateKeyMaterial` 对外使用、`withPrivateKey`、`exportPrivateKey`（bsv8 语义）；新增 unlock/switch/lock/maintenance/backup 的公开 contract。注释改为“Worker 持有私钥”。 |
| `packages/contracts/src/keyspace.ts` | `setActive` 改为仅内部会话提交后的公开状态同步，UI 不可用它解锁/切换；删除任何“active 即可借任意 Key”的语义。 |
| `packages/contracts/src/protocol.ts` | 删除 `OwnerRuntimeBootstrap.privateKeyHex`、`OwnerRuntimeSource` 的 bootstrap 私钥分支及一切 unlock-runtime handoff；定义 session capability bootstrap（仅 sessionId、publicKeyHex、公开能力、不可伪造 token）。 |
| `packages/contracts/src/index.ts` | 导出新 ActiveKeyCrypto / VaultSession contract，删除旧私钥借用导出。 |
| `packages/plugin-vault/src/crypto.ts` | 保持 PBKDF2；支持明确 AAD、版本化 verifier，移除不使用的 cipher salt 语义或使其真实参与定义，禁止无 AAD AES-GCM 调用。 |
| `packages/plugin-vault/src/vaultDb.ts` | schema bump；无条件删 staging；meta 增加 crypto/KDF version；record 增加 cipher version；提供 canonical records 批量原子替换与备份只读接口。 |
| `packages/plugin-vault/src/vaultService.ts` | 删除 `masterKey/masterSalt/keyCache` 解锁语义、legacy migration、withPrivateKey/export bsv8；改为 Coordinator/session 生命周期 façade。 |
| `packages/plugin-vault/src/keyspaceService.ts` | active 只反映 Keymaster 当前 session 的已解锁公钥；切换提交前不改变 active；锁定清空 active。 |
| `packages/plugin-vault/src/manifest.ts`、`packages/plugin-vault/src/index.ts` | 注册 Coordinator、session/crypto capability 与 Worker 入口，不再向其它插件提供私钥借用。 |

### 8.3 Vault UI 与首启/导入 UI

| 文件 | 必须改动 |
|---|---|
| `apps/web/src/shell/LockedShell.tsx`、`packages/plugin-vault/src/VaultUnlockPage.tsx` | locked 状态显示可选公开 Key 列表；提交 `{ publicKeyHex, password }`，成功后只显示 Worker session 的公开状态。 |
| `packages/plugin-vault/src/KeySwitchWidget.tsx` | 不再直接 `keyspace.setActive`；改为“解锁并切换”对话流程，错误/取消保留旧 Key。 |
| `packages/plugin-vault/src/VaultSettingsPage.tsx` | 新增修改锁屏密码入口、单 Key Backup 导出/导入入口；移除 bsv8 export 所需的“备份密码”流程。 |
| `packages/plugin-vault/src/VaultKeyExportModal.tsx` | 替换为不输入密码的 Key Backup 导出确认页，明确该备份由当前 Vault 锁屏密码保护。 |
| `packages/plugin-vault/src/VaultKeyCreateModal.tsx`、`packages/plugin-vault/src/VaultKeyDeleteModal.tsx` | 创建要求当前系统锁屏密码；删除继续要求系统锁屏密码，均不借出私钥。 |
| `packages/plugin-key-import/src/ImportPage.tsx`、`apps/web/src/shell/FirstTimeImportWizard.tsx` | 分离来源格式密码与目标 Vault 锁屏密码；支持新 Vault / 已有 Vault / Key Backup 导入；重复公钥拒绝。 |
| `apps/web/src/shell/AppShell.tsx`、`apps/web/src/shell/UnlockedShell.tsx` | 按 Keymaster session 状态渲染；实现 5 分钟自动锁定、页面生命周期锁定与 Worker 销毁。 |

### 8.4 业务插件与协议

| 文件/模块 | 必须改动 |
|---|---|
| `packages/plugin-p2pkh/src/p2pkhService.ts`、`p2pkhTransferService.ts`、`p2pkhSigner.ts`、`manifest.ts` | 所有签名和地址推导改走 ActiveKeyCrypto；不传私钥 hex。 |
| `packages/plugin-appmsg/src/manifest.ts`、`appmsgCore.ts`、`appmsgCrypto.ts`、`reconnectCoordinator.ts` | 删除任何 owner 私钥字段与缓存；将签名、ECDH、消息封装改为 capability operation；lock/revoke 时断开 provider。 |
| `packages/plugin-broadcast/src/manifest.ts`、`broadcastCore.ts`、相关 provider contract | 删除 `currentPrivKeyHex` 和 BoundSession 私钥；只保存 owner 公钥及受控 signer。 |
| `packages/plugin-poker/src/pokerCrypto.ts`、`pokerService.ts`、相关 manifest | 改为 Worker capability operation；不允许 poker crypto 接受 raw private hex。 |
| `packages/plugin-protocol/src/protocolService.ts`、`sessionWindowBootstrap.ts`、`ProtocolPopupPage.tsx`、`protocolCrypto.ts`、`protocolStorageDb.ts`、`manifest.ts` | appView session 持有专属 Worker capability，不交接私钥；关闭 window 即 revoke；Protocol 方法通过 session capability 执行；删除 Vault 锁后 bootstrap owner 仍可执行的路径。 |
| `packages/plugin-apps/src/**` | appView 启动流程改为选择/解锁 session owner、创建专属 Worker，并在窗口生命周期结束时销毁。 |

### 8.5 测试、文档与旧施工单

| 文件/范围 | 必须改动 |
|---|---|
| `packages/plugin-vault/src/vaultService.test.ts`、`keyspaceService.test.ts` | 删除 withPrivateKey/masterKey/staging 预期；覆盖单 Key session、切换、改密码、AAD、Key Backup、重复导入、DB 原子性。 |
| `packages/plugin-appmsg/src/**/*.test.ts`、`packages/plugin-broadcast/src/**/*.test.ts`、`packages/plugin-p2pkh/src/**/*.test.ts`、`packages/plugin-protocol/src/**/*.test.ts` | 增加“原始私钥不可见”“revoke 后失败”“session key mismatch”“appView close destroys worker”测试。 |
| `apps/web/src/shell/**/*.test.tsx`、`packages/plugin-vault/src/**/*.test.tsx`、`packages/plugin-key-import/src/**/*.test.tsx` | 覆盖 Key 选择解锁、切换取消/错误保持旧 Key、两个密码导入、无密码备份导出、自动锁定。 |
| `docs/architecture/code-architecture.md` | 重画 Vault 生命周期为 session Worker 模型，删除“unlocked = masterKey in memory”。 |
| `docs/protocol/keymaster-protocol-common-v1-draft.md`、`docs/protocol/keymaster-connect-v1-draft.md` | 删除 withPrivateKey / OwnerRuntimeBootstrap 私钥 / appView 锁后可运行描述，改为 session Worker capability。 |
| `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md` 及仍声称私钥 bootstrap 有效的旧施工单 | 加“已被本单整体替代”的历史标记；不得修改历史内容来伪装兼容。 |

---

## 9. 验证命令与最终验收清单

### 9.1 静态零命中门禁

实现完成后，以下生产代码搜索结果必须为 `0`（历史施工单可保留，但不得作为生产实现依据）：

```bash
rg -n 'withPrivateKey|PrivateKeyMaterial|masterKey|masterSalt|OwnerRuntimeBootstrap|bootstrap_owner|vault_unlock|exportUnlockRuntime|importUnlockRuntime|vault_keys_legacy_staging|legacyId' packages apps --glob '!**/*.test.*' --glob '!**/*.md'
```

以下搜索只允许出现在 Worker 内部的私钥解析/密码学实现和专门的安全断言测试中；不允许出现在 UI、manifest、protocol bootstrap、AppMsg、Broadcast、P2PKH、Poker：

```bash
rg -n 'privateKeyHex|privateKey.*hex' packages apps --glob '!**/*.md'
```

### 9.2 功能与安全验收

- [ ] Vault 持久化层只剩 `vault_meta` 与以 `publicKeyHex` 为主键的 `vault_keys`；staging store、类型、运行时读取和迁移代码均不存在。
- [ ] `vault_meta` 包含 PBKDF2 版本、参数、salt 和 verifier；它不包含密码、私钥、`masterKey` 或可复用解锁 token。
- [ ] 每条 `vault_keys` 密文均使用固定版本化 AAD；交换两条密文或让私钥与记录 `publicKeyHex` 不匹配时解锁失败。
- [ ] 正式旧记录在首次正确密码操作时完成一次 AAD 升级；升级失败不产生 Session Worker，也不部分改写数据。
- [ ] Keymaster 解锁 A 后，内存中不存在常驻 `masterKey`；只能使用 A 的 Worker operation，不能读取/使用 B。
- [ ] 切换到 B 时，取消或错误密码后 A 仍可签名；成功后 A Worker 已销毁，B Worker 是唯一 Keymaster Worker；B 损坏后 Keymaster 锁定而非保留全库能力。
- [ ] Keymaster 锁定、注销、自动超时、关闭/刷新页面后，Keymaster Worker 已终止，旧 capability 与 in-flight operation 均不可用。
- [ ] 每个 appView 只在用户选择并解锁 Key 后获得自己的 Worker；它与 Keymaster/其它 appView 可使用不同 Key，但无法读取、调用或持久化其它 session 的 Key。
- [ ] appView Session Window 关闭、刷新或 `endSession` 后对应 Worker 被销毁，公钥绑定和私钥均不恢复。
- [ ] AppMsg、Broadcast、P2PKH、Poker、Protocol 的运行时对象、session bootstrap 和日志中没有 raw private key 字段。
- [ ] 新 Vault / 已有 Vault 导入均区分来源格式密码与系统锁屏密码；任一密码错误、文件损坏或公钥重复时零写入、零覆盖。
- [ ] 单 Key Backup 导出只复制 `vault_meta + selected vault_keys`，不要求输入密码、不解密、不创建 Worker；备份可用原锁屏密码恢复。
- [ ] Key Backup 导入到已有 Vault 时，来源 meta 从不覆盖目标 meta；来源与目标密码均正确才写入目标记录。
- [ ] 修改锁屏密码逐条重加密所有 `vault_keys`，单个事务更新 meta 和记录；失败保持旧密码可用，成功后旧密码立即失效且所有 session 都被锁定。
- [ ] 所有密码输入提交后立即清空 UI state；日志、error、telemetry、URL、持久化存储均不含密码或私钥。
- [ ] 全量 TypeScript、lint、现有及新增测试通过；Worker terminate、port revoke、IndexedDB 原子失败等异常路径有确定性测试。

---

## 10. 不允许拆分实施

以下“中间态”都不允许合并：

1. 先引入 Worker、仍保留 `withPrivateKey` 给旧插件使用；
2. 先删除 masterKey、但让插件继续缓存 `privateKeyHex`；
3. appView 改用 Worker、但仍允许 bootstrap 传私钥；
4. 增加 AAD、但继续无版本地读取旧密文；
5. 只改 Keymaster 锁定、不处理 appView Worker 关闭与密码轮换；
6. 改密码时逐条写库但不使用原子事务；
7. 保留 staging “以防万一”。

本单的价值来自边界一次收口：密码根不常驻、私钥不外借、会话独立、旧模型彻底删除。任何保留旧口子的折中都会重新引入同一类泄露面。
