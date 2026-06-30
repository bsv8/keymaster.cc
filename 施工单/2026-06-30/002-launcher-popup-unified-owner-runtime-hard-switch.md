# 002 launcher / popup 统一 Owner Runtime 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
- `施工单/2026-06-29/002-plugin-apps-appview-launcher-hard-switch.md`
- `施工单/2026-06-29/003-appview-session-signer-hard-switch.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `docs/keymaster-storage-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/sessionWindow.test.ts`

发生冲突时：

1. 本单优先于 `2026-06-29/003`。
2. 本单关于 `launcher`、`Session Window`、`connect.launch`、`connect.resume`、`storage.*` 的 owner 执行模型定义优先。
3. 后续若再改 launcher / popup 统一执行模型，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是修一个 `connect.launch` 卡死的小补丁。

本单定义的是一次硬切换：

- 撤销 `2026-06-29/003` 把 launcher 落成第二条 `session_signer` 执行路线的设计；
- `session_signer` 必须被彻底根除，不允许留下兼容字段、兼容命名、兼容分支、兼容测试前提；
- 恢复并写死正确目标：
  - `launcher` 和传统 `popup` 最终必须收口到同一套 Session Window execution runtime；
  - 二者只允许 runtime 来源不同，不允许 execution model 不同；
- 顺手修掉这次现场故障：
  - Session Window 已收到 `connect.launch`；
  - request 已进 `executionQueue`；
  - 但 `drainExecutionQueue()` 仍被全局 `lockStateValue === "unlocked"` 卡住，导致永远不执行。

本单目标不是把 Session Window “伪装成已解锁”，而是把“能不能执行”从“全局 lockState”改回“当前 request 需要的 owner runtime 是否可用”。

---

## 2. 简述缘由

### 2.1 现场根因已经定位，不是 transport，不是 opener，不是 DB 抢锁

这次现场已经确认：

- JustNote 的 `postMessage` 确实发到了 Session Window；
- Session Window 的 `isAllowedRequestSource()` 也放行了；
- `connect.launch` 进了 `executionQueue`；
- 但 `executeConnectLaunch()` 没有被执行；
- 原因是 `drainExecutionQueue()` 仍然要求：

```txt
while (queue.length > 0 && lockStateValue === "unlocked")
```

也就是说，当前实现上层说“`connect.launch` 不需要解锁，可以直接执行”，底层执行器却还在按“全局 vault unlocked 才能执行”卡死，两层语义互相打架。

### 2.2 更深的根因不是锁判断，而是之前把 launcher 设计成了第二条执行路

`2026-06-29/003` 的方向是：

- 传统 popup 走 `runtimeBinding = "vault"`；
- launcher / appView 走 `runtimeBinding = "session_signer"`；
- `ConnectSessionRecord.runtimeBinding` 持久化为 session 真值。

这个设计的根错误是：

- 它把“runtime 来源不同”误做成了“session 语义不同”；
- 它把 launcher 从“启动优化器”做成了“第二套长期执行模型”；
- 它迫使 `connect.launch`、`storage.*`、`cipher.*`、`intent.sign` 等方法永远分两条业务路。

这与用户已经明确的最终目标相冲突：

```txt
launcher 和 popup 是一条路
launcher 只是利用 Keymaster 当前已持有私钥的事实
避免用户再无谓解锁一次
不是再起一条独立私钥执行道路
```

### 2.3 `runtimeBinding` 持久化为 session 真值，本身就是错误抽象

session 的稳定真值应该是：

```txt
connectSessionId + origin + ownerPublicKeyHex
```

而不应该是：

```txt
connectSessionId + origin + ownerPublicKeyHex + 运行时来源
```

原因很直接：

1. runtime 来源不是稳定真值，它是窗口内运行时状态。
2. 同一个 session 在窗口存活期间，可能先用 bootstrap 私钥材料执行，后面又在本窗口 unlock 后改用本地 vault 重建执行 runtime。
3. 如果把 `runtimeBinding=session_signer` 写死到持久层，反而会阻止“回到旧 popup 统一路径”。

所以这次必须硬切掉 `runtimeBinding` 作为 session 真值的设计。

### 2.4 正确抽象应当是统一 execution runtime，区别只在 runtime 来源

最终应当收口为：

```txt
同一个 OwnerExecutionRuntime 接口
  - 来源 A：当前窗口本地 vault unlock 后重建
  - 来源 B：launcher bootstrap 过来的 owner 私钥材料
```

两条来源都服务同一套：

- `connect.launch`
- `connect.resume`
- `identity.*`
- `intent.sign`
- `cipher.*`
- `storage.*`
- `p2pkh.transfer`
- `feepool.*`

差异只能停留在“当前窗口怎么拿到 owner 执行能力”，不能继续泄漏到 session schema、业务分支、方法语义、协议文档里。

### 2.5 这次必须彻底删掉 `session_signer`，不能做“换壳保留”

这次不接受下面这种半切换：

- 只是把 `session_signer` 改成新注释；
- 只是把 `SessionSignerBootstrap` 改个类型别名；
- 只是保留 `runtimeBinding` 但默认不再使用；
- 只是把旧分支藏到 helper 里；
- 只是让测试继续以“存在 `session_signer` 路径”为前提。

这些做法都会留下尾巴，后面一旦有人修 bug 或补功能，就会自然回头继续沿用旧概念。

所以本次标准是：

1. `session_signer` 不是弃用，而是删除。
2. `runtimeBinding` 不是保留兼容，而是从 session 真值里移除。
3. 代码里不再存在“appView 专属 signer 路径”的业务前提。
4. 测试里不再以“session_signer session”作为一个合法系统概念。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. launcher 和传统 popup 使用同一套 Session Window protocol service 与 execution runtime 接口。
2. `connect.launch` 不再被 `lockStateValue === "unlocked"` 全局卡死。
3. `connect.launch` 是否可执行，只取决于当前窗口是否已具备该 session 对应 owner runtime。
4. `connect.resume`、`identity.*`、`cipher.*`、`storage.*`、`intent.sign`、`p2pkh.transfer`、`feepool.*` 全部走同一个 owner runtime resolver。
5. `ConnectSessionRecord` 不再持久化 `runtimeBinding = "vault" | "session_signer"`。
6. launcher bootstrap 不再向系统引入“第二条 session 执行语义”，只是在 Session Window 启动早期注入 owner runtime 材料。
7. Session Window 内部允许同时存在两类 owner runtime 来源：
   - `bootstrap_owner`
   - `vault_unlock`
8. 这两类来源对外行为一致；外部 request、result、sessionId、origin 校验、history、UI feed 都不分叉。
9. Session Window 刷新或关闭后，bootstrap 注入的 owner runtime 会随内存丢失；这是允许的。
10. 若 bootstrap runtime 丢失，但本窗口用户后来完成 unlock，系统可以按同一 owner 重新从 vault 建立 runtime 并继续走旧 popup 路线。
11. 若 runtime 丢失且本窗口也拿不到 owner，系统 fail-closed，要求用户重新从 Keymaster 启动 app；不做复杂补偿。
12. `session_signer`、`SessionSignerBootstrap`、`runtimeBinding` 不再出现在最终 contract、最终实现、最终测试命名中。

---

## 4. 单真值定义

### 4.1 Connect Session 真值

本次固定：

```txt
ConnectSessionRecord
  = sessionId
  + origin
  + ownerPublicKeyHex
  + ownerLabel
  + claimsSnapshot
  + createdAt / lastUsedAt / revokedAt
```

关键约束：

1. `ownerPublicKeyHex` 是 owner 唯一真值。
2. `ConnectSessionRecord` 不再持久化 `runtimeBinding`。
3. session 真值不记录“当前执行 runtime 来源”。
4. session 真值不记录私钥材料。

### 4.2 Owner Runtime 真值

本次固定：

```txt
OwnerExecutionRuntime
  = 当前 Session Window 可直接执行 owner 能力的一段统一运行时
```

它至少要统一承载以下能力：

- 取 ownerPublicKeyHex
- 签名
- 私钥输入派生
- `cipher.*` 需要的私钥能力
- `storage.*` 内容 key 派生能力

关键约束：

1. 所有业务方法都依赖 `OwnerExecutionRuntime`，不直接分叉到旧的 `vault` / `session_signer` 特判代码。
2. runtime 来源是实现细节，不是 session contract 真值。

### 4.3 Runtime 来源

本次固定：

```txt
OwnerRuntimeSource = "bootstrap_owner" | "vault_unlock"
```

含义：

- `bootstrap_owner`：launcher 在启动期把本次 owner 的私钥材料交给 Session Window；
- `vault_unlock`：Session Window 在本窗口解锁后，按 `ownerPublicKeyHex` 从本地 vault 重建 owner runtime。

关键约束：

1. 这是窗口内运行时状态，不落库。
2. 这是调试信息，不是业务真值。
3. 允许同一 session 在窗口生命周期内从 `bootstrap_owner` 切到 `vault_unlock`。

### 4.4 lockState 真值

本次固定：

```txt
lockState
  = 当前窗口本地 vault 是否已解锁
```

关键约束：

1. `lockState` 只表达本地 vault 状态。
2. `lockState` 不是“所有 request 是否可执行”的总闸门。
3. `bootstrap_owner` 已就绪时，即使 `lockState === "locked"`，`connect.launch` 和同 owner 的后续业务 request 也允许执行。

### 4.5 launcher bootstrap 真值

本次固定：

```txt
AppBootstrapPayload
  = app
  + connectSessionId
  + ownerPublicKeyHex
  + resolvedClaims
  + resolvedAt
  + launchToken
  + ownerRuntimeBootstrap
```

关键约束：

1. 命名从 `sessionSigner` 改成 `ownerRuntimeBootstrap`。
2. 它表达的是“启动时注入统一 owner runtime 的材料”，不是“另一套 signer 系统”。
3. bootstrap 材料只允许存在于 launcher 到 Session Window 的一次性内存交接里，不落长期存储。

---

## 5. 怎么做

### 一、先把 contract 和文档纠正，明确撤销 `runtimeBinding` 模型

必须先把以下定义删掉，而不是保留兼容：

- `ConnectSessionRecord.runtimeBinding`
- `runtimeBinding = "vault" | "session_signer"`
- `SessionSignerBootstrap`
- `sessionSigner` payload 命名
- 文档里“appView session 必须永远走 session_signer”的表述
- 文档里“缺 signer 绝不允许回到 vault”的表述

改成：

- session 真值只认 `connectSessionId + origin + ownerPublicKeyHex`
- owner runtime 由 Session Window 在运行时解析
- 运行时优先使用当前已就绪的 owner runtime
- bootstrap runtime 丢失后，如本窗口 unlock 能按同 owner 重建，则允许继续

这是本次硬切的第一原则。否则实现层再怎么修，语义仍然是错的。

### 二、把 `sessionSigner` 收口成统一的 `OwnerExecutionRuntime`

当前代码里与 `sessionSigner` 绑定的东西都要改名、改职责，并且旧名必须删掉：

- `SessionSignerBootstrap` 改成 `OwnerRuntimeBootstrap`
- `sessionSignerRuntimes` 改成 `ownerRuntimesBySessionId`
- `applyLauncherBootstrap()` 不再说“注册 signer runtime”，而是“注册 owner runtime”
- 所有 `sessionSigner`、`session_signer`、`signer runtime` 命名同步清除

统一 runtime 最少提供一个内部接口：

```txt
resolveOwnerRuntime(sessionId, origin)
  -> { runtime, source }
  -> null
```

解析顺序固定为：

1. 先看当前窗口内存是否已有该 `sessionId` 对应的 bootstrap owner runtime；
2. 没有则按 `ownerPublicKeyHex` 检查当前窗口本地 vault 是否已 unlock 且该 key 可用；
3. 能用则即时构建 / 复用 vault owner runtime；
4. 仍拿不到则返回 runtime missing。

### 三、把执行闸门从全局 lockState 改成“当前 record 是否具备执行条件”

本次必须改 `drainExecutionQueue()` 的调度语义。

不能再写成：

```txt
queue.length > 0 && lockState === unlocked 才能执行任何东西
```

应该改成：

```txt
只要没有正在执行的 record，就尝试取队首
根据该 record 的 method 和当前 runtime 条件决定：
  - 立即执行
  - 转 waiting_unlock_manual / waiting_unlock_auto
  - fail-fast
```

最少要满足：

1. `connect.launch` 在 bootstrap owner runtime 已就绪时，locked 也能直接执行。
2. `connect.resume` / `storage.*` / `cipher.*` / `intent.sign` / `identity.*` 若当前可解析到 owner runtime，也能直接执行。
3. 若当前解析不到 runtime，但解锁后理论上能从 vault 重建，则进入 unlock 流程。
4. 若当前解析不到 runtime，且解锁也无法成立，则 fail-closed。

### 四、把所有业务方法收口到同一个 owner runtime resolver

当前代码里凡是这种分叉都要收掉，而且删掉后不能保留死代码：

- `if (session.runtimeBinding === "session_signer") ...`
- `if (session.runtimeBinding === "vault") ...`
- `session signer 缺失时直接报错，不再尝试统一 resolver`

统一改成：

```txt
1. 先取 session 真值
2. 再 resolveOwnerRuntime(session)
3. runtime 存在 -> 执行
4. runtime 不存在 -> 判断是否该解锁 / 是否直接失败
```

这条规则必须覆盖：

- `connect.launch`
- `connect.resume`
- `identity.*`
- `intent.sign`
- `cipher.*`
- `storage.*`
- `p2pkh.transfer`
- `feepool.*`

### 五、让 launcher 仍然只负责“避免重复解锁”，不负责长期执行

launcher 路径保留，但职责收窄成：

1. 校验当前 Keymaster 已具备 owner 私钥能力；
2. 预建 `connectSessionId`；
3. 生成 `launchToken`；
4. 组装 `ownerRuntimeBootstrap`；
5. 打开 Session Window；
6. Session Window 自己变成真正的执行窗口。

明确禁止：

- launcher 长期持有 app 会话执行职责；
- app 运行期继续回头向 launcher 借执行能力；
- 为 launcher / appView 继续维护第二套 transport 或第二套 service 分支。

### 六、保留“简单失败”原则，不做复杂恢复编排

本次恢复策略只允许以下几种：

1. 当前窗口有 bootstrap owner runtime：直接执行。
2. 当前窗口没有 bootstrap runtime，但用户在本窗口完成 unlock 且 owner 可读：切到 `vault_unlock` 路径继续执行。
3. 当前窗口既没有 bootstrap runtime，也无法在本窗口重建 vault runtime：失败，提示用户回到 Keymaster 重新 Open App。

明确不做：

- launcher 关闭后后台偷偷再补 bootstrap；
- 多窗口互相借 runtime；
- 跨窗口复制运行中的 vault service 实例；
- 为了一次业务成功引入重试风暴或双向桥接。

---

## 6. 不能怎么做

### 一、不能把 `lockState` 假改成 `unlocked`

这只是掩盖问题，不是修复问题。

后果是：

- UI 会误判当前窗口已完整解锁；
- 传统 popup 行为会被污染；
- 以后 `connect.logout`、手动锁定、unlock 提示、异常恢复都会变脏。

### 二、不能继续把 `runtimeBinding` 持久化为 session 真值

这是错误抽象，必须撤销。

因为：

- runtime 来源不是 session 真值；
- 同一 session 的 runtime 来源可能变化；
- 持久化它会阻止 launcher 最终回到旧 popup 统一路径。

### 三、不能继续维护 `session_signer` 这条独立业务路

不允许保留任何兼容命名过渡。

不能继续出现：

- `connect.launch` 专属执行分支
- `storage.*` 的 `session_signer` 特有实现
- “appView 只能 signer，传统 popup 只能 vault”的硬编码
- 任何 `SessionSigner*` 类型、函数、变量、测试夹具

### 四、不能把 bootstrap 私钥材料落进长期存储

明确禁止写入：

- IndexedDB
- localStorage
- sessionStorage
- URL
- command history
- protocol feed
- 日志正文

bootstrap 私钥材料只允许出现在：

- launcher 当前内存
- Session Window 当前内存

### 五、不能靠 opener / launcher 长期在线维持 app 正常工作

这会把系统重新做复杂。

必须坚持：

- bootstrap 是一次性交接；
- Session Window 后续独立运行；
- launcher 可以关闭；
- opener 丢了不影响已经建好的 Session Window 继续处理同窗口 request。

---

## 7. 特殊情况怎么办

### 7.1 用户连续多次点 `Open App`

处理原则：

1. 每次点击都新建 `connectSessionId + launchToken`。
2. 同 origin 旧 session 继续按既有规则吊销。
3. 只有命中的那一对 `launchToken -> connectSessionId` 能成功接上。
4. 旧 token、重复 token、晚到 token 一律失败，不做补偿。

### 7.2 `connect.launch` 已入队，但 Session Window 此时还是 locked

处理原则：

1. 不因为 locked 就卡死整个执行器。
2. 若该 request 已能解析到 bootstrap owner runtime，则直接执行。
3. 若该 request 需要 runtime 但当前没有，而 unlock 后可得，则进入 unlock 流程。
4. 若 runtime 无法成立，则 fail-closed。

### 7.3 Session Window 刷新或关闭，bootstrap runtime 丢失

处理原则：

1. 这是允许的，不做跨窗口恢复。
2. 若用户在新开的 Session Window 内 unlock，且本地 vault 拥有该 owner，则按统一 popup 路线恢复执行。
3. 若本地无法重建 owner runtime，则提示用户重新从 Keymaster Open App。

### 7.4 app 首次 `connect.launch` 之前，launcher 已关闭

处理原则：

1. 只要 Session Window 已成功 consume bootstrap，这不构成问题。
2. 若 Session Window 还没 consume 到 bootstrap 就丢失来源，则启动失败。
3. 启动失败不补偿，用户重新从 Keymaster Open App。

### 7.5 本地 vault 解锁后，owner 与 session 绑定 owner 不一致

处理原则：

1. 一律以 `session.ownerPublicKeyHex` 为真值。
2. 当前 active key 不相关。
3. 若本地解锁后拿不到该 owner，对该 session 仍视为 runtime missing。

### 7.6 `storage.*`、`cipher.*`、`intent.sign` 行为差异

处理原则：

1. 不允许因为 runtime 来源不同出现不同协议结果。
2. 只允许调试信息里看到 `source = bootstrap_owner | vault_unlock`。
3. 业务成功 / 失败语义必须一致。

### 7.7 调试与日志

处理原则：

1. 可以记录 `sessionId`、`origin`、`method`、`runtime source`、`phase`。
2. 不记录私钥材料。
3. 新增调试快照时，要能看出：
   - request 是否已入队；
   - 当前是否有 executingRecord；
   - 队首 record 为什么没执行；
   - runtime 来源是什么；
   - 是 runtime missing 还是 waiting unlock。

---

## 8. 文件级改动清单

### 文档与 contract

- `施工单/2026-06-29/003-appview-session-signer-hard-switch.md`
  - 标注被本单取代，避免后续继续按错误模型施工。
- `docs/keymaster-protocol-common-v1-draft.md`
  - 删除 `runtimeBinding` 作为 session 真值的定义。
  - 改写 launcher / popup 统一 owner runtime 语义。
- `docs/keymaster-connect-v1-draft.md`
  - 改写 `connect.launch`、`connect.resume`、unlock 与 runtime 解析关系。
- `docs/keymaster-storage-v1-draft.md`
  - 改写 `storage.*` 对 owner runtime 的统一依赖，去掉 `session_signer` 特判语义。
- `packages/contracts/src/protocol.ts`
  - 删除 `ConnectSessionRecord.runtimeBinding`。
  - `SessionSignerBootstrap` 改名为 `OwnerRuntimeBootstrap`。
  - `AppBootstrapPayload.sessionSigner` 改名为 `ownerRuntimeBootstrap`。
  - 删除一切 `session_signer` / `SessionSigner` 残留命名。
  - 改写相关注释与错误码说明。

### 存储层

- `packages/plugin-protocol/src/protocolStorageDb.ts`
  - DB version 升级。
  - `connectSessions` store 做硬切重建，去掉 `runtimeBinding` 旧真值语义。
  - 注释改成“session 真值不含 runtime 来源”。

### Session Window bootstrap 与 service

- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
  - 改名与注释同步到 `ownerRuntimeBootstrap`。
  - 删除旧 `sessionSigner` 命名，不保留兼容别名。
  - 保持一次性内存 consume，不新增持久化。
- `packages/plugin-protocol/src/protocolService.ts`
  - 引入统一 `OwnerExecutionRuntime` / `resolveOwnerRuntime()`。
  - 删除 `runtimeBinding === "session_signer" / "vault"` 分叉主逻辑。
  - `launchAppView()` 改为预建普通 session，不再写 `runtimeBinding`。
  - `applyLauncherBootstrap()` 改为注册统一 owner runtime。
  - 删除所有 `sessionSigner*` 数据结构、helper、日志 event、调试字段、测试钩子。
  - `drainExecutionQueue()` 改成按 record 执行条件调度，不再被全局 unlocked 卡死。
  - `connect.launch`、`connect.resume`、`identity.*`、`cipher.*`、`storage.*`、`intent.sign`、`p2pkh.transfer`、`feepool.*` 全部改走统一 runtime resolver。
  - 调试快照补 runtime source / blocked reason。
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
  - UI 文案和状态展示改成：
    - vault locked
    - runtime ready
    - waiting unlock
    - runtime missing
  - 不再把“能执行”直接等同于“vault 已解锁”。

### 测试

- `packages/plugin-protocol/src/protocolService.test.ts`
  - 新增 / 重写统一 runtime 解析与队列调度测试。
  - 删除以 `session_signer` 为前提的测试命名、夹具、断言。
- `packages/plugin-protocol/src/sessionWindow.test.ts`
  - 覆盖 launcher bootstrap、`connect.launch`、Session Window locked 但 runtime ready 的路径。
  - 删除以 `SessionSigner` 为前提的测试命名、夹具、断言。
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
  - 覆盖 UI 在 locked 但 runtime ready 时仍可执行 appView request 的展示。

---

## 9. 最终验收清单

- [ ] 从 `/apps` 点击 JustNote，打开 Session Window，再点 `Open App`，JustNote 不再出现 “Timed out waiting for result”。
- [ ] 现场复现里，Session Window 即使 `lockState === "locked"`，只要 bootstrap owner runtime 已就绪，`connect.launch` 也会真正进入执行而不是只排队。
- [ ] `drainExecutionQueue()` 不再以 `lockState === "unlocked"` 作为所有 request 的统一前置条件。
- [ ] `ConnectSessionRecord` 已移除 `runtimeBinding`。
- [ ] `protocolStorageDb` 已完成硬切升级，不再保留 `runtimeBinding` 作为 session 真值。
- [ ] `sessionSigner`、`SessionSignerBootstrap`、`session_signer` 命名已从核心 contract / service / 测试中彻底删除。
- [ ] `sessionSigner` 语义已从核心 contract / service 中撤出，统一收口为 `OwnerExecutionRuntime` / `ownerRuntimeBootstrap`。
- [ ] launcher 打开的 app session 与传统 popup session 使用同一套 request / result / history / feed / execution runtime 解析逻辑。
- [ ] `connect.launch`、`connect.resume`、`identity.*`、`intent.sign`、`cipher.*`、`storage.*`、`p2pkh.transfer`、`feepool.*` 全部通过同一个 owner runtime resolver。
- [ ] 当前窗口 bootstrap runtime 丢失后，若用户在本窗口 unlock 且 owner 可用，可继续处理同 session request。
- [ ] 当前窗口既无 bootstrap runtime、又无法从本地 vault 重建时，系统 fail-closed，并明确要求用户重新从 Keymaster Open App。
- [ ] 不存在 bootstrap 私钥材料写入 IndexedDB / localStorage / sessionStorage / URL / history / 明文日志。
- [ ] launcher 关闭后，已完成 bootstrap 的 Session Window 可继续独立工作。
- [ ] opener 丢失不会让已经建好的 Session Window 进入假死等待。
- [ ] 传统 `connect.login` / `connect.resume` / `connect.logout` 流程未回归。
- [ ] 新旧测试通过，且新增测试覆盖“locked 但 runtime ready”这条关键路径。

---

## 10. 一句话施工原则

这次不要再修成“让 appView 看起来像 unlocked”，而是要修成“appView 和 popup 本来就是同一条执行路，谁能提供 owner runtime，谁就让这条路跑起来”。
