# 003 appView child ready + show app / popup 两段式硬切换施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- 既有施工单：
  - `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
  - `施工单/2026-06-29/002-plugin-apps-appview-launcher-hard-switch.md`
  - `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md`
- 协议与实现：
  - `packages/contracts/src/protocol.ts`
  - `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
  - `packages/plugin-protocol/src/protocolService.ts`
  - `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
  - `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
  - `packages/plugin-protocol/src/protocolService.test.ts`

发生冲突时：

1. 本单关于 `ready` 的方向对称、`show app -> popup` 两段 UI、命名窗口复用的定义优先。
2. `002-launcher-popup-unified-owner-runtime-hard-switch.md` 关于统一 owner runtime、`connect.launch`、`runtimeBinding` 删除的定义继续有效。
3. 后续若再改 appView 启动握手，必须先改本单、contract、测试，再改实现；不允许只改代码。

---

## 1. 本单定位

本单不是修一个 “Open App 会重复开多个窗口” 的小问题。

本单定义一次硬切换：

- appView 启动期**不新增消息类型**；
- 继续复用现有顶层 `ready`；
- 但方向改成与传统 popup 流对称：
  - 传统 popup：`Session Window -> client web` 发 `ready`
  - appView：`client web -> Session Window` 发 `ready`
- Session Window UI 固定为两段：
  1. `show app`
  2. `popup`
- `show app` 页面保留，不删除，不自动跳过；
- child app 一旦发来合法顶层协议消息，Session Window 就视为 child ready，并立刻进入传统 popup 界面；
- 重复点击 `Open App` 不再用 `_blank` 开无限新窗，而是复用命名窗口：
  - `keymaster-app-<origin编码后>`
- soft timeout 只恢复按钮可点，**不**重建 `connectSessionId`，**不**重发 bootstrap，**不**偷偷补救。

本单目标不是“继续把 Session Window 当一次性跳板页”，而是：

- launcher 完成 bootstrap 后退出职责；
- child app 启动完成后，Session Window 回到真正的传统 popup 职责。

---

## 2. 简述缘由

### 2.1 当前实现把 appView `ready` 做反了

当前 `protocolService.openClientApp()` 会在 `window.open(appUrl, "_blank")` 后主动向 child app 发 `ready`，并在短窗口内重复发送。

这条设计的问题不是“不能工作”，而是抽象错位：

1. `ready` 的自然语义是“被打开的一方，listener 已就绪”。
2. 在传统 popup 流里，这个语义已经成立：
   - client web 打开 Session Window；
   - Session Window listener 就绪后向 opener 发 `ready`。
3. 到 appView 流里，窗口方向反过来了：
   - Session Window 打开 client web；
   - 因此应当由 client web 在 listener 就绪后向 opener(Session Window) 发 `ready`。

也就是说，能力没变，只是方向反了。本单不接受为了 appView 再发明第二个新消息。

### 2.2 当前 `ProtocolPopupPage` 永远停在 app show 页面，进不了传统 popup

当前 `ProtocolPopupPage.tsx` 里只要 `bootMode() === "appView"`，就固定渲染：

- bootstrap 等待页
- bootstrap 完成后的 app show 页
- bootstrap 失败页

它不会落到下面传统 popup 的顶栏 + feed + 授权按钮逻辑。

这与 appView 的正确目标冲突：

- launcher 只负责把窗口和 bootstrap 建起来；
- child app 启动完成后，Session Window 应回到传统 popup。

### 2.3 当前 `_blank` 会把“重试 Open App”变成“多实例混战”

当前 `openClientApp()` 用 `_blank`。

结果是：

1. 第一次点击 `Open App` 开一扇 client 窗口；
2. soft timeout 后再次点击，又开一扇；
3. 哪一扇先发 `ready`、哪一扇先发 `connect.launch`、哪一扇还持有旧页面状态，都会变脏。

这类复杂度不该靠额外恢复逻辑去兜。

更简单的收口是：

- 固定命名窗口；
- 浏览器优先复用同一扇 app 窗口；
- Session Window 只面对一个 child app 方向。

### 2.4 soft timeout 不应重建 `connectSessionId`

用户已明确要求简单，不要为了边缘业务完整把系统做复杂。

因此本单固定：

- “没有及时收到 child 合法消息” 只说明 app 没起来或起来慢了；
- 它**不**等于这次 launcher 预建的 session 已失效；
- soft timeout 不得重建 `connectSessionId`，不得重做 bootstrap，按钮恢复可点即可。

如果用户真的要新 session，那应该回到 launcher 重新发起一次新的 Open App，而不是在同一 show app 页面里偷偷换一套 session 真值。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. appView 仍只复用现有顶层 `ready`，不新增 `app_ready`、`handoff_ack` 一类新指令。
2. child app 在自己的 listener 就绪后，向 `window.opener`（Session Window）发送顶层 `ready`。
3. Session Window 在 appView 下固定为两段 UI：
   - `show app`
   - `popup`
4. bootstrap 未完成时显示 waiting launcher。
5. bootstrap 完成后显示 `show app` 页面。
6. 用户点击 `Open App` 后，按钮进入等待态；若 5 秒内未收到合法 child 协议消息，按钮恢复可点。
7. soft timeout 只恢复按钮可点；不重建 `connectSessionId`，不重建 `launchToken`，不重新 bootstrap。
8. 收到合法 child 协议消息后，Session Window 立即进入传统 popup 界面。
9. 进入 popup 后，不再额外隐藏历史，不再加第三段过渡态。
10. `Open App` 使用命名窗口 `keymaster-app-<origin编码后>`，不再用 `_blank`。
11. 再次点击 `Open App` 时优先复用同一扇 client 窗口，减少重复窗口与迟到消息混乱。
12. appView 下 child ready 的合法性按 `origin + source + 顶层协议消息形状` 校验；不接受任意同源窗口乱发垃圾消息。
13. 传统 connect popup 流仍保持原语义：Session Window 继续向 opener 发 `ready`。
14. `connect.launch`、后续业务 request、统一 owner runtime 逻辑不因本单而分叉成第二套执行模型。
15. `lockStateValue` 的公开语义改成“当前 Session Window 是否已经拥有可执行的 owner runtime”，不再限制为“本地 vault 是否已解锁”。

---

## 4. 单真值定义

### 4.1 `ready` 的统一语义

本次固定：

```txt
哪个窗口是被打开的一方
哪个窗口在自己的 message listener 就绪后
就由它向 window.opener 发送顶层 ready
```

于是得到：

- 传统 popup：
  - opener = client web
  - child = Session Window
  - `Session Window -> client web` 发 `ready`
- appView：
  - opener = Session Window
  - child = client web
  - `client web -> Session Window` 发 `ready`

关键约束：

1. `ready` 仍是顶层协议消息，不带 method。
2. 不新增第二种“只给 appView 用”的 ready 类消息。
3. 不把 `ready` 变成业务态确认；它只表达 listener 就绪。
4. 对 appView 来说，显式 `ready` 只是最直接的 child ready 信号，不是唯一信号。
5. 任何来自合法 child source 的顶层协议消息，只要已足以证明 child listener 在工作，就等价视为 implicit `ready`。

这里的“合法 child 协议消息”最少要满足：

1. `event.origin === appViewContext.appOrigin`
2. `event.source` 已绑定为当前 child source，或可被接纳为首个 child source
3. 消息形状属于现有顶层协议消息，例如：
   - `ready`
   - `request`
   - `cancel`

也就是说：

- 显式 `ready` 可以切 `show app -> popup`
- 首条合法 child 协议消息也可以切 `show app -> popup`
- `ready` 仍保留；只是系统不再要求“必须先看到显式 ready，后续 request 才算 child 已起来”

### 4.2 Session Window UI 两段式

本次固定：

```txt
appView UI
  = show app
  -> popup
```

定义：

- `show app`
  = launcher bootstrap 已成功
  = child app 尚未发来合法 child 协议消息
- `popup`
  = child app 已发来合法 child 协议消息
  = Session Window 回到传统 popup 界面

关键约束：

1. `show app` 页面保留。
2. `popup` 页面就是传统 popup 页面，不再造一份 appView 专属主界面。
3. 不新增 “show app -> waiting request -> popup” 第三段。
4. “收到第一条合法 child 协议消息即切 popup” 是 child ready 的隐式判定，不是新增第三段状态。

### 4.3 `Open App` 重试真值

本次固定：

```txt
show app 页面里的重试
  = 对同一 appUrl / 同一 connectSessionId / 同一 launchToken
    再次尝试打开 / 聚焦 child app 窗口
```

关键约束：

1. soft timeout 后重试不新建 session。
2. soft timeout 后重试不改 launchToken。
3. 真正的新 session 只发生在 launcher 重新发起一次新的 Open App。

### 4.4 client app 命名窗口

本次固定：

```txt
window.open(appUrl, "keymaster-app-<origin编码后>")
```

关键约束：

1. 直接用这个命名字符串作为 `window.open` 的第二参数。
2. 不再使用 `_blank`。
3. 不单独维护一个额外的 `stableWindowName` 状态变量。

### 4.5 `lockStateValue` 真值

本次固定：

```txt
lockStateValue
  = 当前 Session Window 是否已经拥有可执行的 owner runtime
```

含义：

- `locked`
  = 当前 Session Window 没有可执行 owner runtime
- `unlocked`
  = 当前 Session Window 已有可执行 owner runtime

来源允许有两种：

1. `bootstrap_owner`
   = launcher / bootstrap 继承过来的 owner runtime
2. `vault_unlock`
   = 本窗口后续通过本地 vault 解锁得到的 owner runtime

关键约束：

1. 这次硬切换后，`lockStateValue` **不再**专指“本地 vault 是否已解锁”。
2. appView bootstrap 成功并建立可执行 owner runtime 后，Session Window 就应视为 `unlocked`。
3. 不能为了保留“本地 vault locked”这个细节，再让 UI / accept 阶段继续把 request 推进解锁流。

### 4.6 popup 模式下的锁屏接管规则

本次固定：

```txt
appView 进入 popup 后
不能因为底层本地 vault 仍是 locked
就立刻把页面打回全屏锁屏
```

关键约束：

1. child ready 到达后，如果当前没有 auth owner、也没有待处理锁屏请求，页面应先显示传统 popup 主界面。
2. 只有真正出现：
   - `connect.login` auth owner
   - `connect.resume` auth owner
   - `waiting_unlock_*` / 需要锁屏接管的请求
   才允许切到现有 auth / lock 全屏。
3. `lockStateValue` 已经表达“当前 Session Window 是否可执行”，因此 appView popup 阶段不应再额外保留“虽然可执行但 UI 仍视作 locked”的旁路。

---

## 5. 怎么做

### 一、把 child ready 变成 appView 切段信号

需要在 `protocolService` 内部显式维护“child app 是否已 ready”真值。

最少需要：

1. 新增 appView 运行期状态：
   - child ready 是否已收到
   - 当前 `Open App` 按钮是否处于等待态
2. `handleMessage(event)` 在 appView 下先识别合法 child 协议消息：
   - `event.origin === appViewContext.appOrigin`
   - `event.source` 合法
   - 消息形状属于允许接纳的顶层协议消息
3. 合法 child 协议消息命中后：
   - 绑定 / 确认 `currentAppClientSource`
   - 关闭 soft timeout / 停止等待态
   - 切 `childReady = true`
   - 触发 UI 进入 popup
4. 若命中消息本身就是业务消息，例如 `request`，则它在触发 implicit ready 后继续按原协议流程处理，不允许因为“还没显式 ready”被丢弃。

### 二、`ProtocolPopupPage` 只保留 appView 的启动壳，不再长期霸占主界面分支

当前 appView 分支要改成：

1. bootstrap 失败：
   - 渲染失败页
2. bootstrap 未完成：
   - 渲染 waiting launcher
3. bootstrap 已完成且 child 未 ready：
   - 渲染 `show app`
4. child 已 ready：
   - 落回传统 popup 渲染逻辑

也就是说：

- appView 只在启动阶段占用独占页面；
- child ready 后，`ProtocolPopupPage` 必须走传统 popup 分支。

### 三、`show app` 页面保留，但只负责按钮态和说明态

`show app` 页面继续保留。

它只需要承载：

1. `Open App` 按钮
2. 正在等待 child ready 时的 disabled 态
3. 5 秒 soft timeout 后的提示
4. 再次点击重试

明确不做：

1. 不在这里展示传统 popup 命令流
2. 不在这里创建新 session
3. 不在这里偷偷重做 bootstrap

### 四、`openClientApp()` 改成命名窗口复用

实现必须改成：

```txt
window.open(appUrl, "keymaster-app-<origin编码后>")
```

设计要求：

1. 命名直接由 `appOrigin` 计算。
2. 直接写到 `window.open` 的 target 参数里，不新增长期状态变量。
3. 同一 Session Window 下重复点 `Open App`，优先复用同一扇 child 窗口。

### 五、去掉 Session Window -> child app 的 `ready` 泵

当前 `openClientApp()` 打开 child 后立即发 `ready` 并短时间内重复发送。

本单要求删除这条 appView 专属路径。

原因：

1. `ready` 的职责应当由 child app 自己声明；
2. Session Window 不应继续猜测 child listener 是否已就绪；
3. 让 appView 与传统 popup 在抽象上真正对称。

保留：

- 传统 connect popup 下 `Session Window -> opener` 的 `ready`

删除：

- appView 下 `Session Window -> child app` 的 `ready` / ready pump

### 六、soft timeout 只恢复按钮，不做复杂补偿

soft timeout 到点时：

1. 按钮恢复可点
2. 提示用户 app 尚未连接，可再次点击

明确不做：

1. 不新建 `connectSessionId`
2. 不重新生成 `launchToken`
3. 不自动关闭旧 child 窗口
4. 不跨窗口迁移 runtime
5. 不在 Session Window 与 launcher 之间再补任何握手

### 七、popup 模式下恢复传统 popup，但不被默认 locked 态立即打回锁屏

appView child ready 后：

1. 先进入 popup 模式
2. 由于 bootstrap owner runtime 已经在当前 Session Window 内成立，此时 `lockStateValue` 应视为 `unlocked`
3. 若当前无 auth owner、无待处理锁屏请求，则显示传统 popup 主界面
4. 后续真的来了 `connect.launch` / `connect.resume` / 其它 request，按普通 unlocked popup 规则推进：
   - manual -> `confirming`
   - auto -> `queued`

这样才符合“show app / popup 两段式”，而不是 child 已经可证明在线、却又因为保留旧 `lockState` 语义被重新打进解锁流。

---

## 6. 不能怎么做

1. 不能新增 `app_ready`、`child_ready_ack`、`launch_handoff_done` 一类新顶层消息。

2. 不能保留 `Session Window -> child app` 的 ready 泵，同时又再收 child ready，做成双向握手。

3. 不能把 appView 切 popup 的信号只绑到显式 `ready`，导致合法 child 业务消息已经到达却仍卡在 `show app`。

4. 不能把 `show app` 页面删掉，直接点 `Open App` 后自动切 popup。

5. 不能继续用 `_blank`，把每次点击都变成新窗口。

6. 不能在 soft timeout 后偷偷重建 `connectSessionId`。

7. 不能继续把 `lockStateValue` 只解释成“本地 vault 是否解锁”，导致 appView 明明已继承可执行 runtime，request 仍被送进 `waiting_unlock_*`。

8. 不能为了让 UI 看起来简单，把 appView 再做成第二套独立 popup service 或第二套 request/feed 模型。

---

## 7. 特殊情况怎么办

### 7.1 用户重复点击 `Open App`

处理原则：

1. 使用同一个命名窗口 target。
2. 浏览器可复用同一扇 child 窗口。
3. Session Window 不新建 session，不新建 launchToken。
4. 谁先发来合法 child 协议消息，由当前合法 child source 规则决定。

### 7.2 第一次点击后 child app 很慢，5 秒内没任何合法消息

处理原则：

1. 这是 soft timeout，不是启动失败。
2. 按钮恢复可点。
3. 迟到的合法 child 协议消息仍然接受。
4. 不重建 session。

### 7.3 child app 迟到发来消息

处理原则：

1. 只要当前 bootstrap / appViewContext 仍有效，且 `origin + source + 顶层协议消息形状` 合法，就接受。
2. 一旦接受，立即进入 popup。
3. 同时清掉 soft timeout 提示。

### 7.4 `openClientApp()` 没拿到 window 句柄

处理原则：

1. 视为打开失败。
2. `show app` 页展示错误。
3. 用户可再次点击。
4. 不新建 session。

### 7.5 child 消息来自错误窗口

处理原则：

1. `origin` 不匹配，直接忽略。
2. 若已有绑定 `currentAppClientSource`，而 `source` 不匹配，直接忽略。
3. 不因错误窗口消息污染当前 appView 会话。

---

## 8. 验收标准

### 8.1 服务端协议与状态

1. appView 不新增任何新顶层消息类型。
2. `ready` 语义在传统 popup 与 appView 中保持方向对称。
3. appView runtime 有明确 child ready 真值，并且该真值可由显式 `ready` 或首条合法 child 协议消息触发。
4. `lockStateValue` 真值已经从“本地 vault 是否解锁”收口为“当前 Session Window 是否拥有可执行 owner runtime”。

### 8.2 Session Window UI

1. bootstrap 未完成时显示 waiting launcher。
2. bootstrap 完成后显示 `show app` 页面。
3. 点击 `Open App` 后按钮 disabled。
4. soft timeout 后按钮恢复可点。
5. 收到合法 child 协议消息后，页面切到传统 popup。
6. 切到 popup 后不再停留在 `show app` 页面。
7. appView popup 阶段的普通业务 request 不再被错误送进解锁 UI。

### 8.3 窗口复用

1. 重复点击 `Open App` 不再每次开一扇新窗口。
2. `window.open` 的 target 使用 `keymaster-app-<origin编码后>`。
3. 代码里不新增长期维护的 `stableWindowName` 状态变量。

### 8.4 回归

1. 传统 connect popup 流的 `ready` 语义不被破坏。
2. `connect.launch`、统一 owner runtime、命令流、历史、授权按钮继续走同一套 popup 逻辑。
3. 现有 appView bootstrap 失败态仍可 fail-closed。

---

## 9. 给实施者的短说明

本单这次修正的关键不是再补一个 appView 特判，而是**改真值**：

- `lockStateValue` 现在表示“当前 Session Window 是否已经拥有可执行的 owner runtime”
- 不再表示“本地 vault 是否已解锁”

因此实施时请按下面的方向收口：

1. appView bootstrap 成功后，当前窗口应视为 `unlocked`
2. 不要继续保留“UI 看起来 unlocked，但 accept 阶段仍按 locked 推 `waiting_unlock_*`”的夹生状态
3. 尽量删掉 appView popup 阶段为旧 `lockState` 语义打的补丁，改成统一走普通 unlocked popup 路径

一句话：这次要的是**统一真值**，不是再加一层旁路。

下次检查实现时，要再次提醒实施者：不要把 child ready 收窄成“只认显式 `ready`”，必须按本单定义实现成“显式 `ready` 或首条合法 child 协议消息都算 ready”。
