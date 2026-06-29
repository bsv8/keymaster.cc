# 003 Connect.Login 重新认证建新会话 + Auth Owner 仲裁硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `packages/plugin-protocol/src/protocolService.test.ts`
- `施工单/2026-06-27/001-protocol-popup-lock-screen-multi-request-and-global-serial-execution-hard-switch.md`
- `施工单/2026-06-27/002-protocol-popup-live-slots-and-history-split-hard-switch.md`
- `施工单/2026-06-28/001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md`
- `施工单/2026-06-28/002-protocol-business-methods-bind-connect-session-hard-switch.md`

发生冲突时：

1. 本单关于 `connect.login` / `connect.resume` 的 auth 语义优先。
2. 本单关于 auth 页面仲裁与抢占规则的定义优先。
3. `001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md` 中凡是仍把 `connect.login` 理解成“解锁后再选 key”的地方，以本单为准并必须同步修文档。
4. 后续若再改 popup auth 行为，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是“把选 key 从历史列表上面挪一下”的 UI 微调。

本单定义的是一次硬切换：

- `connect.login` 不再被理解成“当前 popup 里来一条 login 请求，若已经 unlocked 就直接选 key”；
- `connect.login` 固定表示“重新认证，并建立一个新的 connect session”；
- `connect.resume` 固定表示“恢复既有 session，只补 unlock，不改 key，不重建 session”；
- popup 在任一时刻只允许一个 auth owner 控制当前 auth 页面；
- `login` 未提交时若又来了 `resume`，必须有明确仲裁规则，不能让界面混乱。

本单目标不是增加更多中间态，而是把 auth 真值收紧，减少歧义和 UI 打架。

---

## 2. 简述缘由

### 2.1 现在的问题不是表单拆成两段，而是 `login` 和 `resume` 语义打架

当前实现里：

- `connect.login` 在 locked 时先输密码，再在 unlocked 主页面顶部单独选 key；
- `connect.login` 在 unlocked 时甚至可以直接进入“选 key + 确认”；
- `connect.resume` 则被定义成“只补 unlock，自动恢复”。

这会导致两个严重问题：

1. `login` 看起来像“借用当前 unlock runtime 做一次新的授权”，而不是“重新认证建立新会话”；
2. 当 `login` 尚未完成时再来一个 `resume`，系统没有清晰的 auth owner 边界，UI 很容易出现两个流程抢同一块屏幕。

### 2.2 `connect.login` 必须代表一次新的身份建立，而不是一次普通 manual confirm

外部站点视角下：

- `resume` = 继续原会话；
- `login` = 明确重登，可重新选 key。

如果 `login` 在 popup 已 unlocked 时还允许“跳过密码，只选 key”，那它本质上就退化成了：

- “沿用当前 popup 运行时材料，顺手建个新 session”

这会把“会话重建”和“当前 popup 恰好已经解锁”错误地耦合在一起。

### 2.3 旧 session 不能在新 login 开始时立刻销毁，但也不能让半填 login 长期占屏

更稳妥的系统行为是：

1. 新 `login` 开始时，旧 session 暂时保留；
2. 新 `login` 成功后，再原子吊销同 origin 的旧 session；
3. 如果用户没提交新 `login`，旧 session 仍然可被 `resume` 恢复；
4. 一旦有效 `resume` 到来，未提交 `login` 必须收口，不能继续占着 auth 页面。

这条规则同时满足：

- 系统简单；
- 用户中途取消不丢旧会话；
- 界面不会双 auth 表单打架。

### 2.4 本项目不需要“万能并存 UI”，需要明确仲裁

这里不该追求：

- 一个页面同时能编辑 `login` 草稿，又能输入 `resume` 密码，又能看历史卡片。

这里应当追求：

- popup 任一时刻只有一个 auth owner；
- auth owner 决定当前整页显示什么；
- 其它 auth 请求要么等待，要么终止，要么直接进历史终态。

这样系统边界更硬，竞态更少，测试也更容易写。

---

## 3. 硬切换结论

### 一、`connect.login` 固定表示“重新认证并建立新 session”

本次固定：

```txt
connect.login
  = 重新认证
  = 用户可重新选择一把 key
  = 成功后建立新的 connectSessionId
  = 成功后原子吊销同 origin 的旧 session
```

关键约束：

1. `connect.login` 不再表示“若当前 popup 已解锁，可直接复用当前 unlock runtime 继续”。
2. `connect.login` 必须要求用户再次输入密码，即使 vault 当前已是 unlocked。
3. `connect.login` 允许用户重新选择 key；新 session 的 owner 只取本次提交所选 key。
4. `connect.login` 成功前，旧 session 仍保留，不提前销毁。
5. `connect.login` 成功后，必须原子完成：
   - 建立新 session；
   - 吊销同 origin 旧 session；
   - 返回新 `connectSessionId`。

### 二、`connect.resume` 固定表示“恢复原 session，只补 unlock”

本次固定：

```txt
connect.resume
  = 恢复既有 connectSessionId
  = 不重新选 key
  = 不建立新 session
  = 只恢复该 session 绑定的 owner
```

关键约束：

1. `resume` 只读显示 session 绑定的 key 信息。
2. `resume` 不允许改 key。
3. `resume` 若命中“session 有效但 popup 无 unlock runtime”，只要求输入密码。
4. `resume` 若命中“session 无效 / 已 revoke / origin 不匹配 / owner 不可用”，直接 fail-fast，不抢 auth 页面。

### 三、popup 任一时刻只允许一个 auth owner

本次固定：

```txt
auth owner
  = 当前唯一有权控制 auth 页面的 request

无 auth owner
  = 显示主 popup 页面（顶栏 + 活请求区 + 历史区）
```

auth owner 候选仅包括：

1. `connect.login`
2. `connect.resume`

其它业务 request 不参与 auth owner 竞争。

关键约束：

1. auth 页面是独立全屏视图，不与历史流混排。
2. 不存在“页面上半部 login，下半部 resume，再下面历史卡片”的三拼布局。
3. 只有 auth owner 为空时，才允许展示主 popup 页面。

### 四、auth owner 仲裁优先级固定为“有效 resume 高于未提交 login”

本次固定优先级：

```txt
有效 connect.resume
  > 未提交 connect.login
  > 无 auth owner
```

含义：

1. `login` 尚未提交时，只是一个可撤销的 re-auth 草稿，不是不可抢占真值。
2. 若此时到来一条“有效的” `resume`：
   - 若当前 popup 已有 unlock runtime，则直接恢复该 session；
   - 若当前 popup 没有 unlock runtime，则切到 resume auth 页面；
   - 原未提交 `login` 必须立即收口。
3. 若到来的 `resume` 无效，则它只能 fail-fast 进历史，不能打断当前 `login`。

### 五、仅“未提交的 login”可被抢占；已提交 login 不可被后来的 resume 反抢

本次固定：

1. `connect.login` 从收到请求到用户点主提交按钮前，属于“未提交 login”。
2. 用户一旦点了“重新登录 / 解锁并登录”，该 `login` 立即变为已提交 auth request。
3. 已提交 `login` 进入执行路径后，后来的 `resume` 不得再反向抢占它。
4. 已提交 `login` 若最终失败，由其自己正常终态收口；不回滚到旧 auth 页面。

这样可以避免：

- 用户已经点了登录，页面又突然跳回旧 session 恢复页。

### 六、`connect.login` 和 `connect.resume` 的页面必须彻底分开

#### 1. `connect.login` 页面

同一屏完成：

- 站点提示
- key 可选列表
- 密码输入框
- 取消按钮
- 主提交按钮

主按钮文案应表达：

- 重新认证
- 建立新会话

而不是：

- 继续
- 恢复
- 解锁后继续

#### 2. `connect.resume` 页面

同一屏完成：

- 站点提示
- 绑定 key 只读显示
- 密码输入框
- 取消按钮
- 主提交按钮

主按钮文案应表达：

- 恢复当前会话

而不是：

- 用此 key 登录
- 重新选择 key

#### 3. 主 popup 页面

只在 `auth owner = null` 时显示：

- 顶栏
- 站点配置
- 活请求区
- 历史区

`connect.login` 不得再作为一个独立面板悬在历史列表上方。

### 七、`connect.login` 不得通过“先 vault.lock 再 unlock”实现

本次固定：

1. `connect.login` 需要的是 fresh password verification，而不是强制把整个 popup 打回 locked。
2. 不允许为了 `login` 去先调用 `vault.lock()`，再要求用户重新解锁。
3. 正确能力应收口为“重新验密码”语义：
   - vault 已 locked：验证成功后建立 unlock runtime；
   - vault 已 unlocked：验证成功后仅完成 re-auth 所需校验，不主动打断其它运行时。

设计缘由：

- `vault.lock()` 会把当前 popup 里的其它活请求一起打断，副作用过大；
- 为了达成 `login` 的再次验密，不值得把全局锁状态来回翻转。

---

## 4. 核心不变量

1. `connect.login` = 重新认证并建立新 session，不是普通 unlock 续接。
2. `connect.resume` = 恢复原 session，不重新选 key，不建新 session。
3. popup 任一时刻只有一个 auth owner。
4. auth owner 不为空时，主 popup 页面不显示。
5. 有效 `resume` 可以抢占未提交 `login`。
6. 无效 `resume` 不得抢占当前 `login`。
7. 已提交 `login` 不可被后来的 `resume` 反抢。
8. 新 `login` 成功前，旧 session 保留；成功后原子吊销旧 session。
9. `login` 需要再次验密码，即使 vault 当前已 unlocked。
10. 不允许把 `connect.login` 的 key 选择 UI 再挂回历史列表上方。

---

## 5. 特殊情况提前定义

### 5.1 popup 当前已 unlocked，此时收到 `connect.login`

处理：

1. 不进入主页面顶部“选 key”面板。
2. 直接切到全屏 `connect.login` auth 页面。
3. 页面要求：
   - 重新选 key；
   - 重新输入密码。
4. 成功后建立新 session，并原子吊销同 origin 旧 session。

### 5.2 popup 当前 locked，此时收到 `connect.login`

处理：

1. 进入全屏 `connect.login` auth 页面。
2. 同一屏展示：
   - 选 key；
   - 密码输入。
3. 提交成功后建立 unlock runtime，并完成新 session 建立。

### 5.3 `connect.login` 尚未提交时，又来了一个有效 `connect.resume`

处理：

1. `resume` 抢占 auth owner。
2. 未提交 `login` 立即收口，不再继续占屏。
3. 若 popup 当前已有 unlock runtime：
   - 直接执行 `resume`；
   - auth owner 清空；
   - 页面进入主 popup 页面。
4. 若 popup 当前没有 unlock runtime：
   - 切到 `resume` auth 页面；
   - 只读显示 key；
   - 用户输入密码后恢复当前 session。

建议本地失败原因：

- `superseded_by_resume`

对外仍按通用拒绝语义收口，不暴露复杂内部状态。

### 5.4 `connect.login` 尚未提交时，又来了一个无效 `connect.resume`

处理：

1. 该 `resume` fail-fast 进入历史终态。
2. 当前 `login` 页面保持不动。
3. 不允许无效 `resume` 抢占 auth owner。

### 5.5 `connect.login` 已提交，此时又来了一个 `connect.resume`

处理：

1. 不允许 `resume` 抢占已提交 `login`。
2. `login` 按自己的执行路径完成或失败。
3. 后来的 `resume` 只能等待 auth owner 释放后再判定：
   - 若此时旧 session 已被新 login 吊销，则 `resume` fail-fast；
   - 若新 login 失败且旧 session 仍在，可再按正常规则处理。

### 5.6 `connect.login` 取消或关闭 popup

处理：

1. 因为新 login 尚未成功，旧 session 保留。
2. caller 若仍持有旧 `connectSessionId`，后续可再发 `connect.resume`。
3. 不因 login 取消而顺手注销旧 session。

### 5.7 `connect.login` 成功后，同 origin 旧请求如何处理

处理：

1. 旧 session 下挂着的未完成 request 不得漂移进新 session。
2. 这些旧 request 后续执行时重新校验 session，应直接失败。
3. 不做“同 owner 就复用”的宽松兼容。

### 5.8 多个 `connect.login` 连续到达

处理：

1. 同一时刻仍只允许一个 auth owner。
2. 后到的 `login` 不得与前一个 `login` 并排共存界面。
3. 推荐收口：
   - 只保留当前 auth owner 对应的 login；
   - 其它同类 login 作为普通活请求留在 store 中，但不拥有 auth 页；
   - 待当前 auth owner 释放后，再按 createdAt asc 挑下一条。

### 5.9 popup 当前没有 auth owner，但收到一个有效 `connect.resume`

处理：

1. 若 popup 已有 unlock runtime，则直接恢复并进入主页面。
2. 若 popup 没有 unlock runtime，则切到全屏 `resume` 页要求输密码。
3. 不显示 `login` 页，不要求重新选 key。

---

## 6. 不能怎么做

1. 不能继续把 `connect.login` 视为“如果当前已 unlocked，就只选 key 不输密码”。
2. 不能继续让 `connect.login` 的 UI 挂在历史列表或活请求区上方。
3. 不能让 `connect.login` 与 `connect.resume` 共用同一套“解锁后继续”文案。
4. 不能让 `login` 和 `resume` 同时占据屏幕不同区域。
5. 不能让无效 `resume` 打断当前 `login`。
6. 不能让已提交 `login` 被后来的 `resume` 反抢。
7. 不能在 `login` 开始时立刻销毁旧 session。
8. 不能在 `login` 取消、输错密码或关窗时顺手把旧 session 干掉。
9. 不能通过 `vault.lock()` 再 `vault.unlock()` 的方式假装完成 `login` re-auth。
10. 不能为了少改代码，把 `login` 生搬进现有 `waiting_unlock_manual -> confirming` 的普通 request 视图里继续混用。
11. 不能把“重新认证”错误实现成“复用当前 popup unlock runtime”。
12. 不能让旧 session 下的 request 在新 login 成功后漂移进新 session。

---

## 7. 文件级一次性迭代施工单

## 7.1 协议文档

### `docs/keymaster-connect-v1-draft.md`

要做：

1. 把 `connect.login` 的行为改写为“重新认证并建立新 session”。
2. 明确 `connect.login` 需要再次验密码，即使 popup 当前已 unlocked。
3. 明确 `connect.resume` 只补 unlock，不重新选 key。
4. 新增 auth owner / auth 页面仲裁章节。
5. 新增“有效 resume 抢占未提交 login；已提交 login 不可反抢”的规则。

### `docs/keymaster-protocol-common-v1-draft.md`

要做：

1. 把 popup 页面模型补充为“auth 页面”和“主 popup 页面”二分。
2. 明确 auth owner 不为空时不显示主页面。
3. 明确 `connect.login` 不再是主页面顶部独立面板。
4. 加入 auth 抢占与收口规则。

## 7.2 Contract

### `packages/contracts/src/protocol.ts`

要做：

1. 更新 `connect.login` / `connect.resume` 注释语义。
2. 若当前 contract 里仍暴露 `connectResumeRecord()` 之类旧“恢复按钮”语义，需要改成新的 auth owner 视图契约。
3. 增加 auth owner 只读快照 contract，至少能表达：
   - 当前 owner 类型（login / resume / null）
   - login 候选 key 列表
   - resume 绑定 key 只读信息
   - 当前 auth request 的可提交状态
4. 明确 `connect.login` 所需的是 re-auth，而不是 unlocked 下直接 confirming。

## 7.3 Service

### `packages/plugin-protocol/src/protocolService.ts`

要做：

1. 移除当前把 `connect.login` 归入“unlocked -> confirming”的旧路径。
2. 引入单一 auth owner 真值，统一管理当前 auth 页面归属。
3. 把 `connect.login` 改成独立 auth 流：
   - 候选 key
   - 密码提交
   - 成功后新建 session
   - 原子吊销旧 session
4. 把 `connect.resume` 改成独立 auth 流：
   - 只读 owner
   - 必要时输入密码
   - 成功后恢复原 session
5. 实现仲裁：
   - 有效 `resume` 抢占未提交 `login`
   - 无效 `resume` 不抢占
   - 已提交 `login` 不可被 `resume` 反抢
6. 为 `login` 被 `resume` 抢占定义明确收口路径。
7. 保持 request store、活请求区、历史区模型不变，不为 auth 重新引入第二套 request truth。
8. 不通过 `vault.lock()` 实现 login re-auth。

### `packages/plugin-protocol/src/protocolStorageDb.ts`

要做：

1. 若需要支持“同 origin 新 login 成功后原子吊销旧 session”，补充相应存储操作。
2. 保证不会出现“新 session 已写入，旧 session 未吊销”的半成功落地。

## 7.4 UI

### `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

要做：

1. 去掉当前主页面顶部 `ConnectSection` 方案。
2. 在页面最外层改成：
   - 先看 lock / auth owner
   - 再决定渲染 auth 页还是主页面
3. 新增两个独立 auth 页面：
   - `ConnectLoginAuthPage`
   - `ConnectResumeAuthPage`
4. `connect.login` 页面同屏包含 key 选择和密码输入。
5. `connect.resume` 页面同屏包含只读 key 和密码输入。
6. auth owner 为空时，才渲染 `ProtocolCommandFeed`。

### `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`

要做：

1. 继续只负责活请求区 + 历史区。
2. 删除对“顶部 connect 登录面板”的任何隐式依赖。
3. 若历史卡中需要展示“被 resume 抢占的 login”终态，明确其文案和状态归类。

### `packages/plugin-protocol/src/styles.css`

要做：

1. 为两个 auth 页面提供独立样式。
2. 视觉上清晰区分：
   - 重新登录页
   - 恢复会话页
   - 主 popup 页面
3. 不再让 auth 页看起来像历史流上的一张特殊卡片。

## 7.5 测试

### `packages/plugin-protocol/src/protocolService.test.ts`

要做：

1. 新增 `login` 在 unlocked 下仍要求密码再次提交的测试。
2. 新增“未提交 login 被有效 resume 抢占”的测试。
3. 新增“未提交 login 遇到无效 resume，不被抢占”的测试。
4. 新增“已提交 login 不可被 resume 反抢”的测试。
5. 新增“login 取消后旧 session 仍可 resume”的测试。
6. 新增“新 login 成功后旧 session 被吊销”的测试。

### `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

要做：

1. 新增 `connect.login` 页面同屏显示 key + password 的渲染测试。
2. 新增 `connect.resume` 页面只读 key + password 的渲染测试。
3. 新增 auth owner 不为空时不渲染主页面历史流的测试。
4. 新增 `resume` 抢占 `login` 后页面正确切换的测试。

---

## 8. 最终验收清单

### 8.1 文档与 contract

1. `docs`、contract、实现、测试对 `connect.login` / `connect.resume` 的语义一致。
2. 仓库内不再存在“`connect.login` 在 unlocked 下直接选 key 即可”的旧注释真值。
3. 仓库内不再把 `connect.login` 描述成主页面顶部 connect 面板。

### 8.2 `connect.login`

1. popup 已 unlocked 时收到 `connect.login`，仍进入独立全屏重新登录页。
2. `connect.login` 页同屏可见 key 选择与密码输入。
3. 用户未输密码时，不能提交 `login`。
4. `connect.login` 成功后返回新的 `connectSessionId`。
5. `connect.login` 成功后，同 origin 旧 session 已被吊销。

### 8.3 `connect.resume`

1. `connect.resume` 页面只读显示绑定 key，不允许改 key。
2. popup 无 unlock runtime 时，`resume` 只要求输密码，不重新登录。
3. popup 有 unlock runtime 时，有效 `resume` 可直接恢复并进入主页面。
4. 无效 `resume` 直接失败，不进入 auth 页面。

### 8.4 auth owner 仲裁

1. 任一时刻最多只有一个 auth 页面显示。
2. 未提交 `login` 遇到有效 `resume`，页面切到 `resume` 或直接进主页面，不会残留旧 login 表单。
3. 未提交 `login` 遇到无效 `resume`，当前 login 页面不抖动、不跳走。
4. 已提交 `login` 过程中到来的 `resume`，不会把页面抢回旧 session。

### 8.5 主页面与历史流

1. `connect.login` 不再显示在历史列表上方。
2. auth owner 不为空时，主 popup 页面不显示。
3. auth owner 释放后，主页面正常回到活请求区 + 历史区。
4. 原有“活请求固定槽位 + 历史区分离”语义不被本次 auth 改坏。

### 8.6 边界行为

1. 新 `login` 取消或失败后，旧 session 仍可 `resume`。
2. 新 `login` 成功后，旧 session 下挂旧请求后续执行会失败，不漂移进新 session。
3. 不存在通过 `vault.lock()` 再 `unlock()` 实现 re-auth 的路径。
4. 不存在 `login` 和 `resume` 同时占据同一屏幕不同区域的路径。

---

## 9. 本次实施要求

1. 本单是硬切换，不做分步过渡，不保留双 auth 模型。
2. 不接受“先把 UI 改一下，语义以后再收”的半改方案。
3. 如果实现中发现现有 contract 无法清晰表达 auth owner，应先改 contract，再改 UI，不要把真值藏在组件本地状态里。
