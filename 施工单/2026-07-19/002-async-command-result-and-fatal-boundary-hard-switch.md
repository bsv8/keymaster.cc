# 002 异步命令结果与致命错误边界硬切换一次性迭代施工单

## 参考文档与代码

本单的实现、联调和验收以下列文档与代码为准：

- `施工单/2026-07-18/001-background-sync-two-actions-hard-switch.md`
- `施工单/2026-07-18/002-shared-vault-session-and-sync-coordinator-hard-switch.md`
- `packages/contracts/src/background.ts`
- `packages/contracts/src/sessionCoordinator.ts`
- `apps/web/src/keymasterSessionCoordinatorClient.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.ts`
- `packages/plugin-background/src/backgroundServiceCoordinator.ts`
- `packages/plugin-background/src/BackgroundTray.tsx`
- `apps/web/src/installGlobalFatalHandlers.ts`
- `apps/web/src/fatalErrorStore.ts`
- `apps/web/src/AppCrashBoundary.tsx`
- `apps/web/src/main.tsx`

发生冲突时，本单只优先于上述施工单中关于 **tab facade 的异步返回值、命令
ack 解释、UI 命令调用和 `unhandledrejection` 归类** 的定义。SharedWorker 是
唯一会话与同步执行者、任务快照是 UI 真值、私钥不离开 Worker 等既有约束继续
有效。

---

## 1. 背景与问题

2026-07-19 的生产构建曾在 Vault 锁定时出现如下路径：

```text
业务领域事件
  -> BackgroundService.trigger(taskId, reason)
  -> Coordinator RPC: background.trigger
  -> ack: { status: "blocked", reason: "Vault is locked" }
  -> facade 将 ack 转为 throw Error("Trigger task failed: blocked")
  -> 调用方按 trigger 的 void 契约没有 await / catch
  -> global.unhandledrejection
  -> 顶级 fatal handler 接管，整个 Keymaster 页面退出正常路径
```

`blocked` 在这里不是程序崩溃，而是安全门禁的正常业务结果：Vault 未解锁、
keyspace 尚未就绪、没有 active key 或任务当前不可执行时，Worker 必须拒绝
网络任务，并通过任务快照说明原因。

根因并非单一 `throw`，而是三层契约互相矛盾：

1. `BackgroundService.trigger()` 与旧 `runNow()` 声明为 `void`；调用方合理地
   以 fire-and-forget 方式调用。
2. Coordinator RPC 天然是异步的，并返回可判别 ack；facade 却把正常 ack
   转换为 rejected Promise。
3. 浏览器全局 fatal handler 正确地把来自同源 bundle 的未处理 rejection 当成
   程序错误。因此一个未被消费的正常业务结果被错误升级为全站 fatal。

当前 `backgroundServiceCoordinator` 已做临时止血：内部 `trigger()` 吞掉
`blocked` 的 rejection。该保护必须保留到本单硬切换完成；但它不是最终设计，
因为它仍会丢失用户命令的可见结果，也没有统一其他 facade 的异步边界。

---

## 2. 目标、范围与非目标

### 2.1 目标

完成后，系统必须满足：

1. **正常命令结果永不以 rejection 表达。** `blocked`、`locked`、
   `not-ready`、`stale-epoch`、`validation-error`、`already-running`、网络/port
   不可用等都必须由可判别结果返回；它们不得触发 `unhandledrejection`。
2. **领域触发与用户命令严格分层。** `trigger()` 只用于领域事件，始终
   fire-and-forget；`runNow()`、`cancel()`、设置保存等用户动作必须返回显式
   `Promise<…Result>`，UI 必须消费结果。
3. **任务状态的唯一展示真值仍是 Worker snapshot。** ack 只回答“这次命令有
   没有被接受/拒绝以及为什么”；它不伪造同步完成、余额、UTXO 或 token 数据。
4. **所有跨 Worker facade 采用同一命令结果模式。** 至少覆盖 background、
   Vault、keyspace、crypto 的页面侧调用；不允许每个插件自行 `try/catch` 后猜测
   `Error.message`。
5. **fatal 边界保持严格。** 真正未处理的同源程序异常仍进入 fatal page；不得
   通过在 global handler 按错误字符串白名单过滤来掩盖契约问题。
6. **可观测而不崩溃。** transport 故障和异常 ack 要进入结构化非致命诊断，并使
   facade snapshot 收敛到 booting/locked/相应可恢复状态。

### 2.2 本单范围

- SharedWorker Coordinator client、其 RPC transport 与 tab facade；
- `BackgroundService` 的 `trigger`、`runNow`、`cancel`、设置更新；
- Vault/keyspace/crypto 的 command-returning public facade；
- React 事件回调、插件 MessageBus/订阅回调中的异步调用规范；
- fatal handler 的回归测试与全仓静态扫描。

### 2.3 非目标

- 不改变后台任务调度、冷却、eligibility、DB 原子提交或 `blocked` 的业务含义；
- 不弱化 SharedWorker、epoch、active-key 或私钥边界；
- 不把所有应用错误降级为 toast，也不修改 fatal crash page 的展示文案；
- 不为旧的 `void runNow()`、会 throw 的 facade 保留 adapter、feature flag 或
  隐式兼容路径；这是 source-level hard break。

---

## 3. 最终模型（唯一语义）

### 3.1 三类异步边界

| 类别 | 适用 API | 返回值 | 调用方责任 | 可否 reject |
|---|---|---|---|---|
| 领域通知 | `trigger()`、资源就绪/解锁/active-key 事件 | `void` | 不等待；观察 snapshot | 不可 |
| 用户命令 | `runNow()`、`cancel()`、保存设置、锁定/切换 key | `Promise<CommandResult>` | 显式消费结果并更新临时 UI | 不可 |
| 值操作 | 签名、导出、读取需要结果的 vault/crypto 操作 | `Promise<ValueResult<T>>` | 显式处理成功/失败 | 不可（业务/transport 均编码为结果） |

这里的“不可 reject”指 facade 的**公共生产 API**。Coordinator client 的低层
`MessagePort` 请求实现可因 port 被关闭或超时而 reject，但该 rejection 必须在
client 的单一 normalize 边界被捕获，不能泄漏给 plugin、React handler 或
MessageBus handler。

未被捕获的类型错误、代码 bug、渲染错误、违反不变量的异常仍然是程序异常，继续
由既有 fatal path 接管。不能为了满足本单而在最外层加 `catch(() => undefined)`。

### 3.2 通用结果类型

在 `packages/contracts/src/sessionCoordinator.ts` 定义 Coordinator 层通用结果。
`CoordinatorCommandAck` 保留为 Worker wire protocol 的业务确认；新增 tab facade
使用的归一化结果，避免调用方区分“Worker 返回 error”和“transport 先断开”。

```ts
export type CoordinatorTransportFailure = {
  status: "transport-error";
  message: string;              // 已脱敏、可显示的简短描述
  retryable: boolean;
};

export type CoordinatorCommandResult =
  | CoordinatorCommandAck
  | CoordinatorTransportFailure;

export type CoordinatorValueResult<T> =
  | { status: "ok"; value: T; sessionEpoch: SessionEpoch }
  | Exclude<CoordinatorCommandResult, { status: "ok" }>;
```

约束如下：

- `accepted` 只表示 Worker 已接受/入队，绝不表示后台任务已完成。
- `blocked` 必须带稳定的原因 code 与可本地化 fallback，不能只靠英语错误字符串。
  `CoordinatorCommandAck` 的 `reason: string` 改为 `{ key: string; fallback: string }`。
- `validation-error` 是调用参数不合法的预期结果；不得 `throw`。
- `error` 是 Worker 已受控捕获的操作失败；message 脱敏后可诊断，不能含密码、
  私钥、完整 transaction、资产 payload 或 stack。
- `transport-error` 只由 client normalize 层产生。它必须让 client 清除陈旧的
  unlocked cache，并启动既有 reconnect/hello 流程；不得假装命令已经 accepted。
- 业务状态不能通过 `Error.message`、`instanceof Error` 或字符串前缀判断。

`background.ts` 另外导出窄化后的公共类型，而不是要求后台插件依赖整个
Coordinator contract：

```ts
export type BackgroundCommandResult =
  | { status: "accepted" }
  | { status: "already-running" }
  | { status: "blocked"; reason: I18nText }
  | { status: "locked" | "not-ready" | "stale-epoch" }
  | { status: "validation-error" | "error" | "transport-error"; message: string };
```

### 3.3 BackgroundService 最终契约

```ts
export interface BackgroundService {
  listSnapshots(): BackgroundTaskSnapshot[];
  onChange(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void;

  /** 仅领域事件使用；请求和失败都由 snapshot/诊断通道表达。 */
  trigger(taskId: string, reason?: string): void;

  /** UI 手动动作；永远 resolve 为可判别结果。 */
  runNow(taskId: string): Promise<BackgroundCommandResult>;

  /** UI 手动动作；永远 resolve 为可判别结果。 */
  cancel(taskId: string): Promise<BackgroundCommandResult>;

  getScheduleSettings(): BackgroundSyncSettings;
  updateScheduleSettings(settings: BackgroundSyncSettings): Promise<BackgroundCommandResult>;
  dispose?(): void;
}
```

`trigger()` 不可改为 `Promise`，也不可由页面调用。它只将 domain intent 投递给
Coordinator；Worker 的 snapshot event 负责广播 queued/running/blocked/idle。
底层 RPC 失败时，facade 只写非致命诊断并促使 client 的连接状态收敛，绝不让
plugin 生命周期回调产生 rejected Promise。

`runNow()`、`cancel()`、设置更新不可再宣称 `void`。它们对 UI 提供一次性的
ack；UI 用该 ack 清除“请求中”状态、提示明显的不可恢复请求错误，随后仍以
snapshot 作为任务状态真值。`blocked` 不是 toast 错误：托盘保持/展示同一条
blocked reason。

### 3.4 Client normalize 边界

`KeymasterSessionCoordinatorClient` 必须新增一个私有的、唯一的 command helper：

```ts
async function requestCommand(request: CoordinatorClientRequest): Promise<CoordinatorCommandResult> {
  try {
    return (await sendRequest(request)).ack;
  } catch (cause) {
    transitionToDisconnectedSnapshot(cause);
    reportRecoverableCoordinatorFailure(request.kind, cause);
    return { status: "transport-error", message: "Coordinator connection lost", retryable: true };
  }
}
```

所有 command 方法都只能通过该 helper 返回结果。`hello`/connect 启动过程可继续
以 rejection 向 bootstrap 报告真正的启动失败；但已交给插件和 UI 的 command
方法不得直接暴露 `sendRequest()`。

对于 value operation，client 用相同 helper 接住 transport，再验证 ack 与
payload 的匹配：例如 `crypto.signDigest` 只有 `status === "ok"` 且
`cryptoResult.type === "signDigest"` 才返回 value；不匹配返回脱敏
`{ status: "error", message: "Invalid Coordinator response" }` 并记录安全诊断。

### 3.5 UI 与订阅回调规则

React、DOM、MessageBus、event emitter 的回调不得直接返回一个可能 reject 的
Promise。统一写法如下：

```ts
const requestRunNow = (taskId: string) => {
  void service.runNow(taskId).then((result) => {
    // 只处理一次性 ack；snapshot 才是任务状态真值。
    applyRunNowResult(taskId, result);
  });
};
```

由于公共 API 永远 resolve，上例 `.then()` 不需要第二个 rejection handler。若
`applyRunNowResult` 自身抛错，这是同源程序错误，应照常由 global fatal handler
发现，不能吞掉。

禁止以下写法：

```ts
onClick={() => service.runNow(id)}             // 丢弃用户命令结果
onClick={() => service.cancel(id)}             // 丢弃可恢复失败
void service.runNow(id).catch(() => undefined) // 掩盖 facade 违反契约
async () => { await service.runNow(id); }      // 不检查 result
```

领域订阅中允许：

```ts
messageBus.subscribe("vault.unlocked", () => {
  backgroundService.trigger("p2pkh.recent", "vault.unlocked");
});
```

但 `trigger` 实现内部必须自行接住 transport rejection；订阅回调不能自行将它
包装成 Promise，也不允许按 `blocked` 报 fatal。

### 3.6 Fatal、recoverable error 与诊断边界

```text
预期业务结果 / transport 故障
  -> CommandResult
  -> facade 更新 cache / snapshot，记录 recoverable diagnostic
  -> UI 提示或等待快照；应用继续运行

未捕获的程序异常 / 违反不变量 / bootstrap 失败
  -> global error 或 global unhandledrejection
  -> fatalErrorStore
  -> fatal crash page
```

`installGlobalFatalHandlers.ts` 不得新增 `"blocked"`、`"locked"`、
`"transport"` 等 message allowlist。正确性来自命令 API 不产生这些 rejection，
不是让 fatal handler 猜测某个 rejection 是否安全。

recoverable diagnostic 至少记录：command kind、结果 status、session epoch、
task id（如有）、连接状态和安全显示的 public-key hash；不得记录敏感 payload。
诊断落点使用现有 `PluginLogger`/安全日志基础设施，不得依赖 `console.error` 作为
唯一产品路径。

---

## 4. 状态与交互规定

| 情况 | command result | snapshot / client 收敛 | UI 行为 | fatal |
|---|---|---|---|---|
| Vault 锁定时 `runNow` | `blocked` + `background.blocked.unlock` | task 保持/变为 blocked | 停止请求中，展示等待解锁 | 否 |
| 任务已经 running | `already-running` | running snapshot 不变 | 停止请求中，展示取消动作 | 否 |
| task id 不存在 | `validation-error` | snapshot 不伪造 | 停止请求中，显示通用请求失败 | 否 |
| epoch 已变化 | `stale-epoch` | client 以新 snapshot 重新渲染 | 丢弃旧 UI intent | 否 |
| Worker 返回操作错误 | `error` | 保留最后可靠 snapshot | 显示脱敏失败信息/允许按既有规则重试 | 否 |
| port 超时/关闭 | `transport-error` | client 清空 unlocked cache，reconnect/hello | 停止请求中，回到连接/锁定状态 | 否 |
| domain `trigger` 收到 blocked | 无返回值 | Worker 广播 blocked 或已存在的 snapshot | 不弹窗；正常展示任务状态 | 否 |
| facade 内部类型错误、错误访问字段 | 无 | 不得吞掉 | 不保证 | 是 |
| Worker bootstrap 失败、协议响应违反安全不变量 | 受控 fatal / bootstrap reject | app 不启动正常路径 | fatal crash page | 是 |

所有 command result 都必须在一次微任务/transport response 后使 UI 的本地 pending
状态结束。不得出现按钮永久显示“正在请求同步…”，也不得通过本地 optimistic
状态伪造 queued/running。

---

## 5. 文件级施工清单

### A. Contract 与 Coordinator transport

| 文件 | 必做修改 |
|---|---|
| `packages/contracts/src/sessionCoordinator.ts` | 新增 `CoordinatorTransportFailure`、`CoordinatorCommandResult`、`CoordinatorValueResult<T>`；将 blocked reason 收敛为 `I18nText` 等价的 structured-clone 类型；更新 request/response 注释，明确 command 不以 exception 表达业务失败。 |
| `packages/contracts/src/background.ts` | 将 `runNow`、`cancel`、`updateScheduleSettings` 改为返回 `Promise<BackgroundCommandResult>`；`trigger` 保持 `void` 并注明只限领域事件；导出窄化结果类型。不得保留旧 overload。 |
| `packages/contracts/src/vault.ts`、`keyspace.ts`、`activeKeyCrypto.ts` | 所有跨 Coordinator 的可恢复 command/value API 改为结果联合类型；区分安全不变量异常与可恢复业务/transport 结果。 |
| `apps/web/src/keymasterSessionCoordinatorClient.ts` | 新建唯一 `requestCommand`/`requestValue` normalize helper；除 connect/hello bootstrap 外，所有对外 command/value 方法都不得直接 reject `sendRequest()` 的失败。transport failure 必须更新本地 snapshot 和 reconnect 状态。 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 每个预期拒绝路径返回结构化 ack，尤其 `blocked` 使用统一 i18n reason；不得为正常门禁 `throw`。协议不变量/初始化失败继续走明确 error/fatal 路径。 |
| `apps/web/src/keymasterSessionCoordinatorClient.test.ts` | 现有“`backgroundRunNow` timeout rejects”测试改为断言 `transport-error`、状态回到 booting/disconnected、无 unhandled rejection；补全部 command/value normalize 测试。 |

### B. Background facade 与托盘

| 文件 | 必做修改 |
|---|---|
| `packages/plugin-background/src/backgroundServiceCoordinator.ts` | 移除临时的吞错式实现，改为调用归一化 client API：`trigger` 自行消费并记录结果；`runNow`/`cancel`/settings 返回明确 result，绝不 `throw` 业务 ack。 |
| `packages/plugin-background/src/backgroundService.ts` | 本地非-Coordinator 实现同步匹配新 contract：所有用户 command resolve result；不可让本地 task 异常泄漏为未处理 Promise。 |
| `packages/plugin-background/src/BackgroundTray.tsx` | `requestRunNow`、取消、设置保存显式消费 result。`accepted`/`already-running` 等待 snapshot；`blocked` 用 snapshot reason；`validation-error`/`error`/`transport-error` 清除 pending 并显示可恢复提示。不得裸调用 Promise。 |
| `packages/plugin-background/src/BackgroundSettingsPage.tsx` | 保存设置改为 result-aware pending/error UI；连接失败不把选择误标为已保存。 |
| `packages/plugin-background/src/manifest.ts` | 补齐 command failure 的中英文可访问文案；接口 mock 更新为新 result 类型，禁止把 Coordinator client `as never` 作为逃避类型检查的手段。 |
| `packages/plugin-background/src/backgroundServiceCoordinator.test.ts`、`backgroundService.test.ts` | 覆盖 accepted、blocked、already-running、validation-error、transport-error 及底层 rejection；断言 public API 永不 reject，`trigger()` 运行时返回 `undefined`。 |

### C. Vault、keyspace、crypto 与调用点审计

| 范围 | 必做修改 |
|---|---|
| `packages/plugin-vault/src/*Coordinator*`、`vaultService.ts`、`keyspaceService.ts`、`sessionCryptoClient.ts` | 所有对用户/UI/插件暴露的 remote command/value 操作使用本单结果类型；不再由 facade 拼接 `Error("…failed: status")` 并抛出。 |
| `packages/plugin-p2pkh/src/p2pkhService.ts`、`packages/plugin-token-bsv21/src/manifest.ts`、`packages/plugin-token-stas/src/manifest.ts` | 领域事件只能调用 `trigger`；不得 await、return 或 catch 一个不存在的 trigger Promise。被门禁时依赖 snapshot，不得自行报错或发网络。 |
| 全部 `*.tsx` UI | 搜索 `onClick`、`onSubmit`、`addEventListener` 中的 service/Coordinator 调用。所有用户 command 必须用 result-aware handler；任何返回 Promise 的回调都不得留给 React/DOM 忽略。 |
| 全部 MessageBus / emitter 订阅 | 搜索 `subscribe(`、`on…Change(`、`addEventListener(`。领域触发只能调用 void trigger；用户 command 不得在订阅中隐式执行。 |

### D. Fatal 与诊断

| 文件 | 必做修改 |
|---|---|
| `apps/web/src/installGlobalFatalHandlers.ts` | 保持“同源未处理程序 rejection 为 fatal”的规则；只补回归测试和注释，禁止添加 command-status/message 白名单。 |
| `apps/web/src/installGlobalFatalHandlers.test.ts` | 新增完整链路回归：已消费的 blocked/transport result 不改变 fatal store；人为未处理的同源 rejection 仍必须进入 fatal。 |
| `apps/web/src/fatalErrorStore.ts` 与日志接入点 | 若缺少 recoverable coordinator diagnostic 的受控入口则新增；必须与 fatal store 分离，且字段脱敏。 |
| `apps/web/src/main.tsx`、`AppCrashBoundary.tsx` | 不改正常接管逻辑；测试确认本单的 recoverable result 不会卸载 React root。 |

---

## 6. 施工顺序（一次合入）

1. 先定义 `CoordinatorCommandResult`、`BackgroundCommandResult` 及 blocked reason
   的结构化类型；删除 `void runNow()` 的旧 contract。
2. 修改 Coordinator client 的唯一 normalize 边界，并先用 unit tests 固定
   ack、timeout、port close、错误 response 的行为。
3. 同次修改 Worker ack、background facade 和本地 background bundle，确保每个
   public command 都是 resolve-only API。
4. 修改托盘和设置页，删除裸 command 调用；用 result 清掉 pending，再等
   snapshot 展示最终任务状态。
5. 审计 Vault/keyspace/crypto facade 与所有插件订阅调用点，按本单三类边界收口。
6. 补 fatal/recoverable 诊断测试、全仓静态扫描和浏览器多 tab 联调。
7. 删除本次临时吞错补丁中已被正式 result API 替代的代码；不得两套语义并存。

不得分阶段发布“contract 已改而 UI 仍裸调用”或“client 可能 reject 而 facade
假定不会”的中间版本。

---

## 7. 测试与验收

### 7.1 定向自动化测试

- [ ] `background.trigger` 得到 `blocked` 时，所有领域调用点都不产生
  `unhandledrejection`，fatal store 保持为空。
- [ ] `runNow` 对 accepted、already-running、blocked、validation-error、
  stale-epoch、error、transport-error 都 resolve 为对应 result；不 reject。
- [ ] `cancel`、设置更新和 Vault/keyspace 用户 command 遵守同一 resolve-only
  规则。
- [ ] client 的 port timeout/close 清除陈旧 unlocked cache、启动 reconnect，且
  result 为 `transport-error`。
- [ ] Worker 的 blocked reason 可本地化且不依赖 `Error.message` 字符串。
- [ ] BackgroundTray 在所有 result 后都清除 pending；blocked 显示原因，
  transport-error 不显示“已开始”。
- [ ] 人为制造未处理的同源 `Promise.reject(new Error(...))` 仍会进入 fatal
  store，证明没有通过弱化 global handler 掩盖问题。
- [ ] 业务 handler 自身抛错仍可被测试发现；禁止为通过测试在 UI callback
  外层无差别 catch。

### 7.2 多 tab 浏览器验收

- [ ] Tab A 锁定、Tab B 因 resource-ready 触发同步：两 tab 正常显示 blocked，
  没有 fatal crash page、没有网络请求。
- [ ] 任一 tab 点击“立即同步一次”时，accepted/already-running/blocked 都有
  可见且不乐观伪造的反馈。
- [ ] Worker 被关闭或部署升级导致 port 失效时，页面回到连接/锁定收敛态而不崩溃；
  重新 `hello` 后可继续操作。
- [ ] 真正注入的页面程序错误仍显示 fatal crash page。

### 7.3 静态扫描与质量门槛

- [ ] `rg -n 'async (runNow|trigger)|Trigger task failed|Run task failed|\.catch\(\(\) => undefined\)' packages apps/web/src` 不得在生产 facade 中残留旧语义；本单明确允许的 transport normalize 内部处理除外，且必须有命名 helper 与测试。
- [ ] `rg -n 'onClick=.*(runNow|cancel)|onSubmit=.*updateScheduleSettings' packages apps/web/src` 的每个命中均使用 result-aware handler。
- [ ] `pnpm typecheck`
- [ ] `pnpm vitest run packages/plugin-background/src/backgroundServiceCoordinator.test.ts packages/plugin-background/src/backgroundService.test.ts apps/web/src/keymasterSessionCoordinatorClient.test.ts apps/web/src/installGlobalFatalHandlers.test.ts`
- [ ] `pnpm test`
- [ ] `pnpm lint:boundaries`
- [ ] `pnpm build`

任何一个 public command 仍可因正常 ack 或 transport failure reject、任何一个
`blocked` 能触发 fatal、或任何一个 UI 用户命令丢弃 result，均视为本单未完成。

---

## 8. 禁止事项与完成定义

禁止事项：

1. 在 `installGlobalFatalHandlers` 里按 `blocked`、`Task failed`、某个 stack 或
   bundle 文件名忽略 rejection。
2. 将所有 `.catch` 统一吞掉，或为了避免 fatal 而改为 `console.warn` 后继续假装
   操作成功。
3. 保留 `runNow(): void` 同时让实现偷偷返回 Promise，依赖 TypeScript 对
   `void` 回调的宽松赋值规则。
4. 用 `Error.message` 作为业务协议，或把敏感 RPC payload 放进可显示 message。
5. 用本地 optimistic `running` 状态替代 Worker snapshot，或在 blocked 时发网络。
6. 为旧 API 保留 overload、compat adapter、feature flag 或页面本地执行 fallback。

完成定义：所有跨 Coordinator 的公开命令和值操作都具有明确、类型可判别且
resolve-only 的可恢复结果；领域触发不产生 Promise；UI 消费用户命令结果并以
Worker snapshot 展示最终状态；正常业务拒绝和 transport 故障不再触发 fatal，
而真正未处理的同源程序异常仍由 fatal crash page 接管。上述自动化、静态和多 tab
验收全部通过后，方可判定本单完成。
