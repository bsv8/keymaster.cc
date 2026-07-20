# 003 Runtime Resource Store、精确订阅与页面数据边界硬切换一次性迭代施工单

## 0. 优先级、范围与硬切原则

本单把近期首页重复渲染问题收口为框架能力，而非继续要求每个页面自行处理
`useEffect`、请求去重、事件合并和 state 相等判断。

发生冲突时按以下顺序执行：

1. 本单定义的 **Resource Store 是 React 读业务数据、订阅业务数据变更的唯一框架入口**。
2. 本单为一次性**硬切换**：删除旧的页面式数据加载/订阅路径；不保留 adapter、
   feature flag、双读、旧 hook 兼容层或“暂时允许”的例外名单。
3. SharedWorker、Vault、active key、插件热卸载、provider DB snapshot、后台任务与
   `I18nService` 的既有真值边界不变。本单只改变页面如何观察这些真值。
4. 页面和 widget 只能声明自己需要的资源及 selector；它们不得自行协调请求、
   订阅 provider、合并通知或按事件写业务数据 state。

本单覆盖 `apps/web` 及全部 `packages/plugin-*` 的 React 页面和 widget；不改变 WOC
协议、资产/交易数据模型、后台任务频率或 UI 视觉设计。

---

## 1. 简述缘由

本次首页问题表明，现有模式把同一类并发控制散落在页面中：

- 页面重复调用订阅型 `useI18n()`，产生冗余订阅；
- `AssetsHomeWidget` 为每个 provider 的完成事件分别 `setState`；
- P2PKH、资产、联系人等组件各自维护 `aliveRef`、revision、订阅清理和 reload；
- `AppShell`、registry、provider 和后台事件各自用不同粒度的更新信号；
- `data-changed` 合并临时放在 `bootstrapPlugins.ts`，装配层不应拥有领域事件策略。

React StrictMode 并不是根因；它只是正确暴露了副作用不可重复执行、请求没有去重、
状态发布不按语义比较的问题。关闭 StrictMode 只能隐藏问题，不能防止生产环境的
重复事件、切 key、跨标签页通知和插件热卸载再次触发同类故障。

最终模型必须是：

```text
后台任务 / Vault / provider DB / registry
        │  失效事件（不携带第二份业务真值）
        v
Runtime Resource Store
  key、scope、请求去重、取消、缓存、批处理、语义相等、精确订阅
        v
useResource / useResourceSelector
        v
React 页面与 widget（仅渲染资源 snapshot + 本地交互 state）
```

---

## 2. 最终架构与唯一职责

### 2.1 新增资源契约

新增 `packages/contracts/src/resource.ts`，并从 `packages/contracts/src/index.ts` 导出。

```ts
export type ResourceKey = readonly [resourceId: string, ...parts: readonly string[]];
export type ResourceStatus = "pending" | "ready" | "stale" | "error" | "blocked";

export interface ResourceSnapshot<T> {
  readonly key: ResourceKey;
  readonly status: ResourceStatus;
  readonly data: T | undefined;
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
}

export interface ResourceDefinition<T, TArgs extends readonly string[] = readonly string[]> {
  readonly id: string;
  readonly scope: "global" | "active-key";
  key(args: TArgs, context: ResourceContext): ResourceKey;
  load(args: TArgs, context: ResourceContext, signal: AbortSignal): Promise<T>;
  subscribe?(args: TArgs, context: ResourceContext, invalidate: () => void): () => void;
  equals?(previous: T | undefined, next: T | undefined): boolean;
  readonly invalidation: "immediate" | "microtask";
}

export interface ResourceRegistry {
  register<T, TArgs extends readonly string[]>(definition: ResourceDefinition<T, TArgs>): void;
  unregister(id: string): void;
  get<T, TArgs extends readonly string[]>(id: string): ResourceDefinition<T, TArgs> | undefined;
}

export const RESOURCE_REGISTRY_CAPABILITY = "resource.registry";
```

约束：

- `ResourceKey` 必须是稳定、可比较、无秘密信息的字符串元组；不得包含密码、私钥、
  未脱敏 payload、随机数或整个对象 JSON。
- `scope: "active-key"` 的 key 必须含当前 `activePublicKeyHex`；切换 key 后，旧 key
  的请求和事件绝不能写入新 key snapshot。
- `load()` 只能读取本地服务/DB；页面资源不得调用 WOC、`fetch` 或启动后台同步。
- `equals()` 以业务语义决定是否发布新 snapshot；缺省使用 runtime 提供的
  `Object.is`。资源作者不得用“每次创建新数组/对象”强迫订阅者重渲染。
- `subscribe()` 只表达失效，不直接把业务数据 `setState` 给 React；返回的取消函数必须
  幂等。

`ResourceContext` 由 runtime 创建，包含稳定的只读 capability reader、当前 active-key
快照、语言以外的资源上下文和 plugin owner。页面不能构造或缓存它。

### 2.2 Runtime Resource Store

新增：

- `packages/runtime/src/resources/resourceRegistry.ts`
- `packages/runtime/src/resources/resourceStore.ts`
- `packages/runtime/src/react/useResource.ts`
- `packages/runtime/src/react/useResourceSelector.ts`

`createPluginHost()` 创建唯一 `ResourceRegistry` 和 `ResourceStore`，通过 capability
提供 registry；store 是 runtime 私有实现，不直接让插件绕过 hook 操作内部 Map。

每个 `(definition.id, ResourceKey)` 只有一个 record，且包含：

```text
snapshot / inFlight promise / AbortController / subscribers /
invalidationScheduled / loadRevision / owner / provider unsubscribe
```

必须实现以下不变量：

1. 同 key 并发 `ensure()` 复用同一个 in-flight Promise；StrictMode 双挂载不得发双请求。
2. `invalidate()` 只标记失效；`microtask` 类型在当前事件轮次合并一次，随后只 load 一次。
3. 新 load 开始时取消旧 load；不能取消的底层读取必须用 `loadRevision` 拒绝旧结果。
4. `load()` 成功后仅在 key、owner、revision 仍匹配且 `equals()` 判定变化时发布新 snapshot。
5. 失败保留最后一个 `data`，状态为 `stale` 或 `error`；不得用空数组、零余额或
   `undefined` 覆盖最后成功快照。
6. `blocked` 是预期可恢复状态（Vault 锁定、无 active key、初始化中）；不得 throw，
   不得写 fatal 通道。
7. 最后一个 React subscriber 取消订阅时允许延迟 abort pending load；不得清除有效缓存。
8. plugin disable/unregister 时，runtime 必须按 owner 取消请求、取消 provider 订阅、删除
   records 和 definitions；之后任何旧回调都不得发布数据。

`useResource(id, args)` 负责 ensure + `useSyncExternalStore` 订阅并返回完整 snapshot。
`useResourceSelector(id, args, selector, equality?)` 只在 selector 结果发生语义变化时
重渲染；selector 和 equality 必须为纯函数。所有 registry/read-model UI 使用该 hook，
不得以 `host.version()` 作为粗粒度刷新源。

### 2.3 事件合并的最终归属

修改 `AssetDataNotifier`：它是 asset/token DB 失效事件的唯一合并边界。

- `packages/contracts/src/assets.ts` 为 `AssetDataNotifier` 增加明确的合并语义：同一
  `providerId + publicKeyHex` 的同一 microtask 内事件合并，`kinds` 求并集，revision 取
  最新事件。
- `packages/runtime/src/createPluginHost.ts` 中的 `createAssetDataNotifier()` 实现该规则。
- 删除 `apps/web/src/bootstrapPlugins.ts` 中的 `createDataChangedCoalescer()` 及其导出；
  装配层只把 Coordinator `data-changed` 转发给 notifier。

不允许 plugin、页面或 `bootstrapPlugins` 再创建 provider/key 维度的 debounce、timer 或
事件合并器。其它非资产资源若需要相同策略，使用 Resource Store 的
`invalidation: "microtask"`，不得复制 AssetDataNotifier。

### 2.4 React 与 i18n 最终边界

`useI18n()` 已是订阅 hook。最终规则：

```ts
// 唯一允许形式
const { t, text, language } = useI18n();

// 禁止：额外调用只为“触发刷新”
useI18n().language();
```

移除 `UseI18nResult.language()` 的“用于强制重渲染”暗示；它只能作为当前语言的普通读取
API。语言切换由 hook 本身的 `useSyncExternalStore` 订阅驱动。新增 AST 静态检查，禁止
`useI18n().language()`、同一函数组件内多次 `useI18n()`，以及 React 文件直接使用
`react-i18next`（`plugin-poker` 也迁移至 runtime `useI18n`）。

---

## 3. 页面允许与禁止的写法

### 3.1 必须怎样做

插件在 `setup()` 中注册资源定义；页面只读取资源：

```ts
// plugin-assets manifest/setup
resources.register({
  id: "assets.holdings",
  scope: "active-key",
  key: (_args, context) => ["assets.holdings", context.activePublicKeyHex ?? "none"],
  load: (_args, context, signal) => loadHoldingsFromLocalProviders(context, signal),
  subscribe: (_args, context, invalidate) => context.assetsNotifier.subscribe(invalidate),
  equals: equalHoldingRows,
  invalidation: "microtask"
});

// React
const rows = useResourceSelector("assets.holdings", [], (snapshot) => snapshot.data?.rows ?? EMPTY_ROWS, shallowEqualRows);
```

页面本地 state 只允许保存交互临时值：输入框、展开状态、modal 开关、当前 tab、按钮 pending
状态、未提交 draft。用户命令返回 `CommandResult` 的处理仍由事件 handler 显式消费；它不是
可缓存 read resource。

### 3.2 绝对不能怎样做

完成后，以下生产代码必须不存在：

```text
React 页面 / widget
  -> useEffect(() => service.list...; setState(...))
  -> provider.onChange(... setState ...)
  -> service.onDataChanged(... reload ...)
  -> keyspace.onActiveChange(... reload ...)
  -> 自建 aliveRef / revisionRef / AbortController 来管理业务 read
  -> setInterval / setTimeout / queueMicrotask 来合并业务数据刷新
  -> host.version / useHostVersion 用作数据刷新触发器
  -> WocService / fetch / BackgroundService.trigger
```

不得：

- 用 `React.memo`、关闭 StrictMode、延长 debounce 或吞掉 state 更新来掩盖未收口的资源边界；
- 引入 TanStack Query、SWR 等第二套独立 cache。Resource Store 必须服从 plugin owner、
  active-key、Coordinator 和热卸载语义，不能出现两个不互相知道的缓存真值；
- 为旧 `AssetsHomeWidget` / `P2pkhBalanceWidget` loader 保留“过渡 adapter”；旧 loader、
  旧订阅和旧测试直接删除；
- 让资源 `load()` 因预期业务状态 reject 或抛出含敏感数据的 Error；
- 将 provider 返回值另存为通用全局资产表。Resource Store 是内存 read cache，不是新的
  持久化业务真值。

---

## 4. 特殊情况与固定处理

| 情况 | 必须处理 | 不得处理 |
|---|---|---|
| React StrictMode 双挂载 | Resource Store 同 key 复用 in-flight；订阅可重复注册/清理 | 关闭 StrictMode、页面加布尔锁 |
| active key 切换 | key 含 key hex；abort/ignore 旧 revision；新 scope 独立 load | 清空后复用旧 key 的结果、用全局 `latest` 覆盖 |
| Vault locked / keyspace 初始化 | 发布 `blocked`，保留旧成功数据或显示受控空态 | throw、fatal、把未知余额显示为 0 |
| provider 同轮多次通知 | notifier/store microtask 合并一次，kinds 求并集 | 每个事件直接 reload、各页面自行 debounce |
| provider 数据语义未变 | `equals` 返回 true，不发布新 snapshot | 每次创建数组后无条件 `setState` |
| loader 慢、失败或取消 | 保留 stale 数据；error 脱敏；旧 revision 忽略 | 清空成功数据、让晚到请求覆盖新数据 |
| plugin disable / unregister | runtime 按 owner dispose record、abort、unsubscribe | 保留后台 listener、保留缓存给已卸载组件 |
| 参数化详情页 | key 含稳定 route 参数；参数变化自动切换 record | 用组件 effect 手动 reset/reload |
| 用户点击“刷新/立即运行” | 仅调用 BackgroundService `runNow()`，消费 CommandResult；资源收到 DB 已提交事件后自行失效 | 页面直接 network load 或把命令结果当成新余额 |
| 非 React 调用者 | 使用 Resource Store 的受限 `ensure/read/invalidate` 服务 API | import React hook、复制 loader/cache |
| 测试 / SSR | `getServerSnapshot` 稳定；测试显式 reset store/counters | 依赖全局残留 cache、依赖 timing sleep |

---

## 5. 文件级施工清单

### 5.1 Contracts 与 runtime（必须先完成，但不作为分阶段上线）

| 文件 | 必须修改 |
|---|---|
| `packages/contracts/src/resource.ts` | 新增 Resource key、definition、snapshot、registry 契约与 capability key。 |
| `packages/contracts/src/index.ts` | 导出 resource 契约。 |
| `packages/contracts/src/assets.ts` | 固化 `AssetDataNotifier` 的 provider/key microtask 合并契约。 |
| `packages/runtime/src/resources/resourceRegistry.ts` | 实现 owner-aware definition registry；重复 id 抛错，disable 时可回收。 |
| `packages/runtime/src/resources/resourceStore.ts` | 实现 in-flight 去重、abort、revision、snapshot、selector subscription、相等判断、失效批处理、owner dispose。 |
| `packages/runtime/src/react/useResource.ts` | 实现完整 snapshot hook；不得暴露 store 内部可变对象。 |
| `packages/runtime/src/react/useResourceSelector.ts` | 实现 selector/equality 的精确订阅 hook。 |
| `packages/runtime/src/react/useI18n.ts` | 删除“额外读取语言以触发刷新”的使用路径；保持单 hook 订阅。 |
| `packages/runtime/src/createPluginHost.ts` | 创建并 provide resource registry/store；在 plugin ownership purge 时回收资源；把 AssetDataNotifier 合并实现迁入此处。 |
| `packages/runtime/src/pluginOwnership.ts` | 记录 plugin 注册的 resource definition id，确保 disable/unregister 精确回收。 |
| `packages/runtime/src/index.ts` | 导出 public React hooks 与 contracts 所需类型，不导出可破坏 owner 边界的 store Map。 |
| `packages/runtime/src/react/renderCounter.ts` | 保留开发/测试计数能力；生产必须 no-op。新增独立测试。 |

### 5.2 装配与静态边界

| 文件 | 必须修改 |
|---|---|
| `apps/web/src/bootstrapPlugins.ts` | 删除 `createDataChangedCoalescer`；只转发 Coordinator event 给 runtime notifier。 |
| `apps/web/src/bootstrapPlugins.test.ts` | 删除装配层 coalescer 测试；测试转移至 runtime notifier。 |
| `scripts/check-react-resource-boundaries.mjs` | 新增 TypeScript AST 检查：禁止 React 页面/widget 的业务 `on*` 订阅 + `setState`、原始 provider reload、`useI18n().language()`、重复 `useI18n()`、直接 `react-i18next`。 |
| `package.json` | 新增 `lint:react-boundaries`，并纳入 CI 的 `test` 或检查流水线。 |

### 5.3 资源定义与页面迁移

| 文件 | 必须修改 |
|---|---|
| `packages/plugin-assets/src/manifest.ts`、`holdingsFlow.ts` | 注册 `assets.holdings` 资源；loader 仅聚合本地 provider read API；定义 HoldingRow 语义相等。 |
| `packages/plugin-assets/src/AssetsHomeWidget.tsx` | 删除全部 `useEffect`、ref revision、microtask 与数据 state；改为 `useResourceSelector("assets.holdings")`。 |
| `packages/plugin-assets/src/AssetsPage.tsx` | 同上；列表和首页共享同一个 holdings resource，不得再双读。 |
| `packages/plugin-assets/src/AssetDetailPage.tsx`、`AssetDetailRedirect.tsx` | 注册/使用参数化 asset/token detail resource；route 参数进入 ResourceKey。 |
| `packages/plugin-p2pkh/src/manifest.ts`、`p2pkhService.ts` | 注册 P2PKH balance、overview、UTXO、history 等本地 read resource；service 的 `onDataChanged` 只供资源定义订阅。 |
| `packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx` | 删除 service/keyspace 多订阅、`loadBalances`、revision ref；仅读 balance resource。 |
| `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx`、`P2pkhUtxosPage.tsx`、`P2pkhHistoryPage.tsx` | 删除页面数据 reload effect；改为各自 resource selector。 |
| `packages/plugin-contacts/src/manifest.ts`、`RecentContactsWidget.tsx`、`ContactsPage.tsx`、`ContactDetailPage.tsx`、`ContactPicker.tsx` | 联系人列表/详情按 active key、contact id 注册并读取资源；交互编辑 state 保留在页面。 |
| `packages/plugin-apps/src/AppsHomeWidget.tsx`、`AppsPage.tsx`、`AppLaunchModal.tsx` | 静态 catalog 读取不必注册 resource；删除重复 i18n hook。Modal 的用户命令和表单 state 保留。 |
| `packages/plugin-poker/src/widgets/PokerHomeWidget.tsx`、`PokerLobby.tsx`、`PokerTable.tsx` | 将 poker status/presence/session 组合为资源或专用 store adapter；移除 `react-i18next` 和直接 service 订阅。 |
| `apps/web/src/shell/AppShell.tsx` | guard、notice、vault status 改用 selector resource/store；保留 local mobile/modal state。语义相等函数保留在 runtime shared helper 或 resource definition 中。 |
| `apps/web/src/shell/Sidebar.tsx`、`Topbar.tsx`、`Breadcrumbs.tsx`、`RouteRenderer.tsx` | 改为 registry 的精确 selector hook；禁止通过全局 host version 让无关 registry 更新。 |
| `apps/web/src/shell/LockedShell.tsx`、`FirstTimeImportWizard.tsx`、`OnboardingHeader.tsx`、`StepProgress.tsx`、`apps/web/src/theme/ThemeToggle.tsx` | 删除重复 i18n hook；用户输入和向导 reducer 不迁移为 resource。 |
| `packages/plugin-{background,collectibles,collectible-transfer,key-import,protocol,transfer,vault,woc}/src/**/*.tsx` | 全仓迁移同一模式：业务 read 走 resource hook；删除重复 i18n hook；命令/表单 state 留在组件。 |

### 5.4 删除项

必须删除而非保留：

- 所有 React 文件中的 `useI18n().language()`；
- `AssetsHomeWidget` / `AssetsPage` / `P2pkhBalanceWidget` 及同类组件内的业务
  `aliveRef`、request revision、provider `onChange`、service `onDataChanged` reload effect；
- `bootstrapPlugins.ts` 的 data-changed coalescer；
- 仅为旧页面 loader 服务的测试 fixture、helper 和注释；
- 任何以 `host.version`、全局 rerender 或 `forceUpdate` 作为业务数据刷新机制的代码。

---

## 6. 测试与最终验收清单

### 6.1 Runtime 必测

- [ ] 同 key 双 `ensure()` 只调用一次 loader。
- [ ] StrictMode mount → cleanup → mount 不产生第二个 loader 请求。
- [ ] 同 provider/key 的同轮失效只产生一次 reload，kinds 合并且 revision 最新。
- [ ] 不同 provider 或 active key 不合并。
- [ ] active key 切换后旧请求 resolve 不得发布到新 key。
- [ ] `equals` 判定相同数据时 selector subscriber 不通知。
- [ ] loader failure 保留旧 data 并进入 stale/error；blocked 不 throw。
- [ ] owner plugin disable 后 abort、unsubscribe、record purge 均发生；旧回调无效。
- [ ] selector 只在 selector 结果变化时 render；无关 registry/resource 更新不触发。
- [ ] AssetDataNotifier 合并测试位于 runtime，不再位于 web bootstrap。

### 6.2 页面与插件必测

- [ ] `AssetsHomeWidget` 在非 StrictMode 初始加载仅渲染“空态 + 完整数据”两次；不出现 provider 级中间提交。
- [ ] `AssetsPage` 与首页共享相同 holdings resource，同一时刻只读一次 provider。
- [ ] P2PKH 后台 recent/history 同轮完成时，余额和资产资源各最多重读一次。
- [ ] active key 切换、Vault lock/unlock、provider error、plugin disable/re-enable 均无旧数据串 key。
- [ ] 语言切换后文案更新且每组件只保留一个 i18n 订阅。
- [ ] AppShell 收到语义相同 guard/vault/notice snapshot 时，RouteRenderer/HomePage 不重渲染。
- [ ] Poker、Contacts、Assets、P2PKH 关键 widget 的 render counter 有明确预算，并在测试中断言。
- [ ] 用户命令仍消费 `CommandResult`；资源更新只发生在 DB/服务提交后的失效事件之后。

### 6.3 静态与构建验收

- [ ] `pnpm lint:boundaries` 通过。
- [ ] `pnpm lint:react-boundaries` 通过；扫描结果为零违规。
- [ ] `rg -n 'useI18n\\(\\)\\.language\\(\\)' apps/web/src packages -g '*.{ts,tsx}'` 无输出。
- [ ] `rg -n 'useTranslation\\(' apps/web/src packages -g '*.{ts,tsx}'` 无输出，除非该文件被静态检查明确列为非 React/i18n adapter（默认不允许）。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] `pnpm --filter @keymaster/web build` 通过。
- [ ] 开发模式 React Profiler：首页 idle 期间无持续 commit；生产模式不依赖关闭 StrictMode 才正确。

### 6.4 最终人工验收

- [ ] 首次进入首页、切换语言、切换 active key、后台同步一轮、切换插件启停，均没有 console missing-key、未处理 Promise、重复订阅或旧 key 数据闪现。
- [ ] Wallet locked、无 active key、provider 失败时显示受控状态，不显示伪造零余额，不进入 fatal 页面。
- [ ] 打开/关闭同一页面多次，Network、IndexedDB 读取和 React commit 数不随挂载次数线性累积。
- [ ] 代码审查确认不存在旧 loader adapter、组件级业务 timer/debounce、第二套 query cache 或关闭 StrictMode 的规避方案。

完成以上所有项目后，首页重复渲染类问题才视为由框架层**预防**，而不是在单个 widget 中被临时修复。
