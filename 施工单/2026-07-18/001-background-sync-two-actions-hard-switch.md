# 001 后台同步“立即同步一次 / 取消本次”双动作硬切换施工单

## 0. 目标、范围与执行原则

本单承接并修正 [002 统一资产后台同步、DB 快照与可配置频率硬切换一次性迭代施工单](../2026-07-17/002-unified-asset-background-sync-hard-switch.md)。该单已把资产页面收敛为 DB 读取与 `onChange` 刷新；本单只重做**后台任务对用户暴露的控制语义**，不把网络能力放回页面。

目标是让用户只需要理解三件事：

1. 同步始终由后台维持，频率由“资产余额同步间隔”设置决定。
2. 任务未在执行时，可以“立即同步一次”。
3. 任务正在执行或排队时，可以“取消本次同步”。

本单是一次性**硬切换**：不保留“暂停 / 继续 / 重试 / 单任务持久化启停”的兼容 UI、API、状态或本地存储。一次发布完成 contract、后台服务、托盘、任务实现、测试与历史偏好迁移；禁止灰度、双按钮、旧 API wrapper 或按页面逐步迁移。

适用范围是 `plugin-background` 当前注册的 P2PKH recent-sync、P2PKH history-backfill、BSV-21 sync、STAS sync，以及以后进入通用后台任务托盘的同步任务。它不改变：页面零网络边界、WOC 限流、余额 DB snapshot 真值、keyspace 切换取消屏障、资产同步间隔设置的归属。

## 1. 缘由

现有托盘同时暴露“立即运行、取消、重试、暂停、继续”：

- `立即运行`只绕过冷却；当 `canRun()` 为 false 时任务回到 `idle`，没有说明为什么未执行，用户感觉按钮无效。
- `暂停`不只是停止当前请求，而是持久化禁用任务并取消后续周期；`继续`只恢复定时器并计算下次运行，**不会**立即同步。两者都是调度器内部概念，而不是用户想要的同步概念。
- 失败任务会停在 `failed`，只能靠“重试”重新运行。这把“自动同步一直存在”的承诺变成了“用户要管理失败任务”。

用户不应管理轮询开关。正确模型是：后台始终存在；用户只可取消当前一轮，或要求后台尽快做一轮；不满足运行条件时系统必须告知等待原因。

## 2. 切换后的最终模型

### 2.1 用户动作与可见状态

| 后台状态 | 托盘展示 | 唯一动作 | 结果 |
|---|---|---|---|
| `idle`（含上次失败后等待下次周期） | 等待同步；显示下次时间、上次错误（如有） | 立即同步一次 | 绕过普通冷却，进入 queued/running 或明确 blocked |
| `blocked` | 等待条件；显示原因 | 不显示伪“开始成功”；条件满足后由后台触发 | 例如等待解锁、密钥初始化、无 active key |
| `queued` / `running` | 同步中 / 排队中 | 取消本次同步 | abort 当前/排队实例，清空 rerun，回到等待下次周期 |

`failed`、`paused` 不再是用户可操作的稳态：

- 网络或业务错误保存在 `lastError` / `lastAttemptAt` 中；task 状态回到 `idle`，正常周期仍继续。下一次成功必须清掉 `lastError`。
- “暂停”状态及 task-level `enabled` 偏好完全删除，不存在“继续”。
- P2PKH full history backfill 仍可从已持久化 cursor 续跑，但用户只能取消当前轮；不得提供 pause/resume。它不是余额轮询，因此不应被硬塞进 `asset-holdings` 周期。

### 2.2 对外服务语义

保留两个用户可调用的通用操作：

```ts
runNow(taskId: string): void
cancel(taskId: string): Promise<void>
```

- `runNow` 是托盘唯一的手动动作；它等价于把 `manual` 请求交给 leader，绕过普通 2 分钟事件冷却，但不绕过安全/就绪门禁。
- `cancel` 只中止当前 instance，不会禁用任务、不会取消未来定时、不会删除 snapshot/cursor，也不会让页面回退为零余额。
- 业务插件继续可用内部 `trigger(taskId, reason)` 发领域事件；它不是 UI 控制 API，也不代表页面可以请求网络。
- 同一 task 正在 `running`/`queued` 时，不显示第二个“立即同步一次”，不排队额外的用户手动 run。用户若需要中断后重做，先取消，状态回到 idle 后再点立即同步一次。

### 2.3 就绪门禁和失败必须可见

`canRun(): boolean` 改为可携带展示原因的就绪结果；建议 contract：

```ts
type BackgroundRunEligibility =
  | { ready: true }
  | { ready: false; reason: I18nText; retryOn: "unlock" | "key-ready" | "interval" };
```

BackgroundService 对 `ready: false` 必须写入 snapshot 的 `blockedReason`、状态 `blocked`，并保留/计算下一次检查时间；不得静默返回 idle。P2PKH、BSV-21、STAS 至少覆盖：Vault 未解锁、keyspace 初始化中、没有 active key。业务任务可以有额外原因，但不得把网络失败伪装成 blocked。

## 3. 必须怎么做

### 3.1 平台调度规则

1. 所有注册 task 默认持续启用；删除 `defaultEnabled`、`enabled`、`background.enabled` 和 pause/resume action。
2. 周期任务在成功、取消、门禁阻塞、网络失败后都计算下一次正常运行时间。取消时以取消完成时为新周期起点；失败时以失败完成时为新周期起点，保留错误信息。
3. `runNow` 仅绕过普通冷却，不绕过 `BackgroundRunEligibility`。点击后必须立刻通过 snapshot 显示 `queued`、`running` 或 `blocked`，不能无状态变化。
4. 失败后不要保留“重试”动作：用户可用“立即同步一次”提前发起；否则等下一周期。WOC 自己的 `Retry-After` / queue 限流仍由 WOC 层负责，后台不得另造请求循环。
5. `cancel` 必须 abort、等待旧 `runPromise` 退出、清掉 `rerunRequested`，再 schedule next；取消后不得写 `lastCompletedAt`、不得发成功 data-changed。
6. leader/follower 语义不变：follower 点击 runNow/cancel 只转发给 leader；leader 的 snapshot 广播是 UI 唯一反馈。不得在 follower 本地启动第二个任务。

### 3.2 托盘规则

1. idle 与带有 `lastError` 的 idle 都显示“立即同步一次”。
2. blocked 显示等待原因与下次检查/自动同步时间；没有“暂停”“继续”“重试”。必要时可以让“立即同步一次”保留为 disabled 按钮并附同一原因，但不能制造一次无反馈的点击。
3. queued/running 只显示“取消本次同步”。
4. 状态文案不得出现“已暂停”“继续”“重试失败任务”；失败信息显示为“上次同步失败：…；下次自动尝试 …”。
5. 任务动作只存在于 `BackgroundTray`；资产页、首页 widget、P2PKH 页、token 页仍然没有网络或同步按钮。

### 3.3 历史偏好迁移

启动 BackgroundService 时执行一次性 migration：

1. 读取旧 `localStorage["background.enabled"]` 仅用于诊断日志，不能继承其中的 `false`。
2. 无论旧值为何，所有已注册 task 按新 contract 进入持续调度；清除该 key。
3. 删除后 reload 不得重新生成 `background.enabled`；不能保留空对象作为伪兼容。
4. 旧 snapshot/跨标签 action 若包含 `pause`、`resume`、`retry`，接收端直接忽略并记录兼容期告警；同一发布版本的 UI/contract 不得再发这些 action。

## 4. 明确不能怎么做

- 不能把“暂停”改名为“取消”却继续持久化 `enabled=false`；取消只限当前轮。
- 不能保留“继续”并让它只恢复下次定时；这正是本单要消除的误导。
- 不能让“立即同步一次”绕过 Vault、active key、keyspace 初始化等门禁，或为了按钮可见强行发 WOC 请求。
- 不能在页面、widget、provider read API 中为“立即查看结果”增加 fetch、timer、`backgroundService.trigger` 或轮询。
- 不能让失败 task 永久停在 `failed`，再以“重试”要求用户接管调度。
- 不能在 P2PKH、BSV-21、STAS 各自保存暂停/失败重试 timer、localStorage 时间戳或手工轮询；周期、冷却、自动重试、跨标签协调只属于 BackgroundService。
- 不能因取消、blocked 或失败清空已提交的 snapshot，也不能把“无首个 snapshot”显示为零金额。

## 5. 特殊情况与预定处理

| 情况 | 规定处理 |
|---|---|
| Vault 锁定 | task 为 `blocked`，显示“等待解锁”；不发网络。解锁和资源 rehydrate 后由既有领域事件请求后台运行。 |
| keyspace 初始化/无 active key | task 为 `blocked`，显示相应原因；key ready/切换完成后再触发，绝不写错 key namespace。 |
| 用户在运行中点击取消 | abort 并等待退出；保留已原子提交的旧/部分 snapshot，不发本轮成功通知；下次周期仍存在。 |
| 用户在排队中点击取消 | 取消排队或合并 rerun，不能让 microtask rerun 漏网；状态回到 idle。 |
| manual run 时普通冷却未过 | manual 必须绕过冷却；普通领域事件仍合并。 |
| manual run 与已有 running 重叠 | 不显示第二个立即同步；只允许取消。不得偷偷形成无限 rerun。 |
| 网络失败、429、超时 | 保留 snapshot 和 last error；后台按下一个正常周期再次尝试。WOC 的 Retry-After 和限流保持生效。 |
| active key 切换/删除/锁屏 | 继续走 keyspace 的 cancelByKey -> await old task -> close namespace 屏障；不得由用户 cancel 语义替代该安全屏障。 |
| history-backfill 中途取消 | cursor 保留；不出现 pause/resume。后续由领域触发或托盘“立即同步一次”继续，不将其加入余额周期。 |
| follower tab 操作 | 仅转发 leader，UI 等 snapshot 更新；不能乐观显示 running，更不能在 follower 发网络。 |

## 6. 文件级施工清单

### A. Contract 与跨标签 action

| 文件 | 必做修改 |
|---|---|
| `packages/contracts/src/background.ts` | 删除 `paused`/`failed` 作为稳态控制语义、`defaultEnabled`、snapshot `enabled`、`pause()`、`resume()`、`retry()`；新增 `blocked`、`BackgroundRunEligibility`、snapshot `blockedReason`/`lastAttemptAt`；新增 `runNow()` 作为 UI 手动 API。保留 `trigger()` 供后台领域事件使用，明确禁止页面调用。 |
| `packages/plugin-background/src/backgroundService.ts` | 删除 `ENABLED_PREF_KEY`、enabledOverrides、pause/resume/retry 及其 leader action；实现旧偏好清除 migration；把 canRun 改为 eligibility 处理；失败后回 idle 并保留错误、安排下次周期；实现 `runNow` 的 manual leader 转发与 queued/running/blocked snapshot；确保 cancel 只取消本轮。 |
| `packages/plugin-background/src/index.ts` | 若 service/export 类型因 contract 更名而变化，同步导出，不保留旧 API alias。 |

### B. 托盘与文案

| 文件 | 必做修改 |
|---|---|
| `packages/plugin-background/src/BackgroundTray.tsx` | 删除 Pause/Play/RotateCw 图标及暂停、继续、重试分支；按第 2.1 节只渲染“立即同步一次”或“取消本次同步”；渲染 blocked 原因、上次错误与下次自动尝试。不得用本地 optimistic state 假装任务已开始。 |
| `packages/plugin-background/src/manifest.ts` | 删除 pause/resume/retry/paused/failed 的 i18n key；新增 run once、cancel current sync、waiting for condition、last sync failed、next automatic attempt 等中英文 key。 |
| `packages/plugin-background/src/BackgroundSettingsPage.tsx` | 保留并明确“资产余额同步间隔”是唯一持久化用户设置；不得加入“关闭自动同步”或单任务开关。文案说明立即同步只执行一轮。 |

### C. 资产同步任务的门禁与失败收口

| 文件 | 必做修改 |
|---|---|
| `packages/plugin-p2pkh/src/p2pkhService.ts` | recent/backfill task 的 canRun 改为结构化 blocker；移除 `backfillPaused` 及其所有分支；取消后保持 cursor/snapshot、回到自动/等待态；任务失败交由平台保留 error 和下一周期，不再把用户引向 retry/resume。保留 vault/keyspace rehydrate 后的后台 trigger。 |
| `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts` | 删除 `pausedRef` 参数、`paused` state 和 resume 相关注释/逻辑；只接受 AbortSignal 取消；cursor 语义不变。 |
| `packages/plugin-token-bsv21/src/bsv21Sync.ts` | canRun 改为返回统一 eligibility，并继续保持 cancel/active-key 双检查及 snapshot notifier 语义。 |
| `packages/plugin-token-stas/src/stasSync.ts` | 与 BSV-21 完全同构地改用统一 eligibility。 |
| `packages/plugin-token-bsv21/src/manifest.ts`、`packages/plugin-token-stas/src/manifest.ts` | 删除已失效的 task `defaultEnabled` 断言/文档；保留 resource-ready、first-sync、settings-change 的后台触发，不添加 UI 同步入口。 |

### D. 测试与清理

| 文件 | 必做修改 |
|---|---|
| `packages/plugin-background/src/backgroundService.test.ts` | 删除 pause/resume/retry/enabled 旧用例；新增 manual 绕过冷却、manual 被门禁明确 blocked、取消后下一周期仍存在、失败后自动下一周期、旧 `background.enabled` 被清除、follower runNow/cancel 转发、运行中不产生第二个 manual rerun。 |
| `packages/plugin-p2pkh/src/p2pkhService.test.ts` | 删除 backfill paused/resume 断言；覆盖 Vault 锁定/keyspace 初始化的 blocked reason、取消 recent/backfill 后无 notifier 且 cursor 保留、解锁/资源就绪后可重新排入。 |
| `packages/plugin-token-bsv21/src/bsv21Sync.test.ts`、`packages/plugin-token-stas/src/stasSync.test.ts` | 补 canRun eligibility 的 ready 与三类 blocked reason；现有 abort/key-switch/no-notifier 回归必须保留。 |
| `packages/plugin-token-bsv21/src/manifest.test.ts`、`packages/plugin-token-stas/src/manifest.test.ts` | 移除 `defaultEnabled` mock 期望，确认 resource-ready 是唯一 token 同步入口，页面/解锁/active change 不直连网络。 |
| 全仓 `rg` 清理 | 生产代码不得残留 `background.enabled`、`pause(`、`resume(`、`retry(`、`state === "paused"`、`defaultEnabled`（后台 task 定义层）或“暂停/继续/重试”托盘 i18n。插件 manifest 的 `meta.defaultEnabled` 是插件启用概念，不在本单删除范围。 |

## 7. 施工顺序（一次合入，不分阶段发布）

1. 先改 `background.ts` contract 与 `backgroundService.ts` 状态机、leader action、历史偏好 migration。
2. 同一变更中改 BackgroundTray/manifest/BackgroundSettingsPage，确保 UI 不可能调用已删除 API。
3. 改 P2PKH recent/backfill、BSV-21、STAS 的 eligibility 和取消/失败衔接；同步删除 backfill paused 语义。
4. 更新所有 mock、unit test 与 i18n；删除旧 API 和字符串残留。
5. 最后执行全量类型检查、定向测试和全量测试；任何旧 pause/resume 生产残留或 task 停在 failed/paused 都视为未完成，不允许用 adapter 兼容。

## 8. 最终验收清单

### 行为验收

- [ ] 顶部每个未运行资产同步任务只显示“立即同步一次”；没有暂停、继续、重试。
- [ ] 顶部每个 queued/running 任务只显示“取消本次同步”；取消后自动同步仍在下一个设置周期继续。
- [ ] “立即同步一次”在 ready 时立即变为 queued/running，绕过普通冷却；不会等待下次 interval。
- [ ] Vault 锁定、keyspace 初始化、无 active key 时，点击/触发后显示明确 blocked 原因，不发网络、不静默回 idle。
- [ ] 任务失败后保留旧 DB snapshot 与 last error，自动计算下次尝试；没有 failed 死状态和 retry 按钮。
- [ ] 取消请求、取消后 resolve、取消后抛 AbortError、切 key cancel 四种路径都不会发成功 data-changed 或错误 key 的通知。
- [ ] history-backfill 无 pause/resume；取消后 cursor 保留，随后运行可正确续传。
- [ ] follower tab 的立即同步/取消不会本地发网络，只由 leader 执行并通过 snapshot 更新 UI。
- [ ] 页面、widget、provider read API 仍只读 DB；没有新增 fetch、WOC、timer 或同步按钮。

### 静态与迁移验收

- [ ] `rg` 证明后台 task 生产代码没有 `background.enabled`、`pause(`、`resume(`、`retry(`、`state === "paused"`、`enabledOverrides` 残留；插件 manifest `meta.defaultEnabled` 除外。
- [ ] 有旧 `background.enabled` 的浏览器启动后，所有任务回到持续调度，旧 key 被删除且 reload 后不重建。
- [ ] `BackgroundTaskSnapshot` 不再暴露用户暂停/启用字段；blocked/error/nextRunAt 足以解释未运行原因。

### 验证命令

- [ ] `pnpm typecheck`
- [ ] `pnpm vitest run packages/plugin-background/src/backgroundService.test.ts packages/plugin-p2pkh/src/p2pkhService.test.ts packages/plugin-token-bsv21/src/bsv21Sync.test.ts packages/plugin-token-stas/src/stasSync.test.ts packages/plugin-token-bsv21/src/manifest.test.ts packages/plugin-token-stas/src/manifest.test.ts`
- [ ] `pnpm test`
- [ ] `pnpm lint:boundaries`；若失败，输出必须区分本单引入的问题与既有违反项。

验收结论只有在上述行为、静态扫描、类型检查和定向测试全部通过后才能给出。任何“保留 pause/resume 但不在 UI 显示”“失败后仍需用户 retry”“点击立即同步后无状态/原因反馈”的实现，均不符合本单。
