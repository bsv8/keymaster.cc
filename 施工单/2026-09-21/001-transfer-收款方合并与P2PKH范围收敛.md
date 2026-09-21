# 001：/transfer 收款方合并与 P2PKH 范围收敛

> 日期：2026-09-21
>
> 状态：已实施
>
> 优先级：P1
>
> 上游约束：[P2PKH](../../docs/P2PKH.md) 的「转账页收款方（已实现）」章节

## 1. 背景与问题

当前 `/transfer` 与设计目标存在四处冲突：

1. 页面把「1 收款人」和「2 资产类型」拆成两步；收款人只接受 `recipientPublicKeyHex`，
   手工输入没有地址入口（`apps/web/src/system/transfer.tsx`）。
2. 资产网格混合 P2PKH 与 BSV-21 offer，页面还展示收款人收藏品区；
   而 BSV-21、1Sat 与普通 BSV 共用 P2PKH 地址，用户无法从界面区分。
3. `P2pkhTransferWidget` 第 3 步用可编辑 `TextInput` 收集收款地址
   （`packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:248`），
   把核对步骤当成了输入步骤。
4. testnet 没有统一的显示与报错规则：设置关闭 testnet 后，地址输入没有明确行为。

## 2. 目标

1. `/transfer` 范围收敛为普通 BSV（P2PKH，主网/testnet），不混 BSV-21 token 与 1Sat 收藏品。
2. BSV-21 保留独立可达入口 `/assets/bsv21/transfer`，不因普通 BSV 范围收敛而丢失代币转账能力。
3. 把「1 收款人 + 2 资产类型」合并成一个「收款方」区块：
   `身份（publicKeyHex）/ 地址 + 网络 -> 收款地址`。
4. 资产类型不再由用户选择：P2PKH 范围内资产由网络唯一决定。
5. 核对区改为纯只读；金额与矿工费率是唯一输入区。
6. 统一 testnet 开关行为与地址格式校验规则。
7. 通讯录地址反查：地址命中联系人时回填昵称，不新增联系人字段。

## 3. 冻结的不变量

### 3.1 范围与资产

- [x] `/transfer` 不再列出 BSV-21 或任何非 P2PKH 的 offer。
- [x] `/transfer` 不再展示收款人收藏品区，`transfer.recipient-collectibles` 资源移除。
- [x] 页面不出现资产类型选择器；网络即资产（主网 `bsv`、testnet `bsvtest`）。

### 3.2 收款方真值

- [x] 收款地址是签名与广播的唯一真值；身份只用于派生地址、回填昵称和核对。
- [x] 地址模式（手工地址）下网络由地址 version 字节反推并锁定，选择器不可手动切换。
- [x] 公钥模式下网络由用户选择，切换网络必须重新派生地址并提示「地址已更新，请重新核对」。
- [x] 身份与地址同时存在时必须一致：`address === deriveAddress(publicKeyHex, network)`；
      不一致时阻断，不允许静默合并。

### 3.3 testnet 规则

- [x] `includeTestnet=false`（默认）：不显示主网/testnet 选择器，公钥模式直接派生主网地址。
- [x] `includeTestnet=false`：手工输入 testnet 地址报错，文案说明「未启用 testnet，请在设置中开启」。
- [x] `includeTestnet=false`：URL 上的 `network=testnet` 降级回主网。
- [x] `includeTestnet=true`：地址模式选择器跟随地址网络且不可操作；公钥模式可切换。

### 3.4 核对与页面

- [x] 核对区不承载任何输入控件，只展示收款人标签、完整地址、金额、矿工费率、找零地址。
- [x] 换收款人、换网络、改金额或费率都会使核对结果失效，必须重新核对后才能提交。
- [x] 输入内容自动分流：`02/03` + 64 hex 视为公钥；Base58Check 25 字节视为地址；
      其他文本进入通讯录搜索。
- [x] 非 P2PKH 格式地址（校验和错误、长度错误或未来其他地址族）直接拒绝并提示对应入口。
- [x] 记录来源徽标：`联系人公钥派生` / `地址命中联系人` / `手工公钥` / `手工地址`。

### 3.5 入口参数

- [x] `recipientPublicKeyHex` 与 `recipientAddress` 同时存在且矛盾时阻断页面并提示，不猜测。
- [x] `network` 参数仅在公钥模式下生效；地址模式忽略该参数。

## 4. 收款方状态模型

实现时字段可与现有 contracts 合并，但每个公开字段必须有中文说明，不得另建平行类型。

```ts
interface TransferRecipient {
  /** 收款人身份：压缩公钥 hex；来自通讯录、手工公钥或地址命中。 */
  identity?: {
    /** 压缩公钥 hex（小写）。 */
    publicKeyHex: string;
    /** 身份来源：联系人、手工公钥、地址反查命中。 */
    source: "contact" | "manual" | "resolved";
  };
  /** 网络：主网 main 或测试网 test。 */
  network: BsvNetwork;
  /** 收款地址：最终支付真值。 */
  address: string;
  /** 地址来源：公钥派生或手工输入。 */
  addressSource: "derived" | "manual";
  /** 命中的联系人昵称；未命中时省略。 */
  contactName?: string;
}

interface P2pkhAddressCodec {
  /** 由压缩公钥与网络派生 P2PKH 地址。 */
  deriveAddress(publicKeyHex: string, network: BsvNetwork): string;
  /** 解析地址；返回网络与 hash160，非 P2PKH 格式返回 undefined。 */
  parseAddress(address: string): { network: BsvNetwork; hash160Hex: string } | undefined;
}
```

`BsvNetwork` 复用 `@keymaster/contracts`（`"main" | "test"`）。
建议把 `P2pkhAddressCodec` 做成 contracts 中的能力，由 plugin-p2pkh 提供，
平台页面通过 `useOptionalCapability` 消费；缺失时降级为「公钥模式 + 手工地址不做通讯录反查」。

## 5. 页面与交互

```text
1 收款方
   [输入/搜索：昵称 或 粘贴公钥 或 粘贴地址]
   【从通讯录选择】【手工输入】
   网络：[主网][testnet]        <- 条件显示
   收款地址：<只读地址> [复制] 来源徽标
2 金额与矿工费率（唯一输入区）
3 只读核对（地址 / 金额 / 费率 / 找零）-> 提交
```

- 金额输入旁显示当前收款网络的可用余额参考，网络随收款方网络切换（mainnet/testnet）；
  数据来源与未知语义见 [002 全局余额广播](./002-全局余额广播.md) §7.4。

| 输入 | 网络 | 收款地址 | 选择器 |
| --- | --- | --- | --- |
| 通讯录联系人 | 默认主网，可切 testnet | 派生，只读 | 条件显示 |
| 手工公钥 | 默认主网，可切 testnet | 派生，只读 | 条件显示 |
| 手工地址 | 由 version 反推 | 即输入地址，只读 | 锁定到该网络 |

- 公钥命中通讯录：回填昵称与「联系人公钥派生」徽标。
- 地址命中通讯录：回填昵称与「地址命中联系人」徽标；未命中显示「陌生地址」警示样式。
- 手工公钥未命中通讯录：显示「未命名公钥」，提供「保存为联系人」入口（可后续单独立项）。

## 6. 地址与通讯录反查

- 通讯录不新增地址字段；地址是 `publicKeyHex + network` 的派生投影。
- 反查流程：`parseAddress(address)` 取 `hash160Hex` -> 遍历 `contacts.list` 资源中每个联系人的公钥
  派生同一网络地址并比较 `hash160` -> 命中则回填昵称。
- 反查只对本地通讯录生效，不做全网反查；未命中是正常状态。
- 地址命中联系人只说明 hash160 一致，不证明对方掌握私钥；这不改变「地址是支付真值」的规则。

## 7. 主要代码范围

- `apps/web/src/system/transfer.tsx`：收款方区块重写；移除资产网格与收藏品区；URL 参数解析。
- `apps/web/src/system/registerAssetWorkspace.ts`：移除 `transfer.recipient-collectibles` 资源；
  `/transfer` 只保留 p2pkh offer；补充中英文 i18n 文案；通讯录动作 URL 兼容。
- `packages/contracts/src/transfer.ts`：`TransferWidgetProps` 增加
  `/** 收款地址：平台核对后的最终支付真值 */ recipientAddress?: string`。
- `packages/contracts/src/`：新增 `P2pkhAddressCodec` 与 capability 定义。
- `packages/plugin-p2pkh/src/manifest.ts`、`p2pkhContracts.ts`：注册地址 codec 能力。
- `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`：收款地址改为只读展示；
  仅金额、矿工费率为输入；核对失效逻辑随参数变化重建。
- `packages/plugin-p2pkh/src/p2pkhSigner.ts` / `p2pkhTransactionParser.ts`：复用现有派生与解码实现，
  不新写 base58check。
- `packages/plugin-token-bsv21/src/bsv21TransferProvider.tsx`、`manifest.ts`：提供独立 BSV-21
  转账页面、网络选择、路由和业务菜单入口，保持 BSV-21 转账可达。
- `apps/web/src/system/transfer.test.tsx`、`packages/plugin-p2pkh/src/`：补充验证用例。
- `packages/plugin-token-bsv21/src/manifest.test.ts`：验证独立 BSV-21 路由和业务入口注册。

## 8. 自动化验证矩阵

| ID | 场景 | 通过标准 |
| --- | --- | --- |
| T01 | 菜单进入 | 只显示收款方区块，不出现资产网格与收藏品区 |
| T02 | 通讯录跳转命中 | 显示昵称、短公钥、派生地址与「联系人公钥派生」徽标 |
| T03 | 手工公钥 + testnet 关闭 | 无网络选择器，直接显示主网派生地址 |
| T04 | 手工主网地址 | 地址即收款地址，选择器锁定主网 |
| T05 | 手工 testnet 地址 + testnet 关闭 | 报错且不允许继续 |
| T06 | 手工 testnet 地址 + testnet 开启 | 网络徽标为 testnet，选择器不可切换 |
| T07 | 公钥模式切换 testnet | 地址重新派生，核对结果失效 |
| T08 | URL `recipientPublicKeyHex` 与 `recipientAddress` 矛盾 | 阻断并给出明确文案 |
| T09 | URL `network=testnet` + testnet 关闭 | 降级回主网 |
| T10 | 地址命中通讯录 | 回填昵称与「地址命中联系人」徽标 |
| T11 | 非 P2PKH / 校验和错误地址 | 拒绝并提示对应资产入口 |
| T12 | 核对区只读 | 核对区无任何可编辑控件；改金额后核对失效 |
| T13 | provider widget | 收到 `recipientAddress`，地址输入框为只读 |
| T14 | BSV-21 独立入口 | `/assets/bsv21/transfer` 路由和业务菜单均可达，普通 `/transfer` 不再承载 BSV-21 |

## 9. 发布门禁

实施者至少运行并记录：

```bash
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm build
```

通过标准：

- [x] T01～T14 有自动化结果；
- [x] `/transfer` 页面不再出现 BSV-21 offer 与收藏品区，且原收藏品转账入口不受影响；
- [x] 不通过放宽断言或保留旧资产选择逻辑来让测试变绿；
- [x] i18n 中英文案同步，字段均有中文说明。

实施证据（2026-09-21）：

- `apps/web/src/system/transfer.test.tsx`：16 项通过，覆盖 T01～T11 及入口兼容场景；
  `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.test.tsx`：2 项通过，覆盖 T12～T13。
- `packages/plugin-token-bsv21/src/manifest.test.ts`：6 个测试通过，覆盖 T14 的独立路由和业务入口。
- `node scripts/check-integration-coverage.mjs`：通过；正式路由已登记到 `docs/集成测试/覆盖矩阵.yaml`。
- `pnpm typecheck`、`pnpm lint:boundaries`、`pnpm lint:react-boundaries`、`pnpm check:contracts`、
  `pnpm test`（236 个测试文件）和 `pnpm build`（4008 个模块）均通过。

## 10. 非目标

- 不引入 Paymail 等新地址格式；
- 不做二维码扫描、地址簿分组等增强功能；
- 不修改通讯录存储格式，不给联系人加地址字段；
- 不改变 P2PKH 的 UTXO、签名、广播等底层逻辑。

## 11. 开放风险

- **BSV-21 入口缺口（已关闭）**：已在 `/assets/bsv21/transfer` 注册独立路由和业务菜单，
  并由 `manifest.test.ts` 验证；`/transfer` 仅保留普通 BSV（P2PKH）。
- 地址反查在联系人数量大时需为联系人列表建立一次 hash160 索引，避免每次输入全量派生；
  实现时按联系人数量设上限或做缓存。

## 12. 交付物

- 本文档对应设计已在 `docs/P2PKH.md` 标注「已实现」；
- `TransferRecipient` 状态模型与 `P2pkhAddressCodec` 能力实现及中文说明；
- `/transfer` 新页面、只读核对区与中英文 i18n 文案；
- `/assets/bsv21/transfer` 独立页面、路由、菜单和中英文 i18n 文案；
- T01～T14 验证证据和全量发布门禁记录；
- 尚未关闭的风险：联系人数量很大时的 hash160 反查索引优化。
