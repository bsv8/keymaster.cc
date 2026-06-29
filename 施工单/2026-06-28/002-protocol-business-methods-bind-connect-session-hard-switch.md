# 002 外部协议业务方法全部绑定 Connect Session 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `docs/keymaster-identity-get-v1-draft.md`
- `docs/keymaster-intent-sign-v1-draft.md`
- `docs/keymaster-cipher-v1-draft.md`
- `docs/keymaster-p2pkh-transfer-v1-draft.md`
- `docs/keymaster-feepool-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `施工单/2026-06-28/001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md`

发生冲突时：

1. 本单关于“所有外部业务方法都属于 `connectSessionId` 子集”的定义优先。
2. 本单关于“`ownerPublicKeyHex` 是唯一 owner 真值，`ownerKeyId` 必须移除”的定义优先。
3. `001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md` 中只覆盖 `cipher.*` 的旧范围，本单统一扩展为全部业务方法；冲突处以本单为准。
4. 后续若再改协议归属，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是对现有 `connect + cipher` 新设计再做一个小补丁，而是对整个旧协议做一次收口：

- 旧模型里，`identity.get` / `intent.sign` / `p2pkh.transfer` / `feepool.*` 仍然走钱包全局 `active key`；
- 新模型里，`cipher.*` 已经走 `connectSessionId`；
- 这会导致同一套外部协议里同时存在两种 owner 归属语义，后面一定继续打架。

本单要求一次性硬切换到下面这套最终模型：

```txt
transport 报文
  = ready / request / result / closing / cancel
  = 只描述 popup 通信

connect 方法
  = connect.login / connect.resume / connect.logout
  = 只描述应用会话建立、恢复、注销

业务方法
  = identity.get
  = intent.sign
  = cipher.encrypt / cipher.decrypt
  = p2pkh.transfer
  = feepool.prepare / feepool.commit
  = 全部必须属于某个 connectSessionId
```

也就是说：

- `connectSessionId` 是**应用会话真值**；
- `ownerPublicKeyHex` 是**owner 真值**；
- 所有外部业务请求都是“某个应用会话里的子请求”；
- `ownerKeyId` 不再允许作为第二套 owner 真值存在。

---

## 2. 简述缘由

### 2.1 旧协议最大的问题不是字段多少，而是 owner 归属分裂

现在的协议分裂成了两半：

- `cipher.*`：按 `connectSessionId` 绑定 owner；
- `identity.get` / `intent.sign` / `p2pkh.transfer` / `feepool.*`：按执行时的全局 `active key` 决定 owner。

这会直接产生下面这些错位：

1. caller 已经登录 A，会话期间主站切到 B，后续签名却落到 B；
2. 待确认请求发出时属于旧会话，真正点确认时却混入了新会话；
3. 同一个 origin 下，同一个 `feepool` 对端，不同 owner 的池状态会互相污染；
4. 协议实现会越来越依赖“当前钱包正好 active 的是谁”，而不是“这个请求本来属于谁”。

### 2.2 `connectSessionId` 不是装饰，它是应用会话边界

用户给出的例子已经把问题说透了：

```txt
caller 发出 identity.get
-> keymaster 收到，但用户还没确认
-> 中间 logout / 再 login / 删除 key
-> 之后用户再点确认
```

如果请求不绑定 `connectSessionId`，这个旧请求就可能掺进新的应用会话。

这不是“体验细节”，而是协议边界错误。

所以本单固定：

- `connectSessionId` 用来回答“这个请求属于哪次登录”；
- `ownerPublicKeyHex` 用来回答“这次登录绑定的是谁”；
- 两者都保留，但不竞争；
- `ownerKeyId` 不再出现，因为它会制造第二套 owner 身份。

### 2.3 `ownerPublicKeyHex` 可以作为 owner 单真值，`ownerKeyId` 不可以

`ownerPublicKeyHex` 有三个优点：

1. 它天然是协议对外可见、可比较、可持久化的 owner 标识；
2. 它可以直接用于 UI、历史、session、fee pool 归属；
3. 它不会像内部自增 id / 本地 keyId 一样，引入一套只有本地实现才看得懂的第二真值。

`ownerKeyId` 的问题不是“多一个字段丑”，而是：

- session 里存它；
- request 里存它；
- service 分支判断用它；
- vault 取 key 用它；
- 结果对象还把它返回给 caller；

久而久之系统里就会同时出现：

```txt
这个请求属于 ownerPublicKeyHex=X
这个请求执行时却取 ownerKeyId=Y
```

这就是双真值。

本单要求一次性把 owner 收口成：

```txt
owner 唯一真值 = ownerPublicKeyHex
```

---

## 3. 硬切换结论

### 一、transport 层不带 `connectSessionId`

以下顶层报文继续只承载 popup transport 语义：

- `ready`
- `request`
- `result`
- `closing`
- `cancel`

它们的职责只有：

- popup 是否 ready；
- 某条 request 的业务结果；
- popup 窗口是否断开。

它们**不**回答：

- 当前 caller 是否已登录；
- 当前请求属于哪次应用会话；
- 当前 owner 是谁。

因此：

- `ready` 不带 `connectSessionId`；
- `closing` 不带 `connectSessionId`；
- 不引入“transport 默认当前 session”；
- popup 的物理窗口绑定不能替代应用会话绑定。

设计缘由：

- `ready` 发生在 `connect.login` 之前，天然不该承载应用会话；
- 就算是同一个 popup 窗口，里面也可能先后处理不同 session 的请求；
- 真正的业务边界必须落在每条业务 request 上，而不是靠“这扇窗看起来还是同一扇”去猜。

### 二、除 `connect.login` 外，所有外部业务方法都必须带 `connectSessionId`

本次固定方法边界：

#### 1. session 生命周期方法

- `connect.login`
- `connect.resume`
- `connect.logout`

语义：

- `connect.login`：建立新会话，因此输入里没有旧 `connectSessionId`；
- `connect.resume`：恢复既有会话，必须带 `connectSessionId`；
- `connect.logout`：注销既有会话，必须带 `connectSessionId`。

#### 2. 业务方法

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`

这些方法全部必须带：

```ts
{
  connectSessionId: string;
}
```

这条规则没有例外。

也就是说，外部站点以后不再存在“没登录也能直接打一枪业务请求”的协议语义。

硬切换后 caller 接入顺序固定为：

```txt
connect.login
-> 持久化 connectSessionId
-> identity.get / intent.sign / cipher.* / p2pkh.transfer / feepool.*
-> popup 断线后 connect.resume
-> 主动退出 connect.logout
```

### 三、`identity.get` 不再是登录入口，而是会话内能力

本次明确废弃旧叙事：

```txt
identity.get = 推荐登录入口
```

改为：

```txt
connect.login = 登录入口
identity.get = 会话内身份断言能力
```

`identity.get` 以后回答的是：

- “请用这次 `connectSessionId` 绑定的 owner 给我出一份带时效的身份断言”

而不是：

- “请拿当前钱包 active key 看看是谁，顺便当成登录”

### 四、request 在创建时就绑定 session，不是执行时才绑定

所有业务 request 在 `acceptRequest` 成功后，至少要把下面这组真值写进 request record：

- `method`
- `origin`
- `connectSessionId`
- `ownerPublicKeyHex`
- `paramsSnapshot`

关键约束：

1. 这组字段在 request 生命周期内不可漂移；
2. request 真值来自“创建当时命中的 session”，不是执行时临时再猜；
3. 执行时仍然要重新校验 session 是否还有效，但不能重新改写 request 归属；
4. request record 里不再落 `ownerKeyId`。

### 五、session 记录只保留一套 owner 真值

`ConnectSessionRecord` 最小模型固定为：

```ts
interface ConnectSessionRecord {
  sessionId: string;
  origin: string;
  ownerPublicKeyHex: string;
  claimsSnapshot: Record<string, ResolvedClaimValue>;
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}
```

可选展示字段允许保留：

- `ownerLabel`

但它只是展示快照，不参与 owner 判定。

明确移除：

- `ownerKeyId`

### 六、业务执行统一按 `connectSessionId -> ownerPublicKeyHex` 解析

所有业务方法执行时统一走下面这条链：

```txt
connectSessionId
-> 查 session
-> 取 ownerPublicKeyHex
-> 校验 session 是否仍有效
-> 用 ownerPublicKeyHex 找到当前可执行 key
-> 执行业务
```

固定不允许：

```txt
connectSessionId
-> 查 session
-> 读 ownerKeyId
-> 直接拿 ownerKeyId 去执行
```

也不允许：

```txt
业务方法
-> 忽略 session
-> 读取当前 active key
```

### 七、`feepool` 必须同时绑定 session、owner、operation

`feepool` 不是普通一次性请求，它比别的方法多一个 `operationId`。

本次固定：

1. `feepool.prepare` 必须带 `connectSessionId`；
2. `feepool.commit` 必须带 `connectSessionId`；
3. 内存中的 pending operation 至少落：
   - `operationId`
   - `origin`
   - `connectSessionId`
   - `ownerPublicKeyHex`
   - `counterpartyPublicKeyHex`
   - `amountSatoshis`
   - `action`
4. `feepool.commit` 不能只按 `operationId` 找 operation，必须同时校验：
   - same origin
   - same connectSessionId
   - same ownerPublicKeyHex

此外，费用池持久化 key 也必须收口为：

```txt
origin + ownerPublicKeyHex + counterpartyPublicKeyHex
```

不能再只按：

```txt
origin + counterpartyPublicKeyHex
```

否则同一个站点同一个对端，在不同 owner 间会串池。

---

## 4. 核心不变量

1. `connectSessionId` 是应用会话真值，所有外部业务方法都属于某个 `connectSessionId`。
2. `ownerPublicKeyHex` 是 owner 唯一真值。
3. `ownerKeyId` 不允许出现在 protocol contract、session record、request record、result payload、fee pool key、pending operation key、service 分支判断里。
4. 所有业务 request 都必须在创建时绑定 `connectSessionId + ownerPublicKeyHex`。
5. 所有业务执行都必须在执行前重新校验 session 仍有效。
6. session 有效不等于 popup 当前文档已解锁。
7. popup 当前文档已解锁也不等于请求仍然有效。
8. 旧请求绝不允许漂移进新 session，即使 owner 恰好还是同一把 key。
9. 任何路径都不允许 fallback 到当前全局 `active key`。
10. 不新增“默认当前 sessionId”语义；没有 `connectSessionId` 就是协议不成立。

---

## 5. 特殊情况提前定义

### 5.1 popup 刷新或关闭

处理：

1. transport 断开；
2. popup unlock runtime 丢失；
3. 已持久化 `connectSession` 仍在；
4. caller 后续应先 `connect.resume`，然后继续业务；
5. 刷新前还在 waiting / confirming / queued 的 request 不做恢复，直接视为丢失；
6. caller 需要重新发起该业务请求。

这不是 bug，而是本项目“简单粗暴重启即可”的固定边界。

### 5.2 caller 页面刷新

处理：

1. caller 自己保留 `connectSessionId`；
2. 页面起来后先 `connect.resume`；
3. 成功后再继续发业务方法；
4. 不重新 `connect.login`。

### 5.3 logout 后再 login

处理：

1. 旧 `connectSessionId` 全部失效；
2. 新 login 一定生成新的 `connectSessionId`；
3. 旧 session 下挂着的 pending request 全部视为过期请求；
4. 旧 `feepool.commit(operationId)` 也不得进入新 session。

### 5.4 request 发出后，session 被注销

处理：

1. request record 本身仍保留原 `connectSessionId`；
2. 用户稍后点确认时，执行前校验 session 已失效；
3. 该请求直接拒绝；
4. caller 收到结果后清理本地 session，重新登录。

### 5.5 request 发出后，绑定 key 被删除

处理：

1. 该请求执行时不得切换到别的 key；
2. session 校验或 owner 取 key 步骤失败时，直接拒绝；
3. 对外这不是 `invalid_request`，因为请求格式没错；
4. 对内按 owner 不可执行 / session 已坏处理；
5. 后续同 session 的业务请求也应失败，caller 需要重新登录。

### 5.6 request 发出后，同 owner 重新登录得到新 session

处理：

1. 即使 `ownerPublicKeyHex` 相同，旧 request 也仍属于旧 `connectSessionId`；
2. 旧 request 不得借同 owner 混入新 session；
3. session 是第一层边界，owner 是第二层边界，二者缺一不可。

### 5.7 `feepool.prepare` 成功后 popup 刷新

处理：

1. `operationId` 丢失；
2. site 必须重新从 `feepool.prepare` 开始；
3. 不做 operation 恢复；
4. 不做跨刷新续跑；
5. 不做半程事务补偿。

### 5.8 多标签页共用同一 `connectSessionId`

处理：

1. 允许多个 caller 标签页持有同一个 `connectSessionId`；
2. 每个 popup 文档的 unlock runtime 仍彼此独立；
3. 某个标签页 logout 后，其它标签页上的旧请求随后执行时必须失败；
4. 不做跨标签页协同修复。

### 5.9 升级到本次硬切换版本

推荐处理：

1. 直接重建 `keymaster.protocol` DB；
2. 老 `connectSession` 全部失效；
3. 老 `feePool` 记录全部清空；
4. 老 command history 全部清空；
5. origin settings 如需保留，只能作为额外优化，不能成为双模型兼容的理由。

设计缘由：

- 这次变更改的是 owner 真值、session 归属、fee pool key 和业务方法 contract；
- 为了保留旧数据而引入双读、双写、旧 shape 兼容，比重建 DB 更复杂也更脏；
- 本项目当前优先级是系统简单、重启干净、边缘业务失败可接受。

---

## 6. 不能怎么做

1. 不能只给 `cipher.*` 带 `connectSessionId`，其余业务方法继续读全局 `active key`。
2. 不能把 `identity.get` 继续当登录入口，同时又让 `connect.login` 并存为第二入口。
3. 不能在部分方法里“缺 `connectSessionId` 就默认当前 session”。
4. 不能把 `ready` / `closing` 搞成携带业务 session 的 transport 报文。
5. 不能为了兼容旧逻辑，在 session record 或 request record 里继续落 `ownerKeyId`。
6. 不能让 `connect.login` / `connect.resume` / `connect.logout` 的结果里继续返回 `ownerKeyId`。
7. 不能让 vault / keyspace 边界继续以 `ownerKeyId` 作为 owner 身份传递。
8. 不能在业务执行失败时 fallback 到当前钱包 `active key`。
9. 不能让 `feepool` 的持久化 key 继续缺少 `ownerPublicKeyHex`。
10. 不能让 `feepool.commit` 只按 `operationId` 找 pending operation。
11. 不能为了保留旧 session / 旧 fee pool / 旧 history，引入双模型兼容分支。
12. 不能把“请求格式错误”和“旧 session / 旧 owner 已不可执行”混成一类；前者是 `invalid_request`，后者是会话或执行失败。

---

## 7. 文件级一次性迭代施工单

## 7.1 协议文档

### `docs/keymaster-protocol-common-v1-draft.md`

要做：

1. 把“业务请求按 method 区分”改成“所有业务方法都必须属于 `connectSessionId`”。
2. 明确 transport 级报文不带 `connectSessionId`。
3. 明确 request record 创建时要绑定 `connectSessionId + ownerPublicKeyHex`。
4. 加入“旧请求不得漂移进新 session”的公共约束。

### `docs/keymaster-protocol-v1-draft.md`

要做：

1. 更新总览，把所有业务方法都归入 session-bound business methods。
2. 把 `identity.get` 从“登录推荐入口”改成“会话内身份断言能力”。
3. 明确 `p2pkh.transfer` / `feepool.*` 也走 `connectSessionId`。

### `docs/keymaster-connect-v1-draft.md`

要做：

1. 移除 `ownerKeyId` 相关定义、返回值、session record 字段。
2. 把 connect 的适用边界从“只服务 cipher.*”扩成“服务全部业务方法”。
3. 固定 `ConnectSessionRecord` 只保留 `ownerPublicKeyHex` 作为 owner 真值。
4. 增加“业务请求创建时绑定 session”的章节。

### `docs/keymaster-identity-get-v1-draft.md`

要做：

1. 请求参数新增 `connectSessionId`。
2. 设计原则里删除“推荐作为登录入口”。
3. 明确 subject 取自 session 绑定 owner，而不是当前 active key。
4. 明确待确认请求若 session 已失效，执行时直接拒绝。

### `docs/keymaster-intent-sign-v1-draft.md`

要做：

1. 请求参数新增 `connectSessionId`。
2. 明确 subject 取自 session 绑定 owner。
3. 删除“登录场景推荐 identity.get”的旧叙事，改成“登录先走 connect.login”。

### `docs/keymaster-cipher-v1-draft.md`

要做：

1. 移除“基于当前 active key 派生站点密钥”的说法。
2. 改成“基于 session 绑定 ownerPublicKeyHex 派生站点密钥”。
3. 明确 contract / result 中不再出现 `ownerKeyId`。

### `docs/keymaster-p2pkh-transfer-v1-draft.md`

要做：

1. 请求参数新增 `connectSessionId`。
2. 明确资金 owner 取自 session 绑定 owner，不再读取全局 active key。
3. 明确旧 session 失效时 fail-fast。

### `docs/keymaster-feepool-v1-draft.md`

要做：

1. `prepare` / `commit` 请求参数都新增 `connectSessionId`。
2. 把 fee pool state key 从 `origin + counterpartyPublicKeyHex` 改成 `origin + ownerPublicKeyHex + counterpartyPublicKeyHex`。
3. 把 pending operation 绑定项补全为 `connectSessionId + ownerPublicKeyHex`。
4. 明确 `commit` 必须校验 operation 与当前 session/owner 一致。

## 7.2 Contract

### `packages/contracts/src/protocol.ts`

要做：

1. 给 `IdentityGetParams` 增加 `connectSessionId`。
2. 给 `IntentSignParams` 增加 `connectSessionId`。
3. 给 `P2pkhTransferParams` 增加 `connectSessionId`。
4. 给 `FeepoolPrepareParams` 增加 `connectSessionId`。
5. 给 `FeepoolCommitParams` 增加 `connectSessionId`。
6. 从 `ConnectSessionRecord` 删除 `ownerKeyId`。
7. 从 `ConnectLoginResult` / `ConnectResumeResult` 删除 `ownerKeyId`。
8. 若 `ProtocolCommandRecord` / pending op 类型里有 owner snapshot，统一只保留 `ownerPublicKeyHex`。
9. 给 fee pool record key 相关类型补 `ownerPublicKeyHex` 维度。

## 7.3 Service

### `packages/plugin-protocol/src/protocolService.ts`

要做：

1. `identity.get` / `intent.sign` / `p2pkh.transfer` / `feepool.prepare` / `feepool.commit` 在 accept 阶段统一预校验 `connectSessionId`。
2. 业务 request record 创建时统一绑定：
   - `connectSessionId`
   - `ownerPublicKeyHex`
3. 执行阶段统一再次校验 session 仍有效。
4. 删除所有“这些方法走 `requireActiveKey()`”的旧路径。
5. 删除所有 `ownerKeyId` 分支、字段和返回值。
6. cipher 派生站点密钥改成通过 `ownerPublicKeyHex` 解析 owner。
7. `identity.get` / `intent.sign` / `p2pkh.transfer` / `feepool.*` 全部改为通过 session owner 执行。
8. `feepool` pending operation 增加 `connectSessionId + ownerPublicKeyHex` 绑定。
9. `feepool.commit` 校验 operation 与当前 session/owner/origin 一致。
10. logout 后，同 session 下未完成请求后续执行必须失败。

### `packages/plugin-protocol/src/protocolStorageDb.ts`

要做：

1. DB version 升级。
2. 推荐直接 delete + recreate 整个 `keymaster.protocol` DB。
3. 若实现层坚持不整库重建，至少必须 delete + recreate：
   - `connectSessions`
   - `feePools`
   - `commands`
4. 不允许为了兼容旧 `ownerKeyId` shape 引入双读分支。

## 7.4 Popup UI

### `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

要做：

1. `identity.get` / `intent.sign` / `p2pkh.transfer` / `feepool.*` 的确认文案都明确展示“当前请求属于哪个已登录 session owner”。
2. 不再把 `identity.get` 呈现为“登录确认”。
3. 当请求因 session 失效而 fail-fast 时，不展示误导性的确认 UI。
4. connect 相关页面与业务确认页面都不再展示 `ownerKeyId`。

## 7.5 测试

### 建议覆盖文件

- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `packages/contracts/src/protocol.test.ts`（如存在）

要补的测试：

1. 所有业务方法缺 `connectSessionId` 时直接 `invalid_request`。
2. 所有业务方法在 session 不存在 / 已 revoke / origin 不匹配时 fail-fast。
3. `identity.get` 待确认期间 logout，再确认时必须失败。
4. `intent.sign` 待确认期间切换 session，再确认时必须失败。
5. `p2pkh.transfer` 不再受全局 active key 变化影响。
6. `feepool.prepare` / `commit` 在同 origin 不同 owner 下不会串池。
7. `feepool.commit` 用旧 session 的 `operationId` 提交时必须失败。
8. `connect.login` / `connect.resume` 结果不再含 `ownerKeyId`。
9. 升级后老 session 全部失效，caller 必须重新 login。

---

## 8. 最终验收清单

### 一、协议边界验收

1. `ready / request / result / closing / cancel` 都不带 `connectSessionId`。
2. 除 `connect.login` 外，所有外部业务方法参数都必须显式包含 `connectSessionId`。
3. `identity.get` 不再被任何文档或 UI 描述为登录入口。
4. 协议 contract、文档、UI、测试里都不再出现 `ownerKeyId` 作为 owner 身份。

### 二、session 与 owner 真值验收

1. `ConnectSessionRecord` 只保留 `ownerPublicKeyHex` 作为 owner 真值。
2. `ConnectLoginResult` 与 `ConnectResumeResult` 都不再返回 `ownerKeyId`。
3. 所有业务 request record 都已绑定 `connectSessionId + ownerPublicKeyHex`。
4. 所有业务执行都不再读取全局 `active key`。

### 三、行为验收

1. caller `connect.login` 后，可以连续调用 `identity.get` / `intent.sign` / `cipher.*` / `p2pkh.transfer` / `feepool.*`。
2. 主站切换 `active key` 后，既有 session 的业务结果不变。
3. popup 刷新后，caller 可以 `connect.resume` 恢复，但刷新前挂起的 request 不会续跑。
4. logout 后，旧 session 下所有业务请求随后执行都失败。
5. 同 owner 重新 login 得到新 session 后，旧请求不会漂移进新 session。

### 四、feepool 专项验收

1. `feepool.prepare` / `commit` 都要求 `connectSessionId`。
2. fee pool 持久化 key 已包含 `ownerPublicKeyHex`。
3. `operationId` 不能跨 session 复用。
4. `operationId` 不能跨 owner 复用。
5. `operationId` 不能跨 origin 复用。

### 五、升级与迁移验收

1. 升级到本版后，不存在旧 `ownerKeyId` session 被继续复活使用的路径。
2. 不存在旧 fee pool 记录与新 owner 维度串在一起的路径。
3. 不存在“为了兼容旧历史 shape”而新增的双模型分支。
4. caller 在升级后若持有旧 sessionId，会明确收到需要重新登录的结果。

### 六、设计收口验收

1. 文档、contract、service、UI、测试对“应用会话真值 = `connectSessionId`”表述一致。
2. 文档、contract、service、UI、测试对“owner 唯一真值 = `ownerPublicKeyHex`”表述一致。
3. 仓库里不再存在“有的业务看 session，有的业务看 active key”的混合模型。
4. 仓库里不再存在 `ownerKeyId` 与 `ownerPublicKeyHex` 并列充当 owner 身份的混合模型。

---

## 9. 一句话结论

这次硬切换的本质不是“给几个老方法补一个参数”，而是把整套外部协议统一成：

```txt
所有业务请求
  都属于某个 connectSessionId

每个 connectSessionId
  都只绑定一个 ownerPublicKeyHex

系统里不再允许 ownerKeyId 作为第二套 owner 真值继续存在
```

这条线只要收干净，后面再加新业务方法时，先问“它属于哪个 `connectSessionId`、执行 owner 是哪个 `ownerPublicKeyHex`”，协议就不会再反复打架。
