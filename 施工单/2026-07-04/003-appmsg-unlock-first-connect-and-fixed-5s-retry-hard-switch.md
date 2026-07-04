# 003 `appmsg` 解锁首次连接、锁定断开、固定 5 秒重连硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/appmsgService.ts`
- `packages/plugin-appmsg/src/AppMsgPage.tsx`
- `packages/plugin-appmsg/src/AppMsgPage.test.tsx`
- `packages/plugin-appmsg/src/appmsgCore.test.ts`
- `packages/plugin-hubmsg/src/hubmsgProvider.ts`
- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
- `施工单/2026-07-04/001-appmsg-provider-split-and-thin-message-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“`vault locked` 时必须断开、`vault unlocked` 后才允许首次连接、连接失败固定 5 秒重试”的定义优先。
2. 旧实现里凡是“setup 仅尝试一次、失败后只记日志不再重试”的行为，本次全部失效。
3. 本次不保留兼容层、不保留双路重连逻辑、不做“先页面补倒计时、以后再补真实重连”的过渡方案。

---

## 1. 文档定位

这不是一次“补个倒计时展示”的小修，而是一次**连接生命周期真值重定**。

当前 `appmsg` 的核心问题不是连接代码不能跑，而是连接策略和系统边界不一致：

- `vault` 锁定后，系统已经拿不到私钥，却还没有把“必须断开”明确固化成最终规则。
- `vault` 解锁后，连接只做一次 best-effort，失败后没有自动重试。
- `/system/appmsg` 虽然有连接状态，但还没有“何时下一次重连”的真值。

这会带来三个直接问题：

1. 用户解锁后如果碰到一次网络抖动，连接就会停在失败态，除非再触发别的事件。
2. 锁定、解锁、切 key、切 provider 这些结构性事件，与“网络暂时失败”的瞬时事件混在一起。
3. 管理页看得到“断开”，但看不到系统接下来会不会自己恢复、何时恢复。

所以这次要一次性把规则钉死。

---

## 2. 简述缘由

### 2.1 锁定后没有私钥，继续持连没有意义

HubMsg bind 依赖 owner 私钥签 challenge。

只要 `vault` 进入 `locked`：

- 当前文档已经没有可用 signer
- 任何后续重新建连都不再可能成功
- 保留旧连接只会制造“系统似乎还活着”的错觉

因此本次固定：

- `locked` 立即断开
- `locked` 不做重连

这不是保守，而是和系统真实能力一致。

### 2.2 解锁后的首次连接必须自动发生

`vault` 一旦重新 `unlocked`，owner 私钥能力重新可用，此时最合理的行为不是等用户手动点按钮，而是：

- 立即尝试第一次连接

因为“解锁后可连接”是结构性真值变化，不是用户可选操作。

### 2.3 网络失败应该用固定重试，不应该扩成复杂状态机

这个项目当前的系统原则很明确：

- 优先系统简单
- 边缘失败宁可失败
- 不要为了业务完整引入复杂恢复机制

所以这里不做：

- 指数退避
- 抖动随机化
- 多级错误分类
- 永久熔断
- 复杂 session resume

只做最小有效策略：

- 连接失败后固定 5 秒再试
- 一直试到成功或结构条件变化

### 2.4 管理页必须展示“系统下一步会做什么”

`/system/appmsg` 不是普通业务页，而是诊断页。

诊断页如果只能显示“closed”，用户仍然不知道：

- 是正常锁定断开
- 还是异常失败后等待恢复
- 如果会恢复，多久以后

因此必须把“等待重连倒计时”纳入状态真值，而不是 UI 自己猜。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `vault.status() === "locked"` 时，`appmsg` 主动断开当前 provider 连接。
2. `vault.status() === "locked"` 时，不安排任何自动重连计时器。
3. `vault.status() === "unlocked"` 且存在 active key 时，`appmsg` 立即尝试首次连接。
4. 首次连接失败后，系统固定在 5 秒后重试一次。
5. 只要结构条件仍满足，重试会一直循环直到成功。
6. 任意一次重连成功后，等待中的重连计时器必须被清空。
7. `/system/appmsg` 继续显示现有连接状态，并新增等待重连倒计时。
8. 倒计时只在“当前应当连接但尚未连接”时显示。
9. `locked`、无 active key、无 active provider 等结构性不可连接场景，不显示“5 秒后重连”。
10. 本次不保留“锁屏后台继续收消息”的旧设想，不保留锁定态重连。

---

## 4. 最终行为定义

### 4.1 结构性状态

本次把连接前提分成两类：

- 结构性可连接
- 结构性不可连接

结构性可连接，必须同时满足：

1. `vault.status() === "unlocked"`
2. `keyspace.active().activePublicKeyHex` 存在
3. active message provider 存在

只要三者缺一，就属于结构性不可连接。

### 4.2 结构性不可连接时的固定行为

结构性不可连接时，系统必须：

1. 立即断开已有连接
2. 清空等待中的重连计时器
3. 不再继续 5 秒循环
4. 管理页不显示等待重连倒计时

这类场景包括但不限于：

- `vault locked`
- 无 active key
- 无 active provider

### 4.3 结构性可连接时的固定行为

结构性可连接时，系统必须：

1. 立即尝试一次连接
2. 若成功，进入 `open`
3. 若失败，进入“等待重连”状态
4. 固定 5 秒后再尝试一次
5. 循环直到成功或结构条件变化

### 4.4 `/system/appmsg` 连接状态的最终语义

本次不新增一整套复杂状态机，只保留现有 `AppMsgLocalDbSnapshot.state` 三值，并补足倒计时真值：

- `idle`
  - 当前未进入可连接阶段
  - 或者当前已被结构性条件阻断
- `open`
  - 当前已建立 provider 连接
- `closed`
  - 当前应当连接，但连接失败或已断开，正在等待下次自动重试

附加字段最小扩充为：

- `nextReconnectAtMs: number | null`

约束如下：

- `open` 时必须为 `null`
- `idle` 时必须为 `null`
- `closed` 且正在等待自动重试时必须为未来时间戳

本次不再新增 `reconnectReason`、`retryAttempt`、`backoffLevel` 等字段，避免把简单问题做复杂。

---

## 5. 必须怎么做

### 5.1 在 `plugin-appmsg` setup 内建立单一重连协调器

`packages/plugin-appmsg/src/manifest.ts` 里现有的 `tryReconnect()` 只是一次性 best-effort，不够。

本次必须收口成一个**单一重连协调器**，它统一处理：

- setup 初始尝试
- `vault` 状态变化
- active key 变化
- active provider 变化
- 失败后的固定 5 秒重试

这个协调器必须满足：

1. 同一时刻最多只有一个连接尝试在飞
2. 同一时刻最多只有一个重连计时器存在
3. 结构条件变化时，旧计时器必须失效

### 5.2 `locked` 时必须显式断开并清计时器

收到 `vault.onStatusChange("locked")` 后，必须：

1. `await core.disconnect()`
2. 清掉等待中的重连 timer
3. 把 `nextReconnectAtMs` 置空
4. 发布状态变化

这里不能只“停止后续重试”而不主动断开，因为这会留下陈旧连接。

### 5.3 `unlocked` 后必须立即首次连接

收到 `vault.onStatusChange("unlocked")` 后，若 active key 与 active provider 都可用，必须立即尝试一次连接。

不能变成：

- 等用户进 `/system/appmsg` 才连
- 等用户点“手动同步”才连
- 等下一次 key 切换才连

因为这些都把结构性真值变化降级成了偶然触发。

### 5.4 失败后固定 5 秒重试，不做别的策略

连接失败时必须：

1. 写入 `lastError`
2. 设置 `state = "closed"` 对应的快照真值
3. 写入 `nextReconnectAtMs = Date.now() + 5000`
4. 安排单次 timer
5. timer 到点后再走同一套连接尝试逻辑

重试间隔固定为 5000ms。

本次不做：

- 指数退避
- 抖动
- 限次
- 按错误类型决定不同间隔

### 5.5 `AppMsgLocalDbSnapshot` 必须扩出倒计时字段

`packages/contracts/src/appmsg.ts` 的 `AppMsgLocalDbSnapshot` 必须补一个最小字段：

- `nextReconnectAtMs: number | null`

原因：

- 这是管理页要消费的系统真值
- 不应该让页面自己凭 `lastError` 推导

### 5.6 `appmsgCore` 必须拥有重连快照真值

`packages/plugin-appmsg/src/appmsgCore.ts` 必须成为重连展示真值的唯一来源。

即：

- `inspectLocalDb()` 返回的不是临时拼出来的 UI 数据
- 而是 core 当前连接态与重连态的稳定快照

因此 core 内部必须新增最小状态存储，例如：

- `nextReconnectAtMsValue`

并提供设置入口给 setup 内的重连协调器使用。

这里的设计原则是：

- 重连驱动逻辑主要在 `manifest.ts`
- 但重连展示真值收口在 `core`

这样页面仍然只面对 `appmsg.core`，不会反过来依赖 setup 内私有变量。

### 5.7 连接状态判断必须修正为“看真实 handle 状态”

当前 `inspectLocalDb()` 只看 `boundHandle` 是否存在，这不够严谨。

因为 WebSocket 若已关闭，但 handle 引用尚未清掉，页面可能会误判成 `open`。

本次必须修正为：

- `boundHandle` 存在且 `boundHandle.state() === "bound"` 才算 `open`
- 否则按是否处于等待重连决定 `closed` / `idle`

### 5.8 `/system/appmsg` 必须订阅状态变化并显示倒计时

`packages/plugin-appmsg/src/AppMsgPage.tsx` 当前主要靠：

- 首次 `refresh()`
- `subscribeUnfilteredMessages()`

这不足以驱动连接态刷新。

本次必须补两层刷新：

1. 订阅 `core.onStateChange()`，让连接态变化立即刷新页面
2. 当 `snapshot.nextReconnectAtMs !== null` 时，启动一个 1 秒 UI tick，仅用于刷新倒计时显示

这个 1 秒 tick 只属于页面展示层，不属于真实重连逻辑。

### 5.9 倒计时展示必须是“剩余秒数”，不是绝对时间

页面文案固定为：

- `等待重连：5 秒`
- `等待重连：4 秒`
- `等待重连：1 秒`

显示规则：

- 以 `Math.max(1, ceil((nextReconnectAtMs - now)/1000))` 计算
- 到点后由真实重连逻辑接管，页面不做“自己触发连接”

本次不显示：

- 绝对时间戳
- 毫秒
- 重试次数

### 5.10 手动同步不能拥有自己的重连分支

`triggerSync()` 是业务动作，不是连接生命周期 owner。

所以本次明确：

- 自动重连只由重连协调器负责
- 手动同步失败只反馈失败，不负责顺手补连或自建重试循环

这样可以避免两套恢复逻辑互相打架。

---

## 6. 不能怎么做

### 6.1 不能在 `locked` 状态继续保留后台连接

这是本次已经明确否掉的方向。

原因不是“实现麻烦”，而是：

- 锁定后已经拿不到 signer
- 连接失效后也无法恢复
- 状态语义会变得自相矛盾

因此必须硬切换为：锁定即断开。

### 6.2 不能在 `locked` 状态做假重连

不能出现这种行为：

- 每 5 秒尝试一次
- 每次都因为 `no signer` 失败
- 页面一直刷错误

这不是“坚持重试”，这是无意义空转。

正确行为是：

- `locked` 直接进入结构性不可连接
- 不显示等待重连

### 6.3 不能同时存在多个计时器或多个并发 connect

否则会出现：

- 一个失败后安排了 timer A
- 切 key 后又安排 timer B
- 两个 timer 轮流抢 connect

这会把系统拖进竞争态。

所以必须保证：

- 单飞连接
- 单实例 timer
- 旧 timer 可失效

### 6.4 不能把页面路由进入当成连接前提

`/system/appmsg` 是观察者，不是连接 owner。

不能做成：

- 只有进页面才开始首次连接
- 离开页面就停止自动重连

因为连接生命周期属于 `plugin-appmsg` 系统内核，而不是某个页面组件。

### 6.5 不能为这次需求扩张成“完整网络恢复框架”

本次禁止顺手引入：

- 通用 retry utility 抽象
- 多 provider 通用 backoff policy 插件化
- 网络错误码分类中心
- 指标上报系统

这些都和当前问题不成比例。

### 6.6 不能让 UI 自己决定是否应当重连

UI 不知道：

- vault 是否真的可签
- active key 是否有效
- 当前是否已有 in-flight connect

所以 UI 只能消费：

- `inspectLocalDb()` 快照
- `onStateChange()` 通知

不能反向拥有重连策略。

---

## 7. 特殊情况与处理规则

### 7.1 锁定发生在等待 5 秒重连期间

处理规则：

1. 立即清掉等待中的 timer
2. `disconnect()`
3. `nextReconnectAtMs = null`
4. 页面回到 `idle`

不能等 5 秒到了再发现自己已经锁定。

### 7.2 锁定发生在连接尝试 in-flight 期间

处理规则：

1. 标记本轮连接尝试结果为过期
2. 连接返回后如果发现代次已失效，不再安排下一轮重试
3. 最终以锁定态为准

本次不要求去中断 provider 内部已经发起的底层 bind，只要求结果不能污染新状态。

### 7.3 解锁后立刻切 active key

处理规则：

1. 旧 owner 的等待 timer 失效
2. 旧 owner 的连接结果若晚到，必须丢弃
3. 新 owner 立即走一次首次连接

即：owner 真值永远以最后一次结构条件为准。

### 7.4 解锁后 active provider 被切换

处理规则：

1. 旧 provider 连接断开
2. 旧 provider 的等待 timer 失效
3. 新 provider 立即尝试连接
4. 失败则对新 provider 开始新的 5 秒循环

不能把旧 provider 的失败倒计时延续到新 provider。

### 7.5 没有 active provider

处理规则：

- 视为结构性不可连接
- 不显示等待重连
- `lastError` 可以保留上一次失败信息，但 `nextReconnectAtMs` 必须清空

### 7.6 没有 active key

处理规则同上：

- 视为结构性不可连接
- 不显示等待重连

### 7.7 页面未打开时仍然要继续自动重连

处理规则：

- 自动重连属于 plugin 内核
- 与页面是否挂载无关

页面只是在打开时读取并展示当前快照。

### 7.8 连接成功后又被远端断开

处理规则：

1. `inspectLocalDb()` 必须能反映出不再是 `open`
2. 若结构条件仍满足，则进入 `closed + 5 秒后重连`
3. 若期间结构条件已变为不可连接，则直接回到 `idle`

这意味着重连协调器不能只覆盖“首次 bind 失败”，还要覆盖“连接后断线”。

### 7.9 手动同步时当前连接断了

处理规则：

- `triggerSync()` 按现有失败语义返回失败
- 不新增手动同步专属重试逻辑
- 自动重连仍由全局重连协调器接管

---

## 8. 文件级实施清单

### 8.1 `packages/contracts/src/appmsg.ts`

必须修改：

- 扩充 `AppMsgLocalDbSnapshot`
  - 新增 `nextReconnectAtMs: number | null`

必须保证：

- 契约注释明确“仅在等待自动重连时为未来时间戳”

### 8.2 `packages/plugin-appmsg/src/appmsgCore.ts`

必须修改：

- 新增最小重连快照存储
  - 例如 `nextReconnectAtMsValue`
- 新增内部设置方法
  - 供 setup 重连协调器写入 / 清空倒计时真值
- 修正 `inspectLocalDb()` 的状态判定
  - 不能只看 `boundHandle` 是否存在
- 在连接成功、断开、结构性不可连接时正确清空倒计时
- 在状态变化时触发 `fireStateChange()`

必须保证：

- 页面订阅 `onStateChange()` 后能看到连接态和倒计时变化

### 8.3 `packages/plugin-appmsg/src/manifest.ts`

必须修改：

- 删除现在的“一次性 best-effort `tryReconnect()`”思路
- 建立单一重连协调器
- 统一接管：
  - setup 初始尝试
  - `vault.onStatusChange`
  - `keyspace.onActiveChange`
  - `providers().onActiveChange`
- 连接失败后固定安排 5000ms 后重试
- 结构条件变化时使旧 timer 失效

建议实现约束：

- 用代次 token 或 epoch 防止过期异步结果回写
- 不引入通用 retry 框架

### 8.4 `packages/plugin-appmsg/src/appmsgService.ts`

原则上不需要扩 API。

如页面层需要更清晰的读取入口，可保持：

- 继续通过 `inspectLocalDb()` 取快照

本次不要在 service 层再造第二套倒计时状态。

### 8.5 `packages/plugin-appmsg/src/AppMsgPage.tsx`

必须修改：

- 订阅 `core.onStateChange()`
- 在连接快照变化时刷新页面
- 当 `nextReconnectAtMs !== null` 时启动 1 秒 UI tick
- 在“连接态”区块新增倒计时展示

必须保证：

- `locked` 或结构性不可连接时不显示等待重连
- 页面卸载时清理 UI tick

### 8.6 `packages/plugin-appmsg/src/AppMsgPage.test.tsx`

必须补测试覆盖：

- 有 `nextReconnectAtMs` 时显示等待重连
- 无 `nextReconnectAtMs` 时不显示等待重连
- `core.onStateChange()` 触发后页面能刷新连接区

### 8.7 `packages/plugin-appmsg/src/appmsgCore.test.ts`

必须补测试覆盖：

- 连接失败后快照进入 `closed`
- 设置 / 清空 `nextReconnectAtMs` 的行为
- `disconnect()` 后倒计时被清空
- 真实 handle 已不是 `bound` 时，`inspectLocalDb()` 不再误报 `open`

### 8.8 `packages/plugin-hubmsg/src/hubmsgProvider.ts`

原则上不改公开契约。

如实现验证需要，可确认：

- 连接断开后 `health()` / handle `state()` 的变化与 `appmsgCore` 新判断一致

本次不要把重连逻辑下沉到 provider。

### 8.9 `packages/plugin-hubmsg/src/hubmsgConnection.ts`

原则上不改重连策略。

若现有状态回报不足以支撑 `appmsgCore` 正确识别断线，可做最小修正，但边界必须保持：

- connection 只负责报告自身状态
- 不负责 5 秒循环重试

---

## 9. 最终验收清单

### 9.1 锁定 / 解锁主流程

- [ ] `vault locked` 后，当前 appmsg 连接会立即断开。
- [ ] `vault locked` 后，系统不会继续自动重连。
- [ ] `vault unlocked` 后，只要 active key 与 active provider 都存在，系统会立即做第一次连接尝试。

### 9.2 固定 5 秒重连

- [ ] 首次连接失败后，系统会自动进入等待重连状态。
- [ ] 等待中的下一次重连时间固定为 5 秒，不是指数退避。
- [ ] 结构条件不变时，系统会一直每 5 秒尝试一次，直到成功。
- [ ] 任意一次成功后，等待中的重连计时器会被清空。

### 9.3 结构条件变化

- [ ] 等待重连期间如果用户重新锁定，等待 timer 会被取消。
- [ ] 等待重连期间如果 active key 改变，旧 owner 的等待与结果不会污染新 owner。
- [ ] 等待重连期间如果 active provider 改变，旧 provider 的等待与结果不会污染新 provider。
- [ ] 无 active key 或无 active provider 时，不会继续 5 秒空转重试。

### 9.4 `/system/appmsg` 展示

- [ ] 连接区仍显示现有 `idle/open/closed` 状态。
- [ ] 连接失败等待重试时，会显示 `等待重连：N 秒`。
- [ ] `locked` 或其它结构性不可连接场景下，不显示等待重连文案。
- [ ] 倒计时会逐秒刷新。
- [ ] 页面不依赖收到消息推送才更新连接态。

### 9.5 实现边界

- [ ] 自动重连逻辑只存在一套，位于 `plugin-appmsg` 生命周期内核，不散落到 UI 或 provider。
- [ ] `triggerSync()` 没有额外拥有自己的重连循环。
- [ ] 没有引入指数退避、通用 retry framework、复杂恢复状态机。
- [ ] 没有恢复“锁屏后台继续运行”的旧方向。

---

## 10. 不在本次范围

本次明确不做：

- 锁定态保持后台连接
- 锁定态重连
- provider session resume 机制
- 指数退避 / 熔断 / 随机抖动
- 网络在线状态感知与浏览器 `online/offline` 事件联动
- 管理页显示重试次数、历史失败序列、详细恢复时间线
- 手动同步失败后的自动补连策略
- 跨页面共享倒计时状态的额外缓存层

这些如果以后真要做，必须另起施工单，不在本次顺手扩张。
