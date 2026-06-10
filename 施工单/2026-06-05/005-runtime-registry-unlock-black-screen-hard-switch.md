# 005 Runtime Registry 解锁黑屏硬切换施工单

## 目标

一次性修复“创建或解锁 Vault 后页面变成黑色空白，没有任何元素”的问题。

本次只切换 runtime 的 registry 读取模型，不改 Vault 加解密流程、不改业务插件注册顺序、不绕过 Topbar、不临时隐藏后台任务托盘。

修复完成后：

```txt
未初始化 / locked
  App -> LockedShell

创建或解锁成功
  App -> UnlockedShell -> AppShell -> Topbar + Sidebar + RouteRenderer

Topbar
  能稳定渲染 topbar.registry 注册项
  不再触发 React external store 无限更新
```

## 问题结论

黑屏不是 CSS 问题，也不是 Vault 解密失败。

实际根因在 `useRegistry`：

```txt
packages/runtime/src/react/useRegistry.ts
```

当前实现用 `useSyncExternalStore` 包住 selector，并在 subscribe 阶段立即调用 `notify()`：

```txt
subscribe(notify)
  notify()

getSnapshot()
  selector(host)
```

`Topbar` 的 selector 是：

```txt
h.topbar.list()
```

而 `topbar.list()` 每次都会返回一个新的数组引用。React 看到 external store snapshot 每次都变，就持续触发重新渲染，最终抛出：

```txt
Maximum update depth exceeded
```

React 抛错后卸载根节点内容，页面只剩全局深色背景，所以表现为“黑色页面，没有元素”。

## 硬切换缘由

1. 当前插件宿主在 `bootstrapPlugins()` 完成后才挂载 React。也就是说，React 运行期间 registry 目前不是动态注册源，没必要伪装成 external store。
2. `useSyncExternalStore` 要求 snapshot 引用在 store 没变时保持稳定。现有 registry 的 `list()` 类 API 通常会返回新数组，和 external store 契约天然冲突。
3. 在 `Topbar` 局部 `useMemo` 或缓存数组只能压住一个症状。以后 Sidebar、Home、Settings 或其他组件复用 `useRegistry` 时还会再次踩坑。
4. 加 ErrorBoundary 只能把黑屏换成错误页，不能修复无限更新根因。
5. 分步骤兼容“伪订阅 + 局部缓存”会让 runtime 契约变得含糊：调用方不知道 selector 返回新对象是否安全。

因此本次必须硬切换 `useRegistry` 的语义：

```txt
当前语义：
  把 registry selector 当成 external store snapshot。

新语义：
  在当前稳定 PluginHost 上同步读取 selector 结果。
  不声明不存在的动态订阅能力。
```

## 核心不变量

1. `PluginHostProvider` 接收的 host 是已经完成 bootstrap 的稳定对象。
2. runtime 不承诺插件在 React 挂载后继续动态注册 registry 项。
3. `useRegistry(selector)` 允许 selector 返回新数组、新对象或派生结果。
4. registry 的 `list()` 方法不需要为了 React snapshot 契约返回稳定引用。
5. Topbar、Sidebar、RouteRenderer、Home 等 shell 层不能直接 import 业务插件。
6. 黑屏修复不能改变 Vault 状态机：

```txt
booting -> uninitialized -> unlocked
booting -> locked -> unlocked
unlocked -> locked
```

7. 创建 Vault 与解锁 Vault 成功后，`AppShell` 必须至少显示顶栏和锁定按钮。

## 不能怎么做

1. 不能通过隐藏 `Topbar`、移除 `BackgroundTray` 或注释 `topbar.registry` 来规避问题。
2. 不能只在 `Topbar.tsx` 里缓存 `h.topbar.list()`，因为根因在 runtime hook。
3. 不能要求所有 registry 的 `list()` 都返回同一个数组引用。这会把 React 约束泄漏到 registry 实现里。
4. 不能继续在 `useSyncExternalStore` 的 `subscribe` 里立即 `notify()`。
5. 不能为了消除黑屏只加 ErrorBoundary。ErrorBoundary 可以作为后续增强，但不是本次修复。
6. 不能修改 Vault 密码、IndexedDB 数据结构或清空用户 Vault 数据。
7. 不能把 shell 和业务插件重新耦合，例如让 shell 直接 import `plugin-background`。

## 文件级施工

### packages/runtime/src/react/useRegistry.ts

硬切换为稳定 host 上的同步 selector 读取。

目标语义：

```txt
const host = usePluginHost()
return selector(host)
```

保留这个 hook 的原因：

1. 统一组件读取 registry 的入口。
2. 后续如果真的需要运行期动态 registry，可以在 runtime 层统一升级，不让业务组件直接依赖 host 细节。
3. 当前修复不扩大调用面，不要求 Topbar 改写为直接 `usePluginHost()`。

注释需要改成中文，明确说明：

```txt
当前插件注册发生在 React 挂载前，host 引用稳定。
这里不使用 useSyncExternalStore，避免 selector 返回新数组时触发无限更新。
```

### apps/web/src/shell/Topbar.tsx

原则上不需要改行为。

只做必要检查：

```txt
const items = useRegistry((h) => h.topbar.list());
```

这行在新 `useRegistry` 语义下是合法用法。

如果后续 TypeScript 因 import 变化报错，只做最小调整，不改 Topbar 的职责。

### packages/runtime/src/react/PluginHostProvider.tsx

不改。

它继续只负责提供稳定 host。

### packages/runtime/src/createPluginHost.ts

不改。

本次不引入 registry invalidate、version、listener 或动态插件注册。

如果将来确实需要运行时安装/卸载插件，必须另开施工单设计 `host.version` 或 `host.subscribe()`，不能在本次黑屏修复里顺手加半套机制。

### tests

当前仓库没有固定 Playwright 依赖，不把 Playwright 加入项目依赖。

本次验证以现有命令为主：

```txt
npm run typecheck
npm run build
```

浏览器验收用本地 dev server 手工验证：

```txt
npm run dev -- --host 127.0.0.1
```

访问：

```txt
http://127.0.0.1:5173/
```

## 特殊情况处理

### selector 返回新数组

允许。

这是本次硬切换要支持的正常情况，例如：

```txt
h.topbar.list()
h.menus.list()
h.routes.list()
```

这些 API 不需要为了 React 做引用缓存。

### 后续需要动态 registry

不能把 `notify()` 加回 `useRegistry`。

正确处理方式是另开 runtime 施工单，明确增加：

```txt
PluginHost version
PluginHost subscribe
registry register 后 bump version
useRegistry 读取稳定 version snapshot
selector 结果用 useMemo 按 version 重新计算
```

也就是说，external store 的 snapshot 应该是稳定的 `version`，不是 `selector(host)` 返回的数组或对象。

### 页面仍然黑屏

先看浏览器 console。

如果错误仍是：

```txt
Maximum update depth exceeded
```

说明 `useRegistry` 没有真正切掉 external store 订阅。

如果是业务 widget 抛错，例如首页某个 widget 在 effect 或 render 中报错，则另开 bug：

```txt
Home widget 错误隔离
App ErrorBoundary
业务插件异常兜底
```

不能把业务 widget 错误和本次 runtime 无限更新混在一起修。

### 创建 Vault 后停留在锁定页

检查 `vault.status()` 和 `useRuntimeStatus()`。

本次施工不改 Vault 状态机。如果状态没有变为 `unlocked`，那是 Vault service 或 IndexedDB 问题，不应通过 runtime registry 修复。

### 导入意图丢失

`LockedShell` 当前还有一个独立可疑点：

```txt
pendingRef 不是 useRef，而是每次 render 创建的新对象
```

它可能影响“创建后继续导入”的跳转，但不会导致本次黑屏。

本次施工不处理该问题，避免把两个 bug 混在一次硬切换里。需要时另开施工单修 `LockedShell` 的 pending intent。

## 最终结构

本次落地后，相关结构保持：

```txt
packages/runtime/src/react/
  PluginHostProvider.tsx
  useCapability.ts
  useRegistry.ts        # 同步读取稳定 host 上的 registry selector
  useRuntimeStatus.ts

apps/web/src/shell/
  Topbar.tsx            # 继续通过 useRegistry 读取 topbar.registry
  AppShell.tsx
  Sidebar.tsx
  RouteRenderer.tsx
```

## 最终验收清单

### 静态验收

- [ ] `packages/runtime/src/react/useRegistry.ts` 不再 import `useSyncExternalStore`。
- [ ] `useRegistry` 内不再调用 `notify()`。
- [ ] `useRegistry` 允许 selector 返回新数组或新对象。
- [ ] `Topbar.tsx` 不直接 import `plugin-background`。
- [ ] 没有修改 Vault IndexedDB schema。
- [ ] 没有清空或迁移用户 Vault 数据。

### 命令验收

- [ ] 执行通过：

```txt
npm run typecheck
```

- [ ] 执行通过：

```txt
npm run build
```

### 浏览器验收

- [ ] 首次打开显示欢迎页。
- [ ] 点击“新建钱包”，输入 8 位以上密码并创建后，页面进入解锁后的 AppShell。
- [ ] 解锁后能看到顶部栏品牌：

```txt
BSV Web Wallet
```

- [ ] 解锁后能看到“锁定”按钮。
- [ ] 解锁后不会出现黑色空页面。
- [ ] 浏览器 console 不再出现：

```txt
The result of getSnapshot should be cached
Maximum update depth exceeded
```

- [ ] 点击“锁定”后回到锁定页。
- [ ] 再次输入密码解锁后仍能看到 AppShell。
- [ ] 默认 `/` 路由能显示首页或业务 widget；即使业务 widget 无数据，也不能清空 `#root`。

## 完成定义

本施工单完成的标准是：

```txt
创建 Vault 后不黑屏。
锁定后再次解锁不黑屏。
Topbar 正常显示。
runtime registry hook 不再制造 React external store 无限更新。
typecheck 和 build 通过。
```

