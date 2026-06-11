# 002 删除 Key 改为密码确认并在删空后回到初始锁屏态硬切换施工单

## 目标

一次性把 Key 删除流程切换为下面这套明确语义：

```txt
删除任意 Key
  必须重新输入锁屏密码
  不能再用指纹 / 标签字符串充当删除授权

删除成功后
  非最后一把 Key：系统保持当前 Vault 会话，只更新 key 列表与 active key
  最后一把 Key：立即结束当前 Vault，会话销毁，系统回到初始锁屏态

初始锁屏态
  = vault.status() === "uninitialized"
  = 首页欢迎页，显示“新建钱包 / 导入私钥”
  ≠ 仅仅 active = all
  ≠ 仅仅 locked
```

本次是硬切换，不接受“先把文案改成输入密码，后面再补平台鉴权”或“先删空后停留在空 Vault，后面再补回初始态”这类中间态。

## 简述缘由

1. 当前删除确认只是要求输入 key 指纹或标签，位于 [packages/plugin-vault/src/VaultKeyDeleteModal.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/VaultKeyDeleteModal.tsx:79)。这只能防误触，不能证明操作者仍掌握锁屏密码。
2. 当前真正删除入口是 [packages/plugin-vault/src/VaultSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/VaultSettingsPage.tsx:347) 调 `keyspace.deleteKeyById(keyId)`，删除服务本身不接受密码参数，意味着其他 UI 或未来入口也能绕过密码确认。
3. 当前删掉 active key 后，keyspace 只会 fallback 到 `mode = "all"`，见 [packages/plugin-vault/src/keyspaceService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.ts:273)。删光所有 key 后，系统不会回到 `uninitialized`，而是留下一个“还有 Vault、但 0 key”的空壳。
4. 空壳 Vault 会把用户带入错误心智：界面不再是首次欢迎页，但实际上已经没有任何 key，可签名、收款、转账都失去对象。这类状态只会把复杂度转移到所有业务页面做兜底。
5. “删除 key”是危险操作，正确边界应该是：

```txt
UI 负责风险提示
平台服务负责重新鉴权
Vault 负责会话与空 Vault 收尾
```

而不是把授权逻辑散落在某个 React modal 里。

## 硬切换结论

本次统一采用下面的产品与平台定义：

```txt
删除授权
  = 输入锁屏密码并由 Vault 校验

输入 key 指纹 / 标签
  = 废弃，不再作为删除授权方式

删掉最后一把 Key
  = 删除 key + 销毁空 Vault + 结束会话 + 回到 uninitialized

空 Vault unlocked / locked
  = 不再作为“删除完最后一把 key”后的合法停留状态
```

这意味着：

1. 删除接口必须把密码参数带进 service 层。
2. service 层必须在真正删除前校验密码。
3. 最后一把 key 删除成功后，Vault 必须主动完成“空 Vault 收尾”，而不是把 UI 留在 unlocked/locked 空状态。
4. App 和 LockedShell 不应为了这次需求发明额外分支；它们只消费 `vault.status()`。

## 不能怎么做

1. 不能只改 modal 文案和输入框，把“请输入指纹”换成“请输入密码”就算完成。这样授权仍在页面层，其他入口依然可以绕过。
2. 不能在 `VaultSettingsPage` 里先手动调一次 `vault.unlock(password)` 再删除。当前会话本来就是 unlocked；删除前重新鉴权应该是“校验密码”，不是再走一次完整解锁流程。
3. 不能直接拿当前内存中的 `masterKey` 或“当前已解锁会话”当作删除授权。危险操作必须要求用户重新输入密码，不能把“之前解过锁”视为永久授权。
4. 不能继续使用 key 指纹、标签、publicKeyHash 作为最终确认口令。这些都是公开信息或展示信息，不是秘密。
5. 不能在 keyspace 内自己拼装密码校验逻辑或直接操作 verifier 密文。密码校验必须收敛到 Vault。
6. 不能让 `deleteKey()` / `deleteKeyById()` 保持旧签名，再由某个页面“额外先校验一下密码”。那会制造新旧两条删除语义。
7. 不能在删掉最后一把 key 后只做 `setActiveInternal({ mode: "all" })`。这只是 active fallback，不是产品要求的“回到初始锁屏态”。
8. 不能删除最后一把 key 后保留 `vault_meta`，让系统下次启动落在 `locked`。这会形成“还能输入密码解锁，但其实没有任何 key”的假状态。
9. 不能在 namespace DB 删除 blocked / timeout 时继续删除 Vault 私钥，哪怕密码是对的。平台仍必须 fail-closed。
10. 不能为了减少改动而在 UI 上检测“删除后 keys.length === 0 就跳首页”。真正的状态源必须是 Vault，而不是页面本地列表长度。

## 应该怎么做

### 总体策略

把删除动作重构成下面这条平台级路径：

```txt
VaultSettingsPage
  收集删除密码
  -> keyspace.deleteKeyById({ keyId, password })

keyspace.deleteKeyById
  -> vault.verifyPassword(password)
  -> prepareDeleteKey(...)
  -> delete namespace DBs
  -> vault.deleteKeyMaterial(keyId)
  -> emit key.deleted
  -> 如果已无剩余 key
       vault.finalizeEmptyVaultAfterLastKeyDeletion()
     否则
       active fallback 到下一把 ready key 或 all
```

### 这样做的缘由

1. 删除前的“重新鉴权”属于平台安全语义，应由 service 保证，而不是依赖某个具体页面。
2. `verifyPassword(password)` 与 `unlock(password)` 语义不同：
   - `verifyPassword`：只校验密码，不改变 Vault 状态，不重跑 backfill，不发 unlock 事件。
   - `unlock`：创建会话、建立 keyspace ready 边界、通知业务插件。
3. “删空后回到初始态”属于 Vault 生命周期收尾，应由 Vault 自己删除 `vault_meta`、清理会话、改变状态，而不是让 keyspace 或页面直接碰 `vaultDb`。
4. keyspace 仍然保留它原有的删除主流程职责：后台任务取消、namespace DB 删除、active fallback、统一发 `key.deleted`。

## 接口级设计

### VaultService 新能力

建议在 [packages/contracts/src/vault.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/vault.ts:1) 新增两个能力：

```ts
verifyPassword(password: string): Promise<void>;

finalizeEmptyVaultAfterLastKeyDeletion(): Promise<void>;
```

语义约束：

1. `verifyPassword(password)`
   - 只验证密码正确性。
   - 不要求当前状态必须是 `locked`；`unlocked` 会话中也允许调用。
   - 不修改 `masterKey / masterSalt / keyCache / status`。
   - 密码错误抛英文错误，例如 `Invalid password`。

2. `finalizeEmptyVaultAfterLastKeyDeletion()`
   - 只允许在“Vault 还存在，但 key 列表已空”的收尾场景调用。
   - 内部必须再次确认 `vault_keys` 已空；若不空则 fail-closed。
   - 删除 `vault_meta`，清理内存会话，最终 `setStatus("uninitialized")`。
   - 需要兼容现有插件清理链路：在结束会话时要触发一次清理信号，避免业务插件残留 unlocked 会话内存。

### KeyspaceService 删除签名调整

建议在 [packages/contracts/src/keyspace.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/keyspace.ts:1) 把删除入口升级为：

```ts
deleteKey(input: { publicKeyHash: string; password: string }): Promise<void>;
deleteKeyById(input: { keyId: string; password: string }): Promise<void>;
```

设计缘由：

1. 删除密码必须成为平台删除 API 的一部分，而不是页面私有约定。
2. `deleteKeyById` 是管理入口，UI 本来就以 `keyId` 驱动删除；把密码与 `keyId` 一起传入最直接。
3. 未来若有命令面板、快捷操作、批处理入口，都会被同一套删除语义约束住。

## 特殊情况提前约定

### 情况 1：密码错误

处理原则：

```txt
删除必须完全不开始
```

应该这样做：

1. `vault.verifyPassword(password)` 在删除最前面执行。
2. 密码错误时直接抛 `Invalid password`。
3. 不调用 `prepareDeleteKey`。
4. 不取消后台任务、不关闭 DB、不删除任何数据、不发 `key.deleting / key.deleted`。

不能这样做：

1. 不能先停任务、删 namespace DB，再发现密码错。
2. 不能把错误吞掉后继续停留在“删除中”状态。

### 情况 2：namespace DB 删除 blocked / timeout

处理原则：

```txt
密码正确也不能继续删私钥
```

应该这样做：

1. 继续沿用当前 fail-closed 语义。
2. 提示英文错误，例如包含 `blocked` 或 `timed out`。
3. Vault 私钥材料保留，`vault_meta` 保留，状态不变。

不能这样做：

1. 不能因为用户已经输入了正确密码就强行删私钥。
2. 不能把“部分 namespace 已删、私钥也删了”的半完成态当成功。

### 情况 3：删除的是最后一把 ready key，但 Vault 里还残留 failed key

处理原则：

```txt
是否删空，以 Vault 实际剩余 key 数量为准
不是以 ready key 数量为准
```

应该这样做：

1. 删除后重新检查 `vault.listKeys()` 或等价底层真实列表。
2. 只要还有 failed / uninitialized / no-hash key，就不能销毁 Vault。
3. active fallback 可以落到 `all`，但 Vault 状态仍保持 `unlocked`。

原因：

```txt
failed key 仍然是用户数据，用户还需要导出或继续删除。
```

### 情况 4：删除的是最后一把 key，`finalizeEmptyVaultAfterLastKeyDeletion()` 失败

处理原则：

```txt
这是高优先级异常，不能假装成功跳回欢迎页
```

应该这样做：

1. `key.deleted` 只在 key 材料已删后发出一次，保持现有事件语义。
2. 如果删完最后一把 key 后，销毁空 Vault 失败，必须把错误明确暴露给调用方。
3. 此时系统可能处于“0 key 但 meta 还在”的异常残留态；错误文案必须明确说明销毁 Vault 收尾失败。
4. 后续实现可以考虑补专用事件如 `vault.empty-finalize-failed` 供诊断，但本次不是必须前置条件。

不能这样做：

1. 不能吞掉 finalize 错误然后仍然告诉用户“已回到初始状态”。
2. 不能在 finalize 失败时再去伪造一条 UI 跳转补救。

### 情况 5：删除最后一把 key 时，业务插件需要清理会话

处理原则：

```txt
删除最后一把 key = 会话结束
```

应该这样做：

1. keyspace 先完成该 key 的删除主流程。
2. Vault 在 `finalizeEmptyVaultAfterLastKeyDeletion()` 中发出会话结束清理信号，再把最终状态落到 `uninitialized`。
3. 现有依赖 `vault.locked` 的插件要么直接复用该清理信号，要么在本次实现中显式兼容。

设计要求：

1. 最终用户可见状态必须是 `uninitialized`，而不是 `locked`。
2. 不能为了兼容插件清理，最终把状态停在 `locked`。

### 情况 6：删除成功后 modal 关闭，但 UI 本地列表还没刷新

处理原则：

```txt
状态以 service / 事件为准
页面只做展示同步
```

应该这样做：

1. 继续通过 `key.deleted`、`key.identity.*`、`keyspace.onActiveChange` 刷新。
2. 对于“删空后进入初始态”，页面不自己判断，而是让 App 根据 `vault.status()` 自动切壳。

不能这样做：

1. 不能在页面上手动 `router.push("/")` 试图模拟初始态。
2. 不能在 modal 内部根据本地 `keys.length` 预测是否要跳欢迎页。

## 文件级施工

### 1. packages/contracts/src/vault.ts

新增或调整契约：

1. 增加 `verifyPassword(password: string): Promise<void>`。
2. 增加 `finalizeEmptyVaultAfterLastKeyDeletion(): Promise<void>`。
3. 注释写清：
   - `verifyPassword` 只校验密码，不改变状态。
   - `finalizeEmptyVaultAfterLastKeyDeletion` 只服务“最后一把 key 删除后的空 Vault 收尾”。
4. 错误信息约束继续使用英文。

### 2. packages/contracts/src/keyspace.ts

调整删除契约：

1. `deleteKey(publicKeyHash)` 改为 `deleteKey({ publicKeyHash, password })`。
2. `deleteKeyById(keyId)` 改为 `deleteKeyById({ keyId, password })`。
3. 注释明确删除第一步就是密码校验。
4. 注释明确删空后必须把 Vault 最终状态收敛到 `uninitialized`。

### 3. packages/plugin-vault/src/VaultKeyDeleteModal.tsx

删除确认 UI 改为密码确认。

必须这样改：

1. 删除 `confirmText` / `typed === fingerprint` 这套逻辑。
2. 最终确认 step 输入项改为 `type="password"`，语义为“请输入锁屏密码以确认删除”。
3. modal 只负责收集密码与风险提示，不负责自行校验密码真伪。
4. 继续保留“导出备份”按钮与两步危险提示。

不能这样改：

1. 不能同时要求“输入指纹 + 输入密码”叠加复杂度。
2. 不能把密码缓存到 modal 外的长期 state。

### 4. packages/plugin-vault/src/VaultSettingsPage.tsx

删除交互接入新接口。

必须这样改：

1. `deleting` 相关本地状态需要同时携带待删 key 与用户输入密码。
2. 调用改为 `keyspace.deleteKeyById({ keyId: deleting.keyId, password })`。
3. 删除成功后仍按现有模式刷新；如果 Vault 状态被切到 `uninitialized`，页面会自然卸载。
4. 错误展示继续透传 service 层英文错误。

不能这样改：

1. 不能在页面里先调用 `vault.verifyPassword()` 再调用旧 `deleteKeyById(keyId)`。
2. 不能在页面里手动判断“如果删完没 key 了就调用某个跳转”。

### 5. packages/plugin-vault/src/vaultService.ts

实现新 Vault 能力。

`verifyPassword(password)` 必须：

1. 从 `vault_meta` 读取 verifier。
2. 派生临时 key 校验 verifier。
3. 成功则返回，失败抛 `Invalid password`。
4. 不触碰当前 `masterKey / masterSalt / keyCache / status`。

`finalizeEmptyVaultAfterLastKeyDeletion()` 必须：

1. 再次确认 Vault 当前已无任何 key。
2. 清理会话相关内存。
3. 删除 `vault_meta`。
4. 触发必要的会话结束清理。
5. 最终 `setStatus("uninitialized")`。

设计缘由：

1. “空 Vault 收尾”必须由 Vault 掌控，而不是让 keyspace 越层直接动 `vaultDb`。
2. `verifyPassword` 必须复用 Vault 现有 verifier 机制，不能复制出第二套密码真值。

### 6. packages/plugin-vault/src/keyspaceService.ts

删除主流程升级。

必须这样改：

1. `deleteKey` / `deleteKeyById` 开头先调用 `vault.verifyPassword(password)`。
2. 之后继续沿用当前主删除顺序：

```txt
verifyPassword
-> prepareDeleteKey
-> delete namespace DB
-> vault.deleteKeyMaterial
-> emit key.deleted
-> 根据剩余 key 决定 active fallback 或 finalize empty vault
```

3. 删除后如果剩余 key 数量为 0：
   - 不再仅仅 fallback 到 `all`
   - 改为调用 `vault.finalizeEmptyVaultAfterLastKeyDeletion()`
4. 删除后如果仍有 key：
   - 删的是 active key 时，fallback 到下一把 ready key；没有 ready key 则 `all`
   - 删的不是 active key 时，保持当前 active

不能这样改：

1. 不能先删 key 再校验密码。
2. 不能在 keyspace 中直接调用 `vaultDb.deleteMeta()`。
3. 不能在“还有 failed key”时误判为已删空。

### 7. packages/plugin-vault/src/vaultService.test.ts

补充或调整单测，至少覆盖：

1. `verifyPassword`：
   - 正确密码通过
   - 错误密码抛 `Invalid password`
   - 调用前后 `vault.status()` 不变化
2. `finalizeEmptyVaultAfterLastKeyDeletion`：
   - 仅在无 key 时成功
   - 成功后状态为 `uninitialized`
   - 新实例 bootstrap 后也应读到 `uninitialized`
3. 如果还有 key，`finalizeEmptyVaultAfterLastKeyDeletion` 必须拒绝执行。

### 8. packages/plugin-vault/src/keyspaceService.test.ts

补充或调整集成测试，至少覆盖：

1. 删除前密码错误：
   - `verifyPassword` 失败
   - 不发 `key.deleting / key.deleted`
   - key 仍在
2. 删除非最后一把 key：
   - 删除成功
   - Vault 仍保持 `unlocked`
   - active fallback 正确
3. 删除最后一把 key：
   - 删除成功后 Vault 进入 `uninitialized`
   - 新实例 bootstrap 读到 `uninitialized`
   - 不遗留 `vault_meta`
4. 删除最后一把 ready key但仍有 failed key：
   - Vault 不进入 `uninitialized`
   - 系统保持 unlocked，但 active 可回到 `all`
5. namespace DB blocked 时：
   - 私钥不删除
   - Vault 不 finalize

### 9. apps/web/src/App.tsx

原则上无需新增逻辑，但必须回归验证：

1. 当最后一把 key 删除触发 `vault.status() === "uninitialized"` 时，App 会自动切回 `LockedShell`。
2. 不需要额外路由跳转或页面层补丁。

### 10. apps/web/src/shell/LockedShell.tsx

原则上无需新增逻辑，但必须回归验证：

1. `status === "uninitialized"` 时展示欢迎页。
2. 最后一把 key 删除后回来的页面必须是欢迎页，而不是解锁页。

## 实施顺序

本次虽然是硬切换，但实现顺序仍应固定，避免中途引入半状态：

1. 先改 contracts，锁定接口语义。
2. 再改 Vault service，提供 `verifyPassword` 与 empty-vault finalize。
3. 再改 keyspace service，把删除授权与删空收尾收进主流程。
4. 再改删除 modal 与设置页，接入新参数与新文案。
5. 最后补齐单测和集成测试。

注意：

```txt
提交顺序可以分文件
运行中的语义不能以“UI 已要求输入密码，但 service 仍可绕过”中间态合入
```

## 最终验收清单

- [ ] 删除确认不再要求输入 key 指纹、标签或 publicKeyHash。
- [ ] 删除确认最终输入项是锁屏密码类型输入框。
- [ ] `keyspace.deleteKey` 与 `keyspace.deleteKeyById` 都要求密码参数。
- [ ] 删除主流程第一步是 `vault.verifyPassword(password)`。
- [ ] 密码错误时不发 `key.deleting`，不删 namespace DB，不删私钥。
- [ ] namespace DB 删除 blocked / timeout 时，不删 Vault 私钥，不 finalize Vault。
- [ ] 删除非最后一把 key 后，Vault 仍保持 `unlocked`。
- [ ] 删除 active key 后会 fallback 到下一把 ready key；没有 ready key 但仍有其他残留 key 时可回到 `all`。
- [ ] 删除最后一把 key 后，Vault 最终状态是 `uninitialized`，不是 `locked`，也不是仅仅 `all`。
- [ ] 删除最后一把 key 后，`vault_meta` 已被移除；新实例 bootstrap 读到 `uninitialized`。
- [ ] 删除最后一把 ready key 但仍有 failed/no-hash key 时，不会误销毁 Vault。
- [ ] App 不依赖手动跳转，只依赖 `vault.status()` 就能回到初始欢迎页。
- [ ] LockedShell 在最后一把 key 删除后显示欢迎页，而不是密码解锁页。
- [ ] 文档、注释使用中文；代码错误信息保持英文。
- [ ] 删除相关新增测试全部通过。

## 本次明确不做

1. 不改“导出备份”能力本身，只调整删除确认与删空收尾。
2. 不改 importer 流程，不改 createVault / createVaultWithInitialKey 现有语义。
3. 不新增“批量删除多个 key”能力。
4. 不借这次需求引入新的全局事件体系；若现有 `vault.locked` 清理链路需要兼容，只在本次收尾逻辑内最小化处理。
