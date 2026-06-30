# 003 appView Session Signer 替代 Unlock Runtime 硬切换一次性迭代施工单

> ⚠️ **已被 `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md` 整体撤销并取代**。
>
> 003 提出的 `runtimeBinding` 二分路（`vault` / `session_signer`）、
> `SessionSignerBootstrap` 类型、`sessionSigner` payload 命名，
> 以及 `drainExecutionQueue` 以全局 `lockState === "unlocked"`
> 作为所有 request 统一前置门的设计，均已**删除**：
>
> - `runtimeBinding` 不再落库；session 真值收口为
>   `sessionId + origin + ownerPublicKeyHex` 三元组。
> - bootstrap 启动材料统一改名为 `OwnerRuntimeBootstrap`，
>   业务方法收口到 `resolveOwnerRuntime(session)`：
>   `bootstrap_owner` → `vault_unlock` → fail-fast。
> - `drainExecutionQueue()` 改按 record 自己能否解析到
>   owner runtime 决定立即执行 / waiting_unlock / fail-fast。
>
> 本单**仅留作历史追溯**；后续禁止在不参考 2026-06-30/002 的情况下
> 单独推进 003 的实现。

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
- `施工单/2026-06-29/002-plugin-apps-appview-launcher-hard-switch.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `docs/keymaster-storage-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/vault.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
- `packages/plugin-protocol/src/storageObjectService.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/plugin-apps/src/appsCatalog.json`

发生冲突时：

1. 本单关于 `appView` 启动期 handoff、`Session Window` 运行时、`storage.*` owner 执行面的定义优先。
2. 本单未覆盖的 `connectSessionId`、`ownerPublicKeyHex`、`transport`、`popup lifecycle` 语义，继续以 `2026-06-28` 与 `2026-06-29/001` 为准。
3. 后续若再改 `appView` owner 执行模型，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是“先把 `exportUnlockRuntime` 的 bug 修掉，后面再慢慢收权限”的补丁单。

本单定义的是一次**硬切换**：

- `appView` mode 的 Session Window **不再导入整套 vault unlock runtime**；
- launcher **不再**把 `masterKey / masterSalt / keySnapshot / active key` 交给 Session Window；
- launcher 只把**这次 session 绑定的 owner 私钥材料**交给 Session Window；
- Session Window 在 `appView` mode 下运行的是 **session signer runtime**，不是“完整解锁的钱包运行时”；
- 运行期所有外部业务方法继续严格绑定：
  - `connectSessionId`
  - `ownerPublicKeyHex`
- 但执行面从“`keyspace.getKey()` + `vault.withPrivateKey()`”切成：
  - `connect session 的 runtimeBinding`
  - `runtimeBinding=session_signer` 时只走 Session Window 内存里的 session signer
  - `runtimeBinding=vault` 时继续走既有 vault 路径

本单目标不是“把同源窗口共享内存讲圆”，而是把 `appView` 权限面和执行面收窄到真正需要的那一把 key。

---

## 2. 简述缘由

### 2.1 同源不等于共享 launcher 当前内存态

`Session Window` 是 Keymaster 同源页面，这一点没问题；但它打开后是**新的浏览器上下文**，天然拿不到 launcher 当前内存里的：

- `masterKey`
- `masterSalt`
- vault service 实例闭包
- React 状态
- 已解锁内存态

所以“同源网页自己就有 keymaster 的所有东西”只对“代码和持久化存储”成立，不对“当前内存解锁态”成立。

### 2.2 appView 真正需要的是 owner 执行权，不是整套 vault 解锁权

`appView` 的运行期需求是：

- `connect.launch`
- `identity.*`
- `intent.sign`
- `cipher.*`
- `storage.*`
- `p2pkh.transfer`
- `feepool.*`

这些能力的共同点不是“需要整个钱包都解锁”，而是“需要这次 session 对应 owner 的签名 / 派生能力”。

把整套 unlock runtime 搬过去，会把以下无关能力也带过去：

- vault 全局解锁态
- launcher 当下 active key 语义
- 全量 key 列表快照
- 后续继续从 vault 借私钥的能力

这比 appView 真正需要的权限面大得多。

### 2.3 当前 unlock runtime 模型已经暴露出错误方向

当前 `launchAppView()` 依赖：

- `vault.exportUnlockRuntimeForSessionWindow()`
- `Session Window` 侧 `vault.importUnlockRuntimeFromLauncher(...)`

而 vault 里的 `masterKey` 现在是 non-extractable key。实现为了交接 unlock runtime，又要走 `exportKey("raw", masterKey)`，这说明模型已经在逼实现做一件本来就不该做的事。

问题不是“这次没把 `extractable` 配对好”，而是：

- appView 本来不该拿这把 `masterKey`
- 更不该为了 appView 去扩大 vault 解锁态暴露面

### 2.4 `active key` 只该用于 launcher 选 owner，不该漂到运行期

当前 launcher 打开 app 时，确实需要基于“当前准备好的 key”来选出本次 owner。

但这只是**启动期选择 owner**，不是运行期真值。

一旦 `connectSessionId` 创建完成，后续真值就应该是：

```txt
connectSessionId -> ownerPublicKeyHex -> execution runtime
```

而不是：

```txt
connectSessionId -> ownerPublicKeyHex -> 再去读当前全局 active key / 当前 vault 解锁态
```

如果运行期还要继续依赖全局 active key，那 `connectSessionId + ownerPublicKeyHex` 这套硬切换就等于只做了一半。

### 2.5 `storage.*` 必须跟签名面走同一条 owner 执行路径

现在 `storage.*` 的内容加密 key 派生底层仍然依赖 `vault.withPrivateKey(...)`。

如果这次只把签名改成 session signer，但 `storage.*` 还继续走 vault，那 appView 运行时就会出现两套 owner 执行面：

- `cipher / intent / p2pkh / feepool` 走 session signer
- `storage.*` 走 vault

这会重新把系统撕裂成两半，不允许。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. `appView` mode 的 Session Window **不再导入 unlock runtime**。
2. launcher 点击 `Open App` 时，仍然立即预建新的 `connectSessionId`。
3. launcher 在预建 session 后，只交接这次 session 绑定 owner 的私钥材料，不交接 `masterKey / masterSalt / keySnapshot / activePublicKeyHex`。
4. `AppBootstrapPayload` 改为携带 `session signer bootstrap`，不再携带 `unlockRuntime`。
5. `ConnectSessionRecord` 必须新增运行时绑定真值字段，显式区分：
   - `runtimeBinding = "vault"`
   - `runtimeBinding = "session_signer"`
6. `plugin-apps -> protocol.service.launchAppView(...)` 创建的 session 一律写成 `runtimeBinding = "session_signer"`。
7. `connect.login` 创建的传统 popup session 一律写成 `runtimeBinding = "vault"`。
8. 运行期所有外部业务方法都先按 `connectSessionId` 取 session，再按 `runtimeBinding` 决定执行面。
9. `runtimeBinding = "session_signer"` 的 session **绝不允许** fallback 到：
   - 当前全局 active key
   - `keyspace.getKey() + vault.withPrivateKey()`
10. `storage.*` 的内容 key 派生也必须跟随 `runtimeBinding` 走同一套 owner 执行面。
11. `Session Window` 在 `appView` mode 下不要求 vault 进入 `unlocked` 状态，也不把自己伪装成“完整解锁钱包窗口”。
12. `Session Window` 刷新 / 关闭后，session signer 运行时随窗口内存一起丢失；V1 不做自动恢复，用户重新从 Keymaster 启动 app。
13. 本次同步把 `packages/plugin-apps/src/appsCatalog.json` 增加 `https://demo.apps.bsv8.com/`。

---

## 4. 单真值定义

### 4.1 Session Window 运行时类型

本次固定：

```txt
Session Window runtime
  = vault runtime
  | session signer runtime
```

含义：

- `vault runtime`：传统 connect popup，执行时从已解锁 vault 借 owner 私钥；
- `session signer runtime`：appView mode，执行时只使用 bootstrap 进来的 owner 私钥材料。

关键约束：

1. 二者只在**执行面**不同；transport、request、result、sessionId 语义不分叉。
2. 不允许为 appView 再做第二套协议方法或第二套 transport。

### 4.2 Connect Session 运行时绑定真值

本次固定：

```txt
ConnectSessionRecord.runtimeBinding = "vault" | "session_signer"
```

含义：

- `vault`：这条 session 的 owner 执行权来自当前窗口的 vault；
- `session_signer`：这条 session 的 owner 执行权来自当前窗口内存中的 session signer。

关键约束：

1. `runtimeBinding` 是 session 真值，必须持久化到 `connectSessions`。
2. 执行路径不允许靠“当前 bootMode”临时猜测；必须读 session record 真值。
3. `runtimeBinding = "session_signer"` 时，缺 signer 就是失败，不能改走 vault。

### 4.3 Session Signer Bootstrap

本次固定：

```txt
session signer bootstrap
  = ownerPublicKeyHex
  + ownerLabel
  + privateKeyHex
  + capabilities
  + createdAt
```

最小要求：

1. 必须有 `ownerPublicKeyHex`；
2. 必须有 `privateKeyHex`；
3. `privateKeyHex` 派生出的压缩公钥必须与 `ownerPublicKeyHex` 一致；
4. 不需要 `keyId`；
5. 不需要 `masterKey / masterSalt / keySnapshot / activePublicKeyHex`。

### 4.4 AppBootstrapPayload

本次固定：

```txt
AppBootstrapPayload
  = app
  + connectSessionId
  + ownerPublicKeyHex
  + resolvedClaims
  + resolvedAt
  + launchToken
  + sessionSigner
```

关键约束：

1. 删除 `unlockRuntime` 字段。
2. Session Window consume bootstrap 时必须校验：
   - `connectSessionId` 非空
   - `launchToken` 非空
   - `sessionSigner.ownerPublicKeyHex === payload.ownerPublicKeyHex`
   - `sessionSigner.privateKeyHex` 对应公钥确实等于 `ownerPublicKeyHex`

### 4.5 Launcher 期 owner 选择

本次固定：

```txt
launcher 期可以读取 active key
  = 为了决定本次 app session 绑定谁

app 运行期不再读取 active key
  = 真值改为 connectSessionId -> ownerPublicKeyHex -> runtimeBinding
```

关键约束：

1. `active key` 只存在于 launcher 决策期。
2. 启动后切换 active key 不影响已存在 app session。

### 4.6 appView Session Window 的 vault 状态

本次固定：

```txt
appView Session Window
  可以 vault.status() === "locked"
  但 session signer runtime === ready
```

关键约束：

1. `appView` mode 下，不把“vault locked”误判成“协议不可执行”。
2. 业务方法是否可执行，取决于 session 的 `runtimeBinding` 与对应 runtime 是否就绪。
3. `appView` mode 下不展示“请先解锁钱包才能服务该 app”的错误文案；缺 signer 时报 session runtime 缺失。

---

## 5. 不能怎么做

1. 不能继续沿用 `unlockRuntime`，只把 `masterKey` 改成 extractable 后当作本单完成。
2. 不能把 appView session 仍然落成“普通 vault session”，只是多塞一个 `launchToken`。
3. 不能让 `runtimeBinding = "session_signer"` 的请求在 signer 缺失时偷偷 fallback 到：
   - 当前 active key
   - vault 当前 active key
   - `keyspace.getKey(ownerPublicKeyHex)` 后 `vault.withPrivateKey(...)`
4. 不能只改签名链路，不改 `storage.*` 的 owner key 派生链路。
5. 不能把 session signer 持久化到：
   - IndexedDB
   - localStorage
   - sessionStorage
   - URL
   - launch token store
6. 不能为了 appView 去恢复或维持整套 vault `unlocked` 状态。
7. 不能把 `Session Window` 重新定义成“完整钱包主界面”；它是协议窗口，不是 wallet shell。
8. 不能为了“刷新后继续工作”引入第二套长期 signer 持久化机制。
9. 不能要求 `plugin-apps` 自己处理 owner 私钥读取、bootstrap 拼装、Session Window URL 拼接。
10. 不能把 `ownerKeyId` 重新带回 session 持久化、bootstrap payload、record、storage key、result payload。
11. 不能要求 appView 运行期的每次请求再去问 launcher 要私钥；bootstrap 是一次性交接，不做长期 bridge。
12. 不能让 `vault.deleteKey`、`active key` 切换、vault 锁定事件去强依赖地驱赶 appView 活会话；V1 不做全局 kill-switch 编排。

---

## 6. 应该怎么做

### 一、把 appView handoff 从 unlock runtime 改成 session signer

具体改法：

1. 删除 `UnlockRuntimeHandoff` contract。
2. 删除 `AppBootstrapPayload.unlockRuntime`。
3. 新增 `SessionSignerBootstrap` contract。
4. `buildAppBootstrapPayload(...)` 改成组装 `sessionSigner`。
5. `applyLauncherBootstrap(...)` 改成：
   - 校验 signer payload
   - 在 Session Window 内存中注册 session signer runtime
   - 写入 `appViewContext`
   - 缓存 `launchToken`
6. 不再调用 `vault.importUnlockRuntimeFromLauncher(...)`。

### 二、launcher 用现有 vault 借 owner 私钥，不新增广义导出 API

具体改法：

1. `launchAppView()` 仍然先选定当前 owner。
2. 通过现有：
   - `keyspace.getKey(ownerPublicKeyHex)`
   - `vault.withPrivateKey(keyId, fn)`
   在 launcher 当前调用栈里借出 owner 私钥明文 hex。
3. 只把这把 key 的最小必要材料写进 `sessionSigner` bootstrap。

关键约束：

1. 不新增 `vault.exportWholeSessionRuntime()` 之类更大的 API。
2. 不引入“把私钥转存进某个共享 store，再让 Session Window 自己读”的复杂路径。

### 三、给 connect session 持久化增加 runtimeBinding 真值

具体改法：

1. `ConnectSessionRecord` 增加 `runtimeBinding` 字段。
2. `connect.login` 建 session 时写入：
   - `runtimeBinding = "vault"`
3. `launchAppView` 建 session 时写入：
   - `runtimeBinding = "session_signer"`
4. `protocolStorageDb` 升级版本，重建 `connectSessions` store。

设计缘由：

- 执行路径必须看 session 真值，不看窗口猜测；
- 否则一旦 appView / connect 逻辑混住在同一 service 里，很容易悄悄 fallback。

### 四、把 owner 执行面统一收口为 execution runtime resolver

`protocol.service` 内部必须新增统一解析逻辑，例如：

```txt
resolveExecutionRuntime(connectSessionId)
  -> load ConnectSessionRecord
  -> switch(runtimeBinding)
      "vault"          -> resolve vault-backed owner executor
      "session_signer" -> resolve in-memory session signer executor
```

后续所有依赖 owner 私钥的方法都走这一条，不再各自手写：

- `identity.*`
- `intent.sign`
- `cipher.*`
- `storage.*`
- `p2pkh.transfer`
- `feepool.*`

### 五、appView mode 下把“可执行”与“vault locked”解耦

具体改法：

1. `ProtocolPopupPage` / `ProtocolService` 里，不能再把 `vault.status() !== "unlocked"` 直接等价成“当前窗口不可执行”。
2. 对 `runtimeBinding = "session_signer"` 的 session：
   - 即使 vault locked，只要 signer runtime 在，就允许执行。
3. 传统 connect popup 仍然继续沿用 vault 锁屏 / 解锁流程。

### 六、storage.* 与 signer 执行面一起硬切

具体改法：

1. `StorageCryptoBridge` 不能再只接收 `ownerPublicKeyHex` 然后内部强依赖 vault。
2. 它必须改成接受“已解析好的 owner 执行材料”，或者由 `protocol.service` 先解析出 owner executor，再把 raw 派生能力传给 storage。
3. `runtimeBinding = "session_signer"` 时，`storage` 内容 key 派生直接使用 session signer 的私钥 hex。
4. `runtimeBinding = "vault"` 时，仍可走 vault 闭包借用。

关键约束：

1. 不允许 `storage.*` 成为唯一还强依赖 vault 的旧链路。
2. `storage.*` 与 `cipher.*`、`intent.sign` 必须共享同一 owner 解析真值。

### 七、Session Window 刷新/关闭的语义直接收口为“重新启动 app”

本次固定：

1. session signer 只存在于 Session Window 当前内存。
2. Session Window 刷新或关闭后，signer runtime 丢失。
3. V1 不做：
   - 自动恢复 signer
   - 自动重连 launcher
   - 自动重建 bootstrap
   - signer 持久化
4. 用户重新从 Keymaster 启动 app 即可；旧 session 允许留存，下一次同 origin 启动时由 launcher 正常预建新 session 并吊销旧 peer。

---

## 7. 特殊情况应该怎么办

### 7.1 launcher 当前 vault 已锁定

处理原则：

1. `Open App` 直接失败。
2. 不打开 Session Window。
3. 不尝试 appView 里再补解锁。

原因：

- launcher 此时连 owner 私钥都借不出来，启动前置条件不成立。

### 7.2 launcher 没有可用 owner key

处理原则：

1. `Open App` 直接失败。
2. 不新增“先打开 app，再在 Session Window 里选 key”的第二套流程。

### 7.3 bootstrap 里的私钥与 ownerPublicKeyHex 对不上

处理原则：

1. Session Window bootstrap 直接失败。
2. 不缓存半残 signer。
3. 不写入 `appViewContext`。
4. 不打开 client app。

原因：

- 这是 owner 真值损坏，不允许继续。

### 7.4 Session Window 成功 bootstrap 后，用户切换主钱包 active key

处理原则：

1. 当前 app session 不受影响。
2. 已绑定的 `connectSessionId -> ownerPublicKeyHex -> session signer` 不变。

### 7.5 Session Window 成功 bootstrap 后，用户在主钱包删除这把 key

处理原则：

1. 当前 app session 继续运行到窗口结束。
2. 不做跨窗口全局驱赶。
3. 下一次从 Keymaster 启动 app 时，这把被删 key 不再可选。

设计取舍：

- 这是为了避免引入复杂的跨窗口 revoke / kill-switch。
- 当前 live session 已经拿到 session signer，V1 允许它自然结束。

### 7.6 Session Window 刷新

处理原则：

1. 视为 signer runtime 丢失。
2. 页面进入“session runtime missing / 请回到 Keymaster 重新打开应用”的失败态。
3. 不尝试用老 `connectSessionId` 自动恢复。

### 7.7 client app 还拿着旧 connectSessionId 继续发请求，但 Session Window signer 已经没了

处理原则：

1. 直接返回运行时缺失错误。
2. 不 fallback 到 vault。
3. 不自动建新 session。

### 7.8 `window.open()` 成功，但后续 bootstrap 失败

处理原则：

1. Session Window 自己显示失败态。
2. launcher 端这次启动视为失败结束。
3. 用户回到 Keymaster 再点一次 `Open App`。

### 7.9 同一个 app 连续多次点击打开

处理原则：

1. 允许。
2. 每次都新建 `connectSessionId`。
3. 每次都新建一份独立 session signer runtime。
4. 不做窗口单例复用。

---

## 8. 文件级施工清单

下面是本次硬切换必须触达的文件级变更范围。

### 一、协议文档

#### 1. `docs/keymaster-protocol-common-v1-draft.md`

必须修改：

1. 把 `appView` mode 的 handoff 从 `unlockRuntime` 改成 `sessionSigner`。
2. 明确同源只解决代码与存储，不解决 launcher 当前内存共享。
3. 明确 `appView` 运行期 owner 执行面来自 session signer，不来自 vault unlock runtime。
4. 明确 Session Window 刷新后 signer 丢失，用户需重新启动 app。

#### 2. `docs/keymaster-connect-v1-draft.md`

必须修改：

1. `connect.launch` 与 `runtimeBinding=session_signer` 的关系。
2. `connect.launch` 成功后返回的 session 仍是普通 `connectSessionId`，但运行时绑定是 `session_signer`。
3. `connect.resume` 对 appView stale session 不自动恢复 signer。

#### 3. `docs/keymaster-storage-v1-draft.md`

必须修改：

1. `storage.*` owner 内容 key 派生不再默认等同 vault。
2. 明确 `appView` session 下 storage 走 session signer 私钥派生。

### 二、contracts

#### 4. `packages/contracts/src/protocol.ts`

必须修改：

1. `ConnectSessionRecord` 增加 `runtimeBinding` 字段。
2. 删除 `UnlockRuntimeHandoff`。
3. 新增 `SessionSignerBootstrap`。
4. 修改 `AppBootstrapPayload`：
   - 删除 `unlockRuntime`
   - 增加 `sessionSigner`
5. 调整 `LaunchAppViewErrorCode`：
   - `export_unlock_runtime_failed` 改成更准确的 `export_session_signer_failed`
   - 对应注释和 UI 文案一起改
6. 调整 `ProtocolService` 注释，明确 appView 运行时不是完整 vault runtime。

#### 5. `packages/contracts/src/vault.ts`

必须修改：

1. 删除：
   - `exportUnlockRuntimeForSessionWindow()`
   - `importUnlockRuntimeFromLauncher(...)`
   - `UnlockRuntimeHandoff` re-export
2. 保留 `withPrivateKey(...)` 作为 launcher 借 owner 私钥的唯一基础能力。

### 三、plugin-vault

#### 6. `packages/plugin-vault/src/vaultService.ts`

必须修改：

1. 删除 unlock runtime export/import 实现。
2. 删掉相关状态回滚与导入逻辑。
3. 不再承担 Session Window bootstrap 导入已解锁态的职责。

#### 7. `packages/plugin-vault/src/vaultService.test.ts`

必须修改：

1. 删除 unlock runtime export/import 相关测试。
2. 保留并强调 `withPrivateKey(...)` 是借 owner 私钥的唯一受控入口。

### 四、plugin-protocol bootstrap 与运行时

#### 8. `packages/plugin-protocol/src/sessionWindowBootstrap.ts`

必须修改：

1. `LauncherHandoffInput` 删除 `unlockRuntime`，增加 `sessionSigner`。
2. `buildAppBootstrapPayload(...)` 改成输出 signer payload。
3. 相关注释全部从“导入 unlock runtime”改成“注册 session signer runtime”。

#### 9. `packages/plugin-protocol/src/protocolService.ts`

必须修改：

1. `launchAppView(...)` 不再调 `vault.exportUnlockRuntimeForSessionWindow()`。
2. 改为：
   - 解析 owner key
   - `vault.withPrivateKey(keyId, fn)` 借出 `privateKeyHex`
   - 组装 `sessionSigner` bootstrap
3. `applyLauncherBootstrap(...)` 不再导入 vault runtime，而是注册 in-memory signer runtime。
4. 新增统一的 owner execution runtime resolver。
5. 所有业务执行路径改用统一 resolver，不再各自直接调：
   - `resolveOwnerKeyMaterial`
   - `keyspace.getKey(...)`
   - `vault.withPrivateKey(...)`
6. `runtimeBinding=session_signer` 的请求，signer 缺失时报明确错误，不 fallback。
7. `openClientApp()` 之前只有 signer bootstrap 成功才允许继续。

#### 10. `packages/plugin-protocol/src/protocolStorageDb.ts`

必须修改：

1. DB version 升级。
2. `connectSessions` schema 增加 `runtimeBinding`。
3. 由于 session record 结构变化，`connectSessions` store 直接重建。
4. 不引入 signer 持久化 store。

#### 11. `packages/plugin-protocol/src/storageObjectService.ts`

必须修改：

1. `StorageCryptoBridge` 改为走统一 owner execution runtime，而不是只认 vault。
2. `deriveStorageContentKey(...)` 的入参与注释同步调整。
3. appView session 的 storage key 派生直接使用 session signer 私钥。

#### 12. `packages/plugin-protocol/src/manifest.ts`

必须修改：

1. `createVaultBackedStorageCryptoBridge(...)` 这类只认 vault 的桥接实现要收口或替换。
2. 相关 capability reason / 注释从“协议需要 active key 与 withPrivateKey”改成“connect mode 需要 vault；appView mode 可走 session signer runtime”。
3. i18n 错误文案从 unlock runtime 改成 session signer 失败文案。

#### 13. `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

必须修改：

1. appView mode 下的 UI 状态不能再等价于 vault locked/unlocked。
2. bootstrap 失败态文案改成 signer runtime 语义。
3. refresh 后缺 signer 的提示要明确引导用户回到 Keymaster 重新打开应用。

#### 14. `packages/plugin-protocol/src/protocolService.test.ts`

必须修改：

新增或调整至少覆盖：

1. `launchAppView()` 成功创建 `runtimeBinding=session_signer` session。
2. `launchAppView()` 借 owner 私钥失败时直接报错。
3. Session Window bootstrap 成功后不调用 vault import。
4. `runtimeBinding=session_signer` 的 `cipher.*` 使用 signer runtime，不读 active key。
5. `runtimeBinding=session_signer` 的 `storage.*` 使用 signer runtime，不读 vault。
6. active key 切换不影响既有 appView session。
7. signer 缺失时请求 fail-closed。
8. appView session refresh 后 `connect.resume` 不自动恢复 signer。

#### 15. `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

必须修改：

1. appView bootstrap 成功态；
2. signer 校验失败态；
3. refresh / signer 丢失提示态。

### 五、plugin-apps

#### 16. `packages/plugin-apps/src/appsCatalog.json`

必须修改：

在保留 `justnote` 的基础上，增加：

```txt
https://demo.apps.bsv8.com/
```

建议最小记录：

```txt
id        = "demo"
name      = "Demo"
appOrigin = "https://demo.apps.bsv8.com"
appUrl    = "https://demo.apps.bsv8.com/"
```

#### 17. `packages/plugin-apps/src/manifest.ts`

必须修改：

1. 错误文案从“安全交接准备失败”改成更准确的“session signer 准备失败”语义。
2. 中英文文案同步。

#### 18. `packages/plugin-apps/src/AppsPage.tsx`

必须修改：

1. 错误码映射同步新 code。
2. 不改启动入口形态，仍然只调用 `protocol.service.launchAppView(...)`。

#### 19. `packages/plugin-apps/src/AppsHomeWidget.tsx`

必须修改：

1. 错误码映射同步新 code。
2. 不改 widget 启动职责边界。

### 六、装配层与文档索引

#### 20. `apps/web/src/bootstrapPlugins.ts`

通常无需结构性修改，但必须确认：

1. `plugin-protocol` 在 `plugin-apps` 之前装配；
2. 新 bootstrap 模型不依赖额外插件顺序。

#### 21. `README.md`

如有必要，补一句：

1. appView 运行时使用 session-bound owner signer，不导入整套 wallet unlock runtime。

---

## 9. 实现顺序（一次性迭代，不分阶段上线）

虽然这是硬切换，但开发时仍按下面顺序落：

1. 先改 `docs + contracts`，把 `runtimeBinding`、`sessionSigner`、去掉 `unlockRuntime` 写死。
2. 再改 `plugin-vault`，删除 unlock runtime export/import。
3. 再改 `plugin-protocol` 的 bootstrap payload、session resolver、storage 执行面。
4. 再改 `ProtocolPopupPage` UI 状态与错误文案。
5. 再改 `plugin-apps` 错误码映射与新增 `demo` app。
6. 最后跑测试，补回归。

关键约束：

1. 不允许只改一半，让代码同时支持 `unlockRuntime` 和 `sessionSigner` 双模型长期共存。
2. 不允许先保留旧字段、后续再删；本单要求一次性硬切。
3. 不允许“签名先切、storage 后补”；本单要求同次完成。

---

## 10. 最终验收清单

### 10.1 contract 与文档真值

- [ ] `ConnectSessionRecord` 已有 `runtimeBinding` 字段。
- [ ] `AppBootstrapPayload` 不再包含 `unlockRuntime`。
- [ ] 已新增 `SessionSignerBootstrap` contract。
- [ ] `packages/contracts/src/vault.ts` 已移除 unlock runtime export/import API。
- [ ] `docs` 对 appView handoff 的描述统一改成 session signer。

### 10.2 launcher 启动链路

- [ ] 点击 `Open App` 时 launcher 仍然先创建新的 `connectSessionId`。
- [ ] `launchAppView()` 创建的 session 会持久化 `runtimeBinding=session_signer`。
- [ ] `launchAppView()` 不再调用 `exportUnlockRuntimeForSessionWindow()`。
- [ ] bootstrap payload 只包含 owner signer，不包含 vault unlock runtime。

### 10.3 Session Window 运行时

- [ ] Session Window consume bootstrap 后，不再调用 `vault.importUnlockRuntimeFromLauncher(...)`。
- [ ] Session Window 能在 `vault.status() === "locked"` 下服务 appView session。
- [ ] Session Window 内存中存在按 sessionId 索引的 signer runtime。
- [ ] refresh 后 signer runtime 丢失，页面进入明确失败态。

### 10.4 业务执行真值

- [ ] `cipher.*` 对 appView session 走 signer runtime，不读 active key。
- [ ] `intent.sign` 对 appView session 走 signer runtime，不读 active key。
- [ ] `storage.*` 对 appView session 走 signer runtime，不读 vault。
- [ ] `p2pkh.transfer` / `feepool.*` 对 appView session 走 signer runtime，不读 active key。
- [ ] `runtimeBinding=session_signer` 缺 signer 时 fail-closed。
- [ ] 不存在 fallback 到当前全局 active key 的路径。

### 10.5 connect / appView 共存

- [ ] `connect.login` 建的 session 是 `runtimeBinding=vault`。
- [ ] 传统 connect popup 功能不受影响。
- [ ] appView session 与 connect session 在同一套 protocol service 内共存，但执行面按 `runtimeBinding` 分流。

### 10.6 app catalog

- [ ] `appsCatalog.json` 中保留 `justnote`。
- [ ] `appsCatalog.json` 中新增 `https://demo.apps.bsv8.com/`。
- [ ] `/apps` 页面与首页 widget 都能看到新 app。

### 10.7 失败语义

- [ ] launcher vault locked 时，`Open App` 直接失败。
- [ ] owner key 缺失时，`Open App` 直接失败。
- [ ] signer payload 校验失败时，Session Window 直接失败。
- [ ] Session Window signer 丢失时，后续请求直接失败，不自动恢复。
- [ ] 整个系统不存在长期 signer 持久化。

---

## 11. 本次完成后的系统图

```txt
plugin-apps
  = 读本地 JSON app 清单
  = 展示 justnote + demo
  = 用户点击 Open App
      -> protocol.service.launchAppView(app)

protocol.service.launchAppView(app)
  = 校验 launcher 当前 vault 已解锁
  = 选定 ownerPublicKeyHex
  = 创建 connectSessionId(runtimeBinding=session_signer)
  = 通过 vault.withPrivateKey 借 owner privateKeyHex
  = 组装 sessionSigner bootstrap
  = 打开 /protocol/v1/popup?boot=appView&bootstrapToken=...

Session Window
  = consume bootstrap
  = 校验 sessionSigner 与 ownerPublicKeyHex 一致
  = 注册 in-memory session signer runtime
  = 打开 client app

client app
  = connect.launch({ launchToken })
  = 接上已预建 session
  = 后续所有方法都走：
      connectSessionId
        -> ownerPublicKeyHex
        -> runtimeBinding=session_signer
        -> in-memory session signer
```

这次硬切换完成后，appView 的权限面必须收敛到“这次 session 对应的一把 owner key”，不再把整套 wallet 解锁态搬进 Session Window。
