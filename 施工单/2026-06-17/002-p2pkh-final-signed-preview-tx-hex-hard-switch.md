# 002 P2PKH 最终已签名预览、严格 `sats/kB` 矿工费与 `tx hex` 广播硬切换施工单

## 目标

一次性把当前 P2PKH 转账流程从“粗略预览 + 提交时再签名广播”的半成品模型，硬切换为下面这套单真值模型：

```txt
预览
  = 最终版
  = 最终输入集合
  = 最终输出集合
  = 最终矿工费
  = 最终找零
  = 最终 txid
  = 最终 rawTxHex
  = 只是尚未广播

矿工费输入
  = sats/kB
  = 严格按估算字节数换算
  = 最低只保底 1 sat
  = 不再有 500 sats 人工下限

submit
  = 只广播 preview 里已经生成好的 rawTxHex
  = 不再重签
  = 不再重算 fee
  = 不再改找零

链上真值
  = WOC 观察到的链上状态

本地 pending / reservation / history
  = 观察层
  = 不是链上真值
```

本次是硬切换，不接受“先把 500 改小一点过渡”“先继续返回未签名 preview，submit 再悄悄改交易”“先只显示 tx hex 但仍在 submit 重签”“先保留旧文案以后再收口”这类中间态。

## 简述缘由

1. 当前 `/transfer` 的用户心智已经把“预览”理解成“最终版，只差提交”。现实现却在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1) 里把签名放到 `submit()`，这会让 preview 失去承诺能力。
2. 当前矿工费输入框文案是 `sats/kB`，但实现却写死了 `Math.max(500, ceil(rate * 250 / 1000))`。这既不忠于用户输入，也不忠于“按费率计算矿工费”的语义。
3. 现在的 `500 sats` 硬下限不是施工单要求，而是实现自行拍的策略。它会直接把小额 testnet 转账判死，例如 `100 sats` 余额转 `50 sats`，即使 `1 sats/kB` 也会被强行抬成 `500 sats` fee reserve。
4. 如果 preview 不是最终版，用户就无法安全地复制 `tx hex` 去外部网络手工广播；而你已经明确要求这条路径是允许的。
5. 本地 `pending / reservation` 的职责是防止应用内重复花费，不是链上真值。如果用户绕过应用手工广播，应用短时间内不知道这件事是可以接受的；真正的真值收敛应交给 WOC recent-sync / history-backfill。
6. 继续保留“preview 只是粗估，submit 再偷偷重算”的设计，只会让转账 UI 永远不可验证，后续所有问题都会变成“页面看到的和实际上链的不是一笔交易”。

## 硬切换结论

本次统一采用下面这套最终模型：

```txt
prepareTransfer()
  不是“准备一个草稿”
  而是“生成最终已签名交易”

P2pkhTransferPreview
  不是未签名预览对象
  而是“已签名交易快照”

submitTransfer(preview)
  不是“再签一次再广播”
  而是“广播 preview.rawTxHex”

fee
  = max(1, ceil(serializedBytes * feeRateSatoshisPerKb / 1000))

change
  = totalInput - amount - fee
  = 只要 > 0 就保留为真实找零输出
  = 不允许为了省事把小找零吞进矿工费
```

必须满足下面的不变量：

1. `prepareTransfer()` 返回后，`allocation / outputs / estimatedFeeSatoshis / txid / rawTxHex` 必须已经稳定，`submitTransfer()` 不允许再改。
2. `submitTransfer()` 只接收 preview，不再接收原始 form input；广播以 preview 为唯一输入。
3. `feeRateSatoshisPerKb` 的最小合法值是 `1`，不是 `0`，也不是隐藏兜底 `500 sats`。
4. 矿工费必须按交易最终字节数计算，不允许继续写死 `250 bytes`。
5. 只要 `changeSatoshis > 0`，就必须保留找零输出；不能把小找零并入矿工费。
6. preview 必须展示最终 `rawTxHex`，用户复制后可自行广播；应用必须接受“链外先广播、应用内后同步”的现实。
7. preview 本身不写本地 reservation；只有应用内走 `submitTransfer()` 开始广播时，才写 pending / reservation。
8. 如果 preview 生成后链上状态变化导致广播失败，`submitTransfer()` 只能报错，不能为了“帮用户成功”偷偷重选输入或重签另一笔交易。

## 不能怎么做

1. 不能只把 `Math.max(500, ...)` 改成 `Math.max(1, ...)`，但仍然保留固定 `250 bytes`。那只是把一个拍脑袋常量换成另一个拍脑袋常量。
2. 不能继续让 `submitTransfer(preview, input)` 接收 form input 并在内部重建交易。只要还接 form input，`submit` 就仍然有篡改 preview 的能力。
3. 不能把 preview 定义成“接近最终版”，然后在用户看不见的 submit 阶段改 fee、改找零、改 txid。带预览的产品里，这属于错误状态机。
4. 不能为了避免 1 sat 找零或很小找零，私自把这部分金额吞进矿工费。用户要求“是多少就是多少”，实现必须忠实。
5. 不能因为支持手工广播，就在 preview 阶段先写 reservation。那会把“只是看了一眼 tx hex 但没广播”的状态伪装成“已经占用 UTXO”。
6. 不能把本地 `pending / reservation` 设计成链上真值或余额真值。它们只是应用内防重复花费与收敛观察工具。
7. 不能把“外部已广播导致应用内再次提交失败”当作 bug 去自动修正。正确行为是广播报错，然后由同步收敛链上结果。
8. 不能继续保留 `p2pkh.transfer.description` 这种缺失 key 的文案路径。施工单必须同时收口这类已知 UI 破绽。
9. 不能只改 service，不改 Widget 文案。只要按钮还叫“准备预览 / 签名并广播”，用户就会被错误语义继续误导。
10. 不能让 allocator 继续带隐藏 fee policy default。矿工费策略必须只存在于 transfer service 一处。

## 应该怎么做

### 一、先收缩转账契约：preview 改成“已签名交易快照”

在 [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1)：

1. 保留 `P2pkhTransferInput` 作为用户输入，但 `submitTransfer()` 不再接收它。
2. `P2pkhTransferPreview` 扩成“最终已签名交易快照”，至少包含：
   - `assetId`
   - `network`
   - `recipientAddress`
   - `amountSatoshis`
   - `feeRateSatoshisPerKb`
   - `allocation`
   - `changeAddress`
   - `outputs`
   - `estimatedFeeSatoshis`
   - `serializedSizeBytes`
   - `txid`
   - `rawTxHex`
3. `P2pkhTransferResult` 继续表示广播结果，但 `rawTxHex` 应直接回显 preview 里的最终 hex，不再是 submit 临时签出来的新值。
4. `P2pkhService` 接口改为：

```ts
prepareTransfer(input: P2pkhTransferInput): Promise<P2pkhTransferPreview>;
submitTransfer(preview: P2pkhTransferPreview): Promise<P2pkhTransferResult>;
```

设计缘由：

```txt
只要 submit 仍能拿到原始输入，它就仍然可能重建另一笔交易。
把 submit 收窄为只吃 preview，是把“preview 即最终版”做成类型级约束。
```

### 二、删掉隐藏 fee 下限与固定 250 bytes，改成严格 `sats/kB` 换算

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)：

1. 删除：

```ts
Math.max(500, Math.ceil((feeRateSatoshisPerKb / 1000) * 250))
```

2. `feeRateSatoshisPerKb` 的输入校验改为：
   - 必须是正整数
   - 最小值为 `1`
3. fee 统一按下面公式：

```txt
estimatedFeeSatoshis
  = max(1, ceil(serializedSizeBytes * feeRateSatoshisPerKb / 1000))
```

4. `serializedSizeBytes` 不能再拍脑袋固定值，而要由 P2PKH 最终交易的输入数、输出数和真实签名字节决定。

设计缘由：

```txt
用户输入的是费率，不是最终 fee。
实现必须尊重这个单位，而不是借输入框文案之名，内部跑另一套固定费策略。
```

### 三、prepare 内部允许多次试算，但对外只返回稳定后的最终版一次结果

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1) 与 [packages/plugin-p2pkh/src/p2pkhSigner.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSigner.ts:1)：

1. prepare 阶段允许内部迭代，但这个迭代必须完全发生在 `prepareTransfer()` 内部，不能把不稳定中间态暴露给 UI。
2. 推荐流程：
   - 先过滤出当前可选 UTXO 候选集合
   - 逐步累加选币
   - 对每组已选输入，分别评估：
     - 单输出版本：只有收款输出
     - 双输出版本：收款输出 + 找零输出
   - 只要 `changeSatoshis > 0`，就必须选择双输出版本
   - 通过构造未签名交易并完成真实签名，拿到真实 `rawTxHex`
   - 以真实序列化大小反算 fee
   - 若真实 fee 使本次找零或输入选择发生变化，则在 prepare 内继续下一轮求解
   - 直到 `allocation / outputs / fee / txid / rawTxHex` 完全稳定，再把最终 preview 返回给 UI
3. 这个“多轮”只属于 prepare 内部实现细节；用户看到的 preview 必须只有稳定后的最终一版。

设计缘由：

```txt
经典钱包可以内部多次计算，但不能把“尚未稳定的预估版”交给用户。
对外承诺必须是一版最终版。
```

### 四、找零处理按金额守恒走，不吞小找零

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1) 与 [packages/plugin-p2pkh/src/p2pkhSigner.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSigner.ts:1)：

1. 如果最终 `changeSatoshis === 0`，交易只有收款输出。
2. 如果最终 `changeSatoshis > 0`，交易必须带找零输出，哪怕找零只有 `1 sat`。
3. 不允许引入：
   - dust 吞并分支
   - “小于某阈值改并入矿工费”分支
   - “为了更像标准钱包先吞掉”分支

本次明确以“金额守恒 + preview 最终版”为优先级。  
后续如果链上标准性需要额外约束，应作为另一份明确施工单处理，不能在本次顺手偷偷加入。

### 五、submit 只广播 preview，不能再重签

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)：

1. `submit(preview)` 只做：
   - 校验当前 active key 仍然是同一条 key namespace
   - 以 preview 中的 `rawTxHex` 调用 `woc.broadcast()`
   - 写 pending / reservation
   - 返回广播结果
2. 删除 submit 内部重新：
   - 派生 changeAddress
   - `buildP2pkhTx()`
   - `signP2pkhTx()`
3. preview 里已经有最终 `txid` 时，submit 只在广播成功后把 `spendingTxid` 从本地 pending id 更新为真正链上 txid；如果广播前后 txid 不一致，说明 preview 不是最终版，必须视为实现错误。

设计缘由：

```txt
submit 的职责是“把这笔交易发出去”，不是“再构造另一笔看起来差不多的交易”。
```

### 六、preview 展示最终 `tx hex` 与最终 `txid`

在 [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)：

1. 页面文案改名：
   - `准备预览` → `生成最终交易`
   - `签名并广播` → `广播交易`
2. preview 区必须展示：
   - 最终输入数量与输入总额
   - 最终收款输出
   - 最终找零输出
   - 最终矿工费
   - 最终序列化大小
   - 最终 `txid`
   - 最终 `rawTxHex`
3. 允许用户复制 `rawTxHex`。
4. feeRate 校验改成 `< 1` 直接报错，不允许再输入 `0`。
5. 预览错误不再直接裸露 `P2PKH allocation failed: insufficient`，而要转成带上下文的可读提示，例如：
   - `可用输入总额`
   - `转账金额`
   - `最终矿工费`
   - `总需求`

### 七、手工广播是允许路径，但不提前写 reservation

在 [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)：

1. `prepareTransfer()` 只返回最终 signed preview，不写：
   - pending transfer
   - reservation
2. `submitTransfer(preview)` 开始走应用内广播时，才写本地 pending / reservation。
3. 如果用户复制 preview 中的 `rawTxHex` 去链外手工广播：
   - 应用内本地记录可能不存在
   - 下次 recent-sync / history-backfill 观察到链上交易后，仍必须正确收敛 UTXO / history
   - 这不构成本地真值错误
4. 如果链外广播和应用内后续再次提交形成双花竞争，应用内广播失败是预期行为，不要自动补救为另一笔交易。

设计缘由：

```txt
preview 只代表“我已经把最终交易准备好了”，
不代表“应用已经正式接管它的广播生命周期”。
```

### 八、allocator 收回为纯函数，不再持有 fee policy

在 [packages/plugin-p2pkh/src/utxoAllocator.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.ts:1)：

1. 删除隐藏 `DEFAULT_FEE_RESERVE = 1000` 兜底语义，或至少不再让正式转账路径依赖它。
2. allocator 的职责只保留：
   - 基于调用方传入的候选集合
   - 基于调用方传入的明确 `feeReserveSatoshis`
   - 返回选币结果或 `required / available / feeReserve / reason`
3. fee policy、试算轮次、输出布局选择全部回收到 transfer service。

设计缘由：

```txt
allocator 负责选币，不负责制定矿工费政策。
把 fee policy 放在 allocator 里，只会让隐藏常量继续扩散。
```

### 九、补齐 i18n 与 offer 描述，消除当前已知控制台错误

在 [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1) 与 [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)：

1. 补齐当前缺失的 transfer 描述 key。
2. 不建议继续复用单一 `p2pkh.transfer.description` 给 main/test 两个 offer；推荐拆成：
   - `p2pkh.transfer.description.bsv`
   - `p2pkh.transfer.description.bsvtest`
3. 新增 preview 最终版所需文案：
   - 最终交易
   - 广播交易
   - 最终 txid
   - 最终 tx hex
   - 估算大小
   - 复制 hex
   - fee rate 必须至少为 1 sats/kB
   - 广播不会重签、不会改 fee 的说明

## 文件级实施

### 核心契约与服务

1. [packages/plugin-p2pkh/src/p2pkhContracts.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhContracts.ts:1)
   - 重定义 `P2pkhTransferPreview`
   - 收窄 `submitTransfer()` 签名
2. [packages/plugin-p2pkh/src/p2pkhTransferService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.ts:1)
   - 删除 `500 sats` 下限
   - 删除 submit 重签
   - 实现 prepare 内部稳定求解
   - 应用内广播才写 pending / reservation
3. [packages/plugin-p2pkh/src/utxoAllocator.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.ts:1)
   - 移除隐藏 fee policy default 语义
   - 保留纯选币职责
4. [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)
   - 适配新的 `prepareTransfer(input)` / `submitTransfer(preview)` 流程

### 签名与序列化

1. [packages/plugin-p2pkh/src/p2pkhSigner.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSigner.ts:1)
   - 增加真实 signed tx byte size 读取辅助能力
   - 增加 `rawTxHex -> txid` 本地计算能力
   - 如有必要，暴露最小辅助函数供 transfer service 在 prepare 内部稳定求解使用
2. [packages/plugin-p2pkh/src/p2pkhSigner.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSigner.test.ts:1)
   - 补 signed size / txid 计算测试
   - 验证两输出与一输出序列化大小可区分

### UI 与文案

1. [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
   - 改按钮语义
   - 展示最终 txid / rawTxHex / size / fee
   - 改 feeRate 校验
   - 改错误提示
2. [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1)
   - 补或拆分 transfer description key
3. [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)
   - 新增最终交易相关文案
   - 删除旧“预览即未签名草稿”的误导文案

### 测试补齐

1. [packages/plugin-p2pkh/src/utxoAllocator.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/utxoAllocator.test.ts:1)
   - 删除对隐藏默认 fee policy 的依赖
2. 新增 [packages/plugin-p2pkh/src/p2pkhTransferService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferService.test.ts:1)
   - 覆盖 preview 最终版语义
   - 覆盖 `1 sats/kB` 小额 testnet 成功
   - 覆盖 submit 不重签
   - 覆盖外部状态变化导致广播失败

## 特殊情况提前约定

### 情况 1：`feeRateSatoshisPerKb = 1`

处理原则：

```txt
合法
最终 fee 仍至少为 1 sat
不能再被 500 sats 下限抬高
```

应该这样做：

1. Widget 校验通过。
2. prepare 按真实最终字节数换算 fee。
3. 若字节数换算后不足 1 sat，则补齐到 `1 sat`。

### 情况 2：刚好无找零

处理原则：

```txt
只有收款输出
不是错误
```

应该这样做：

1. prepare 产出单输出交易。
2. preview 明确显示 `change = 0`。
3. submit 直接广播这笔最终 hex。

### 情况 3：找零非常小，但仍大于 0

处理原则：

```txt
保留找零输出
不能吞并入矿工费
```

应该这样做：

1. 只要 `changeSatoshis > 0`，就构造双输出交易。
2. preview 明确显示这个找零金额。
3. 不允许为了“更像钱包”私自改经济结果。

### 情况 4：用户复制 preview 的 `rawTxHex` 去链外手工广播

处理原则：

```txt
允许
本地此时可以没有 pending / reservation
链上真值以后由 WOC 收敛
```

应该这样做：

1. 应用不因为“只是生成 preview”就写本地 reservation。
2. 若用户之后再在应用里基于旧 UTXO 生成另一笔交易，冲突广播失败属于预期行为。
3. recent-sync / history-backfill 观察到链上交易后，正确更新：
   - UTXO 快照
   - history
   - pending 对账

### 情况 5：preview 生成后，链上状态变化，再点应用内广播

处理原则：

```txt
广播失败即可
不能偷偷重选输入
不能偷偷重签另一笔
```

应该这样做：

1. submit 只广播 preview.rawTxHex。
2. 若返回冲突、已花费、mempool reject 等错误，直接把错误展示给用户。
3. 后续 recent-sync 负责把本地观察收敛到链上真值。

### 情况 6：active key 切换后仍保留旧 preview

处理原则：

```txt
旧 preview 立即失效
不能拿旧 key 的最终交易去当前 key 上下文继续广播
```

应该这样做：

1. Widget 继续保留 active key 变化时清空 preview 的防御。
2. submit 前再次校验 preview 所属 key 上下文仍匹配当前 active key。

### 情况 7：prepare 内部第一轮估算不稳定

处理原则：

```txt
允许 prepare 内部多轮
不允许把半成品给用户
```

应该这样做：

1. prepare 内部反复构造 / 签名 / 反算字节数。
2. 直到结果稳定，再返回 preview。
3. 如果达到实现保护上限仍不稳定，直接抛错，不返回伪最终版。

## 最终验收清单

- [ ] `/transfer` 上的 P2PKH “预览”实际返回最终已签名交易，而不是未签名草稿。
- [ ] preview 区展示最终 `txid` 与最终 `rawTxHex`。
- [ ] `submitTransfer()` 只接收 preview，不再接收 form input。
- [ ] submit 不再重新派生 changeAddress、重建交易或重签。
- [ ] `500 sats` 下限已彻底删除。
- [ ] fee 只按 `max(1, ceil(serializedBytes * satsPerKb / 1000))` 计算。
- [ ] `feeRateSatoshisPerKb < 1` 会被前端校验拦截。
- [ ] 不再写死 `250 bytes` 作为最终 fee 估算依据。
- [ ] 只要 `changeSatoshis > 0`，最终交易就保留找零输出。
- [ ] 生成 preview 本身不会写本地 pending / reservation。
- [ ] 应用内点击广播时才写 pending / reservation。
- [ ] 用户手工广播 preview hex 后，后续 recent-sync / history-backfill 仍能把 UTXO 与历史收敛到链上真值。
- [ ] 链上状态变化导致旧 preview 广播失败时，应用只报错，不偷偷改交易。
- [ ] `P2PKH allocation failed: insufficient` 之类裸错误已改成带 `available / amount / fee / required` 的可读提示。
- [ ] `p2pkh.transfer.description` 或其替代 key 已补齐，不再出现 i18n missing key 控制台报错。
- [ ] Widget 按钮文案已从“准备预览 / 签名并广播”改成符合最终语义的命名。
- [ ] `1 sats/kB` 的 testnet 小额转账测试通过，例如 `100 sats` 余额转 `50 sats` 不再因为隐藏 `500 sats` 下限失败。
- [ ] `p2pkhSigner.test.ts`、`utxoAllocator.test.ts`、新增 `p2pkhTransferService.test.ts` 覆盖本次新真值。

## 本单优先级

本单一旦实施，旧的“preview 只是粗略草稿、submit 再签名修正”的认知全部作废。  
后续 P2PKH 转账相关实现、文案、测试、排错都以本单为准。
