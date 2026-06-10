# 003 P2PKH 双资产硬切换施工单

## 目标

把 `plugin-p2pkh` 一次性切换为“一个 P2PKH 资产供应商维护两个资产”的模型。

切换完成后：

```txt
providerId = "p2pkh"

assetId = "bsv"
  BSV mainnet P2PKH 资产

assetId = "bsvtest"
  BSV testnet P2PKH 资产
```

一个 Vault 私钥不是一个单网络资产。一个 Vault 私钥材料在 P2PKH 里要同时派生两个网络资源：

```txt
keyId + main -> mainnet P2PKH 地址 -> bsv
keyId + test -> testnet P2PKH 地址 -> bsvtest
```

## 硬切换缘由

1. `bsv` 和 `bsvtest` 是两个资产，不是两个 provider。它们共享 P2PKH 地址派生、UTXO 同步、签名、广播和页面能力，拆成两个 provider 会把网络差异误建模为业务实现差异。
2. 当前实现把 `assetId` 设为 `keyId`，资产平台看到的是“每把私钥一项资产”。这不符合资产语义。资产应是 `bsv` / `bsvtest`，私钥只是持有该资产的资源来源。
3. 当前 P2PKH 地址资源只按 `keyId` 存储，隐含使用 `vault.KeyRef.network`。这会阻止同一私钥同时拥有 mainnet 和 testnet P2PKH 资产，必须一次性切到 `keyId + network` 资源模型。
4. 分步骤保留旧 `assetId = keyId` 会让资产列表、详情、转账和 IndexedDB 同时存在两套身份体系，容易出现余额重复、网络错配、广播到错误 endpoint 等问题。

## 核心不变量

1. `plugin-p2pkh` 只注册一个 `AssetProvider`，id 固定为 `p2pkh`。
2. `plugin-p2pkh` 对外只暴露两个资产 id：`bsv` 和 `bsvtest`。
3. Vault key 表示私钥身份，不表示 P2PKH 资产网络。
4. P2PKH 内部资源必须用 `resourceId = keyId:network` 唯一标识。
5. `assetId` 决定网络：

```txt
bsv     -> main
bsvtest -> test
```

6. `keyId` 决定使用哪把私钥。
7. 转账 prepare、sign、broadcast 必须使用同一个网络上下文，不能在 broadcast 阶段重新猜网络。
8. mainnet 和 testnet 的余额、UTXO、历史、同步状态不能互相污染。

## 不能怎么做

1. 不能注册两个 provider，例如 `p2pkh-main` 和 `p2pkh-test`。
2. 不能继续把 `AssetSummary.assetId` 设为 `keyId`。
3. 不能把 `vault.KeyRef.network` 当作 P2PKH 资产网络边界。
4. 不能在 `plugin-assets` 或 `plugin-transfer` 里硬编码 `bsv` / `bsvtest` 的业务逻辑。
5. 不能让 `contracts/src/assets.ts` 出现 P2PKH、UTXO、script、WOC 等实现细节。
6. 不能在 `broadcast()` 里用第一条地址或第一把 key 的网络选择 WOC endpoint。
7. 不能把 mainnet UTXO 用于 `bsvtest` 转账，也不能把 testnet UTXO 用于 `bsv` 转账。
8. 不能为了兼容旧缓存保留旧 DB keyPath。旧 P2PKH 缓存可以丢弃后重新同步，Vault 私钥不受影响。

## 资产身份设计

新增 P2PKH 内部资产定义：

```txt
P2pkhAssetId = "bsv" | "bsvtest"

P2PKH_ASSETS:
  bsv:
    assetId: "bsv"
    label: "BSV"
    network: "main"
    unit: "sats"
    tags: ["p2pkh", "main"]

  bsvtest:
    assetId: "bsvtest"
    label: "BSV Testnet"
    network: "test"
    unit: "sats"
    tags: ["p2pkh", "test"]
```

资源身份：

```txt
resourceId = `${keyId}:${network}`
```

资源记录：

```txt
P2pkhKeyResource:
  resourceId
  keyId
  label
  address
  network
  createdAt
  lastSyncedAt?
```

余额、UTXO、历史都按 `resourceId` 存储，同时保留 `keyId` 和 `network` 便于查询与展示。

## 文件级施工

### packages/plugin-p2pkh/src/p2pkhContracts.ts

调整 P2PKH 内部契约。

必须做：

1. 新增 `P2pkhAssetId = "bsv" | "bsvtest"`。
2. 新增资产定义类型或常量需要的字段：`assetId`、`label`、`network`、`unit`。
3. `P2pkhKeyResource` 新增 `resourceId`，保留 `keyId`，网络仍为 `BsvNetwork`。
4. `P2pkhBalanceRow` 对应的业务类型必须能按 `resourceId` 表达。
5. `P2pkhUtxo` 新增 `resourceId` 和 `network`。
6. `P2pkhHistoryItem` 新增 `resourceId` 和 `network`。
7. `UtxoAllocationRequest` 新增 `assetId: P2pkhAssetId` 或 `network: BsvNetwork`。推荐用 `assetId`，由 P2PKH 内部映射到网络。
8. `P2pkhService` 新增或调整这些能力：

```txt
syncAsset(assetId)
syncAll()
getAssetBalance(assetId)
getResourceBalance(resourceId)
listResources(assetId?)
listUtxos(filter?)
listHistory(filter?)
allocateUtxos(request)
onKeyImported(keyId)
onKeyRemoved(keyId)
```

不能做：

1. 不能把 `P2pkhAssetId` 放到 `packages/contracts`。
2. 不能让 contracts 知道 `resourceId` 的内部格式。
3. 不能删除 `keyId`，转账仍需要知道使用哪把私钥签名。

### packages/plugin-p2pkh/src/p2pkhDb.ts

硬切换 P2PKH IndexedDB schema。

必须做：

1. `DB_VERSION` 从 `1` 升级到 `2`。
2. 地址 store 使用 `resourceId` 作为 keyPath。
3. balance store 使用 `resourceId` 作为 keyPath。
4. UTXO store 记录必须包含 `resourceId`、`keyId`、`network`。
5. history store 记录必须包含 `resourceId`、`keyId`、`network`。
6. 为常用查询建立索引：

```txt
p2pkh_addresses:
  resourceId keyPath
  keyId index
  network index
  address index，唯一

p2pkh_balances:
  resourceId keyPath
  keyId index
  network index

p2pkh_utxos:
  id keyPath
  resourceId index
  keyId index
  network index

p2pkh_history:
  id keyPath
  resourceId index
  keyId index
  network index
```

7. v2 upgrade 时删除旧 `p2pkh_addresses`、`p2pkh_balances`、`p2pkh_utxos`、`p2pkh_history` 后重建。

设计缘由：

旧缓存可从 Vault 私钥和 WOC 重新生成。硬迁移保留旧缓存会让 `keyId` 和 `resourceId` 两套主键并存，风险大于收益。

特殊情况：

1. 如果用户已有旧缓存，升级后 P2PKH 余额会暂时显示 0 或未同步，执行同步后恢复。
2. 如果 WOC 不可用，旧缓存不保留，页面应显示同步失败或暂无数据，但 Vault 私钥不能受影响。
3. 如果 upgrade 中发现 store 不存在，按新 schema 创建即可。

不能做：

1. 不能保留旧 keyPath 为 `keyId` 的 store。
2. 不能迁移旧 main/test 单网络记录后伪装成双网络记录。
3. 不能把私钥材料写入 P2PKH DB。

### packages/plugin-p2pkh/src/p2pkhService.ts

重写服务层资源边界。

必须做：

1. 新增资产到网络的映射函数：

```txt
assetIdToNetwork("bsv")     -> "main"
assetIdToNetwork("bsvtest") -> "test"
```

2. 新增 `makeResourceId(keyId, network)`。
3. `getOrCreateAddress(keyId, network)` 按指定网络派生地址，不再使用 `vault.KeyRef.network`。
4. `onKeyImported(keyId)` 为同一 key 同时创建 main/test 两条 P2PKH 地址资源。
5. `syncAll()` 同步所有 Vault key 的 main/test 资源。
6. `syncAsset(assetId)` 只同步该资产对应网络的所有 Vault key。
7. `syncOne(keyId, network)` 只同步一个资源。
8. `getAssetBalance(assetId)` 聚合同网络所有 resource balance。
9. `getResourceBalance(resourceId)` 读取单资源余额。
10. `listResources(assetId?)` 可按资产网络过滤。
11. `listUtxos(filter?)` 支持按 `assetId`、`keyId`、`resourceId` 过滤。
12. `listHistory(filter?)` 支持按 `assetId`、`keyId`、`resourceId` 过滤。
13. `allocateUtxos(request)` 必须先按 `assetId` 过滤网络，再按可选 `keyId` 过滤私钥。
14. 写入 balance、UTXO、history 时必须使用 `resourceId`。
15. 同步完成后更新对应地址资源的 `lastSyncedAt`。

不能做：

1. 不能从 Vault key 的 `network` 字段决定 P2PKH 网络。
2. 不能在 `syncAll()` 里只同步 Vault key 原网络。
3. 不能让 `allocateUtxos()` 从两个网络混选 UTXO。
4. 不能在同步失败时清空已成功同步的另一个网络数据。

特殊情况：

1. 如果某个 key 派生失败，只标记本次同步失败，不能删除其他 key 的资源。
2. 如果某个网络 WOC 限流，状态可以标记 `rate-limited`，但另一个网络已有缓存仍可展示。
3. 如果 `assetId` 非法，抛英文错误，例如 `Unknown P2PKH asset "xxx"`。

### packages/plugin-p2pkh/src/p2pkhAssetProvider.ts

把对外资产从“按 key 列表”改为“固定两个资产”。

必须做：

1. `listAssets()` 永远返回 `bsv` 和 `bsvtest` 两条摘要。
2. `bsv` 余额来自 mainnet 所有资源聚合。
3. `bsvtest` 余额来自 testnet 所有资源聚合。
4. `AssetSummary.assetId` 分别为 `bsv`、`bsvtest`。
5. `AssetSummary.providerId` 固定为 `p2pkh`。
6. `AssetSummary.network` 分别为 `main`、`test`。
7. `detailRoute` 指向 P2PKH 自己的详情页，并带上 `assetId` 查询参数。
8. `getAsset(assetId)` 只返回对应资产详情。
9. `listActivity(assetId)` 只返回对应网络历史。
10. `sync(assetId?)`：

```txt
assetId = "bsv"     -> syncAsset("bsv")
assetId = "bsvtest" -> syncAsset("bsvtest")
assetId undefined   -> syncAll()
```

不能做：

1. 不能再把每个 key 映射成一个 `AssetSummary`。
2. 不能把 mainnet 和 testnet 历史混在同一个资产详情里。
3. 不能返回第三个隐藏资产或兼容旧 `keyId` 资产。

### packages/plugin-p2pkh/src/p2pkhTransferProvider.ts

让转账网络由资产决定，并修复广播网络来源。

必须做：

1. `canHandle(input)` 在指定 `assetProviderId` 时只接受 `p2pkh`。
2. 指定 `assetId` 时只接受 `bsv` 或 `bsvtest`。
3. 未指定 `assetId` 时，可以继续允许手动 provider 转账，但必须默认到 `bsv` 或要求调用方选择资产。推荐要求选择资产，避免网络不明确。
4. `prepare(input)` 必须要求 `keyId` 和 `assetId`。
5. `prepare(input)` 调用 `allocateUtxos({ assetId, keyId, ... })`。
6. `sign(input, draft)` 根据 `assetId` 派生 change address：

```txt
bsv     -> deriveP2pkhAddress(privateKey, "main")
bsvtest -> deriveP2pkhAddress(privateKey, "test")
```

7. 签名产物必须携带本次网络，供 broadcast 使用。

推荐做法：

```txt
SignedTransfer 增加 details?: Record<string, unknown>

sign 返回：
  details: {
    p2pkh: {
      assetId,
      network
    }
  }
```

8. `broadcast(signed)` 从 `signed.details.p2pkh.network` 读取网络，选择对应 WOC endpoint。

不能做：

1. 不能在 broadcast 阶段调用 `service.listKeys()` 后取第一条网络。
2. 不能从 `vault.getKey(keyId).network` 推断广播网络。
3. 不能允许 `assetId` 缺失时默默广播到 mainnet。
4. 不能把 testnet 交易发到 mainnet WOC endpoint。

特殊情况：

1. 如果 draft 里没有 allocation，抛英文错误 `Draft missing p2pkh allocation`。
2. 如果 signed transfer 没有 P2PKH network details，抛英文错误 `Signed transfer missing p2pkh network`。
3. 如果用户未选择资产，UI 层应提示选择资产；provider 层仍抛英文错误，例如 `P2PKH provider requires an assetId`。

### packages/contracts/src/transfer.ts

为广播阶段保留 provider 私有上下文。

必须做：

1. `SignedTransfer` 增加：

```txt
details?: Record<string, unknown>
```

2. 注释说明 `details` 是 provider 专属签名上下文，平台不解释。

不能做：

1. 不能在 contracts 里新增 `p2pkhNetwork`、`utxos`、`assetIdToNetwork` 等 P2PKH 字段。
2. 不能让 `plugin-transfer` 解释 `details.p2pkh`。

### packages/plugin-transfer/src/TransferPage.tsx

确保资产选择驱动转账上下文。

必须做：

1. 当前 `ctx` 已携带 `assetId` 和 `assetProviderId`，保留这个方向。
2. 当用户选择 `bsv` 或 `bsvtest` 时，传入 P2PKH provider 的 `assetId` 必须准确。
3. `prepare` 按 provider 返回的英文错误展示即可，页面文案可中文。
4. 资产下拉显示建议包含资产名、网络和 provider，例如 `BSV / main (p2pkh)`。

不能做：

1. 不能让转账页面根据 `assetId` 自己判断 main/test。
2. 不能让转账页面直接调用 `p2pkh.service`。
3. 不能在用户未选择资产时给 P2PKH 默认 mainnet。

特殊情况：

1. 如果用户手动选择 provider 但未选择资产，P2PKH provider 应从兼容列表中消失，或者 prepare 时抛错。
2. 如果资产列表还没加载完成，保持“未指定”状态，不自动推断资产。

### packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx

调整 P2PKH 总览页展示双网络资源。

必须做：

1. 页面列出 `resourceId`、`keyId`、标签、地址、网络、最近同步。
2. 支持从 URL 查询参数读取 `assetId`，例如 `/p2pkh?assetId=bsv`。
3. 指定 `assetId` 时只展示对应网络资源。
4. 同步按钮在指定 `assetId` 时同步该资产，不指定时同步全部。

不能做：

1. 不能只按 Vault key 展示一行。
2. 不能隐藏 testnet 资源。

### packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx

按资产网络过滤历史。

必须做：

1. 支持 URL 查询参数 `assetId`。
2. 指定 `assetId` 时只展示对应网络历史。
3. 表格增加网络列。

不能做：

1. 不能把 `bsv` 和 `bsvtest` 历史无提示混在一起。

### packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx

按资产网络过滤 UTXO。

必须做：

1. 支持 URL 查询参数 `assetId`。
2. 指定 `assetId` 时只展示对应网络 UTXO。
3. 表格增加网络列和地址列。

不能做：

1. 不能让不同网络 UTXO 出现在同一资产过滤结果里。

### packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx

调整首页 widget 为双资产展示。

必须做：

1. 展示 `BSV` 和 `BSV Testnet` 两个余额。
2. 刷新按钮触发 `syncAll()`。
3. 状态仍展示 P2PKH 同步状态。

可选：

1. 每个资产提供独立刷新按钮，分别调用 `syncAsset("bsv")` 和 `syncAsset("bsvtest")`。

不能做：

1. 不能只展示 mainnet 聚合余额。
2. 不能把两个网络余额相加成一个总余额。

### packages/plugin-p2pkh/src/manifest.ts

更新说明文案和路由语义。

必须做：

1. 插件 description 改为说明维护 `bsv` 和 `bsvtest`。
2. 菜单和页面文案避免暗示 P2PKH 只有 mainnet。
3. 面包屑保持 P2PKH 业务页即可，不需要为两个资产注册两套页面。

不能做：

1. 不能注册两个 P2PKH 插件。
2. 不能注册两个 AssetProvider。

### packages/plugin-p2pkh/src/p2pkhSigner.ts

保持签名和地址派生工具函数纯粹。

必须做：

1. `deriveP2pkhAddress(privateKeyHex, network)` 继续以显式 network 参数派生地址。
2. 调用方必须传入资产映射出来的 network。

不能做：

1. 不能在 signer 内部读取 Vault key。
2. 不能在 signer 内部默认选择 mainnet 来掩盖调用方缺参。

### packages/plugin-p2pkh/src/wocClient.ts

保持 WOC endpoint 映射。

必须做：

1. `WOC_NETWORK_BASE.main` 对应 mainnet。
2. `WOC_NETWORK_BASE.test` 对应 testnet。
3. 调用方必须传入明确 network。

不能做：

1. 不能让 `WocClient` 自己猜网络。

## 特殊情况处理

### 旧 IndexedDB 缓存

处理方式：

1. P2PKH DB v2 删除旧 store 后重建。
2. 旧地址、余额、UTXO、历史缓存全部作废。
3. Vault 私钥不删除、不迁移、不重写。
4. 用户重新同步后生成 `keyId:main` 和 `keyId:test` 两套资源。

原因：

旧数据主键是 `keyId`，无法无歧义表达双网络资源。硬切换保留它会造成身份污染。

### Vault key 的 network 字段

处理方式：

1. P2PKH 派生地址时忽略 `vault.KeyRef.network`。
2. P2PKH 转账网络由 `assetId` 决定。
3. Vault 其他插件如果仍使用 `network` 字段，不在本次施工中改动。

原因：

本次目标是 P2PKH 双资产模型，不是重构 Vault 元数据。Vault key 的 `network` 可以视为导入来源或旧元数据，但不能再限制 P2PKH 双网络资产。

### 用户未选择资产直接转账

处理方式：

1. P2PKH provider 不默认 mainnet。
2. `canHandle` 对缺少 `assetId` 的输入返回 false，或 `prepare` 抛 `P2PKH provider requires an assetId`。
3. UI 显示用户需要选择资产。

原因：

默认 mainnet 会把 testnet 调试交易误导到真实资产网络，是不可接受的。

### 同一私钥两个网络地址相同或冲突

处理方式：

1. 正常 BSV main/test P2PKH 地址编码不同，不应相同。
2. 如果 DB 唯一 address 索引发生冲突，抛英文错误并停止写入该资源。
3. 不自动覆盖已有资源。

### WOC 单网络失败

处理方式：

1. mainnet 失败不清空 testnet 缓存。
2. testnet 失败不清空 mainnet 缓存。
3. 全局 `syncStatus` 可以标记失败，但资产详情仍展示已有缓存。

后续如果需要更细粒度，可以把同步状态拆成 per asset status；本次不强制，除非现有 UI 明显需要。

## 最终验收清单

### 代码结构验收

1. `plugin-p2pkh` 只注册一个 `AssetProvider`，id 为 `p2pkh`。
2. `listAssets()` 只返回 `bsv` 和 `bsvtest` 两个资产。
3. 不存在 `assetId = keyId` 的 P2PKH 对外资产摘要。
4. P2PKH DB 使用 `resourceId = keyId:network` 存地址、余额、UTXO、历史。
5. `vault.KeyRef.network` 不再决定 P2PKH 派生、同步、转账、广播网络。
6. `SignedTransfer.details` 存在，且 contracts 不包含 P2PKH 专属字段。

### 行为验收

1. 导入一把私钥后，P2PKH 能创建 main/test 两条资源。
2. 资产页显示 `BSV` 和 `BSV Testnet` 两条资产。
3. `BSV` 余额只聚合 mainnet 资源。
4. `BSV Testnet` 余额只聚合 testnet 资源。
5. 同步 `bsv` 只请求 WOC main endpoint。
6. 同步 `bsvtest` 只请求 WOC test endpoint。
7. P2PKH 总览页能看到同一私钥对应的两个网络地址。
8. 历史页和 UTXO 页按 `assetId` 过滤时不串网。
9. 选择 `bsv` 转账时，change address 使用 mainnet 地址，广播到 mainnet WOC。
10. 选择 `bsvtest` 转账时，change address 使用 testnet 地址，广播到 testnet WOC。
11. 未选择资产时，P2PKH 转账不能静默默认 mainnet。
12. 旧 P2PKH DB 缓存升级后清空，重新同步可恢复显示。

### 命令验收

施工完成后至少运行：

```txt
pnpm --filter @web-wallet/contracts typecheck
pnpm --filter @web-wallet/plugin-p2pkh typecheck
pnpm --filter @web-wallet/plugin-transfer typecheck
pnpm --filter @web-wallet/web typecheck
pnpm test
```

如果 workspace 没有对应脚本，改用当前包已有的 `build` 或 `typecheck` 脚本，但必须记录实际运行命令和结果。

### 人工验收

1. 新建或解锁 Vault。
2. 导入一把可用于 P2PKH 的私钥。
3. 打开资产页，确认只出现 `BSV` 和 `BSV Testnet` 两个 P2PKH 资产，不出现按 key 拆分的资产。
4. 分别点击两个资产详情，确认网络、地址、余额、历史、UTXO 过滤正确。
5. 对 testnet 资产执行一次小额转账，确认广播 endpoint 是 testnet。
6. 在未选择资产时尝试 P2PKH 转账，确认不会默认 mainnet。

## 完成标准

本次施工完成后，`plugin-p2pkh` 的对外资产模型必须只有：

```txt
p2pkh:bsv
p2pkh:bsvtest
```

私钥数量只影响每个资产内部聚合了多少 P2PKH 地址资源，不再影响资产数量。
