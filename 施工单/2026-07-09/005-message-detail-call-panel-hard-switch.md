# 005 消息详情页承载音视频通话面板 + `/system/webrtc` 退场硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下现状文件与文档为准：

- `packages/plugin-message/src/MessageDetailPage.tsx`
- `packages/plugin-message/src/MessageDetailPage.test.tsx`
- `packages/plugin-message/src/styles.css`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-webrtc/src/webrtcService.ts`
- `packages/plugin-webrtc/src/manifest.ts`
- `packages/plugin-webrtc/src/WebrtcPage.tsx`
- `packages/plugin-webrtc/src/styles.css`
- `apps/web/src/shell/AppShell.tsx`
- `packages/contracts/src/notice.ts`
- `施工单/2026-07-09/003-message-session-webrtc-notice-hard-switch.md`
- `施工单/2026-07-09/004-notice-shell-root-top-rail-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“WebRTC 主交互承载页改为 `/message/:publicKeyHex`”的定义优先。
2. 本单关于“消息详情页直接消费 `webrtc.service` 当前单活真值，不再保留独立工作台 UI”的定义优先。
3. 本单关于“视频与音频面板只消费现有 service 能力，不借机扩张 mute / camera toggle / 多会话”等边界定义优先。
4. 本次是硬切换，不保留 `/system/webrtc` 主流程，不保留双套通话 UI，不保留“先接到旧页，再慢慢搬”的过渡方案。

---

## 1. 文档定位

这不是一次“在消息页里多塞两个视频标签”的局部 UI 追加，也不是“把 `/system/webrtc` 页面复制进会话页”的搬家活。

这次要一次性收口的是 4 个边界问题：

1. **入口边界错了**：当前 WebRTC 主流程还挂在 `/system/webrtc`，而实际产品模型是“围绕某个 `publicKeyHex` 会话进行沟通”。
2. **承载边界错了**：当前 `MessageDetailPage` 只能发起动作，不能承载接通后的媒体面板，导致 notice 接通后还要去别处找通话画面。
3. **路由边界错了**：notice 的“接听”虽然已经能执行内存动作，但跳转目标还没有和最终承载页完全收口。
4. **能力边界容易失控**：如果在这次迭代里顺手加静音、切摄像头、多路来电、会中切换模式，会把当前简单单活模型重新做复杂。

因此本单要解决的不是某个按钮缺失，而是：

- WebRTC 主交互入口
- 消息详情页的媒体承载职责
- notice 接听后的落点
- 本次实现允许和不允许扩张的能力边界

全部一次性钉死。

---

## 2. 简述缘由

### 2.1 通话必须围绕会话页，而不是围绕系统工作台

当前系统里，文本消息的真值已经围绕 `publicKeyHex` 会话聚合，这个方向是对的。

如果音视频通话还保持 `/system/webrtc` 工作台模式，会导致：

- 用户在消息页确定了对端是谁，却还要再去另一页输入一次 `publicKeyHex`
- notice 来电接通后，用户不在当前对话上下文里
- 通话、消息、附件、通话历史被拆到两个页面模型，体验和数据心智都断裂

所以这次必须明确：

- WebRTC 主交互承载页是 `/message/:publicKeyHex`
- 文本消息、通话面板、图片/文件传输动作、通话历史都围绕同一个会话详情页展开

### 2.2 `/system/webrtc` 是临时工作台，不应继续占主入口

`/system/webrtc` 在当前阶段的价值，更多是：

- 早期验证 service 状态机
- 独立调试媒体绑定
- 临时排障

它不适合继续作为用户主流程页面，因为它与联系人/会话上下文天然脱节。

继续保留它做主入口，会把系统长期固定在“双入口、双 UI、双心智”的状态里。

所以这次必须硬切：

- `/system/webrtc` 退出主流程
- 相关 route / menu / breadcrumb 一次性撤掉
- 仅保留 `/settings/webrtc` 作为 STUN 设置/诊断入口

### 2.3 notice 的“接听”必须和最终承载页收口成一条链

来电 notice 现在已经具备：

- 内存态 `run()`
- 跳转 `navigateTo`

这条链本身是对的，不需要再造一套“点击接听后把命令写进 URL”的复杂机制。

问题在于：跳过去的页面还不是最终通话承载页。

所以本次正确收口方式是：

- notice 的接听继续直接调用 `webrtc.acceptIncoming()`
- 完成后跳转到 `/message/:publicKeyHex`
- 会话页读取 `webrtc.snapshot()`，根据当前会话真值直接渲染视频或音频面板

也就是说，**不新增第二套接听协议，只让承载页正确消费已有真值。**

### 2.4 这次不能借机扩张成“完整通话客户端”

用户要的是：

- 视频通话时，大画面 + 小画面
- 交换主次
- 全屏 / 退出全屏
- 音频通话时，显示对应控制面板

这不等于要在本次同时引入：

- 静音
- 切前后摄
- 关闭本地视频
- 会中视频转音频
- 多设备路由
- 多路来电并发仲裁

如果把这些都塞进来，复杂度会远大于本次真实需求，也会直接突破当前 `webrtc.service` 的最小单活模型。

因此本次必须坚持：

- UI 只消费现有 `webrtc.service` 已暴露的能力
- 不新增 service 方法，仅为展示与已有动作接线

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `/system/webrtc` 不再注册 route、menu、breadcrumb，不再作为用户可进入的主业务页。
2. `/settings/webrtc` 继续保留，作为 STUN 设置与诊断页。
3. `/message/:publicKeyHex` 成为 WebRTC 主承载路由。
4. `/messages/:publicKeyHex` 仍可作为兼容别名进入同一个 `MessageDetailPage`，但 notice 与后续主流程统一落到 `/message/:publicKeyHex`。
5. `MessageDetailPage` 在 `km-message-detail__header` 与 `km-message-detail__composer` 之间插入“会话通话面板区”。
6. 当前没有针对本 peer 的活动 WebRTC 会话时，不显示空白通话壳子。
7. 当前 peer 是视频通话时，显示视频面板：
   - 大画面默认远端
   - 小画面默认本地
   - 支持交换主次
   - 支持全屏
   - 全屏后大画面铺满，小画面浮动
   - 全屏状态下仍有交换与退出全屏按钮
8. 当前 peer 是音频通话时，显示音频控制面板，而不是视频容器。
9. 来电状态下，会话页可直接执行接听 / 拒接；已接通或连接中时可挂断。
10. notice 点击“接听”后，进入对应 `/message/:publicKeyHex` 页面，并看到匹配当前会话真值的音频或视频面板。
11. 当前页发起“视频联系 / 音频联系”时，除在线门禁外，还必须受全局单活会话门禁控制。
12. 本次不新增 mute、camera toggle、speaker toggle、会中模式切换、多会话并发支持。

---

## 4. 单真值与职责边界

### 4.1 `webrtc.service` 仍然是通话真值

本次不改 WebRTC 业务真值位置。

唯一通话真值仍然是 `webrtc.service` 的：

- `snapshot()`
- `subscribe(...)`
- `acceptIncoming()`
- `rejectIncoming()`
- `hangup()`
- `startCall(...)`
- `attachToVideo(...)`

页面层只负责消费，不重新缓存一套“通话状态机”。

### 4.2 `MessageDetailPage` 只做会话内承载，不改写 service 语义

`MessageDetailPage` 新增的职责是：

- 判断当前 `webrtc.snapshot()` 是否属于本 peer
- 根据 mode / phase 渲染对应面板
- 绑定本地 / 远端 video DOM
- 承载交换布局、全屏这种**纯显示状态**

它不负责：

- 发明新的会话 phase
- 推导新的媒体状态
- 猜测 track 是否可用
- 直接访问 `MediaStreamLike.native`

### 4.3 notice 只负责把用户送到正确会话页

notice 的职责继续保持最小化：

- 来电时出现
- “接听”执行现有 `acceptIncoming()`
- 跳转到 `/message/:publicKeyHex`

notice 不负责：

- 自己渲染通话画面
- 长期停留在页面里承载会话
- 把额外的“是否视频全屏、当前谁大谁小”写进 URL 或 registry

### 4.4 全屏与交换只是页面显示状态，不是业务真值

本次新增的：

- 交换主次
- 进入/退出全屏

都只是 `MessageDetailPage` 本地 UI 状态。

它们不能进入：

- `webrtc.service.snapshot()`
- notice
- history
- route 参数

否则只是一个显示问题，最后会污染业务真值。

---

## 5. 特殊情况应该怎么办

### 5.1 用户点击 notice 的“接听”时，已经不在空闲态

如果 notice 对应会话已经被别处处理，或者 service 已经不再是同一个 incoming 会话：

- `acceptIncoming()` 失败就失败
- notice 动作按现有错误处理结束
- 不再额外补一层复杂恢复逻辑

会话页只按当前 `snapshot()` 真值展示，不做“回放式接听”。

### 5.2 用户已经在对应 `/message/:publicKeyHex` 页面时收到来电

此时系统应该同时满足两点：

- 全局 notice 仍然照常出现，保证行为一致
- 当前会话页也能因为 `webrtc.subscribe(...)` 刷新，显示 incoming 音频或视频控制面板

用户可以从 notice 接听，也可以直接在页面面板上接听。两边最终都调同一个 `webrtc.service` 动作，不允许两套状态机分叉。

### 5.3 用户在别的 peer 会话页里，当前 peer 有活动通话

`MessageDetailPage` 的通话面板只展示“当前页面 peer 对应的会话”。

因此：

- 如果活动会话属于别的 peer，当前页不显示通话面板
- 当前页的视频/音频拨号按钮要因 `busy_local` 语义被置灰，避免点了才报错

### 5.4 活动会话存在，但还没远端视频流

比如：

- outgoing inviting
- incoming 已接听但还在 connecting

页面仍应展示视频面板壳体，但允许远端大画面处于“等待远端画面”占位，不因为没有 `remoteStream` 就退回空白页。

### 5.5 音频通话不应该渲染假视频

如果当前 mode 是 `audio`：

- 不渲染大/小视频布局
- 不渲染交换主次与视频全屏按钮
- 只渲染音频控制面板和会话状态

不能为了视觉统一，硬塞两个黑色视频框。

### 5.6 浏览器不支持 Fullscreen API 或调用失败

这属于边缘能力失败。

处理原则：

- 全屏按钮可隐藏或点击后静默失败并保持当前布局
- 不引入新的复杂 polyfill
- 不影响通话主流程

也就是说，**全屏失败不该卡住通话。**

### 5.7 页面刷新

页面刷新后，现有 `webrtc.service` 的会话内存态会丢，这与当前系统原则一致。

因此刷新后的处理是：

- 通话断掉就断掉
- 页面按最新 `snapshot()` 重新渲染为空或 ended 后的普通会话页
- 不做跨刷新通话恢复

### 5.8 当前 peer 在线状态是 `unknown`

对发起按钮的处理继续沿用现有简单门禁：

- `online` 才允许发起
- `offline` / `unknown` 都置灰

本次不为“可能其实在线”增加任何猜测式放行。

---

## 6. 应该怎么做

### 6.1 主承载路由收口到 `/message/:publicKeyHex`

主流程层面必须明确：

- notice 的 `routeTo` 与 `action.navigateTo` 全部统一到 `/message/${publicKeyHex}`
- 外部口头路径、后续直达路径也统一用单数 `message`
- `plugin-message` 仍保留 `/messages/:publicKeyHex` 兼容别名，但不再把它作为 WebRTC 主承载入口对外扩散

### 6.2 `plugin-webrtc` 撤掉 `/system/webrtc` 入口

`packages/plugin-webrtc/src/manifest.ts` 必须改成：

- 不再注册 `WEBRTC_WORKBENCH_PATH`
- 不再注册对应 menu
- 不再注册对应 breadcrumb

`/settings/webrtc` 保留不动。

`WebrtcPage.tsx` 文件本身可以暂留，前提是：

- 不再有 route 入口引用它
- 不再让它承担主业务路径

如果实现时顺手删除它，会扩大改动面；本次优先接受“文件还在，但入口已断”。

### 6.3 `MessageDetailPage` 新增会话通话面板区

在 `km-message-detail__header` 和 `km-message-detail__composer` 之间新增一块通话区域。

这块区域必须满足：

- 仅当 `webrtc.snapshot().remotePublicKeyHex === 当前 peerPublicKeyHex` 时才显示
- 订阅 `webrtc.subscribe(...)` 实时跟随刷新
- 不新建第二份通话状态

建议页面内新增三个收口判断：

- `activeCallForCurrentPeer`
- `isVideoSessionForCurrentPeer`
- `isAudioSessionForCurrentPeer`

这样能把展示条件写清楚，避免 JSX 里散落一堆硬判断。

### 6.4 视频面板只做展示编排，不改 service

视频面板实现要求：

- 远端 video 元素、大画面容器、本地浮窗 video 元素各自有稳定 DOM ref
- 继续调用 `webrtc.attachToVideo("remote" | "local", el)` 绑流
- 页面本地状态保存：
  - `isLocalPrimary`
  - `isFullscreen`

交换主次只改变 CSS/DOM 布局语义，不重新请求媒体、不重启通话、不交换 service 内的 local/remote 定义。

### 6.5 音频面板只做当前 service 支持的控制

音频面板应展示：

- 当前 phase
- 对端标识
- mode=audio
- 接听 / 拒接 / 挂断中当前适用的动作按钮

音频面板不应展示：

- 假视频框
- 不存在的静音/扬声器切换
- 自定义音频可视化伪状态

### 6.6 页面按钮门禁收口

当前页下方动作区的：

- 视频联系
- 音频联系

除了受 `onlineStatus !== "online"` 影响外，还必须受单活会话影响。

建议按钮可用性收口为：

- 当前无活动会话，且在线 `online` -> 可点
- 当前活动会话就是本 peer -> 由通话面板承担控制，拨号按钮置灰
- 当前活动会话是别的 peer -> 直接置灰

这样比“点了再抛 `busy_local`”更直接，也更符合页面语义。

### 6.7 i18n 与测试必须一次性补齐

本次新增 UI 不是临时调试块，必须补齐：

- 视频面板标题/占位/按钮文案
- 音频面板标题/状态/按钮文案
- 全屏/退出全屏/交换视频文案
- “等待对方画面”“等待连接”等稳定文案

同时测试至少覆盖：

- 当前 peer 视频会话渲染视频面板
- 当前 peer 音频会话渲染音频面板
- notice 跳转目标改为 `/message/:publicKeyHex`
- 其他 peer 活动会话不污染当前页面板
- 呼叫按钮在 `busy_local` 语义下置灰

---

## 7. 明确不能怎么做

### 7.1 不能保留 `/system/webrtc` 和消息页两套主流程 UI

本次是硬切换，不允许：

- `/system/webrtc` 继续对用户可见
- 消息页和工作台页都能完整承载通话
- notice 有时跳旧页，有时跳新页

否则主流程永远收不拢。

### 7.2 不能把视频布局状态写回 service / notice / route

`isLocalPrimary`、`isFullscreen` 都只是页面展示状态。

不能把它们：

- 写进 `webrtc.snapshot()`
- 写进 notice action payload
- 写进 URL query/hash

否则只是 UI 控件，却把业务真值做脏了。

### 7.3 不能为这次 UI 强行扩张 `webrtc.service`

本次不能顺手新增：

- `toggleMute()`
- `toggleCamera()`
- `switchSpeaker()`
- `switchMode(audio|video)`
- `transferCall(...)`

因为这些都不是当前 service 的现成能力，也不是本次问题的最小解。

### 7.4 不能做“当前页 + 全局浮层 + 旧工作台”三套并行控制

接听/拒接/挂断的控制入口可以有多个触发点，但动作真值只能是一套。

因此不能出现：

- notice 一套按钮逻辑
- 会话页一套独立按钮逻辑
- `/system/webrtc` 又一套旧按钮逻辑

所有控制最终都必须走同一个 `webrtc.service` 方法。

### 7.5 不能为了视频页好看，音频页也硬塞两块视频黑屏

这会制造伪状态，误导用户，也让页面代码复杂化。

音频就是音频，视频就是视频，本次必须按 mode 分开渲染。

### 7.6 不能因为 Fullscreen API 有兼容性问题就引入复杂兜底系统

本次全屏是增强能力，不是主业务真值。

不能因此新增：

- 自定义 portal 全屏系统
- 全站级兼容层
- 一堆浏览器分支逻辑

失败就失败，不影响主流程。

---

## 8. 文件级实施清单

以下为实现时必须覆盖的文件级改动点。

### 8.1 `packages/plugin-message/src/MessageDetailPage.tsx`

必须修改：

- 新增对 `webrtc.snapshot()` 的订阅与当前 peer 会话判断
- 在 header 与 composer 之间插入通话面板区
- 新增视频面板与音频面板渲染逻辑
- 新增本地 UI 状态：
  - 交换主次
  - 全屏
- 新增接听 / 拒接 / 挂断入口，全部直连现有 `webrtc.service`
- 收口当前页动作按钮的可用性逻辑，加入单活会话门禁

### 8.2 `packages/plugin-message/src/styles.css`

必须修改：

- 新增会话通话面板样式
- 新增视频大画面、小浮窗、控制条、全屏态样式
- 新增音频控制面板样式
- 保证桌面和移动端都能正常展示

不能把这部分样式写进全局样式文件。

### 8.3 `packages/plugin-message/src/manifest.ts`

必须修改：

- 为新增通话面板文案补 i18n key
- 明确 `/message/:publicKeyHex` 是主承载别名的文案语义

不需要改 message service 能力边界。

### 8.4 `packages/plugin-message/src/MessageDetailPage.test.tsx`

必须修改：

- 扩 fake `WebrtcService.snapshot()` / `subscribe()` 场景
- 覆盖视频通话面板渲染
- 覆盖音频通话面板渲染
- 覆盖别的 peer 活动会话不展示当前页面板
- 覆盖活动会话存在时按钮置灰

### 8.5 `packages/plugin-webrtc/src/webrtcService.ts`

必须修改：

- 来电 notice 的 `routeTo`
- `accept` 动作的 `navigateTo`

统一从 `/messages/${peer}` 收口到 `/message/${peer}`。

不在这里新增新的媒体控制方法。

### 8.6 `packages/plugin-webrtc/src/manifest.ts`

必须修改：

- 停止注册 `WEBRTC_WORKBENCH_PATH`
- 停止注册对应 menu
- 停止注册对应 breadcrumb

保留 `/settings/webrtc` 设置页注册不变。

### 8.7 `packages/plugin-webrtc/src/WebrtcPage.tsx`

本文件的处理原则：

- 可以暂时保留文件
- 但不得再被 route 主流程引用

如果实现时不删除它，不算问题；只要它已经失去用户可达入口即可。

### 8.8 `packages/plugin-webrtc/src/WebrtcPage.test.tsx`

按实现情况处理：

- 如果仍保留 `WebrtcPage` 文件与导出，旧测试可以保留或删减
- 但不能再把它当“主流程验收页”来扩测试

本次主流程测试应转移到 `MessageDetailPage.test.tsx`。

---

## 9. 建议实施顺序

1. 先改 `webrtcService.ts` 的 notice 路由收口，确保来电跳转目标统一。
2. 再改 `plugin-webrtc` manifest，断开 `/system/webrtc` route/menu/breadcrumb 入口。
3. 在 `MessageDetailPage.tsx` 中接入 `webrtc.snapshot()` 订阅与当前 peer 会话判断。
4. 先做音频/视频面板的最小结构，再接 `attachToVideo(...)` 绑流。
5. 最后补 `styles.css`、i18n、测试。

这样可以保证每一步都围绕“主流程收口”推进，而不是先堆样式。

---

## 10. 最终验收清单

### 10.1 路由与入口验收

- `/system/webrtc` 已不再出现在菜单中。
- 直接访问 `/system/webrtc` 不再命中主业务页路由。
- `/settings/webrtc` 仍可正常进入。
- 来电 notice 的点击跳转目标是 `/message/:publicKeyHex`，不是 `/messages/:publicKeyHex`。

### 10.2 会话页通话承载验收

- `MessageDetailPage` 在 header 与 composer 之间能显示通话面板区。
- 当前 peer 没有活动通话时，不显示空壳通话面板。
- 当前 peer 是视频会话时，显示远端大画面、本地小画面。
- 当前 peer 是音频会话时，显示音频控制面板，而不是视频容器。
- 活动会话属于别的 peer 时，当前页不显示其通话面板。

### 10.3 视频交互验收

- 视频面板有“交换视频”按钮，点击后主次画面互换。
- 视频面板有“全屏”按钮。
- 进入全屏后，大画面铺满，小画面浮动显示。
- 全屏状态下仍可执行“交换视频”和“退出全屏”。
- 退出全屏后页面恢复普通布局。

### 10.4 控制动作验收

- 来电状态下，会话页可接听 / 拒接。
- 已接通或连接中时，可挂断。
- 页面底部“视频联系 / 音频联系”在对方非 `online` 时置灰。
- 页面底部“视频联系 / 音频联系”在已有别的活动会话时置灰。
- 所有控制最终都调用现有 `webrtc.service` 方法，没有第二套状态机。

### 10.5 notice 协同验收

- 用户不在会话页时收到来电，notice 正常出现。
- 用户点击 notice 的“接听”后，进入对应 `/message/:publicKeyHex` 页面。
- 进入页面后，能看到与当前会话 mode 匹配的视频或音频面板。
- 用户已经在对应会话页时收到来电，notice 与页面面板都能同步反映当前状态。

### 10.6 硬切换纪律验收

- 没有保留 `/system/webrtc` 与消息页双主流程。
- 没有新增 mute / camera / speaker / 会中模式切换等额外 service 能力。
- 没有把全屏、交换主次等显示状态写进 service / notice / URL。
- 没有新增多会话并发、来电排队、跨刷新恢复。
- 没有把音频通话伪装成视频双画面。

---

## 11. 完成定义

完成本单，意味着系统已经明确进入以下状态：

- WebRTC 主交互从系统工作台退出，回到消息会话上下文。
- notice 的接听动作和会话页承载页收口成一条稳定主链路。
- `MessageDetailPage` 成为文本消息、WebRTC 控制、媒体展示、历史时间线的统一会话页。
- 本次只做最小必要承载，不借机把系统扩成复杂通话客户端。

这才符合当前项目“优先保持系统简单、失败就失败、不要为了补边缘场景把整体复杂化”的原则。
