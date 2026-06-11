# 001 首启导入改为“先选导入类型，再决定系统锁屏密码，再一次性建 Vault+落首把导入 Key”硬切换施工单

## 目标

一次性把首启导入、空 Vault、最后一把 Key 删除后的状态机切换为下面这套明确语义：

```txt
系统处于 uninitialized
  没有 vault_meta
  没有任何 key
  没有系统锁屏密码

首次进入应用
  新建钱包
    -> 设置系统锁屏密码
    -> 立即生成第一把 Key

  导入私钥
    -> 先选择导入类型
    -> 先解析导入材料
    -> 再决定系统锁屏密码
    -> 一次性创建 Vault 并保存这把导入的 Key

系统处于 locked / unlocked
  必须已经至少有一把 key
  锁屏密码只服务于“保护现有 key”
  不能存在“有锁屏密码但没有 key”的状态

删除最后一把 key
  -> 删除 key
  -> 删除 vault_meta
  -> 清空会话
  -> 回到 uninitialized
```

本次是硬切换，不接受“先继续保留 createVault 空 Vault 路径，后面再慢慢收敛”这类中间态。

## 简述缘由

1. 当前首启“导入私钥”路径本质上仍是：

```txt
先 createVault(password)
再跳 /import
```

这会先创建一个只有锁屏密码、没有任何私钥的空 Vault。

2. 这类状态与系统的真实安全目标冲突：

```txt
锁屏密码存在的意义
  = 加密保护已经存在的私钥

没有私钥
  = 不应该有锁屏密码
```

3. 如果允许空 Vault 成为合法产品状态，就会把多个边界同时搞乱：
   - 首启导入时，用户还没选导入类型、还没解析出私钥，就先被要求创建系统密码；
   - 导入失败或取消后，会残留一个“有密码但 0 key”的空壳；
   - 删除最后一把 key 后，如果保留旧密码，下次新建/导入会错误复用上一轮系统状态。

4. “导入源密码”和“系统锁屏密码”是两个不同的安全域：
   - 导入源密码：解开外部备份文件；
   - 系统锁屏密码：加密本机 Vault。

它们可以相同，但不能在逻辑上混成同一个概念。

5. 正确的业务顺序应该是：

```txt
先拿到真实私钥材料
再决定本机如何加密保存
```

而不是先创建一个没有私钥的系统密码壳。

## 硬切换结论

本次统一采用下面的产品定义：

```txt
系统锁屏密码存在
<=> Vault 中至少存在一把 key

没有任何 key
<=> 没有 Vault
<=> 状态必须是 uninitialized

首启导入
  不是“先建空 Vault 再导入”
  而是“先解析导入，再一次性建 Vault 并保存导入 Key”

已存在 Vault 且 locked
  只能先解锁
  不能导入
```

这意味着：

1. `createVault()` 这种“只创建空 Vault”的产品路径必须废弃，不再作为正常用户流程使用。
2. 首启导入必须有自己的高层事务能力，不能复用已解锁态 `/import` 页面语义。
3. 删除最后一把 key 后，旧锁屏密码必须一起消失，不能延续到下一次导入或新建。

## 不能怎么做

1. 不能继续保留：

```txt
uninitialized
-> 点“导入私钥”
-> 先输入系统锁屏密码
-> createVault()
-> 再进 /import
```

这会制造空 Vault。

2. 不能让产品存在“有 Vault meta、0 key”的合法停留状态，不管它是 `locked` 还是 `unlocked`。

3. 不能把“导入源密码”和“系统锁屏密码”写成同一个内部字段。
   UI 可以给用户“是否使用同一密码”的选择，但内部语义必须分开。

4. 不能因为导入类型自带密码，就强制把该密码直接当系统锁屏密码。
   必须给用户选择权。

5. 不能在页面层自己拼事务：
   - 先 `createVault`
   - 再 `importPrivateKey`
   - 出错后自己猜要不要回滚 meta / 会话

这必须收敛到 Vault 高层能力中。

6. 不能把首启导入直接复用当前 `/import` 页面并简单放开给 `uninitialized`。
   当前 `/import` 的语义是“Vault 已存在且已解锁后导入更多 key”，不是“首启导入第一把 key”。

7. 不能在删除最后一把 key 后保留旧锁屏密码，等下一次导入或新建继续沿用。
   这违反“无 key = 无 Vault”的核心不变量。

8. 不能让删除最后一把 key 后只做 `active = all` 或只切回 `locked`。
   最终必须是 `uninitialized`。

9. 不能把私钥材料放进 localStorage、IndexedDB 明文、URL、MessageBus payload 或长期 React state。

10. 不能为了兼容旧逻辑而同时保留两套首启导入路径：

```txt
旧：先建空 Vault，再导入
新：先解析，再一次性建 Vault+导入
```

本次必须硬切。

## 应该怎么做

### 总体策略

把首启导入重构成一条新的高层事务能力，例如：

```ts
createVaultWithImportedKey(input: {
  vaultPassword: string;
  key: {
    label: string;
    material: PrivateKeyMaterial;
    format: string;
    capabilities: string[];
    source?: string;
  };
}): Promise<KeyRef>;
```

语义固定为：

```txt
校验当前状态必须是 uninitialized
写 vault_meta
立即把这把导入的私钥加密保存到 Vault
设为 active
成功后才宣布 unlocked
```

而不是：

```txt
createVault()
跳转 /import
save
自己收拾失败状态
```

### 这样做的缘由

1. 首启导入是一个完整业务动作，不是“创建空 Vault”和“保存首把导入 key”两个可分离的产品步骤。
2. 事务边界必须在 Vault 内部。页面层不应知道：
   - meta 是否已写入；
   - 首把导入 key 是否已落库；
   - active 是否已切换；
   - 失败时是否回滚到 `uninitialized`。
3. 这样才能彻底消灭空 Vault 产品状态。

## 导入密码逻辑必须这样定

### 情况 A：导入类型自带密码

例如加密 JSON / bsv8 envelope。

业务顺序必须是：

```txt
1. 用户先输入“导入源密码”
2. importer 先把外部私钥解析出来
3. 解析成功后，进入“系统锁屏密码”决策步骤：
   [x] 使用同一密码作为系统锁屏密码

   如果勾选
     vaultPassword = importPassword

   如果取消勾选
     用户必须单独输入 vaultPassword

4. 调 createVaultWithImportedKey({ vaultPassword, key })
```

关键约束：

1. `importPassword` 和 `vaultPassword` 是两个字段。
2. 默认可以勾选“使用同一密码”，但内部不能把它们混成一个概念。
3. 只有在用户明确选择“使用同一密码”时，`vaultPassword` 才等于 `importPassword`。

### 情况 B：导入类型没有密码

例如裸 WIF、裸 hex。

业务顺序必须是：

```txt
1. 用户先输入导入材料
2. importer 解析出私钥
3. 系统强制要求用户设置 vaultPassword
4. 调 createVaultWithImportedKey({ vaultPassword, key })
```

关键约束：

1. 不能先裸保存私钥，再补系统锁屏密码。
2. 不能在拿到私钥前就要求用户创建空 Vault。

## 状态机必须收紧成这样

### 合法状态

```txt
uninitialized
  无 vault_meta
  无 key

locked
  有 vault_meta
  至少一把 key

unlocked
  有 vault_meta
  至少一把 key
```

### 非法状态

```txt
有 vault_meta
但 0 key
```

处理原则：

1. 首启导入不得制造它。
2. 新建钱包失败不得制造它。
3. 删除最后一把 key 后不得留下它。

## 特殊情况提前约定

### 情况 1：导入解析失败

处理原则：

```txt
没有解析出私钥
就不能创建 Vault
```

应该这样做：

1. 解析失败时仍停留在首启导入向导。
2. 不写 `vault_meta`。
3. 状态保持 `uninitialized`。

### 情况 2：导入解析成功，但用户取消

处理原则：

```txt
取消只是丢弃本次内存结果
不能留下空 Vault
```

应该这样做：

1. 私钥材料只停留在本次页面内存。
2. 用户返回欢迎页后，状态仍是 `uninitialized`。

### 情况 3：写入 vault_meta 成功，但导入首把 key 失败且 key 未落库

处理原则：

```txt
首启导入整体失败
不能留下空 Vault
```

应该这样做：

1. `createVaultWithImportedKey` 内部回滚 `vault_meta`。
2. 清理内存会话。
3. 最终回到 `uninitialized`。

### 情况 4：首把导入 key 已落库，但 active 切换失败

处理原则：

```txt
这不是完全失败
而是“已保存但未自动激活”
```

应该这样做：

1. 复用现有 `KeyPersistedButActivationFailedError` 语义。
2. 不删除已落库 key。
3. 允许进入主界面，并给出明确 notice：

```txt
Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。
```

### 情况 5：导入类型自带密码，用户勾选“使用同一密码作为系统锁屏密码”

处理原则：

```txt
允许相同
但不是隐式强制
```

应该这样做：

1. UI 明确展示该选择。
2. 如果勾选，`vaultPassword = importPassword`。
3. 如果取消勾选，必须输入单独的 `vaultPassword`。

### 情况 6：删除最后一把 key

处理原则：

```txt
系统锁屏密码必须一起消失
```

应该这样做：

1. 删除 key 后继续删除 `vault_meta`。
2. 清理会话。
3. 最终状态是 `uninitialized`。
4. 下一次新建或导入必须重新决定系统锁屏密码。

### 情况 7：删除最后一把 ready key，但仍有 failed key

处理原则：

```txt
是否“删空”
以 Vault 实际剩余 key 数量为准
不是以 ready key 数量为准
```

应该这样做：

1. 只要还有 failed / uninitialized / no-hash key，就不能销毁 Vault。
2. 因为这些仍然是用户数据，用户还需要导出或继续删除。

### 情况 8：已有 Vault 且 locked

处理原则：

```txt
不能导入
只能先解锁
```

应该这样做：

1. 继续保留当前 locked shell 只显示解锁能力。
2. 解锁后才允许进入现有 `/import` 页面导入更多 key。

## 文件级施工

### 1. packages/contracts/src/vault.ts

新增首启导入高层能力契约，例如：

```ts
createVaultWithImportedKey(input: {
  vaultPassword: string;
  key: {
    label: string;
    material: PrivateKeyMaterial;
    format: string;
    capabilities: string[];
    source?: string;
  };
}): Promise<KeyRef>;
```

要求：

1. 注释明确这是“首启导入第一把 key”的唯一高层入口。
2. 注释明确它只允许在 `status === "uninitialized"` 时调用。
3. 注释明确失败时不得残留空 Vault。

### 2. packages/plugin-vault/src/vaultService.ts

实现 `createVaultWithImportedKey(...)`。

推荐内部顺序：

```txt
校验 status === uninitialized
写 vault_meta
建立内存会话
调统一私钥持久化路径 persistPrivateKey(...)
成功后 setStatus("unlocked") + emit "vault.unlocked"
失败时按是否已落库决定回滚或保留
```

要求：

1. 必须复用现有 `persistPrivateKey(...)`，不能复制加密落库逻辑。
2. 如果首把导入 key 未落库，必须回滚 `vault_meta`。
3. 不能再让首启导入依赖 `createVault()`。

### 3. packages/plugin-key-import/src/ImportPage.tsx

当前页面定位必须收紧为：

```txt
仅服务已存在 Vault 且已 unlocked 的“导入更多 key”
```

要求：

1. 不再承担首启导入第一把 key 的职责。
2. 保持当前 `persistImport(vault, ...)` 语义不变，因为它本来就依赖已解锁 Vault。
3. 页面说明文案要避免让人误解它是首启导入入口。

### 4. packages/plugin-key-import/src/manifest.ts

保持 `/import` 只在 `unlocked` 可见。

要求：

1. `visibleWhen: ({ unlocked }) => unlocked` 继续保留。
2. 如果还存在任何把 `uninitialized` 直接导航到 `/import` 的路径，本次必须删掉。

### 5. apps/web/src/shell/LockedShell.tsx

重做 `uninitialized -> 导入私钥` 流程。

必须改成：

```txt
欢迎页点“导入私钥”
-> 进入首启导入向导
-> 先选导入类型 / 输入导入材料 / 解析
-> 再决定系统锁屏密码
-> 调 createVaultWithImportedKey(...)
```

不能再这样做：

```txt
点“导入私钥”
-> 先输入系统锁屏密码
-> createVault()
-> 跳 /import
```

同时要求：

1. locked 状态下继续只显示解锁，不显示导入入口。
2. 首启导入向导可以做成 LockedShell 内部的 mode，也可以拆独立组件，但语义必须是“仍处于 uninitialized，尚未创建 Vault”。

### 6. packages/plugin-key-import/src/importFlow.ts

要求：

1. 保持它只负责“已解锁态导入更多 key”的保存逻辑。
2. 不要把首启导入硬塞进这个函数里。
3. 首启导入应新增单独高层编排函数，避免把“创建首个 Vault”和“已解锁继续导入”混语义。

### 7. packages/plugin-vault/src/vaultService.test.ts

补测试，至少覆盖：

1. `createVaultWithImportedKey()` 成功后：
   - Vault 状态是 `unlocked`
   - `listKeys()` 长度为 `1`
   - 首把导入 key 可见
   - `keyspace.active()` 指向这把 key

2. `createVaultWithImportedKey()` 失败且 key 未落库时：
   - 回滚到 `uninitialized`
   - `vault_meta` 不存在

3. 首把导入 key 已落库但 active 切换失败时：
   - 复用 `KeyPersistedButActivationFailedError`
   - Vault 仍进入可恢复状态

4. 删除最后一把 key 后：
   - Vault 回到 `uninitialized`
   - 下一次导入/新建必须重新设置密码

### 8. packages/plugin-vault/src/keyspaceService.test.ts

补测试，至少覆盖：

1. 删除最后一把 key 后：
   - `vault_meta` 已删除
   - 新实例 bootstrap 读到 `uninitialized`

2. 删除最后一把 ready key 但仍有 failed key 时：
   - Vault 不被销毁

### 9. apps/web/src/App.tsx

原则上无需新增复杂逻辑，但必须验证：

1. `vault === "uninitialized"` 时仍渲染 `LockedShell`。
2. 删除最后一把 key 后，会自然回到首启欢迎/首启导入入口。

### 10. apps/web/src/i18n/resources.ts

更新文案，避免继续表达旧语义。

尤其要修正：

1. 首启“导入私钥”相关说明，不能再暗示“先创建密码保存 vault，再导入”。
2. 新建钱包相关说明，明确“立即生成第一把 Key”。
3. locked 状态说明，明确“需要先解锁，解锁后才能导入或管理私钥”。

## 实施顺序

虽然本次是硬切换，但实现顺序必须固定，避免中间出现空 Vault 可达状态：

1. 先改 contracts，锁定高层能力语义。
2. 再改 vaultService，实现 `createVaultWithImportedKey(...)`。
3. 再改 LockedShell，把首启导入入口改成新向导。
4. 再收紧 `/import` 的定位，只保留给 unlocked 导入更多 key。
5. 最后补测试和文案。

注意：

```txt
不能先把 UI 放开
后面再补 Vault 事务回滚
```

## 最终验收清单

- [ ] `uninitialized` 状态下，系统不存在 `vault_meta`。
- [ ] `uninitialized` 状态下，系统不存在任何 key。
- [ ] 产品上不存在“有 Vault 密码但 0 key”的合法状态。
- [ ] 首启“导入私钥”不再先调用 `createVault()`。
- [ ] 首启导入的第一步是选择导入类型与解析导入材料，不是先设置系统锁屏密码。
- [ ] 导入类型自带密码时，用户可以选择“使用同一密码作为系统锁屏密码”，但不是强制。
- [ ] 导入类型不带密码时，系统会强制要求设置系统锁屏密码。
- [ ] `/import` 页面只服务已解锁态导入更多 key，不承担首启导入第一把 key。
- [ ] `locked` 状态下不能导入，只能先解锁。
- [ ] `createVaultWithImportedKey()` 失败且首 key 未落库时，不残留空 Vault。
- [ ] 删除最后一把 key 后，`vault_meta` 被删除，状态回到 `uninitialized`。
- [ ] 删除最后一把 key 后，旧锁屏密码不会延续到下一次导入或新建。
- [ ] 删除最后一把 ready key 但仍有 failed/no-hash key 时，Vault 不会被误销毁。
- [ ] 首启导入和新建钱包都不会制造“空 Vault”中间态。
- [ ] 文档、注释使用中文；代码错误信息保持英文。

## 本次明确不做

1. 不在本次顺手改导入格式协议本身；WIF / Hex / bsv8 importer 的解析规则保持原有职责边界。
2. 不把 `/import` 变成同时支持“首启导入”和“已解锁继续导入”的双模式页面。
3. 不增加“先创建空 Vault，稍后再补第一把 key”的兼容路径。
4. 不保留“删除最后一把 key 后继续沿用旧密码”的迁就逻辑。
