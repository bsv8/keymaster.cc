# 002 启动关键能力契约硬切换一次性迭代施工单

## 参考文档与代码

- `packages/contracts/src/plugin.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/pluginConfigStore.ts`
- `packages/runtime/src/pluginConfigStoreContract.ts`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/fatalCrashPage.ts`
- `packages/plugin-vault/src/manifest.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/runtime/src/createPluginHost.test.ts`
- `apps/web/src/bootstrapPlugins.test.ts`

发生冲突时，本单优先于既有施工单中关于 **插件启停配置、`canDisable`、启动
注册失败处理和 Web 首屏挂载前置条件** 的定义。Vault/Coordinator 的安全边界、
插件依赖 capability 的业务语义、fatal page 的统一接管机制继续有效。

---

## 1. 背景与根因

线上曾出现如下故障：

```text
旧 localStorage: { vault: false }
  -> PluginHost 按持久化配置不启用 vault
  -> bootstrapPlugins 正常返回 host
  -> React App/Shell 无条件 useCapability("vault.service")
  -> Capability "vault.service" is not available
  -> React render fatal page
```

`vault` 的 manifest 已声明 `canDisable: false`，但现有语义只在用户调用
`host.disable()` 时拒绝禁用；启动期和 `storage` 跨标签同步仍允许旧配置覆盖它。
因此同一个字段同时被赋予了互相矛盾的含义：

1. `canDisable: false` 表示“运行系统不可缺少”；
2. plugin config 却仍可把它写成 `false`；
3. React 又被迫假设它存在。

另一个放大器是 `host.register()` 会将 setup 失败降为 `error-disabled`，继续让
bootstrap 返回。这对可选业务插件合理，但对首屏必需能力不合理；错误被延迟到
任意 React hook，诊断位置错误且上下文丢失。

本单不以此为由重做 plugin system、Coordinator 或 Shell。问题是**启动依赖没有
被建模为不可违反的契约**，应在 contracts/runtime/bootstrap 三个边界一次性收口。

---

## 2. 目标、范围与非目标

### 2.1 目标

完成后必须满足：

1. 启动关键插件永远不受用户开关、历史 localStorage、`storage` 事件或普通
   `host.disable()` 影响。
2. Web 应用在首次 `root.render()` 前验证其必需 capability 集合；缺任一项即进入
   既有 `pre-bootstrap.plugins` fatal path，绝不进入 React render path。
3. 一个启动关键插件 setup 失败时，bootstrap 必须失败且保留 plugin id、声明的
   capability、host state 和脱敏的 error；不能静默降级为缺 capability。
4. 普通平台/业务插件保留现有可选、可禁用和 `error-disabled` 行为；本单不把所有
   插件失败升级为全站 fatal。
5. 启停配置格式具备版本和迁移规则；不再让历史布尔值永久拥有高于 manifest 的
   权限。
6. 所有规则由 runtime 的公共契约表达，不靠 `bootstrapPlugins.ts` 中硬编码
   `if (id === "vault")` 或各 React 组件自行判断。

### 2.2 范围

- plugin manifest 元数据及其验证；
- `PluginConfigStore` 的版本化读写和旧配置迁移；
- PluginHost 注册/启停/跨标签同步的强制规则；
- web bootstrap 的 capability preflight 与 fatal 诊断；
- 核心 manifest 标注和单元/集成测试。

### 2.3 非目标

- 不改变 Vault 数据、密码、Key、IndexedDB schema 或 Coordinator RPC；
- 不提供 feature flag、灰度开关、双读取旧/新启动语义或旧 API adapter；本单是
  source-level hard switch；
- 不把 capability registry 改成返回 `undefined` 的宽松 API；业务代码仍应在真正
  依赖缺失时失败；
- 不在 `AppCrashBoundary` / global handler 中按错误文本吞异常；
- 不用“每个组件先 `useHasCapability()` 再显示空状态”掩盖启动装配错误；
- 不自动启用所有 `defaultEnabled: true` 的插件。只有显式 startup critical 的插件
  不可被配置关闭。

---

## 3. 最终架构与唯一语义

### 3.1 Manifest：把不可关闭和启动关键分开表达

在 `PluginMeta` 增加：

```ts
startup: "required" | "optional";
```

约束：

| `startup` | `canDisable` | 含义 |
|---|---|---|
| `required` | 必须为 `false` | 若本 Web entrypoint 声明依赖其 capability，则注册、setup、capability 提供均是启动前提。 |
| `optional` | `true` 或 `false` | 不因自身失败阻止首屏；`false` 仅表示运行后不能被 UI 禁用，不自动成为首屏依赖。 |
| 未声明 | 不允许 | 本单后所有 manifest 必须显式选择，消除默认推断。 |

`canDisable` 只描述运行期是否可关闭；`startup` 描述 entrypoint 是否可在它缺失时
挂载。二者相关但不等同。例如 Settings 可为 `optional + canDisable:false`，因为它
不是每条首屏路径都必须；Vault 为 `required + canDisable:false`。

所有 `startup: "required"` manifest 必须同时满足：

- `meta.defaultEnabled === true`；
- `meta.canDisable === false`；
- `meta.providesCapabilities` 非空；
- 不可声明依赖任何由 optional plugin 提供的 capability；
- setup 成功后必须实际 `ctx.provide()` 每个声明 capability（以 ownership 快照校验，
  不以“registry 中碰巧已有同名值”判断）。

违反这些规则是 manifest 定义错误，`host.register()` 立即 throw；不能作为
`error-disabled` 记录。

### 3.2 Entry point：声明 capability，而非声明插件 id

`apps/web/src/bootstrapPlugins.ts` 导出唯一的 Web 启动契约：

```ts
export const WEB_STARTUP_REQUIRED_CAPABILITIES = [
  "vault.service",
  "keyspace.service"
] as const;
```

Web bootstrap 注册完所有 manifest 后，调用 runtime 提供的
`host.assertCapabilities(WEB_STARTUP_REQUIRED_CAPABILITIES, { phase: "web-bootstrap" })`。
它必须返回或抛出结构化的 `StartupCapabilityError`，至少包含：

- 缺失 capability；
- 其声明 provider（若有）；
- provider plugin 的 `state` / `error`；
- 当前配置中关联 plugin id 的值；
- 不含密码、私钥、完整 stack 的诊断 message。

本单不允许 entrypoint 通过 plugin id 推断服务，也不允许 React/Shell 再承担
preflight。能力才是消费者的真实依赖；一个 capability 的 provider 如何实现仍由
manifest/host 管理。

当前 Web 必需项仅为 `vault.service`、`keyspace.service`。不要在本单顺手把
`protocol`、`settings`、`home`、background 等都列入；它们是否 required 必须由其
对应首屏路径的实际同步依赖证明。没有证据就保持 optional。

### 3.3 配置：版本化且 manifest 优先

`keymaster.plugins.runtime` 的 JSON 改为：

```ts
type PersistedPluginConfigV2 = {
  version: 2;
  enabled: Record<string, boolean>;
};
```

读取规则（唯一规则）：

1. 缺失、损坏或未知版本：按空配置处理并记录 recoverable diagnostic；不可导致
   fatal；
2. v1（裸 `{ [pluginId]: boolean }`）一次性迁移到 v2；
3. `startup: "required"` 的有效值永远为 `true`，无论 v1/v2 写了什么；迁移时删除
   或改写其 `false` 项，最终持久化为 `enabled[id] = true`；
4. optional plugin 才读取 `enabled[id]`，缺失时用 `defaultEnabled`；
5. storage event 收到 required plugin 的 `false` 时，当前 tab 不执行 disable，立即
   规范化并写回 `true`；
6. manifest 已不存在的 id 仍忽略；不得为此清空用户其他插件配置。

不引入“required plugin 的配置值可保存但 runtime 忽略”的半状态；那会在开发工具、
跨标签和下次升级时继续制造歧义。

### 3.4 Host 生命周期规则

新增内部 predicate：

```ts
function isStartupRequired(manifest: PluginManifest): boolean
```

它只依据已验证的 `meta.startup`，禁止散落 `kind === "core"`、`id === "vault"` 或
`canDisable === false` 猜测。

- `register(required)`：忽略 config 的 false，必须尝试 enable；成功后规范化 config
  为 true。
- `enable(required)`：setup/dependency/capability 完整性任一失败，保留清理逻辑，随后
  throw `StartupPluginError`；调用者不得吞掉。
- `disable(required)`：无论当前 state 是否 enabled，返回 `{ ok:false, reason }`，
  不写 config。
- config subscription：required plugin 的 false 只触发配置修复；不得调用 disable。
- `unregister(required)`：直接拒绝。运行中的 Web host 不允许拆掉启动契约。
- required plugin 的 i18n、route、resource ownership 仍按现有 enable 事务管理；失败
  时必须全部回滚，不能留下半注册 capability。

`register(optional)` 保持现行“失败 -> `error-disabled` + 继续 boot”语义。这个差异是
本单刻意保留的隔离边界。

### 3.5 Fatal 边界

`bootstrapPlugins()` 必须让 `StartupPluginError` / `StartupCapabilityError` 原样 reject；
`main.tsx` 现有 catch 负责写入 fatal store，phase 仍为 `pre-bootstrap.plugins`。

fatal page 应展示安全摘要，例如：

```text
Startup prerequisite unavailable: vault.service
Provider: vault (error-disabled)
```

详细 stack 只进入已有诊断区，按当前 production 脱敏规则处理。不得在 fatal page
执行 `host.enable()`、清 localStorage、删 IndexedDB 或重试 Coordinator；这些动作
可能改变用户状态，必须由明确的恢复入口/用户操作授权。

---

## 4. 文件级实施清单

### 4.1 `packages/contracts/src/plugin.ts`

1. 增加 `PluginStartupMode = "required" | "optional"` 与 `PluginMeta.startup`。
2. 将 `meta` 在 `PluginManifest` 中改为必填；全仓 manifest 一次性补齐 `startup`。
3. 在注释中定义 required 的四条不变量，明确 `canDisable` 不再承担启动语义。
4. 导出 `StartupCapabilityErrorDetails` / `StartupPluginErrorDetails` 的纯数据类型；
   `Error` class 留在 runtime，避免 contracts 引入运行时依赖。

### 4.2 `packages/contracts/src/index.ts`

确认新 plugin contract 类型由 contracts barrel 导出；不增加 web 专有 capability
列表到 contracts。

### 4.3 `packages/runtime/src/pluginConfigStoreContract.ts`

1. 将快照改为内部规范化后的 `Record<string, boolean>`，不向调用方暴露 v1/v2。
2. 增加 `normalize(manifests)` 或等价的 host 驱动入口，使 required 规则可基于
   manifest 运行；不得让 store 自己维护插件 id 白名单。
3. 增加只读的 config schema/version 诊断接口，供启动错误组装，不暴露原始存储。

### 4.4 `packages/runtime/src/pluginConfigStore.ts`

1. 实现 v1 -> v2 无损迁移、损坏值回退和 v2 写入。
2. 由 host 传入 required id 集合进行规范化；required id 强制 true。
3. `storage` 回调先解析、再规范化、最后只在有变化时写回；避免写回自身造成循环。
4. 保持 localStorage 不可用/配额错误 best-effort：内存快照仍能启动 required plugin，
   只追加 recoverable diagnostic。
5. 删除任何“裸对象格式仍可写出”的路径。

### 4.5 `packages/runtime/src/createPluginHost.ts`

1. 增加 manifest 静态验证和 `isStartupRequired()`。
2. 增加 `PluginHost.assertCapabilities(...)` 公共方法；以 `providesCapabilities` 建立
   provider 索引，形成结构化错误。
3. 按第 3.4 节改写 register/enable/disable/unregister/config subscription；required
   失败必须向调用方抛出，optional 维持现状。
4. required setup 后校验其自身声明的 capability 已由该 plugin ownership 提供。
5. 删除当前所有通过 `canDisable === false` 直接推断“必须初始启用”的分支；替换为
   `startup === "required"`。
6. 不修改 `CapabilityRegistry.get()` 的 throw 行为，不给 `useCapability()` 加 fallback。

### 4.6 `packages/runtime/src/createPluginHost.test.ts`

新增并覆盖：

- required manifest 缺 `defaultEnabled:true`、`canDisable:false`、provides 或依赖
  optional provider 时立即失败；
- v1/v2 config 都写 `{ vault:false }` 时 required plugin 仍 enabled、capability 存在且
  持久化值被规范化；
- required plugin setup throw 时 `register()` reject，ownership 全回滚；
- required provider 少提供一个已声明 capability 时失败；
- `disable()`、`unregister()`、storage false 均不能移除 required capability；
- optional plugin 失败仍为 `error-disabled`，不改变既有兼容行为；
- `assertCapabilities()` 错误包含 provider state，但不含原始 stack/敏感配置。

### 4.7 所有 `packages/plugin-*/src/manifest.ts`

一次性为每个 manifest 添加显式 `meta.startup`：

- `packages/plugin-vault/src/manifest.ts`：`required`，且声明
  `vault.service`、`keyspace.service`；
- 其它 manifest：默认 `optional`；若实施者认为某项 required，必须在本单对应的
  Web capability 列表增加条目和测试，不能仅因为 `kind:"core"` 自动提升。

不要在各 manifest 的 `setup()` 中读取 localStorage、手动覆盖 config 或自行注册
fatal；规则只属于 runtime。

### 4.8 `apps/web/src/bootstrapPlugins.ts`

1. 在全部 ordered plugins 注册完成后调用 `host.assertCapabilities()`，参数只能使用
   `WEB_STARTUP_REQUIRED_CAPABILITIES`。
2. 保持 plugin 注册顺序与 timeout 策略；不因本单将 optional plugin 注册改为并行。
3. 删除临时的单 capability `if (!host.capabilities.has("vault.service"))` 特判；由
   声明式 preflight 替代。
4. 对 bootstrap 错误补充 provider state 的安全上下文，但不 catch 后继续 mount。

### 4.9 `apps/web/src/bootstrapPlugins.test.ts`

新增真实 host 级测试（允许最小 manifest fixture）：

- 启动契约成功时返回 host；
- required provider 被旧配置禁用时仍成功且 capability 存在；
- required setup 失败、声明能力未提供、required capability 无 provider 时均 reject，
  错误精确指出 capability/provider；
- optional plugin 失败不阻断、但 required preflight 仍正确；
- 不使用 React render 来断言上述启动行为。

### 4.10 `apps/web/src/main.tsx`、`apps/web/src/fatalCrashPage.ts`

1. 保持 fatal store 作为唯一接管者；只补充对结构化启动错误的安全摘要格式化。
2. 明确 phase 仍为 `pre-bootstrap.plugins`，不是 `react.render`。
3. 不添加自动清配置/自动 reload/自动删除 IndexedDB；恢复动作必须显式、可审计。

### 4.11 文档与静态约束

- 更新 `docs/architecture/code-architecture.md`：补充 startup contract、配置优先级和
  bootstrap -> preflight -> React 的边界图；
- 在 `scripts/check-boundaries.mjs` 或新增静态检查中禁止：`apps/web/src/shell/**` 对
  `useHasCapability("vault.service")` 作降级分支，以及 manifest setup 直接访问 plugin
  config storage；检查只覆盖明确列出的禁止模式，不能用脆弱的全仓字符串黑名单。

---

## 5. 明确禁止的实现方式

1. **不可只修 Vault。** 在 bootstrap 写 `if (vault missing) enable("vault")` 是把
   通用规则藏在 Web，下一项 required capability 会复发。
2. **不可把 `canDisable:false` 偷换为 startup required。** 有些运行期不可关闭的
   功能仍可以不参与首屏；必须显式 `startup`。
3. **不可让 React 兜底。** `useCapability<T | undefined>`、空白 Shell、loading
   spinner 都会掩盖启动装配错误，且让不同页面表现不一致。
4. **不可吞 required setup 错误。** `catch (err) { state="error-disabled" }` 后继续
   bootstrap 会重演本事故。
5. **不可为“兼容旧配置”保留旧值优先。** 旧 v1 值只迁移一次，manifest required
   语义永远胜出。
6. **不可清空整个 `keymaster.plugins.runtime` 或 IndexedDB。** 这会破坏用户的
   可选插件设置，且与 Vault 恢复无关。
7. **不可把所有 optional plugin 的错误升级为 fatal。** 这样会将网络、第三方服务或
   实验功能故障扩大成不可用首屏。
8. **不可把 fatal handler 改为忽略 `Capability ... unavailable`。** 那只会隐藏真正的
   依赖缺失并让页面进入半工作状态。

---

## 6. 特殊情况与预定处置

| 情况 | 必须行为 | 禁止行为 |
|---|---|---|
| 用户带 v1 `{ vault:false }` 升级 | 迁移为 v2，并将 vault 规范化为 true 后启动 | 要求用户手动清缓存或直接 render |
| localStorage 损坏、禁用或 quota 满 | 内存按 manifest 启动 required；记录 recoverable diagnostic | 因配置存储失败进入 fatal |
| 另一标签写 required=false | 当前标签不 disable，写回 true；另一标签收到事件后同样收敛 | 两标签互相反复 enable/disable |
| required setup 抛错 | 完整 rollback，bootstrap fatal，诊断显示 provider/state | React 继续挂载、自动重试写库 |
| required plugin 声明 capability 未提供 | host 视为契约违规，bootstrap fatal | 仅依赖 React 后续 get() 报错 |
| optional plugin setup 抛错 | `error-disabled`、记录状态；仍执行 required preflight | 将全站 fatal 或静默丢失诊断 |
| 新 entrypoint（popup/app-view）需要不同能力 | 该 entrypoint 自己声明常量并调用同一 `assertCapabilities` | 复用 web 列表或在组件内临时判断 |
| 需要人工恢复配置 | 提供独立、可见、仅重置 plugin config 的操作，并说明影响范围 | fatal page 自动清除或连带删除 Vault 数据 |
| manifest 元数据来自第三方/动态插件 | 不允许其声明 `startup:"required"`；仅编译时受信任内建 manifest 可用 | 让下载的插件把自身升级为首屏前提 |

---

## 7. 实施顺序（一次性硬切换）

本单不分阶段上线，也不保留旧 API。单个合并集按以下顺序完成，最终一次部署：

1. contracts 增加 startup 元数据与结构化错误数据；一次性补全全部 manifest；
2. 实现 config v2 与迁移/规范化；
3. 改造 PluginHost 生命周期和 capability assertion；
4. 将 Web bootstrap 接到声明式 preflight，移除 Vault 特判；
5. 更新 fatal 摘要、架构文档和静态约束；
6. 完整测试、构建并以“带旧 v1 false 配置”的干净浏览器 profile 做发布前验证。

中途不得发布。contracts 已要求 `meta.startup`，但 runtime/web 尚未同时理解它的
构建不允许合并或部署。

---

## 8. 最终验收清单

### 8.1 契约与代码审查

- [ ] 每个 manifest 都显式声明 `meta.startup`；没有缺省语义。
- [ ] 只有受信任的内建 Vault 是 `required`，它满足 required 的全部不变量。
- [ ] `WEB_STARTUP_REQUIRED_CAPABILITIES` 是 Web 唯一启动能力清单，当前恰为
  `vault.service`、`keyspace.service`。
- [ ] runtime 没有 plugin-id 特判；required 规则只通过 manifest 元数据执行。
- [ ] `CapabilityRegistry.get()`、`useCapability()` 的严格缺失行为未被弱化。
- [ ] optional plugin 的失败隔离和用户可禁用行为未回归。

### 8.2 自动化测试

- [ ] `pnpm vitest run packages/runtime/src/createPluginHost.test.ts apps/web/src/bootstrapPlugins.test.ts` 通过。
- [ ] 新增 v1/v2 配置迁移、storage 同步、required setup rollback、声明/实际 capability
  不一致、optional failure 隔离、preflight error 内容的测试全部通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm lint:boundaries` 通过。
- [ ] `pnpm lint:react-boundaries` 通过。
- [ ] `pnpm build` 通过。

### 8.3 发布前浏览器验收

- [ ] 在目标 origin 预置旧格式 `localStorage["keymaster.plugins.runtime"] = '{"vault":false}'`，刷新后进入正常 Vault/Shell，而非 React fatal；存储自动变为 v2 且 Vault=true。
- [ ] 在 v2 中预置 required=false，结果相同。
- [ ] 模拟 Vault setup 失败：页面显示 `pre-bootstrap.plugins` fatal 摘要，包含
  `vault.service` 与 provider `vault`，不出现 `react.render`。
- [ ] 模拟 optional plugin setup 失败：首屏仍可用，host state 可诊断为 error-disabled。
- [ ] 两个同 origin 标签页中写入 required=false 后，二者均保持 Vault capability，配置最终收敛为 true，无 enable/disable 循环。
- [ ] localStorage 被浏览器拒绝时，required capability 仍能启动；只产生非致命诊断。
- [ ] 不执行任何自动清 Vault IndexedDB、自动删除用户 key 或自动重载页面。

### 8.4 交付判定

仅当所有自动化与浏览器验收项完成，且生产错误不再出现
`react.render / Capability "vault.service" is not available`，本施工单才算完成。若
required plugin 真实初始化失败，允许出现的是带明确 provider/capability 的
`pre-bootstrap.plugins` fatal；这代表契约正确地阻止了半初始化应用，而不是回归。
