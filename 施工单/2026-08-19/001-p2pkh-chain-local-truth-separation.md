# 001 P2PKH 链上真值与本地真值分层施工单

## 1. 目标

把 P2PKH 钱包恢复为两套物理分离、由链上同步单向裁决的事实层：

```text
p2pkh_transactions（链上当前真值）
  +
p2pkh_local_transactions（本机构造、广播与确认前 DAG）
  -> 完整交易图
  -> 链上 UTXO - 本地 claim + 本地可用找零
  -> 本地可花投影
```

正式页面口径：

| 路由 | 唯一交易数据源 | 默认展示范围 |
| --- | --- | --- |
| `/p2pkh/{mainnet,testnet}/transactions` | `p2pkh_transactions` | 当前 confirmed provider 已完整提交的链上事实 |
| `/p2pkh/{mainnet,testnet}/local-transactions` | `p2pkh_local_transactions` | 尚未晋升为链上事实的本地记录，包括提交中、本地确认、隔离和冲突 |

同一 txid 可以同时保存在两套事实表中，但两行表达不同事实：链上表证明它在当前有效链中，本地表保留本机如何构造、广播及被裁决的审计信息。UI 默认不得把已经 `chain-confirmed` 的本地审计行重复显示在本地列表。

## 2. 非目标与边界

1. 本次不新增 `/coins`、`/outputs` 或第三个资产菜单。
2. 原 Coins/Outputs 表退出 `/local-transactions`；`p2pkh_owned_outpoints`、`p2pkh_local_outpoints` 和 `p2pkh_local_input_claims` 继续作为余额、选币与重建使用的内部投影。
3. 不把余额持久化为新实体。
4. 不把 mempool 观察冒充链上事实，也不引入 mempool 同步。
5. 不删除已经晋升或冲突的本地交易审计记录。
6. 不改变 P2PKH 地址、provider 选择、广播协议或其它资产协议提交的业务语义。

## 3. 数据模型

### 3.1 链上事实 `p2pkh_transactions`

沿用 `P2pkhTransactionFact`，但强化以下不变量：

- 只能由 confirmed sync 的成功提交写入；
- 本地广播结果不得创建或补造 chain fact；
- 行主键保持 `resourceId + txid`；
- 重组删除只能发生在完整成功历史核对或有效 anchor overlap 核对中；
- `/transactions` 列表只读取该表，状态恒为 `chain-confirmed`；
- 本地记录不得覆盖链上行的状态、时间、区块高度或详情数据源。

### 3.2 本地事实 `p2pkh_local_transactions`

把当前单一 `state` 硬切换为两个正交维度：

```ts
type P2pkhLocalLifecycleState =
  | "prepared"
  | "submitting"
  | "local-confirmed"
  | "isolated";

type P2pkhLocalChainResolution =
  | "unresolved"
  | "chain-confirmed"
  | "conflicted";

interface P2pkhLocalTransaction {
  // 现有身份、原始交易、输入、自己的输出、父 txid、attempts 与时间字段保留
  localState: P2pkhLocalLifecycleState;
  chainResolution: P2pkhLocalChainResolution;
  confirmedFactId?: string;
  resolvedAt?: string;
  conflictSourceTxids?: string[];
  isolationReason?: string;
}
```

删除生产模型中的：

- `state`；
- `chainConfirmationPreviousState`；
- `conflictPreviousState`。

链上裁决不得抹掉本地生命周期：一笔已被广播供应商接受并随后入块的交易应保存为：

```text
localState = local-confirmed
chainResolution = chain-confirmed
```

### 3.3 索引与唯一性

升级 P2PKH IndexedDB schema 版本并完成真实迁移：

- 为本地交易增加 `[resourceId, chainResolution]` 索引，服务默认本地列表过滤；
- 为本地交易增加 `[resourceId, txid]` 索引；若历史数据已经存在同 resource/txid 多行，不得通过盲设 unique 导致升级失败，应先制定确定性归并或保留非 unique 索引；
- rebroadcast 必须追加到同一 submission 的 `attempts`，不得为相同本地交易制造第二份有效 overlay；
- 所有 key namespace 隔离规则保持不变。

### 3.4 V15 到新版本迁移

迁移映射必须确定、可测试、不能清库：

| 旧 `state` | 新 `localState` | 新 `chainResolution` |
| --- | --- | --- |
| `prepared` | `prepared` | `unresolved` |
| `submitting` | `submitting` | `unresolved` |
| `local-confirmed` | `local-confirmed` | `unresolved` |
| `isolated` | `isolated` | `unresolved` |
| `chain-confirmed` | 合法 `chainConfirmationPreviousState`，否则 `isolated` | `chain-confirmed` |
| `conflicted` | 合法 `conflictPreviousState`，其次合法 `chainConfirmationPreviousState`，否则 `isolated` | `conflicted` |

其中“合法 previous state”只接受 `prepared/submitting/local-confirmed/isolated`；不得把旧的 terminal state 写入 `localState`。迁移后移除旧字段，保留 `conflictSourceTxids`、attempts、raw tx、DAG 和时间信息。对 chain-confirmed 行尽可能由已有 fact 填充 `confirmedFactId`；无法关联时仍保留 terminal resolution，不伪造 fact。

## 4. 投影定义

### 4.1 `p2pkh_owned_outpoints`

- 只从 chain facts 重建；
- `chainState` 只有 `available/spent`；
- 不写入 claim、隔离、保护等本地状态；
- provider 完整同步后可以从 chain facts 全量重建。

### 4.2 `p2pkh_local_input_claims`

- 表示尚未由链上裁决收口的本地输入占用；
- `chainResolution=chain-confirmed` 后删除对应临时 claims；
- `chainResolution=conflicted` 后不得参与可花选择；可保留隔离诊断行，但状态必须阻止消费；
- reorg 撤销裁决后从 local transaction 的输入和已知 value 重建；
- 不允许超时自动解锁。

### 4.3 `p2pkh_local_outpoints`

- 从 unresolved 本地交易的 `ownOutputs` 派生；
- 只有 `localState=local-confirmed` 且分支未冲突时可以成为 `available`；
- 入块晋升后删除临时行，由 chain owned projection 接管；
- 冲突时本交易及全部后代输出失效；
- reorg 撤销裁决后按保留的本地生命周期和 DAG 重建。

### 4.4 余额和选币

余额仍为实时计算结果：

```text
blockConfirmed = chain available owned outputs
localSpendable = chain available - active/isolated/protected claims + valid local available outputs
```

所有读取本地交易状态的生产代码必须改用双轴；禁止为了兼容继续读取已删除的 `state`。

## 5. 原子状态转换

### 5.1 准备与广播

1. prepare 原子写入本地交易、input claims 和 unavailable local outputs；
2. 发出广播前后保持 `chainResolution=unresolved`；
3. provider 明确 `accepted/already-known`：`localState=local-confirmed`，输出可用，claim active；
4. 结果不确定：`localState=isolated`，输出与 claim 隔离；
5. late broadcast response 只允许追加 attempt；若已经被链上裁决，不能改变 `chainResolution` 或重新激活投影。

### 5.2 同 txid 入块

同一个 IndexedDB readwrite transaction 内：

1. upsert chain fact；
2. 更新 chain owned projection；
3. 本地行保持原 `localState`，设置 `chainResolution=chain-confirmed`、`confirmedFactId`、`resolvedAt`；
4. 删除对应临时 claim 与 local outpoint；
5. 提交 sync checkpoint。

### 5.3 竞争交易入块

同一个原子提交内：

- 根本地交易及全部 DAG 后代设置 `chainResolution=conflicted`；
- 追加且去重 `conflictSourceTxids`；
- 本地输出全部失效；
- claims 不得再使任何输出可花；
- 本地 `localState` 保持原值，用于审计与未来重组恢复。

### 5.4 重组

只有完整成功核对可撤销事实：

- 本地同 txid 的 chain fact 消失：`chainResolution=unresolved`，清理 `confirmedFactId/resolvedAt`，按 `localState` 重建 overlay；
- 冲突来源消失：移除对应 `conflictSourceTxids`；全部来源消失时恢复 `unresolved` 并重建分支；
- 仍有其它冲突来源时保持 `conflicted`；
- 重建 chain owned projection、local overlay 和 sync checkpoint 必须原子完成。

## 6. UI 与读取口径

### 6.1 `/transactions`

- 只迭代 `P2pkhTransactionFact`；
- 不加载本地分页来补链上列表；
- 不把 local row merge/overwrite 到 fact row；
- 所有行状态为“链上确认”；
- 区块高度、区块时间和 block balance 只来自 chain fact/projection；
- 详情 `source=transactions` 时只以 chain fact 为交易事实，不使用 local state 覆盖摘要。

### 6.2 `/local-transactions`

- 渲染本地“交易”表，不再渲染 outpoint/Coins 表；
- 默认过滤 `chainResolution !== chain-confirmed`；
- 至少展示 txid、输入金额、输出金额、本地生命周期、链上裁决、最近更新时间和详情操作；
- `conflicted` 继续显示用于解释失败，但不参与余额；
- `isolated`、`submitting` 等需要重广播的状态继续提供既有安全操作；
- 详情 `source=local-transactions` 时以 local transaction 为主，并展示 attempts、父交易和本地裁决；
- 已晋升记录保留在 DB，本次不要求新增“已晋升”筛选 UI。

### 6.3 公共摘要

两个页面可以继续显示钱包公共余额分解和 provider/sync 摘要，因为它们明确是合成投影；列表本身必须严格分层。修复“最近完整同步”中文插值键不匹配，禁止出现未展开的 `{{main}}`。

## 7. 必须补齐的测试

### 7.1 DB 与迁移

1. V15 每一种旧状态迁移到双轴的精确映射；
2. 迁移保留 raw tx、DAG、attempts、冲突来源和审计时间；
3. local-confirmed -> chain-confirmed 保留 localState，删除临时 overlay；
4. 同 txid reorg 后恢复 unresolved 和原 localState，并重建 claims/outputs；
5. competing fact 冲突整条后代分支；
6. competing fact reorg 后恢复分支；
7. late broadcast response 不能降级 chain-confirmed/conflicted；
8. owned projection 可以只从 chain facts 重建。

### 7.2 Service、余额与发送

1. 连续消费本地确认找零仍可工作；
2. unresolved claim 防止双花；
3. isolated/conflicted 分支不能进入可花集合；
4. chain-confirmed 本地交易不重复贡献余额；
5. provider/transfer/rebroadcast 所有状态判断均使用双轴。

### 7.3 UI、导航与详情

1. `/transactions` 有 local-only 行时绝不显示该行；
2. 同 txid 同时有 fact/local 时，链上页只显示 fact 状态和区块数据；
3. `/local-transactions` 显示 unresolved/isolated/conflicted 本地交易，不显示 Coins 表列；
4. 默认本地页隐藏 chain-confirmed 审计行；
5. 两种详情来源使用各自事实层并正确返回来源页；
6. 主网/测试网切换和分页保持当前正式路径；
7. 中文同步时间插值正确。

## 8. 实施检查范围

至少检查：

- `packages/plugin-p2pkh/src/p2pkhContracts.ts`
- `packages/plugin-p2pkh/src/p2pkhDb.ts`
- `packages/plugin-p2pkh/src/p2pkhService.ts`
- `packages/plugin-p2pkh/src/p2pkhBalance.ts`
- `packages/plugin-p2pkh/src/p2pkhTransferProvider.ts`
- `packages/plugin-p2pkh/src/coordinator.ts`
- `packages/plugin-p2pkh/src/pages/P2pkhWalletPage.tsx`
- `packages/plugin-p2pkh/src/pages/P2pkhTransactionDetailPage.tsx`
- `packages/plugin-p2pkh/src/pages/p2pkhTransactionView.ts`
- `packages/plugin-p2pkh/src/manifest.ts`
- 所有 P2PKH DB、同步、余额、转账、页面和导航测试

## 9. 验收命令

```text
pnpm exec vitest run packages/plugin-p2pkh/src
pnpm exec tsc -b --pretty false
pnpm lint:react-boundaries
```

若全仓类型检查或边界检查存在与本变更无关的基线失败，必须记录证据，并至少保证 P2PKH 定向测试及受影响 package 的等价类型检查通过。最后执行定向搜索，生产代码中不得残留：

```text
P2pkhLocalTransaction["state"]
local.state
row.local.state
chainConfirmationPreviousState
conflictPreviousState
```

测试 fixture 中只允许在明确的 V15 migration input 中保留旧字段。

## 10. 完成定义

- 两个页面的数据源物理分层，不再以 UI 文案掩盖混表；
- 双轴状态完成真实 DB 迁移且无清库；
- 入块、冲突、重组和迟到响应满足原子不变量；
- 连续消费本地找零、余额与选币没有回归；
- 本地审计记录永久保留，晋升后默认不重复显示；
- 定向测试、类型检查和边界检查无阻断失败。

## 11. 实施与验收记录

实施日期：2026-08-19。

本施工单已完成实施，并经过三轮设计核查与返修：

1. 完成链上页与本地页的数据源、表格语义和分页物理分离，补齐本地 DAG 输入金额；
2. 收紧双轴写入边界、审计读取、单笔同步冲突传播、迁移覆盖和页面隔离测试；
3. 修正重组恢复时父输出 claim 重建、隔离原因与冲突来源分离，以及成功重广播后的隔离原因清理。

最终实现结果：

- IndexedDB schema 由 V15 升级到 V16，旧单轴状态确定性迁移为 `localState + chainResolution`；
- 链上事实入块、竞争冲突、后代传播、事实撤销与本地 overlay 重建均在数据库事务边界内完成；
- 本地审计行继续保留，业务默认读取和 UI 默认列表排除已经 `chain-confirmed` 的本地行；
- `/transactions` 只读取 chain facts，`/local-transactions` 只表达仍由本地层裁决或用于解释冲突的本地交易；
- 连续消费本地确认找零、迟到广播响应和重组后的 DAG 可花状态均有回归测试覆盖。

主代理独立终验结果：

```text
pnpm exec vitest run packages/plugin-p2pkh/src
  17 test files passed
  102 tests passed

pnpm typecheck
  passed

pnpm lint:boundaries
  passed

pnpm lint:react-boundaries
  passed

git diff --check
  passed
```

遗留字段扫描仅在 V15 migration 实现及其输入 fixture 中命中，生产运行路径没有继续读取旧 `state` 或两个 previous-state 字段。当前无阻断问题。

## 12. Review 返修施工单

返修来源：2026-08-19 实施后代码审查。以下问题在合并前必须全部关闭，且不得以删除审计记录、改回单轴状态或放宽页面数据源边界规避。

### 12.1 迟到 abort 不得越过链上裁决

`abortUnattemptedLocalSubmission` 只有在以下条件同时满足时才允许删除尚未形成广播事实的初始 submission：

- `requestKind=initial`；
- `chainResolution=unresolved`；
- `localState=prepared/submitting`；
- attempts 为空。

检查与删除必须位于同一个 IndexedDB readwrite transaction。若同步已经把记录裁决为 `chain-confirmed` 或 `conflicted`，迟到的 `not-dispatched` 只能成为无效的清理请求，不能删除本地交易、claims、outputs 或审计信息。

必须新增 chain-confirmed 与 conflicted 两种迟到 abort 回归测试。

### 12.2 同 resource/txid 的全部历史行必须一致裁决

V16 的 `[resourceId, txid]` 索引保持非 unique，本次不归并或删除历史审计行。所有同步路径不得再以 `Map<txid, row>` 丢失重复记录：

- 同 txid 入块时，该 resource 下所有同 txid 本地行都晋升为 `chain-confirmed`；
- 竞争输入入块时，所有匹配根记录及其所有后代记录都设置为 `conflicted`；
- 删除 claims/local outpoints 或重建 overlay 时按每个 submission id 执行；
- DAG 邻接表允许一个 txid 对应多个本地行，遍历必须以 row id 去重，不能以 txid 提前丢弃审计行；
- 单笔 ingest 与分页 ingest 必须具有相同语义。

必须覆盖重复 txid 的入块晋升、竞争冲突、后代传播和重组恢复；测试同时断言没有遗留可花 overlay 或重复余额贡献。

### 12.3 完整同步必须收敛无 fact 的 terminal 本地行

V15 迁移允许旧 `chain-confirmed` 行暂时没有 `confirmedFactId`，但下一次 `completeHistory=true` 的成功同步必须以当前完整 facts 重新裁决：

- 使用 `[resourceId, chainResolution]` 索引定向读取本 resource 的 `chain-confirmed` 本地行，不做跨 resource 全表扫描；
- txid 仍有当前 fact：补齐或校正 `confirmedFactId`，保持 `chain-confirmed`；
- txid 已无当前 fact，且没有当前 confirmed fact 竞争消费其输入：恢复 `unresolved`，清理 `confirmedFactId/resolvedAt` 并重建本地 DAG overlay；
- txid 已无当前 fact，但当前链存在竞争 spender：直接裁决为 `conflicted`，记录全部冲突来源，不能短暂变成可花；
- partial/anchor overlap 同步不得凭不完整历史恢复这种 terminal 行。

必须新增“迁移后无 fact + 完整同步缺席”“完整同步仍存在 fact”“缺少同 txid fact 但存在竞争 spender”三类测试。

### 12.4 本地交易深分页必须填充目标页

自动加载条件必须依据当前目标页 `visibleLocalTxRows`，而不是全部已加载行数。直接访问 `local-transactions?page=N` 时，应持续沿 cursor 加载，直到：

- 目标页至少出现一条记录；或
- cursor 耗尽；或
- 检测到无进展/游标循环；或
- 加载失败。

自动加载失败后必须进入本地分页失败状态，禁止 effect 无限重试；用户显式再次点击加载/下一页时可以清除失败状态后重试。不得在没有加载到目标页记录时推进页码。

必须覆盖深链接目标页、连续 promoted-only 原始页、游标耗尽和自动加载失败不循环。

### 12.5 返修验收

除原第 9 节命令外，最终核查必须确认：

```text
late abort cannot delete resolved rows
duplicate txid rows are all adjudicated
complete history resolves orphan terminal rows
deep local pages do not remain empty while a cursor can fill them
automatic local pagination failure does not loop
```

主代理 review 发现的问题全部关闭后，重新记录测试数量、类型检查、两项边界检查与 `git diff --check` 结果。在此之前，第 11 节“当前无阻断问题”的结论视为已被本节取代。

## 13. Review 返修实施与终验记录

返修完成日期：2026-08-19。

本轮业务代码及测试全部由 `luna_worker` 实施，主代理只负责设计、施工单和实施核查。返修经过三轮核查：

1. 第一轮关闭迟到 abort、常规重复 txid 裁决、terminal orphan 完整同步收敛和本地深分页问题；
2. 第二轮补齐字段已经分叉的同 txid sibling 闭包，统一单笔 ingest、分页 ingest 和完整同步的逐行裁决语义；
3. 第三轮修正重复父输出在混合生命周期下可能残留 `available` 的问题，使未决 child claim 覆盖整个逻辑 outpoint 组，同时保留 `isolated/invalidated` 的更强状态。

最终实现满足：

- resolved 本地行不会被迟到的初始 abort 删除；
- 同 resource/txid 的全部历史审计行和后代按 row id 完整裁决，不依赖历史字段仍然一致；
- `completeHistory=true` 使用 `resourceChainResolution` 索引收敛没有 fact 的 terminal 行，并区分恢复、保留确认和竞争冲突；
- 重复物理 outpoint 只有一个逻辑可花语义；被未决子交易消费后组内不存在 `available`；
- 本地深链接页面会沿 cursor 填充目标页，自动失败熔断，显式操作可以安全重试且不会空页跳转。

主代理独立终验结果：

```text
pnpm exec vitest run packages/plugin-p2pkh/src
  17 test files passed
  111 tests passed

pnpm typecheck
  passed

pnpm lint:boundaries
  passed

pnpm lint:react-boundaries
  passed

git diff --check
  passed
```

遗留字段扫描仍仅命中 V15 migration 实现和 migration fixture。第 12 节提出的 review 问题及后续核查发现均已关闭，当前没有已知阻断问题。

## 14. 第二轮 Review 返修施工单

返修来源：2026-08-19 对第 13 节实现的再次代码审查。第 13 节“当前没有已知阻断问题”的结论由本节取代；以下问题全部关闭前不得合并。

### 14.1 CompleteHistory 必须按 txid 裁决全部审计兄弟行

完整历史同步发现某个 txid 仍有当前链上 fact 时，不得只校正已经是 `chain-confirmed` 的 terminal 行，也不得只依赖本次 `pageFacts` 命中：

- 只要 `reconciledFacts` 中存在该 resource/txid 的当前 fact，该 resource 下所有同 txid 本地审计行都必须晋升为 `chain-confirmed`；
- 所有兄弟行统一写入正确的 `confirmedFactId/resolvedAt`，清理冲突字段；
- 删除这些兄弟 submission 对应的全部 local outputs 与 claims，不能留下 unresolved/conflicted overlay；
- 分页早先页面出现的 fact，与后续通过 terminal/DAG 闭包载入的 sibling，必须得到和当前页 fact 完全相同的裁决。

必须新增多页完整同步回归测试：fact 位于较早页面，而同 txid 的 unresolved、conflicted 或错误 fact-id sibling 在后续闭包中被载入；断言全部晋升且 overlay/claims 清空。

### 14.2 CompleteHistory 必须收敛孤立 conflicted 行

完整历史是当前链事实的权威快照，除 `chain-confirmed` terminal 行外，还必须使用 `[resourceId, chainResolution]` 索引定向读取本 resource 的 `conflicted` 行：

- 若同 txid 当前 fact 存在，按 14.1 全组晋升；
- 若 `conflictSourceTxids` 中仍有当前链 fact，或当前链 fact 实际竞争消费本地输入，保持/更新 `conflicted` 并记录完整冲突来源；
- 若不存在同 txid fact，也不存在任何仍有效的竞争 spender，则恢复为 `unresolved`，清理 terminal 裁决字段，并按 DAG 顺序重建 overlay 与 claims；
- 迁移产生的 conflicted 行即使其旧冲突来源已经完全不在 facts 中，也必须在本次完整同步收敛，不能永久锁定余额；
- partial sync 不得用不完整链历史恢复 conflicted 行。

必须覆盖：孤立 conflicted 恢复、冲突来源仍在链上、来源字段陈旧但存在实际竞争 spender、同 txid fact 重新出现、跨 resource 不互相影响。

### 14.3 所有输出状态写路径必须维持逻辑 outpoint 单一可花性

同一 resource 下，相同 `txid:vout` 的多条物理审计输出只能表达一个逻辑 outpoint。任何会改变 local output 状态的路径（尤其迟到成功广播的 `finishLocalSubmission`、abort、重组恢复与 overlay 重建）结束时都必须统一重算整组：

- 若存在有效未决 child claim，整组不得有 `available`；
- 若不存在 child claim，整组至多一条记录可贡献可花余额和选币候选；
- `isolated/invalidated` 等更强状态不得被无条件降级；
- 余额读取和选币读取必须做防御性逻辑 outpoint 去重，避免历史脏数据或未来写路径遗漏造成双计数、双花候选；
- 写入裁决与读取去重必须限定 resource，不能跨钱包或网络合并。

必须新增迟到成功广播回归测试：重复 parent sibling 在重组后处于混合生命周期，完成其中一次 submission 后仍只有一个逻辑可花输出；余额与候选列表都不得重复贡献。

### 14.4 重复本地审计行的详情必须逐条可达

本地列表以 submission row 为审计单位时，详情导航不能只携带 txid 并使用 `find(txid)`：

- 本地详情 URL 必须携带稳定的 submission id（query 或 route segment 均可），并以 resource/network、txid、submission id 联合约束读取；
- 从某一列表行点击详情，展示的 attempts、`localState`、`chainResolution`、隔离/冲突原因必须属于该行；
- 旧的仅 txid 本地详情链接应保留确定性的兼容行为，但不能影响新链接的精确选择；
- 链上交易详情仍以 txid/fact 为身份，不引入本地 submission 语义。

必须新增 UI 回归测试：两个相同 txid、不同 submission id 和状态的本地行分别进入详情，断言展示各自数据；同时覆盖旧链接兼容行为。

### 14.5 第二轮返修验收

业务实现和测试只由 `luna_worker` 修改。主代理逐项审查并独立验证：

```text
complete history promotes every same-tx sibling across pages
complete history restores or preserves orphan conflicted rows correctly
every write path and read path preserves one logical spendable outpoint
duplicate audit rows open their own local detail
```

同时重新执行插件完整测试、类型检查、两项边界检查和 `git diff --check`。任何不变量缺失、回归测试只覆盖表面路径、或出现新的阻断问题，都必须继续退回 `luna_worker` 返修。

### 14.6 第一轮实施核查退回项

`luna_worker` 第一轮报告 17 个测试文件、116 项测试通过，但主代理逐项代码审查发现以下路径尚未闭合，必须继续返修：

1. 完整同步在删除 stale fact 后，先把对应 `chain-confirmed` 本地行恢复为 `unresolved`，后续却只对仍为 terminal 的组检查当前竞争 fact。若竞争 spender 已在较早分页写入、最终 complete page 的 `pageFacts` 为空，该组会跳过竞争裁决并错误恢复可花。必须基于“本轮开始时是 terminal 或本轮由 stale fact 恢复”的候选集合裁决，或者统一对受影响组用完整 facts 重算，不能依赖恢复后的瞬时 `chainResolution`。
2. `p2pkhTransferService` 的实际转账选币入口仍将所有 available local outputs 直接加入 candidates，没有按 `resourceId + txid:vout` 去重。必须在保护/预约过滤前形成确定性逻辑候选，并覆盖两个重复 available 行不会提高可分配金额、不会形成重复 input。
3. 详情页带 `submissionId` 时，若目标审计行不在首屏、但同 txid 的另一个 sibling 在首屏，当前逻辑会回退到 sibling 并停止深读取。只允许“没有 submissionId 的旧链接”使用确定性 txid fallback；显式 id 未命中时必须继续深读取，全量仍未命中则显示 unavailable，不能展示另一条审计行。
4. 输出组 normalize 只从当前已经是 `available` 的行中选 canonical。若原 canonical 被隔离、删除或失效，另一个仍是 `local-confirmed + unresolved` 但此前因去重处于 `unavailable` 的 sibling 不会被提升，导致逻辑余额永久锁定。无 child claim 时 canonical 必须从所有语义上可花的 mutable sibling 推导，而不是从旧物理状态推导。

以上四项都必须新增能够在第一轮实现上失败的回归测试。修复完成后重新执行第 14.5 节全部验收命令。

### 14.7 第二轮实施核查退回项

第二轮实现关闭了第 14.6 节四个直接场景，但 complete-history 的候选集合仍不完整：

1. `restoredTerminalTxids` 只记录由 stale 同 txid fact 恢复的 `chain-confirmed` 行；当 `conflicted` 行的旧冲突来源 fact 在本轮成为 stale、来源清空并暂时恢复为 `unresolved` 时，没有加入候选集合。若另一个实际竞争 spender 仍在完整 facts 中且来自较早页，该行会越过竞争重算并错误解锁。
2. 完整历史的竞争检查原则上不能只覆盖 terminal 或本轮恢复的 terminal。若一个 `unresolved` 本地 submission 在竞争 fact 所在分页处理之后才写入，最终 complete page 的 `pageFacts` 可以为空，但完整 `reconciledFacts` 已足以裁决它。同步完成边界必须检查所有无同 txid fact 的未决本地组是否被当前 facts 竞争消费输入。

建议把“是否检查实际竞争”与“无竞争时是否需要 restore”分开：所有无同 txid fact 的本地 txid 组都根据完整 facts 计算竞争来源；有来源则整组及后代 conflicted；只有无来源时，才仅对 terminal/本轮恢复 terminal 执行 unresolved overlay 恢复，原本 unresolved 的组保持原状态。必须新增两个早页 fact + 最终空页测试，分别覆盖 stale conflict-source 恢复和同步期间后写入 unresolved submission。

## 15. 第二轮 Review 返修实施与终验记录

完成日期：2026-08-19。

本轮所有业务代码与测试仍由 `luna_worker` 实施；主代理只修改本施工单并进行逐轮代码审查和独立验证。实施共经过三轮验收退回：

1. 首轮实现完成同 txid 全组晋升、孤立 conflicted 收敛、写路径输出组重算、读取侧余额去重和 submission-id 详情导航；主代理退回 stale terminal 竞争漏判、transfer 实际选币未去重、显式 submission-id 错误 fallback、canonical 无法接替四项。
2. 第二轮关闭上述四项；主代理继续发现 stale conflict-source 恢复和同步分页期间后写入 unresolved submission 仍可能越过完整 facts 裁决。
3. 第三轮将“检查当前事实竞争”扩展到全部无同 txid fact 的本地组，同时仅在无竞争时恢复 terminal 候选，避免扰动普通 unresolved 行。

最终实现满足：

- complete-history 以当前完整 facts 对同 resource 的全部相关本地 txid 组裁决；早页 fact、最终空页、stale chain-confirmed、stale conflict source 和同步期间后写入 submission 均能收敛；
- 当前同 txid fact 会晋升全部审计 sibling 并清理每个 submission 的 outputs/claims；实际竞争 spender 会使整组与 DAG 后代 conflicted；无事实无竞争的 terminal 才恢复 unresolved overlay；
- local output 写路径按 `resourceId + txid:vout` 重算逻辑可花性，仍有效的 sibling 可以接替被隔离/失效的旧 canonical；
- 余额、资产分配和转账实际选币均防御性去重，chain/local 合并时链上 confirmed 候选优先；
- 本地详情链接携带 submission id，并按 resource/network、txid、submission id 精确选择；显式 id 未命中不会回退到 sibling，旧 txid-only 链接保留确定性兼容；
- `/transactions` 继续只表达链上事实，`/local-transactions` 默认只表达仍由本地层裁决的记录，已晋升审计行仍保存在数据库中。

主代理独立终验结果：

```text
pnpm exec vitest run packages/plugin-p2pkh/src
  17 test files passed
  123 tests passed

pnpm typecheck
  passed

pnpm lint:boundaries
  passed

pnpm lint:react-boundaries
  passed

git diff --check
  passed
```

旧 `state` 双义字段及 `chainConfirmationPreviousState/conflictPreviousState` 仅保留在 V15→V16 migration 读取逻辑和 migration fixture 中，生产运行路径不再依赖旧单轴状态。第 14 节及 14.6、14.7 的阻断项均已关闭，当前没有已知阻断问题。

## 16. 应用集成 Review 返修施工单

返修来源：2026-08-19 对插件、Web Coordinator 和实际广播路径的跨包审查。第 15 节“当前没有已知阻断问题”的结论由本节取代；以下问题关闭前不得合并。

### 16.1 Coordinator 必须完整迁移到双轴状态

`P2pkhLocalTransaction` 已移除旧 `state`，生产 Worker、测试辅助入口和 Worker fixture 不得继续读取或写入旧单轴字段：

- 初次广播只允许 `localState=submitting && chainResolution=unresolved` 的目标 submission；已经链上确认或冲突的迟到请求不能再次广播或降级；
- 广播成功和 `already-known` 必须调用 `finishLocalSubmission({ localState: "local-confirmed" })`；首次明确失败使用 `localState: "isolated"`；
- 重广播失败时，先前 `localState=local-confirmed` 的记录只追加失败 attempt，保持本地确认及 outputs/claims，不得降级为 isolated；
- 祖先遍历以 `chainResolution=chain-confirmed` 判断跳过，以 `chainResolution=conflicted` 判断阻断；生命周期判断只读取 `localState`；
- Worker 测试 seed、helper 参数和断言全部改为 `localState + chainResolution`，除 V15 migration fixture 外不得用额外旧 `state` 掩盖生产错误；
- 新增真实双轴普通广播集成测试：从不含旧 `state` 的 submitting/unresolved submission 开始，断言供应商被调用、attempt 被保存、记录变为 local-confirmed、输出 available、claims active；
- 保留并修正“已 local-confirmed 的祖先重广播失败不降级”“chain-confirmed 祖先跳过”“conflicted 祖先阻断”测试。

必须以根 `pnpm typecheck` 和 `pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false` 双重验证，确保没有增量缓存假绿。

### 16.2 本地状态写入不得扫描全部审计历史

审计交易永久保留后，普通 prepare、finish、abort 的成本必须只与受影响 outpoint 组和直接相关 submission/children 成正比：

- `normalizeLocalOutputGroupsInTransaction` 接收明确的受影响逻辑 outpoint keys；
- 使用 outpoint、inputOutpoint、submission 主键/索引定向读取同 resource 组，不得 `getAll()` 全部 local transactions、local outpoints 或 claims 后再过滤；
- prepare 覆盖新 outputs 与被 claims 消费的 parent keys；finish 覆盖自身 outputs 与输入 parent keys；abort 覆盖删除的 outputs 与释放的 parent keys；
- 仍需维持同 resource、同 `txid:vout` 只有一个逻辑可花语义，并保留 isolated/invalidated 优先级；跨 resource 同 outpoint 不得互相影响。

必须新增带大量无关历史行的定向写入回归测试，并通过可观察的索引/事务行为或 helper 边界证明无关行不参与状态重算，不能只测最终小样本状态。

### 16.3 CompleteHistory 必须保持线性收敛

完整历史为了裁决 terminal、同步期间后写入 unresolved 行，可以执行一次明确的 `[resourceId]` 线性扫描；但不得继续逐 local row 查询 sibling/children/claims/outputs，也不得对每个本地组遍历全部 facts：

- 一次构建 `factByTxid` 与 `spenderTxidsByInputOutpoint`；同 txid 晋升和实际竞争来源查询应为 map/set 查找；
- 一次构建本 resource 的 `localsByTxid`、`childrenByParent`、claims/outpoints by submission/outpoint；完整集合已加载时禁止 `loadLocalOverlay` 再对每一行发 sibling、parent、submission N+1 查询；
- 保持第 14.7 节语义：所有无同 txid fact 的本地组都检查竞争；有竞争整组及后代 conflicted；无竞争只恢复原 terminal 候选，普通 unresolved 不受扰动；
- partial/anchor overlap 仍只加载与本页/锚点相关的闭包，不扩大为完整 resource 扫描。

必须用规模化 fixture 覆盖大量 facts、已晋升审计、普通 unresolved、stale terminal 和跨 resource 数据；测试既断言最终裁决，也应约束关键查询/比较不随 `locals × facts` 二次增长。

### 16.4 本轮验收

所有生产代码和测试只由 `luna_worker` 修改，主代理只负责本施工单和实施核查。至少执行：

```text
pnpm exec vitest run packages/plugin-p2pkh/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm typecheck
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
pnpm lint:boundaries
pnpm lint:react-boundaries
git diff --check
```

验收必须确认普通双轴交易能够通过真实 Coordinator 广播完成；Worker 不再出现旧 `state`；普通本地写入定向收敛；complete-history 保持第 14.7 节正确性且消除 N+1/二次比较。任何失败或新的阻断问题都继续退回 `luna_worker`。

### 16.5 第一轮实施核查退回项

`luna_worker` 第一轮报告插件 125 项测试、Worker 61 项测试以及类型检查和边界检查通过；主代理逐项代码审查后仍发现以下阻断项，必须继续返修：

1. complete-history 对每个发现当前冲突来源的 txid 组调用 `invalidateBranch`，而该函数会把来源写入全部后代。后续遍历到这些后代组时，又会因继承的有效 `conflictSourceTxids` 再次遍历各自的全部后代；深链会形成 `N + (N-1) + …` 的重复遍历和重复 IndexedDB 写入。必须先用本轮完整 facts 和本地 DAG 在内存中计算最终冲突来源/裁决计划，再对每条 local row、claim、output 至多执行一次最终状态写入。多冲突来源的成本可以与实际需要保存的 source-row 关系数量成正比，但不得重复扫描整条 branch 或重复写相同最终状态。
2. 第 16.1 节要求保留并修正的“`chain-confirmed` 祖先跳过”和“`conflicted` 祖先阻断”Worker 回归测试没有落地。必须使用只含 `localState + chainResolution` 的真实双轴 fixture，断言 provider 调用顺序/次数、目标与祖先最终状态及 attempts；不能只测试普通广播和重广播失败。
3. Coordinator 重广播祖先图仍使用 `Map<txid, row>`，会按插入顺序丢失相同 txid 的其它审计 sibling。必须按 txid 分组并确定性裁决逻辑交易：同组存在 `conflicted` 行时不得广播该祖先；同组已经由链上事实裁决为 `chain-confirmed` 时跳过；需要广播时只能广播一次，并确定性选择与 txid 一致的 raw transaction，同时按 submission id 保留审计边界。新增重复 txid sibling 状态分叉测试，证明行为不依赖数据库返回顺序且 provider 不会重复广播。

返修后重新执行第 16.4 节全部命令。主代理将继续进行代码级复杂度核查，不能以扩大规模但只断言最终状态的测试替代线性实现证据。

### 16.6 第二轮实施核查退回项

第一轮返修已将 complete-history 改为内存冲突计划，并用深 DAG 的 IndexedDB `put` 次数证明不再重复写分支；祖先的 chain-confirmed 跳过、conflicted 阻断与重复 txid 分组测试也已补齐。但 Coordinator 的目标审计边界仍未闭合：

- `p2pkh.rebroadcast-ancestors` 明确携带 `submissionId`。对祖先 txid 组可以确定性选择一个 sibling 代表逻辑交易广播一次；但遍历到请求目标自身的 txid 时，必须使用请求命中的 `local` row 执行广播和保存 attempt，不能再用组内 raw/id 排序结果替换目标；
- 当前 `canonicalRowForTxid(local.txid)` 可能选择另一个 sibling，导致用户操作 submission B，却把 provider attempt 和生命周期更新写到 submission A，B 的本地详情无法审计这次操作；
- 同组 conflicted 阻断和 chain-confirmed 跳过规则仍应先于广播执行；只有确实需要广播目标逻辑交易时才使用精确 submission row；
- 新增重复 txid 目标回归测试：令请求目标不是排序 canonical sibling，断言 provider 只调用一次、raw tx 来自请求目标、attempt 只追加到目标 submission，另一个 sibling 的 attempts/生命周期保持不变。测试必须能在第一轮返修实现上失败。

完成后再次执行第 16.4 节全部验收命令。

### 16.7 应用集成返修实施与终验记录

完成日期：2026-08-19。

本轮所有业务代码和测试仍由 `luna_worker` 实施；主代理只负责设计、施工单、逐项代码审查和独立终验。返修经过三轮核查：

1. 第一轮完成 Web Coordinator 双轴迁移、普通本地写入的 affected-outpoint 定向重算，以及 complete-history 的 resource 级集合加载；主代理退回深 DAG 重复冲突遍历、Worker 祖先边界测试缺失和重复 txid 祖先丢 sibling 三项。
2. 第二轮将完整历史冲突处理改为内存计划后统一落库，用 24 层 DAG 的 IndexedDB 写入计数约束每条 row/output 的单次最终写入，并补齐 chain-confirmed 跳过、conflicted 阻断和重复 txid 分组；主代理继续发现请求目标可能被 canonical sibling 替换，导致 attempt 记错审计行。
3. 第三轮区分祖先代表行与请求目标行：祖先组保持确定性单次广播，目标 txid 在组裁决通过后精确使用 `submissionId` 对应记录，新增非 canonical 目标回归测试，断言 raw transaction、provider 调用次数和两条 sibling 的 attempts 均正确。

最终实现满足：

- 普通双轴 submission 可以通过真实 Coordinator 广播，成功、失败和重广播均不再依赖旧单轴字段；
- chain-confirmed 祖先跳过、conflicted 祖先阻断，重复 txid sibling 的判断不依赖 IndexedDB 返回顺序，逻辑交易只广播一次；
- 请求目标的 attempt 严格写入请求指定的 submission，重复审计行的详情边界不被重广播破坏；
- prepare、finish、abort 只重算受影响 outpoint 组，不扫描全部永久审计历史；
- complete-history 一次加载本 resource 集合并构建 fact、spender 和本地 DAG map，在内存中形成最终冲突计划后统一落库，不再逐 root 重复遍历或写入后代；
- 同 txid 晋升、竞争冲突、terminal 恢复、普通 unresolved 保持和跨 resource 隔离继续满足此前施工单不变量。

主代理独立终验结果：

```text
pnpm exec vitest run packages/plugin-p2pkh/src --reporter=dot
  17 test files passed
  126 tests passed

pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts --reporter=dot
  1 test file passed
  64 tests passed

pnpm typecheck
  passed

pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
  passed

pnpm lint:boundaries
  passed

pnpm lint:react-boundaries
  passed

git diff --check
  passed
```

旧 `P2pkhLocalTransaction.state` 和 previous-state 字段只存在于 V15→V16 迁移读取逻辑及其 migration fixture；其它 `row.state` 命中属于 local outpoint、claim 或页面 view-model 的独立状态字段。第 16 节及 16.5、16.6 的阻断项均已关闭，当前没有已知阻断问题。

## 17. 第三轮 Review 返修施工单

返修来源：2026-08-21 对全部未提交差异的再次代码审查。第 16.7 节“当前没有已知阻断问题”的结论由本节取代；以下 1 个 P1、3 个 P2 全部关闭前不得合并。本轮业务代码和测试仍只由 `luna_worker` 修改，主代理只负责本施工单、设计核查与独立验收。

### 17.1 Chain/local 重叠必须使用同一个 authoritative canonical outpoint

链上 owned projection 与本地 output 历史可能因迟到通知、迁移脏数据或事务边界外读取短暂同时包含同一个 `resourceId + txid:vout`。所有余额和选币入口必须执行一致规则：

- chain projection 是该逻辑 outpoint 的权威来源；同 key 同时存在 chain/local 时只能保留 chain 的 value、script、status 和 id；
- `blockConfirmed` 仍只统计 chain available；`localConfirmedChange` 只统计没有同 key chain projection 的有效 local output；`localSpendable` 不得重复贡献；
- claims/protected reservation 对该逻辑 outpoint只扣除一次；跨 resource、跨网络不得互相去重；
- 公共 `allocateUtxos` 与实际 transfer candidate 路径必须使用相同优先级，不能因 local id 字典序更小而覆盖 confirmed candidate；
- 对同层重复物理行仍使用既有确定性 id 规则。

必须新增能够在当前实现失败的回归测试：同 key chain/local value 或 script 不同，余额断言不双计，公共 `allocateUtxos` 与实际 transfer preview 都选择 confirmed candidate；另覆盖跨 resource 同 txid:vout 不互相吞并。

### 17.2 已晋升审计详情必须继续精确可达

`/local-transactions` 默认隐藏 `chainResolution=chain-confirmed` 只是一条列表展示策略，不能让永久保留的审计详情失效：

- `source=local-transactions&submissionId=...` 的详情深读取必须显式 opt in `includeResolvedLocalTransactions=true`；
- 读取必须同时限定 route resource/network、txid 和 submission id，不能扩大到其它网络或回退到 sibling；
- submission 入块后，已打开或保存的精确详情链接仍能展示原 local lifecycle、chain resolution、attempts 与裁决元数据；
- txid-only 旧链接保留确定性兼容，但不得改变 `/local-transactions` 默认隐藏已晋升行的行为。

必须新增“首屏不存在且已经 chain-confirmed 的精确 submission 深读取”回归测试，并断言 service 调用携带 resolved opt-in 和 resource/network 约束。

### 17.3 本地链式交易详情必须解析父级 local output

消费本地确认找零是本设计存在 `local-transactions` 的核心能力，详情页不能只从 chain owned projection 求输入值：

- snapshot 读取应把同 resource 已加载的全部 local outpoints 纳入 value map，而不是只加入当前 txid 的 outputs；
- 深读取目标 local submission 时，还必须读取同 resource 的 local outpoints，以覆盖父输出不在首屏 bounded snapshot 的情况；
- 输入金额与 fee 只在全部输入值可知时显示精确值，不能把未知输入当 0；
- chain 详情继续只以 chain fact 为事实，但本地 value projection 可以用于解释它曾消费的钱包 owned outpoint，不得用 local lifecycle 覆盖 chain 摘要。

必须覆盖首屏父输出与深页父输出两种 chained local 详情，断言输入总额和 fee；另覆盖缺少任一输入值时仍显示未知。

### 17.4 本地终态详情与操作必须一致

本地详情必须解释裁决，而列表不能提供必然失败的动作：

- 展示 `isolationReason`（若有）、`conflictSourceTxids`、`confirmedFactId` 和 `resolvedAt`；字段标题补齐中英文资源；
- `chainResolution=conflicted` 是链上裁决终态，列表不显示重广播按钮；
- 重广播按钮只允许仍由本地层裁决且生命周期确实支持重试的记录，至少要求 `chainResolution=unresolved`，不得仅凭 `localState` 放宽；
- Worker 对 conflicted 请求继续 fail-closed，不能为了适配 UI 放宽生产门禁。

必须新增 conflicted 行无重广播按钮、isolated/unresolved 行仍可操作，以及详情裁决原因/来源/时间展示测试。

### 17.5 本轮验收

`luna_worker` 完成后，主代理逐项审查并独立执行：

```text
pnpm exec vitest run packages/plugin-p2pkh/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm typecheck
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
pnpm lint:boundaries
pnpm lint:react-boundaries
git diff --check
```

验收必须确认余额和两条选币路径采用同一 chain-first canonical 规则；已晋升 local audit 精确可达；本地父输出在列表与详情均能解释；终态原因和操作边界一致。测试全绿但未覆盖旧实现可失败场景，或任何入口仍有不同 canonical 规则，都必须继续退回 `luna_worker`。

### 17.6 第一轮实施核查退回项

`luna_worker` 第一轮已引入 chain-first canonical helper，并接入余额、公共分配和实际 transfer；已晋升审计精确深读、父级 local outpoint 深读、裁决元数据和 conflicted 操作门禁也已实现。主代理代码审查后仍有以下阻断项，关闭前不得验收：

1. 余额中的 protected reservation 仍使用裸 `txid:vout`：`calculateP2pkhBalanceBreakdown` 的 `protectedOutpoints` 与 `isReserved` 没有携带 `resourceId`。当调用方不传 network、同时汇总 main/test，或未来同网络存在多个 resource 时，一个 resource 的保护记录会错误隔离另一个 resource 的同名 outpoint，违反 17.1 的跨 resource/网络隔离。必须让保护键与 claims/canonical 一样使用 `resourceId + txid + vout`；生产调用方从 registry 行构建 resource-qualified key，不能只依赖当前多数调用恰好按 network 过滤。新增跨 resource 同 txid:vout、只保护其中一条的余额回归测试，并证明另一条仍可花。
2. 17.3 要求的 UI 回归覆盖不完整。目前只有列表首屏父输出和“目标 submission 不在首屏”的详情深读；必须再覆盖“目标 local transaction 已在 bounded snapshot，但父 output 也已在 snapshot”的详情，断言输入总额和 fee，证明 effect/快照合并没有短路或覆盖错误。还必须构造至少两个输入且缺少其中一个 value，断言总输入和 fee 都保持 `—`，并显示输入不完整提示，不能只依赖 `inputAmount` 的旧单元测试间接证明。
3. 17.4 要求的正向操作测试缺失。现有测试只证明 conflicted 行没有重广播按钮；必须再用 `localState=isolated && chainResolution=unresolved`（以及需要时 submitting/unresolved）断言按钮仍存在并触发精确 submission 的 Coordinator 请求，避免修复终态门禁时误伤正常本地重试。

返修后重新执行 17.5 全部命令。主代理会复查 resource-qualified protection 是否贯穿类型、registry 转换和余额计算，而不是只在测试 fixture 中改键。

### 17.7 第三轮 Review 返修实施与终验记录

完成日期：2026-08-21。

本轮所有业务代码和测试继续由 `luna_worker` 实施；主代理只负责设计、施工单、代码审查和独立终验。第一轮实现完成 chain-first canonical、已晋升审计深读、本地父输出详情和终态操作门禁后，主代理退回了 protected reservation 裸键以及三组验收测试缺口；第二轮返修已全部关闭。

最终实现满足：

- 新增统一 logical outpoint helper，以 `resourceId + txid + vout` 作为 canonical identity；chain confirmed 候选在余额、公共 `allocateUtxos` 和实际 transfer 三条路径中始终覆盖本地叠加，同层重复行按稳定 id 裁决；
- `blockConfirmed`、`localConfirmedChange` 和 `localSpendable` 不再重复贡献同一 chain/local outpoint；claim 金额优先采用链上权威 value，reservation 对同逻辑 outpoint 只扣一次；
- protected registry 行通过 `makeResourceId(network)` 转换为 resource-qualified key，跨 resource 同 txid:vout 只隔离被明确保护的记录；
- `/local-transactions` 默认继续隐藏 `chainResolution=chain-confirmed`，但携带 `submissionId` 的详情深读显式启用 resolved audit，并以 resource/network、txid、submission id 精确选择，不回退到 sibling；
- 本地详情同时使用同 resource 的 chain-owned value 与全部 local outpoint value；目标及父输出位于 bounded snapshot 或父输出需要深读时都可解释 chained spend，任一输入缺值时总输入和 fee 均显示未知；
- 详情展示 isolation reason、conflict sources、confirmed fact id 和 resolved time；conflicted 行无重广播操作，isolated/unresolved 行仍可按精确 submission id 重试，Worker 的 conflicted fail-closed 门禁未放宽。

主代理独立终验结果：

```text
pnpm exec vitest run packages/plugin-p2pkh/src --reporter=dot
  19 test files passed
  139 tests passed

pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts --reporter=dot
  1 test file passed
  64 tests passed

pnpm typecheck
  passed

pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
  passed

pnpm lint:boundaries
  passed

pnpm lint:react-boundaries
  passed

git diff --check
  passed
```

Worker 测试首次与插件测试并行执行时，既有的 cross-vault import 用例触发一次 5 秒超时；停止并行资源竞争后，完整 Worker 文件单独重跑 64 项全部通过。插件测试会输出既有的 `p2pkh.wallet.provider` i18n missing-key warning，但没有测试失败，且该 key 使用不属于本轮真值分层返修引入的差异。第 17 节及 17.6 的阻断项均已关闭，当前没有已知阻断问题。
