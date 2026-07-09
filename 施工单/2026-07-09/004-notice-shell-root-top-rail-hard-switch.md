# 004 Notice Shell 根部订阅 + 页面顶部整宽 Rail 硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下现状文件与文档为准：

- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/shell/AppShell.notice.test.tsx`
- `apps/web/src/shell/RouteRenderer.tsx`
- `apps/web/src/styles/global.css`
- `packages/runtime/src/react/useRegistry.ts`
- `packages/runtime/src/react/PluginHostProvider.tsx`
- `packages/runtime/src/registries/noticeRegistry.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/contracts/src/notice.ts`
- `packages/contracts/src/registries.ts`
- `packages/plugin-webrtc/src/webrtcService.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `施工单/2026-07-09/003-message-session-webrtc-notice-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“notice 真值继续留在 runtime / shell，不落成独立业务插件”的定义优先。
2. 本单关于“notice 显示区挂在 AppShell 根部，不受具体 page route 影响”的定义优先。
3. 本单关于“notice rail 独占页面内容区顶部整行，不再与业务页做左右伴随布局”的定义优先。
4. 本次是硬切换，不保留旧右侧 rail，不保留路由内局部挂载，不保留“先兼容两个位置、后面再删”的过渡方案。

---

## 1. 文档定位

这不是一次纯 CSS 微调，也不是“某个 message 子页少渲一块 notice”的局部 bug 修补。

这次要一次性收口的是 notice 的 3 个边界错误：

1. **订阅边界错了**：`AppShell` 现在通过 `useRegistry((h) => h.notice.list())` 读 notice，但这个 hook 只跟 `host.version` 变化，不跟 `notice.registry.subscribe()` 变化，导致 notice 的 React 可见性并不稳。
2. **挂载边界错了**：notice 虽然真值在 runtime 全局，但当前渲染方式让它看起来像业务页伴随区域，用户感知上像“进了某些路由才有，换个子页就没了”。
3. **布局边界错了**：notice rail 当前和 page 内容是左右关系，这会把“需要立刻处理的全局通知”降级成页面侧栏信息，不符合系统级紧急提示的产品语义。

因此本次不是补丁式修修 UI，而是一次性把 notice 的：

- 真值边界
- 订阅边界
- 壳层挂载边界
- 页面布局边界

全部重新钉死。

---

## 2. 简述缘由

### 2.1 notice 必须是 shell/runtime 级能力，而不是 route 级能力

当前 `notice.registry` 已经在 runtime 内建，这个方向本身是对的。

但如果 React 层还是通过“跟 host 生命周期相关、跟 notice 自身变化无关”的方式取值，就会出现两个问题：

- notice 不是“没有”，而是“没有可靠渲到当前树上”
- 用户会误判为 notice 依赖当前 route

这会直接破坏“全局紧急通知”的核心承诺。

所以本次必须明确：

- notice 真值继续在 `runtime`
- shell 必须直接订阅 `host.notice.subscribe(...)`
- notice 的显示与否，只取决于 registry 当前状态，不取决于具体 page route

### 2.2 紧急 notice 不是页面侧栏信息

右侧伴随栏适合：

- 统计信息
- 补充说明
- 次要工具

但不适合：

- 来电
- 需要立即接听/拒绝的动作
- 需要跨页面持续可见的系统级提示

如果 notice 和业务页左右并排，它的视觉优先级会被业务正文稀释，而且不同页面宽度下会让 notice 看起来像“这页的一个局部模块”。

所以本次必须改成：

- notice rail 位于页面内容区顶部
- 横向独占整行
- 多条 notice 在该区域纵向堆叠

这样 notice 仍然不侵入 header / menu，但在内容区内拥有明确的最高优先级。

### 2.3 不能把这次问题误解成“再做一个 notice plugin”

如果因为“想让 notice 更全局”就去新建一个 `plugin-notice`：

- shell 会反向依赖业务插件
- notice 的存在要等插件 UI 装配完成
- 其它插件发布 notice 时边界会倒挂

这和当前系统的简化原则相反。

正确做法不是再加一层，而是把已经对的 runtime 真值真正接到 shell 根部。

### 2.4 不能为了“所有路由都能显示”把 notice 塞进各页面自己渲染

另一种错误修法是：

- `MessagePage` 渲一份
- `MessageDetailPage` 渲一份
- 以后别的业务页再各自补一份

这样短期看能修 `/message` 和 `/message/:publicKeyHex`，长期一定会变成：

- 每个页面都要自己接 notice
- 样式和交互漂移
- dismiss / action / routeTo 行为不一致

因此 notice 只能由 `AppShell` 统一渲染，业务页不允许复制 notice UI。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. notice 真值仍然唯一存在于 `runtime` 的 `notice.registry`。
2. `AppShell` 不再通过 `useRegistry((h) => h.notice.list())` 获取 notice。
3. `AppShell` 改为直接订阅 `host.notice.subscribe(...)`，notice 变化立即触发壳层重渲染。
4. notice 的显示不再依赖 `host.version` bump，不再依赖插件启停，不再依赖路由切换顺手触发刷新。
5. notice rail 挂载在 `AppShell` 正常业务内容区根部，位置在 `Breadcrumbs` 和 `RouteRenderer` 之前。
6. notice rail 不进入任何单独业务 page 组件，不允许 `plugin-message`、`plugin-webrtc` 等业务插件自行渲染这块 UI。
7. notice rail 在桌面端独占页面内容区顶部整行，不再和业务页形成左右两列。
8. notice rail 在 pad / mobile 端继续位于内容区顶部，保持单列顺序，不因为响应式回退成页面侧栏。
9. `activationNotice` 仍保留在 topbar 下方原位，它是 vault 壳层守卫提示，不与通用 notice rail 合并。
10. `routeTo`、按钮 `run()`、按钮 `navigateTo`、`autoDismiss` 行为语义保持不变。
11. `/messages`、`/messages/:publicKeyHex`、`/message/:publicKeyHex` 三类消息路由下看到的是同一个 shell 根级 notice rail。
12. 本次不新增 `plugin-notice`，不新增 notice 持久化，不新增跨刷新动作恢复。

---

## 4. 单真值与职责边界

### 4.1 `notice.registry` 是唯一真值

`packages/runtime/src/registries/noticeRegistry.ts` 继续是唯一 notice 真值。

它负责：

- `upsert(record)`
- `dismiss(id)`
- `list()`
- `subscribe(handler)`
- `removeBySourcePluginId(sourcePluginId)`

它不负责：

- React 渲染
- 页面布局
- 业务判断
- 持久化

### 4.2 `AppShell` 是唯一渲染者

`apps/web/src/shell/AppShell.tsx` 是 notice rail 的唯一渲染位置。

它负责：

- 订阅 notice 列表
- 统一渲染 rail / card
- 执行 action 的 `run()` / `navigateTo`
- 统一 dismiss 行为

它不负责：

- 决定什么时候发 notice
- 解释业务含义
- 做业务级会话仲裁

### 4.3 业务插件只能投递 notice，不能持有全局 notice UI

`plugin-webrtc` 等业务插件负责：

- 创建 notice record
- 更新 notice
- 移除 notice

它们不负责：

- 在自己的页面内渲染全局 notice rail
- 提供全局 notice page / plugin
- 要求 shell 为某个插件特判渲染位置

### 4.4 `useRegistry` 不是 notice 的订阅通道

`useRegistry` 的定位仍然是：

- 跟 host registry 装配变化走
- 适合 routes / menus / settings / breadcrumbs 等“随 host.version 变”的读取

它不是 notice 的正确订阅模型，因为 notice 的变化频率和触发来源与 host.version 无关。

因此本次必须明确：

- notice 读法走 `notice.subscribe`
- 不把 `useRegistry` 改造成一个包打天下的通用 store 桥接器

这是简化系统边界，而不是扩展 `useRegistry` 复杂度。

---

## 5. 必须怎么做

### 5.1 `AppShell` 必须改成直接订阅 `host.notice`

`apps/web/src/shell/AppShell.tsx` 内 notice 读取逻辑必须改成：

- 通过 `usePluginHost()` 拿 `host`
- 组件本地 `useState<NoticeRecord[]>`
- `useEffect` 内调用 `host.notice.subscribe(setter)`
- 初次订阅时立即吃到当前快照

设计理由要在代码注释里写清楚：

- notice 变化与 `host.version` 无关
- 直接订阅 notice registry 才能保证跨 route 的稳定可见性

### 5.2 notice rail 必须挪到 `AppShell` 内容区顶部

`renderNormalShell(...)` 的结构必须改成以下语义顺序：

1. `Topbar`
2. `activationNotice`（如有）
3. `app-shell__body`
4. `Sidebar`
5. `main.app-shell__main`
6. `NoticeRail`
7. `div.app-shell__paged`
8. `Breadcrumbs`
9. `RouteRenderer`

也就是说，notice rail 必须在 `app-shell__paged` 外层、但仍在 `main` 内。

这样才能同时满足：

- 不属于 header
- 不属于 menu
- 不属于具体 page route
- 独占内容区顶部整行

### 5.3 notice rail 样式必须改成整宽顶部区

`apps/web/src/styles/global.css` 必须一次性去掉 notice 的右侧栏布局语义：

- 删除 `app-shell__main.has-notice-rail` 的双列网格职责
- 删除 notice rail 的右列 `order: 2`
- 删除其“sticky 右侧栏”语义
- 保留多条 card 堆叠，但整体改成顶部全宽块

新的布局要求：

- `.app-shell__main` 始终单列
- `.app-notice-rail` 宽度 100%
- `.app-notice-rail__list` 纵向堆叠
- 桌面端允许 rail 内部卡片横向舒展，但 rail 自身不能和 page 并列
- pad / mobile 不需要做特殊“回退到顶部”的补丁，因为默认就是顶部

### 5.4 测试必须覆盖“跨路由一致可见”

`apps/web/src/shell/AppShell.notice.test.tsx` 至少要覆盖：

1. 多条 notice 全部渲染
2. 点击 notice 本体时 `routeTo` 正常跳转
3. 在 `/messages` 路由下能看到 notice
4. 在 `/message/:publicKeyHex` 路由下也能看到同一条 notice
5. notice 在 `host.notice.upsert(...)` 后无需 host.version 变化也能显示

第 5 条是本次修复的关键验收点，不能只测静态初始态。

---

## 6. 不能怎么做

### 6.1 不能新增 `plugin-notice`

本次明确禁止：

- 新建 `packages/plugin-notice`
- 让 shell 依赖某个 UI notice 插件
- 把 notice 真值从 runtime 挪走

### 6.2 不能把 notice 再塞回任意业务 page

本次明确禁止：

- 在 `MessagePage.tsx` 渲一份 notice
- 在 `MessageDetailPage.tsx` 渲一份 notice
- 在 `WebrtcPage.tsx` 渲一份 notice
- 各插件复制一套“全局通知条”

### 6.3 不能保留“右侧栏 + 顶部栏”双实现

本次是硬切换，明确禁止：

- 桌面端右侧栏、移动端顶部栏双实现
- 先保留旧 `.has-notice-rail` 双列样式，再额外补一个顶部 rail
- 通过 CSS 隐藏旧 rail 而不删壳层结构

最终只能有一个真正在 DOM 里承担职责的全局 notice rail。

### 6.4 不能把 notice 修复成对 `host.version` 的副作用依赖

本次明确禁止：

- 为了让 notice 刷新，去强行 bump `host.version`
- 在业务插件每次 `notice.upsert` 后顺手启停/注册某个 host 资源来触发刷新
- 让 route 切换承担 notice 的刷新职责

这种修法会把 notice 正确性建立在无关副作用上，属于假修复。

### 6.5 不能顺手扩张 `useRegistry`

本次明确禁止：

- 把 `useRegistry` 改成内部自动识别所有 `subscribe` 型对象
- 为 notice 单独给 `useRegistry` 加复杂分支
- 借题发挥做一套通用 store bridge 框架

这次任务的正确修法是局部直接订阅 `host.notice`，不是扩一层抽象。

---

## 7. 特殊情况与处理原则

### 7.1 notice 在当前页面触发，但目标路由是别的页面

处理原则：

- shell 统一允许 notice 点击和动作内跳转
- notice rail 继续留在 shell 顶部
- 路由切换后如果 notice 仍未 dismiss，则继续显示

不需要额外做“当前页专属 notice 容器”。

### 7.2 当前没有任何 notice

处理原则：

- `NoticeRail` 返回 `null`
- `AppShell` 主内容区保持单列正常流式布局
- 不保留空白占位，不保留右侧空列

### 7.3 同时存在 `activationNotice` 和通用 notice

处理原则：

- `activationNotice` 继续保留在 topbar 下方原位
- 通用 notice rail 位于 main 内容区顶部
- 两者不合并，不共享 dismiss 语义

原因：

- `activationNotice` 是 vault 壳层守卫提示
- 通用 notice 是 runtime 业务插件投递区
- 两者来源与职责不同，强行合并只会把壳层边界搅乱

### 7.4 notice 动作执行失败

处理原则：

- 保持当前已有 `console.error("notice action failed", err)` 防御语义
- 不新增 toast 框架
- 不为失败动作新增持久化补偿

本项目优先系统简单性；动作失败让它失败，但不能让 shell 卡住。

### 7.5 来电 notice 在 `/message/:publicKeyHex` 别名路由下显示

处理原则：

- notice 只认 shell 根部，不认当前 message 路由是复数还是单数别名
- `/messages/:publicKeyHex` 与 `/message/:publicKeyHex` 看到同一份 notice 真值
- 不允许在别名路由单独写一套 notice 兼容逻辑

---

## 8. 文件级实施清单

### 8.1 `apps/web/src/shell/AppShell.tsx`

必须修改：

- 删掉 `useRegistry((h) => h.notice.list())` 对 notice 的依赖
- 引入 `usePluginHost()`
- 新增 notice 本地订阅状态
- 在 `useEffect` 中直接订阅 `host.notice.subscribe(...)`
- 调整 `renderNormalShell(...)` 的 DOM 结构，把 `NoticeRail` 放到 `app-shell__paged` 前
- 删除 `has-notice-rail` 这类双列布局耦合用法

### 8.2 `apps/web/src/styles/global.css`

必须修改：

- 让 `.app-shell__main` 固定为单列内容流
- 删除 `.app-shell__main.has-notice-rail` 双列逻辑
- 删除 `.app-notice-rail` 的右栏 / sticky / order 语义
- 改成顶部整宽 rail 样式
- 保持 notice card 内部交互样式不变，避免无关 UI 扩散

### 8.3 `apps/web/src/shell/AppShell.notice.test.tsx`

必须修改或补充：

- 增加“挂载后再 upsert，notice 立即出现”的测试
- 增加 `/messages` 路由下可见的测试
- 增加 `/message/:publicKeyHex` 路由下可见的测试
- 保留现有“全部渲染”“点击跳转”断言

### 8.4 `packages/runtime/src/react/useRegistry.ts`

本次原则上**不改实现**。

允许做的最多是：

- 在注释里补充说明它不适合 notice 这类自带订阅的 runtime store

如果不改注释，也可以不动这个文件。

### 8.5 `packages/plugin-webrtc/src/webrtcService.ts`

原则上**不需要改业务语义**。

只需要在联调验收时确认：

- 现有 `noticeRegistry.upsert(...)`
- `removeBySourcePluginId("webrtc")`

在新壳层订阅模型下表现正常。

除非联调中发现 record 字段本身有问题，否则本文件不应顺手重构。

### 8.6 `packages/plugin-message/src/MessagePage.tsx`

原则上**不应承接任何 notice UI 代码**。

如现有跳转仍使用 `/message/:publicKeyHex` 别名，本次不强制顺手改路由真值；只要 shell notice 能跨这两类路径一致显示即可。

### 8.7 `packages/plugin-message/src/MessageDetailPage.tsx`

原则上**不应承接任何 notice UI 代码**。

本次只验证：

- 当前路径是 `/messages/:publicKeyHex`
- 或当前路径是 `/message/:publicKeyHex`

notice 都由 shell 根部统一显示。

---

## 9. 实施步骤

1. 调整 `AppShell` 的 notice 订阅方式，去掉对 `useRegistry` 的依赖。
2. 调整 `renderNormalShell(...)` 的结构，把 notice rail 提升到内容区顶部根部。
3. 清理 `global.css` 中 notice 右栏布局，收口为顶部整宽 rail。
4. 补齐 `AppShell.notice.test.tsx`，覆盖动态 upsert 与两类 message 路由。
5. 联调 `plugin-webrtc` 来电 notice，确认 accept / reject / routeTo 行为不回归。

这是一次性硬切换流程，不拆阶段，不保留双实现。

---

## 10. 最终验收清单

以下条件必须全部满足，才算本次完成：

1. `AppShell` 内不存在通过 `useRegistry((h) => h.notice.list())` 读取 notice 的代码。
2. `AppShell` 使用 `host.notice.subscribe(...)` 直接订阅 notice。
3. notice 在页面初始无数据时不占位，不产生空白右栏。
4. 挂载完成后调用 `host.notice.upsert(...)`，页面无需切路由、无需 host.version 变化，notice 立即出现。
5. `/messages` 路由下可见 notice。
6. `/messages/:publicKeyHex` 路由下可见 notice。
7. `/message/:publicKeyHex` 路由下可见同一份 notice。
8. 桌面端 notice rail 位于页面内容区顶部整行，不再与业务页左右并排。
9. pad / mobile 端 notice rail 仍位于内容区顶部，不出现右侧窄栏残留。
10. 点击 notice 本体时，`routeTo` 仍能正常跳转。
11. 点击 notice action 时，`run()`、`navigateTo`、`autoDismiss` 行为与改造前保持一致。
12. `activationNotice` 仍保留在 topbar 下方原位，不与通用 notice rail 混合。
13. 代码库中未新增 `plugin-notice`，未新增 notice 持久化，未新增 host.version 强制 bump 之类旁路修复。
14. `plugin-message`、`plugin-webrtc` 页面组件内没有复制 notice rail UI。

---

## 11. 完成定义

本单完成的定义不是“样式看起来差不多对了”，而是以下 3 个条件同时成立：

1. notice 的**真值边界**正确：仍在 runtime。
2. notice 的**响应边界**正确：由 shell 直接订阅 notice registry。
3. notice 的**布局边界**正确：在页面内容区顶部独占整行，不受具体业务路由影响。

少任何一个，都不算真正修完。
