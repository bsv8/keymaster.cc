# 代码架构模型

这份文档描述的是代码内部的稳定逻辑结构，不是目录树。

这里重点回答四个问题：

- 运行时对象如何协作。
- 核心数据对象如何分层。
- 平台状态如何推进。
- 一条关键主流程如何穿过 Vault、Keyspace、Runtime 和业务插件。

设计取舍：

- 不展开具体页面和 `src/` 文件级实现，因为那是易变表象。
- 不把 `plugin-p2pkh`、`plugin-protocol`、`plugin-message` 的专题细节塞进总览页，避免图失焦。
- 只保留平台级稳定骨架，方便以后继续补专题文档。

`docu.md` 可以直接打开本文件，并渲染下面的 PlantUML 图。

## 1. 运行时组件关系

这张图表达运行时的装配骨架。

- `apps/web` 负责启动和装配。
- `runtime` 是插件宿主，不持有业务实现。
- `contracts` 只定义协议与能力接口，不放实现。
- `plugin-*` 通过 capability、registry、message bus 接入系统。

```plantuml
@startuml
title Keymaster 运行时组件关系
left to right direction
skinparam shadowing false
skinparam componentStyle rectangle

package "apps/web" {
  [AppShell / Bootstrap]
}

package "packages/runtime" {
  [PluginHost]
  [CapabilityRegistry]
  [MessageBus]
  [RouteRegistry]
  [MenuRegistry]
  [SettingsRegistry]
  [HomeRegistry]
  [TransferRegistry]
  [AssetRegistry]
  [TopbarRegistry]
  [I18nService]
  [LogService]
}

package "packages/contracts" {
  interface "PluginManifest" as IPluginManifest
  interface "PluginContext" as IPluginContext
  interface "VaultService" as IVaultService
  interface "KeyspaceService" as IKeyspaceService
  interface "WocService" as IWocService
  interface "BackgroundService" as IBackgroundService
}

package "plugin 基础设施层" {
  [plugin-vault]
  [plugin-background]
  [plugin-woc]
  [plugin-protocol]
  [plugin-sat-subscription]
}

package "plugin 平台 / 业务层" {
  [plugin-key-import]
  [plugin-assets]
  [plugin-transfer]
  [plugin-p2pkh]
  [plugin-message]
  [plugin-contacts]
  [plugin-poker]
}

[AppShell / Bootstrap] --> [PluginHost] : 创建 host\n注册 manifest\n启用插件
[PluginHost] --> [CapabilityRegistry] : provide / get
[PluginHost] --> [MessageBus] : publish / subscribe
[PluginHost] --> [RouteRegistry]
[PluginHost] --> [MenuRegistry]
[PluginHost] --> [SettingsRegistry]
[PluginHost] --> [HomeRegistry]
[PluginHost] --> [TransferRegistry]
[PluginHost] --> [AssetRegistry]
[PluginHost] --> [TopbarRegistry]
[PluginHost] --> [I18nService]
[PluginHost] --> [LogService]

[PluginHost] ..> IPluginManifest : 按 manifest 装配
[PluginHost] ..> IPluginContext : setup(ctx)

[plugin-vault] ..> IVaultService : 实现 capability
[plugin-background] ..> IBackgroundService : 实现 capability
[plugin-woc] ..> IWocService : 实现 capability
[plugin-p2pkh] ..> IKeyspaceService : 读取 key namespace

[plugin-vault] --> [PluginHost] : 注册 vault.service
[plugin-background] --> [PluginHost] : 注册 background.service
[plugin-woc] --> [PluginHost] : 注册 woc.service
[plugin-protocol] --> [PluginHost] : 注册 protocol UI / 流程
[plugin-key-import] --> [PluginHost]
[plugin-assets] --> [PluginHost]
[plugin-transfer] --> [PluginHost]
[plugin-p2pkh] --> [PluginHost]
[plugin-sat-subscription] --> [PluginHost] : Coordinator Channel 物理传输
[plugin-message] --> [PluginHost]
[plugin-contacts] --> [PluginHost]
[plugin-poker] --> [PluginHost]

note bottom
运行时的核心原则是：
插件通过 contract 和 capability 协作，
而不是直接 import 彼此内部实现。
end note
@enduml
```

## 2. 核心数据模型

这张图只画平台级稳定对象，不画页面 view model。

关键理解：

- `PluginManifest` 是插件装配真值。
- `KeyIdentity` / `KeyRef` / `ActiveKeyState` 是平台 key 域真值。
- `KeyScopedStorageOpenInput` 表达业务数据归属到哪个 key namespace。

```plantuml
@startuml
title Keymaster 核心数据模型
skinparam shadowing false
skinparam classAttributeIconSize 0

class PluginManifest {
  +id: string
  +name: string
  +description?: string
  +dependencies?: PluginDependency[]
  +meta?: PluginMeta
  +keyScopedStorages?: PluginKeyStorageDeclaration[]
  +capability declarations
  +setup(ctx): void | teardown
}

class PluginMeta {
  +kind: PluginKind
  +defaultEnabled: boolean
  +canDisable: boolean
  +providesCapabilities?: string[]
  +displayGroup?: PluginDisplayGroup
}

class PluginState {
  +id: string
  +kind: PluginStateKind
  +error?: string
}

class PluginGraph {
  +plugins: string[]
  +dependencies: Record<string, string[]>
  +provides: Record<string, string[]>
  +reverse: Record<string, PluginReverseDep[]>
}

class KeyIdentity {
  +publicKeyHex: string
  +label: string
  +capabilities: string[]
  +createdAt: string
}

class KeyRef {
  +publicKeyHex: string
  +label: string
  +format: string
  +capabilities: string[]
  +createdAt: string
  +source?: string
  +address?: string
  +network?: BsvNetwork
}

class ActiveKeyState {
  +activePublicKeyHex?: string
}

class KeyScopedStorageOpenInput {
  +publicKeyHex: string
  +pluginId: string
  +storageId: string
  +version: number
  +upgrade(db, oldVersion, newVersion): void
}

class ProtocolRequest {
  +id: string
  +method: ProtocolMethod
  +params: object
}

class BinaryField {
  +$type: "binary"
  +bytes: ArrayBuffer
  +mime?: string
}

PluginManifest --> PluginMeta
PluginState --> PluginManifest : 对应运行中状态
PluginGraph --> PluginManifest : 汇总依赖图

KeyRef --|> KeyIdentity
ActiveKeyState --> KeyIdentity : 当前选中的 key
KeyScopedStorageOpenInput --> KeyIdentity : publicKeyHex 归属

ProtocolRequest --> BinaryField : 参数中的二进制字段

note right of KeyIdentity
平台根身份是 publicKeyHex。
不再存在 key 域 surrogate id。
end note

note right of KeyScopedStorageOpenInput
key-scoped DB name 语义：
keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>
end note
@enduml
```

## 3. 平台状态机

这部分只画两个最关键的状态机：

- Vault 生命周期
- 插件生命周期

原因很直接：这是平台能否继续运行的两个总开关。

```plantuml
@startuml
title Keymaster 平台状态机
skinparam shadowing false

state "VaultStatus" as VaultStatus {
  [*] --> booting
  booting --> uninitialized : 无 vault_meta
  booting --> locked : 已有 vault
  uninitialized --> unlocked : createVaultWithInitialKey /\ncreateVaultWithImportedKey
  locked --> unlocked : unlock
  unlocked --> locked : lock
  unlocked --> uninitialized : 删除最后一把 key 后收敛空 Vault
}

state "PluginStateKind" as PluginStateKind {
  [*] --> registered
  registered --> enabled : enable
  registered --> blocked : 依赖不满足
  enabled --> disabled : disable
  enabled --> error_disabled : teardown 出错但已卸载
  blocked --> enabled : 依赖恢复后 enable
  disabled --> enabled : enable
  error_disabled --> enabled : 再次 enable
}

note bottom of VaultStatus
unlocked 的语义不是"只有 masterKey 在内存"。
它还要求 keyspace ready 边界已经完成。
end note

note bottom of PluginStateKind
plugin host 支持运行期启停，
而不是一次启动后静态常驻。
end note
@enduml
```

## 4. 关键执行流：Unlock

我选 `unlock` 作为总览页唯一主流程。

原因：

- 这条路径会穿过 Vault、Keyspace、Runtime 和业务插件。
- 它能体现这个系统最核心的边界收敛点。
- 它比某一个业务方法更能代表平台骨架。

```plantuml
@startuml
title Keymaster Unlock 主流程
skinparam shadowing false

actor User
participant "UI\n(AppShell / LockedShell)" as UI
participant "VaultService" as Vault
participant "VaultDB" as VaultDB
participant "KeyspaceService" as Keyspace
participant "PluginHost / Runtime" as Runtime
participant "Business Plugins" as Plugins

User -> UI : 输入密码并点击解锁
UI -> Vault : unlock(password)
Vault -> VaultDB : 读取 vault_meta / vault_keys
Vault -> Vault : 校验密码\n派生 masterKey / masterSalt
Vault -> Vault : migrateLegacyStaging()
Vault -> Keyspace : onVaultUnlocked()
Keyspace -> Keyspace : 载入 key 列表
Keyspace -> Keyspace : 选择 / 校验 activePublicKeyHex
Keyspace --> Vault : keyspace ready
Vault -> Vault : setStatus("unlocked")
Vault --> UI : unlock 成功

UI -> Runtime : 读取 capability / active key
Runtime -> Plugins : 业务插件开始安全读取 key-scoped storage
Plugins -> Keyspace : openKeyStorage(publicKeyHex, pluginId, storageId)
Keyspace --> Plugins : 返回 key namespace DB handle

note right of Vault
关键顺序不能反：
migration -> keyspace ready -> setStatus("unlocked")
否则 UI / 插件会过早进入 unlocked 态，
然后撞上 key storage not ready。
end note
@enduml
```

## 5. 启动关键能力契约

> 状态：实现中。浏览器迁移、跨标签、localStorage 禁用和 setup 故障场景仍需在目标
> 浏览器 profile 中完成发布前验收。

插件 manifest 的 `meta.startup` 显式区分运行期不可关闭与首屏启动前提。只有
`startup: "required"` 的受信任内建插件才可成为 entrypoint 的启动依赖，并必须同时
满足 `defaultEnabled: true`、`canDisable: false` 和非空 capability 声明；Vault 当前
是唯一 required 插件。

启停配置存储为 `{ version: 2, enabled }`。旧裸对象只迁移一次，required 插件的值
始终由 manifest 优先规范化为 `true`，包括 storage 跨标签同步。runtime host 在
`register` / `enable` 阶段校验 manifest、setup ownership 和声明 capability；required
失败抛出结构化启动错误并回滚，optional 失败仍隔离为 `error-disabled`。

required 插件的依赖 provider 必须在完整 manifest 图上验证，而不是依赖当前注册顺序；
因此 Web bootstrap 会先预扫描全部 manifest，再开始逐个注册。

Web 的边界是：

```text
manifest 注册 -> host.assertCapabilities(WEB_STARTUP_REQUIRED_CAPABILITIES)
              -> 成功后 root.render(React)
              -> 缺失/失败进入 pre-bootstrap.plugins fatal page
```

React 组件不再负责推断或兜底启动依赖。

## 6. 阅读方式

- 先看“运行时组件关系”，理解系统为什么是插件宿主架构。
- 再看“核心数据模型”，理解系统以什么对象作为真值。
- 再看“平台状态机”，理解什么时候系统能安全工作。
- 最后看“Unlock 主流程”，理解这些对象和状态是如何串起来的。

## 7. 后续可拆分的专题

这份文档故意没有继续展开以下专题：

- `plugin-protocol` 的 request / confirm / result 流程
- `plugin-p2pkh` 的转账预览与协议 spend 细节
- `plugin-message` 的本地消息历史与固定私密协议
- `plugin-contacts` 的 Ping/Pong 在线状态资源

普通 BSV/P2PKH 的确认数据链路已统一为：

```text
Coordinator P2PKH data-source selection
  -> p2pkh.transactions-sync（按网络过滤、可断点续传）
  -> p2pkh_transactions（唯一确认事实）
  -> p2pkh_owned_outpoints（可重建查询投影）
  -> P2PKH service 的余额、Coins、Transactions 视图
```

页面不直接访问 WOC/JungleBus。Coordinator 持有 provider 选择、配置和
`includeTestnet` 的 worker 侧真值；配置先持久化再切换内存状态。广播成功后
由本地交易 DAG 提供 `local-confirmed` 找零，异常交易保持 `isolated`，链事实
在确认、竞争花费或完整 reorg 核对后再收敛本地覆盖层。

如果后面要继续写，我建议每个专题单独一页，不要继续往这份总览里堆。
