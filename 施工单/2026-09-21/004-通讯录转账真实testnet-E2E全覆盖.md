# 004：通讯录 + 转账真实 testnet E2E 全覆盖（硬切换一次性落地）

> 日期：2026-09-21
>
> 状态：设计定稿，代码与 Journey 已实施；真实资源执行待验收
>
> 优先级：P1（资金安全回归：序号门禁、未派发保护、资金回收）
>
> 上游约束：
> [001 转账单](./001-transfer-收款方合并与P2PKH范围收敛.md)（收款方合并与网络规则，已实施 `3fbb7ca`）、
> [002 全局余额广播](./002-全局余额广播.md)（已实施 `c813234`）、
> [003 UTXO 序号门禁与中心广播服务](./003-UTXO序号门禁与中心广播服务.md)（已实施 `d5e6e79`）、
> [P2PKH 现行文档](../../docs/P2PKH.md)、[集成测试 README](../../docs/集成测试/README.md)

## 1. 背景与问题

今天的三个单子已全部落地，但真实 testnet 的 p2pkh Journey 没有同步升级：

1. `e2e/integration/drivers/p2pkhDriver.ts` 仍按旧 `/transfer` 编写：`openTransferPage` 等
   「资产类型」网格、`prepareAndBroadcast` 往可编辑的收款地址输入框填值。001 落地后
   `/transfer` 已没有资产网格、Widget 收款地址只读，**现有 `J-REAL-TESTNET-ROUNDTRIP` 实际已跑不通**。
2. 002（余额广播 / 金额旁可用余额参考）与 003（序号门禁 / 唯一广播出口 / sendAll 需重新确认）
   的页面级行为没有真实资金 Journey；现有单测覆盖状态机，但「页面快照衔接 + 链上输入衔接」是单测证不了的。
3. 覆盖矩阵尚未登记 002/003 的需求行，也没有对应真实资源场景，证据链缺口会一直保留。

## 2. 目标

新增一个覆盖 001+002+003 的 p2pkh Journey，并让旧的 roundtrip Journey 恢复可执行：

1. 真实链上完成 **3 笔固定金额 + 1 笔全部余额回收**，合计 4 次页面广播，最后把资金归集回 seed。
2. 覆盖收款方四种输入形态（通讯录、手工公钥、地址命中联系人、陌生地址）与 testnet 开关边界。
3. 覆盖 003 的 consumed 序号恢复、明确未派发不消费序号和 sendAll 重新确认边界；中心服务自动重建仍由 003 的 T26 单测覆盖。
4. 覆盖 002 的金额旁余额参考、跨 tab 刷新不覆盖输入、跨 tab testnet 开关。
5. 旧 `J-REAL-TESTNET-ROUNDTRIP` 迁移到新 UI/driver，不保留任何兼容旧 UI 的分支。

## 3. 硬切换说明（为什么不分步骤）

- driver 是三个 Journey 共用的；旧 driver 与新 UI 不可能同时成立，分步落地会让仓库在这两单之间
  **持续处于 p2pkh 测试全红**。
- 覆盖矩阵一次登记「新场景 + 两条新需求 + 旧场景迁移」，分步会出现「Journey 元数据引用不存在的需求」
  或「孤儿场景」直接触发 `check:integration-coverage` 失败。
- 真实 testnet Journey 每次执行都要占用 seed 资金和串行资源档；一次改完、一次跑通、一次验收
  比多轮「迁移一半再修」更省资金与时间。
- 因此：**所有改动必须在同一提交内完成，禁止留下旧 UI 分支、兼容函数或暂时跳过的断言。**

## 4. 冻结的不变量

### 4.1 允许与禁止

- [ ] 只允许改 e2e 目录、覆盖矩阵与文档；产品代码只允许一处：`TestnetFundingResource.prepare()`
  返回公开的 `seedPublicKeyHex`（它本来就是内部已派生的公开值），以及对应的公开状态投影。
- [ ] 禁止为了让测试变绿修改 `/transfer`、Widget、中心广播或余额广播的任何生产行为。
- [ ] 禁止在测试里访问 Coordinator、SharedWorker、插件 service 或 IndexedDB 内部真值；
  页面断言只走可见 UI，链上真值只走 Node 的 WoC 链适配器。
- [ ] 禁止新增 Coordinator topic、路由或能力；禁止使用旧 `/transfer` 资产网格选择器。
- [ ] 禁止把 seed 私钥、key01 私钥、密码、txid、rawTxHex 写入附件；附件只允许脱敏计时 JSON。
- [ ] 禁止用固定 `waitForTimeout` 代替可观测同步（`waitForP2pkhSyncIdle` 的既有说明除外）。
- [ ] 禁止在广播结果未知（`isolated`）后再次广播或用 Node 归集；禁止吞错、`try/catch` 后继续。

### 4.2 资金与链上

- [ ] Journey 开始时 key01 地址**必须无可花费输出**，否则 fail closed 并提示
  `pnpm collect:testnet:key01`；不得自动清理、不得跳过。
- [ ] seed 只由 Node Resource 的 `fund` / `returnRemaining` 读取私钥；页面只拿公开地址与公钥。
- [ ] 总损失（手续费）≤ 声明上限；每笔广播必须链上可观察，且输入消费上一笔 key01 的输出。
- [ ] `sendAll`（全部）出现 `requires-reconfirm` 时只允许重新生成一次；仍失败即失败，不循环。

### 4.3 页面断言

- [ ] 收款方来源徽标只接受四种：`联系人公钥派生` / `地址命中联系人` / `手工公钥` / `手工地址`。
- [ ] 地址模式网络选择器必须 disabled；testnet 关闭时不得存在；非法地址必须显式拒绝，
  不允许落到「没有匹配的本地联系人」。
- [ ] Widget 收款地址是只读文本（`data-testid=p2pkh-recipient-address`），不存在地址输入框。
- [ ] 金额旁余额参考：快照就绪后精确等于钱包余额；未知只接受「可用余额未知」；**任何情况不得显示 0**。
- [ ] 广播结果状态只接受 `local-confirmed`；出现 `isolated` 立即停止并失败。

## 5. 覆盖映射（三单 → Journey 步骤）

| 单 | 能力 | 步骤 |
| --- | --- | --- |
| 001 | 收款方合并、四种输入、网络锁定、冲突/非法阻断、只读核对 | R1–R10 |
| 002 | 金额旁余额参考、广播后扣减、跨 tab 设置/快照同步、输入不被覆盖 | B1–B5 |
| 003 | consumed 序号恢复、明确未派发不消费序号、sendAll、广播结果与链上衔接 | T1–T5 |

## 6. 测试流程

### Phase 0 预检与身份（Node + 页面）

1. `readResourceRunState()` 非空，`configFingerprint` 与 `loadE2EConfig()` 一致；
   `state.testnet.seedPublicKeyHex` 合法。
2. `wallet = funding.createImportedWallet(runId, JOURNEY_ID, config.testnet.trackingKeyPrivateKeyHex.read())`；
   断言 `inspectAddress(wallet.address).spendableUtxoCount === 0`，`mainnetBalance === 0`。
3. 页面导入 key01（`initializeLocalUserWithImportedHexKey`），断言 active 公钥一致。
4. seed 打 **200 sat**；等待链上（mempool 即可）可观察；记 `fundingTxid`（只留内存）。

### Phase 1 资产与联系人

5. `enableTestnetAssets` + `setP2pkhFeeRate(medium, 1)` + `waitForP2pkhSyncIdle`；
   `waitForTestnetUtxoSnapshot(page, 1)`；钱包页余额 200 sat。
6. 联系人页新建 `{publicKeyHex: state.testnet.seedPublicKeyHex, name: "seedkey"}`，列表读回。

### Phase 2 收款方全覆盖（只校验，不广播）

| ID | 步骤 | 断言 |
| --- | --- | --- |
| R1 | 菜单进转账页 | 标题「收款方」；无「资产类型」；无收藏品区；两 tab 可见 |
| R2 | 选 seedkey → 网络切 testnet | 昵称 + 公钥；派生地址 = `deriveTestnetP2pkhAddress(seedPublicKeyHex)`；徽标「联系人公钥派生」；Widget 只读地址一致 |
| R3 | 更换收款方 → 手工公钥 → main↔test | 地址重派生；出现「地址已更新，请重新核对」 |
| R4 | 手工 testnet 地址 | 徽标「地址命中联系人」+ seedkey；网络选择器 disabled |
| R5 | 陌生 testnet 地址（确定性派生自固定测试公钥） | 徽标「手工地址」+「陌生地址」警示；Widget 可挂载 |
| R6 | 设置关闭 testnet | 选择器消失；testnet 地址报错「未启用 testnet」；`network=testnet` 降级主网；测完恢复开启 |
| R7 | URL 公钥 + 不匹配地址 | 阻断文案；无 Widget |
| R8 | `3...` P2SH、坏校验和地址 | 明确「不是有效 P2PKH 地址」；不出现通讯录搜索空结果 |
| R9 | 生成预览后改金额 | 预览消失，需重新生成；核对区无可编辑控件 |
| R10 | 联系人行「转账」动作 | 跳 `/transfer?recipientPublicKeyHex=...`，昵称回填 |

### Phase 3 多次转账与资金回收

| 顺序 | 输入路径 | 金额 | 同步策略 | 覆盖 |
| --- | --- | --- | --- | --- |
| T1 | 联系人 seedkey（testnet） | 50 | 正常等待 | 001 联系人真实广播 + 002 参考扣减 |
| T2 | 手工公钥（testnet） | 30 | **先显式刷新**：T1 结果关闭后刷新到找零产生的新 seq，再生成/广播 | 003 consumed → fresh 恢复；prepare 不在 consumed 快照上轮询 |
| T3 | 手工地址（命中联系人） | 30 | 等待 | 001 地址路径真实广播 |
| T4 | 陌生地址 | 不广播 | — | 001 陌生地址 UI 与只读预览入口 |
| T4.5 | 任意路径，金额 = 可用余额 + 1000 | 拒绝 | — | 003 明确未派发：余额不足不消费序号 |
| T5 | 手工地址（命中联系人） | **全部** | 等待 | 003 sendAll + 资金回收；遇 `requires-reconfirm` 重新生成一次 |

资金账本（费率 1 sat/kB；实际手续费以页面预览和原始交易为准）：

```text
200 − 50 − f1 → C1 − 30 − f2 → C2 − 30 − f3 → C3
T4 只做陌生地址 UI 校验，不广播、不改变余额；T4.5 只验证余额不足，不广播。
T5 全部：C3 − f4 → seed 收款；key01 归 0
页面收款输出总额 + f1 + f2 + f3 + f4 = 200；总手续费 ≤ 10
```

每笔广播后：

- 结果卡断言 `local-confirmed` + canonical txid；
- Node `waitForTransaction` + `inspectTransactionOutputs(txid, seedAddress)`：
  seed 实收等于页面预览、输入包含上一笔 key01 输出（T1 为 `fundingTxid`）；
- T1–T3 断言 key01 有 1 个找零输出；`refreshTestnetUtxoSnapshot(page, 1)` 后余额等于账本值；
- T5 后 `refreshTestnetUtxoSnapshot(page, 0)`，余额归 0。

### Phase 4 余额广播（002）

| ID | 步骤 | 断言 |
| --- | --- | --- |
| B1 | 首笔广播前 | 参考文本等于 `可用余额：<钱包余额> sats（testnet）`；快照未就绪时只允许「可用余额未知」，**不得出现 0** |
| B2 | 每笔广播后 | 参考值等于新的钱包余额（含手续费扣减） |
| B3 | tab1 已输入金额；tab2 钱包页点「刷新 UTXO」 | 回 tab1：参考更新，**当前挂载中的金额输入值不变** |
| B4 | tab2 设置关闭 testnet | tab1 testnet 参考与入口消失；再开启后重新进入收款方流程，不要求跨卸载恢复金额草稿 |
| B5 | 资产总览页 | 广播后聚合余额跟随 |

### Phase 5 收尾

- `appReturnSubmitted` 语义升级为「已进入任意一次页面广播」：置位后 `finally` 一律不归集；
  未置位且 key01 有可花费输出时，按 1 sat/kB 归集回 seed。
- 任意广播出现 `isolated`：立即停止后续步骤，保留现场，Node 不归集，直接失败。
- 附件：脱敏计时 JSON（不含 txid/私钥）；`clearSecrets` + `wallet.clear()`。

## 7. 文件级改动清单

### 7.1 资源与状态（3 个文件）

- `e2e/integration/support/resourceState.ts`
  - `ResourceRunState.testnet` 增加 `seedPublicKeyHex: string`，注释「seed 压缩公钥的公开投影，不含私钥」；
  - 校验器增加 `^0[23][0-9a-f]{64}$` 形状校验。
- `e2e/integration/resources/testnet/fundingResource.ts`
  - `prepare()` 返回 `seedPublicKeyHex`（复用函数内已派生的 `publicKeyHex`），注释同步。
- `e2e/integration/resources/resource-setup.spec.ts`
  - 写入 `testnet.seedPublicKeyHex: prepared.seedPublicKeyHex`。

### 7.2 场景元数据与矩阵（3 个文件）

- `e2e/integration/support/scenarioMetadata.ts`
  - 新增 `REAL_TESTNET_CONTACT_TRANSFER_SCENARIO`：
    `id: "J-REAL-TESTNET-CONTACT-TRANSFER"`、`level: "p2pkh"`、
    `requirementIds: ["KM-ASSET-001","KM-CONTACT-001","KM-BALANCE-001","KM-BROADCAST-001"]`、
    `resourceProfile: "testnet"`，中英文状态与成功标准见 §6。
- `docs/集成测试/覆盖矩阵.yaml`
  - `KM-ASSET-001`、`KM-CONTACT-001` 的 `scenario_ids` 追加新场景；
  - 新增 `KM-BALANCE-001`（002）与 `KM-BROADCAST-001`（003）两条需求行，
    `gate_level: "p2pkh"`、`resource_profile: "testnet"`，`scenario_ids` 含新场景，status `部分覆盖`；
  - `source_refs.packages` 分别包含 `@keymaster/plugin-p2pkh`、`@keymaster/contracts`。
- `docs/集成测试/覆盖矩阵.md`
  - 只允许用 `pnpm generate:integration-coverage` 生成，禁止手改。

### 7.3 驱动（2 个文件）

- `e2e/integration/drivers/p2pkhDriver.ts`（改造）
  - `openTransferPage`：断言「收款方/Recipient」，断言无「资产类型/Asset type」；
  - 删除 `openTestnetTransfer`、`selectTestnetTransferOffer`、`expectTestnetOfferBalance`、
    `readTestnetOfferBalance`（Offer 余额 UI 已不存在）；
  - `prepareAndBroadcast`：不再填收款地址；金额标签 `金额 (sats)`；预览标题 `最终交易预览`；
    按钮 `生成最终交易` / `广播交易`；结果标题 `广播结果`，`确认并关闭`；
  - `dismissTestnetTransferResult`：关闭后断言回到「收款方」空态；
  - 新增 `expectTestnetWalletBalance(page, sats, timeout)`（钱包页余额文本解析）
    与 `expectAmountBalanceReference(page, { network, sats? | unknown })`；
  - 新增 `readAmountValue` / `expectAmountValue`；
  - 新增 `submitAndAwaitResult(page, { allowReconfirm })`：结果出现 `requires-reconfirm` 时
    重新「生成最终交易」一次，否则按失败处理。
- `e2e/integration/drivers/transferRecipientDriver.ts`（新增）
  - `selectRecipientTab`（role=tab）、`pickContact(name)`（联系人 Select）、
    `enterManualRecipient(value)`（收款地址输入框）、`chooseRecipientNetwork(main|test)`、
    `expectRecipientAddress`、`expectSourceBadge`、`expectRecipientError`、
    `expectNetworkSelectorLocked`、`expectNoNetworkSelector`、`changeRecipient`。

### 7.4 新增 Journey（1 个文件）

- `e2e/integration/journeys/p2pkh/contact-recipient-transfer.spec.ts`
  - 导出 `JOURNEY_ID` / `JOURNEY_METADATA`（与 `scenarioMetadata.ts` 同源）；
  - `test.setTimeout(1_800_000)`；实现 §6 全流程；
  - 不得引用旧 driver 的资产网格函数。

### 7.5 旧 Journey 迁移（1 个文件）

- `e2e/integration/journeys/p2pkh/real-testnet-roundtrip.spec.ts`
  - 只改「转账交互」与「余额观测」：开启 testnet → 钱包余额 50 sat → 进转账页 →
    手工地址贴 seed testnet 地址（命中/不命中都允许）→ 全部 → 广播 → 余额 0 → 链上对账；
  - 场景 ID、50 sat 预算、1 sat/kB、最大损失 10、归集语义全部保持不变；
  - 不新增需求、不改 `JOURNEY_METADATA` 的成功标准。

### 7.6 不改动的文件（明确边界）

- `e2e/playwright.resources.config.ts`：`testMatch` 已覆盖 `journeys/p2pkh/*.spec.ts`，不加项目、不改并发（保持 `workers: 1` 与 trace/screenshot/video 关闭）。
- `e2e/integration/drivers/contactDriver.ts`：现有创建联系人能力足够，不改。
- 任何 `packages/`、`apps/` 生产代码：不允许改（§4.1 唯一例外是 fundingResource/state 的公开投影）。

## 8. 特殊情况与处置

| 情况 | 处置 |
| --- | --- |
| 开始前 key01 有可花费输出 | fail closed，提示 `pnpm collect:testnet:key01`；不自动清理、不跳过 |
| seed 余额不足预算 | 由 `resource-setup` 既有门禁 fail closed（`KEYMASTER_E2E_MIN_TESTNET_RESERVE_SATOSHIS`） |
| T2 刷新找零超过 180s 仍未出现新 seq | 判定失败；若此前已有 `isolated` 立即停止，不做任何归集/重发 |
| 任意广播 `isolated` | 停止全部后续广播，保留现场失败；key01 余额留给人工 `collect:testnet:key01` |
| T5 全部余额遇 `requires-reconfirm` | 只重新「生成最终交易」一次后重播；再失败即失败 |
| T4.5 超额被拒 | 只断言内联错误；不得点击广播；随后 T5 成功证明序号未被消费 |
| 找零在 WoC 未更新（快照仍是旧数） | 用 `refreshTestnetUtxoSnapshot` 轮询到期望输出数；超时即失败 |
| 跨 tab 设置/快照同步慢 | `expect.poll` 最长 20s；仍不同步则失败，不用固定等待掩盖 |
| 余额参考暂时未知 | 只在首笔前允许；`waitForTestnetUtxoSnapshot` 后必须精确；任何阶段出现 0 即失败 |
| 通讯录为空或联系人插件不可用 | fail closed（不降级成手工地址流程），联系人步骤不可跳过 |
| 联系人重复/创建失败 | 本轮是全新 BrowserContext，重复即为异常，直接失败 |
| WoC 抖动/限流 | 沿用既有 180s 链上等待与 429 退避；不允许增加测试级重试 |
| 浏览器错误证据 | 只在 finally 中按既有脱敏规则附加；证据失败不得掩盖 Journey 原始失败 |

## 9. 最终验收清单

### 9.1 静态与门禁

- [ ] 新 spec 导出 `JOURNEY_ID`/`JOURNEY_METADATA`，ID 与元数据、矩阵完全一致；
- [ ] `pnpm check:integration-coverage` 通过，`覆盖矩阵.md` 由脚本生成且与 YAML 一致；
- [ ] `pnpm typecheck:e2e` 通过；
- [ ] `e2e/integration` 内不存在对已删除 driver 函数（`selectTestnetTransferOffer` 等）的引用；
- [ ] 不存在旧 UI 选择器残留（`资产类型`、`transfer-picker__balance`、可编辑收款地址输入）；
- [ ] `git grep` 确认生产代码除 `fundingResource`/`resourceState` 公开投影外无改动。

### 9.2 真实资源执行

- [ ] `playwright test --config=e2e/playwright.resources.config.ts --project=p2pkh` 两个 Journey 全部通过；
- [ ] 新 Journey：T1、T2、T3、T5 四笔广播全部 `local-confirmed` 且有 canonical txid；
- [ ] T2 显式刷新到新 seq 后成功，Node 证明 T2 输入 = T1 找零输出；
- [ ] T4.5 超额被拒，随后 T5 成功（序号未被消费）；
- [ ] T4 仅完成陌生地址 UI 验证；T5 无找零，key01 余额归 0；`回款 + 手续费 = 200`，损失 ≤ 10；
- [ ] R1–R10、B1–B5 全部断言通过；
- [ ] 旧 roundtrip Journey 语义不变（50 sat、全部回款、损失 ≤ 10）且通过；
- [ ] 没有 `isolated`、没有测试级重试、没有跳过步骤。

### 9.3 证据与文档

- [ ] 运行结果（run id、日期、通过/失败、损失 sat）回填 `覆盖矩阵.yaml` 的 evidence；
- [ ] 新需求行状态按实际结果更新（不通过不得写「已覆盖」）；
- [ ] 附件仅含脱敏计时 JSON，不含私钥、密码、txid、rawTxHex；
- [ ] 遗留未覆盖项（isolated/超时/reorg/纯代币 gas）明确留在 003 单测或后续单，不写成通过。

## 10. 发布门禁命令

```bash
pnpm typecheck
pnpm typecheck:e2e
pnpm check:integration-coverage
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm build
playwright test --config=e2e/playwright.resources.config.ts --project=p2pkh
```

## 11. 非目标

- 不做 `isolated`、重试预算耗尽、reorg、纯代币 gas 门禁的真实链上注入；
- 不做 mainnet 真实资金广播；
- 不为断言 `attempts` 数字修改产品或结果卡 UI（e2e 以“新 seq 恢复成功 + 输入衔接”为证据）；
- 不新增 Journey 之外的 e2e 项目、topic、路由或产品能力。

## 12. 交付物

- 新 Journey `contact-recipient-transfer.spec.ts` 与两个驱动的硬切换改造；
- 旧 roundtrip Journey 的新 UI 迁移；
- `seedPublicKeyHex` 公开投影（resource state + setup）；
- 覆盖矩阵两条新需求 + 新场景登记与生成的 Markdown；
- 真实资源运行证据与 §9 验收清单勾选结果。
