# 003 前端多语言能力一次性硬切换施工单

## 目标

一次性建立 Web Wallet 的前端多语言能力。

本次不是先接一个页面级 `useTranslation()`，以后再慢慢处理菜单、设置、资产状态和插件文案；也不是保留中文硬编码作为长期主路径。完成后系统必须形成以下完整闭环：

```txt
启动解析语言
  有用户手动选择 -> 使用已保存语言
  无用户手动选择 -> 遍历浏览器语言并映射到系统支持语言
  无法映射       -> fallback 到 en

运行时展示文本
  React 组件文本
  route / menu / breadcrumb / settings / home / topbar 等 registry 文本
  db / provider 返回的状态 code
  动态插值、复数、日期、数字、金额

用户切换语言
  设置页选择语言
  保存到 localStorage
  i18n runtime 热切换
  当前页面、菜单、面包屑、设置项、状态文本同步刷新
  刷新页面后仍然有效
```

## 简述缘由

1. 当前项目是插件式前端，很多展示文本不是直接写在 React 页面里，而是提前注册到 `route.registry`、`menu.registry`、`settings.registry`、`home.registry` 等平台 registry。只在组件内调用翻译 hook 会漏掉这些文本。
2. `label: string` 这类 contract 会把注册时的展示文案固化下来。语言切换时，如果 registry 里保存的是已经翻译好的字符串，菜单、面包屑、设置页标题不会可靠热更新。
3. db 和 provider 应保存稳定业务 code，例如 `ready`、`syncing`、`confirmed`、`failed`。翻译后的中文或英文不能进 db，否则用户切换语言后旧数据无法重翻译。
4. 语言首屏能力应复用当前主题模块的工程模式：启动前同步读 localStorage、解析系统偏好、写入 `<html>` 属性、通过订阅热更新。主题已有同类边界，语言不需要引入更重的状态管理。
5. `i18next + react-i18next` 更适合当前项目：既能在 React 组件内热更新，也能在组件外给 registry、service、provider 渲染时调用 `t()`；同时支持 fallback、namespace、插值、复数和运行时 `changeLanguage`。
6. 浏览器语言检测必须受系统支持语言约束。不能把 `navigator.language` 原样当系统语言，否则 `en-US`、`en-GB`、`zh-Hans-CN` 等会制造资源缺失或重复语言目录。

## 硬切换边界

本施工单要求一次完成以下内容，不允许拆成“先接 i18next、后迁移文案”：

```txt
依赖引入
i18n contract
i18n service
i18n React hooks
启动语言解析
html lang 写入
registry 文本契约硬切换
公共 shell / settings / assets / home / topbar 渲染层改造
插件翻译资源
语言设置入口
动态状态 code 翻译
数字 / 日期 / 金额 locale 化
单元测试
构建与人工验收
```

可以分多个 commit 实施，但合并、发布和验收必须作为一个整体完成。中间态不能进入主分支。

## 核心不变量

1. 系统内部支持语言使用稳定短码，首批建议：

```txt
en
zh-CN
```

2. 默认系统语言固定为 `en`。
3. 用户未手动选择语言时，使用浏览器语言映射结果；映射失败使用 `en`。
4. 用户手动选择语言后必须持久化；刷新页面后继续使用手动选择，不再受浏览器语言影响。
5. 用户选择“跟随浏览器”时，必须清除手动语言覆盖，并重新按浏览器语言映射。
6. `navigator.language` / `navigator.languages` 只能作为输入，不能原样写入系统语言状态。
7. `route/menu/breadcrumb/settings/home/topbar/command` 等 registry 中不得长期保存“已翻译后的字符串”作为唯一数据源。
8. db、provider、service 返回的状态必须是稳定 code；显示层负责翻译。
9. 用户生成内容不翻译，例如联系人名称、Key 标签、用户输入备注、资产自定义名称。
10. 代码错误信息继续使用英文；文档、注释和 UI 中文资源使用中文。
11. 本地化资源缺失时必须 fail visible：开发测试中暴露缺 key；生产中显示 fallback 文案或 key，但不能静默显示错误语言的旧文案。
12. 语言切换不能触发 Vault 锁定、插件重新注册、IndexedDB 迁移或路由重载。

## 语言映射规则

### 支持语言

集中定义：

```ts
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;
export const DEFAULT_LANGUAGE = "en";
```

后续新增语言只能改这一处和对应资源，不允许插件自己定义独立支持语言列表。

### 浏览器语言输入

读取顺序：

```txt
navigator.languages[0..n]
navigator.language
DEFAULT_LANGUAGE
```

对每个候选语言执行规范化：

```txt
trim
把 "_" 替换成 "-"
按 BCP 47 语义处理大小写
非法或空字符串跳过
```

映射优先级：

```txt
精确匹配:
  en      -> en
  zh-CN   -> zh-CN

中文别名:
  zh-Hans, zh-Hans-CN, zh-SG -> zh-CN
  zh-Hant, zh-TW, zh-HK, zh-MO -> 如果系统支持 zh-TW 则 zh-TW，否则 zh-CN

英文区域:
  en-US, en-GB, en-AU, en-CA, en-* -> en

基础语言:
  xx-YY -> xx，前提是 xx 在 SUPPORTED_LANGUAGES 中

兜底:
  无匹配 -> en
```

注意：

1. 不做任意 `xxx-en` 后缀匹配。标准语言 tag 是 `en-US` 这种结构，不是任意字符串包含 `en`。
2. 不通过 IP、时区、地理位置推断语言。
3. 不把语言写入 URL path 或 hash。本项目不是内容站，当前需求是应用设置，不需要 SEO 语言路由。

## 不能怎么做

1. 不能只在页面组件里使用 `useTranslation()`，然后把 registry 文本留成中文字符串。
2. 不能在插件 setup 时调用 `t()` 并把结果注册进 registry。这会把当前语言固化，热切换失效。
3. 不能把 db 中已有或新增的状态写成中文/英文展示文案。
4. 不能让后端/API 返回完整 UI 文案再由前端直接展示。后端应返回 code 和参数，前端按当前语言翻译。
5. 不能引入长期双字段，例如 `label` 和 `labelKey` 并让两者都成为主路径。硬切换后 contract 应统一为 `I18nText`。
6. 不能让每个插件各自读写 `localStorage` 保存语言。语言状态只有一个入口。
7. 不能在语言切换时 `window.location.reload()`。
8. 不能为了翻译菜单而重新 bootstrap 全部插件。
9. 不能把 `i18next-browser-languagedetector` 作为唯一检测逻辑。可以参考它的 localStorage / navigator 顺序，但本项目需要明确系统语言映射和 `auto` 模式语义。
10. 不能把缺失翻译吞掉成空字符串。空字符串会让问题在 UI 上不可见。
11. 不能把错误对象 `Error.message` 全量翻译。代码错误信息保持英文；UI 可以按错误 code 显示本地化摘要。
12. 不能让语言资源文件里保存业务状态枚举之外的用户数据。

## 特殊情况处理

### localStorage 不可用

隐私模式、浏览器策略或异常环境下，localStorage 可能读写失败。

处理要求：

```txt
读取失败 -> mode = auto，activeLanguage = 浏览器映射或 en
写入失败 -> 当前内存语言仍然热切换成功，但刷新后可能丢失
UI 不弹 fatal error
测试覆盖 read/write throw
```

### 浏览器语言变化

浏览器没有统一的 language change 事件。处理要求：

```txt
mode = auto 时:
  页面刷新后按新的浏览器语言重新解析

mode = 手动语言时:
  浏览器语言变化不影响当前应用语言
```

不要用定时器轮询浏览器语言。

### 翻译资源缺失

处理要求：

```txt
开发 / 测试:
  缺 key 应暴露为测试失败或 console warning

生产:
  优先显示 I18nText.fallback
  没有 fallback 时显示 key
```

不能显示空白。

### 插件资源缺失

某插件未提供当前语言资源时：

```txt
先 fallback 到 en
仍缺失 -> fallback 文案或 key
```

插件不得因为缺少某个语言资源导致整个应用 bootstrap 失败，除非默认语言 `en` 资源也缺失且该插件注册了必须本地化的文本。

### 动态值插值

带参数的文案必须使用插值：

```txt
{ key: "vault.keyCreated", fallback: "Key 已创建：{{label}}", values: { label } }
```

不能手工拼接不同语言的句子片段，例如：

```txt
"Key 已创建：" + label
```

### 富文本翻译

需要链接、强调、代码片段的句子使用 `Trans` 或等价封装。

不能把 HTML 字符串放进翻译资源后用 `dangerouslySetInnerHTML` 渲染。

### 日期、数字、金额

处理要求：

```txt
日期 -> Intl.DateTimeFormat(activeLanguage)
数字 -> Intl.NumberFormat(activeLanguage)
金额 -> 单位和数字分开处理；链上单位 code 不翻译，展示标签可翻译
```

`sats`、`BSV` 这类链上单位作为单位 code 保持稳定；“余额”“金额”等 UI 标签翻译。

### 网络/API 错误

后端或第三方 API 错误分两层：

```txt
日志 / Error.message:
  英文，保留原始诊断信息

UI:
  按错误 code 翻译，例如 network.timeout / woc.rateLimited
  无 code 时显示通用本地化错误，并保留可展开的英文 details
```

### 旧数据

旧 IndexedDB 里如果已经存了中文标题或活动标题：

```txt
能识别为枚举状态的字段 -> 改 provider 输出 code
确实是历史用户可见文本 -> 当作用户/外部数据，不强行翻译
```

本施工单不做 IndexedDB 内容清洗，除非发现某个字段明确违反“状态 code”设计并影响热切换。

## 技术方案

### 翻译引擎

引入：

```txt
i18next
react-i18next
```

暂不引入：

```txt
i18next-browser-languagedetector
i18next-http-backend
i18next-localstorage-backend
```

设计缘由：

1. 语言检测和持久化需要项目自定义 `auto` 语义，薄层自己写更可控。
2. 首批资源随插件打包即可，不需要 HTTP backend。
3. 翻译资源体积可控，暂不需要 localStorage 缓存资源。

### 文本描述类型

在 contracts 中新增统一类型：

```ts
export type I18nValues = Record<string, string | number | boolean | null | undefined>;

export type I18nText =
  | string
  | {
      key: string;
      fallback: string;
      values?: I18nValues;
    };
```

语义：

1. `string` 只作为兼容输入和极少数不可翻译文本，不作为新增 UI 文案主路径。
2. 新增和迁移后的平台 UI 文案必须使用 `{ key, fallback }`。
3. `fallback` 是默认语言缺 key 时的可见兜底，不是主要翻译源。

### i18n service

新增 capability：

```txt
i18n.service
```

接口建议：

```ts
export interface I18nService {
  mode(): LanguageMode;
  language(): SupportedLanguage;
  supported(): readonly SupportedLanguageDescriptor[];
  t(key: string, values?: I18nValues): string;
  text(input: I18nText | undefined): string;
  setLanguage(language: SupportedLanguage): Promise<void>;
  setAuto(): Promise<void>;
  registerResources(pluginId: string, resources: I18nPluginResources): void;
  onChange(handler: (language: SupportedLanguage) => void): () => void;
}
```

设计缘由：

1. `t()` 给组件外的 registry 渲染点使用。
2. `text()` 统一处理 `I18nText`、fallback 和缺 key。
3. `registerResources()` 允许插件按 namespace 提供自己的资源。
4. `onChange()` 让 shell、settings、registry 渲染点在语言切换后重渲染。

### React hooks

runtime 新增：

```txt
useI18n()
useI18nText(input)
useLocale()
```

要求：

1. hook 内部订阅 `i18n.service.onChange()`。
2. 切换语言后必须触发使用 hook 的组件重渲染。
3. 不要求业务组件直接 import i18next 实例。

### 插件资源注册

`PluginManifest` 增加可选字段：

```ts
i18n?: I18nPluginResources;
```

资源示例：

```ts
export const homePlugin: PluginManifest = {
  id: "home",
  name: "Home",
  i18n: {
    namespace: "home",
    resources: {
      en: { "route.label": "Home" },
      "zh-CN": { "route.label": "首页" }
    }
  },
  setup(ctx) {
    ...
  }
};
```

runtime 在执行插件 setup 前注册资源。

设计缘由：

1. 插件 setup 注册 route/menu 时就可以引用自己的 translation key。
2. 资源注册由 runtime 统一处理，避免每个插件手写 `ctx.get("i18n.service").registerResources(...)`。

## 文件级施工

### package.json

新增运行时依赖：

```json
"i18next": "...",
"react-i18next": "..."
```

要求：

1. 更新根 `package-lock.json`。
2. 不引入 detector/backend/cache 插件。
3. 版本使用当前 npm 最新稳定小版本，避免 alpha/beta。

### packages/contracts/src/i18n.ts

新增 i18n 公共契约。

必须包含：

```txt
SUPPORTED_LANGUAGES
DEFAULT_LANGUAGE
SupportedLanguage
LanguageMode
SupportedLanguageDescriptor
I18nValues
I18nText
I18nPluginResources
I18nService
I18N_SERVICE_CAPABILITY
```

注释要求：

1. 中文注释说明 `I18nText` 的设计缘由。
2. 错误信息示例使用英文。

### packages/contracts/src/index.ts

导出 `i18n.ts`。

### packages/contracts/src/navigation.ts

把以下字段硬切换为 `I18nText`：

```txt
AppRoute.label
MenuItem.label
BreadcrumbItem.label
```

保留字段名 `label`，不新增 `labelKey`。

设计缘由：

```txt
调用方语义仍然是“展示标签”，只是标签值从 string 扩展为可翻译描述。
```

### packages/contracts/src/settings.ts

把以下字段硬切换为 `I18nText`：

```txt
SettingsField.label
SettingsField.description
SettingsField.options[].label
SettingsPage.label
SettingsPage.description
```

注意：

1. `defaultValue`、`value` 不翻译。
2. select 的 `value` 是稳定 code，不能本地化。

### packages/contracts/src/home.ts

把以下字段硬切换为 `I18nText`：

```txt
HomeWidget.title
```

### packages/contracts/src/topbar.ts

把以下字段硬切换为 `I18nText`：

```txt
TopbarItem.label
```

### packages/contracts/src/transfer.ts

检查并硬切换 provider/offer/action 中面向 UI 的 `label/title/description` 字段为 `I18nText`。

稳定业务字段、id、network、assetId 不翻译。

### packages/contracts/src/keyImport.ts

检查 importer 展示字段：

```txt
name
description
```

如用于 UI 展示，硬切换为 `I18nText`。

### packages/contracts/src/assets.ts

调整展示字段边界：

1. `AssetProvider.name` 切换为 `I18nText`。
2. `AssetSummary.label` 保持 `string | I18nText` 需要谨慎判断：
   - 系统内置资产名称，例如 BSV，可用 `I18nText`。
   - 用户自定义资产名、链上名称、外部 token name，不强制翻译。
3. `AssetActivity.title` 切换为 `I18nText` 或新增稳定 `kind/status` code 后由显示层翻译。

要求：

```txt
不要把链上资产名强制翻译。
不要把 provider 内部状态直接展示为英文枚举。
```

### packages/contracts/src/plugin.ts

`PluginManifest` 增加：

```ts
i18n?: I18nPluginResources;
```

`PluginContext` 不强制增加 i18n 字段，插件仍通过 capability 读取服务。

设计缘由：

```txt
manifest 声明资源，runtime 统一注册；需要运行时翻译的插件再显式 get i18n.service。
```

### packages/runtime/src/i18n/languageMap.ts

新增浏览器语言映射模块。

必须导出：

```txt
normalizeLanguageTag(input)
mapBrowserLanguage(input)
resolveBrowserLanguage(candidates)
```

测试必须覆盖：

```txt
en -> en
en-US -> en
en_GB -> en
zh-CN -> zh-CN
zh-Hans -> zh-CN
zh-Hans-CN -> zh-CN
zh-SG -> zh-CN
zh-TW -> zh-CN（在未支持 zh-TW 时）
fr-FR -> en
空字符串 / 非法字符串 -> en
多个 candidates 时第一个可映射项胜出
```

### packages/runtime/src/i18n/i18nStore.ts

新增语言状态 store。

参考 `apps/web/src/theme/themeStore.ts` 的结构，但放在 runtime 中，避免 app 和插件各自实现。

必须包含：

```txt
applyInitialLanguage()
getLanguageMode()
getLanguage()
setLanguage(language)
setAutoLanguage()
subscribe(handler)
```

副作用：

```txt
读写 localStorage: web-wallet.languageMode
写 <html lang="...">
```

注意：

1. localStorage 异常必须吞掉并走兜底。
2. `setLanguage()` 保存手动语言。
3. `setAutoLanguage()` 保存 `auto` 或删除手动 key，二者择一但语义必须清晰。
4. 不监听浏览器语言变化事件。

### packages/runtime/src/i18n/createI18nService.ts

创建 i18next 实例并包装为 `I18nService`。

要求：

1. 初始化时使用 `DEFAULT_LANGUAGE` 和当前 `i18nStore.getLanguage()`。
2. `fallbackLng = DEFAULT_LANGUAGE`。
3. `supportedLngs = SUPPORTED_LANGUAGES`。
4. `interpolation.escapeValue = false`，React 已处理 escaping。
5. `changeLanguage()` 完成后再 emit。
6. `text(input)` 支持 `string`、`{ key, fallback, values }` 和 `undefined`。
7. `registerResources(pluginId, resources)` 必须按 namespace 注入。
8. 默认语言 `en` 的公共 namespace 缺失时应在测试中失败。

### packages/runtime/src/react/useI18n.ts

新增 React hook。

必须使用 `useSyncExternalStore` 或等价稳定订阅方式，避免语言切换后遗漏重渲染。

导出：

```txt
useI18n()
useI18nText(input)
useLocale()
```

### packages/runtime/src/createPluginHost.ts

在 host 创建时先创建 i18n service，再作为内置 capability 注册：

```txt
capabilities.provide<I18nService>("i18n.service", i18n)
```

插件注册流程调整：

```txt
依赖检查
注册 plugin.i18n 资源
执行 plugin.setup(ctx)
```

设计缘由：

```txt
setup 中注册 registry 时可能引用该插件的 i18n key，资源必须先可用。
```

### packages/runtime/src/index.ts

导出 i18n service、语言 store 和 hooks。

### apps/web/src/main.tsx

启动顺序硬切换为：

```txt
applyInitialTheme()
applyInitialLanguage()
normalizeLegacyHashRoute()
checkEnvironment()
bootstrapPlugins()
React mount
```

要求：

1. `applyInitialLanguage()` 必须在 React mount 前执行。
2. 首帧前写入 `<html lang="...">`。
3. 不阻塞环境检查。

### apps/web/src/App.tsx

将启动 loading 文案改为 `I18nText` 渲染。

如果 `i18n.service` 尚未可用，允许显示默认英文 fallback，但正常路径下 service 在 host 创建时已存在。

### apps/web/src/shell/Sidebar.tsx

菜单渲染必须使用 `i18n.text(item.label)`。

注意：

1. 语言切换后 Sidebar 必须重渲染。
2. `group` 不作为展示文案；如果未来展示 group 名，必须走 i18n key。

### apps/web/src/shell/Breadcrumbs.tsx

面包屑渲染必须使用 `i18n.text(crumb.label)`。

异步 `resolve()` 的结果如果带动态用户数据，插件应明确传入普通 string 或 `{ key, values }`。

### apps/web/src/shell/RouteRenderer.tsx

404 / loading / route label 等文案必须走 i18n。

不要在 route 匹配逻辑中依赖翻译后的 label。

### apps/web/src/shell/Topbar.tsx

topbar item label / tooltip 必须走 i18n。

### packages/plugin-settings/src/SettingsPage.tsx

设置页硬切换为 i18n 渲染。

必须新增平台语言设置区：

```txt
语言
  跟随浏览器
  English
  简体中文
```

交互要求：

1. 切换后立即调用 `i18n.setAuto()` 或 `i18n.setLanguage(language)`。
2. 成功后无需刷新，当前页面文案立即热更新。
3. 保存失败仅可能来自 localStorage 写入失败；内存切换仍生效，UI 可显示非致命提示。
4. 设置项自身的 label/options 也必须能热更新。

### packages/ui/src/index.ts

移除硬编码 `en-US` 的格式化。

处理方案：

1. 若是纯工具函数，增加 locale 参数：

```ts
formatSats(value, locale)
```

2. 调用方通过 `useLocale()` 传入当前语言。
3. 不让 UI 包直接依赖 runtime，避免包边界倒置。

### packages/plugin-home/src/manifest.ts

新增 `i18n` 资源。

迁移：

```txt
首页 route label
首页 menu label
```

### packages/plugin-settings/src/manifest.ts

新增 `i18n` 资源。

迁移：

```txt
设置 route label
设置 menu label
设置页面公共文案
语言设置文案
```

### packages/plugin-vault/src/manifest.ts

新增 `i18n` 资源。

迁移：

```txt
解锁钱包
创建钱包
Key 管理
设置 / Key 管理 面包屑
锁定钱包 command label
切换 Key topbar label
```

### packages/plugin-vault/src/*.tsx

迁移 Vault 页面文案：

```txt
VaultCreatePage
VaultUnlockPage
VaultSettingsPage
VaultKeyCreateModal
VaultKeyExportModal
VaultKeyDeleteModal
KeySwitchWidget
```

要求：

1. 表单校验 UI 文案本地化。
2. Error.message 保持英文；展示给用户的摘要本地化。
3. Key 标签、指纹、公钥不翻译。

### packages/plugin-assets/src/manifest.ts

新增 `i18n` 资源。

迁移：

```txt
资产 route/menu/widget label
资产详情 route label
```

### packages/plugin-assets/src/*.tsx

迁移资产平台页面文案：

```txt
AssetsPage
AssetsHomeWidget
AssetDetailPage
AssetDetailRedirect
```

必须把状态 code 翻译：

```txt
AssetStatus.ready
AssetStatus.syncing
AssetStatus.stale
AssetStatus.failed
AssetStatus.unsupported

AssetActivity.direction.in
AssetActivity.direction.out
AssetActivity.direction.self
AssetActivity.direction.info

AssetActivity.status.confirmed
AssetActivity.status.unconfirmed
AssetActivity.status.pending
AssetActivity.status.failed
```

### packages/plugin-p2pkh/src/*

新增 `i18n` 资源并迁移 P2PKH 展示文本。

重点：

1. provider name 可翻译。
2. BSV / BSV Testnet 这类资产标识不强制翻译。
3. 同步状态、后台状态、空态、按钮文案必须翻译。
4. WOC 错误摘要本地化，原始英文 details 保留。

### packages/plugin-woc/src/*

新增 `i18n` 资源并迁移 WOC 设置页、后台任务展示文本。

要求：

1. URL、API path、错误 details 不翻译。
2. `rate limited`、`timeout`、`background sync` 等展示摘要翻译。

### packages/plugin-background/src/*

新增 `i18n` 资源并迁移后台任务托盘文案。

后台任务 id 不翻译；展示 label/status 翻译。

### packages/plugin-contacts/src/*

新增 `i18n` 资源并迁移联系人页面文案。

联系人姓名、地址、备注不翻译。

### packages/plugin-transfer/src/*

新增 `i18n` 资源并迁移转账页面文案。

金额单位、地址、txid 不翻译。

### packages/plugin-key-import/src/*

新增 `i18n` 资源并迁移导入流程文案。

Importer 的展示名和说明走 `I18nText`；解析错误的底层英文 message 保留，UI 摘要本地化。

### packages/plugin-importer-wif/src/manifest.ts

新增 importer 名称和说明的 i18n 资源。

WIF 字样不翻译。

### packages/plugin-importer-hex/src/manifest.ts

新增 importer 名称和说明的 i18n 资源。

HEX 字样不翻译。

### packages/plugin-importer-json-file/src/manifest.ts

新增 importer 名称和说明的 i18n 资源。

文件格式名不翻译。

### tests

新增或调整测试：

```txt
packages/runtime/src/i18n/languageMap.test.ts
packages/runtime/src/i18n/i18nStore.test.ts
packages/runtime/src/i18n/createI18nService.test.ts
packages/runtime/src/react/useI18n.test.tsx
```

现有受影响插件测试需要同步更新类型和文案断言。

测试要求：

1. 不用快照大面积锁中文 UI。
2. 断言 key 行为、fallback、热切换和状态 code 翻译。
3. localStorage throw 场景必须覆盖。
4. `setLanguage("zh-CN")` 后 registry label 渲染必须变化。
5. 缺失 key 返回 fallback；无 fallback 返回 key。

## 翻译 key 规范

key 使用稳定 namespace + 语义路径：

```txt
common.action.save
common.action.cancel
settings.language.title
settings.language.auto
vault.route.settings
vault.key.status.active
assets.status.ready
p2pkh.sync.status.failed
```

规则：

1. 不把中文或英文句子当 key。
2. 不用组件文件路径作为唯一 key，避免重构文件导致翻译 key 大面积变化。
3. 通用动作进 `common` namespace。
4. 插件私有文案进插件 namespace。
5. 状态枚举 key 必须和业务 code 一一对应。

## 资源文件要求

首批资源：

```txt
en
zh-CN
```

要求：

1. `en` 必须完整。
2. `zh-CN` 必须完整，不允许靠 fallback 大面积显示英文。
3. 每个插件资源按 namespace 独立。
4. 插值变量名必须稳定，不随语言变化。
5. 不把 HTML 字符串写入资源。

## 最终验收清单

### 自动化验收

必须通过：

```txt
npm run typecheck
npm run test
npm run build
npm run lint:boundaries
```

必须新增并通过以下能力测试：

```txt
语言映射:
  en-US -> en
  en-GB -> en
  zh-Hans-CN -> zh-CN
  zh-TW -> zh-CN（未支持 zh-TW 时）
  fr-FR -> en

持久化:
  无存储 -> 浏览器映射或 en
  手动 zh-CN -> 刷新后 zh-CN
  手动 en -> 刷新后 en
  跟随浏览器 -> 清除手动覆盖
  localStorage throw -> 不崩溃

热切换:
  当前页面标题更新
  Sidebar 菜单更新
  Breadcrumb 更新
  Settings label/options 更新
  Asset status code 更新

fallback:
  缺当前语言 key -> en 或 fallback
  缺全部资源但有 fallback -> fallback
  缺全部资源且无 fallback -> key
```

### 人工验收

在浏览器中执行以下流程：

1. 清空 `localStorage["web-wallet.languageMode"]`，把浏览器语言设为 `en-US`，打开应用，首屏显示英文，`<html lang="en">`。
2. 清空语言设置，把浏览器语言设为 `zh-CN` 或 `zh-Hans-CN`，打开应用，首屏显示简体中文，`<html lang="zh-CN">`。
3. 浏览器语言为不支持语言，例如 `fr-FR`，打开应用，首屏显示英文。
4. 在设置页选择“简体中文”，不刷新页面，菜单、面包屑、设置项、当前页面文案立即变中文。
5. 刷新页面后仍为简体中文。
6. 在设置页选择 `English`，不刷新页面，菜单、面包屑、设置项、当前页面文案立即变英文。
7. 刷新页面后仍为英文。
8. 选择“跟随浏览器”，刷新页面后重新按浏览器语言映射。
9. Vault 锁定态、解锁态、Key 管理页、新建/导出/删除 Modal 文案均随语言切换。
10. 资产列表、资产详情、P2PKH 首页 widget、WOC 设置页、后台托盘状态均随语言切换。
11. 联系人姓名、Key 标签、地址、txid、公钥、URL、API path 不被翻译。
12. 日期、数字、sats 金额按当前语言格式化；链上单位 code 不被错误翻译。
13. 语言切换过程中不会触发页面刷新、Vault 锁定、插件重复注册或 IndexedDB 迁移。
14. 控制台没有缺 key warning；如果刻意删掉一个 key，UI 显示 fallback 或 key，不显示空白。

### 代码验收

检查以下事项：

1. 新增 UI 文案不再直接写死中文或英文字符串，必须走 `I18nText` 或 `t()`。
2. 插件 setup 不调用 `t()` 注册已翻译 label。
3. registry 渲染点统一使用 `i18n.text(...)`。
4. 状态枚举显示统一走 key 映射。
5. `packages/ui` 不直接依赖 runtime。
6. `localStorage` 只由 i18n store 读写语言设置。
7. 没有引入 URL 语言路由、IP 语言判断、后台组合 UI 文案。
8. 错误信息字符串仍为英文，用户可见摘要走本地化。
9. `en` 和 `zh-CN` 资源 key 集合一致。
10. 删除临时兼容代码，不保留 `labelKey` / `labelText` 双轨。

## 参考依据

1. i18next fallback：`https://www.i18next.com/principles/fallback`
2. i18next API / `changeLanguage`：`https://www.i18next.com/overview/api`
3. react-i18next namespace：`https://react.i18next.com/guides/multiple-translation-files`
4. i18next browser language detector 的 detection/caches/supportedLngs 设计参考：`https://github.com/i18next/i18next-browser-languageDetector`
