# 003 消息会话内嵌 WebRTC + 全局紧急 Notice Rail 硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下现状文件与文档为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/registries.ts`
- `packages/contracts/src/topbar.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/registries/topbarRegistry.ts`
- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/shell/Topbar.tsx`
- `apps/web/src/styles/global.css`
- `apps/web/src/bootstrapPlugins.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/messageConversation.ts`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `packages/plugin-message/src/styles.css`
- `packages/plugin-message/src/MessageDetailPage.test.tsx`
- `packages/plugin-webrtc/src/manifest.ts`
- `packages/plugin-webrtc/src/webrtcService.ts`
- `packages/plugin-webrtc/src/webrtcSignal.ts`
- `packages/plugin-webrtc/src/WebrtcPage.tsx`
- `packages/plugin-webrtc/src/WebrtcPage.test.tsx`
- `packages/plugin-webrtc/src/constants.ts`
- `施工单/2026-07-04/002-plugin-webrtc-stun-online-gated-hard-switch.md`
- `施工单/2026-07-09/002-contacts-publickeyhex-and-message-conversation-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“全局紧急通知真值属于 shell/runtime，不属于某个业务插件”的定义优先。
2. 本单关于“消息文本与 WebRTC 历史分库存储、会话页只做时间线合并展示”的定义优先。
3. 旧文档里凡是把 `plugin-webrtc` 限定为“只存在 `/system/webrtc` 工作台、不得进入 `/messages` 子页”的边界，本次全部失效。
4. 本次是硬切换，不保留双入口、不保留“先在 `/system/webrtc` 做一套，再慢慢搬进消息页”的过渡方案，不保留离线来电、来电队列、断点续传、跨刷新动作回调持久化。

---

## 1. 文档定位

这不是一次“消息页后面多加几个按钮”的小改，也不是“专门为 WebRTC 补一个来电弹框”的局部优化。

本单一次性定义 4 个新边界：

1. `AppShell` 增加全局 `notice rail`，用于承载“需要用户立刻处理”的系统级通知。
2. `notice` 是通用紧急交互能力，不为 WebRTC 特化；WebRTC 只是第一批消费者。
3. `plugin-message` 会话详情页从“纯文本消息页”升级为“文本消息 + WebRTC 历史合并时间线”。
4. `plugin-webrtc` 从“系统工作台主入口”硬切到“消息会话内的一等业务能力”，同时保留设置/诊断页，不再把 `/system/webrtc` 当主流程。

本单要解决的实际问题是：

- 当前 shell 没有一个全局、稳定、可并存多条的紧急通知承载区；
- 当前 `plugin-webrtc` 虽然已有单活通话状态机，但入口仍是 `/system/webrtc`，这与“围绕某个 `publicKeyHex` 对话”的产品模型不匹配；
- 文本消息与通话/图片/文件历史本来就不是一类真值，强行都塞进 `AppMsgMessage` 会把契约做坏；
- 图片/文件如果继续走 `appmsg`，会把文本消息系统拖进二进制附件、下载、预览、分片等复杂度，方向错误。

---

## 2. 简述缘由

### 2.1 紧急通知是壳层能力，不是某个业务插件的真值

用户这次提的是“系统级通用消息，支持多个 notice、多个按钮、可跳转到对应插件页面继续处理”。

这类能力天然属于：

- 全局壳层固定位置渲染；
- 多业务插件都能投递；
- shell 自己不理解业务语义，只渲染结构化动作。

如果把 notice 真值做进 `plugin-notice`：

- 其它插件都会反向依赖一个 UI 插件；
- shell 反而要等插件装完才能知道有没有通知；
- 后续任何“立即处理”业务都会绕路进这个插件，边界会倒挂。

因此本次必须收口为：

- **真值**：`runtime` 新增 `notice.registry`
- **渲染**：`AppShell` 固定渲染 `notice rail`
- **业务来源**：`plugin-webrtc` / 后续其它插件

“`plugin-notice`”这个名字可以保留为口头称呼，但本次**不**把全局通知真值做成一个独立业务插件。

### 2.2 文本消息和 WebRTC 历史不是同一类数据

文本消息的真值已经很清楚：

- 走 `appmsg`
- 走 `AppMsgEndpointService`
- 本地真值在 `plugin-appmsg` 自己的消息库

而 WebRTC 历史的本质是：

- 通话记录
- 图片/文件传输记录
- 本地 blob / 下载信息
- 只属于本地会话展示，不属于对端消息协议真值

如果把这两者硬合并成一种存储：

- `AppMsgMessage` 契约会被迫长出附件字段、系统记录字段、下载字段；
- `plugin-appmsg` 会被迫承担不属于它的 WebRTC 业务复杂度；
- 后续所有依赖 `appmsg` 的插件都要被这套复杂度污染。

因此本次必须明确：

- 文本消息继续留在 `appmsg`
- WebRTC 历史单独进 `plugin-webrtc` 自己的 key-scoped 本地库
- `plugin-message` 只在会话页把两路数据按时间合并展示

### 2.3 WebRTC 主入口必须围绕 `publicKeyHex` 会话，而不是系统工作台

你要的交互是：

- 进入某个 `publicKeyHex` 会话后
- 立刻能判断对方是否在线
- 直接在发送框后面发起视频/音频/图片/文件

这和当前 `/system/webrtc` 的工作台模式是冲突的。

继续坚持系统工作台主入口会导致：

- 用户先去另一页输入一次 `publicKeyHex`
- 再回来消息页继续聊天
- 来电还要在系统页和消息页之间来回找状态

这和“像手机短信/IM 那样围绕联系人会话展开”的产品模型不一致。

所以本次必须硬切：

- `/messages/:publicKeyHex` 成为 WebRTC 主交互入口
- `/system/webrtc` 只保留为设置 / STUN 诊断 / 开发排障页

### 2.4 多条 notice 可以支持，但 WebRTC 不应借机做来电排队系统

全局 `notice` 系统应支持多条并存，因为以后不只 WebRTC 会用它。

但当前 `plugin-webrtc` 已经明确是单活会话模型。如果因为 `notice` 支持多条，就顺手把 WebRTC 做成：

- 多路同时来电
- 本地排队
- 先后接听仲裁
- 多个邀请并存等待用户选择

那就已经超出当前系统简单性边界了。

因此本次必须固定：

- `notice.registry` 支持多条
- `plugin-webrtc` 仍然是单活
- 新来电若本地已有活动会话或已有待处理来电，直接回 `busy`
- WebRTC 不做本地来电排队

### 2.5 图片/文件必须走 WebRTC，但不能把系统拖进“大附件平台”

你要的是：

- 图片：会话内展示缩略图，点开看大图，可下载
- 文件：会话内展示下载项，不预览

这可以做，但必须明确边界：

- 只做点对点 WebRTC data channel 传输
- 不做离线代收
- 不做中转存储
- 不做断点续传
- 不做目录/文件夹同步

否则“发个文件”会迅速膨胀成另一套存储系统。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `AppShell` 新增全局 `notice rail`，位置在 `Topbar` 下方、主内容区右上。
2. `notice.registry` 成为系统级通用能力，支持多条 notice 并存、按钮动作、可选跳转、订阅刷新。
3. shell 只渲染结构化 notice，不理解任何 WebRTC / protocol / background 业务语义。
4. `/messages/:publicKeyHex` 会话页在发送按钮后新增动作区：
   - 竖线分隔
   - 视频联系
   - 音频联系
   - 发送图片
   - 发送文件
5. 会话页进入后每 3 秒探测当前 peer 在线状态；非 `online` 时上述 4 个按钮全部置灰。
6. 文本消息继续走 `appmsg`，不新增附件字段、不新增系统记录字段。
7. `plugin-webrtc` 新增自己的 key-scoped 本地历史库，单独持久化：
   - 通话完成/未接等系统历史
   - 图片传输记录与本地 blob
   - 文件传输记录与本地 blob
8. `plugin-message` 会话页按时间把“文本消息”和“WebRTC 历史”合并成一条时间线，但渲染类型分开。
9. 图片记录展示缩略图，点击可看大图并下载；文件记录只展示文件项与下载动作，不预览。
10. WebRTC 通话仍然只支持单活会话，不做本地来电队列，不做并发接听。
11. `/system/webrtc` 不再是主业务入口，只保留设置、诊断、调试职责。
12. 本次不引入 TURN，不引入离线邀请，不引入断点续传，不引入跨刷新动作回调持久化。

---

## 4. 单真值与职责边界

### 4.1 `notice.registry` 才是紧急通知真值

本次新增的全局通知系统，唯一真值在 `runtime`：

- `notice.registry`

它负责：

- `upsert` 一条 notice
- `dismiss` 一条 notice
- `list` 当前 notice
- `subscribe` 通知列表变化

它不负责：

- 持久化业务历史
- 理解业务动作语义
- 记录“用户处理了什么业务”
- 跨刷新恢复回调

### 4.2 `AppShell` 只负责固定位置渲染，不负责业务判断

`AppShell` / shell 层只负责：

- 取 `notice.registry.list()`
- 按排序规则渲染 notice rail
- 执行动作按钮绑定的通用 `run()` / `navigateTo`
- 响应式布局

shell **不**负责：

- 判断是否应该接听
- 判断是否应该挂断
- 判断某个 WebRTC 邀请是否过期
- 决定哪些 notice 应该出现

### 4.3 `plugin-webrtc` 负责通话/传输状态机与自身历史

`plugin-webrtc` 继续持有：

- 单活会话状态机
- WebRTC 信令
- 在线门禁
- 音视频媒体流
- 图片/文件 data channel 传输协议
- WebRTC 自己的本地历史库
- 何时投递 / 更新 / 撤销 notice

它不负责：

- 渲染全局 notice rail
- 改写 `appmsg` 契约
- 让 shell 知道自己的业务方法名

### 4.4 `plugin-message` 只负责会话 UI 与时间线合并

`plugin-message` 负责：

- 文本消息发送与展示
- 当前会话的在线状态轮询
- 调起 WebRTC 音视频/文件/图片动作
- 把两路历史数据按时间合并成时间线

它不负责：

- 持有 WebRTC 通话状态机
- 直接操作 `RTCPeerConnection`
- 管理全局 notice 真值

### 4.5 本次不新增独立 `plugin-notice` 真值插件

这里必须直接纠正设计方向：

- 你口头上可以把它叫“notice 插件”
- 但真正实现上，**不能**把全局通知真值做进一个业务插件

否则后面所有插件都要倒挂依赖它，边界一定坏。

如果后续确实需要一个 `/system/notices` 调试页，可以另起一个薄插件去**消费** `notice.registry`；但那是后话，不是本次主线。

---

## 5. Notice 通用契约

### 5.1 新增结构化 notice 模型

本次必须新增独立 contract，暂定：

```txt
packages/contracts/src/notice.ts
```

最小公开模型应收口为：

```txt
NoticeRecord
  id: string
  sourcePluginId: string
  priority: number
  title: I18nText
  body?: I18nText
  createdAtMs: number
  routeTo?: string
  dismissible?: boolean
  actions: NoticeAction[]

NoticeAction
  id: string
  label: I18nText
  variant?: "primary" | "secondary" | "danger"
  run?: () => void | Promise<void>
  navigateTo?: string
  autoDismiss?: boolean
```

关键约束：

1. `id` 是 notice 真值主键；同 id 再次 `upsert` 表示覆盖更新，不是叠加。
2. `run()` 是**当前页面内存态动作**，不持久化。
3. `navigateTo` 是可选增强，不是唯一动作入口。
4. `sourcePluginId` 仅用于诊断、归属与后续 owner 回收，不用于排序。
5. 通知内容只允许结构化文本 + 按钮；**不**允许自定义 JSX。

### 5.2 Notice 排序与渲染规则

排序固定为：

1. `priority` 降序
2. `createdAtMs` 降序

渲染固定为：

- 桌面端最多直接展示前 3 条
- 超出部分展示“还有 N 条”
- 每条 notice 独立按钮组

本次 notice rail 不做：

- 展开收起复杂交互
- 分页
- 历史归档
- 任意自定义卡片布局

### 5.3 Notice 生命周期

本次只允许两种消失路径：

1. 业务插件显式 `dismiss(id)`
2. 用户点击 dismiss / 某个 `autoDismiss` 动作后由系统 dismiss

本次不做：

- 自动过期清理框架
- 定时器中心
- 跨刷新自动恢复动作回调

如果某个业务需要刷新后 notice 还在，规则固定为：

- 源插件在自己 setup / 状态恢复时，基于自身真值重新 `upsert`
- 不是让 `notice.registry` 去持久化业务回调

---

## 6. 消息会话内嵌 WebRTC 的最终形态

### 6.1 会话详情页动作区

`/messages/:publicKeyHex` 的发送区固定改成：

```txt
发送按钮 | 视频联系 | 音频联系 | 发送图片 | 发送文件
```

规则：

1. 动作区只在合法 `peerPublicKeyHex` 会话页显示。
2. 文本输入与文本发送保持现状，不与 WebRTC 共用表单。
3. 图片 / 文件动作直接打开文件选择。
4. 视频 / 音频动作直接调用 `webrtc.service`。

### 6.2 会话页在线探测

进入某个会话页后：

- 每 3 秒调用一次在线查询
- 只查当前 peer
- 离开页面立即停止轮询

门禁语义固定：

- `online`：按钮可用
- `offline`：按钮全部置灰
- `unknown`：按钮全部置灰

本次不做：

- 在线状态全局缓存中心
- 多个会话共享轮询器
- 指数退避
- 手动刷新按钮

页面级定时轮询足够，离开即停，保持简单。

### 6.3 `/system/webrtc` 的角色变化

本次硬切换后：

- `/system/webrtc` **不再**承担日常通话主入口
- 它只保留：
  - STUN 设置
  - STUN 自检
  - 当前会话诊断
  - 开发/排障观察

这意味着旧施工单里“页面边界不新增 `/messages` 子页”的约束失效。

---

## 7. WebRTC 历史库与时间线模型

### 7.1 新增 `plugin-webrtc` 自己的 key-scoped 本地库

`plugin-webrtc` 必须新增 key-scoped storage，单独持久化自己的历史。

它至少要有两类记录：

1. `call_records`
2. `transfer_records`

其中：

- `call_records`：音频/视频通话结果
- `transfer_records`：图片/文件传输结果与本地 blob 引用

本次不允许把这些记录混进 `plugin-appmsg` 的消息库。

### 7.2 WebRTC 历史记录形态

本次时间线需要的最小记录类型：

```txt
WebrtcHistoryRecord
  recordId
  ownerPublicKeyHex
  peerPublicKeyHex
  kind: "audio_call" | "video_call" | "image" | "file"
  direction: "outgoing" | "incoming"
  status: "completed" | "missed" | "rejected" | "failed"
  startedAtMs
  endedAtMs?
  durationSec?
  fileName?
  mimeType?
  byteLength?
  blobKey?
```

约束：

1. 图片/文件的可下载内容只保存在本地，不进入 `appmsg`。
2. 会话页展示依赖本地 blob；对端不会自动获得“可回看资源链接”。
3. 历史记录只记录**完成态**或明确终态；不记录拨号中、ICE gathering、中间协商细节。

### 7.3 时间线合并规则

`plugin-message` 会话页读取两路数据：

1. `AppMsgMessage[]`
2. `WebrtcHistoryRecord[]`

再映射成统一时间线项：

- `text_message`
- `webrtc_call_record`
- `webrtc_image_record`
- `webrtc_file_record`

最后按时间倒序合并展示。

关键要求：

1. 文本消息仍然是聊天气泡。
2. 通话记录是系统样式行，不算聊天消息。
3. 图片记录展示缩略图、查看大图、下载。
4. 文件记录只展示文件名/大小/下载，不预览。

### 7.4 本次不再额外写“系统记录消息”

用户已经确认接受这个边界：

- “所有这些交互都应该在 message 里留下一条系统记录”这句不再按 `appmsg` 系统消息落地
- 因为 WebRTC 历史本身已经是独立记录源

因此本次**不能**再为了“看起来像同一种消息”去伪造一条 `AppMsgMessage` 系统消息。

---

## 8. WebRTC 通话与图片/文件传输规则

### 8.1 通话

通话继续沿用当前单活状态机，新增的只是入口与历史落库。

完成通话后，`plugin-webrtc` 必须落一条历史：

- 音频：`audio_call`
- 视频：`video_call`

至少记录：

- 对端 `publicKeyHex`
- 方向
- 开始时间
- 结束时间
- 时长
- 终态

### 8.2 图片发送

图片规则固定为：

1. 用户本地选图。
2. 通过 WebRTC data channel 发送二进制分片。
3. 完成后双方都在本地生成一条 `image` 历史记录。
4. 会话页展示缩略图。
5. 点击缩略图可查看大图与下载。

本次不做：

- 图片编辑
- 压缩工具链
- EXIF 清理
- 多图批量发送

### 8.3 文件发送

文件规则固定为：

1. 用户本地选文件。
2. 通过 WebRTC data channel 发送二进制分片。
3. 完成后双方都在本地生成一条 `file` 历史记录。
4. 会话页只展示文件名、大小、下载动作。
5. 文件不预览。

### 8.4 大小与失败边界

为了避免本次被拖进“大文件平台”，必须加固定上限。

本次建议固定：

- `MAX_WEBRTC_TRANSFER_BYTES = 16 * 1024 * 1024`

即：

- 图片超过 16 MiB：直接本地报错，不发起传输
- 文件超过 16 MiB：直接本地报错，不发起传输

这样虽然保守，但边界清楚，且不需要为了少数边缘文件把系统拉进更复杂的流控/断点续传设计。

### 8.5 分片协议最小化

data channel 本次允许新增最小分片协议，但必须保持简单：

- `transfer_begin`
- `transfer_chunk`
- `transfer_end`
- `transfer_cancel`

不允许继续扩张成：

- 重传窗口
- 丢块重试
- 断点续传
- 进度持久化

丢了就失败，重新发，这是本项目当前更正确的复杂度取舍。

---

## 9. 特殊情况应该怎么办

### 9.1 同时有多个 notice

`notice.registry` 必须支持多条并存。

处理规则：

- shell 按优先级展示前 3 条
- 其余只显示计数，不做复杂展开
- 每条 notice 独立动作、独立 dismiss

### 9.2 同时来了多个 WebRTC 来电

本次固定策略：

- `plugin-webrtc` 仍是单活
- 本地已有活动会话或待处理来电时，新来电直接回 `busy`
- 不在本地排队
- 不在 notice rail 里堆多个“可接听来电”

如果要做来电排队，应另起施工单重做 `plugin-webrtc` 状态机，本次明确不做。

### 9.3 用户不在对应会话页时收到来电

处理规则：

- `plugin-webrtc` 投递全局 notice
- notice 可直接 `接听`
- `接听` 成功后自动跳转到对应 `/messages/:publicKeyHex`

这就是全局 notice rail 存在的意义。

### 9.4 用户已经在对应会话页时收到来电

处理规则：

- 页面内可展示局部状态
- 但全局 notice 仍然允许出现
- 不做“页面里有了就禁止 notice 出现”的复杂互斥逻辑

因为 notice 的职责是“不要让用户错过需要立即处理的事”，不是“绝对不重复一像素”。

### 9.5 浏览器刷新

刷新后：

- `notice.registry` 内存回调丢失
- shell notice 会消失

这是允许的。

如果源插件认为某个 notice 仍应存在，规则固定为：

- 源插件在 setup / 状态恢复后基于自身真值重新 `upsert`

本次不为回调持久化新增框架。

### 9.6 vault 锁定 / active key 切换

锁定或切换 active key 时：

- 当前 WebRTC 会话立刻挂断并清理资源
- 当前 owner 对应的在线轮询停止
- 当前 owner 对应的 notice 由源插件撤销
- 新 owner 的会话页重新从自己的 key-scoped 历史库读取

本次不跨 owner 共享任何会话历史或 notice。

### 9.7 对方在线状态是 `unknown`

和 `offline` 一样处理：

- 4 个动作按钮全部置灰
- 不发起通话
- 不发起图片/文件传输

本次 fail-closed，不做“unknown 也试试看”。

### 9.8 传输中断

传输中断时：

- 不生成 `completed` 历史
- 当前临时 UI 可以显示错误
- 用户自己重新发

本次不记录“半条失败附件历史”，避免时间线被各种失败碎片刷脏。

### 9.9 图片/文件下载

下载永远只依赖本地 blob。

如果本地 blob 丢失或数据库损坏：

- 时间线项仍可见
- 但下载动作报“本地文件不可用”

本次不做“向对方补拉一次附件”。

---

## 10. 应该怎么做

### 10.1 新增 `notice` contract 与 registry

必须新增：

- `packages/contracts/src/notice.ts`
- `packages/runtime/src/registries/noticeRegistry.ts`

必须修改：

- `packages/contracts/src/index.ts`
- `packages/contracts/src/registries.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/index.ts`

要求：

1. 暴露 `notice.registry` capability。
2. registry 支持 `upsert / dismiss / list / subscribe`。
3. 支持 owner 回收与 plugin 卸载后清理自己投递的 notice。
4. 错误信息保持英文。

### 10.2 `AppShell` 增加全局 notice rail

必须修改：

- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/styles/global.css`

要求：

1. 在 `Topbar` 下方、`app-shell__body` 内新增 notice rail 布局。
2. 桌面端固定右栏，移动端折叠到主内容上方。
3. 没有 notice 时右栏不占固定空白。
4. 每条 notice 渲染标题、正文、按钮组、可选 dismiss。
5. 按钮动作统一支持：
   - 执行 `run()`
   - 跳转 `navigateTo`
   - `autoDismiss`

### 10.3 `plugin-message` 内嵌 WebRTC 动作区与时间线合并

必须修改：

- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `packages/plugin-message/src/messageConversation.ts`
- `packages/plugin-message/src/styles.css`
- `packages/plugin-message/src/MessageDetailPage.test.tsx`
- `packages/plugin-message/src/manifest.ts`

可能新增：

- `packages/plugin-message/src/messageTimeline.ts`
- `packages/plugin-message/src/MessageAttachmentLightbox.tsx`

要求：

1. 详情页动作区加到发送按钮后方。
2. 进入会话页后开始 3 秒在线探测，离开即停。
3. 引入 `webrtc.service` 依赖。
4. 支持从 `plugin-webrtc` 读取当前 peer 历史并与文本消息合并。
5. 图片项支持查看大图与下载；文件项只支持下载。

### 10.4 `plugin-webrtc` 新增历史库、传输协议、notice 发布

必须修改：

- `packages/plugin-webrtc/src/manifest.ts`
- `packages/plugin-webrtc/src/webrtcService.ts`
- `packages/plugin-webrtc/src/webrtcSignal.ts`
- `packages/plugin-webrtc/src/constants.ts`
- `packages/plugin-webrtc/src/WebrtcPage.tsx`
- `packages/plugin-webrtc/src/WebrtcPage.test.tsx`
- `packages/plugin-webrtc/src/webrtcService.test.ts`

必须新增：

- `packages/plugin-webrtc/src/webrtcHistoryDb.ts`
- `packages/plugin-webrtc/src/webrtcHistoryService.ts`
- `packages/plugin-webrtc/src/webrtcTransferProtocol.ts`

要求：

1. 新增 key-scoped storage，持久化 WebRTC 历史。
2. 继续维持单活会话模型。
3. 收到来电时向 `notice.registry` 投递结构化 notice。
4. 通话结束后落通话历史。
5. 图片/文件传输完成后落传输历史与本地 blob。
6. `/system/webrtc` 页面退为诊断/设置入口，不再承担主业务入口语义。

### 10.5 装配层收口

必须修改：

- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`

要求：

1. 保证 `plugin-message` 能取到 `webrtc.service`。
2. 保证 `plugin-webrtc` 能取到 `notice.registry`。
3. 不新增假的 `plugin-notice` 真值插件。

---

## 11. 明确不能怎么做

### 11.1 不能把全局 notice 真值做进 `plugin-notice`

本次明确不能：

- 新建一个 `plugin-notice`，然后让其它插件都去依赖它的 capability
- 让 shell 去 import 某个业务插件才能拿到全局 notice

这是错误的依赖方向。

### 11.2 不能让 shell 渲染任意业务 JSX

本次明确不能：

- `notice` 记录直接带 React component
- 让业务插件把整块自定义 UI 塞进 shell

否则 notice rail 会失控，最终变成第二套页面框架。

### 11.3 不能把图片/文件重新塞回 `appmsg`

本次明确不能：

- 改 `AppMsgMessage` 给它加附件字段
- 给 `contentType` 再扩图片/文件类型然后把 blob 当正文
- 伪造“系统消息 + 附件消息”两套 `appmsg`

这会把文本消息系统污染坏。

### 11.4 不能为了多 notice 支持去偷渡多来电队列

本次明确不能：

- notice rail 支持多条，于是 WebRTC 也开始排多个可接听来电
- 做“稍后处理来电”
- 做“呼叫等待”

这不是 notice 能力本身的需求，而是 WebRTC 状态机升级，本次不做。

### 11.5 不能做持久化动作回调

本次明确不能：

- 把 `run()` 序列化进 storage
- 刷新后试图恢复 JS 回调
- 做通用回调恢复中心

刷新后如需 notice 继续存在，源插件自己重发。

### 11.6 不能把失败中间态刷进时间线

本次明确不能：

- “invite sent”
- “ringing”
- “ice gathering”
- “chunk 41/132”
- “传输失败重试中”

这类中间态不能进最终会话时间线。

---

## 12. 文件级实施范围

### 12.1 必须新增

- `packages/contracts/src/notice.ts`
- `packages/runtime/src/registries/noticeRegistry.ts`
- `packages/plugin-webrtc/src/webrtcHistoryDb.ts`
- `packages/plugin-webrtc/src/webrtcHistoryService.ts`
- `packages/plugin-webrtc/src/webrtcTransferProtocol.ts`

### 12.2 必须修改

- `packages/contracts/src/index.ts`
- `packages/contracts/src/registries.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/index.ts`
- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/styles/global.css`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `packages/plugin-message/src/styles.css`
- `packages/plugin-message/src/MessageDetailPage.test.tsx`
- `packages/plugin-webrtc/src/manifest.ts`
- `packages/plugin-webrtc/src/webrtcService.ts`
- `packages/plugin-webrtc/src/webrtcSignal.ts`
- `packages/plugin-webrtc/src/constants.ts`
- `packages/plugin-webrtc/src/WebrtcPage.tsx`
- `packages/plugin-webrtc/src/webrtcService.test.ts`
- `packages/plugin-webrtc/src/WebrtcPage.test.tsx`

### 12.3 视实现拆分可新增

- `packages/plugin-message/src/messageTimeline.ts`
- `packages/plugin-message/src/MessageTimeline.tsx`
- `packages/plugin-message/src/MessageAttachmentLightbox.tsx`

---

## 13. 最终验收清单

### 13.1 Notice 系统

- [ ] `runtime` 暴露 `notice.registry` capability。
- [ ] `AppShell` 出现全局 notice rail。
- [ ] notice rail 能同时显示多条 notice。
- [ ] 同 `id` 的 notice 再次投递会更新，不会重复堆叠。
- [ ] 每条 notice 的按钮可独立执行 `run()`、可独立跳转。
- [ ] shell 不 import 任何 WebRTC 业务代码。

### 13.2 消息会话页

- [ ] `/messages/:publicKeyHex` 发送按钮后出现动作区与竖线分隔。
- [ ] 每 3 秒探测当前 peer 在线状态。
- [ ] `offline` / `unknown` 时视频/音频/图片/文件按钮全部置灰。
- [ ] 离开会话页后在线轮询停止。

### 13.3 WebRTC 主流程

- [ ] 可从会话页直接发起音频/视频通话。
- [ ] 来电时若当前不在对应会话页，notice rail 会出现紧急卡片。
- [ ] 点击 `接听` 后能够接通并跳转到对应会话页。
- [ ] 本地已有活动会话或待处理来电时，新来电直接 `busy`。
- [ ] `/system/webrtc` 仍可用于设置和诊断，但不再是主入口。

### 13.4 时间线与历史

- [ ] 文本消息与 WebRTC 历史来自两套不同数据源。
- [ ] 会话页能按时间合并两路数据。
- [ ] 通话结束后会出现系统样式通话记录。
- [ ] 图片传输完成后会出现缩略图项，可查看大图和下载。
- [ ] 文件传输完成后会出现文件项，只可下载不可预览。
- [ ] 本次没有伪造任何 `appmsg` 系统消息来冒充 WebRTC 历史。

### 13.5 失败与边界

- [ ] `unknown` 在线状态不会误开放按钮。
- [ ] 超过 16 MiB 的图片/文件会被本地拒绝。
- [ ] 传输失败不会落 `completed` 历史。
- [ ] 刷新后 notice 回调不会被错误恢复；需要继续显示的 notice 由源插件自行重发。
- [ ] 锁定或切换 active key 后，当前会话、notice、轮询都会被清理。

---

## 14. 本单对旧设计的明确替换

以下旧说法在本单生效后直接失效：

1. “`plugin-webrtc` 页面边界固定为 `/system/webrtc`，不新增 `/messages` 子页。”
2. “所有系统级紧急提示可以先专门做成一个业务插件承载真值。”
3. “图片/文件如果也放进消息里，可以顺手复用 `appmsg`。”

新的单真值定义是：

- 紧急 notice 真值 = `notice.registry`
- 文本消息真值 = `appmsg`
- WebRTC 历史真值 = `plugin-webrtc` 本地库
- 会话页 = 只做合并展示与动作入口

