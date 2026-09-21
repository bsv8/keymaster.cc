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

## 同步调度（智能调度）

P2PKH 的链上数据分成两个独立任务，互不阻塞：

| 任务 | 数据 | 调度方式 |
| --- | --- | --- |
| `p2pkh.utxo-snapshot` | BSV 余额来源（内存 UTXO 快照） | 智能：解锁/初始化后立即刷新一次；之后只要 WoC 队列空闲满 2 秒就刷新一轮 |
| `p2pkh.transactions-sync` | 链上历史元数据（txid / height / fee） | 同步管理：30 秒 / 1 分钟 / 5 分钟 / 关闭 |

- 智能调度的计时以「WoC 进程结束」为准：任何 WoC 请求开始都会打断计时，请求结束
  后重新计时 2 秒；429 backoff 期间自动推迟到 backoff 解除。因此余额总是尽量新，
  同时不会和用户操作抢 WoC 队列（用户请求优先级更高）。
- 同步管理在「设置 → 智能调度」中配置；「关闭」只关闭自动同步，托盘的
  「立即同步一次」仍然有效。
- 任务失败不会把余额写成 0：旧快照保留，等下一轮成功响应原子替换。

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

## 转账页收款方（已实现）

计划中的 `/transfer` 只处理普通 BSV（P2PKH），不混入 BSV-21 token 和 1Sat 收藏品；
BSV-21 通过独立的 `/assets/bsv21/transfer` 入口转账，1Sat 收藏品使用各自资产的转账入口。
页面把原来的「1 收款人 + 2 资产类型」合并为一个「收款方」
区块，资产类型不再由用户选择。

```text
收款方 = 身份（identity.publicKeyHex）或地址（destination.address）
       + 网络（network）
       -> 收款地址（最终真值，签名与广播只使用它）
```

- 地址是唯一支付真值；身份只用于派生地址、回填昵称和核对。
- P2PKH 范围内资产由网络唯一决定：主网 `bsv`，testnet `bsvtest`。
- 通讯录仍以 `publicKeyHex` 为唯一身份，不新增地址字段；地址是公钥 + 网络的派生投影，
  地址命中联系人靠「地址 hash160 与联系人公钥 hash160 比对」完成。

### 输入形态

| 输入 | 网络 | 收款地址 |
| --- | --- | --- |
| 通讯录联系人（publicKeyHex） | 默认主网，可切 testnet | 由公钥派生，只读 |
| 手工 publicKeyHex | 默认主网，可切 testnet | 由公钥派生，只读 |
| 手工地址 | 由地址 version 字节反推并锁定 | 即输入地址，只读 |

- 地址命中通讯录时回填昵称；未命中显示「陌生地址」。
- 非 P2PKH 格式地址直接拒绝，并提示使用对应资产入口。

### testnet 开关

P2PKH 设置 `includeTestnet=false`（默认）时：

- 不显示主网 / testnet 选择器，公钥模式直接派生主网地址；
- 手工输入 testnet 地址报错「未启用 testnet」；
- URL 上的 `network=testnet` 降级回主网。

`includeTestnet=true` 时才显示选择器；地址模式下选择器跟随地址网络且不可手动切换。

### 页面结构

```text
1 收款方（身份 / 地址 + 网络 + 最终地址）
2 金额与矿工费率（唯一输入区）
3 只读核对（地址 / 金额 / 费率 / 找零）-> 提交
```

核对区不承载任何输入控件；金额、矿工费率、收款来源都在进入核对前完成。
换收款人、换网络、改金额或费率都会使核对结果失效，必须重新核对。

### 入口参数

| 参数 | 含义 | 约束 |
| --- | --- | --- |
| `recipientPublicKeyHex` | 收款人公钥 | 通讯录动作与公钥跳转使用 |
| `recipientAddress` | 收款地址 | 优先于公钥；两者矛盾时阻断 |
| `network` | 网络 | 仅公钥模式有效；地址模式忽略，以地址 version 为准 |

以上设计已落地；页面当前仅挂载普通 BSV（P2PKH）转账入口。

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
