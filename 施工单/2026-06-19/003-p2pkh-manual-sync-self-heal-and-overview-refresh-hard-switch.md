# 003 P2PKH 手工同步自愈、全量 info 日志与总览页真刷新硬切换施工单

## 目标

一次性把当前 P2PKH 同步链路硬切换为下面这套最终模型：

```txt
旧 P2PKH 本地缓存
  不迁移
  不补历史 DB 到新 namespace
  直接允许链上真值重新同步下来

P2PKH 存储修复
  缺 DB / 缺表 / 版本旧
  统一走 openKeyStorage(version + upgrade)
  直接修复到最新版 schema

手工同步 / 手工回填
  先对当前 active key 做 rehydrate
  保证当前 key 至少有可同步的 P2PKH resource
  再触发 background task

同步日志
  每一次同步都必须有 info 日志
  包括手工触发、自动触发、0 resource、自愈创建 resource、完成结果

总览页
  不再依赖“点击按钮后立刻 setVersion()”假刷新
  必须在后台同步完成后重新读取 recent_sync / resources / backfill states
```

本次是硬切换，不接受“先补一点日志看看”“先保留旧 DB 迁移以后再说”“先让页面多点几次刷新按钮凑合可用”这类中间态。

## 简述缘由

1. 链上数据才是 P2PKH 真值。本地缓存丢了、旧格式废了，并不是需要做复杂迁移的灾难；最多只是重新同步时间变长。
2. 当前故障不是单点，而是三处一起坏：
   - 老 key 的旧 P2PKH 数据没有迁移到新的 key-scoped storage；
   - 手工同步不会先补 resource，空资源时 recent-sync 直接跑空；
   - 总览页只会在按钮点击瞬间读一次状态，同步完成后不会再读，所以页面长期显示“最近同步：未同步”。
3. 现有 `migrateLegacyP2pkhDb()` 只有定义没有接线，而且它天然和现在“只允许 active key 打开 namespace DB”的约束冲突。继续补这条迁移链，只会把系统复杂度重新做高。
4. 对这个项目来说，正确优先级不是“把每一份旧缓存都救回来”，而是“系统能简单粗暴恢复运行，边缘缓存失败就失败”。
5. “任务里有反应，但页面还是未同步”比“同步慢”更糟，因为它会误导你判断系统状态。页面必须跟真实任务完成态对齐。
6. 日志不是可选锦上添花。当前同步链路里大量分支是 silent no-op，导致“到底没触发、没资源、没 active key、还是跑完没刷新页面”完全分不清。

## 硬切换结论

本次统一采用下面这套最终规则：

```txt
不做旧 P2PKH DB 迁移
  = 不调用 migrateLegacyP2pkhDb()
  = 老 key 切回来后，由 rehydrate + WOC 重建当前 key 的 P2PKH 状态

手工 recent-sync / history-backfill
  = 先 rehydrate 当前 active key
  = 再 trigger background

缺 DB / 缺表
  = 不是错误分支
  = 是正常自愈路径
  = 统一升级到当前 schema

recent-sync 的“最近同步时间”
  = 仍以 p2pkh_recent_sync.lastSuccessAt / lastCheckedAt 为真值
  = 不回写 address 表伪造 lastSyncedAt

总览页刷新
  = 订阅同步状态
  = 在任务完成态重读 service
  = 不再靠按钮点击后的立即刷新冒充“同步完成”
```

本次切换后，必须满足下面的不变量：

1. 老的全局 `p2pkh` DB 不是主路径，也不是恢复路径；系统不再尝试把它迁进当前 key namespace。
2. 当前 active key 只要能被选中，手工同步前必须先尝试补齐当前 key 需要的 `p2pkh:<network>` resource。
3. `openKeyStorage(..., version, upgrade)` 是 P2PKH 存储修复的唯一入口；不允许再造第二套“修表脚本”“单次迁移器”“特殊补丁函数”。
4. 每一次 recent-sync / history-backfill 触发都必须写 `info` 日志，不能 silent。
5. `0 resource` 不是异常崩溃，但也不能静默掩盖；必须记 `info`，说明本次同步为什么没有实际工作。
6. 总览页“最近同步”只允许显示 recent-sync 真值；不能为了 UI 好看而把按钮点击时间写成已同步。
7. 页面刷新必须跟后台任务完成态耦合，不能继续依赖用户手工二次刷新或切页。

## 不能怎么做

1. 不能启用或补接 `migrateLegacyP2pkhDb()`，把旧全局 `p2pkh` DB 迁到新 namespace。你已经明确接受链上真值重建，这条迁移链只会增加复杂度。
2. 不能在手工同步按钮里只继续 `backgroundService.trigger()`，却不先 `rehydrate()` 当前 active key。空 resource 场景下那等于什么也没做。
3. 不能把“缺 DB / 缺表”当成需要用户手工修复的错误。对 P2PKH 来说，这必须是自动修复路径。
4. 不能为了让页面显示好看，直接把“点击同步的时间”写进 `recent_sync` 或 address 表。那是假同步。
5. 不能只在 recent-sync 真正请求到 WOC 时记日志，而把“手工触发”“0 resource”“自愈补 resource”“schema 修复”这些关键分支留空。
6. 不能给总览页再加一个本地“最近点击同步时间”状态冒充真实同步状态。
7. 不能把“同步完成后页面不刷新”的问题交给用户重新进页面、切 tab、改筛选项。页面自己必须订阅到真实完成态。
8. 不能做成“先补文档，代码里继续留旧路径共存”。这次只允许一套最终行为继续存在。

## 应该怎么做

### 一、放弃旧 P2PKH 缓存迁移，明确以链上真值重建为唯一恢复路径

在 `packages/plugin-p2pkh/src/p2pkhDb.ts`：

1. 保留 `migrateLegacyP2pkhDb()` 的代码可以接受，但它不再接入任何启动路径、rehydrate 路径、unlock 路径、手工同步路径。
2. 注释必须明确：
   - 当前系统不再依赖 legacy migration 恢复 P2PKH 数据；
   - 老缓存即使存在，也允许被放弃；
   - 恢复路径是 `rehydrate + recent-sync + history-backfill`。

设计缘由：

```txt
只要系统还能从 WOC 重建当前 active key 的资源、UTXO 和历史，
旧本地缓存就不是必须保全的业务真值。
```

### 二、把“缺 DB / 缺表 / schema 旧”收口成正常自愈路径

在 `packages/plugin-p2pkh/src/p2pkhService.ts` 与 `packages/plugin-p2pkh/src/p2pkhDb.ts`：

1. 继续统一走：

```ts
keyspace.openKeyStorage({
  publicKeyHash,
  pluginId: "p2pkh",
  storageId: "state",
  version: P2PKH_DB_VERSION,
  upgrade: createV6Stores
})
```

2. `ensureDb()` 的语义明确为：
   - 若当前 key 的 P2PKH namespace DB 不存在，则创建；
   - 若存在但版本旧，则升级；
   - 若缺表，则在 upgrade 中补齐最新版结构；
   - 这不是错误，而是修复。
3. 为 `ensureDb()` 补 `info` 日志，至少包含：
   - `publicKeyHash`
   - 是否复用已有 handle
   - 是否新打开 namespace DB
   - 当前 schema version / 目标 version
4. 若浏览器层面真的发生 `indexedDB.open` 失败，这才作为真实错误上抛，并写 `error` 日志。

设计缘由：

```txt
P2PKH 存储的正确恢复方式，不是维护额外迁移流程，
而是让“打开当前 key 的 namespace DB”天然具备修复能力。
```

### 三、手工同步与手工回填都必须先 rehydrate 当前 active key

在 `packages/plugin-p2pkh/src/p2pkhService.ts`：

1. `triggerRecentSync()` 改成：
   - 先写 `info` 日志：手工 recent-sync 已请求；
   - 先执行 `await rebindActiveKey()` 或等价 ready 检查；
   - 再执行 `await rehydrateResources()`；
   - 最后再 `backgroundService.trigger(P2PKH_TASK_RECENT, "manual")`。
2. `triggerHistoryBackfill()` 同样先：
   - 记录 `info`；
   - `rehydrateResources()`；
   - 再触发 backfill。
3. `rehydrateResources()` 要补 `info` 日志：
   - 当前 active key 是谁；
   - includeTestnet 是否开启；
   - 本次尝试补哪些网络；
   - 哪些 resource 已存在；
   - 哪些 resource 是本次新建。
4. `getOrCreateAddress()` 要补 `info` 日志：
   - `resourceId`
   - `network`
   - `keyId`
   - `address`
   - `created = true/false`

设计缘由：

```txt
手工同步的第一职责不是“发任务”，
而是保证当前 active key 具备最基本的可同步资源。
```

### 四、recent-sync / backfill 要把“0 resource”当成可观测结果，不再 silent

在 `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`：

1. 当前 `resources.length === 0` 直接 `return` 的路径要改成：
   - 先写 `info` 日志；
   - 日志里明确写出 `resourceCount = 0`；
   - 再返回。
2. `runOnce()` 开始时已经有 `started`，结束时有 `completed`；
   需要确保这两个日志在 `0 resource` 场景下也能出现，或者至少有同等级的 `info` 说明本次同步无资源可处理。
3. 每个 resource 的同步前后也建议补 `info`：
   - `resourceId`
   - `network`
   - `address`
   - `utxoCount`
   - `recentConfirmedCount`

在 `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts`：

1. `resources.length === 0` 时同样记录 `info`。
2. 手工 backfill 被触发、但当前无可回填 resource 时，要能从日志上看出原因，而不是只看到 background task 有动作。

设计缘由：

```txt
“这次同步没有任何 resource 可跑”不是崩溃，
但它是重要诊断信息，必须能看见。
```

### 五、总览页必须在同步完成后真刷新，不再依赖按钮点击时的假刷新

在 `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`：

1. 保留现有 `load()` 读取路径：
   - `service.listResources(assetId)`
   - `service.listBackfillStates()`
   - `service.listRecentSyncStates()`
2. 删除“点击按钮后立刻 `setVersion(v + 1)` 就算刷新”的主逻辑依赖。
   这个行为可以保留为立即反馈，但不能是唯一刷新方式。
3. 新增对 `service.onSyncStatusChange()` 的订阅。
4. 在下面这些完成态里触发一次真正重读：
   - `syncing -> ok`
   - `syncing -> failed`
   - `syncing -> idle`
5. 若 recent-sync / backfill 都共用同一个 `syncStatus()`，页面可以不区分任务类型；只要后台任务结束后能重新拉取 `recent_sync` 真值即可。
6. “最近同步”字段继续只从 `recentByResource.get(resourceId)` 取：
   - `lastSuccessAt`
   - fallback `lastCheckedAt`
   不引入新的 UI 本地时间字段。
7. 若同步完成后 resource 仍为空，要显示真实空态；若 recent_sync 已更新，则应能正确从“未同步”切到时间戳。

设计缘由：

```txt
页面必须订阅后台任务完成结果，
而不是只在按钮点击瞬间自我刷新一次。
```

### 六、同步链路所有入口补齐 info 级日志

本次要求的“每一次同步都应该有 info 日志”，至少覆盖下面这些入口：

1. `packages/plugin-p2pkh/src/p2pkhService.ts`
   - `triggerRecentSync()`
   - `triggerHistoryBackfill()`
   - `onVaultUnlocked()`
   - `onActiveChange` 触发的 auto recent/backfill
   - `applyGlobalSettings(includeTestnet false -> true / true -> false)` 触发的同步
   - `onKeyImported()`
   - `rehydrateResources()`
   - `getOrCreateAddress()`
   - `ensureDb()`
2. `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`
   - `runOnce()` 开始
   - `0 resource`
   - 每个 resource 开始
   - 每个 resource 完成
   - `runOnce()` 完成
3. `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts`
   - `runOnce()` 开始
   - `0 resource`
   - 每个 resource 开始
   - 每个 resource 完成 / complete
   - `runOnce()` 完成

日志消息要求：

1. 注释与文档写中文可以，但实际错误信息保留英文。
2. `message` 用英文短句，便于统一日志页后续过滤与机器检索。
3. `data` 放结构化字段，不要把大对象原样 dump。
4. 不记录私钥、rawTxHex、完整 WOC 响应体。

## 特殊情况提前约定

### 情况 1：当前 active key 没有任何 P2PKH DB

处理原则：

```txt
这不是阻断错误
这是正常自愈
```

应该这样做：

1. `ensureDb()` 打开当前 key 的 namespace DB。
2. 若 DB 不存在，直接创建最新版 schema。
3. `rehydrateResources()` 补齐 `p2pkh:main`，若 includeTestnet=true 再补 `p2pkh:test`。
4. 然后 recent-sync / backfill 正常继续。

不能这样做：

1. 不能提示用户“请先初始化 P2PKH DB”。
2. 不能要求单独点一个“修复数据库”按钮。

### 情况 2：当前 active key 有 P2PKH DB，但没有 address resource

处理原则：

```txt
先补 resource
再同步
```

应该这样做：

1. 手工 recent-sync / backfill 先调用 `rehydrateResources()`。
2. `getOrCreateAddress("main")` 至少要保证主网 resource 存在。
3. resource 创建成功后再触发 background task。

不能这样做：

1. 不能让 `0 resource` recent-sync 静默 return 后页面继续显示“还没有 P2PKH 资源”，却不给任何自愈机会。

### 情况 3：老 key 还残留旧全局 `p2pkh` DB 数据

处理原则：

```txt
不迁移
不报错
不依赖
```

应该这样做：

1. 系统完全忽略旧全局 `p2pkh` DB。
2. 切到这把老 key 时，通过 `rehydrate + recent-sync + backfill` 从链上重建。
3. 若需要诊断，只在日志里说明本次走的是自愈重建，不走 legacy migration。

不能这样做：

1. 不能为了“挽救旧缓存”再把迁移器接回主路径。
2. 不能让老 key 因为没有迁移而进入不可恢复态。

### 情况 4：手工同步触发成功，background task 的托盘里有动作，但页面仍显示“未同步”

处理原则：

```txt
这说明页面刷新链路坏了
不是 recent_sync 真值一定没写
```

应该这样做：

1. 总览页订阅 `onSyncStatusChange()`。
2. 在后台任务结束时重新拉 `listRecentSyncStates()`。
3. 只要 `lastSuccessAt / lastCheckedAt` 已写入，就必须显示时间戳。

不能这样做：

1. 不能要求用户自己重新进页面验证。
2. 不能把“按钮点击时间”写进 UI 假装修好了。

### 情况 5：rehydrate 成功创建了 resource，但 WOC 请求失败

处理原则：

```txt
resource 保留
同步失败可见
后续可重试
```

应该这样做：

1. 继续保留新建的 `p2pkh:<network>` resource。
2. recent-sync / backfill 记录 `warn/error`。
3. 总览页仍显示 resource 行，但“最近同步”继续按 recent_sync 真值显示为未同步或旧时间。
4. 用户下次手工同步可再次重试。

## 文件级改动清单

### 1. `packages/plugin-p2pkh/src/p2pkhService.ts`

要做的事：

1. 手工 `triggerRecentSync()` 改为先 `rehydrate` 再 trigger。
2. 手工 `triggerHistoryBackfill()` 改为先 `rehydrate` 再 trigger。
3. `ensureDb()` 补自愈创建 / 打开 schema 的 `info` 日志。
4. `rehydrateResources()`、`getOrCreateAddress()` 补 `info` 日志。
5. `onVaultUnlocked()`、`onActiveChange`、`onKeyImported()`、settings 触发同步的入口补 `info` 日志。
6. 明确不接入 legacy migration。

### 2. `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`

要做的事：

1. `0 resource` 分支补 `info`。
2. 每个 resource 的开始 / 完成补 `info`。
3. 保持 `lastSuccessAt / lastCheckedAt` 仍由 `p2pkh_recent_sync` 维护。

### 3. `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts`

要做的事：

1. `0 resource` 分支补 `info`。
2. 每个 resource 的开始 / 完成 / complete 补 `info`。
3. 手工回填链路完成后，页面能通过同步状态刷新看到最新 backfill state。

### 4. `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`

要做的事：

1. 订阅 `service.onSyncStatusChange()`。
2. 在同步完成态重新调用当前页面的 `load()` 逻辑。
3. 降低对按钮点击后 `setVersion()` 假刷新的依赖。
4. 保持“最近同步”只读 recent-sync 真值。

### 5. `packages/plugin-p2pkh/src/p2pkhDb.ts`

要做的事：

1. 明确 legacy migration 不再接入主路径。
2. 如有必要，调整注释，防止后续开发者误以为它仍是默认恢复方案。
3. 保持 schema upgrade 是修复当前 namespace DB 的唯一真值。

### 6. `packages/plugin-p2pkh/src/*.test.ts`

至少应覆盖：

1. 手工 recent-sync 在无 resource 时会先 rehydrate，再触发任务。
2. 手工 backfill 在无 resource 时会先 rehydrate，再触发任务。
3. `0 resource` recent-sync / backfill 会记录 `info` 日志。
4. 总览页在同步状态从 `syncing` 进入完成态后，会重新读取 `recent_sync` 并刷新 UI。
5. 老 key 没有旧缓存迁移时，当前 active key 仍可通过 rehydrate 创建 resource。

## 最终验收清单

### 行为验收

- [ ] 切到一个老 key，原来页面显示“还没有 P2PKH 资源”时，点击“触发同步”后会先补出当前 active key 的 `p2pkh:main` resource。
- [ ] 若 `includeTestnet=true`，同样可以补出 `p2pkh:test` resource。
- [ ] 当前 active key 没有任何 P2PKH DB 时，不需要手工修库；同步流程会自动创建最新版 schema。
- [ ] 手工点击“触发同步”后，background task 有动作，任务完成后总览页“最近同步”会从“未同步”切到真实时间。
- [ ] 手工点击“触发回填”后，若有 resource，backfill state 会在页面上刷新，不需要手工二次进入页面。
- [ ] recent-sync 失败时，页面不会伪装成已同步；仍显示旧时间或“未同步”。
- [ ] 老的全局 `p2pkh` DB 即使还存在，也不会阻断当前系统运行。

### 日志验收

- [ ] 每次手工 recent-sync 都有 `info` 日志。
- [ ] 每次手工 history-backfill 都有 `info` 日志。
- [ ] `rehydrateResources()` 执行时有 `info` 日志，能看出本次是否新建了 resource。
- [ ] `ensureDb()` 首次打开当前 key 的 P2PKH namespace DB 时有 `info` 日志。
- [ ] `0 resource` recent-sync 会记录 `info`，而不是静默返回。
- [ ] `0 resource` history-backfill 会记录 `info`，而不是静默返回。
- [ ] 每个 resource 的 recent-sync 至少有开始 / 完成两类 `info` 日志。
- [ ] 日志里不落私钥、rawTxHex、完整 WOC 响应。

### 结构验收

- [ ] 没有任何启动路径接入 `migrateLegacyP2pkhDb()`。
- [ ] 没有新增独立“迁移旧 P2PKH 缓存”的 service、command、按钮或后台任务。
- [ ] 总览页不再只靠按钮点击瞬间的 `setVersion()` 假刷新维持状态。
- [ ] “最近同步”仍只读 `p2pkh_recent_sync.lastSuccessAt / lastCheckedAt`。

### 回归验收

- [ ] active key 切换后，旧 key 的请求结果不会写回新 key 页面。
- [ ] Vault unlock 后，P2PKH 仍会按原规则自动 rehydrate 并触发 recent/backfill。
- [ ] includeTestnet=false 时，不会意外新建 testnet resource。
- [ ] includeTestnet=true 时，testnet resource 仍可正常创建并参与同步。
- [ ] 现有 transfer、asset provider、balance widget 不因为这次改动失去当前 active key 的 P2PKH 读取能力。

