# Keymaster P2PKH.Transfer V1（草案）

本文档定义 Keymaster 对外协议 `p2pkh.transfer` 方法。

## 能力

- **主网 BSV P2PKH 受控转账**：从 session 绑定 owner 对应的主网
  P2PKH 余额中，向一个主网 P2PKH 地址转账指定 satoshis。
  施工单 2026-06-28 002 硬切换：资金 owner 取自 `connectSession.ownerPublicKeyHex`，
  **不**读取钱包全局 active key。
- 受控含义：site 不允许自带确认文案 / 不允许传 assetId / network /
  aud / text / feeRate / allowUnconfirmed / rawTx / changeAddress 等
  字段；Keymaster 自己做决策。
- 必须携带 `connectSessionId`（002 硬切换）；缺该字段直接
  `invalid_request` 拒绝，**不**fallback 到 active key。

## 请求

```ts
type P2pkhTransferParams = {
  recipientAddress: string;   // 主网 P2PKH base58check（version 0x00）
  amountSatoshis: number;     // 正整数
  feeRateSatoshisPerKb?: number; // 可选；>= 1
  connectSessionId: string;   // 必填（002 硬切换）
};
```

## 成功结果

```ts
type P2pkhTransferResult = {
  txid: string;
  rawTxHex: string;
  feeSatoshis: number;
};
```

## 错误

| 触发条件 | errorCode（对外） | failureReason（本地历史） |
| --- | --- | --- |
| 主网地址非法（version ≠ 0x00 / base58 解码失败） | `invalid_request` | — |
| `amountSatoshis` 非正整数 | `invalid_request` | — |
| 余额不足 / 无可用 UTXO | `user_rejected` | `insufficient_balance` |
| 站点地址非法（p2pkh signer 拒绝） | `user_rejected` | `invalid_address` |
| 内部错误 | `user_rejected` | `internal_error` |

**关键**：site 通过 `error.code` 与 `error.message` **永远**只能看到
`user_rejected` / `User rejected`；真实失败原因（特别是 `insufficient_balance`）
只在本地 `ProtocolCommandRecord.failureReason` 字段里。

## 自动确认（per-origin auto-approve）

按 origin 配置 `p2pkhAutoApproveEnabled` + `p2pkhAutoApproveMaxSatoshis`
决定是否走 auto-approve：

| 条件 | 命中 |
| --- | --- |
| `storageDb` 不可用 | 否（manual confirm） |
| origin 无配置（默认值） | 否（manual confirm） |
| `p2pkhAutoApproveEnabled !== true` | 否（manual confirm） |
| `amountSatoshis > p2pkhAutoApproveMaxSatoshis` | 否（manual confirm） |
| 全部满足 | **是**：popup 不弹确认页，结果写进命令历史 |

auto-approve 命中时，service 在 `tryAcceptFirstRequest` 直接进入
`executing` phase 并**异步**执行转账；UI 通过 `currentRequestAutoApproved()`
判断跳过 ConfirmView。

## 确认页（manual confirm）

popup 展示：

- 来源站点 origin
- 收款地址（recipientAddress）
- 转账金额（amountSatoshis）
- 当前 origin 的自动确认状态 badge：
  - `protocol.confirm.originSettingsBadge.off` / `on`
- 确认 / 取消两个按钮

确认文案由 Keymaster 自己生成（`protocol.confirm.method.p2pkh.transfer`），
**不接受 site 自带文案**——不允许 site 把"转账"伪装成"登录确认"或
"签名授权"。

## 命令历史摘要

| 字段 | 值 |
| --- | --- |
| `method` | `"p2pkh.transfer"` |
| `recipientAddress` | `params.recipientAddress` |
| `amountSatoshis` | `params.amountSatoshis` |
| `autoApproved` | `true` 当且仅当走了 auto-approve 路径 |
| `failureReason` | 失败时填（`insufficient_balance` / `invalid_address` / `invalid_amount` / `internal_error`） |

## DB 可用性差异化降级

- `storageDb` 不可用时：
  - `p2pkh.transfer` 仍可继续（auto-approve 关闭、manual confirm 仍工作）。
- `storageDb` 可用但 DB 写失败时：
  - 命令卡仍能在内存里走完完整流程；UI 顶部显示"历史不可用"。

## 不接受参数

```txt
assetId, network, aud, text, feeRate (默认由 service 兜底),
allowUnconfirmed, rawTx, changeAddress, signRequest, signatures
```

- `aud` 对这类方法没有必要；connect popup 已天然拿到 `event.origin`。
- `text` 不允许由 site 传入；确认文案由 Keymaster 自己生成。
- `assetId` / `network` 不引入（本次只做 `bsv` 主网）。
