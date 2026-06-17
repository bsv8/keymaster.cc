# 007 内部导航禁止整页刷新硬切换施工单

## 目标

一次性把这类“点击应用内入口，浏览器整页刷新，React host 重建后回到解锁界面”的问题硬切掉：

1. 找到 `/settings/p2pkh` 页面里 `WOC 设置` 链接触发刷新的直接原因。
2. 对全项目同类问题做一次排查，不只修这一处。
3. 明确一条内部导航真值路径，后续插件不能再各自写 `<a href="/...">` 或 `window.location.href = ...`。
4. 顺手补上通用 `Button` 的隐式 submit 风险，避免下一次在表单上下文里复发“点普通按钮却提交页面”。

## 已定位根因

根因已经明确，不是 WOC service，也不是限流/队列状态本身：

1. `/settings/p2pkh` 页里的 `WOC 设置` 入口当前写成了原生锚点：
   `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`
   ` <a href="/settings/woc">WOC 设置</a> `
2. 这条路径绕过了 runtime 的 SPA 导航，只会触发浏览器原生页面跳转。
3. 浏览器一旦整页跳转，`apps/web` 整个 React host 会重建；Vault 的 in-memory 解锁态不会跨 reload 保留，所以用户看到的现象就是“页面刷新，然后回到解锁界面”。
4. 这个行为和项目现有导航约束是直接冲突的。`packages/runtime/src/navigate.ts` 已经明确写了：应用内 pathname 跳转必须走 `navigateTo/router.push()`，不能用 `<a href>` 绕过 SPA。

结论：

```txt
这次事故的直接原因
  = /settings/p2pkh -> /settings/woc 走了浏览器原生 href
  = 不是 WOC 保存配置
  = 不是 Vault 自己锁定
  = 不是限流队列导致状态切换
```

## 全项目同类排查结果

本次按“会不会触发整页刷新/整页重建”做了同源排查，结果如下。

### A 类：已确认的内部硬导航问题

1. `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`
   `/settings/p2pkh` 中的 `WOC 设置` 使用 `<a href="/settings/woc">`

2. `packages/plugin-assets/src/AssetsPage.tsx`
   资产列表“进入”使用 `<a href={r.detailRoute.path}>`

3. `packages/plugin-assets/src/AssetDetailPage.tsx`
   “打开专属详情”使用 `window.location.href = detail.summary.detailRoute.path`

这三处都属于同一类错误：

```txt
应用内路由
  却走了浏览器原生导航
  = 整页刷新
  = host 重建
  = 解锁态丢失
```

### B 类：当前未发现更多同类硬导航

对 `packages` 与 `apps/web` 做了关键字排查后，除了上面三处与 `apps/web/index.html` 里的 favicon 之外，没有发现其它内部 `href="/..."` / `window.location.href = ...` / `location.assign(...)`。

因此这次不是“到处都在裸跳转”，但已经足够说明规范还没有被收紧成硬规则。

### C 类：不是本次根因，但必须顺手硬化的隐患

1. `packages/ui/src/Button.tsx` 当前没有默认 `type`。
2. 在 HTML 里，`<button>` 进入任意祖先 `<form>` 时默认就是 `submit`。
3. 项目当前只有两处真实表单：
   `packages/plugin-vault/src/VaultCreatePage.tsx`
   `packages/plugin-vault/src/VaultUnlockPage.tsx`
   它们都已经显式写了 `type="submit"`，所以不是本次事故的直接来源。
4. 但 `Button` 作为通用组件，如果继续不设默认 `type="button"`，以后任何页面一旦被包进 `<form>`，普通“保存/切换/连接/展开”按钮都可能再次退化成提交按钮。

结论：

```txt
本次直接事故
  = 内部 href / location 导航

本次必须顺手收掉的共性隐患
  = Button 默认 type 缺失
```

## 简述缘由

这次必须用硬切换，而不是零散修点，原因很简单：

1. 只修 `/settings/p2pkh` 这一处，`plugin-assets` 里的两处硬导航还会继续制造同类刷新。
2. 只做“代码评审提醒”不够。这个项目插件多、页面多、入口分散，内部导航如果没有唯一真值，很快还会有人重新写回 `<a href>`。
3. 把问题归因到“Vault 没有跨刷新保持解锁态”是方向错误。钱包解锁态本来就不该靠“刷新后尽量保留”去掩盖错误导航。
4. `Button` 默认 submit 虽然不是这次现场根因，但它和“点击普通按钮导致页面状态整体跳变”属于同源风险，应该借这次窗口一起硬化。

## 硬切换结论

本次统一采用下面这套单一规则，不留中间态：

```txt
应用内导航真值
  = runtime router
  = router.push(path)
  = 或 runtime 提供的 AppLink/内部链接组件

禁止物
  = <a href="/..."> 内部路径直跳
  = window.location.href = "/..."
  = location.assign("/...")
  = location.replace("/...")

按钮真值
  = Button 默认 type="button"
  = 只有真实表单提交才显式 type="submit"
```

## 应该怎么做

### 一、把“内部文本链接”收口成统一组件

新增一个 runtime 层的内部链接组件，例如：

`packages/runtime/src/react/AppLink.tsx`

职责只做一件事：

1. 渲染真实 `<a>`，保留文本链接语义、可复制链接地址、可被浏览器识别为链接。
2. 对“同源、应用内、普通左键点击、无 modifier、无 `target`、无 `download`”的场景执行：
   `event.preventDefault()`
   `router.push(to)`
3. 对下面这些情况放行浏览器默认行为：
   外链
   `target="_blank"`
   `download`
   Ctrl/Cmd/Shift/Alt 点击
   中键点击

设计要求：

1. 这个组件应该放在 runtime，不应该放进 UI 包。
2. 原因是 UI 包目前明确不依赖 runtime；导航能力属于应用运行时，不属于纯样式组件。

### 二、把三处已确认的硬导航全部替换

1. `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`
   把 `WOC 设置` 从裸 `<a href="/settings/woc">` 改成统一内部链接组件。

2. `packages/plugin-assets/src/AssetsPage.tsx`
   把资产列表里的“进入”从裸 `<a href={detailRoute.path}>` 改成统一内部链接组件。

3. `packages/plugin-assets/src/AssetDetailPage.tsx`
   “打开专属详情”是按钮语义，不用文本链接组件；直接改成：
   `onClick={() => router.push(detail.summary.detailRoute.path!)}`

### 三、把 Button 默认行为改成 fail-closed

修改：

`packages/ui/src/Button.tsx`

规则改成：

1. 调用方没传 `type` 时，组件默认补 `type="button"`。
2. 真实提交按钮必须显式写 `type="submit"`。
3. 真实重置按钮必须显式写 `type="reset"`。

这条改动的意义不是修这次现场，而是把“普通按钮误提交表单”的行为从默认允许改成默认禁止。

### 四、把规则写成可失败的仓库检查

不能只靠文档约束，必须落成硬规则。建议直接扩充：

`scripts/check-boundaries.mjs`

新增导航安全检查：

1. 禁止在 `packages/**` 与 `apps/web/src/**` 里出现内部 `<a href="/...">`
2. 禁止出现 `window.location.href = "/..."`、`location.assign("/...")`、`location.replace("/...")`
3. 允许白名单：
   `apps/web/index.html` 的 favicon / 静态资源链接
   明确外链
4. 发现违规时 `process.exit(1)`

这样 `npm run lint:boundaries` 就能把这类问题变成“提交流水线失败”，而不是“之后再看”。

### 五、补一个 Button 默认 type 的单测

新增：

`packages/ui/src/Button.test.ts`

至少覆盖两条不变量：

1. 未传 `type` 时，渲染结果必须包含 `type="button"`
2. 显式传 `type="submit"` 时，不能被默认值覆盖

这个测试可以直接用 `react-dom/server` 做静态渲染，不需要引入新的浏览器测试框架。

## 不能怎么做

1. 不能只改 `/settings/p2pkh` 一处，然后把 `plugin-assets` 留着。那不叫收口，只是挪现场。

2. 不能把根因归咎为“刷新后为什么不自动保持解锁”。这会把错误从“导航层用了错工具”转移成“Vault 是否要跨 reload 保活”，方向错了。

3. 不能继续允许插件自己随手写：
   `<a href="/...">`
   `window.location.href = ...`
   然后靠 code review 人工识别。

4. 不能把内部文本链接全部改成普通 `<button>` 冒充链接。
   文本链接需要链接语义、可复制地址、可新开标签页；这正是统一 `AppLink` 存在的原因。

5. 不能把 `AppLink` 放到 UI 包里。
   UI 包当前边界是不依赖 runtime；导航拦截逻辑属于 runtime。

6. 不能为了“兼容旧习惯”保留一部分内部 `<a href>`，再期待 service worker / Vite / 浏览器缓存“看起来像没刷新”。
   只要走原生导航，原则上就是错。

7. 不能只在 WOC 页做修复，不把仓库检查补上。
   否则下一次同类入口会在别的插件重新长出来。

8. 不能继续让通用 `Button` 保持隐式 submit。
   即使它不是这次根因，也必须顺手改成 fail-closed。

## 特殊情况应该怎么办

### 情况 1：确实要跳外部站点

继续使用原生 `<a>`，并按需要补 `target="_blank"` / `rel`。  
这次硬切换只禁止“应用内路径还走浏览器原生导航”。

### 情况 2：需要新开标签页打开应用内页面

统一内部链接组件必须保留浏览器默认能力：

1. Cmd/Ctrl 点击
2. 中键点击
3. `target="_blank"`

这些场景不能强行 `preventDefault()`。

### 情况 3：目标只改 query/hash，不改 pathname

当前 runtime 的 `useCurrentPath()` 真值是 `pathname`，不是完整 location。  
如果未来出现“同一路径下只换 `?query` 也要触发页面逻辑重算”的需求，应该先升级：

`packages/runtime/src/navigate.ts`
`packages/runtime/src/react/useCurrentPath.ts`

把订阅真值从“仅 pathname”提升为“完整 location 或 pathname+search”。  
不能为了绕过这个限制，重新退回裸 `href`。

说明：

1. 本次已发现的三个现场都不是这种情况。
2. `/settings/p2pkh -> /settings/woc` 与 `/assets -> /p2pkh?...` 都会改变 pathname，按现有 router 已足够。

### 情况 4：真实表单提交

继续保留原生 `<form onSubmit>`，并显式写提交按钮：

`type="submit"`

本次改 `Button` 默认值之后，所有真正依赖表单提交的地方都必须显式声明，不允许再靠 HTML 默认值“碰巧生效”。

## 一次性施工单

### 需要新增

1. `packages/runtime/src/react/AppLink.tsx`
   新增统一内部链接组件，承接应用内文本链接导航。

2. `packages/ui/src/Button.test.ts`
   新增按钮默认 `type` 的单测。

### 需要修改

1. `packages/runtime/src/index.ts`
   导出新的内部链接组件。

2. `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx`
   把 `WOC 设置` 从裸 `<a href>` 改成统一内部链接组件。

3. `packages/plugin-assets/src/AssetsPage.tsx`
   把资产列表“进入”从裸 `<a href>` 改成统一内部链接组件。

4. `packages/plugin-assets/src/AssetDetailPage.tsx`
   把 `window.location.href = ...` 改成 `router.push(...)`。

5. `packages/ui/src/Button.tsx`
   默认补 `type="button"`，但保留调用方显式传入的 `submit/reset`。

6. `scripts/check-boundaries.mjs`
   增加“内部导航禁止原生硬跳转”的可失败检查。

## 最终验收清单

- [ ] 从 `/settings/p2pkh` 点击 `WOC 设置`，地址切到 `/settings/woc`，但浏览器不发生整页刷新，不回到解锁界面。
- [ ] 从 `/assets` 点击任意资产“进入”，不发生整页刷新。
- [ ] 从通用资产详情点击“打开专属详情”，不发生整页刷新。
- [ ] 项目源码中不再存在内部 `<a href="/...">`、`<a href={internalPath}>`、`window.location.href = internalPath` 这类写法。
- [ ] `packages/ui/src/Button.tsx` 在未传 `type` 时默认输出 `type="button"`。
- [ ] 现有真实表单提交入口仍显式保留 `type="submit"`，不被这次硬化破坏。
- [ ] `npm run lint:boundaries` 通过，且新增导航安全规则能在重新引入裸内部 href 时失败。
- [ ] `npm test -- packages/ui/src/Button.test.ts` 通过。
- [ ] 手工验证期间，Vault 不需要“跨刷新保活”来掩盖导航问题；即使保活能力未来变化，这次导航修复本身也独立成立。

## 实施后的不变量

```txt
内部页面跳转
  = 只能走 runtime router / AppLink

文本链接
  = AppLink

按钮动作
  = Button(type=button 默认)

真实表单提交
  = 显式 type=submit

仓库规则
  = check-boundaries 可失败守护
```
