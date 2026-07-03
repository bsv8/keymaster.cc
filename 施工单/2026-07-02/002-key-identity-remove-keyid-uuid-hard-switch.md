# 002 key 身份彻底删除 keyId / key-uuid、统一为 publicKeyHex 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `README.md`
- `packages/contracts/src/keyspace.ts`
- `packages/contracts/src/vault.ts`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-vault/src/vaultDb.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/plugin-vault/src/keyspaceService.ts`
- `packages/plugin-vault/src/VaultSettingsPage.tsx`
- `packages/plugin-vault/src/VaultKeyExportModal.tsx`
- `packages/plugin-vault/src/VaultKeyDeleteModal.tsx`
- `packages/plugin-vault/src/KeySwitchWidget.tsx`
- `packages/plugin-p2pkh/src/p2pkhContracts.ts`
- `packages/plugin-p2pkh/src/p2pkhDb.ts`
- `packages/plugin-p2pkh/src/p2pkhService.ts`
- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`
- `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`
- `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`
- `packages/plugin-p2pkh/src/manifest.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-poker/src/pokerCrypto.ts`
- `packages/plugin-poker/src/pokerService.ts`
- `apps/web/src/shell/AppShell.tsx`
- `packages/plugin-key-import/src/ImportPage.tsx`
- `施工单/2026-06-20/001-publickeyhex-root-identity-hard-switch.md`
- `施工单/2026-06-28/002-protocol-business-methods-bind-connect-session-hard-switch.md`

发生冲突时：

1. 本单关于“key 域彻底删除 surrogate id，只保留 `publicKeyHex`”的定义优先。
2. 旧文档里“`keyId` 仅作为 Vault 内部借用句柄保留”的结论，本单全部覆盖。
3. 后续若再改 key 身份、Vault 主键、删除路径、P2PKH owner 维度，必须先改本单，再改代码与测试，不允许只改实现。

---

## 1. 本单定位

本单不是“把 `keyId` 再往里藏一层”的重命名，也不是“业务层用 `publicKeyHex`，Vault 里继续保留 uuid 主键”的折中方案。

本单定义的是一次**硬切换**：

```txt
平台 key 身份
  = publicKeyHex

Vault key 记录主键
  = publicKeyHex

active key
  = activePublicKeyHex

key 删除
  = deleteKey({ publicKeyHex, password })

私钥借用
  = vault.withPrivateKey(publicKeyHex, fn)

P2PKH owner / 资源归属 / 本地缓存归属
  = publicKeyHex

key.created / key.deleted / key.identity.ready / key.identity.failed
  = 不再携带 keyId

系统中不存在
  = keyId
  = deleteKeyById
  = Vault key.uuid 主键
  = “无 publicKeyHex 也能继续运行”的 steady state
```

这里说的“删除 uuid”，指的是**key 身份领域的 surrogate id**：

- Vault key 记录主键；
- KeyIdentity / KeyRef 里的内部 id；
- key 事件 payload 里的内部 id；
- key 删除 / 导出 / 签名路径依赖的内部 id；
- P2PKH / protocol / appmsg / poker 为了拿 key 而继续透传的内部 id。

本单**不**处理下列非 key 身份问题：

- protocol request id / session id；
- runtime message id；
- log entry id；
- background task run id；
- 本地 UI 行级临时 key。

这些 id 属于“过程记录标识”，不是“key 身份真值”。不能把 `publicKeyHex` 误用到这些位置，否则只是把另一类概念也扭曲掉。

---

## 2. 简述缘由

### 2.1 只要系统里还留 `keyId`，它就会重新长成第二真值

当前仓库已经证明了这一点：

1. 一开始说 `keyId` 只是 Vault 内部句柄；
2. 后面 P2PKH contract 开始接受 `keyId?` 兼容入参；
3. transfer widget 开始提交 `keyId`；
4. protocol capability 为兼容旧接口继续暴露 `keyId?`；
5. UI、日志、导出文件名、事件 payload 又继续读它。

这不是“代码没改完”，而是系统结构本身在鼓励第二真值复活。

### 2.2 key 域 surrogate id 没有带来简单，反而制造迁移和边界噪音

`keyId` / key-record uuid 看起来像“实现细节”，但它会污染：

- DB 主键；
- 事件 payload；
- 删除路径；
- 导出路径；
- P2PKH owner 过滤；
- 会话签名路径；
- UI 列表 key；
- 文件命名；
- 故障修复入口。

最后系统里就会同时存在：

```txt
用户认 publicKeyHex
业务认 publicKeyHex
但是实现真正操作靠 keyId / uuid
```

这种双轨不可能长期稳定。

### 2.3 `publicKeyHex` 已经足够承担 key 域唯一真值

它同时满足：

- 唯一；
- 稳定；
- 可展示；
- 可复制；
- 可跨系统对账；
- 可从私钥直接派生；
- 可作为 DB 主键；
- 可作为 namespace 根；
- 可直接作为签名借用定位键。

既然最终每条关键路径都要落回 `publicKeyHex`，那继续保留中间 surrogate id 没有价值。

### 2.4 这次应该选“硬切换 + fail-closed”，而不是“兼容几版再慢慢收”

原因：

1. key 身份是平台根边界，不适合长期双轨；
2. P2PKH 本地缓存可以重建，不值得为兼容 `keyId` 再背一套迁移语义；
3. failed / uninitialized key 这套“因为没有 `publicKeyHex` 所以还得靠 `keyId` 管理”的例外，正是第二真值继续存在的温床；
4. 项目当前更需要简单和确定，而不是为了照顾边缘旧态继续保留旧模型。

---

## 3. 硬切换结论

### 一、key 域唯一真值只有 `publicKeyHex`

以下全部统一为 `publicKeyHex`：

- `KeyIdentity`
- `KeyRef`
- `ActiveKeyState`
- Vault key 记录主键
- keyspace 查找 / 切 active / 删除
- key 事件 payload
- P2PKH owner / resource / UTXO / history / local claim / local submission
- protocol owner key 解析
- appmsg signer owner 解析
- poker session key 解析

### 二、系统中不再存在 `keyId`

删除范围包括：

- contract 字段；
- service 入参；
- service 返回值；
- IndexedDB 行字段；
- store keyPath；
- event payload；
- UI 列；
- diagnostic 字段；
- 兼容 fallback 分支；
- `deleteKeyById`；
- `withPrivateKey(keyId, fn)`。

### 三、Vault 直接按 `publicKeyHex` 借私钥

最终接口固定为：

```ts
vault.getKey(publicKeyHex)
vault.withPrivateKey(publicKeyHex, fn)
vault.exportPrivateKey({ publicKeyHex, password })
keyspace.deleteKey({ publicKeyHex, password })
```

不再允许：

```ts
vault.getKey(keyId)
vault.withPrivateKey(keyId, fn)
vault.exportPrivateKey({ keyId, password })
keyspace.deleteKeyById({ keyId, password })
```

### 四、Vault key 记录主键从 uuid 改为 `publicKeyHex`

最终持久化模型：

```txt
vault_keys keyPath
  = publicKeyHex
```

也就是说：

- 新 key 落库前必须先派生 `publicKeyHex`；
- 不存在“先生成 uuid，再回填身份”的路径；
- 不存在“没有 `publicKeyHex` 的正常 key 记录”。

### 五、identity backfill 不再作为长期系统能力存在

硬切换后：

- 新建 key / 导入 key：落库前必须先得到 `publicKeyHex`；
- unlock 后不再跑“逐把 key 补 publicKeyHex”的常规 backfill；
- `identityStatus = uninitialized / failed` 这套因缺身份而存在的 steady state 要删除；
- 如果老数据在迁移时拿不到 `publicKeyHex`，那是**迁移异常 / 本地遗留问题**，不是新系统允许长期继续运行的状态。

---

## 4. 怎么做

### 4.1 总体策略

采用一次性硬切换：

1. 先改 contract，把 key 域 `keyId` 全部从类型系统删除；
2. 再改 Vault schema 与 service，让 canonical key record 主键变成 `publicKeyHex`；
3. 再改 keyspace 删除 / active / 事件；
4. 再改 P2PKH、protocol、appmsg、poker 等依赖方；
5. 最后改 UI、文案、日志、测试、施工单与 README。

禁止分阶段保留“外层 publicKeyHex、内层 keyId”的过渡形态。

### 4.2 Vault 一次性迁移策略

Vault 迁移必须一次性完成到最终形态，但允许有**一次性迁移暂存结构**，前提是：

1. 新代码运行时只认 canonical store；
2. 旧结构只作为迁移源；
3. 迁移完成后物理删除；
4. 业务 contract / service / UI 永远看不到旧结构。

推荐实现策略：

```txt
DB vNext upgrade
  1. 新建 canonical vault_keys（keyPath = publicKeyHex）
  2. 扫旧 vault_keys
  3. 已有 publicKeyHex 的行 -> 直接写 canonical store
  4. 缺 publicKeyHex 的旧行 -> 写入一次性 legacy staging store
  5. 删除旧 vault_keys
```

随后在首次 unlock 时：

```txt
verify password
-> 挂 masterKey
-> 读取 legacy staging rows
-> 逐条解密私钥
-> 派生 publicKeyHex
-> 写入 canonical vault_keys
-> 删除 legacy staging rows
-> staging 为空后删除 staging store
-> 再进入 unlocked
```

关键点：

- staging store 不是新系统的一部分，只是一次性迁移缓冲区；
- unlocked 之前必须完成迁移；
- 迁移失败不能带着半成品继续跑。

### 4.3 P2PKH 直接删掉 `keyId` 维度

P2PKH 这次不是“保留 keyId 诊断字段”，而是彻底删除：

- `P2pkhKeyResource.keyId`
- `P2pkhUtxo.keyId`
- `P2pkhHistoryItem.keyId`
- `P2pkhLocalSubmission.keyId`
- `P2pkhLocalInputClaim.keyId`
- `P2pkhTransferInput.keyId?`
- `P2pkhTransferPreview.keyId?`
- `P2pkhUtxoFilter.keyId?`
- `onKeyImported(keyId)`
- `onKeyRemoved(keyId)`

transfer / 选币 / 广播统一改成：

```txt
ownerPublicKeyHex
-> keyspace.getKey(ownerPublicKeyHex)
-> vault.withPrivateKey(ownerPublicKeyHex, fn)
```

P2PKH DB 直接升版本重建，不迁移旧 `keyId` 字段缓存。

### 4.4 protocol / appmsg / poker 全部只按 `publicKeyHex` 借私钥

统一模式：

```txt
session.ownerPublicKeyHex
-> keyspace.getKey(ownerPublicKeyHex) 仅做存在性校验 / 取 label
-> vault.withPrivateKey(ownerPublicKeyHex, fn)
```

不再允许：

```txt
ownerPublicKeyHex
-> 先解析 keyId
-> 再 withPrivateKey(keyId)
```

### 4.5 UI 与运维语义同步收口

界面上不再出现：

- `keyId`
- “按 keyId 删除”
- “keyId 前 8 位”
- “身份初始化中 / 身份失败（因为还没 backfill 出 publicKeyHex）”

如果有需要短串展示，一律使用：

```txt
formatShortPublicKey(publicKeyHex)
```

---

## 5. 文件级施工

### 5.1 contracts

- `packages/contracts/src/vault.ts`
  - 删除 `KeyRef.id`。
  - 删除 `InitialActivationNotice.keyId`。
  - `VaultService` 全部改为 `publicKeyHex` 入参。
  - 删除 `withPrivateKey(keyId, fn)` / `exportPrivateKey({ keyId })` 旧签名。
  - 所有注释与错误说明改成 `publicKeyHex` 语义。

- `packages/contracts/src/keyspace.ts`
  - 删除 `KeyIdentity.keyId`。
  - 删除 `deleteKeyById`。
  - `key.created` / `key.deleted` / `key.identity.ready` / `key.identity.failed` payload 全部去掉 `keyId`。
  - 删除所有“failed key 必须走 keyId 管理入口”的注释与 contract。

- `packages/contracts/src/protocol.ts`
  - 删除任何对 vault `keyId` 的对外叙述。
  - protocol 内关于 owner key 的实现说明统一改成 `ownerPublicKeyHex`。

### 5.2 Vault

- `packages/plugin-vault/src/vaultDb.ts`
  - Vault DB 升版本。
  - canonical `vault_keys` 改成 `keyPath = publicKeyHex`。
  - 新增一次性 legacy staging 迁移逻辑。
  - 删除把 key row 主键写成 uuid 的持久化模型。

- `packages/plugin-vault/src/vaultService.ts`
  - 新 key 创建 / 导入时先派生 `publicKeyHex`，再落库。
  - 删除 `crypto.randomUUID()` 作为 key 主键。
  - `recordToRef` / `recordToIdentity` / `refreshKeyCache` 改成无 `keyId` 模型。
  - `withPrivateKey` / `exportPrivateKey` 全部改成按 `publicKeyHex`。
  - 删除常规 `backfillIdentities` 体系；改成 unlock 前的一次性 legacy migration。
  - `KeyPersistedButActivationFailedError` 与 notice 改成只带 `publicKeyHex`。

- `packages/plugin-vault/src/keyspaceService.ts`
  - `listManageableKeys` / `listActiveCandidates` / `requireActiveKey` 全部改成无 `keyId`。
  - 删除 `deleteKeyById` 路径。
  - 删除所有只靠 `keyId` 才能删 failed key 的处理。
  - 删除 active 变更日志中的 `nextKeyId`。

- `packages/plugin-vault/src/VaultSettingsPage.tsx`
  - key 管理页行模型、导出、删除、rowKey、notice 对位全部改成 `publicKeyHex`。
  - 删除对 `keyId` 的 UI 展示与引用。
  - 删除“failed/uninitialized 因 identity backfill 未完成”的管理语义。

- `packages/plugin-vault/src/VaultKeyExportModal.tsx`
  - 入参改成 `publicKeyHex`。
  - 文件名 fallback 改成 `publicKeyHex` 前缀，而不是 `keyId.slice(0, 8)`。

- `packages/plugin-vault/src/VaultKeyDeleteModal.tsx`
  - 注释与删除调用改成 `deleteKey({ publicKeyHex, password })`。

- `packages/plugin-vault/src/KeySwitchWidget.tsx`
  - 事件类型去掉 `keyId`。

### 5.3 P2PKH

- `packages/plugin-p2pkh/src/p2pkhContracts.ts`
  - 删除全部 `keyId` 字段与说明。
  - `ReadyKeyIdentity` 只保留 `publicKeyHex` 等公开身份字段。
  - `onKeyImported` / `onKeyRemoved` 改成 `publicKeyHex`。

- `packages/plugin-p2pkh/src/p2pkhDb.ts`
  - DB 升版本。
  - 删除所有 store record 上的 `keyId` 物理字段。
  - 删除 legacy `keyId` 分桶迁移与 `resourceIdFor(keyId, network)` 之类 helper。
  - 旧 `keyId` schema 不做细粒度迁移，直接 rebuild。

- `packages/plugin-p2pkh/src/p2pkhService.ts`
  - 删除 `activeKeyId`、`request.keyId`、`preview.keyId` 路径。
  - `allocateUtxos` / `listUtxos` / `listHistory` 只按 `ownerPublicKeyHex` 与 `publicKeyHex` 过滤。
  - `onKeyImported` / `onKeyRemoved` 改成按 `publicKeyHex`。

- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`
  - 删除 `input.keyId` fallback。
  - 所有签名调用改成 `vault.withPrivateKey(owner.publicKeyHex, fn)`。
  - `submission` / `claim` 写库时不再写 `keyId`。

- `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`
  - history / claim / submission commit 不再写 `keyId`。

- `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`
  - 不再提交 `keyId`。

- `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`
  - 删除 `keyId` 列。

- `packages/plugin-p2pkh/src/manifest.ts`
  - `key.created` 订阅改成按 `publicKeyHex`。

### 5.4 protocol / appmsg / poker

- `packages/plugin-protocol/src/manifest.ts`
  - capability 最小接口删掉 `keyId?`。

- `packages/plugin-protocol/src/protocolService.ts`
  - 删除 owner -> keyId 解析 helper。
  - 全部签名 / 取私钥 / 取压缩公钥路径改成 `withPrivateKey(ownerPublicKeyHex, fn)`。
  - 保留 `ownerPublicKeyHex` 为唯一 owner 真值。

- `packages/plugin-appmsg/src/manifest.ts`
  - signer provider 改成 `vault.withPrivateKey(activePublicKeyHex, fn)`。

- `packages/plugin-poker/src/pokerCrypto.ts`
  - `signDigestWithVault(vault, publicKeyHex, digest)`。

- `packages/plugin-poker/src/pokerService.ts`
  - 事件类型去掉 `keyId`。
  - 挑战签名改用 `sessionKey.publicKeyHex`。

### 5.5 Shell / 其它

- `apps/web/src/shell/AppShell.tsx`
  - repair 列表行 key 改成 `publicKeyHex`。
  - 移除围绕 `keyId` 的修复态文案。

- `packages/plugin-key-import/src/ImportPage.tsx`
  - 删除 `key.imported { keyId: null }` 幽灵事件。

- `README.md`
  - 删除“`keyId` 是 Vault 内部借用句柄”的架构说明，改成 `publicKeyHex` 单真值。

### 5.6 测试

受影响测试按模块整体更新：

- `packages/plugin-vault/src/*.test.ts`
- `packages/plugin-p2pkh/src/*.test.ts`
- `packages/plugin-protocol/src/*.test.ts`
- `packages/plugin-poker/src/*.test.ts`
- `apps/web/src/shell/*.test.ts`

原则：

- fixture 不再造 `keyId: "k1"`；
- 断言不再匹配 `keyId`；
- 删除 / 导出 / 签名 / active 切换全部改测 `publicKeyHex`。

---

## 6. 不能怎么做

1. 不能把 contract 改成 `publicKeyHex`，但 Vault store 仍用 uuid 主键偷偷续命。
2. 不能保留 `keyId` 作为“仅诊断字段”。诊断字段会重新长成业务依赖。
3. 不能保留 `deleteKeyById` 作为坏 key 专用入口。
4. 不能让 P2PKH 对外继续接受 `keyId?` 兼容入参。
5. 不能让 protocol / appmsg / poker 继续走“先解析 keyId，再借私钥”。
6. 不能把 old `vault_keys` 当长期 sidecar 共存；legacy staging 只能是一次性迁移源。
7. 不能在 unlocked 之后再慢慢补 `publicKeyHex`。unlock 完成时系统必须已经进入最终一致状态。
8. 不能为了兼容旧数据继续保留 `identityStatus = uninitialized / failed` 作为常规 key 生命周期。
9. 不能把 `publicKeyHex` 误拿去替代 requestId / log id / background run id 这类过程标识。
10. 不能因为旧缓存迁移麻烦，就让 P2PKH 保留 `keyId` 字段继续活着。

---

## 7. 特殊情况处理

### 情况 1：旧 vault key 行已经有 `publicKeyHex`

处理：

- upgrade 时直接复制到 canonical store；
- 不再保留旧 uuid 主键；
- 不需要 backfill。

### 情况 2：旧 vault key 行没有 `publicKeyHex`

处理：

- upgrade 时写入一次性 legacy staging store；
- 首次 unlock 成功后立即迁移；
- 迁移完成前不进入 `unlocked`。

### 情况 3：legacy staging 行解密失败，无法派生 `publicKeyHex`

处理：

- fail-closed；
- 不进入 `unlocked`；
- 明确报告“本地遗留 key 无法迁移到 publicKeyHex canonical model”；
- 不再把这条记录当作“failed key 但还能继续管理”的常规状态。

设计缘由：

- 这类记录既不能稳定签名，也不能稳定导出，也不能成为 canonical key；
- 继续保留只会逼系统重新引入 surrogate id。

### 情况 4：迁移时出现重复 `publicKeyHex`

处理：

- fail-closed；
- 不允许 silent overwrite；
- 不允许“保留第一条/最后一条”；
- 要求用户显式处理本地重复脏数据。

### 情况 5：P2PKH 旧本地缓存里还有 `keyId`

处理：

- 不迁移；
- 直接升版本 rebuild；
- 依赖 `rehydrate + recent-sync + history-backfill` 重建。

设计缘由：

- P2PKH 本地库是可重建缓存，不值得为了删 `keyId` 再维护一条复杂迁移链。

### 情况 6：最后一把 key 被删掉

处理：

- 仍按 `publicKeyHex` 删除；
- 删除后 Vault 收敛回 `uninitialized`；
- 不再存在“最后一把坏 key 只能按 keyId 删”的例外。

### 情况 7：active key 切换失败，但 key 已落库

处理：

- 保留 `KeyPersistedButActivationFailedError` 语义；
- 错误与 notice 只带 `publicKeyHex`；
- UI 可继续按 `publicKeyHex` 导出 / 删除 / 手动 setActive。

---

## 8. 最终验收清单

### 8.1 contract 与源码收口

- [ ] `packages/contracts/src/vault.ts`、`keyspace.ts`、`protocol.ts` 不再声明 key 域 `keyId`。
- [ ] `VaultService` 不再暴露 `withPrivateKey(keyId, fn)`、`exportPrivateKey({ keyId })`。
- [ ] `KeyspaceService` 不再暴露 `deleteKeyById`。
- [ ] `P2PKH` contract / service / widget / overview 不再出现 `keyId` 字段、入参、列或文案。
- [ ] `protocol` / `appmsg` / `poker` 不再通过 `keyId` 借私钥。

### 8.2 Vault canonical model

- [ ] `vault_keys` canonical store 主键是 `publicKeyHex`。
- [ ] 新建 key / 导入 key 时不再生成 key-record uuid。
- [ ] unlocked 之后系统里不存在“没有 `publicKeyHex` 的正常 key 记录”。
- [ ] 不再存在常规 identity backfill / per-key identity failed 稳态。

### 8.3 迁移与失败语义

- [ ] 老数据里已有 `publicKeyHex` 的 key 能直接迁移并继续使用。
- [ ] 老数据里缺 `publicKeyHex` 的 key 会在首次 unlock 前完成一次性迁移。
- [ ] 迁移失败时系统 fail-closed，不以半迁移状态继续运行。
- [ ] 重复 `publicKeyHex` 冲突不会被 silent overwrite。

### 8.4 业务行为

- [ ] key 创建、导入、导出、删除、切 active 全部只认 `publicKeyHex`。
- [ ] P2PKH 转账、选币、广播、最近同步、本地提交、本地 claim 全部不再依赖 `keyId`。
- [ ] protocol `p2pkh.transfer`、feepool、appview owner 签名全部只按 `ownerPublicKeyHex` 工作。
- [ ] appmsg 当前 owner signer 只按 `activePublicKeyHex` 借私钥。
- [ ] poker challenge 签名只按 `sessionKey.publicKeyHex` 借私钥。

### 8.5 grep 验收

- [ ] `rg -n '\bkeyId\b' packages apps --glob '!**/*.test.*' --glob '!**/*.md'` 结果为 `0`。
- [ ] `rg -n 'deleteKeyById|withPrivateKey\\(keyId|exportPrivateKey\\(\\{ keyId' packages apps --glob '!**/*.test.*' --glob '!**/*.md'` 结果为 `0`。
- [ ] `rg -n 'crypto\\.randomUUID\\(' packages/plugin-vault packages/plugin-p2pkh --glob '!**/*.test.*'` 不再出现 key 域主键 / key 域路径上的 uuid 生成。

### 8.6 文档与 UI

- [ ] `README.md` 与相关施工单不再把 `keyId` 描述为仍然存在的系统概念。
- [ ] Vault 设置页、P2PKH 总览页、导出/删除弹窗、AppShell repair 页不再显示或依赖 `keyId`。
- [ ] 导出文件名 fallback 使用 `publicKeyHex` 短串，而不是 `keyId` 片段。

---

## 9. 一句话收口

这次不是“把 `keyId` 藏深一点”，而是把 key 域里所有 uuid / surrogate id 一次性赶出系统；从 Vault 主键、contract、事件、P2PKH 到 protocol，全部只允许 `publicKeyHex` 继续存在。
