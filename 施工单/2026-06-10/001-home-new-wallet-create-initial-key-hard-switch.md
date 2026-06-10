# 001 首页“新建钱包即生成首把 Key”硬切换施工单

## 目标

一次性把首页首启流程切换为下面这套明确语义：

```txt
首次进入应用
  新建钱包      -> 创建 Vault 密码 + 立即生成第一把 Key
  导入私钥      -> 创建 Vault 密码 + 进入 /import 导入已有私钥

创建完成后进入已解锁主界面
  Key 管理里能看到刚创建的第一把 Key
  锁屏密码立即可用
  active key 已经是这把新 Key
```

本次是硬切换，不接受“先只改文案”“先允许空钱包、以后再补自动生成首 Key”这类中间态。

## 简述缘由

1. 当前首页“新建钱包”实际只调用 `createVault(password)`，创建的是 Vault 和锁屏密码，不会生成私钥。
2. 这会导致用户心智和系统行为错位：用户以为自己“创建了钱包”，但 Key 管理里是空的。
3. Key 管理页面当前按 `keyspace.listKeys()` 读取真实 Key 列表，本身没有问题。真正的问题在于首页新建流程没有落第一把 Key。
4. 继续保留“空 Vault 也叫新建钱包”的语义，会把所有首次使用者都带入“已解锁但 0 key”的尴尬状态，后续资产、转账、联系人、同步都只能继续做兜底。
5. `createVault()` 仍然有保留价值，因为“导入私钥”流程需要先有一个空 Vault 才能保存外部私钥。问题不是 `createVault()` 错，而是首页“新建钱包”用错了入口。

## 硬切换结论

本次统一采用下面的产品定义：

```txt
新建钱包
  = 创建 Vault + 生成首把 Key

导入私钥
  = 创建 Vault + 跳转导入流程

createVault()
  = 底层能力，只表示创建空 Vault，不再直接作为“新建钱包”对用户暴露
```

这意味着：

1. 首页“新建钱包”必须改走新的高层能力。
2. 首页“导入私钥”继续允许先创建空 Vault。
3. Key 管理页不需要为这个问题发明“伪 Key”“默认占位 Key”或额外列表兜底。

## 不能怎么做

1. 不能只改首页文案，把“新建钱包”改成“创建密码”就算结束。这样只是把产品缺陷转成命名规避，没有解决第一次进入主界面没有 Key 的根因。
2. 不能把首把 Key 的生成放在 React 组件、页面 effect、路由跳转后补跑，私钥生成必须属于 Vault 安全边界。
3. 不能让首页先 `createVault()` 成功，再依赖用户自己去 Key 管理页点“新建 Key”。这仍然是两步心智，不符合“新建钱包”的语义。
4. 不能在 Key 管理页里伪造一条“默认 Key”占位记录。列表必须只展示真实落库的 Key。
5. 不能为了兼容旧逻辑把 `createVault()` 直接偷偷改成“永远自动生成首把 Key”。这样会破坏“导入私钥”分支需要空 Vault 的前提。
6. 不能在首页生成首 Key 时绕过 `vault.generateKey()` 现有持久化链路，另写一套加密、落库、切 active、发事件的旁路实现。
7. 不能把私钥材料放进 React state、MessageBus payload、URL、日志或错误对象里。
8. 不能把“active 切换失败”“导出失败”“列表刷新失败”误判成“没有创建 Key”，这些都是后续状态处理问题，不能回滚成伪失败提示。

## 应该怎么做

### 总体策略

新增一个面向首启流程的高层能力，例如：

```ts
createVaultWithInitialKey(input: {
  password: string;
  label?: string;
  capabilities?: string[];
}): Promise<KeyRef>
```

语义固定为：

```txt
创建空 Vault
生成第一把 Key
把新 Key 设为 active
返回公开 KeyRef
```

而不是让页面自己编排：

```txt
createVault()
generateKey()
自己猜异常该怎么处理
```

### 这样做的缘由

1. 首启“新建钱包”是一个业务动作，不是两个彼此无关的底层调用。
2. 事务边界必须由 Vault 自己掌握，页面层不应该知道“创建成功但首 Key 失败时要不要回滚 meta、要不要清理内存 masterKey、要不要保留已落库 key”。
3. 现有 `generateKey()` 已经走正确的持久化路径：派生身份、查重、加密落库、通知 keyspace、发布事件。首把 Key 必须复用这条路径，不能复制实现。

## 特殊情况提前约定

### 情况 1：`createVault()` 成功，但 `generateKey()` 失败

处理原则：

```txt
这次“新建钱包”整体失败
不能把用户悄悄留在“已创建空 Vault 但没有 Key”的状态
```

建议处理：

1. 该高层能力内部负责回滚刚创建的 Vault meta。
2. 清理内存里的 `masterKey / masterSalt`，状态回到 `uninitialized`。
3. 页面给用户一个明确失败提示，允许重试。

原因：

```txt
“新建钱包”失败时留下一个空 Vault，是制造另一类更难理解的脏状态。
```

### 情况 2：首 Key 已落库，但自动设为 active 失败

处理原则：

```txt
这不是完全失败，而是“已创建但未自动激活”
```

建议处理：

1. 复用现有 `KeyPersistedButActivationFailedError` 语义。
2. 不删除已落库的首 Key。
3. 允许新建流程继续进入主界面，但要给出明确 notice：

```txt
Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。
```

原因：

```txt
私钥已经安全落库，回滚只会把真实状态藏起来，甚至诱发重复生成。
```

### 情况 3：用户选择“导入私钥”分支

处理原则：

```txt
保留空 Vault 语义
不自动生成首 Key
```

建议处理：

1. 继续走 `createVault(password)`。
2. 成功后直接跳转 `/import`。
3. 如果用户中途取消导入，允许他暂时停留在“已解锁但 0 key”的状态。

原因：

```txt
导入分支的目标是保存外部已有私钥，不应该强塞一把额外生成的 Key。
```

### 情况 4：浏览器刷新或新会话重新解锁

处理原则：

```txt
首 Key 只在首启“新建钱包”时生成一次
后续 unlock 绝不能重复生成
```

建议处理：

1. 新能力只在 `status === "uninitialized"` 时允许调用。
2. 解锁路径继续只做 `unlock(password)`。
3. 测试要明确覆盖“第二次 unlock 不会新增 Key”。

### 情况 5：默认标签

处理原则：

```txt
可以给默认标签
但标签不是身份主键
```

建议处理：

1. 首页新建钱包时可以不给用户多一步表单，直接用系统默认标签，例如：

```txt
Key YYYY-MM-DD HH:mm
```

2. 如果后续产品要让首启就自定义标签，应在同一能力上扩展 `label`，不要再拆出另一条流程。

原因：

```txt
首启主流程的目标是“把钱包可用状态建立起来”，不是让用户先处理命名细节。
```

## 文件级施工

### packages/contracts/src/vault.ts

新增首启高层能力契约：

```ts
createVaultWithInitialKey(input: {
  password: string;
  label?: string;
  capabilities?: string[];
}): Promise<KeyRef>;
```

要求：

1. 注释明确它只服务“新建钱包”语义。
2. 注释明确 `createVault()` 仍表示“创建空 Vault”。
3. 错误信息代码里继续使用英文。

### packages/plugin-vault/src/vaultService.ts

实现 `createVaultWithInitialKey(...)`。

推荐内部顺序：

```txt
校验当前状态必须是 uninitialized
await createVault(password)
try
  await generateKey({ label: defaultLabel, capabilities })
catch
  如果是“刚创建的空 Vault + 尚无其他 Key”的失败场景
    回滚 meta
    清理内存会话
    回到 uninitialized
  然后把原始错误抛给上层
```

注意事项：

1. 不能复制 `generateKey()` 的私钥生成与持久化代码，必须复用现有 `generateKey()`。
2. 回滚只适用于“首启新建钱包”这条全新事务，不要把通用 `createVault()` 行为改成失败就删除一切。
3. 如果命中 `KeyPersistedButActivationFailedError`，不回滚已落库 Key；让上层按“已创建但未自动激活”处理。
4. 默认标签生成逻辑建议收敛在 Vault 插件内部或共用小工具中，避免 shell 和管理页各写一套不同格式。

### packages/plugin-vault/src/vaultService.test.ts

补测试，至少覆盖：

1. `createVaultWithInitialKey()` 成功后：
   - Vault 状态是 `unlocked`
   - `listKeys()` 长度为 1
   - 新 Key 可见
   - `keyspace.active()` 指向这把 Key
2. `createVaultWithInitialKey()` 失败时：
   - 如果首 Key 未落库，则状态回到 `uninitialized`
   - 新实例 bootstrap 后也应读到 `uninitialized`
3. `KeyPersistedButActivationFailedError` 分支：
   - 首 Key 仍在 DB 中
   - 不被误回滚
4. `createVault()` 老语义保持不变：
   - 仍然允许创建空 Vault
   - 不自动生成 Key

### apps/web/src/shell/LockedShell.tsx

调整首启流程分流：

1. `pending === "new"` 时调用 `vault.createVaultWithInitialKey(...)`。
2. `pending === "import"` 时继续调用 `vault.createVault(password)`。
3. “新建钱包”分支的成功不再只是“密码已设置”，而是“钱包已建好并带首 Key”。
4. 如果 `createVaultWithInitialKey` 返回“已创建但未自动激活”的可恢复状态，要把 notice 带到下一屏，不能展示成完全失败。

### packages/plugin-vault/src/VaultCreatePage.tsx

如果这个路由仍保留给独立入口使用，需要同步切换语义。

要求：

1. 页面标题和提交行为应与首页“新建钱包”保持一致。
2. 不允许这个页面继续只创建空 Vault，否则同一个产品动作会存在两套相互矛盾的结果。

如果该页面已无正式入口，也应至少在注释里声明它是首启“新建钱包”页，而不是“只设密码”页。

### apps/web/src/i18n/resources.ts

修正文案，至少包括：

1. “新建钱包”描述不再强调“创建空的 BSV 钱包，之后再导入私钥”。
2. 应改为类似：

```txt
设置一个本地密码，并立即生成你的第一把 Key。之后可以继续导入其他私钥。
```

3. “导入私钥”卡片保留“先创建 Vault 再导入”的描述。
4. 失败提示如果区分“创建 Vault 失败”和“生成首 Key 失败”，要明确中文文案，不要都笼统叫“创建失败”。

### packages/plugin-vault/src/manifest.ts

同步 Vault 插件内 i18n 资源：

1. `vault.create.*` 相关文案要与新的“创建钱包=生成首 Key”语义一致。
2. 如新增 notice / 警告文案，也在这里补齐。

### 可选触点：packages/plugin-vault/src/VaultSettingsPage.tsx

这页不是本次主修复点，但建议补一条说明性防御：

1. 当系统因为“首 Key 已创建但未自动激活”进入主界面时，页面顶部要能展示已有的 notice。
2. 不要因为首次进入看到 0 key 就新增额外兜底逻辑；硬切换完成后，“新建钱包”路径正常不应再落到 0 key。

## 最终交付口径

交付完成后，对外只保留下面这套解释：

```txt
新建钱包：创建本地 Vault，并自动生成第一把 Key。
导入私钥：创建本地 Vault，然后导入已有私钥。
Key 管理：展示所有真实已保存的 Key。
```

不再使用下面这些说法：

```txt
新建钱包只是设置密码
钱包创建后没有 Key 是正常的
先去管理页再手动补第一把 Key
```

## 最终验收清单

### 首启新建钱包

1. 首次进入应用，点击“新建钱包”。
2. 输入合法密码并提交。
3. 进入已解锁主界面后，打开 Key 管理。
4. 列表中能看到 1 把新生成的 Key。
5. 顶栏 Key Switch 显示这把 Key，而不是“无 key”或“未选择”。
6. 锁定后用刚才的密码可以再次解锁。
7. 再次进入 Key 管理，仍只有这 1 把 Key，不会重复新增。

### 首启导入私钥

1. 首次进入应用，点击“导入私钥”。
2. 输入合法密码并提交。
3. 成功跳转到 `/import`。
4. 在真正导入前，Key 管理可以为空。
5. 导入完成后，Key 管理出现导入的 Key。

### 失败与回滚

1. 人为 mock 首 Key 生成失败。
2. “新建钱包”流程应整体失败。
3. 页面仍停留在可重试状态。
4. 刷新应用后仍应是 `uninitialized`，不能残留一个空 Vault。

### 已落库但未自动激活

1. 人为 mock `notifyKeyCreated / activateCreatedKey` 失败。
2. 新建钱包后，真实 Key 仍能在 Key 管理看到。
3. 页面给出“已保存但未自动设为 active”的明确提示。
4. 用户可在 Key 管理中手动设为 active。

### 回归验证

1. 现有 `VaultSettingsPage` 里的“新建 Key”仍可正常生成额外 Key。
2. 现有导出、删除、切 active 行为不受影响。
3. `createVault()` 现有调用方中，“导入私钥”分支仍不会自动多生成一把 Key。
4. `vault.unlock()`、`vault.lock()`、`keyspace.onVaultUnlocked()` 现有 ready boundary 不被破坏。

## 实施完成标准

满足下面三条，才算这张施工单完成：

1. 首启“新建钱包”路径在真实 UI 中能稳定落出首把 Key。
2. “导入私钥”路径仍保留空 Vault 语义，不被偷偷塞入额外 Key。
3. 代码层和文案层都不再把“创建空 Vault”当成“新建钱包”的最终语义。
