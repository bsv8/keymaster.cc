# 005 P2PKH DB 版本升级与不匹配即重建硬切换施工单

## 目标

一次性把当前 `packages/plugin-p2pkh` 的本地存储切换为下面这套最终模型：

```txt
P2PKH DB schema version
  当前从 v6 升到 v7

打开 DB
  插件层仍走 openP2pkhDb() -> keyspace.openKeyStorage(...)
  indexedDB.open(name, 7) 只作为底层语义说明，
  不允许在 plugin-p2pkh 里直接调用

版本旧于目标
  进入 onupgradeneeded
  不迁移旧数据
  直接删光当前 P2PKH stores
  按 v7 完整重建

版本高于目标
  keyspace.openKeyStorage 抛 VersionError
  关闭当前缓存 handle
  deleteDatabase(name)
  再 openKeyStorage(version = 7) 新建

版本等于目标
  直接使用

系统原则
  不做老数据迁移
  不做表级补丁链
  不做多套恢复机制
  只保留“版本不匹配即 rebuild”这一套语义
```

本次是硬切换，不接受“先保留旧表凑合兼容”“先做半套 migrate，以后再删”“先补一个 meta 表看看”这类中间态。

## 简述缘由

1. 当前项目已经明确接受 `plugin-p2pkh` 本地缓存不是业务真值，真值来自链上与后续 `rehydrate + recent-sync + history-backfill`。
2. 既然不保老数据，本次最合理的方案就不是迁移，而是版本不匹配时直接重建。
3. `plugin-p2pkh` 当前使用的是每把 key 独立、每个 plugin 独立的 namespace DB，不和其它 plugin 共库；因此删除整个 `p2pkh` DB 边界清晰，不会误伤别的业务。
4. `IndexedDB` 内部版本已经天然提供了“当前 schema 代数”和 `onupgradeneeded / VersionError` 两条分支，足够承载本次最简需求，不需要再引入第二套版本真值。
5. 当前需求重点不是“修坏库的所有可能性”，而是把“代码要求的版本”和“本地 DB 实际版本”收紧成一条简单、可预期、可自愈的硬规则。

## 问题定义

当前 `packages/plugin-p2pkh/src/p2pkhDb.ts` 里：

1. `P2PKH_DB_VERSION` 还是 `6`。
2. 版本旧于目标时，虽然会进入 `onupgradeneeded`，但当前语义更接近“升级并重建 stores”，没有把“这是一次硬切换 rebuild，而不是数据迁移”说死。
3. 版本高于目标时，`keyspace.openKeyStorage` 内部触发的
   `indexedDB.open(name, targetVersion)` 会直接报 `VersionError`；
   如果不在 `openP2pkhDb()` 里显式捕获并收敛，就无法回到代码要求版本。
4. 当前需求已经明确：
   - 不做老数据迁移；
   - 不做升级兼容；
   - 只要版本不匹配，就要进入 rebuild 语义。

## 硬切换结论

本次统一采用下面这套最终规则：

```txt
P2PKH schema version
  = 7

openP2pkhDb() -> keyspace.openKeyStorage(name, 7)
  oldVersion < 7
    -> onupgradeneeded
    -> 删除所有现有 P2PKH stores
    -> 按 v7 schema 重建

  oldVersion === 7
    -> 普通打开
    -> 直接使用

  oldVersion > 7
    -> keyspace.openKeyStorage 抛 VersionError
    -> close cached handle
    -> plugin-p2pkh 自己拼出 name
       = `keymaster.key.<publicKeyHash>.plugin.p2pkh.state`
    -> indexedDB.deleteDatabase(name)
    -> 再次 keyspace.openKeyStorage(version = 7)
    -> 全新建库
```

本次切换后，必须满足下面的不变量：

1. `plugin-p2pkh` 的 schema 目标版本固定为 `7`，不再继续以 `6` 运行。
2. `oldVersion < 7` 时，upgrade 路径不是“保数据升级”，而是“删光旧 stores 后重建 v7”。
3. `oldVersion > 7` 时，不能 silent fail，不能继续使用；必须收敛到“删整库后按 v7 新建”。
4. `oldVersion === 7` 时，不额外引入表结构扫描、meta 表校验、迁移补丁链。
5. 本次硬切换不负责保留任何旧 P2PKH 本地数据。
6. 删除 / 重建的边界是整份 `keymaster.key.<publicKeyHash>.plugin.p2pkh.state` namespace DB，不是跨 plugin 共库。

## 不能怎么做

1. 不能把 `P2PKH_DB_VERSION` 继续留在 `6`，却只改注释或文档说“已经是新版本”。
2. 不能在 `onupgradeneeded` 里保留旧数据、逐表复制、补索引、兼容历史列。这次不做迁移。
3. 不能新增 `meta` store 作为第二套 schema 真值。当前最简方案只使用 `IndexedDB` 内部版本。
4. 不能把 `VersionError` 当成普通打开失败直接抛给 UI，而不进入删库重建。
5. 不能在 `VersionError` 分支里只删某几张表，不删整个 `p2pkh` namespace DB。
6. 不能把这次逻辑做成“只有部分打开路径会 rebuild，另一些路径还是旧行为”。必须收口到 `openP2pkhDb()` 一处。
7. 不能为了“保险”额外造一套后台修复器、启动迁移器、一次性脚本链。当前系统不需要第二套恢复通道。
8. 不能让 `plugin-p2pkh` 直接调 `indexedDB.open(name, 7)` 打开
   namespace DB——这是绕过 `keyspace.openKeyStorage` 的"抄近路"，会
   让 keyspace 的 `openDbs` 缓存、active 切换、删除 key 时的 handle
   关闭等机制全部失效。`indexedDB.open` 在本施工单里**只能**作为
   底层语义说明，不允许出现在 plugin-p2pkh 的运行时调用栈里。
9. 不能"等 keyspace 加一个 delete helper 再做"或"缓存上一次 handle.name
   备用"来处理 VersionError -> deleteDatabase 这一步。plugin-p2pkh 必须
   按 keyspace 写在 contract 上的命名约定直接拼出
   `keymaster.key.<publicKeyHash>.plugin.p2pkh.state` 自己删除。

## 应该怎么做

### 一、把 P2PKH DB 目标版本从 v6 升到 v7

在 `packages/plugin-p2pkh/src/p2pkhDb.ts`：

1. 把 `P2PKH_DB_VERSION` 从 `6` 改到 `7`。
2. 顶部注释和 `createV6Stores` 相关描述同步升级为 v7 语义。
3. 如果现有重建函数名带 `V6`，一并收敛到与 v7 一致的命名，避免代码名义上还停留在旧版本。

设计缘由：

```txt
这次不是口头上的“规则变了”，而是显式 schema generation +1。
只有真的升版本，浏览器才会把 oldVersion < targetVersion 的库导向 upgrade 分支。
```

### 二、统一把 oldVersion < 7 定义为“upgrade 事务内删表重建”

在 `packages/plugin-p2pkh/src/p2pkhDb.ts`：

1. 继续统一走 `openP2pkhDb()` 内部封装，对应底层是 `keyspace.openKeyStorage(...)`：

```ts
keyspace.openKeyStorage({
  publicKeyHash,
  pluginId: "p2pkh",
  storageId: "state",
  version: P2PKH_DB_VERSION,
  upgrade(db, oldVersion, newVersion) { ... }
})
```

`indexedDB.open(name, P2PKH_DB_VERSION)` 在本施工单里**只作为底层语义说明**——
它最终会被 `keyspace.openKeyStorage` 内部调起，但 `plugin-p2pkh` 自身不允许
直接调 `indexedDB.open`，必须经过 `openP2pkhDb()` 这一道关卡。

2. 在 `upgrade` 回调里明确：
   - 只要进入 upgrade，就不做旧数据迁移；
   - 删除当前 DB 内已存在的全部 `p2pkh_*` stores；
   - 再按 v7 schema 完整重建所需 stores 与 indexes。
3. 这条路径的语义要在注释中写明：
   - `oldVersion === 0`：首次创建；
   - `0 < oldVersion < 7`：旧版本升级；
   - 但两者都统一落到“按 v7 rebuild stores”，不是迁移。

设计缘由：

```txt
upgrade 事务本来就是浏览器给的 schema 独占窗口。
既然不要迁移，最直接的做法就是在这个窗口里删光旧 stores，重建新版结构。
```

### 三、统一把 oldVersion > 7 定义为“VersionError -> 整库删除 -> 新建”

在 `packages/plugin-p2pkh/src/p2pkhDb.ts`：

1. `openP2pkhDb()` 或其底层打开路径要显式捕获 `VersionError`。
2. 命中 `VersionError` 后，统一执行：

```txt
1) 关闭当前模块缓存的 openHandle（如果存在）
2) 调用 indexedDB.deleteDatabase(name)
3) delete 成功后，再次 keyspace.openKeyStorage(version = 7) 打开
```

3. `name` 的来源必须明确——当前 `KeyScopedStorageOpenInput` contract 下，
   失败的 `keyspace.openKeyStorage` 不会返回 handle，调用方拿不到
   `handle.name`。本次施工单采用下面这套**唯一**做法：

```txt
plugin-p2pkh 自己按 keyspace 的命名约定拼出 DB name：
  name = namespaceDbName(publicKeyHash)
       = `keymaster.key.<publicKeyHash>.plugin.p2pkh.state`

这条命名约定是 keyspace 写在 contract 上的硬事实
（见 packages/contracts/src/keyspace.ts:114-115：
  `keymaster.key.<publicKeyHash>.plugin.<pluginId>.<storageId>`）。
plugin-p2pkh 在 VersionError 分支内直接用这条规则拼出 name，
自己调 indexedDB.deleteDatabase(name)；不允许"等 keyspace 加一个
delete helper 再做"或"缓存上一次的 handle.name 备用"。
```

实现上建议在 p2pkhDb.ts 内部把这条拼装规则封到
`namespaceDbName(publicKeyHash)` 一个本地 helper 里：

- 调用点只看到一行 `deleteDatabase(namespaceDbName(publicKeyHash))`，
  读起来就是"删当前 key 的 p2pkh namespace DB"，意图直接；
- 拼装规则只在一处，万一 keyspace 以后改命名约定也只动这一处；
- 测试可以直接覆盖 `namespaceDbName("hex...")` 的输出，验证
  命名约定没有被悄悄改。

4. 这里删除的是整份：

```txt
keymaster.key.<publicKeyHash>.plugin.p2pkh.state
```

而不是单独某些 stores。
5. 这条路径必须写注释说明：
   - 这是“本地 DB 版本高于当前代码要求版本”的 fail-closed 收敛；
   - 当前项目不支持 downgrade 兼容；
   - 正确做法就是放弃旧缓存并重建；
   - deleteDatabase 路径绕过了 keyspace——这意味着 keyspace 内部
     `openDbs` 缓存不会同步清掉；但因为我们在 VersionError 触发
     之前 `openKeyStorage` 已经失败、handle 根本没进缓存，所以
     重建时第二次 `openKeyStorage` 走的是首次 open 路径，不存在
     缓存污染问题。

设计缘由：

```txt
当 oldVersion > targetVersion 时，浏览器不会给 upgrade 机会。
既然系统不打算做向后兼容，最简单、最一致的做法就是删整库后重建到代码要求版本。
```

### 四、把 rebuild 边界明确为“整份 p2pkh namespace DB”，不是共库里的部分表

在文档、注释、测试里都要说清楚：

1. `plugin-p2pkh` 使用的是每把 key 自己的 namespace DB。
2. DB 名格式是：

```txt
keymaster.key.<publicKeyHash>.plugin.p2pkh.state
```

3. 这个 DB 只归 `plugin-p2pkh` 自己使用。
4. 因此：
   - `oldVersion < 7` 时，在 upgrade 事务里删光当前 DB 内全部 `p2pkh_*` stores 后重建，是安全的；
   - `oldVersion > 7` 时，删除整库 `deleteDatabase(name)` 也是安全的；
   - 不存在“和别的 plugin 共库，删错别人表”的风险。

设计缘由：

```txt
只有先把存储边界说清楚，删库重建这个策略才是可审计、可接受的。
```

### 五、测试要覆盖版本不匹配进入 rebuild，而不是继续复用旧库

在 `packages/plugin-p2pkh/src/p2pkhDb.test.ts` 及相关单测里：

1. 增加或更新下面几类用例：
   - `oldVersion = 0`：首次创建，最终版本是 `7`；
   - `oldVersion = 6`：打开 `version = 7`，进入 upgrade，最终版本是 `7`，旧 stores 不保留；
   - `oldVersion = 8`：打开 `version = 7`，触发 `VersionError`，删整库后重建，最终版本是 `7`。
2. 需要显式验证：
   - 重建后 DB `version === 7`；
   - 需要的 stores 存在；
   - 不再保留旧版本遗留 stores；
   - `VersionError` 分支不是停在失败，而是能成功收敛到新库。
3. v6 / v8 这两个用例需要 keyspace fake **不要**像默认 fake 那样把
   `oldVersion` 强行传成 0——必须透传 `IDBVersionChangeEvent.oldVersion`，
   浏览器层在 `oldVersion > targetVersion` 时自然触发
   `req.onerror` 抛 `VersionError`，才能验证完整 rebuild 链路。
   不允许在 fake 层用 "if version mismatch then throw VersionError"
   这种模拟来替代真 IDB 路径，否则等于没测这条分支。
4. v8 用例的 DB name / `namespaceDbName(publicKeyHash)` 拼写
   也要被测试覆盖——这是 Section 三"plugin-p2pkh 自己拼 name"
   这条规则的回归点：如果 keyspace 改命名约定，这里会先红。

设计缘由：

```txt
这次需求的核心不是“表长什么样”，而是“版本不匹配时一定进入 rebuild 语义”。
测试必须直接证明这一点。
```

## 特殊情况与处理规则

### 情况一：DB 不存在

处理：

```txt
直接 open(name, 7)
进入首次创建
建出 v7 stores
```

说明：

```txt
这是正常路径，不是错误，也不需要先 deleteDatabase。
```

### 情况二：DB 版本低于 7

处理：

```txt
进入 onupgradeneeded
删除现有 P2PKH stores
按 v7 全量重建
```

说明：

```txt
不迁移旧数据，不复制旧记录，不保留兼容层。
```

### 情况三：DB 版本高于 7

处理：

```txt
命中 VersionError
close cached handle
deleteDatabase(name)
reopen(name, 7)
```

说明：

```txt
这是“代码比本地库旧”的场景。
当前项目不做 downgrade 兼容，只允许放弃本地缓存并回到代码要求版本。
```

### 情况四：deleteDatabase 被 blocked / 失败

处理：

```txt
不继续假装成功
不跳过 rebuild
直接失败上抛
```

说明：

```txt
blocked 说明还有连接没关干净；这时继续流程只会让“代码以为已经重建成功，实际库没删掉”。
本次必须 fail-closed。
```

### 情况五：已有模块级 openHandle

处理：

```txt
进入 VersionError 重建前必须先 close 并清掉 openHandle
```

说明：

```txt
否则 deleteDatabase 很容易被自己持有的连接阻塞。
```

### 情况六：active key 切换到另一把 key

处理：

```txt
按新的 publicKeyHash 打开新的 namespace DB
每把 key 的 p2pkh DB 独立判断版本并独立 rebuild
```

说明：

```txt
这次硬切换的重建边界始终是“当前 key 的 p2pkh namespace DB”，不是全局单库。
```

## 文件级实施清单

### `packages/plugin-p2pkh/src/p2pkhDb.ts`

1. `P2PKH_DB_VERSION` 从 `6` 升到 `7`。
2. 把 schema 注释、重建函数命名、目标版本描述统一到 v7。
3. `upgrade` 回调里明确执行“删旧 stores -> 建 v7 stores”，不做迁移。
4. 打开流程显式处理 `VersionError`：
   - close cached handle；
   - **按 keyspace 命名约定自己拼出** `keymaster.key.<publicKeyHash>.plugin.p2pkh.state`；
   - delete 整库；
   - reopen 到 v7。
5. 给关键路径补清晰注释，说明：
   - 为什么 old < target 走 upgrade rebuild；
   - 为什么 old > target 走整库删除重建；
   - 为什么当前不支持 downgrade 兼容；
   - **为什么 name 是 plugin-p2pkh 自己拼的**（keyspace contract
     下失败的 `openKeyStorage` 不会返回 handle，调用方拿不到 `handle.name`；
     命名约定又是写在 contract 上的硬事实，可以直接拼）。

### `packages/plugin-p2pkh/src/p2pkhDb.test.ts`

1. 更新当前 schema 版本断言到 `7`。
2. 增加 `v6 -> v7` rebuild 用例：使用透传 `IDBVersionChangeEvent` 的
   keyspace fake，覆盖整条 upgrade 路径。
3. 增加 `v8 -> deleteDatabase -> v7` 收敛用例：使用同一个透传 fake，
   验证 `openP2pkhDb` 在 VersionError 触发时
   `close -> deleteDatabase(name = keymaster.key.<hash>.plugin.p2pkh.state) -> reopen` 整条链路。
4. 验证重建后 stores 集合与版本号符合预期。
5. 增加"非 VersionError 必须原样冒泡，不被吞错假装 rebuild"用例。

### `packages/plugin-p2pkh/src/p2pkhServiceManualTrigger.test.ts`

1. 若测试里对 DB version 或 DB 名有直接假设，需要同步更新到 v7 语义。
2. 若测试覆盖手工触发路径依赖打开 DB 成功，需要补一条“版本不匹配后仍能恢复打开”的验证。

### 相关引用处

1. 所有提到“当前 schema 是 v6”的注释、断言、测试命名都要同步到 v7。
2. 所有“upgrade 是修复 / 重建”的描述都要明确本次不含数据迁移语义。
3. 所有提到 `indexedDB.open(name, version)` 的地方都要明确这只是
   底层语义说明，**plugin-p2pkh 自身的运行时调用必须经过
   `openP2pkhDb() -> keyspace.openKeyStorage(...)`**。

## 最终验收清单

1. `packages/plugin-p2pkh/src/p2pkhDb.ts` 中目标版本已经从 `6` 变成 `7`。
2. 打开一个本地 `v6` 的 `p2pkh` DB 时，会进入 `onupgradeneeded`，旧 stores 被删除，最终以 `v7` schema 成功打开。
3. 打开一个本地 `v8` 的 `p2pkh` DB 时，不会停在 `VersionError`；会进入“close handle -> deleteDatabase -> reopen(v7)”并最终成功打开。
4. 重建成功后，DB `version === 7`。
5. 重建成功后，v7 所需 stores 全部存在，不应再残留已废弃旧 stores。
6. 本次实现中没有新增迁移函数、补丁链、meta 版本表或额外恢复器。
7. 本次实现中没有把重建边界扩大到其它 plugin，也没有误删共享库，因为 `plugin-p2pkh` 使用的是独立 namespace DB。
8. 单测能直接证明“版本不匹配时进入 rebuild”，而不是只证明“首次创建能成功”。
9. `deleteDatabase` 若 blocked / 失败，流程会明确失败，而不是假装已经 rebuild 完成。
10. 所有与当前 schema 版本相关的注释、命名、测试断言已经统一到 v7，不再留 `v6` 旧语义混淆。
