# 004 appView launch sessionWindowOrigin 显式注入硬切换施工单

## 参考文档与现状代码

本次施工、联调、验收以下文档与代码为准：

- 既有施工单：
  - `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
  - `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md`
  - `施工单/2026-06-30/003-appview-child-ready-showapp-popup-two-stage-hard-switch.md`
- 协议与实现：
  - `packages/contracts/src/protocol.ts`
  - `packages/plugin-protocol/src/protocolService.ts`
  - `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
- 下游 client：
  - `/home/david/Workspaces/KeymasterConnectNotesDemo`
  - `/home/david/Workspaces/KeymasterConnectDemo`

发生冲突时：

1. 本单关于 appView launch origin 真值来源的定义优先。
2. `003` 关于 child `ready`、`show app -> popup` 两段式、首条合法 child 协议消息等定义继续有效。
3. 后续若再改 appView launch 握手，必须先改本单与下游施工单，再改实现。

---

## 1. 本单定位

本单不是修一个 “demo 默认写死 `https://keymaster.cc`” 的小问题。

本单定义的是 appView 启动期一条新的单真值：

- popup / direct 模式继续使用用户输入的 `targetOrigin`
- appView / launch 模式**不再**使用这个 `targetOrigin`
- appView / launch 模式的 transport target origin 改成：
  - `sessionWindowOrigin`
  - 来源 = Session Window 在 `openClientApp()` 时显式注入给 child app

本单目标不是再给 child app 增加一套“猜 opener 在哪”的恢复逻辑，而是把 launch 真值直接写清楚。

---

## 2. 简述缘由

### 2.1 现在 launch 错把 popup 的 `targetOrigin` 当成自己的真值

当前下游 client demo / app 的 appView 启动链路里：

1. `adoptOpener()` 用 `targetOrigin`
2. `postReadyToOpener()` 用 `targetOrigin`
3. `connect.launch` 的 transport 也用 `targetOrigin`

但这个 `targetOrigin` 原本是：

- 用户手输 / UI 默认值
- 面向 direct popup 模式的“我要连哪个 Keymaster”

它不是：

- “实际打开我的那扇 Session Window 当前在哪个 origin”

这两个概念混在一起，dev / staging / 自托管都会错。

### 2.2 `postMessage` 永远是 “发给某扇窗 + 用 origin 校验”

需要明确：

```txt
targetWindow.postMessage(message, targetOrigin)
```

其中：

- `targetWindow`
  = 发给哪扇具体窗口
- `targetOrigin`
  = 只有这扇窗口当前页面 origin 等于该值时，浏览器才投递

因此 launch 下可以取消“用户输入 targetOrigin”，但不能取消“发送层 origin 真值”。

### 2.3 child app 不能可靠自猜 opener origin

下游 child app 不能把这件事做成：

- 读 `window.opener.location.origin`
- 读 `document.referrer`
- 或直接 `postMessage(..., "*")`

原因分别是：

1. `window.opener.location.origin`
   - 跨 origin 下不可靠
2. `document.referrer`
   - 受 referrer policy / 浏览器差异影响
3. `*`
   - 会把带 `launchToken` 的协议消息边界做脏

更简单的收口是：

- Session Window 知道自己的 `window.location.origin`
- 那就由它在打开 child app 时显式传进去

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. popup / direct 模式继续使用原有 `targetOrigin`。
2. appView / launch 模式不再读取下游页面里的默认 `targetOrigin`。
3. Session Window 在 `openClientApp()` 时，把自己的 `window.location.origin` 显式带给 child app。
4. 这份值命名固定为：
   - `sessionWindowOrigin`
5. child app 在 appView 模式下：
   - `adoptOpener()`
   - `postReadyToOpener()`
   - `connect.launch`
   - 后续协议 request transport
   都统一使用 `sessionWindowOrigin`。
6. 若 URL 带 `launchToken` 但缺少合法 `sessionWindowOrigin`，appView 启动直接 fail-closed。
7. 不回退到默认 `https://keymaster.cc`
8. 不回退到当前页面手工输入的 `targetOrigin`
9. 不新增新的顶层协议消息
10. `003` 定义的 child `ready` / popup 切段 / owner runtime 真值不被破坏。

---

## 4. 单真值定义

### 4.1 两种 origin 真值

本次固定：

```txt
popup/direct mode
  -> targetOrigin

appView/launch mode
  -> sessionWindowOrigin
```

定义：

- `targetOrigin`
  = 用户输入 / UI 默认 / 本地 session 绑定的 popup 目标 origin
- `sessionWindowOrigin`
  = 实际打开 child app 的 Session Window 当前 `window.location.origin`

关键约束：

1. 这两者不能混用。
2. launch 模式不能再吃 `targetOrigin`。
3. popup/direct 模式也不需要引入 `sessionWindowOrigin`。

### 4.2 `sessionWindowOrigin` 的来源

本次固定：

```txt
sessionWindowOrigin
  = Session Window 在 openClientApp() 时
    显式注入给 child app 的 URL.origin
```

关键约束：

1. 这里的值必须是完整 `origin`
   - 即 `scheme + host + port`
2. 不能只传 `domain:port`
3. 不能省略 scheme

### 4.3 appView 启动失败边界

本次固定：

```txt
launchToken 存在
但 sessionWindowOrigin 缺失 / 非法
  => appView fail-closed
```

关键约束：

1. 不 fallback 到默认值
2. 不 fallback 到手工输入的 `targetOrigin`
3. 不猜 opener origin

---

## 5. 怎么做

### 一、在 Session Window 打开 child app 时显式注入 `sessionWindowOrigin`

`openClientApp()` 要负责：

1. 基于当前 `appUrl` 组装新的 child URL
2. 继续保留现有 `launchToken`
3. 额外附加：
   - `sessionWindowOrigin=<window.location.origin>`

关键约束：

1. 由 Session Window 自己写入
2. 下游不自行计算

### 二、下游 child app 在 appView 模式下只认 `sessionWindowOrigin`

当下游页面检测到 `launchToken` 时：

1. 进入 appView / launch 模式
2. 读取 `sessionWindowOrigin`
3. 用它驱动：
   - opener 复用校验
   - 顶层 `ready`
   - `connect.launch`
   - 后续协议 request

### 三、popup / direct 模式继续沿用原有 `targetOrigin`

本单不改：

1. 手工登录页
2. popup 工作台
3. 本地 session 中的 `targetOrigin`

这样可以把影响面收窄到 appView launch 链路。

---

## 6. 不能怎么做

1. 不能继续让 appView launch 复用 popup 的 `targetOrigin`。

2. 不能在 child app 里读 `window.opener.location.origin` 作为真值。

3. 不能用 `document.referrer` 作为 launch transport 真值。

4. 不能把 `postReadyToOpener()` / `connect.launch` 一律改成 `postMessage(..., "*")`。

5. 不能只传 `domain:port`，必须传完整 `origin`。

6. 不能为了兼容旧逻辑，在 `launchToken` 模式下默默 fallback 到 `https://keymaster.cc`。

---

## 7. 验收标准

1. Session Window 打开 child app 时，child URL 内存在合法 `sessionWindowOrigin`。
2. 下游 appView / launch 模式不再读取 UI 默认 `targetOrigin` 作为 transport target。
3. `ready`、`connect.launch` 与后续 request 在 launch 模式下统一使用 `sessionWindowOrigin`。
4. 缺少 / 非法 `sessionWindowOrigin` 时 appView 明确失败，不隐式回退。
5. popup / direct 模式现有 `targetOrigin` 行为不被破坏。

