# 003 settings 详情页注册模型硬切换施工单

## 目标

一次性把当前 `settings` 体系从“聚合页 + section 注册”硬切换为“独立设置详情页注册”：

```txt
settings 真值模型
  = 删除 /settings 聚合页
  = 删除 SettingsPage / SettingsField 聚合模型
  = settings.registry 只注册“设置详情页”
  = 每个插件只保留自己的 /settings/<plugin> 正式设置页

导航模型
  = 设置类入口统一由 settings.registry 产出
  = shell 不再依赖一个总的 /settings 路由做总览页
  = 面包屑不再指向不存在的 /settings

插件边界
  = plugin-settings 只保留独立系统设置页
  = plugin-woc / plugin-poker / plugin-p2pkh / plugin-vault 只保留各自详情页
  = 删除所有 settings 聚合 section、占位页、重复注册、重复渲染

语言设置
  = 从聚合页内嵌 section 迁移为独立 /settings/language

删除原则
  = 不隐藏
  = 不兼容旧聚合模型
  = 不保留旧结构空壳
  = 不留下未来可被误接回去的注册点
```

本次是硬切换，不接受下面这些中间态：

1. 保留 `/settings` 路由，但把内容清空或做跳转页。
2. 保留 `SettingsPage.tsx`、`SettingsField`、`registerField/listFields`，只是暂时“不使用”。
3. 让插件同时向 `settings.registry` 和 `route/menu.registry` 各注册一份同一个设置页。
4. 继续保留 `PokerSettingsEntry`、`Woc 在 /settings` 的重复渲染、`P2PKH 在 /settings` 的聚合页重复页面。
5. 继续让面包屑回指 `/settings`，即使该路由已经不存在。
6. 只在 UI 上删掉菜单入口，但 runtime 契约与 owner 回收仍保留旧 `settings page / field` 资源类型。

## 简述缘由

1. 当前 `/settings` 不是“设置根路由”，而是一个额外的聚合产品模型。它把 `settings.registry` 注册的 page 全部直接渲染出来，见 [packages/plugin-settings/src/SettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/SettingsPage.tsx:103)。

2. 侧边栏只读 `menu.registry`，并不会因为“存在 `/settings/poker` 路由”就自动出现菜单，见 [apps/web/src/shell/Sidebar.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/Sidebar.tsx:53)。这说明现在“设置详情页路由”和“设置总览聚合页”本来就是两套平行机制。

3. 当前 `plugin-poker` 已经显式把 `/settings/poker` 定义成唯一正式完整设置页，同时又向 `settings.registry` 注册了 `PokerSettingsEntry` 作为 `/settings` 中的轻量入口，见 [packages/plugin-poker/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/manifest.ts:266) 与 [packages/plugin-poker/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/manifest.ts:297)。这不是产品能力，而是重复导航模型。

4. 当前 `plugin-woc`、`plugin-p2pkh` 还把完整详情页本体重新塞回 `/settings` 聚合页，形成同一路由页与聚合页的双渲染，见 [packages/plugin-woc/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/manifest.ts:131) 与 [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:448)。

5. 当前 `plugin-settings` 自己既注册 `/settings`，又注册 `/settings/plugins`，而 `/settings/plugins` 的面包屑还回指 `/settings`，见 [packages/plugin-settings/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/manifest.ts:148) 与 [packages/plugin-settings/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/manifest.ts:196)。如果决定删除 `/settings`，就必须把这个信息架构一起改掉，不能只删一个页面。

6. 如果继续保留 `SettingsField` / `SettingsPage` 聚合契约，即使当前 UI 不渲染，后续任何插件都还能重新把 section 接回 `/settings` 模型。要“删除干净”，必须从契约、registry、owner 回收、测试、业务插件注册点一起删除。

## 硬切换结论

本次统一采用下面这套明确架构：

```txt
settings.registry
  = 只注册设置详情页
  = 每条记录自带 path / label / component / order / icon / visibleWhen
  = shell 用它直接生成“设置分组菜单 + 设置类路由”

设置页信息架构
  /settings/language
    = 语言设置
    = 原 LanguageSection 独立成正式页面

  /settings/plugins
    = 系统级插件管理页
    = 由 plugin-settings 注册

  /settings/vault
    = Key 管理页

  /settings/p2pkh
    = P2PKH 设置页

  /settings/woc
    = WOC 设置页

  /settings/poker
    = Poker 设置页

删除物
  = /settings
  = SettingsPage.tsx
  = SettingsField
  = registerField / listFields / unregisterField
  = registerPage / listPages / unregisterPage 旧语义
  = PokerSettingsEntry
  = 所有 settings 聚合 section
```

本次切换后，必须满足下面的不变量：

1. 应用内不存在 `/settings` 路由。
2. 应用内不存在“设置聚合页”组件和任何 section 聚合逻辑。
3. `settings.registry` 不再表达“要把某个组件塞进 `/settings` 页面里”，只表达“这是一个设置详情页”。
4. 任何插件若要提供设置，只能注册自己的独立详情页，不能注册聚合页 section。
5. `plugin-poker` 只保留 `/settings/poker`，不再保留任何 `PokerSettingsEntry` 或其它聚合入口。
6. `plugin-woc`、`plugin-p2pkh` 不再把完整详情页组件重复注册进 `/settings`。
7. `plugin-settings` 不再注册总的“设置”菜单；只注册真实存在的详情页，如“语言”“插件”。
8. 面包屑中的“设置”不再是一个可点击的 `/settings` 链接，而是一个不可点击的分类节点。
9. owner 回收、host 快照 diff、测试夹具中都不再出现旧 `settingsPages/settingsFields` 聚合资源分类。
10. 任何旧 hash 路由或安全跳转如果还写死 `/settings`，都必须迁移到新的真实页面。

## 不能怎么做

1. 不能保留一个空白 `/settings` 页面作为“以后也许有用”的兜底。不存在的产品模型就必须删除。

2. 不能把 `settings.registry` 改名不改义，例如仍然注册 `component + fields`，只是 shell 不再渲染聚合页。那只是把旧债藏起来。

3. 不能让一个设置页同时：
   - 在 `settings.registry` 注册
   - 又在 `route.registry` 注册同一路由
   - 又在 `menu.registry` 注册同一个菜单

   同一路由的真值只能有一份，否则 owner 回收、排序、菜单状态、禁用插件后的残留都容易错。

4. 不能保留 `SettingsField` 契约仅供“未来可能还要用”。只要保留，它就还会长回来。

5. 不能保留 `PokerSettingsEntry`、`WocSettingsPage` 在聚合页里的第二份挂载，再靠文案解释“这是入口不是正文”。既然总聚合页已经删除，入口模型就不存在了。

6. 不能让面包屑继续把“设置”做成 `/settings` 可点击链接。目标路由不存在时，继续保留链接是错误导航。

7. 不能只修业务插件，不修 runtime / contracts / host owner / tests。那样下一个插件还会按旧模型继续注册。

8. 不能为了省改动而把 `settings.registry` 继续暴露成“给 plugin-settings 内部专用”的私有逻辑。它是平台契约，既然保留，就必须语义正确且可被后续插件直接使用。

9. 不能把 `language` 丢在某个随机业务页里临时安置。语言设置是系统级详情页，必须有稳定路由。

10. 不能用“CSS 隐藏”“不渲染菜单”“不在首页出现”当作删除。真值、契约、注册、测试都必须一起清理。

## 应该怎么做

### 一、把 settings 契约改成“详情页注册”

`packages/contracts/src/settings.ts` 与 `packages/contracts/src/registries.ts` 必须重写语义：

```txt
旧模型
  SettingsPage
    = label / description / fields / component / order
  SettingsField
    = 通用字段模型
  SettingsRegistry
    = registerPage / registerField / listPages / listFields

新模型
  SettingsRoute（命名可按实现定）
    = id
    = path
    = label
    = description?          // 可选，仅页内元数据
    = component
    = order
    = icon?
    = visibleWhen?

  SettingsRegistry
    = register(route)
    = unregister(id)
    = list()
    = byId(id)
    = byPath(path)
```

设计缘由：

1. 设置详情页本质上就是一类受约束的应用路由，不是 section 拼装页。
2. 之所以不直接让所有插件继续各自碰 `route.registry + menu.registry`，是因为设置页需要平台统一的“settings 分组”语义。
3. `settings.registry` 继续保留，但它的职责收缩为“设置类详情页注册表”，不再承担页面拼装。

### 二、shell 改为直接消费 settings.registry

应用壳层需要调整为：

```txt
路由渲染
  host.routes
  + host.settings
  一起参与匹配

侧边栏 settings 分组
  不再来自 menu.settings
  改为读取 host.settings.list()
  统一渲染为 settings 分组下的菜单项

面包屑
  业务插件的 settings breadcrumb
  第一段统一改成不可点击“设置”
```

具体要求：

1. `RouteRenderer` 需要把 `settings.registry` 的详情页纳入路由匹配。
2. `Sidebar` 需要停止依赖 `menu.registry` 里的 settings 组来表现设置页，而是直接读取 `host.settings`。
3. `Sidebar` 中如果仍保留 `menu.registry` 的其它分组，settings 分组必须从普通菜单注册中剥离，避免重复来源。
4. 如果存在“锁定状态下隐藏设置页”的策略，应该通过 `visibleWhen` 留在 `settings.registry` 上，而不是再额外复制一层 menu 可见性判断。

### 三、删除 /settings 聚合页及其全部遗留

这部分必须彻底删除：

1. [packages/plugin-settings/src/SettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/SettingsPage.tsx)
2. `LanguageSection` 在聚合页中的嵌入用法
3. `plugin-settings` 中的 `/settings` route 注册
4. `menu.settings` 总菜单
5. 所有面包屑里指向 `/settings` 的可点击链接
6. 所有关于“来自 settings.registry 的设置项”的 i18n 文案
7. 所有把完整设置页重新注册为 `/settings` section 的插件逻辑

注意：

1. 不是“保留 `SettingsPage.tsx` 但不 export”。
2. 不是“保留 `/settings` 但改成 redirect 到 `/settings/language`”。
3. 不是“保留 settings.page route id，方便旧代码继续引用”。

这些都会留下未来再次长回聚合页的尾巴，必须一起删除。

### 四、语言设置独立成正式详情页

删除 `/settings` 后，语言设置不能消失，必须迁成真实页面：

```txt
plugin-settings
  /settings/language
    = LanguageSettingsPage
    = 复用现有 LanguageSection 内的核心交互
    = 独立 PageHeader / 独立说明文案
```

要求：

1. `LanguageSection` 若适合作为内部表单块可保留，但对外以 `LanguageSettingsPage` 呈现。
2. `plugin-settings` 至少注册两个 settings 详情页：
   - `/settings/language`
   - `/settings/plugins`
3. 如果语言页和插件页都属于系统级设置，则都通过 `settings.registry` 注册，而不是一个走 `settings.registry`、一个走 `route/menu.registry`。

### 五、各插件迁移到新的详情页注册

#### 1. plugin-settings

保留：

1. `PluginManagerPage`
2. `LanguageSection` 的核心逻辑
3. settings 相关样式文件

删除/迁移：

1. `/settings` 路由
2. `menu.settings`
3. 聚合页 i18n 文案
4. 指向 `/settings` 的 breadcrumb link

新增/改造：

1. `LanguageSettingsPage.tsx`
2. `settings.registry.register(...)` 注册：
   - `settings.language`
   - `settings.plugins`

#### 2. plugin-vault

保留：

1. `/settings/vault`
2. Key 管理页本体

迁移：

1. 不再向 `route.registry` / `menu.registry` 注册该设置页
2. 改为向新的 `settings.registry` 注册 `vault.settings`
3. breadcrumb 第一段改为不可点击“设置”

#### 3. plugin-woc

保留：

1. `/settings/woc`
2. `WocSettingsPage`

删除：

1. `settings.registerPage({ component: WocSettingsPage })` 旧聚合注册
2. 任何依赖 `/settings` 聚合页重复展示 WOC 设置的设计

迁移：

1. 改为向新的 `settings.registry` 注册 `woc.settings`
2. 如果之前有 `menu.woc`，应迁到 settings.registry 真值，不再保留第二份菜单真值

#### 4. plugin-p2pkh

保留：

1. `/settings/p2pkh`
2. `P2pkhSettingsPage`

删除：

1. 旧 `settings.registerPage({ component: P2pkhSettingsPage })`

迁移：

1. 改为向新的 `settings.registry` 注册 `p2pkh.settings`
2. breadcrumb 第一段改为不可点击“设置”

#### 5. plugin-poker

保留：

1. `/settings/poker`
2. `PokerSettingsPage`

必须删除：

1. [packages/plugin-poker/src/PokerSettingsEntry.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerSettingsEntry.tsx)
2. manifest 中所有关于“轻量入口 section”的设计注释与注册逻辑
3. 聚合页专用文案，例如 `poker.entry.*`
4. 聚合页专用样式，例如 `poker-settings-entry*`

迁移：

1. 改为向新的 `settings.registry` 直接注册 `poker.settings`
2. 不再向 `route.registry` / `menu.registry` 重复注册该设置页
3. breadcrumb 第一段改为不可点击“设置”

### 六、runtime / owner / 测试同步收口

这部分不能漏，否则旧模型仍然残留在宿主内部。

必须处理：

1. `packages/runtime/src/registries/settingsRegistry.ts`
   - 从 page/field 双表改为单一详情页注册表
2. `packages/runtime/src/pluginOwnership.ts`
   - 删除 `settingsPages`
   - 删除 `settingsFields`
   - 收敛成单一 `settingsRoutes`（命名按实现）
3. `packages/runtime/src/createPluginHost.ts`
   - snapshot / diff / purgeOwnership 改成新的 settings 资源类型
   - `safePath` 缺省值从 `/settings/plugins` 继续保留或改名时，要确保指向真实存在的设置详情页
4. 所有 host / plugin manager 测试
   - 删除对 `registerField/listFields` 的断言
   - 删除 `/settings` 相关断言
   - 补上 settings 详情页注册、禁用插件后 settings 详情页消失的断言
5. contracts / runtime 的导出面
   - 删除旧类型导出
   - 更新所有 import

## 特殊情况怎么办

### 一、旧 hash 路由或历史链接还指向 /settings

处理原则：

1. 不恢复 `/settings` 页面。
2. 旧入口若必须兼容，只允许在 hash/path 迁移层做一次性改写。
3. 改写目标必须是一个真实存在的新页面。

推荐落点：

```txt
#/settings           -> /settings/language
/settings            -> /settings/language   // 如果存在历史入口修正层
```

理由：

1. 语言页是最稳定的系统级设置页。
2. 不能把旧 `/settings` 迁到业务插件页，例如 `/settings/poker`，否则默认落点会被插件启停影响。

### 二、safePath 或禁用当前插件后的跳离目标

如果当前打开的是一个将被禁用的设置页，例如 `/settings/poker`，插件卸载前必须先跳离。

处理原则：

1. 默认安全页必须是真实存在、稳定、不可被普通业务插件卸载的设置页。
2. 推荐保持 `/settings/plugins` 作为 `safePath`。
3. 若 `plugin-settings` 被定义为不可禁用，则这个目标可靠；若未来允许禁用 `plugin-settings`，则需要另定核心安全页，但本次不扩展。

### 三、某插件同时想注册普通业务页和设置页

允许，但必须分清注册面：

1. 普通业务页继续进 `route.registry`
2. 设置详情页只进 `settings.registry`
3. 不允许同一路径同时出现在两边

### 四、某插件没有设置页

不需要强行补。只有真正提供设置详情页的插件才注册到 `settings.registry`。

### 五、插件禁用后的设置导航残留

必须由 owner 回收保证：

1. settings 菜单项消失
2. settings 路由不可达
3. breadcrumb provider 一并消失

不能依赖 shell 手工过滤“已禁用插件 id 列表”。

## 文件级施工范围

### 一、contracts

1. [packages/contracts/src/settings.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/settings.ts)
   - 删除 `SettingsField`
   - 删除旧 `SettingsPage`
   - 定义新的 settings 详情页契约

2. [packages/contracts/src/registries.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/registries.ts)
   - 改写 `SettingsRegistry` 接口

3. [packages/contracts/src/index.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/index.ts)
   - 更新导出面，移除旧聚合类型导出

### 二、runtime

4. [packages/runtime/src/registries/settingsRegistry.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/registries/settingsRegistry.ts)
   - 改成单一 settings 详情页注册表实现

5. [packages/runtime/src/pluginOwnership.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/pluginOwnership.ts)
   - 删除旧 `settingsPages/settingsFields`
   - 改为新的单一 settings 资源记录

6. [packages/runtime/src/createPluginHost.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/createPluginHost.ts)
   - snapshot / diff / purgeOwnership 全量收口
   - 确保 settings 详情页与禁用插件后的回收一致

7. [packages/runtime/src/createPluginHost.test.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/createPluginHost.test.ts)
   - 改写为新的 settings registry 测试语义

8. [packages/runtime/src/pluginManager.test.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/pluginManager.test.ts)
   - 移除 `/settings` 聚合前提
   - 补新的详情页注册前提

### 三、web shell

9. [apps/web/src/shell/Sidebar.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/Sidebar.tsx)
   - settings 分组改为直接读 `host.settings`
   - 避免与 `menu.registry` 的 settings 组重复

10. [apps/web/src/shell/RouteRenderer.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/RouteRenderer.tsx)
   - settings 详情页纳入路由匹配

11. [apps/web/src/shell/Breadcrumbs.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/Breadcrumbs.tsx)
   - 逻辑本身未必需要大改，但需要验证不再依赖 `/settings` 可点击父链接

12. [apps/web/src/shell/legacyHashRoute.ts](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/legacyHashRoute.ts)
   - 迁移旧 `/settings` 入口到新的真实页面

13. [apps/web/src/shell/legacyHashRoute.test.ts](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/legacyHashRoute.test.ts)
   - 同步更新断言

### 四、plugin-settings

14. [packages/plugin-settings/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/manifest.ts)
   - 删除 `/settings`
   - 删除 `menu.settings`
   - 改为注册 `/settings/language` 与 `/settings/plugins`

15. [packages/plugin-settings/src/SettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/SettingsPage.tsx)
   - 删除文件

16. [packages/plugin-settings/src/LanguageSection.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/LanguageSection.tsx)
   - 提炼/复用为独立语言设置页内部块

17. 新增 `packages/plugin-settings/src/LanguageSettingsPage.tsx`
   - 语言设置正式详情页

18. [packages/plugin-settings/src/index.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/index.ts)
   - 删除 `SettingsPage` 导出
   - 增加语言设置页导出（若需要）

19. [packages/plugin-settings/src/styles.css](/home/david/Workspaces/keymaster.cc/packages/plugin-settings/src/styles.css)
   - 删除聚合页相关样式
   - 补语言设置页样式

### 五、业务插件

20. [packages/plugin-vault/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/manifest.ts)
   - settings 页改为通过新的 settings.registry 注册
   - breadcrumb 不再跳 `/settings`

21. [packages/plugin-woc/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/manifest.ts)
   - 删除旧聚合 page 注册
   - 迁到 settings 详情页注册

22. [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts)
   - 删除旧聚合 page 注册
   - 迁到 settings 详情页注册

23. [packages/plugin-poker/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/manifest.ts)
   - 删除 `PokerSettingsEntry` 相关注册与文案
   - 迁到 settings 详情页注册

24. [packages/plugin-poker/src/PokerSettingsEntry.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerSettingsEntry.tsx)
   - 删除文件

25. [packages/plugin-poker/src/styles.css](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/styles.css)
   - 删除 `poker-settings-entry*` 聚合入口样式

### 六、其它收尾

26. `rg -n "/settings\\b|SettingsPage|SettingsField|registerField\\(|registerPage\\(" packages apps`
   - 全仓搜索残留，逐项清空

27. 所有引用 `/settings` 的 breadcrumb/i18n/comment/test/doc
   - 必须同步修正

## 最终验收清单

### 一、结构验收

1. 代码库中不存在 `/settings` 路由真值。
2. 代码库中不存在 `SettingsPage.tsx` 聚合页实现。
3. 代码库中不存在 `SettingsField` 类型、`registerField`、`listFields`、`unregisterField`。
4. 代码库中不存在旧 `settings.registerPage(...)` 聚合语义。
5. 代码库中不存在 `PokerSettingsEntry.tsx`。

### 二、导航验收

6. 侧边栏 settings 分组中只出现真实存在的设置详情页。
7. 点击 settings 分组中的任一条目，都直接进入对应详情页，不经过总览页。
8. 不存在“设置”总菜单点击后进入 `/settings` 的行为。
9. `/settings/language`、`/settings/plugins`、`/settings/vault`、`/settings/p2pkh`、`/settings/woc`、`/settings/poker` 都能独立访问。

### 三、业务页验收

10. `Poker` 只有 `/settings/poker` 一份正式设置页，不再存在聚合入口页。
11. `WOC` 只有 `/settings/woc` 一份正式设置页，不再在任何总设置页重复渲染。
12. `P2PKH` 只有 `/settings/p2pkh` 一份正式设置页，不再在任何总设置页重复渲染。
13. `Vault` 保持 `/settings/vault`，且入口来源与其它设置页一致。
14. 语言设置已迁到独立 `/settings/language`，功能不丢失。
15. 插件管理页保留在 `/settings/plugins`，且仍可正常启停插件。

### 四、运行时验收

16. 禁用 `plugin-poker` 后：
   - `/settings/poker` 不可达
   - settings 分组中不再出现 Poker
   - Poker breadcrumb provider 一并消失

17. 禁用 `plugin-woc` 后：
   - `/settings/woc` 不可达
   - settings 分组中不再出现 WOC

18. 禁用 `plugin-p2pkh` 后：
   - `/settings/p2pkh` 不可达
   - settings 分组中不再出现 P2PKH 设置

19. 若当前正停留在将被禁用插件的设置页，宿主会先跳到安全页，再执行卸载，不出现渲染崩溃。

### 五、兼容验收

20. 历史 `#/settings` 或其它旧 `/settings` 入口会迁移到一个真实存在的新设置页，不出现 404 死链。
21. 所有 settings breadcrumb 第一段显示“设置”，但不再指向不存在的 `/settings`。
22. 仓库全文搜索不再出现把 `/settings` 当作真实可访问页面的业务逻辑。

### 六、清理验收

23. 仓库全文搜索不再出现：
   - `PokerSettingsEntry`
   - `settings.field`
   - `registerField(`
   - `listFields(`
   - `settings.page.title`
   - `settings.page.description`

24. 插件注释、施工单、测试描述中，不再把 `settings.registry` 描述为“聚合页 section 注册表”。
25. 所有删除项都是真删，不是注释掉、不 export、或运行时绕开。

## 一次性迭代顺序

1. 先改 contracts 与 runtime 的 `settings` 契约和 owner 模型。
2. 再改 shell，让 settings 分组与路由直接消费新的 `settings.registry`。
3. 再删除 `plugin-settings` 的 `/settings` 聚合页，并补 `LanguageSettingsPage`。
4. 再逐个迁移 `vault / woc / p2pkh / poker` 到新的 settings 详情页注册。
5. 最后全仓清理 `/settings`、聚合注释、测试、legacy hash、死代码残留。

顺序不能反过来。原因很简单：

1. 先删插件侧聚合注册而不改 runtime/shell，会让 settings 导航断层。
2. 先改 shell 而不改 contracts/runtime，会造成新旧两套 settings 资源并存。
3. 先局部迁一个插件，例如只迁 `poker`，会把项目继续留在“双模型混跑”状态。

本次必须一次切穿，不保留过渡层。
