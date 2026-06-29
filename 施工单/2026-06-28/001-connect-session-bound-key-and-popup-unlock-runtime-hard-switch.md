# 001 Connect Session 绑定选中 Key + Popup 解锁运行时内存化硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-identity-get-v1-draft.md`
- `docs/keymaster-cipher-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/protocolValidation.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/contracts/src/keyspace.ts`

发生冲突时：

1. 本单新定义的 connect session / 选中 key / 解锁运行时语义优先。
2. 本单未覆盖的通用 popup transport 语义，继续以 `docs` 为准。
3. 后续若再改 connect 行为，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是对现有 `identity.get + active key + popup ready/closing` 模型的局部补丁，也不是“先给 caller 缓存 identity，后面再看怎么恢复”的过渡方案。

本单定义一次**硬切换**，目标是把当前 connect 从下面这套脆弱模型：

- caller 用 `identity.get` 拿一次身份快照；
- 后续 `cipher.encrypt/decrypt` 隐式依赖钱包全局 `active key`；
- popup 窗口一断，caller 既失去 transport，也失去稳定身份语义；
- popup 刷新、主站切 active key、其它页面操作都会污染当前 connect 使用者；

切到下面这套新定义：

- **登录时显式选择一把 key**；
- 后续整个 connect session 都绑定这把 key，不再依赖钱包全局 `active key`；
- caller 真正持有的是 `connectSessionId`，不是一次性的 `identity.get` 快照；
- popup transport session 与 connect auth session 解耦；
- popup 刷新/关闭后，auth session 仍可 `resume`；
- 但 popup 当前文档内的**解锁运行时材料**会丢失，必须重新输入密码恢复 unlock；
- 只有 caller 显式 `logout`，或绑定 key/会话本身失效，才真正要求重新登录。

后续实现、联调、验收以本单为单真值。

---

## 2. 简述缘由

### 2.1 当前 active key 不是 connect caller 可接受的稳定真值

当前 popup 协议路径把很多关键语义隐式绑在钱包全局 `active key` 上：

- `identity.get` 返回“当时 active key 的身份”；
- `cipher.encrypt/decrypt` 也隐式走当前 active key；
- caller 只要稍后再次发请求，就有可能命中另一把 key。

这对钱包主站是合理的，对外部站点不是。

外部站点真正需要的是：

- “我登录时用户明确给了我哪一把 key”
- “后续整个会话都还是这把 key”

而不是：

- “你下一次请求时钱包当前恰好 active 的那把 key”

### 2.2 popup transport 窗口不应该承载登录态真值

`ready/closing/popup.closed` 只适合描述：

- 这扇 popup 窗当前能不能收消息；
- 当前 transport 会话是否还活着。

它不适合描述：

- 当前 caller 是否已登录；
- 当前 caller 绑定的是谁；
- popup 刷新后是否应该重新登录。

把窗口生命周期和登录态绑死，必然导致：

- note 页面刷新后被迫重新登录；
- popup 短暂断线变成 auth 失效；
- caller 必须依赖一次性 identity 快照继续猜后续 owner。

### 2.3 unlock 运行时本来就该短命，但 auth session 不该短命

当前系统里“密码 / 解锁态 / 登录态”混在一起。

实际上它们应该是三层完全不同的东西：

1. 用户密码
2. popup 当前文档里的解锁运行时材料
3. caller 已获得授权的 connect session

这里真正应该短命的是：

- 用户输入的密码字符串
- popup 当前文档里的解锁运行时材料

不该短命的是：

- caller 已登录的 connect session

### 2.4 note 场景需要“登录做一次，后续尽量只补解锁”

对 note 这类持续编辑应用，更合理的用户体验是：

- 第一次显式登录时选 key；
- 以后即使 popup 关闭、刷新、transport 断线，也尽量通过 `resume` 恢复；
- 如果只是解锁态没了，补输密码即可；
- 不要重新选 key，不要重新登录，不要重新确认身份。

这正是本单要实现的目标。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. 新增一套显式 connect session 协议，不再要求 note 等 caller 以 `identity.get` 充当登录真值。
2. 登录时用户显式选择 key；connect session 绑定该 key 的 `publicKeyHex`。
3. 后续 `cipher.encrypt/decrypt` 必须基于 `connectSessionId` 找到绑定 key，不再读取钱包全局 `active key`。
4. popup transport session 断开后，caller 仍可通过 `connect.resume` 恢复 auth session。
5. popup 当前文档刷新/关闭后，**解锁运行时材料必须失效**。
6. `connect.resume` 命中“session 还在但未解锁”时，只要求用户重新输入密码恢复 unlock，不要求重新登录。
7. 只有 caller 显式 `connect.logout`，或 session/key/origin 本身失效时，才真正要求重新登录。
8. Keymaster 主站任意切换 active key、执行其它业务操作，不得影响已建立的 connect session。
9. 不得把密码、解锁运行时材料写入任何长期存储。

---

## 4. 本单补充定义

> 本段是本次硬切换的行为单真值。后续改 connect 行为，必须先改这里。

### 4.1 三层语义必须分开

本次固定分成三层：

```txt
popup transport session
  = popup 窗口级 postMessage 收发会话

connect auth session
  = caller 对当前 origin 已获得授权的持久会话

popup unlock runtime
  = 当前 popup 文档内可直接执行私钥操作的短期运行时材料
```

约束：

1. transport session 断开，不自动等于 auth session 失效。
2. auth session 存在，不自动等于 popup 当前文档已解锁。
3. unlock runtime 失效，不自动等于 caller 需要重新登录。

### 4.2 登录时选 key，后续 session 固定绑定

本次固定：

```txt
connect.login
  -> 用户显式选择一把 key
  -> 返回 connectSessionId
  -> 返回 ownerPublicKeyHex
  -> 后续所有 connect 业务都绑定这把 key
```

约束：

1. 绑定 key 的真值写在 connect session 记录里。
2. 后续 `resume` 不重新选 key。
3. 后续 `cipher.*` 不读取钱包全局 `active key`。

### 4.3 popup 当前文档刷新 = unlock runtime 失效，不是 auth 失效

本次固定：

```txt
popup 刷新/关闭/重载
  -> 当前 unlock runtime 丢失
  -> connectSession 仍可有效
  -> connect.resume 时若未解锁，只要求重新输入密码
```

约束：

1. popup 当前文档里的解锁运行时材料只能存在内存里。
2. 不允许跨刷新复用 unlock runtime。
3. 不允许通过长期存储或跨文档共享把 unlock runtime “续命”。

### 4.4 caller 主动 logout 是 auth 失效的唯一正常路径

本次固定：

```txt
connect.logout
  -> 吊销 connect session
  -> 清掉 popup unlock runtime
  -> caller 必须清掉本地 sessionId
```

只有下面这些情况允许把 caller 打回“需要重新登录”：

1. caller 主动 `logout`
2. sessionId 不存在
3. session 已吊销
4. origin 不匹配
5. 绑定 key 已删除 / 不可用 / 身份未 ready

单纯 popup 断线、popup 刷新、vault 重新锁定，都**不**属于“必须重新登录”。

---

## 5. 协议硬切换定义

## 5.1 新增 connect 方法族

本次新增：

- `connect.login`
- `connect.resume`
- `connect.logout`

本次不删除：

- `identity.get`
- `cipher.encrypt`
- `cipher.decrypt`

但对 note 这类“持续登录态 caller”来说：

- `identity.get` 不再作为登录入口真值；
- `cipher.*` 的稳定调用路径改为 session 绑定版本。

### 5.1.1 `connect.login`

用途：

- 首次显式登录
- 选择 key
- 建立 connect auth session

输入必须至少包含：

- `origin` 仍然通过浏览器 `event.origin` 取真值
- `claims` 请求列表
- `text` 或等价确认文案字段

输出必须至少包含：

- `connectSessionId`
- `ownerPublicKeyHex`
- `resolvedClaims`
- `resolvedAt`

行为：

1. popup 若当前未解锁，先进入 unlock UI；
2. unlock 成功后进入“选择 key + 确认授权”；
3. 用户明确选定一把 key；
4. Keymaster 建立 connect session 记录；
5. 返回 sessionId 与身份快照。

### 5.1.2 `connect.resume`

用途：

- caller 在已有 `connectSessionId` 时恢复登录态
- 用于页面刷新、popup 关闭重开、transport 断线重建

输入必须至少包含：

- `connectSessionId`

输出必须至少包含：

- `connectSessionId`
- `ownerPublicKeyHex`
- `resolvedClaims`
- `resolvedAt`

行为：

1. 查 session 是否存在；
2. 校验 `event.origin` 与 session.origin 一致；
3. 校验绑定 key 仍存在且 identity ready；
4. 若 session 无效，直接失败并要求 caller 重新 login；
5. 若 session 有效但 popup 当前未解锁，先进入 unlock UI；
6. unlock 成功后恢复该 session；
7. 返回原 session 绑定的 `ownerPublicKeyHex`。

关键约束：

1. `resume` 不重新选 key。
2. `resume` 不因为当前钱包全局 active key 不同而失败。
3. `resume` 只校验 session 自己绑定的 key 是否仍存在/可用。

### 5.1.3 `connect.logout`

用途：

- caller 主动注销

输入必须至少包含：

- `connectSessionId`

行为：

1. 吊销该 session；
2. 清掉与当前 popup 文档相关的 unlock runtime；
3. 后续同 sessionId 的 `resume` 必须失败。

---

## 5.2 cipher 改为 session 绑定，不再依赖 active key

### 5.2.1 `cipher.encrypt`

本次协议语义改为：

```txt
cipher.encrypt(connectSessionId, content)
  -> 通过 connectSessionId 找到绑定 key
  -> 用该 key 对应的站点绑定能力执行加密
```

### 5.2.2 `cipher.decrypt`

本次协议语义改为：

```txt
cipher.decrypt(connectSessionId, nonce, cipherbytes)
  -> 通过 connectSessionId 找到绑定 key
  -> 用该 key 对应的站点绑定能力执行解密
```

关键约束：

1. `cipher.*` 不再从“当前 active key”读取执行身份。
2. `cipher.*` 必须失败关闭，而不是静默 fallback 到另一把 key。
3. `cipher.*` 若 session 有效但 popup 当前未解锁，应进入 unlock UI，而不是要求 caller 重新 login。

---

## 5.3 Connect Session 存储模型

本次新增一个持久化 store，例如：

```txt
connectSessions
```

每条记录至少包含：

- `sessionId`
- `origin`
- `ownerPublicKeyHex`
- `claimsSnapshot`
- `createdAt`
- `lastUsedAt`
- `revokedAt | null`

可选字段：

- `displayName`
- `sessionLabel`
- `grants`

关键约束：

1. 这是 auth session 真值；
2. 它允许持久化；
3. 它不等于 unlock runtime；
4. 它不应混入 pending request、中间密文、解锁材料。

---

## 5.4 Popup Unlock Runtime 设计

unlock runtime 必须满足：

1. 只存在于 popup 当前文档内存；
2. 不写入 `localStorage` / `sessionStorage` / `IndexedDB`；
3. 不通过 URL / hash / query 传播；
4. popup 刷新、关闭、重载后立即失效。

这里要明确：

- **不是“密码保存在内存里”**
- 而是“解锁后可直接执行私钥操作的运行时材料保存在内存里”

用户密码字符串只用于当次解锁：

1. 用户输入密码；
2. 派生或恢复运行时解锁材料；
3. 密码字符串从 React state / service 临时变量中尽快丢弃；
4. 后续仅保留 unlock runtime。

---

## 5.5 Popup UI 硬切换

本次 popup UI 需要新增三类明确视图：

### 5.5.1 Login 选择 key 视图

仅用于 `connect.login`：

1. 若未解锁，先显示 unlock；
2. 解锁后显示可选 key 列表；
3. 用户明确选择一把 key；
4. 再做 session 授权确认。

### 5.5.2 Resume 解锁视图

仅用于 `connect.resume` 且 session 有效但未解锁：

1. 不显示“重新登录”语义；
2. 不重新选 key；
3. 文案明确为“恢复已授权会话，需要输入密码解锁当前本地 Vault”；
4. 解锁成功后继续原 session。

### 5.5.3 Logout 结果视图

用于 `connect.logout`：

1. 可无额外交互，快速完成；
2. 完成后 caller 后续 `resume` 必须失败。

---

## 6. 特殊情况提前定义

## 6.1 popup 刷新

处理：

1. 当前 popup 文档内的 unlock runtime 失效；
2. connect session 持久化记录仍保留；
3. caller 下次 `resume` 时只要求重新输入密码；
4. 不要求重新登录；
5. 不要求重新选 key。

## 6.2 popup 关闭后重开

处理同上：

1. transport 断开；
2. unlock runtime 丢失；
3. `resume` 时补解锁；
4. 不重新 login。

## 6.3 caller 页面刷新

处理：

1. caller 自己保留 `connectSessionId`；
2. 启动后优先发 `connect.resume`；
3. 如果 session 有效但未解锁，popup 要求输入密码；
4. 解锁后继续进入工作区；
5. 不重新登录。

## 6.4 钱包主站切换 active key

处理：

1. 不影响既有 connect session；
2. `resume` 与 `cipher.*` 继续使用 session 绑定 key；
3. 不允许静默漂移到新的 active key。

## 6.5 session 绑定 key 被删除

处理：

1. `resume` 必须失败；
2. 返回“需要重新登录”；
3. caller 清掉本地 `connectSessionId`；
4. 不允许自动切到另一把 key。

## 6.6 session 绑定 key identity 未 ready

处理：

1. `resume` 必须失败关闭；
2. caller 需要重新登录或等待 key 恢复；
3. 不允许 fallback 到别的 ready key。

## 6.7 origin 不匹配

处理：

1. `resume/logout/cipher.*` 直接失败；
2. 不允许跨 origin 复用 session；
3. caller 必须重新走本 origin 的 login。

## 6.8 caller 同时打开多个标签页

处理：

1. 多个 caller 标签页可以各自持有同一个 `connectSessionId`；
2. 但每个 popup 文档的 unlock runtime 各自独立；
3. 某个 popup 刷新失效，不自动续命另一个 popup；
4. 不要求这次迭代做跨 popup unlock 共享。

## 6.9 caller 主动 logout 后立即 resume

处理：

1. `resume` 必须失败；
2. 不允许“logout 只是清 caller，本地 session 其实还活着”。

---

## 7. 不能怎么做

下面这些做法本单明确禁止：

1. 继续让 `identity.get` 充当 note 这类 caller 的长期登录入口真值。
2. 继续把 popup transport 窗口是否还活着，当成 auth session 是否还活着。
3. 继续让 `cipher.*` 读取钱包全局 `active key`。
4. 登录后每次业务请求再次要求用户选 key。
5. caller 侧每次 `resume` 都重新变相走一次 login。
6. 把用户密码、解锁运行时材料写进 `localStorage` / `sessionStorage` / `IndexedDB`。
7. 用 `BroadcastChannel`、全局单例或其它跨文档共享，把 unlock runtime 跨 popup 刷新续命。
8. 当 session 绑定 key 失效时，自动切到另一把 key。
9. caller 主动 logout 之外，因 popup transport 抖动就直接把 auth session 吊销。
10. 为了“少输密码”，把 popup 解锁态提升为长期持久状态。

---

## 8. 文件级实施方案

## 8.1 `docs/keymaster-protocol-v1-draft.md`

目标：

- 把当前总览里“popup transport 生命周期”和“持续登录 caller 的 auth session”分开。
- 明确新增 connect 方法族。

需要做的事：

1. 新增 `connect.login / connect.resume / connect.logout` 索引。
2. 明确 `identity.get` 仍保留，但不是持续登录 caller 的推荐入口。
3. 明确 `cipher.*` 的 session 绑定执行语义。
4. 明确 popup refresh 只丢 unlock runtime，不等于 logout。

## 8.2 `docs/keymaster-protocol-common-v1-draft.md`

目标：

- 补齐 auth session 与 unlock runtime 的公共约束。

需要做的事：

1. 新增“transport session / auth session / unlock runtime 分层”章节。
2. 明确 `closing` 只表示 transport 断开。
3. 明确 caller 断线后可通过 `resume` 恢复。
4. 明确 unlock runtime 只在 popup 当前文档内存中存在。

## 8.3 新增 `docs/keymaster-connect-v1-draft.md`

目标：

- 单独定义 connect 方法族。

需要做的事：

1. 定义 `connect.login`
2. 定义 `connect.resume`
3. 定义 `connect.logout`
4. 定义请求/响应字段
5. 定义失败语义与 caller 行为边界

## 8.4 `packages/contracts/src/protocol.ts`

目标：

- 扩展 contract 类型，加入 connect 方法族与 connect session 数据结构。

需要做的事：

1. 在 `ProtocolMethod` 中加入 `connect.login` / `connect.resume` / `connect.logout`。
2. 新增对应 `params/result` 类型。
3. 新增 `ConnectSessionRecord` 或等价结构。
4. 为 `cipher.*` 增加 `connectSessionId` 输入字段。
5. 文档注释里明确“不依赖 active key”。

## 8.5 `packages/plugin-protocol/src/protocolValidation.ts`

目标：

- 新增 connect 方法族的参数校验。

需要做的事：

1. 校验 `connectSessionId`
2. 校验 login/resume/logout 的必填字段
3. 明确 origin/session 绑定校验入口

## 8.6 `packages/plugin-protocol/src/protocolStorageDb.ts`

目标：

- 增加 `connectSessions` store。

需要做的事：

1. DB schema 升级
2. `put/get/revoke/list` connect session 记录
3. 不把 unlock runtime 落盘
4. 不把密码或中间私钥材料落盘

## 8.7 `packages/plugin-protocol/src/protocolService.ts`

目标：

- 把 connect session 变成协议真值；
- 把 cipher 执行身份从 active key 切到 session 绑定 key。

需要做的事：

1. 实现 `connect.login`
2. 实现 `connect.resume`
3. 实现 `connect.logout`
4. 新增“按 sessionId 解析绑定 key”的公共分支
5. `cipher.encrypt/decrypt` 改走 session 绑定 key
6. popup 未解锁时，`resume` 与 `cipher.*` 进入 unlock UI，而不是要求重新 login
7. `logout` 后 revoke session

不能做的事：

1. `resume` 时重新读取 active key 决定 owner
2. `cipher.*` 校验失败后 fallback 到当前 active key

## 8.8 `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

目标：

- 增加 login 选 key 视图与 resume 解锁视图。

需要做的事：

1. 为 `connect.login` 增加“选 key + 确认”UI
2. 为 `connect.resume` 增加“仅解锁恢复”UI
3. 文案明确区分“需要登录”与“需要解锁”
4. 不把 popup 刷新后的恢复入口误画成重新登录

## 8.9 `packages/plugin-protocol/src/manifest.ts`

目标：

- 增补 connect 方法族的多语言文案。

需要做的事：

1. login 选 key 文案
2. resume 解锁文案
3. logout 文案
4. session 失效 / key 丢失 / 需要重新登录文案

## 8.10 `packages/plugin-vault/src/vaultService.ts`

目标：

- 继续只负责 unlock runtime 的生命周期；
- 不要越界承担 connect auth session 真值。

需要做的事：

1. 保持 unlock 后只在当前文档内建立运行时材料
2. popup 刷新/关闭后自然丢失
3. 不新增长期持久化 unlock 状态

## 8.11 测试文件

目标：

- 为本单所有关键边界补单测/集成测。

重点补：

1. login 后返回 sessionId 与选定 key
2. resume 时不重新选 key
3. popup refresh 后 resume 只要求解锁
4. active key 切换不影响 session 绑定 key
5. 绑定 key 删除后 resume 失败
6. logout 后 resume 失败
7. cipher.* 只认 session 绑定 key

---

## 9. 最终验收清单

### 9.1 首次登录

1. caller 首次发 `connect.login`。
2. popup 若 locked，先要求输入密码。
3. unlock 后展示 key 选择界面。
4. 用户选定一把 key 并确认。
5. 返回 `connectSessionId + ownerPublicKeyHex + claimsSnapshot`。

### 9.2 刷新 caller 页面

1. caller 本地保留 `connectSessionId`。
2. 刷新后优先发 `connect.resume`。
3. 若 popup 当前未解锁，只要求输入密码。
4. 解锁后恢复原 session。
5. 不重新登录，不重新选 key。

### 9.3 popup 刷新

1. popup 当前解锁运行时失效。
2. caller 再次 `resume` 时要求输入密码。
3. 解锁后继续原 session。
4. 不重新 login。

### 9.4 active key 切换

1. 用户在 Keymaster 主站切换 active key。
2. 已有 connect session 继续可用。
3. `resume` 与 `cipher.*` 仍走 session 绑定 key。
4. 不发生 owner 漂移。

### 9.5 绑定 key 删除

1. 删除 session 绑定 key。
2. 之后 `connect.resume` 失败。
3. caller 被要求重新登录。
4. 不自动切到其它 key。

### 9.6 logout

1. caller 发 `connect.logout`。
2. session 被吊销。
3. caller 清掉本地 sessionId。
4. 后续 `resume` 必须失败。

### 9.7 安全边界

1. 代码与浏览器存储中不存在持久化的用户密码。
2. 不存在持久化的 popup unlock runtime。
3. popup 刷新/关闭后，必须重新输入密码恢复 unlock。
4. transport 断开不自动等于 auth session 吊销。

---

## 10. 本次落地完成的标志

满足以下全部条件，才算本单完成：

1. Keymaster 协议已经把 connect session 作为持续登录 caller 的正式真值。
2. 登录时显式选 key，后续会话不再依赖 active key。
3. caller 刷新与 popup 刷新都能通过 `resume` 恢复，而不是重新 login。
4. popup 当前文档 refresh 后只补解锁，不补登录。
5. caller 主动 logout 才是正常注销路径。
6. 所有相关文档、contract、实现、测试已同步，不存在“两套真值”。
