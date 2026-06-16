# 001 运行时插件热卸载 + 系统级插件管理硬切换施工单

## 目标

一次性把当前插件宿主升级成真正支持**运行时热启用 / 热卸载**的系统，并补齐系统级插件管理 UI：

```txt
系统级
  = 新增插件管理 UI
  = 用户通过 UI 启用 / 禁用插件
  = 启停结果立即生效，不靠刷新页面
  = 启停状态全局持久化，不走 key-scoped

插件元数据
  = 依赖关系由开发时配置
  = 元数据放在各插件目录里
  = 不引入中心化插件目录真值
  = 插件目录对开发者保持移除友好

依赖治理
  = UI 显示“本插件依赖谁 / 被谁依赖”
  = 不做自动依赖关联 enable / disable
  = 但若存在启用中的反向依赖，禁止 disable

宿主运行时
  = capability 可撤销
  = registry 可注销
  = plugin setup 必须有 teardown
  = React 层能感知 host 运行时变化
```

本次是硬切换，不接受下面这些中间态：

1. 先做“插件管理 UI”，但 disable 只是隐藏菜单。
2. 先做“刷新后生效”，热卸载后面再说。
3. 先只给 `plugin-poker` 加开关，runtime 生命周期后面再补。
4. 先手工维护一个中心化插件目录表，后面再迁回插件目录。

## 简述缘由

1. 当前 runtime 的前提是“插件在 React 挂载前全部注册完，挂载后不再变化”。这不是猜测，而是现代码显式写出来的：
   - `useRegistry()` 明确假定 host 不会在运行期变化，见 [useRegistry.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/react/useRegistry.ts:1)
   - `PluginHost` 只有 `register/registerAll`，没有 `unregister/disable/enable`，见 [createPluginHost.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/createPluginHost.ts:36)

2. 当前所有 registry 与 capability 都只有“注册”没有“撤销”：
   - capability 没有 `revoke`，见 [capabilityRegistry.ts](/home/david/Workspaces/keymaster.cc/packages/runtime/src/capabilityRegistry.ts:7)
   - route/menu/settings/home/breadcrumb/asset/transfer/importer/topbar 全都没有 `unregister`

3. 因此，如果现在直接做“运行时 disable 某插件”，结果只会是：

```txt
route 可能还在
menu 可能还在
capability 可能还在
messageBus 订阅可能还在
interval / websocket / actor 可能还在跑
```

这不是热卸载，而是脏状态。

4. 你要求“依赖关系由开发时配置，元数据放在插件目录里，对开发者移除友好”。这意味着不能再引入一个新的中心化插件目录真值，否则插件目录删掉后还要额外回收中心表，违背移除友好。

5. 当前旧插件只声明了“依赖哪些 capability”，但**没有统一声明自己提供哪些 capability**。因此 UI 现在无法可靠回答：

```txt
这个插件被谁依赖？
禁用它会影响谁？
哪些依赖是 runtime 内建 capability，哪些是另一个 plugin 提供的？
```

6. `plugin-poker` 已经证明“系统级开关”和“业务配置”必须分层：
   - 是否启用插件，是宿主级问题
   - `proxyEndpoint`、双平面 announce、fallback 策略，是插件业务设置

## 硬切换结论

本次统一采用下面这套明确架构：

```txt
插件目录
  = 每个插件的 manifest 自带元数据真值
  = 声明：
      - 依赖 capability
      - 提供 capability
      - 默认启用状态
      - 是否允许禁用
      - 插件类别（core / platform / business）

runtime
  = 支持 register / enable / disable / unregister
  = setup 返回 teardown
  = 记录每个 plugin 运行期“拥有”的 capability / route / menu / settings / home / ...
  = 运行时热卸载时按 owner 回收
  = 暴露 version + subscribe 给 React 层

settings
  = 新增系统级插件管理页面
  = 显示启用状态、依赖、反向依赖、可否禁用、查看设置入口
  = 不自动联动 enable / disable

apps/web
  = bootstrap 仍负责引入 manifest 顺序
  = 但不再是真值依赖图
  = 首屏按系统级配置决定初始启用集合
```

本次切换后，必须满足下面的不变量：

1. `disable plugin` 的真实语义必须是**实际卸载该插件在当前 host 上的运行期痕迹**，不是只隐藏 route/menu。
2. 插件启用状态必须是**全局配置**，不能存进 key-scoped storage。
3. 插件依赖图的真值必须来自**插件目录内 manifest 元数据**，不能再维护一份中心化插件目录表。
4. UI 展示的“被谁依赖”必须从 `providesCapabilities + dependencies` 推导，不允许手写反向依赖。
5. 不允许自动帮用户启用依赖，也不允许自动级联禁用下游。
6. 如果某插件存在启用中的反向依赖，则 disable 按钮必须被阻止，并清楚显示阻塞者。
7. 插件热卸载时，如果当前页面属于该插件，必须先导航离开再卸载。
8. 插件 teardown 必须是幂等、可重复调用、可容忍部分资源已经被清理。
9. 旧插件的依赖补录与 teardown 补录必须和宿主改造在同一迭代内完成，不能把“旧插件先假装支持热卸载”留到以后。
10. `plugin-poker` 仍然保持一体代码；系统级插件管理只决定它是否装载，不拆协议真值层。

## 不能怎么做

1. 不能把“禁用插件”实现成只隐藏菜单、只隐藏页面、只把 capability 置空。那不叫禁用。

2. 不能新建一个中心化 `plugins-catalog.ts` 作为插件元数据真值。这样插件目录移除后还会残留第二张真值表。

3. 不能只补 `plugin-poker` 的启停，而忽略旧插件。宿主一旦进入热卸载模型，所有已装载插件都必须能被统一管理，哪怕其中一部分最终显示为 `canDisable=false`。

4. 不能只靠 runtime 启动时“扫一遍 `ctx.provide(...)`”推断 capability 提供者，然后把这个扫描结果当长期真值。扫描可以做校验和 owner 捕获，但不能代替开发时元数据声明。

5. 不能把 runtime 内建 capability 当成普通插件来管理：
   - `route.registry`
   - `menu.registry`
   - `settings.registry`
   - `home.registry`
   - `asset.registry`
   - `transfer.registry`
   - `importer.registry`
   - `command.registry`
   - `topbar.registry`
   - `runtime.messageBus`
   - `i18n.service`

6. 不能在当前页面属于目标插件时，直接先 `revoke capability` 再让 React 继续渲染。那会立刻把 `useCapability()` 打崩。

7. 不能假设“逻辑上常一起出现”的两个插件就一定存在技术依赖。比如 `plugin-p2pkh` 与 `plugin-transfer` 的关系，若没有 capability 依赖声明，就不能凭产品直觉强行阻断 disable。

8. 不能忽略长期资源清理：
   - `messageBus.subscribe(...)`
   - `messageBus.handle(...)`
   - `setInterval / setTimeout`
   - `window/document.addEventListener(...)`
   - `WebSocket`
   - actor/service 的 `dispose()`

9. 不能把系统级插件启停配置做成 key-scoped。那会导致“切换 active key 改变启用插件集合”的错误语义。

10. 不能要求用户“修改代码里的布尔开关”来控制插件启停。本次目标就是系统级 UI 配置。

## 应该怎么做

### 一、元数据真值模型

插件元数据不另开中心目录，直接落在每个插件自己的 `manifest.ts` 内，扩展 `PluginManifest`：

```txt
PluginManifest
  新增：
    meta.kind
      = core | platform | business

    meta.defaultEnabled
      = true | false

    meta.canDisable
      = true | false

    meta.providesCapabilities
      = string[]

    meta.displayGroup
      = core | platform | business | import | experimental
      （仅 UI 分组用，可选）
```

`dependencies` 继续表示“我需要哪些 capability”。

`providesCapabilities` 明确表示“我声明提供哪些 capability”。

这两张表一起，才构成系统级依赖图的真值。

### 二、setup / teardown 生命周期

当前 `PluginManifest.setup(ctx)` 只能注册，不能清理。必须改成下面语义：

```txt
setup(ctx)
  => void
  => teardown function
  => Promise<void | teardown function>
```

其中 teardown 的职责是：

1. 停止后台任务
2. 取消订阅
3. 关闭 actor / websocket / broadcast channel
4. 释放插件内部 service 持有的资源

host 在 disable / unregister 时必须调用 teardown。

### 三、host 运行时生命周期

`PluginHost` 必须新增下面这些能力：

```txt
installed()
manifests()
state(pluginId)
graph()
enable(pluginId)
disable(pluginId)
unregister(pluginId)
version()
subscribe(listener)
```

其中：

1. `enable(pluginId)`
   - 预检查依赖 capability 是否满足
   - 注册 i18n 资源
   - 执行 setup
   - 捕获 owner 资源
   - 记录 teardown
   - 标记 enabled
   - 递增 version

2. `disable(pluginId)`
   - 先查启用中的反向依赖
   - 若存在则拒绝
   - 若当前路由属于该插件，先导航走
   - 调 teardown
   - 注销其 owner 资源
   - revoke 其 capability
   - 标记 disabled
   - 递增 version

3. `unregister(pluginId)`
   - 给 host 内部用
   - 等价于彻底从当前运行时移除该插件实例

### 四、owner 捕获与回收

不要求旧插件手写“每个 route/menu 谁注册的”。那样侵入太大。

正确做法是：host 在每次 `setup(plugin)` 前后做快照 diff，把新增资源归属到当前 plugin：

```txt
setup 前快照
  capability keys
  route ids
  menu ids
  breadcrumb ids
  settings page ids
  settings field ids
  home widget ids
  command ids
  importer ids
  transfer provider ids
  asset provider ids
  topbar ids

执行 setup

setup 后快照
  做 diff
  新增的全部记到 plugin ownership record
```

disable 时按 ownership record 反向注销。

这条设计非常关键，因为它保证：

1. 对旧插件侵入最小
2. 元数据仍然以插件目录内 manifest 为真值
3. 删除插件目录不会额外残留中心化 owner 表代码

### 五、registry 与 capability 的基础设施补齐

下面这些模块都必须支持撤销：

1. capability registry
   - `revoke(key)`

2. route registry
   - `unregister(id)`

3. menu registry
   - `unregister(id)`

4. breadcrumb registry
   - `unregister(id)`

5. settings registry
   - `unregisterPage(id)`
   - `unregisterField(id)`

6. home registry
   - `unregister(id)`

7. command registry
   - `unregister(id)`

8. importer registry
   - `unregister(id)`

9. transfer registry
   - `unregister(id)`

10. asset registry
   - `unregister(id)`

11. topbar registry
   - `unregister(id)`

12. i18n service
   - `unregisterResources(pluginId)` 或等价能力

### 六、React 层的动态感知

runtime 进入热卸载模型后，React 层不能再假定 host 永远不变。

必须改成：

1. `PluginHostProvider` 暴露可订阅的 host
2. `useRegistry()` 基于 `host.version + host.subscribe()` 重新取快照
3. `useCapability()` / `useHasCapability()` 也要跟随 host 变化重新求值

否则插件虽然被卸载了，页面不会重新渲染，最终仍是脏 UI。

### 七、系统级插件启停配置

启停配置必须是全局的，不依赖 active key。

建议单独放一个 runtime 级全局配置存储：

```txt
plugin runtime config
  pluginId -> enabled | disabled
```

要求：

1. 首屏 bootstrap 读取它
2. 运行时 enable / disable 时立即写回
3. 删除了某个插件目录后，旧配置里残留的 pluginId 不能导致崩溃
4. 最多只能影响“是否装载”，不能影响业务 settings

### 八、系统级插件管理 UI

放在 `plugin-settings` 里新增一个系统页面，例如：

```txt
/settings/plugins
```

每个插件必须展示：

1. 名称
2. 描述
3. 当前状态
   - enabled
   - disabled
   - blocked
   - error-disabled（若 teardown 出错但卸载已完成）
4. 是否允许禁用
5. 该插件提供的 capability
6. 该插件依赖的 capability
7. 反向依赖它的启用中插件列表
8. 操作按钮
   - 启用
   - 禁用
   - 查看设置（若该插件有 settings 页）

必须遵守下面的交互规则：

1. 不自动启用依赖
2. 不自动级联禁用
3. 若禁用被阻止，UI 必须明确显示阻塞者
4. 若插件没有 settings 页，“查看设置”按钮隐藏或置灰

### 九、旧插件依赖补录基线

下面这张表是**从当前代码真实扫描出的初始补录基线**，施工时必须把它落实到各插件 manifest 元数据里。

#### 1. 提供 capability 的旧插件

```txt
plugin-vault
  provides:
    - vault.service
    - keyspace.service

plugin-background
  provides:
    - background.registry
    - background.service

plugin-woc
  provides:
    - woc.service

plugin-key-import
  provides:
    - key-import.platform

plugin-contacts
  provides:
    - contacts.service

plugin-p2pkh
  provides:
    - p2pkh.service

plugin-poker
  provides:
    - poker.service
```

#### 2. 依赖 capability 的关键业务插件

```txt
plugin-p2pkh
  depends:
    - vault.service
    - keyspace.service
    - woc.service
    - background.registry
    - background.service
    - route.registry
    - menu.registry
    - settings.registry
    - home.registry
    - asset.registry
    - transfer.registry
    - breadcrumb.registry

plugin-poker
  depends:
    - vault.service
    - keyspace.service
    - runtime.messageBus
    - i18n.service
    - route.registry
    - menu.registry
    - settings.registry
    - home.registry
    - breadcrumb.registry

plugin-contacts
  depends:
    - keyspace.service

plugin-key-import
  depends:
    - vault.service
    - importer.registry

plugin-woc
  depends:
    - runtime.messageBus
    - route.registry
    - menu.registry
    - settings.registry
    - breadcrumb.registry

plugin-background
  depends:
    - topbar.registry
```

#### 3. 必须明确写进施工单的一个原则

```txt
依赖图只按“显式 capability 真值”计算
不按“产品上通常一起出现”计算
```

例如：

1. `plugin-p2pkh` 并**不**通过 capability 依赖 `plugin-transfer`
2. `plugin-importer-wif/hex/json-file` 并**不**通过 capability 依赖 `plugin-key-import`

如果后续产品认为这些是“隐式业务依赖”，那也必须回到 manifest 元数据里显式声明，而不是让 UI 或宿主猜。

### 十、旧插件 teardown 补录基线

这部分不是可选项，必须和宿主改造一起做。

#### 1. 已有 dispose 基础，应该直接接入 teardown

```txt
plugin-woc
  - service 已有 dispose()

plugin-background
  - service 已有 dispose()
```

#### 2. 需要补正式 teardown / dispose 的插件

```txt
plugin-poker
  - 需要 service.dispose()
  - 不能只靠 disconnect()
  - 还要清理 vault / keyspace / status 监听器与 reconnect timer

plugin-p2pkh
  - 需要统一回收 messageBus.subscribe(...)
  - 需要回收 provider 侧订阅
  - 需要把 service / provider 生命周期收拢成 teardown

plugin-contacts
  - 需要审计是否存在长生命周期句柄；没有则 teardown 可为空实现

plugin-key-import / importers / assets / transfer / home / settings
  - 主要依赖 registry 注销
  - 若没有长期资源，teardown 可为空实现
```

#### 3. 当前建议的初始 `canDisable`

为了保持硬切换后的行为可控，建议下面这组初始策略：

```txt
canDisable = false
  - plugin-vault
  - plugin-settings
  - plugin-home

canDisable = true
  - plugin-poker
  - plugin-woc
  - plugin-background
  - plugin-p2pkh
  - plugin-contacts
  - plugin-transfer
  - plugin-assets
  - plugin-key-import
  - plugin-importer-wif
  - plugin-importer-hex
  - plugin-importer-json-file
```

注意：

1. 这不是“分步骤上线”
2. 这是硬切换中的**初始产品策略**
3. 是否允许禁用由插件 manifest 明确声明，不是 host 猜

## 特殊情况提前约定

### 情况 1：用户正在被禁用插件的页面里

处理原则：

```txt
先安全跳走
再热卸载
```

应该这样做：

1. host 先判断当前 route 是否归属于目标 plugin
2. 若是，则先导航到系统稳定页，例如 `/settings/plugins`
3. 确认 React 已离开目标 plugin 页面后，再执行 disable

不能这样做：

1. 不能先 revoke capability 再让旧页面继续 render
2. 不能期待组件自己吞掉 `useCapability()` 抛错

### 情况 2：目标插件当前被启用中的其他插件依赖

处理原则：

```txt
阻止禁用
不自动联动
```

应该这样做：

1. host 计算当前反向依赖集合
2. 若非空，则 `disable(pluginId)` 直接失败
3. UI 显示：
   - 被谁依赖
   - 依赖原因（capability）

不能这样做：

1. 不能自动把下游插件一起 disable
2. 不能偷偷移除 capability 然后让下游插件进入半死状态

### 情况 3：插件没有自定义 capability，但有产品上的关联

处理原则：

```txt
只认显式 capability 依赖
不认隐式产品联想
```

应该这样做：

1. 若确实需要阻断，就把关系补进 manifest 元数据
2. 若没有补，就允许用户自行决定

不能这样做：

1. 不能在 UI 层手写“这个插件大概和那个插件有关，所以先别让他关”

### 情况 4：teardown 过程中抛错

处理原则：

```txt
宿主完成卸载
状态记录错误
```

应该这样做：

1. host 捕获 teardown 错误
2. 仍继续执行 registry/capability 的回收
3. 把插件状态记为 `error-disabled`
4. UI 明确显示该错误并建议刷新

不能这样做：

1. 不能因为 teardown 报错就中断到一半，留下半卸载状态
2. 不能吞错不报

### 情况 5：多标签页同时开着，一个标签禁用了插件

处理原则：

```txt
全局配置广播
每个 host 本地跟随
```

应该这样做：

1. 全局插件配置存储变化后，当前标签立即热卸载
2. 其他标签通过存储广播事件收到变更后，也执行同样的 enable/disable

不能这样做：

1. 不能只把配置写盘，不同步当前标签
2. 不能让不同标签页长期保持不同插件启用集合

### 情况 6：某个插件代码已经从仓库删除，但浏览器里还有旧启用配置

处理原则：

```txt
忽略残留
不崩启动
```

应该这样做：

1. bootstrap 只认当前实际 import 进来的 manifest
2. 对不存在的 pluginId 残留配置直接忽略

不能这样做：

1. 不能因为旧配置里还有 `plugin-x` 就把应用启动打崩

## 文件级施工范围

### 一、contracts / runtime 契约层

1. `packages/contracts/src/plugin.ts`
   - 扩展 `PluginManifest`
   - 增加插件元数据字段
   - 增加 setup 返回 teardown 的生命周期契约

2. `packages/contracts/src/index.ts`
   - 导出新增的插件生命周期 / 元数据类型

3. `packages/contracts/src/i18n.ts`
   - 补 `unregisterResources(pluginId)` 或等价接口

### 二、runtime 核心

4. `packages/runtime/src/capabilityRegistry.ts`
   - 增加 `revoke`
   - 必要时增加按 owner 批量回收支持

5. `packages/runtime/src/createPluginHost.ts`
   - 增加：
     - plugin manifest 注册表
     - enabled/disabled state
     - teardown 存储
     - owner 资源快照与 diff 捕获
     - `enable/disable/unregister`
     - `version/subscribe`
     - `graph/state/manifests`
   - 处理 active route 迁移
   - 处理 runtime 级启停配置持久化

6. `packages/runtime/src/index.ts`
   - 导出新的 host 生命周期 API / hooks

7. `packages/runtime/src/react/PluginHostProvider.tsx`
   - 支持 host 运行时版本更新

8. `packages/runtime/src/react/useRegistry.ts`
   - 改为订阅 host 变化
   - 删除“host 挂载后不变”的假设

9. `packages/runtime/src/react/useCapability.ts`
   - 跟随 host 版本变化重新求值

10. `packages/runtime/src/registries/routeRegistry.ts`
    - 增加 `unregister`
    - 暴露 owner 可回收的最小快照能力

11. `packages/runtime/src/registries/menuRegistry.ts`
    - 增加 `unregister`

12. `packages/runtime/src/registries/breadcrumbRegistry.ts`
    - 增加 `unregister`

13. `packages/runtime/src/registries/settingsRegistry.ts`
    - 增加 `unregisterPage`
    - 增加 `unregisterField`

14. `packages/runtime/src/registries/homeRegistry.ts`
    - 增加 `unregister`

15. `packages/runtime/src/registries/commandRegistry.ts`
    - 增加 `unregister`

16. `packages/runtime/src/registries/importerRegistry.ts`
    - 增加 `unregister`

17. `packages/runtime/src/registries/transferRegistry.ts`
    - 增加 `unregister`

18. `packages/runtime/src/registries/assetRegistry.ts`
    - 增加 `unregister`

19. `packages/runtime/src/registries/topbarRegistry.ts`
    - 增加 `unregister`

20. `packages/runtime/src/i18n/createI18nService.ts`
    - 补资源注销
    - 修正 host 多次 enable/disable 同一 plugin 时的资源重注册与清理

21. `packages/runtime/src/`
    - 新增建议文件：
      - `pluginConfigStore.ts`
      - `pluginGraph.ts`
      - `pluginOwnership.ts`
      - `react/usePluginRuntime.ts`

### 三、系统级插件管理 UI

22. `packages/plugin-settings/src/SettingsPage.tsx`
    - 接入“插件管理”系统页入口

23. `packages/plugin-settings/src/manifest.ts`
    - 注册插件管理页
    - 增加系统级文案

24. `packages/plugin-settings/src/`
    - 新增建议文件：
      - `PluginManagerPage.tsx`
      - `PluginDependencyPanel.tsx`
      - `pluginManagerI18n.ts`（若需要拆）

### 四、apps/web 装配层

25. `apps/web/src/bootstrapPlugins.ts`
    - 继续按顺序 import manifests
    - 首屏根据全局启停配置决定初始启用集合
    - 不再把“全部 ordered = 全部一定装载”当成不变量

### 五、旧插件元数据补录

26. `packages/plugin-vault/src/manifest.ts`
    - 补 metadata
    - 标记 `canDisable=false`
    - 声明提供 capability

27. `packages/plugin-home/src/manifest.ts`
    - 补 metadata
    - 标记 `canDisable=false`

28. `packages/plugin-settings/src/manifest.ts`
    - 补 metadata
    - 标记 `canDisable=false`

29. `packages/plugin-assets/src/manifest.ts`
    - 补 metadata

30. `packages/plugin-transfer/src/manifest.ts`
    - 补 metadata

31. `packages/plugin-contacts/src/manifest.ts`
    - 补 metadata
    - 声明 `contacts.service`

32. `packages/plugin-key-import/src/manifest.ts`
    - 补 metadata
    - 声明 `key-import.platform`

33. `packages/plugin-importer-wif/src/manifest.ts`
    - 补 metadata

34. `packages/plugin-importer-hex/src/manifest.ts`
    - 补 metadata

35. `packages/plugin-importer-json-file/src/manifest.ts`
    - 补 metadata

36. `packages/plugin-woc/src/manifest.ts`
    - 补 metadata
    - 声明 `woc.service`
    - setup 返回 teardown，桥接 `service.dispose()`

37. `packages/plugin-background/src/manifest.ts`
    - 补 metadata
    - 声明 `background.registry/background.service`
    - setup 返回 teardown，桥接 `service.dispose()`

38. `packages/plugin-p2pkh/src/manifest.ts`
    - 补 metadata
    - 声明 `p2pkh.service`
    - setup 返回 teardown

39. `packages/plugin-p2pkh/src/p2pkhService.ts`
    - 收拢 messageBus 订阅
    - 暴露可 teardown 的 service 生命周期

40. `packages/plugin-p2pkh/src/p2pkhAssetProvider.ts`
    - 收拢 provider 订阅与清理

41. `packages/plugin-p2pkh/src/p2pkhTransferProvider.ts`
    - 收拢 provider 订阅与清理

42. `packages/plugin-poker/src/manifest.ts`
    - 补 metadata
    - 声明 `poker.service`
    - setup 返回 teardown

43. `packages/plugin-poker/src/pokerService.ts`
    - 增加 `dispose()`
    - 回收：
      - ws
      - reconnect timer
      - vault/keyspace/status 监听
      - settings 监听

### 六、测试与文档

44. `packages/runtime/src/*.test.ts`
    - 增加 host enable/disable/unregister/graph/version 测试

45. `packages/plugin-settings/src/*.test.tsx`
    - 增加插件管理 UI 测试

46. `packages/plugin-woc/src/*.test.ts`
    - 验证 disable 后 actor 不再接请求

47. `packages/plugin-background/src/*.test.ts`
    - 验证 disable 后 interval / online / visibility / cross-tab 协调全部停止

48. `packages/plugin-p2pkh/src/*.test.ts`
    - 验证 disable 后 messageBus 订阅与 provider 刷新全部停止

49. `packages/plugin-poker/src/*.test.ts`
    - 验证 disable 后 proxy 断连、reconnect 停止、route/menu/settings/home 移除

50. `README.md`
    - 更新插件生命周期与插件管理说明

## 施工顺序（一次性迭代内的工程顺序，不是分阶段上线）

虽然本次是硬切换，但落笔顺序仍应固定：

1. 先改 `contracts/plugin.ts` 与 `i18n.ts`，把元数据与 teardown 契约定死。
2. 再改 `capabilityRegistry` 与全部 runtime registry，补齐 `revoke/unregister` 基础能力。
3. 再改 `createPluginHost.ts`，做 owner 捕获、graph、enable/disable/unregister/version/subscribe。
4. 再改 React hooks，让 host 运行时变化能触发 UI 重渲染。
5. 再做全局插件启停配置存储与 bootstrap 初始启用集。
6. 再补旧插件 manifest 元数据。
7. 再补旧插件 teardown / dispose。
8. 再做 `plugin-settings` 的插件管理 UI。
9. 再让 `plugin-poker` 接入系统级启停，而不是自管 enable。
10. 最后补自动化测试、README、边界说明。

这里的“顺序”只是同一迭代内的工程依赖顺序，不表示允许先上线半套。

## 最终验收清单

### 一、runtime 宿主验收

1. `PluginHost` 具备：
   - `enable(pluginId)`
   - `disable(pluginId)`
   - `state(pluginId)`
   - `graph()`
   - `version()`
   - `subscribe(listener)`

2. capability 可以在插件卸载时被真正撤销。

3. route/menu/settings/home/breadcrumb/asset/transfer/importer/topbar 都可以在插件卸载时被真正回收。

4. React UI 能随着 host 运行时变化即时刷新，不要求页面刷新。

5. 插件目录元数据是唯一真值；不存在中心化插件目录表。

### 二、系统级插件管理 UI 验收

1. `/settings/plugins` 页面存在。

2. 每个插件能显示：
   - 启用状态
   - 是否允许禁用
   - 提供 capability
   - 依赖 capability
   - 反向依赖它的插件

3. 点击 enable 后插件立即装载，route/menu/settings/home/capability 立即可见。

4. 点击 disable 后插件立即卸载，route/menu/settings/home/capability 立即消失。

5. 若有启用中的反向依赖，disable 被阻止，并明确显示阻塞者。

6. 不存在自动 enable 依赖或自动级联 disable。

### 三、旧插件补录验收

1. 所有旧插件 manifest 都已补 metadata。

2. 所有提供自定义 capability 的插件都声明了 `providesCapabilities`。

3. `plugin-vault`、`plugin-settings`、`plugin-home` 显示为不可禁用。

4. `plugin-poker` 作为业务插件出现在系统级插件管理 UI 中，可启用 / 可禁用。

### 四、热卸载行为验收

1. 当前页面属于目标插件时，disable 会先安全跳转，再卸载，不会出现空白页或 capability throw。

2. `plugin-poker` disable 后：
   - proxy 连接断开
   - reconnect 停止
   - route/menu/home/settings 消失
   - `poker.service` capability 不再可用

3. `plugin-woc` disable 后：
   - actor 停止
   - 新请求不再进入旧 service

4. `plugin-background` disable 后：
   - interval 停止
   - online / visibility / cross-tab 协调停止

5. `plugin-p2pkh` disable 后：
   - 订阅回收
   - provider 不再继续刷新

### 五、持久化与稳定性验收

1. 插件启停状态在刷新后保持。

2. 删除某个插件目录后，旧启停配置不会打崩应用。

3. 多标签页中，一个标签启用 / 禁用插件后，其他标签能同步到相同状态。

4. teardown 报错时：
   - host 不会停在半卸载状态
   - UI 能看到错误状态

### 六、自动化验收

1. runtime 生命周期测试通过。
2. plugin manager UI 测试通过。
3. `plugin-poker` 热卸载测试通过。
4. `npm run typecheck` 通过。
5. `npm run build` 通过。
6. `npm run lint:boundaries` 通过。

## 交付判定

只有同时满足下面四条，本次施工才算完成：

1. runtime 已支持真正的运行时热启用 / 热卸载，而不是刷新后生效。
2. 旧插件依赖与 provider 元数据已补录到各自插件目录里。
3. 系统级插件管理 UI 已可用，且不做自动依赖联动。
4. `plugin-poker` 已纳入系统级插件管理，不再靠代码布尔开关控制是否存在。
