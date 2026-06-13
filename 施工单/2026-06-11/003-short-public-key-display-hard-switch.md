# 003 Key 展示统一改为“短公钥”，废弃指纹概念硬切换施工单

## 目标

一次性把 Key 的用户可见展示模型切换为下面这套明确语义：

```txt
完整公钥（publicKeyHex）
  = Key 的完整公开材料
  = 系统内传递、导出、复制时使用的真实内容

短公钥（xxxx...yyyy）
  = 完整公钥的显示格式
  = 只存在于 UI 视图层
  = 不是新字段，不落库，不参与接口传递

指纹（fingerprint）
  = 废弃
  = 不再作为产品词汇、展示字段、契约字段、持久化写入字段

内部稳定引用
  = keyId / publicKeyHash
  ≠ 短公钥
  ≠ 完整公钥显示串
```

本次是硬切换，不接受“先把 UI 文案从指纹改成公钥，内部继续传 fingerprint”或“先保留两套展示概念，后面再慢慢删旧字段”这类中间态。

## 简述缘由

1. 当前产品同时展示“公钥”和“指纹”，而 `fingerprint` 实际上并不是另一份独立密码学材料，而是从公钥身份再派生出来的短展示串。这会把用户心智带偏成“这两个东西都很重要，但又看不出区别”。

2. 对用户真正有意义、能跨系统流通、能导出和核对的公开材料是 `publicKeyHex`，不是 `fingerprint`。如果产品把“指纹”摆到一线位置，用户会误以为它也能拿去互操作或作为唯一引用。

3. 当前 `fingerprint` 还是从 `publicKeyHash` 截出来的，不是从公钥直接截断。这意味着：
   - 用户看到的短串和完整公钥没有直接视觉对应关系；
   - 页面上会出现“公钥一列 + 指纹一列”的重复认知负担；
   - 一旦用户想复制、对账或和外部钱包比对，仍然只能回到完整公钥。

4. 正确的模型应该是：

```txt
用户只认识“公钥”
  完整公钥用于复制 / 导出 / 对账
  短公钥用于列表 / 顶栏 / 狭窄区域显示

系统只把“短公钥”当显示格式
  不把它变成独立身份字段
```

5. 这样既保留了 UI 的紧凑性，也消除了“指纹到底是什么”的额外学习成本。

## 硬切换结论

本次统一采用下面的产品与工程定义：

```txt
对人展示
  默认显示短公钥

点击展开 / 详情查看
  显示完整公钥

复制动作
  永远复制完整公钥

契约 / 存储 / 业务对象
  不再包含 fingerprint

短公钥
  由 formatShortPublicKey(publicKeyHex) 运行时现算
  不持久化，不通过 MessageBus / contracts 传递
```

这意味着：

1. “指纹”这个词不再出现在产品文案里。
2. `fingerprint` 不再是 `KeyIdentity` / `KeyRef` / `ReadyKeyIdentity` 的一部分。
3. 所有 UI 上原来显示 `fingerprint` 的位置，都改成显示 `publicKeyHex` 的短格式。
4. 系统对外复制、导出、跨插件传递，仍然使用完整 `publicKeyHex`。
5. 内部查找、active key、namespace、删除流程，继续使用 `keyId` / `publicKeyHash`，不改成公钥显示串。

## 不能怎么做

1. 不能只把“指纹”列标题改成“公钥”，底层仍然显示 `publicKeyHash` 的截断串。那只是换皮，不是切模型。

2. 不能再新增一个 `shortPublicKey`、`displayPublicKey` 或同类持久化字段。短公钥是视图格式，不是数据字段。

3. 不能让任何复制按钮复制 `xxxx...yyyy` 这种截断串。复制必须拿完整 `publicKeyHex`。

4. 不能把短公钥当主键、查找键、删除确认口令、路由参数或接口入参。

5. 不能保留“有的页面显示短公钥，有的页面还显示指纹”这种双轨状态。顶栏、Key 管理、资产页、转账页、创建成功提示等入口必须一次性统一。

6. 不能在 `publicKeyHex` 缺失时伪造短公钥，更不能从 `publicKeyHash` 继续生成“过渡用指纹”顶上。没有公钥就明确显示“身份不可用”。

7. 不能为了少改代码，继续在 contracts、vaultDb、message payload、测试 fixture 中保留 `fingerprint`，只在 React 组件层做一层映射。这样旧概念会继续外溢。

8. 不能在 IndexedDB 回写时使用：

```ts
const next = { ...current, ...identity }
```

如果 `current` 是老记录且带有 `fingerprint`，这种写法会把旧字段继续续命。必须显式构造允许保留的字段。

9. 不能把完整公钥默认整段铺在窄列表、顶栏切换器、移动端行项里。那会直接破坏信息密度和交互可用性。

10. 不能为了“去掉指纹”而改掉内部稳定引用，把所有 service 都改成用 `publicKeyHex` 查找。机器引用仍然应该是 `keyId` / `publicKeyHash`。

## 应该怎么做

### 总体策略

把“短公钥”明确收敛为一个共享显示 helper，而不是一个新字段：

```ts
formatShortPublicKey(publicKeyHex: string): string
```

建议默认格式固定为：

```txt
前 8 位 + "..." + 后 8 位
```

例如：

```txt
02fc6c87...f92752a1
```

约束：

1. 使用 ASCII `...`，不使用 Unicode `…`，避免用户截图、搜索、肉眼比对时出现不一致。
2. 所有 UI 必须走同一个 helper，不能每个组件自己 `slice()`。
3. helper 只做展示，不做校验、不做引用、不做持久化。

### 数据与契约模型必须这样收敛

1. `KeyIdentity` 只保留：
   - `keyId`
   - `publicKeyHex`
   - `publicKeyHash`
   - `label`
   - `capabilities`
   - `createdAt`
   - `identityStatus`
   - `identityError`

2. `KeyRef` 只保留完整公钥 `publicKeyHex`，不再保留 `fingerprint`。

3. `ReadyKeyIdentity` 也不再要求 `fingerprint` 必填；只要求 `publicKeyHex` 与 `publicKeyHash`。

4. `BackgroundTaskKeyScope` 若需要附带展示元信息，应改为：
   - `label?: string`
   - `publicKeyHex?: string`

而不是继续传 `fingerprint`。

### UI 语义必须这样定

#### Key 管理列表

1. 保留“公钥”列。
2. 废弃“指纹”列。
3. 默认在“公钥”列显示短公钥。
4. 行内提供“展开公钥”和“复制公钥”动作。
5. 展开后显示完整 `publicKeyHex`。
6. 复制永远复制完整 `publicKeyHex`。

#### 顶栏当前 Key / Key Switch

1. 单 key 模式显示：

```txt
label + 短公钥
```

2. 下拉列表每项显示：

```txt
label
短公钥
capabilities
```

3. 不再显示 `fingerprint` 文案或 class 语义。

#### 资产页 / 转账页等业务上下文

1. 当前 key 上下文统一显示 `label + 短公钥`。
2. 不再出现“label + fingerprint”。
3. 当业务页需要复制公钥时，仍复制完整 `publicKeyHex`。

#### 新建 Key 成功提示

1. 成功提示展示“公钥”而不是“指纹”。
2. 默认显示短公钥。
3. 提供查看完整公钥和复制完整公钥的动作。

#### 删除确认

1. 删除授权仍然是密码，不受本次影响。
2. 目标 key 复核信息从“标签 + 指纹”切到“标签 + 短公钥（如果可用）”。
3. 若该 key 没有 `publicKeyHex`，则显示“身份不可用”，不强行拼展示串。

## 特殊情况提前约定

### 情况 1：failed / uninitialized key 没有 publicKeyHex

处理原则：

```txt
没有完整公钥
就不显示短公钥
```

应该这样做：

1. 列表显示“身份不可用”。
2. 不显示复制公钥动作。
3. 不显示展开完整公钥动作。
4. 删除确认中若需要复核目标，只显示标签、状态、创建时间等已有信息。

不能这样做：

1. 不能从 `publicKeyHash` 反向拼一个“假的短公钥”。
2. 不能继续复用旧 `fingerprint` 兜底。

### 情况 2：旧库记录里仍然残留 fingerprint 字段

处理原则：

```txt
允许旧数据残留
但系统不得再读取、回写、透传它
```

应该这样做：

1. 读取时忽略 `fingerprint`。
2. 新写入记录时不再写 `fingerprint`。
3. 回写 identity / status 时显式构造对象，避免 `...current` 把旧字段继续写回。

不能这样做：

1. 不能为了“兼容旧库”继续让新 contracts 和新 UI 依赖 `fingerprint`。
2. 不能专门为了删除旧字段而阻塞本次硬切换上线；行为切换优先，存量字段清理以“不再被读取/写入”为准。

### 情况 3：两个 Key 标签相同

处理原则：

```txt
列表靠短公钥区分
不是靠指纹区分
```

应该这样做：

1. 顶栏、列表、选择器都显示 `label + 短公钥`。
2. 如果某条记录没有 `publicKeyHex`，则退回显示：

```txt
label + 状态 + 创建时间
```

原因：

```txt
短公钥本来就是完整公钥的显示态，足以承担人工区分。
```

### 情况 4：用户点击复制，但浏览器剪贴板失败

处理原则：

```txt
复制失败不改变展示模型
```

应该这样做：

1. 错误提示清楚说明复制失败。
2. 若页面已展开完整公钥，用户仍可手动选择复制。

不能这样做：

1. 不能在复制失败时退回复制短公钥。

### 情况 5：窄屏与顶栏宽度不足

处理原则：

```txt
继续显示短公钥
不把完整公钥硬塞进狭窄容器
```

应该这样做：

1. 顶栏与移动端列表只显示短公钥。
2. 完整公钥只在展开区、详情区、复制动作中出现。
3. CSS class 语义从 `fingerprint` 改为 `pubkey` 或 `short-pubkey`，避免名称漂移。

### 情况 6：业务插件当前 contract 还要求 fingerprint 必填

处理原则：

```txt
本次一起收口
不留兼容桥
```

应该这样做：

1. 直接把业务 contract 改成要求 `publicKeyHex` 必填。
2. 业务组件自行格式化短公钥显示。
3. 不新增“临时同时传 fingerprint + publicKeyHex”的过渡字段。

## 文件级施工

### 1. packages/contracts/src/keyspace.ts

调整 `KeyIdentity` 契约。

必须这样改：

1. 删除 `fingerprint?: string`。
2. 注释改成“ready key 必须有 `publicKeyHex` / `publicKeyHash`”。
3. 所有关于“短展示指纹”的注释改为“短公钥属于 UI 格式，不在 contract 中持有”。

### 2. packages/contracts/src/vault.ts

调整 `KeyRef` 契约。

必须这样改：

1. 删除 `fingerprint?: string`。
2. 注释明确：
   - `publicKeyHex` 是完整公钥
   - 短公钥不是字段

### 3. packages/contracts/src/background.ts

调整 `BackgroundTaskKeyScope`。

建议这样改：

1. 删除 `fingerprint?: string`。
2. 如保留展示元信息，改为 `publicKeyHex?: string`。
3. 注释明确：任务如需显示 key 上下文，应在 UI 侧由 `publicKeyHex` 现算短公钥。

### 4. packages/contracts/src/index.ts

导出新的共享显示 helper。

必须这样改：

1. 新增并导出 `formatShortPublicKey(publicKeyHex: string): string`。
2. 供 vault、assets、p2pkh、未来插件统一复用。

### 5. packages/contracts/src/keyDisplay.ts

新增纯函数文件。

建议内容：

```ts
export function formatShortPublicKey(publicKeyHex: string): string
```

约束：

1. 入参必须是完整压缩公钥 hex。
2. 太短直接抛英文错误，例如 `Public key too short`。
3. 输出固定为 `前 8 + ... + 后 8`。

设计缘由：

1. 让“短公钥只是显示格式”成为共享工程事实。
2. 防止各组件自行切片导致格式漂移。

### 6. packages/plugin-vault/src/keyIdentity.ts

删除指纹派生逻辑。

必须这样改：

1. `KeyIdentityFields` 删除 `fingerprint`。
2. `deriveKeyIdentity()` 只返回 `publicKeyHex` 与 `publicKeyHash`。
3. `identityFromPublicKeyHex()` 只返回 `publicKeyHex` 与 `publicKeyHash`。
4. 删除 `makeFingerprint()` 及其注释。

不能这样改：

1. 不能保留 `makeFingerprint()` 但只是不再显示。那会继续诱导后续代码依赖它。

### 7. packages/plugin-vault/src/vaultDb.ts

收紧 Vault 持久化模型。

必须这样改：

1. `VaultKeyRecord` 删除 `fingerprint?: string` 类型字段。
2. `putKeyIdentity()` 入参删除 `fingerprint`。
3. 所有回写 identity / ready / failed 的路径，显式构造允许保留的字段，避免把旧 `fingerprint` 原样 spread 回去。
4. 注释明确：旧库可能残留 `fingerprint`，但新代码不再读写。

注意：

1. 本次不必为了删除旧字段单独升级 DB version。
2. 但绝不能继续让新写入路径把它带回来。

### 8. packages/plugin-vault/src/vaultService.ts

移除对 `fingerprint` 的所有生成、缓存、回写、返回。

必须这样改：

1. `listKeys()` / `exportPrivateKey()` / `generateKey()` / backfill 路径都不再读写 `fingerprint`。
2. identity backfill 只负责补：
   - `publicKeyHex`
   - `publicKeyHash`
3. 若有内存 notice / 页面返回对象引用到 `fingerprint`，一并删掉。

### 9. packages/plugin-vault/src/keyspaceService.ts

收紧平台公开身份对象。

必须这样改：

1. `listKeys()` / `getKey()` 返回值不再包含 `fingerprint`。
2. active candidate 的 ready 判定只依赖：
   - `identityStatus === "ready"`
   - `publicKeyHash`
   - `publicKeyHex`
3. 任何“兜底空对象”不要再塞 `fingerprint: ""`。

### 10. packages/plugin-vault/src/KeySwitchWidget.tsx

顶栏切换器改为显示短公钥。

必须这样改：

1. 引入共享 `formatShortPublicKey()`。
2. `current.fingerprint` 改为 `formatShortPublicKey(current.publicKeyHex)`。
3. 下拉项中的 `k.fingerprint` 同样改掉。
4. CSS class 从 `key-switch__fingerprint` 改名为 `key-switch__pubkey` 或等价语义。

### 11. packages/plugin-vault/src/VaultSettingsPage.tsx

Key 管理页是本次改造核心页面。

必须这样改：

1. 删除“指纹”列。
2. “公钥”列默认显示短公钥，不默认整段显示完整公钥。
3. 保留展开完整公钥能力。
4. 增加复制完整公钥动作。
5. 删除页内任何 `fingerprint` 透传、回填、构造。
6. 删除确认弹窗传参改成 `publicKeyHex` 或直接传完整 `KeyIdentity`，由弹窗内部决定如何显示短公钥。

不能这样改：

1. 不能保留“指纹列 + 公钥列”双列并存。
2. 不能让复制按钮复制当前屏幕上的短公钥文本。

### 12. packages/plugin-vault/src/VaultKeyCreateModal.tsx

新建成功反馈改为公钥语义。

必须这样改：

1. “后续管理列表按指纹区分”改为“后续管理列表按公钥区分”或更准确地写“按短公钥区分”。
2. 成功摘要展示“公钥”而不是“指纹”。
3. 默认显示短公钥，并提供复制完整公钥动作。

### 13. packages/plugin-vault/src/VaultKeyDeleteModal.tsx

删除确认只改展示，不改授权模型。

必须这样改：

1. 目标 key 展示字段从 `keyFingerprint` 改为 `publicKeyHex` 或 `shortPublicKey` 现算值。
2. 如果有 `publicKeyHex`，显示短公钥辅助复核。
3. 如果没有 `publicKeyHex`，显示“身份不可用”。

不能这样改：

1. 不能为了这次显示调整，重新把删除授权改回“输入公钥/短公钥”。

### 14. packages/plugin-vault/src/manifest.ts

统一中英文文案键值。

必须这样改：

1. 删除或重命名所有 `fingerprint` 相关文案键。
2. 新增或统一：
   - `vault.settings.col.pubkey`
   - `vault.settings.action.copyPubkey`
   - `vault.settings.action.collapsePubkey`
   - `vault.keyCreate.success.publicKey`
   - 其他必要短公钥文案
3. 所有“按指纹区分”的提示改掉。

### 15. packages/plugin-assets/src/AssetsPage.tsx

资产页当前 key 上下文改为短公钥。

必须这样改：

1. `label（fingerprint）` 改成 `label（短公钥）`。
2. 通过 `publicKeyHex` 现算，不再读取 `identity.fingerprint`。
3. 没有 `publicKeyHex` 时返回“身份不可用”或“无 key”，不制造旧指纹兜底。

### 16. packages/plugin-p2pkh/src/p2pkhContracts.ts

收紧 `ReadyKeyIdentity`。

必须这样改：

1. 删除 `fingerprint: string`。
2. `requireReadyKey()` 不再要求 `fingerprint` 存在。
3. 改为只断言：
   - `publicKeyHash`
   - `publicKeyHex`

### 17. packages/plugin-p2pkh/src/p2pkhService.ts

移除业务层对 `fingerprint` 的依赖。

必须这样改：

1. `activeIdentity` 类型和资源对象不再含 `fingerprint`。
2. `p2pkhTaskKeyScope()` 若带展示信息，改传 `publicKeyHex` 而不是 `fingerprint`。
3. 任何事件 payload 如无必要，不再塞 `fingerprint`。

### 18. packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx

当前 key 展示改为短公钥。

必须这样改：

1. 顶部“当前 key”区域显示 `label + 短公钥`。
2. 注释从“label + fingerprint”改成“label + 短公钥”。
3. class 语义改名，避免继续叫 `__fingerprint`。

### 19. apps/web/src/styles/global.css

同步样式命名。

必须这样改：

1. `key-switch__fingerprint` 等 class 改为 `key-switch__pubkey` 或等价名称。
2. 若 Vault 页面、P2PKH 页面还有 `fingerprint` 命名样式，一并改掉。
3. 样式效果保持现有紧凑单行显示，不因这次改名破坏布局。

### 20. 测试文件

至少需要覆盖这些文件：

1. `packages/plugin-vault/src/vaultService.test.ts`
2. `packages/plugin-vault/src/keyspaceService.test.ts`
3. `packages/plugin-p2pkh/src/p2pkhDb.test.ts`
4. `packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts`
5. 其他任何手写了 `fingerprint` fixture 的测试

必须这样改：

1. fixture 改成只提供 `publicKeyHex` / `publicKeyHash`。
2. 展示断言改为断言短公钥格式或完整公钥复制行为。
3. 不保留“为了兼容旧字段，测试继续传 fingerprint”的写法。

## 实施顺序

本次虽然是硬切换，但落地顺序仍应固定，避免半改态：

1. 先改 contracts 与共享 helper，锁死模型和显示格式。
2. 再改 vault identity 派生、vaultDb、vaultService、keyspaceService，彻底停止 `fingerprint` 的生成与传递。
3. 再改 vault 相关 UI：KeySwitch、Settings、Create/Delete Modal、manifest、样式。
4. 再改业务页：assets、p2pkh transfer、其他读取当前 key 展示上下文的组件。
5. 最后统一改测试 fixture 和断言。

注意：

```txt
提交可以按文件分批
语义不能以“contracts 已删 fingerprint，但 service/UI 仍偷偷构造 fingerprint”
的中间态合入
```

## 最终验收清单

- [ ] 产品文案中不再出现“指纹”一词。
- [ ] `KeyIdentity`、`KeyRef`、`ReadyKeyIdentity`、`BackgroundTaskKeyScope` 不再包含 `fingerprint`。
- [ ] 系统内不再生成、回写、透传 `fingerprint`。
- [ ] `deriveKeyIdentity()` 与 `identityFromPublicKeyHex()` 只派生 `publicKeyHex` / `publicKeyHash`。
- [ ] 短公钥有且只有一个共享格式化 helper。
- [ ] 短公钥格式固定为 `前 8 + ... + 后 8`。
- [ ] Key 管理页不再有“指纹”列。
- [ ] Key 管理页默认显示短公钥，展开后可查看完整公钥。
- [ ] Key 管理页提供复制完整公钥动作，复制内容不是截断串。
- [ ] 顶栏 Key Switch 显示 `label + 短公钥`。
- [ ] 资产页当前 key 上下文显示 `label + 短公钥`。
- [ ] P2PKH 转账页当前 key 上下文显示 `label + 短公钥`。
- [ ] 新建 Key 成功提示显示“公钥”，不再显示“指纹”。
- [ ] 删除确认只把短公钥作为目标复核信息，删除授权仍然是密码。
- [ ] `publicKeyHex` 缺失的 key 不会伪造短公钥，而是显示“身份不可用”。
- [ ] 旧库残留的 `fingerprint` 字段不会再被读取、展示或写回续命。
- [ ] 所有相关 fixture、测试、样式命名都已完成从 `fingerprint` 到 `publicKey` 语义的切换。
- [ ] 文档、注释使用中文；代码错误信息保持英文。

## 本次明确不做

1. 不改内部稳定引用策略；`keyId` / `publicKeyHash` 仍然是机器引用主路径。
2. 不因为这次需求把所有业务逻辑都改成用 `publicKeyHex` 查找对象。
3. 不增加新的持久化展示字段，如 `shortPublicKey`。
4. 不为了清除旧库中的历史 `fingerprint` 残留而单独设计数据迁移批处理；本次目标是“新系统不再依赖、不再写回”。
