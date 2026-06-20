# 004 P2PKH 后台任务与 namespace DB 关闭竞态硬切换施工单

## 目标

一次性把当前 P2PKH 的 active key 切换 / Vault 锁定链路硬切换为下面这套最终模型：

```txt
旧 key 的 background task 仍在运行
  先 cancel
  先 await 旧实例真正退出
  再关闭旧 key 的 namespace DB handle
  再切 active / 再发布 vault.locked

任务生命周期
  不能碰 closing 的 IDBDatabase
  不能靠吞掉 InvalidStateError 假装恢复
  不能靠重试把顺序错误掩盖掉

系统原则
  顺序收紧
  语义单一
  不增加第二套恢复机制
```

本次是硬切换，不接受“先把异常 catch 掉再说”“先给 transaction 套重试”“先让锁屏和切 key 大多数时候不报错”这类中间态。

## 问题定义

当前观察到的报错是：

```txt
InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.
```

对应任务是：

```txt
taskId = p2pkh.history-backfill
```

这不是 WOC 请求失败，也不是某一页 backfill 数据坏了，而是典型的生命周期顺序错误：

1. 旧 key 的 `history-backfill` 还在跑。
2. active key 切换或 Vault 锁定开始清理。
3. namespace DB 连接先被关闭。
4. 还没退出的后台任务继续调用 `db.transaction(...)`。
5. 浏览器抛 `InvalidStateError`，background task 被记成 failed。

## 简述缘由

1. 这个项目当前最合理的修法，不是提高“业务补救能力”，而是把资源关闭顺序做对。顺序对了，错误自然消失；顺序不对，补多少重试都只是掩盖。
2. `InvalidStateError: database connection is closing` 不是随机浏览器毛病，而是非常明确的信号：代码在对一个正在关闭的 `IDBDatabase` 开事务。
3. 当前删除 key 的主路径已经有“先 cancelByKey，再关 handle，再删 namespace DB”的语义，这说明系统本来就承认“先停任务，后关资源”才是正确顺序。active key 切换和 Vault 锁定也必须统一到这条语义上。
4. P2PKH 的恢复路径已经是 `rehydrate + recent-sync + history-backfill`。这次故障和数据真值无关，没必要再引入“事务失败重试器”“closing 特判吞错器”“后台任务自恢复写库兜底”这类新复杂度。
5. 如果把这个错误当“可接受边缘失败”直接吞掉，日志会安静，但系统真实状态会变差：任务可能半途退出、状态被错误标记、用户以为只是偶发失败，后续排障更难。

## 硬切换结论

本次统一采用下面这套最终规则：

```txt
active key 切换
  = 先 cancel old key background tasks
  = await old task instances exit
  = 再 close old key namespace DB handles
  = 再 setActiveInternal(new key)

Vault lock
  = 先 cancel current key background tasks
  = await old task instances exit
  = 再 close namespace DB handles
  = 再 publish vault.locked

P2PKH onVaultLocked
  = 不再承担“抢先 cancel 才安全”的职责
  = 它只做本地缓存 / 状态清理

InvalidStateError: database connection is closing
  = 不视为正常取消
  = 不吞
  = 正确做法是从顺序上消灭它
```

本次切换后，必须满足下面的不变量：

1. 任何会关闭 namespace DB handle 的路径，必须先让该 key 的后台任务退出。
2. “后台任务已收到 abort”不等于“后台任务已退出”；必须 `await` 到旧实例真正结束。
3. `setActive()` 不能再先关 DB、后切 active、最后才让业务插件自己善后。
4. `vault.locked` 不能再在 namespace DB 已关、但任务还没真正退出时对业务层可见。
5. 不允许把 `InvalidStateError` 包装成取消、paused 或正常边缘失败。
6. 不允许为这次问题引入新的 transaction retry 策略。

## 不能怎么做

1. 不能在 `p2pkhDb.tx()` 或 `commitBackfillPage()` 里 catch `InvalidStateError` 后直接 return。当成“用户正好切 key/锁屏了，忽略即可”是不对的。
2. 不能给 `db.transaction(...)` 外面再套一层重试。连接都在 closing，重试只会让时序更乱。
3. 不能只改 P2PKH，把 `background.cancel()` 放在 `vault.locked` 事件订阅里继续 fire-and-forget。那只是把竞态留在系统边界外。
4. 不能只在 active key 切换后补一条 `background.cancelByKey(oldKey)`，但仍然先 `setActiveInternal(newKey)` 再去 cancel。因为 `keyScope` 是延迟求值的，切完 active 以后再 cancel，匹配到的已经不是旧 key。
5. 不能新增“closing 状态白名单”或“transaction on closing db 视为 ok”的平台特判。
6. 不能为了降低改动面，把 `vault.locked` 继续当成“通知业务自己取消任务”的事件。锁屏语义是平台级会话结束，平台必须先把关键资源停稳，再向业务暴露事件。
7. 不能复制出第二套“停任务 + 关 handle”逻辑散落在 P2PKH、Vault、Keyspace 各处。必须收口到 keyspace 的 namespace 清理语义。

## 应该怎么做

### 总体策略

把 active key 切换、Vault 锁定、删除 key 三条路径统一收口到同一条 namespace quiesce 语义：

```txt
quiesceKeyNamespace(publicKeyHash)
  -> cancelByKey(publicKeyHash)
  -> await old task instances exit
  -> close matching openDbs handles

delete key
  已经近似是这条语义
  继续沿用

setActive
  改成先 quiesce old key
  再切 active

onVaultLocked
  改成先 quiesce current active key
  再关剩余 openDbs
  再清 active
```

设计缘由：

```txt
系统里真正知道“哪些 DB handle 属于哪个 key namespace”的地方是 keyspace，
不是 P2PKH，也不是 background 平台。
```

### 一、把“停任务并等待退出”提升为 keyspace 的显式屏障

在 `packages/plugin-vault/src/keyspaceService.ts`：

1. 抽出内部辅助函数，语义类似：

```txt
quiesceNamespace(publicKeyHash)
  如果 attachedBackground 存在
    await attachedBackground.cancelByKey(publicKeyHash)
  再关闭这个 key 的 openDbs
```

2. 这个辅助函数必须成为下面三条路径的唯一实现来源：
   - `prepareDeleteKey(publicKeyHash)`
   - `setActive(publicKeyHash)` 中对旧 active key 的清理
   - `onVaultLocked()` 中对当前 active key 的清理
3. 不能把“先 cancel 再关 handle”的语义分别手写三次。只要一条路径忘记 await，就会重新长回同类 bug。

设计缘由：

```txt
删除 key 路径已经证明“先停后台任务，再关 namespace 资源”是有效模型，
本次只是把这个模型扩展为 active 切换和 vault 锁定的统一语义。
```

### 二、active key 切换必须先停旧 key 任务，再切 active

在 `packages/plugin-vault/src/keyspaceService.ts` 的 `setActive(publicKeyHash)`：

1. 先取 `prev.activePublicKeyHash`。
2. 若 `prev.activePublicKeyHash` 存在且与目标 key 不同：
   - 先 `await quiesceNamespace(prev.activePublicKeyHash)`；
   - 再 `setActiveInternal({ activePublicKeyHash: publicKeyHash })`。
3. 若切换目标就是当前 active key：
   - 直接 return；
   - 不重复 cancel，不重复 close。
4. `setActiveInternal()` 必须继续保留在清理之后，不能提前。

设计缘由：

```txt
active 状态一旦先变了，background task 的延迟 keyScope 求值就会指向新 key，
此时再 cancelByKey(oldKey) 已经失去正确匹配边界。
```

### 三、Vault 锁定必须先停任务，再关闭 DB，再发 vault.locked

在 `packages/contracts/src/keyspace.ts` 与 `packages/plugin-vault/src/keyspaceService.ts`：

1. 把 `onVaultLocked()` 从同步方法升级为 `Promise<void>`。
2. `onVaultLocked()` 的语义改成：
   - 若当前有 active key，先 `await quiesceNamespace(active.activePublicKeyHash)`；
   - 再关闭可能残留的其它 openDbs；
   - 再 `setActiveInternal({})`。
3. 这一步完成前，Vault 不应该向外发布 `vault.locked`。

在 `packages/plugin-vault/src/vaultService.ts`：

1. `lock()` 改成：

```txt
setStatus("locked")
await keyspace.onVaultLocked()
publish("vault.locked")
```

2. `finalizeEmptyVaultAfterLastKeyDeletion()` 内部如果还复用会话结束清理链路，也必须遵守同样顺序：
   - 先 await `keyspace.onVaultLocked()`
   - 再 publish `vault.locked`
   - 再做剩余 finalize 收尾

设计缘由：

```txt
vault.locked 不是“请各业务插件现在开始抢救性收尾”的信号，
而应该是“平台级会话和关键命名空间已经停稳”的信号。
```

### 四、P2PKH 不再负责抢救式 cancel，职责收窄为本地清理

在 `packages/plugin-p2pkh/src/p2pkhService.ts`：

1. `onVaultLocked()` 不再承担“正确性依赖于我先 cancel task”的职责。
2. 允许保留 `backgroundService.cancel(P2PKH_TASK_*)` 作为幂等保险，但不能再把它当正确性边界；更合理的做法是移除这两条 fire-and-forget cancel，只保留：
   - `setStatus("idle")`
   - `disposeP2pkhDb()`
   - 清理 `p2pkhDbHandle / currentPublicKeyHash / activeIdentity / activeKeyId`
3. 注释必须写清：
   - 锁屏前的任务退出屏障由 keyspace 负责；
   - P2PKH 在 `vault.locked` 上只做本地会话缓存释放。

设计缘由：

```txt
P2PKH 知道自己的 task id，
但它不知道系统中“什么时候关闭 namespace handle 才安全”的总顺序；
这个顺序边界必须由 keyspace 统一掌控。
```

### 五、不要改 background 平台的失败语义

在 `packages/plugin-background/src/backgroundService.ts`：

1. 本次原则上不改 `runOne()` 的 failed/canceled 语义。
2. `InvalidStateError` 不应该被 background 平台识别为“正常取消”。
3. 正确目标不是改 background 的错误分类，而是让这种错误不再发生。

设计缘由：

```txt
这个错误不是任务业务内的合法结束分支，
而是上游生命周期顺序错了。
```

## 特殊情况提前约定

### 情况 1：active key 从 A 切到 B 时，A 的 history-backfill 正在跑

处理原则：

```txt
先停 A
再关 A
最后才切到 B
```

应该这样做：

1. `setActive(B)` 先拿到旧值 `A`。
2. `await cancelByKey(A)`。
3. 等旧 `history-backfill` 真正退出。
4. 关闭 `A` 的 openDbs。
5. 再把 active 改成 `B`，发布 active change。

不能这样做：

1. 不能先关 `A` 的 DB，再等 `history-backfill` 自己因为异常退出。
2. 不能先把 active 改成 `B`，再试图 cancel `A`。

### 情况 2：Vault 锁定时，P2PKH recent-sync / history-backfill 正在跑

处理原则：

```txt
锁屏是平台级停止点
不是业务自己竞速收尾
```

应该这样做：

1. `vaultService.lock()` await `keyspace.onVaultLocked()`。
2. `keyspace.onVaultLocked()` 先 await 当前 active key 任务退出。
3. 任务退出后再关 namespace DB。
4. 最后才 publish `vault.locked`。

不能这样做：

1. 不能继续先 `keyspace.onVaultLocked()` 直接关 DB，再发 `vault.locked` 让业务去 cancel。
2. 不能在 `vault.locked` 事件订阅里依赖 fire-and-forget cancel 保正确。

### 情况 3：background service 还没 attach 到 keyspace

处理原则：

```txt
不引入新复杂度
按最小语义退化
```

应该这样做：

1. `quiesceNamespace(publicKeyHash)` 发现 `attachedBackground` 不存在时，直接关闭该 key 的 openDbs。
2. 注释明确这表示“当前没有可等待的后台平台接入”，不是新建第二套本地任务状态机。

原因：

```txt
没有 background service 时，本身就不存在需要经它 cancelByKey 协调的任务平台。
```

### 情况 4：active key 重复切到自己

处理原则：

```txt
无事不做
```

应该这样做：

1. 若目标 hash 与当前 active 相同，直接 return。
2. 不 cancel，不 close，不重发 active changed。

不能这样做：

1. 不能把“重复 setActive 当前 key”也当成一次完整 quiesce。那会平白打断正在跑的同步。

### 情况 5：修复后仍然再看到 InvalidStateError

处理原则：

```txt
继续当 bug 查
不能降级成正常情况
```

应该这样做：

1. 说明系统里还有其它提前 close DB 的路径未被 quiesce 语义覆盖。
2. 继续补齐顺序边界。

不能这样做：

1. 不能因为“这次只偶发一条”就改成 catch-and-ignore。
2. 不能把日志等级从 error 降成 info/warn 伪装为正常收尾。

## 文件级施工

### 1. `packages/contracts/src/keyspace.ts`

要做的事：

1. 把 `onVaultLocked(): void` 改为 `onVaultLocked(): Promise<void>`。
2. 注释明确：
   - `onVaultLocked` 是平台级锁屏清理屏障；
   - resolve 时表示当前 key namespace 的后台任务已退出，相关 DB handle 已关闭。
3. 若有 `setActive()` 注释，也补充“切换前会先 quiesce 旧 active namespace”。

### 2. `packages/plugin-vault/src/keyspaceService.ts`

要做的事：

1. 新增内部 helper，语义类似 `quiesceNamespace(publicKeyHash)`。
2. 让 `prepareDeleteKey(publicKeyHash)` 复用这个 helper，而不是继续手写一套。
3. `setActive(publicKeyHash)` 改为：
   - 目标就是当前 active -> 直接返回；
   - 否则先 await 旧 active 的 quiesce；
   - 再 `setActiveInternal(...)`。
4. `onVaultLocked()` 改为 async：
   - 先 await 当前 active key 的 quiesce；
   - 再关闭其余 openDbs；
   - 再 `setActiveInternal({})`。
5. 注释明确：
   - active 切换、删除 key、Vault 锁定共用同一条 namespace quiesce 语义；
   - 关闭 DB 之前必须先 await 旧任务退出。

### 3. `packages/plugin-vault/src/vaultService.ts`

要做的事：

1. `lock()` 改为 await `keyspace.onVaultLocked()`。
2. `vault.locked` 的 publish 放在上述 await 之后。
3. 若 `finalizeEmptyVaultAfterLastKeyDeletion()` 内部也调用 `keyspace.onVaultLocked()`，同样保持 await 顺序先于 `vault.locked` publish。
4. 注释明确：
   - `vault.locked` 是“平台清理完成后”的事件；
   - 不能再把它当“请业务开始抢清理”的起点。

### 4. `packages/plugin-p2pkh/src/p2pkhService.ts`

要做的事：

1. 收窄 `onVaultLocked()` 职责到本地缓存释放。
2. 视实现选择：
   - 删除 `backgroundService.cancel(P2PKH_TASK_RECENT)` 与 `backgroundService.cancel(P2PKH_TASK_BACKFILL)`；
   - 或保留为幂等保险，但注释明确不再依赖它们保证正确性。
3. 补注释说明：
   - 任务退出屏障由 keyspace + background.cancelByKey 负责；
   - P2PKH 这里只清理本地句柄与内存状态。

### 5. `packages/plugin-vault/src/keyspaceService.test.ts`

至少补这些测试：

1. `setActive(B)` 在 `A` 的后台任务未退出前，不会先关闭 `A` 的 namespace DB。
2. `setActive(B)` 会先调用 `cancelByKey(A)`，再切 active。
3. `onVaultLocked()` 会先等待 `cancelByKey(currentActive)` resolve，再关闭 DB、再清 active。
4. `prepareDeleteKey()` 仍然保持现有语义，并复用新的 quiesce helper。
5. 重复 `setActive(currentActive)` 不会触发 cancel / close。

### 6. `packages/plugin-vault/src/vaultService.test.ts`

至少补这些测试：

1. `lock()` 会 await `keyspace.onVaultLocked()` 完成后才 publish `vault.locked`。
2. `finalizeEmptyVaultAfterLastKeyDeletion()` 里的锁屏清理顺序同样正确。
3. 若 `keyspace.onVaultLocked()` 抛错，错误仍可见，不被吞掉伪装成成功锁屏。

### 7. `packages/plugin-p2pkh/src/p2pkhService.test.ts` 或相关集成测试

至少补这些测试：

1. `history-backfill` 运行中切 active key，不再因为 `database connection is closing` 进入 failed。
2. `history-backfill` 运行中 lock vault，不再因为 closing DB 失败。
3. P2PKH 在 `vault.locked` 后仍会释放自身缓存句柄，不残留旧 handle。

## 实施顺序

本次虽然是一次性硬切换，但代码落地顺序应固定，避免中途制造新的半状态：

1. 先改 `contracts/keyspace.ts`，锁定 `onVaultLocked(): Promise<void>` 语义。
2. 再改 `keyspaceService.ts`，把 quiesce helper 抽出来并接上 `setActive / prepareDeleteKey / onVaultLocked`。
3. 再改 `vaultService.ts`，让 `lock()` 和 finalize 链路 await 新屏障。
4. 再改 `p2pkhService.ts`，把 `onVaultLocked()` 职责收窄。
5. 最后补齐 keyspace / vault / p2pkh 的测试。

注意：

```txt
提交可以分文件
但最终合并语义必须一次到位
不能出现“contract 已要求 await，实际实现仍然同步 close DB”的中间态
```

## 最终验收清单

### 行为验收

- [ ] `p2pkh.history-backfill` 运行中切 active key，不再出现 `InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.`
- [ ] `p2pkh.history-backfill` 运行中锁定 Vault，不再出现同类 closing DB 异常。
- [ ] active key 从 A 切到 B 时，旧 key A 的后台任务会先退出，再关闭 A 的 namespace DB。
- [ ] Vault 锁定时，当前 active key 的后台任务会先退出，再关闭 namespace DB，再对业务层发布 `vault.locked`。
- [ ] 重复切到当前 active key，不会打断正在跑的同步任务。

### 顺序验收

- [ ] `setActive()` 的旧 key 清理顺序是：`cancelByKey(old)` -> `await old task exit` -> `close old openDbs` -> `setActiveInternal(new)`。
- [ ] `onVaultLocked()` 的清理顺序是：`cancelByKey(current)` -> `await current task exit` -> `close openDbs` -> `setActiveInternal({})`。
- [ ] `vaultService.lock()` 的顺序是：`setStatus("locked")` -> `await keyspace.onVaultLocked()` -> `publish("vault.locked")`。
- [ ] 删除 key 路径继续保持“先停任务，再关 namespace，再删数据”的既有语义，并复用同一个 helper。

### 错误语义验收

- [ ] 没有新增“吞掉 InvalidStateError”或“把 closing DB 当取消”的逻辑。
- [ ] 没有新增 transaction retry / backoff / 二次提交之类的复杂恢复机制。
- [ ] 若 `keyspace.onVaultLocked()` 自身失败，错误仍然可见，不会被包装成锁屏成功。

### 结构验收

- [ ] active 切换、Vault 锁定、删除 key 的 namespace 清理逻辑已经收口到 keyspace 的单一 quiesce 语义。
- [ ] P2PKH `onVaultLocked()` 不再承担系统正确性所依赖的 cancel 职责。
- [ ] `vault.locked` 事件的含义已经收紧为“平台级资源已停稳”，不是“开始清理”的信号。
- [ ] 文档、注释使用中文；代码错误信息保持英文。

### 回归验收

- [ ] 现有 key 删除流程仍然可以正确取消该 key 的后台任务并删除 namespace DB。
- [ ] Vault unlock 后，P2PKH 仍按原规则 rebind / rehydrate / trigger recent + backfill。
- [ ] active key 切换后，新 key 的 recent-sync / history-backfill 仍可正常触发。
- [ ] background tray 对 recent-sync / history-backfill 的 started / completed / failed / canceled 状态显示语义不被本次修改破坏。

## 本次明确不做

1. 不引入新的 background task ACK 协议或跨 tab 等待机制。
2. 不改 `backgroundService.runOne()` 的错误分类规则。
3. 不加 IndexedDB transaction retry。
4. 不借这次需求顺手改 P2PKH 的同步业务语义、WOC 请求策略或 schema。
5. 不把 `InvalidStateError` 重新定义为“可接受边缘失败”。
