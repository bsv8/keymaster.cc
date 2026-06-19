# 001 JSON 导入“文件 + 文本双输入统一化”硬切换施工单

## 目标

一次性把系统里两条 JSON 导入入口统一切换为同一套能力模型：

```txt
入口一：初始化页首启导入向导
入口二：已解锁后的系统导入页

两条入口都支持：
  JSON 文件
  JSON 文本

两条入口对 JSON 的处理语义完全一致：
  明文 JSON 可直接解析
  bsv8 加密 JSON 必须要求密码
  文件 / 文本只是输入来源不同
  解析规则、报错规则、密码规则、确认规则完全一致
```

本次是硬切换，不接受：

1. 文件支持加密 JSON，但文本不支持。
2. 首启向导支持文本，但系统导入页不支持。
3. 两个入口各自实现一套 JSON 解析分支。
4. 继续把“JSON 导入”错误建模成“只能传文件”。

## 简述缘由

1. 对用户来说，“一段 JSON”与“一个 JSON 文件”是同一种导入材料，只是来源不同，不应产生能力差异。
2. 现在 `json-file importer` 只支持 `file`，导致 UI 层天然只能渲染文件上传，想补“JSON 文本”只能绕开契约，后续一定继续分叉。
3. 当前 `password` 只存在于 `file` 输入上，这会把“加密 JSON 文本”排除在正确模型之外，属于契约设计缺口，不是单纯页面问题。
4. 两个入口当前都按 `importer.supports` 自动渲染输入控件，所以正确做法是先统一 importer 契约，再让两条入口复用同一套能力，而不是页面硬编码特判。
5. 如果只做“文本仅支持明文 JSON”，产品表面上看是交付了，实际上埋下了最差的一类一致性问题：同一份 JSON，换个来源就失效。

## 硬切换结论

本次统一采用下面这套定义：

```txt
JSON importer
  = 同时支持 file 和 text

text input
  = 可携带 password

file input
  = 可携带 password

bsv8 加密 JSON
  = 不关心来源是文件还是文本
  = 只关心输入内容是否是 envelope
  = 缺密码时报同一条业务错误

UI
  = 先让用户选择输入方式
  = 再提供对应输入控件
  = 只把标准化输入交给 importer.parse()
```

## 核心不变量

1. `importer.parse()` 仍然是唯一解析入口，UI 不自己解析私钥字段。
2. `json-file importer` 必须同时支持 `text` 和 `file`。
3. `password` 是“本次解析输入”的属性，不是 importer 实例的静态属性。
4. bsv8 加密 JSON 的密码规则对文件和文本完全一致。
5. 两条入口都必须共用同一套 JSON 输入模式切换语义。
6. 私钥明文与导入源密码都不能进入 localStorage、IndexedDB、URL、MessageBus payload 或全局长期状态。
7. 错误信息代码里保持英文；文档、注释、页面说明保持中文。

## 不能怎么做

1. 不能继续让 `KeyImportInput` 的 `password` 只存在于 `file` 分支。
2. 不能在 UI 层写“如果是 JSON 文本，就手动 `JSON.parse` 后绕开 importer”。
3. 不能把“文件导入 JSON”和“文本导入 JSON”做成两个 importer，例如 `json-file` 和 `json-text`。这会重复解析逻辑并撕裂能力模型。
4. 不能让首启向导和系统导入页各自维护一份“JSON 是否需要密码”的判断逻辑副本。
5. 不能继续复用单行 `TextInput` 让用户粘贴大段 JSON 文本。JSON 文本输入必须是多行控件。
6. 不能让“输入方式切换”只改 UI，不清理旧的文件、文本、密码、解析结果状态。否则会把上一种输入方式的残留状态带到下一种方式。
7. 不能让“文本模式”默认不支持加密 JSON，只因为当前嗅探工具只接收 `Uint8Array`。
8. 不能为了少改动，把“JSON 文本”偷偷塞进现有 `wif` / `hex` 文本框语义里。JSON 是独立的输入模式，不应混淆为普通文本私钥。
9. 不能让两个入口出现不一致文案，例如一个叫“JSON 文件”，另一个叫“JSON 文本或文件”，但背后行为不同。
10. 不能保留旧能力并存开关。本次是硬切换，旧模型直接移除。

## 应该怎么做

### 总体策略

先修正契约，再收敛 importer，再让两条 UI 入口复用同一套输入模式。

执行顺序固定为：

```txt
1. 扩展 contracts：text/file 都允许带 password
2. 重构 json importer：抽出“从 bytes/text 解析 JSON”的共享路径
3. 补 sniff 工具：文件 / 文本都能判断是否像 bsv8 envelope
4. 升级 UI：JSON importer 渲染“文件 / 文本”二选一
5. 两个入口都复用这套模式
6. 完成单测与回归验证
```

### 这样做的缘由

1. 契约先统一，后续页面与 importer 才能保持自然复用。
2. `json-file importer` 的本质不是“文件 importer”，而是“JSON 私钥材料 importer”。文件只是载体，不是能力边界。
3. 先抽共享解析函数，可以避免未来文件和文本路径在明文 JSON / bsv8 envelope / 错误处理上逐渐漂移。
4. 输入方式切换是 UI concerns，不应污染 importer 契约；而密码是否需要，是输入内容属性，应由 parse 行为和 sniff 共同驱动。

## 交互与状态设计

### 1. JSON importer 的输入方式

当用户选中 JSON importer 时，输入区必须先显示输入方式切换：

```txt
输入方式
  JSON 文件
  JSON 文本
```

行为要求：

1. 默认值建议为 `JSON 文件`，因为它兼容当前用户习惯，且对大多数备份场景更直观。
2. 切换到 `JSON 文本` 时，隐藏文件选择控件，显示多行文本框。
3. 切换到 `JSON 文件` 时，隐藏多行文本框，显示文件选择控件。
4. 切换输入方式时，必须清理另一种方式残留的输入值、密码嗅探结果、解析错误、解析结果。

### 2. JSON 密码语义

统一语义如下：

```txt
如果输入内容是明文 JSON
  不需要密码

如果输入内容是 bsv8 加密 JSON
  需要密码

如果内容来源是文件
  嗅探文件内容

如果内容来源是文本
  嗅探文本内容

如果嗅探没命中，但 parse() 判断确实需要密码
  仍然以 PASSWORD_REQUIRED_MSG 回推 UI 显示密码框
```

关键约束：

1. `PASSWORD_REQUIRED_MSG` 在两个入口、两种来源上都必须保持同一条业务错误。
2. 文本模式也必须支持“先不显示密码框，parse 后再升起密码框”的 fail-open 路径。
3. 首启向导里，若 JSON 文本解析成功且实际用了密码，`resolvedImportPassword` 的复用语义必须与 JSON 文件完全一致。

### 3. 非 JSON importer 的行为

WIF 与 Hex 的行为不变：

1. 继续只支持 `text`。
2. 不显示 JSON 输入方式切换。
3. 不显示 JSON 专用密码逻辑。

设计缘由：

1. 本次目标是统一 JSON 双输入，不是重做全部 importer UI。
2. 保持 WIF / Hex 不变，能把改动范围控制在真正相关的契约与界面上。

## 特殊情况与处理规则

### 情况 A：用户在 JSON 文本模式粘贴的是明文 JSON

处理：

1. 不显示密码框，或即使之前显示过也在重新嗅探后关闭。
2. 直接解析。
3. 成功后进入原有确认流程。

### 情况 B：用户在 JSON 文本模式粘贴的是 bsv8 加密 JSON

处理：

1. 如果嗅探命中，立即显示密码框。
2. 如果嗅探未命中但 parse 抛出 `Password is required for encrypted key file`，立刻显示密码框并保留原文本。
3. 用户补密码后再次解析。
4. 首启向导成功后把本次密码保存到 `resolvedImportPassword`，后续第 4 步可复用。

### 情况 C：用户在文件模式选了文件，又切到文本模式

处理：

1. 立刻清理已选文件名、文件字节、文件密码需求状态、文件密码草稿。
2. 清理任何基于该文件得到的解析结果与错误。
3. 不允许把旧文件的密码需求状态继承到文本模式。

### 情况 D：用户在文本模式输入了加密 JSON 和密码，又切到文件模式

处理：

1. 立刻清理 JSON 文本内容、文本密码需求状态、文本密码草稿。
2. 不允许把文本模式下的密码草稿带到文件模式。
3. 文件模式重新从文件内容独立嗅探。

### 情况 E：用户输入的不是合法 JSON

处理：

1. importer 返回英文错误，例如 `Invalid JSON: ...`。
2. UI 原样展示错误。
3. 不自动切换输入方式，不自动清空用户内容。

### 情况 F：JSON 中没有可导入私钥字段

处理：

1. importer 返回英文错误，例如 `No private key candidates found in JSON`。
2. 不把这类错误特殊映射成“需要密码”。
3. 允许用户继续修改原文本或重选文件重试。

### 情况 G：用户在首启向导第 2 步解析成功后返回上一步重选输入方式

处理：

1. 必须清掉旧的 `parsed`、`importRequiredPassword`、`resolvedImportPassword`。
2. 不允许第 4 步继续复用一份已经与当前输入无关的旧密码。

## 文件级施工

### packages/contracts/src/keyImport.ts

修改 `KeyImportInput`：

```ts
type KeyImportInput =
  | { kind: "text"; text: string; password?: string }
  | { kind: "file"; name: string; content: Uint8Array; password?: string };
```

要求：

1. 注释里明确：`password` 是输入属性，文本与文件都可能需要。
2. 不引入 importer 级静态 `requiresPassword` 字段。
3. 不改变 `KeyImporter.parse()` 的整体职责边界。

### packages/plugin-importer-json-file/src/jsonFileImporter.ts

重构为“同时支持 `text` 与 `file`”。

要求：

1. `supports` 改为 `["text", "file"]`。
2. 抽出共享解析函数，例如：

```txt
decode input -> parse JSON -> 判断 envelope -> 明文 dig / 加密解密 -> 生成 KeyImportResult[]
```

3. 对 `text` 输入：
   - 使用 `input.text`
   - 读取 `input.password`
4. 对 `file` 输入：
   - decode `input.content`
   - 读取 `input.password`
5. bsv8 分支缺密码时仍抛：

```txt
Password is required for encrypted key file
```

说明：

1. 这条错误文案虽然包含 `file`，本次先保持不变，目的是不破坏既有 UI 与测试常量。
2. 后续若要统一成更中性的 `encrypted key JSON`，必须连同两个入口和测试一起改，不在本次硬切换顺手做半套。

### packages/plugin-importer-json-file/src/jsonFileImporter.test.ts

补齐并更新单测。

至少覆盖：

1. 明文 JSON 文件可解析。
2. 明文 JSON 文本可解析。
3. bsv8 JSON 文件缺密码时报 `PASSWORD_REQUIRED_MSG`。
4. bsv8 JSON 文本文字缺密码时报同一错误。
5. bsv8 JSON 文件密码错误时失败。
6. bsv8 JSON 文本密码错误时失败。
7. importer 运行时仍无 `requiresPassword` 静态字段。
8. `supports` 同时包含 `text` 与 `file`。

### packages/plugin-importer-json-file/src/manifest.ts

更新文案描述。

要求：

1. 名称是否仍叫 `JSON File` 需要在本次直接改正。
2. 我建议改为更准确的 `JSON`，因为它已经不再是文件专属 importer。

资源建议同步为：

```txt
name: JSON
description: 从钱包导出的 JSON 中提取私钥；支持 JSON 文件、JSON 文本与 bsv8 加密 envelope。
```

如果保留 `JSON File` 这个名称，会和“支持 JSON 文本”直接冲突，不建议。

### packages/plugin-key-import/src/importFileSniff.ts

扩展嗅探工具，收敛成既能处理字节也能处理文本的共享逻辑。

建议方向：

1. 保留现有 `isBsv8KeyEnvelopeShape(obj)`。
2. 新增统一入口，例如：

```txt
peekBsv8EnvelopeText(text: string): boolean
peekBsv8EnvelopeBytes(bytes: Uint8Array): boolean
```

或：

```txt
peekBsv8EnvelopeFromJsonText(text: string): boolean
```

核心要求：

1. 文件和文本不能各自复制一份 JSON.parse + shape 判断。
2. sniff 只做“像不像 envelope”，不做私钥提取。

### packages/plugin-key-import/src/importFileSniff.test.ts

补测试覆盖文本嗅探。

至少覆盖：

1. pretty JSON 文本命中 envelope。
2. compact JSON 文本命中 envelope。
3. 明文 JSON 文本不命中 envelope。
4. 非法 JSON 文本不命中 envelope。
5. 原有 bytes 路径回归不坏。

### packages/ui/src/TextArea.tsx

新增多行文本输入组件。

要求：

1. API 风格与 `TextInput` 保持一致。
2. 支持 `label / hint / description / error`。
3. 使用 `textarea`，不是用 CSS 假装多行的 `input`。
4. 注释写清楚：这是多行文本输入，供 JSON 文本等长内容场景使用。

设计缘由：

1. JSON 文本不是一行短字符串，继续塞单行框会直接损害可用性。
2. UI 层应提供正式组件，而不是在业务页内联原生 `textarea` 各写一套。

### packages/ui/src/index.ts

导出新的 `TextArea` 组件。

要求：

1. 业务页统一从 `@keymaster/ui` 入口使用。
2. 不允许业务页深路径 import `packages/ui/src/TextArea.tsx`。

### packages/plugin-key-import/src/ImportPage.tsx

把已解锁导入页升级为支持 JSON importer 的双输入方式。

要求：

1. 继续保持 WIF / Hex 原语义不变。
2. 当选中的 importer 是 JSON 且同时支持 `text` 与 `file` 时：
   - 先展示“输入方式”二选一
   - 再展示文件上传或多行文本框
3. 文本模式下：
   - 使用 `TextArea`
   - 用文本嗅探 envelope
   - 按需显示密码输入框
4. 文件模式下：
   - 继续使用文件上传
   - 用 bytes 嗅探 envelope
5. 解析前构造标准输入：
   - 文本模式 -> `{ kind: "text", text, password? }`
   - 文件模式 -> `{ kind: "file", name, content, password? }`
6. 切换输入方式、切换 importer、清除文件时，必须清掉与当前模式不一致的状态。

建议把 JSON 输入局部状态收敛清楚，避免继续堆在散乱的布尔值上。

### apps/web/src/shell/FirstTimeImportWizard.tsx

把首启导入向导升级为与 `ImportPage` 同步的 JSON 双输入模式。

要求：

1. 第 2 步当选中 JSON importer 时，先选输入方式，再输入文件或文本。
2. 文本模式支持 bsv8 嗅探与补密码重试。
3. `resolvedImportPassword` 的语义对文本 / 文件完全一致。
4. 切换输入方式、切换 importer、回退重选时，必须清掉已失效的：
   - `parsed`
   - `importRequiredPassword`
   - `resolvedImportPassword`
   - 密码草稿
5. 第 4 步如果走复用密码，必须不关心解析来源是文本还是文件，只关心“本次解析是否实际用了密码且成功”。

### apps/web/src/i18n/resources.ts

补充或调整 shell 层文案。

至少需要：

1. JSON 输入方式切换标签。
2. `JSON 文件`、`JSON 文本` 选项文案。
3. JSON 文本输入框 label / placeholder / hint。
4. 必要时补“切换输入方式会清空当前内容”的辅助说明。

要求：

1. 文案必须中英文同步。
2. 不靠 `defaultValue` 临时兜完整业务文案而不落资源。

### packages/plugin-key-import/src/ImporterPicker.tsx

视 manifest 改名结果，确认展示名称与描述无需额外特判。

要求：

1. 不在 picker 层硬编码“JSON 文本 / 文件”说明。
2. 输入方式切换属于页面输入区，不属于 importer 选择器。

如果 importer 改名为 `JSON`，这里应自然显示新名称，无额外逻辑。

## 不需要改的文件

本次不应触碰：

1. `packages/plugin-importer-wif/src/wifImporter.ts`
2. `packages/plugin-importer-hex/src/hexImporter.ts`
3. Vault 持久化与 `persistImport` 逻辑
4. `vault.createVaultWithImportedKey(...)` 契约与落库流程
5. 路由、菜单、插件注册装配逻辑

设计缘由：

1. 本次是 JSON 输入源统一化，不是整个导入系统重写。
2. 不相关模块不应被顺手重构。

## 最终验收清单

### 契约与 importer

- [ ] `KeyImportInput.text` 与 `KeyImportInput.file` 都支持可选 `password`。
- [ ] `json-file importer` 同时支持 `text` 与 `file`。
- [ ] 明文 JSON 在文件与文本两种来源下都能成功解析。
- [ ] bsv8 加密 JSON 在文件与文本两种来源下都要求密码。
- [ ] 两种来源缺密码时都抛同一条业务错误。
- [ ] 没有引入 importer 级 `requiresPassword` 静态字段。

### 系统导入页

- [ ] 已解锁导入页选择 JSON importer 后，能看到“JSON 文件 / JSON 文本”输入方式切换。
- [ ] 选择 `JSON 文件` 时，只显示文件上传控件。
- [ ] 选择 `JSON 文本` 时，只显示多行文本输入框。
- [ ] 文本模式粘贴明文 JSON 可以解析成功。
- [ ] 文本模式粘贴加密 JSON，会要求密码并可成功解析。
- [ ] 在文件 / 文本模式之间切换时，不会残留旧的密码状态、解析结果或错误。

### 首启导入向导

- [ ] 首启导入第 2 步在 JSON importer 下同样支持“文件 / 文本”切换。
- [ ] JSON 文本模式下也能走完整的 parse -> confirm -> set password 流程。
- [ ] 加密 JSON 文本解析成功后，第 4 步可以复用第 2 步的导入源密码。
- [ ] 返回上一步重选输入方式或重选 importer 后，不会复用失效的旧密码。

### UI 与文案

- [ ] 新增正式的多行 `TextArea` 组件，而不是业务页内联原生 `textarea`。
- [ ] `JSON` importer 名称与描述和其真实能力一致，不再误导为“仅文件”。
- [ ] 新增文案已补齐中英文资源。

### 回归

- [ ] WIF 文本导入不回归。
- [ ] Hex 文本导入不回归。
- [ ] 现有 JSON 文件导入不回归。
- [ ] 现有 bsv8 JSON 文件导入不回归。
- [ ] 错误信息代码里保持英文。

## 建议验证命令

```bash
npm test -- --run jsonFileImporter
npm test -- --run importFileSniff
npm test -- --run FirstTimeImportWizard
npm test -- --run ImportPage
```

如果当前仓库测试命名或过滤方式不适配，上述命令可按实际 `vitest` 用法调整，但验证范围不能缩。

## 完成定义

满足以下条件才算完成：

1. 两个入口都已支持 JSON 文件与 JSON 文本。
2. 加密 JSON 的密码语义在文件与文本之间完全一致。
3. 首启导入与已解锁导入两条路径没有各自维护的 JSON 特殊逻辑副本。
4. 测试已覆盖文件 / 文本、明文 / 加密、向导 / 系统导入页四个维度。
5. 旧的“JSON 只能文件输入”的产品与契约模型已被移除。
