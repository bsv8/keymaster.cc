# 001 平台根身份切换为 publicKeyHex、彻底删除 publicKeyHash、P2PKH 链上哈希改名硬切换施工单

## 目标

一次性把当前系统切换为下面这套最终模型：

```txt
平台根身份
  = publicKeyHex
  = 压缩公钥 hex
  = lowercase
  = 无 0x 前缀
  = 66 个字符

Vault 内部借用句柄
  = keyId
  = 只用于 vault.withPrivateKey / 管理动作

平台 active key
  = activePublicKeyHex

key namespace DB 命名
  = keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>

平台 contract / 事件 / DB 唯一性 / 路由上下文
  = 只认 publicKeyHex

publicKeyHash
  = 从平台模型彻底删除
  = 不保留双读双写
  = 不保留兼容入参
  = 不保留别名字段

P2PKH 链上真正的 HASH160(pubkey)
  = 单独命名
  = 例如 pubKeyHash160Hex
  ≠ publicKeyHex
  ≠ 平台 namespace id
```

本次是硬切换，不接受“先把 contract 改成 publicKeyHex，底层继续用 publicKeyHash”“先双字段共存几版”“先把 publicKeyHash 换个文案继续留着”“P2PKH 里继续混用两个 hash 名字以后再收”这类中间态。

## 简述缘由

1. 当前系统已经长期同时持有 `publicKeyHex` 与 `publicKeyHash`，而 `publicKeyHash` 只是 `sha256(compressed public key)` 的平台二次派生值，不是链上主语义，也不是唯一可得材料。这层派生没有换来真正的简单，反而制造了“真实身份到底是哪一个”的认知分叉。

2. `publicKeyHex` 本身已经满足平台根身份需要的几个关键条件：
   - 唯一；
   - 稳定；
   - 可展示；
   - 可复制；
   - 可与外部系统直接对账；
   - 可从私钥或公钥直接派生；
   - 不存在“拿到 id 但反查不回完整公钥”的问题。

3. 当前 `publicKeyHash` 名字在钱包/P2PKH 语境里天然会让人联想到链上的 `HASH160(pubkey)` / `pubKeyHash`。但你们平台里这个字段实际是 `sha256(pubkey)` 的内部 namespace id。它和链上 P2PKH 语义撞名，本身就是设计噪音。

4. 现在的系统里很多关键路径已经同时需要 `publicKeyHex`：
   - UI 展示短公钥；
   - 导出 / 复制完整公钥；
   - 地址派生；
   - 签名上下文；
   - 外部对账。

   既然完整公钥已经是第一公民，再保留一个“平台真正主键却不可逆”的 `publicKeyHash`，只会让后续修改继续往双轨漂。

5. 按项目当前处境，最合理的方向不是再补抽象，而是收口：
   - 平台机器引用只保留 `publicKeyHex` 与 `keyId` 两层；
   - P2PKH 链上 hash 只留在 P2PKH 自己的术语里；
   - 能重建的本地数据就重建，不能重建的本地真值只做一次最小迁移。

## 当前问题定义

当前仓库里实际存在三层混淆：

### 一、平台根身份混淆

当前 `packages/plugin-vault/src/keyIdentity.ts` 把：

```txt
publicKeyHex
publicKeyHash = sha256(compressed public key)
```

一起作为平台公开身份。

随后：

1. `packages/contracts/src/keyspace.ts`
2. `packages/contracts/src/vault.ts`
3. `packages/plugin-vault/src/keyspaceService.ts`
4. `packages/plugin-vault/src/vaultService.ts`

又把 `publicKeyHash` 当成：

```txt
active key 主键
key namespace 主键
删除 key 主路径
事件 payload 主字段
DB 名命名根
```

于是平台虽然“展示公钥”，但真正 machine identity 却还是另一套东西。

### 二、P2PKH 语义混淆

当前 `packages/plugin-p2pkh` 里的 `publicKeyHash` 字段表示的是：

```txt
“拥有这份 namespace 数据的是哪把 key”
```

但在 P2PKH 领域，`pubkey hash` 更自然应该表示：

```txt
HASH160(compressed public key)
```

也就是地址锁定脚本里的那 20 字节哈希。

这导致：

1. 平台 namespace id 与链上脚本语义同名；
2. 测试里已经出现 `hash160(ACTIVE.publicKeyHex)` 却塞进 `ACTIVE_PUBLIC_KEY_HASH` 这种混用；
3. 后续任何人看 `publicKeyHash` 都需要先猜“这里说的是平台 key 还是链上 pubkey hash”。

### 三、key-scoped storage 边界混淆

当前 key namespace DB 名是：

```txt
keymaster.key.<publicKeyHash>.plugin.<pluginId>.<storageId>
```

这意味着：

1. 一旦平台改根身份，所有 key namespace DB 的命名边界都会变化；
2. `p2pkh`、`contacts`、`poker` 这类 key-scoped 数据都要明确决定：
   - 放弃旧 DB 并重建；
   - 还是做一次性迁移；
3. 如果这里不在施工单里先定死，后面实现时最容易出现“有的插件改了，有的插件偷偷继续沿用 hash 命名”的尾巴。

## 硬切换结论

本次统一采用下面这套最终规则：

### 一、平台 canonical key identity 只保留 `publicKeyHex`

`publicKeyHex` 是平台对外唯一的 key identity 根字段：

```txt
KeyIdentity.publicKeyHex
KeyRef.publicKeyHex
ActiveKeyState.activePublicKeyHex
keyspace.getKey(publicKeyHex)
keyspace.setActive(publicKeyHex)
keyspace.deleteKey({ publicKeyHex, password })
openKeyStorage({ publicKeyHex, ... })
```

### 二、`keyId` 只作为 Vault 内部引用

`keyId` 继续存在，但职责收窄为：

```txt
vault.withPrivateKey(keyId)
deleteKeyById(keyId)
导出 / 删除 / 诊断
```

`keyId` 不是 namespace 根 id，不参与 key-scoped DB 命名。

### 三、平台模型彻底删除 `publicKeyHash`

删除范围包括：

1. contract 字段；
2. service 入参；
3. service 返回值；
4. active state；
5. 事件 payload；
6. DB index 名；
7. DB name 命名根；
8. UI 文案与注释里的平台术语；
9. 测试 fixture 与 helper 命名。

本次不保留：

```txt
publicKeyHash?: string
activePublicKeyHash?: string
getKeyByPublicKeyHash()
deleteKey({ publicKeyHash })
legacy 双入参 publicKeyHex | publicKeyHash
```

### 四、P2PKH 链上哈希单独命名

`HASH160(compressed public key)` 在 P2PKH 范围内统一改名为：

```txt
pubKeyHash160Hex
```

或等价但语义同样明确的名字。要求：

1. 名字里必须显式体现 `160` 或 `hash160`；
2. 不允许再叫 `publicKeyHash`；
3. 不允许与平台 key namespace id 共用名字。

### 五、旧 hash namespace 一次性收口

旧命名：

```txt
keymaster.key.<sha256(publicKeyHex)>.plugin.<pluginId>.<storageId>
```

不再是运行时主路径。

处理原则：

1. `plugin-p2pkh`
   - 旧 hash namespace 直接放弃；
   - 新 hex namespace 下重新 `rehydrate + recent-sync + history-backfill`；
   - 可 best-effort 删除旧 hash DB，但不做数据迁移。

2. `plugin-poker`
   - 旧 hash namespace 直接放弃；
   - 这是会话/缓存态，不做迁移；
   - 可 best-effort 删除旧 hash DB。

3. `plugin-contacts`
   - 不能静默丢联系人；
   - 必须做一次性迁移：旧 hash namespace -> 新 hex namespace；
   - 迁移成功后删除旧 hash DB；
   - 只迁联系人，不抽象成平台通用迁移框架。

### 六、只允许一份最终命名事实继续存在

切换后，代码层只能有下面这两套概念：

```txt
平台身份
  publicKeyHex / keyId

P2PKH 链上脚本材料
  address / pubKeyHash160Hex / script
```

中间不再允许残留第三套 `publicKeyHash` 身份概念。

## 核心不变量

1. `publicKeyHex` 必须是压缩公钥 hex、lowercase、无 `0x` 前缀、长度 66。
2. 平台 contract 中，`publicKeyHex` 是唯一 key namespace 根身份。
3. `keyId` 不是公开身份，只是 Vault 内部借用句柄。
4. P2PKH 链上 `HASH160(pubkey)` 不是平台 identity，不允许再叫 `publicKeyHash`。
5. key-scoped storage DB 名必须统一为：

```txt
keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>
```

6. 删除 key、切 active key、后台任务 cancelByKey、日志 keyScope 都只认 `publicKeyHex`。
7. 任何新代码都不允许再从平台对象上读取 `publicKeyHash`。
8. 任何兼容逻辑都不能把 `publicKeyHash` 再带回运行期主路径。

## 不能怎么做

1. 不能把 contract 改成 `publicKeyHex`，但底层 DB 命名、事件 payload、删除入口仍然继续用 `publicKeyHash`。

2. 不能在 `KeyIdentity` / `KeyRef` / `ActiveKeyState` 里保留：

```ts
publicKeyHex?: string;
publicKeyHash?: string;
```

这种“双真值”结构。

3. 不能为了省改动保留下面这类兼容 API：

```ts
getKey(id: { publicKeyHex?: string; publicKeyHash?: string })
setActive(id: string) // 既可能是 hex 也可能是 hash
deleteKey({ publicKeyHex?: string; publicKeyHash?: string })
```

4. 不能把 `publicKeyHash` 改名成 `keyNamespaceId` 继续由 `sha256(pubkey)` 充当平台主键。那只是换皮保留旧设计，不是收口。

5. 不能把 `publicKeyHex` 只用于展示，而继续把 `publicKeyHash` 当真正 machine id。这样后面的实现仍会把 hash 当主路径，等于没改。

6. 不能在 P2PKH 里继续出现：

```txt
publicKeyHash = HASH160(pubkey)
```

这种命名。平台身份与链上脚本 hash 必须分词。

7. 不能为了“平滑升级”保留无限期 legacy alias，例如：

```txt
activePublicKeyHash -> activePublicKeyHex 映射
event payload 同时带两个字段
DB row 同时写 publicKeyHex / publicKeyHash
```

8. 不能对 `p2pkh`、`poker` 引入整套通用 namespace 迁移框架。它们的数据可重建或可放弃，不值得为此增加平台复杂度。

9. 不能把 `contacts` 的迁移问题也按“反正重建”处理。联系人是本地真值，静默丢失不可接受。

10. 不能把“旧 hash namespace 如何处理”留到实现时临时决定。必须在本施工单里先定死：
    - `contacts` 迁移；
    - `p2pkh/poker` 放弃；
    - 成功后删旧库。

11. 不能在全局共享 contract / helper 里再公开 `legacyPublicKeyHash` 这类运行期概念。旧 hash 只允许存在于一次性迁移/清理代码的局部 helper 中。

12. 不能为了少改测试，继续在 fixture 里把 `hash160(pubkey)` 或 `sha256(pubkey)` 变量命名为 `PUBLIC_KEY_HASH`。测试命名也必须跟最终模型一致。

## 应该怎么做

### 一、把平台 key 身份 contract 一次性改成 `publicKeyHex`

在 `packages/contracts/src/keyspace.ts`、`packages/contracts/src/vault.ts` 及相关 barrel 中：

1. `KeyIdentity.publicKeyHash` 删除，只保留 `publicKeyHex`。
2. `ActiveKeyState.activePublicKeyHash` 改为 `activePublicKeyHex`。
3. `KeyScopedStorageOpenInput.publicKeyHash` 改为 `publicKeyHex`。
4. `getKey(publicKeyHash)` 改为 `getKey(publicKeyHex)`。
5. `setActive(publicKeyHash)` 改为 `setActive(publicKeyHex)`。
6. `prepareDeleteKey(publicKeyHash)` 改为 `prepareDeleteKey(publicKeyHex)`。
7. `deleteKey({ publicKeyHash, password })` 改为

```ts
deleteKey({ publicKeyHex, password })
```

8. 所有 keyspace 事件 payload：
   - `key.created`
   - `key.deleting`
   - `key.deleted`
   - `activeKey.changed`

   全部改为携带 `publicKeyHex`。

设计缘由：

```txt
平台级 contract 是整次切换的第一真值。
只要 contract 还保留 publicKeyHash，后续实现就一定会被旧字段继续拉回去。
```

### 二、Vault 内只做一份 identity：`publicKeyHex`

在 `packages/plugin-vault/src/keyIdentity.ts`、`vaultDb.ts`、`vaultService.ts`：

1. `deriveKeyIdentity()` 只返回：

```ts
{
  publicKeyHex
}
```

2. `identityFromPublicKeyHex()` 仍保留，但只做 canonicalization / 校验，不再计算平台 `publicKeyHash`。

3. `vault_keys` schema 升级：
   - 删除 `publicKeyHash` unique index；
   - 新建 `publicKeyHex` unique index；
   - `DB_VERSION` 递增。

4. unlock/backfill 时，逐条把 `vault_keys` 记录重写为最终白名单字段：
   - 保留 `publicKeyHex`；
   - 不再写 `publicKeyHash`；
   - 老记录里残留的 `publicKeyHash` 必须在 rewrite 后物理消失，而不是“代码不读但字段还在”。

5. 重复导入校验从：

```txt
重复 publicKeyHash
```

改为：

```txt
重复 publicKeyHex
```

设计缘由：

```txt
如果 vault 根库还继续保留 publicKeyHash 索引或字段，
后面 keyspace / UI / 删除路径就会不断被旧模型吸回去。
```

### 三、keyspace 命名、active state、删除路径全部切到 `publicKeyHex`

在 `packages/plugin-vault/src/keyspaceService.ts`：

1. `ACTIVE_KEY_STORAGE_KEY` 改名，例如：

```txt
keyspace.activePublicKeyHex
```

2. 所有内部变量改名：

```txt
activePublicKeyHash -> activePublicKeyHex
```

3. namespace DB 名改为：

```txt
keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>
```

4. `listActiveCandidates()` 改为筛：
   - `identityStatus === "ready"`
   - `publicKeyHex` 存在

5. `deleteKey()` / `deleteKeyById()` / `prepareDeleteKey()` /
   `quiesceNamespace()` / `openKeyStorage()` 全部改成按 `publicKeyHex` 主路径运行。

6. 所有 log payload、message bus payload、测试辅助、缓存 key 都统一换成 `publicKeyHex`。

设计缘由：

```txt
平台真正的“上下文切换”和“命名空间删除”都发生在 keyspace。
这里不切干净，系统根本不算完成硬切换。
```

### 四、旧 hash namespace 的处理策略一次性定死

#### 4.1 P2PKH

在 `packages/plugin-p2pkh/src/p2pkhDb.ts`、`p2pkhService.ts`：

1. 新库直接开：

```txt
keymaster.key.<publicKeyHex>.plugin.p2pkh.state
```

2. 不迁移旧 hash namespace 的 UTXO / history / recent_sync / backfill / pending / reservations。
3. 新 namespace 下直接重新：
   - `rehydrateResources()`
   - `recent-sync`
   - `history-backfill`

4. 可选 best-effort 清理旧 hash DB，但清理失败不阻断主流程。

设计缘由：

```txt
P2PKH 真值来自链上与后续同步。
这里最合理的是放弃旧缓存，而不是为了保缓存引入一套跨 namespace 复制器。
```

#### 4.2 Poker

在 `packages/plugin-poker/src/pokerDb.ts`、`pokerService.ts`、`pokerSessionKey.ts`：

1. 新库直接开：

```txt
keymaster.key.<publicKeyHex>.plugin.plugin-poker.poker
```

2. 不迁移旧 hash namespace 的 presences / tables / txIngest。
3. 旧状态按缓存/会话态放弃，服务重连后重建。
4. 可 best-effort 删除旧 hash DB。

设计缘由：

```txt
Poker 的 key-scoped 数据不是平台长期真值，不值得为它保留迁移复杂度。
```

#### 4.3 Contacts

在 `packages/plugin-contacts/src/contactsDb.ts`、`contactsService.ts`：

1. 联系人新库改为：

```txt
keymaster.key.<publicKeyHex>.plugin.contacts.book
```

2. 首次打开新 hex namespace 时：
   - 若新库为空；
   - 且旧 hash namespace 存在；
   - 则把旧 contacts 全量复制到新库；
   - 行内归属字段改写为 `publicKeyHex`；
   - 成功后删除旧 hash DB。

3. 这条迁移逻辑只存在于 `plugin-contacts` 自己，不抽成平台通用迁移器。

4. 迁移失败时：
   - 不能先删旧库；
   - 不能部分写完就假装成功；
   - 应保持旧库仍在，让后续版本或手工诊断仍有挽回空间。

设计缘由：

```txt
联系人是本地真值，不像链上缓存那样可重建。
但联系人插件体量小，做一次局部迁移比引入平台级迁移框架更合适。
```

### 五、P2PKH 里把链上 `HASH160(pubkey)` 单独改名

在 `packages/plugin-p2pkh/src/p2pkhSigner.ts`、`p2pkhContracts.ts`、
`p2pkhTransferService.ts`、相关测试里：

1. 平台 owning key 字段统一叫 `publicKeyHex`。
2. 任何链上 `HASH160(pubkey)` helper / 变量 / 字段改名为：

```txt
pubKeyHash160Hex
```

或语义等价名字。

3. `publicKeyHash` 这个词在 `plugin-p2pkh` 内禁用，除非是 legacy 清理注释中明确指“旧平台字段”。

4. 若某个类型同时需要：
   - 平台拥有者身份；
   - 链上 P2PKH 锁定哈希；

   则必须显式写成两个不同名字段，例如：

```ts
publicKeyHex: string;
pubKeyHash160Hex: string;
```

绝不允许其中任一方继续叫 `publicKeyHash`。

设计缘由：

```txt
只要 P2PKH 里还留着 publicKeyHash 这个词，
后来的人就会继续把平台 identity 和链上 hash 混成一团。
```

### 六、localStorage、事件、日志、测试全部同步收口

在 `apps/web`、`packages/plugin-vault`、`packages/plugin-p2pkh`、
`packages/plugin-poker`、`packages/plugin-contacts`、相关测试中：

1. 本地状态 key：
   - `activePublicKeyHash` 全部改为 `activePublicKeyHex`。

2. 事件 payload：
   - 只带 `publicKeyHex`。

3. logger data：
   - 只记录 `publicKeyHex`，不再记录 `publicKeyHash`。

4. 测试 helper / fixture / 常量：
   - `PUBLIC_KEY_HASH` 改为真实含义名；
   - `HASH160(pubkey)` 的 fixture 明确叫 `PUBKEY_HASH160_HEX` 或等价名；
   - `sha256(pubkey)` 若仅用于 legacy namespace 清理，则必须显式叫
     `legacyNamespaceSha256Hex` 之类的迁移名，不准伪装成运行时主字段。

设计缘由：

```txt
如果测试与日志仍留旧词，未来修改最容易把 publicKeyHash 悄悄带回主路径。
```

## 特殊情况提前约定

### 情况 1：旧 vault 记录没有 `publicKeyHex`

处理原则：

```txt
unlock 时 backfill + rewrite
```

应该这样做：

1. 若能解密出私钥，则重新派生压缩公钥 hex；
2. 回写最终字段形状；
3. 删掉旧 `publicKeyHash` 字段；
4. 成功后记为 `ready`。

不能这样做：

1. 不能继续靠旧 `publicKeyHash` 充当占位 identity；
2. 不能只在内存里补 `publicKeyHex`，DB 里继续留旧形状。

### 情况 2：failed key 以前有 `publicKeyHash`，但现在拿不到 `publicKeyHex`

处理原则：

```txt
failed 继续 failed
平台主路径不再允许靠旧 hash 管理它
```

应该这样做：

1. `deleteKeyById(keyId)` 仍可删；
2. `export` 若需要私钥但解不出来，则继续失败；
3. 该 key 不参与 active 候选；
4. 记录重写时去掉旧 `publicKeyHash`，即使最终没有 `publicKeyHex` 也不要保留旧平台 hash 字段续命。

不能这样做：

1. 不能因为 failed key 还带旧 hash，就保留 `deleteKey(publicKeyHash)` 这条兼容路径；
2. 不能为了“方便管理”继续在 UI 或 service 里把旧 hash 当这把 key 的身份。

### 情况 3：旧 localStorage 里仍有 `activePublicKeyHash`

处理原则：

```txt
忽略旧键，重新按新模型选 active
```

应该这样做：

1. 新代码只读 `keyspace.activePublicKeyHex`；
2. unlock 后按：
   - 若新 localStorage 有 `activePublicKeyHex` 且仍存在，则用它；
   - 否则 `autoPickActive()`；
3. 发现旧 `activePublicKeyHash` 时可直接删除。

不能这样做：

1. 不能再写一套“读旧 hash -> 映射到 hex”的长期兼容逻辑常驻运行。

### 情况 4：旧 hash namespace 的 `p2pkh` / `poker` DB 仍躺在浏览器里

处理原则：

```txt
不迁移，不使用
```

应该这样做：

1. 主流程只打开新 hex namespace；
2. 可以 best-effort 清理旧 hash DB；
3. 即使清理失败，也不能回退去使用旧 hash DB。

不能这样做：

1. 不能为了读旧缓存再造一条“先查 hex namespace，没数据就查 hash namespace”的双路径。

### 情况 5：旧 hash namespace 的 contacts DB 存在，但迁移中断

处理原则：

```txt
宁可旧库保留，也不要先删后丢
```

应该这样做：

1. 复制成功后才删旧库；
2. 若复制失败，新库可回滚或丢弃，但旧库必须仍在；
3. 下次打开 contacts 时允许重试迁移。

不能这样做：

1. 不能先删旧库再开始复制；
2. 不能迁一半就把“已迁移”标志写死。

### 情况 6：需要在迁移代码里找到旧 hash namespace 名

处理原则：

```txt
旧 hash 只允许作为局部 legacy helper 存在
```

应该这样做：

1. 在具体插件局部实现一个只给迁移/清理用的 helper，例如：

```txt
legacyNamespaceSha256HexFromPublicKeyHex(publicKeyHex)
```

2. 它只能用于：
   - contacts 迁移读取旧 DB；
   - p2pkh/poker best-effort 删除旧 DB；
3. 不进入 shared contract；
4. 不进入运行时业务对象字段。

不能这样做：

1. 不能把这个 helper 再命名成 `publicKeyHashFromHex()` 并放回公共模块。

## 文件级施工

下面是一次性迭代需要落地的主要文件。

### 一、contracts

#### 1. `packages/contracts/src/keyspace.ts`

1. 全量把 `publicKeyHash` 改为 `publicKeyHex`。
2. `ActiveKeyState.activePublicKeyHash` 改为 `activePublicKeyHex`。
3. `KeyScopedStorageOpenInput.publicKeyHash` 改为 `publicKeyHex`。
4. `KeyspaceService` 所有相关方法入参与返回值同步改名。
5. 注释改写为“平台根身份 = publicKeyHex”。
6. DB naming 规则更新为：

```txt
keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>
```

#### 2. `packages/contracts/src/vault.ts`

1. `KeyRef` 删除 `publicKeyHash`。
2. `InitialActivationNotice.publicKeyHash` 改为 `publicKeyHex`。
3. 所有注释改写为：
   - `publicKeyHex` 是平台公开身份；
   - `keyId` 是内部借用句柄。

#### 3. `packages/contracts/src/contacts.ts`

1. `Contact.publicKeyHash` 改为 `publicKeyHex`。
2. 注释明确这是联系人归属的 owning key 公钥，不是链上 hash。

#### 4. `packages/contracts/src/poker.ts`

1. 所有 `activePublicKeyHash` / `publicKeyHash` 平台身份字段改为 `publicKeyHex`。
2. `PokerSessionKeyState` 相关注释改写。

#### 5. `packages/contracts/src/background.ts`、`index.ts` 等 barrel

1. 所有 keyScope / event payload 类型同步改名。
2. re-export 不留旧名。

### 二、plugin-vault

#### 6. `packages/plugin-vault/src/keyIdentity.ts`

1. `deriveKeyIdentity()` 只返回 `publicKeyHex`。
2. `identityFromPublicKeyHex()` 只做校验/canonicalization。
3. 删除平台 `publicKeyHash` 计算逻辑。

#### 7. `packages/plugin-vault/src/vaultDb.ts`

1. `DB_VERSION` 递增。
2. 删除 `publicKeyHash` index，新增/保留 `publicKeyHex` unique index。
3. `VaultKeyRecord` 删除 `publicKeyHash` 字段。
4. 增加 rewrite/normalize 路径，物理删掉旧字段。
5. `getKeyByPublicKeyHash()` 删除，改为 `getKeyByPublicKeyHex()`。

#### 8. `packages/plugin-vault/src/vaultService.ts`

1. 查重逻辑改为按 `publicKeyHex`。
2. 所有事件 payload 改为 `publicKeyHex`。
3. `recordToRef()` / `refreshKeyCache()` / backfill / import / generate /
   delete 相关代码同步切换。
4. `pendingActivationNotice` 携带 `publicKeyHex`。

#### 9. `packages/plugin-vault/src/keyspaceService.ts`

1. active state 改为 `activePublicKeyHex`。
2. namespace DB name 改为 hex 根。
3. `openDbs` cache key 改为 `${publicKeyHex}::${dbName}`。
4. `deleteKey(publicKeyHex)`、`prepareDeleteKey(publicKeyHex)`、
   `quiesceNamespace(publicKeyHex)` 全部改名改语义。
5. localStorage key 改名。
6. event publish payload 改名。

#### 10. `packages/plugin-vault/src/KeySwitchWidget.tsx`

1. 订阅 payload 改为 `publicKeyHex`。
2. active 比较字段改为 `activePublicKeyHex`。
3. UI 仍显示短公钥，不显示任何 hash。

#### 11. `packages/plugin-vault/src/VaultSettingsPage.tsx`

1. 管理动作全部按 `publicKeyHex` 路径走。
2. failed key 删除仍走 `keyId` 路径。
3. 文案/错误处理不再引用 `publicKeyHash`。

#### 12. `packages/plugin-vault/src/VaultKeyCreateModal.tsx`、`VaultKeyDeleteModal.tsx`

1. payload 与展示文案同步改名。
2. 删除确认信息继续用 `label + 短公钥`，不引入 hash。

#### 13. `packages/plugin-vault/src/*.test.ts`

1. fixture / helper / event 断言全部切换到 `publicKeyHex`。
2. 增加旧记录 rewrite 后 `publicKeyHash` 物理消失的测试。
3. 增加 old localStorage key 被忽略/清除的测试。

### 三、plugin-p2pkh

#### 14. `packages/plugin-p2pkh/src/p2pkhContracts.ts`

1. 所有拥有者字段 `publicKeyHash` 改为 `publicKeyHex`。
2. 注释明确：
   - 这是 owning key；
   - 不是链上 pubkey hash。
3. 若需要链上 `HASH160(pubkey)`，单独命名为 `pubKeyHash160Hex`。

#### 15. `packages/plugin-p2pkh/src/p2pkhDb.ts`

1. keyspace.open 参数改为 `publicKeyHex`。
2. DB name 注释改为 hex 根。
3. 旧 hash namespace 不迁移，必要时 best-effort delete。

#### 16. `packages/plugin-p2pkh/src/p2pkhService.ts`

1. active identity 与 current namespace 改为 `publicKeyHex`。
2. `rehydrateResources()` 写入 `publicKeyHex`。
3. `key.created` / `key.deleted` / `active.changed` 订阅 payload 改名。
4. 旧 hash DB 不再进入任何读取路径。

#### 17. `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`

1. rows/resource/history/utxo/submission/input-claim 的拥有者字段改为 `publicKeyHex`。
2. 不再出现平台 `publicKeyHash` 命名。

#### 18. `packages/plugin-p2pkh/src/p2pkhTransferService.ts`

1. 平台 owning key 改为 `publicKeyHex`。
2. 若内部需要链上 `HASH160(pubkey)`，明确命名 `pubKeyHash160Hex`。

#### 19. `packages/plugin-p2pkh/src/p2pkhSigner.ts`

1. 若需要显式暴露 `HASH160(pubkey)` helper，则名字必须带 `160`。
2. 注释明确这是链上脚本材料，不是平台 namespace id。

#### 20. `packages/plugin-p2pkh/src/pages/*.tsx`、`widgets/*.tsx`

1. 不显示 `publicKeyHash`。
2. 若有调试列/诊断列涉及 owning key，改为 `publicKeyHex` 或短公钥。

#### 21. `packages/plugin-p2pkh/src/*.test.ts`

1. `PUBLIC_KEY_HASH`、`ACTIVE_PUBLIC_KEY_HASH` 这类名字全部按真实语义改。
2. `hash160(pubkey)` 测试值改名为 `PUBKEY_HASH160_HEX` 或等价名。
3. 增加“旧 hash namespace 不被读取、只走新 hex namespace”的测试。

### 四、plugin-contacts

#### 22. `packages/plugin-contacts/src/contactsDb.ts`

1. `openContactsDb({ publicKeyHash })` 改为 `openContactsDb({ publicKeyHex })`。
2. store index `publicKeyHash` 改为 `publicKeyHex`。
3. 新增一次性迁移：
   - 若新库为空且旧 hash DB 存在，则复制旧联系人；
   - 成功后删旧库。

#### 23. `packages/plugin-contacts/src/contactsService.ts`

1. service 内所有 active key 读取改为 `activePublicKeyHex`。
2. `Contact.publicKeyHex` 回写。
3. 注释明确 contacts 是本地真值，因此做迁移而不是放弃。

#### 24. `packages/plugin-contacts/src/*.tsx` 与测试

1. 若有归属字段展示或断言，改为 `publicKeyHex`。
2. 增加 contacts 迁移成功/失败不删旧库的测试。

### 五、plugin-poker

#### 25. `packages/plugin-poker/src/pokerDb.ts`

1. DB 名注释改为 `keymaster.key.<publicKeyHex>.plugin.plugin-poker.poker`。
2. 若任何 row 使用平台 `publicKeyHash`，改为 `publicKeyHex`。

#### 26. `packages/plugin-poker/src/pokerSessionKey.ts`

1. `activePublicKeyHash` 改为 `activePublicKeyHex`。
2. `noActiveHash` 这类状态命名同步改为 `noActiveKey` 或 `noActivePublicKeyHex`，不再保留旧词。

#### 27. `packages/plugin-poker/src/pokerService.ts` 与测试

1. 解析 active key、日志、事件断言全改为 `publicKeyHex`。
2. 旧 hash namespace 只允许 best-effort 清理，不允许读取回退。

### 六、apps/web / runtime / 其他

#### 28. `apps/web/src/shell/AppShell.tsx`、`AppShell.guard.test.ts`

1. active key 判定字段改为 `activePublicKeyHex`。
2. 顶层 notice / guard 不再读 `publicKeyHash`。

#### 29. `packages/runtime`、`packages/plugin-background`

1. 若日志或后台任务 keyScope 依赖旧字段，统一改成 `publicKeyHex`。
2. `cancelByKey` 等命名可以保留方法名，但 payload/调用语义必须清楚是 `publicKeyHex`。

#### 30. `README.md`

1. 更新平台身份、key namespace、P2PKH 术语说明。
2. 明确：
   - 平台根身份 = `publicKeyHex`
   - P2PKH 链上 hash = `pubKeyHash160Hex`

## 最终验收清单

### 一、代码搜索层

- [ ] 运行时代码中不存在平台字段/状态/API 名 `publicKeyHash`。
- [ ] 运行时代码中不存在 `activePublicKeyHash`。
- [ ] `plugin-p2pkh` 运行时代码中不存在把链上 `HASH160(pubkey)` 命名为 `publicKeyHash` 的地方。
- [ ] 若仓库里仍出现 `publicKeyHash` 字样，只允许出现在：
  - 本施工单等历史文档；
  - 局部 legacy 迁移注释；
  - 一次性旧库清理 helper 的明确 legacy 命名中。

### 二、contract 层

- [ ] `KeyIdentity` / `KeyRef` / `ActiveKeyState` / `Contact` / Poker 相关 contract 全部以 `publicKeyHex` 为平台根身份。
- [ ] `keyspace.openKeyStorage` 入参为 `publicKeyHex`。
- [ ] `keyspace.deleteKey` 入参为 `{ publicKeyHex, password }`。
- [ ] 所有 keyspace / vault 事件 payload 只携带 `publicKeyHex` 与 `keyId`，不再携带 `publicKeyHash`。

### 三、Vault / Keyspace 层

- [ ] `vault_keys` 上的唯一性检查以 `publicKeyHex` 为准。
- [ ] unlock/backfill 后，旧记录会被 rewrite 成最终字段形状，`publicKeyHash` 不再被续命。
- [ ] localStorage 只使用 `keyspace.activePublicKeyHex`。
- [ ] key namespace DB 名统一为 `keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>`。

### 四、P2PKH 层

- [ ] `p2pkh` 所有拥有者字段都叫 `publicKeyHex`。
- [ ] 链上 `HASH160(pubkey)` 字段/helper 明确叫 `pubKeyHash160Hex` 或等价名。
- [ ] `plugin-p2pkh` 不会再读取旧 hash namespace DB。
- [ ] 切 active key 后，P2PKH 会在新 hex namespace 下正常 rehydrate 和同步。

### 五、Contacts / Poker / 旧库处理

- [ ] `contacts` 首次打开新 hex namespace 时能把旧 hash namespace 联系人迁过来。
- [ ] contacts 迁移失败时旧库仍保留，不会先删后丢。
- [ ] `poker` 不迁移旧 hash namespace，只在新 hex namespace 重建运行时状态。
- [ ] `p2pkh` / `poker` 的旧 hash DB 即使仍存在，也不会被运行时代码重新使用。

### 六、UI / 测试 / 日志

- [ ] UI 不再显示或复制任何平台 `publicKeyHash`。
- [ ] 测试 fixture / helper 的命名与最终语义一致，不再用 `PUBLIC_KEY_HASH` 指代别的东西。
- [ ] 日志、错误上下文、MessageBus 诊断字段统一使用 `publicKeyHex`。

### 七、人工回归

- [ ] 新建钱包后，active key、Vault 管理、顶部切换、P2PKH、Contacts、Poker 都在 `publicKeyHex` 模型下正常运行。
- [ ] 导入已有 key 后，不会因为缺旧 `publicKeyHash` 而出现任何主路径故障。
- [ ] 删除 ready key、删除 failed key、切换 active key 都不再依赖 `publicKeyHash`。
- [ ] 旧用户升级后：
  - Vault key 列表正常；
  - P2PKH 能重新同步；
  - Contacts 能迁移；
  - Poker 能重新建立会话；
  - 不会再打开旧 hash namespace 作为主路径。
