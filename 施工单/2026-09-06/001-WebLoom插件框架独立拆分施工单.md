# 001：WebLoom 插件框架独立拆分施工单

> 日期：2026-09-06
>
> 状态：代码切换已完成（WebLoom 已发布，生产部署证据待目标环境）
>
> 优先级：P0
>
> 来源仓库：`/home/david/Workspaces/keymaster.cc`
>
> 目标仓库：`/home/david/Workspaces/WebLoom`
>
> 设计基线：`docs/proposals/plugin-lifecycle/design.md`、`implementation-plan.md`、`inventory.md`

## 1. 目标与冻结结论

本单将 Keymaster 已完成的插件生命周期框架彻底拆为独立项目 WebLoom。此次不是把
`@keymaster/contracts`、`@keymaster/runtime`、`@keymaster/ui` 原样换名，而是完成
**通用框架与 Keymaster 领域适配层的依赖倒置**。

最终依赖方向必须是：

```text
webloom-framework（通用框架，无 Keymaster/BSV 依赖）
  ↑
  ├─ @keymaster/contracts（钱包领域契约 + WebLoom 类型扩展）
  ├─ @keymaster/runtime（Keymaster Host Adapter + 领域 Registry）
  └─ apps/web、platform-storage、plugin-*（产品装配和业务实现）
```

冻结结论：

1. 首版直接执行彻底通用化，不发布携带 Keymaster 业务语义的过渡版框架；
2. npm 包名已确认为 `webloom-framework`，首发版本为 `0.1.0`；不维护备用包名或
   组织 scope。WebLoom 已以提交 `a5ace48`、标签 `v0.1.0` 发布；
3. 只发布一个 npm 包，通过 `webloom-framework`、`webloom-framework/react`、
   `webloom-framework/testing` 三个入口区分核心、React 绑定和测试工具；
4. `@keymaster/ui` 留在 Keymaster。Button、Modal、DataTable 等视觉组件不属于
   插件生命周期框架；
5. WebLoom 不引入 Cordis，不建设动态插件市场、远程脚本加载或恶意代码沙箱；
6. Keymaster 正式依赖固定为 `"webloom-framework": "0.1.0"`，不得使用 link、file、
   workspace、绝对路径或宽松版本；
7. 发布顺序固定为：先发布 WebLoom，再切换并部署 Keymaster；
8. 优先使用 `cp -a` 复制成熟实现和测试，再做机械化 rename/import 替换；禁止
   凭记忆重写生命周期、权限、服务桥和升级门禁算法；
9. 迁移期间可以暂存两份源码，但任何可执行构建中只能有一个 Plugin Host 和一套
   生命周期核心，禁止新旧框架同时启动同一插件；
10. 本单不改变 Keymaster 的数据格式、签名格式、存储目录、权限范围、插件默认
    启停值、业务协议或最终 I/O 校验；
11. WebLoom 使用 `AGPL-3.0-only`；包名、版本、许可证、来源提交和发布标签已记录，
    施工不修改 LICENSE。

## 2. 完成定义

只有同时满足以下条件，才算“独立拆分完成”：

- WebLoom 在没有 Keymaster 源码、路径别名和兄弟仓库的环境中可以独立安装、
  typecheck、test、build、pack；
- `webloom-framework` 的运行时代码和类型声明中不存在 Keymaster、BSV、Vault、P2PKH、
  owner 公钥、桶世代或具体业务 Registry；
- Keymaster 的插件 Host 实际由 `webloom-framework` 创建，`packages/runtime` 只剩领域适配、
  领域 Registry 和产品级服务；
- Keymaster 插件引用通用框架类型/Hook 时直接 import `webloom-framework` 或
  `webloom-framework/react`，不再由 `@keymaster/contracts`、`@keymaster/runtime` 永久
  re-export 一整套旧框架 API；
- Keymaster 中被外置的框架实现和重复测试已删除，没有两份真值；
- Keymaster 现有插件生命周期、权限、跨 Worker、升级接管及生产构建验证全部通过；
- Keymaster 最终提交和 lockfile 中不存在 `link:../WebLoom`、绝对路径或未发布的
  tarball 依赖。

仅完成以下事项不算完成：

- 只复制目录或替换包名；
- WebLoom 仍 import `@keymaster/*`；
- Keymaster 通过兼容 re-export 继续使用旧核心，实际没有调用 WebLoom；
- 同时保留两套 Host，用 feature flag 在运行时选择；
- 只通过 TypeScript，未跑跨 Window/Worker 和打包消费验证。

## 3. 术语与通用契约

以下术语作为 WebLoom 公共 API 的中文语义基线。所有导出的字段和复杂状态必须在
TypeScript 声明及文档中保留中文说明，不能让使用者根据英文猜含义。

| 字段/术语 | 中文含义 |
|---|---|
| `pluginId` | 插件产品的稳定标识；用户启停和依赖图的产品级身份。 |
| `unitId` | 一个产品在某种执行环境中的稳定运行单元标识。 |
| `instanceId` | 某运行单元本次启动产生的唯一实例标识；重启不得复用。 |
| `execution` | 运行代码所在环境标签，由宿主定义，如 Window、Worker；框架不内置 Keymaster 枚举。 |
| `lifetime` | 实例依附的生命周期标签，由宿主定义；框架只比较和调度，不解释业务含义。 |
| `scopeId` | 本次生命周期作用域的唯一标识。 |
| `capability` | 插件提供或依赖的服务契约标识。 |
| `contractVersion` | capability 的精确契约版本；跨环境依赖不猜测兼容性。 |
| `permission` | 字符串形式的权限动作；具体权限集合由宿主定义和批准。 |
| `attributes` | 宿主绑定的只读扩展元数据；用于承载 owner、会话世代等领域信息。 |
| `desiredEnabled` | 用户或权威控制面希望产品启用的持久意图。 |
| `state` | 当前运行实例的实际状态，不能与启用意图合并成一个布尔值。 |
| `blockedBy` | 当前实例无法启动时缺少的依赖或作用域原因。 |

### 3.1 通用类型约束

WebLoom 的基础类型使用开放字符串和泛型扩展，不固定 Keymaster 的领域联合类型：

```ts
/** 执行环境由宿主定义，框架只把它当作稳定标签。 */
export type PluginExecution = string;

/** 生命周期类别由宿主定义，例如 root、session、document。 */
export type PluginLifetime = string;

/** 权限动作由宿主定义，例如 document.read。 */
export type PluginPermission = string;

/** 生命周期身份中的领域信息由宿主只读注入。 */
export interface LifecycleScopeIdentity<
  TAttributes extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  scopeId: string;
  instanceId: string;
  kind: string;
  parentScopeId?: string;
  pluginId?: string;
  attributes: TAttributes;
}
```

规则：

- `ownerPublicKeyHex`、`sessionEpoch`、`bucketGeneration`、`vaultStatus` 不得成为
  WebLoom 顶层固定字段；它们由 Keymaster Adapter 放入受类型约束的 attributes；
- `coordinator-worker`、`window`、`connect-worker` 不得是 WebLoom 的封闭枚举；
- `storage`、`owner-session`、`connect-session` 不得是 WebLoom 的封闭生命周期枚举；
- WebLoom 的权限租约负责交集、绑定、撤销和比较；权限名称以及最终 I/O 允许列表由
  Keymaster 定义；
- attributes 必须是只读、可比较、无私钥/Seed/密码的结构化元数据，不能变成绕过
  Context 类型和权限审查的任意对象仓库。

### 3.2 Manifest 与 Context

WebLoom Manifest 只保留通用字段：

- 产品元数据：稳定 id、默认启用、是否允许禁用、可选展示信息；
- 运行单元：execution、lifetime、依赖、提供能力、权限申请；
- 不携带可执行函数的静态描述；
- 当前执行环境的 setup 继续由 `pluginId + unitId` 实现注册表解析；
- contribution（宿主贡献）、config（配置声明）采用泛型扩展，不解释业务内容。

Keymaster 专属字段留在 `@keymaster/contracts` 的扩展类型中：

- `bootstrapStage`（存储/Vault/owner/Connect 启动阶段）；
- Storage declaration（存储声明）；
- business contribution（路由、首页、设置、资产等界面贡献）；
- Coordinator facade（插件专属 Coordinator 窄接口）；
- i18n 资源。

WebLoom 的基础 Context 包含：

- pluginId、unitId、instanceId；
- scope、signal、onDispose；
- provide/get/has/require；
- messageBus；
- 已批准权限和 permission lease；
- 只读 config；
- 宿主泛型扩展字段。

`ctx.storage`、`ctx.coordinator` 等现有字段由 Keymaster Context Extension
提供，不能作为 WebLoom 固定能力。

### 3.3 Host 扩展点

通用 Host 不再自行创建 Keymaster Registry、i18n、存储和 Vault 状态机。它必须
通过明确的 adapter/options 接受以下扩展：

| 扩展点 | 中文职责 |
|---|---|
| `capabilities` | 宿主在插件启动前注入的内建能力。 |
| `contextExtension` | 按 plugin/unit/instance 生成只读领域 Context。 |
| `manifestValidator` | 校验 Keymaster storage/business/bootstrap 等领域声明。 |
| `scopeResolver` | 根据宿主当前状态决定某 lifetime 是否可用及其父 Scope。 |
| `permissionPolicy` | 计算申请、平台批准和会话约束的权限交集。 |
| `configStore` | 插件启停/配置的持久化端口；WebLoom 不依赖 Keymaster K-V 类型。 |
| `intentCoordinator` | 多页面环境下的唯一启停意图控制面。 |
| `runtimeSnapshots` | 读取其他执行环境真实运行单元状态。 |
| `contributionAdapters` | 注册并释放路由、设置、资产等宿主自定义贡献。 |
| `serviceBridge` | 为当前实例提供已完成握手和快照校验的远程服务代理。 |

Keymaster 的 `transitionRuntimeIdentity()` 不进入 WebLoom 公共核心。Keymaster Adapter
在 Storage/Vault/owner 状态变化时更新自己的 scopeResolver 状态，再调用 WebLoom 的
通用 reconcile（重新协调）入口。通用入口只处理“哪些 scope 已出现、变化或撤销”，
不理解锁屏、公钥或桶。

## 4. 文件拆分边界

### 4.1 迁入并通用化到 WebLoom

| 当前来源 | 目标职责 | 必须处理的耦合 |
|---|---|---|
| `contracts/src/plugin.ts` | Manifest、Context、运行单元、图状态基础契约 | 移除启动阶段、Storage、business、Coordinator、Keymaster capability 表。 |
| `contracts/src/lifecycle.ts` | Scope、权限租约、服务桥、任务、升级门禁契约 | 领域身份改 attributes；执行环境/权限开放；移除 Coordinator 常量。 |
| `contracts/src/messageBus.ts` | MessageBus 公共契约 | 去除 Keymaster 文件注释和命名。 |
| `contracts/src/resource.ts` | 通用 Resource Store 契约 | `activePublicKeyHex`、`active-key` 改为宿主 attributes/scope key；Symbol 改为 WebLoom 名称。 |
| `runtime/src/capabilityRegistry.ts` | capability 注册与撤销 | 原样复制后改通用 import。 |
| `runtime/src/pluginGraph.ts` | 依赖图、契约版本校验、反向依赖 | 原样复制测试，移除领域默认表。 |
| `runtime/src/createPluginHost.ts` | 通用 Host 调度核心 | 领域 Registry、i18n/log/storage/Vault 状态改为注入适配器。 |
| `runtime/src/messageBus.ts` | MessageBus 实现 | 保持事件同步与 actor mailbox 行为。 |
| `runtime/src/lifecycle/resourceScope.ts` | 作用域、同步撤权、结构化清理 | 保持迟到资源和父子 Scope 聚合语义。 |
| `runtime/src/lifecycle/permissionLease.ts`、`permissionVerifier.ts` | 通用权限租约 | 权限与绑定字段泛型化。 |
| `runtime/src/lifecycle/serviceBridge.ts` | 跨环境服务目录和代理 | owner 字段进入 attributes；保持旧代理永久失效。 |
| `runtime/src/lifecycle/messagePortServiceTransport.ts`、`Provider.ts` | MessagePort RPC | 消息 codec 可配置；传输 callId 与 operationId 继续分离。 |
| `runtime/src/lifecycle/pluginIntentController.ts` | 权威启停意图 | 持久化改为通用端口。 |
| `runtime/src/lifecycle/taskScheduler.ts` | Scope 绑定任务 | 去除 Keymaster 类型 import。 |
| `runtime/src/lifecycle/scopedRegistry.ts` | 自动释放 Registry 注册 | owner 参数绑定方式由适配器描述。 |
| `runtime/src/lifecycle/upgradeGate.ts` | 新旧运行环境接管 | 保持 drain、lease、精确版本和未知结果不重放。 |
| `runtime/src/lifecycle/runtimeUnitImplementationRegistry.ts` | unit 实现解析 | 保持描述和实现分离。 |
| `runtime/src/resources/resourceStore.ts` 等 | 通用资源缓存与订阅 | 活跃 Key 改为通用 Context attributes。 |
| 通用 React Provider/Hooks | `webloom-framework/react` | 只依赖 React 和 WebLoom Host；不 import Keymaster i18n/router/Vault。 |
| 对应单元测试 | WebLoom 回归基线 | 优先 `cp -a`，随后只改 fixture 和 import，不弱化断言。 |

### 4.2 留在 Keymaster

| 当前模块 | 保留原因/调整方式 |
|---|---|
| `contracts` 中除通用插件契约外的领域文件 | BSV、Vault、Storage、Connect、MSFile、资产等均是产品契约。 |
| `contracts/src/pluginProducts.ts` | Keymaster 25 个内置产品目录，不属于通用框架。 |
| `runtime/src/registries/*` | 路由、资产、Token、联系人、Vault 设置等是 Keymaster Host 贡献。 |
| `runtime/src/i18n/*`、`log/*` | 当前实现依赖 Keymaster 契约和平台 K-V，由 Adapter 注入。 |
| `runtime/src/lifecycle/scopedChannelRuntime.ts` | 绑定 Keymaster ChannelRuntime，留在领域适配层。 |
| `runtime/src/navigate.ts`、`react/AppLink.tsx`、`useCurrentPath.ts` | 当前 SPA 路由和内存 Vault 会话策略是 Keymaster 产品行为。 |
| `runtime/src/react/useI18n.ts`、`useRuntimeStatus.ts` | 分别绑定 Keymaster i18n 和 Vault 状态。 |
| `runtime/src/fatalErrorStore.ts` | Keymaster 应用启动 fatal 通道。 |
| `runtime/src/keyValueSettingsStore.ts`、`storage/inMemoryKeyValueStore.ts` | 绑定 Keymaster KeyValueStore；通过通用持久化端口接入 WebLoom。 |
| `packages/ui` | Keymaster 视觉组件库，不迁入 WebLoom。 |
| `apps/web/src/bootstrapPlugins.ts` | Keymaster 四阶段门禁、Coordinator facade 和业务装配。 |
| `apps/web/src/pluginCatalog.ts` | Keymaster 选择的产品清单。 |
| Coordinator Worker 与 worker unit catalog | Keymaster 多 Tab、私钥、存储、网络和最终 I/O 权威。 |
| `platform-storage`、`connect`、全部 `plugin-*` | 产品与业务实现。 |

### 4.3 旧兼容代码处理

- `pluginOwnership` 的 Registry 前后快照差分只能作为迁移期兼容；完成贡献适配器和
  Scope 归属后删除，不复制为 WebLoom 长期公共 API；
- `PluginManifest.setup` 的旧回退入口只允许测试夹具短期存在。生产 catalog 继续强制
  从 RuntimeUnitImplementationRegistry 解析实现；最终 WebLoom 文档不得推荐旧入口；
- `@keymaster/contracts` 可以在单个迁移批次内临时 re-export WebLoom 类型帮助机械
  切换，但最终边界检查必须禁止新增此类 re-export，并删除无调用者的旧入口；
- `@keymaster/runtime` 最终可以导出 Keymaster Adapter 与领域 Hook，不得复制或包装
  出另一套 createPluginHost 行为。

## 5. WebLoom 包结构与发布形态

目标目录建议：

```text
WebLoom/
  src/
    contracts/       # 通用 Manifest、状态、Scope、权限、服务桥契约
    host/            # Host、依赖图、capability、意图协调
    lifecycle/       # Scope、租约、任务、升级门禁
    messaging/       # MessageBus
    transport/       # 服务桥与 MessagePort RPC
    resources/       # 通用 Resource Store
    react/           # Provider 和通用 Hooks
    testing/         # 假 Host、假 transport、稳定测试辅助
    index.ts
    react.ts
    testing.ts
  docs/
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  LICENSE
```

`package.json` 必须满足：

- `name` 固定为已发布的 `webloom-framework`，版本为 `0.1.0`；
- ESM 包，公共入口只指向 `dist`，不发布依赖工作区源码的 TypeScript 入口；
- `exports` 至少包含 `.`、`./react`、`./testing`，每个入口同时提供 types/import；
- `files` 只包含 dist、README、LICENSE 和必要文档；不得包含测试结果、源码仓库配置、
  Keymaster 文档或本地证据；
- React 为可选 peer dependency；导入 `webloom-framework` 核心时不要求运行 React；
- `sideEffects: false` 的前提是删除类似当前 navigate 顶层 window listener 的副作用；
- build 生成 JavaScript 和 `.d.ts`，pack 后在空临时项目中消费，不依赖 pnpm workspace
  symlink；
- packageManager、Node engine、TypeScript/Vitest 版本明确锁定；
- Keymaster 使用精确版本 `0.1.0`，不用 `*`、`latest`、Git branch 或宽松范围。

## 6. 跨 Worker wire 协议兼容

当前 Keymaster 使用 `keymaster.remote-service.*` 控制消息。直接把字符串改成
`webloom.remote-service.*` 会使部署时并存的新页面和旧 SharedWorker 断链，因此：

1. WebLoom transport 接受显式 `RemoteServiceMessageCodec`；codec 负责消息 type、
   decode、encode 和协议版本，不在传输代码中散落字符串判断；
2. WebLoom 默认 codec 使用 `webloom.remote-service.*`，供新项目使用；
3. Keymaster Adapter 提供 legacy codec，继续生成和接收现有
   `keymaster.remote-service.*`；
4. Keymaster 本次拆分不提升 wire 版本、不修改旧 type、不要求旧 Worker 理解 WebLoom；
5. 现有 callId、connectionId、authorityInstanceId、contractVersion、snapshotRevision、
   baseline、grantId 和 handoverGeneration 的比较规则保持不变；
6. 如果实现过程中发现必须改变 wire schema，立即停止该批次，另写协议升级施工单，
   不得把双读/双写临时分支隐藏在本次通用化里。

WebLoom 默认 codec 与 Keymaster legacy codec 使用同一套 transport 合规测试向量，避免
只测试新名称而破坏旧部署。

## 7. 分批施工与交付门槛

### WL-001：固定基线与机械迁移清单

**目标：** 在改类型前冻结现有行为和源码来源。

**施工：**

- 记录 Keymaster 来源 commit、WebLoom 起始 commit、Node/pnpm 版本；
- 输出要迁移的文件、公共导出、测试和 Keymaster 调用者清单；
- 运行并记录 runtime/contracts 当前单测、typecheck 和生命周期关键测试；
- 记录每个 Keymaster 专属字段最终归属，未归类字段不得直接复制进入公共 API；
- 检查两个仓库工作区，保留用户已有修改，不覆盖无关文件；
- WebLoom 已有 README/LICENSE 作为目标仓库真值，不用 Keymaster 文件覆盖。

**门槛：** 基线命令通过或已有失败被单独记录；迁移清单没有“稍后判断”的核心字段。

### WL-002：建立可独立构建的单包骨架

**目标：** WebLoom 不依赖兄弟仓库即可 build/test/pack。

**施工：**

- 创建单包 package.json、TypeScript、Vitest、build、exports 和 README；
- 用 `cp -a` 复制 4.1 节列出的实现和测试，不复制 `node_modules`、dist、coverage；
- 先做路径和文件级机械 rename，再做领域类型拆分；
- 所有新增公共字段提供中文注释；
- 添加 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm pack` 脚本。

**门槛：** WebLoom 自身命令可运行；此阶段尚未通用化完成时不得发布 npm 包。

### WL-003：契约与生命周期通用化

**目标：** 删除公共类型中的 Keymaster 领域语义，同时保留安全规则。

**施工：**

- 按 3.1 节泛型化 execution、lifetime、permission、attributes；
- 拆出 Base Manifest、Base Context、Runtime Unit、Plugin State；
- 将 Scope、Permission Lease、Remote Service Reference 的领域绑定移入 attributes；
- 保留同步撤权、异步清理、迟到资源释放、父子 Scope 聚合、旧代理永久失效；
- 将 Keymaster 常量和 capability 默认表移回 Keymaster contracts/adapter；
- 错误码保持稳定类别，错误信息不得包含领域秘密。

**门槛：** WebLoom 源码和声明执行以下扫描均无命中，允许 README 的迁移说明单独列为
明确例外：

```bash
rg -n '@keymaster/|ownerPublicKeyHex|vaultStatus|bucketGeneration|P2PKH|BSV|Keymaster' src dist
```

### WL-004：Host 依赖倒置

**目标：** 通用 Host 只管理产品、单元、实例、依赖和 Scope。

**施工：**

- 将 createPluginHost 中所有领域 Registry 改为 contribution adapter 注入；
- i18n、storage binding、Coordinator facade 改为 Context extension；统一产品 logger 不属于当前 Context；
- config 持久化和多 Tab intent 改为端口接口；
- runtime identity 改为 scopeResolver + reconcile；
- Host 不按 pluginId 内置 Storage 白名单或能力策略；
- 初始化失败、disable、依赖级联、恢复和清理超时保持现有状态机；
- 删除 WebLoom 内的 snapshot-diff ownership，统一使用实例 Scope 和贡献释放句柄。

**门槛：** 用两个与钱包无关的测试插件覆盖：普通 Window 插件、跨 Worker provider/
consumer；测试代码不出现 Keymaster fixture。

### WL-005：服务桥、wire codec 与升级门禁

**目标：** transport 通用，同时保持 Keymaster wire 兼容能力。

**施工：**

- 提取可配置 codec；
- default WebLoom codec 和 Keymaster legacy fixture 共用测试；
- 保持连接身份、快照连续性、provider instance、授权引用和最终调用上下文；
- 验证断线、乱序、旧 authority、revision gap、provider 重建和调用取消；
- 升级门禁继续区分业务 operationId 与 transport callId，不自动重放副作用。

**门槛：** 原 messagePort/serviceBridge/upgradeGate 测试断言等价迁入并通过；legacy
codec 的编码结果与当前 Keymaster wire 完全一致。

### WL-006：React、testing 与 npm 包消费验证

**目标：** 发布物可被普通 React 项目和纯 Worker 项目分别使用。

**施工：**

- `webloom-framework/react` 只导出通用 Provider、Host/Capability/Registry/Resource/状态 Hooks；
- Keymaster i18n、Vault 状态、router/AppLink 不进入该入口；
- `webloom-framework/testing` 提供无业务含义的 fake store、fake transport 和 Host fixture；
- build 后执行 `pnpm pack`，在 `mktemp -d` 的空项目安装 tarball；
- 分别验证 core-only、React consumer 和 Worker consumer 的 import、类型和运行；
- 检查 tarball 内容、体积和 sourcemap，不泄露绝对路径。

**门槛：** 三类消费 smoke 通过，且临时项目不访问 Keymaster 或 WebLoom 源码目录。

### KM-001：建立 Keymaster Adapter

**目标：** 把从通用 Host 拆出的领域行为集中接回 Keymaster，外部行为不变。

**施工：**

- `@keymaster/contracts` 用扩展类型表达 bootstrap、storage、business、Coordinator、
  owner/session attributes 和权限字符串；
- `@keymaster/runtime` 创建 Keymaster Host Adapter，组合 WebLoom Host 和现有 Registry；
- Adapter 负责 i18n、Resource Context、config K-V、plugin intent、Storage
  declaration 校验、platform allowlist；
- 将 Coordinator/Vault 快照转换为 scopeResolver 状态；锁屏/切 Key/换桶仍使用现有
  session epoch、owner generation、bucket generation；
- 注入现有 `keymaster.remote-service.*` legacy codec；
- 保留现有 `PluginHost` 对 shell 真正需要的领域属性，通用操作直接使用 WebLoom Host。

**门槛：** Adapter 单测证明字段映射正确；伪造 owner、旧 epoch、旧 bucket generation、
越权 platform storage 仍在原最终边界被拒绝。

### KM-002：机械切换 imports 与插件类型

**目标：** 所有 Keymaster 调用者使用正确的通用或领域入口。

**施工：**

- package.json 使用已发布的 `"webloom-framework": "0.1.0"`；
- 通过 rg 生成调用者清单并批量替换，不逐文件手敲同类 import；
- 通用类型/函数/Hooks 改从 `webloom-framework` 或 `webloom-framework/react` 导入；
- BSV、Vault、Storage、业务 Registry、Keymaster Hook 继续从 `@keymaster/*` 导入；
- manifest setup 类型通过 Keymaster Context Extension 保持精确类型，不使用 `any` 或
  大面积 `unknown as` 掩盖拆分；
- 每批替换后立即 typecheck 对应 package，避免一次堆积数百个错误。

**门槛：** 全仓 typecheck 通过；新增边界检查可以区分通用 import 与领域 import。

### KM-003：切换唯一运行核心并删除旧源码

**目标：** Keymaster 运行时只执行 WebLoom 核心。

**施工：**

- bootstrapPlugins 只通过 Keymaster Adapter 创建 WebLoom Host；
- 删除已迁入 WebLoom 的通用实现、重复类型和重复测试；
- 删除无调用者的旧 re-export 和 setup fallback；
- 保留 `packages/runtime` 目录，但只能包含 Keymaster Adapter、领域 Registry、领域
  React Hook、i18n/log/router/fatal 等 4.2 节内容；
- 更新 `scripts/check-boundaries.mjs`，禁止 WebLoom 反向依赖、通用实现回流和插件
  deep import；
- 生成最终依赖矩阵和旧文件删除清单。

**门槛：** 构建图中只有一个 createPluginHost 实现、一个 Scope 实现、一个服务桥
实现；删除本地 WebLoom 目录后，使用 pack tarball 或已发布版本仍能构建 Keymaster。

### REL-001：发布 WebLoom 并切换 Keymaster 正式依赖

**目标：** 两个仓库可以独立发布和部署。

**施工：**

1. 确认 npm 包 `webloom-framework@0.1.0`、许可证、README、provenance、tarball
   内容和 npm 身份；
2. WebLoom 已由提交 `a5ace48`（标签 `v0.1.0`）发布，并已完成 registry 消费 smoke；
3. Keymaster 全部调用者已切换为 `webloom-framework` 公共入口，package.json 固定
   为 `"webloom-framework": "0.1.0"`，lockfile 已重新生成；
4. 扫描并拒绝旧 `webloom` 名称、link、file、绝对路径和 workspace 误依赖；
5. 跑 Keymaster 完整验收后提交并部署 Keymaster。

**门槛：** CI/构建机只 checkout Keymaster 也能安装、测试和构建；WebLoom 仓库不在
同一文件系统仍可工作。

## 8. 验收矩阵

### 8.1 WebLoom 通用行为

| 场景 | 必须断言 |
|---|---|
| 依赖链、菱形依赖、循环依赖 | 启动顺序确定；循环被明确拒绝；实例不重复。 |
| 可选依赖缺失/恢复 | 主体按声明运行；局部能力恢复不篡改用户意图。 |
| 提供者停止 | 先同步撤销代理，再按反向依赖顺序停止消费者。 |
| 初始化中 disable | 迟到资源立即释放，不能发布 ready。 |
| 清理失败或超时 | 其他资源继续释放；保持撤权；cleanup-pending 可观察。 |
| 父子 Scope | 子 Scope 失败、超时和迟到结果汇总到父级。 |
| 权限申请大于批准 | 只获得交集；旧租约或 attributes 不匹配时拒绝。 |
| 消息 actor 并发/超时/取消 | target 并发有界；signal 生效；快照准确。 |
| 服务快照乱序/缺口 | 旧 revision 丢弃；缺口撤下代理并要求新 baseline。 |
| provider 重建 | 新 instance 创建新代理，旧代理永久失效。 |
| RPC operationId 重复 | transport callId 仍唯一，不错误关联响应。 |
| 新旧环境接管 | draining 不发新写租约；旧 I/O 可观察排空；未知结果不重放。 |
| React Host 更新 | enable/disable/unregister 触发必要渲染，无订阅泄漏。 |

### 8.2 Keymaster 领域不变量

| 场景 | 必须断言 |
|---|---|
| Storage 未 ready | Vault 与 owner 插件不能启动。 |
| 锁屏、切 Key、A→B→A | 旧 Scope、store、crypto、service proxy 永久失效。 |
| 换桶或 owner generation 变化 | 旧 K-V 句柄在最终 I/O 边界拒绝。 |
| 多 Tab 启停 | SharedWorker 仍是 desiredEnabled 唯一写入控制面。 |
| Worker 服务重建 | Window 只接受当前 authority、instance 和连续快照。 |
| 插件声明 platform storage | 非白名单插件继续 fail closed。 |
| 签名/存储越权 | WebLoom Context 可见不等于获权；最终服务端仍复核 grant。 |
| 插件禁用/teardown | Registry、订阅、任务、Worker、Port 和 URL 全部按原语义释放。 |
| AppView/Connect | origin、App identity、session、owner、launch token 校验不变。 |
| 旧/新 Keymaster 构建并存 | 继续使用 legacy wire codec，不因包拆分断链。 |

## 9. 必跑命令

### WebLoom

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

另需在临时目录安装 pack 产物并运行 core、React、Worker 三类 consumer smoke。

### Keymaster

按改动批次先跑对应 Vitest；最终至少执行：

```bash
pnpm install
pnpm lint:webloom-release
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm build
pnpm test:e2e:lifecycle
pnpm verify:final-io-audit
pnpm verify:lifecycle-deployment
pnpm test:e2e:external
pnpm test:e2e:irreversible-io
pnpm test:e2e:recovery
pnpm verify:lifecycle-production-gates
```

需要真实外部目标、凭据或发布环境的命令必须记录为“待目标环境执行”，不得用本地
fixture 的成功代替生产证据，也不得为验证框架拆分发起真实付款或广播。

## 10. 静态边界检查

至少增加以下自动检查：

1. WebLoom `src/`、生成的 `.d.ts`、package dependencies 不得包含 `@keymaster/*`；
2. WebLoom 核心入口不得 import React、ReactDOM、浏览器路由或 Keymaster UI；
3. WebLoom 不得出现 BSV、Vault、P2PKH、MSFile、owner public key、bucket generation
   等领域类型；迁移文档说明可列显式例外；
4. Keymaster 中通用 Host/Scope/permission/serviceBridge/messagePort 实现只能来自
   `webloom-framework`；
5. `plugin-*` 不得 deep import WebLoom `src/` 或 `dist/` 内部文件；
6. 最终 Keymaster package.json、pnpm-lock 和源码不得包含旧 `webloom` 包名、
   `link:../WebLoom`、`file:`、`workspace:` 或 `/home/david/Workspaces/WebLoom`；
7. WebLoom tarball 不得包含 node_modules、coverage、test-results、Keymaster 施工单、
   本地路径或密钥材料；
8. Keymaster 原有业务边界规则继续执行，不能用“已拆到 WebLoom”为理由删除。

## 11. 发布与回退

### 11.1 发布

- WebLoom 发布记录为 `webloom-framework@0.1.0`，来源提交为 `a5ace48`，标签为
  `v0.1.0`；
- 发布已通过 registry 安装的真实 tarball 验证，不以 workspace/link 验证代替；
- Keymaster 精确锁版本，框架升级通过明确 PR/提交进行；
- npm 已发布版本不得覆盖或依赖 unpublish 作为回退策略；
- Keymaster 部署继续执行当前 Worker handover、旧 Worker drain/exit 和恢复证据流程。

### 11.2 回退

- WebLoom `0.1.0` 发布失败：不提交 Keymaster 的 registry 依赖切换；
- WebLoom 已发布但 Keymaster 验收失败：不部署 Keymaster，修复后发布新的 WebLoom
  patch 版本，禁止覆盖已发布版本；
- Keymaster 已部署后需要回退：恢复上一 Keymaster 构建及其锁定的 WebLoom 版本；
- 包拆分不改变数据 schema，因此回退不得执行数据“恢复”或删除；
- 已发生的外部副作用按现有恢复日志和未知结果规则继续处理，框架版本回退不能自动
  重放；
- wire codec 保持不变是本次可回退前提。若施工中改变 wire schema，必须停止并另做
  双版本协议迁移设计。

## 12. 非目标

本单不包含：

- 插件市场、在线安装、动态 import 未信任代码；
- iframe/Realm/SES 等恶意插件安全沙箱；
- Cordis 或另一套依赖注入/生命周期框架；
- 重做 Keymaster UI、路由、i18n 或日志产品体验；
- 修改 Storage/Vault/BSV/Connect 的数据与密码学格式；
- 重排 25 个产品的业务依赖或改变默认启停策略；
- 为了“更通用”而降低最终 I/O 权限校验；
- 同时发布多个 npm 包或 scope 包；
- 未经明确授权自动执行 npm publish 或 Keymaster 生产部署。

## 13. 最终交付物

1. 可独立构建、测试、打包的 WebLoom 仓库；
2. `webloom-framework` 单包及 `.`、`./react`、`./testing` 公共入口；
3. WebLoom 中英文 API README，所有字段有中文含义；
4. Keymaster Host Adapter 与领域扩展类型；
5. Keymaster 全仓 import 切换和旧框架源码删除清单；
6. 通用依赖图、Keymaster 适配依赖图和公共 API 清单；
7. WebLoom 单测、pack consumer smoke、Keymaster 完整验证记录；
8. npm 包名/版本/许可证/来源 commit/发布 tarball 的发布记录；
9. Keymaster 从 `link:` 切换到精确 npm 版本的 lockfile；
10. 新旧 Worker 接管、生产部署与回退证据。

## 14. 最终验收清单

- [ ] WebLoom 无 `@keymaster/*` 运行时或类型依赖；
- [ ] WebLoom 公共 API 无钱包领域字段和硬编码生命周期；
- [ ] WebLoom core 不依赖 React，React 只从子路径引入；
- [ ] WebLoom 可在空目录从 tarball/registry 独立消费；
- [ ] Keymaster 只有一个实际 Plugin Host/Scope/serviceBridge 实现；
- [ ] `@keymaster/runtime` 只剩领域适配，不含复制的通用核心；
- [ ] Keymaster UI、领域 Registry 和最终 I/O 权限仍在 Keymaster；
- [ ] legacy `keymaster.remote-service.*` wire 完全兼容；
- [x] registry 精确版本安装与发布门禁通过；
- [x] WebLoom 已先发布并完成 registry 安装验证；
- [x] Keymaster 已改为 `webloom-framework@0.1.0`，lockfile 无 WebLoom 本地路径；
- [x] 两仓 typecheck/test/build 以及 Keymaster 本地生命周期测试通过；
- [ ] Keymaster 目标部署交接、外部 AppView、不可逆 I/O、恢复演练和生产证据待目标环境执行；
- [x] 包名、版本、许可证、来源 commit 和回退规则记录齐全；
- [ ] 旧框架源码、临时 re-export、重复测试和无调用者兼容层已删除。
