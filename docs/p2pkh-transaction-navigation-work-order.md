# P2PKH 交易导航硬切换施工单

## 1. 目标

把 P2PKH 钱包中依赖 `tab` 查询参数切换的两个列表，硬切换为两个独立路由和两个左侧业务菜单：

| 页面 | 主网路由 | 测试网路由 | 左侧菜单 |
| --- | --- | --- | --- |
| 当前 Transactions 列表 | `/p2pkh/mainnet/transactions` | `/p2pkh/testnet/transactions` | 链上交易 / On-chain transactions |
| 当前 Coins 列表 | `/p2pkh/mainnet/local-transactions` | `/p2pkh/testnet/local-transactions` | 本地交易 / Local transactions |

本次只改变页面身份、路由和导航，不重新定义两张现有列表的数据口径、字段、状态、排序、分页、加载或操作行为。

## 2. 硬切换约束

1. 不保留旧 URL，不增加 redirect、alias、兼容组件或兼容参数解析。
2. 删除旧列表入口：
   - `/p2pkh`
   - `/p2pkh/mainnet`
   - `/p2pkh/testnet`
   - `/p2pkh/history`
   - `/p2pkh/utxos`
   - `?tab=coins` 与任何 `tab` 驱动的视图选择
3. 删除只为旧列表入口存在的 `P2pkhLegacyRouteRedirect` 及其注册。
4. 项目内所有指向旧列表入口的生产代码必须一次性改到新正式路由；不允许留下“以后迁移”的分支。
5. `/p2pkh/tx/:txid` 是现有交易详情正式路由，不属于本次旧列表兼容入口；允许保留，但从详情返回时必须回到发起详情操作的正式列表及页码。

## 3. 页面行为

### 3.1 链上交易

- 直接承接当前 `WalletTab = "transactions"` 的完整渲染分支。
- 保留当前交易表列、状态、排序、详情、重广播条件、分页和自动补页逻辑。
- 不在本施工单内拆分或过滤当前已合并的 fact/local 行。

### 3.2 本地交易

- 直接承接当前 `WalletTab = "coins"` 的完整渲染分支。
- 保留当前 outpoint、金额、状态、来源、本地提交、花费交易等列。
- 保留当前确认/本地确认、可用/已花费/占用/隔离/保护等同步状态表达及“加载更多”逻辑。
- 不因菜单改名而重写表结构或底层存储模型。

### 3.3 页面内导航

- 删除 Transactions / Coins 页内 tab 导航；视图由正式 pathname 唯一决定。
- 主网/测试网切换必须保持当前页面类别：
  - `mainnet/transactions` ↔ `testnet/transactions`
  - `mainnet/local-transactions` ↔ `testnet/local-transactions`
- 页码继续使用 `?page=N`；不得使用 `tab` 查询参数。
- Testnet 关闭时，两条 testnet 正式路由都不注册；若用户正在 testnet 页面并关闭 Testnet，导航到 `/p2pkh/mainnet/transactions`。这是设置状态收口，不是旧 URL 兼容。

## 4. 左侧菜单与文案

在现有 `assets` 业务域注册两个独立 feature：

1. `链上交易`，入口 `/p2pkh/mainnet/transactions`。
2. `本地交易`，入口 `/p2pkh/mainnet/local-transactions`。

要求：

- 两个菜单各自只在其正式主网/测试网列表范围内激活。
- 详情页若能确定来源列表，只激活对应菜单；不得让两个菜单同时激活。
- 中英文 route、menu、breadcrumb、页面标题/说明均使用现有 i18n 机制。
- 删除只服务于旧 overview/history/utxos/tab 身份且已无引用的文案，避免死资源。

## 5. 生产代码检查范围

至少检查并按实际依赖修改：

- `packages/plugin-p2pkh/src/manifest.ts`
- `packages/plugin-p2pkh/src/pages/P2pkhNetworkRoutes.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhWalletPage.tsx`
- `packages/plugin-p2pkh/src/pages/p2pkhTransactionView.ts`
- `packages/plugin-p2pkh/src/pages/P2pkhTransactionDetailPage.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhLegacyRouteRedirect.tsx`（删除）
- `packages/plugin-p2pkh/src/p2pkhAssetProvider.ts`
- P2PKH 相关测试及所有搜索到的旧路径消费者

不要修改 P2PKH 数据库 schema、同步任务、交易状态机或表格视觉样式。

## 6. 必须补齐的测试

1. 四条正式列表路由注册正确；Testnet 路由仍受 `includeTestnet` 控制。
2. 两个左侧菜单都存在，名称和入口正确，激活范围互斥。
3. `/transactions?page=1` 渲染当前 Transactions 表，不受 `tab` 查询参数影响。
4. `/local-transactions?page=1` 渲染当前 Coins 表，样式、列和状态保持现状。
5. 主网/测试网切换保留页面类别且不生成 `tab` 参数。
6. 两类页面分页只生成正式 pathname 和 `page` 参数。
7. 从交易详情返回到正确的来源列表和页码。
8. route registry 中不存在旧列表路由；代码搜索不存在旧列表路径、legacy redirect 或 `tab=coins` 生产引用。
9. 现有 P2PKH 页面、manifest/registry 及相关 web shell 测试通过。

## 7. 验收命令

按仓库脚本选择最小且完整的命令集，至少包括：

```text
pnpm --filter @keymaster/plugin-p2pkh test
pnpm --filter @keymaster/plugin-p2pkh typecheck
```

若包内没有对应脚本，应运行根级等价 Vitest/TypeScript 命令并记录实际命令。最后执行定向 `rg`，证明生产代码不再引用旧列表 URL 与 `tab=coins`。

## 8. 非目标

- 不调整 Coins/本地交易列表的业务命名争议之外的数据含义。
- 不新增兼容、迁移、重定向或遥测层。
- 不改变交易同步、广播、重广播、余额计算、选币或 Testnet 设置语义。
- 不做额外视觉重构。

## 9. Review 整改项（2026-08-18）

### 9.1 Testnet 详情页关闭收口

关闭 `includeTestnet` 时，“正在 Testnet 页面”的判断必须同时覆盖：

- `/p2pkh/testnet/transactions`
- `/p2pkh/testnet/local-transactions`
- `/p2pkh/tx/:txid?network=test&...`

命中任一形式后都导航到 `/p2pkh/mainnet/transactions`，不得把用户留在已禁用的 Testnet 详情页，也不得让详情返回按钮指向已经注销的 Testnet 列表。

测试必须真实覆盖“先启用 Testnet、把当前地址切到 Testnet 列表或详情、再关闭 Testnet”的事件顺序；不得用初始化 `includeTestnet=false` 时发生的跳转代替动态关闭断言。

### 9.2 详情来源缺省语义统一

详情 URL 的 `source` 缺省或非法时，唯一语义为 `transactions`。以下消费者必须使用同一解析结果：

- 详情返回路径；
- 面包屑来源路径与文案；
- 左侧菜单 active 状态。

因此 `/p2pkh/tx/:txid?network=main&page=1` 必须只激活“链上交易”；明确 `source=local-transactions` 时必须只激活“本地交易”。不得出现两个菜单同时激活或两个菜单都不激活。

优先复用一个纯解析 helper，避免在 navigation、detail 和 breadcrumb 中分别实现不同缺省规则。新增测试至少覆盖：缺省 source、非法 source、明确 transactions、明确 local-transactions。
