# 002 Protocol popup 活请求固定槽位 + 历史区分离 + 同类请求不复用卡位硬切换一次性迭代施工单

## 参考需求文档

本次施工、联调、验收以下列文档与代码为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`
- `packages/plugin-protocol/src/styles.css`
- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `施工单/2026-06-26/003-protocol-popup-confirm-in-feed-cancel-and-timeout-hard-switch.md`
- `施工单/2026-06-27/001-protocol-popup-lock-screen-multi-request-and-global-serial-execution-hard-switch.md`

发生冲突时：

1. 本单新定义的“活请求固定槽位 + 历史区分离”语义优先。
2. 本单未覆盖的多 request、锁屏、串行执行、取消、timeout 语义，继续以 `施工单/2026-06-27/001...` 为准。
3. `docs` 里凡是仍写着“当前请求只在最新卡片交互”或“commands 全局按 updatedAt desc 直接渲染”的地方，都以本单为准并必须同步修文档，不允许只改实现。

## 目标

一次性把 protocol popup 收口到下面这套最终模型：

```txt
显示模型
  活请求区
    只放未终态 request
    每条 request 一个固定格子
    同类请求不复用卡位
    活卡顺序按 createdAt asc 固定

  历史区
    只放终态 request
    历史按 updatedAt desc
    与活请求区视觉分离

交互
  每张活卡各自确认 / 取消 / 倒计时 / 执行
  第一张卡状态变化不能让第二张“借壳”顶上来
  UI 不再假设“只有第一张活卡值得展开”

数据
  request store 仍是唯一真相源
  feed 只是展示投影
  活请求排序不再受 updatedAt 驱动
  历史加载不能覆盖活请求的新状态
```

本次是硬切换，不接受：

1. 继续保留“整个 feed 全部按 `updatedAt desc` 排序”，再靠文案解释“其实有两条请求”。
2. 继续把“当前请求交互”理解成“只有第一张卡可见，其余活请求折叠在下面”。
3. 继续让同 method 的第二条请求通过修改第一张卡内容来伪装成“更新了同一张卡”。
4. 继续依赖“最新一张活卡”的旧心智，让第一张确认后第二张顶替到第一格，看起来像还是同一个框。
5. 继续在 UI 上只默认展开索引 0 的卡片，把其它活卡折叠掉。
6. 继续把历史载入结果整批覆盖当前 feed，不区分“DB 旧记录”和“内存里的活记录新状态”。

## 简述缘由

1. 这次问题的根因不是 request store 没有并存，而是展示层仍然在沿用“当前请求 = 顶部最新卡”的旧模型。对并发等待用户处理的请求，这个模型天然会制造“像在复用第一格”的错觉。

2. `updatedAt desc` 适合历史回顾，不适合活事务展示。活事务一旦按 `updatedAt` 排序，任何确认、排队、执行、失败都会触发跳位，用户无法再把“这张卡”稳定映射到“那条请求”。

3. 当前项目最需要的是简单、稳定、可解释的交互，不是“看起来很动态”的列表。把活请求和历史拆成两段，比在一个列表里反复重排要简单得多，也更容易测试。

4. 这次的用户目标不是“点一次以后下一条能接着处理”，而是“多条请求同时可见，各自独立处理”。这要求卡位稳定，而不是只要求状态机正确。

## 本单补充定义

> 本段是这次硬切换的行为单真值。后续改语义，必须先改这里。

### 一、popup 主页面分成“活请求区 + 历史区”，不再把所有卡片当成一条同质列表

本次主页面固定为：

```txt
顶栏
站点配置
活请求区
历史区
```

定义如下：

1. 活请求区只放未终态 request：
   - `waiting_unlock_manual`
   - `waiting_unlock_auto`
   - `confirming`
   - `queued`
   - `executing`
2. 历史区只放终态 request：
   - `approved`
   - `rejected`
   - `failed`
   - `timed_out`
3. 两个区块必须有明确视觉分离，不允许用户把第二条活请求误认成“历史第一条”。

不允许：

1. 继续只渲染一个统一列表，再靠颜色暗示谁是活卡。
2. 继续用“最新卡片”和“历史卡片”二元模型描述多条活请求。
3. 继续让活请求和终态历史混排，导致确认后列表整体跳位。

### 二、活请求区的顺序固定为 `createdAt asc`，不是 `updatedAt desc`

本次活请求区排序规则固定为：

```txt
同一 currentOrigin 下
未终态 request
按 createdAt asc 排
若 createdAt 相同
按内部稳定 recordId 作次级稳定排序
```

语义：

1. 第一条请求先进第一格。
2. 第二条请求进第二格。
3. 第一条请求从 `confirming -> queued -> executing` 过程中，仍留在自己的格子里。
4. 第二条请求不能因为第一条状态更新而接管第一格的视觉位置。

理由：

1. `createdAt` 表示“这条请求什么时候来到 popup”，最符合“各自一个格子”的空间语义。
2. `updatedAt` 表示“最近一次状态变化”，适合作历史排序，不适合作活事务卡位。

不允许：

1. 活请求区按 `updatedAt desc` 排。
2. 活请求区按“phase 优先级”重排。
3. 活请求区在每次 `emitFeed()` 后整体 `sort(updatedAt desc)`。

### 三、历史区固定按 `updatedAt desc` 排序，承担“过去发生了什么”的职责

本次历史区规则固定为：

```txt
终态 request
按 updatedAt desc 排
最新完成的历史在最上面
```

语义：

1. 活请求处理期间，历史区只承载已完成事务，不参与当前交互。
2. 某条活请求进入终态后，离开活请求区，进入历史区。
3. 进入历史区后，它的排序重新按 `updatedAt desc` 参与历史排序。

说明：

1. 这意味着某条请求终态后，不再占用活请求区槽位；后面的活请求可以自然上移。
2. 这种上移是“前一条事务完成，活卡槽位释放”的正常结果，不是“第二条借壳复用第一条卡”。

不允许：

1. 终态后仍留在活请求区里，只为了维持视觉占位。
2. 为了避免上移，把所有终态卡也强行钉死在活请求区顺序里。
3. 让历史区按 `createdAt` 排，破坏“最近发生了什么”的回顾价值。

### 四、活请求区里的每张卡都默认展开；历史卡默认只读

本次交互固定为：

```txt
活请求卡
  默认展开
  直接展示详情、按钮、倒计时、状态文案

历史卡
  默认折叠或只读摘要
  用户可手动展开看详情
  不允许出现确认/取消按钮
```

约束：

1. UI 不再假设“只有索引 0 的卡值得展开”。
2. 活请求卡片的展开态必须以 `recordId` 为边界，不允许一个 React 本地状态复用到另一条 request 身上。
3. 历史卡是否默认展开可以按页面体验定，但不影响活请求展示。

不允许：

1. 继续用 `i === 0` 作为唯一默认展开策略。
2. 让第二条活请求默认折叠，逼用户误以为只有一条活请求。
3. 把活请求卡做成“点击第一张处理，其他活卡只显示一行摘要”的伪多请求模型。

### 五、feed 的展示顺序不再等于“全局 commands 按 updatedAt desc”

本次语义固定为：

```txt
request store
  唯一真相源

feed commands
  展示投影
  顺序 = 活请求区 display order + 历史区 display order
```

这意味着：

1. `ProtocolCommandFeedState.commands` 不再承诺“全局最新在前”。
2. `commands` 的顺序要么由 service 直接按新显示语义产出，要么由 UI 从 request truth 结构中稳定派生。
3. 无论采用哪种实现方式，contract 注释、文档注释、测试断言都必须同步切换。

推荐收口：

1. 保持 `requestsByRecordId` 作为唯一真相源。
2. service 在 `feedSnapshot()` 或内部 helper 中派生：
   - `liveCommands = 非终态，按 createdAt asc`
   - `historyCommands = 终态，按 updatedAt desc`
   - `commands = [...liveCommands, ...historyCommands]`
3. UI 仍可再按 `isTerminal` 分段渲染，但不再自己发明排序真值。

不允许：

1. contract 还写着“commands 已是 updatedAt desc，UI 拿来直接渲染”，实现却偷偷改成别的顺序。
2. UI 和 service 各自定义一套活卡排序规则。
3. 为了兼容旧注释，保留错误语义不改文档。

### 六、历史加载必须是“按 id 合并，活记录覆盖旧记录”，不能回退成历史第一条

本次 `loadHistoryForOrigin()` 语义固定为：

```txt
DB 历史
  提供该 origin 的终态上下文

内存 request store
  提供当前 popup 会话里的活记录与最新状态

合并规则
  同 id 时以内存记录为准
  不同 id 时共存
```

必须满足：

1. DB 里已有旧记录，内存里该 request 又推进到新 phase 时，最终 feed 里必须显示最新状态。
2. 新进来的第二条 request，绝不能因为 DB 读回了一条旧历史而被“视觉上覆盖到第一格”。
3. 历史加载完成后，当前活请求区顺序仍按 `createdAt asc` 重建，不许直接吃 DB 返回顺序。

不允许：

1. “DB 里已存在同 id，就不再用内存记录覆盖”。
2. “loadHistoryForOrigin 完成后直接 `this.feedCommands = listFromDb`”。
3. 用 DB 记录里的过时字段把当前活卡内容覆盖回旧值。

### 七、历史加载必须具备批次隔离，旧 origin 或旧批次结果不能覆盖当前视图

本次明确要求：

1. `historyLoadInFlight` 不能再只是一个无区分的全局 promise。
2. 必须按 `origin` 或批次 token 做隔离。
3. 若旧批次异步返回时，当前 `currentOrigin` 已切换，旧结果必须丢弃，不得回写 feed。

理由：

1. 当前项目允许同一 popup 会话内切 origin。
2. 不做隔离，旧批次结果会把当前视图打回过去，看起来像“第一条旧卡又冒回来了”。

### 八、交互 API 仍按 `recordId` 精确作用到具体卡片，不再有“最新活卡”心智

本次 UI 交互固定为：

1. `confirmByUser(recordId)` 只确认对应卡片。
2. `rejectByUser(recordId)` 只取消对应卡片。
3. `confirmDeadlineMs(recordId)` 只读对应卡片 deadline。
4. 活请求区所有按钮都必须带明确 `recordId`。

兼容说明：

1. service 内部可以临时保留无参兼容分支，防止旧测试或旧调用炸掉。
2. 新 UI、新测试、新文档都不允许再依赖“无参 = 取当前最新一张”。

不允许：

1. 在 `ProtocolCommandFeed.tsx` 里调用无参 `confirmByUser()`。
2. 继续把“当前请求”理解成“随手取一张 confirming 卡”。
3. 让第一张卡的按钮影响第二张卡。

## 特殊情况处理

### 一、连续两条 `cipher.decrypt`

期望行为：

1. 第一条进入活请求区第一格。
2. 第二条进入活请求区第二格。
3. 两张卡都默认展开。
4. 第一张点确认后进入 `queued` 或 `executing`，仍留在第一格。
5. 第二张继续留在第二格，直到它自己被确认或取消。

不允许：

1. 第一张确认后，第二张直接顶成“第一张框还在，只是内容变了”。
2. 用户需要连续点两次同一个视觉框，才能把两条请求都处理完。

### 二、第一条活请求终态后，第二条上移

这是允许且预期的：

1. 第一条进入终态后，从活请求区移到历史区。
2. 第二条成为活请求区第一格。
3. 这种上移是“前面的活事务已结束”，不是“第二条复用了第一条卡”。

要求：

1. 上移前后第二条必须保持自己的 `recordId`、按钮绑定、倒计时、内容不变。
2. 不允许通过复用 DOM / 复用本地展开态，让第二条继承第一条的 UI 残留。

### 三、relock

期望行为：

1. 所有 `confirming` 卡回到 `waiting_unlock_manual`。
2. 活请求区顺序不变。
3. timeout 清掉。
4. 已在 `queued` / `executing` 的卡仍按既有语义处理，不因为重锁而重排。

### 四、外部 `cancel(id)`

期望行为：

1. 命中哪一条，就只改变哪一条卡。
2. 被取消的活卡进入终态后离开活请求区，进入历史区。
3. 其它卡片的位置与内容不受影响。

### 五、DB 不可用

期望行为：

1. 活请求区仍正常工作，因为 request store 在内存里。
2. 历史区只显示本会话里还能从内存派生出来的终态，不要求跨会话恢复。
3. UI 顶部继续显示“历史不可用”。

不允许：

1. 因为 DB 挂了，就把多条活请求收缩成一张“当前请求卡”。
2. 因为 DB 挂了，就把活请求展示退回旧模型。

### 六、同一 popup 会话里切换 origin

本次不引入“多 origin 同屏”复杂模型，继续保持：

1. `currentOrigin` 仍表示当前展示的 exact origin。
2. 新 origin request 到达时，popup 切到该 origin 视图。
3. 旧 origin 的 request store / 历史仍保留，后续再回到该 origin 时按其自己的数据重建视图。

本次明确不做：

1. 多 origin tab。
2. 多 origin 活请求同屏并排。
3. 跨 origin 共享一个活请求区排序。

### 七、popup 刷新 / 关闭

期望行为：

1. 当前会话内存请求全部结束。
2. 已落到 DB 的终态历史，下次可按 origin 再加载。
3. 未持久化成功的活请求不做恢复，不做“占位卡复原”。

## 文件级改动要求

### 一、协议文档

需要修改：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`

必须改成：

1. 删除“当前请求交互只发生在命令流最新卡片里”的旧表述。
2. 改成“当前 origin 视图由活请求区 + 历史区组成；活请求区可同时存在多张活卡”。
3. 明确活请求区按 `createdAt asc`，历史区按 `updatedAt desc`。
4. 特殊情况章节要覆盖“两条同类 decrypt 同时可见，不复用第一格”。

### 二、contracts

需要修改：

- `packages/contracts/src/protocol.ts`

必须改成：

1. `ProtocolCommandFeedState` 注释不再写“commands 已按 updatedAt desc，UI 直接渲染”。
2. 改成“commands 是展示顺序投影：活请求在前，历史在后”或等价明确定义。
3. `ProtocolService.feedSnapshot()` 注释同步更新。
4. 与“最新卡片”相关的旧注释全部收口到“活请求区中的具体卡片”。

### 三、service

需要修改：

- `packages/plugin-protocol/src/protocolService.ts`

必须完成：

1. 抽出“是否终态”的统一 helper。
2. 抽出 feed 展示排序 helper：
   - 活请求按 `createdAt asc`
   - 历史按 `updatedAt desc`
3. `upsertFeedCommand()` / `writeFeedCommandFor()` / `feedSnapshot()` 统一走新排序语义。
4. `loadHistoryForOrigin()` 改成按 id 合并，内存活记录覆盖 DB 旧记录。
5. 历史加载加 origin / token 隔离，旧批次结果不能回写当前视图。
6. 修掉把 `origin` 误传成 `activePublicKeyHex` 的错误调用，避免展示脏数据。

### 四、popup 页面

需要修改：

- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

必须完成：

1. 页面语义从“单一命令流列表”切到“活请求区 + 历史区”。
2. 回到最新 / 自动滚动等行为优先对活请求区顶部生效，而不是盲目按总条数滚。
3. 若需要节标题，文案必须清楚区分“待处理请求”和“历史”。

### 五、命令流组件

需要修改：

- `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`

必须完成：

1. 按终态 / 非终态拆成两个区块渲染。
2. 活请求卡全部默认展开。
3. 历史卡保持只读，不出现确认/取消按钮。
4. 组件内部不再用 `i === 0` 决定唯一展开卡。
5. 活卡展开态按 `recordId` 稳定绑定，不允许因重排继承上一张卡的本地状态。

### 六、样式

需要修改：

- `packages/plugin-protocol/src/styles.css`

必须完成：

1. 为活请求区和历史区提供清晰分组样式。
2. 活卡的视觉重点要明显高于历史卡。
3. 不通过动画掩盖跳位问题；顺序语义必须先正确。

### 七、测试

需要修改：

- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

必须补的断言：

1. 连续两条 `cipher.decrypt` 进入后，feed 中有两条独立活记录。
2. 活记录显示顺序按 `createdAt asc`，不是 `updatedAt desc`。
3. 第一条进入 `queued` / `executing` 后，第二条仍是第二格，不接管第一格。
4. 第一条终态进入历史区后，第二条成为活请求区第一格，但 `recordId`、按钮绑定、内容不变。
5. `loadHistoryForOrigin()` 不会让 DB 旧记录覆盖当前活卡状态。
6. 切换 origin 时，旧批次历史加载结果不会串回当前视图。

## 最终验收清单

### 一、活请求固定槽位

- 连续发送两条 `cipher.decrypt`，popup 同时出现两张独立活卡。
- 第一条在第一格，第二条在第二格。
- 第一条状态变化时，第二条不会借壳显示成第一格。
- 每张卡的确认、取消、倒计时都只作用于自己。

### 二、活请求区与历史区分离

- 未终态 request 只出现在活请求区。
- 终态 request 只出现在历史区。
- 活请求区顺序按 `createdAt asc`。
- 历史区顺序按 `updatedAt desc`。

### 三、同类请求不复用卡位

- 两条同 method、相近文案的请求仍能被清楚识别成两张卡。
- 用户不需要连续点击同一个视觉框两次，才能处理两条请求。
- UI 上不存在“看起来还是第一条框，只是内容换了”的现象。

### 四、状态推进稳定

- `confirming -> queued -> executing` 过程中，卡片在活请求区相对顺序不变。
- relock 后 `confirming -> waiting_unlock_manual`，卡位不变。
- `cancel(id)` 只让目标卡离开活请求区，其他卡不受影响。

### 五、历史加载与切 origin

- 历史加载完成后，当前活卡状态不会被旧 DB 记录覆盖。
- 新 origin request 到达后，popup 切到新 origin 视图。
- 旧 origin 的历史加载结果晚回来时，不会覆盖当前 origin 视图。

### 六、降级与异常

- DB 不可用时，活请求区仍可正常并存显示多条卡片。
- popup 刷新 / 关闭后，不做会话级活卡恢复。
- 即便历史不可用，也不会退回“单一当前请求卡”的旧模型。
