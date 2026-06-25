# 002 Connect 增加 P2PKH 转账与费用池能力硬切换一次性迭代施工单

## 参考需求文档

可以参考以下需求文档，施工与验收以这些文档与本单“本单补充定义”段的合集为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-intent-sign-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolCommandDb.ts`
- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`

需求文档与本单发生冲突时：

1. `docs` 里已经明确定义且本单未补钉的，以 `docs` 为准。
2. `docs` 当前尚未定义 connect 转账 / 费用池，而本单“本单补充定义”段已经钉死的，以本单为准。
3. 后续若要改 connect 转账 / 费用池语义，必须先改本单与对应 `docs` 段，再改 contract、实现、测试，保持单真值。

## 本单补充定义

> 本段是“当前协议草案尚未纳入 connect 转账与费用池能力”的一次性补钉。
> 改本段必须先同步改对应 `docs` 段，再改 contract、实现、测试。

- **本次只支持 `bsv` 主网 P2PKH 转账。**

  不引入：

  ```txt
  assetId 参数
  testnet
  多币种
  多网络协商
  ```

  也就是说，本次新增的 connect 转账能力语义固定为：

  ```txt
  从当前 active key 对应的主网 P2PKH 余额中
  向一个主网 P2PKH 地址转账指定 satoshis
  ```

- **本次新增三个协议方法：**

  ```txt
  p2pkh.transfer
  feepool.prepare
  feepool.commit
  ```

  不新增单步 `feepool.transfer`。

- **本次把原始需求里的“自动确认金额的最小值 / 自动签名划转最低金额”统一收口为“金额上限”。**

  因为真实行为是：

  ```txt
  amount <= threshold
    -> 自动确认 / 自动签名
  ```

  这在语义上是“上限”，不是“最小值”或“最低金额”。

  因此：

  - 产品文案应统一改成“自动确认金额上限” / “自动签名金额上限”；
  - 代码字段统一使用 `MaxSatoshis`；
  - 不允许 UI 说“最小值”，代码却按“上限”执行。

- **`p2pkh.transfer` 的余额不足不对外暴露真实原因。**

  规则固定为：

  ```txt
  Keymaster 可以本地检查余额是否足够
  但不能因为余额不足就自动直接向 site 回 insufficient_funds
  ```

  用户可见行为：

  - popup 显示“余额不足，只能放弃”；
  - 用户只能点“取消 / 放弃”；
  - 对 opener/site 回的仍然是 `user_rejected`；
  - 本地历史里记录真实失败原因。

- **费用池必须拆成 `prepare + commit` 两步普通 request/result，不改公共 transport。**

  语义固定为：

  ```txt
  feepool.prepare
    = Keymaster 判断这次要创建池 / 直接划拨 / 关池重建
    = 产出需要 site 配合签名的任务集

  feepool.commit
    = site 把签名结果交回 Keymaster
    = Keymaster 完成最终落地、更新费用池状态、返回最终结果
  ```

  这样做的目的不是增加抽象，而是避免把现有
  `ready/request/result/closing` 简单协议改成“带中间子会话”的复杂 transport。

- **费用池状态按 `exact origin + counterpartyPublicKeyHex` 归档，不只按 origin。**

  不能只按 origin，因为同一站点可以更换费用池对端公钥。

- **费用池 pending operation 只保存在 popup 会话内存中，不持久化。**

  也就是说：

  ```txt
  prepare 成功后
    operationId 只在当前 popup 会话里有效

  popup 刷新 / 关闭 / 崩溃
    -> operation 丢失
    -> site 需要重新从 prepare 开始
  ```

  不新增：

  ```txt
  operations store
  operation 恢复
  operation 重放
  跨刷新续跑
  ```

## 目标

一次性把 connect 扩到下面这套最终模型：

```txt
connect 新能力
  = p2pkh.transfer
  = feepool.prepare
  = feepool.commit

p2pkh.transfer
  = site 只提交 recipientAddress + amountSatoshis
  = Keymaster 自己生成确认文案
  = 支持按 exact origin 存站点级自动确认配置
  = 余额不足不自动对外暴露

fee pool
  = site 不管理费用池状态
  = site 只提交 counterpartyPublicKeyHex + amountSatoshis
  = Keymaster 管理费用池状态、重建策略、站点配置
  = prepare 产出签名任务
  = commit 收签名结果并落地

站点配置
  = 按 exact origin 持久化
  = 与命令历史同库管理
  = 不是 command record 附带字段

费用池状态
  = 按 exact origin + counterpartyPublicKeyHex 持久化
  = pending operation 不持久化

协议 transport
  = 继续使用 popup + postMessage
  = 不引入中间子会话协议
  = 不引入心跳
  = 不引入 MessageChannel
```

本次是硬切换，不接受：

1. 先上 `p2pkh.transfer`，费用池以后再补。
2. 先做单步 `feepool.transfer`，后面再回头拆 `prepare + commit`。
3. 先让 site 自己管理费用池状态，后面再迁回 Keymaster。
4. 先把自动确认阈值做成“最小值文案 + 上限实现”的混合态。
5. 先把余额不足直接对外报错，后面再补隐私保护。
6. 先把站点配置塞进 command history，后面再拆 store。
7. 先把 pending fee pool operation 落库，后面再删。

## 简述缘由

1. `p2pkh.transfer` 本质是“受控转账能力”，不是现有站内 `plugin-transfer` 页面复用。站内转账页允许丰富表单、预览、provider widget；connect 需要的是对外最小接口和更强的安全边界。

2. connect 转账请求不能允许 site 自己传确认文案。否则站点可以把“转账”伪装成“登录确认”或“签名授权”。确认页必须由 Keymaster 按方法语义自己生成。

3. 费用池天然不是单步动作。`MultisigPool` 至少包含“创建池 / 消耗池 / 关池重建 / 双方协签”等多阶段行为。如果硬塞进一个 `feepool.transfer`，就必须把公共协议改成“处理中再反向向 site 要下一步材料”的复杂模型，这与当前项目追求的简单边界相反。

4. 站点配置与命令历史是两种不同真值：

   - 命令历史是过去发生过什么；
   - 站点配置是以后遇到这个 origin 应该按什么策略执行。

   把两者混在一条 command record 里，会把读取逻辑、更新逻辑、迁移逻辑全部搞脏。

5. 余额不足是敏感本地信息。尤其在 connect 场景下，若 Keymaster 自动对 site 回“钱不够”，site 就能拿用户钱包余额做探测。正确做法是：本地可以知道，但站点不该自动知道。

6. pending fee pool operation 不是用户资产真值，只是一次半程事务。把它持久化会立刻引入“续跑、恢复、去重、过期、跨版本兼容”一整串复杂度，不值得。

## 硬切换结论

### 一、方法模型固定为一个单步转账 + 一个两步费用池协议

本次新增：

```txt
p2pkh.transfer
feepool.prepare
feepool.commit
```

明确不做：

```txt
feepool.transfer
feepool.open
feepool.close
feepool.resume
通用多步工作流引擎
```

`p2pkh.transfer` 是单次请求，`feepool.prepare/commit` 是两次普通请求。
二者都继续跑在现有 popup 常驻会话里。

### 二、`p2pkh.transfer` 请求只允许最小业务参数

请求参数固定为：

```ts
{
  recipientAddress: string;
  amountSatoshis: number;
}
```

不接受：

```txt
assetId
network
aud
text
feeRate
allowUnconfirmed
rawTx
changeAddress
```

说明：

1. `aud` 对这类方法没有必要，因为 connect popup 已经天然拿到了 `event.origin` 真值。
2. `text` 不允许由 site 传入，确认文案由 Keymaster 自己生成。
3. `assetId` / `network` 不引入，因为本次只做 `bsv` 主网。

### 三、`feepool.prepare` 只负责“出作业”，`feepool.commit` 只负责“交作业并结案”

`feepool.prepare` 请求参数固定为：

```ts
{
  counterpartyPublicKeyHex: string;
  amountSatoshis: number;
}
```

返回结果至少包含：

```ts
{
  operationId: string;
  action: "create" | "spend" | "close_and_recreate";
  signRequests: Array<{
    signId: string;
    kind: "multisigpool.client-sign.v1";
    payload: Record<string, unknown>;
  }>;
}
```

`feepool.commit` 请求参数固定为：

```ts
{
  operationId: string;
  signatures: Array<{
    signId: string;
    kind: "multisigpool.client-sign.v1";
    payload: Record<string, unknown>;
  }>;
}
```

返回结果至少包含：

```ts
{
  action: "create" | "spend" | "close_and_recreate";
  poolBalanceSatoshis: number;
}
```

关键约束：

1. `payload` 对 connect 协议层是 opaque object。site 和 Keymaster 通过 `MultisigPool` SDK 理解它，connect 协议本身不再解释字段细节。
2. `operationId` 只在当前 popup 会话内有效。
3. `commit` 只能消费当前 popup 会话内由 `prepare` 产生的 operation。

### 四、站点配置按 exact origin 持久化，并与命令历史分 store 管理

新增站点配置模型，key 为 `event.origin` 原样字符串。

字段固定为：

```ts
{
  origin: string;
  p2pkhAutoApproveEnabled: boolean;
  p2pkhAutoApproveMaxSatoshis: number;
  feePoolDefaultFundSatoshis: number;
  feePoolAutoSignMaxSatoshis: number;
  updatedAt: number;
}
```

默认值规则：

1. `p2pkhAutoApproveEnabled = false`
2. `p2pkhAutoApproveMaxSatoshis = 0`
3. `feePoolAutoSignMaxSatoshis = 0`
4. `feePoolDefaultFundSatoshis` 首次没有默认真值，必须由用户首次为该 origin 明确设置

这意味着：

- `p2pkh` 首次请求可以按“自动确认关闭”继续工作；
- `fee pool` 首次请求若该 origin 尚未配置 `feePoolDefaultFundSatoshis`，popup 必须要求用户先设置，不能偷偷猜一个默认金额。

### 五、费用池状态按 `origin + counterpartyPublicKeyHex` 归档

费用池持久化 key 固定为：

```txt
exactOrigin + "|" + counterpartyPublicKeyHex
```

至少保存：

- `origin`
- `counterpartyPublicKeyHex`
- `poolBalanceSatoshis`
- `fundingAmountSatoshis`
- `status`
- `updatedAt`
- 当前池所需的最小链上引用信息

不保存：

- pending operation
- site 端签名任务集
- 完整签名材料
- 大体积原始交易草稿

### 六、`p2pkh.transfer` 和 `fee pool` 的自动通过都按“上限”语义执行

`p2pkh.transfer` 自动确认触发条件：

1. origin 已有配置；
2. `p2pkhAutoApproveEnabled === true`；
3. `amountSatoshis <= p2pkhAutoApproveMaxSatoshis`；
4. 本地余额足够；
5. 地址合法；
6. 当前 vault 已解锁。

`feepool.prepare/commit` 自动签名触发条件：

1. origin 已有配置；
2. `amountSatoshis <= feePoolAutoSignMaxSatoshis`；
3. 当前费用池动作所需本地前置条件满足；
4. 当前 vault 已解锁。

`fee pool` 本次不额外再做一个布尔开关，`feePoolAutoSignMaxSatoshis = 0`
就等价于“默认关闭”。

### 七、余额不足只在本地暴露，不自动对外暴露

`p2pkh.transfer`：

- Keymaster 可以在确认前检查余额；
- 若不足，popup 显示“余额不足，只能放弃”；
- 站点拿到的仍是 `user_rejected`；
- 本地历史记录真实原因，例如 `insufficient_funds`。

`fee pool`：

- 若当前池余额不足，需要先走 `close_and_recreate`；
- 若连重建池所需资金都不足，popup 也只给用户本地看到“无法创建或重建费用池”；
- 对外仍然统一 `user_rejected`；
- 本地历史记录真实原因。

### 八、历史与配置都在 `keymaster.protocol` 库里，但职责分离

最终 IndexedDB 结构固定为：

```txt
DB: keymaster.protocol
stores:
  commands
  origins
  feePools
```

不新增：

```txt
operations
siteCache
feePoolDrafts
```

## 核心不变量

1. connect 新增方法仍然只接受 `window.opener` 当前 popup 会话内的 `postMessage` request。
2. `p2pkh.transfer` / `feepool.prepare` / `feepool.commit` 都不接受 site 自定义确认文案。
3. `p2pkh.transfer` 只支持 `bsv` 主网，不接受网络协商。
4. 站点配置 key 必须是 `event.origin` 原样字符串，不做 host / port 归一化。
5. 费用池状态 key 必须包含 `counterpartyPublicKeyHex`，不能只按 origin。
6. `feepool.prepare` 只产出签名任务，不直接更新最终费用池状态。
7. `feepool.commit` 只能消费当前 popup 会话内有效的 `operationId`。
8. `operationId` 不持久化；popup 关闭或刷新后必须失效。
9. `p2pkh.transfer` 余额不足不允许自动直接对外回真实原因。
10. `fee pool` 资金不足无法建池/重建池时，也不允许自动直接对外回真实原因。
11. DB 不可用时，`p2pkh.transfer` 只能降级为手动确认；`fee pool` 必须 fail-closed。
12. 本次不新增协议级心跳、MessageChannel、双向子会话、通用工作流框架。

## 不能怎么做

1. 不能把 connect 转账直接复用站内 `plugin-transfer` 页面或 widget。当下对外协议需要更小接口和更强边界，而不是把站内产品 UI 暴露出去。

2. 不能允许 site 在 `p2pkh.transfer` 里传 `text` / `title` / `confirmMessage` 之类字段。确认页文案必须由 Keymaster 自己生成。

3. 不能继续保留“最小值 / 最低金额”这种反语义命名。产品和代码都必须统一成“上限”。

4. 不能在余额不足时自动对 site 回：

   ```txt
   insufficient_funds
   no_utxos
   fee_pool_empty
   ```

   这些都属于本地敏感状态。

5. 不能把 `feepool.transfer` 做成单步请求后，在处理过程中再临时向 site 发子请求要签名。这会把现有协议从简单 request/result 变成嵌套状态机。

6. 不能让 site 自己保存“当前有哪一个费用池、余额多少、需不需要 close”。这些状态必须由 Keymaster 单边管理。

7. 不能把费用池状态只按 origin 归档。只按 origin 会让同站点不同对端公钥之间相互串池。

8. 不能把 pending `operationId`、签名任务、site 回签结果落入持久化 DB。它们只属于半程事务，不是长期真值。

9. 不能因为“为了少改一点代码”把 `origins` 配置塞进 `commands` 记录里。命令历史和站点配置必须分 store。

10. 不能在 DB 不可用时继续尝试费用池。没有可靠状态存储，就不能安全维护池生命周期。

11. 不能新增新的对外错误码来承载“余额不足”“池不存在”“池需要重建”。对外错误码仍然收敛在现有协议集合里，真实原因留在本地历史。

12. 不能为了未来想象出来的多链 / 多池 / 多资产，先发明一套通用资金池平台。当前只做 `bsv` connect fee pool。

## 应该怎么做

### 一、先补 `docs`，再补 contracts，再补实现

先把协议文档钉死，再落 contract 和实现：

1. 总览文档补方法列表；
2. 公共文档补站点配置与命令历史持久化范围；
3. 新开 `p2pkh.transfer` 方法文档；
4. 新开 `fee pool` 方法文档；
5. 再改 `packages/contracts/src/protocol.ts`；
6. 最后改 `plugin-protocol` 实现与测试。

### 二、`p2pkh.transfer` 要走 Keymaster 自己的转账执行路径

执行路径建议固定为：

```txt
site request
  -> popup 读取 origin 配置
  -> 校验地址与金额
  -> 判断是否可自动确认
  -> 若不可自动确认则显示确认页
  -> 调 p2pkh service 预览/提交
  -> 对外返回 txid
```

确认页至少展示：

- 来源站点 origin
- 收款地址
- 转账金额
- 当前 origin 的“自动确认金额上限”状态

若余额不足：

- 仍显示确认页；
- 但只能拒绝，不能确认；
- 对外统一 `user_rejected`。

### 三、费用池走“Keymaster 做决策，site 只协签”的模型

`feepool.prepare` 处理逻辑固定为：

1. 读取 origin 配置；
2. 校验 `counterpartyPublicKeyHex` 与 `amountSatoshis`；
3. 查当前 origin + counterparty 的池状态；
4. 得出本次动作：
   - `create`
   - `spend`
   - `close_and_recreate`
5. 判断是否能自动签名；
6. 若不能自动签名则先显示确认页；
7. 生成 `operationId` 和 `signRequests`；
8. 把 pending operation 只放内存；
9. 对外返回 prepare result。

`feepool.commit` 处理逻辑固定为：

1. 校验 `operationId` 是否存在且属于当前 origin；
2. 校验 `signatures` 数量与 `signId` 对应关系；
3. 校验回签内容；
4. 执行最终交易组装与广播；
5. 更新 `feePools` store；
6. 清理内存中的 pending operation；
7. 返回 commit result。

### 四、首次费用池请求若缺站点配置，必须先让用户补齐

当某个 origin 第一次调用 `feepool.prepare` 且没有 `feePoolDefaultFundSatoshis` 时：

1. popup 不能偷偷猜默认值；
2. popup 必须先要求用户输入该 origin 的费用池缺省金额；
3. `feePoolAutoSignMaxSatoshis` 缺省为 `0`；
4. 用户取消则对外 `user_rejected`。

这样虽然多一步 UI，但比“系统擅自选一个默认金额”更可控，且不会把策略藏进代码常量。

### 五、站点配置读取失败时要区分 `p2pkh` 和 `fee pool`

若 `origins` store 读取失败：

`p2pkh.transfer`：

- 允许继续；
- 强制当作“自动确认关闭”；
- 不允许编辑配置；
- UI 显示“站点配置不可用，已降级为手动确认”。

`fee pool`：

- 必须 fail-closed；
- 因为缺少可靠配置与池状态真值，不能安全继续。

### 六、命令历史要补齐新方法的摘要字段

命令历史至少要能看出：

`p2pkh.transfer`

- `recipientAddress`
- `amountSatoshis`
- `decision`
- 本地真实失败原因

`feepool.prepare`

- `counterpartyPublicKeyHex`
- `amountSatoshis`
- `action`
- `decision`
- 本地真实失败原因

`feepool.commit`

- `operationId`
- `action`
- `decision`
- 本地真实失败原因

但仍然不持久化：

- 完整签名任务
- 完整回签结果
- 完整原始交易

## 特殊情况提前约定

### 情况 A：`p2pkh.transfer` 地址不合法

处理：

1. 直接判为 `invalid_request`。
2. 不进入确认页。
3. 不调 `p2pkhTransferService`。

### 情况 B：`p2pkh.transfer` 金额非正整数

处理：

1. 直接判为 `invalid_request`。
2. 不进入确认页。
3. 不做任何自动确认判断。

### 情况 C：`p2pkh.transfer` 满足自动确认阈值，但余额不足

处理：

1. 不允许自动确认。
2. popup 显示“余额不足，只能放弃”。
3. 用户只能拒绝。
4. 对外仍回 `user_rejected`。

### 情况 D：origin 配置不存在时第一次 `p2pkh.transfer`

处理：

1. 视为：
   - `p2pkhAutoApproveEnabled = false`
   - `p2pkhAutoApproveMaxSatoshis = 0`
2. 请求继续走人工确认。
3. 用户若主动开启自动确认并保存，才写入 `origins` store。

### 情况 E：第一次 `feepool.prepare`，origin 还没有 `feePoolDefaultFundSatoshis`

处理：

1. popup 先要求用户填写该值。
2. 未填写前不生成 `operationId`。
3. 用户取消则对外 `user_rejected`。

### 情况 F：`feepool.prepare` 找到旧池但余额不够

处理：

1. 本次 action 固定为 `close_and_recreate`。
2. 不能一边保留旧池，一边再偷偷建第二个池。
3. 关闭旧池与重建新池视为同一 operation。

### 情况 G：`feepool.prepare` 需要重建，但当前本地资金不足以重建

处理：

1. popup 本地提示“无法创建或重建费用池”。
2. 用户只能拒绝。
3. 对外回 `user_rejected`。
4. 本地历史写真实原因。

### 情况 H：`feepool.commit` 收到未知 `operationId`

处理：

1. 直接判为 `invalid_request`。
2. 不尝试推断或恢复旧 operation。
3. site 需要重新从 `feepool.prepare` 开始。

### 情况 I：`feepool.commit` 的 `operationId` 来自别的 origin

处理：

1. 直接判为 `invalid_request`。
2. 不允许跨 origin 复用 operation。

### 情况 J：popup 在 `prepare` 之后被刷新或关闭

处理：

1. 内存中的 pending operation 丢失。
2. `commit` 必然失败为 `invalid_request`。
3. site 重新走 `prepare`。

### 情况 K：`origins` store 可用，但 `feePools` store 不可用

处理：

1. `p2pkh.transfer` 仍可继续。
2. `fee pool` 必须 fail-closed。
3. 不允许把 fee pool 状态偷偷降级成内存态继续跑。

### 情况 L：同一 origin 更换 `counterpartyPublicKeyHex`

处理：

1. 视为另一条独立费用池命名空间。
2. 不能复用旧池。
3. 旧池仍按旧 key 继续存在，直到它自己被关闭。

## 文件级一次性迭代施工单

### 一、`docs`

#### 1. `docs/keymaster-protocol-v1-draft.md`

更新总览：

- 方法列表补入：
  - `p2pkh.transfer`
  - `feepool.prepare`
  - `feepool.commit`
- 说明 `fee pool` 是两步方法族，不是单步转账。

#### 2. `docs/keymaster-protocol-common-v1-draft.md`

补公共约定：

- 新增“站点配置”段，说明配置按 `exact origin` 存；
- 更新“命令流历史”段，补新方法的持久化范围；
- 明确历史与配置分 store；
- 明确 pending fee pool operation 不持久化。

#### 3. `docs/keymaster-p2pkh-transfer-v1-draft.md`（新增）

定义：

- 方法名 `p2pkh.transfer`
- 请求 / 成功结果 / 失败结果
- 自动确认金额上限语义
- 余额不足隐私边界
- 确认页展示要求

#### 4. `docs/keymaster-feepool-v1-draft.md`（新增）

定义：

- `feepool.prepare`
- `feepool.commit`
- `operationId`
- `action`
- `signRequests` / `signatures`
- 站点配置
- 费用池状态 key
- 首次配置与重建语义

### 二、`packages/contracts`

#### 5. `packages/contracts/src/protocol.ts`

扩展 contract：

- `PROTOCOL_METHODS` 补入三种新方法；
- 新增：
  - `P2pkhTransferParams`
  - `P2pkhTransferResult`
  - `FeepoolPrepareParams`
  - `FeepoolPrepareResult`
  - `FeepoolCommitParams`
  - `FeepoolCommitResult`
  - `ProtocolOriginSettingsRecord`
  - `ProtocolFeePoolRecord`
- 扩展 `ProtocolCommandRecord`，补新方法所需摘要字段；
- 若现有 `ProtocolCommandDb` 命名已不足以表达职责，直接硬切到：
  - `ProtocolStorageDb`
  - `PROTOCOL_STORAGE_DB_CAPABILITY`

#### 6. `packages/contracts/src/index.ts`

导出新增类型。

### 三、`packages/plugin-protocol`

#### 7. `packages/plugin-protocol/src/protocolValidation.ts`

新增三个方法的参数校验：

- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`

校验内容至少包括：

- 地址格式
- 公钥 hex 格式
- `amountSatoshis` 正整数
- `operationId` 非空
- `signatures` 结构合法

#### 8. `packages/plugin-protocol/src/protocolService.ts`

新增执行分发：

- `executeP2pkhTransfer()`
- `executeFeepoolPrepare()`
- `executeFeepoolCommit()`

并补：

- origin 配置读取
- 自动确认 / 自动签名判断
- pending operation 内存管理
- 本地真实失败原因记录

#### 9. `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

更新 popup UI：

- 顶部显示当前 origin 的 `p2pkh` 自动确认金额上限状态；
- `p2pkh.transfer` 确认页展示地址、金额、自动确认状态；
- `fee pool` 确认页展示对端公钥、金额、action、自动签名状态；
- 首次费用池请求缺配置时，允许在 popup 内先补 `feePoolDefaultFundSatoshis`。

#### 10. `packages/plugin-protocol/src/ProtocolCommandFeed.tsx`

更新命令流展示：

- 能展示新方法摘要；
- 能展示本地真实失败原因；
- 不展示完整签名任务 / 原始交易。

#### 11. `packages/plugin-protocol/src/protocolCommandDb.ts`

若保留当前文件名，则本文件职责升级为协议存储 DB owner；
若改名为 `protocolStorageDb.ts`，则连同 import 全量硬切。

无论文件名是否保留，都必须完成：

- DB version bump；
- 新增 `origins` store；
- 新增 `feePools` store；
- 命令历史读写兼容新方法；
- 不新增 `operations` store。

#### 12. `packages/plugin-protocol/src/manifest.ts`

更新 setup：

- 注入升级后的 protocol storage DB；
- 若存储不可用，向 UI 明确暴露：
  - `p2pkh` 降级
  - `fee pool` fail-closed

#### 13. `packages/plugin-protocol/src/index.ts`

导出新增 helper / type / service API。

### 四、`packages/plugin-p2pkh`

#### 14. `packages/plugin-p2pkh/src/p2pkhTransferService.ts`

确认 connect 调用路径是否可直接复用当前预览/提交能力。

本次要求：

- connect 不自己重写 P2PKH 广播逻辑；
- 若需要为 connect 补一层更小结果对象，可在 protocol service 层裁剪；
- 不要把站内 UI 的复杂 provider 语义直接暴露给 connect。

### 五、测试

#### 15. `packages/plugin-protocol/src/protocolService.test.ts`

补单测覆盖：

- `p2pkh.transfer` 正常成功
- 自动确认开启 / 关闭
- 地址非法
- 金额非法
- 余额不足但不对外泄漏
- `feepool.prepare` 三种 action
- `feepool.commit` 正常落地
- 丢失 `operationId`
- 跨 origin `operationId`
- DB 不可用时 `p2pkh` 降级 / `fee pool` fail-closed

#### 16. `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

补 UI 测试：

- 顶部自动确认金额上限展示
- `p2pkh.transfer` 余额不足时只有拒绝按钮
- 首次 fee pool 请求需要先补默认金额
- `prepare` 后 `commit` 前刷新导致 operation 丢失

#### 17. `packages/plugin-protocol/src/protocolCommandDb.test.ts`

若文件未改名则扩展现有测试；若改名则迁移测试文件名。

补覆盖：

- `origins` store 读写
- `feePools` store 读写
- DB migration
- 不存在 `operations` store

## 最终验收清单

### 一、文档验收

1. `docs/keymaster-protocol-v1-draft.md` 已把三种新方法纳入总览。
2. `docs/keymaster-protocol-common-v1-draft.md` 已明确站点配置、命令历史、费用池状态边界。
3. 已新增 `docs/keymaster-p2pkh-transfer-v1-draft.md`。
4. 已新增 `docs/keymaster-feepool-v1-draft.md`。
5. 文档里不再出现“最小值 / 最低金额”这种与行为冲突的阈值命名。

### 二、contract 验收

1. `packages/contracts/src/protocol.ts` 已补入：
   - `p2pkh.transfer`
   - `feepool.prepare`
   - `feepool.commit`
2. 新方法的 params/result 类型已经存在并导出。
3. 站点配置与费用池状态类型已经存在并导出。
4. 命令历史类型已经能表达新方法摘要。

### 三、P2PKH 转账验收

1. site 只需提交地址与金额即可发起 connect 转账。
2. popup 确认页文案由 Keymaster 自己生成，不接受 site 自定义确认文案。
3. 默认自动确认关闭。
4. 用户可按 origin 单独开启自动确认并设置金额上限。
5. `amountSatoshis <= 上限` 时可自动确认。
6. 余额不足时 popup 本地可见，但 site 对外只收到 `user_rejected`。
7. 成功时 site 能拿到最小成功结果，例如 `txid`。

### 四、费用池验收

1. 不存在单步 `feepool.transfer`。
2. `feepool.prepare` 能返回：
   - `operationId`
   - `action`
   - `signRequests`
3. `feepool.commit` 能消费 `operationId + signatures` 并完成落地。
4. `action` 三种路径都可覆盖：
   - `create`
   - `spend`
   - `close_and_recreate`
5. site 不需要保存池余额、池状态、重建决策。
6. 费用池状态按 `origin + counterpartyPublicKeyHex` 归档。
7. 首次 fee pool 请求若缺默认金额，popup 会要求用户先补配置。
8. popup 刷新或关闭后，旧 `operationId` 必须失效。

### 五、存储验收

1. `keymaster.protocol` 已至少有：
   - `commands`
   - `origins`
   - `feePools`
2. 没有 `operations` store。
3. `origins` 里的配置 key 是 `event.origin` 原样字符串。
4. `feePools` 里的 key 包含 `counterpartyPublicKeyHex`。
5. DB 不可用时：
   - `p2pkh.transfer` 会降级为手动确认
   - `fee pool` 会 fail-closed

### 六、安全边界验收

1. connect 转账请求无法自带伪装确认文案。
2. 余额不足不会自动对外暴露真实原因。
3. 费用池重建失败不会自动对外暴露真实原因。
4. `operationId` 不能跨 origin 使用。
5. `operationId` 不能跨 popup 刷新恢复。

### 七、特殊情况验收

1. 非法地址会直接 `invalid_request`。
2. 非法金额会直接 `invalid_request`。
3. 自动确认阈值命中但余额不足时，仍不能自动确认。
4. 旧池余额不足时，会走 `close_and_recreate`，不会偷偷并存双池。
5. 缺 `feePoolDefaultFundSatoshis` 时不会由系统私自猜默认值。
6. `feePools` store 不可用时，不会偷偷降级成内存态继续跑。

### 八、工程收口验收

1. 新增能力没有引入新的 transport 通道。
2. 没有引入协议级心跳。
3. 没有引入 `MessageChannel`。
4. 没有引入通用多步工作流框架。
5. 没有把站内 `plugin-transfer` UI 直接暴露给 connect。

### 九、施工单 002 收尾反馈 V4（钉死累计 B-Tx 草稿模型）

施工单 002 在前两轮实现中漂移成了"每次独立 spend tx"；实施者反馈
V2/V3 后**仍未收口**。本节明确**真实模型**，禁止再回到独立 spend
的语义。

#### 1. 真实模型是两笔 tx + 持续协商的 B-Tx 草稿

```
A-Tx（base tx，建池时定）：
  inputs:    client P2PKH UTXO（funding）
  outputs:   2-of-2 multisig output（= totalAmount = feePoolDefaultFundSatoshis）
  签名:      仅 client 签（funding inputs）；**不需要** server sig。
  状态:      一旦建好不变。

B-Tx（spend 草稿，持续协商）：
  inputs:    [上一笔 A-Tx 的 multisig output, index=baseTxOutputIndex]
  outputs:   server 拿 serverAmount；client 拿 change
  签名:      client + server 都在草稿上签
  状态:      每次 transfer **不**构造新独立 spend tx，
            而是在同一个 B-Tx 草稿上 update `serverAmount` 字段并重签。
```

#### 2. 三种 action 实际构造的 tx（V4 关键）

| action | A-Tx | B-Tx（主 transfer）| close 草稿（FINAL_LOCKTIME）|
| --- | --- | --- | --- |
| `create` | ✓ 新池 base | ✓ 初始草稿（`serverAmount = amountSatoshis`）| — |
| `spend` | — | **不是**构造新 tx；用 SDK `loadTx` 在 prior draft 上 `serverAmount += amountSatoshis` 并 client 重签 | — |
| `close_and_recreate` | ✓ 新池 base | ✓ 初始草稿（新池）| ✓ 把 prior draft 切到 `FINAL_LOCKTIME` 最终版本 |

**核心**：spend **不是**构造新独立 spend tx；是在同一个 B-Tx 草稿上
update `serverAmount` 字段并重签。

#### 3. 决策：累计，不是单次

`if (prior.serverAmount + amountSatoshis <= prior.totalAmount) → spend`
**else** → `close_and_recreate`

不是 `if (prior.totalAmount >= amountSatoshis)`；那样会忽略累计已
分配金额，导致 "余额不足" 永远走不进 close_and_recreate。

#### 4. close_and_recreate 不再是 dust spend 路径

- 用 SDK `loadTx(prior.draftSpendTxHex, locktime=FINAL_LOCKTIME, sequence=0xFFFFFFFF, serverAmount=prior.serverAmount+amountSatoshis, targetAmount=prior.totalAmount)`
  把**旧 B-Tx 草稿**切到 `FINAL_LOCKTIME` 最终版本；commit 落地即生效。
- **不**是另造一笔 "server 拿 dust" 的 spend tx。

#### 5. spend 不删池

- commit 后**同一条** pool record 仍在 `feePools` store；
- `totalAmount` 不变；`serverAmount` 累加；`draftSpendTxHex` 更新。
- close_and_recreate 同理：`putFeePool(newRecord)` 覆盖同一条 pool record。

#### 6. commit 验签参数要跟 prepare 的 spend 输入总额一致

- prepare：`sdkBuildSpendTx({totalAmount: baseResp.amount, ...})` 建 B-Tx 草稿。
- commit：验签时**必须**用 `op.draftTotalAmount`（= baseResp.amount = 池大小）。
- 不能用 `op.amountSatoshis`（那是 transfer 金额，不是池大小）。

#### 7. baseCounterpartySignatures 字段删除

- base tx 仅由 client 用 P2PKH UTXO funding 并签 inputs；server 不参与
  base tx 的签名（multisig output 是被**创建**的，不是被**花费**的）。
- `FeepoolCommitParams` 移除 `baseCounterpartySignatures` 字段。

#### 8. feepool.commit auto-sign 必须从 pending op 读 amountSatoshis

- `feepool.commit` 请求里**没有** `amountSatoshis` 字段。
- auto-sign 判断必须从 `pendingOps.get(operationId)?.amountSatoshis` 读；
  不能从 request params 读（永远拿到 0/undefined）。
- 仅当 `op.amountSatoshis <= feePoolAutoSignMaxSatoshis` 才走 auto-sign。

#### 9. 收口

- 协议层**只**接受 `feepool.prepare` / `feepool.commit` 两个 method。
- 不接受 `feepool.transfer` / `feepool.open` / `feepool.close` /
  `feepool.resume` / 通用多步工作流。
- 不引入 `MessageChannel` / 心跳 / 嵌套 request 子会话。
- `draftSpendTxHex` / `closeDraftTxHex` 是**草稿**；commit 落库后
  是"当前 B-Tx 协商结果"，**不是**已广播的最终 tx。
- 真广播留给 `plugin-multisigpool` 后续接入；本施工单范围内只完成
  协议骨架 + 落库。

### 十、施工单 002 收尾反馈 V5（钉死 SDK 调用细节）

V4 已把"两笔 tx + 持续协商 B-Tx 草稿"模型落实，但**SDK 调用细节**还有
3 个会让真实链上"签名失败 / 签名 preimage 不一致 / 旧数据落地"的问题。
本节钉死。

#### 1. close_and_recreate 的 close.serverAmount 只能是 prior.serverAmount

- SDK `loadTx` 只是 `outputs[0] = serverAmount`、`outputs[1] = totalAmount - serverAmount`，
  **没有**上限检查。
- 旧池总额 = `prior.totalAmount`；close.serverAmount 如果 > prior.totalAmount，
  change 输出 = 负数，签名失败。
- **正确语义**（V5 收口）：close.serverAmount = `prior.serverAmount`
  （旧池已累计金额，**不**加 site 的新请求 `amountSatoshis`）。
- 新请求的 `amountSatoshis` 由**新池**的初始 B-Tx 草稿承接：
  `buildInitialDraftSpendTx({totalAmount: baseResp.amount, serverAmount: params.amountSatoshis})`。
- 实测：若误用 `prior.serverAmount + params.amountSatoshis`（如 2000+2000=4000
  超过 prior.totalAmount=3000），change 输出会变成 `-1000`，签名抛错。

#### 2. spend 路径的 sequenceNumber 必须是**非零**

- SDK 的 update 签名 / 验签函数都用 `input.sequence || 1` 计算 sighash preimage。
- 传 `sequenceNumber: 0` 会让 sighash preimage 按 `1` 算，而实际 sequence
  是 `0`，导致"sighash preimage 与实际交易体不一致"，签名验证**会**失败。
- mock 测试看不出来（mock 不查 sighash 一致性）；真实链上是显式的不一致点。
- **正确做法**：V1 用 `0xfffffffe`（"近未来"——非零、但也不强制立即生效）。
- **禁止**在任何路径上传 `sequenceNumber: 0`。

#### 3. DB v2 → v3 迁移必须**清空** feePools store

- V3 给 `ProtocolFeePoolRecord` 加了 `draftSpendTxHex` / `draftClientSignBytes`
  字段；`serverAmount` 语义从"本次 transfer 金额"改为"累计"。
- 旧 v2 record 里**没有**这些字段；进入新版 `spend` 路径读取
  `prior.draftSpendTxHex` 会拿到 `undefined`。
- 后续 `loadTx(undefined, ...)` 抛错，spend 失败。
- **正确做法**（V5 收口）：`onupgradeneeded` 在 v2 → v3 时**delete + recreate**
  `feePools` store，**不**迁数据。site 第一次重新发起 transfer 时按新模型重建池。
- `onupgradeneeded` 旧实现**只** `createObjectStore`（如果不存在），**没有**
  清空旧 record——所以旧 v2 record 仍残留在 v3 store 里，触发上述 bug。

#### 4. 收口

- V4 模型 + V5 SDK 细节共同形成"累计 B-Tx 草稿"语义的可工作实现。
- 进一步优化（更多测试、更多 action 变体、plugin-multisigpool 接入）留给后续施工单。
