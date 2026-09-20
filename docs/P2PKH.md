# P2PKH

P2PKH 管理普通 BSV 的地址、链上历史、本地提交、余额和转账。Token 与收藏品有自己的
业务状态，不把 P2PKH 的数据模型直接套到其他资产。

## 数据真值

```text
UTXO：WoC `unspent/all`（每个 owner + network + address 一次请求）
      → 严格校验 → Coordinator Worker 内存快照（唯一真值，不落盘）

历史：WoC confirmed history（分页）
      → 只保存 txid / height / fee 元数据（`<net>/history.json`，完整分页成功后整文件替换）

详情：打开交易详情页时按 txid 懒加载 raw transaction
      → 临时解析输入/输出用于展示，不写任何派生状态
```

设计缘由（2026-09-20 解耦）：历史同步与 UTXO 派生彻底分离。

- 历史同步不再下载 raw transaction、不构建归属输出、不回放花费关系、不计算余额。
- 余额不是表、不是持久化实体，只是基于内存 UTXO 快照的实时计算结果。
- 不再有链上事实表、归属输出投影、本地 UTXO overlay 或交易 DAG。

## UTXO 快照规则

- 快照只存在于 Coordinator Worker 内存，不写文件、不写 K-V。
- 每个 `owner + network + address` 调用一次 `GET /v1/bsv/<network>/address/<address>/unspent/all`。
- 新响应完整校验成功后原子替换旧快照；请求失败、超时、429、JSON 错误或字段冲突时
  保留旧快照，绝不把余额写成 0。
- 成功返回空 `result` 才表示余额为 0；冷启动尚未取得快照时余额是“未知/不可用”。
- `isSpentInMempoolTx=true` 的输出不进入可花费部分，也不参与选币。
- 未知 `status`、非法 txid/vout/value、同一 outpoint 内容冲突使整次快照失败。
- 锁定钱包、切换 Owner、销毁会话时清除对应内存快照。
- 免费档限流（约 3 请求/秒）由 WoC actor 统一限流、超时与 429 backoff 承担。

## 供应商

- 链上数据只有 WoC 一个来源：历史与 UTXO 直接调用 `WocService`，不再有确认同步供应商选择层。
- 广播边界保留：`broadcast provider`（当前为 WoC）经 registry 解析，提交交易时使用。
- 不再有 Provider generation；P2PKH 配置只有 includeTestnet、费率与 WoC 端点。

## 转账边界

- 准备交易前刷新一次 `unspent/all`；提交前再次刷新，并确认 preview 中的全部输入
  仍然存在且数值未变。
- 可花集合固定为：`WoC unspent/all − isSpentInMempoolTx − 本地 input claims − 协议保护 outpoints`。
- 同一进程内保留原子 input claim，防止两个并发提交选择同一个 UTXO。
- 本地广播产生的找零不再主动加入可花集合；只有 WoC 返回该找零后才能再次消费。
- 广播后立即触发一次后台刷新；刷新失败不释放输入 claim。
- 重启后没有本地 UTXO 缓存，必须重新请求 WoC 后才能转账。

## 本地交易

广播明确返回 accepted 或 already-known 后进入 `local-confirmed`（本地确认）。超时、拒绝或
网络异常进入 `isolated`（隔离），不能自动释放输入。历史记录只通过“相同 txid”把本地提交
标记为 `chain-confirmed`，不再根据输入关系派生 `conflicted`、后代失效或本地交易 DAG。

本地审计行永久保留，但默认列表不重复展示已经晋升的记录。

## 页面

| 页面 | 主网 | 测试网 |
| --- | --- | --- |
| 链上交易 | `/p2pkh/mainnet/transactions` | `/p2pkh/testnet/transactions` |
| 本地交易 | `/p2pkh/mainnet/local-transactions` | `/p2pkh/testnet/local-transactions` |

链上列表只展示 txid、高度、状态与观察时间；详情页懒加载 raw transaction 后展示完整
输入/输出。旧 `/p2pkh`、`history`、`utxos` 和 `tab=coins` 入口不再兼容。

## 安全边界

- 选币同时考虑快照可花输出、输入 claim 和受保护 outpoint。
- 广播结果未知时不自动重试，不用超时 TTL 解锁输入。
- 所有写入绑定 Owner、网络和会话 epoch。
- Connect 转账只使用会话 Owner，不读取钱包全局 active Key。
