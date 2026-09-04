# 002：SatSubscription SPI 多网络充值与回收修复

> 日期：2026-09-04
>
> 状态：待实施
>
> 影响范围：`contracts`、`plugin-sat-subscription`、Web SharedWorker、设置页及测试

## 1. 问题与结论

`us-gateway` 的 SPI Information 正确返回：

```text
currency = BSV
network = testnet
payment_address = mqrAdPBmbvhLohuqFneSmn8TfZahUvu9eJ
```

设置页也正确显示 `BSV/testnet`，但生成充值预览时报错：

```text
Supplier has no BSV mainnet SPI account
```

根因在 Keymaster 客户端：

1. `prepareTopUp` 固定查找 `BSV/main`；
2. P2PKH 转账固定使用主网资产 `bsv`；
3. `SatTopUpPreview.network` 类型固定为 `main`；
4. `submitTopUp` 固定按主网重新校验账户；
5. 设置页回收操作固定传入 `network: main`；
6. SharedWorker 固定派生 owner 主网地址。

这不是错误文案问题。当前充值和回收都只实现了主网路径，而且 SPI 与 P2PKH 使用的网络名称没有显式转换。

## 2. 网络字段契约

两套模块的网络名称不同，禁止直接混用：

| SPI 返回值 | P2PKH 内部网络 | P2PKH 资产 ID | 中文说明 |
|---|---|---|---|
| `mainnet` | `main` | `bsv` | BSV 主网 |
| `testnet` | `test` | `bsvtest` | BSV 测试网 |

新增一个集中、纯函数式映射，充值、提交和回收共同使用：

```ts
type SupportedSpiBsvNetwork = "mainnet" | "testnet";

function mapSpiBsvNetwork(network: string): {
  spiNetwork: SupportedSpiBsvNetwork;
  p2pkhNetwork: "main" | "test";
  assetId: "bsv" | "bsvtest";
};
```

要求：

- 不接受大小写变体、别名或自动猜测；
- 未知网络必须在创建交易前失败；
- 错误应明确指出供应商返回了不支持的 BSV 网络；
- 不能继续使用含义不清的字符串 `main` 代表 SPI 网络。

## 3. 施工范围

### 3.1 Contracts

修改 `packages/contracts/src/satSubscription.ts`：

1. `SatTopUpPreview.network` 改为 SPI 网络：`"mainnet" | "testnet"`；
2. `prepareTopUp` 返回的 preview 必须保存实际供应商网络；
3. 中文注释不得继续写“仅 BSV mainnet”；
4. 如 UI/API 需要显式选择账户，输入必须包含 `currency` 和 `network`，禁止默认主网。

### 3.2 SPI 充值服务

修改 `packages/plugin-sat-subscription/src/satSpi.ts`：

1. 从最新 SPI Information 中选择 BSV 账户；
2. 将 `mainnet/testnet` 映射为正确的 P2PKH 网络和资产 ID；
3. `SatP2pkhService.prepareTransfer.assetId` 支持 `bsv | bsvtest`；
4. testnet 充值必须调用 `assetId: "bsvtest"`；
5. `validateP2pkhPreview` 同时校验预期的 `assetId`、P2PKH 网络、owner、收款地址和金额；
6. `submitTopUp` 必须按 preview 中的 SPI 网络重新查询并匹配同一账户；
7. 网络、收款地址或底层 preview 被篡改时，禁止广播；
8. P2PKH 未启用 testnet 时返回“P2PKH 设置未启用测试网”，不要误报供应商余额不足。

如果 Information 中没有 BSV 账户，返回“供应商没有 BSV SPI 账户”；如果返回不支持的 BSV 网络，返回“供应商 BSV 网络不受支持”。两者不得都写成 mainnet 缺失。

### 3.3 回收余额

充值之外必须同步修复 Collect：

1. 把 `deriveMainAddress` 改为按目标网络派生地址，例如：

   ```ts
   deriveP2pkhAddress(ownerPublicKeyHex, network: "main" | "test")
   ```

2. `collectNew` 使用 SPI 账户的实际网络派生 owner 收款地址；
3. `testnet` 必须生成 version `0x6f` 的测试网 P2PKH 地址；
4. 已持久化的未决 Collect 继续使用原始 `requestWire`，不得因本次升级重写或换网重试；
5. network、currency、amount、paymentAddress 继续参与未知结果恢复的一致性校验。

### 3.4 SharedWorker

修改 `apps/web/src/keymasterSessionCoordinator.worker.ts`：

1. 替换固定的 `deriveMainAddress` 注入；
2. 把映射后的 `main | test` 传给 `deriveP2pkhAddress`；
3. owner、session epoch、generation 校验保持不变；
4. 不允许页面直接接触私钥或绕过 Coordinator。

### 3.5 设置页

修改 `packages/plugin-sat-subscription/src/SatSubscriptionSettings.tsx`：

1. 充值和回收目标必须来自 SPI Information 中显示的实际账户；
2. 禁止按钮内部硬编码 `main`；
3. 确认框必须显示 `BSV 主网` 或 `BSV 测试网`、目标地址及金额；
4. testnet 未启用时给出明确引导，不得显示“供应商余额不足”；
5. 如果将来一个供应商返回多个可操作账户，应在账户行上分别提供操作入口，不能静默选择第一项；
6. 当前只有一个 BSV 账户时可以自动选择，但仍必须使用该账户返回的 network。

## 4. 禁止事项

- 不修改 SatSubscription 服务端返回的 `testnet` 来迎合客户端硬编码；
- 不把 `testnet` 充值偷偷改发到主网；
- 不根据地址首字符猜测网络；网络以已认证 SPI Information 为真值，地址只做一致性校验；
- 不仅修改错误文案；
- 不在 testnet 关闭时自动启用 P2PKH testnet；
- 不自动广播真实交易作为普通单元测试的一部分。

## 5. 测试要求

### 5.1 SPI 服务单元测试

至少覆盖：

1. `BSV/mainnet` → `assetId=bsv`、P2PKH `network=main`；
2. `BSV/testnet` → `assetId=bsvtest`、P2PKH `network=test`；
3. testnet preview 提交前按 `BSV/testnet` 重新校验；
4. 未知 BSV 网络拒绝且没有调用 `prepareTransfer`；
5. preview 的网络、assetId、地址、owner 或金额被修改时不广播；
6. P2PKH testnet 未启用时返回 `unavailable` 类错误；
7. testnet Collect 使用测试网 owner 地址；
8. 原有 Collect 未知结果、owner generation 和 supplier generation 测试继续通过。

现有测试 fixture 中的 SPI `network: "main"` 必须改成正式值 `mainnet`，并新增 `testnet` fixture，避免测试继续固化错误契约。

### 5.2 设置页测试

至少覆盖：

- 页面显示 `BSV/testnet` 时，充值调用携带/选择 `testnet`；
- 回收调用使用 `testnet`，确认文本明确写“BSV 测试网”；
- 主网仍正常；
- 多账户时不会误选网络；
- 错误文案不再出现与实际账户冲突的 `mainnet`。

### 5.3 回归命令

```text
pnpm typecheck
pnpm test
pnpm build
```

三项必须全部通过，不允许只运行 `plugin-sat-subscription` 局部测试后交付。

## 6. 线上验收

以 `us-gateway` 为测试供应商：

1. 刷新 SPI 后显示 `BSV/testnet` 与地址 `mqrAdPBmbvhLohuqFneSmn8TfZahUvu9eJ`；
2. 点击生成充值预览，不再查询或报错 `mainnet`；
3. preview 显示测试网、上述供应商地址、金额、找零地址和矿工费；
4. 使用测试网余额不足的钱包时，应报告本地 testnet 余额不足，而不是供应商无主网账户；
5. 未经单独授权不点击“确认并广播”；
6. 如执行真实 testnet 小额广播，必须随后刷新 SPI，确认付款被扫描并入账；
7. 回收验收需要账户有余额，并单独验证回收地址为当前 owner 的 testnet 地址。

## 7. 完成标准

同时满足以下条件才可关闭工单：

- 充值、提交和回收链路均不存在固定主网逻辑；
- SPI 与 P2PKH 网络转换集中且有穷尽测试；
- `us-gateway` testnet 能生成正确充值预览；
- mainnet 行为无回归；
- 类型检查、全量测试和生产构建通过；
- 未发生未经授权的真实主网或测试网广播。

## 8. 预计修改文件

| 文件 | 修改内容 |
|---|---|
| `packages/contracts/src/satSubscription.ts` | 放宽并明确充值 preview/API 网络契约 |
| `packages/plugin-sat-subscription/src/satSpi.ts` | 网络映射、充值、提交、Collect 修复 |
| `packages/plugin-sat-subscription/src/satSpi.test.ts` | 主网/testnet/错误网络/防篡改测试 |
| `packages/plugin-sat-subscription/src/SatSubscriptionSettings.tsx` | 使用实际账户网络并修正确认信息 |
| `packages/plugin-sat-subscription/src/SatSubscriptionSettings.test.tsx` | 页面网络传递与文案测试 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 按网络派生 owner P2PKH 地址 |
| 相关 Worker 测试 | 验证 `mainnet/testnet` 到 `main/test` 的传递 |
