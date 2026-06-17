# 006 首页 `main / aside` 双栏布局硬切换施工单

## 目标

一次性把当前首页从“横向栅格 + `size` 控制跨度”的模型，硬切换为“左 `main` 主栏 + 右 `aside` 辅助栏”的双栏模型：

```txt
首页真值模型
  = 首页只认两个栏目：main / aside
  = 每个首页 widget 必须显式声明自己属于哪个栏目
  = main 为主业务栏，宽度自适应撑满
  = aside 为辅助栏，固定窄宽
  = desktop 双栏，mobile 单列回落

插件接入模型
  = 插件注册首页 widget 时，必须声明 slot
  = 不再用 size 表达布局归属
  = 不允许宿主猜测“这个 widget 应该去左边还是右边”
```

本次是硬切换，不接受下面这些中间态：

1. 只改 [apps/web/src/styles/global.css](/home/david/Workspaces/keymaster.cc/apps/web/src/styles/global.css:568) 的 CSS，把现有栅格“看起来像双栏”，但插件契约仍然只有 `size`。
2. 保留 `size: "sm" | "md" | "lg"`，再额外新增一个可选 `slot`，形成双真值。
3. 通过 `size` 自动推断栏目，例如 `sm -> aside`、`md/lg -> main`。这会把“视觉尺寸”偷渡成“信息架构”，后续一定失控。
4. 给 `slot` 设置宿主默认值，例如“不写就默认 `main`”。这会让插件作者继续不表达意图。
5. desktop 做成双栏，但 mobile 仍然保留固定右栏宽度，导致小屏横向溢出。

## 简述缘由

1. 当前首页契约见 [packages/contracts/src/home.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/home.ts:1)，它只有 `size`，没有“栏目”这个产品语义。`size` 当前只是在旧横向栅格里表达跨度，不足以承载新的双栏信息架构。
2. 当前首页渲染见 [packages/plugin-home/src/HomePage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-home/src/HomePage.tsx:1)，它只会把全部 widget 平铺进 `.home-grid`。这意味着如果不改契约，宿主根本不知道哪些 widget 应进入主栏，哪些应进入辅助栏。
3. 当前首页样式见 [apps/web/src/styles/global.css](/home/david/Workspaces/keymaster.cc/apps/web/src/styles/global.css:568)，是典型 12 栏横向 grid。你要的“左主右辅”不是简单视觉调参，而是首页信息结构改变。
4. 现在真正挂到首页的插件只有四个：
   - `assets.overview`
   - `p2pkh.balance`
   - `contacts.recent`
   - `poker.status`

   影响面很小，适合现在就一次切干净；如果继续拖着 `size` 兼容，后面新插件会在旧模型上继续堆。
5. 对插件系统来说，“首页挂在哪个栏目”必须是插件自己声明的真值，而不是宿主猜。否则插件作者写 widget 时无法稳定预期自己的信息层级和可用宽度。

## 硬切换结论

本次统一采用下面这套单真值模型：

```txt
HomeWidget
  必填字段：
    id
    title
    component
    order
    slot: "main" | "aside"
    refreshHint?

删除字段：
  size

首页渲染
  先按 slot 分组
  再在各自栏目内按 order 升序排列

desktop
  左 main：minmax(0, 1fr)
  右 aside：固定 320px

mobile
  回落为单列
  顺序：main 在前，aside 在后
```

本次切换后，必须满足下面的不变量：

1. 所有注册到 `home.registry` 的 widget 都必须显式声明 `slot`。
2. 代码中不存在任何以 `HomeWidgetSize`、`sizeClass()`、`.home-grid__cell--sm/md/lg` 为真值的首页布局逻辑。
3. desktop 首页必须稳定呈现为左主右辅两列，而不是随 widget 数量自动折行的横向卡片墙。
4. `main` 栏永远是主业务内容承载区；`aside` 栏永远是辅助信息、状态、快捷概览承载区。
5. mobile 不再保留固定右侧窄栏，而是收敛成单列，避免小屏布局破裂。
6. 插件若未声明 `slot`，应在编译阶段直接暴露问题，而不是运行时猜测。

## 不能怎么做

1. 不能保留 `HomeWidgetSize`，再引入 `slot?: "main" | "aside"` 作为“过渡字段”。这会让旧插件继续写 `size`，新插件写 `slot`，契约立刻分裂。
2. 不能把 `size` 改成“视觉尺寸提示”，同时仍参与布局。首页的布局真值只能剩下 `slot`。
3. 不能写任何“兼容桥”：
   - `size === "sm"` 自动归 `aside`
   - `size !== "sm"` 自动归 `main`
   - `slot ?? "main"`

   这些都只是把旧债藏起来。
4. 不能继续保留 `.home-grid__cell--sm` / `.home-grid__cell--md` / `.home-grid__cell--lg` 这些 class，然后让新样式“碰巧看起来没事”。旧语义必须删除，不是隐藏。
5. 不能让 `aside` 宽度跟内容一起漂移。辅助栏应该固定窄宽，否则“主辅”关系会变成随机两栏。
6. 不能把“某个 widget 较重要”误写成“放大 widget 尺寸”来解决。新的首页没有“跨 12 栏”这个问题，只有“在哪个栏目、栏目内顺序如何”的问题。
7. 不能因为某个插件暂时没想好挂哪边，就先放 `main` 凑合。首页挂载点是插件产品意图的一部分，必须明确。
8. 不能只改 `plugin-home`，不改四个业务插件 manifest。宿主渲染层改完但插件注册信息没变，不叫完成切换。
9. 不能把 desktop 双栏和 mobile 单列做成两套不同的 widget 顺序真值。顺序真值只有 `slot + order`，响应式只改变排版，不改变语义。

## 应该怎么做

### 一、把首页契约从 `size` 收窄为 `slot`

必须修改：

- `packages/contracts/src/home.ts`

要求：

1. 删除 `HomeWidgetSize` 类型。
2. 新增 `HomeWidgetSlot = "main" | "aside"`。
3. `HomeWidget` 删除 `size`，新增必填 `slot`。
4. 注释明确说明：
   - `main` 是首页主业务栏
   - `aside` 是首页辅助栏
   - 首页挂载插件必须显式声明栏目归属

设计缘由：

1. 首页从横向跨栏改为信息分栏后，`size` 已经不再是正确抽象。
2. 栏目归属是信息架构，不是视觉尺寸，不应继续借壳 `sm/md/lg` 表达。

### 二、保持 `home.registry` 简单，不把分栏逻辑塞进 registry

涉及文件：

- `packages/runtime/src/registries/homeRegistry.ts`
- `packages/contracts/src/registries.ts`

要求：

1. `home.registry` 继续只提供：
   - `register(widget)`
   - `list()`
2. registry 不负责按栏目分组，不提供 `listMain()` / `listAside()` 这类新 API。
3. `list()` 继续按 `order` 升序返回；栏目分组放在渲染层完成。
4. 注释改成“`slot` 决定栏目归属”，不再出现“`size` 决定栅格跨度”。

设计缘由：

1. registry 是注册表，不是页面编排器。
2. 如果把 `main/aside` 分组逻辑塞进 registry，后面每个消费方都会被迫接受一份过强的页面结构 API。
3. 当前只有 `plugin-home` 消费首页 widget，分栏属于页面渲染职责，不属于 runtime 注册表职责。

### 三、首页渲染改成 `main / aside` 双栏容器

必须修改：

- `packages/plugin-home/src/HomePage.tsx`

要求：

1. 删除 `sizeClass()` 及其全部调用。
2. 读取 `registry.list()` 后，按 `slot` 分成：
   - `mainWidgets`
   - `asideWidgets`
3. 页面结构改成：

```txt
home-layout
  home-layout__main
    widget list
  home-layout__aside
    widget list
```

4. 两栏内都按 `order` 保持稳定顺序。
5. 不新增“空 aside 占位说明”“空 main 占位说明”这类产品噪音；栏目为空时只是不渲染对应 widget 列表。
6. 如果首页整体没有 widget，继续复用现有 `EmptyState`。

设计缘由：

1. 这次切换是首页信息结构硬切换，不是卡片 class 替换。
2. `main/aside` 分组必须在真正渲染首页的地方发生，保证页面结构和契约一一对应。

### 四、CSS 从横向栅格改成双栏布局

必须修改：

- `apps/web/src/styles/global.css`

要求：

1. 删除旧的：
   - `.home-grid`
   - `.home-grid__cell--sm`
   - `.home-grid__cell--md`
   - `.home-grid__cell--lg`
2. 新增双栏样式，例如：

```txt
.home-layout
  display: grid
  grid-template-columns: minmax(0, 1fr) 320px
  gap: 12px
  align-items: start

.home-layout__main
.home-layout__aside
  display: flex
  flex-direction: column
  gap: 12px
  min-width: 0
```

3. `aside` 固定窄宽建议定为 `320px`。
4. `main` 必须使用 `minmax(0, 1fr)`，避免内部长内容把布局撑爆。
5. 在平板/手机断点下改为单列：

```txt
grid-template-columns: 1fr
```

6. 单列时保证 DOM 顺序仍是 `main` 在前、`aside` 在后。

设计缘由：

1. `aside` 固定窄宽，才能让首页视觉上稳定体现“辅助栏”而不是“第二个平级内容区”。
2. `main` 用弹性主栏，才能容纳资产、余额这类主业务 widget。
3. 小屏改单列是必要的，不然固定窄栏在手机上没有意义。

### 五、四个首页插件 manifest 必须显式声明栏目

必须修改：

- `packages/plugin-assets/src/manifest.ts`
- `packages/plugin-p2pkh/src/manifest.ts`
- `packages/plugin-contacts/src/manifest.ts`
- `packages/plugin-poker/src/manifest.ts`

本次明确归位如下：

1. `assets.overview` -> `slot: "main"`
2. `p2pkh.balance` -> `slot: "main"`
3. `contacts.recent` -> `slot: "aside"`
4. `poker.status` -> `slot: "aside"`

设计缘由：

1. `assets` 与 `p2pkh` 是钱包首页主业务信息，内容密度高，需要主栏宽度。
2. `contacts` 与 `poker` 更像辅助状态、次级入口和轻量概览，更适合固定窄栏。
3. 这个归位不是样式偏好，而是首页信息层级的明确声明。

### 六、测试与文档一起收尾，防止旧模型复活

建议新增或修改：

- `packages/plugin-home/src/HomePage.test.tsx`
- 如有需要，同步更新受 `HomeWidget` 类型影响的测试夹具

至少覆盖下面这些断言：

1. widget 会按 `slot` 正确进入 `main` / `aside`。
2. 同一栏目内按 `order` 升序排列。
3. 整体无 widget 时仍显示首页空态。
4. 代码库中不再存在 `HomeWidgetSize`、`sizeClass()`、`.home-grid__cell--sm/md/lg` 这类旧布局真值。

说明：

1. 当前仓库没有现成的首页测试，这次如果不补至少一层渲染测试，后面很容易有人把 `size` 模型又接回来。
2. 类型收窄本身能拦住一部分错误，但不能替代首页栏目分发行为测试。

## 特殊情况提前约定

### 情况 1：`aside` 暂时没有任何 widget

处理原则：

```txt
不发明占位卡片
不渲染假内容
首页仍然保持双栏结构
```

应该这样做：

1. `home-layout__aside` 可以为空容器，也可以在无内容时不渲染内部列表。
2. 不新增“暂无辅助信息”之类占位 UI。

不能这样做：

1. 不能因为 `aside` 空了，就自动把 `main` widget 重新流式铺满整个旧栅格。
2. 不能临时让宿主从 `main` 栏“借一个 widget”过去填空。

### 情况 2：`main` 暂时没有任何 widget，但 `aside` 有内容

处理原则：

```txt
这不是 aside 提升为主栏
这是首页插件配置不完整
```

应该这样做：

1. 如果整个首页仍有 widget，就按既定 DOM 结构渲染。
2. 允许出现“左空右有”的过渡结果，但它应被视为插件接入问题，而不是布局要自动兜底的场景。

不能这样做：

1. 不能自动把 `aside` 变成 100% 宽主栏。
2. 不能偷偷把 `aside` widget 提升到 `main` 去渲染。

### 情况 3：两个 widget 在同一栏目里 `order` 相同

处理原则：

```txt
保持当前 registry 注册顺序稳定
但不鼓励复用相同 order
```

应该这样做：

1. 继续依赖现有 `list().sort((a, b) => a.order - b.order)` 的稳定排序表现。
2. 施工实施时尽量让同栏 widget 的 `order` 保持清晰间距，避免碰撞。

不能这样做：

1. 不能引入“不同栏目共用一套穿插排序”的附加规则。
2. 不能为了处理同序号冲突，再把 `slot` 排序掺进 registry 真值。

### 情况 4：旧插件没有声明 `slot`

处理原则：

```txt
编译期失败
不做运行时猜测
```

应该这样做：

1. 通过 `HomeWidget` 类型收窄，让所有旧注册点在编译时报错。
2. 一次性改完仓库内四个首页插件 manifest。

不能这样做：

1. 不能提供 `slot ?? "main"`。
2. 不能在运行时看到缺失就 fallback 到某个栏目。

### 情况 5：移动端显示

处理原则：

```txt
语义不变
排版收敛
```

应该这样做：

1. 仅在 CSS 断点下改成单列。
2. DOM 顺序保持 `main` 后接 `aside`。

不能这样做：

1. 不能移动端单独定义另一套栏目归属规则。
2. 不能在移动端重新按全局 `order` 混排 `main` 和 `aside`。

## 文件级施工清单

### 必改文件

1. `packages/contracts/src/home.ts`
   - 删除 `HomeWidgetSize`
   - 新增 `HomeWidgetSlot`
   - `HomeWidget.size` 改为 `HomeWidget.slot`
   - 更新注释为双栏语义

2. `packages/contracts/src/registries.ts`
   - 更新 `HomeRegistry` 相关注释
   - 明确 `slot` 才是首页栏目归属真值

3. `packages/runtime/src/registries/homeRegistry.ts`
   - 更新注释
   - 确认 registry 不引入额外栏目 API

4. `packages/plugin-home/src/HomePage.tsx`
   - 删除 `sizeClass()`
   - 按 `slot` 分组渲染 `main / aside`
   - 保留整体空态逻辑

5. `apps/web/src/styles/global.css`
   - 删除旧 `.home-grid*` 样式
   - 新增 `.home-layout*` 双栏样式
   - 添加移动端单列回落

6. `packages/plugin-assets/src/manifest.ts`
   - `assets.overview` 改为 `slot: "main"`

7. `packages/plugin-p2pkh/src/manifest.ts`
   - `p2pkh.balance` 改为 `slot: "main"`

8. `packages/plugin-contacts/src/manifest.ts`
   - `contacts.recent` 改为 `slot: "aside"`

9. `packages/plugin-poker/src/manifest.ts`
   - `poker.status` 改为 `slot: "aside"`

### 建议新增/补充文件

1. `packages/plugin-home/src/HomePage.test.tsx`
   - 覆盖栏目分发与排序行为

## 最终验收清单

### 类型与契约验收

1. `HomeWidget` 中已不存在 `size` 字段。
2. 仓库中已不存在 `HomeWidgetSize` 类型定义与引用。
3. 所有首页 widget 注册点都显式声明了 `slot`。
4. 没有任何 `slot` 默认值、`size -> slot` 推断或运行时 fallback。

### 渲染与样式验收

1. desktop 首页稳定显示为左 `main`、右 `aside` 两列。
2. `main` 栏明显更宽，且为自适应宽度。
3. `aside` 栏为固定窄宽，建议值 `320px`。
4. mobile 首页回落为单列，不出现横向溢出。
5. 旧 `.home-grid__cell--sm/md/lg` 样式已完全删除。

### 插件接入验收

1. `assets.overview` 出现在 `main`。
2. `p2pkh.balance` 出现在 `main`。
3. `contacts.recent` 出现在 `aside`。
4. `poker.status` 出现在 `aside`。
5. 同栏目内按 `order` 升序稳定排列。

### 行为与回归验收

1. 首页没有 widget 时，仍显示现有 `EmptyState`。
2. 只有 `main` 或只有 `aside` 有 widget 时，不发生运行时错误。
3. 任何旧插件若漏改 `slot`，应在编译阶段直接失败。
4. `npm run typecheck` 通过。
5. `npm test` 通过。
6. `npm run build` 通过。

## 实施完成定义

只有当下面几点同时成立，这次施工才算完成：

1. 首页契约、渲染、样式、插件注册点已经全部切到 `slot`。
2. 仓库中不再存在旧 `size` 布局模型残留。
3. desktop / mobile 行为都与双栏设计一致。
4. 编译、测试、构建全部通过。
