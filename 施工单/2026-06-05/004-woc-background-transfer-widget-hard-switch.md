# 004 WOC 代理、后台任务与资产转移 Widget 硬切换施工单

## 目标

把当前项目一次性切换为以下架构：

```txt
plugin-woc
  WOC 基础设施插件。
  统一管理 WOC URL、请求频率、请求队列、重试、网络 endpoint 与广播。

plugin-background
  通用后台任务平台。
  统一调度插件后台任务，并在顶部状态区展示当前运行、排队、暂停和失败任务。

plugin-p2pkh
  P2PKH 资产插件。
  通过 woc.service 读取链上数据，通过 background.registry 注册后台同步任务。
  区分“完整历史回填”和“最近状态检查”，内部管理 UTXO、历史、pending 转账与签名。

plugin-transfer
  资产转移入口平台。
  只展示可转移资产与 provider，并挂载 provider 提供的完整转移 Widget。
  不再收集 key、地址、金额、矿工费、UTXO 或广播参数。
```

本次是硬切换，不保留旧 WOC 客户端、旧 Transfer prepare/sign/broadcast 平台流程、旧 P2PKH 手动同步模型或旧 P2PKH 历史主键。

## 硬切换缘由

1. WOC 免费 API 默认限制为每秒最多 3 次请求。当前每个业务插件自行请求 WOC，会让多个地址、多个插件、前台刷新和后台同步互相争抢额度，无法统一限流。
2. WOC 是链上数据来源，不是 P2PKH 私有实现。后续 1Sat、合约、交易详情或其他 BSV 插件也可能消费 WOC，必须把传输、限流和 endpoint 管理从 P2PKH 中抽离。
3. P2PKH 的完整历史回填与日常状态检查不是同一种任务。完整历史可能运行很久，日常检查必须快速、可重复，并且不能被历史回填阻塞。
4. 历史尽头不能用余额、金额或 UTXO 数量判断。余额为 0 的地址仍可能拥有大量历史，历史分页 token 才是可靠的终止信号。
5. 浏览器后台工作需要可观察。用户必须知道当前有哪些任务在运行、排队、暂停或失败，不能让长时间历史同步在无提示状态下消耗请求额度。
6. 当前 Transfer 平台已经知道 `keyId`、接收方地址、satoshis、未确认 UTXO 策略和 preview 结构，实际偏向 P2PKH coin 转账。未来 token、合约或其他资产转移不一定具备这些字段，平台边界必须一次切干净。
7. 分步骤保留旧架构会形成双路径：

```txt
旧路径：plugin-p2pkh -> WocClient -> fetch
新路径：plugin-p2pkh -> woc.service -> 请求队列

旧路径：plugin-transfer -> prepare/sign/broadcast
新路径：plugin-transfer -> provider offer -> provider Widget
```

双路径会造成限流绕过、事件重复、网络上下文不一致和转账流程职责不清，因此不允许渐进兼容。

## 外部事实与前提

1. WOC 官方文档说明 API 默认限制为每秒最多 3 次请求：

```txt
https://docs.whatsonchain.com/
```

2. WOC Address API 的确认历史接口支持分页参数和分页 token。完整历史同步必须依赖分页 token 判断是否到达尽头：

```txt
https://docs.whatsonchain.com/address
```

3. WOC 在 2025 年 7 月 21 日移除了旧版废弃地址接口。当前项目使用的下列路径不能继续保留：

```txt
/address/{address}/balance
/address/{address}/unspent
/address/{address}/tx/history
```

变更记录：

```txt
https://docs.whatsonchain.com/change-log
```

4. 本项目运行在浏览器。浏览器定时器可能被节流、页面可能离线、用户可能打开多个同源标签页，因此“每 60 秒”只能表达调度目标，不能保证精确到秒。
5. `plugin-woc` 能保证本应用同源标签页内、所有经过 `woc.service` 的请求遵守频率限制，但无法控制其他网站、其他设备或绕过本服务直接访问 WOC 的请求。

## 核心不变量

1. 所有 WOC 请求必须经过 `woc.service`，业务插件禁止直接 `fetch` WOC。
2. WOC URL 与请求频率只由 `plugin-woc` 设置管理，P2PKH 设置页不再保存 WOC URL。
3. WOC 默认配置必须可直接工作：

```txt
woc.baseUrl = "https://api.whatsonchain.com/v1/bsv"
woc.requestsPerSecond = 3
```

4. WOC 限流必须覆盖查询和广播。广播优先级最高，但不能绕过频率限制。
5. WOC 请求队列必须使用连续时间窗口控制，任意连续 1000ms 内最多发出配置数量的请求。
6. WOC 返回的余额、UTXO 和链上历史是链上状态真值。IndexedDB 只是缓存。
7. 本地 pending 转账和 UTXO reservation 是防止重复花费的安全覆盖层，不是链上真值。
8. P2PKH 完整历史回填必须从最新向最旧分页，直到 WOC 不再返回下一页 token。
9. P2PKH 最近状态检查必须优先于完整历史回填，不能每次从创世历史重新扫描。
10. 同一个后台任务不能重叠执行。重复触发必须合并为一次后续运行。
11. P2PKH 后台任务必须在 Vault 解锁时运行，Vault 锁定后不得继续读取 key 或签名相关资源。
12. Shell 顶部状态区只消费通用 `topbar.registry`，不能直接 import `plugin-background`。
13. `plugin-background` 只理解通用任务状态，不理解 P2PKH、WOC、UTXO 或历史分页。
14. `plugin-transfer` 只理解 provider、资产 offer、动态余额、状态和 Widget，不理解具体转移表单。
15. P2PKH 转移 Widget 可以拥有完整交互，但签名、广播、UTXO reservation 和业务状态变更必须落在 P2PKH service 中，不能只写在 React 组件里。

## 最终结构

```txt
packages/
  contracts/
    src/
      background.ts
      topbar.ts
      transfer.ts
      woc.ts
      index.ts
      registries.ts

  runtime/
    src/
      createPluginHost.ts
      index.ts
      registries/
        topbarRegistry.ts

  plugin-woc/
    package.json
    tsconfig.json
    src/
      index.ts
      manifest.ts
      wocService.ts
      wocSettings.ts
      pages/
        WocSettingsPage.tsx

  plugin-background/
    package.json
    tsconfig.json
    src/
      index.ts
      manifest.ts
      backgroundService.ts
      BackgroundTray.tsx
      BackgroundTaskList.tsx

  plugin-transfer/
    src/
      index.ts
      manifest.ts
      TransferPage.tsx
      TransferOfferPicker.tsx

  plugin-p2pkh/
    src/
      manifest.ts
      p2pkhContracts.ts
      p2pkhDb.ts
      p2pkhService.ts
      p2pkhSyncCoordinator.ts
      p2pkhHistorySync.ts
      p2pkhRecentSync.ts
      p2pkhTransferService.ts
      p2pkhTransferProvider.ts
      widgets/
        P2pkhTransferWidget.tsx
      pages/
        P2pkhSettingsPage.tsx

apps/
  web/
    src/
      bootstrapPlugins.ts
      shell/
        Topbar.tsx
      styles/
        global.css
```

硬切换后删除：

```txt
packages/plugin-p2pkh/src/wocClient.ts
packages/plugin-transfer/src/transferFlow.ts
packages/plugin-transfer/src/TransferPreview.tsx
packages/plugin-transfer/src/TransferProviderPicker.tsx
```

## 职责边界

### plugin-woc

负责：

1. WOC base URL 与请求频率设置。
2. main/test 网络 URL 拼接。
3. 请求队列、连续窗口限流、超时、取消、429 backoff。
4. 同源多标签页请求频率协调。
5. WOC 当前 API 的请求与响应类型。
6. 地址余额、UTXO、历史和 raw transaction 广播。
7. 向订阅者暴露队列状态和最近错误。

不负责：

1. 不知道 P2PKH 资源、资产、key、UTXO 分配或签名。
2. 不决定哪个地址应该同步。
3. 不保存 P2PKH 历史或余额。
4. 不注册 P2PKH 后台任务。

### plugin-background

负责：

1. 注册、调度、触发、暂停、恢复和取消后台任务。
2. 防止同一个任务重叠执行。
3. 合并任务重复触发。
4. 保存任务运行状态、进度、最近完成时间、下次计划时间和错误。
5. 在顶部状态区展示任务摘要和任务列表。
6. 在浏览器重新联网、标签页重新获得执行机会时重新评估到期任务。

不负责：

1. 不保存业务分页 cursor。
2. 不解释历史、余额、UTXO、WOC 或转账。
3. 不替业务插件决定任务是否可以运行。
4. 不把任务失败自动解释为资产失败。

### plugin-p2pkh

负责：

1. P2PKH 地址资源、余额、UTXO、历史、历史 cursor、pending 转账和 reservation。
2. 注册 `p2pkh.recent-sync` 与 `p2pkh.history-backfill` 后台任务。
3. 决定地址分组、同步顺序、历史去重、链上状态更新和 reservation 释放。
4. 提供 P2PKH transfer offer 与完整转移 Widget。
5. 通过 `woc.service` 查询和广播，禁止直接访问 WOC。

不负责：

1. 不实现 WOC 限流。
2. 不实现通用后台任务 UI。
3. 不让 Transfer 平台理解 P2PKH 表单或交易草稿。

### plugin-transfer

负责：

1. 聚合所有 TransferProvider 的动态 offer。
2. 展示 provider、资产名称、余额、状态。
3. 用户选择 offer 后挂载 provider 的 Widget。
4. 提供 Widget 错误边界。
5. 接收 Widget 的通用完成通知，用于平台级事件和页面切换。

不负责：

1. 不读取 Vault key。
2. 不读取联系人。
3. 不收集接收地址、金额、矿工费或未确认策略。
4. 不展示 provider 专属 preview。
5. 不执行 prepare、sign 或 broadcast。

## WOC 服务设计

### WOC 公共契约

`packages/contracts/src/woc.ts` 是跨包 WOC 协议。它可以出现 WOC 专属概念，因为 `plugin-woc` 与业务插件需要通过它协作，但它不能包含 P2PKH 专属类型。

建议协议形态：

```txt
WocRequestPriority =
  "broadcast"
  | "foreground"
  | "recent-sync"
  | "history-backfill"

WocQueueSnapshot:
  queued
  active
  requestsPerSecond
  rateLimitedUntil?
  lastError?

WocAddressHistoryPage:
  items
  nextPageToken?

WocService:
  getAddressBalances(network, addresses, options?)
  getAddressUtxos(network, addresses, options?)
  getAddressUnconfirmedHistory(network, addresses, options?)
  getAddressConfirmedHistory(network, address, pageOptions)
  broadcast(network, rawTxHex, options?)
  getQueueSnapshot()
  onQueueChange(handler)
```

要求：

1. 优先使用 WOC 当前批量地址接口，最近同步按网络把地址分组，减少请求次数。
2. 完整历史回填需要单地址分页时，可以使用单地址确认历史接口。
3. 公共 service 不暴露任意 URL 的 `fetchJson(path)` 逃生口。新增 WOC endpoint 时先扩展 WOC 契约，再由 `plugin-woc` 实现。
4. 所有方法都支持 `priority` 和 `AbortSignal`。
5. 响应类型保留 WOC 必要字段，但不能包含 P2PKH `resourceId`、`keyId` 或资产 id。
6. `nextPageToken` 是项目内部规范化字段，`plugin-woc` 负责把 WOC 原始响应中的 `next-page` token 映射为该字段。

### 请求队列与频率

默认调度算法：

1. 所有请求先进入优先级队列。
2. 队列按优先级取请求，同优先级按进入时间先进先出。
3. 调度器记录最近已发出的请求时间戳。
4. 发出新请求前，删除 1000ms 以前的时间戳。
5. 如果窗口内请求数已达到 `requestsPerSecond`，等待最早时间戳离开窗口后再发出。
6. 收到 429 时读取可用的 `Retry-After`；没有时使用指数 backoff，并暂停发出新请求。
7. 请求取消后，如果尚未发出则从队列移除；已经发出则通过 `AbortController` 中止。

优先级顺序：

```txt
broadcast > foreground > recent-sync > history-backfill
```

设计缘由：

1. 用户确认广播后不能被长时间历史回填压在队尾。
2. 前台手动刷新应比后台任务更快得到结果。
3. 最近状态检查影响余额和可花费 UTXO，优先于旧历史补全。
4. 历史回填可以长期运行，但必须让出请求额度。

### 多标签页协调

要求：

1. 在支持 Web Locks API 的浏览器中，WOC 调度必须使用同源命名锁协调发出时间。
2. 最近发出时间戳需要保存在同源可共享存储中，让多个标签页看到同一个连续窗口。
3. `plugin-background` 也应选举单个后台任务 leader，避免每个标签页都运行相同周期任务。
4. 不支持 Web Locks API 时，退化为单标签页限流，并在 WOC 队列状态中标记无法保证跨标签页频率。

不能做：

1. 不能只在每个 `WocClient` 实例内部计数。
2. 不能通过 `setInterval(333)` 假装实现每秒 3 次，因为它不能处理突发、优先级和多标签页。
3. 不能让广播直接 `fetch` 来绕过队列。

### WOC 设置

默认值：

```txt
baseUrl = "https://api.whatsonchain.com/v1/bsv"
requestsPerSecond = 3
```

设置要求：

1. URL 保存前去除末尾 `/`。
2. URL 必须是有效的 `http:` 或 `https:` URL，否则显示中文校验提示，不写入设置。
3. 请求频率必须是大于 0 的有限数字。
4. 修改设置后立即作用于后续请求，不中断已经发出的请求。
5. 自定义代理 URL 可以使用更高频率，但用户必须显式修改；默认不能高于 3。
6. 本次不新增 API Key 设置。未来如果支持 API Key，必须存入 Vault 或专门 secret storage，不能明文写入 `localStorage`。

## 后台任务平台设计

### 后台任务公共契约

`packages/contracts/src/background.ts` 定义通用任务协议。

建议协议形态：

```txt
BackgroundTaskState =
  "idle"
  | "queued"
  | "running"
  | "paused"
  | "failed"

BackgroundTaskProgress:
  current?
  total?
  message?

BackgroundTaskRunReason =
  "schedule"
  | "manual"
  | "event"
  | "retry"

BackgroundTaskDefinition:
  id
  pluginId
  label
  description?
  intervalMs?
  priority?
  canRun?()
  run(context)

BackgroundTaskContext:
  signal
  reason
  reportProgress(progress)

BackgroundTaskSnapshot:
  id
  pluginId
  label
  state
  progress?
  lastStartedAt?
  lastCompletedAt?
  nextRunAt?
  error?

BackgroundRegistry:
  register(task)
  list()

BackgroundService:
  trigger(taskId, reason?)
  pause(taskId)
  resume(taskId)
  cancel(taskId)
  listSnapshots()
  onChange(handler)
```

要求：

1. `run()` 抛出的错误保留英文错误信息，UI 使用中文状态标签并展示原始错误详情。
2. `canRun()` 返回 false 时任务保持 idle 或 queued，不标记 failed。
3. 同一个任务运行期间再次触发时，只记录一次 rerun 请求，当前运行结束后再执行一次。
4. `cancel()` 必须触发 `AbortSignal`，业务任务需要在分页循环和请求间检查 signal。
5. `pause()` 不得删除业务 cursor。恢复后从业务插件保存的 cursor 继续。
6. interval 任务加入少量 jitter，避免多个任务在同一毫秒同时入队。
7. 用户主动暂停状态需要按 task id 持久化，页面刷新后不能自动恢复被用户暂停的任务。
8. 任务业务 cursor 不由后台平台持久化，必须由注册任务的业务插件负责。
9. 多标签页中 leader 通过 `BroadcastChannel` 或等价同源机制广播任务快照，follower 标签页的托盘也能看到真实状态。
10. follower 标签页触发暂停、恢复、取消、重试或手动运行时，需要转发给 leader 执行。

### 顶部状态区

新增通用 `topbar.registry`，由 runtime 内置并由 Shell 渲染。

`plugin-background` 向 `topbar.registry` 注册一个任务托盘组件。

托盘要求：

1. 收起状态显示后台任务图标和运行/排队数量。
2. 有失败任务时显示明确失败状态。
3. 展开后显示任务名称、状态、进度、最近完成时间、下次运行时间和错误。
4. 支持暂停、恢复、取消当前运行和失败重试。
5. 使用 lucide 图标与 tooltip，不能在顶部堆放长文本按钮。
6. 顶部状态区不能遮挡品牌、锁定按钮或移动端内容。

不能做：

1. 不能让 `Topbar.tsx` import `plugin-background`。
2. 不能让 P2PKH 自己直接修改 Topbar。
3. 不能把后台任务列表做成 P2PKH 专属页面。

## P2PKH 同步设计

### 数据真值

链上真值：

```txt
余额
确认 UTXO
未确认 UTXO
确认历史
未确认历史
交易是否已确认或已从 mempool 消失
```

本地缓存与安全覆盖层：

```txt
P2PKH 地址资源
历史分页 cursor
最近同步 watermark
本地 pending 转账
已广播输入的 UTXO reservation
后台任务进度
```

规则：

1. WOC 返回的当前 UTXO 快照决定链上可见未花费集合。
2. 本地 reservation 必须从可分配 UTXO 中排除，即使 WOC 暂时仍返回该 UTXO。
3. 链上历史通过 upsert 更新，不在每次最近同步时清空。
4. 本地 pending 转账可以立即用于 UI，但必须和 WOC 链上历史分开存储或明确标记来源。
5. WOC 同步成功后，链上状态覆盖本地 pending 的确认状态。

### 完整历史回填任务

任务 id：

```txt
p2pkh.history-backfill
```

用途：

1. 新导入地址后补齐从最新到最旧的确认历史。
2. 应用升级后补齐尚未完成的地址历史。
3. 用户手动重试失败或暂停的历史同步。

算法：

1. 遍历所有未完成 backfill 的 P2PKH resource。
2. 对每个 resource 从已保存的 `nextPageToken` 继续请求确认历史。
3. 每取得一页，通过 `P2pkhSyncCoordinator` 按 `resourceId + txid` upsert 历史。
4. 当前页历史、新的 `nextPageToken` 和进度必须在同一个 IndexedDB 事务中提交。
5. 如果响应没有 `nextPageToken`，将该 resource 标记为 `backfillComplete = true`。
6. 每页之间检查取消信号，并让出执行机会。
7. 所有请求使用 `history-backfill` 优先级。

历史尽头判断：

```txt
只有“WOC 不再返回 nextPageToken”表示到达尽头。
```

不能使用：

```txt
余额为 0
页面金额合计为 0
UTXO 数量为 0
本页没有收到交易金额
遇到未确认交易
遇到区块高度 0
```

设计缘由：

1. 地址可能已经把全部余额花完，但历史仍然存在。
2. 地址历史记录不一定包含可直接汇总的金额。
3. 一个地址可以长期没有 UTXO，但仍有收款和花费历史。

### 最近状态检查任务

任务 id：

```txt
p2pkh.recent-sync
```

默认调度：

```txt
intervalMs = 60_000
```

触发来源：

1. 周期调度。
2. Vault 解锁。
3. 导入或移除 key。
4. P2PKH 广播成功。
5. 用户手动刷新。
6. 浏览器重新联网。

用途：

1. 刷新余额。
2. 刷新当前确认和未确认 UTXO。
3. 检查未确认历史变化。
4. 检查最新确认历史。
5. 更新 pending 转账与 reservation。

算法：

1. 按网络把地址分组，优先使用 WOC 批量地址接口。
2. 更新每个 resource 的余额和 UTXO 快照。
3. 对未确认历史做完整的当前快照更新。
4. 从最新确认历史开始读取。
5. 遇到已知 txid 或已知最近 watermark 后停止读取旧页。
6. 如果新地址没有已知 watermark，最近同步只写入最新页，不继续回填到创世；完整历史交给 `history-backfill`。
7. 所有请求使用 `recent-sync` 优先级。

最近同步与完整历史回填的区别：

```txt
recent-sync
  从最新开始，遇到已知边界就停止。
  目标是快速刷新余额、UTXO 和新交易。

history-backfill
  从保存的分页 cursor 继续，直到没有下一页 token。
  目标是最终补齐全部旧历史。
```

## P2PKH 同步协调器

### 为什么不能只依赖后台任务防重叠

`plugin-background` 只能保证同一个 task id 不重叠运行，但：

```txt
p2pkh.recent-sync
p2pkh.history-backfill
```

是两个不同 task id，它们仍可能同时处理同一个 resource，并且都会写入历史 store。

如果只要求“DB 写入串行”，仍然会留下这些问题：

1. backfill 可能在等待 WOC 响应时长期占用资源锁，导致 recent-sync 无法及时刷新刚广播的交易。
2. recent-sync 可能在 backfill 期间发现新交易，历史头部变化不能破坏 backfill cursor。
3. 任务取消、页面刷新或网络失败可能发生在“历史页已写入、cursor 尚未写入”之间。
4. backfill 的旧响应可能覆盖 recent-sync 已经写入的新确认状态。
5. key 删除后，迟到的 WOC 响应可能重新创建已删除 resource 的历史。

因此 P2PKH 内部必须新增 `P2pkhSyncCoordinator`。后台平台只观察任务，不理解这个协调器。

### 协调单位

协调单位是：

```txt
resourceId = keyId:network
```

每个 resource 拥有独立同步通道：

```txt
P2pkhResourceSyncLane:
  resourceId
  recentPending
  recentRunning
  backfillRunning
  backfillYieldRequested
  generation
  cursorRevision
```

要求：

1. 同一个 resource 同一时刻最多允许一个 history commit。
2. 不同 resource 可以并行准备请求，但最终仍受 `woc.service` 全局限流。
3. mainnet 与 testnet resource 不共享业务锁，但共享 WOC 请求队列。
4. resource 删除时必须取消该 resource 的 recent 与 backfill 工作，并清理同步通道。
5. 所有 P2PKH 历史写入必须经过协调器，页面、后台任务和转移服务不能绕过它直接写 history store。

### generation 与 cursorRevision

不能使用一个含义模糊的 revision 表示所有数据变化。

```txt
generation:
  resource 创建时生成的唯一值。
  resource 删除后即失效。
  同一个 resourceId 删除后重新创建时必须得到新的 generation。

cursorRevision:
  backfill cursor 的版本号。
  cursor 前进、重置或标记 complete 时增加。
  recent-sync 正常提交时不增加。
```

规则：

1. backfill 请求发出前必须捕获 `generation`、`cursorRevision` 和当前 `nextPageToken`。
2. backfill 响应提交时三者都必须仍然匹配。
3. recent-sync 请求发出前至少捕获 `generation`，提交时 generation 不匹配则丢弃响应。
4. recent-sync 更新余额、UTXO 或 recent watermark 时不能增加 cursorRevision，否则会无意义地让有效 backfill 响应失效。
5. resource 删除后重建即使仍使用相同 `resourceId`，旧 generation 的迟到响应也不能提交。
6. token 失效并重置 cursor 时必须增加 cursorRevision，使旧 token 对应的迟到响应失效。

### 两类任务的写权限

`p2pkh.recent-sync` 可以写：

1. resource balance。
2. resource UTXO 快照。
3. 未确认历史。
4. 最新确认历史。
5. recent history watermark。
6. pending transfer 状态。
7. UTXO reservation 对账结果。
8. resource `lastSyncedAt`。

`p2pkh.recent-sync` 不能写：

1. backfill `nextPageToken`。
2. backfill `complete` 状态。
3. backfill 页数、记录数或旧历史进度。

`p2pkh.history-backfill` 可以写：

1. 缺失的旧确认历史。
2. backfill `nextPageToken`。
3. backfill `complete` 状态。
4. backfill 页数、记录数与最近错误。

`p2pkh.history-backfill` 不能写：

1. balance。
2. UTXO。
3. 未确认历史。
4. pending transfer。
5. UTXO reservation。
6. recent history watermark。
7. resource `lastSyncedAt`。

设计缘由：

backfill 响应可能比 recent-sync 响应旧。限制写权限可以避免旧分页响应覆盖近期状态。

### 优先级与让出规则

```txt
recent-sync > history-backfill
```

规则：

1. recent-sync 到达时，如果 backfill 已经发出当前页请求，不强制中断该请求。
2. backfill 完成当前页响应处理后，必须检查 `recentPending`。
3. 如果存在 `recentPending`，backfill 在请求下一页之前让出执行权。
4. recent-sync 完成后，未完成的 backfill 可以继续下一页。
5. backfill 每页都必须重新检查取消信号、暂停状态和 `recentPending`。
6. backfill 不能一次取得“同步到尽头”的长期资源锁。
7. recent-sync 运行中再次触发时合并为一次后续 rerun，不能并发运行两次。
8. backfill 运行中再次触发时忽略重复触发，保留当前任务。
9. UTXO 快照替换必须按 resource 原子执行，不能先清空后因中断留下空数据。
10. 单个 resource 同步失败不能清空其他 resource 或其他网络缓存。

### 请求与提交分离

WOC 请求不能在持有 IndexedDB 写事务或资源 commit 锁时等待。

backfill 每页流程：

```txt
1. 在协调器中读取当前 backfill cursor、generation、cursorRevision 和 resource 状态。
2. 释放 commit 锁。
3. 通过 woc.service 发出最低优先级分页请求。
4. 请求返回后重新进入协调器。
5. 比较 resource 是否仍存在、generation、cursor、cursorRevision 是否仍匹配。
6. 如果不匹配，丢弃该响应并重新读取 cursor，不能盲写。
7. 如果匹配，在同一个 IndexedDB 事务中：
   - 按 resourceId + txid upsert 当前页历史。
   - 写入下一页 token 或 complete 状态。
   - 增加页数与记录数。
8. 提交完成后释放锁并检查 recentPending。
```

recent-sync 流程：

```txt
1. 读取 resource 与 recent watermark。
2. 通过 woc.service 发出 recent-sync 优先级请求。
3. 请求返回后进入协调器。
4. 在短事务中提交余额、UTXO 快照、近期历史、watermark 与 reservation 对账。
5. 提交完成后通知资产、Transfer Offer 与页面订阅者。
```

### backfill 页与 cursor 原子提交

P2PKH DB 必须提供类似能力：

```txt
commitBackfillPage(resourceId, expectedGeneration, expectedCursorRevision, expectedPageToken, page)
commitRecentSnapshot(resourceId, expectedGeneration, snapshot)
```

`commitBackfillPage` 必须保证：

1. 当前页历史与 cursor 在同一个 IndexedDB 事务中提交。
2. 事务失败时，当前页历史与 cursor 都不生效。
3. 重试同一页时按 `resourceId + txid` 去重。
4. 没有 `nextPageToken` 时，在同一个事务中标记 `backfillComplete = true`。
5. expected generation、cursor revision 或 page token 不匹配时拒绝提交，调用方重新读取当前 cursor。

不能做：

1. 不能先写 history，再用另一个事务写 cursor。
2. 不能先写 cursor，再写 history。
3. 不能使用“紧邻事务”代替原子事务。
4. 不能因为重复页可以去重，就忽略 cursor 原子性。

### 历史合并规则

历史记录需要明确来源与状态：

```txt
source:
  "pending-local"
  | "woc-unconfirmed"
  | "woc-confirmed"

status:
  "pending"
  | "unconfirmed"
  | "confirmed"
  | "dropped"
```

规则：

1. backfill 只写 `woc-confirmed`。
2. backfill 对已存在记录只能补充缺失字段，不能把 recent-sync 写入的新状态降级。
3. recent-sync 可以把 `pending-local` 更新为 `woc-unconfirmed` 或 `woc-confirmed`。
4. recent-sync 可以把 `woc-unconfirmed` 更新为 `woc-confirmed`。
5. recent-sync 负责近期重组窗口内的状态校准；backfill 不处理重组。
6. 同一 txid 的确认记录不能因为旧 backfill 响应被改回未确认。
7. `syncedAt` 使用最新成功观察时间，不能被旧响应覆盖为更早时间。

### backfill cursor 与 recent watermark

两类任务必须维护不同边界：

```txt
backfill cursor:
  只描述向旧历史分页的进度。

recent watermark:
  描述上一次近期检查已经看过的历史头部。
```

要求：

1. backfill 首次启动时记录初始历史头部作为 anchor。
2. recent-sync 发现 anchor 之后的新交易时，只更新 recent watermark，不重置 backfill cursor。
3. backfill 始终沿已保存的分页 token 向旧历史继续。
4. 如果分页 token 失效，不能清空已有历史。重置 backfill cursor 后从头重新分页，依靠 `resourceId + txid` 去重。
5. token 失效后的重新扫描可以增加请求量，但不能造成历史丢失。
6. backfill 完成后，recent-sync 仍继续运行，不能把 complete 当作不再检查新交易。

### recent-sync 新历史检查

recent-sync 不是完整历史同步。

要求：

1. 从最新历史开始读取。
2. 遇到已保存的 recent watermark 或已知近期 txid 后停止。
3. 如果一次 interval 内新增交易超过单页容量，可以继续读取后续页，直到遇到已知边界。
4. 每次 recent-sync 设置最大页数，达到上限后安排一次 rerun，不能长时间占用近期同步任务。
5. 新 resource 没有 recent watermark 时，recent-sync 只保存最新页并建立 watermark，旧历史交给 backfill。
6. recent-sync 不能因为没有遇到已知 txid 就一路扫描到创世历史。
7. 未确认历史单独读取和对账，不能使用确认历史分页 token 替代。

### 批量请求与逐资源提交

近期同步应优先使用 WOC 当前支持的批量地址接口，减少请求数量。

要求：

1. 按 network 分组 resource。
2. 按 WOC 批量接口允许的最大地址数分批。
3. WOC 批量响应返回后，仍按 resourceId 分别进入协调器提交。
4. 单个地址响应失败不能阻止同批其他地址提交成功数据。
5. backfill 仍按单 resource 分页，因为每个地址拥有独立 cursor。

### 取消、锁定与删除

1. Vault 锁定时取消 P2PKH recent-sync 与 history-backfill 的当前运行。
2. Vault 解锁时重新检查未完成任务并触发一次 recent-sync。
3. key 删除时先取消其 main/test resource 通道，再删除缓存。
4. 已取消请求返回时不得写库。
5. resource 删除后迟到的 WOC 响应必须因 generation 或存在性检查失败而被丢弃。

### P2PKH 后台任务状态

P2PKH 注册后台任务时：

1. `canRun()` 检查 Vault 是否解锁、浏览器是否在线、是否存在 P2PKH resource。
2. Vault 锁定事件触发任务取消。
3. Vault 解锁事件触发一次最近同步，并继续未完成历史回填。
4. key 导入后创建 main/test resource，触发最近同步和历史回填。
5. key 移除后清理资源、历史 cursor、pending 与 reservation。

## P2PKH 转移与 UTXO reservation

### 广播成功后的处理

P2PKH 广播成功后必须立即：

1. 使用已签名交易 txid 创建本地 pending transfer。
2. 为本次交易选中的输入创建 UTXO reservation。
3. 从后续 `allocateUtxos()` 结果中排除这些 reservation。
4. 发出通用 `transfer.completed` 事件。
5. 高优先级触发一次 `p2pkh.recent-sync`。
6. Widget 内展示 txid、资产、网络、金额、矿工费、输入数量和广播状态。

设计缘由：

WOC 在广播成功后可能短时间仍返回旧 UTXO。如果不做 reservation，用户可能在下一次同步前重复选择同一个输入并产生双花。

### reservation 释放

规则：

1. WOC 不再返回某个已 reservation 的 UTXO 时，保留交易 pending 状态，但可以移除该 UTXO reservation，因为它已经不可能再次被本钱包选择。
2. WOC 历史确认该 txid 后，将 pending transfer 更新为 confirmed。
3. 如果交易长时间不在未确认历史中、输入仍重新出现在 WOC UTXO 中，并且超过安全等待时间，才允许释放 reservation。
4. 自动释放前必须至少经过多次成功最近同步，不能因一次 WOC 短暂不一致释放。
5. 提供手动释放失败 reservation 的高级操作时，必须有明确风险提示。

不能做：

1. 不能在广播成功后直接把本地 pending 当作链上已确认历史。
2. 不能仅因为一次未查到 txid 就释放输入。
3. 不能让 reservation 永久遮蔽已经重新可花费的 UTXO。

## Transfer Widget 平台设计

### Transfer 公共契约

硬切换重写 `packages/contracts/src/transfer.ts`。

建议协议形态：

```txt
TransferOffer:
  id
  providerId
  assetProviderId
  assetId
  assetLabel
  providerLabel
  balance?
  status
  description?
  order?

TransferCompletion:
  offerId
  providerId
  assetProviderId
  assetId
  reference?
  completedAt
  details?

TransferWidgetProps:
  offer
  onCompleted(result)

TransferProvider:
  id
  name
  order?
  component
  listOffers()
  onChange(handler)

TransferRegistry:
  register(provider)
  list()
  get(id)
```

要求：

1. offer 动态暴露 provider、资产、余额和状态。
2. provider 余额或可用性变化时，通过 `onChange()` 通知 Transfer 平台刷新 offer。
3. `component` 是 provider 提供的完整转移 Widget。
4. `reference` 是通用外部引用，可以是 txid，也可以是其他资产系统的操作 id。
5. `details` 由 provider 自解释，Transfer 平台不展开显示。

从公共 Transfer 契约删除：

```txt
TransferContext
TransferDraft
SignedTransfer
BroadcastResult
canHandle()
prepare()
sign()
broadcast()
```

设计缘由：

这些字段把平台绑定到“先填 coin 表单，再预览，再签名广播”的单一模型。完整 Widget 模型允许不同资产自行决定交互流程，同时仍通过 offer 和完成通知接入平台。

### Transfer 页面

最终页面流程：

```txt
读取全部 TransferProvider
  -> 订阅 provider.onChange
  -> 聚合动态 TransferOffer
  -> 用户选择 offer
  -> 挂载 provider.component
  -> provider Widget 内部完成输入、预览、提交和结果展示
  -> Widget 调用 onCompleted
  -> Transfer 平台发出通用完成事件
```

页面展示：

1. offer 列表显示资产名称、provider 名称、动态余额和状态。
2. 选中 offer 后只显示对应 Widget。
3. offer 失效或被移除时，卸载旧 Widget 并提示用户重新选择。
4. Widget 渲染异常由平台错误边界捕获，不能让整个应用崩溃。

不能做：

1. 不能在 Transfer 页面出现“来源 key”“接收方地址”“金额”“允许未确认 UTXO”等 P2PKH 表单。
2. 不能让 Transfer 页面读取 `vault.service`、`contacts.service` 或 `p2pkh.service`。
3. 不能把 provider 专属对象 JSON stringify 后作为通用 preview。
4. 不能要求所有资产都有 satoshis、txid 或地址。

### P2PKH Transfer Widget

`P2pkhTransferWidget` 内部负责：

1. 根据 offer 的 `assetId` 固定网络，禁止默认 mainnet。
2. 展示该资产动态余额。
3. 选择来源 key 或 resource。
4. 输入接收地址。
5. 可选接入 `contacts.picker`。
6. 校验接收地址网络。
7. 输入金额、矿工费和未确认 UTXO 策略。
8. 分配 UTXO。
9. 展示 P2PKH 专属预览。
10. 签名、广播和提交后详情。
11. 广播成功后调用平台 `onCompleted()`。

业务逻辑要求：

1. Widget 只负责交互和展示。
2. UTXO 分配、签名、广播、pending、reservation 和后台同步触发放入 `p2pkhTransferService.ts`。
3. 联系人 picker 是可选 capability。没有联系人插件时，手工地址输入仍可工作。
4. P2PKH provider 不硬依赖 `plugin-contacts`，也不 import 其源码。

## 不能怎么做

1. 不能保留 `packages/plugin-p2pkh/src/wocClient.ts`。
2. 不能在 `plugin-p2pkh`、`plugin-transfer` 或其他业务插件中直接请求 `api.whatsonchain.com`。
3. 不能让某个业务插件自行实现每秒 3 次限流。
4. 不能用余额为 0 判断历史同步完成。
5. 不能让最近同步每次遍历完整历史。
6. 不能让完整历史回填阻塞广播或前台刷新。
7. 不能在每次同步时清空全部历史后重写。
8. 不能用数组索引构造历史主键。
9. 不能在广播成功后立即删除已选 UTXO，却不保留 pending 或 reservation 信息。
10. 不能让后台任务平台保存 P2PKH 分页 cursor。
11. 不能让 Shell 或 runtime import 任何业务插件。
12. 不能让 Transfer 平台理解 P2PKH 交易草稿。
13. 不能让 P2PKH Widget 成为唯一业务实现。
14. 不能为了兼容旧 Transfer API 同时保留旧 provider 方法和新 Widget provider 方法。
15. 不能为了兼容旧 P2PKH DB schema 保留两套历史 id 或两套 cursor 语义。

## 文件级施工

### packages/contracts/src/woc.ts

新增 WOC 跨包协议。

必须做：

1. 定义 WOC 请求优先级。
2. 定义 WOC 队列状态。
3. 定义当前地址余额、UTXO、未确认历史、确认历史分页和广播所需类型。
4. 定义 `WocService`。
5. 所有请求方法支持 network、priority 和取消信号。

不能做：

1. 不能出现 P2PKH `resourceId`、`keyId`、assetId 或 UTXO 分配类型。
2. 不能暴露任意 URL `fetch`。
3. 不能包含 React 组件。

### packages/contracts/src/background.ts

新增通用后台任务协议。

必须做：

1. 定义任务状态、进度、运行原因、任务定义、任务快照。
2. 定义 `BackgroundRegistry` 与 `BackgroundService`。
3. 定义任务运行上下文和取消信号。

不能做：

1. 不能出现 P2PKH、WOC、历史或转账字段。
2. 不能保存业务 cursor。

### packages/contracts/src/topbar.ts

新增顶部状态区扩展协议。

必须做：

1. 定义 `TopbarItem`，至少包含 id、order、component。
2. 定义 `TopbarRegistry`。

不能做：

1. 不能出现后台任务专属字段。
2. 不能让 contracts import runtime、UI 或业务插件。

### packages/contracts/src/transfer.ts

硬切换 Transfer 协议。

必须做：

1. 新增 `TransferOffer`、`TransferCompletion`、`TransferWidgetProps`。
2. 重写 `TransferProvider` 为 `component + listOffers + onChange`。
3. 保留 `TransferRegistry` 注册表语义。
4. 删除旧 coin 表单和 prepare/sign/broadcast 协议。

不能做：

1. 不能保留 `keyId`、recipient、satoshis、fee、UTXO、rawTx 等平台必需字段。
2. 不能出现 P2PKH 专属类型。

### packages/contracts/src/registries.ts

必须做：

1. 导出或引用 `TopbarRegistry`。
2. 如 `BackgroundRegistry` 通过插件 capability 提供，不需要由 runtime 内置，但 contracts 必须能导出其类型。
3. 避免从 `index.ts` 反向导入造成类型循环，优先从具体文件 `import type`。

### packages/contracts/src/index.ts

必须做：

1. 导出 `woc.ts`。
2. 导出 `background.ts`。
3. 导出 `topbar.ts`。
4. 继续导出重写后的 `transfer.ts`。

### packages/runtime/src/registries/topbarRegistry.ts

新增顶部状态区 registry 实现。

必须做：

1. 按 id 注册，重复 id 抛英文错误。
2. `list()` 按 order 排序。

不能做：

1. 不能 import `plugin-background`。
2. 不能理解任务状态。

### packages/runtime/src/createPluginHost.ts

必须做：

1. 创建 `topbarRegistry`。
2. 以 `topbar.registry` capability 暴露。
3. 在 `PluginHost` 上提供只读访问入口，便于 Shell 渲染。

不能做：

1. 不能内置 WOC 或后台任务业务。

### packages/runtime/src/index.ts

导出 `topbarRegistry`。

### packages/runtime/src/registries/transferRegistry.ts

按新 `TransferProvider` 类型继续实现注册表。

必须做：

1. 保持 provider id 重复注册校验。
2. 保持按 order/name 排序。
3. 确认实现不再假设 provider 存在 `canHandle()`、`prepare()`、`sign()` 或 `broadcast()`。

### packages/plugin-woc/package.json

新增包。

依赖：

```txt
@web-wallet/contracts
@web-wallet/runtime
@web-wallet/ui
```

不能依赖：

```txt
@web-wallet/plugin-p2pkh
@web-wallet/plugin-background
其他业务插件
```

### packages/plugin-woc/tsconfig.json

按现有插件包配置新增 TypeScript 配置。

### packages/plugin-woc/src/wocService.ts

实现 `woc.service`。

必须做：

1. 实现 URL 拼接和网络选择。
2. 实现优先级请求队列。
3. 实现连续 1000ms 时间窗口限流。
4. 实现超时、取消、429 backoff 和队列状态订阅。
5. 实现同源多标签页协调。
6. 实现当前 WOC 地址余额、UTXO、历史分页和广播 API。
7. 优先实现批量地址查询。

不能做：

1. 不能默认猜网络。
2. 不能在方法外暴露未限流 fetch。
3. 不能引用 P2PKH 类型。

### packages/plugin-woc/src/wocSettings.ts

实现设置读取、校验和保存。

必须做：

1. 提供正确缺省值。
2. 统一处理 URL 规范化。
3. 提供请求频率校验。
4. 配置变化后通知 `wocService`。

### packages/plugin-woc/src/pages/WocSettingsPage.tsx

实现 WOC 设置页。

必须做：

1. 展示 Base URL。
2. 展示每秒请求数。
3. 显示当前队列状态、最近限流时间或最近错误。
4. 使用中文文案。

不能做：

1. 不能展示或保存 P2PKH 设置。

### packages/plugin-woc/src/manifest.ts

必须做：

1. 提供 `woc.service` capability。
2. 注册 WOC 设置页和设置字段。
3. 声明对 settings registry 等必要 capability 的依赖。

### packages/plugin-woc/src/index.ts

导出 `wocPlugin` 和必要 capability key。

### packages/plugin-background/package.json

新增包。

依赖：

```txt
@web-wallet/contracts
@web-wallet/runtime
@web-wallet/ui
lucide-react
```

不能依赖任何业务插件。

### packages/plugin-background/tsconfig.json

按现有插件包配置新增 TypeScript 配置。

### packages/plugin-background/src/backgroundService.ts

实现后台任务 registry 和 service。

必须做：

1. 注册任务。
2. 调度 interval。
3. 防止同任务重叠。
4. 合并重复触发。
5. 支持暂停、恢复、取消和重试。
6. 保存并广播任务快照。
7. 处理在线状态和后台 leader。

不能做：

1. 不能保存业务数据。
2. 不能吞掉任务错误。

### packages/plugin-background/src/BackgroundTray.tsx

实现顶部任务托盘。

必须做：

1. 使用图标显示运行、排队和失败摘要。
2. 展开任务列表。
3. 提供 tooltip。
4. 在移动端可用。

### packages/plugin-background/src/BackgroundTaskList.tsx

实现任务详情列表。

必须做：

1. 展示状态、进度、最近完成、下次运行和错误。
2. 提供暂停、恢复、取消和重试操作。

### packages/plugin-background/src/manifest.ts

必须做：

1. 提供 `background.registry`。
2. 提供 `background.service`。
3. 向 `topbar.registry` 注册后台任务托盘。

### packages/plugin-background/src/index.ts

导出 `backgroundPlugin` 和必要 capability key。

### packages/plugin-p2pkh/package.json

必须做：

1. 不新增对 `plugin-woc` 或 `plugin-background` 的包级 import 依赖。
2. 继续只通过 `@web-wallet/contracts` 获取跨包协议类型，通过 capability 获取实例。

设计缘由：

当前边界检查禁止 plugin 之间直接 import。基础设施插件与业务插件仍应通过 capability 协作。

### packages/plugin-p2pkh/src/wocClient.ts

删除文件。

不能做：

1. 不能留下兼容 wrapper。
2. 不能保留 WOC base URL 常量。

### packages/plugin-p2pkh/src/p2pkhContracts.ts

扩展 P2PKH 内部契约。

必须做：

1. 历史 id 改为 `resourceId + txid`。
2. 新增历史来源或状态字段，区分链上记录与本地 pending。
3. 新增历史 backfill cursor 类型。
4. 新增最近同步 watermark 类型。
5. 新增 pending transfer 类型。
6. 新增 UTXO reservation 类型。
7. 新增 P2PKH transfer service 输入、预览和结果类型。
8. `P2pkhService` 增加最近同步、历史回填、pending 和 reservation 所需能力。
9. `P2pkhKeyResource` 新增 `generation`。
10. backfill cursor 类型包含 `generation` 与 `cursorRevision`。
11. recent sync state 使用独立 watermark 类型，不能复用 backfill cursor。

不能做：

1. 不能把这些 P2PKH 专属类型迁入全局 contracts。
2. 不能让 WOC 契约知道 P2PKH resource。

### packages/plugin-p2pkh/src/p2pkhDb.ts

硬切换 P2PKH IndexedDB schema 到下一版本。

必须做：

1. 升级 DB version。
2. 历史记录使用稳定 id：`resourceId:txid`。
3. P2PKH resource 记录新增 `generation`，删除后重建必须生成新值。
4. 新增历史 cursor store。
5. 新增独立最近同步 watermark store，不能与 backfill cursor 混为同一进度字段。
6. 新增 pending transfer store。
7. 新增 UTXO reservation store。
8. 提供按 resource、network、txid 查询和清理的方法。
9. UTXO 快照替换按 resource 原子执行。
10. 提供 `commitBackfillPage()`，在同一个事务中提交历史页、cursor、complete 状态和进度。
11. 提供 `commitRecentSnapshot()`，按 resource 提交近期同步快照。
12. commit 方法支持 expected generation、cursorRevision 与 page token 校验，防止迟到响应覆盖新状态。
13. key 移除时清理该 key 所有网络的新增 store 数据。

推荐 store：

```txt
p2pkh_history_cursors
  resourceId keyPath
  generation
  cursorRevision
  nextPageToken?
  backfillComplete
  anchorTxids
  pagesSynced
  recordsSynced
  updatedAt

p2pkh_recent_sync
  resourceId keyPath
  generation
  recentConfirmedTxids
  lastCheckedAt?
  lastSuccessAt?
  updatedAt

p2pkh_pending_transfers
  txid keyPath
  resourceId index
  network index
  status
  createdAt
  updatedAt

p2pkh_utxo_reservations
  outpointId keyPath
  txid index
  resourceId index
  createdAt
  lastObservedAt?
```

旧缓存处理：

1. 旧 history id 包含数组索引，无法稳定 upsert，必须作废。
2. 余额和 UTXO 如 schema 兼容可以保留，但默认推荐清空 P2PKH 缓存后重新同步，避免混用旧 API 结果。
3. Vault 私钥不能删除或重写。

### packages/plugin-p2pkh/src/p2pkhSyncCoordinator.ts

新增 P2PKH 内部同步协调器。

必须做：

1. 按 `resourceId` 建立同步通道。
2. 实现 recent-sync 高于 history-backfill 的业务优先级。
3. 实现 backfill 每页让出，不允许长期持有资源锁。
4. 实现 resource 存在性、generation、cursorRevision 与 page token 校验。
5. 实现取消、Vault 锁定与 resource 删除防护。
6. 确保所有 history commit 经过协调器。
7. 协调批量 recent-sync 响应按 resource 分别提交。

不能做：

1. 不能直接请求 WOC。
2. 不能在等待 WOC 响应时持有 IndexedDB 写事务。
3. 不能让 background 平台理解 resource lane。
4. 不能允许 backfill 旧响应覆盖 recent-sync 新状态。

### packages/plugin-p2pkh/src/p2pkhRecentSync.ts

新增最近状态检查实现。

必须做：

1. 通过 `woc.service` 查询。
2. 按网络和批量地址分组。
3. 更新余额、UTXO、未确认历史和最新确认历史。
4. 遇到已知边界停止旧页读取。
5. 更新 pending 和 reservation。
6. 支持取消信号和进度上报。
7. 通过 `P2pkhSyncCoordinator` 提交每个 resource 的 recent snapshot。
8. 不修改 backfill cursor、complete 状态或进度。

不能做：

1. 不能读取到历史尽头。
2. 不能直接 fetch。
3. 不能绕过协调器直接写 history。

### packages/plugin-p2pkh/src/p2pkhHistorySync.ts

新增完整历史回填实现。

必须做：

1. 从 cursor 继续分页。
2. 每页通过 `P2pkhSyncCoordinator` 原子 upsert 历史并保存 cursor。
3. 没有下一页 token 时标记完成。
4. 支持取消信号和进度上报。
5. 使用最低的 `history-backfill` WOC 优先级。
6. 每页完成后检查 recentPending、暂停与取消状态，并在需要时让出。
7. 只补充旧确认历史，不写余额、UTXO、未确认历史、pending 或 reservation。

不能做：

1. 不能用余额或金额判断结束。
2. 不能每次从第一页重新开始。
3. 不能绕过协调器直接写 history。
4. 不能用旧响应降级 recent-sync 已写入的状态。

### packages/plugin-p2pkh/src/p2pkhService.ts

重组 P2PKH 服务。

必须做：

1. 移除 `WocClient` 创建逻辑。
2. 依赖注入 `WocService`、`BackgroundRegistry` 和 `BackgroundService` 所需实例。
3. 把最近同步与历史回填委托到独立模块。
4. 读取 UTXO 时叠加 reservation 过滤。
5. 提供后台任务注册所需的 run/canRun 方法。
6. 同步成功后通知 AssetProvider、TransferProvider 和页面更新。
7. 同步失败保留旧缓存并标记 stale。
8. 创建并持有 `P2pkhSyncCoordinator`，recent-sync 与 history-backfill 共用同一个实例。
9. key 移除前先取消对应 resource lane，再清理 DB。

不能做：

1. 不能让 recent-sync 与 history-backfill 各自创建独立协调器。
2. 不能在 service 之外留下直接 history 写入路径。

### packages/plugin-p2pkh/src/p2pkhAssetProvider.ts

调整资产 Provider 的同步和变化通知语义。

必须做：

1. `sync(assetId?)` 触发前台优先级最近同步，不触发完整历史回填。
2. 订阅最近同步、历史变化、pending 转账和 reservation 变化。
3. 资产余额只使用链上余额缓存，不把本地 pending 金额直接当作已确认余额。
4. 资产活动可以合并展示链上历史和本地 pending，但必须明确状态。

不能做：

1. 不能让资产平台知道后台任务 id。
2. 不能让资产平台知道 reservation。

### packages/plugin-p2pkh/src/p2pkhTransferService.ts

新增 P2PKH 转移业务服务。

必须做：

1. 提供 P2PKH 转移 prepare、sign、broadcast 或统一 submit 能力。
2. 固定使用 offer assetId 映射出来的网络。
3. 通过 Vault 闭包使用私钥。
4. 通过 `woc.service` 以 `broadcast` 优先级广播。
5. 广播成功后写 pending、写 reservation、触发最近同步。
6. 返回 Widget 展示所需的 P2PKH 专属结果。

不能做：

1. 不能让 Widget 直接操作私钥。
2. 不能在 broadcast 阶段重新猜网络。
3. 不能直接 fetch WOC。

### packages/plugin-p2pkh/src/p2pkhTransferProvider.ts

重写为新 TransferProvider。

必须做：

1. `listOffers()` 只暴露 `bsv` 和 `bsvtest` 可转移 offer。
2. offer 包含动态余额与资产状态。
3. `onChange()` 订阅 P2PKH 同步和转移状态变化。
4. `component` 指向 `P2pkhTransferWidget`。

删除：

```txt
canHandle
prepare
sign
broadcast
```

### packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx

新增完整 P2PKH 转移 Widget。

必须做：

1. 展示选中资产与动态余额。
2. 选择来源 resource。
3. 手工输入地址。
4. 可选显示联系人 picker。
5. 输入金额和 P2PKH 策略。
6. 展示 P2PKH 专属预览。
7. 提交并展示广播后详情。
8. 成功后调用 `onCompleted()`。

不能做：

1. 不能把签名实现写在组件里。
2. 不能依赖联系人插件存在。

### packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx

调整手动同步入口。

必须做：

1. 手动同步触发前台优先级最近同步。
2. 页面继续展示 resource、网络和最近同步时间。
3. 页面可以显示缓存 stale 状态，但完整后台任务详情仍由顶部任务托盘展示。

不能做：

1. 不能在页面内部创建定时器。
2. 不能从页面直接请求 WOC。

### packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx

调整历史展示。

必须做：

1. 使用稳定历史 id。
2. 展示链上确认、未确认和本地 pending 状态。
3. 数据变化时响应 P2PKH service 通知刷新。
4. 可以展示“历史仍在后台补齐”的简短状态，但不能自己执行分页循环。

不能做：

1. 不能按数组索引作为 row key。
2. 不能直接请求下一页 WOC 历史。

### packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx

调整 UTXO 展示。

必须做：

1. 显示链上 UTXO 状态。
2. 显示本地 reservation 状态。
3. 明确 reservation UTXO 不可用于新转移。

不能做：

1. 不能把 reservation 伪装成链上 spent。

### packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx

调整首页余额 Widget。

必须做：

1. 手动刷新触发前台优先级最近同步。
2. 订阅 P2PKH 变化并刷新动态余额。
3. 显示 stale 状态。

不能做：

1. 不能在 Widget 内创建周期同步定时器。

### packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx

必须做：

1. 删除 WOC Base URL 设置。
2. 只保留 P2PKH 自己拥有的策略设置，例如是否允许未确认 UTXO。
3. 页面文案指向独立 WOC 设置页时，可以提供普通导航提示，但不能重复保存同一设置。

### packages/plugin-p2pkh/src/manifest.ts

必须做：

1. 增加对 `woc.service`、`background.registry`、`background.service` 的 capability 依赖。
2. 获取 WOC 与后台任务服务并注入 P2PKH service。
3. 注册 `p2pkh.recent-sync`。
4. 注册 `p2pkh.history-backfill`。
5. 监听 Vault 解锁、锁定、key 导入、key 移除和转移完成所需事件。
6. 注册新的 P2PKH TransferProvider。
7. 删除 P2PKH WOC 设置字段注册。

不能做：

1. 不能直接 import `plugin-woc` 或 `plugin-background`。
2. 不能自己创建 interval。

### packages/plugin-transfer/src/transferFlow.ts

删除文件。

设计缘由：

新 Transfer 平台不再编排 prepare/sign/broadcast。

### packages/plugin-transfer/src/TransferPreview.tsx

删除文件。

设计缘由：

provider 专属预览属于 provider Widget。

### packages/plugin-transfer/src/TransferProviderPicker.tsx

删除或重命名为 `TransferOfferPicker.tsx`，不能保留旧 provider-only 选择语义。

### packages/plugin-transfer/src/TransferOfferPicker.tsx

新增 offer 选择组件。

必须做：

1. 展示资产、provider、余额和状态。
2. 不展示 P2PKH 专属字段。
3. offer 不可用时显示状态并禁止选择。

### packages/plugin-transfer/src/TransferPage.tsx

重写页面。

必须做：

1. 不再读取 `vault.service` 或 `asset.registry`。
2. 聚合 provider offer 并订阅变化。
3. 选择 offer 后挂载 provider Widget。
4. 提供错误边界。
5. Widget 完成后发出通用平台事件。

不能做：

1. 不能保留旧表单。
2. 不能保留旧草稿状态。

### packages/plugin-transfer/src/manifest.ts

必须做：

1. 删除对 Vault 或资产 registry 的不必要依赖。
2. 继续依赖 `transfer.registry`、route、menu 等平台 capability。

### apps/web/package.json

新增依赖：

```txt
@web-wallet/plugin-woc
@web-wallet/plugin-background
```

### apps/web/src/bootstrapPlugins.ts

调整插件顺序。

推荐顺序：

```txt
runtime 内置
vault
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

要求：

1. `woc` 必须早于 `p2pkh`。
2. `background` 必须早于 `p2pkh`。
3. `transfer` 必须早于 `p2pkh`，因为 P2PKH 要注册 TransferProvider。
4. `contacts` 可以早于 P2PKH，但 P2PKH 仍不能声明硬依赖。

### apps/web/src/shell/Topbar.tsx

必须做：

1. 从 `topbar.registry` 渲染扩展项。
2. 保留品牌和 Vault 锁定命令。
3. 不 import 后台任务插件。

### apps/web/src/styles/global.css

必须做：

1. 增加顶部状态区、后台托盘、任务列表、offer picker 和 P2PKH 转移 Widget 样式。
2. 确保桌面与移动端不重叠。
3. 使用现有颜色变量，避免新增一套不一致主题。

### scripts/check-boundaries.mjs

扩展边界检查。

必须检查：

1. 业务插件不能包含 `api.whatsonchain.com`。
2. `plugin-p2pkh` 不能直接调用 `fetch` 访问 WOC。
3. `plugin-transfer` 不能 import Vault、联系人或具体资产插件。
4. Shell 和 runtime 不能 import `plugin-background`。
5. plugin 之间仍禁止直接 import。

### README.md

更新架构说明。

必须说明：

1. `plugin-woc` 是统一 WOC 代理和限流入口。
2. `plugin-background` 是通用后台任务平台。
3. `plugin-p2pkh` 通过两类后台任务同步。
4. `plugin-transfer` 挂载 provider Widget，不解释资产转移表单。

### tsconfig.json

新增 `plugin-woc` 与 `plugin-background` project reference。

### package-lock.json

使用 workspace 安装命令更新，不手工编辑。

## 特殊情况处理

### WOC 返回 429

处理方式：

1. `plugin-woc` 统一进入 rate-limited 状态。
2. 有 `Retry-After` 时优先使用。
3. 没有时使用指数 backoff。
4. 队列中的请求保留，广播请求仍排在最高优先级，但必须等待 backoff。
5. P2PKH 保留旧缓存并显示 stale。

不能做：

1. 不能让每个 P2PKH resource 各自重试形成请求风暴。

### WOC 不可用或自定义 URL 错误

处理方式：

1. WOC 队列记录最近错误。
2. 后台任务标记 failed。
3. P2PKH 不清空旧余额、UTXO 或历史。
4. 用户修正 URL 后可以从后台托盘重试。

### 历史分页 token 失效

处理方式：

1. 不删除已有历史。
2. 清除该 resource 的失效 token。
3. 从最新页重新开始回填。
4. 依赖稳定 `resourceId + txid` 主键去重。
5. 增加 cursorRevision，使失效 token 对应的迟到响应无法提交。

原因：

重复请求旧页只会增加成本，删除已同步历史会造成更大损失。

### recent-sync 与 history-backfill 同时到达

处理方式：

1. recent-sync 标记 resource 的 `recentPending`。
2. backfill 最多完成当前页，不再请求下一页。
3. backfill 当前页响应只有在 generation、cursor、cursorRevision 仍匹配时才能提交。
4. recent-sync 提交近期状态后，backfill 从已保存 cursor 继续。
5. 两类任务只能写各自拥有的状态字段。

### backfill 响应返回时 resource 已删除

处理方式：

1. 协调器的 resource 存在性或 generation 检查失败。
2. 丢弃迟到响应。
3. 不重新创建 history、cursor、pending 或 reservation。

### 历史接口返回重复 txid

处理方式：

1. 使用稳定主键 upsert。
2. recent-sync 可以更新近期高度和确认状态。
3. backfill 只能补充缺失字段，不能降级 recent-sync 已写入的状态。
4. 不创建重复历史行。

### 地址余额为 0

处理方式：

1. 最近同步仍更新余额和 UTXO。
2. 完整历史回填仍按分页 token 继续。
3. 余额为 0 不能标记 backfill complete。

### 新地址没有历史

处理方式：

1. WOC 第一页没有记录且没有下一页 token 时，标记 backfill complete。
2. 后续最近同步仍按周期检查新交易。

### 链重组或确认状态变化

处理方式：

1. 最近同步允许更新已有 txid 的高度和状态。
2. 不把区块高度当作唯一历史主键。
3. 已确认交易重新变为未确认或消失时，保留记录并标记为需要复核，不能静默删除用户可见历史。

### 广播成功但 WOC 暂时查不到交易

处理方式：

1. 保留 pending transfer。
2. 保留输入 reservation。
3. 周期最近同步继续检查。
4. 不允许立即再次分配这些输入。

### 广播失败

处理方式：

1. 不创建成功 pending transfer。
2. 不创建长期 reservation。
3. Widget 展示英文底层错误与中文操作提示。
4. 用户可以修改参数后重新准备和提交。

### 用户打开多个标签页

处理方式：

1. 后台任务只由 leader 标签页运行。
2. WOC 请求频率通过同源锁和共享窗口协调。
3. 非 leader 标签页仍可以发起前台操作，但必须经过同一个跨标签页限流机制。

### 浏览器离线

处理方式：

1. 后台任务 `canRun()` 返回 false 或保持 queued。
2. 页面展示缓存数据并标记 stale。
3. `online` 事件触发一次最近同步。

### 浏览器节流后台定时器

处理方式：

1. 不假设 interval 精确执行。
2. 标签页恢复执行时检查 `nextRunAt`，到期任务立即入队。
3. 不能为了补偿错过次数而瞬间重复执行多次。

### 页面刷新或应用重启

处理方式：

1. 插件启动后重新注册任务定义。
2. `plugin-background` 恢复用户主动暂停状态。
3. P2PKH 从自己的历史 cursor、pending transfer 和 reservation store 恢复业务进度。
4. 未完成历史回填重新进入队列，并从已保存 token 继续。
5. 页面刷新前显示为 running 的任务不能直接假设仍在运行，必须重新调度。

### Vault 锁定

处理方式：

1. 取消 P2PKH 正在运行的后台任务。
2. 不再派生地址、读取 key 或签名。
3. WOC 服务本身可以存在，但不得由 P2PKH 继续提交需要 Vault 数据的新任务。

### 联系人插件未安装

处理方式：

1. P2PKH Transfer Widget 只显示手工地址输入。
2. 不报缺少 capability 错误。
3. 安装联系人插件后 picker 可以通过 capability 接入。

### 自定义 WOC 代理支持更高频率

处理方式：

1. 用户显式修改请求频率。
2. WOC 服务立即按新频率调度后续请求。
3. 不根据 URL 自动猜测额度。

### 未来支持 WOC API Key

处理方式：

1. 扩展 WOC 设置与 service。
2. API Key 存入 Vault 或专门 secret storage。
3. 不把 secret 放入普通 settings localStorage。

### 未来新增其他 WOC 消费插件

处理方式：

1. 扩展 `WocService` 的类型化方法。
2. 新插件通过 `woc.service` capability 使用。
3. 不允许新插件直接 fetch，也不允许复制 WOC 限流器。

### 未来新增非交易型资产转移

处理方式：

1. 新 provider 暴露自己的 TransferOffer 与 Widget。
2. `reference` 可以不是 txid。
3. Transfer 平台不增加地址、金额或 raw transaction 假设。

## 一次性实施顺序

本节只描述同一次迭代内的施工顺序，不允许分阶段上线或保留双架构。

1. 新增 contracts：WOC、后台任务、Topbar、Transfer Widget 协议。
2. 新增 runtime `topbar.registry`。
3. 新增 `plugin-woc`。
4. 新增 `plugin-background`。
5. 硬切换 `plugin-transfer` 到 offer + Widget。
6. 硬切换 P2PKH DB schema、同步服务、后台任务和转移 Widget。
7. 删除旧 WOC client 与旧 Transfer flow 文件。
8. 调整 web 装配、Topbar、样式、README、边界检查和 workspace 配置。
9. 一次性运行全部类型检查、构建、边界检查和人工验收。

## 最终验收清单

### 架构验收

1. 存在 `plugin-woc`，并提供 `woc.service`。
2. 存在 `plugin-background`，并提供 `background.registry` 与 `background.service`。
3. runtime 提供 `topbar.registry`。
4. Shell Topbar 通过 registry 渲染后台任务托盘。
5. `plugin-p2pkh` 不再包含 `wocClient.ts`。
6. `plugin-transfer` 不再包含旧 prepare/sign/broadcast flow。
7. plugin 之间没有直接 import。
8. contracts 不 import runtime、UI 或业务插件。

### WOC 验收

1. 默认 WOC base URL 为 `https://api.whatsonchain.com/v1/bsv`。
2. 默认请求频率为每秒 3 次。
3. 任意连续 1000ms 内，单标签页最多发出 3 次默认配置请求。
4. 支持 Web Locks 的浏览器中，两个同源标签页合计最多发出 3 次默认配置请求。
5. 广播、前台刷新、最近同步和历史回填都进入同一个队列。
6. 广播优先于历史回填。
7. 429 会触发统一 backoff。
8. 修改 URL 或频率后，后续请求立即使用新配置。
9. 项目业务插件中不存在旧废弃 WOC 地址接口。
10. 项目业务插件中不存在直接访问 `api.whatsonchain.com` 的代码。

### 后台任务验收

1. 顶部状态区能看到当前运行、排队和失败任务数量。
2. 展开托盘能看到任务详情。
3. 同一任务不会重叠运行。
4. 重复触发会合并为一次后续运行。
5. 任务可以暂停、恢复、取消和失败重试。
6. Vault 锁定后 P2PKH 后台任务停止。
7. 浏览器重新联网后触发一次最近同步。
8. 多标签页只运行一份周期后台任务。

### P2PKH 同步协调验收

1. recent-sync 与 history-backfill 同时处理同一 resource 时不会并发提交 history。
2. recent-sync 到达后，backfill 最多完成当前页就让出。
3. backfill 不会持有资源锁或 IndexedDB 写事务等待 WOC 响应。
4. backfill 当前页历史与 cursor 在同一个事务中提交。
5. 事务失败时不会出现“cursor 前进但历史未写入”。
6. 事务失败时不会出现“历史已写入但 cursor 未前进”的不一致提交。
7. 重试同一 backfill 页不会产生重复历史。
8. recent-sync 不写 backfill cursor、complete 状态或进度。
9. history-backfill 不写余额、UTXO、未确认历史、pending 或 reservation。
10. backfill 旧响应不会覆盖 recent-sync 写入的新状态。
11. resource 删除后迟到响应不会重新创建数据。
12. token 失效后重新扫描不会清空已有历史。
13. 新交易出现在 backfill 期间时，recent watermark 更新但 backfill cursor 不重置。
14. recent-sync 正常提交不会增加 cursorRevision 或导致有效 backfill 页无意义失效。
15. resource 删除后使用相同 resourceId 重建时，旧 generation 响应仍无法提交。

### P2PKH 历史验收

1. 新导入 resource 会注册或触发完整历史回填。
2. 历史回填从最新向最旧分页。
3. 历史回填只在没有下一页 token 时结束。
4. 余额为 0 的有历史地址仍能同步完整历史。
5. 暂停后恢复会从保存的 cursor 继续。
6. token 失效后不会删除已有历史。
7. 重复 txid 不产生重复历史记录。
8. 历史主键不包含数组索引。
9. 最近同步不会每次遍历完整历史。
10. 最近同步遇到已知边界后停止读取旧页。

### P2PKH UTXO 与转移验收

1. 最近同步定时刷新余额、UTXO、未确认历史和新确认历史。
2. WOC UTXO 快照是链上真值。
3. 广播成功后立即创建 pending transfer。
4. 广播成功后立即 reservation 已选输入。
5. WOC 暂时仍返回旧 UTXO 时，allocation 不会再次选择 reservation 输入。
6. WOC 确认交易后，pending 状态更新为 confirmed。
7. 同步失败不会清空旧余额、UTXO 或历史。
8. mainnet 与 testnet 请求、余额、UTXO、历史和广播不串网。

### Transfer 平台验收

1. Transfer 页面展示动态 offer，而不是 provider-only 列表。
2. offer 显示 provider、资产、余额和状态。
3. Transfer 页面不显示 key、地址、金额或矿工费输入。
4. 选择 P2PKH offer 后挂载 P2PKH Transfer Widget。
5. P2PKH Widget 内完成来源选择、联系人可选接入、地址、金额、预览、提交和结果展示。
6. 联系人插件缺失时 P2PKH Widget 仍可手工输入地址。
7. Transfer 页面不读取 Vault、联系人或 P2PKH service。
8. provider Widget 异常不会让整个应用崩溃。

### 边界验收

1. `plugin-p2pkh` 只通过 `woc.service` 使用 WOC。
2. `plugin-p2pkh` 只通过 background capability 注册和触发任务。
3. `plugin-background` 不知道 P2PKH 业务。
4. `plugin-woc` 不知道 P2PKH 业务。
5. `plugin-transfer` 不知道 P2PKH 业务。
6. Shell 不知道后台任务业务。
7. P2PKH 设置页不再保存 WOC URL。
8. WOC 设置页不保存 P2PKH 策略。

### 命令验收

施工完成后至少运行：

```txt
npm run typecheck
npm run build
npm run lint:boundaries
```

并分别确认新增包可以独立类型检查：

```txt
npm run typecheck -w @web-wallet/plugin-woc
npm run typecheck -w @web-wallet/plugin-background
npm run typecheck -w @web-wallet/plugin-p2pkh
npm run typecheck -w @web-wallet/plugin-transfer
npm run typecheck -w @web-wallet/web
```

如果新增自动化测试脚本，至少覆盖：

```txt
WOC 连续窗口限流
WOC 请求优先级
WOC 429 backoff
后台任务防重叠与重复触发合并
历史分页 cursor 继续与完成
backfill 页与 cursor 原子提交
recent-sync 与 history-backfill 让出协调
迟到响应 generation/cursorRevision 拒绝
历史稳定主键去重
UTXO reservation 排除
Transfer offer 动态刷新
```

### 人工验收

1. 新建或解锁 Vault。
2. 导入一把有历史的 P2PKH 私钥。
3. 顶部后台托盘显示最近同步和历史回填任务。
4. 观察历史回填持续运行，同时手动刷新余额，确认前台刷新优先完成。
5. 暂停历史回填，刷新页面后恢复，确认从 cursor 继续。
6. 使用余额为 0 但有历史的地址，确认仍能同步历史到尽头。
7. 打开两个同源标签页，确认只运行一份周期后台任务。
8. 在两个标签页同时触发请求，确认 WOC 默认频率合计不超过每秒 3 次。
9. 选择 BSV 或 BSV Testnet transfer offer，确认挂载 P2PKH Widget。
10. 通过联系人或手工地址完成一次转移。
11. 广播成功后立即再次准备转移，确认已使用输入不会被重复选择。
12. 断网后观察 stale 状态，重新联网后确认自动触发最近同步。

## 完成标准

本次施工完成后，项目必须只有一条 WOC 访问路径：

```txt
业务插件 -> woc.service -> 统一请求队列 -> WOC
```

P2PKH 必须只有两类后台同步语义：

```txt
p2pkh.recent-sync
  快速刷新最近状态，遇到已知边界停止。

p2pkh.history-backfill
  按分页 token 持续补齐完整历史，直到真正尽头。
```

Transfer 平台必须只有一种接入语义：

```txt
TransferProvider -> 动态 TransferOffer -> Provider Transfer Widget
```

不再允许旧 WOC client、旧 Transfer prepare/sign/broadcast 平台流程、余额为零历史终止规则或不可观察的 P2PKH 后台同步继续存在。
