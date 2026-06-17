# 001 P2PKH UTXO 真值、余额实时计算与 Testnet 开关硬切换施工单

## 目标

一次性把当前 P2PKH 钱包模型硬切换为下面这套单真值设计：

```txt
链上真值
  = WOC 当前返回的未花费 UTXO 集合

余额
  = 每次读取时，对当前本地 UTXO 快照实时求和
  = 不再单独落库

confirmed / unconfirmed
  = 不再作为余额或选币策略
  = 只允许作为可选诊断信息存在，不能影响业务结论

转账输入集合
  = 当前未花费 UTXO
  - 本地 reservation 已占用的 outpoint

P2PKH 设置
  = 新增“是否包含 testnet 货币”
  = 缺省 false
```

本次是硬切换，不接受“先保留余额表兼容一版”“先保留 allowUnconfirmed 开关以后再删”“先继续同步 testnet 只是先隐藏 UI”“先用 confirmed + unconfirmed 余额过渡”这类中间态。

## 简述缘由

1. 当前 `p2pkh_balances` 是冗余缓存。余额既然可以由 UTXO 快照直接求和，就不应该再维护第二份数值真值。
2. 余额实时性要求高。只要把余额落库，就会天然引入“缓存时间”和“缓存失效”问题，最后又要解释为什么 UI 数字和当前 UTXO 不一致。
3. 当前实现里，UTXO 页已经承认部分 `unconfirmed` UTXO 可花费，但余额、资产摘要、转账入口仍按 `confirmed` 显示，属于同一批数据多套口径并存。
4. 对本项目的 P2PKH 钱包语义来说，`confirmed / unconfirmed` 不是余额真值，而是同步观察维度。把它们继续放进余额模型，只会继续污染业务边界。
5. `allowUnconfirmed` 是伪策略开关。既然产品决定“只要还在 WOC 未花费集合里就可参与转账”，那这个开关就没有存在意义。
6. testnet 不应该默认占据正式钱包的资产、余额和转账入口。它应由显式设置开启，缺省关闭。
7. 如果这次只改 UI 不改底层，`p2pkh_balances`、`allowUnconfirmed`、`balance endpoint` 和旧测试真值很快会在别处复活。

## 硬切换结论

本次统一采用下面这套最终模型：

```txt
P2PKH 余额
  不是表
  不是持久化实体
  只是 service 基于当前 UTXO 快照的实时计算结果

P2pkhBalance
  = { total: number }

WOC balance endpoint
  不再请求

p2pkh_balances
  删除

allowUnconfirmed
  删除

testnet
  是否纳入资产/转账/UI/后台同步范围
  由 P2PKH 设置 includeTestnet 控制
  默认 false
```

必须满足下面的不变量：

1. WOC 当前返回的未花费 UTXO 集合，是余额与可选输入的唯一链上真值。
2. 本地 DB 不再存储余额行，也不再把 `confirmed / unconfirmed / spendable` 作为余额字段持久化。
3. `getAssetBalance()` 与 `getResourceBalance()` 每次都必须基于当前 DB 中的 UTXO 现算，不能读取任何余额缓存。
4. recent-sync 必须按最新 WOC UTXO 结果替换本地 resource UTXO 快照。WOC 已经看不到的 UTXO，本地必须删除。
5. `reservation` 只影响“本地还能不能再次选这个 outpoint”，不能伪装成余额真值。
6. `allowUnconfirmed` 不再存在于设置、转账表单、service、allocator、测试、文案中。
7. `includeTestnet=false` 时，testnet 不得出现在资产摘要、余额 widget、转账入口、P2PKH 页面切换按钮和后台同步范围里。

## 最终 DB 结构

DB 名称保持不变：

```txt
keymaster.key.<publicKeyHash>.plugin.p2pkh.state
```

版本升级为：

```txt
v5
```

最终只保留下面这些 store：

```txt
p2pkh_addresses
p2pkh_utxos
p2pkh_history
p2pkh_history_backfill
p2pkh_recent_sync
p2pkh_pending_transfers
p2pkh_utxo_reservations
```

必须删除：

```txt
p2pkh_balances
```

### 各表作用

`p2pkh_addresses`
- 记录当前 active key 在各网络下派生出的 P2PKH 资源。
- 它回答的是“这个 key 在 main/test 上对应哪个地址”。
- 不存余额，不参与金额真值。

`p2pkh_utxos`
- 记录当前从 WOC 同步到的未花费输出快照。
- 这是余额实时计算的唯一直接来源。
- recent-sync 每次都必须用 WOC 最新结果替换对应 resource 的旧快照。

`p2pkh_history`
- 记录这个地址观察到的交易历史。
- 用于历史页面展示、pending 对账、同步观察与排障。
- 不用于余额计算。

`p2pkh_history_backfill`
- 记录完整历史回填任务做到哪里。
- 它是后台任务进度表，不是业务真值表。

`p2pkh_recent_sync`
- 记录最近同步水位、最近检查时间、最近成功时间。
- 它是同步控制表，不是余额表。

`p2pkh_pending_transfers`
- 记录本地发起过、但链上结果尚未完全收敛的转账。
- 它追踪的是“一笔交易”。

`p2pkh_utxo_reservations`
- 记录哪些输入 outpoint 已被本地某笔交易临时占用。
- 它锁住的是“几个 UTXO”。

## 不能怎么做

1. 不能保留 `p2pkh_balances` 作为“过渡缓存”，然后新旧两套余额并存。
2. 不能把 `confirmed + unconfirmed` 当成新的余额口径继续落库。你只是在给旧错误换名字。
3. 不能让 `getAssetBalance()` 继续读 `db.listBalances()`，哪怕只作为 fallback 也不行。
4. 不能保留 WOC balance endpoint 请求，再把结果和 UTXO 求和做双重校验。余额真值只能有一个来源。
5. 不能保留 `allowUnconfirmed` 的设置、localStorage、UI 控件、service 参数或 allocator 分支，哪怕默认值改成 `true` 也不行。
6. 不能把 `reservation` 金额折算进 `P2pkhBalance` 返回值，制造新的 `available/spendable` 变体。余额只保留 `total`。
7. 不能把 “是否包含 testnet” 存进 key-scoped P2PKH DB。它是产品级显示与同步范围配置，不是某一把 key 的链上状态。
8. 不能在 `includeTestnet=false` 时只是隐藏几个按钮，但后台仍然继续同步 testnet。那只是把成本藏起来。
9. 不能把 `confirmed / unconfirmed` 当作选币优先级、转账能力或业务禁用条件复活。
10. 不能因为有 testnet 缓存残留，就在 UI 中继续展示 testnet 资产。

## 应该怎么做

### 一、收缩契约：余额只保留实时计算结果

在 [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1) 做下面这些收缩：

1. `P2pkhBalance` 改为：

```ts
export interface P2pkhBalance {
  total: number;
}
```

2. 删除 `P2pkhRecentCommit.balance`。
3. 删除 `P2pkhTransferInput.allowUnconfirmed`。
4. 删除 `UtxoAllocationRequest.allowUnconfirmed`。
5. 新增全局 P2PKH 设置类型：

```ts
export interface P2pkhGlobalSettings {
  includeTestnet: boolean;
}
```

### 二、删除余额表，DB 升级到 v5

在 [packages/plugin-p2pkh/src/p2pkhDb.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.ts:1)：

1. 把 DB version 从 `4` 升到 `5`。
2. schema upgrade 时删除 `p2pkh_balances`。
3. 删除 `P2pkhBalanceRow` 类型。
4. 删除：
   - `putBalance()`
   - `listBalances()`
   - `getBalanceRow()`
   - `clearBalance()`
5. `commitRecentSnapshot()` 删除 balance 写入逻辑。
6. legacy migration 不再迁移 balance 数据。
7. 任何清理 resource 的逻辑都不再处理 balance store。

### 三、recent-sync 不再请求 WOC balance endpoint

在 [packages/plugin-p2pkh/src/p2pkhRecentSync.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhRecentSync.ts:1)：

1. 删除：
   - `getAddressConfirmedBalance()`
   - `getAddressUnconfirmedBalance()`
2. `Promise.all()` 只保留：
   - confirmed UTXO
   - unconfirmed UTXO
   - confirmed history
   - unconfirmed history
3. `commit` 中不再携带 `balance` 字段。
4. resource 的 UTXO 真值来自：

```txt
confirmed UTXO
+ unconfirmed UTXO（按 outpoint 去重）
= 当前完整未花费快照
```

### 四、service 每次实时计算余额

在 [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)：

1. `getAssetBalance(assetId)` 改为：
   - `listUtxos()`
   - 按 network + activePublicKeyHash 过滤
   - 对 `value` 求和
   - 返回 `{ total }`
2. `getResourceBalance(resourceId)` 改为：
   - 从 `listUtxos()` 或按 resource 过滤现算
   - 返回 `{ total }`
3. 不允许引入“为了性能保留最近一次余额”的内存缓存。余额实时性优先于这点微小开销。
4. “最近同步时间”仍由 `p2pkh_recent_sync` 提供，不塞回余额结构。

### 五、固定选币策略：所有未花费且未 reserved 的 UTXO 都可选

在 [packages/plugin-p2pkh/src/utxoAllocator.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.ts:1)：

1. 删除 `allowUnconfirmed` 过滤分支。
2. allocator 不再关心 `confirmed/unconfirmed`。
3. allocator 只接收 service 已经排除 `reserved` 的候选集合。
4. 失败原因收敛为：
   - `no-utxos`
   - `insufficient`
   - `policy-denied`

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)：

1. 删除向 allocator 传 `allowUnconfirmed` 的逻辑。
2. 候选集只做两件事：
   - 按 asset/network/resource 过滤
   - 按 `reservation.state === "reserved"` 排除

### 六、P2PKH 设置改为全局 `includeTestnet`

在 [packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx:1)：

1. 删除“允许未确认 UTXO”设置。
2. 新增“包含 testnet 货币”设置，缺省 `false`。
3. 存储位置继续使用全局 `localStorage`：

```txt
key = "p2pkh.settings"
value = { "includeTestnet": boolean }
```

这样做的原因：

1. 这是 P2PKH 插件的全局产品设置，不是某把 key 的链上状态。
2. 当前仓内没有现成的“插件业务设置通用存储契约”；强行塞进 key-scoped DB 会把产品配置和链上缓存混在一起。
3. 该设置需要在 active key 切换前后保持一致，因此不应进入 key namespace。

### 七、`includeTestnet` 控制暴露范围与后台同步范围

`includeTestnet=false` 时，必须满足：

1. 资产平台不列出 `bsvtest`。
2. 转账入口不列出 `bsvtest`。
3. 首页余额 widget 不显示 testnet 行。
4. `P2PKH Overview / History / UTXOs` 页面不显示 testnet 切换按钮。
5. `rehydrateResources()` 不再为 testnet 创建 address resource。
6. `recent-sync` 与 `history-backfill` 不再同步 testnet resource。

`includeTestnet=true` 时，恢复：

1. testnet asset / offer / widget / 页面按钮。
2. testnet address resource 创建。
3. testnet recent-sync / backfill。

这里采用的是真正硬切换语义：

```txt
includeTestnet 决定
  “testnet 是否属于当前 P2PKH 产品运行范围”
而不是
  “testnet 先继续跑，只是暂时不显示”
```

### 八、关闭 testnet 时的处理原则

当设置从 `true -> false`：

1. 立即停止 testnet 暴露。
2. 后续 recent-sync / backfill 不再处理 testnet resource。
3. 当前 DB 中已有的 testnet 行允许保留为 dormant cache，不作为显示与业务真值暴露。
4. 下次用户重新打开 `includeTestnet=true` 时：
   - 重新进入 testnet 运行范围
   - 触发 rehydrate + recent-sync
   - 由最新 WOC 结果覆盖旧缓存

这样设计的原因：

1. 这次设置切换的主语是“产品是否纳入 testnet”，不是“立即物理删除 testnet 历史档案”。
2. 立即清空 testnet history / pending / reservation 容易让本地观察链条中断。
3. 关闭暴露与同步范围，已经满足默认不包含 testnet 的产品要求；重新开启时再用 WOC 真值刷新即可。

### 九、UI 文案与页面语义同步收缩

在 [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1) 及相关页面中：

1. 删除所有 `allowUnconfirmed` 文案。
2. 删除“confirmed / unconfirmed balance”类余额描述。
3. balance widget、资产摘要、转账入口统一显示单一 `total`。
4. testnet 相关文案改成受 `includeTestnet` 控制，而不是默认恒存在。

## 文件级施工清单

### contracts / 类型

- [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1)
  - 删除 balance 三字段模型
  - 删除 `allowUnconfirmed`
  - 新增 `P2pkhGlobalSettings`
  - 收紧 recent commit / transfer input / allocation request

### DB / 迁移

- [packages/plugin-p2pkh/src/p2pkhDb.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.ts:1)
  - 升级到 v5
  - 删除 `p2pkh_balances`
  - 删除 balance 相关读写与迁移
  - 调整 `commitRecentSnapshot()`

- [packages/plugin-p2pkh/src/p2pkhDb.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.test.ts:1)
  - 删除 balance store 断言
  - 增加 v5 schema 与无 balance 提交断言

### recent-sync / backfill / service

- [packages/plugin-p2pkh/src/p2pkhRecentSync.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhRecentSync.ts:1)
  - 删掉 balance endpoint 请求
  - 只提交 UTXO / history / reservation / pending

- [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)
  - `getAssetBalance()` 改成 UTXO 现算
  - `getResourceBalance()` 改成 UTXO 现算
  - `rehydrateResources()` 受 `includeTestnet` 控制
  - `listAllResources()` / task 资源范围受 `includeTestnet` 控制

- [packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts:1)
  - 通过上层资源过滤自然排除 testnet

### 选币 / 转账

- [packages/plugin-p2pkh/src/utxoAllocator.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.ts:1)
  - 删除 `allowUnconfirmed` 分支

- [packages/plugin-p2pkh/src/utxoAllocator.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.test.ts:1)
  - 删除“默认只选 confirmed”的旧测试
  - 改成“所有未 reserved UTXO 都可参与”

- [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)
  - 删除 `allowUnconfirmed` 透传

- [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
  - 删除 `allowUnconfirmed` 表单项
  - 删除对应 localStorage 读取

- [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1)
  - offer 列表受 `includeTestnet` 控制
  - 余额展示改为 `total`

### 资产 / 页面 / 设置

- [packages/plugin-p2pkh/src/p2pkhAssetProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhAssetProvider.ts:1)
  - assets 列表受 `includeTestnet` 控制
  - balance 展示改为 `total`

- [packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx:1)
  - 金额来源改为 `total`
  - testnet 行受 `includeTestnet` 控制

- [packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx:1)
  - summary 只显示 `total`
  - testnet 切换按钮受 `includeTestnet` 控制

- [packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx:1)
  - testnet 切换按钮受 `includeTestnet` 控制

- [packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx:1)
  - testnet 切换按钮受 `includeTestnet` 控制
  - 若保留 WOC 状态列，只作为观察信息

- [packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx:1)
  - 设置项从 `allowUnconfirmed` 改为 `includeTestnet`

- [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)
  - i18n 文案重写
  - 设置页描述更新

### 相关测试

- [packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts:1)
  - 删除依赖 balance commit 的断言

- [packages/plugin-p2pkh/src/p2pkhAssetProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhAssetProvider.ts:1)
  - 如有测试，补 `includeTestnet=false` 时只暴露 main

- [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1)
  - 如有测试，补 `includeTestnet=false` 时只暴露 main

## 特殊情况提前约定

### 情况 1：WOC 这次返回的 UTXO 比本地少

处理原则：

```txt
以 WOC 为准
本地多出来的必须删除
```

应该这样做：

1. recent-sync 用最新 UTXO 集合替换 resource 旧快照。
2. 不允许因为“可能只是 unconfirmed”而把旧 UTXO 暂留。
3. 这正是“区块竞争失败 / 交易未落下”的真实业务含义。

### 情况 2：WOC 暂时失败，recent-sync 没拿到新结果

处理原则：

```txt
不写新快照
保留旧快照
把状态标 stale/failed
```

应该这样做：

1. 失败时不改写 UTXO store。
2. UI 可以提示数据可能陈旧。
3. 但不能造出一张 balance 缓存表来“修复”这个问题。

### 情况 3：关闭 testnet 时，DB 里仍有旧 testnet 缓存

处理原则：

```txt
不暴露
不同步
允许保留 dormant cache
```

应该这样做：

1. 关闭后立即从 UI、provider、后台同步范围中排除 testnet。
2. 不要求同步时立刻清空旧 testnet 缓存。
3. 重新开启时再由 WOC 真值刷新。

### 情况 4：开启 testnet 后第一次进入页面

处理原则：

```txt
先纳入运行范围
再 rehydrate + recent-sync
```

应该这样做：

1. 创建 testnet address resource（若不存在）。
2. 触发 recent-sync。
3. 在第一次同步前允许显示“暂无 UTXO / 未同步”，但不能显示旧的 main 余额代替 testnet。

### 情况 5：余额读取频繁

处理原则：

```txt
仍然实时算
不回退到余额缓存
```

应该这样做：

1. 从 UTXO 快照现场求和。
2. 如果后续证明性能真有问题，只能优化读取路径或索引，不能恢复余额表。

## 最终验收清单

- [ ] IndexedDB schema 已升级到 v5，`p2pkh_balances` 不再存在。
- [ ] 代码中不存在 `P2pkhBalance.confirmed / unconfirmed / spendable`。
- [ ] 代码中不存在 `allowUnconfirmed` 类型、设置、文案、表单项、service 参数和 allocator 分支。
- [ ] `p2pkhRecentSync` 不再请求 WOC balance endpoint。
- [ ] `getAssetBalance()` 每次都从当前 UTXO 快照现算，并只返回 `{ total }`。
- [ ] `getResourceBalance()` 每次都从当前 UTXO 快照现算，并只返回 `{ total }`。
- [ ] 首页余额 widget、资产摘要、转账入口余额全部显示 `total`，不再显示 confirmed/unconfirmed 余额口径。
- [ ] UTXO allocator 不再区分 confirmed / unconfirmed，只排除 reserved outpoint。
- [ ] WOC 本次已看不到的旧 UTXO，会在 recent-sync 后从本地被删除。
- [ ] P2PKH 设置页已改为 `includeTestnet`，默认值为 `false`。
- [ ] `includeTestnet=false` 时，不显示 testnet 资产、余额行、转账入口和页面切换按钮。
- [ ] `includeTestnet=false` 时，后台 recent-sync / backfill 不再处理 testnet resource。
- [ ] `includeTestnet=true` 后，testnet 重新进入 address rehydrate、recent-sync、资产与转账暴露范围。
- [ ] 相关测试已删除旧 balance/store/allowUnconfirmed 真值，并覆盖 realtime balance 与 testnet toggle 新语义。

