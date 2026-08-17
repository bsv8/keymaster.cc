# 001 P2PKH 确认交易事实、供应商插件与本地确认硬切换施工单

## 0. 施工结论

本单一次性把普通 BSV/P2PKH 从“WOC history + WOC UTXO 快照 + WOC 未确认观察”硬切换为下面的最终模型：

```text
选中的 confirmed sync provider
  -> 地址涉及的已确认 txid 列表
  -> 每笔交易的 raw transaction + 最小区块信息
  -> Keymaster 统一解析输入 outpoint 和属于本地址的输出
  -> p2pkh_transactions（唯一确认交易事实）
  -> p2pkh_owned_outpoints（可重建的查询投影）
  -> confirmed history / confirmed coins / chain balance

选中的 broadcast provider
  -> 明确 accepted / already-known
  -> local-confirmed（本地确认）
  -> 本地输入占用 + 本地找零可继续花

任意广播异常
  -> isolated（隔离）
  -> 输入不再参与自动选币
  -> 本地找零不可花

当前有效区块事实
  -> chain-confirmed / conflicted
  -> 覆盖并收敛本地确认层
```

这是一次性硬切换，不分“先接 JungleBus”“再改数据库”“最后改页面”等上线阶段；所有新契约、数据库、Coordinator、同步任务、转账状态机、设置、页面和测试必须在同一个迭代里完成后一起交付。

“不分步骤实施”不等于代码没有依赖顺序。开发时仍按本单第 12 节的顺序施工，但在最终合并点之前不允许任何中间模型进入生产。

## 1. 简述缘由

1. JungleBus 提供的是更接近链本身的统一事实：地址涉及哪些交易，以及每笔交易的原始数据。是否花费由后续交易 input 引用哪个 `(txid, vout)` 决定，不需要供应商再维护一份业务化 UTXO 真值。
2. 当前 P2PKH 被 WOC 的接口形状带成了两套持久化真值：`p2pkh_history` 与 `p2pkh_utxos`。两者可能更新不同步，也让业务层依赖 WOC 的 confirmed/unconfirmed 特有语义。
3. 供应商切换只有建立在 Keymaster 自己的最小统一交易模型上才成立。把 WOC JSON 或 JungleBus JSON直接写库，只会把供应商差异扩散到 DB、同步、选币和 UI。
4. 每次查余额都扫描全部交易在记录增大后不可接受；因此交易表是唯一确认事实，同时维护一个由交易事实事务性派生、可以整表重建的 owned-outpoint 查询投影。
5. 本次明确不做订阅和未确认同步。广播成功后若仍要等待区块才能花找零，钱包会退化为“一笔一确认”。因此增加本地确认层：供应商明确接受广播即在本机生效，区块事实负责最终裁决。
6. timeout、double-spend、供应商错误或远端设备未确认花费都不能证明输入安全。自动超时解锁会制造双花窗口，所以异常输入必须隔离，直到区块事实收敛或用户明确重试。

## 2. 本次范围与非范围

### 2.1 本次必须完成

- 普通 BSV/P2PKH mainnet 与 testnet。
- confirmed sync provider 插件注册表。
- transaction broadcast provider 插件注册表。
- WOC confirmed provider 适配器。
- WOC 普通 BSV broadcast provider 适配器。
- JungleBus confirmed provider 适配器。
- Coordinator 权威的按网络供应商设置。
- 单一 `p2pkh.transactions-sync` 后台任务。
- 统一 raw transaction 解析器。
- 确认交易事实表与 owned-outpoint 查询投影。
- 本地确认交易 DAG、本地找零、输入占用与隔离。
- 普通 BSV 转账连续消费本地确认找零。
- Transactions / Coins 两个统一视图以及余额口径。
- v9 -> 新 schema 的安全硬迁移与完整测试。

### 2.2 本次明确不做

- JungleBus subscription。
- 任何供应商的 mempool/unconfirmed history、unconfirmed UTXO 或交易状态轮询。
- 自动判断“一笔交易已经从所有矿工内存池消失”。
- 自动 TTL 解锁、自动放弃交易、自动构造冲突替代交易。
- BSV-21、STAS、1Sat Ordinals 自身的同步供应商切换。
- BSV-21、STAS、1Sat Ordinals 自身的广播供应商切换。
- 将 JungleBus 伪装成广播供应商；它没有本单使用的广播能力，就不能出现在广播下拉框。
- 多设备 pending journal 同步。本次只在冲突时隔离，不能宣称支持同一私钥多设备 active-active 协调。

### 2.3 其它资产的兼容边界

本次“只处理普通 BSV/P2PKH”必须解释为：

- `plugin-token-bsv21`、`plugin-token-stas`、`plugin-collectible-1satordinals` 的 WOC API、状态机、页面和业务真值不改。
- `p2pkhProtocolSpend.ts` 暂时保留原有 WOC 广播路径；普通 BSV 的 broadcast provider 选择只控制 `p2pkhTransferService.ts`。
- 其它资产读取普通 BSV funding coins 时改为读取新的 confirmed owned-outpoint 投影，但本次不赋予它们消费普通 BSV 本地确认找零的能力。
- 旧 `WocService` 中被其它资产使用的方法不能因为普通 P2PKH 不再使用就删除。

## 3. 硬切换后的真值分层

### 3.1 确认交易事实

`p2pkh_transactions` 是普通 P2PKH 唯一的确认链事实表。

它只接受当前选中 confirmed provider 返回的已确认地址历史和交易详情，不接受：

- WOC confirmed UTXO 快照；
- WOC/JungleBus 未确认数据；
- 广播回执；
- 本地 preview；
- 页面推测；
- 余额反推。

### 3.2 查询投影

`p2pkh_owned_outpoints` 是从 `p2pkh_transactions` 确定性派生的物化索引，不是第二份供应商真值。

它允许直接查询：

- 当前 confirmed 可用 outpoint；
- 已确认花费的 owned outpoint；
- `spentByTxid`；
- confirmed chain balance；
- history 某笔交易对钱包的净变化。

投影损坏时必须能只根据 `p2pkh_transactions + resource address` 全量重建；任何字段若不能从交易事实推导，就不能放进该表冒充链事实。

### 3.3 本地确认覆盖层

`p2pkh_local_transactions`、`p2pkh_local_outpoints` 与 `p2pkh_local_input_claims` 共同构成确认前的本地覆盖层。

本地确认不是区块确认，但它是本机继续转账的操作依据：

- 广播供应商明确 `accepted / already-known` 后，交易进入 `local-confirmed`；
- 该交易花费的输入继续被占用；
- 属于自己的找零进入 `p2pkh_local_outpoints` 并可继续被普通 BSV 转账使用；
- 子交易必须记录父交易 txid，形成可追溯 DAG。

### 3.4 最终裁决

“进入块是真值”指当前选中 confirmed provider 所看到的当前有效链事实，不表示永不重组。

- 同一 txid 入块：本地交易提升为 `chain-confirmed`，本地输出原子晋升为 confirmed owned outpoint，临时 claim 删除。
- 其它 confirmed 交易花了相同输入：本地分支进入 `conflicted`，所有未确认后代及其本地输出失效。
- 已确认交易因重组从一次完整且成功的重叠核对结果中消失：撤销其当前区块状态，重新按本地记录或冲突事实计算。
- 单次请求失败、404、超时或半页结果不能触发回滚；只有完整成功的同步核对可以修改既有区块结论。

## 4. 供应商插件契约

### 4.1 两个独立能力

在 `packages/contracts/src/bsvP2pkhProviders.ts` 新增两个完全独立的 provider 契约：

```ts
interface P2pkhConfirmedDataProvider {
  descriptor: {
    id: string;
    label: string;
    supportedNetworks: BsvNetwork[];
  };

  listAddressConfirmedTransactions(input: {
    network: BsvNetwork;
    address: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<{
    items: Array<{
      txid: string;
      blockHeight?: number;
      blockHash?: string;
      blockTime?: number;
    }>;
    nextCursor?: string;
    exhausted: boolean;
  }>;

  getConfirmedTransaction(input: {
    network: BsvNetwork;
    txid: string;
    signal: AbortSignal;
  }): Promise<{
    txid: string;
    rawTxHex: string;
    blockHeight?: number;
    blockHash?: string;
    blockTime?: number;
  }>;
}

interface P2pkhTransactionBroadcastProvider {
  descriptor: {
    id: string;
    label: string;
    supportedNetworks: BsvNetwork[];
  };

  broadcast(input: {
    network: BsvNetwork;
    canonicalTxid: string;
    rawTxHex: string;
    signal?: AbortSignal;
  }): Promise<{
    status: "accepted" | "already-known";
    canonicalTxid: string;
    providerReference?: string;
    providerCode?: string;
    providerMessage?: string;
  }>;
}
```

provider 原始 JSON 不进入跨包契约、业务 DB 或 UI；adapter 只保留经过长度限制和脱敏的 code/message 供 attempt 诊断，业务状态只能消费归一化字段。

### 4.2 注册表所有权

Coordinator 是两个 provider 注册表、当前选择和执行实例的唯一 owner。

- provider 包导出 worker-safe factory/registration 函数；
- `keymasterSessionCoordinator.worker.ts` 静态导入已安装 provider 模块并注册；
- 页面不持有 provider 实例，不直接 fetch；
- 页面通过 Coordinator RPC 获取 descriptor 列表和当前选择；
- 普通 BSV 广播也必须通过 Coordinator RPC 执行，页面侧 `p2pkhTransferService` 只负责 preview/本地业务调用，不能从 registry 取 provider 后自己发网络请求；
- 同一个插件可以注册一个或两个能力；
- provider id 重复注册必须启动失败，不能后注册覆盖前注册。

本次注册结果固定为：

| provider plugin | confirmed sync | ordinary BSV broadcast |
|---|---:|---:|
| WOC | 是 | 是 |
| JungleBus | 是 | 否 |

### 4.3 不允许交叉调用

- 每次同步任务启动时捕获一个 `syncProviderId + providerSettingsGeneration`。
- 本轮所有 history 与 transaction detail 请求只能进入该 provider。
- 选中 JungleBus 后，普通 P2PKH confirmed sync 不允许“JungleBus 查 txid、WOC 补 transaction info”。
- confirmed provider 与 broadcast provider 是用户显式分开的两个设置，因此“JungleBus 同步 + WOC 广播”是合法组合，不属于暗中交叉取数。
- 选中 provider 缺失、不支持当前网络或初始化失败时，任务进入 blocked；不能 fallback 到 WOC。
- broadcast 同理：选中的广播 provider 不可用时转账提交失败并进入安全状态，不能暗中换另一个广播商。

### 4.4 WOC 适配要求

在 `plugin-woc` 内新增普通 P2PKH provider adapter：

- 把 WOC confirmed address history 归一化成 newest -> oldest 的页；
- 用 WOC raw transaction 接口取得 hex；
- 校验返回 txid、raw transaction 本地计算 txid 和请求 txid一致；
- 只输出 provider contract 的最小字段；
- 普通 P2PKH adapter 内禁止调用 WOC unconfirmed balance、unconfirmed UTXO、unconfirmed history 和 transaction observation；
- broadcast adapter 继续完成 provider 回执 txid 归一化，但只在 canonical txid 匹配并明确接受时返回成功。

旧 `WocService` 继续服务其它资产，普通 P2PKH 新代码不再依赖它的 UTXO/history/unconfirmed 方法。

### 4.5 JungleBus 适配要求

新增 `packages/plugin-junglebus`：

- address endpoint 只负责产出该地址涉及的 confirmed txid 集合；
- transaction endpoint 的 `transaction` 字段按 Base64 原始字节处理，转成小写 hex 后交给统一解析器；不能把 Base64 字符串当 hex；
- 不依赖 JungleBus 返回的 `inputs` 字段；输入必须从 raw transaction 本地解析；
- 若上游返回 oldest -> newest，adapter 必须归一化为 newest -> oldest；
- 若上游没有分页，adapter 可以对单次返回集合建立规范化分页视图，但不得伪造“服务端增量”语义；
- raw tx 计算出的 canonical txid 与请求 txid 不一致时整笔失败，不能写库；
- 不注册 broadcast provider；
- 不实现 subscription、不建立 WebSocket、不存 dashboard subscription id。

## 5. 供应商设置与切换

### 5.1 设置形状

供应商选择按网络保存：

```ts
interface P2pkhNetworkProviderSelection {
  syncProviderId: string | null;
  broadcastProviderId: string | null;
}

interface P2pkhProviderSettings {
  main: P2pkhNetworkProviderSelection;
  test: P2pkhNetworkProviderSelection;
  generation: number;
}
```

首次升级默认：

```text
main.syncProviderId      = "woc"
main.broadcastProviderId = "woc"
test.syncProviderId      = "woc"
test.broadcastProviderId = "woc"
```

这是迁移默认值，不是 fallback。用户明确切换后，provider 缺失必须 blocked。

### 5.2 权威位置

- 设置存入 `keymaster.session-coordinator` 的 meta，而不是 P2PKH 页面 localStorage。
- 更新设置必须先持久化成功，再增加 generation、切换内存选择和广播事件。
- 持久化失败必须返回 error 并保持旧 provider 生效；不能 UI 显示新值、Worker 仍使用旧值。
- Coordinator snapshot/RPC 返回可用 sync providers、可用 broadcast providers、当前网络选择和 generation。

### 5.3 切换动作

切换 sync provider：

1. 增加 provider settings generation。
2. abort 当前 `p2pkh.transactions-sync`。
3. 清除该网络 provider-specific in-progress cursor。
4. 保留 provider-neutral 的 confirmed transaction facts、owned-outpoint 投影和 complete anchor。
5. 从新 provider 最新端重新扫描，直到找到上次完整 head anchor 或到达最早交易。
6. 任何旧 generation 的迟到 commit 全部拒绝。

切换 broadcast provider：

- 不重写旧 local transaction 的 attempt history；
- 新提交和手动重广播使用当前明确选择的 provider；
- 不自动重广播现有隔离交易；
- UI 显示每次 attempt 使用的 provider id。

## 6. 统一交易事实与本地解析

### 6.1 共享解析器

新增 `packages/plugin-p2pkh/src/p2pkhTransactionParser.ts`，所有 confirmed provider 和本地交易都复用它：

```ts
interface ParsedP2pkhTransaction {
  canonicalTxid: string;
  inputs: Array<{
    prevTxid: string;
    prevVout: number;
    outpointKey: string;
  }>;
  outputs: Array<{
    vout: number;
    value: number;
    scriptHex: string;
  }>;
}
```

解析器必须：

- 从 raw bytes 本地计算 txid；
- 正确处理 Bitcoin varint 和 input/output 数量；
- 不信任 provider decoded vin/vout；
- 通过 locking script 与资源地址的 P2PKH script 精确匹配 owned outputs；
- 对越界、截断、超额长度、负值/超过安全整数、末尾残留字节 fail closed；
- 解析失败时不产生部分 transaction row。

允许使用项目已有的 `@bsv/sdk` 做 raw transaction 解码，但必须把它声明为直接依赖并用固定 fixture 测试；不能依赖其它 plugin 的私有 parser。

### 6.2 `p2pkh_transactions`

建议记录：

```ts
interface P2pkhTransactionFact {
  id: string;                       // `${resourceId}:${txid}`
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  rawTxHex: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
  inputOutpointKeys: string[];      // multiEntry query
  inputs: Array<{ txid: string; vout: number; outpointKey: string }>;
  ownedOutpointKeys: string[];      // multiEntry query
  ownedOutputs: Array<{ vout: number; value: number; scriptHex: string }>;
  firstConfirmedAt: string;
  lastConfirmedAt: string;
}
```

建议索引：

- `resourceId`
- `[resourceId, blockHeight]`
- `inputOutpointKeys`（multiEntry）
- `ownedOutpointKeys`（multiEntry）
- `txid`

不得保存 WOC/JungleBus 专属 JSON 作为业务字段。必要的原始响应只能作为受限诊断，不进入事实表。

### 6.3 `p2pkh_owned_outpoints`

建议记录：

```ts
interface P2pkhOwnedOutpointProjection {
  id: string;                       // `${resourceId}:${txid}:${vout}`
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  address: string;
  txid: string;
  vout: number;
  outpointKey: string;
  value: number;
  scriptHex: string;
  chainState: "available" | "spent";
  spentByTxid?: string;
  createdBlockHeight?: number;
  spentBlockHeight?: number;
  updatedAt: string;
}
```

建议索引：

- `[resourceId, chainState]`
- `outpointKey`
- `spentByTxid`
- `[resourceId, createdBlockHeight]`

交易按 newest -> oldest 落库时必须顺序无关：

- 先看到 spender：保存 transaction inputs；若 owned output 尚不存在，不报错。
- 后看到旧 funding tx：创建 owned outpoint 后，用 `inputOutpointKeys` 索引反查已经存在的 spender 并立即标记 spent。
- 先看到 funding tx：创建 available outpoint；以后 spender 落库时直接更新 spent。

交易事实、owned-outpoint 更新、sync checkpoint 必须在同一个 IndexedDB transaction 内提交。

## 7. 单一 confirmed 同步任务

### 7.1 删除旧任务划分

删除：

```text
p2pkh.recent-sync
p2pkh.history-backfill
P2pkhRecentSyncState
P2pkhBackfillState
p2pkh_recent_sync
p2pkh_history_backfill
```

新增唯一任务：

```text
p2pkh.transactions-sync
```

### 7.2 同步方向与停止条件

每个 resource/network：

1. 从 provider 的最新 confirmed 地址交易开始。
2. 页内先规范化为 newest -> oldest。
3. 对未知或需重核对的 txid 拉取 raw transaction。
4. 统一解析并原子写 transaction fact + owned-outpoint projection。
5. 遇到上一次完整成功同步的 `completeHeadTxid` 后，仍处理完该页作为重叠核对窗口，再停止。
6. 如果找不到 anchor，继续到最早交易；不能因为遇到任意一个“库里已存在的 txid”就停止。
7. 首次同步没有 anchor，必须走到最早一条。

### 7.3 checkpoint

`p2pkh_transaction_sync` 至少保存：

```ts
interface P2pkhTransactionSyncState {
  resourceId: string;
  completeHeadTxid?: string;        // provider-neutral，只有完整成功后推进
  inProgressProviderId?: string;
  inProgressProviderGeneration?: number;
  inProgressCursor?: string;        // provider-specific，只供同 provider 续传
  runHeadTxid?: string;
  runId?: string;
  pagesSynced: number;
  transactionsSynced: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}
```

规则：

- tx/page 提交成功后才推进 in-progress cursor。
- 完整到达 anchor 或 earliest 后才推进 `completeHeadTxid = runHeadTxid`。
- partial failure 保留上一个 complete anchor，不把半次同步伪装完成。
- provider switch 丢弃 in-progress cursor/run，保留 complete anchor。
- 同步完整重叠区间后，对上轮位于该区间但本轮没有出现的 confirmed tx 做重组核对；核对未完整时不删除。

### 7.4 请求失败

- history page 失败：终止本轮、保存错误、保留全部既有事实。
- transaction detail 失败或 raw tx/txid 不一致：整页不推进 cursor；已经原子提交的前页保留。
- 429：由 provider adapter 自己按其配置退避，任务显示 rate-limited/failed；不能换 provider。
- abort/provider generation 变化：不记业务失败，迟到写由 generation 栅栏拒绝。
- 一页中某笔交易不合法：不能跳过后继续并推进 cursor，否则会永久形成历史洞。

## 8. 本地确认、隔离和连续转账

### 8.1 状态机

普通 BSV 本地交易统一为：

```text
prepared
  -> submitting
  -> local-confirmed
  -> chain-confirmed

submitting
  -> isolated

local-confirmed / isolated
  -> chain-confirmed            同 txid 入块
  -> conflicted                 其它 tx 花掉相同输入并入块

chain-confirmed
  -> local-confirmed/isolated   区块重组后按原始本地事实恢复
```

删除旧状态词在普通 BSV 路径上的业务意义：

```text
broadcast-pending-woc
woc-observed-unconfirmed
woc-confirmed
woc-dropped
provider-inconsistent（保留为 attempt reason，不再是最终交易状态）
```

### 8.2 广播前原子写

在任何网络调用之前，单个 IndexedDB transaction 必须写入：

- canonical txid；
- raw tx；
- 所有输入 outpoint；
- 属于自己的输出；
- parent txids；
- `submitting` 本地交易；
- 输入 claim；
- 本地输出初始不可用状态。

如果任一输入已经被其它 active claim 占用，整笔事务 abort，不能调用 broadcast provider。

本地确定性校验必须在进入网络调用之前完成。只有明确证明请求尚未离开客户端的本地校验失败，才允许撤销本次新 claim；一旦开始调用 provider，任何异常都按“可能已发送”处理。

provider 是否存在、是否支持当前网络、当前 setting generation 是否仍有效，也必须在写 claim 前完成 preflight。此类本地结构性失败没有越过网络边界，不创建 submission/claim；不能把“没有配置广播商”也变成永久隔离。preflight 通过后再原子写库，并在事务提交后调用已捕获的 provider/generation。

实际网络调用由 Coordinator 的 `p2pkh.broadcast` RPC 承担：

1. 页面/领域 service 完成 preflight，并原子写入 `submitting + claims + local outputs`。
2. RPC 只传 `ownerPublicKeyHex/network/submissionId/expectedProviderGeneration/expectedSessionEpoch`；Coordinator 必须从 owner DB 重读 canonical txid/raw tx/inputs，不能相信页面重复传一份可变 raw tx。
3. Coordinator 再次核对 submission 状态、session epoch、provider generation 与 active provider，然后调用唯一选中的 broadcaster。
4. Coordinator 根据结果原子写 `local-confirmed` 或 `isolated`、attempt 和 local-output state，再返回页面。
5. 即使页面在网络调用中刷新或崩溃，SharedWorker 仍完成状态落库；页面重连后以 DB 为准。

preflight 后、RPC 调用前若 provider generation 已变化，Coordinator 必须在零网络请求的前提下原子撤销这笔仍为 `submitting` 且没有 attempt 的新 submission/claims/local outputs，并返回 `not-dispatched/stale-provider-generation`。不能让一次纯设置竞态制造永久隔离，也不能拿新 provider替旧 generation 暗中提交。

### 8.3 什么算本地确认

只有当前选中 broadcast provider 明确返回：

```text
accepted
already-known
```

并且返回/本地 canonical txid 一致，才进入 `local-confirmed`。

以下情况全部进入 `isolated`，不能成为本地确认：

- timeout；
- AbortError；
- 网络断开；
- 429/5xx；
- 无法解析响应；
- provider txid mismatch；
- rejected / invalid；
- double-spend / mempool-conflict；
- missing-inputs；
- 任意供应商自相矛盾的回执。

本次删除 `isDefinitivelyRejectedError()` 后“4xx/invalid 就释放 claim”的逻辑。供应商拒绝不是全网未接收的证明。

### 8.4 本地输出

新增 `p2pkh_local_outpoints`：

```ts
interface P2pkhLocalOutpoint {
  id: string;
  resourceId: string;
  txid: string;
  vout: number;
  value: number;
  scriptHex: string;
  submissionId: string;
  state: "unavailable" | "available" | "claimed" | "isolated" | "invalidated";
  createdAt: string;
  updatedAt: string;
}
```

- `local-confirmed` 的 own change：`available`。
- `isolated` 交易产生的输出：`unavailable`。
- 后续本地交易消费 change：输出转 `claimed`，并建立 parentTxid。
- 子交易广播异常：它使用的父 change 转 `isolated`，父交易仍保持自己的状态，但该 change 不再可用。
- 同 txid 入块：删除对应 local outpoint，并在同一事务创建/合并 confirmed owned outpoint。只清理由这笔已确认交易消费的输入 claim；若该输出已被未确认子交易 claim，相同 outpoint key 的子 claim 必须继续保留并覆盖新晋升的 confirmed outpoint。
- 分支冲突：所有后代 local outpoint 进入 `invalidated`，永不参与余额和选币。

祖先 raw tx 的回收也必须按 DAG 做：只要还有未 `chain-confirmed/conflicted` 的后代可能需要重广播，就不能删除祖先 raw tx。完成分支可以保留审计元数据；若以后做体积 GC，也必须先证明没有活动后代。

### 8.5 选币集合

普通 BSV 自动选币只能使用：

```text
confirmed owned outpoints where chainState=available
  - active local claims
  - isolated claims
  - protected outpoints

+ local outpoints where state=available
  - active/protected claims
```

不得扫描全部历史计算可用币，也不得把 `chainState=available` 直接等同“本机可花”。

其它资产的 protocol spend 本次只使用 confirmed 部分，不使用普通 BSV local outpoints。

### 8.6 多设备冲突

同一私钥在远端设备产生未确认花费，本地看不到是本次确认数据边界的必然结果。

本地广播收到 double-spend/conflict 时：

- 相关输入进入 `isolated`；
- 停止自动重复创建新交易；
- 不产生可花本地找零；
- UI 显示“可能被其它设备未确认花费，等待区块事实”；
- 远端交易入块后按 confirmed spender 收敛；
- 本地交易入块则按本地 tx 收敛；
- 如果两边都永不入块，隔离可以永久存在，这是预期安全结果。

本次不宣称解决多设备 active-active。真正解决需要设备间 pending journal 或资金分区，另立施工单。

### 8.7 重广播

本次只提供用户触发的“重新广播完整祖先链”：

- 从最早未确认祖先到目标交易按拓扑顺序；
- accepted/already-known 才继续下一笔；
- 任意异常停止本轮，所有 claim 保持；
- 重试使用当前选择的 broadcast provider，并新增 attempt record；
- 不自动后台无限重试；
- 不因重广播失败释放输入；
- 不每次重新签名/生成不同 tx，复用已经持久化的稳定 raw tx。

## 9. 余额与 UI

### 9.1 余额口径

页面必须同时展示：

```text
区块余额
  = confirmed owned outpoints 中 chainState=available 的总额

本地可花余额
  = confirmed available 去掉 claim/isolated/protected
  + local available change

本地确认找零
  = local-confirmed 分支仍有效的 own outputs

待确认占用
  = local-confirmed 交易占用的输入金额

隔离金额
  = isolated claim 对应的可知输入金额
```

默认主数字使用“本地可花余额”；区块余额不能再被 UI 叫作“可用余额”。

### 9.2 页面结构

硬切换为一个 BSV/P2PKH wallet workspace：

```text
/p2pkh
  - Transactions
  - Coins / Outputs
```

顶部共同区域显示：

- main/test 网络筛选；
- 区块余额、本地可花、本地确认找零、待确认占用、隔离金额；
- 当前 sync provider 与 broadcast provider；
- 最后完整同步时间、当前任务状态和错误。

Transactions：

- 交易方向和钱包净变化；
- `local-confirmed / isolated / chain-confirmed / conflicted`；
- block height/time；
- txid；
- 展开后显示 wallet-relevant inputs/outputs、父子关系、广播 attempts；
- 不显示 `source=woc-confirmed` 这类供应商业务字段。

Coins / Outputs：

- outpoint、金额、网络；
- origin：confirmed / local-confirmed；
- availability：available / claimed / isolated / protected / spent / invalidated；
- spentBy 或 pending spender；
- local submission；
- 不显示“WOC 状态”列。

旧 `/p2pkh/history` 与 `/p2pkh/utxos` 只做一次性路由重定向到新 workspace 对应 tab，不保留旧组件与旧查询模型。

### 9.3 设置 UI

P2PKH 设置页新增按网络的：

- 已确认数据供应商；
- 普通 BSV 广播供应商。

选项来自 Coordinator provider registry snapshot。JungleBus 不能出现在 broadcast 列表。

WOC endpoint/rate limit 仍在 WOC provider 自己的设置区；JungleBus endpoint/rate limit 在 JungleBus 自己的设置区。P2PKH 设置页只选择 provider，不复制 provider 私有配置。

但“在 provider 自己的设置区”不等于页面 localStorage 是执行真值。由于实际请求在 SharedWorker，provider 私有配置也必须由 Coordinator/worker-readable IndexedDB 权威持久化并通过 RPC 更新；页面只显示与编辑 snapshot。旧 WOC localStorage 配置需要一次性导入或明确废弃为默认值，不能出现页面显示一个 endpoint、Worker 实际使用另一个 endpoint。

## 10. 数据库 v10 硬迁移

### 10.1 新 schema

`P2PKH_DB_VERSION` 从 9 升到 10。最终 stores：

```text
p2pkh_addresses
p2pkh_transactions
p2pkh_owned_outpoints
p2pkh_transaction_sync
p2pkh_local_transactions
p2pkh_local_outpoints
p2pkh_local_input_claims
p2pkh_protocol_submissions       # 其它资产兼容，暂保留
```

删除：

```text
p2pkh_utxos
p2pkh_history
p2pkh_history_backfill
p2pkh_recent_sync
p2pkh_local_submissions
```

### 10.2 迁移原则

这是硬切换，但不能沿用当前“版本不匹配就删光所有 `p2pkh_*` stores”的实现，因为那会把可能已经广播的交易和输入 claim 一起抹掉并重新开放双花。

v9 -> v10 upgrade 必须在一个 upgrade transaction 中：

1. 读取并暂存 `p2pkh_addresses`。
2. 读取旧 `p2pkh_local_submissions`、`p2pkh_local_input_claims`、`p2pkh_protocol_submissions`。
3. 删除旧 provider-derived `p2pkh_utxos/history/recent/backfill`。
4. 创建 v10 stores/indexes。
5. 恢复 addresses。
6. 能解析 raw tx 的旧普通提交迁入 `p2pkh_local_transactions`，统一标为 `isolated`/`legacy-migration`；不能因旧 WOC 状态自动产生可花 local outpoint。
7. 旧 active claims 保守保留；不能自动释放。
8. protocol submissions 原样保留，确保其它资产未完成流程不被本单清空。
9. 新 confirmed facts、owned projection 和 sync checkpoint 留空，解锁后由选中 provider 全量重建。

若旧 submission 缺 raw tx、inputs 或 canonical txid：

- 保留能识别的 input claims 为隔离；
- 建立不完整的 migration audit record；
- 不创建可花本地输出；
- UI 提示人工检查；
- 不能猜测它“肯定失败”并释放。

若 upgrade 读取/写入失败：

- 整个 upgrade transaction abort，旧 v9 DB 保持；
- P2PKH fail closed，不执行选币和广播；
- 显示可诊断错误；
- 不能 fallback 到“删库重建”。

`oldVersion > 10` 也不能再自动 deleteDatabase，因为其中可能有未完成本地交易；应抛 VersionError 并阻断，等待兼容版本。

### 10.3 收尾删除

完整迁移和首次 confirmed sync 后：

- 旧 provider cache 不保留 alias；
- 旧 TypeScript 类型、service 方法和页面 resource id 删除；
- 不双写 v9/v10；
- 不保留“出问题切回旧 WOC UTXO 快照”的代码开关。

## 11. 不能怎么做

1. 不能先保留 `p2pkh_utxos` 当 WOC 真值，再旁边新增 transaction facts；这会继续存在双真值。
2. 不能把 `p2pkh_owned_outpoints` 叫成“供应商 UTXO 表”或直接用 WOC UTXO API覆盖它；它只能由本地交易事实派生。
3. 不能每次算余额扫描全部 raw transaction；必须查询 owned-outpoint availability 索引。
4. 不能只用交易输出判断 spent；必须处理后续 input 对 `(txid, vout)` 的引用。
5. 不能依赖交易同步顺序；spender 先到、funding 后到必须得到同一结果。
6. 不能选 JungleBus 后又调用 WOC 补 confirmed tx info。
7. 不能 provider 请求失败时静默 fallback。
8. 不能让 provider adapter 返回自己的 JSON 给 P2PKH service/UI。
9. 不能把 JungleBus Base64 raw transaction 当 hex，也不能依赖其未使用的 inputs 字段。
10. 不能继续运行 recent-sync 与 history-backfill；最终只能有一个 confirmed transaction sync task。
11. 不能用未确认 history、未确认 UTXO、subscription 或 mempool 查询偷偷改变普通 P2PKH 状态。
12. 不能把“请求已发出”叫本地确认；必须收到明确 accepted/already-known 且 canonical txid 一致。
13. 不能因为 provider 返回 4xx/invalid/double-spend 就自动释放输入。
14. 不能设置 TTL、missing count 或固定区块数自动解锁 isolated claim。
15. 不能让 isolated 交易产生的找零进入选币池。
16. 不能在子交易广播前忘记持久化父交易 raw tx 和 parentTxids。
17. 不能自动重签和制造一串不同的冲突交易；重广播复用稳定 raw tx。
18. 不能在 v10 upgrade 中删掉 local claims/submissions 后靠重新同步“恢复”；未确认事实无法从 confirmed provider 恢复。
19. 不能顺带修改 BSV-21、STAS、1Sat 的供应商真值和页面语义。
20. 不能在 History/UTXO 页面继续显示 WOC/JungleBus 特有 source/status 文案。

## 12. 一次性施工顺序

以下是同一次迭代内部的依赖顺序，不是分批发布方案：

1. 定义 provider、Coordinator RPC、交易事实、本地确认状态契约。
2. 实现统一 raw transaction parser 与固定 fixtures。
3. 实现 WOC/JungleBus adapters 和两个 registry。
4. 完成 v10 schema 与 v9 安全迁移。
5. 实现 order-independent transaction ingest 与 owned-outpoint projection。
6. 将 recent/backfill 合并为唯一 transactions-sync。
7. 把普通 BSV transfer/allocator 改为 confirmed projection + local overlay。
8. 将 provider 设置收口到 Coordinator，并接通任务 abort/generation 栅栏。
9. 重做 P2PKH workspace、settings、余额 widget 和文案。
10. 更新装配、边界扫描、全部测试与 E2E fixture。
11. 执行最终残留扫描和全仓验收；未全部通过不得合并。

## 13. 文件级施工单

### A. 新增跨包契约与 Coordinator RPC

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/contracts/src/bsvP2pkhProviders.ts` | 新增 | 定义 confirmed provider、broadcast provider、descriptor、registry、provider settings、归一化 success/error 和 capability key。契约不得引用 WOC/JungleBus wire 类型。 |
| `packages/contracts/src/sessionCoordinator.ts` | 修改 | 新增 `p2pkh.providers.get/update`、`p2pkh.provider-config.get/update`、`p2pkh.broadcast`、`p2pkh.rebroadcast-ancestors`；定义可用 provider snapshot、当前按网络选择和 generation；新增 `p2pkh.providers` topic 或纳入明确 baseline，不能靠页面轮询 localStorage。广播 RPC 只传 submission 引用，Worker 从 DB 读取 raw tx。 |
| `packages/contracts/src/assets.ts` | 修改（如现有 invalidation kinds 不足） | 为 transaction/local-output/provider-settings 增加精确 invalidation kind；不要用 `utxo` 一个词继续混合 confirmed projection 与 local overlay。 |
| `packages/contracts/src/index.ts` | 修改 | 导出新 provider 契约。 |

### B. WOC 普通 P2PKH adapters

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/plugin-woc/src/p2pkhProviders.ts` | 新增 | 实现 WOC confirmed history/raw tx provider 与普通 BSV broadcaster；所有返回归一化，校验 canonical txid。 |
| `packages/plugin-woc/src/wocActor.ts` | 修改 | 增加 raw transaction 请求能力；保留其它资产旧 endpoint。普通 P2PKH confirmed adapter 不调用 unconfirmed endpoints。 |
| `packages/plugin-woc/src/wocMessages.ts` | 修改 | 增加 raw tx/confirmed tx info actor message；payload 只含 network/txid/options。 |
| `packages/plugin-woc/src/wocService.ts` | 修改 | 必要时暴露 adapter 内部所需 worker-safe调用；旧 WocService 对其它资产保持兼容。 |
| `packages/plugin-woc/src/wocSettings.ts` | 修改 | WOC provider 私有配置改为 worker-readable 权威持久化/Coordinator RPC；处理旧 localStorage 一次性导入或明确默认化，页面与 Worker 不得出现双配置。 |
| `packages/plugin-woc/src/pages/WocSettingsPage.tsx` | 修改 | 改读/写 Coordinator provider config snapshot，不把页面 localStorage 当执行真值。 |
| `packages/plugin-woc/src/coordinator.ts` | 修改 | 导出 `registerWocP2pkhProviders` 或对应 factory，供 SharedWorker 注册两个能力。 |
| `packages/plugin-woc/src/index.ts` | 修改 | 导出 descriptor/manifest 所需信息，不向业务页面暴露 wire client。 |
| `packages/plugin-woc/src/wocService.test.ts` | 修改 | 覆盖 raw tx、history 规范化、accepted/already-known、mismatch、reject/timeout 不被伪装成功。 |
| `packages/plugin-woc/src/p2pkhProviders.test.ts` | 新增 | provider contract conformance；断言普通 confirmed adapter 零 unconfirmed 请求。 |

### C. JungleBus provider plugin

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/plugin-junglebus/package.json` | 新增 | 新 workspace package；声明 contracts/runtime/ui 等实际直接依赖和 coordinator export。 |
| `packages/plugin-junglebus/tsconfig.json` | 新增 | 接入 monorepo TS build。 |
| `packages/plugin-junglebus/src/jungleBusClient.ts` | 新增 | worker-safe HTTP、超时、AbortSignal、限流/429退避；配置由 Coordinator 注入，不直接读页面 localStorage；不使用 DOM。 |
| `packages/plugin-junglebus/src/p2pkhConfirmedProvider.ts` | 新增 | 地址 txid + raw transaction 适配，Base64 -> hex、newest-first、canonical txid 校验；只注册 confirmed 能力。 |
| `packages/plugin-junglebus/src/coordinator.ts` | 新增 | 导出 provider registration/factory。 |
| `packages/plugin-junglebus/src/manifest.ts` | 新增 | provider 私有设置页/i18n/插件描述；不声明 broadcast capability。 |
| `packages/plugin-junglebus/src/pages/JungleBusSettingsPage.tsx` | 新增 | 通过 Coordinator provider-config RPC 编辑 endpoint、限流和查看队列状态；不加入 subscription 配置。 |
| `packages/plugin-junglebus/src/index.ts` | 新增 | 导出 manifest。 |
| `packages/plugin-junglebus/src/p2pkhConfirmedProvider.test.ts` | 新增 | 覆盖用户示例形状、Base64、oldest->newest 归一化、空历史、非法 raw、txid mismatch、Abort/429。 |

### D. P2PKH 领域模型与 DB

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/plugin-p2pkh/src/p2pkhContracts.ts` | 重写相关类型 | 删除 UTXO/history/recent/backfill/WOC observation 语义；新增 transaction fact、owned projection、sync checkpoint、local transaction DAG、local outpoint、attempt、余额分项和统一 query models。协议 spend 兼容类型单独保留。 |
| `packages/plugin-p2pkh/src/p2pkhTransactionParser.ts` | 新增 | 唯一 raw tx parser、txid 校验、input/output 最小投影、owned script 匹配。 |
| `packages/plugin-p2pkh/src/p2pkhTransactionParser.test.ts` | 新增 | 固定 main/test 交易 fixture、varint、多输入输出、截断/畸形、txid mismatch、owned output 匹配。 |
| `packages/plugin-p2pkh/src/p2pkhProviderRegistry.ts` | 新增 | 两个内存 registry 实现；重复 id 拒绝、network capability 过滤、无选择 fail closed。实例仅在 Coordinator 使用。 |
| `packages/plugin-p2pkh/src/p2pkhDb.ts` | 重大重写 | DB v10；安全迁移 v9 本地记录；建立新 stores/indexes；实现原子 ingest、order-independent spender linking、projection rebuild、checkpoint、pending DAG、promotion/conflict cascade。删除版本不符即删整库。 |
| `packages/plugin-p2pkh/src/p2pkhDb.test.ts` | 重写/扩展 | v9->v10 保留 claims/submissions/protocol；旧 provider cache 被清；失败 rollback；spender/funding 两种顺序一致；索引查询；projection rebuild；oldVersion>10 fail closed。 |
| `packages/plugin-p2pkh/src/p2pkhTransactionSync.ts` | 新增 | 唯一 newest->oldest 同步、anchor/overlap/cursor、provider generation、完整核对和 reorg 收敛。 |
| `packages/plugin-p2pkh/src/p2pkhTransactionSync.test.ts` | 新增 | 首次全量、增量到 anchor、anchor 丢失、partial resume、provider switch、late commit、重复 txid、非法详情、reorg、无 fallback。 |
| `packages/plugin-p2pkh/src/p2pkhRecentSync.ts` | 删除 | 不保留 compatibility wrapper。 |
| `packages/plugin-p2pkh/src/p2pkhRecentSync.test.ts` | 删除 | 用 transaction sync tests 替代。 |
| `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts` | 删除 | 不保留旧 backfill。 |
| `packages/plugin-p2pkh/src/p2pkhSyncCoordinator.ts` | 删除或收缩重命名 | recent/backfill 仲裁退场；必要的 generation/DB atomic guard 并入 transaction sync/DB。 |
| `packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts` | 删除/替换 | 对应行为进入 transaction sync tests。 |
| `packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.ts` | 重写 | 只导出 `p2pkh.transactions-sync` handler；依赖 selected confirmed registry，不依赖 WocService。 |
| `packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.test.ts` | 重写 | 无 window 环境、单任务、provider selection、abort/generation、data changed kinds。 |
| `packages/plugin-p2pkh/src/coordinator.ts` | 修改 | 导出新 task、registry、DB 能力给 Worker。 |

### E. 普通 BSV 选币、转账与本地确认

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/plugin-p2pkh/src/utxoAllocator.ts` | 重写输入模型 | 从 confirmed projection + local available outpoint 分配；排除 claim/isolated/protected；不接收 WOC `isSpentInMempoolTx`。类型可重命名 coin allocator。 |
| `packages/plugin-p2pkh/src/utxoAllocator.test.ts` | 重写/扩展 | confirmed、本地找零、父子连续花费、isolated、protected、并发 claim、余额不足。 |
| `packages/plugin-p2pkh/src/p2pkhTransferService.ts` | 重大重写 | 注入 Coordinator broadcast facade 而不是 provider registry；preflight 后广播前原子保存；由 Worker RPC 读 submission 并执行 provider；accepted -> local-confirmed；所有已越过网络边界的异常 -> isolated；删除明确拒绝释放；保存 attempts/parents/local outputs；实现祖先链手动重广播调用。 |
| `packages/plugin-p2pkh/src/p2pkhTransferService.test.ts` | 重写/扩展 | accepted/already-known、本地找零二次消费、timeout/reject/double-spend/mismatch 全隔离、无自动释放、provider switch、新广播 attempt、父链重广播中断。 |
| `packages/plugin-p2pkh/src/p2pkhTransferServiceNotifier.test.ts` | 修改 | transaction/local-output/claim/coin invalidation 精确。 |
| `packages/plugin-p2pkh/src/p2pkhTransferServiceSessionOwner.test.ts` | 修改 | owner/network/provider selection 隔离，切 key/epoch 后迟到广播不能写。 |
| `packages/plugin-p2pkh/src/p2pkhService.ts` | 重大重写 | 查询 transaction/coins/balance breakdown；allocator 接新投影；普通 transfer 接 Coordinator broadcast facade/provider snapshot；删除 recent/backfill、WOC UTXO/history read facade。 |
| `packages/plugin-p2pkh/src/p2pkhService.test.ts` | 重写/扩展 | 余额五口径、indexed query、provider unavailable blocked、testnet 过滤、local overlay。 |
| `packages/plugin-p2pkh/src/p2pkhProtocolSpend.ts` | 最小兼容修改 | 继续使用旧 WOC 广播，不接普通 BSV provider setting；适配新 confirmed coin 类型/claim 排除规则，不消费普通 BSV local change。 |
| `packages/plugin-p2pkh/src/p2pkhProtocolSpend.test.ts` | 修改 | 证明其它资产协议 spend 没被切到 JungleBus/普通 broadcast setting；v10 claims 仍安全。 |
| `packages/plugin-p2pkh/src/p2pkhAssetProvider.ts` | 修改 | balance/activities 改读新统一模型，不暴露 provider source。 |
| `packages/plugin-p2pkh/src/p2pkhTransferProvider.ts` | 修改 | 新状态映射为本地确认/隔离/区块确认/冲突。 |

### F. Coordinator 权威设置与任务装配

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 重大修改 | 注册 WOC/JungleBus provider factories；持久化按网络选择/config/generation；实现 provider RPC/topic 和 DB-backed broadcast/rebroadcast；只注册一个 P2PKH sync task；切换 abort/清 cursor/重跑；late commit 栅栏；其它资产 WOC task 保持原装配。严禁记录完整 raw tx。 |
| `apps/web/src/keymasterSessionCoordinator.worker.test.ts` | 扩展 | registry 列表、JungleBus 无 broadcast、默认 WOC、切换持久化、持久化失败 rollback、无 fallback、旧任务消失、单任务、旧 generation 迟到写拒绝、页面断线后广播结果仍落库、stale generation 零网络并安全撤销新 claim。 |
| `apps/web/src/keymasterSessionCoordinatorClient.ts` | 修改 | 增加 provider snapshot/config get/update、broadcast/rebroadcast facade 与 topic 重连 baseline。 |
| `apps/web/src/keymasterSessionCoordinatorClient.test.ts` | 扩展 | provider/broadcast RPC transport、断线重连快照、更新 ack/error、旧 epoch；断言 RPC 不由页面选择/携带 provider 实例。 |
| `packages/plugin-background/src/BackgroundSettingsPage.tsx` | 修改（如展示任务名） | 删除 recent/backfill 文案，显示单一 transactions sync；不在此页复制 provider 选择。 |
| `packages/plugin-background/src/backgroundServiceCoordinator.test.ts` | 修改 | 新 task id 的 runNow/cancel/snapshot。 |

### G. P2PKH UI、资源和路由

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `packages/plugin-p2pkh/src/pages/P2pkhWalletPage.tsx` | 新增/替换 Overview | 统一顶部余额/provider/sync 状态；Transactions 与 Coins tabs；展开详情、attempt/父子关系、隔离说明、重广播入口。 |
| `packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx` | 删除 | 旧路由仅重定向，不保留旧表格。 |
| `packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx` | 删除 | 旧路由仅重定向，不保留 WOC UTXO 页面。 |
| `packages/plugin-p2pkh/src/pages/P2pkhLegacyRouteRedirect.tsx` | 新增 | `/p2pkh/history` -> transactions；`/p2pkh/utxos` -> coins；使用内部 navigation，不整页 reload。 |
| `packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx` | 修改 | 按 main/test 展示两个 provider select；选项来自 Coordinator；provider 私有参数仍各自设置页。 |
| `packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx` | 删除或改为薄别名后最终删除 | 最终只保留一个 wallet workspace 实现，不能两个页面模型并存。 |
| `packages/plugin-p2pkh/src/P2pkhOverviewPage.test.tsx` | 重命名/重写 | 新 workspace tabs、余额、provider、状态、旧路由跳转、隔离与 conflict 展示。 |
| `packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx` | 修改 | 主数字改本地可花；辅助显示区块余额/隔离；删除 WOC stale 文案。 |
| `packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.test.tsx` | 修改 | 新余额口径与同步失败保留值。 |
| `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx` | 修改 | 结果文案使用本地确认/隔离；错误不再说“未写 claim”；隔离提供查看/重广播入口。 |
| `packages/plugin-p2pkh/src/manifest.ts` | 重大修改 | 新 i18n、resource queries、单任务文案、统一路由/面包屑、Coordinator provider/broadcast facade 依赖；删除 `WOC_CAPABILITY` 作为普通 P2PKH 依赖，并删除 WOC source/history/UTXO/recent/backfill 文案与 resource。 |
| `packages/plugin-p2pkh/src/styles.css`（若不存在则新增并从 manifest 引入） | 修改/新增 | wallet tabs、余额摘要、状态标识、展开交易/coins；沿用现有 UI tokens，不写 provider 专属色。 |
| `packages/plugin-p2pkh/src/index.ts` | 修改 | 导出最终页面/契约，删除旧 sync exports。 |

### H. Web 装配、workspace 与边界检查

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `apps/web/src/pluginCatalog.ts` | 修改 | 加入 JungleBus manifest，顺序满足 settings/registry；WOC 保持给其它资产。 |
| `apps/web/package.json` | 修改 | 增加 `@keymaster/plugin-junglebus`。 |
| `tsconfig.json` | 修改 | 增加 plugin-junglebus project reference。 |
| `pnpm-lock.yaml` | 机械更新 | workspace link 和直接依赖更新；使用 pnpm 正常生成，不手改内容。 |
| `packages/plugin-p2pkh/package.json` | 修改 | 若 parser 使用 `@bsv/sdk`，增加直接依赖；不得依赖 plugin-woc/plugin-junglebus。 |
| `scripts/check-boundaries.mjs` | 修改 | 禁止 P2PKH 直接引用 WOC/JungleBus URL或 import provider plugin；禁止 JungleBus import P2PKH 内部类型；允许 Coordinator 装配层导入 provider factories；扫描普通 P2PKH unconfirmed 调用残留。 |
| `apps/web/src/bootstrapPlugins.test.ts` | 修改 | catalog/依赖装配包含 JungleBus，禁用/缺 provider 的 UI 与 Worker 结果一致。 |
| `e2e/*`（按现有测试组织选择文件） | 新增/修改 | fake WOC/JungleBus 切换、同一事实结果、普通转账本地确认、连续花找零、隔离、刷新后 claim 仍在。 |

### I. 文档

| 文件 | 操作 | 必做内容 |
|---|---|---|
| `docs/architecture/code-architecture.md` | 修改 | 增加 P2PKH provider registry、confirmed fact/projection/local overlay、Coordinator 设置与真值图。 |
| `docs/architecture/project-structure.md` | 修改 | 增加 plugin-junglebus 与 provider 模块职责。 |
| `README.md` 或用户文档实际入口 | 修改 | 说明普通 BSV provider 可选、本地确认与隔离含义；不宣传 mempool 同步。 |

## 14. 特殊情况预案

| 情况 | 必须处理 |
|---|---|
| 选中 provider 插件缺失/禁用 | 设置保留原 id，任务/广播 blocked，UI 明示；不 fallback。 |
| provider 只支持 main 或 test | 不出现在不支持网络的下拉框；已有非法选择 blocked。 |
| 同步过程中切 provider | abort 旧任务、generation++、清 provider cursor；旧响应不得写库，新 provider 从最新开始。 |
| JungleBus 返回空历史 | 完整成功且地址确实为空时记录 successful empty；若本地已有 anchor/事实，进入核对而不是立刻清库。 |
| provider history 有重复 txid | 页内与跨页按 txid 去重，但 cursor 正常推进；不同 block metadata 冲突则本轮失败。 |
| raw tx txid mismatch/解析失败 | 整页不推进，保留上次完整事实，显示 provider inconsistency。 |
| spender 比 funding 先同步 | 通过 transaction input index 反向补链，最终 outpoint=spent。 |
| 同步半途断网/429 | 已提交页保留，complete anchor 不推进；同 provider 从 cursor 续传。 |
| anchor 在新 provider 找不到 | 扫到最早；只有完整成功后才能重建/核对，不以某个任意已知 tx 停止。 |
| 一确认后发生 reorg | 完整重叠核对撤销旧区块结论；若有本地 raw/accepted 记录则恢复本地层，否则标记 chain-orphaned 等待后续事实。 |
| 广播 accepted 但写 DB 失败 | 因广播前已经原子保存 submitting+claims，保持隔离/unknown；绝不能释放。 |
| 广播 timeout/5xx/响应损坏 | transaction=isolated，inputs 隔离，outputs unavailable；不自动重试。 |
| 广播返回 invalid/double-spend | 同上；provider error 只做 attempt 诊断。 |
| 同一私钥远端未确认花费 | 本地冲突输入隔离，等待任一分支入块；可能永久隔离。 |
| 本地确认父交易后立即花找零 | 允许；子交易保存 parentTxid，广播/重广播必须能取得完整祖先 raw tx。 |
| 子交易广播失败 | 子输入（包括父找零）隔离，子输出不可用；不回滚父交易的 accepted 事实。 |
| 父交易被链上冲突覆盖 | 父及所有后代 conflicted/invalidated，本地输出全部退出余额；chain spender 为真值。 |
| 本地交易自己入块 | 原子 promotion，删除临时 claims/local outpoints，保留 transaction audit。 |
| v9 存在未知旧 submission | 迁为 legacy-isolated，保留 claims，无本地可花输出。 |
| v10 migration 失败/blocked | P2PKH fail closed，旧 DB 不删；提示关闭其它 tab/升级错误，不退回旧业务代码。 |
| provider 设置持久化失败 | 保持旧选择和旧 generation，返回错误；UI 回滚显示。 |
| 广播 provider 未选择/不支持网络 | preflight 直接 blocked，不写 claim、不调用网络；不得 fallback。 |
| Worker 重启 | provider 选择从 Coordinator meta 恢复；local DAG/claims 从 owner DB 恢复；不依赖内存恢复。 |
| testnet 被关闭 | 停止 test resource sync/展示，但不清事实、pending、claims；再次开启按原 provider 同步。 |

## 15. 最终验收清单

### 15.1 架构与残留扫描

- [ ] 普通 P2PKH 生产代码不再调用 confirmed/unconfirmed WOC UTXO、balance、unconfirmed history、transaction observation。
- [ ] 生产任务只有 `p2pkh.transactions-sync`；不存在 `p2pkh.recent-sync` 和 `p2pkh.history-backfill` 注册。
- [ ] `p2pkh_utxos`、`p2pkh_history`、`p2pkh_recent_sync`、`p2pkh_history_backfill` 不在 v10 schema。
- [ ] P2PKH service 不 import `@keymaster/plugin-woc` 或 `@keymaster/plugin-junglebus`。
- [ ] JungleBus provider 不注册 broadcast capability、不包含 subscription/WebSocket 代码。
- [ ] 所有 provider 结果在 adapter 边界归一化，DB/UI 无 WOC/JungleBus wire 字段。
- [ ] 选中 provider 失败时没有自动 fallback 代码或测试 fixture。

### 15.2 同步与数据正确性

- [ ] WOC 与 JungleBus 对同一测试地址同步后，transaction txid/input/owned output/available coin 结果一致。
- [ ] 首次同步走到最早交易；后续从最新走到完整 anchor 并处理重叠页。
- [ ] partial failure 不推进 complete anchor，不清已有事实。
- [ ] provider switch 清 cursor、保留事实、旧 generation 迟到 commit 被拒绝。
- [ ] spender-first 与 funding-first 两种导入顺序产出完全相同投影。
- [ ] raw tx mismatch、Base64 误码、非法交易不会产生部分记录或历史洞。
- [ ] confirmed reorg/冲突只能由一次完整成功核对收敛，单次请求失败不回滚。
- [ ] 余额和 coin list 使用索引查询，不随全部历史条数线性扫描。
- [ ] owned projection 可以由 transaction facts 全量重建并字节级/字段级一致。

### 15.3 转账、本地确认与隔离

- [ ] 广播前 submission + inputs + local outputs 在单一事务落库；并发撞 input 时只有一笔能进入网络调用。
- [ ] accepted/already-known 且 txid 一致才进入 local-confirmed。
- [ ] local-confirmed change 可以立即完成第二次普通 BSV 转账，不等待区块。
- [ ] timeout、429、5xx、invalid、double-spend、missing-inputs、mismatch 全部隔离且不释放输入。
- [ ] 不存在 TTL、missing count、定时任务自动释放隔离输入。
- [ ] isolated 输出不进入 local spendable balance 与选币。
- [ ] 手动祖先链重广播按拓扑顺序、复用 raw tx，任意异常停止且 claims 保留。
- [ ] 同 txid 入块后正确 promotion/清理临时行；竞争 tx 入块后整条后代分支 invalidated。
- [ ] 父交易先确认、子交易仍未确认时，父找零晋升 confirmed，但子交易对该 outpoint 的 claim 不丢失。
- [ ] 页面刷新、Worker 重启、切 key 后本地 claims/DAG 不丢失。
- [ ] 远端设备 conflict 场景不会无限自动造新交易，也不会误解锁。

### 15.4 数据迁移

- [ ] v9 provider-derived UTXO/history/recent/backfill 被删除并从 selected provider 重建。
- [ ] v9 local submissions/claims/protocol submissions 不被整库删除。
- [ ] 旧未知提交迁为隔离，不产生可花本地找零。
- [ ] migration 任意异常导致 upgrade transaction rollback 与 P2PKH fail closed。
- [ ] `oldVersion > 10` 不再自动 deleteDatabase。
- [ ] 不存在 v9/v10 双写、旧 store alias 或旧快照 fallback。

### 15.5 设置与 UI

- [ ] main/test 分别可选 confirmed provider 与 ordinary BSV broadcast provider。
- [ ] provider 选项来自 Coordinator registry；JungleBus 不出现在 broadcast 下拉框。
- [ ] 设置持久化失败时 UI 与 Worker 都保持旧选择。
- [ ] `/p2pkh` 只有 Transactions 与 Coins/Outputs 两个主视图。
- [ ] 旧 history/utxos 路由内部重定向，不整页刷新。
- [ ] 顶部同时显示区块余额、本地可花、本地确认找零、待确认占用、隔离金额。
- [ ] Transactions/Coins 不显示 WOC source/WOC status 等供应商耦合列。
- [ ] local-confirmed、isolated、chain-confirmed、conflicted 文案中英文完整。
- [ ] 同步/provider blocked/error 有明确可诊断提示，失败不清空旧数据。

### 15.6 非范围回归

- [ ] BSV-21、STAS、1Sat 自身 WOC 同步测试不变且通过。
- [ ] `p2pkhProtocolSpend` 仍走原有 WOC 广播，不受普通 BSV provider 下拉框切换影响。
- [ ] 其它资产只能读取新的 confirmed funding coin 投影，不会误用普通 BSV local pending change。
- [ ] protected outpoint 规则继续生效，普通选币不能吃 token/ordinal outpoint。

### 15.7 自动化命令

- [ ] `pnpm typecheck`
- [ ] `pnpm lint:boundaries`
- [ ] `pnpm lint:react-boundaries`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] 相关 Playwright E2E（WOC/JungleBus fake、provider switch、本地连续转账、隔离恢复）
- [ ] 浏览器手工 smoke：main/test、切 provider、刷新/重启 Worker、两个 tab 并发 submit、远端 conflict 模拟。

## 16. 完成定义

只有同时满足以下条件，本单才算完成：

1. 普通 P2PKH 的 confirmed 数据只来自用户当前明确选择的一个 provider。
2. WOC 与 JungleBus 只在 adapter 内存在差异，进入 Keymaster 后是同一交易事实结构。
3. History 与 UTXO 不再是两份供应商真值；transaction facts 是唯一确认事实，owned outpoints 只是可重建投影。
4. 普通 BSV 广播明确成功即可本地确认并连续花找零；异常只隔离，不猜测、不自动解锁。
5. 当前有效区块事实可以提升、覆盖或回滚本地状态，并正确级联到后代。
6. provider 切换没有 fallback、混用、双写和旧 cursor 污染。
7. v9 升级不会丢掉任何可能仍在网络中的本地交易输入占用。
8. 新 UI、设置、任务、数据库与测试一次性替换旧模型，仓库不存在可重新启用旧 WOC UTXO/history 模型的生产路径。
