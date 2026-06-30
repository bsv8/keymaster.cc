# Keymaster Protocol Common V1（草案）

本文档定义 Keymaster 对外协议的公共约定，供 `identity.get`、`intent.sign`、`cipher.encrypt`、`cipher.decrypt`、`p2pkh.transfer`、`feepool.prepare` 与 `feepool.commit` 复用。

## 目标

- `keymaster.cc` 作为浏览器内密钥管理者，对外站点提供标准化能力。
- 协议当前聚焦：
  - 身份断言：`identity.get`
  - 内容签名：`intent.sign`
  - 内容加密：`cipher.encrypt`
  - 内容解密：`cipher.decrypt`
  - 受控转账：`p2pkh.transfer`
  - 费用池两步方法族：`feepool.prepare` / `feepool.commit`

## 非目标

- 本协议 V1 不依赖服务器，不提供服务器级全局防重放保证。
- 本协议 V1 不定义第三方资料的校验流程，只定义如何命名、传输、签名与加解密。
- 本协议 V1 不暴露过低层密码学原语，例如原始共享密钥。

## 传输方式

通信方式固定为：

1. 第三方站点 `window.open("https://keymaster.cc/...")` 打开 Keymaster popup。
2. Keymaster popup 初始化完成后，通过 `postMessage` 回发一条 `ready`。
3. 第三方站点收到 `ready` 后，再发送正式 `request`。
4. Keymaster 完成后回发 `result`。
5. Keymaster popup 在**窗口生命周期结束**时（用户手工关闭 / 页面卸载 / 第三方站点主动要求关闭），主动发出一条 `closing`；第三方站点把 `closing` 与 `popup.closed === true` 共同视作断开信号。

设计缘由：

- popup 页面加载和消息监听注册存在时序问题；
- `ready` 用来明确“我已经能收消息了”，避免首条请求丢失；
- 传输层只解决消息收发，不承载业务语义；
- `closing` 是 popup **窗口**生命周期的主动通知，**不**是“单条 request 收尾”的通知；popup 可以连续处理多条 request，期间不发 `closing`。
- `popup.closed === true` 是浏览器给的兜底真值。两者并联收敛到断开态，本协议**不**引入心跳、**不**引入 MessageChannel。

### Session Window（施工单 2026-06-29 001 硬切换 + 2026-06-29 003 硬切换）

popup 在 V1 不再仅是"第三方站点拉起的窗口"，而是统一为 **Session Window**。同一份代码、同一个 `/protocol/v1/popup` 入口承载两种启动模式：

- `connect` mode（缺省）：第三方 client web `window.open` 拉起，等待外部 request；
- `appView` mode：Keymaster launcher 拉起，URL 上加 `?boot=appView`；Session Window 在挂载时进入"等待 launcher bootstrap"状态，launcher 通过一次性同源 `__keymaster_session_window_bootstrap__.acquire(token)` 把 `AppBootstrapPayload`（**含 session signer bootstrap** + connectSessionId + launchToken + app 信息）移交过去。token 一次性消费，命中即从 launcher registry 删除。

两种 mode 在启动后走同一套 service / 同一套 transport / 同一套协议方法族。差异只存在于**启动阶段**。

#### Session signer 替代 unlock runtime（施工单 2026-06-29 003 硬切换）

`appView` mode 在 V1 不再把整套 vault unlock runtime（masterKey / masterSalt / keySnapshot / activePublicKeyHex）交给 Session Window（施工单 2026-06-29 003）。理由：

1. 同源不等于共享 launcher 当前内存态：Session Window 打开后是新的浏览器上下文，天然拿不到 launcher 的 masterKey / masterSalt / 已解锁 keyspace 内存；
2. appView 真正需要的是"这次 session 绑定 owner 的签名 / 派生能力"，不是整套钱包解锁态；导入 unlock runtime 会把 vault 全局解锁态、launcher 当下 active key 语义带进 Session Window，权限面过大。

硬切后（2026-06-29 003 → 已被 2026-06-30 002 撤销，最终版）：

- `appView` mode 的 Session Window 启动早期只持有 `OwnerRuntimeBootstrap`（ownerPublicKeyHex + privateKeyHex + ownerLabel + capabilities + createdAt），足够跑 `identity.*` / `intent.sign` / `cipher.*` / `storage.*` / `p2pkh.transfer` / `feepool.*`；
- Session Window **不**调用 `vault.importUnlockRuntime*`（已删除）；**不**把 vault 切到 unlocked 态；
- Session Window 刷新 / 关闭后 bootstrap 注入的 owner runtime 随窗口内存丢失；本窗口用户后续在本窗口 unlock 后可按同 owner 从 vault 重建 runtime（来源切到 `vault_unlock`）。

施工单 2026-06-30 002 撤销了 2026-06-29/003 引入的 `runtimeBinding` 二分路：

- session 真值收口为三元组 `sessionId + origin + ownerPublicKeyHex`，**不**持久化 runtime 来源；
- `OwnerRuntimeSource`（`"bootstrap_owner"` / `"vault_unlock"`）只作为窗口内调试信息存在；
- `AppBootstrapPayload` 字段从 `sessionSigner: SessionSignerBootstrap` 改名为 `ownerRuntimeBootstrap: OwnerRuntimeBootstrap`；
- `drainExecutionQueue()` 取消 `lockState === "unlocked"` 作为所有 request 的统一前置门——按 record 自己能否解析到 owner runtime 决定立即执行 / waiting_unlock / fail-fast。

`UnlockRuntimeHandoff` / `vault.export/importUnlockRuntime*` 仍按 2026-06-29 003 删除。

#### plugin-apps 内部 launcher（施工单 2026-06-29 002 硬切换 + 2026-06-30 002 硬切换）

Keymaster 内部 `plugin-apps` 是 `appView` mode 的**唯一**业务调用方。app 启动链路：

- `plugin-apps` 读取本地 `appsCatalog.json`（包含 `justnote` 与 `demo` 两 app），在 `/apps` 页面与首页 widget 展示 app 卡片；
- 用户点击 `Open App` 时，`plugin-apps` **只**调 `protocol.service.launchAppView(input)`，自己**不**直接 import `protocolStorageDb` / `buildAppBootstrapPayload` / `installLauncherBootstrapRegistry` / `window.open` popup URL；
- `protocol.service.launchAppView(...)` 内部一次性收口整套 launcher 流程：
  1. 校验 vault 已解锁、active key ready、owner key 有 vault keyId；
  2. 校验 app 配置合法（`new URL(appUrl).origin === appOrigin`）；
  3. 解析 claims 快照；
  4. **预建 connect session**（session 真值三元组，无 `runtimeBinding` 字段）；
  5. 调 `vault.withPrivateKey(keyId, fn)` 借出 owner 私钥 hex，组装 `OwnerRuntimeBootstrap`；
  6. 生成新 `launchToken`；
  7. 组装 `AppBootstrapPayload`（含 `ownerRuntimeBootstrap`）；
  8. 在 launcher `window` 上挂一次性 bootstrap registry；
  9. `window.open("/protocol/v1/popup?boot=appView&bootstrapToken=...")` 打开 Session Window。
- 任何一道闸失败：抛错 `LaunchAppViewError.code`，**不**补偿、**不**回退、**不**做"半启动"。
- `connect.launch` 与 `connect.login` / `connect.resume` 三者边界：
  - `connect.launch` **只**消费 launchToken；它**不**创建 session。
  - 真正"创建 connect session"的时机是 launcher 点击 `Open App` 时（即 `protocol.service.launchAppView(...)` 内部），不是等 client app 发 `connect.launch`。
  - `plugin-apps` **不**自己直接 import / 调 `protocolStorageDb` / `buildAppBootstrapPayload` / `installLauncherBootstrapRegistry` / `window.open` popup URL——所有这些细节都收口在 `protocol.service.launchAppView(...)` 内部。
- 借 owner 私钥 hex 失败抛 `export_owner_runtime_failed`（取代 003 的 `export_session_signer_failed`）。

更细节的 storage / connect.* / Session Window 启动顺序见：

- `docs/keymaster-storage-v1-draft.md`：storage.* 协议族；
- `docs/keymaster-connect-v1-draft.md`：connect.* + connect.launch；

## 三层会话语义（施工单 2026-06-28 001 硬切换）

V1 把"窗口生命周期 / connect 会话 / popup 解锁运行时"分到三条独立的时间线上：

```txt
popup transport session
  = popup 窗口级 postMessage 收发会话

connect auth session
  = caller 对当前 origin 已获得授权的持久会话

popup unlock runtime
  = 当前 popup 文档内可直接执行私钥操作的短期运行时材料
```

约束：

1. **transport session 断开 ≠ auth session 失效**。`closing` /
   `popup.closed === true` 只是窗口断开信号，**不**直接吊销
   connect session；caller 后续可以靠 `connect.resume` 恢复。
2. **auth session 存在 ≠ popup 当前文档已解锁**。session 真值在
   `keymaster.protocol` 的 `connectSessions` store 里持久化；popup
   当前文档刷新 / 关闭后，session 真值仍在；解锁 runtime 丢失。
3. **unlock runtime 失效 ≠ caller 需要重新登录**。caller 通过
   `connect.resume` 即可恢复既有 session；它不重新选 key，也不回到
   `connect.login` 的重新认证流程。
4. popup 任一时刻只允许一个 auth owner；`connect.login` / `connect.resume`
   的 auth 页面必须互斥，不能和主页面混排。

popup 当前文档的 unlock runtime 由 vault 在 `locked` 时清空全部
派生材料（masterKey / masterSalt）实现；popup 刷新 / 关闭后
window 全局变量被回收，效果与 locked 等价。**任何时候都不允许把
unlock runtime 写入 `localStorage` / `sessionStorage` / `IndexedDB`**。

业务请求（identity.get / intent.sign / cipher.encrypt / cipher.decrypt /
p2pkh.transfer / feepool.prepare / feepool.commit）的执行身份**统一**
按 `connectSessionId` 区分（施工单 2026-06-28 002 硬切换）：

- 所有上述方法**必须**携带 `connectSessionId`；service 通过 sessionId
  找到绑定 key，**不**读取钱包全局 active key。
- owner 唯一真值 = session 绑定的 `ownerPublicKeyHex`；`ownerKeyId` **不**
  出现在 protocol contract / session record / request record / result
  payload / fee pool key / pending operation key / service 分支判断里。
- **Confirm timeout 语义（施工单 2026-06-28 002 硬切换收口）**：
  - request 进入 `confirming` 的瞬间决定 timeout 快照——同步 cache
    命中则用 cache 真值（`startedFromFallback = false`），cache miss
    则用默认 `30s` 兜底（`startedFromFallback = true`）。
  - DB 真值晚到时**只**允许**缩短** deadline（clamp down），**不**允许
    延长；已走 cache 真值启动的 request **不**允许热更新。
  - newDeadline `<=` 当前时间时立即 `finalizeRequestByTimeout`，
    不等下一个 tick——晚到的更小 timeout 立即超时。
- `connect.login` 是唯一不要求 `connectSessionId` 的入口方法——它
  本身负责建 session。`connect.resume` / `connect.logout` 必传
  `connectSessionId`。
- 旧钱包主站语义"按全局 active key 执行"已被硬切换收口——所有
  外部业务方法都属于某个 `connectSessionId`。
- 登录入口走 `connect.login` → 持久化 `connectSessionId`；之后
  所有业务方法（identity.get / intent.sign / cipher.* / p2pkh.transfer /
  feepool.*）都必传 `connectSessionId`；不推荐用 `identity.get` 当登录
  入口真值。

## Popup 生命周期与业务请求生命周期

V1 把"窗口生命周期"与"业务请求生命周期"分到两条独立的时间线上。

### 窗口生命周期

```txt
window.open(...)   -> 收到 ready                -> 收到 closing / popup.closed
       opening              connected                  disconnected
```

- `opening` → `connected`：收到 `ready`。
- `connected` → `disconnected`：收到 `closing` 或 `popup.closed === true`。
- `disconnected` 是终态；下次 `window.open` 才能重新进入 `opening`。

### 业务请求生命周期（在同一窗口内可重复）

```txt
(locked + manual)   waiting_unlock_manual
(locked + auto)     waiting_unlock_auto
(unlocked + manual) confirming
(unlocked + auto)   queued
                    -> executing -> (approved / rejected / failed / timed_out)
```

关键约束（施工单 2026-06-27 001）：

1. 收到合法 request 后立刻建立独立 record；按 `lockState + auto-approve`
   落到对应初始 phase。
2. 同 `source + origin + requestId` 已有未终态 record 时，后续同 id
   直接忽略（重复 requestId 拒绝）。
3. 同一时刻允许多条 `waiting_unlock_*` / `confirming` / `queued` 共存；
   执行层全局串行 FIFO，同一时刻只允许一条 `executing`。
4. 用户点"确认" → `confirming → queued`，再触发全局 drain。
5. `queued` 也可被 `cancel(id)` 命中 → `rejected`，并从执行队列中移除。
6. `executing` 不响应 `cancel(id)`——V1 不支持补偿 / 中断。
7. 终态后服务**回到** `waiting`，允许在同一个 popup 会话里处理下一条 request。
8. `result` 报回业务结果；`closing` **不**在此路径上发出。

### 会话锁状态（施工单 2026-06-27 001 硬切换）

会话级锁状态独立于 request 状态：

```txt
locked   -> 渲染全页面锁屏（解锁表单 + 待处理概要）
unlocked -> 渲染主 popup 页面（顶栏 + 站点配置 + 命令流）
```

- popup 加载时若 vault 处于 locked，**只**渲染锁屏页。
- 解锁成功后 vault.onStatusChange 触发 service.setVaultLockState(false)
  + resumeAfterUnlock()；service 批量把 `waiting_unlock_*` 推进。
- 重新锁定时（vault.onStatusChange("locked")）service 立即把
  `confirming` 收口到 `waiting_unlock_manual` 并清 timeout；queued
  保持；executing 当前这条允许跑完。

### 关键不变量

1. `ready` 是连接建立信号，**不**表示用户已授权、**不**表示业务成功。
2. `closing` 是**窗口**生命周期结束信号，**不**携带业务结果，**不**替代 `result`。
3. `result` 是单条 request 的业务结果，**不**代表连接已断开。
4. `result` 与 `closing` 必须保持两种不同语义的顶层报文，**不允许**在 `result` 里夹带“连接已断开”。
5. 同一 popup 窗口里允许串行处理多条 request；同时只允许**一条在途** request。
6. `disconnected` 是窗口级终态；`approved / rejected / failed` 是 request 级终态，两者**不**互相替代。

## Popup 连接状态

Popup 连接状态只在 popup 窗口级别定义，**不**在 request 级别定义。

外部发起方只感知：

```txt
popup 是否已经 ready    -> opening / connected
popup 是否已经结束      -> disconnected
```

而不是：

```txt
request 是否正在执行
request 是否成功
result 是否已经返回
```

### 状态定义

| 状态        | 含义                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `opening`   | `window.open` 已成功返回 popup 句柄，尚未收到 `ready`。              |
| `connected` | 已收到 `ready`。                                                     |
| `disconnected` | 已收到 `closing`，或轮询到 `popup.closed === true`。终态。         |

### 转移规则

- `window.open(...)` 成功 → `opening`。
- 收到 `ready` → `connected`。
- 收到 `closing` → `disconnected`。
- 任意时刻轮询到 `popup.closed === true` → `disconnected`。
- 重复收到 `closing` 或重复轮询到 `popup.closed === true` 直接忽略。

### 不变量

1. `ready` 是连接建立信号，**不**表示用户已授权、**不**表示业务成功。
2. `closing` 是**窗口**生命周期结束信号，**不**携带业务结果，**不**替代 `result`。
3. `result` 与 `closing` 必须保持两种不同语义的顶层报文，**不允许**在 `result` 里夹带“连接已断开”。
4. `disconnected` 是终态；client 端状态转移必须幂等。
5. 本协议**不**做心跳：不引入 `ping/pong`、不基于“若干秒没消息”判定断开。
6. 本协议**不**引入 `MessageChannel`：连接状态完全建立在现有 `window.open + postMessage` 模型上。

## 报文对象模型

V1 不是 JSON 文本协议，而是浏览器对象协议。

也就是说：

- 报文整体是 JS 对象；
- 发送时直接 `postMessage(message, targetOrigin)`；
- 接收时直接读取 `event.data`；
- 协议不要求先 `JSON.stringify()`；
- 协议允许报文内部直接包含二进制字段。

工程约束：

- 所有报文必须是 structured clone 可传输的对象；
- 不允许在协议里使用 `function`、DOM 节点等不可结构化克隆的值；
- 二进制字段必须使用本文档定义的“二进制字段对象”。

## 二进制字段对象

V1 约定：所有二进制内容都必须显式包成一个带特殊属性标记的对象。

```ts
type BinaryField = {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
};
```

字段说明：

- `$type: "binary"`：二进制字段标记。
- `bytes`：真实字节内容。
- `mime`：可选。图片、文件、密文等有明确内容类型时填写。

约束：

- 所有二进制值都必须走 `BinaryField`。
- 哈希值不属于 `BinaryField`，继续用原始 32 字节或十六进制字符串表达，具体由各方法文档定义。
- 大对象允许结合 transfer list 发送，但传输语义不变。

## 顶层报文

### `ready`

```ts
{
  v: 1,
  type: "ready"
}
```

`ready` 只表示 popup 已准备好开始收消息，不表示用户已授权任何操作。

### `request`

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440000",
  method: "identity.get",
  params: {}
}
```

字段说明：

- `v`：协议版本。
- `type`：固定为 `request`。
- `id`：请求唯一标识。V1 中它同时承担“请求-响应关联”和“本次业务操作唯一标识”的职责。
- `method`：调用的方法名。
- `params`：方法参数。

### `result`

成功：

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: true,
  result: {}
}
```

失败：

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: false,
  error: {
    code: "user_rejected",
    message: "User rejected"
  }
}
```

字段说明：

- `id` 必须原样回显请求的 `id`。
- `ok=true` 时返回 `result`。
- `ok=false` 时返回 `error`。

### `closing`

```ts
{
  v: 1,
  type: "closing"
}
```

`closing` 是 popup **窗口**生命周期结束信号。它**只**说明：

```txt
这个 popup 窗口会话要结束了
```

它**不**说明：

- 当前 request 成功还是失败；
- 用户是否授权；
- 有没有 `result`；
- 为什么关闭。

字段说明：

- 报文为最小对象，**不**附带 `id` / `ok` / `error` / `reason` / `method` 等业务字段。
- `closing` 与 `result` 是两种不同语义的顶层报文，不允许合并。
- popup 在以下路径发出 `closing`：
  - 用户手工关闭窗口 / 页面卸载 / 刷新（`pagehide` / `beforeunload`）；
  - 第三方站点主动要求关闭 popup（例如 `targetOrigin` 改变）。
- popup **不**在"单条 request 完成"路径上发 `closing`：单条 request 完成
  只回 `result`；popup 仍可继续处理下一条 request。
- popup 最多发一次 `closing`；发送失败不重试，由 `popup.closed === true` 兜底。
- client 收到 `closing` 后立即收敛到 `disconnected`；重复 `closing` 幂等忽略。

### `cancel`（施工单 003 硬切换）

```ts
{
  v: 1,
  type: "cancel",
  id: "<原 request.id>"
}
```

字段说明：

- `id` 指向**已经发出**的 `request.id`。
- `cancel` **不是**业务 method；不允许把它做成 `method: "cancel"` 的伪 request，
  也不允许给 `cancel` 单独配 `result`。
- 被取消的是原 request，所以最终仍由原 request 回 `result(ok=false)`；
  `cancel` 自己**不**回一条新 `result`。

生效条件（必须全部满足）：

1. popup 存在一条与 cancel.id 匹配的活 request；
2. `event.source === 该 request 绑定的 source`；
3. `event.origin === 该 request 绑定的 origin`；
4. `cancel.id === 该 request 的 transportRequestId`；
5. 该 request 处于 `waiting_unlock_*` / `confirming` / `queued` 之一
   （施工单 2026-06-27 001：`queued` 也可被 cancel 命中）。

否则 popup **静默忽略**该 `cancel`：不抛、不回包、不回错误。

可生效的情况：

- `phase = "waiting_unlock_manual"` / `"waiting_unlock_auto"`：cancel 生效，
  走原 request 的 reject 路径，对外回 `user_rejected`。
- `phase = "confirming"`：cancel 生效，清 timeout，对外回 `user_rejected`。
- `phase = "queued"`：cancel 生效，从执行队列移除，对外回 `user_rejected`。

可忽略的情况：

- `phase = "executing"`：cancel 忽略（V1 不支持补偿事务）。
- `phase = "approved" / "rejected" / "failed" / "timed_out"` 或没绑定：cancel 忽略。
- id 不匹配：cancel 忽略（不允许"最接近匹配"或"取消最新一条"）。
- source / origin 不匹配：cancel 忽略。

并发收尾规则：

- 本地点"取消"与外部发来 `cancel` 同时发生时：`first-wins`，第二次幂等
  忽略；原 request 最多只回一条 `result(ok=false, error.user_rejected)`。
- 不允许双回包；service 在收尾入口先快照 binding 并立即清 binding，确保
  并发第二次进入时看到 `binding === null` 早退。

## 当前请求交互：活请求区 + 历史区（施工单 2026-06-27 002 硬切换）

V1 popup 的"当前 origin 视图"由**两个语义独立的区块**组成。
不再使用全页确认 overlay；收口到命令流**活请求区**的对应卡片里：

```txt
顶栏（sticky）
  当前站点 / 进入钱包 / 站点配置 / 回到最新 / 关闭
站点配置 inline 面板（可选）
活请求区
  放置未终态 request（waiting_unlock_manual / waiting_unlock_auto /
  confirming / queued / executing）
  按 createdAt asc 稳定排序
  每条 request 一个固定格子；同类 request 不复用卡位
  每张卡默认展开；直接展示详情 / 按钮 / 倒计时 / 状态文案
历史区
  放置终态 request（approved / rejected / failed / timed_out）
  按 updatedAt desc 排序
  默认只读 / 折叠；用户可手动展开看详情
  不出现确认 / 取消按钮
```

### 活请求区

- 显示当前 origin 下所有**未终态** request；
- 顺序按 `createdAt asc` 固定（同类 request 不会"借壳"接管旧卡位）；
- 每张卡按 phase 渲染：
  - `waiting_unlock_manual`：卡片内显示"等待解锁" + 请求摘要；
  - `waiting_unlock_auto`：卡片内显示"等待解锁（自动）" + 摘要；
  - `confirming`：卡片内显示请求详情 + 确认按钮 + 取消按钮 + 倒计时；
  - `queued`：卡片内显示"已确认，等待执行" + 取消排队按钮；
  - `executing`：卡片内显示"处理中"，无取消按钮。
- 每张活卡**默认展开**，并以 `recordId` 稳定绑定展开态——不允许
  通过 `i === 0` 之类的索引决定唯一展开卡。

### 历史区

- 显示当前 origin 下所有**终态** request；
- 顺序按 `updatedAt desc` 排序；
- 每张卡按 phase 渲染：
  - `approved`：卡片内显示"成功" + 终态摘要 + 时间线；
  - `rejected`：卡片头按本地 `failureReason` 区分展示
    "你已取消" / "对方主动取消"；旧记录或未知值回退到"已拒绝"；
  - `failed`：卡片内显示"失败" + 错误码 + 时间线；
  - `timed_out`：`phase = "failed"`、`decision = "failed"`、
    `status = "timed_out"`、`failureReason = "request_timeout"`；
    UI 单独把 `status === "timed_out"` 翻译成"超时"。
- 历史卡默认折叠；用户可手动展开看详情；**不**出现确认 / 取消按钮。

### 排序真值

- `ProtocolCommandFeedState.commands` 是**展示投影**，**不**再承诺
  "全局按 `updatedAt desc`"。
- 实际顺序 = `活请求区按 createdAt asc` 拼接 `历史区按 updatedAt desc`。
- `createdAt` 相同时按内部稳定 `recordId` 作次级稳定排序。
- 该语义由 service 在 `feedSnapshot()` 内统一派生；UI 不再发明
  第二套排序规则。

### 历史加载合并

`loadHistoryForOrigin(origin)` 的合并规则：

- DB 读出来的旧记录与内存 request store 里的活记录**按 recordId 合并**；
- 同 id 时一律以**内存活记录**为准；DB 旧字段不允许覆盖内存里正在
  等待用户处理的请求；
- 不同 id 时共存；
- 合并完成后按"活请求区 + 历史区"投影规则重建 `commands` 顺序。

### 批次隔离

- `loadHistoryForOrigin` 内部用 `origin + token` 隔离批次；
- 旧 origin 的历史加载晚到时，**不**回写当前 origin 视图；
- 切换 origin 时新批次开始，旧批次的最终结果被丢弃。

### 关键不变量

1. 同一时刻**允许多张**未终态活卡并存；不存在"全局当前唯一 request"心智。
2. `confirming -> queued -> executing` 状态推进**不**改变活卡相对顺序。
3. 第一条活卡进入终态后从活请求区离开，进入历史区；第二条活卡
   上移成为新的活请求区第一格——这是"前一条事务结束"的正常释放，
   不是"第二条借壳复用第一条卡"。
4. `cancel(id)` 按 `recordId` 精确命中，只影响目标卡。
5. popup 刷新 / 关闭后，内存里的活请求**不**做"占位卡复原"——与
   施工单 001 的 popup 会话级生命周期一致。
6. DB 不可用时：活请求区照常渲染（来自内存），历史区只显示本会话
   内可从内存派生的终态，UI 顶部继续显示"历史不可用"——但**不**
   因此退回"单一当前请求卡"的旧模型。

## 确认超时（施工单 003 硬切换）

每个 origin 站点级配置新增 `confirmTimeoutSeconds`：

- 类型：`number`（正整数秒）。
- 缺省值：`30`；UI / DB 归一化路径上"空串 / 非整数 / `<= 0` → 30"。
- 不引入"关闭 timeout"语义；不引入小数秒 / 毫秒 / 上限 clamp。

定时起点：请求进入 `unlocking` 或 `confirming`。

定时终点（先发生者为准）：

1. 用户本地确认。
2. 用户本地取消。
3. client 发来 `cancel` 并生效。
4. 请求进入 `executing`。
5. 倒计时到点。

auto-approve / auto-sign 命中时**不**创建 timer。

UI 倒计时显示：popup 顶栏/卡片内显示"剩余 N 秒"；setInterval 仅作 1s
re-render 触发器，**不**用作超时触发器——超时判定走 wall-clock 比较
deadline，确保 setInterval 抖动不会把"实际超时时刻"拖后。

timeout 与当前请求生命周期的关系：

- 修改站点 timeout **不**热更新当前正在倒计时的 request；当前 request
  保留它开始计时时快照下来的 deadline。下一条新 request 才读新值。
- timeout 不因为卡片折叠 / 页面重渲染 / 顶栏面板打开而暂停或重置。

timeout 收尾的本地 / 对外口径分离：

```txt
本地命令卡
  phase = "failed"
  decision = "failed"
  status = "timed_out"
  failureReason = "request_timeout"

对外 result
  ok = false
  error.code = "user_rejected"
  error.message = "User rejected"
```

`request_timeout` **不**对外暴露——site 不应通过 `error.message` 反推用户
是否在场 / 是否解锁 / 是否超时离开。

## 命令流历史（popup 内）

popup 内部维护一份"按 exact origin 归档"的命令流历史，目的是让用户
在同一个站点反复调用时能看到命令流上下文，但**不**承担审计冷库职责。

### 数据模型

- 一条 request = 一条 `ProtocolCommandRecord`；状态推进时直接更新同一
  条记录（**不**做 event-sourcing / 不追加 event row）。
- 状态收口为：`waiting_unlock` / `waiting_confirm` / `executing` /
  `approved` / `rejected` / `failed`。
- `status` 是与 `decision` 类似的稳定字符串，给 UI 直接展示用：
  - 中间态与终态：`waiting_unlock` / `waiting_confirm` / `executing` /
    `approved` / `rejected` / `failed`。
  - 终态超时（施工单 003）：`timed_out`。`phase = "failed"` +
    `decision = "failed"` + `status = "timed_out"` +
    `failureReason = "request_timeout"`；UI 单独把 `status === "timed_out"`
    翻译成"超时"，避免重做整套 phase 枚举。
- 终态稳定后立刻落 IndexedDB；中间态不一定落库（取决于实现）。

### 归档维度

- **exact origin**（`event.origin` 原样字符串），不归一化到 host。
- `https://example.com` 与 `https://example.com:8443` 必须视为不同 origin。
- UI 文案可以显示"站点 / 域名"，但 DB 真值必须存 exact origin。

### 持久化范围

| 方法 | 持久化字段 |
| --- | --- |
| `identity.get` | `aud`（= origin）、`text`、请求的 `claims` |
| `intent.sign` | `text`、`contentType`、content 字节长度 |
| `cipher.encrypt` | `text`、`contentType`、content 字节长度 |
| `cipher.decrypt` | `text`、nonce 字节长度、cipherbytes 字节长度 |
| 终态 | 状态、错误码、错误英文消息 |

**不**持久化：

- 私钥材料；
- 解密后的明文完整内容；
- 完整密文字节；
- 完整签名结果字节；
- 大体积二进制正文。

### DB 位置

- DB 名：`keymaster.protocol`；
- store：`commands`；
- 索引：`origin` / `updatedAt` / compound `[origin, updatedAt]`。

DB 不可用时 popup 继续工作：当前 request 仍可正常执行，UI 顶部显示
"历史不可用"。

### 历史加载时机

- popup 第一次启动**不**预先载入任何历史。
- 收到第一条合法 request 时，按 `event.origin` 载入该 origin 的历史。
- 同 popup 会话内遇到不同 origin 的 request 时，按新 origin 重新载入。
- 不支持从 URL 参数 / demo 本地缓存猜测历史归属；历史只信浏览器
  `event.origin`。

## 安全边界

- Keymaster 必须只接受预期来源窗口的消息。
- Keymaster 必须校验 `event.origin` 与业务参数中的 `aud` 一致；不一致立即拒绝。
- 每次请求都必须使用新的 `id`。
- 所有 `identity.get` / `intent.sign` 请求都必须经过用户确认。
- 不存在“静默获取轻量身份信息”的特例。

## `id` 的语义

V1 约定：顶层 `request.id` 既是传输层请求 id，也是业务层操作 id。

约束：

- 每次新请求都必须生成新的 UUID。
- 同一个 `id` 不应重复用于不同操作。

## Claims 命名规则

`claims` 不额外返回 `provenance` 字段，来源语义隐藏在 claim 名本身中。

### 保留命名空间

- `key.*`
- `profile.*`
- `wallet.*`
- `verified.<issuer>.*`
- `imported.<issuer>.*`

示例：

- `key.label`
- `profile.nickname`
- `profile.email`
- `profile.avatar.sha256`
- `profile.avatar.image`
- `wallet.bsv.address.main`
- `verified.google.email`
- `imported.google.nickname`

约束：

- claim 名本身必须足以表达“属性是什么”和“这个属性按什么语义理解”。
- `profile.email` 只能表示用户在 Keymaster 中自填的邮箱，不能暗示“已验证邮箱”。
- 需要“已验证”语义时，必须进入 `verified.<issuer>.*` 命名空间。
- 图片、文件等二进制 claim 不走 URL 引用，必须直接传输真实内容。

## Claims 值类型

大多数 claim 值是普通 JS 值，例如字符串、数字、布尔值、普通对象、数组。

二进制 claim 必须使用 `BinaryField`：

```ts
{
  $type: "binary",
  mime: "image/png",
  bytes: avatarArrayBuffer
}
```

约束：

- `mime` 表示内容类型。
- `bytes` 是真实内容，不是 URL，不是 base64 字符串。
- 同一个资源如果同时存在哈希 claim 与本体 claim，两者必须对应同一份内容。

## `resolvedClaims`

`resolvedClaims` 表示 Keymaster 本次实际返回给调用方的 claim 真值。

约束：

- `resolvedClaims` 只返回请求里明确索要且当前存在的 claim。
- 不存在的 claim 不报错，直接省略。
- 对于二进制 claim，`resolvedClaims` 返回真实文件本体 / 图片本体 / 二进制本体。
- `resolvedClaims` 不因为签名实现需要而改变 claim 名，也不自动补派生 claim。

### 头像 claims

头像至少拆成两类 claim：

- `profile.avatar.sha256`
- `profile.avatar.image`

推荐读取流程：

1. 常规流程里先请求 `profile.avatar.sha256`。
2. 第三方站点发现哈希变化，说明用户更新了头像。
3. 再请求 `profile.avatar.image`，拿到图片本体。

示例：

```ts
{
  resolvedClaims: {
    "profile.avatar.sha256": "a3f5..."
  }
}
```

```ts
{
  resolvedClaims: {
    "profile.avatar.image": {
      $type: "binary",
      mime: "image/png",
      bytes: avatarArrayBuffer
    }
  }
}
```

## Claims 签名投影规则

当某个方法需要把 claims 纳入签名信封时，不直接把 `resolvedClaims` 整体原样塞入，而是使用“签名投影”。

投影列表格式：

```txt
[
  [claimName, claimValue],
  [claimName, claimValue]
]
```

约束：

- 按 `claimName` 字典序升序排序。
- `claimName` 是字符串。
- `claimValue` 是该 claim 的签名投影，不一定等于返回给调用方的真实值。

签名投影规则：

- 文本 / 数字 / 布尔值等轻量 claim：直接以对应值进入签名信封。
- 二进制 claim：不把本体直接放入签名信封，而是放该二进制本体的摘要投影。

二进制 claim 的摘要投影格式：

```txt
["binary", mime, sha256(bytes)]
```

说明：

- 第一项固定字符串 `"binary"`。
- 第二项是 `mime`；没有时用空字符串。
- 第三项是该二进制 claim 本体的 SHA-256 原始 32 字节。

关键语义：

- 例如 `profile.avatar.image`：
  - 在 `resolvedClaims` 里返回的是真实图片本体；
  - 在签名信封里记录的是同名 claim 的摘要投影；
  - claim 名不变，只是签名表示和返回表示不同。

- `profile.avatar.image` 的摘要投影规则，不等于自动生成一个 `profile.avatar.sha256` claim。
  - `profile.avatar.sha256` 仍然是独立、显式、可单独请求的业务 claim；
  - `profile.avatar.image` 的摘要投影只是签名实现规则，不改变对外业务语义。

## 站点配置（per-origin settings）

`p2pkh.transfer` / `feepool.*` 的 auto-approve / auto-sign 配置按
exact origin 持久化，与命令历史分 store 管理。

### 数据模型

```ts
type ProtocolOriginSettingsRecord = {
  origin: string;                       // exact event.origin
  p2pkhAutoApproveEnabled: boolean;    // 默认 false
  p2pkhAutoApproveMaxSatoshis: number;  // 默认 0（= 关闭）
  feePoolAutoSignMaxSatoshis: number;   // 默认 0（= 关闭）
  feePoolDefaultFundSatoshis: number;   // 默认 0（= 未配置）
  /** 确认超时秒数；默认 30（正整数秒）。见"确认超时"段。*/
  confirmTimeoutSeconds: number;
  updatedAt: number;
};
```

### 默认值与开启流程

- `p2pkhAutoApproveEnabled` 默认 false；未配置 origin 的第一次
  `p2pkh.transfer` 视为"自动确认关闭 + 上限 0"，走人工确认。
- 用户主动开启 + 设置上限后，配置写到 `origins` store；后续同 origin
  的 `p2pkh.transfer` 命中 `amountSatoshis <= max` 即走 auto-approve。
- `feePoolDefaultFundSatoshis` 默认 0；首次 `feepool.prepare` 命中
  `create` action 且 `feePoolDefaultFundSatoshis === 0` 时，service 拒绝
  并要求用户先在 popup 顶栏"站点配置"按钮处填该字段。详见
  `feepool-v1` 文档。
- 配置入口在 popup 顶栏"站点配置"按钮 → inline 面板，编辑当前
  origin 的**四个**字段；写操作走 `service.setOriginSettings`。
- origin key 必须是 `event.origin` 原样字符串，不做 host / port 归一化。

### 与命令历史的关系

站点配置是"以后遇到这个 origin 该按什么策略执行"——属于**未来策略真值**。
命令历史是"过去发生过什么"——属于**历史真值**。两者职责分离，分别
落在 `origins` / `commands` 两个 store。任何把配置塞进 command 记录的
混合态都禁止。

## 费用池状态（fee pools）

费用池状态按 exact origin + counterpartyPublicKeyHex 复合 key 持久化。
Site 不管理池状态；Keymaster 内部负责重建策略 + 落地事务。

### 数据模型

```ts
type ProtocolFeePoolRecord = {
  poolKey: string;                          // `${origin}::${counterpartyPublicKeyHex}`
  origin: string;
  counterpartyPublicKeyHex: string;
  baseTxid: string;
  baseTxHex: string;
  totalAmount: number;                      // 池大小 = multisig output satoshis
  /**
   * 累计已分配给 server 的金额（V4 语义）。create 第一次 transfer 后
   * = `amountSatoshis`；spend 累加 = `prior.serverAmount + amountSatoshis`；
   * close_and_recreate 的新池 = `amountSatoshis`（新池从 0 重新累计）。
   * 永远 `<= totalAmount`。
   */
  serverAmount: number;
  /** 当前 B-Tx 草稿 hex（site 与 server 持续协商的对象；当前草稿，不是真广播）。*/
  draftSpendTxHex: string;
  /** 当前 B-Tx 草稿上的 client 部分签名。*/
  draftClientSignBytes: BinaryField;
  lastOperationId: string;
  updatedAt: number;
};
```

### 关键不变量

1. poolKey 必须包含 counterpartyPublicKeyHex；只按 origin 归档会让同站点
   不同对端公钥之间相互串池。
2. pending fee pool operation **不持久化**；operationId 只在当前 popup
   会话内存中有效。popup 关闭 / 刷新后旧 operationId 必然无效，commit
   失败为 `user_rejected`（对外口径）。
3. `feepool.commit` 成功后：
   - `create` → 新增 `feePools` 记录（首次 transfer 已包含）；
   - `spend` → **不删池**；`putFeePool` 覆盖同一条 pool record（累计 `serverAmount` + 草稿 hex）；
   - `close_and_recreate` → `putFeePool` 覆盖同一条 pool record（同 key 用新池替换旧池；close 草稿单独维护）。
4. **V4 关键：池大小（`totalAmount`）与累计 transfer 金额（`serverAmount`）必须分开**：
   - `totalAmount` = 池大小 = `feePoolDefaultFundSatoshis`（per-origin 设置）。
   - `serverAmount` = 累计已分配给 server 的金额 = `prior.serverAmount + amountSatoshis`（create 时从 0 起；close_and_recreate 新池从 `amountSatoshis` 起）。
   - 两者在不同 commit 后**不应该相等**（除非 site 想 transfer 整个池）。
   - **不允许 `serverAmount` 写成 0**；create 的第一次 transfer 同样非 0。
   - spend **不**构造新独立 draftTx；是在同一个 B-Tx 草稿上 `serverAmount += amountSatoshis` 并 client 重签。

### 系统级设置（fee pool 缺省 fund）

> **施工单 002 收尾反馈（已撤回原"系统级 + /settings/protocol"方案）**

`feePoolDefaultFundSatoshis` 是 **per-origin** 设置，放在
`ProtocolOriginSettingsRecord` 里，**不**再是系统级常量 + `/settings/protocol`
详情页。

理由：

- 同一站点不同 origin 之间彼此独立；统一一个全局默认值会让某些 origin
  拿到超过自己预期的池大小。
- per-origin 的设置入口已经存在：popup 顶栏"站点配置"按钮 →
  `<OriginSettingsTray>`；同一套 UI 同时承载
  `p2pkhAutoApproveEnabled` / `p2pkhAutoApproveMaxSatoshis` /
  `feePoolAutoSignMaxSatoshis` / `feePoolDefaultFundSatoshis` 四个字段。
- V1 不引入"系统级默认值可被全局修改"这种能力；保持 V1 简洁。

`feePoolDefaultFundSatoshis` 在 `feepool.prepare` 决策中的用法（V4
收口：**`amountSatoshis` 一律 = 本次 transfer 金额，**`feePoolDefaultFundSatoshis`
一律 = 池大小；两个量必须分开**）：

| action | 池大小（= multisig output）| 草稿 B-Tx 行为 |
| --- | --- | --- |
| `create` | `feePoolDefaultFundSatoshis`（建新池时）| 生成初始 B-Tx 草稿；草稿 `serverAmount = params.amountSatoshis` |
| `spend` | 不变（仍 = 旧池大小）| 在旧 B-Tx 草稿上 `serverAmount += params.amountSatoshis` 并 client 重签；不构造新独立 draftTx，不广播 |
| `close_and_recreate` | `feePoolDefaultFundSatoshis`（建新池时）| 旧草稿切到 `FINAL_LOCKTIME` 得到 close 草稿（待双方后续广播，V1 简化下暂不广播）；再建新池 A-Tx + 生成新池初始 B-Tx 草稿 |

约束：

- `create` / `close_and_recreate`：建新池时 `amountSatoshis <= feePoolDefaultFundSatoshis`；
  site 想 transfer 比池子还大的钱 → 拒掉，site 重新提交。
- `spend`：`prior.serverAmount + amountSatoshis <= prior.totalAmount`；用
  累计值校验，**不**是 `amountSatoshis <= prior.totalAmount`。

首次 create 命中但 `feePoolDefaultFundSatoshis === 0` 时：

- popup 必须先让用户填该值；
- 未填前 service 拒绝：对外 `user_rejected`，本地 `failureReason = "internal_error"`（专门给"未配置"的语义留口子）；
- popup 弹"补 default fund"面板即可（不是协议强制的）。

## 命令历史与新方法摘要（p2pkh + feepool）

命令历史 `ProtocolCommandRecord` 在 V1 新方法下扩展以下可选字段：

| 字段 | 何时填写 | 含义 |
| --- | --- | --- |
| `recipientAddress` | `p2pkh.transfer` | 收款地址 |
| `amountSatoshis` | `p2pkh.transfer` / `feepool.*` | 转账或池金额 |
| `action` | `feepool.prepare` / `feepool.commit` | `create` / `spend` / `close_and_recreate` |
| `operationId` | `feepool.commit` | commit 时指向 prepare 产出的 op |
| `counterpartyPublicKeyHex` | `feepool.*` | 对端公钥 |
| `failureReason` | 有本地终态原因时 | 本地终态原因（如 `user_canceled` / `client_canceled` / `insufficient_balance`） |
| `autoApproved` | `p2pkh.transfer` auto-approve 命中 | true |

**不**持久化：完整签名任务集、回签结果、完整 rawTx、完整密文 / 签名 / 明文。

## 隐私边界（敏感状态对外不暴露）

以下情况发生时，**对外**（`result.error`）一律返回 `user_rejected` +
`User rejected` 英文 message；**本地**（`ProtocolCommandRecord.failureReason`）
记录真实原因：

- `p2pkh.transfer` 余额不足（`insufficient_balance`）；
- `p2pkh.transfer` 地址非法（`invalid_address`）；
- `p2pkh.transfer` 金额非法（`invalid_amount`）；
- `feepool.prepare` / `feepool.commit` 找不到对应池（`fee_pool_not_found`）；
- `feepool.prepare` / `feepool.commit` DB 不可用（`fee_pool_db_unavailable`）；
- `feepool.commit` 未知 operationId（`unknown_operation`）；
- `feepool.commit` 跨 origin operationId（`cross_origin_operation`）；
- 其它本地内部错误（`internal_error`）。

site **不**应通过 `error.message` 反推本地敏感状态（余额 / 池状态 / 失败原因）。
新错误码不引入；现有 `ProtocolErrorCode` 集合保持稳定。

## Connect session 运行时绑定（施工单 2026-06-30 002 硬切换：撤销 runtimeBinding）

`ConnectSessionRecord` 在 V1 的稳定真值收口为三元组：

```txt
sessionId + origin + ownerPublicKeyHex
```

施工单 2026-06-30 002 撤销了 2026-06-29/003 引入的 `runtimeBinding` 字段 —— 把 runtime 来源持久化为 session 真值是错误抽象：

- runtime 来源不是稳定真值；它属于窗口内运行时状态；
- 同一 session 在窗口生命周期内可能从 bootstrap 注入的 owner runtime
  切到 unlock 后从 vault 重建的 owner runtime；
- 持久化这条字段会阻止 launcher 路径最终回到传统 popup 统一路径。

新 owner execution runtime 模型（`OwnerExecutionRuntime`）：

- 解析入口：`resolveOwnerRuntime(session)`；
- 解析顺序固定：
  1. `bootstrap_owner`：当前 Session Window 内存里已 bootstrap 注入
     的 `OwnerRuntimeBootstrap`；命中后直接拿私钥 hex，**不**读 keyspace /
     vault。这是 launcher 启动早期与 vault `locked` 态下的主要来源。
  2. `vault_unlock`：当前窗口 vault 已 `unlocked` 且
     `ownerPublicKeyHex` 对应的 key 可读 → 解析 vault `keyId` →
     用 `vault.withPrivateKey(keyId, fn)` 借出。
  3. 解析失败 → `failureReason = "runtime_missing"`（对外 `user_rejected`），
     提示用户重新从 Keymaster 启动 app。
- 业务方法（`identity.*` / `intent.sign` / `cipher.*` / `p2pkh.transfer` /
  `feepool.*` / `storage.*`）**统一**走 `resolveOwnerRuntime` 这一个入口；
  **不**再按"vault / session_signer"业务分支硬编码。
- 两条来源对外行为一致（同一把 owner、同一份私钥 hex），只在调试信息
  上区分 `OwnerRuntimeSource`。

不允许：

- 解析不到 owner runtime 时 fallback 到 vault 或当前 active key；
- 依据"当前 bootMode"或"vault.status()"硬编码执行路径；
- 把 `unlockRuntime` / `OwnerRuntimeBootstrap.privateKeyHex` 写回
  `AppBootstrapPayload` / `storageDb` / launchToken 缓存 / `localStorage`
  / `sessionStorage` / URL；
- 把 `bootstrap_owner` / `vault_unlock` 来源的差异泄漏到 session
  schema / 业务分支 / 协议文档。

`storage.*` 的内容 key 派生与签名 / 加解密走**同一条** owner 解析真值：
两条来源都最终提供同一把 owner 私钥 hex；同一 `connectSessionId` **不**
允许在不同来源间切换过程中产生不一致行为。

`protocolStorageDb` version 升到 8：再次重建 `connectSessions` store
移除 `runtimeBinding` 字段；commands / origins / feePools /
storageProviderConfig / launchTokens 沿用 v6 / v7 schema。
