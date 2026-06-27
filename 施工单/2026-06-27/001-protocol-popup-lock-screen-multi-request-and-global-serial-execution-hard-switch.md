# 001 Protocol popup 锁屏恢复全页 + 多 request 并存 + 解锁后全局串行执行硬切换一次性迭代施工单

## 参考需求文档

本次施工、联调、验收以下列文档与代码为准：

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
- `施工单/2026-06-26/003-protocol-popup-confirm-in-feed-cancel-and-timeout-hard-switch.md`

发生冲突时：

1. 本单新定义的锁屏、多 request、串行执行语义优先。
2. 本单未覆盖的通用协议语义，继续以 `docs` 为准。
3. 后续若再改 popup connect 行为，必须先改本单与对应协议文档，再改 contract、实现、测试，不允许只改代码。

## 目标

一次性把 protocol popup 收口到下面这套最终模型：

```txt
锁屏
  锁屏仍然是全页面
  未解锁前不显示主 popup 页面
  未解锁前允许接收多条 request
  锁屏页只显示待处理概要，不显示完整历史流

请求
  去掉“全局单 active request”
  每条 request 独立建记录、独立状态机
  多条同类请求不能复用同一张顶部卡
  解锁后主页面按卡片逐条展示

执行
  不做按资源加锁
  不做无条件完全并发
  用户确认后或命中 auto-confirm 后，再进入全局串行执行队列
  执行队列按确认完成顺序 FIFO 依次执行

取消
  client web 继续通过 request id 取消指定 request
  waiting_unlock / confirming / queued 可取消
  executing 后忽略取消

超时
  confirm timeout 只存在于 confirming
  默认 30 秒
  per-origin 配置
  未解锁前没有 confirm timeout
```

本次是硬切换，不接受：

1. 先保留旧的“单 active request”中心模型，再在 UI 上硬堆多卡片。
2. 先把未解锁请求放一套临时队列，解锁后再搬运到正式历史队列。
3. 先允许 auto-confirm 在锁屏期间直接执行。
4. 先继续复用同一张顶部 live 卡，再把多条请求只显示成数字。
5. 先把 timeout 继续挂在 unlocking，再以后再改。
6. 先让 queued 也继续吃 confirm timeout，再以后再拆。

## 简述缘由

1. 旧设计的根问题不是“按钮放哪”，而是 service 内部仍然假设同一时刻只有一条活请求。这会让 cancel、timeout、锁屏、多条同类请求同时到达这些场景全部打架。

2. “未解锁临时队列 -> 解锁后正式队列”的双队列迁移看起来直观，实际最容易制造竞态：迁移时超时、迁移时取消、迁移时重复建卡、迁移后时间戳漂移。项目当前阶段不值得承受这套复杂度。

3. 全局串行执行比“按资源加锁”简单得多，而且符合当前项目“执行很快、失败可以接受、优先避免系统卡死”的原则。这里真正需要并存的是“等待用户处理”的请求，不是复杂执行调度器。

4. 锁屏和请求状态必须解耦。否则“未解锁前不应有 timeout”“重新锁定时如何收口”“auto-confirm 但钱包还锁着”这些边界会全部变模糊。

## 本单补充定义

> 本段是这次硬切换的行为单真值。后续改语义，必须先改这里。

### 一、会话锁状态与请求状态分层，不再共享一个中心 phase

本次固定为两层状态：

```txt
会话锁状态
  locked
  unlocked

请求状态
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

1. `locked/unlocked` 是会话级状态，不属于某一条 request。
2. request 自己维护自己的状态，不再依赖 service 的单一 `binding + phase`。
3. UI、取消、超时、执行调度都必须基于“请求状态 + 会话锁状态”联合判定。

不允许：

1. 继续把 `locked/unlocked` 与 `confirming/executing` 混在一个枚举里。
2. 继续用 `currentRequest()` 代表系统内唯一活请求。
3. 继续用单一 `confirmDeadlineMs()` 代表所有请求的倒计时。

### 二、请求从到达那一刻起就进入统一 request store，不做双队列搬运

本次固定模型：

```txt
request store
  所有请求的唯一真相源

lock summary
  从 request store 聚合出来的锁屏概要视图

execution queue
  从 request store 派生出的“已获准执行”顺序队列
```

约束：

1. 未解锁时收到请求，也要立刻建独立 request 记录。
2. 解锁后主页面展示的，就是这些已存在记录，不允许“解锁后补建卡片”。
3. 锁屏页摘要必须从 request store 聚合，不允许自己维护第二份可变状态。

不允许：

1. `pendingBeforeUnlockQueue -> feedCommands` 的搬运式设计。
2. 未解锁时只记数量，不记逐条 request。
3. 锁屏页用一份单独内存结构维护摘要真值。

### 三、锁屏仍是全页面；解锁后才进入主 popup 页面

本次明确恢复：

```txt
locked
  显示全页面锁屏
  不显示主 popup 历史流

unlocked
  显示主 popup 页面
  顶栏 + 站点配置 + 历史卡片流
```

锁屏页只显示：

1. 解锁表单。
2. 待处理总数。
3. 按 method 聚合的概要数量。
4. 可选的分组计数：
   - 待解锁后人工确认
   - 解锁后自动执行
   - 已确认待执行
   - 执行中

不允许：

1. 锁屏页直接展示完整历史流并允许点确认。
2. 锁屏页只显示“有新请求”，不显示数量和类型概要。
3. 未解锁时让用户直接操作具体 request。

### 四、未解锁前允许多 request 并存，但不允许执行，也不允许 confirm timeout

本次固定：

```txt
locked + manual request
  -> waiting_unlock_manual

locked + auto-confirm request
  -> waiting_unlock_auto
```

两者共同约束：

1. 都必须保存为独立 request 记录。
2. 都允许外部 `cancel(id)`。
3. 都不允许进入执行队列。
4. 都不允许启动 confirm timeout。
5. 只要在未解锁阶段被 `cancel(id)` 命中，这条 request 必须直接进入终态 `rejected`，后续解锁推进时绝不能再次进入 `confirming`、`queued` 或 `executing`。

理由：

1. 未解锁时，系统只是在缓存待处理意图，不是在等待用户确认某条具体请求。
2. 你已经明确要求“没有解锁前的，不应该有 timeout”，这里必须写死到状态规则里。

### 五、解锁后再做分流：manual 进 confirming，auto 进 queued

用户解锁成功时：

```txt
waiting_unlock_manual
  -> confirming

waiting_unlock_auto
  -> queued
```

约束：

1. `waiting_unlock_manual -> confirming` 的瞬间，才快照该 origin 的 `confirmTimeoutSeconds` 并启动计时。
2. `waiting_unlock_auto` 解锁后直接入队，不经过 confirming。
3. 执行队列开始 drain 的前提是会话已 `unlocked`。

不允许：

1. 让 `waiting_unlock_auto` 在锁屏状态直接执行。
2. 让 `waiting_unlock_manual` 在解锁后继续停留无状态，不进入明确的 confirming。
3. 解锁时把所有请求粗暴并发执行。

### 六、执行模型固定为“确认后全局串行执行”，不是无条件完全并发，也不是按资源锁

本次执行模型固定为：

```txt
request 可并存
request 状态机独立
真正执行时全局串行
```

调度规则：

1. 用户点“同意”后，`confirming -> queued`。
2. auto-confirm 且已解锁的请求，到达即 `queued`。
3. 执行器从 `queued` 中按进入队列时间 FIFO 取一条执行。
4. 同一时刻只允许一条 request 处于 `executing`。
5. 当前执行完成后，如果仍是 `unlocked`，继续取下一条；如果已 relock，则暂停 drain。

理由：

1. 去掉“全局单 active request”解决的是等待态并存问题。
2. 保留“执行期全局串行”解决的是执行层复杂度问题。
3. 不做资源锁，不做补偿，不做复杂并发控制，符合当前项目处境。

不允许：

1. 把“全局串行”提前到“请求接收阶段”。
2. 请求 A 未获用户处理时就阻塞请求 B 的建卡与展示。
3. 为了所谓吞吐量重新引入资源级锁表、互斥图或死锁规约。

### 七、confirm timeout 只允许存在于 confirming

本次 timeout 规则固定为：

```txt
waiting_unlock_manual
  无 timeout

waiting_unlock_auto
  无 timeout

confirming
  有 timeout

queued
  无 timeout

executing
  无 timeout
```

具体语义：

1. timeout 缺省值仍为 `30` 秒。
2. 配置来源仍是 per-origin `confirmTimeoutSeconds`。
3. 请求进入 `confirming` 时才快照 timeout 值。
4. 当前请求开始 `confirming` 后，即使用户再改 settings，也不热更新这条请求。
5. 请求一旦离开 `confirming`，必须立即清掉 timeout。

超时终态：

```txt
confirming -> timed_out
对外仍回 user_rejected
本地 failureReason = request_timeout
```

不允许：

1. 在 unlocking 状态下启动 timeout。
2. 在 queued 中继续跑 confirm timeout。
3. 在 executing 中因为 confirm timeout 把请求打死。

### 八、取消权限固定：waiting_unlock / confirming / queued 可取消；executing 不可取消

本次 `cancel(id)` 生效范围固定为：

```txt
waiting_unlock_manual
  可取消

waiting_unlock_auto
  可取消

confirming
  可取消

queued
  可取消

executing
  忽略
```

约束：

1. `cancel` 继续按 `request.id` 精确命中。
2. 命中后这条 request 进入 `rejected`，对外仍回原 request 的 `user_rejected`。
3. `cancel` 自己不单独回 result。
4. 已在执行中的请求，不做补偿、不做中断。

### 九、重新锁定时要硬收口，不能保留半开的确认态

本次固定 relock 规则：

```txt
confirming
  -> waiting_unlock_manual
  清掉 timeout

queued
  保持 queued

executing
  允许当前这一条跑完

后续 drain
  暂停，直到再次 unlocked
```

理由：

1. 你已明确要求未解锁前不应有 timeout。
2. 如果 relock 后还保留 `confirming + 倒计时`，语义上就是自相矛盾。
3. 不做“pause/resume 剩余秒数”以避免复杂度。

不允许：

1. relock 后继续保留 confirming 中的倒计时。
2. relock 后自动丢弃 queued。
3. relock 时中断正在执行的请求。

### 十、重复 requestId 不能并存

本次固定去重规则：

```txt
同一 source + origin + requestId
只要存在未终态 request
后续同 id request 直接拒绝
```

理由：

1. 否则 `cancel(id)` 无法精确命中。
2. 同一个 requestId 对多条活记录同时存在，会让对外 result 归属错乱。

本次不做：

1. 自动合并重复请求内容。
2. 复用旧卡片替换为新请求。
3. 因重复请求去修改已存在记录的 params。

## 怎么做

### 一、contract 与协议文档层

1. 在 `docs/keymaster-protocol-v1-draft.md`、`docs/keymaster-protocol-common-v1-draft.md` 更新 popup connect 语义：
   - 锁屏为全页面。
   - 多 request 并存。
   - confirm timeout 只在 confirming。
   - queued 可取消。
   - executing 不可取消。

2. 在 `packages/contracts/src/protocol.ts` 扩充类型定义：
   - 新增会话锁状态类型，例如 `ProtocolPopupLockState`。
   - 新增 request 级状态枚举，不再只依赖单一 `ProtocolSessionPhase`。
   - `ProtocolService` 改为面向 request 集合的接口。

3. `ProtocolService` 接口至少要改到这些能力：
   - `currentRequest()` 改为可查询多条活动 request，或改为 `requestsSnapshot()`。
   - `confirmByUser()` 改为 `confirmRequestById(requestId)`。
   - `rejectByUser()` 改为 `rejectRequestById(requestId)`。
   - `confirmDeadlineMs()` 改为按 request 查询，例如 `confirmDeadlineMs(requestId)`，或直接把 deadline 带进 request snapshot。
   - 新增锁屏摘要快照接口，供锁屏页读取聚合信息。

### 二、service 内核改造

1. 去掉单一 `binding / pendingRequestSnapshot / currentRecordId / timeoutRecordId` 中心模型。
2. 改为：
   - `requestsByRecordId` 或同等结构保存所有活请求与终态历史。
   - `recordOrder` 或同等结构保存展示顺序。
   - `executionQueue` 保存已确认待执行的 recordId 顺序。
   - `executingRecordId` 表示当前正在执行的一条。
   - `timersByRecordId` 保存 confirming 请求的 timeout 信息。

3. 消息处理改造：
   - 新 request 到达时，按锁状态 + auto-confirm 判定落到哪个 request 状态。
   - `cancel(id)` 按 source + origin + requestId 命中具体 request。
   - 重复 requestId 拒绝，不入队、不覆盖旧记录。

4. 解锁推进改造：
   - `locked -> unlocked` 时，批量扫描所有 `waiting_unlock_*`。
   - `manual` 逐条进入 `confirming` 并分别起 timeout。
   - `auto` 逐条进入 `queued`。
   - 最后尝试启动执行 drain。

5. 执行器改造：
   - 单独的 `drainExecutionQueue()` 或同等逻辑。
   - 只有 `unlocked && !executingRecordId` 才能继续取队首。
   - 一条执行完成后推进下一条。

6. relock 改造：
   - 会话重新变锁时，批量把 `confirming -> waiting_unlock_manual`。
   - 逐条清掉 confirming timer。
   - 执行器暂停取新任务。

### 三、popup 页面与组件层

1. `ProtocolPopupPage.tsx`
   - 恢复全页面锁屏分支。
   - `locked` 时渲染锁屏页，只显示聚合概要，不显示主历史流。
   - `unlocked` 时渲染主 popup 页面。

2. 新增或改造锁屏页组件：
   - 使用 service 提供的锁屏摘要快照。
   - 展示总待处理数、按 method 聚合数、按类别聚合数。
   - 不允许展示逐条确认按钮。

3. `ProtocolCommandFeed.tsx`
   - 不再假设只有最新一张 live 卡。
   - 每张处于 `confirming` 的卡都可以独立确认/取消。
   - `queued` 显示“已确认，等待执行”。
   - `executing` 显示“处理中”。
   - `timed_out` 独立显示“超时”。

4. 交互按钮全部改成按 requestId/recordId 作用到具体卡片，不允许再调用全局无参 `confirmByUser()` / `rejectByUser()`。

### 四、设置层

1. `OriginSettingsTray.tsx` 保持 `confirmTimeoutSeconds` 为 per-origin 字段。
2. 文案要明确：
   - 这个 timeout 只作用于解锁后的人工确认阶段。
   - 锁屏等待阶段不计时。

### 五、样式层

1. `styles.css` 恢复全页面锁屏布局。
2. 为锁屏摘要增加：
   - 总数区域
   - method 聚合列表
   - 分类聚合区域

3. 历史卡片样式增加这些可见状态：
   - `confirming`
   - `queued`
   - `executing`
   - `timed_out`

## 不能怎么做

1. 不能为了少改代码，继续保留“service 里只有一个当前请求”的真相源。
2. 不能在锁屏页和主页面各维护一份请求状态。
3. 不能通过“复用同一顶部卡片 + 改里面文字”伪装成多 request。
4. 不能在未解锁前启动任何 confirm timeout。
5. 不能让 auto-confirm 在锁屏期间绕过解锁直接执行。
6. 不能让 queued 状态继续被 timeout 或被重新确认。
7. 不能把执行串行做成“收到请求就串行”，必须是“确认后才串行”。
8. 不能 relock 时把正在 confirming 的请求保留成 confirming。
9. 不能为了省事让 `cancel(id)` 只命中“最新那条”。
10. 不能对 executing 请求做中断补偿尝试。

## 特殊情况与处理办法

### 一、锁屏期间连续收到多条请求

处理：

1. 全部立刻建记录。
2. manual 进 `waiting_unlock_manual`。
3. auto 进 `waiting_unlock_auto`。
4. 锁屏摘要即时更新数量。

### 二、锁屏期间收到多条同类请求

处理：

1. 不能复用一张顶部卡。
2. 每条请求都保留独立记录。
3. 锁屏摘要里可以聚合成 `cipher.decrypt x N`，但解锁后主页面必须逐条展示。

### 三、锁屏期间 client 发 cancel(id)

处理：

1. 只要命中的请求仍在 `waiting_unlock_*`，直接转 `rejected`。
2. 摘要数量同步减少。
3. 对外仍回原 request 的 `user_rejected`。
4. 这条 request 到此结束；后续即使用户再解锁，也不允许被重新扫入任何待执行路径。

### 四、解锁瞬间同时有多条 auto 与 manual 请求

处理：

1. manual 全部转 `confirming` 并各自独立计时。
2. auto 全部转 `queued`。
3. 执行器开始全局串行 drain `queued`。
4. manual 不因为 auto 的存在而被隐藏或丢失。

### 五、queued 状态被 cancel

处理：

1. 从执行队列中移除。
2. 记录转 `rejected`。
3. 对外回 `user_rejected`。

### 六、relock 发生在有多条 confirming 请求时

处理：

1. 全部 `confirming -> waiting_unlock_manual`。
2. 全部清 timeout。
3. 锁屏摘要重新反映这些待处理项。

### 七、relock 发生在 queued 与 executing 并存时

处理：

1. `queued` 保持不变。
2. `executing` 当前这一条允许跑完。
3. 跑完后不再取新队首，直到下次再次解锁。

### 八、popup 刷新或被关闭

处理：

1. 不做活请求恢复执行。
2. best-effort 持久化历史展示可以保留。
3. 与 opener/source 的活会话关系不可恢复时，未完成请求直接失效，不补复杂恢复协议。

### 九、重复 requestId 再次发来

处理：

1. 同一 `source + origin + requestId` 下，只要还有未终态记录，就拒绝第二条。
2. 不覆盖原记录。
3. 不生成第二张活卡。

## 文件级施工清单

### 一、协议与 contract

- `docs/keymaster-protocol-v1-draft.md`
  - 更新 popup 锁屏、请求状态、取消、timeout、全局串行执行语义。

- `docs/keymaster-protocol-common-v1-draft.md`
  - 补充 `cancel`、requestId 去重、终态对外语义的公共约束。

- `packages/contracts/src/protocol.ts`
  - 新增锁状态、请求状态、锁屏摘要、per-request 交互接口类型。
  - 废弃或收缩依赖单一 active request 的接口定义。

### 二、service

- `packages/plugin-protocol/src/protocolService.ts`
  - 从单 request 中心模型改成 request store + execution queue。
  - 实现锁屏摘要聚合。
  - 实现 per-request timeout。
  - 实现 queued 可取消。
  - 实现 relock 收口。
  - 实现解锁后批量推进与全局串行执行。

- `packages/plugin-protocol/src/protocolValidation.ts`
  - 若需要，补 requestId 去重与 cancel 校验辅助逻辑。

### 三、popup UI

- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
  - 恢复全页面锁屏分支。
  - 接入锁屏摘要与 unlocked 主页面切换。

- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`
  - 改成多条活动请求并存的卡片交互模型。
  - 每张卡片按自己的 requestId 执行确认/取消。

- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
  - 补 timeout 作用范围说明文案。

- `packages/plugin-protocol/src/styles.css`
  - 恢复锁屏样式并补摘要区域。
  - 补 queued / executing / timed_out 的视觉态。

### 四、测试

- `packages/plugin-protocol/src/protocolService.test.ts`
  - 覆盖多 request 并存、解锁前无 timeout、解锁后批量推进、全局串行执行、queued 取消、relock 收口、重复 requestId 拒绝。

- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
  - 覆盖锁屏页只显示摘要、解锁后切主页面、主页面逐条展示请求卡片。

- `packages/plugin-protocol/src/OriginSettingsTray.test.tsx`
  - 覆盖 timeout 说明文案与设置保存行为。

- `packages/plugin-protocol/src/protocolStorageDb.test.ts`
  - 若 request 持久化模型变化，补对应读写断言。

## 最终验收清单

### 一、锁屏与解锁

- 钱包未解锁时，popup 显示全页面锁屏，不显示主历史流。
- 锁屏期间连续收到多条 request，不会丢失，不会互相覆盖。
- 锁屏页能看到待处理总数与按 method 聚合的概要。
- 解锁后直接进入主 popup 页面，且能看到锁屏期间已经积累的逐条请求卡片。

### 二、多 request 并存

- 连续发送多条 `cipher.decrypt`，会出现多张独立请求卡片，不复用同一张顶部 live 卡。
- 不同 method 的请求可同时存在于列表中，各自状态独立。
- 同一 `source + origin + requestId` 的重复未终态请求会被拒绝，不会生成第二张活卡。

### 三、确认与超时

- 未解锁前的请求没有 confirm timeout。
- 解锁后，manual 请求进入 `confirming` 才开始 timeout。
- timeout 只作用于 `confirming`，不会打到 `waiting_unlock_*`、`queued`、`executing`。
- timeout 后卡片显示 `timed_out`，对外仍回 `user_rejected`。

### 四、自动确认与执行

- 命中 auto-confirm 且未解锁时，请求先停在 `waiting_unlock_auto`，不会直接执行。
- 命中 auto-confirm 且已解锁时，请求直接进入 `queued`。
- 多条已确认请求按进入队列顺序串行执行，同一时刻只有一条 `executing`。
- 当前执行结束前，不会启动下一条执行。

### 五、取消

- `cancel(id)` 能精确取消 `waiting_unlock_manual`、`waiting_unlock_auto`、`confirming`、`queued` 中的指定请求。
- `cancel(id)` 不会误伤其他 requestId。
- `cancel(id)` 对 `executing` 请求无效。
- queued 被取消后，会从执行队列中移除，不再执行。

### 六、重新锁定

- relock 后，所有 `confirming` 请求都会回到 `waiting_unlock_manual`。
- relock 后，这些请求的 timeout 会被清掉。
- relock 时若有 `executing`，当前这一条允许跑完。
- relock 后执行器暂停，不会继续从 queued 中取新请求，直到再次解锁。

### 七、UI 交互

- 锁屏页不允许直接对具体 request 点确认。
- 主页面中每条处于 `confirming` 的卡片都能独立确认/取消。
- `queued` 卡片明确显示“已确认，等待执行”。
- `executing` 卡片明确显示“处理中”。

### 八、回归

- 现有 `identity.get`、`intent.sign`、`cipher.encrypt`、`cipher.decrypt`、`p2pkh.transfer`、`feepool.prepare`、`feepool.commit` 在新模型下都能正常走通。
- 站点配置 `confirmTimeoutSeconds` 仍能保存、刷新后仍生效。
- popup 关闭或刷新不会让系统卡死，也不会引入复杂恢复逻辑。
