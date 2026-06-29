# Connect V1（草案）

本文档定义 Keymaster 对外协议 V1 的 connect session 方法族。

connect session 是**所有外部业务方法**的正式真值（施工单 2026-06-28 002
硬切换）。caller 在接入时通过 `connect.login` 建会话并绑定 owner
public key；后续 `identity.get` / `intent.sign` / `cipher.encrypt` /
`cipher.decrypt` / `p2pkh.transfer` / `feepool.prepare` / `feepool.commit`
全部必须基于此 session 绑定的 owner 执行，**不**读取钱包全局 active key。

## 适用边界

connect 方法族**仅**为外部站点提供"会话级"语义；所有外部业务方法
都属于某个 `connectSessionId`（`connect.login` 是唯一不要求
`connectSessionId` 的入口方法）。owner 唯一真值 = session 绑定的
`ownerPublicKeyHex`。

持续登录 caller 在接入时应当：

1. 首次调用 `connect.login` → 拿到 `connectSessionId`；
2. 把 `connectSessionId` 持久化在 caller 本地（localStorage / IndexedDB）；
3. 后续所有业务方法都必传 `connectSessionId`；
4. 启动 / popup 断线重建后调用 `connect.resume` 恢复会话；
5. 主动注销时调用 `connect.logout`。

## 三层语义

connect session 与 popup transport、popup unlock runtime 三层语义
互相独立，详见[公共约定](./keymaster-protocol-common-v1-draft.md)
的"三层会话语义"段。核心要点：

- transport 断开（`closing` / `popup.closed === true`）**不**吊销
  connect session；caller 通过 `connect.resume` 恢复。
- popup unlock runtime 失效（refresh / close / relock）**不**要求
  caller 重新 `connect.login`；`connect.resume` 触发补 unlock 即可。
- `connect.logout` 是 auth 失效的**唯一**正常路径。

## 方法族

| 方法 | 用途 | popup 当前文档 locked 时 | popup unlocked 时 |
| --- | --- | --- | --- |
| `connect.login` | 首次显式登录 + 选 key + 落 session | 进入 waiting_unlock_manual；解锁后进入"选 key + 确认"视图（confirming） | 进入"选 key + 确认"视图（confirming） |
| `connect.resume` | caller 持 sessionId，恢复会话 | 进入 waiting_unlock_manual；解锁后**直接** queued → executing → approved（**不**经 confirming / 不弹"恢复"按钮） | **直接** queued → executing → approved（**不**经 confirming / 不弹"恢复"按钮） |
| `connect.logout` | caller 主动注销 | 进入 waiting_unlock_manual；解锁后**不**经过 confirming，直接 queued → executing | **不**经过 confirming，直接 queued → executing |

### `connect.login`

#### 输入

```ts
{
  text: string;                // 人类可读确认文案
  claims?: string[];           // 可选；要返回的 claim 名列表
}
```

**关键（硬切换修复）：** `ownerPublicKeyHex` **不**在 params 里。owner
是用户在 popup UI 上**明确**选定的；service 不能替 caller 决定。
caller 发起 `connect.login` 后 popup 解锁 → 展示 ready key 列表
让用户选 → 用户点"用此 key 登录"时由 UI 调
`service.confirmConnectLogin(recordId, ownerPublicKeyHex)` 一次性写入
service 内部 record。

`origin` 不在 params 里——service 按 `event.origin` 取真值。

#### 输出

```ts
{
  connectSessionId: string;     // caller 必须存本地
  ownerPublicKeyHex: string;    // owner 唯一真值（施工单 2026-06-28 002 硬切换：ownerKeyId 移除）
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
}
```

#### 行为

1. popup 若 locked，先进入 unlock UI（解锁表单 + 待处理概要）；
2. unlock 成功后进入"选择 key + 确认授权"视图；
3. 用户明确选定一把 key；UI 调 `confirmConnectLogin(recordId, ownerPublicKeyHex)`；
4. Keymaster 建立 `ConnectSessionRecord` 记录（写 IndexedDB
   `connectSessions` store）；
5. 返回 `connectSessionId` 与身份快照。

#### 失败语义

- popup locked 时用户取消解锁 → `user_rejected`；
- 用户在选 key 视图点"取消" → `user_rejected`；
- 候选 key 列表为空（无 ready key）→ `user_rejected`（UI 展示"无
  ready key"兜底文案，但 confirm 按钮 disable）；
- DB 不可用 → `internal_error`（本地 reason），对外 `user_rejected`；
- owner key 已删 / identity 未 ready → `internal_error`，对外
  `user_rejected`。

### `connect.resume`

#### 输入

```ts
{
  connectSessionId: string;
}
```

#### 输出

```ts
{
  connectSessionId: string;
  ownerPublicKeyHex: string;    // owner 唯一真值（施工单 2026-06-28 002 硬切换：ownerKeyId 移除）
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;          // 本次 resume 的时间戳，**不**是 connect.login 时的快照时间
}
```

#### 行为（关键不变量）

1. **acceptRequest 阶段同步预校验** session 真值：
   - sessionId 对应的 `ConnectSessionRecord` 必须存在；
   - `event.origin === session.origin`，不一致 → `invalid_origin`；
   - `session.revokedAt === null`，否则 session 已吊销；
   - 绑定 key 必须仍存在且 `identityStatus === "ready"`。
2. **预校验失败 → 直接 fail-fast**：service 立即把 record 置为
   `phase=failed` 并向 opener 回 `result(ok=false)`。
   - locked / unlocked 状态**一视同仁**——fail-fast **不依赖** vault
     unlock，**不**经过任何"解锁" / "确认" UI；用户看不到额外交互。
   - 对外错误码：`user_rejected`（跨 origin 失败时为 `invalid_origin`）；
   - 本地 reason：`internal_error`；
   - caller 收到失败后必须重新 `connect.login`。
3. **预校验通过 + popup 当前未解锁** → 进入 `waiting_unlock_manual`，
   走锁屏页（解锁表单 + 待处理概要）。
4. **解锁后**：`connect.resume` **不**经过任何 confirming UI，**不**
   要求用户再点"恢复"按钮——**直接** queued → executing → approved。
   这是施工单 4.3 + 9.2 / 9.3 明确要求的"只补解锁，自动恢复"。
5. **预校验通过 + popup 已 unlocked** → 同 4，直接 queued → executing
   → approved（同样不弹"恢复"按钮）。
6. 执行阶段再次校验 session 真值（防止 acceptRequest 与 execute 之间
   session 被另一 tab 改 DB 吊销）；任何校验失败 → `user_rejected` +
   `internal_error`。
7. 执行成功 → 返回原 session 绑定的 `ownerPublicKeyHex` 与
   `claimsSnapshot`，刷新 `session.lastUsedAt`。

#### 关键约束

- `resume` **不**重新选 key；
- `resume` **不**因为当前钱包全局 active key 不同而失败；
- `resume` 只校验 session 自己绑定的 key 是否仍存在 / 可用；
- session 真值被吊销后，resume 必须失败（不允许"logout 只是清
  caller，本地 session 其实还活着"的语义）；
- 若 origin 不匹配，直接拒掉（`invalid_origin`），不允许跨 origin
  复用 session；
- **popup 刷新 / 关闭后** caller 只看到"补 unlock"，**不**经历第二次
  "恢复"确认。

### `connect.logout`

#### 输入

```ts
{
  connectSessionId: string;
}
```

#### 输出

```ts
{
  connectSessionId: string;
  revokedAt: number;
}
```

#### 行为

1. 按 sessionId 查 session 记录；
2. 不存在视为幂等成功（直接返回 `revokedAt = now`）；
3. 已 revoke 视为幂等成功（返回原 `revokedAt`）；
4. 跨 origin 直接拒掉（`invalid_origin`）；
5. 否则写 `session.revokedAt = now` 并持久化；
6. **同步**调 `vault.lock()`（await），失败 propagate 为 `internal_error`
   （关键修复）：
   - vault 内部 `setStatus("locked")` + publish `vault.locked` →
     popup 顶层 `vault.onStatusChange` 监听 → `service.setVaultLockState(true)`
     → popup 当前文档回到锁屏页；其它 confirm / queued request 进入
     `waiting_unlock_manual`（与现有 relock 行为一致）。
   - **不允许** fire-and-forget：若 `keyspace.onVaultLocked()` 或业务订阅者
     抛错，必须让 caller 看到 `internal_error`，避免"session 已吊销但
     unlock runtime 没清"的错位状态。
   - 失败时 session 真值层面 logout 已生效（revokedAt 已 commit），
     下次 `connect.resume` / `cipher.*` 仍会按 fail-fast 失败——这是
     fail-closed 的安全语义，不是 bug。
7. 后续同 sessionId 的 `connect.resume` 必须失败（fail-fast）；
8. 后续同 sessionId 的 `cipher.*` 必须失败（fail-fast）。

#### 关键约束

- unlocked 路径**不**经过 confirming，直接 queued → executing
  （"可无额外交互，快速完成"）；
- locked 路径解锁后**也**直接 queued → executing（**不**经过 confirming）；
- 不允许 `logout` 隐式"清 caller 本地 sessionId 但 service 真值仍在"；
  logout 必须真在 DB 里写 `revokedAt`；
- 不允许把 `revokedAt` 写成 null / 0；必须写入 unix milliseconds；
- **logout 之后 popup 必须回到 locked**：与施工单 4.4 + 5.1.3
  "清掉 popup unlock runtime"语义一致；
- `vault.lock()` 失败时必须 propagate 为 `internal_error`——这是
  fail-closed 安全语义，宁可让 caller 看到失败，也不能让"session 已吊销
  但 unlock runtime 仍在"的状态错位。

## ConnectSessionRecord 持久化模型

```ts
interface ConnectSessionRecord {
  sessionId: string;
  origin: string;
  // 施工单 2026-06-28 002 硬切换：owner 唯一真值 = ownerPublicKeyHex。
  // ownerKeyId 已移除——vault 内部借用句柄按需从 keyspace 解析。
  ownerPublicKeyHex: string;
  ownerLabel: string;
  claimsSnapshot: Record<string, ResolvedClaimValue>;
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}
```

### 持久化范围

**写**入 IndexedDB `connectSessions` store：

- sessionId / origin / ownerPublicKeyHex / ownerLabel
  （ownerKeyId 已移除——施工单 2026-06-28 002 硬切换）
- claimsSnapshot（本次 connect.login 解析一次的 claims 真值）
- createdAt / lastUsedAt / revokedAt

**不**写入：

- 任何形式的密码（包括派生材料 / 解锁材料）；
- 任何私钥字节；
- 任何 popup 解锁运行时材料；
- 完整密文 / 完整签名 / 解密明文。

### 关键不变量

1. `ownerPublicKeyHex` 在创建后**不**可变（resume 不重新选 key）。
2. session 真值允许 popup 关闭 / 刷新 / 跨 tab 共享；
   `connect.resume` 按 sessionId + origin 找到对应记录。
3. `connect.resume` 不修改 `createdAt`；只刷新 `lastUsedAt`。
4. `connect.logout` 是 session 真值发生"吊销态"翻转的**唯一**入口。
5. sessionId / origin / ownerPublicKeyHex 三元组是 session 的稳定真值。
6. 不允许通过 transport 跨 origin 复用 sessionId。

## 所有业务方法的 session 绑定语义

施工单 2026-06-28 002 硬切换：所有外部业务方法都属于 `connectSessionId`。
`cipher.encrypt` / `cipher.decrypt` 仅是其中一类，`identity.get` /
`intent.sign` / `p2pkh.transfer` / `feepool.prepare` / `feepool.commit`
**同样**强制要求 `connectSessionId` 入参；`connect.login` 是唯一不要求
`connectSessionId` 的入口方法（它本身负责建 session）。

```ts
identity.get(aud, iat, exp, text, claims, connectSessionId)
intent.sign(aud, iat, exp, text, contentType, content, connectSessionId)
cipher.encrypt(text, contentType, content, connectSessionId)
cipher.decrypt(text, nonce, cipherbytes, connectSessionId)
p2pkh.transfer(recipientAddress, amountSatoshis, feeRateSatoshisPerKb, connectSessionId)
feepool.prepare(counterpartyPublicKeyHex, amountSatoshis, connectSessionId)
feepool.commit(operationId, counterpartyPublicKeyHex, connectSessionId, counterpartySignatures, ...)
```

`connectSessionId` 强制输入字段；缺省 / 空字符串一律 `invalid_request`。
service 在 acceptRequest 阶段**同步预校验** session 真值：

1. sessionId 对应记录存在；
2. `session.origin === event.origin`，不一致 → `invalid_origin`；
3. `session.revokedAt === null`，否则 session 已吊销；
4. owner key 仍 ready。

**预校验失败 → 直接 fail-fast（关键修复）**：

- service 立即把 record 置为 `phase=failed`，向 opener 回
  `result(ok=false)`；
- **不**进入任何"解锁" / "确认" UI——locked / unlocked 状态一视同仁；
- 用户看不到额外交互；caller 必须重新 `connect.login`。

**预校验通过**：

- popup 当前 unlocked → 直接进入 `confirming` 视图（用户确认后
  执行）；
- popup 当前 locked → 进入 `waiting_unlock_manual`；解锁后进入
  `confirming` 视图。

执行阶段（所有业务方法）：

5. 通过 `keyspace.getKey(session.ownerPublicKeyHex)` 解析当前 vault
   内部 keyId → `vault.withPrivateKey(keyId, ...)` 借用私钥；
6. 用 session 绑定的 owner public key 派生签名 / 选币 / 站点密钥
   并执行业务；
7. 刷新 `session.lastUsedAt`。

业务方法路径**不**读取钱包全局 active key。任何"缺 connectSessionId
但仍然执行业务"的实现都被视为对硬切换的破坏。

### 失败语义（业务方法路径）

| 失败场景 | 对外 error code | 本地 failureReason | 路径 |
| --- | --- | --- | --- |
| sessionId 缺失 / 空 | `invalid_request` | （不写 record；顶层校验失败直接忽略） | validation |
| session 不存在 | `user_rejected` | `internal_error` | **fail-fast** |
| session 已吊销 | `user_rejected` | `internal_error` | **fail-fast** |
| origin 不匹配 | `invalid_origin` | （路径不再走 localFailure） | **fail-fast** |
| owner key 不 ready | `user_rejected` | `internal_error` | **fail-fast** |
| session 有效 + popup 当前未解锁 | （进入 unlock UI，不是错误） | — | normal |
| 解锁后 owner key 仍 ready | `user_rejected` | `internal_error` | execute |
| AES-GCM / 内容 / nonce 错（仅 cipher） | `decrypt_failed` | `decrypt_failed` | execute |

不允许业务方法路径 fallback 到 active key；不允许在 session 无效
时静默选另一把 key；不允许 fail-fast 让用户先做无意义的解锁 / 确认。

## 特殊情况

### popup 刷新

处理：

1. popup 当前文档 unlock runtime 失效；
2. connect session 持久化记录仍保留（IndexedDB）；
3. caller 下次 `connect.resume` 时只要求重新输入密码；
4. **不**要求重新登录；
5. **不**要求重新选 key；
6. **不**要求再点"恢复"按钮——解锁后自动恢复（见 `connect.resume`
   行为段）。

### popup 关闭后重开

处理同上。

### caller 页面刷新

处理：

1. caller 自己保留 `connectSessionId`；
2. 启动后优先发 `connect.resume`；
3. **session 无效** → 直接收到 `user_rejected`/`invalid_origin`
   result，caller 清掉本地 `connectSessionId` 并重新 `connect.login`；
4. **session 有效 + 未解锁** → popup 要求输入密码；
5. **解锁后** 继续进入工作区；caller 收到 `result(ok=true)`，
   `resolvedAt` 是本次时间戳；
6. 不重新登录；不重新选 key；不重新点"恢复"按钮。

### 钱包主站切换 active key

处理：

1. **不**影响既有 connect session；
2. `connect.resume` 与 `cipher.*` 继续使用 session 绑定 key；
3. **不**允许静默漂移到新的 active key。

### session 绑定 key 被删除

处理：

1. `connect.resume` 走 fail-fast：直接回 `user_rejected` /
   `internal_error`，**不**进 unlock UI（即使 vault 当前 locked）；
2. caller 清掉本地 `connectSessionId`；
3. **不**允许自动切到另一把 key。

### session 绑定 key identity 未 ready

处理：

1. `connect.resume` 走 fail-fast（与"key 被删除"同语义）；
2. caller 需要重新登录或等待 key 恢复；
3. **不**允许 fallback 到别的 ready key。

### origin 不匹配

处理：

1. `connect.resume` / `connect.logout` / `cipher.*` 走 fail-fast：
   直接回 `invalid_origin`；
2. **不**允许跨 origin 复用 session；
3. caller 必须重新走本 origin 的 login。

### caller 同时打开多个标签页

处理：

1. 多个 caller 标签页可以各自持有同一个 `connectSessionId`；
2. 但每个 popup 文档的 unlock runtime 各自独立；
3. 某个 popup 刷新失效，**不**自动续命另一个 popup；
4. 不要求这次迭代做跨 popup unlock 共享。

### logout 后立即 resume

处理：

1. `connect.resume` 走 fail-fast：直接回 `user_rejected` /
   `internal_error`；
2. **不**允许"logout 只是清 caller，本地 session 其实还活着"的语义；
3. popup 当前 vault 已被 logout 同步清到 locked，caller 也**不**会
   看到"恢复会话" UI。

### caller 主动 logout 后立即 resume

处理：

1. `connect.resume` 走 fail-fast：直接回 `user_rejected` /
   `internal_error`；
2. **不**允许"logout 只是清 caller，本地 session 其实还活着"的语义；
3. popup 当前 vault 已被 logout 同步清到 locked，caller 也**不**会
   看到"恢复会话" UI。

## 不能怎么做

下面这些做法本草案明确禁止：

1. 继续让 `identity.get` 充当 note 这类 caller 的长期登录入口真值。
2. 继续把 popup transport 窗口是否还活着，当成 auth session 是否还活着。
3. 继续让 `cipher.*` 读取钱包全局 active key。
4. 登录后每次业务请求再次要求用户选 key。
5. caller 侧每次 `connect.resume` 都重新变相走一次 login（包括再多
   点一次"恢复"按钮）。
6. 把用户密码、解锁运行时材料写进 `localStorage` / `sessionStorage` /
   `IndexedDB`。
7. 用 `BroadcastChannel`、全局单例或其它跨文档共享，把 unlock runtime
   跨 popup 刷新续命。
8. 当 session 绑定 key 失效时，自动切到另一把 key。
9. caller 主动 logout 之外，因 popup transport 抖动就直接把 auth
   session 吊销。
10. 为了"少输密码"，把 popup 解锁态提升为长期持久状态。
11. 在 cipher 路径上 fallback 到 active key。
12. 跨 origin 复用 sessionId。
13. 在 session 无效时仍走 `waiting_unlock_manual` 或 `confirming` UI
    才告诉用户失败；必须 fail-fast（locked / unlocked 一视同仁）。
14. `connect.resume` 在 unlocked 路径上仍弹"恢复"按钮要求用户再次
    确认；必须自动恢复（unlock 后直接 queued → executing）。
