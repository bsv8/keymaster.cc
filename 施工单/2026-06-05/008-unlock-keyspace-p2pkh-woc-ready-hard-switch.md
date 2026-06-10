# 008 Unlock Ready Boundary / P2PKH 抢跑 / WOC 404 空结果硬切换施工单

## 目标

一次性修复系统启动或解锁后 web 控制台出现的两类错误：

```txt
Error: Key storage is not ready
GET https://api.whatsonchain.com/.../confirmed/unspent 404 (Not Found)
GET https://api.whatsonchain.com/.../confirmed/history 404 (Not Found)
```

本次是硬切换，不做“先让组件 catch 错误、以后再理顺服务状态”的分步骤修补。

修复完成后：

```txt
Vault 解锁按钮返回成功
  表示 masterKey 可用、identity backfill 完成、keyspace active key 已选定。

UnlockedShell / 首页业务 widget 渲染
  只能发生在 keyspace ready 之后。

P2PKH 后台任务
  只在 Vault unlocked + keyspace 非初始化 + single active key 时运行。

WOC confirmed UTXO / confirmed history
  对“地址没有确认 UTXO 或确认历史”的 404 视为空结果。
```

## 硬切换缘由

1. 当前 `vault.unlock()` 先把 Vault 状态切到 `unlocked` 并发出 `vault.unlocked`，然后才执行 identity backfill 和 `keyspace.onVaultUnlocked()`。
2. App 看到 `unlocked` 后立即渲染 `UnlockedShell`，首页 `P2pkhBalanceWidget` 挂载时马上调用 `getAssetBalance()`。
3. 此时 keyspace 可能还没有 active key，所以 `p2pkhService.ensureDb()` 抛出 `Key storage is not ready`。
4. 只在 widget 层 catch 这个错误会掩盖根因：平台对外宣布“已解锁”的时刻早于业务可用时刻。
5. 后台任务 `canRun` 只检查 `vault.status() === "unlocked"` 和 `single active key`，没有把 identity backfill 初始化期纳入条件，也可能抢跑。
6. WOC 对同一地址的 balance endpoint 可以返回 200 + 0，但 confirmed unspent / confirmed history 可能返回 404。对钱包来说，这不是同步失败，而是空 UTXO / 空历史。
7. 分步骤实施会形成双语义：

```txt
旧语义：
  unlocked = masterKey 已进内存，业务插件自己判断 keyspace 是否 ready。

新语义：
  unlocked = 对 UI 和业务插件可用，keyspace 已完成 ready 边界。
```

双语义会让每个业务插件都重复实现 readiness 防御，后续插件越多越容易漏。

## 核心不变量

1. `VaultStatus = "unlocked"` 对 UI 和业务插件的含义必须是“平台解锁完成且 keyspace 可用”，不能只是“masterKey 已经放入内存”。
2. identity backfill 阶段必须通过 `keyspace.isInitializing()` 暴露，但业务主界面不应该在这个阶段提前开始 key-scoped 读写。
3. `vault.unlocked` 事件必须在 keyspace active key 选择完成后发出。
4. `p2pkhService.ensureDb()` 继续 fail closed。没有 single active key 时仍然抛 `Key storage is not ready`，不能静默打开错误 namespace。
5. P2PKH UI 可以展示“尚未就绪/空值”，但不能把 readiness 错误作为未处理 Promise 打到控制台。
6. P2PKH 后台任务不能在 keyspace 初始化期运行。
7. WOC 429、timeout、5xx、网络错误仍然是真失败；只有特定读取型 endpoint 的 404 可以归一为空结果。
8. 代码里的错误信息继续使用英文；文档和注释使用中文。

## 不能怎么做

1. 不能只在 `P2pkhBalanceWidget` 里包一层 `try/catch` 就结束。这只能消除一个控制台错误，不能修复平台 ready 边界。
2. 不能把 `ensureDb()` 改成返回全局 DB 或临时 DB。P2PKH 数据必须仍然属于 active key namespace。
3. 不能在没有 active key 时返回某个旧 key 的缓存余额。这会造成跨 key 数据串读。
4. 不能让后台任务在 `keyspace.isInitializing() === true` 时继续运行。
5. 不能把所有 WOC 404 都吞掉。广播、tx 查询或非空结果语义的接口如果返回 404，仍应按错误处理。
6. 不能为了减少错误清空用户 IndexedDB、Vault 或 key namespace 数据。
7. 不能改 WOC endpoint 路径来“试错”。当前路径与 WOC 文档一致，问题是空结果返回语义。
8. 不能引入“延迟 setTimeout 重试”作为主方案。ready 边界应该由状态机和事件顺序保证。

## 文件级施工

### packages/plugin-vault/src/vaultService.ts

硬切换 `unlock(password)` 的完成边界。

目标顺序：

```txt
校验 meta / password
masterSalt = salt
masterKey = key
await backfillIdentities()
await keyspace.onVaultUnlocked()
setStatus("unlocked")
emit "vault.unlocked"
```

设计缘由：

```txt
masterKey 需要先进入内存，backfill 才能解密 key 材料。
但 UI 可见的 unlocked 必须放到 keyspace ready 之后。
```

注意事项：

1. `backfillIdentities()` 失败 key 仍按现有逻辑标记 `identity-failed`，不能让单把坏 key 阻止整个 Vault 解锁。
2. 如果 `backfillIdentities()` 或 `keyspace.onVaultUnlocked()` 抛出不可恢复错误，`unlock()` 必须进入失败路径，并清理 `masterKey` / `masterSalt`，避免 UI 仍停在 locked 但内存里有解锁态材料。
3. `createVault(password)` 是首次创建路径。它创建时通常没有旧 key 需要 backfill，但仍要明确 ready 边界：创建后如果 keyspace 存在，应保证 keyspace 处于一致状态，再 `setStatus("unlocked")` / emit。
4. `lock()` 顺序保持：先切 locked 并清内存，再通知 keyspace 锁定，再发 `vault.locked`。

### packages/plugin-vault/src/vaultService.test.ts

补充或调整测试，覆盖 `unlock()` 的事件顺序。

必须验证：

```txt
vault.unlock(password) resolve 前：
  keyspace.onVaultUnlocked 已经执行。

vault.unlocked 事件发出时：
  keyspace.active() 已经不是未就绪的临界状态。
```

如果现有测试 mock keyspace，应让 mock 记录调用顺序，而不是只断言最终状态。

### apps/web/src/App.tsx

原则上不需要改。

修复后 `App` 继续只依赖 runtime status：

```txt
booting / !ready -> loading
uninitialized / locked -> LockedShell
unlocked -> UnlockedShell
```

不要在 `App.tsx` 里再额外判断 `keyspace.isInitializing()`。ready 边界应该由 Vault 状态机保证，不能把平台内部时序泄漏给根组件。

### packages/plugin-p2pkh/src/p2pkhService.ts

收紧后台任务运行条件。

`P2PKH_TASK_RECENT.canRun` 必须同时满足：

```txt
vault.status() === "unlocked"
!keyspace.isInitializing()
keyspace.active().mode === "single"
```

`P2PKH_TASK_BACKFILL.canRun` 必须同时满足：

```txt
vault.status() === "unlocked"
!backfillPaused
!keyspace.isInitializing()
keyspace.active().mode === "single"
```

`onVaultUnlocked()` 保持负责：

```txt
rebindActiveKey()
rehydrateResources()
trigger recent
trigger backfill
```

但它现在应只在 keyspace 已 ready 后被事件触发。不要在里面用重试循环弥补顺序问题。

### packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx

补上 UI 层防御，但不把它当主修复。

必须做：

1. 读取 `keyspace.service`。
2. 订阅 `keyspace.onInitializationChange()` 和 `keyspace.onActiveChange()`。
3. 初始化中或非 single active key 时，不调用 `service.getAssetBalance()`。
4. `load()` 内部捕获错误，避免未处理 Promise。
5. `refreshAll()` 在 keyspace 未就绪时直接返回或显示空状态，不触发 recent sync。
6. 组件卸载后不能 `setState`。

推荐展示语义：

```txt
初始化中 -> 金额显示 "—"，状态显示 initializing 或保留当前 syncStatus。
无 active key -> 金额显示 "—"，刷新按钮 disabled。
读取失败 -> 金额保持 "—"，状态进入 stale/failed 提示。
```

不要在这里把 `Key storage is not ready` 转换成 0 余额。0 余额是链上业务数据，未就绪是本地状态，两者不能混。

### packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx

补防御，避免用户直接进入 `/p2pkh` 时触发同类未处理 Promise。

必须做：

1. 读取 `keyspace.service` 或通过已有事件得知 active key 状态。
2. keyspace 初始化中或非 single active key 时，不调用：

```txt
service.listResources()
service.listBackfillStates()
service.listRecentSyncStates()
service.getAssetBalance()
```

3. 所有 Promise 读取需要 catch，失败时显示空态或错误态，不打未处理 Promise。

页面文案可以继续使用中文，例如：

```txt
Key 正在初始化
请选择一个 active key
```

代码错误信息仍用英文。

### packages/plugin-p2pkh/src/p2pkhAssetProvider.ts

资产 provider 需要对 keyspace 未就绪做只读空结果防御。

必须做：

1. `listAssets()` 在 keyspace 初始化中或非 single active key 时返回 P2PKH 资产摘要的空余额，或返回空列表。二选一后保持一致。
2. `getAsset(assetId)` 在未就绪时不要调用 `service.getAssetBalance()` / `listHistory()`。
3. `onChange` 继续订阅 P2PKH sync 和 active key 变化；建议额外订阅 keyspace 初始化变化，初始化结束后通知资产平台重拉。

推荐策略：

```txt
未就绪返回空列表。
```

缘由：资产行展示 0 余额会误导用户，以为空链上余额已经确认。

### packages/plugin-p2pkh/src/p2pkhTransferProvider.ts

检查并补防御。

必须保证：

```txt
keyspace 初始化中 -> 不给转账 offer
非 single active key -> 不给签名 / 广播入口
```

不能把 all-keys 模式当作可转账上下文。

### packages/plugin-woc/src/wocService.ts

新增 WOC 读取型 404 空结果处理。

推荐实现：

```txt
增加一个内部 helper：
  isWocNotFoundEmptyResult(path, init)

只对这些 GET endpoint 返回空结果：
  /address/<address>/confirmed/unspent
  /address/<address>/unconfirmed/unspent
  /address/<address>/confirmed/history
  /address/<address>/unconfirmed/history
```

更稳妥的实现方式是不要在泛型 `fetchJson<T>()` 里盲目返回 `{ result: [] }`，而是在具体 endpoint 里捕获：

```txt
getAddressConfirmedUtxos()
getAddressUnconfirmedUtxos()
listAddressConfirmedHistory()
listAddressUnconfirmedHistory()
```

遇到 `WOC 404` 时返回：

```txt
UTXO -> []
confirmed history -> { items: [], nextPageToken: undefined }
unconfirmed history -> { items: [] }
```

设计缘由：

```txt
fetchJson 是通用 HTTP 层，不应该知道每个 endpoint 的空结果结构。
endpoint 层最清楚空结果应该映射成什么类型。
```

如果当前 `fetchJson()` 只抛 `Error("WOC 404 Not Found")`，可以增加内部谓词：

```txt
function isWocStatusError(err: unknown, status: number): boolean
```

不要把 404 应用于：

```txt
broadcast()
tx raw / tx detail
exchange rate
settings/config
未来的非列表型 endpoint
```

### packages/plugin-woc/src/wocService.test.ts

补 404 空结果单测。

必须覆盖：

```txt
confirmed/unspent 404 -> []
unconfirmed/unspent 404 -> []
confirmed/history 404 -> { items: [], nextPageToken: undefined }
unconfirmed/history 404 -> { items: [] }
```

必须同时覆盖：

```txt
500 仍然 reject
429 仍然触发 backoff 并 reject
```

不要只测批量方法 `getAddressesConfirmedUtxos()`，因为批量方法当前 `Promise.allSettled()` 会吞掉单地址错误，无法证明单地址 endpoint 的语义正确。

### packages/plugin-p2pkh/src/p2pkhRecentSync.ts

原则上不需要改业务算法。

只检查：

```txt
当 WOC endpoint 返回空 UTXO / 空 history 时，recent sync 能写入 0 余额、空 UTXO、空 history，并将 sync 状态视为成功。
```

如果这里对空 history 有“必须有 result”之类假设，删除该假设。

### packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts

原则上不需要改业务算法。

只检查：

```txt
confirmed history 404 -> 空第一页 -> backfill 完成或保持 idle/ok
```

不能把空历史当成 failed backfill。

### packages/contracts/src/vault.ts

只改注释，不改类型。

需要把 `VaultStatus = "unlocked"` 的语义补清楚：

```txt
unlocked 表示 Vault 会话和 keyspace ready 边界都已完成，业务插件可以安全读取 key-scoped storage。
```

如果不需要改注释，也可以不动此文件。

### packages/contracts/src/keyspace.ts

原则上不改接口。

确认现有接口已经满足本次施工：

```txt
isInitializing(): boolean
onInitializationChange(handler): () => void
active(): ActiveKeyState
onActiveChange(handler): () => void
```

如果调用方需要这些类型，优先从现有 contract import，不新增重复类型。

## 特殊情况处理

### Vault 中没有任何 key

`keyspace.onVaultUnlocked()` 应将 active key 置为 `{ mode: "all" }` 或无 single active key 的状态。

业务插件处理：

```txt
P2PKH widget -> 显示 "—"，刷新禁用。
P2PKH 页面 -> 显示导入 key 的空态。
AssetProvider -> 返回空列表或不展示 P2PKH 资产。
TransferProvider -> 不提供转账 offer。
```

不能把“无 key”当成错误反复 console.error。

### 某些 key identity backfill 失败

单把 key 失败不能阻止 Vault 解锁。

处理方式：

```txt
失败 key 标记 identityStatus = "failed"
VaultSettingsPage 展示失败原因并允许删除 / 导出
keyspace 只从 ready key 中选择 active key
P2PKH 不为 failed key 打开 namespace
```

如果所有 key 都失败，表现等同“没有可用 active key”，不是 P2PKH 同步失败。

### 用户在初始化结束前点击刷新

刷新按钮应 disabled，或者点击后直接 no-op。

不能触发 background recent sync，也不能弹出英文错误。

### 用户处于 all-keys 模式

P2PKH 转账必须不可用。

P2PKH 余额 widget 不能读取 single namespace。

如果未来要支持 all-keys 聚合，需要另开施工单明确聚合 DB 枚举策略；本次不顺手实现。

### WOC 404 的地址确实是错误地址

对 UTXO / history 列表型 endpoint，404 仍按空结果处理。

理由：

```txt
地址合法性应该在地址派生 / 输入校验阶段保证。
同步层面对已派生地址看到 404，按“无链上记录”处理更符合钱包体验。
```

如果未来开放用户手输任意地址查询，应在查询入口单独做地址格式校验，不在 WOC service 里改变列表型 404 语义。

### WOC 429 或 5xx

保持失败。

处理方式：

```txt
429 -> 保留现有 backoff
5xx / timeout / network error -> sync failed 或 stale
```

不能为了消除控制台噪声把这些错误也吞成空列表。

### React StrictMode 双 effect

组件的 `load()` 必须具备取消标记。

要求：

```txt
组件卸载后不 setState
重复挂载不会产生未处理 Promise
重复加载不会把旧 active key 的结果写到新 active key UI
```

如果 active key 在请求期间切换，旧请求结果必须丢弃。

## 最终验收清单

### 自动化命令

必须通过：

```txt
npm run typecheck
npm run test -- -t "WocService"
npm run test -- -t "Vault"
npm run test -- -t "P2PKH"
npm run build
```

如果 `-t` 过滤名称与现有测试名不匹配，可以改跑：

```txt
npm run test
```

但最终记录里必须说明实际执行过哪些命令。

### 浏览器手工验收

启动：

```txt
npm run dev -- --host 127.0.0.1
```

访问：

```txt
http://127.0.0.1:5173/
```

验收项：

1. locked 状态下页面正常显示解锁入口。
2. 输入正确密码后，不出现黑屏。
3. 解锁完成进入首页后，控制台不再出现未处理的 `Key storage is not ready`。
4. 顶栏 key switch 在 identity backfill 期间显示初始化态；完成后显示 active key 或无 key。
5. 首页 P2PKH 余额 widget 在无 key / 初始化中 / all-keys 模式下不触发余额读取错误。
6. 点击 P2PKH widget 刷新，在 keyspace 未就绪时不触发后台同步。
7. 有 active key 时，P2PKH main/test 余额可正常显示；空余额显示为 0 余额只能来自成功同步后的链上结果，不来自未就绪兜底。
8. 访问 `/p2pkh`，无 active key 时显示空态，不打未处理 Promise。
9. WOC 对日志中地址的 confirmed unspent/history 返回 404 时，同步流程按空 UTXO / 空历史完成，不把 P2PKH sync 标记为 failed。
10. WOC 429 仍进入 backoff；5xx 仍显示 stale/failed，不被吞成空结果。

### 代码审查验收

必须确认：

1. `vault.unlocked` 事件发出点在 keyspace ready 之后。
2. `VaultStatus` 的注释语义与实际顺序一致。
3. `p2pkhService.ensureDb()` 仍然 fail closed。
4. P2PKH 后台任务 `canRun` 包含 `!keyspace.isInitializing()`。
5. P2PKH React 组件没有裸 `void asyncFn()` 触发未处理 Promise；内部必须 catch 或由统一 loader 处理。
6. WOC 404 空结果只落在地址 UTXO / history 列表型 endpoint。
7. 没有新增 setTimeout 轮询、魔法延迟或清库逻辑。
8. 没有引入新的全局 DB 作为 P2PKH fallback。
9. 中文注释说明关键业务逻辑设计缘由；错误信息保持英文。

## 完成定义

本施工单完成的标准不是“控制台暂时没有红字”，而是：

```txt
Vault unlocked 的语义被收紧为业务可用边界；
P2PKH 不再在 keyspace 初始化期抢跑；
WOC 空链上记录不再污染同步失败状态；
真实网络失败仍然按失败处理。
```
