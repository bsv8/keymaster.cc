# Keymaster Protocol V1（草案）

本文档是 Keymaster 对外协议的总览入口。**当前**协议按能力拆成多份
草案：

- [公共约定](./keymaster-protocol-common-v1-draft.md)
- [Identity.Get](./keymaster-identity-get-v1-draft.md)
- [Intent.Sign](./keymaster-intent-sign-v1-draft.md)
- [Cipher](./keymaster-cipher-v1-draft.md)
- [P2PKH.Transfer](./keymaster-p2pkh-transfer-v1-draft.md)
- [FeePool](./keymaster-feepool-v1-draft.md)
- [Connect](./keymaster-connect-v1-draft.md)

拆分缘由：

- 公共约定承载 `BinaryField` / 顶层 `ready` / `request` / `result` 报文
  形态 / 安全边界 / claim 命名规则 / 站点配置 / 命令历史 / 费用池状态
  等所有方法共享的部分。
- `identity.get` 与 `intent.sign` 都需要 Keymaster 签名，但签名对象不同：
  - `identity.get` 签的是"身份断言"；
  - `intent.sign` 签的是"调用方提供的业务内容信封"。
  两者继续放在一份文档里，会让 `resolvedClaims` / `contentType` /
  `contentSha256` 等概念互相污染。
- `cipher.encrypt` / `cipher.decrypt` 处理的是站点绑定的二进制加解密，
  业务模型、加解密算法、错误语义与签名类方法差异较大，单独成文避免
  把"明文/密文"与"待签名字节/签名"混在一起。
- `p2pkh.transfer` 是受控转账能力（**不**复用站内 `plugin-transfer` UI）；
  site 只提交地址 + 金额，确认文案由 Keymaster 自己生成；余额不足时不
  自动对外暴露真实原因。
- `feepool.prepare` / `feepool.commit` 是双端费用池两步方法族；不允许
  单步 `feepool.transfer`，也不允许中间子会话 / 心跳 / MessageChannel。
- `connect.login` / `connect.resume` / `connect.logout` 是施工单
  2026-06-28 001 硬切换新增的 connect session 方法族；定义在
  [Connect](./keymaster-connect-v1-draft.md)。
- 各草案都复用公共约定中的 transport / `BinaryField` / popup + `postMessage`
  通信模型；不要在子文档里再次定义这些。

当前协议能力包括：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`
- `connect.login`
- `connect.resume`
- `connect.logout`

十个方法都：

- 走同一套 transport（popup + `postMessage` + JS 对象 + `BinaryField`）。
- 必须由 Keymaster popup 处理；Keymaster popup 协议入口固定为
  `/protocol/v1/popup`。
- `identity.get` / `intent.sign` / `cipher.encrypt` / `cipher.decrypt` 经过用户确认；
  `p2pkh.transfer` 默认走人工确认，但 origin 配置了 `p2pkhAutoApproveEnabled`
  + `amountSatoshis <= p2pkhAutoApproveMaxSatoshis` 时走 auto-approve
  （不弹确认页，结果写进命令历史）。
  `feepool.prepare` / `feepool.commit` 默认走人工确认；但 origin 配置了
  `feePoolAutoSignMaxSatoshis` + `amountSatoshis <= feePoolAutoSignMaxSatoshis`
  时走 auto-sign（同 p2pkh.autoApprove，跳过 ConfirmView）。
- `connect.login` / `connect.resume` / `connect.logout` 走"会话级"语义
  （不是单条业务请求的真值），详见 [Connect](./keymaster-connect-v1-draft.md)：
  - `connect.login`：首次显式登录 + 用户选 key + 落 session 真值；
  - `connect.resume`：caller 持 sessionId，恢复会话（**不**重新选 key）；
  - `connect.logout`：吊销 session。
- **所有外部业务方法的执行身份都必须走 `connectSessionId`**（施工单
  2026-06-28 002 硬切换）：`identity.get` / `intent.sign` / `cipher.encrypt` /
  `cipher.decrypt` / `p2pkh.transfer` / `feepool.prepare` / `feepool.commit`
  全部强制要求 `connectSessionId` 入参；不允许 fallback 到钱包全局 active key。
  owner 唯一真值 = session 绑定的 `ownerPublicKeyHex`。
  `connect.login` 是唯一不要求 `connectSessionId` 的入口方法（它本身负责
  建 session）。
- `connect.*` 与所有外部业务方法都不存在"静默获取"模式——必须由 caller
  显式走 `connect.login` 建会话。

## Popup 连接状态与业务请求结果

Popup 连接状态是协议公共约定的一部分，与具体方法（`identity.get` /
`intent.sign` / `cipher.encrypt` / `cipher.decrypt`）无关。连接状态
与业务请求结果是两层语义：

- 连接状态：`opening` / `connected` / `disconnected`。
  - `ready`：连接建立信号。
  - `closing`：**窗口**生命周期结束信号。
  - `popup.closed === true`：浏览器兜底真值。
- 业务结果：`result`（`ok=true` / `ok=false`），由 `id` 关联到具体 `request`。

不允许把 `result` 当成"连接已经断开"的唯一真值，也不允许把
`closing` 当成 `result` 的别名。具体定义收敛在
[公共约定](./keymaster-protocol-common-v1-draft.md) 里的"Popup
生命周期与业务请求生命周期"与"顶层报文 / closing"段。本总览页不重复
定义连接状态机，只做语义分层提示。

## Popup 复用与命令流

V1 协议 popup 是一次 window.open 之后**常驻**的会话窗口：

- 同一个 popup 会话内允许多条 request 并存；每条 request 独立状态机。
  同一时刻允许多条 `waiting_unlock_*` / `confirming` / `queued`
  共存；执行层全局串行 FIFO，同一时刻只允许一条 `executing`。
- 单条 request 完成后 popup **不**自动关闭；它回到"等待下一条请求"
  的可继续复用状态。
- 一次只面向一个当前 origin；切换 origin 时按新 origin 重新载入命令
  流历史。
- 历史按 `event.origin` 归档到 Keymaster 自有的 IndexedDB
  `keymaster.protocol`；不持久化私钥 / 完整密文 / 完整签名 / 解密明文。
- 命令流历史**不**是协议层审计冷库，仅作为 popup 内的命令上下文展示。

### 当前 origin 视图：活请求区 + 历史区（施工单 2026-06-27 002 硬切换）

V1 popup 的"当前 origin 视图"由两个语义独立的区块组成：

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

约束：

1. **请求**是 request 状态机的唯一真相源；活请求区与历史区**只是**它的
   投影。`recordId` 是每条请求的稳定主键。
2. **排序**语义固定：活请求区按 `createdAt asc`，历史区按 `updatedAt desc`。
   `updatedAt` 表示"最近一次状态变化"，仅适合作历史排序，不适合作活
   事务的卡位排序——`confirming -> queued -> executing` 过程中状态
   变化不应让卡位跳变。
3. **同类不复用**：连续两条 `cipher.decrypt` 会进入活请求区两个独立
   格子；用户在第一格确认后，**第二格不会被"借壳"接管第一格的视觉
   位置**。这是 V1 显示模型的核心不变量。
4. **历史加载合并**：DB 里的旧记录与内存里的活记录合并时，**同 id
   一律以内存活记录为准**——保证内存里正在等待用户处理的请求永远
   不会被 DB 旧字段回退覆盖。
5. **批次隔离**：切换 origin 时，旧 origin 的历史加载结果如果晚到，
   **不**覆盖当前 origin 视图。

不允许：

1. 继续保留"整个 feed 全部按 `updatedAt desc` 排序"再靠颜色暗示活卡。
2. 继续把"当前请求"理解成"第一张可见卡"或"最新一张卡"。
3. 让同 method 的第二条 request 通过修改第一张卡的内容伪装成"更新"。
4. 在 UI 上只默认展开索引 0 的卡片。
5. `loadHistoryForOrigin` 完成后直接把 `commands = listFromDb`，覆盖
   当前内存活记录。

### 当前请求交互：cancel 与 timeout

- 外部 client 可以通过顶层 `cancel` 报文取消当前正在等待用户处理
  的 request；被取消的是原 request，由原 request 回
  `result(ok=false, error.user_rejected)`。详见[公共约定]里的
  "cancel" 与"当前请求交互在命令流卡片内"段。
  popup 本地历史可用 `failureReason = "client_canceled"` 如实记录，
  但该信息**不**对 site 暴露。
- 当前请求有 per-origin `confirmTimeoutSeconds` 超时（默认 30 秒）；
  超时走本地 `status = "timed_out"` + `failureReason = "request_timeout"`，
  对外仍回 `user_rejected`，**不**暴露 `request_timeout`。

### Popup 锁屏 + 多 request 并存（施工单 2026-06-27 001 硬切换）

本协议 V1 在 popup 与命令流层面引入两层语义：

```txt
会话锁状态 (ProtocolPopupLockState)
  locked
  unlocked

请求状态 (ProtocolCommandPhase)
  waiting_unlock_manual
  waiting_unlock_auto
  confirming
  queued
  executing
  approved
  rejected
  failed
  timed_out
```

约束：

1. `locked / unlocked` 是**会话级**状态，与具体 request 解耦。
2. request 自己维护自己的状态；不再依赖 service 内部的单一
   `binding + phase`。
3. UI / cancel / timeout / 执行调度都必须基于"请求状态 + 会话锁状态"
   联合判定。
4. vault 处于 `locked` 时 popup 渲染**全页面锁屏**（解锁表单 +
   待处理概要），不渲染主 popup 页面 / 顶栏 / 命令流。
5. vault 处于 `unlocked` 时才进入主 popup 页面（顶栏 + 站点配置 +
   命令流）。

不允许：

1. 继续把 `locked / unlocked` 与 `confirming / executing` 混在一个
   枚举里。
2. 继续用"全局当前绑定 request"代表系统内唯一活请求。
3. 用单一 `confirmDeadlineMs()` 代表所有 request 的倒计时——必须按
   `recordId` 查询。
4. 在 `waiting_unlock_*` 阶段启动 confirm timeout。
5. 让 auto-confirm 在锁屏期间直接执行——必须等解锁后再走全局串行。

具体定义收敛在[公共约定](./keymaster-protocol-common-v1-draft.md) 里
的"命令流历史"与"popup 锁屏 + 多 request 并存 + 串行执行"段。

本协议 V1 **不**引入心跳、**不**引入 `MessageChannel`：连接状态
完全建立在现有 `window.open + postMessage` 模型上。

各方法的"返回真值字节"语义**不**通用，按方法区分：

- `identity.get` 返回 `identityEnvelope`（含 `subjectPublicKey` 与
  `claims` 签名投影的 Deterministic CBOR 真值字节）+ `signature`。
  详见 [Identity.Get](./keymaster-identity-get-v1-draft.md)。
- `intent.sign` 返回 `signedEnvelope`（含 `contentType` / `contentSha256`
  / `subjectPublicKey` 的 Deterministic CBOR 真值字节）+ `signature`。
  详见 [Intent.Sign](./keymaster-intent-sign-v1-draft.md)。
- `cipher.encrypt` / `cipher.decrypt` **不**返回签名真值 envelope。
  详见 [Cipher](./keymaster-cipher-v1-draft.md)。

`signature.bytes` 的具体 secp256k1 编码细节请查阅对应方法文档的
"约束"段（[Identity.Get](./keymaster-identity-get-v1-draft.md) /
[Intent.Sign](./keymaster-intent-sign-v1-draft.md)）。本总览页只做
能力索引，不下沉到实现级编码细节。

后续扩展：

- 任何"非以上四个方法"的能力都视为 V2 范畴；本 V1 不预留"通用
  消息平台 / claim provider registry / 多算法协商"等扩展框架。
  后续若要新增，先改本文档总览，再单独开方法文档。
