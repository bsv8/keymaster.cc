# Keymaster FeePool V1（草案）

本文档定义 Keymaster 对外协议 `feepool.prepare` 与 `feepool.commit`
两步费用池方法族。

## 能力

- 双端（2-of-2）多签费用池；服务方为 `counterpartyPublicKeyHex`。
- Site 不管理池状态；site 只提交：
  - `counterpartyPublicKeyHex`（33-byte compressed secp256k1 hex）
  - `amountSatoshis`：**本次想转给对端的金额**（satoshis；语义在三种 action 下统一）
  - `connectSessionId`：本次 transfer 所属 connect session（002 硬切换）
- Keymaster 决定本次 action（`create` / `spend` / `close_and_recreate`）；
  累计维护 B-Tx 草稿。
- Site 把签名任务交给对端 / 自己处理，回签通过 `feepool.commit` 提交。
- Keymaster 完成最终落地 + 更新 `feePools` store。
- **owner 真值**：feepool 走 session 绑定 owner（`connectSessionId` 对应
  `ownerPublicKeyHex`），**不**读取钱包全局 active key。建池资金来源
  与签名 key 都按 session owner 走，**不**错位。

## 关键不变量（V4 收口）

1. **两笔 tx + 持续协商的 B-Tx 草稿**（V4 真实模型）：
   - **A-Tx（base tx，建池时定）**：client P2PKH UTXO → 2-of-2 multisig output；
     池大小 = multisig output 总额 = `feePoolDefaultFundSatoshis`。
     仅 client 签（funding inputs）；**不需要** server sig。
   - **B-Tx（spend 草稿）**：multisig output → server + client change。
     持续协商的草稿；不是最终已广播的 tx。
2. `operationId` 只在当前 popup 会话内存中有效；popup 刷新 / 关闭 /
   崩溃后 operationId 失效。
3. 不持久化 `operations` store；pending operation 不进 IndexedDB。
4. 不允许中间子会话协议。
5. 费用池状态 key 必须包含 `counterpartyPublicKeyHex` 与 owner
   `ownerPublicKeyHex`（施工单 2026-06-28 002 硬切换）：
   `${origin}::${ownerPublicKeyHex}::${counterpartyPublicKeyHex}`；
   同一 origin 不同 owner 不再串池。
6. `feepool.commit` 的 `operationId` 不能跨 origin / 跨 session /
   跨 owner 复用。
7. 不引入协议级心跳、MessageChannel、嵌套 request 子会话。
8. 不允许新增对外错误码。
9. **`amountSatoshis` 一律 = 本次 transfer 金额**（三种 action 统一）。
10. **决策：累计 `serverAmount`（不是单次 `amountSatoshis`）+ 与 `totalAmount` 比较**。
11. **spend 不删池**；只更新同一条 pool record（累计 `serverAmount` + 草稿）。
12. **close_and_recreate 不用 dust spend 路径**；用 SDK `loadTx` 把旧 B-Tx
    草稿切到 `FINAL_LOCKTIME` 最终版本，再建新池。
13. `feepool.prepare` / `feepool.commit` **必须**携带 `connectSessionId`
    （002 硬切换）；签名主体公钥与建池 UTXO 选币都按 session 绑定
    owner 走，**不**读取全局 active key。

## 三个量的关系（V4 关键）

| 量 | 含义 | 来源 |
| --- | --- | --- |
| `feePoolDefaultFundSatoshis` | 池大小策略 | per-origin `ProtocolOriginSettingsRecord`（**不是** site 请求；Keymaster 单边） |
| `amountSatoshis` | 本次 transfer 金额 | site `params.amountSatoshis`（三种 action 统一） |
| `totalAmount`（record） | 池大小 = A-Tx multisig output 总额 | create / close_and_recreate 时 = `feePoolDefaultFundSatoshis`；spend 不变 |
| `serverAmount`（record） | 累计已分配给 server 的金额 | `prior.serverAmount + amountSatoshis` 的累加结果；永远 `<= totalAmount` |

决策：`prior.serverAmount + amountSatoshis <= prior.totalAmount` → spend；
否则 close_and_recreate。

## `feepool.prepare`

### 请求

```ts
type FeepoolPrepareParams = {
  counterpartyPublicKeyHex: string;  // 33-byte compressed secp256k1 hex
  amountSatoshis: number;            // 本次 transfer 金额
  connectSessionId: string;          // 必填（002 硬切换）
};
```

**site 不传**：`action` / `lockHeight` / `aud` / `text` / `network` /
`assetId` / `feeRate` —— Keymaster 单边决定。

### action 决策（Keymaster 单边）

| 池状态 | 决策 |
| --- | --- |
| 无 prior | `create` |
| 有 prior，`prior.serverAmount + amountSatoshis <= prior.totalAmount` | `spend` |
| 有 prior，且累加超出 `totalAmount` | `close_and_recreate` |

### 三种 action 实际构造的 tx（V4 关键）

| action | close 旧 B-Tx 草稿（FINAL_LOCKTIME）| 新池 A-Tx（base）| 新 B-Tx 草稿（initial）|
| --- | --- | --- | --- |
| `create` | — | ✓（feePoolDefaultFundSatoshis）| ✓（initial；serverAmount = amountSatoshis）|
| `spend` | — | — | **不是**构造新 tx；用 SDK `loadTx` 在 prior draft 上 `serverAmount += amountSatoshis` 再 client 重签（**关键**：sequenceNumber 不能传 0；SDK 用 `input.sequence || 1` 计算 sighash，0 会导致 preimage 与实际 sequence 不一致）|
| `close_and_recreate` | ✓（prior draft 切到 `FINAL_LOCKTIME` 最终版本）| ✓（feePoolDefaultFundSatoshis）| ✓（initial；serverAmount = amountSatoshis）|

**核心**：spend **不是**构造新的独立 spend tx；是在同一个 B-Tx 草稿上
修改 `serverAmount` 字段并重新签名。

**关键（V5 收口）**：`close_and_recreate` 的 close 部分 `serverAmount` **只是
`prior.serverAmount`**（旧池已累计金额；close 兑现旧池内的累计）。新请求
的 `amountSatoshis` 由新池的初始 B-Tx 草稿承接，**不**进 close。SDK `loadTx`
不做上限检查——close.serverAmount 如果超出 prior.totalAmount，change 输出
会变成负数，签名失败。

### 成功结果

```ts
type FeepoolPrepareResult = {
  operationId: string;
  action: ProtocolFeePoolAction;
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
  /** create / close_and_recreate：建新池 A-Tx hex */
  baseTxHex?: string;
  baseTxOutputIndex?: number;
  /** 三种 action 都有：主 B-Tx 草稿 hex（不是已广播的最终 tx）*/
  draftSpendTxHex: string;
  draftClientSignBytes: BinaryField;
  /** 仅 close_and_recreate：旧 B-Tx 草稿切到 FINAL_LOCKTIME 最终版本 */
  closeDraftTxHex?: string;
  closeClientSignBytes?: BinaryField;
  priorPoolRecord?: {
    baseTxid: string;
    totalAmount: number;
    serverAmount: number;
  } | null;
};
```

## `feepool.commit`

### 请求

```ts
type FeepoolCommitParams = {
  operationId: string;
  counterpartyPublicKeyHex: string;
  connectSessionId: string;          // 必填（002 硬切换）
  /** 主 B-Tx 草稿的 server sig（create 走 initial，spend 走 update） */
  counterpartySignatures: BinaryField[];
  /** 仅 close_and_recreate：旧 B-Tx 草稿切到 FINAL_LOCKTIME 的 server sig（update sig）*/
  closeCounterpartySignatures?: BinaryField[];
};
```

V4 移除 `baseCounterpartySignatures`（base tx 仅 client 用 P2PKH UTXO
funding 签；server 不参与 base tx 的签名）。

### 验签矩阵

| action | 验什么 | sig 类型 |
| --- | --- | --- |
| `create` | 主 B-Tx 草稿 | initial spend sig |
| `spend` | 主 B-Tx 草稿（更新版）| update sig |
| `close_and_recreate` | close 草稿（旧池 final）+ 主 B-Tx 草稿（新池）| update sig + initial spend sig |

### 成功结果

```ts
type FeepoolCommitResult = {
  operationId: string;
  action: ProtocolFeePoolAction;
  /** 主 B-Tx 草稿的 txid；明确是"草稿"语义（不是已广播的最终 tx）*/
  draftTxid: string;
  draftTxHex: string;
  poolRecord: ProtocolFeePoolRecord | null;
  /** 仅 close_and_recreate：旧池 close 草稿的 txid */
  closeDraftTxid?: string;
};
```

### store 变更

| action | 行为 |
| --- | --- |
| `create` | `putFeePool(newRecord)`（totalAmount = pool size，serverAmount = amountSatoshis）|
| `spend` | `putFeePool` 覆盖同一条 pool record（totalAmount 不变；serverAmount += amountSatoshis；draftSpendTxHex 更新）|
| `close_and_recreate` | `putFeePool(newRecord)` 覆盖同一条 pool record（同 key；新池替换旧池）|

**关键**：spend **不**删池；close_and_recreate 用 `putFeePool` 覆盖代替 `deleteFeePool` + `putFeePool`（同 key 操作更快）。

## 错误与隐私

| 触发条件 | errorCode（对外） | failureReason（本地历史） |
| --- | --- | --- |
| `counterpartyPublicKeyHex` 不是 66 hex 字符 | `invalid_request` | — |
| `amountSatoshis` 非正整数 | `invalid_request` | — |
| `amountSatoshis > totalAmount`（create / close_and_recreate）| `user_rejected` | `internal_error` |
| `amountSatoshis > prior.totalAmount - prior.serverAmount`（spend）| `user_rejected` | `internal_error` |
| `operationId` 未在当前 session 注册 | `user_rejected` | `unknown_operation` |
| `operationId` 来自不同 origin | `user_rejected` | `cross_origin_operation` |
| 池记录不存在（spend / close_and_recreate）| `user_rejected` | `fee_pool_not_found` |
| 任意一段 server sig 验签失败 | `user_rejected` | `internal_error` |
| `storageDb` 不可用 | `user_rejected` | `fee_pool_db_unavailable` |
| `create` 命中但 origin 的 `feePoolDefaultFundSatoshis === 0` | `user_rejected` | `internal_error` |

**关键**：site 通过 `error.code` 与 `error.message` **永远**只能看到
`user_rejected` / `User rejected`；真实失败原因只在本地
`ProtocolCommandRecord.failureReason` 字段里。

## 自动签名（per-origin auto-sign）

按 origin 配置 `feePoolAutoSignMaxSatoshis` 决定是否走 auto-sign：

| 条件 | 命中 |
| --- | --- |
| `storageDb` 不可用 | 否（manual confirm） |
| origin 无配置 / `feePoolAutoSignMaxSatoshis === 0` | 否（manual confirm） |
| `amountSatoshis > feePoolAutoSignMaxSatoshis` | 否（manual confirm） |
| 全部满足 | **是**：`feepool.prepare` 与 `feepool.commit` 都跳过 ConfirmView |

`feepool.commit` 的 auto-sign 金额判断（V4 关键修复）：

> `feepool.commit` 请求里**没有** `amountSatoshis` 字段。auto-sign 判断
> 必须从 `pendingOps.get(operationId)?.amountSatoshis` 读 prepare 阶段
> 已经决策好的金额；**不能**从 request params 读（永远拿到 0/undefined）。

## 命令历史摘要

| 字段 | `prepare` | `commit` |
| --- | --- | --- |
| `method` | `"feepool.prepare"` | `"feepool.commit"` |
| `action` | ✓ | ✓ |
| `counterpartyPublicKeyHex` | ✓ | ✓ |
| `amountSatoshis` | ✓（transfer 金额） | — |
| `operationId` | — | ✓（指向 prepare 的 op） |

## V1 已知简化

- **不真广播**：commit 阶段把"已合并签名的 tx"当作落地写 store；真实
  广播留给后续 `plugin-multisigpool` 接入。**本次施工单明确标记
  "协议骨架已落，链上落地未完成"**。
- **V1 简化下新池大小 = `feePoolDefaultFundSatoshis`**；不做"池大小 >=
  transfer 金额"的复杂校验。V1 假设 site 知道池大小并据此发 amountSatoshis。
- **close_and_recreate 的 close 部分 serverAmount = `prior.serverAmount`**
  （V5 关键）：只兑现旧池已累计的金额；新请求 `amountSatoshis` 由新池
  初始 B-Tx 草稿承接。**不**是把新请求金额加进 close。
- **spend action 用固定的非零 sequenceNumber（V5 关键）**：V1 用
  `0xfffffffe`（"近未来"），保证 SDK `loadTx` 出来的 sequence 与 sighash
  preimage 计算的 sequence 一致（SDK 用 `input.sequence || 1`，
  0 会让 preimage 按 1 算而实际 sequence 是 0，签名验证不过）。
- **DB 升级 v2 → v3（V5 关键）**：`onupgradeneeded` 直接 **delete + recreate**
  `feePools` store。旧 v2 记录没有 `draftSpendTxHex` / `draftClientSignBytes`
  字段，进入新版 `spend` 路径读 `prior.draftSpendTxHex` 会拿到 undefined，
  后续 `loadTx(undefined, ...)` 抛错；新版不会自动迁移数据。site 第一次
  重新发起 transfer 时按新模型重建池即可。
- **spend action** 总是更新同一条 pool record（不构造新 spend tx；
  不存在"多笔 transfer 共享一个池"的复杂历史）。
- MultisigPool SDK 通过 `keymaster-multisig-pool@1.5.0` + `@bsv/sdk@^1.6.12`
  接入；测试通过 mock 屏蔽 SDK 直接调用验证 service 状态机；真实链上
  交互由后续 `plugin-multisigpool` 包提供。
