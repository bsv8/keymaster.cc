# 002 统一资产后台同步、DB 快照与可配置频率硬切换一次性迭代施工单

## 参考、优先级与硬切范围

本单以以下现状代码为施工基线：

- `packages/contracts/src/assets.ts`
- `packages/contracts/src/tokens.ts`
- `packages/contracts/src/background.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/plugin-background/src/backgroundService.ts`
- `packages/plugin-background/src/BackgroundTray.tsx`
- `packages/plugin-assets/src/AssetsPage.tsx`
- `packages/plugin-assets/src/AssetsHomeWidget.tsx`
- `packages/plugin-assets/src/AssetDetailPage.tsx`
- `packages/plugin-assets/src/holdingsFlow.ts`
- `packages/plugin-p2pkh/src/p2pkhService.ts`
- `packages/plugin-p2pkh/src/p2pkhDb.ts`
- `packages/plugin-p2pkh/src/p2pkhAssetProvider.ts`
- `packages/plugin-p2pkh/src/p2pkhTransferProvider.ts`
- `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`
- `packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx`
- `packages/plugin-token-bsv21/src/**`
- `packages/plugin-token-stas/src/**`
- `packages/plugin-woc/src/wocActor.ts`
- `packages/plugin-woc/src/wocBsv21Service.ts`
- `packages/plugin-woc/src/wocStasService.ts`
- `packages/plugin-woc/src/pages/WocSettingsPage.tsx`

发生冲突时，按以下优先级执行：

1. 本单关于“页面零网络、后台任务唯一同步入口、provider DB 快照唯一数据源”的定义优先。
2. 本单是一次性**硬切换**；不保留页面同步、页面网络读取、`sync()` 兼容入口或一分钟轮询的双轨路径。
3. 金额 / 余额不是平台层第二份持久化真值；它只能从各 provider 自己已提交的持仓快照派生。
4. 所有定时、合并、冷却、失败退避和跨标签页 leader 协调只能由 `plugin-background` / WOC 队列承担；业务插件与页面不得自行创建 interval、timeout 轮询或网络队列。

本单覆盖 coin、fungible token 及后续同类资产 provider；collectible 若未来有持仓读取，也必须遵循同一边界。本单不改变 WOC 协议 URL、P2PKH 交易构造/签名语义、历史记录字段或 WOC 每秒请求数设置的含义。

---

## 1. 简述缘由

当前系统已经部分把 P2PKH recent sync 放进后台任务，但整体资产链路仍是分裂的：

- `p2pkh.recent-sync` 固定每 60 秒执行一次，频率过高；
- P2PKH 总览、UTXO、历史、首页余额卡仍放有同步/刷新入口；
- `/assets` 与首页资产 widget 的“刷新”入口仍由页面拥有；
- BSV-21 与 STAS 的 `listTokens()` 直接访问 WOC；进入 `/assets` 时，`loadAllHoldings()` 等待所有 provider 完成，任一慢网络请求都会使整个页面长期停在 loading；
- BSV-21 对每个地址先列 token、再对每个 token 串行取余额，页面等待会随 token 数增长；
- 页面目前大量借助“同步状态从 syncing 变为完成”猜测何时 reload，不能准确表达“哪个 DB 事务已提交”。

这使页面既是展示层又是同步入口，造成频繁请求、慢页面、跨标签页数据不一致及状态竞态。

本单将系统硬切为：

```text
后台任务（唯一网络同步入口）
  -> provider 原子提交本地持仓快照
  -> 发布不含金额的 data-changed 通知
  -> 页面 / widget / transfer picker 只读 DB 并重渲染
```

结果是：进入任何资产相关页面不会发网络请求、不会启动同步；余额频率有一个全局、可配置且较长的默认值；唯一手动运行位置是后台任务托盘。

---

## 2. 最终真值、职责与数据模型

### 2.1 三层职责

```text
BackgroundService
  调度、周期、leader、合并、冷却、退避、托盘“立即运行”
        |
        v
Asset provider sync task
  唯一 WOC / 外网调用者；写自己的 key-scoped snapshot DB
        |
        v
Asset / Token provider read API
  只读自己的 snapshot DB；向页面返回 summary/detail/activity
```

页面层（`/assets`、首页 widget、详情、P2PKH 总览/UTXO/历史、转账资产选择器）只属于第三层。页面不得拥有同步语义。

### 2.2 每种资产的唯一数据源

| 资产 | 持仓快照真值 | 余额派生规则 | 远端读取者 |
|---|---|---|---|
| P2PKH | 当前 key namespace 的 UTXO / recent-sync / 本地 claim 与 submission 数据 | 当前网络 UTXO `value` 求和；不另存 balance 表 | `p2pkh.recent-sync` |
| BSV-21 | 当前 key namespace 的 BSV-21 token snapshot（origin、网络、地址、余额、元数据、同步时间） | 同一 origin 按定义聚合已提交 snapshot | `token-bsv21.sync` |
| STAS | 当前 key namespace 的 STAS token snapshot（symbol / issuer / 网络 / 地址 / 余额、同步时间） | 同一 token 标识按定义聚合已提交 snapshot | `token-stas.sync` |

不得新建“assets total balances”全局表，也不得由资产聚合页把 provider 返回值再落一份库。全局表会变成第二份余额真值，无法与 provider 的 UTXO / token snapshot 原子一致。

### 2.3 余额、可花费额与新鲜度必须分开

- `balance`：已提交链上持仓快照按 provider 规则派生的金额；零是合法链上结果。
- `spendable`：P2PKH 在 UTXO + 本地 input claim 叠加后的可选输入语义；不能用“余额”字段偷换。
- `freshness/status`：`never-synced`、`syncing`、`ready`、`stale`、`failed`；它不是金额。
- `lastSuccessAt`、`lastAttemptAt`、`lastError`：同步元数据；失败必须保留最后一次成功快照。

没有首个快照时，页面显示“尚未同步”或空金额 `—`，绝不能显示 `0`；同步失败时显示陈旧数据和状态，绝不能清空为 `0`。

### 2.4 本地转账写入不是同步

转账广播后的 local submission / input claim 是本地业务事务，不是网络同步。它可以立刻写入并发 data-changed，使 UTXO 页的可花费状态、历史 pending 状态即时更新；之后是否进行链上对账，仍由后台任务按本单第 5 节的策略决定。

---

## 3. 页面零网络硬边界

完成后，下列调用链必须始终成立：

```text
React 页面 / Widget / Provider listAssets/listTokens/getAsset/getToken/listActivity
  -> provider/service read API
  -> IndexedDB / key-scoped DB
  -> 返回最近提交的 snapshot
```

以下生产调用链必须不存在：

```text
React 页面 / Widget
  -> WocService / WocBsv21Service / WocStasService

AssetProvider.listAssets / TokenProvider.listTokens / getAsset / getToken
  -> WocService / fetch / messageBus.request("woc.*")

页面 mount / useEffect / Button onClick
  -> backgroundService.trigger(...) / p2pkhService.triggerRecentSync(...) /
     p2pkhService.triggerHistoryBackfill(...)
```

`p2pkhPlugin.setup()` 的本地 `rehydrate()` 可以保留：它只补当前 key 的本地资源/address，不得访问 WOC；真正链上读取仍须由后台任务完成。

### 3.1 删除而非隐藏的旧入口

必须一次性删除：

- `AssetProvider.sync()` 与 `TokenProvider.sync()` contract 方法、全部实现和全部调用点；provider 的 read API 不再带“顺便同步”的能力。
- `P2pkhService.triggerRecentSync()`、`triggerHistoryBackfill()`、`pauseHistoryBackfill()`、`resumeHistoryBackfill()` 等被业务页面调用的手工任务 facade；页面不能再通过 P2PKH service 控制后台任务。
- `/assets`、`AssetsHomeWidget`、`P2pkhBalanceWidget`、P2PKH 总览、UTXO、历史页上的刷新/同步/回填按钮与 i18n/CSS/test 残留。
- BSV-21 的 1 秒内存网络 cache；它不是 snapshot，不能作为“页面读缓存”兼容层。
- STAS / BSV-21 provider 内从 `listTokens()` / `getToken()` 发起的所有 WOC 调用。

禁止把旧按钮改名为“重新读取”“快速检查”后继续触发网络；页面允许因 data-changed 事件**重读 DB**，但不提供任何手工网络入口。

---

## 4. 统一后台任务与调度配置

### 4.1 资产同步组

扩展后台任务 contract，使 task 能声明一个通用 schedule group。新增的表达应等价于：

```ts
schedule: {
  group: "asset-holdings",
  defaultIntervalMs: 15 * 60_000,
  minIntervalMs: 5 * 60_000
}
```

具体字段名可以按现有 contract 风格确定，但不得让业务插件以 `setInterval`、闭包读取 localStorage 或自定义 timer 绕过 BackgroundService。BackgroundService 必须在运行时解析 effective interval，并以它计算 `nextRunAt` 和周期到期。

归入 `asset-holdings` 的任务：

```text
p2pkh.recent-sync
token-bsv21.sync
token-stas.sync
未来所有“刷新资产持仓快照”的 provider task
```

`p2pkh.history-backfill` 不是余额轮询任务：不归入此组，不因此获得周期；它仍是独立的、可暂停/继续/立即运行的后台任务。

### 4.2 设置唯一真值

新增后台平台全局设置，建议持久化键：

```text
background.sync.settings
```

其初始 schema：

```ts
{
  assetHoldingsIntervalMs: 900_000 // 15 minutes
}
```

设置属于后台任务平台，而不是 P2PKH 设置页或 WOC 设置页：

- 它影响 P2PKH、BSV-21、STAS 及未来所有资产 provider；放到某个业务插件会错误地让该业务插件拥有平台调度真值。
- 它不等于 WOC `requestsPerSecond`。后者限制请求速率，继续由 WOC 设置页拥有；前者决定多久发起一轮资产同步。

新增 `/settings/background`（或现有后台任务设置注册点）中的“资产余额同步频率”选择项：

| 选项 | 值 |
|---|---:|
| 5 分钟 | `300_000` |
| 15 分钟（缺省） | `900_000` |
| 30 分钟 | `1_800_000` |
| 1 小时 | `3_600_000` |

禁止任意秒数输入、禁止小于 5 分钟、禁止“永不同步”。用户可在后台托盘暂停特定任务，但暂停不是把其设置成零周期。

保存配置后：

1. leader 写入设置并通知 follower；
2. BackgroundService 重新计算同组任务 `nextRunAt`；
3. 新周期从保存时刻开始计时；
4. **不得**因为保存设置立即触发网络同步，避免改一个 select 造成任务突发。

现有 `background.enabled` 仅表达 task 是否暂停，不能承载 interval；必须保留其既有语义，并为 schedule settings 建立单独存储和变更通知。

### 4.3 唯一手动入口

BackgroundTray 为每个 idle / queued / paused（恢复后）任务提供通用“立即运行”操作，调用 BackgroundService 的通用 task API；不出现 P2PKH、BSV-21、STAS 专有按钮。

当前托盘只有取消、重试、暂停、继续；本单必须补齐“立即运行”，再删除所有业务页面的同步按钮。失败任务的“重试”保留，语义仍是立即运行该失败任务。

---

## 5. 自动触发、合并、冷却与异常策略

### 5.1 可以请求后台运行的领域事件

以下事件可以向 BackgroundService 发出**后台**运行请求，但它们不能从页面组件发出网络请求：

| 事件 | 策略 |
|---|---|
| 首次解锁且当前 key 没有该 provider snapshot | 立即排入对应资产任务 |
| 切换到新 key / 新导入 key | 立即排入该 key scope 的对应资产任务 |
| 开启 testnet，且 testnet snapshot 缺失 | 立即排入新纳入 scope 的任务 |
| 正常周期到期 | 按 `asset-holdings` 配置运行 |
| 转账广播成功 | 先本地落 submission/claim；对账任务标记 `syncDue` |
| 用户在后台托盘点击立即运行 | 立即排入，允许绕过普通冷却 |

### 5.2 防止频繁获取

BackgroundService 为资产同步组增加通用事件冷却策略：

- 普通领域事件的同一 task/key scope 最短网络间隔为 **2 分钟**；
- 冷却期内的请求只合并为一个 `syncDue`，不创建更多 WOC 请求；
- 正在运行时的请求沿用现有 rerun 合并语义，最多补跑一次；
- 首次没有 snapshot、显式后台“立即运行”、失败后用户“重试”可以绕过普通冷却；
- 周期频率为 15 分钟时，正常情况下同一 scope 不会因页面打开或重复事件频繁拉取。

不能为实现冷却在 P2PKH / token plugin 中各自写时间戳、timer 或 localStorage。冷却、rerun、leader 转发是 BackgroundService 的单一职责。

### 5.3 失败、取消、退避

- 单 provider / 单 resource 网络失败：保留旧 snapshot，task 标记 failed 或部分失败状态，页面显示 stale / failed，不清余额。
- BackgroundService 的 retry 由托盘触发；自动周期失败需要指数退避，退避上限不得短于配置周期，避免 WOC 故障时持续重试。
- WOC 既有全局请求速率、Web Lock / queue 协调继续生效；资产任务不得另建 fetch 并发池。
- Vault 锁定、key 删除、key scope 切换时，继续使用 `cancelByKey()` 等待旧任务退出；迟到结果必须因 generation / namespace 检查而被丢弃，不得重建已删除 namespace。
- token snapshot 提交也必须带 key scope / generation 等价保护；不能让旧 active key 请求返回后写进新 active key DB。

### 5.4 多标签页

Background leader 仍是唯一实际执行者。另建通用的资产数据变更广播，不把 data-changed 错误地等同于任务状态广播：

```text
任务成功提交 provider DB
  -> runtime asset data notifier 在本 tab emit
  -> BroadcastChannel 通知其它 tab：providerId + publicKeyHex + revision + kinds
  -> 收到的 tab 只重读自己的本地 DB
```

广播 payload 禁止携带余额、UTXO、token、地址、交易记录或错误详情；它只是失效通知。IndexedDB 本身没有跨标签页订阅能力，不能依赖“另一标签页已写库所以 React 会自动更新”的假设。

---

## 6. 提交后 onChange 与页面读取规则

### 6.1 新的 data-changed notifier

在 runtime / contracts 中新增通用 asset data notifier capability。它至少表达：

```ts
{
  providerId: string,
  publicKeyHex?: string,
  revision: number,
  kinds: Array<"resource" | "utxo" | "history" | "holding" | "claim" | "submission" | "settings">
}
```

要求：

1. 只能在 provider DB write transaction 成功 resolve 后发布；事务失败、被 abort、generation mismatch 时绝不发布。
2. 不要求 payload 携带金额；消费者收到后重新调用只读 API。
3. 同一轮 backfill 多页提交可以在 consumer 侧 microtask / 短 debounce 合并重读，但不能使用周期轮询。
4. `AssetProvider.onChange()` / `TokenProvider.onChange()` 保留为平台聚合页的无 payload 订阅接口；provider 收到自身 data-changed 后调用它。
5. P2PKH 专属页面订阅 P2PKH service 暴露的同一 data-changed 流，不能继续把 `syncing -> ok` 当作数据已提交信号。

任务状态与数据变更分离：

- `BackgroundService.onChange()`：托盘进度、next run、失败、暂停；
- provider data-changed：DB 已提交，页面应重读；
- 两者可以在一次同步中先后多次发生，彼此不能互相推导。

### 6.2 页面行为

`/assets`、首页资产 widget、资产详情页、转账 Offer picker 必须：

- 首次 mount 立即读所有 provider 的本地 snapshot；
- 每个 provider 独立完成，不再用一个全局 `Promise.all` 把整页锁在 loading；
- provider 无 snapshot 时仅该 provider 显示未同步 / 空态；其它 provider 必须立即显示；
- 收到 provider `onChange` 后重读其数据；
- 不订阅 WOC 队列、不调用 WOC、不触发后台 task。

P2PKH 总览、UTXO、历史和余额 widget 同样只读 DB，订阅 P2PKH data-changed。页面仍可订阅 task snapshot 以显示“同步中 / 陈旧 / 失败 / 上次成功时间”，但不因状态迁移发起数据 reload。

---

## 7. Token snapshot 的硬切换

### 7.1 BSV-21

新增 BSV-21 key-scoped snapshot storage 与 `token-bsv21.sync`：

1. 后台 task 从 P2PKH 本地 resource DB 读取当前 active key 地址；
2. task 通过 WOC 拉 token list / balance；网络请求只在此处出现；
3. 以一次 provider transaction 替换或按地址原子提交 BSV-21 snapshot 与同步元数据；
4. 成功后发 data-changed；
5. `listTokens()`、`getToken()`、`listActivity()` 只读该 snapshot。

第一版应保留当前“同 origin 合并时取何种语义”的业务规则，并把它在 DB 聚合层固定；不得在页面每次进入时重新请求远端决定金额。BSV-21 原有的一秒内存 cache 删除，不迁移。

### 7.2 STAS

新增 STAS key-scoped snapshot storage 与 `token-stas.sync`，规则同上。STAS 仅 main network 的现有范围保持不变；没有 main snapshot 时显示未同步，不因页面打开访问 WOC。

### 7.3 旧数据处理

BSV-21 / STAS 当前没有正式 token snapshot DB，因此无需迁移旧网络内存结果。硬切后首次后台同步前的状态统一是 `never-synced`。禁止在页面挂载时做“为了补旧数据先请求一次 WOC”的兼容分支。

---

## 8. 文件级施工清单

| 文件 | 必做修改 |
|---|---|
| `packages/contracts/src/background.ts` | 扩展 task schedule group / runtime schedule 配置 / 通用立即运行或等价 API；区分周期调度、领域请求、手动立即运行所需的契约。 |
| `packages/contracts/src/assets.ts` | 删除 `AssetProvider.sync()`；新增或导出通用 asset data notifier contract / capability。保留 `onChange()` 作为只读数据失效通知。 |
| `packages/contracts/src/tokens.ts` | 删除 `TokenProvider.sync()`；接入同一 data notifier 语义。 |
| `packages/runtime/src/createPluginHost.ts` 及相关 runtime 文件 | 提供 asset data notifier capability；实现本 tab pub/sub 与跨 tab BroadcastChannel 失效通知、dispose 清理。 |
| `packages/plugin-background/src/backgroundService.ts` | 实现 group schedule settings、有效周期解析、配置变更后重算 next run、资产事件 2 分钟冷却 / 合并、失败退避和 leader/follower 配置同步；不得改变现有 task 单实例与 cancel barrier 不变量。 |
| `packages/plugin-background/src/manifest.ts` | 注册后台同步设置页及 i18n。 |
| `packages/plugin-background/src/BackgroundTray.tsx` | 增加通用“立即运行”操作；保留取消/重试/暂停/继续；不添加任何 provider 专有操作。 |
| `packages/plugin-background/src/BackgroundSettingsPage.tsx`（新增） | 实现资产余额同步频率 preset 设置页，读写唯一 `background.sync.settings` 真值。 |
| `packages/plugin-assets/src/AssetsPage.tsx` | 删除刷新按钮；改为 provider 级只读加载与 `onChange` 重读，不能让慢/失败 provider 阻塞其它行。 |
| `packages/plugin-assets/src/AssetsHomeWidget.tsx` | 删除刷新按钮；按 provider 数据变更重读本地 snapshot。 |
| `packages/plugin-assets/src/AssetDetailPage.tsx` | 订阅目标 provider 的 `onChange`，data-changed 后重新读取详情；不访问网络。 |
| `packages/plugin-assets/src/holdingsFlow.ts` | 保持纯聚合；重构调用方或结果结构以支持 provider 独立 loading/error，禁止把它变成网络超时层。 |
| `packages/plugin-p2pkh/src/p2pkhContracts.ts` | 删除对页面暴露的手工同步 / 回填 facade；新增 P2PKH data-changed 只读订阅和必要同步元数据类型。 |
| `packages/plugin-p2pkh/src/p2pkhService.ts` | `p2pkh.recent-sync` 接入 `asset-holdings` group；删除 `60_000` 硬编码与页面手工 API；仅在 DB commit 或本地 submission/claim 成功后发布 data-changed；生命周期事件只向 BackgroundService 请求运行。 |
| `packages/plugin-p2pkh/src/p2pkhSyncCoordinator.ts` | 让 recent / backfill commit 成功后能精确触发 data-changed；不能在 build、请求开始或 finally 中误发。 |
| `packages/plugin-p2pkh/src/p2pkhDb.ts` | 保持余额不落表；确认 recent snapshot、backfill、submission/claim 写入的事务边界可作为 notifier 的唯一成功点。 |
| `packages/plugin-p2pkh/src/p2pkhAssetProvider.ts` | `listAssets/getAsset/listActivity` 保持纯 DB 读；删除 `sync()`；桥接 P2PKH data-changed 到 `onChange()`。 |
| `packages/plugin-p2pkh/src/p2pkhTransferProvider.ts` | 改为由 P2PKH data-changed 更新 Offer，不靠 sync status 伪刷新。 |
| `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx` | 删除触发同步/回填按钮和 `setVersion` 假刷新；订阅 data-changed 重读资源、余额、recent/backfill state。 |
| `packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx` | 删除刷新按钮；订阅 data-changed 重读 UTXO / claim。 |
| `packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx` | 删除重新回填按钮；订阅 data-changed 重读历史 / backfill state。 |
| `packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx` | 删除刷新全部；订阅 data-changed 重读余额，任务状态只负责状态文案。 |
| `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`、`manifest.ts` | 移除已经失效的“页面可触发同步”描述；保留 testnet scope 设置，但它只能请求后台任务。 |
| `packages/plugin-token-bsv21/src/bsv21Db.ts`（新增） | 实现 key-scoped BSV-21 snapshot / sync metadata 原子读写。 |
| `packages/plugin-token-bsv21/src/bsv21Sync.ts`（新增） | 实现仅由后台 task 调用的 WOC 拉取、原子提交、data-changed。 |
| `packages/plugin-token-bsv21/src/bsv21Service.ts` | 拆成只读 snapshot service 与仅 sync task 使用的远端 reader；禁止 read API 触网。 |
| `packages/plugin-token-bsv21/src/bsv21TokenProvider.ts` | 删除一秒网络 cache 与 `sync()`；list/detail 只读 DB；接 data-changed。 |
| `packages/plugin-token-bsv21/src/manifest.ts` | 注入 background / notifier / key-scoped storage，注册 `token-bsv21.sync`。 |
| `packages/plugin-token-stas/src/stasDb.ts`（新增） | 实现 key-scoped STAS snapshot / sync metadata 原子读写。 |
| `packages/plugin-token-stas/src/stasSync.ts`（新增） | 实现仅后台可用的 WOC 拉取、原子提交、data-changed。 |
| `packages/plugin-token-stas/src/stasService.ts` | 拆成只读 snapshot service 与 sync task reader；禁止页面读链路触网。 |
| `packages/plugin-token-stas/src/stasTokenProvider.ts` | 删除 `sync()`；list/detail 只读 DB；接 data-changed。 |
| `packages/plugin-token-stas/src/manifest.ts` | 注入 background / notifier / key-scoped storage，注册 `token-stas.sync`。 |
| `packages/plugin-woc/src/**` | 不增加页面调用入口；保留 actor、全局限速与错误/取消机制。必要时补测试以证明所有 token 网络请求只由 sync task 触发。 |
| 各受影响 `*.test.ts(x)` | 删除旧页面手工同步期望，新增本单第 9 节的行为测试。 |
| `apps/web/src/styles/global.css`、各 manifest i18n | 删除旧刷新/同步/回填文案与样式，补后台设置 / 托盘立即运行 / snapshot 状态文案。 |

---

## 9. 明确禁止项

完成后，生产代码中不得存在以下模式：

```ts
// 页面与 widget 发网络同步
service.triggerRecentSync()
service.triggerHistoryBackfill()
provider.sync()
backgroundService.trigger(...) // 位于 React 页面 / widget

// provider 读 API 发网络
async listAssets() { await woc... }
async listTokens() { await woc... }
async getAsset() { await woc... }
async getToken() { await woc... }

// 业务插件自己的周期器或“缓存刷新”周期器
setInterval(...)
setTimeout(...再拉余额...)

// 伪造同步完成后的数据刷新
onSyncStatusChange(() => reloadBecauseMaybeDbChanged())

// 余额双真值
assets_total_balances
cachedBalance // 作为持久或跨 provider 真值
```

也禁止以下替代方案：

1. 给 `/assets` 增加更高 WOC priority，使网络更快；这只是让页面继续承担同步。
2. 用 1 秒、5 秒的内存 cache 掩盖页面网络请求；刷新、切 key、跨标签页后仍会失效，且不是持久快照。
3. 在每个 token plugin 内自己放 interval；这会绕开 leader、统一频率、暂停和托盘。
4. 以 BackgroundService task snapshot 的 `completed` 时间充当数据变更事件；任务可能成功但没有数据变化，也可能一个 task 内有多次提交。
5. 让 data-changed 广播携带余额或 UTXO，以“少读一次 DB”；会泄露资产数据且引入消息快照与 DB 真值竞争。
6. 为了兼容旧入口，保留页面按钮但把它们改成调用后台 `trigger`；这仍违反“手动入口只在后台托盘”。

---

## 10. 最终验收清单

### 10.1 静态边界

- [ ] `AssetProvider`、`TokenProvider` 不再有 `sync()`。
- [ ] P2PKH service 不再向业务页面公开 recent sync / history backfill 手工触发方法。
- [ ] `/assets`、首页资产 widget、资产详情、转账页面、P2PKH 总览/UTXO/历史/余额 widget 中没有 WOC capability、`fetch`、`messageBus.request("woc.*")`、`backgroundService.trigger` 或任何同步按钮。
- [ ] BSV-21 / STAS 的 `listTokens()`、`getToken()` 等 read API 只触达 snapshot DB。
- [ ] 除 BackgroundService / WOC actor 外，没有资产同步相关 `setInterval` 或轮询 timeout。
- [ ] P2PKH recent sync 不再硬编码 `60_000`。

### 10.2 调度与设置

- [ ] 后台设置页默认显示“资产余额同步频率：15 分钟”。
- [ ] 只允许 5 / 15 / 30 / 60 分钟预设；不能保存小于 5 分钟、任意秒数或永不运行。
- [ ] 修改频率后，所有 `asset-holdings` task 的 next run 重新计算，但没有立即产生 WOC 请求。
- [ ] P2PKH recent、BSV-21、STAS 均注册为 `asset-holdings` 后台任务；history backfill 不在该组。
- [ ] 后台托盘可对每个任务“立即运行”、取消、重试、暂停、继续；业务页面没有对应操作。
- [ ] 同 task / key scope 在 2 分钟冷却期内收到多个普通事件，只产生一次合并同步；托盘立即运行可绕过冷却。
- [ ] 多标签页只由 leader 实际运行任务；follower 的托盘操作和设置修改正确转发 / 同步。

### 10.3 数据与 UI

- [ ] 首次进入 `/assets` 时，P2PKH 已有 snapshot 立即显示；BSV-21 或 STAS 尚未同步不会阻塞整页。
- [ ] 打开、刷新或切换资产页面时，网络面板没有新增 WOC 请求；网络请求只在后台 task 运行期间出现。
- [ ] BSV-21 多 token 地址不再使资产页等待“逐 token 余额请求”；这些请求只发生在 `token-bsv21.sync`。
- [ ] 一个 provider 读库失败 / 无 snapshot 时，仅该 provider 显示错误或未同步；其它 provider 仍正常显示。
- [ ] 后台 task 原子提交 UTXO/token/history/claim 后，打开的资产页、首页、详情、转账 picker 与 P2PKH 专属页无需轮询、无需重新进入页面即可更新。
- [ ] data-changed 事件到达时，消费者重新读 DB；事件 payload 不包含余额、UTXO、token 或地址数据。
- [ ] 另一标签页完成同步后，本标签页通过 notifier 更新显示；不依赖页面重新加载。
- [ ] 没有 snapshot 显示 `—` / 未同步；链上真零显示 `0`；失败显示最后成功余额 + stale/failed，不显示伪零。
- [ ] 转账广播后，本地 claim / pending 状态立即更新；链上 snapshot 对账遵守后台冷却和队列策略。

### 10.4 生命周期与安全

- [ ] Vault 锁定、key 删除、active key 切换能取消对应 task 并等待退出；迟到网络结果不会写回错误 / 已删除 namespace。
- [ ] testnet 开关只改变允许 scope；开启一个尚无 snapshot 的 scope 时由后台任务同步，页面不直接请求。
- [ ] WOC 限流、超时、部分 resource 失败时，后台任务按退避处理且旧快照保留。
- [ ] 所有新增 DB transaction、跨标签页 data notifier、冷却/配置变更、token sync 与页面零网络边界均有单元测试或集成测试覆盖。

