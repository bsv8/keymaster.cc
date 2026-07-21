# 001 业务导航与 Feature 双轨并行迁移施工单

## 参考代码与优先级

- `packages/contracts/src/business.ts`
- `packages/contracts/src/navigation.ts`
- `packages/contracts/src/home.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/registries.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/registries/menuRegistry.ts`
- `packages/runtime/src/registries/homeRegistry.ts`
- `apps/web/src/shell/Sidebar.tsx`
- `packages/plugin-home/src/HomePage.tsx`
- `apps/web/src/pluginCatalog.ts`
- 各 `packages/plugin-*/src/manifest.ts`

本单优先于现有 `business.ts` 中的全局业务分区、旧 `group` 映射和自动布局映射的
临时实现。它们不是最终架构，必须在本单的基础设施阶段移除。

本单是**并行迁移**，不是硬切换：旧菜单/首页继续可用，插件逐个明确迁移到新模型。
但新旧之间禁止自动转换或兼容猜测。

---

## 1. 缘由

现有菜单与首页的组织真值来自技术 registry：`menu.registry` 的 `group`、
`home.registry` 的 `slot`，以及插件的直接 `register()` 调用。这会带来三个问题：

1. 用户看到的是插件/技术分组，而不是业务目标；菜单项与页面、首页呈现、详情页
   没有共同的业务身份。
2. 如果把业务分组和权重收敛成 runtime 全局常量，虽然表面上改善排序，但 runtime
   又会知道 `wallet`、`system` 等业务词；增加或删除插件仍要改中心代码。
3. 直接硬切换会使尚未迁移的入口、权限条件、详情页、首页卡片和插件依赖关系被
   遗漏，风险不可接受。

因此本单采用：**插件声明业务，feature 拥有页面与专属 hook，runtime 只管理通用
生命周期；新旧导航并排，按插件逐个迁移。**

---

## 2. 目标、范围与非目标

### 2.1 目标

完成后必须满足：

1. 新业务导航是 `业务域（Domain）→ 业务功能（Feature）` 两层结构；UI 不以
   `plugin.id`、capability 或技术 registry 作为分类真值。
2. Domain、Feature、菜单排序、首页投影及其排序全部由 owning plugin 的 manifest
   声明；runtime/shell 不维护业务词典或默认权重。
3. Feature 是业务扩展点，不是单纯 route：feature owner 定义页面骨架和专属业务
   hook；贡献插件按 hook 的业务类型注册能力并给出 hook 内排序。
4. 旧 `menu.registry`、旧 `home.registry` 和已有 route 继续工作；新旧入口在 UI 中
   明确分区并同时可见。
5. 单个插件迁移后可删除它的旧注册；删除插件目录或从 catalog 移除时，不需要修改
   Sidebar、首页、全局业务排序表或其他插件的 UI 配置。
6. 新旧系统没有 `group -> domain`、`slot -> space`、`plugin id -> feature` 等自动
   mapping；每一次迁移都必须显式写出业务语义。

### 2.2 范围

- contracts 中的新业务 Domain/Feature/首页投影契约；
- runtime 中独立的新业务 registry、ownership 与 feature capability 生命周期；
- Web Shell/Home 的双轨渲染；
- 插件 manifest 的逐个迁移规范；
- feature owner 与 contributor 的专属 hook 设计；
- 单元、集成、卸载和迁移验收。

### 2.3 非目标

- 本单不要求一次性重写所有业务页面、路由路径、数据层或 provider；新 Feature 可
  先引用原有页面。
- 本单不保留旧模型到新模型的 adapter、fallback 或映射表。
- 本单不设计用户自定义菜单排序、拖拽布局或远程插件市场。
- 本单不引入一个万能 `registerComponent()` / `registerSlot("name")` API；不同
  Feature 的 hook 必须有不同的业务契约。
- 本单不允许一个 contributor 直接向另一个插件的菜单、首页或 Feature 注入任意
  React component。

---

## 3. 术语与唯一语义

### 3.1 Plugin、Domain、Feature

| 名称 | 定义 | 是否展示给用户 |
|---|---|---|
| Plugin | 代码、能力和生命周期的安装/卸载边界 | 通常不展示 |
| Domain | 一组相邻用户目标的大菜单分类 | 展示 |
| Feature | 用户可以进入、理解和完成的一项业务功能 | 展示为小菜单项 |
| Feature view | Feature 的入口页、详情页、向导页等视图 | 按 Feature 自己的规则展示 |
| Home projection | 某 Feature 在首页的可选业务呈现 | 展示 |

一个 plugin 可以拥有一个或多个 Feature；用户永远从 Domain/Feature 进入，不从
plugin 名称进入。纯 provider/platform plugin 可以没有 Domain 和 Feature。

### 3.2 新业务声明的形状（设计稿）

以下是语义模型，不要求字段名逐字照搬；实现时必须保持字段职责不变：

```ts
business: {
  domains: [
    {
      id: "assets",
      label: { key: "assets.domain.label", fallback: "Assets & Wallet" },
      order: 200,
      features: [
        {
          id: "assets.holdings",
          label: { key: "assets.holdings.label", fallback: "Holdings" },
          description: { key: "assets.holdings.description", fallback: "View holdings" },
          order: 10,
          icon: "Layers",
          entry: { path: "/assets", component: AssetsPage, visibleWhen },
          views: [/* Feature 内部详情/向导页，不自动进菜单 */],
          home: [{ space: "portfolio", order: 10, component: AssetsHomeSummary }]
        }
      ]
    }
  ]
}
```

约束：

- `Domain.order` 仅决定新业务大菜单顺序；权重相同按 `domain.id` 排序。
- `Feature.order` 仅决定该 Domain 内的小菜单顺序；权重相同按 `feature.id` 排序。
- 首页 `space.order` 与其中投影的 `order` 是各自独立的局部权重，不能借用菜单
  权重。
- `id` 由 owner plugin 声明且全局稳定、唯一；它是业务标识，不允许由 runtime
  根据 plugin id、path 或 label 推导。
- i18n key、图标、可见性、排序和路由均随 plugin 删除；不得进入 web shell 的
  全局配置。

### 3.3 Feature 专属 hook

Feature owner 在 setup 中提供 feature capability，并定义领域 API。示例：

```ts
// transfer feature owner 提供
"feature.transfer": {
  registerSource(source: TransferSource): void;
  registerQuoteProvider(provider: TransferQuoteProvider): void;
  registerReviewSection(section: TransferReviewSection): void;
  registerSubmitHandler(handler: TransferSubmitHandler): void;
}

// history feature owner 提供
"feature.history": {
  registerSource(source: HistorySource): void;
  registerFilter(filter: HistoryFilter): void;
  registerTimelineRenderer(renderer: HistoryTimelineRenderer): void;
  registerDetailSection(section: HistoryDetailSection): void;
}
```

每个 hook 的输入、可见性、生命周期与排序只由 owner Feature 的业务契约定义。例如
`TransferQuoteProvider.order` 与 `HistorySource.order` 没有可比较性，不能提到全局
排序器中。

`component` 仅是 React 实现基础。`Home projection`、`HistoryDetailSection`、
`TransferReviewSection` 都可以包含 component，但它们不是同一种万能 widget。

---

## 4. 双轨最终形态与迁移期 UI

### 4.1 两套独立 registry

| 系统 | 数据来源 | 渲染位置 | 迁移期责任 |
|---|---|---|---|
| Legacy navigation | 既有 `menu.registry` / `home.registry` | “现有入口”“现有首页卡片” | 只维护未迁移插件 |
| Business navigation | 新 `business` manifest 声明及 Feature hook | “业务导航”“业务首页” | 只维护已迁移插件 |

两套 registry 独立拥有 ID、排序、订阅和 ownership；禁止任意一套读取或规范化另一套
的数据。

### 4.2 Shell 展示

侧边栏顺序固定为：

```text
业务导航
  Domain A
    Feature 1
    Feature 2
  Domain B
    Feature 1

现有入口（迁移中）
  <原 menu.registry 内容，保持原有 group/order 语义>
```

不能把旧菜单项混进新 Domain，也不能为了“看起来整齐”按旧 `group` 推导新 Domain。
若同一业务迁移期间新旧入口同时指向同一个 path，两个入口允许短期并存，但必须位于
上述两个明确标题下。

### 4.3 首页展示

首页按两个区块显示：

```text
业务首页
  按新 Feature 的 home projection 业务空间、空间权重、投影权重渲染

现有首页卡片（迁移中）
  按旧 home.registry 的现有 slot/order 规则渲染
```

不要把旧 widget 塞进新业务空间，也不要用旧 `main/aside` 猜测新 `space`。一个
已迁移 Feature 删除旧 home widget 后，才只出现在“业务首页”。

### 4.4 路由过渡

新 Feature 首次迁移可以引用已有 route/path 和已有页面 component，避免同时重写
UI 与业务模型。此时新 registry 仅建立 Feature 对 route 的引用，**不重复注册**
相同 route id/path。

当 Feature owner 已接管页面时，才将 route 的 owner 迁至新 Feature；任何时刻同一
path 只能有一个 route owner。route 冲突是启动错误，不能靠“后注册覆盖前注册”。

---

## 5. 强制规则：可以怎样做、不能怎样做

### 5.1 必须这样做

1. 每次迁移都在 owning plugin manifest 中明确声明 Domain、Feature、权重、入口和
   可见性；不允许靠默认值推断业务归属。
2. 先让新入口与旧入口并行可访问，再删除该插件旧入口；每次提交只迁移明确的一组
   Feature，保持可回滚。
3. Feature contributor 通过 `feature.<business-id>` capability 显式依赖 owner；owner
   负责定义专属 hook、排序与渲染。
4. 所有新 registry 注册必须被 PluginHost ownership 捕获，disable/unregister 后不留
   菜单、首页投影、route 引用、Feature hook contributor 或订阅。
5. 所有新 UI 文案来自 owning plugin 的 i18n 资源，删除插件后随 i18n ownership
   回收。

### 5.2 禁止这样做

1. 禁止在 runtime 定义 `BUSINESS_MENU_SECTION_ORDER`、全局 Domain 枚举、`wallet`
   等业务常量或任何中心化业务权重表。
2. 禁止 `businessMenuSectionFromLegacyGroup()`、`slot -> space`、按 plugin id/path
   识别业务等兼容代码。
3. 禁止在 Sidebar/Home 写 `if (plugin.id === "...")`、`if (domain === "...")` 或
   业务专属排序规则。
4. 禁止通用 `registerWidget(component, slot)`、字符串命名的万能 `registerSlot()`；
   Feature 必须暴露语义明确、类型专属的 hook。
5. 禁止 contributor 直接写入别人的 Feature registry；它只能调用 owner 暴露的
   capability API。
6. 禁止新旧入口共享同一个 registry 的 `legacy` flag；这会使双轨边界再次模糊。

---

## 6. 特殊情况与处理规则

### 6.1 一个插件需要多个 Domain 或多个 Feature

允许。每个 Domain/Feature 都在该插件 manifest 中完整声明；ID 仍全局唯一。插件的
删除会一并删除它拥有的全部业务入口。

### 6.2 多个插件想放到同一个 Domain

第一期不允许无 owner 的“共享 Domain”。必须选定一个 Domain owner plugin：

- owner plugin 提供 `feature.<id>` capability，并拥有菜单/Feature 页面；
- contributor 通过 owner 定义的专属业务 hook 提供来源、过滤器、报价、详情区等；
- contributor 不直接添加小菜单项。

若无法定义 owner 或专属 hook，说明该业务边界尚未澄清；保持旧入口，不能以共享
字符串 ID 临时绕过。

### 6.3 新旧入口暂时重复

允许，但必须放在“业务导航”和“现有入口（迁移中）”两块中，且采用相同 label/path
或清晰的迁移标识。验收完成后，同一 Feature 不得长期保留双入口。

### 6.4 新 Feature 依赖尚未迁移的旧 provider

允许。Feature 的业务页面可继续依赖旧 capability；业务导航迁移与底层 capability
迁移解耦。只有 UI 注册模型迁移完成后才删除旧 menu/home 注册。

### 6.5 Feature owner 被禁用、卸载或 setup 失败

- owner Feature 不显示在业务导航和业务首页；其 route 按现有安全跳转规则处理；
- contributor 因显式 capability 缺失变为 blocked/disabled，不能留下孤儿内容；
- legacy 入口若仍存在且属于尚未迁移的独立插件，保持原行为；不得把它自动挂到
  其他 Feature 下。

### 6.6 权重相同、ID 冲突或可见性不同

- 同级同权重：按稳定业务 ID 字典序排序；这是通用规则，不是业务词典。
- Domain/Feature/投影 ID 冲突：host 注册失败并给出两个 owner plugin id；不采用
  静默覆盖。
- `visibleWhen` 属于 Feature/Feature hook 的局部规则；Shell 只执行声明结果，
  不补充业务判断。

### 6.7 页面结构完全不同

这是 Feature hook 存在的原因。转款可以定义 source/quote/review/submit；历史可以
定义 source/filter/timeline/detail。不得为了“统一”让二者使用同一个 cards/slots API。

---

## 7. 文件级实施清单

以下按阶段实施；阶段完成后均应可运行、可测试、可回退到上一阶段。除明确列出的
迁移插件外，不得顺手改变旧插件 UI 行为。

### 阶段 A：清理当前临时业务实现，建立并行契约

#### `packages/contracts/src/business.ts`

1. 删除全局 `BUSINESS_MENU_SECTIONS`、`BUSINESS_MENU_SECTION_ORDER`、
   `BUSINESS_HOME_SPACE_DEFINITIONS` 与所有 legacy group 映射函数。
2. 定义仅由插件实例携带的 `BusinessDomain`、`BusinessFeature`、`FeatureEntry`、
   `FeatureView`、`FeatureHomeProjection` 等纯契约。
3. 定义 ID、权重、label、icon、visibleWhen、entry/view/home 的责任边界；不在此文件
   枚举任何具体业务词或默认权重。
4. 明确 Feature hook 接口由各 Feature contract 包/文件定义，不在此文件创建万能
   slot/component 注册接口。

#### `packages/contracts/src/plugin.ts`

1. 将新的业务声明作为 `PluginManifest.business` 的可选字段；未迁移插件不得被要求
   填写。
2. 保留 plugin 的 capability/dependency/lifecycle 合约，不把业务类别塞入 `meta`。
3. 文档化“plugin 是 owner 边界，Domain/Feature 是用户界面边界”。

#### `packages/contracts/src/navigation.ts` 与 `packages/contracts/src/home.ts`

1. 恢复并冻结旧 `MenuItem.group`、`HomeWidget.slot` 的既有 legacy 语义；它们只服务
   旧 registry。
2. 不向 legacy type 添加 `section`、`space`、`businessId` 等过渡字段。
3. 新 Feature 的首页投影类型只放在 `business.ts`，避免旧 HomeWidget 被污染。

#### `packages/contracts/src/registries.ts` 与 `packages/contracts/src/index.ts`

1. 增加独立 `BusinessFeatureRegistry`（名称可调整）的公共只读查询契约。
2. 确认新 contracts 被 barrel 导出。
3. 不修改旧 `MenuRegistry` / `HomeRegistry` 的公共查询语义。

### 阶段 B：runtime 独立注册、排序与生命周期

#### 新增 `packages/runtime/src/registries/businessFeatureRegistry.ts`

1. 注册 plugin 所拥有的 Domain/Feature 描述；校验 domain/feature/projection ID 唯一。
2. 只按声明的局部权重和稳定 ID 排序；不得 import/维护业务分区常量。
3. 提供按 owner plugin 查询、列表订阅和精确 unregister；不得读取 `menu.registry`
   或 `home.registry`。
4. 对一个 Feature 引用已有 legacy route 的场景提供只读 route reference，不创建第二个
   route 注册。

#### `packages/runtime/src/createPluginHost.ts`

1. 创建并暴露新的 business registry capability/host view。
2. 在 plugin enable 生命周期中注册 manifest business 声明，并纳入 ownership snapshot；
   disable/unregister/失败回滚时精确回收。
3. 检查 feature ID、route ownership、i18n ownership 和 capability dependency 的冲突。
4. 删除当前把 business declaration 自动投影到旧 `routes`/`menus`/`home` registry 的
   实现；双轨期间必须是真正独立的数据通道。
5. 保持旧 registry、owner diff 和 teardown 行为不变。

#### `packages/runtime/src/pluginOwnership.ts`

1. 增加 business domains/features/home projections/feature hook contributors 的 ownership
   字段。
2. 清理顺序要求：先停止 Feature hook contributor，再移除业务投影与导航描述，最后
   回收 capability；避免已移除页面在回调中读取失效 capability。

#### `packages/runtime/src/registries/menuRegistry.ts` 与 `homeRegistry.ts`

1. 删除当前针对新业务字段的 normalize、排序、legacy mapping 与 `space -> slot`
   映射。
2. 恢复旧 registry 仅按旧字段工作的行为，作为迁移期稳定基线。
3. 新业务排序只存在于 `businessFeatureRegistry.ts`。

### 阶段 C：Web 双轨渲染

#### 新增 `apps/web/src/shell/BusinessNavigation.tsx`

1. 只读取 business registry，渲染 `Domain → Feature`；按 registry 已排序结果展示。
2. 解析 Feature entry 到已拥有的 route，执行 Feature 自己的可见性判断。
3. 不 import plugin、不认识业务 ID、不拼默认 label/图标、不读 legacy menu。

#### `apps/web/src/shell/Sidebar.tsx`

1. 保留原菜单渲染为 `LegacyNavigation`，逻辑和 group/order 不变。
2. 在侧边栏最前新增“业务导航”区块；旧菜单包在“现有入口（迁移中）”区块。
3. 新旧两个区块使用独立数据源、空状态与可访问性 label；不得合并 Map 或排序数组。
4. 保留窄屏抽屉、当前路径高亮、关闭行为和 unlocked 状态规则。

#### 新增 `packages/plugin-home/src/BusinessHomePage.tsx` 或等价组件

1. 只读取 business registry 的 HomeProjection，按业务空间/权重渲染。
2. 显示“业务首页”标题；不读取 legacy `home.registry`。
3. 空业务首页必须是正常空态，不影响 legacy 首页。

#### `packages/plugin-home/src/HomePage.tsx`

1. 保留当前 legacy widgets 的展示，增加明确的“现有首页卡片（迁移中）”区块。
2. 组合 `BusinessHomePage` 与 legacy 区块，但两者不得共享分组、slot 或排序逻辑。
3. 迁移结束前不得删除 legacy 空态与原布局。

#### `apps/web/src/i18n/resources.ts`

1. 增加通用壳层文案：业务导航、现有入口（迁移中）、业务首页、现有首页卡片
   （迁移中）。
2. 不在此文件加入 Domain/Feature 名称；这些必须来自插件 i18n。

#### `apps/web/src/pluginCatalog.ts`

1. 保持唯一装配清单职责：选择安装哪些 plugin 和 capability 依赖顺序。
2. 不加入 Domain/Feature、菜单/首页权重或迁移状态配置。
3. 删除一个 plugin 只需从此 catalog 移除（以及包依赖管理中的正常移除）；Shell 和
   其他 plugin 不得有清理项。

### 阶段 D：Feature owner 与 hook contract

#### 新增 Feature contract 文件（按业务建立）

建议位置：`packages/plugin-transfer/src/transferFeature.ts`、
`packages/plugin-history/src/historyFeature.ts`，或在 Feature owner plugin 内建立等价文件。

1. Transfer Feature 定义 `TransferSource`、`TransferQuoteProvider`、
   `TransferReviewSection`、`TransferSubmitHandler` 及其局部排序规则。
2. History Feature 定义 `HistorySource`、`HistoryFilter`、`HistoryTimelineRenderer`、
   `HistoryDetailSection` 及其局部排序规则。
3. Feature owner 向 capability bus 提供 `feature.transfer`、`feature.history` 等 API；
   contributor 显式把该 capability 写入 dependencies。
4. 每个 owner 提供独立测试，证明 contributor disable/unregister 时内容消失，权重
   相同按 contributor ID 稳定排序。

不要在 `packages/contracts` 放 Transfer/History 的具体业务模型，除非它已经是多个
独立 package 的稳定公共协议；默认由 owner plugin 的公开入口导出。

### 阶段 E：逐插件迁移顺序

每个插件遵循“声明新业务 → 双轨验证 → 删除本插件旧入口”的三步，禁止批量猜测。

建议顺序：

1. `plugin-home`：仅建立新业务首页容器/总览 Feature，不删除 legacy 首页。
2. `plugin-assets`：迁移“资产总览”Feature，可先复用 `/assets` 和现有组件。
3. `plugin-contacts`、`plugin-apps`、`plugin-bsv-price`：依赖面小，验证 menu、可见性、
   首页投影和 owner 回收。
4. `plugin-transfer`、`plugin-collectibles`、`plugin-key-import`：建立用户任务型
   Feature，确定 entry/view 边界。
5. `plugin-p2pkh`、token/collectible provider：先作为已有 Feature 的业务来源或明确
   owner，再决定是否拥有独立 Feature；不得因为技术包存在就自动生成菜单项。
6. `plugin-message`、`plugin-webrtc`、`plugin-appmsg`、`plugin-broadcast`：先澄清
   “消息/连接/系统诊断”的业务 owner 和 hook，再迁移；依赖复杂时保持 legacy。
7. Settings、Vault、WOC、Background、Hub providers：默认不是用户 Feature。除非有
   独立用户任务和 owner，否则保持平台/设置入口，不强行纳入业务导航。

每次迁移完成后，删除**该插件自身**的旧 `menu.registry` / `home.registry` 注册和对应
技术依赖声明；不要删除其他未迁移插件的旧入口。

### 阶段 F：旧系统退场（单独施工单）

只有满足以下条件才可另开 hard-switch 施工单：

1. `menu.registry` 与 `home.registry` 中没有任何用户业务入口；
2. 所有保留的 legacy route 已由 Feature owner 接管或被明确废弃；
3. 旧区块在至少一个完整发布周期内持续为空且无回归；
4. plugin 删除/禁用、深链、锁定状态和 i18n 均已覆盖；
5. 通过全仓搜索确认没有旧 `group` / `slot` 业务注册。

在该单之前，禁止删除 legacy registry 或迁移期 UI。

---

## 8. 测试计划

### 8.1 contracts/runtime 单元测试

- business registry 的 owner、ID 冲突、局部权重、同权重稳定排序；
- business registry 从不读取/修改 legacy menu/home registry；
- plugin enable/disable/unregister 与 setup failure 的完整 ownership 回收；
- Feature capability contributor 的依赖阻断、注册、排序、卸载；
- Feature 与 legacy route 引用不创建第二个 route；route ownership 冲突失败；
- 无 business 声明的旧 plugin 仍可按原行为运行。

### 8.2 React/Shell 测试

- Sidebar 同时显示业务导航和现有入口，且不互相混排；
- 新 Domain/Feature 的顺序完全由 owning plugin 声明决定；
- legacy 菜单保持原 group/order；
- 窄屏抽屉、当前路径高亮、锁定可见性和 i18n 在两个区块均正确；
- 首页同时呈现业务首页和 legacy 卡片，二者空态独立；
- 迁移插件删除旧注册后，只剩新 Feature，不出现重复入口。

### 8.3 插件级集成测试

至少用 Assets、Contacts、Transfer/History 各覆盖一个模式：

- 自己拥有 Domain + Feature；
- 自己拥有 Feature 且有 HomeProjection；
- 作为 Feature contributor 提供专属业务能力；
- disable/unregister 后菜单、首页和 Feature 内容均消失；
- 旧入口在迁移前存在、迁移后删除，原页面 path 仍可访问。

---

## 9. 最终验收清单

### 架构验收

- [ ] runtime、Shell、catalog 中不存在具体业务 Domain/Feature 名称、全局业务排序表或默认业务空间表。
- [ ] 不存在 `group -> domain`、`slot -> space`、plugin id/path 推断 Feature 的任何代码。
- [ ] legacy menu/home 与 business registry 是两套独立的数据结构、订阅和 ownership。
- [ ] Feature hook 均为业务专属 API；不存在万能 component/slot 注入接口。
- [ ] `component` 仅作为各类业务呈现的实现类型，不再把 widget 当作通用插件类别。

### 行为验收

- [ ] 未迁移插件的菜单、首页、路由、权限和排序与改造前一致。
- [ ] 已迁移插件在“业务导航”和“业务首页”按 manifest 声明的 Domain/Feature/投影权重显示。
- [ ] 新旧入口可以临时并存，并有明确迁移期视觉与无障碍标题；不混排。
- [ ] 单一 route path 不会被新旧系统重复注册。
- [ ] 每个迁移插件删除旧注册后，不再在 legacy 区块出现。
- [ ] 同权重排序稳定；ID 冲突、route owner 冲突、缺 Feature owner capability 都会明确失败。
- [ ] 插件 disable/unregister/setup 失败后没有孤儿菜单、首页投影、Feature contribution、订阅或 i18n 资源。

### 可维护性验收

- [ ] 新增一个 Feature 只需修改 owning plugin 的 manifest 与其 Feature contract；不修改 Shell、全局排序表或其他插件。
- [ ] 删除一个 plugin 只需从 catalog/包管理移除；没有 Sidebar/Home/全局业务配置清理步骤。
- [ ] 所有 Domain/Feature 文案和图标位于 owning plugin 的 i18n/manifest 中。
- [ ] 迁移记录逐插件列明：旧入口、对应新 Feature、复用 route、删除旧注册的提交与测试证据。

### 工程验收

- [ ] contracts、runtime、受影响 plugins、web 的 typecheck 通过。
- [ ] 新增 runtime、Shell、Feature owner/contributor、迁移插件的测试全部通过。
- [ ] web production build 通过。
- [ ] `git diff --check` 通过。
- [ ] 在最终旧系统退场前，不删除任何 legacy registry 或迁移期区块。

---

## 10. 实施记录（本轮补齐 P0/P1/P2）

已完成：

- 双轨 registry、旧接口测试修复、Feature views、显式 route 引用；
- `PluginContext.onDispose()` 生命周期清理，执行顺序为 dispose callbacks → plugin teardown → ownership purge；
- Transfer 专属 source/quote/review/submit hook，支持注销函数、订阅、局部稳定排序，并保留 legacy 菜单入口；
- 业务首页空间命名空间、空间定义冲突校验、Domain/Feature 权重排序和独立空间渲染；
- legacy `HomeWidget.slot` 必填、legacy 文案/注释清理；
- runtime registry、Transfer hook、业务首页和 Shell 排序测试。

仍未实施：

- 当前仓库没有独立 History Feature owner/contributor，因此未凭空新增 `plugin-history`；
- legacy 系统最终退场仍需单独施工单，旧入口继续保留。
