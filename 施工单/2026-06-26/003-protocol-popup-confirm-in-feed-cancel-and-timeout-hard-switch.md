# 003 Protocol popup 确认收口到历史卡 + 外部取消 + 超时硬切换一次性迭代施工单

## 参考需求文档

施工与验收以现有协议文档、已落地实现、上一批 protocol 施工单与本单“本单补充定义”段的合集为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
- `packages/plugin-protocol/src/styles.css`
- `施工单/2026-06-24/001-protocol-popup-connection-status-hard-switch.md`
- `施工单/2026-06-24/002-connect-p2pkh-transfer-and-feepool-hard-switch.md`
- `施工单/2026-06-26/001-protocol-popup-origin-auto-approve-and-wallet-entry-hard-switch.md`
- `施工单/2026-06-26/002-protocol-origin-settings-style-and-instant-apply-hard-switch.md`

发生冲突时：

1. 现有 `docs` 已明确定义且本单未补钉的，以 `docs` 为准。
2. 本单明确钉死的 popup 确认、取消、超时语义，以本单为准。
3. 后续若要改这块行为，必须先改本单与对应 `docs`，再改 contract、实现、测试，不允许只改代码。

## 目标

一次性把 protocol popup 收口到下面这套最终模型：

```txt
确认展示
  不再用全页 overlay
  当前请求只在命令流最新卡片里交互
  解锁 / 确认 / 处理中 / 超时 都在同一张卡里呈现

外部取消
  client web 可通过 request id 发取消指令
  popup 只取消当前还没执行完的那条请求
  取消后原 request 收到 result(ok=false, error=user_rejected)

确认超时
  每个 origin 有 confirmTimeoutSeconds
  缺省 30 秒
  在 popup 站点配置里可修改
  超时后命令卡状态显示“超时”
  对外仍回 user_rejected
```

本次是硬切换，不接受：

1. 先保留 overlay，再顺手在历史卡片里加一套重复按钮。
2. 先做 popup 内取消，client 外部取消以后再补。
3. 先把 timeout 写死 30 秒，以后再接设置项。
4. 先把 timeout 做成全局系统设置，后面再迁回 per-origin。
5. 先把取消目标设计成 popup 内部 `record.id`，后面再改成协议 id。

## 简述缘由

1. 当前 popup 已经有命令流历史，见 `ProtocolCommandFeed`；再叠一层全页确认，会形成“两套当前请求 UI”。这会让状态推进、测试断言、用户理解都分裂。

2. 命令历史本来就承载“一条 request 从收到到决议”的上下文。把确认动作收回这张卡，才能让“现在在处理什么”与“刚才发生了什么”保持单真值。

3. 外部取消如果使用 popup 内部 `record.id`，等于把 service 的内部实现泄漏成对外协议。现有对外稳定 id 只有 `request.id`，client 已经掌握它，因此取消必须复用这个 id。

4. timeout 是站点策略，不是系统级基础设施。当前项目已经把 protocol 的站点级策略都收口到 `ProtocolOriginSettingsRecord`，这次继续沿用，复杂度最小。

5. timeout 不应该为了“让 site 看起来更懂原因”而扩一套对外错误语义。对外继续统一 `user_rejected`，本地再单独记录 `request_timeout`，更符合当前项目“本地知道，站点少知道”的原则。

## 本单补充定义

> 本段是这次硬切换的行为单真值。后续改语义，必须先改本段。

### 一、当前请求交互入口只保留命令流最新卡片

本次明确废弃：

```txt
ProtocolPopupPage 顶部 / 中部独立的全页确认 overlay
```

最终模型固定为：

```txt
当前请求
  = feed 最新卡片
  = 同一张卡片里显示阶段、详情、按钮、倒计时
```

对应状态收口如下：

```txt
waiting_unlock
  卡片内显示解锁表单 + 取消按钮 + 倒计时

waiting_confirm
  卡片内显示确认详情 + 确认/取消按钮 + 倒计时

executing
  卡片内显示处理中

approved / rejected / failed / timed_out
  卡片进入终态展示
```

这里的关键要求：

1. 同一时刻只允许一张“活的”卡片可交互。
2. 历史卡片仍可展开查看，但不允许出现第二套确认按钮。
3. popup 页面主体只保留顶栏、站点配置面板、命令流，不再保留独立 `CurrentRequestPanel` 语义。

### 二、对外取消使用 `request.id`，不使用内部 `record.id`

现有命令流记录里同时存在：

```txt
record.id
  popup 内部主键

requestId
  transport request id
```

本次明确规定：

```txt
client web 发取消时
  只能使用原 request.id
  不能依赖 popup 内部 record.id
```

理由：

1. `record.id` 是 service 生成的内部主键，site/client 天然不知道。
2. `request.id` 已经是现有 transport 的稳定关联 id。
3. 对外取消若依赖 `record.id`，会把 popup 内部持久化模型暴露成协议一部分，这是不必要的耦合。

### 三、协议新增顶层 `cancel` 报文

本次新增一类顶层报文：

```ts
type ProtocolCancelMessage = {
  v: PROTOCOL_VERSION;
  type: "cancel";
  id: string;
};
```

语义固定为：

1. `id` 指向一条已经发出的 `request.id`。
2. popup 收到后，只尝试取消“当前正在本会话中绑定的那条 request”。
3. `cancel` 自己不单独回一条新 `result`。
4. 被取消的是原 request，所以最终仍由原 request 回 `result(ok=false)`。

不允许怎么做：

1. 不能把 `cancel` 做成 `method: "cancel"` 的伪 request。
2. 不能给 `cancel` 再配一套单独 `result`。
3. 不能把 `cancel` 设计成“顺便关闭 popup”。

### 四、`cancel` 的生效条件固定且保守

popup 只有在下面条件全部满足时，才接受 `cancel`：

1. 当前已有绑定请求。
2. `event.source` 与当前绑定 source 相同。
3. `event.origin` 与当前绑定 origin 相同。
4. `cancel.id === 当前绑定 request.id`。
5. 当前请求还没进入不可逆执行终态。

具体收口：

```txt
phase = unlocking / confirming
  cancel 生效

phase = executing
  cancel 忽略

phase = waiting / error / 无绑定
  cancel 忽略

id 不匹配
  cancel 忽略

source / origin 不匹配
  cancel 忽略
```

忽略的原因是：

1. 当前协议没有“撤销已经开始的签名/广播/落地”的复杂补偿模型。
2. 一旦进入 `executing`，继续做“半取消”会显著增加复杂度。
3. 用户手点取消和 client 发 cancel 并发时，只允许 first-wins，后续幂等忽略。

### 五、确认超时是 per-origin 设置，字段名固定为 `confirmTimeoutSeconds`

本次在 `ProtocolOriginSettingsRecord` 上新增字段：

```ts
confirmTimeoutSeconds: number;
```

语义固定为：

1. 这是 exact origin 级别的站点设置。
2. 缺省值为 `30`。
3. 设置入口就是 popup 顶栏“站点配置”面板。
4. 不新增系统级 `/settings/protocol` 页面。

不允许：

1. 不能把 timeout 放到全局 localStorage 单独管理。
2. 不能把 timeout 只放内存，不持久化。
3. 不能为不同 method 再拆一堆 timeout 字段。

### 六、`confirmTimeoutSeconds` 的取值规则要简单

本次只接受“正整数秒”。

规范化规则固定为：

```txt
空串 / 非整数 / <= 0
  -> 30

正整数
  -> 原值
```

本次不做：

- 小数秒
- 毫秒级输入
- `0 = 关闭 timeout`
- 不同上限区间的复杂 clamp 规则

理由：

1. 用户明确要有 timeout，不是可选关闭项。
2. 当前项目更适合“非法就回默认值”，而不是引入一堆额外边界语义。

### 七、timeout 只作用于“等用户处理”的阶段

定时起点固定为：

```txt
请求进入 unlocking
或
请求进入 confirming
```

定时终点固定为下面任一情况先发生：

1. 用户本地确认。
2. 用户本地取消。
3. client 发来 `cancel` 并生效。
4. 请求进入 `executing`。
5. 请求超时。

明确语义：

1. `executing` 阶段不再计时。
2. auto-approve / auto-sign 命中时不创建 timeout。
3. timeout 不因为卡片折叠、页面重渲染、顶栏面板打开而暂停。
4. timeout 不区分“解锁时间”和“确认时间”，同一条请求只维护一个定时器。

### 八、timeout 的本地与对外结果要分离

时间到后，固定收口为：

```txt
本地命令卡
  status = timed_out
  终态可见为“超时”

对外 result
  ok = false
  error.code = user_rejected
  error.message = User rejected

本地失败原因
  failureReason = request_timeout
```

这里明确要求：

1. `request_timeout` 只写本地，不直接暴露给 site。
2. 不新增对外 `timeout` / `request_timeout` 错误码。
3. 不把超时假装成“用户点了取消”，UI 必须能区分。

### 九、命令卡状态展示收口为“phase + status 分工”

本次建议沿用现有数据结构，不额外发明第二套命令模型：

```txt
phase
  仍表达主状态流转

decision
  仍表达 approved / rejected / failed / pending

status
  允许在终态里区分 timed_out
```

因此 timeout 收口推荐为：

```txt
phase = failed
decision = failed
status = timed_out
failureReason = request_timeout
```

这样做的原因：

1. 不必把 `ProtocolCommandPhase` 整体再扩成一套更复杂的终态枚举。
2. UI 仍然可以单独把 `status = timed_out` 翻译成“超时”。
3. 现有 `decision` 的“失败色”视觉仍可复用，不需要再开新颜色体系。

本次不建议怎么做：

1. 不要为了一个超时展示，重做整套 command decision 模型。
2. 不要在本地根本不落超时状态，只是弹一下提示然后把卡片当普通 failed。

### 十、站点配置即时生效，但只影响新建请求

`confirmTimeoutSeconds` 和现有站点设置一样，走即时生效。

但要明确：

```txt
设置改动
  对下一条新 request 立即生效

已经在跑的当前 request
  继续沿用它开始计时时快照下来的 timeout 值
```

不允许：

1. 用户把 timeout 从 30 改到 5，正在倒计时的老请求立刻跳到 5 秒。
2. 用户把 timeout 从 30 改到 300，正在倒计时的老请求又被延长。

理由：

1. 当前请求的生命周期应该稳定，不应被并行设置改写。
2. 否则会引入“当前 timer 要不要热更新”的额外复杂度。

## 不能怎么做

1. 不能保留 overlay，再把 feed 卡片也改成交互卡。这样会同时存在两套“当前请求”真值。

2. 不能把对外取消目标设计成 `record.id`。popup 内部主键不是协议稳定面。

3. 不能把 `cancel` 做成普通业务 request。取消是 transport 控制消息，不是一个业务 method。

4. 不能给 `cancel` 再单独回一条“取消成功”结果。最终结果必须还是原 request 的 `result`。

5. 不能在 `executing` 后还尝试取消。当前系统没有补偿事务，不要为了业务完整度把系统搞复杂。

6. 不能把 timeout 做成全局系统设置。当前 protocol 站点策略已经收口到 per-origin，不能倒退。

7. 不能让 timeout 改动实时影响已在倒计时的请求。那会引入更多竞态。

8. 不能对外暴露 `request_timeout`。这会让 site 更精确地推断用户是否在场、是否解锁、是否超时离开。

9. 不能把 timeout 实现成页面层 `setInterval` 零散逻辑，service 自己完全不知道。定时器真值必须在 service。

10. 不能因为要在卡片里放解锁表单，就再额外保留一套 `UnlockView` overlay。还是同一条原则：单真值。

## 应该怎么做

### 总体策略

一次性做四层收口：

1. contract 层补 `cancel` 报文、timeout 配置字段、本地失败原因；
2. service 层接管 timeout 与 cancel 真值；
3. popup UI 层删除 overlay，改为 feed 最新卡片内交互；
4. 测试层补全 cancel、timeout、卡片内确认的覆盖。

### 交互模型

最终页面形态固定为：

```txt
顶栏
站点配置 inline 面板（可选）
命令流
  最新卡片：如果是当前请求，则可交互
  历史卡片：只读
```

最新卡片按状态渲染：

1. `unlocking`
   显示密码输入、解锁按钮、取消按钮、剩余秒数。
2. `confirming`
   显示请求详情、确认按钮、取消按钮、剩余秒数。
3. `executing`
   显示处理中，不显示取消。
4. `approved/rejected/failed/timed_out`
   显示终态摘要与时间线。

### service 模型

service 内新增一套最小控制状态即可：

```txt
current timeout handle
current timeout deadline
```

要求：

1. 每次绑定新 request 时，若走 manual 路径，则在进入 `unlocking` 或 `confirming` 时启动 timer。
2. 任何终态都统一清 timer。
3. 收到有效 `cancel` 时，复用现有 reject 路径收尾。
4. timeout 到点时，走“本地标 timed_out + 对外 reply user_rejected”的统一收尾。

这里不需要新引入：

- 调度器
- 任务队列
- 恢复机制
- 多 request map

因为当前 popup 明确“一次只处理一条 request”。

## 特殊情况与处理规则

### 一、auto-approve / auto-sign 命中

处理规则：

1. 不显示确认按钮。
2. 不创建 timeout。
3. 外部 `cancel` 若赶在 `executing` 之前命中才可生效；一旦进入 `executing`，忽略。

### 二、vault 锁定

处理规则：

1. 请求进入 `unlocking` 即开始计时。
2. 用户长时间不解锁，时间到直接 timeout。
3. timeout 后不再保留半开的解锁表单。

### 三、client 在 popup 还没绑定任何 request 时发 `cancel`

处理规则：

1. 直接忽略。
2. 不抛异常。
3. 不回复新消息。

### 四、client 用错误的 id 发 `cancel`

处理规则：

1. 直接忽略。
2. 当前请求继续。
3. 不允许“最接近匹配”或“取消最新一条”的模糊行为。

### 五、同一时刻本地取消与外部取消并发

处理规则：

1. first-wins。
2. 第二次取消幂等忽略。
3. 只能回一条原 request 的 `result`。

### 六、timeout 与用户点击确认并发

处理规则：

1. 先抢到状态推进的一方获胜。
2. 一旦已经进入 `executing`，timeout 回调必须识别并放弃收尾。
3. 不允许双回包。

### 七、history DB 不可用

处理规则：

1. 当前 request 仍可继续。
2. `confirmTimeoutSeconds` 读不到时按缺省 `30`。
3. 超时/取消的当前内存态仍然要工作。

### 八、用户在站点配置里修改 timeout 时，当前请求正在倒计时

处理规则：

1. 当前请求不热更新。
2. 下一条请求才读新值。
3. UI 不做“当前请求已同步新 timeout”的误导文案。

### 九、popup 刷新或关闭

处理规则：

1. 现有 `closing` 语义不变。
2. timeout timer 自然销毁，不做恢复。
3. client 若要继续，只能重新从 `ready -> request` 开始。

## 文件级施工范围

以下是实现这次硬切换时应该改到的文件面，不是可选菜单。

### 一、协议 contract 与文档

- `packages/contracts/src/protocol.ts`
  - 新增 `ProtocolCancelMessage`
  - `ProtocolMessage` union 纳入 `cancel`
  - `ProtocolOriginSettingsRecord` 新增 `confirmTimeoutSeconds`
  - `ProtocolFailureReason` 新增 `request_timeout`
  - 补充命令卡 `status` 可为 `timed_out` 的中文注释

- `docs/keymaster-protocol-common-v1-draft.md`
  - 增补顶层 `cancel` 报文定义
  - 增补“当前请求交互在命令流卡片内完成”语义
  - 增补超时与取消规则

- `docs/keymaster-protocol-v1-draft.md`
  - 增补本次 popup 交互收口说明

### 二、协议校验与 service

- `packages/plugin-protocol/src/protocolValidation.ts`
  - 增加 `cancel` 顶层报文解析/校验
  - 明确 `cancel.id` 必须为非空字符串

- `packages/plugin-protocol/src/protocolService.ts`
  - 接收 `cancel` 报文
  - 管理当前请求 timeout handle / deadline
  - 在 `unlocking` / `confirming` 启动 timer
  - 在终态统一清 timer
  - timeout 时写本地 `request_timeout` 与 `status=timed_out`
  - 继续对外回 `user_rejected`
  - 确保 cancel / timeout / local reject / confirm 并发时只有一次收尾
  - 暴露 feed 卡片渲染所需的最小只读信息

### 三、popup UI

- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
  - 删除全页 `CurrentRequestPanel` overlay 语义
  - 改为只渲染顶栏 + 站点配置 + feed
  - 把当前 request 所需交互能力传给 `ProtocolCommandFeed`

- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`
  - 最新卡片支持 `unlocking` / `confirming` / `executing` 特殊渲染
  - 卡片内放解锁表单、确认/取消按钮、倒计时
  - 历史卡片保持只读
  - `status=timed_out` 时显示“超时”而不是泛化成“失败”

- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
  - 增加 `confirmTimeoutSeconds` 数字字段
  - 继续走 blur / Enter 提交
  - 非法值规范化为 30

- `packages/plugin-protocol/src/styles.css`
  - 补卡片内交互态样式
  - 补倒计时、卡片动作区、卡片内表单样式
  - 保证 feed 内交互卡与历史只读卡视觉一致但层次清晰

- `packages/plugin-protocol/src/manifest.ts`
  - 增加 cancel / timeout / 卡片内解锁确认所需 i18n 文案
  - 增加站点配置 timeout 字段文案

### 四、测试

- `packages/plugin-protocol/src/protocolService.test.ts`
  - cancel 命中当前 request
  - 错误 id cancel 被忽略
  - `executing` 后 cancel 被忽略
  - timeout 默认 30 秒
  - timeout 使用 origin 配置值
  - timeout 后本地状态是 `timed_out`
  - timeout 对外仍回 `user_rejected`
  - 并发收尾只回一次 result

- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
  - overlay 不再渲染
  - 当前交互出现在 feed 最新卡片
  - 卡片内确认/取消按钮存在
  - 卡片内解锁表单存在

- `packages/plugin-protocol/src/OriginSettingsTray.test.tsx`
  - `confirmTimeoutSeconds` 正常读取与提交
  - 空串/非法值/小于等于 0 规范化为 30

- `packages/plugin-protocol/src/protocolStorageDb.test.ts`
  - 旧 origin 记录缺字段时，`confirmTimeoutSeconds` 归一化为 30

## 最终验收清单

### 协议与数据模型

- [ ] `ProtocolMessage` 已包含顶层 `cancel` 报文。
- [ ] 外部取消只使用 `request.id`，实现中没有把 `record.id` 暴露给 site/client。
- [ ] `ProtocolOriginSettingsRecord` 已持久化 `confirmTimeoutSeconds`。
- [ ] 旧 origin 记录缺这个字段时，运行期默认值为 30，不崩。
- [ ] 本地失败原因已能记录 `request_timeout`。

### popup 交互

- [ ] popup 页面不再渲染独立全页确认 overlay。
- [ ] 当前请求只在命令流最新卡片里交互。
- [ ] `unlocking` 时卡片内可直接解锁并取消。
- [ ] `confirming` 时卡片内可直接确认并取消。
- [ ] `executing` 时卡片显示处理中且不再允许取消。
- [ ] 历史卡片没有第二套确认按钮。

### 外部取消

- [ ] client 发送正确 `cancel(id=request.id)` 时，当前请求被拒绝并回原 request 的 `result`。
- [ ] client 发送错误 id 的 `cancel` 时，当前请求不受影响。
- [ ] `executing` 后发送 `cancel` 不生效。
- [ ] 同 source / origin 约束仍然成立，跨 origin / 跨 source `cancel` 被忽略。
- [ ] 无论取消来自本地还是外部，原 request 最多只回一条 `result`。

### 超时

- [ ] 未配置 timeout 时，默认 30 秒。
- [ ] timeout 可在站点配置里修改并持久化。
- [ ] 当前请求进入 `unlocking` 或 `confirming` 后开始计时。
- [ ] auto-approve / auto-sign 路径不会错误启动 timeout。
- [ ] timeout 发生后，命令卡可见状态是“超时”。
- [ ] timeout 后对外仍回 `user_rejected` / `User rejected`。
- [ ] timeout 不会在页面重渲染、折叠卡片、打开站点配置面板时暂停或重置。
- [ ] 修改站点 timeout 只影响后续请求，不回改当前正在倒计时的请求。

### 降级与边界

- [ ] history DB 不可用时，当前请求仍可正常取消、超时、回包。
- [ ] popup 刷新/关闭后，不做 timeout 恢复，不引入额外持久化。
- [ ] 本地取消、外部取消、timeout、确认并发时，状态收尾稳定，没有双回包。

## 施工完成判定

满足下面三条，才算这张单真正完成：

1. 代码路径上已经没有“全页 overlay 才是当前请求真值”的残留实现。
2. `cancel + timeout + feed 内确认` 三条主链路都有测试覆盖，且测试不是只测 happy path。
3. 协议文档、contract、实现、测试四处对 `request.id` / `confirmTimeoutSeconds` / `timed_out` 口径一致。
