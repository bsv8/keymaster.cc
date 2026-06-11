# 002 首启导入向导改为“内存复用解密密码 + 共享头部 + 步骤进度 + 统一视觉”硬切换施工单

## 目标

一次性把初始化页、首启导入向导和相关 step 页面切换为下面这套明确语义：

```txt
首启导入
  第 2 步输入过的解密 JSON 密码
  只保留在本次向导内存
  不落 localStorage
  不落 IndexedDB
  不写 URL
  不进全局长期状态

第 4 步“设置本机系统锁屏密码”
  如果用户选择“使用同一密码”
    直接复用第 2 步已输入并已用于解析成功的解密密码
    不再次要求输入

  如果用户取消“使用同一密码”
    必须单独输入新的本机系统锁屏密码
    必须二次确认

初始化页 / 新建钱包页 / 解锁页 / 首启导入各 step 页
  共享同一套 onboarding header
  header 内可切换主题颜色和语言

首启导入各 step
  顶部必须显示步骤进度
  用户能看见当前在第几步、已完成几步、剩余几步
  不能伪装成可任意乱跳的无约束 tab

视觉
  统一使用一套 onboarding 视觉系统
  简洁圆角
  明确层次
  背景与内容有反差
  保持克制，不做花哨营销页
```

本次是硬切换，不接受“先只修复密码复用，后面再慢慢补 header / step progress / 视觉”的拆分方式，也不接受继续保留旧交互和新交互并存。

## 简述缘由

1. 当前第 4 步虽然有“使用导入源密码作为本机系统锁屏密码”的勾选，但实际实现仍要求用户再次输入一遍，这不是“复用”，而是“重复索取”。
2. 当前实现里，解析成功后会主动清空 `importPassword`，导致第 4 步天然不可能真正复用第 2 步已经输入过的密码。
3. “导入过程数据只留内存，不落库”是这条流程的核心约束。既然前一步输入的密码已经用于本次解析成功，后一步再次索取只会增加摩擦，不会增加安全性。
4. 当前锁屏态页面没有共享 header，主题切换、语言切换和页面主体是割裂的；首启向导也没有步骤进度，用户很难建立“我已经做到哪里了”的心智。
5. 当前页面视觉过于功能化，缺少统一的 onboarding 外观，导致首次进入应用时不像一个完整流程，更像几块临时拼接的表单。
6. 这类问题如果只局部补一个输入框或加一条提示文案，会继续把状态机、交互语义和视觉系统撕裂开。正确做法是一次把首启导入向导收敛成一套完整的 onboarding 结构。

## 硬切换结论

本次统一采用下面的产品与实现定义：

```txt
“使用同一密码”
  = 复用第 2 步已输入且已验证成功的导入源密码
  ≠ 在第 4 步再输一遍同样的密码

导入源密码
  = 本次向导会话内存态
  = 仅供本次解析与可选的 vaultPassword 复用

本机系统锁屏密码
  = createVaultWithImportedKey 最终使用的 vaultPassword
  = 可以等于 resolvedImportPassword
  = 也可以是用户重新设置的新密码

锁屏态页面
  = 共享 onboarding header
  = 共享视觉语言

step progress
  = 有状态的步骤指示器
  ≠ 可无约束跳转的普通 tab
```

这意味着：

1. 第 4 步在“复用导入源密码”场景下不得再渲染密码输入框。
2. 第 2 步与第 4 步之间必须存在一份明确的、只活在 wizard 生命周期内的内存态密码。
3. 新设本机系统锁屏密码时必须二次确认，不能继续用“无确认的单输入框”凑合。
4. 初始化相关页面要收敛到同一套 header 和容器骨架，而不是每个页面各画各的。
5. 进度条必须反映真实状态机，不允许 UI 可跳到尚未满足前置条件的步骤。

## 不能怎么做

1. 不能继续保留“勾选使用同一密码，但第 4 步再让用户输入一遍密码”的交互。这是伪复用。
2. 不能在 parse 成功后立刻清空导入源密码，再在第 4 步靠用户重复输入补回来。
3. 不能把导入源密码写入 localStorage、IndexedDB、URL、MessageBus payload、全局 capability 或跨页面长期 store。
4. 不能把 step progress 做成普通 tabs，然后允许用户在未解析成功前直接点到第 3 步或第 4 步。
5. 不能在每个 step 页各自复制一套主题切换、语言切换按钮。header 必须抽成共享壳层。
6. 不能只给首启导入页面做漂亮样式，而让 welcome / new wallet / unlock 继续保留旧结构。首次使用阶段必须是一套完整的 onboarding 体验。
7. 不能因为“导入类型不带密码”就继续保留单输入框且无确认的新密码流程。凡是用户新设本机密码，都必须确认。
8. 不能把 `ThemeToggle` 继续写死中文文案，再把它放进共享 header。切语言后 header 右侧控件也必须同步切换。
9. 不能为了减少改动把 step progress 只做成静态标题文本，例如“1/4”。这不足以承担步骤感知职责。
10. 不能一边引入 onboarding header，一边继续让页面内部 `PageHeader` 重复渲染品牌级标题，造成双头结构。

## 应该怎么做

### 总体策略

把锁屏态 shell 收敛成一套共享 onboarding 壳层，在壳层里面承载：

```txt
OnboardingShell
  -> OnboardingHeader
  -> 主容器 / 主面板
  -> 页面级 PageHeader
  -> step progress（仅导入向导使用）
  -> 具体表单内容
```

同时把首启导入密码逻辑收敛成下面这套明确状态：

```txt
importPasswordDraft
  第 2 步输入框内容

resolvedImportPassword
  parse 成功后保存在本次 wizard 内存中的“已实际用于导入解析”的密码

useSamePassword = true
  vaultPassword = resolvedImportPassword

useSamePassword = false
  vaultPassword = 用户新输入并确认的新密码
```

### 这样做的缘由

1. `importPasswordDraft` 和 `resolvedImportPassword` 语义不同。前者是未提交输入，后者是本次流程已经被证明有效的密码。把两者分开，才能既避免重复输入，又避免错误地复用未生效的草稿。
2. onboarding header 是锁屏态系统级能力，不是某个页面的私有组件。抽壳后，主题/语言切换和页面主流程才有一致入口。
3. step progress 的本质是状态机可视化，而不是导航组件。必须让视觉结构服务流程约束，而不是反过来破坏流程。
4. onboarding 阶段是用户对产品安全心智的第一印象。视觉应该稳、清晰、有层次，不应该像一组默认表单控件临时拼起来。

## 交互与状态设计

### 1. 首启导入密码语义

#### 情况 A：导入类型带密码，且本次解析成功时实际使用了密码

业务顺序必须是：

```txt
1. 第 2 步输入导入源密码
2. parse 成功
3. 把本次密码转存为 resolvedImportPassword
4. 第 4 步默认勾选“使用同一密码作为本机系统锁屏密码”
5. 如果保持勾选
     直接使用 resolvedImportPassword 作为 vaultPassword
     不再次要求输入
6. 如果取消勾选
     用户输入新密码 + 确认密码
```

关键约束：

1. `resolvedImportPassword` 只活在 `FirstTimeImportWizard` 生命周期内。
2. 第 4 步勾选复用时，页面应显示“将复用第 2 步已输入的解密密码”之类的说明，而不是再显示密码输入框。
3. `finish()` 时应根据 `useSamePassword` 选择 `resolvedImportPassword` 或 `vaultPasswordDraft` 作为最终 `vaultPassword`。

#### 情况 B：导入类型不带密码

业务顺序必须是：

```txt
1. 第 2 步输入 WIF / Hex / 明文 JSON
2. parse 成功
3. 第 4 步不显示“使用同一密码”勾选
4. 强制输入新密码 + 确认密码
5. 以该新密码创建 Vault
```

关键约束：

1. 不存在“单输入框无确认”的路径。
2. 新设密码必须满足现有长度校验与一致性校验。

### 2. step progress 语义

建议固定四步：

```txt
1. 选择方式
2. 输入材料
3. 确认结果
4. 设置锁屏密码
```

交互要求：

1. 当前步骤高亮。
2. 已完成步骤显示完成态。
3. 未到达步骤显示未激活态。
4. 允许点击返回到已完成步骤。
5. 不允许点击跳转到未来步骤。
6. 页面标题仍保留，但不再承担唯一的步骤表达职责。

### 3. onboarding header 语义

共享 header 负责：

```txt
左侧
  品牌
  阶段说明或安全提示

右侧
  ThemeToggle
  LanguageSwitch
```

约束：

1. 主题和语言切换必须在 welcome / new wallet / first import / unlock 各页都可见。
2. header 的视觉样式必须与 onboarding 主容器一体化，而不是直接复用 unlocked topbar。
3. header 不承担路由导航，不引入 sidebar、breadcrumbs 或 unlocked 态扩展项。

### 4. 视觉方向

视觉主张：

```txt
暖色强调
浅底深字
圆角容器
明显层次
有限阴影
有反差但不花哨
```

具体要求：

1. 主背景不能只是纯白空页，至少要有轻微层次或氛围底。
2. 主面板使用较大圆角与干净边框，强调“本地保险箱/初始化流程”的稳定感。
3. 标题、正文、次要说明、风险文案必须有明确色阶，不得全靠字号区分。
4. 错误、提示、步骤状态、按钮 hover 必须在同一色彩系统内。
5. welcome 卡片和 import wizard 面板要统一视觉语言，避免一页一个风格。

## 特殊情况提前约定

### 情况 1：第 2 步曾输入密码，但 parse 失败

处理原则：

```txt
失败的密码不是 resolvedImportPassword
不能进入第 4 步复用逻辑
```

应该这样做：

1. 失败时保留输入框草稿，方便用户重试。
2. 只有 parse 成功后，才把草稿转存为 `resolvedImportPassword`。
3. 如果后续重新选文件、清空文件、切换 importer，要同步清掉 `resolvedImportPassword`。

不能这样做：

1. 不能把“用户曾经输过密码”当作“解析成功时实际用过密码”。
2. 不能在解析失败后仍让第 4 步默认复用旧密码。

### 情况 2：用户在第 4 步取消“使用同一密码”，输入了新密码；随后又重新勾选

处理原则：

```txt
重新勾选后
最终以 resolvedImportPassword 为准
新密码草稿应清空
```

应该这样做：

1. 勾回“使用同一密码”时清掉新密码和确认密码草稿。
2. 页面明确显示当前将复用解密密码，而不是保留一组失效的新密码字段。

### 情况 3：用户从第 4 步返回到第 2 步并重新选择文件或重新解析

处理原则：

```txt
第 4 步的密码决策依赖新的解析结果
旧的 resolvedImportPassword 必须失效
```

应该这样做：

1. 回退并重新解析成功后，用新的解析上下文覆盖旧的 `parsed`、`resolvedImportPassword`、`importRequiredPassword`。
2. 若新的输入不再需要密码，则自动隐藏“使用同一密码”勾选。

### 情况 4：刷新页面、关闭向导、点击返回欢迎页

处理原则：

```txt
本次导入会话整体丢弃
```

应该这样做：

1. 组件卸载或 `resetWizard()` 时清空 `importPasswordDraft`、`resolvedImportPassword`、`parsed`、`vaultPasswordDraft` 等所有流程内存态。
2. 不做任何持久化恢复。

### 情况 5：主题或语言切换发生在导入向导中途

处理原则：

```txt
只切换展示
不重置导入状态
```

应该这样做：

1. 切语言后，header、step progress、按钮、提示文案同步热更新。
2. 切主题后，只影响样式，不影响当前 step、已选 importer、文件、解析结果和密码内存态。

### 情况 6：当前语言切到英文

处理原则：

```txt
共享 header 中所有切换控件与说明文案都必须同步英文
```

应该这样做：

1. `ThemeToggle` 不得继续硬编码中文。
2. onboarding 新增的标题、副标题、步骤标签、复用提示文案必须全部进入 i18n 资源。

## 文件级落地方案

### apps/web/src/shell/FirstTimeImportWizard.tsx

必须改动：

1. 重构密码状态：
   - `importPassword` 拆为 `importPasswordDraft` 与 `resolvedImportPassword`。
   - `vaultPassword` 拆为“新设密码草稿”的明确语义字段，避免与最终值混淆。
2. `parse()` 成功后：
   - 记录 `importRequiredPassword`；
   - 若本次确实用了导入源密码，则写入 `resolvedImportPassword`；
   - 不再无条件清空可复用的成功密码。
3. 第 4 步渲染改造：
   - 复用导入源密码时展示说明块，不再显示密码输入框；
   - 新设密码时统一渲染“新密码 + 确认密码”；
   - 标签输入框保留，但纳入统一面板结构。
4. `finish()` 改为显式计算最终 `vaultPassword`：
   - `useSamePassword === true` 时取 `resolvedImportPassword`；
   - 否则取用户新设密码。
5. 增加 step progress 配置与渲染。
6. 增加回退、重选 importer、清文件、重新解析时的状态清理，确保旧密码和旧解析结果不会串到新流程。

### apps/web/src/shell/LockedShell.tsx

必须改动：

1. 抽出并接入共享 onboarding 壳层。
2. welcome / new-wallet-form / first-time-import / unlock-form 四种模式都使用同一套 header 容器。
3. welcome 区块与表单页区块的结构统一到 onboarding 主布局下。
4. 避免重复品牌头部与双层标题。

### apps/web/src/shell

建议新增组件：

1. `OnboardingHeader.tsx`
   - 负责品牌、安全说明、主题切换、语言切换。
2. `OnboardingShell.tsx`
   - 负责共享容器、背景、内容宽度和页面骨架。
3. `StepProgress.tsx`
   - 负责四步状态可视化。

设计缘由：

1. 这些能力都不是 `FirstTimeImportWizard` 独有逻辑。
2. 抽组件后，welcome / new wallet / unlock / first import 的视觉与结构才能长期一致。

### apps/web/src/theme/ThemeToggle.tsx

必须改动：

1. 所有文案接入 i18n，不再硬编码中文。
2. 触发按钮与下拉面板文案需支持中英文热切换。
3. 若共享 header 视觉与当前按钮样式不匹配，可在不破坏其他页面的前提下补 class 变体或补壳层样式。

### apps/web/src/i18n/LanguageSwitch.tsx

可能改动：

1. 如共享 header 需要更适合 onboarding 的按钮表现，可补充 class 或轻量结构调整。
2. 不改变其语言切换语义，只适配新壳层视觉。

### apps/web/src/i18n/resources.ts

必须改动：

1. 新增 onboarding header 文案：
   - 品牌副标题
   - 安全说明
   - 主题切换标签
   - 主题选项名称与提示
2. 新增 step progress 文案：
   - 四步标签
   - 完成态/当前态辅助说明
3. 新增第 4 步复用密码说明文案。
4. 如 welcome / import / unlock 页面标题文案要配合新视觉精简，也在此统一调整。

### apps/web/src/styles/global.css

必须改动：

1. 新增 onboarding 壳层样式：
   - 背景
   - 容器
   - header
   - 主面板
2. 新增 step progress 样式：
   - 当前
   - 已完成
   - 未开始
3. 调整 locked-shell / first-time-import 现有样式，使其收敛到 onboarding 视觉系统。
4. 补 theme toggle / language switch 在 onboarding header 中的布局与响应式样式。
5. 保证移动端下：
   - header 不拥挤；
   - step progress 可换行或横向滚动但不乱；
   - 主面板可读性不塌陷。

### packages/ui/src/PageHeader.tsx

原则上不强制改。

只有在下面任一情况成立时才改：

1. onboarding 需要 `eyebrow` / `badge` / `tone` 一类的通用头部能力；
2. 这些能力确实对多个页面有复用价值；
3. 不会把 onboarding 私有视觉污染到全部业务页面。

否则应把特化结构留在 shell 侧，而不是把 UI 基础组件改得过重。

## 实施顺序

虽然本次是硬切换，但代码落地仍应按下面顺序完成，以避免中途状态机断裂：

1. 先抽 onboarding 壳层与共享 header。
2. 再把 `ThemeToggle` 文案 i18n 化。
3. 再实现 `StepProgress` 与导入向导结构改造。
4. 最后收口密码状态逻辑与 `finish()` 最终取值逻辑。
5. 全量补齐样式与资源文案后，再做一次 typecheck 与手工流程验收。

这不是“分阶段上线”，只是单次开发内的安全编码顺序。

## 最终验收清单

### 功能验收

- [ ] 加密 JSON 首启导入时，第 2 步输入过解密密码并解析成功后，第 4 步默认勾选“使用同一密码”，且不再要求再次输入解密密码。
- [ ] 加密 JSON 首启导入时，取消“使用同一密码”后，第 4 步必须出现“新密码 + 确认密码”。
- [ ] 明文 WIF / Hex / 明文 JSON 首启导入时，第 4 步不显示“使用同一密码”勾选，且必须输入并确认新密码。
- [ ] 第 4 步最终传给 `createVaultWithImportedKey()` 的 `vaultPassword` 在复用场景下等于 `resolvedImportPassword`，在非复用场景下等于用户新设密码。
- [ ] 用户从第 4 步返回到更早步骤并重解析后，旧密码决策不会污染新流程。
- [ ] 关闭导入向导、返回欢迎页或刷新页面后，本次导入相关内存态全部丢弃。

### 交互验收

- [ ] welcome / 新建钱包 / 解锁 / 首启导入各 step 页面都显示同一套 onboarding header。
- [ ] onboarding header 中可切换主题与语言。
- [ ] 切换主题或语言不会重置当前导入步骤和表单状态。
- [ ] 首启导入顶部有明确的四步进度指示。
- [ ] 用户能明确看见当前步、已完成步、剩余步。
- [ ] 未满足前置条件时，不能通过 progress 直接跳到未来步骤。

### 视觉验收

- [ ] onboarding 阶段页面具有统一背景、圆角主面板、层次清晰的标题与正文颜色。
- [ ] welcome 卡片、新建钱包表单、解锁表单、导入向导面板视觉风格一致。
- [ ] 错误提示、说明文案、按钮、步骤状态色彩系统统一。
- [ ] 移动端下 header、步骤进度、表单布局均可正常阅读和操作。

### i18n 验收

- [ ] onboarding 新增文案全部进入 `apps/web/src/i18n/resources.ts`。
- [ ] `ThemeToggle` 的标题、选项名、提示语不再硬编码中文。
- [ ] 中英文切换后，header、step progress、按钮、说明文案都能同步更新。

### 工程验收

- [ ] `apps/web` 通过 `npm run typecheck --workspace @keymaster/web` 或等价 typecheck。
- [ ] 没有新增把私钥材料或导入密码持久化到浏览器存储的代码。
- [ ] 没有引入 unlocked shell 的 topbar / sidebar 依赖到锁屏态 onboarding。

## 备注

本施工单只覆盖锁屏态 onboarding 与首启导入向导，不扩散到 unlocked 主应用信息架构。目标是把“首次进入应用时的流程正确性、状态语义和视觉一致性”一次收紧，而不是顺手重做整站 UI。
