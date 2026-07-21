# 002 新业务导航硬切换施工单

## 1. 目标

完成业务导航从并行迁移到硬切换：`business.registry` 的 Domain / Feature
成为唯一用户可见菜单来源。旧菜单不可再注册、不可渲染、不可通过任何兼容字段
重新进入侧栏。

本单以 `001-business-navigation-feature-parallel-migration.md` 为前序；其中关于
双轨并行、旧菜单继续可见的内容至此失效。

## 2. 已完成范围

1. 新侧栏只渲染 `BusinessNavigation`，删除“业务导航”和“现有入口（迁移中）”
   两个迁移期标题；无障碍名称使用独立 i18n key，不再显示为页面文字。
2. 删除 `MenuItem`、`MenuRegistry`、`menu.registry` capability、runtime 菜单实现、
   owner 回收字段、测试和旧菜单 i18n 资源；`AppRoute` 不再携带 `inMenu` /
   `menuGroup` 等菜单投影字段。
3. 首页、钱包、转账、收藏品、P2PKH、联系人、消息、应用、BSV Price、Poker 和设置
   均通过业务 Domain / Feature 或对应的设置 hook 注册入口。
4. 设置分为：系统设置 hook、应用设置目录、Key 管理、插件设置、系统日志与系统状态；
   应用设置详情页统一位于 `/settings/apps/<application>`。
5. 系统状态固定展示 Broadcast 与 AppMsg；它们是常驻系统模块，不提供手动启停。
6. `/import` 被移入 Key 管理导入工作区；旧独立入口不再保留。
7. 钱包域使用“钱包 / Wallet”，资产入口使用“资产总览 / Asset overview”；首页域
   “概览 / Overview”及资产相关菜单、首页投影均具备中英文 i18n。

## 3. 强制约束

1. 用户可见菜单只能来自 `business.registry`。插件不得注册旧菜单，也不得通过
   route 元数据要求出现在菜单中。
2. 业务入口的排序、图标、可见性和子路由激活规则只能定义在 `BusinessFeature.entry`。
3. 路由仍是页面渲染与生命周期边界；route 不承担菜单分组或排序语义。
4. 系统设置修改后立即生效；应用设置由各应用自己的运行时配置语义负责。
5. 卸载可禁用插件时，runtime 必须回收该插件拥有的 route、business feature、
   应用设置项、系统设置项、状态模块及资源定义。

## 4. 验收

1. 代码库中不得存在 `MenuRegistry`、`MenuItem`、`menu.registry`、`inMenu` 或
   `menuGroup` 的生产或测试引用。
2. 侧栏没有旧菜单分区，只显示业务 Domain 与 Feature。
3. `/settings/apps` 以应用目录展示可用设置；`/settings/apps/bsv-price` 与
   `/settings/apps/poker` 均能使“应用设置”保持 active。
4. 中英文下“概览 / Overview”“钱包 / Wallet”“资产总览 / Asset overview”均通过
   owning plugin 的 i18n 资源渲染。
5. `pnpm typecheck` 通过；runtime host、business registry、业务导航和受影响插件的
   Vitest 回归测试通过。
