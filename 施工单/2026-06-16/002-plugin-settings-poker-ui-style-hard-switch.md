# 002 插件设置页去重 + Poker UI/CSS 结构化硬切换施工单

## 目标

一次性把当前插件设置与 Poker 页面/UI 样式接入修正到可维护状态：

```txt
系统级设置
  = /settings 只显示真正的业务设置
  = /settings/plugins 只作为独立系统页存在
  = 不再把插件管理页重复塞回 settings.registry

Poker 插件
  = 保留独立业务页面与独立设置页
  = 不再在通用 /settings 中重复渲染一套 field 版 Poker 设置
  = 首页 widget / 大厅 / 单桌 / 设置页具备完整样式

样式结构
  = global.css 只负责全局 token / shell / 通用 primitive
  = 每个插件自带自己的 styles.css
  = apps/web 装配层显式引入插件样式
  = 移除插件时能一起移除对应样式入口

视觉结果
  = Plugin Manager 从“堆满元数据的大白板”变成可扫描的系统页
  = Poker 页面从“无样式骨架”变成可读、可操作、可扩展的业务页
```

本次是硬切换，不接受下面这些中间态：

1. 先给 `PluginManagerPage` 随便补几条全局 CSS，但继续保留 `/settings` 内重复“插件设置”区块。
2. 先让 Poker 页面“看起来不那么丑”，但仍然同时保留 `registerField + registerPage + 独立页面` 三套入口。
3. 继续把业务插件样式追加到 `apps/web/src/styles/global.css`，以后再慢慢拆。
4. 只修 `PokerSettingsPage`，首页 widget / 大厅 / 单桌页继续裸奔。

## 简述缘由

1. 当前 `/settings` 里出现“插件设置”不是产品设计，而是结构错误。`plugin-settings` 既注册了独立路由 `/settings/plugins`，又把 `PluginManagerPage` 注册成了一个 `settings page`，所以重复出现。
   - 重复注册位置见 [packages/plugin-settings/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/manifest.ts:182)
   - `/settings` 会把 `settings.registry` 里的 page 全部直接渲染出来，见 [packages/plugin-settings/src/SettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/SettingsPage.tsx:122)

2. 当前 Poker 插件不是“没有页面”，而是“页面存在但没有成体系的样式接入”：
   - 设置页 class 已写出，见 [packages/plugin-poker/src/PokerSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerSettingsPage.tsx:109)
   - 大厅页 class 已写出，见 [packages/plugin-poker/src/PokerLobby.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerLobby.tsx:35)
   - 首页 widget class 已写出，见 [packages/plugin-poker/src/widgets/PokerHomeWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/widgets/PokerHomeWidget.tsx:28)
   - 但全项目只有 [apps/web/src/styles/global.css](/home/david/Workspaces/keymaster.cc/apps/web/src/styles/global.css:1) 作为样式入口，且其中几乎没有 `poker-*` 与 `plugin-card*` 规则。

3. 当前 Plugin Manager 丑，不只是“CSS 没生效”，也是因为页面模型不对。它本来是一个系统级独立工作台，却被塞进通用设置页 section，同时默认展开所有元数据，信息密度失控。

4. 当前 Poker 设置还存在第二个结构错误：插件既注册了独立 `PokerSettingsPage`，又注册了多条通用 `SettingsField`。这会让一个业务设置模型同时存在“表单页”和“字段页”两套真值，后续必然重复、错位、样式撕裂。
   - 重复 field 注册见 [packages/plugin-poker/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/manifest.ts:235)
   - 独立 page 注册见 [packages/plugin-poker/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/manifest.ts:275)

5. 当前首页 widget 也没有遵守平台已有的 UI 壳约定。其它 widget 都复用了 `home-widget` 壳，而 Poker widget 直接输出了一个没有样式定义的 `poker-home-widget`，导致它即使渲染了，看起来也像没接上平台。

## 硬切换结论

本次统一采用下面这套明确架构：

```txt
系统页分层
  /settings
    = 业务插件设置入口聚合页
    = 聚合 settings.registry 注册的业务设置页
    = 不承载系统级插件启停 UI
    = 业务插件以“入口 section”形式热出现与热消失
    = 业务插件的入口 section 只承担简介 / 当前状态摘要 / 跳转按钮
      ，不内嵌完整表单

  /settings/plugins
    = 唯一系统级插件启停管理页
    = 独立路由、独立菜单、独立视觉结构
    = 不再注册进 settings.registry

Poker 设置模型（硬切换 002 唯一结论）
  = 必须保留 settings.registry.registerPage(...)
  = 但 page.component 是“入口 section 组件”，不是 PokerSettingsPage
  = 删除全部 SettingsField 形式的 Poker 设置
  = /settings/poker 是 Poker 唯一正式完整设置页
  = /settings 中的 Poker 入口 section 负责简介 + 跳转
  = 完整 endpoint / identity / fallback / diag 全部只在 /settings/poker 编辑

样式分层
  global.css
    = 主题 token / shell / 通用 UI primitive / 少量跨插件通用布局

  plugin-settings/src/styles.css
    = Plugin Manager 与 settings 插件专属布局

  plugin-poker/src/styles.css
    = Poker 首页 widget / 大厅 / 单桌 / 设置页 / 设置入口 section 专属布局

  apps/web 装配层
    = 显式引入插件样式入口
    = 开发者删除插件时能一眼找到对应样式 import
```

本次切换后，必须满足下面的不变量：

1. `/settings` 不再显示“插件管理”整页内容。
2. `/settings` 不再承载任何插件 enable / disable 控件。
3. `plugin-settings` 不再通过 `settings.registry.registerPage()` 注册 `PluginManagerPage`。
4. `plugin-poker` 不再同时维护 `SettingsField[]` 与完整 `PokerSettingsPage` 作为同一批业务设置真值。
   - `settings.registry.registerPage(...)` 仍被调用，但其 `component` 是 `PokerSettingsEntry`（轻量入口），不是 `PokerSettingsPage`。
   - `fields` 列表为空。
5. `plugin-poker` 启用时，`/settings` 中出现 Poker 入口 section；禁用时该 section 热消失。
6. `plugin-poker` 启用时，`/settings/poker` 可访问；禁用时该路由不再可访问。
7. `global.css` 不再继续吸收 Poker 或 Plugin Manager 的业务样式。
8. 每个插件自己的样式必须跟着插件目录走，不能散落在 shell 全局样式里。
9. Poker 首页 widget 必须复用平台已有的 widget 壳层级，而不是自造一套无约定外壳。
10. Plugin Manager 必须首先可扫描，再展示细节；不能默认把每个插件的全部元数据铺满页面。
11. 样式入口必须是装配层显式声明，方便未来移除插件时一起删除。

## 不能怎么做

1. 不能保留 `settings.registry` 里的 `settings.plugins` 页面注册，然后只靠 CSS 把它“藏起来”。真值必须删除，不能视觉掩盖。

2. 不能让 Poker 设置继续同时维护：
   - `/settings/poker` 完整业务页
   - `SettingsField[]` 字段列表
   - 在 `/settings` 中内嵌完整 Poker 表单

   这三套真值会重复维护、互相错位、样式撕裂。

3. 不能把 `PluginManagerPage`（含插件 enable / disable 控件）以任何形式塞回 `/settings`。插件启停永远只能在 `/settings/plugins`。

4. 不能让 `/settings` 中的 Poker 入口 section 承载 endpoint / identity / fallback / diag 等任何业务字段编辑器。它必须只做“简介 + 跳转”。

5. 不能继续把 `plugin-card`、`poker-*`、`settings-*` 业务样式堆回 `apps/web/src/styles/global.css`。这会让插件边界再次失效。

6. 不能为了“快”而在 JSX 里塞大量 inline style。那会让主题切换、样式复用、目录移除都变差。

7. 不能只给 `PokerSettingsPage` 补样式，而让：
   - `PokerHomeWidget`
   - `PokerLobby`
   - `PokerTable`

   继续裸样式。Poker 是一个业务插件，不是单页 demo。

8. 不能只修 CSS，不修组件结构。比如 `PluginManagerPage` 当前信息默认全展开，即使补了样式，也仍然是差页面。

9. 不能让 Poker widget 继续绕开 `home-widget` 壳。平台已经有首页组件的统一视觉语义，Poker 必须接上这个约定。

10. 不能把插件样式入口隐式放进某个业务组件 import 里，导致删除插件代码后还可能残留样式副作用。装配层必须显式持有样式入口。

9. 不能把 `/settings/plugins` 做成 `/settings` 的一个 section 锚点跳转。它是系统管理页，不是普通设置分组。

10. 不能为了“页面好看”而隐藏依赖/能力真值。Plugin Manager 的职责是系统可观测，不是营销页。

## 应该怎么做

### 一、设置页职责重新划分

`plugin-settings` 需要明确两类页面的边界：

```txt
/settings
  = 业务插件设置入口聚合页
  = 聚合 settings.registry 注册的业务设置页
  = 业务插件以“入口 section”形式热出现与热消失
  = 入口 section 只承担简介 + 状态摘要 + 跳转
  = 不承载系统级插件启停 UI
  = 不内嵌任何业务插件的完整表单

/settings/plugins
  = 唯一系统级插件启停管理页
  = 独立路由、独立菜单、独立视觉结构
  = 不再注册进 settings.registry
```

具体处理：

1. 删除 [packages/plugin-settings/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/manifest.ts:182) 中把 `PluginManagerPage` 再次注册为 `settings page` 的逻辑。
2. 保留：
   - `/settings` 路由
   - `/settings/plugins` 路由
   - 左侧菜单中的“设置”与“插件”
   - `/settings/plugins` 面包屑
3. `/settings` 页面只聚合真正的业务设置入口 section，不承担系统管理 UI。

### 二、Poker 设置模型硬切换为“入口 section + 完整业务页”双形态

Poker 不是简单字段配置，它至少包含：

1. 代理 endpoint
2. 双平面公告 endpoint
3. fallback 广播策略
4. 连接/断开
5. 稳定身份绑定/解绑
6. 诊断输出

这类页面不适合再拆回通用 `SettingsField`。

唯一正确做法（不能再分叉）：

```txt
plugin-poker
  settings 真值
    = PokerSettingsPage          // 唯一正式完整设置页
    = PokerSettingsEntry          // 在 /settings 中显示的入口 section
    = /settings/poker             // PokerSettingsPage 挂的路由

settings.registry
  必须保留 settings.registerPage(...)
    id      = "poker.config"
    fields  = []
    component = PokerSettingsEntry     // 不是 PokerSettingsPage
    order   = 30
```

具体动作：

1. **删除** `plugin-poker` 中的全部 `registerField(...)` 调用。
2. **保留** `settings.registerPage(...)` 调用；但 `component` 指向 `PokerSettingsEntry`，`fields` 为空数组。
3. `/settings/poker` 路由继续指向 `PokerSettingsPage`，作为唯一完整业务设置页。
4. `PokerSettingsEntry` 是新增的轻量入口组件，**只**展示：
   - Poker 简介文案
   - 当前连接状态摘要
   - 当前 identity 绑定状态摘要
   - 进入 `/settings/poker` 的按钮

   不展示任何表单字段。
5. `plugin-poker` 启用时，`PokerSettingsEntry` 通过 `settings.registerPage` 注册到 `/settings`，`/settings/poker` 也可访问；禁用时两者一起随 owner 回收消失。

推荐语义：

```txt
/settings
  业务插件入口聚合页
  plugin-poker 启用时出现 Poker 入口 section（轻量）
  plugin-poker 禁用时该 section 热消失

/settings/poker
  Poker 唯一正式完整设置页
  plugin-poker 启用时可访问
  plugin-poker 禁用时该路由随 owner 一起回收

/settings/plugins
  唯一系统级插件启停管理页
  永远不注册进 settings.registry
```

这样最符合“业务设置是业务页，不是字段拼盘；业务入口归聚合页管理，正式配置归业务页负责”的长期维护方向。

### 三、样式目录结构硬切换

本次样式结构明确改成下面这样：

```txt
apps/web/src/styles/
  global.css
  plugins.css

packages/plugin-settings/src/
  styles.css

packages/plugin-poker/src/
  styles.css
```

职责边界：

1. `global.css`
   - 主题变量
   - app shell
   - UI primitive
   - 极少量真正跨插件的通用布局类

2. `packages/plugin-settings/src/styles.css`
   - `plugin-manager*`
   - `plugin-card*`
   - `pm-state*`
   - 仅属于 settings 插件的样式

3. `packages/plugin-poker/src/styles.css`
   - `poker-settings*`
   - `poker-lobby*`
   - `poker-table*`
   - `poker-home-widget*`
   - Poker 插件内部页面与组件样式

4. `apps/web/src/styles/plugins.css`
   - 只做装配层样式引入
   - 显式列出当前启用的插件样式来源

为保证装配层可维护，建议同时调整插件包导出：

```txt
@keymaster/plugin-settings/styles.css
@keymaster/plugin-poker/styles.css
```

然后由 `apps/web` 统一引入。这样未来删除插件时：

1. 删 `bootstrapPlugins.ts` 里的插件 import
2. 删 `plugins.css` 里的样式 import
3. 删整个插件目录

不会再去全局样式里人工搜残留选择器。

### 四、Plugin Manager 页面重做原则

视觉主张：

```txt
这是系统运维页
不是设置字段列表
不是卡片海报
也不是大段元数据转储
```

建议版式：

1. 顶部保留 `PageHeader`
2. 中部为按 group 分组的插件列表
3. 每一行先显示：
   - 插件名
   - 分组
   - 状态 badge
   - 简短描述
   - 启用/禁用按钮
4. 依赖、提供能力、反向依赖、阻塞者放进可展开明细区
5. 错误状态、缺依赖状态要高可见，但不把全页染成错误页

交互规则：

1. 默认收起技术细节
2. 当前插件有 `blockers` 时，显示明确原因
3. 缺依赖时，按钮禁用并给出缺失列表
4. 不再把整个页面作为 `/settings` 中的一段 section 渲染

### 五、Poker 页面视觉与结构统一

Poker 页面要从“测试骨架”升级成“可用业务页”，但不做过度装饰。

视觉主张：

```txt
轻量桌面客户端感
暖色强调
深浅主题都可读
信息优先于装饰
```

内容分层：

1. `PokerHomeWidget`
   - 复用 `home-widget`
   - 显示标题、连接状态、在线人数
   - 未连接时显示简洁引导

2. `PokerLobby`
   - 顶部状态摘要
   - 左右或上下分区：
     - 在线玩家
     - 桌局列表
   - 空状态明确，不显示“什么都没接上”的空白页

3. `PokerTable`
   - 桌号 / topic / 订阅状态 / tx event 计数
   - 这是当前阶段的协议页，不强装成完整牌桌

4. `PokerSettingsPage`
   - 顶部状态条
   - 身份绑定区
   - 网络参数区
   - 操作区
   - 诊断区

组件规则：

1. 优先复用 `@keymaster/ui` 里的 `Button`、`TextInput`、`Select`、`PageHeader`
2. 不再直接裸用 HTML `button/input/select` 形成第二套风格
3. class 命名继续保持 `poker-*` 前缀

## 特殊情况提前约定

### 情况 1：用户直接访问 `/settings/plugins` 之外的系统页入口

处理原则：

```txt
系统页独立
但不侵入通用设置聚合页
```

应该这样做：

1. `/settings/plugins` 保持独立工作台。
2. `/settings` 中不再渲染整页插件管理内容。
3. 左侧菜单中仍保留“插件”入口，避免发现性下降。

不能这样做：

1. 不能为了“在 /settings 可见”就重新把整个 `PluginManagerPage` 塞回 `settings.registry`。
2. 不能在 `/settings` 里放一个巨大的 iframe 式插件管理 section。

### 情况 2：Poker 插件被禁用，但用户直接打开 `/settings/poker` 或 `/poker`

处理原则：

```txt
禁用后的正式语义
是页面不可达
不是渲染一个空白组件
```

应该这样做：

1. 依赖 runtime 已有的热卸载与安全跳转逻辑。
2. 插件 disable 后，其 route/menu/settings 注册项一并回收。
3. 当前用户若正停留在 Poker 路由，先跳到安全页，再卸载。

不能这样做：

1. 不能保留路由但让组件内部自己显示“service 不存在”。
2. 不能让 `/settings/poker` 在插件禁用后继续显示半残表单。

### 情况 3：未来移除整个 Poker 插件

处理原则：

```txt
代码和样式都必须可一起移除
```

应该这样做：

1. `apps/web` 装配层同时删除插件 bootstrap import 与样式 import。
2. `global.css` 中不应存在 `poker-*` 规则，因此不需要再全局清扫。
3. `packages/plugin-poker/src/styles.css` 跟着目录整体删除。

不能这样做：

1. 不能把 Poker 选择器继续残留在 `global.css`。
2. 不能把插件样式偷偷散落在其他插件 CSS 中。

### 情况 4：移动端窄屏

处理原则：

```txt
系统页与业务页都要先保证可读和可点
不要在移动端复制桌面三栏
```

应该这样做：

1. Plugin Manager 行布局在窄屏下纵向堆叠。
2. Poker 设置页分区改为单列。
3. Poker 大厅的玩家列表和桌局列表在窄屏下纵排。
4. 按钮行允许换行，不出现横向滚动。

不能这样做：

1. 不能把桌面端双栏强塞到手机宽度。
2. 不能依赖 hover 才能看到关键信息。

### 情况 5：Poker 暂未连接、未绑定身份、Vault 未解锁

处理原则：

```txt
这是正常业务状态
不是错误页
```

应该这样做：

1. 页面继续完整渲染。
2. 状态条明确显示当前状态。
3. 相关操作按钮禁用或收敛。
4. 空状态和引导文案保持简洁。

不能这样做：

1. 不能把整个页面直接渲染成“什么都没有”。
2. 不能把业务未就绪与系统崩溃混成同一种视觉反馈。

## 文件级改动清单

### 一、样式入口与装配层

1. `apps/web/src/main.tsx`
   - 继续保留 `global.css` 引入
   - 新增 `plugins.css` 引入

2. `apps/web/src/styles/global.css`
   - 清理当前不该继续增长的业务样式职责
   - 保留 token / shell / 通用 primitive
   - 删除或迁出：
     - `plugin-manager*`
     - `plugin-card*`
     - `pm-state*`
     - `poker-*`

3. `apps/web/src/styles/plugins.css`
   - 新增
   - 统一引入插件样式导出

### 二、settings 插件

1. `packages/plugin-settings/src/manifest.ts`
   - 删除 `settingsReg.registerPage({ id: "settings.plugins", ... component: PluginManagerPage })`
   - 保留独立 route/menu/breadcrumb

2. `packages/plugin-settings/src/PluginManagerPage.tsx`
   - 重构页面结构
   - 收敛信息层级
   - 增加可展开的依赖/能力明细
   - 统一接入 UI primitive

3. `packages/plugin-settings/src/styles.css`
   - 新增
   - 承载 settings 插件专属样式

4. `packages/plugin-settings/package.json`
   - 新增 `./styles.css` 导出

### 三、Poker 插件

1. `packages/plugin-poker/src/manifest.ts`
   - **删除**全部 `registerField(...)` 调用。
   - **保留** `settings.registerPage(...)` 调用，明确参数语义：
     - `id: "poker.config"`
     - `fields: []`
     - `component: PokerSettingsEntry`（不是 `PokerSettingsPage`）
     - `order: 30`
   - 恢复 `settings.registry` capability 依赖。
   - 保留 `/settings/poker` 路由指向 `PokerSettingsPage`，作为唯一正式完整设置页。

2. `packages/plugin-poker/src/PokerSettingsEntry.tsx`
   - **新增**轻量入口 section 组件。
   - 职责：在 `/settings` 中显示 Poker 简介、当前连接状态摘要、当前 identity 绑定状态摘要，以及一个跳转到 `/settings/poker` 的按钮。
   - 不承载 endpoint / 双平面 / fallback / identity 选择 / diag 等任何业务表单字段编辑器。
   - 走 `@keymaster/ui` 的 `Button` / `useCapability` / `useTranslation`，class 命名走 `poker-settings-entry*`。

3. `packages/plugin-poker/src/PokerSettingsPage.tsx`
   - 改用平台 UI 组件
   - 重构为状态条 + 分区布局
   - 保持业务动作与诊断能力不变
   - 此页只挂 `/settings/poker` 路由，不再作为 `settings.registry.registerPage` 的 component。

4. `packages/plugin-poker/src/PokerLobby.tsx`
   - 重构为结构化大厅布局
   - 完整空状态与列表样式

5. `packages/plugin-poker/src/PokerTable.tsx`
   - 补齐最小可读单桌视图样式

6. `packages/plugin-poker/src/widgets/PokerHomeWidget.tsx`
   - 改为复用 `home-widget` 壳
   - 与首页其它 widget 视觉统一

7. `packages/plugin-poker/src/styles.css`
   - 新增
   - 承载 Poker 插件专属样式
   - 包含 `.poker-settings-entry*` 修饰类

8. `packages/plugin-poker/package.json`
   - 新增 `./styles.css` 导出

### 四、必要的回归与联动

1. 若 `PluginManagerPage` 结构变化影响现有测试快照或断言：
   - 更新相关测试

2. 若 `plugin-poker` 把 `component` 从 `PokerSettingsPage` 改为 `PokerSettingsEntry` 后影响 `/settings` 现有数量或顺序断言：
   - 更新相关测试
   - 重点断言：`settings.registry.listPages()` 中 `poker.config` 的 `component` 字段是 `PokerSettingsEntry`，`fields.length === 0`

3. 若样式导出方式影响构建：
   - 补齐 Vite/TS 对 CSS 导出的解析路径验证

4. 新增一份运行时行为回归：
   - `plugin-poker` enable → `host.settings.listPages()` 包含 `poker.config`
   - `plugin-poker` disable → 该 page 随 owner 回收消失
   - `plugin-poker` enable → `/settings/poker` 路由在 `host.routes.list()` 中存在
   - `plugin-poker` disable → 该路由同样消失

## 最终验收清单

### 结构验收

- [ ] `/settings` 页面内不再出现“插件管理”整页内容。
- [ ] `/settings` 页面内不存在任何插件 enable / disable 控件。
- [ ] `/settings/plugins` 仍可直接访问。
- [ ] `/settings/plugins` 中存在插件 enable / disable 控件。
- [ ] 左侧菜单中仍存在“插件”入口。
- [ ] `plugin-poker` 不再同时注册一组 `SettingsField` 与完整 `PokerSettingsPage` 作为同一业务设置真值。
- [ ] `plugin-poker` 在 `settings.registry.registerPage` 中注册的 `component` 是 `PokerSettingsEntry`（不是 `PokerSettingsPage`），`fields` 为空。
- [ ] `/settings/poker` 仍是 Poker 的唯一正式完整设置页。

### 样式结构验收

- [ ] `apps/web/src/styles/global.css` 不再承载 Poker 与 Plugin Manager 的业务样式主体。
- [ ] `packages/plugin-settings/src/styles.css` 存在并承载 Plugin Manager 专属样式。
- [ ] `packages/plugin-poker/src/styles.css` 存在并承载 Poker 专属样式。
- [ ] `apps/web/src/styles/plugins.css` 作为装配层样式入口存在。
- [ ] 删除某个插件时，开发者可以从装配层一眼找到对应样式 import。

### Plugin Manager 视觉验收

- [ ] 页面默认状态下可快速扫描每个插件的名称、分组、状态、操作按钮。
- [ ] 依赖/能力/反向依赖明细不会默认把整页撑成信息墙。
- [ ] 缺依赖、被阻塞、错误状态有明确视觉反馈。
- [ ] 窄屏下按钮、状态、明细不会横向溢出。

### Poker 页面验收

- [ ] 首页 Poker widget 与其它首页 widget 使用一致的壳层语义。
- [ ] Poker widget 在未连接时仍有清晰空状态，不是空白块。
- [ ] `PokerLobby` 具备完整布局与列表样式。
- [ ] `PokerTable` 具备最小但完整的结构化视图样式。
- [ ] `PokerSettingsPage` 具备清晰分区、按钮区、状态区与诊断区。
- [ ] 深色与浅色主题下文字、边框、操作区都可读。

### 运行语义验收

- [ ] 启用 `plugin-poker` 后，`/settings` 中出现 Poker 设置入口 section（由 `PokerSettingsEntry` 渲染）。
- [ ] 禁用 `plugin-poker` 后，`/settings` 中该入口 section 热消失。
- [ ] 启用 `plugin-poker` 后，`/settings/poker` 可访问。
- [ ] 禁用 `plugin-poker` 后，`/settings/poker` 不再可访问。
- [ ] 启用 `plugin-poker` 后，`/poker` 大厅与 home widget 按预期渲染。
- [ ] 禁用 `plugin-poker` 后，`/poker` 与 `/settings/poker` 不再保留半残页面。
- [ ] `/settings/plugins` 不再因为从 `settings.registry` 渲染而重复出现第二份。
- [ ] `/settings` 中不出现 `PluginManagerPage` 的任何控件或视觉残片。

## 实施后的长期约束

1. 后续新增业务插件页面时，默认先判断它属于：
   - 系统页
   - 业务设置页
   - 聚合页 section

   不能再把三种职责混写。

2. 后续新增插件样式时，默认放进插件自己的 `src/styles.css`，禁止直接向 `global.css` 追加业务选择器，除非该样式确实跨多个插件共享。

3. 后续新增首页 widget 时，默认复用平台 `home-widget` 壳，不重复自造样式基座。

4. 后续新增复杂业务设置页时，优先走“独立业务页”模型；只有真正简单、原子、无流程的配置项才适合注册成通用 `SettingsField`。
