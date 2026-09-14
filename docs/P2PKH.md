# P2PKH

P2PKH 管理普通 BSV 的地址、已确认链上事实、本地提交、余额和转账。Token 与收藏品有自己的
业务状态，不把 P2PKH 的供应商模型直接套到其他资产。

## 数据真值

```text
选中的 confirmed provider（确认数据供应商）
→ 已确认交易 raw transaction
→ p2pkh_transactions（链上事实）
→ p2pkh_owned_outpoints（可重建的归属输出投影）

本地构造和广播
→ p2pkh_local_transactions / input_claims / local_outpoints
→ 区块事实最终裁决
```

`p2pkh_transactions` 是唯一确认事实；`p2pkh_owned_outpoints` 只用于快速查余额和可花输出，
损坏后必须能从事实重建。余额不是从供应商 UTXO 快照直接落库。

## 供应商

- confirmed provider：WOC 或 JungleBus，只负责读取已确认交易。
- broadcast provider：当前由支持广播的 Provider 负责提交交易。
- JungleBus 不提供广播、mempool 或订阅能力，不能出现在广播选择中。
- 每个网络分别保存选择；切换会推进 Provider generation（供应商代际），旧结果失效。

## 本地交易

广播明确返回 accepted 或 already-known 后进入 `local-confirmed`（本地确认），输入继续占用，
找零允许被下一笔普通 BSV 转账消费。超时、拒绝或网络异常进入 `isolated`（隔离），不能自动
释放输入或使用找零。

已确认链事实随后裁决本地记录：

- 同一 txid 入块：`chain-confirmed`（链上确认）。
- 竞争交易先入块：`conflicted`（链上冲突），同时使后代失效。
- 完整重叠同步确认重组：撤销旧区块结论并重算本地 DAG（交易依赖图）。
- 单次超时、404 或不完整分页不能触发链上回滚。

本地审计行永久保留，但默认列表不重复展示已经晋升的记录。

## 页面

| 页面 | 主网 | 测试网 |
| --- | --- | --- |
| 链上交易 | `/p2pkh/mainnet/transactions` | `/p2pkh/testnet/transactions` |
| 本地交易 | `/p2pkh/mainnet/local-transactions` | `/p2pkh/testnet/local-transactions` |

旧 `/p2pkh`、`history`、`utxos` 和 `tab=coins` 入口不再兼容。详情页使用
`/p2pkh/tx/:txid`，并通过来源参数返回正确列表。

## 安全边界

- 选币同时考虑已确认输出、本地找零、输入 claim 和受保护 outpoint。
- 广播结果未知时不自动重试，不用超时 TTL 解锁输入。
- 所有写入绑定 Owner、网络、会话 epoch 和 Provider generation。
- Connect 转账只使用会话 Owner，不读取钱包全局 active Key。
