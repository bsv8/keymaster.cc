# 003 P2PKH 本地提交观察层命名、广播回执归一化与表语义硬切换施工单

## 目标

一次性把当前 P2PKH 转账里的两张“看起来像链上真值、其实只是应用内观察层”的表，硬切换为下面这套精确定义：

```txt
链上真值
  = WOC 观察到的 UTXO / history / 广播是否被服务端接受

本地提交观察
  = 应用内发起过一次 submit 流程的本地记录
  = 不是链上是否成功的最终真值
  = 用户复制 rawTxHex 到外部广播时可以绕过

本地输入占用
  = 应用内为了防重复花费，对某次本地提交暂时占用的输入集合
  = 不是链上 spent 真值
  = 只服务应用内协调

广播回执
  = provider 是否接受
  + provider 返回的 txid 原始值
  + 本地 canonical txid 校验结果
```

本次是硬切换，不接受“先只改 UI 名字，表名和类型先保留”“先继续叫 pending / reservation，只在注释里解释”“先在 P2PKH 自己猜 WOC 字节序，WOC 契约以后再说”“先保留旧表，再双写一版新表过渡”这类中间态。

## 简述缘由

1. 当前 `p2pkh_pending_transfers` 与 `p2pkh_utxo_reservations` 这两个名字过于接近“链上事实表”，会误导维护者把它们当真值使用；而实际上它们是可以被用户手工广播绕过的。
2. 继续叫 `pending transfer`，容易让人误以为“表里有记录 = 链上已经发生，只是在等确认”；继续叫 `reservation`，容易让人误以为“这是一种更强的真值级保留”。这两者都不准确。
3. 你已经明确产品允许“preview 生成最终 rawTxHex，用户复制去外部网络手工提交”。一旦允许绕过应用内 `submit`，本地表就更不应该伪装成链上真值表。
4. 当前输入占用表与提交表之间主要靠 `spendingTxid` 关联，这会把“应用内一次提交尝试”和“链上最终 txid”混为一谈；尤其在 provider 回执字节序不一致或 unknown 广播分支下，会直接污染诊断语义。
5. 广播成功与否的判断应该拆成两层：
   - provider 是否接受
   - provider 返回的 txid 是否和本地 canonical txid 一致
   这两个概念现在还没有被契约清晰表达。
6. 如果这次只修一处字符串比较，不同时把表语义和命名收紧，后续开发仍然会继续把“本地提交观察层”误当成“链上交易事实表”。

## 硬切换结论

本次统一采用下面这套最终模型：

```txt
p2pkh_pending_transfers
  删除
  改名为 p2pkh_local_submissions

p2pkh_utxo_reservations
  删除
  改名为 p2pkh_local_input_claims

P2pkhPendingTransfer
  删除
  改名为 P2pkhLocalSubmission

P2pkhUtxoReservation
  删除
  改名为 P2pkhLocalInputClaim

claim / submission 关系
  以 submissionId 关联
  不再以 spendingTxid 作为主关系

WOC broadcast 返回
  先在 plugin-woc 归一化
  再提供给业务层消费
```

必须满足下面的不变量：

1. 本地提交观察层不是链上真值层；链上是否成功、是否确认，最终仍以 WOC recent-sync / history-backfill 观察为准。
2. 本地输入占用表不是链上 spent 真值；它只表示“应用内为了防重复花费，暂时 claim 了这些输入”。
3. `plugin-p2pkh` 不再直接处理 provider txid 的字节序怪癖；broadcast 回执归一化必须在 `plugin-woc` 完成。
4. 本地提交与本地输入占用的主关系键是 `submissionId`，不是 `txid`。
5. 业务层允许三种广播收敛结果：
   - provider 接受且 txid 完整一致
   - provider 接受但 txid 只是字节序相反，规范化后一致
   - provider 接受但 txid 规范化后仍不一致，此时只能进入 `unknown / provider-inconsistent`
6. 不允许再使用 “pending / reservation / spendingTxid” 这套旧词继续表达本地观察层。

## 不能怎么做

1. 不能只改页面文案，把 IndexedDB store、TypeScript 类型、service 方法、测试 fixture 继续叫 `pending / reservation`。那只是把旧误导藏起来。
2. 不能把新表叫“提交成功信息表”。这些记录不等于链上成功，unknown / rejected / provider-inconsistent 都是合法状态。
3. 不能继续让输入占用表靠 `spendingTxid` 主关联到一笔提交。链上 txid 是链上标识，不是应用内提交主键。
4. 不能在 `plugin-p2pkh` 里各处自己 reverse txid 猜 provider 口径。字节序归一化必须集中在 `plugin-woc`。
5. 不能因为 provider HTTP 成功，就无条件把本地状态推进为 `broadcast`。如果返回 txid 规范化后仍和 canonical txid 不一致，必须显式标出 provider 回执不可信。
6. 不能为了“保留旧本地观察”而伪迁移老 store 数据，如果新模型必需字段（如 `rawTxHex`、`providerReturnedTxidRaw`、`submissionId`）根本不存在。伪迁移比直接丢弃更危险。
7. 不能把 `local_input_claims` 金额或状态折算进余额真值。余额仍只来自当前 UTXO 快照。
8. 不能把“外部手工广播成功但应用内没有记录”当成数据损坏。那是产品允许路径，不应被新命名掩盖。
9. 不能保留旧 store 名作为长期兼容 alias。只要 alias 还在，旧语义就会借尸还魂。
10. 不能只改 P2PKH，不改 `contracts/woc.ts` 与 `plugin-woc`。广播回执归一化属于跨包契约，不是业务插件私有细节。

## 应该怎么做

### 一、收缩命名：把“本地提交观察层”从名字上说清楚

在 [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1)：

1. 删除 `P2pkhPendingTransfer`，新增：

```ts
export interface P2pkhLocalSubmission {
  id: string; // submissionId
  resourceId: string;
  keyId: string;
  publicKeyHash: string;
  network: BsvNetwork;
  assetId: P2pkhAssetId;
  canonicalTxid: string;
  rawTxHex: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
  recipientAddress: string;
  amountSatoshis: number;
  status: "submitting" | "broadcast" | "confirmed" | "failed" | "unknown" | "provider-inconsistent";
  inputOutpoints: Array<{ txid: string; vout: number; value: number }>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
```

2. 删除 `P2pkhUtxoReservation`，新增：

```ts
export interface P2pkhLocalInputClaim {
  id: string;
  submissionId: string;
  resourceId: string;
  keyId: string;
  publicKeyHash: string;
  network: BsvNetwork;
  txid: string;
  vout: number;
  canonicalTxid?: string;
  state: "claimed" | "observed-consumed" | "released";
  createdAt: string;
  updatedAt: string;
  missingObservationCount?: number;
}
```

3. 所有 service / db / page / widget / test 的命名同步切到 `local submission / local input claim`。

设计缘由：

```txt
名字不是装饰；名字就是契约。
只要名字还像链上真值表，后续就一定会有人把它当真值使用。
```

### 二、DB schema 硬切换到 v6，旧 store 直接退场

在 [packages/plugin-p2pkh/src/p2pkhDb.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.ts:1)：

1. DB version 从 `5` 升到 `6`。
2. 删除旧 store：

```txt
p2pkh_pending_transfers
p2pkh_utxo_reservations
```

3. 新建新 store：

```txt
p2pkh_local_submissions
p2pkh_local_input_claims
```

4. 新 store 索引建议：

`p2pkh_local_submissions`
- `resourceId`
- `status`
- `canonicalTxid`
- `txidIntegrity`

`p2pkh_local_input_claims`
- `resourceId`
- `submissionId`
- `state`
- `canonicalTxid`

5. 本次**不做旧数据迁移**，而是明确丢弃旧表数据。

设计缘由：

```txt
旧 pending / reservation 行没有新模型要求的关键字段：
  - rawTxHex
  - providerReturnedTxidRaw
  - providerReturnedTxidNormalized
  - txidIntegrity
  - submissionId 主关系

继续迁移只会制造伪精确语义。
```

### 三、WOC 广播回执归一化收口到 `plugin-woc`

在 [packages/contracts/src/woc.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/woc.ts:1) 与 [packages/plugin-woc/src/wocActor.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/wocActor.ts:1)：

1. `WocBroadcastResult` 不再只返回一个裸 `txid`，建议扩成：

```ts
export interface WocBroadcastResult {
  accepted: true;
  canonicalTxid: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
}
```

2. `plugin-woc` 的 `broadcast(network, rawTxHex, ...)` 内部：
   - 先从 `rawTxHex` 计算 canonical txid
   - 再读取 provider 原始返回值
   - 判断：
     - 原值是否等于 canonical
     - 反转字节序后是否等于 canonical
     - 两者都不等则 `mismatch`
   - 统一把 `canonicalTxid` 返回给上层

3. `plugin-p2pkh` 不再直接做：
   - `broadcastRes.txid !== preview.txid`
   - `reverseHex(...)`
   - 任何 provider 字节序猜测

设计缘由：

```txt
provider 协议适配是 WOC 包职责，不是 P2PKH 业务职责。
只要归一化不收口，上层每个业务插件都会重复踩同一个坑。
```

### 四、P2PKH submit 流程改为“写本地提交观察”，不是“写 pending transfer”

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)：

1. `submitTransfer(preview)` 开始时写入 `local submission`，状态为 `submitting`。
2. 写入内容必须包含：
   - `canonicalTxid = preview.txid`
   - `rawTxHex = preview.rawTxHex`
   - `recipientAddress`
   - `amountSatoshis`
   - `inputOutpoints`
3. 收到 `WocBroadcastResult` 后：
   - `exact / reversed`
     - `status = "broadcast"`
     - 更新 provider 返回字段与 integrity
   - `mismatch`
     - `status = "provider-inconsistent"` 或 `unknown`
     - 仍写本地 input claim，防止应用内重复花费
     - 触发高优先级 recent-sync，等待链上真值收敛
   - provider reject
     - `status = "failed"`
     - 不写 input claim
4. `local input claim` 的主关系是 `submissionId`，不是 `spendingTxid`。

### 五、recent-sync / 页面 / widget 的词汇也要一并收口

在：

- [packages/plugin-p2pkh/src/p2pkhRecentSync.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhRecentSync.ts:1)
- [packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx:1)
- [packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhHistoryPage.tsx:1)
- [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
- [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)

必须把：

```txt
pending transfer
reservation
spending txid
```

这套旧词统一改成：

```txt
local submission
local input claim
submission id
canonical txid
provider txid integrity
```

这一步不能偷懒。  
如果 UI 还在叫 reservation，底层换名的意义会被稀释掉。

### 六、旧数据升级策略：直接丢弃本地观察层，依赖链上真值重建

本次 schema v6 升级时：

1. 不迁移旧 `pending_transfers / utxo_reservations`。
2. 升级完成后立即触发一次高优先级 `recent-sync`。
3. 允许出现“旧应用内本地 claim 丢失，但链上数据稍后会收敛回来”的窗口。

设计缘由：

```txt
这两张表本来就不是链上真值。
名字和结构都错的时候，保旧比清空更危险。
```

## 文件级实施

### 合同与类型

1. [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1)
   - 删除 `P2pkhPendingTransfer / P2pkhUtxoReservation`
   - 新增 `P2pkhLocalSubmission / P2pkhLocalInputClaim`
2. [packages/contracts/src/woc.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/woc.ts:1)
   - 扩 `WocBroadcastResult`

### DB 与持久化

1. [packages/plugin-p2pkh/src/p2pkhDb.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.ts:1)
   - schema 升到 v6
   - 删除旧 store
   - 新建 `local_submissions / local_input_claims`
   - 重写 CRUD 接口
2. [packages/plugin-p2pkh/src/p2pkhDb.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.test.ts:1)
   - 覆盖 v6 schema 与 store 名

### WOC 广播适配

1. [packages/plugin-woc/src/wocActor.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/wocActor.ts:1)
   - broadcast 回执 txid 归一化
2. [packages/plugin-woc/src/wocService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/wocService.ts:1)
   - 透传新契约
3. [packages/plugin-woc/src/wocService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-woc/src/wocService.test.ts:1)
   - 覆盖 exact / reversed / mismatch

### P2PKH 服务与页面

1. [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)
   - submit 流程改写到 local submission / local input claim
2. [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)
   - 列表 / 查询接口改名
3. [packages/plugin-p2pkh/src/p2pkhRecentSync.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhRecentSync.ts:1)
   - 对账逻辑从 reservation/pending 转为 local claim/submission
4. [packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhUtxosPage.tsx:1)
   - 表头与状态名改词
5. [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
   - 广播结果与说明改词
6. [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)
   - i18n 资源同步改词

### 测试

1. [packages/plugin-p2pkh/src/p2pkhTransferService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.test.ts:1)
   - 覆盖 local submission / local input claim
   - 覆盖 provider 回执 reversed / mismatch
2. [packages/plugin-p2pkh/src/p2pkhSigner.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSigner.test.ts:1)
   - 保留 canonical txid 计算测试

## 特殊情况提前约定

### 情况 1：用户手工广播 preview 的 rawTxHex

处理原则：

```txt
允许
本地可以完全没有 local submission / local input claim
链上真值以后由 WOC 收敛
```

应该这样做：

1. 不因为“只是生成 preview”就写本地观察层。
2. 如果用户之后再在应用内发起一笔冲突交易，广播失败属于预期行为。
3. recent-sync / history-backfill 观察到链上交易后，按链上真值收敛 UTXO 与 history。

### 情况 2：provider 接受广播，但返回 txid 字节序相反

处理原则：

```txt
归一化后视为成功
这不是业务失败
```

应该这样做：

1. `plugin-woc` 识别 reversed 口径。
2. 上层拿到 `canonicalTxid` 与 `txidIntegrity = "reversed"`。
3. `plugin-p2pkh` 正常推进到 `broadcast`。

### 情况 3：provider 接受广播，但返回 txid 归一化后仍不一致

处理原则：

```txt
不能当作正常 broadcast
也不能当作 definitive reject
应进入 provider-inconsistent / unknown
```

应该这样做：

1. 本地 submission 记下：
   - canonical txid
   - provider raw txid
   - normalized txid
   - integrity = mismatch
2. 本地 input claim 仍然写入，避免应用内立即重复花费。
3. 立刻触发高优先级 recent-sync，等待链上真值确认。

### 情况 4：升级到 v6 时本地还有旧 pending / reservation

处理原则：

```txt
直接丢弃旧观察层
不要伪迁移
```

应该这样做：

1. schema upgrade 删除旧 store。
2. 首次启动后主动 recent-sync。
3. 文档明确说明：若升级前正好有 unknown 广播，升级后本地 claim 可能暂时消失，但链上真值仍会收敛回来。

### 情况 5：应用内 submit 刚开始，provider 立即 reject

处理原则：

```txt
写 local submission failed
不写 local input claim
```

应该这样做：

1. submission 记录保留为失败诊断。
2. 不要制造假的 input claim。

### 情况 6：active key 切换或 key 删除后，仍有旧 local submission / claim

处理原则：

```txt
它们是旧 key namespace 的本地观察层
不能污染新 active key 语义
```

应该这样做：

1. 查询始终按当前 key namespace 过滤。
2. 新 active key 不读取旧 key 的 local submission / claim。

## 最终验收清单

- [ ] `p2pkh_pending_transfers` store 已删除，不再出现在 schema、代码、测试、文档中。
- [ ] `p2pkh_utxo_reservations` store 已删除，不再出现在 schema、代码、测试、文档中。
- [ ] 新 store 为 `p2pkh_local_submissions` 与 `p2pkh_local_input_claims`。
- [ ] `P2pkhPendingTransfer / P2pkhUtxoReservation` 类型已删除。
- [ ] `P2pkhLocalSubmission / P2pkhLocalInputClaim` 成为唯一观察层契约。
- [ ] 本地提交与本地输入占用通过 `submissionId` 关联，不再以 `spendingTxid` 为主关系。
- [ ] `WocBroadcastResult` 已扩展为 canonical txid + provider raw txid + integrity 结果。
- [ ] `plugin-woc` 已统一处理 txid 字节序归一化。
- [ ] `plugin-p2pkh` 不再自行 reverse txid 猜 provider 口径。
- [ ] provider 返回 reversed txid 时，应用内广播仍能正常推进为 `broadcast`。
- [ ] provider 返回 mismatch txid 时，不会误判为正常 broadcast；本地状态进入 `provider-inconsistent / unknown`。
- [ ] 旧 `pending / reservation / spending txid` 文案已从页面和 i18n 中清除。
- [ ] UI 已明确把这些记录称为“本地提交 / 本地输入占用”，不再暗示链上真值。
- [ ] schema v6 升级时不会伪迁移旧观察层数据，而是明确删除旧 store。
- [ ] 升级后 recent-sync 能重新收敛链上真值，不依赖旧观察层残留。
- [ ] `plugin-woc` 与 `plugin-p2pkh` 的相关测试已覆盖 exact / reversed / mismatch / reject 四类广播结果。

## 本单优先级

本单一旦实施，旧的 `pending transfer / reservation` 语义全部作废。  
后续凡是涉及“应用内提交记录”“本地输入占用”“广播回执 txid 校验”的设计、命名、测试与排错，都以本单为准。
