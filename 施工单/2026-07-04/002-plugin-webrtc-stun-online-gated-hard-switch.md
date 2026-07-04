# 002 `plugin-webrtc` 基于 `appmsg` 信令、在线前置门禁、STUN-only 音视频通话的职责硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/settings.ts`
- `packages/runtime/src/registries/settingsRegistry.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/appmsgService.ts`
- `packages/plugin-appmsg/src/AppMsgPage.tsx`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-woc/src/manifest.ts`
- `packages/plugin-woc/src/pages/WocSettingsPage.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`
- `施工单/2026-07-04/001-appmsg-provider-split-and-thin-message-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“`plugin-webrtc` 是极薄业务插件，`plugin-appmsg` 只提供信令通道，不承担通话状态机”的定义优先。
2. 旧设计里凡是把“离线也先拨号、等对方以后上线补处理”“通话状态跨页面恢复”“自动静默降级视频到音频”的想法，本次全部失效。
3. 本次不保留兼容层、不保留双路实现、不做“先文字消息伪装，后续再改真正通话状态机”的过渡方案。

---

## 1. 文档定位

这不是一次“加个 WebRTC 页面”的小功能，而是一次**新业务插件边界定义 + 信令协议落地 + 运行约束硬切换**。

本次要解决的是下面几个根问题：

- 如何在当前 `appmsg` 架构下，新增一个**不扩张平台复杂度**的实时通话插件
- 如何把“是否在线”收口成**拨号前门禁**，而不是让离线拨号把系统拖进长尾状态
- 如何只做 `STUN`、明确不做 `TURN`，同时把失败边界讲清楚
- 如何把“视频/音频能力协商”做成**最小状态机**，而不是做成一套复杂会话恢复系统

所以这次必须一次性硬切换到下面的最终形态：

- 新建 `plugin-webrtc`
- 它通过 `plugin-appmsg` 的 endpoint service 交换信令
- 拨号前必须先做 online API 检查
- online 不是 `online` 就不拨号
- 通话只做实时会话，不做离线补偿
- 只支持 `STUN`，明确不支持 `TURN`
- 设置页采用多 STUN 地址、`blur` 自动保存、批量测试

---

## 2. 简述缘由

### 2.1 `appmsg` 适合做信令，不适合吞下通话状态机

当前 `appmsg` 已经提供了：

- 固定 endpoint 的稳定 service
- 本地消息持久化
- 实时消息推送
- `checkOnline(...)`

这正适合做 WebRTC 信令交换。

但 `appmsg` 不应该继续向上膨胀成：

- 通话状态机中心
- 媒体设备管理中心
- `RTCPeerConnection` 生命周期中心

这些都应该留在业务插件 `plugin-webrtc` 内部。

### 2.2 “离线也拨一下”会显著放大复杂度

如果允许离线拨号，后面就会自然长出一串复杂度：

- 来电补投递
- 过期邀请清理
- 页面重开恢复
- 已离线邀请的 UI 消歧
- 历史候选 ICE 的去重与超时

这和项目当前“系统简单优先、边缘失败宁可失败”的原则相反。

所以本次固定策略：

- 先查 online
- 不是 `online` 就不拨号
- 不为离线对端维护任何“等他以后上线”的业务尾巴

### 2.3 `STUN-only` 是刻意接受成功率边界，不是漏做

只做 `STUN`，不做 `TURN`，代表系统明确接受：

- 一部分 NAT 组合下无法打通
- 失败时直接失败，不为业务成功率引入中继复杂度

这不是实现缺陷，而是架构取舍。

### 2.4 视频降级必须显式提示，不能静默偷偷改模式

如果发起者选了视频，对方没有视频能力：

- 不能静默改成音频继续
- 必须明确告诉发起者：对方没有视频能力，可以改用音频

如果连音频都没有：

- 必须直接告诉发起者：对方无法进行最低限度的音频聊天

这样用户理解清楚，状态机也保持简单。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. 新增独立插件 `@keymaster/plugin-webrtc`。
2. `plugin-webrtc` 声明固定 `appMessageEndpoint.endpointId = "keymaster.webrtc"`。
3. `plugin-webrtc` 通过 `appmsg.endpoint.registry` 获取稳定长寿 `AppMsgEndpointService`。
4. `plugin-webrtc` 提供系统工作台页面 `/system/webrtc`。
5. `plugin-webrtc` 提供设置页面 `/settings/webrtc`。
6. 拨号前必须调用 `endpointService.checkOnline([targetPublicKeyHex])`。
7. 只有在线结果为 `online` 才允许发起拨号。
8. 在线结果为 `offline` 或 `unknown` 时，前端直接阻断拨号，不发任何邀请信令。
9. 通话模式只允许用户手工选择：
   - 音频聊天
   - 视频聊天
10. 如果发起视频邀请，对方无视频能力但有音频能力，对方必须回送“建议改用音频”的信令，发起方明确提示后再由用户重新发起音频呼叫。
11. 如果对方连音频能力都没有，对方必须回送“无法进行最低限度音频聊天”的拒绝信令。
12. 通话只做实时会话，不做离线来电、不做页面重开恢复、不做历史会话恢复。
13. 设置页支持多个 STUN server 地址。
14. 设置页不使用 Save 按钮，字段 `blur` 后自动保存。
15. 设置页提供“批量测试全部 STUN”按钮。
16. STUN 测试只验证本地 ICE gather 可用性，不宣称“任意网络环境都能通话成功”。
17. 本次不引入 `TURN` 配置、不引入 relay-only 选项、不引入中继账号配置。

---

## 4. 单真值与职责边界

### 4.1 `plugin-webrtc` 的边界

`plugin-webrtc` 只负责：

- WebRTC 信令协议
- 通话状态机
- 本地媒体设备申请
- `RTCPeerConnection` 生命周期
- `/system/webrtc` 页面
- `/settings/webrtc` 页面
- STUN 配置与自检

它不负责：

- provider 选择
- online API 实现
- owner / provider 生命周期
- 全局消息系统连接管理
- 离线消息补偿

### 4.2 `plugin-appmsg` 的边界

`plugin-appmsg` 在本次只提供：

- 稳定 endpoint service
- online API
- 消息收发与本地持久化

它不负责：

- 识别 SDP 结构
- 解释 ICE candidate 业务含义
- 维护通话状态
- 帮业务做降级决策

### 4.3 页面边界

本次固定：

- `/system/webrtc` = 通话工作台
- `/settings/webrtc` = STUN 设置页

不新增：

- `/webrtc`
- `/messages` 下子页
- 独立的来电历史页
- 独立的通话记录页

原因很简单：这是系统工具型业务，不是首页级主业务入口。

### 4.4 配置边界

WebRTC STUN 配置是**浏览器网络配置**，不是 key-scoped 业务配置。

所以本次固定为：

- 全局配置
- 存 `localStorage`
- 不跟随 active key 切换
- 不进 keyspace storage

---

## 5. 必须怎么做

### 5.1 新建 `plugin-webrtc` 包

必须新增：

- `packages/plugin-webrtc/package.json`
- `packages/plugin-webrtc/tsconfig.json`
- `packages/plugin-webrtc/src/index.ts`
- `packages/plugin-webrtc/src/manifest.ts`
- `packages/plugin-webrtc/src/styles.css`

并在装配层显式接入：

- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`

### 5.2 固定 endpoint 与 service 接入方式

`plugin-webrtc` 必须仿照 `plugin-message`：

- 在 manifest 上声明 `appMessageEndpoint.endpointId = "keymaster.webrtc"`
- 在 `setup(ctx)` 里通过 `appmsg.endpoint.registry` 获取 endpoint service
- 自己封装 `webrtc.service`
- 在 teardown 时调用 `releaseEndpoint(...)`

不能：

- 直接读 `appmsg.core`
- 直接订阅 `subscribeUnfilteredMessages`
- 在业务页里自己拼 provider handle

### 5.3 固定信令协议形状

本次信令统一走：

- `contentType = "text/plain"`
- `body = JSON.stringify(signalEnvelope)`

最小信令集合固定为：

- `invite`
- `answer`
- `ice`
- `reject`
- `busy`
- `hangup`
- `fallback_required`

每条信令必须至少带：

- `schema = "keymaster.webrtc.v1"`
- `type`
- `sessionId`
- `createdAtMs`
- `expiresAtMs`

按需再带：

- `mode = "audio" | "video"`
- `reason`
- `sdp`
- `candidate`

这样做的原因：

- 不扩张 `appmsg` contentType 契约
- 历史消息可按 `schema` 过滤
- 过期消息可以 fail-closed 丢弃

### 5.4 online API 必须前置为拨号门禁

拨号流程固定为：

1. 校验目标 `publicKeyHex` 形状
2. 调用 `checkOnline([target])`
3. 只有返回 `online` 才继续
4. `offline` 或 `unknown` 时直接终止
5. 不创建本地会话、不申请媒体、不发邀请

必须这样做，因为你已经明确要求：

- 不在线就根本不拨号

这里要进一步钉死一个边界：

- `unknown` 也视为不可拨号

原因：

- 当前 online API 的 `unknown` 语义本身就是“无法证明对方在线”
- 如果 `unknown` 还继续拨号，那就把“在线前置门禁”自己拆掉了

### 5.5 单活会话

本次固定整个 `plugin-webrtc` 只允许一个活动会话：

- 正在拨号中
- 响铃中
- 已接通
- 挂断清理中

都算“占用会话槽位”。

新来电或新拨号在槽位占用时必须 fail-closed：

- 来电回 `busy`
- 本地二次拨号直接报错并提示当前已有会话

不能一开始就做多通会话、排队接听、多窗口共享会话。

### 5.6 模式协商固定为显式拒绝 / 显式建议降级

发起方本地可选：

- 音频
- 视频

接收方处理规则固定如下：

1. 收到音频邀请：
   - 能拿到音频设备 -> 允许接听
   - 不能拿到音频设备 -> 回 `reject(audio_unavailable)`

2. 收到视频邀请：
   - 能拿到音频和视频 -> 允许接听
   - 没有视频但有音频 -> 回 `fallback_required(video_unavailable)`
   - 连音频都没有 -> 回 `reject(audio_unavailable)`

发起方收到 `fallback_required(video_unavailable)` 后：

- 结束当前会话
- 向用户明确提示“对方没有视频能力，可以改用音频聊天”
- 只有用户再次明确点击“音频聊天”时，才新建一通新的音频会话

不能：

- 在原会话上自动改 SDP 重谈
- 静默偷偷变成音频继续
- 帮用户自动重拨

### 5.7 设备能力以实际采集结果为准

本次不维护“静态能力表”“上线时公告支持视频/音频”。

设备能力统一以当次 `getUserMedia(...)` 结果为准：

- 音频邀请：测试 `audio: true`
- 视频邀请：测试 `audio: true, video: true`

原因：

- 最简单
- 最接近真实可用能力
- 不需要做额外的能力缓存与同步

### 5.8 STUN 配置页采用即时保存

设置页交互固定为：

- 每一行一个 STUN 地址输入框
- 可新增、可删除
- 输入时只更新本地编辑态
- `blur` 或显式删除动作时落库
- 无 Save 按钮
- 提交失败回滚到上次已保存真值

这一点应直接借鉴 `OriginSettingsTray` 的模式：

- 本地字符串编辑态
- `blur` 提交
- 提交失败回滚
- 不做保存队列

### 5.9 STUN 批量测试必须是“本地 ICE gather 自检”

测试按钮的真实定义固定为：

- 对当前所有 STUN 地址逐个发起临时 `RTCPeerConnection`
- 写入对应 `iceServers`
- 触发 gather
- 在超时前观察是否拿到可用 candidate 或错误回调

每个地址输出结果固定为：

- `ok`
- `timeout`
- `error`

页面文案必须明确：

- 这只是 STUN 可用性自检
- 不代表任意两端网络都一定能建立通话

---

## 6. 不能怎么做

### 6.1 不能绕过 online API 直接拨号

不能做：

- 用户点“视频聊天”就直接发 `invite`
- online 失败后再“碰碰运气继续拨”
- `unknown` 当作“可能在线”继续走

本次规则就是：

- 非 `online` 不拨号

### 6.2 不能把离线邀请当成未来可恢复任务

不能做：

- 给离线用户发一条 `invite` 等他上线后再处理
- 在本地保留 pending 邀请等 provider 补同步
- 给 UI 做“对方以后也许会收到”的承诺

原因：

- 这会立刻把系统拖进补偿与过期清理复杂度

### 6.3 不能把 WebRTC 状态机塞进 `plugin-appmsg`

不能新增：

- `appmsg.call.*`
- `appmsg.webrtc.*`
- `appmsg` 平台级通话状态缓存

本次必须保持：

- `appmsg` 只做信令收发
- `webrtc` 自己解释信令

### 6.4 不能一开始就支持 TURN

不能：

- 在设置页预留 TURN username/password
- 在 service 里偷偷接受 `turn:` 配置
- 在测试逻辑里混入 relay 判定

本次明确就是 `STUN-only`。

### 6.5 不能把媒体流或会话记录持久化

不能：

- 把 `MediaStream`、SDP 解析状态、ICE 累积状态落库
- 支持刷新页面后恢复通话
- 维护“最近通话记录”作为业务真值

本次通话是内存态，页面丢了就丢了。

### 6.6 不能默认自动降级

不能：

- 视频失败后自动转音频继续
- 本地音频申请失败时自动改成“只看视频”
- 对方无视频时不提示直接改音频

所有模式变化都必须可见、显式、由用户重新发起。

---

## 7. 特殊情况与处理策略

### 7.1 online API 返回 `offline`

处理：

- 页面提示“对方当前不在线，无法拨号”
- 不申请媒体
- 不创建 peer connection
- 不发信令

### 7.2 online API 返回 `unknown`

处理：

- 页面提示“当前无法确认对方在线状态，已阻止拨号”
- 不继续后续流程

说明：

- `unknown` 不是“弱 online”
- 本次按 fail-closed 处理

### 7.3 本地没有活动 provider / endpoint service 未就绪

处理：

- 页面显示“webrtc service not ready”
- 拨号和接听按钮禁用
- 不尝试 `getUserMedia`

### 7.4 来电时本地已有会话

处理：

- 立即回 `busy`
- 当前本地页面维持原会话
- 不弹第二套会话 UI

### 7.5 收到过期信令

处理：

- 直接丢弃
- 不回包
- 记调试日志即可

### 7.6 收到未知 `sessionId` 的 `answer` / `ice` / `hangup`

处理：

- 直接丢弃
- 不为其新建会话

原因：

- 只允许 `invite` 开新会话
- 其它信令必须附着在已存在会话上

### 7.7 `getUserMedia` 失败

处理：

- 发起侧：本地提示失败，不发起邀请
- 接收侧：
  - 音频失败 -> `reject(audio_unavailable)`
  - 视频失败但音频可用 -> `fallback_required(video_unavailable)`
  - 音频也失败 -> `reject(audio_unavailable)`

### 7.8 STUN gather 失败或超时

处理：

- 只影响设置页测试结果
- 不自动改配置
- 不自动删除 server

如果用户仍坚持使用这组 STUN：

- 通话时继续按配置尝试
- 失败就失败，不额外加重试系统

### 7.9 通话建立后 ICE 断开

处理：

- 页面显示已断开
- 释放当前会话资源
- 不自动重拨
- 用户需要时手工重新拨号

### 7.10 页面卸载 / 插件被 disable

处理：

- 停止本地 tracks
- 关闭 `RTCPeerConnection`
- 清空内存态会话
- 释放 endpoint service

---

## 8. 信令协议最终定义

### 8.1 envelope 公共形状

```ts
interface WebrtcSignalEnvelope {
  schema: "keymaster.webrtc.v1";
  type:
    | "invite"
    | "answer"
    | "ice"
    | "reject"
    | "busy"
    | "hangup"
    | "fallback_required";
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
}
```

### 8.2 `invite`

```ts
interface WebrtcInviteSignal extends WebrtcSignalEnvelope {
  type: "invite";
  mode: "audio" | "video";
  sdp: string;
}
```

### 8.3 `answer`

```ts
interface WebrtcAnswerSignal extends WebrtcSignalEnvelope {
  type: "answer";
  mode: "audio" | "video";
  sdp: string;
}
```

### 8.4 `ice`

```ts
interface WebrtcIceSignal extends WebrtcSignalEnvelope {
  type: "ice";
  candidate: RTCIceCandidateInit;
}
```

### 8.5 `reject`

```ts
interface WebrtcRejectSignal extends WebrtcSignalEnvelope {
  type: "reject";
  reason: "audio_unavailable" | "declined" | "expired" | "invalid_state";
}
```

### 8.6 `busy`

```ts
interface WebrtcBusySignal extends WebrtcSignalEnvelope {
  type: "busy";
  reason: "busy";
}
```

### 8.7 `fallback_required`

```ts
interface WebrtcFallbackRequiredSignal extends WebrtcSignalEnvelope {
  type: "fallback_required";
  reason: "video_unavailable";
  suggestedMode: "audio";
}
```

### 8.8 `hangup`

```ts
interface WebrtcHangupSignal extends WebrtcSignalEnvelope {
  type: "hangup";
  reason: "hangup" | "ice_disconnected" | "page_unload";
}
```

---

## 9. 文件级实施清单

### 9.1 新增 `packages/plugin-webrtc/package.json`

职责：

- 定义新插件包
- 导出 `src/index.ts`
- 导出 `./styles.css`

依赖：

- `@keymaster/contracts`
- `@keymaster/runtime`
- `@keymaster/ui`

### 9.2 新增 `packages/plugin-webrtc/tsconfig.json`

职责：

- 对齐现有插件 TS 编译配置

### 9.3 新增 `packages/plugin-webrtc/src/index.ts`

职责：

- 导出 manifest
- 导出页面组件
- 导出 service / config / 类型

### 9.4 新增 `packages/plugin-webrtc/src/manifest.ts`

职责：

- 定义插件 id：`webrtc`
- 声明 `appMessageEndpoint.endpointId = "keymaster.webrtc"`
- 注册 `/system/webrtc`
- 注册 `/settings/webrtc`
- 注册菜单 / settings / breadcrumb
- 在 `setup` 中创建 `webrtc.service`
- 在 teardown 里释放 endpoint

依赖至少包括：

- `appmsg.endpoint.registry`
- `settings.registry`
- `route.registry`
- `menu.registry`
- `breadcrumb.registry`

### 9.5 新增 `packages/plugin-webrtc/src/webrtcConfig.ts`

职责：

- 定义配置结构
- 读写 `localStorage`
- 校验 STUN URL
- 提供订阅能力

固定配置结构建议：

```ts
interface WebrtcConfig {
  stunServers: string[];
}
```

默认值建议：

```ts
["stun:stun.l.google.com:19302"]
```

### 9.6 新增 `packages/plugin-webrtc/src/webrtcSignal.ts`

职责：

- 定义信令类型
- `parseSignalBody(...)`
- `serializeSignal(...)`
- 校验 `schema/type/sessionId/expiresAtMs`

失败语义：

- 非法消息直接返回错误结果或 `null`
- 不抛到 React 页面层

### 9.7 新增 `packages/plugin-webrtc/src/webrtcService.ts`

职责：

- 封装单活会话状态机
- 收发 `appmsg` 信令
- 前置 online 检查
- 申请本地媒体
- 建立 / 关闭 `RTCPeerConnection`
- 向页面暴露订阅式快照

建议公开最小接口：

- `snapshot()`
- `subscribe(...)`
- `startCall(input)`
- `acceptIncoming()`
- `rejectIncoming()`
- `hangup()`
- `runStunDiagnostics()`

### 9.8 新增 `packages/plugin-webrtc/src/WebrtcPage.tsx`

职责：

- 输入对方 `publicKeyHex`
- 提供“音频聊天”“视频聊天”按钮
- 展示在线门禁失败提示
- 展示来电卡片
- 展示当前会话状态
- 绑定本地 / 远端媒体元素
- 提供挂断按钮

不展示：

- 历史消息列表
- 未接来电列表
- 全局 provider 状态

### 9.9 新增 `packages/plugin-webrtc/src/WebrtcSettingsPage.tsx`

职责：

- 管理多条 STUN 地址
- `blur` 自动保存
- 显示保存错误
- 删除某一行
- 新增空白行
- 一键测试全部 STUN
- 展示每条结果 `ok / timeout / error`

### 9.10 新增 `packages/plugin-webrtc/src/styles.css`

职责：

- 页面与设置页样式
- 本地 / 远端视频区域
- 来电卡片
- 状态提示

### 9.11 新增测试文件

至少新增：

- `packages/plugin-webrtc/src/webrtcSignal.test.ts`
- `packages/plugin-webrtc/src/webrtcConfig.test.ts`
- `packages/plugin-webrtc/src/webrtcService.test.ts`
- `packages/plugin-webrtc/src/WebrtcSettingsPage.test.tsx`

如页面已较重，可再补：

- `packages/plugin-webrtc/src/WebrtcPage.test.tsx`

### 9.12 修改 `apps/web/src/bootstrapPlugins.ts`

职责：

- import `webrtcPlugin`
- 把它加入装配顺序

顺序要求：

- 必须在 `appmsgPlatformPlugin` 之后
- 必须在 `settingsPlugin` 之后并不是强依赖，但放在 `messagePlatformPlugin` 后附近更清晰

推荐顺序：

- `appmsgPlatformPlugin`
- `hubmsgPlatformPlugin`
- `protocolPlugin`
- `messagePlatformPlugin`
- `webrtcPlugin`

### 9.13 修改 `apps/web/src/styles/plugins.css`

职责：

- 显式 `@import "@keymaster/plugin-webrtc/styles.css";`

### 9.14 视情况修改根 `package.json` / workspace 编排

职责：

- 确保 workspace 能识别新包

如果当前 monorepo 通过 `packages/*` 自动拾取，则无需额外改动。

---

## 10. 测试与验证要求

### 10.1 单元测试

必须覆盖：

1. 信令序列化与反序列化
2. 过期信令丢弃
3. 非法信令丢弃
4. online 结果为 `offline` 时不发起拨号
5. online 结果为 `unknown` 时不发起拨号
6. 视频邀请收到“仅音频可用”时产生 `fallback_required(video_unavailable)`
7. 音频不可用时产生 `reject(audio_unavailable)`
8. STUN 配置 `blur` 自动保存
9. STUN 非法地址回滚
10. STUN 批量测试结果映射

### 10.2 联调验证

至少验证以下场景：

1. 双端都在线，音频通话建立成功
2. 双端都在线，视频通话建立成功
3. 对方离线，发起侧被门禁阻断
4. online API 返回 `unknown`，发起侧被门禁阻断
5. 发起视频，对方无视频能力，发起侧收到“改用音频”提示
6. 对方无音频能力，发起侧收到“无法进行最低限度音频聊天”提示
7. 通话中手工挂断，双方都正确释放资源
8. 会话占用时新来电返回 `busy`
9. 设置页修改 STUN 后立即生效
10. 批量测试按钮可对全部 STUN 地址输出状态

---

## 11. 最终验收清单

以下清单全部满足，才算本单完成：

1. 仓库中存在完整新包 `packages/plugin-webrtc/`。
2. `plugin-webrtc` 已被 `apps/web/src/bootstrapPlugins.ts` 正式装配。
3. `apps/web/src/styles/plugins.css` 已显式引入 `plugin-webrtc` 样式。
4. 系统中可访问 `/system/webrtc` 页面。
5. 系统中可访问 `/settings/webrtc` 页面。
6. `/system/webrtc` 可输入对方 `publicKeyHex` 并手工选择音频或视频聊天。
7. 发起拨号前一定会做 online API 检查。
8. online 结果不是 `online` 时，不会发出任何邀请信令。
9. 发起视频时，对方无视频能力会明确提示发起者改用音频。
10. 对方无音频能力时，会明确提示无法进行最低限度音频聊天。
11. 当前实现只支持 `STUN`，设置页没有 `TURN` 相关字段。
12. 设置页支持多条 STUN 地址。
13. 设置页无 Save 按钮。
14. 设置页在字段失焦后自动保存。
15. 设置页“测试全部 STUN”按钮能给出逐条结果。
16. 通话状态机是单活的，不支持并发多通会话。
17. 页面刷新、插件 disable、会话挂断时都会释放媒体流与 peer connection。
18. 不存在离线补偿、来电恢复、历史通话恢复之类额外复杂机制。
19. 新增测试覆盖本单定义的核心边界。
20. 所有与本单冲突的旧实验性实现都没有被保留为隐性旁路。

---

## 12. 本次明确不做

本次明确不做以下内容，后续若要支持，必须另开施工单：

- `TURN` / relay
- 多人通话
- 多并发会话
- 通话记录
- 未接来电列表
- 页面刷新后恢复通话
- 离线邀请补偿
- 通话中文字聊天 / data channel
- 录音录像
- 屏幕共享
- 后台通知 / 系统通知集成

这份边界必须在实现期严格遵守，不能边做边偷长功能面。
