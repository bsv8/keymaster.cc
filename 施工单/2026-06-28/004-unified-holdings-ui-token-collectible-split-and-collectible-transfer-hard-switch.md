# 004 统一持仓 UI + Asset/Token/Collectible 分层 + Collectible Transfer 框架硬切换一次性迭代施工单

## 目标

一次性把当前“资产平台”收口成下面这套最终模型：

```txt
领域层
  = asset / token / collectible 三类对象硬分层
  = 三套独立 registry
  = coin 语义不再污染 token / collectible

UI 层
  = asset + token 共用一套“持仓”UI
  = 继续沿用当前 /assets 路由与“资产”入口
  = collectible 单独平台与单独详情页

转移层
  = 现有 transfer.registry 继续只服务 coin / 现有转账平台
  = 新增 collectible-transfer.registry
  = 先做 collectible transfer 框架，不要求首批具体 handler 插件落地

协议插件
  = plugin-token-bsv21
  = plugin-token-stas
  = plugin-collectible-1satordinals
  = 明确不做 BTC ordinals
```

本次是硬切换，不接受下面这些中间态：

1. 先把 `token` 塞进 `asset.registry`，后面再拆。
2. 先做一套新的 `/tokens` UI，再保留旧 `/assets` UI 并存。
3. 先把 `collectible` 也塞进统一持仓表，后面再单独拆页面。
4. 先让 token / collectible 插件直接 `fetch` WOC，后面再回收进 `plugin-woc`。
5. 先复用现有 `transfer.registry` 做 collectible transfer，后面再拆 item 语义。
6. 先把 BTC ordinals 当成“只读观察器”挂进当前钱包，再慢慢解释不是正式支持。

## 本次范围

本单施工范围：

1. `asset.registry` / `token.registry` / `collectible.registry` 三套协议与 runtime capability。
2. `plugin-assets` 升级为“统一持仓平台”，聚合 `asset + token`。
3. 新增 `plugin-collectibles`，承担 collectible 列表与详情展示。
4. 新增 `collectible-transfer.registry` 与 `plugin-collectible-transfer` 平台壳。
5. 新增三类 BSV 协议插件骨架：
   - `plugin-token-bsv21`
   - `plugin-token-stas`
   - `plugin-collectible-1satordinals`
6. `plugin-woc` 扩展为这些协议的唯一 WOC 查询入口。

本单明确不做：

1. BTC ordinals。
2. token transfer。
3. create token / create collectible 框架。
4. 开发者“删目录即自动消失”的自动发现装配。

## 简述缘由

1. 你已经明确要求 `token` 与 `collectible` 在属性、使用、展示上彻底分开；这意味着分层必须落在领域模型和 registry 上，而不是只在 UI 文案上改名。

2. 但 `asset` 与 `token` 对用户来说都属于“持仓列表”的阅读模式：看名字、看余额、看状态、点详情。若单独再做一套 `/tokens` UI，只会增加负担，也会制造两份几乎相同的平台代码。

3. 因此正确边界不是“asset = token”，而是：

```txt
领域层：asset != token != collectible
UI 层：asset + token 共用一套 holdings UI
```

4. 当前项目有一个必须继续坚持的不变量：所有 WOC 请求必须经过 `plugin-woc`，业务插件不能自己 `fetch`。这条在 [README.md](/home/david/Workspaces/keymaster.cc/README.md:19) 已经写死。token / collectible 扩展不能破坏这条边界。

5. BTC ordinals 被排除，不是因为查询接口不存在，而是因为当前钱包是 BSV 钱包，不是 BTC 钱包。当前 [vault.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/vault.ts:1) 的网络、身份、业务能力与 [woc.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/woc.ts:1) 的契约全部围绕 BSV；把 BTC ordinals 挂进来会制造“看似支持、实则未接入钱包真值”的假象。

## 硬切换结论

### 一、领域对象硬分层，UI 只做聚合不做并类

最终采用：

```txt
asset.registry
  只放 coin 类资产（现有 p2pkh 等）

token.registry
  只放 fungible token（BSV-21 / STAS 等）

collectible.registry
  只放单件藏品（1Sat Ordinals 等）
```

明确禁止：

1. 把 `token` 注册进 `asset.registry`。
2. 把 `asset` 伪装成 `token` 存进 `token.registry`。
3. 引入一个新的“万物都能放”的 `holding.registry` 作为领域真值。

UI 聚合只发生在 `plugin-assets` 内部的页面视图模型层，不发生在 contracts。

### 二、统一持仓 UI 继续使用 `/assets`

不新增 `/tokens` 页面，不保留两套并行持仓平台。

最终语义：

```txt
/assets
  = 统一持仓页
  = 聚合 asset.registry + token.registry
  = 永远先显示 asset，再显示 token
  = 详情入口仍由各 provider 自己声明
```

排序不变量：

1. `asset` 组永远整体排在 `token` 组前面。
2. 组内先按 provider `order`，再按 provider 名称，再按条目名称。
3. 统一持仓页本身不改变 provider 返回的业务顺序语义，只做最终稳定排序。

### 三、collectible 单独平台，不能硬塞进统一持仓表

最终采用：

```txt
/collectibles
  = collectible 列表
  = collectible 详情
  = item 级操作入口（后续 transfer / inspect / content）
```

原因：

1. `asset/token` 以余额和数量为核心。
2. `collectible` 以单件内容、预览、属性、owner、历史为核心。
3. 把二者硬塞成同一张表，只会让持仓页字段污染、详情页也污染。

### 四、collectible transfer 独立框架，不能复用现有 transfer.registry

最终采用：

```txt
collectible-transfer.registry
  = item 级 handler 注册表

plugin-collectible-transfer
  = collectible transfer 平台壳
  = 路由 /collectibles/transfer
  = 挂载具体 handler widget
```

现有 `transfer.registry` 继续只服务 coin / 现有转账平台，不承载 collectible。

### 五、WOC 仍是唯一外网入口，但按协议拆 capability

最终不把所有 token 协议方法都塞进当前 `WocService` 主接口。

采用：

```txt
plugin-woc
  提供：
    woc.service                  （现有 coin / address / utxo / history / broadcast）
    woc.bsv21.service            （新增）
    woc.stas.service             （新增）
    woc.1satordinals.service     （新增）
```

这样既保持“唯一 WOC 入口”，又避免 `woc.ts` 膨胀成一个巨型杂交接口。

### 六、BTC ordinals 明确不进入本单

本单直接排除 BTC ordinals：

1. 不新增 `btc` 网络进 `vault.ts`。
2. 不新增 `btc` 版 `woc.service` 通用契约。
3. 不新增只读 BTC 观察器插件。
4. 不在任何 UI 上出现“BTC ordinals 已支持”的暗示。

## 不能怎么做

1. 不能把 `plugin-assets` 改成“统一持仓平台”后，再让它直接消费 `collectible.registry`。那会把列表模型重新搞脏。

2. 不能为了复用 UI，就在 contracts 里定义一个同时承载 `coin + token + collectible` 的超级对象。UI 复用只能落在平台内部 view model，不是跨包真值。

3. 不能让 `plugin-token-bsv21`、`plugin-token-stas`、`plugin-collectible-1satordinals` 直接 `fetch("https://api.whatsonchain.com/...")`。必须全部走 `plugin-woc` 暴露的协议 capability。

4. 不能把 collectible transfer 做成“现有 transfer 页面多一个类型分支”。现有 transfer 是 offer/amount 模型，collectible transfer 是 item/widget 模型，语义不同。

5. 不能为了“先跑起来”把 BTC ordinals 当成“手填地址只读能力”偷偷接进当前钱包。那会让产品表面上看似支持 BTC，但 Vault、active key、地址真值、转移语义都没接上。

6. 不能在 phase 1 顺手引入 create token / create collectible 框架。本单边界已经够大，再塞 create 会把 contract、UI、权限模型一起拖脏。

7. 不能把 STAS / BSV-21 / 1Sat 的 provider 都做成“各自一套自定义页面，统一平台只是跳板”。phase 1 允许 provider 有专属详情页，但统一平台必须先有足够的通用展示能力。

## 应该怎么做

### 一、contracts 层新增三套协议

#### 1. `packages/contracts/src/tokens.ts`

定义 fungible token 公共协议。

至少包含：

1. `TokenStatus`
2. `TokenBalance`
3. `TokenSummary`
4. `TokenActivity`
5. `TokenDetail`
6. `TokenProvider`
7. `TokenRegistry`

必须坚持：

1. 不能出现 UTXO、script、rawTx、change、fee 这类 coin 专属字段。
2. `TokenSummary` 的核心是 `symbol/label/balance/status/detailRoute`。
3. provider 自己决定是否暴露 `issuer/decimals/icon/tags`。

#### 2. `packages/contracts/src/collectibles.ts`

定义 collectible 公共协议。

至少包含：

1. `CollectibleStatus`
2. `CollectiblePreview`
3. `CollectibleSummary`
4. `CollectibleActivity`
5. `CollectibleAttribute`
6. `CollectibleDetail`
7. `CollectibleProvider`
8. `CollectibleRegistry`

必须坚持：

1. `CollectibleSummary` 必须围绕单件对象，而不是余额。
2. `preview/media/contentType/collection/ownerRef` 应该是一级字段，不要全塞进 `extras`。
3. `CollectibleDetail` 必须能表达“平台通用详情”，不能要求每个插件都必须自带专属详情页才能工作。

#### 3. `packages/contracts/src/collectibleTransfer.ts`

定义 collectible transfer 框架协议。

至少包含：

1. `CollectibleRef`
2. `CollectibleTransferCapability`
3. `CollectibleTransferWidgetProps`
4. `CollectibleTransferCompletion`
5. `CollectibleTransferRegistry`

选择规则必须写死：

1. 平台按 `supports(ref)` 选 handler。
2. 命中 0 个 handler：展示“当前藏品暂无可用转移处理器”。
3. 命中 1 个 handler：直接挂载。
4. 命中多个 handler：按 `order` 选最小者；若仍冲突则报英文错误，禁止静默随机挑选。

### 二、`plugin-woc` 扩展为协议索引入口

新增以下 contracts 文件与 capability：

1. `packages/contracts/src/wocTokens.ts`
2. `WOC_BSV21_CAPABILITY`
3. `WOC_STAS_CAPABILITY`
4. `WOC_1SAT_ORDINALS_CAPABILITY`

设计要求：

1. 三种 capability 都由 `plugin-woc` 提供。
2. 三种 capability 内部继续共用 `plugin-woc` 的限流、优先级、429 backoff、多标签页协调。
3. token / collectible 插件不允许越过这些 capability 直接碰 URL。

### 三、统一持仓 UI 放在 `plugin-assets`，但只做 view-model 聚合

`plugin-assets` 改成“统一持仓平台”，继续保留：

1. 路由 `/assets`
2. 菜单名“资产”
3. 首页资产 widget

内部新增只在本包存在的 view model：

```txt
HoldingRow
  kind: "asset" | "token"
  groupOrder
  providerId
  itemId
  label
  balanceDisplay
  status
  detailRoute
  badges
```

必须做：

1. 同时读取 `asset.registry` 与 `token.registry`。
2. UI 上让 `asset` 与 `token` 看起来是一套统一持仓列表。
3. 资产组永远在前。
4. provider 失败隔离：一个 token provider 爆掉不能拖死 coin 列表。

不能做：

1. 不能把 `HoldingRow` 暴露到 contracts。
2. 不能让 `plugin-assets` 反向依赖任何具体 token 插件。

### 四、collectible 平台独立

新增 `plugin-collectibles`。

职责：

1. 注册 `/collectibles` 列表页。
2. 注册 `/collectibles/detail` 详情页。
3. 从 `collectible.registry` 聚合项目。
4. 在详情页按是否存在 transferable handler，决定是否出现“转移”入口。

设计要求：

1. 列表默认走 gallery/list 混合布局，不是复刻持仓表。
2. 详情页必须支持：
   - 预览图 / 文本预览
   - 属性表
   - owner / outpoint / inscription id 等 provider 解释字段
   - activity 列表
3. 若 `detailRoute` 缺失，平台通用详情页必须仍可完整工作。

### 五、collectible transfer 平台壳独立

新增 `plugin-collectible-transfer`。

职责：

1. 注册 `/collectibles/transfer`。
2. 解析 `providerId` 与 `collectibleId`。
3. 读取 `collectible.registry` 拿详情。
4. 读取 `collectible-transfer.registry` 选择 handler。
5. 挂载 handler widget。

本平台不解释：

1. ordinals outpoint 怎么选。
2. 单件转移如何构造 raw tx。
3. 手续费、change、脚本细节。

这些都交给具体 handler。

### 六、BSV 协议插件怎么挂

#### `plugin-token-bsv21`

依赖：

1. `token.registry`
2. `woc.bsv21.service`
3. `p2pkh.service`

原因：

1. BSV-21 的所有权仍然基于当前钱包 BSV 地址。
2. 当前系统里这些地址资源由 `p2pkh.service` 管理。

#### `plugin-token-stas`

依赖：

1. `token.registry`
2. `woc.stas.service`
3. `p2pkh.service`

特殊约束：

1. phase 1 只支持主网 STAS。
2. provider 在 `listTokens()` 中只暴露正余额条目；零或负值不进入统一持仓页。

#### `plugin-collectible-1satordinals`

依赖：

1. `collectible.registry`
2. `woc.1satordinals.service`
3. `p2pkh.service`

关键特殊情况：

1. WOC 文档当前没有现成“按地址列出 1Sat 持仓”的统一入口，因此**不能**用地址全量拉取。
2. 必须走：

```txt
当前 active key 的 P2PKH 未花费 UTXO 集合
  -> 对每个 outpoint 调 1Sat 查询
  -> 404 / not-found 视为“这不是 1Sat collectible”
  -> 命中的才进入 collectible 列表
```

3. 这不是退而求其次，而是 phase 1 的正确真值：当前未花费 outpoint 才代表“当前仍持有”。

### 七、特殊情况必须提前钉死

#### 1. token / collectible 插件没有 `p2pkh.service`

处理规则：

1. 这些插件直接在 manifest 里声明依赖 `p2pkh.service`。
2. 若 `plugin-p2pkh` 未启用，则这些插件是 `blocked`，不是“半可用空页面”。

#### 2. 某个 provider 查询失败

处理规则：

1. 统一持仓页与 collectible 页都必须 provider 级隔离失败。
2. 单个 provider 失败只显示局部错误，不阻断其他 provider。

#### 3. collectible 没有可转移 handler

处理规则：

1. 详情页不显示“转移”按钮，或显示 disabled 提示。
2. 用户若手工进入 `/collectibles/transfer`，页面显示空态，不报白屏。

#### 4. 多个 collectible transfer handler 同时支持一件藏品

处理规则：

1. 先按 `order`。
2. `order` 相同仍冲突，直接抛英文错误并记录日志。
3. 不允许默默选第一个注册者。

#### 5. 1Sat outpoint 查询 404

处理规则：

1. 当作“普通 P2PKH UTXO，不是 collectible”。
2. 不能把它记成 provider 错误。

#### 6. 巨大媒体内容

处理规则：

1. 列表页只用预览，不内联完整内容。
2. 详情页默认只展示 preview / metadata / link，不自动下载巨大二进制正文。

## 文件级施工

### 一、workspace 与装配

#### `/tsconfig.json`

新增 project references：

1. `packages/plugin-collectibles`
2. `packages/plugin-collectible-transfer`
3. `packages/plugin-token-bsv21`
4. `packages/plugin-token-stas`
5. `packages/plugin-collectible-1satordinals`

#### `/apps/web/package.json`

新增依赖：

1. `@keymaster/plugin-collectibles`
2. `@keymaster/plugin-collectible-transfer`
3. `@keymaster/plugin-token-bsv21`
4. `@keymaster/plugin-token-stas`
5. `@keymaster/plugin-collectible-1satordinals`

#### `/apps/web/src/bootstrapPlugins.ts`

必须做：

1. 保持静态装配，不做自动发现。
2. 让顺序满足：

```txt
vault
protocol
home
settings
assets
collectibles
collectible-transfer
key-import
transfer
contacts
woc
background
p2pkh
token / collectible business plugins
importers
```

不能做：

1. 不能借本单顺手引入“删目录即自动消失”机制。

### 二、contracts

#### `packages/contracts/src/tokens.ts`

新增文件，定义 token 协议。

#### `packages/contracts/src/collectibles.ts`

新增文件，定义 collectible 协议。

#### `packages/contracts/src/collectibleTransfer.ts`

新增文件，定义 collectible transfer 协议。

#### `packages/contracts/src/wocTokens.ts`

新增文件，定义三类 WOC token/collectible 查询 capability。

#### `packages/contracts/src/index.ts`

新增以上四个文件导出。

明确不能做：

1. 不能修改现有 `assets.ts` 去兼容 token / collectible 的全部语义。
2. 不能让 `tokens.ts` import `assets.ts` 再在上面打补丁式扩展。

### 三、runtime

#### `packages/runtime/src/registries/tokenRegistry.ts`

新增 token registry 实现。

#### `packages/runtime/src/registries/collectibleRegistry.ts`

新增 collectible registry 实现。

#### `packages/runtime/src/registries/collectibleTransferRegistry.ts`

新增 collectible transfer registry 实现。

#### `packages/runtime/src/createPluginHost.ts`

必须做：

1. 创建并暴露：
   - `token.registry`
   - `collectible.registry`
   - `collectible-transfer.registry`
2. owner diff / teardown 回收必须把这三类 registry 纳入追踪。

### 四、plugin-woc

#### `packages/plugin-woc/src/manifest.ts`

新增声明：

1. `woc.bsv21.service`
2. `woc.stas.service`
3. `woc.1satordinals.service`

#### `packages/plugin-woc/src/`

新增实现文件，建议形态：

1. `wocBsv21Service.ts`
2. `wocStasService.ts`
3. `woc1SatOrdinalsService.ts`

要求：

1. 全部内部复用现有 actor / fetch core / priority 模型。
2. 不复制第二套限流队列。

### 五、plugin-assets

#### `packages/plugin-assets/src/manifest.ts`

从“资产平台”升级为“统一持仓平台”。

依赖必须改为：

1. `asset.registry`
2. `token.registry`
3. `route.registry`
4. `menu.registry`
5. `home.registry`

#### `packages/plugin-assets/src/AssetsPage.tsx`

改成统一持仓页。

必须做：

1. 聚合 asset + token。
2. 组排序固定。
3. 页面文案仍叫“资产”。

#### `packages/plugin-assets/src/assetsFlow.ts`

扩成统一 holdings 聚合 flow，或拆出新的 `holdingsFlow.ts`。

#### `packages/plugin-assets/src/AssetDetailPage.tsx`

继续承担通用 holding 详情跳转 / 摘要页职责，但只处理 asset/token，不处理 collectible。

#### `packages/plugin-assets/src/AssetsHomeWidget.tsx`

首页 widget 改为聚合 asset + token 的摘要，而不是只看 asset。

### 六、plugin-collectibles

#### `packages/plugin-collectibles/package.json`

新增包。

#### `packages/plugin-collectibles/src/manifest.ts`

注册：

1. `/collectibles`
2. `/collectibles/detail`
3. 菜单入口
4. 可选首页 widget

#### `packages/plugin-collectibles/src/CollectiblesPage.tsx`

新增 collectible 列表页。

#### `packages/plugin-collectibles/src/CollectibleDetailPage.tsx`

新增 collectible 通用详情页。

### 七、plugin-collectible-transfer

#### `packages/plugin-collectible-transfer/package.json`

新增包。

#### `packages/plugin-collectible-transfer/src/manifest.ts`

注册 `/collectibles/transfer`。

#### `packages/plugin-collectible-transfer/src/CollectibleTransferPage.tsx`

实现 handler 选择、空态、错误态、widget 挂载。

### 八、协议业务插件

#### `packages/plugin-token-bsv21/`

新增包。

至少包含：

1. `manifest.ts`
2. `bsv21TokenProvider.ts`
3. `bsv21Service.ts` 或等价内部服务

#### `packages/plugin-token-stas/`

新增包。

至少包含：

1. `manifest.ts`
2. `stasTokenProvider.ts`
3. `stasService.ts`

#### `packages/plugin-collectible-1satordinals/`

新增包。

至少包含：

1. `manifest.ts`
2. `ordinalsCollectibleProvider.ts`
3. `ordinalsService.ts`

## 最终验收清单

### 一、领域边界验收

1. `asset.registry`、`token.registry`、`collectible.registry` 三套 capability 已存在。
2. `token` 没有注册进 `asset.registry`。
3. `collectible` 没有注册进 `token.registry` 或 `asset.registry`。
4. contracts 中不存在一个同时承担三类对象真值的超级接口。

### 二、统一持仓 UI 验收

1. 应用里只有一个 `/assets` 持仓平台入口，没有并存的 `/tokens` 平台。
2. `/assets` 同时展示 coin 与 fungible token。
3. 所有 coin 行永远排在所有 token 行前面。
4. 单个 token provider 失败不会导致 coin 列表不可见。
5. 单个 asset provider 失败不会导致 token 列表不可见。

### 三、collectible 平台验收

1. `/collectibles` 页面存在。
2. collectible 列表与详情不复用统一持仓表字段模型。
3. 详情页能展示 preview / metadata / activity。
4. 即使 provider 没有专属详情页，通用详情页仍可工作。

### 四、collectible transfer 框架验收

1. `collectible-transfer.registry` capability 存在。
2. `/collectibles/transfer` 页面存在。
3. 没有 handler 时，页面显示可理解空态，不白屏。
4. 多 handler 冲突时按固定规则处理，不随机。
5. 现有 `transfer.registry` 没有被 collectible 语义污染。

### 五、WOC 边界验收

1. token / collectible 插件代码里没有直接 `fetch` WOC URL。
2. BSV-21 / STAS / 1Sat 查询全部经过 `plugin-woc` capability。
3. `plugin-woc` 没有复制第二套独立限流系统。

### 六、协议插件验收

1. `plugin-token-bsv21` 能在 `/assets` 中出现 token 持仓。
2. `plugin-token-stas` 能在 `/assets` 中出现 token 持仓。
3. `plugin-collectible-1satordinals` 能在 `/collectibles` 中出现当前 key 持有的 1Sat 条目。
4. 1Sat 非命中 outpoint 不会被记成 provider 错误。

### 七、明确不做项验收

1. 产品中没有 BTC ordinals 入口。
2. 产品中没有 token transfer 入口。
3. 本单没有引入 create token / create collectible 能力。
4. 本单没有引入插件目录自动发现 / 删除目录即消失能力。

