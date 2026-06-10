# 002 资产平台插件化硬切换施工单

## 目标

把当前项目一次性切换为 `资产平台插件 + 资产 Provider + 转账 Provider` 架构。

本次不是渐进式迁移，不保留旧的“P2PKH 等于资产系统”的隐含结构。切换完成后：

1. `plugin-assets` 是资产平台，只负责资产聚合、资产入口、资产展示协议和资产 registry。
2. `plugin-p2pkh` 只是一个资产实现，注册 P2PKH AssetProvider，并可选注册 P2PKH TransferProvider。
3. `plugin-transfer` 仍然是转账流程平台，只负责 prepare/sign/broadcast 流程编排，不拥有资产模型。
4. `packages/contracts` 只放跨包协议；P2PKH 专属内部类型默认留在 `plugin-p2pkh` 内部。

## 硬切换缘由

1. 资产能力会扩展。P2PKH 只是 BSV 钱包的一种基础资产形态，后续还会有 1Sat、合约资产、token、收藏品或其他脚本资产。如果继续让 `p2pkh.ts` 暗含“资产平台”，后续每新增一种资产都会挤进 P2PKH 的边界。
2. 资产展示和资产实现是两件事。资产首页、余额聚合、资产详情入口、活动列表入口属于平台；UTXO 同步、P2PKH 签名、脚本规则属于 P2PKH 插件。
3. 转账和资产也不是同一件事。某些资产可以转账，某些资产只能查看，某些资产需要特殊授权流程。`plugin-transfer` 只应消费 TransferProvider，不应直接理解资产内部结构。
4. 插件边界必须一次性定死。如果先临时保留 `contracts/src/p2pkh.ts` 作为公共资产核心，再慢慢迁移，会形成双平台：一边是 `plugin-assets`，一边是 P2PKH 公共服务，最终边界会更乱。

## 核心结论

```txt
plugin-assets
  资产平台。提供 asset.registry，注册资产列表页、资产详情页、资产首页 widget。

plugin-p2pkh
  P2PKH 资产插件。提供 P2PKH AssetProvider，内部管理 UTXO、同步、历史、签名。

plugin-transfer
  转账平台。消费 TransferProvider，完成转账流程。不消费 P2PKH 内部服务。

packages/contracts
  只放跨包协议。新增 assets.ts，避免 p2pkh.ts 承担资产平台含义。
```

## 最终结构

```txt
packages/
  contracts/
    src/
      index.ts
      assets.ts
      transfer.ts
      vault.ts
      keyImport.ts
      plugin.ts
      navigation.ts
      settings.ts
      home.ts
      contacts.ts
      eventBus.ts
      registries.ts

  runtime/
    src/
      createPluginHost.ts
      index.ts
      registries/
        assetRegistry.ts
        breadcrumbRegistry.ts
        commandRegistry.ts
        homeRegistry.ts
        importerRegistry.ts
        menuRegistry.ts
        routeRegistry.ts
        settingsRegistry.ts
        transferRegistry.ts
      react/
        PluginHostProvider.tsx
        useCapability.ts
        useRegistry.ts
        useRuntimeStatus.ts

  plugin-assets/
    src/
      index.ts
      manifest.ts
      AssetsPage.tsx
      AssetDetailPage.tsx
      AssetsHomeWidget.tsx
      assetsFlow.ts

  plugin-p2pkh/
    src/
      index.ts
      manifest.ts
      p2pkhAssetProvider.ts
      p2pkhTransferProvider.ts
      p2pkhService.ts
      p2pkhContracts.ts
      p2pkhDb.ts
      p2pkhSigner.ts
      utxoAllocator.ts
      wocClient.ts
      pages/
        P2pkhOverviewPage.tsx
        P2pkhSettingsPage.tsx
        P2pkhUtxosPage.tsx
        P2pkhHistoryPage.tsx
      widgets/
        P2pkhBalanceWidget.tsx
```

## 资产契约设计

### packages/contracts/src/assets.ts

新增资产平台公共契约。

```txt
AssetKind
  资产类别，例如 coin、token、collectible、contract。

AssetProvider
  资产实现方注册给 asset.registry 的 provider。

AssetSummary
  资产列表使用的最小摘要。

AssetBalance
  可展示余额，不要求所有资产都有 satoshis 语义。

AssetActivity
  资产活动摘要。只放平台可展示字段，不放 P2PKH UTXO 细节。

AssetDetailRoute
  provider 可声明自己的详情页 routeId/path。

AssetRegistry
  注册和读取 AssetProvider。
```

设计要求：

1. `AssetProvider` 必须是通用资产协议，不能包含 `utxo`、`script`、`wif`、`p2pkh` 等专属字段。
2. `AssetSummary` 只描述资产列表和聚合所需信息，例如 id、kind、label、network、balance、status、detailRoute。
3. `AssetActivity` 只表达平台层活动，例如 txid、title、amount、direction、status、occurredAt。
4. 资产 provider 可以提供自定义详情页面，但详情页面由该资产插件自己注册到 `route.registry`。

建议协议形态：

```txt
AssetProvider
  id
  name
  kind
  listAssets()
  getAsset(assetId)
  listActivity(assetId)
  sync(assetId?)
  onChange(handler)
```

## 文件级施工

### packages/contracts/src/assets.ts

新增文件。定义资产平台协议。

必须包含：

1. `AssetKind`
2. `AssetStatus`
3. `AssetBalance`
4. `AssetSummary`
5. `AssetActivity`
6. `AssetProvider`
7. `AssetRegistry`

不能包含：

1. P2PKH UTXO 类型。
2. P2PKH 签名输入。
3. P2PKH 同步客户端返回值。
4. 任意 IndexedDB schema。
5. 任意 React 页面组件实现。

### packages/contracts/src/p2pkh.ts

硬切换后不再作为资产平台公共契约。

处理方式二选一，按实际跨包需求选择：

1. 如果只有 `plugin-p2pkh` 自己使用 P2PKH 专属类型：删除该文件，把类型移到 `packages/plugin-p2pkh/src/p2pkhContracts.ts`。
2. 如果确实有两个以上非 P2PKH 包需要 P2PKH 专属协议：保留为“领域专属契约”，但必须从注释和导出上明确它不是资产平台。

默认采用第 1 种。

### packages/contracts/src/transfer.ts

调整转账协议，避免依赖 P2PKH 类型。

必须做：

1. 移除对 `./p2pkh.js` 的 import。
2. `TransferDraft` 不再直接暴露 `UtxoAllocation`。
3. provider 专属预览数据放入 `details?: Record<string, unknown>` 或更明确的通用字段。
4. `TransferContext` 可以包含 `assetId`、`assetProviderId`，但不能包含 P2PKH 专属字段。

不能做：

1. 不能让 `transfer.ts` import `p2pkh.ts`。
2. 不能把 UTXO 选择变成通用转账平台必需字段。
3. 不能让 `plugin-transfer` 直接调用 `p2pkh.service`。

### packages/contracts/src/registries.ts

新增 `AssetRegistry` 的类型出口或引用。

要求：

1. `AssetRegistry` 的实现仍放在 runtime。
2. contracts 只声明接口，不创建 registry。
3. 避免从 `./index.js` 反向 import 造成循环类型混乱，优先从具体文件 import type。

### packages/contracts/src/index.ts

导出 `assets.ts`。

默认删除 `p2pkh.ts` 顶层导出。如果因为特殊情况保留 `p2pkh.ts`，必须在注释中说明：

```txt
p2pkh.ts 是 P2PKH 领域专属协议，不是资产平台协议。
资产平台协议在 assets.ts。
```

### packages/runtime/src/registries/assetRegistry.ts

新增资产注册表实现。

必须实现：

1. `register(provider)`
2. `list()`
3. `get(id)`
4. provider id 重复时抛英文错误。

设计要求：

1. 排序优先按 provider order，再按 name。
2. registry 不缓存 provider 返回的资产数据，只保存 provider 本身。
3. 数据刷新由 provider 自己处理，平台通过 `onChange` 或显式 `sync` 感知变化。

### packages/runtime/src/createPluginHost.ts

新增 `asset.registry` capability。

必须做：

1. 创建 `assetRegistry`。
2. 在 `PluginHost` 上暴露 `assets`。
3. `capabilities.provide("asset.registry", assets)`。
4. 注册顺序不应要求 P2PKH 先于资产平台。

不能做：

1. 不能在 runtime 里 import `plugin-assets`。
2. 不能在 runtime 里 import `plugin-p2pkh`。
3. 不能在 runtime 里写资产展示逻辑。

### packages/runtime/src/index.ts

导出 asset registry 类型和创建逻辑需要的公开 API。

注意：

1. 保持 runtime 对 contracts 的单向依赖。
2. 不导出插件内部类型。

### packages/plugin-assets/package.json

新增包。

依赖：

```txt
@web-wallet/contracts
@web-wallet/runtime
@web-wallet/ui
react
```

是否显式声明 `react` 按当前 workspace 规则处理；如果其他插件没有显式声明，可以保持一致。

### packages/plugin-assets/src/manifest.ts

新增资产平台插件 manifest。

职责：

1. 依赖 `asset.registry`、`route.registry`、`menu.registry`、`home.registry`。
2. 注册资产列表页。
3. 注册资产菜单入口。
4. 注册资产首页 widget。
5. 不注册任何具体资产。

不能做：

1. 不能 import `plugin-p2pkh`。
2. 不能调用 `p2pkh.service`。
3. 不能假设只有一种资产。

### packages/plugin-assets/src/AssetsPage.tsx

新增资产列表页。

职责：

1. 从 `asset.registry` 获取全部 provider。
2. 调用 provider 的 `listAssets()` 聚合资产摘要。
3. 展示资产名称、类别、余额、状态、网络和详情入口。
4. provider 加载失败时，只标记该 provider 失败，不阻塞其他 provider。

特殊情况：

1. 没有资产 provider：显示空状态。
2. 有 provider 但没有资产：显示“暂无资产”状态。
3. 某个 provider 报错：展示该 provider 的错误状态，错误文本来自英文错误信息或映射后的中文 UI 文案。

### packages/plugin-assets/src/AssetDetailPage.tsx

新增通用详情页，或只作为转发页。

推荐做法：

1. 如果 provider 声明了 `detailRoute`，资产列表直接跳 provider 自己的详情页。
2. 通用详情页只展示平台级摘要和活动，不展示 UTXO 等专属字段。

不能做：

1. 不能在通用详情页判断 `provider.id === "p2pkh"` 后渲染 P2PKH 专属 UI。
2. 不能在通用详情页 import P2PKH 页面。

### packages/plugin-assets/src/AssetsHomeWidget.tsx

新增首页资产聚合 widget。

职责：

1. 展示跨 provider 的资产概览。
2. 只使用 `AssetSummary` 和 `AssetBalance`。
3. 不展示 P2PKH UTXO 明细。

### packages/plugin-assets/src/assetsFlow.ts

新增资产聚合辅助逻辑。

职责：

1. 封装 provider 并发加载。
2. 统一处理单个 provider 失败。
3. 给 UI 返回稳定结构。

设计缘由：

资产列表不能因为一个 provider 同步失败而整体不可用。资产平台只负责聚合结果，不拥有 provider 的内部状态。

### packages/plugin-p2pkh/src/p2pkhContracts.ts

新增或迁移 P2PKH 专属类型。

可以包含：

1. `P2pkhKeyResource`
2. `P2pkhBalance`
3. `P2pkhUtxo`
4. `P2pkhHistoryItem`
5. `UtxoAllocationRequest`
6. `UtxoAllocation`
7. `P2pkhService`

设计要求：

1. 这些类型默认只在 `plugin-p2pkh` 内部使用。
2. 只有跨包消费者确实需要 P2PKH 专属类型时，才允许迁回 `contracts`。
3. 迁回前必须先判断是否可以通过 `AssetProvider` 或 `TransferProvider` 表达。

### packages/plugin-p2pkh/src/p2pkhAssetProvider.ts

新增 P2PKH AssetProvider。

职责：

1. 把 P2PKH key、余额、同步状态映射成 `AssetSummary`。
2. 把 P2PKH 历史映射成 `AssetActivity`。
3. 提供 `sync`。
4. 提供 `onChange`。
5. 声明详情页 route。

不能做：

1. 不能把 UTXO 原样塞进 `AssetSummary`。
2. 不能让资产平台知道 P2PKH 数据库结构。
3. 不能绕过 vault 的私钥安全规则。

### packages/plugin-p2pkh/src/manifest.ts

调整注册逻辑。

必须做：

1. 依赖 `asset.registry`。
2. 注册 P2PKH AssetProvider。
3. 保持注册 P2PKH TransferProvider。
4. 保持注册 P2PKH 详情页面、设置页面、面包屑和必要 widget。

不能做：

1. 不能把 P2PKH 资产页面注册成全局资产平台首页。
2. 不能让 P2PKH 插件承担所有资产聚合职责。

### packages/plugin-p2pkh/src/p2pkhTransferProvider.ts

调整转账 provider。

必须做：

1. 继续在 P2PKH 插件内部使用 UTXO 分配。
2. `prepare` 返回通用 `TransferDraft`。
3. P2PKH 专属预览数据放入 provider 自己可解释的 `details`。
4. `TransferPreview` 如需展示 provider 专属信息，应通过 provider 提供的通用展示字段，而不是 import P2PKH 类型。

不能做：

1. 不能要求 `contracts/src/transfer.ts` 理解 UTXO。
2. 不能让 `plugin-transfer` import `plugin-p2pkh`。

### packages/plugin-transfer/src/TransferPage.tsx

调整为资产感知，但不资产实现感知。

建议：

1. 可从 `asset.registry` 读取资产列表，用于选择要转出的资产。
2. 根据资产的 provider/id 过滤或推荐 TransferProvider。
3. 仍由 TransferProvider 执行 prepare/sign/broadcast。

不能做：

1. 不能根据 P2PKH 类型分支处理。
2. 不能直接读取 P2PKH UTXO。

### packages/plugin-transfer/src/TransferPreview.tsx

调整预览结构。

要求：

1. 展示通用字段：收款地址、金额、手续费、摘要、provider 名称。
2. provider 专属信息只展示为通用 key/value 或 provider 提供的 display rows。
3. 不 import P2PKH 专属类型。

### apps/web/src/bootstrapPlugins.ts

调整插件注册顺序。

推荐顺序：

```txt
runtime 内置
vault
home
settings
assets
key-import
transfer
contacts
p2pkh
importers
```

说明：

1. `plugin-assets` 必须早于 `plugin-p2pkh`，因为 P2PKH 要注册 AssetProvider。
2. `plugin-transfer` 可以早于或晚于 `plugin-assets`，但如果 Transfer 页面读取资产列表，建议晚于 `plugin-assets`。
3. importer 插件仍只依赖 importer registry，不依赖资产平台。

### scripts/check-boundaries.mjs

增强边界检查。

必须检查：

1. `plugin-*` 之间禁止直接 import。
2. `plugin-assets` 禁止 import 任何具体资产插件，例如 `plugin-p2pkh`。
3. `plugin-transfer` 禁止 import 任何具体资产插件。
4. `packages/contracts` 禁止 import `packages/runtime`、`packages/ui`、`packages/plugin-*`。
5. `packages/runtime` 禁止 import `packages/plugin-*`。

### README.md

更新架构说明。

必须说明：

1. `plugin-assets` 是资产平台。
2. `plugin-p2pkh` 是资产 provider 之一。
3. `plugin-transfer` 是转账流程平台。
4. `contracts/assets.ts` 是资产平台协议。
5. P2PKH 专属类型默认不进入全局 contracts。

## 不能怎么做

### 不能把 P2PKH 当资产平台

禁止：

```txt
contracts/src/p2pkh.ts 承担 AssetProvider 职责
plugin-assets 依赖 p2pkh.service
AssetsPage 直接 import P2PKH 页面或类型
```

### 不能把转账平台做成资产平台

禁止：

```txt
plugin-transfer 管理资产列表
plugin-transfer 同步余额
plugin-transfer 查询 UTXO
plugin-transfer 判断某资产是否是 P2PKH 后走特殊流程
```

### 不能让 contracts 变成业务实现仓库

禁止：

```txt
contracts 里放 IndexedDB schema
contracts 里放 WOC client 返回结构
contracts 里放签名函数
contracts 里放 React 页面实现
contracts 里放 provider 实例
```

### 不能用跨插件 import 解决协作

禁止：

```txt
plugin-assets import @web-wallet/plugin-p2pkh
plugin-transfer import @web-wallet/plugin-p2pkh
plugin-p2pkh import @web-wallet/plugin-transfer/src/...
```

正确方式：

```txt
资产协作走 asset.registry
转账协作走 transfer.registry
服务调用走 capability
页面接入走 route/menu/breadcrumb registry
```

## 特殊情况处理

### 某个 P2PKH 类型被其他包需要

先判断需求来源：

1. 如果是资产展示需要：改用 `AssetSummary`、`AssetBalance`、`AssetActivity`。
2. 如果是转账流程需要：改用 `TransferContext`、`TransferDraft`、`TransferProvider`。
3. 如果是 P2PKH 专属调试页或高级工具需要：可以把该工具放进 `plugin-p2pkh` 内部。
4. 只有两个以上非 P2PKH 包确实要消费 P2PKH 专属协议时，才允许新建或保留 `contracts/src/p2pkh.ts`。

### 某个资产不能转账

允许。

处理方式：

1. AssetProvider 正常注册。
2. 不注册 TransferProvider。
3. 资产详情页不显示转账入口，或显示禁用状态。
4. `plugin-transfer` 不能假设每个资产都有对应 TransferProvider。

### 某个资产有多个转账方式

允许。

处理方式：

1. 同一个 AssetProvider 可以对应多个 TransferProvider。
2. `TransferProvider.canHandle` 负责判断是否支持当前资产和输入。
3. Transfer 页面只展示可处理的 provider。

### 某个资产同步失败

处理方式：

1. provider 自己记录同步状态。
2. `AssetSummary.status` 显示失败或过期。
3. `AssetsPage` 不能因为一个 provider 失败而整体失败。
4. 错误信息内部保持英文，UI 展示可以映射为中文。

### 资产详情需要专属 UI

处理方式：

1. 资产插件自己注册详情 route。
2. AssetProvider 在 summary 中提供 `detailRoute`。
3. 资产平台只负责跳转，不 import 专属页面。

### 资产 provider 和 transfer provider 顺序问题

处理方式：

1. `asset.registry` 和 `transfer.registry` 都由 runtime 内置提供。
2. `plugin-assets` 和 `plugin-transfer` 是平台 UI 插件，不负责创建 registry。
3. 具体资产插件注册 provider 前，必须在 manifest dependencies 中声明所需 registry。

### 旧的 P2PKH 页面如何处理

处理方式：

1. 保留在 `plugin-p2pkh/pages`。
2. 作为 P2PKH 详情页或设置页接入 route registry。
3. 不再作为全局资产列表页。

### P2PKH UTXO 是否能在资产详情看到

可以，但只能在 P2PKH 自己的详情页看到。

规则：

1. 通用资产页不展示 UTXO。
2. P2PKH 详情页可以展示 UTXO。
3. UTXO 类型留在 `plugin-p2pkh/src/p2pkhContracts.ts`。

### 是否保留 p2pkh.service capability

默认可以保留，但要收紧语义。

规则：

1. `p2pkh.service` 是 P2PKH 插件内部能力，不是资产平台能力。
2. 平台插件不能依赖它。
3. 只有 P2PKH 自己的页面、widget、transfer provider 使用它。
4. 如果未来有非 P2PKH 插件需要它，先审查是否违反资产平台边界。

## 实施顺序

本次是硬切换，不上线中间态；但落地时仍按以下文件顺序修改，避免类型爆炸。

1. 新增 `contracts/src/assets.ts`。
2. 调整 `contracts/src/transfer.ts`，移除 P2PKH 依赖。
3. 调整 `contracts/src/index.ts` 和 `contracts/src/registries.ts`。
4. 新增 `runtime/src/registries/assetRegistry.ts`。
5. 调整 `runtime/src/createPluginHost.ts` 和 `runtime/src/index.ts`。
6. 新增 `packages/plugin-assets`。
7. 迁移 P2PKH 专属类型到 `plugin-p2pkh/src/p2pkhContracts.ts`。
8. 新增 `plugin-p2pkh/src/p2pkhAssetProvider.ts`。
9. 调整 `plugin-p2pkh/src/manifest.ts`。
10. 调整 `plugin-p2pkh/src/p2pkhTransferProvider.ts`。
11. 调整 `plugin-transfer` 页面和预览。
12. 调整 `apps/web/src/bootstrapPlugins.ts`。
13. 增强 `scripts/check-boundaries.mjs`。
14. 更新 README。
15. 跑类型检查、边界检查和应用启动验证。

## 最终验收清单

### 架构验收

- [ ] 存在 `packages/plugin-assets`。
- [ ] 存在 `packages/contracts/src/assets.ts`。
- [ ] `asset.registry` 由 runtime 创建并作为 capability 暴露。
- [ ] `plugin-assets` 只依赖 contracts/runtime/ui，不依赖具体资产插件。
- [ ] `plugin-p2pkh` 注册 AssetProvider。
- [ ] `plugin-p2pkh` 仍可注册 TransferProvider。
- [ ] `plugin-transfer` 不 import P2PKH 插件。
- [ ] `plugin-transfer` 不 import P2PKH 专属类型。
- [ ] `contracts/src/transfer.ts` 不 import `p2pkh.ts`。
- [ ] P2PKH 专属类型默认位于 `plugin-p2pkh/src/p2pkhContracts.ts`。

### 资产平台验收

- [ ] 资产菜单入口来自 `plugin-assets`。
- [ ] 资产列表页从 `asset.registry` 聚合 provider。
- [ ] 没有资产 provider 时显示空状态。
- [ ] 某个 provider 失败时，不影响其他 provider 展示。
- [ ] 资产列表可以展示 P2PKH 资产摘要。
- [ ] P2PKH 详情页由 `plugin-p2pkh` 自己注册。
- [ ] 通用资产页不展示 UTXO 明细。

### 转账验收

- [ ] Transfer 页面可以基于资产选择推荐 TransferProvider。
- [ ] P2PKH 转账仍由 P2PKH TransferProvider 完成。
- [ ] UTXO 分配只发生在 `plugin-p2pkh` 内部。
- [ ] TransferDraft 不包含强类型 P2PKH UTXO 字段。
- [ ] 不可转账资产不会破坏 Transfer 页面。

### 边界验收

- [ ] `lint:boundaries` 能发现插件互相 import。
- [ ] `lint:boundaries` 能发现 `plugin-assets` import 具体资产插件。
- [ ] `lint:boundaries` 能发现 `plugin-transfer` import 具体资产插件。
- [ ] `lint:boundaries` 能发现 contracts import runtime/ui/plugin。
- [ ] `lint:boundaries` 能发现 runtime import plugin。

### 类型和运行验收

- [ ] `npm run typecheck` 通过。
- [ ] `npm run lint:boundaries` 通过。
- [ ] 应用启动后 registry 初始化正常。
- [ ] Vault 创建/解锁流程不受影响。
- [ ] 导入私钥后 P2PKH AssetProvider 能展示资产。
- [ ] P2PKH 同步失败时资产页有明确状态。
- [ ] P2PKH 转账 prepare/sign/broadcast 流程仍可执行。

### 文档验收

- [ ] README 说明资产平台、资产 provider、转账 provider 的关系。
- [ ] README 明确 P2PKH 只是资产 provider 之一。
- [ ] contracts 注释明确 `assets.ts` 是资产平台协议。
- [ ] P2PKH 专属类型注释明确其不是资产平台协议。
