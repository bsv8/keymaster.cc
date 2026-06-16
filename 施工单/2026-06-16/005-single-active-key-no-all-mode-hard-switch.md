# 005 单一 `active key` + 彻底删除 `all mode` 硬切换施工单

## 目标

一次性把当前平台从“`single active key` + `all mode` 只读总览”的双状态模型，硬切换为“只有具体 `active key` 才是正常业务态”的单状态模型：

```txt
正常业务态
  = vault.status() === "unlocked"
  = 至少存在一把 ready key
  = keyspace 恰好选中一把 active key

空系统态
  = 没有 Vault
  = 或删空最后一把 key 后完成收尾
  = vault.status() === "uninitialized"
  = 进入 new / import 首启入口

异常修复态
  = Vault 内仍有 key
  = 但没有任何 ready key 可成为 active
  = 这是“待修复管理态”，不是“全部 key 总览”，也不是“欢迎页”
```

本次是硬切换，不接受“先把顶栏入口删掉，底层先留 `setAll()` 兼容”“先保留 all 分支以后再慢慢清理”“先把 no-active-key 页面继续留着”这类中间态。

## 简述缘由

1. 当前 `all mode` 不是单纯 UI 文案，而是已经进入平台状态机。契约定义见 [packages/contracts/src/keyspace.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/keyspace.ts:1)，实现见 [packages/plugin-vault/src/keyspaceService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.ts:1)，顶栏入口见 [packages/plugin-vault/src/KeySwitchWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/KeySwitchWidget.tsx:1)。
2. 一旦平台允许 `mode: "all"`，业务插件就会被迫分叉出第二套语义：资产聚合只读、转账禁用、联系人禁用、Poker fail-closed。这些分支已经散落在 `plugin-assets / plugin-transfer / plugin-contacts / plugin-p2pkh / plugin-poker`。
3. 对钱包产品来说，`active key` 本质上是“当前身份”。用户切身份，应该是在具体 key 之间切，而不是切到一个不能签名、不能收款、不能导出、不能删除的伪身份。
4. “当前没有 active key”也不应该作为已解锁后的常规页面态暴露给用户。没有任何 key 时，系统应回到 `uninitialized`；仍有 key 但都不可用时，系统应进入“修复/管理”入口，而不是冒充成欢迎页，也不是让各业务页各自显示“请选择一个 key”。
5. 如果这次只删顶栏入口，不删 contract、service、provider、测试和文案，`all mode` 很快会以别的入口或分支重新长回来。

## 硬切换结论

本次统一采用下面这套单真值模型：

```txt
keyspace.active()
  只表达“当前 active 的 publicKeyHash”
  不再表达 “all”

keyspace.setActive(hash)
  是唯一显式切换入口

keyspace.setAll()
  删除

业务插件
  不再处理 all mode
  只处理：
    1) 当前有 active key
    2) 当前没有 active key，但这是内部异常/修复态，不是正常业务态
```

必须满足下面的不变量：

1. `vault.status() === "unlocked"` 且存在 ready key 时，系统必须始终有且仅有一个 `active key`。
2. `all mode` 不是降级态，不是只读态，不是总览态，不再存在于 contract、service、UI、测试、文案、旧施工实现里。
3. 删除当前 active key 时，必须自动切到下一把 ready key；不能落回任何“未选择 / 全部 key / 只读总览”状态。
4. 删空最后一把 key 后，必须回到 `uninitialized`，并进入首启 welcome。
5. “无 active key”不再作为已解锁业务页的普通空态文案存在；它只能是内部瞬时过渡，或被壳层识别为异常修复态并立即接管。

## 不能怎么做

1. 不能只删 [packages/plugin-vault/src/KeySwitchWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/KeySwitchWidget.tsx:1) 里的“全部 key”菜单项，而保留 `ActiveKeyMode = "single" | "all"`、`setAll()`、`state.mode === "all"` 分支。
2. 不能把 `all` 改成“隐藏模式”“内部模式”“deprecated mode”继续留在 contract。只要类型还在，分支就会复活。
3. 不能把“没有 active key”继续当作 `TransferPage / ContactsPage / AssetsPage / P2PKH / Poker` 的常规空态。正常路径不应把用户带到这些页再提示“请选择一个 key”。
4. 不能为了图省事，把“跨 key 总览”偷偷转移到资产 provider、转账 provider、联系人页或后台任务页里继续做聚合替代。那只是换地方复活 `all mode`。
5. 不能在 `keyspace` 里保留“如果没有 ready key 就 `mode = "all"`”的 fallback 逻辑。没有 ready key 时必须区分：
   - `0 key`：回 `uninitialized`
   - `还有 key 但都不可用`：进入修复/管理态
6. 不能把“还有 failed/uninitialized key 但没有 ready key”的情况伪装成 welcome 首启页。欢迎页只适用于没有 Vault 或删空后的真 `uninitialized`，不能把已有数据藏起来。
7. 不能只改运行时代码，不删 i18n key、provider 注释、测试 mock 和旧施工认知。只删实现不删语义残留，会让后续开发继续照着旧模型补代码。
8. 不能让业务插件自己发明“下一把 active key 怎么选”。选择规则只能由 keyspace 统一实现。
9. 不能为了兼容旧测试而保留 `allMode`、`setAll()`、`assets.context.allKey` 之类壳字段。测试真值要跟着新产品真值改。

## 应该怎么做

### 一、把平台状态模型收窄成“单一 active key”

1. 在 [packages/contracts/src/keyspace.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/keyspace.ts:1) 删除 `ActiveKeyMode`。
2. 把 `ActiveKeyState` 改为只表达当前选中的具体 key，例如：

```ts
export interface ActiveKeyState {
  activePublicKeyHash?: string;
}
```

3. 删除 `setAll()` 契约与所有注释。
4. `requireActiveKey()` 的注释改成“没有 active key 时抛错”，不再出现 “all 模式” 字样。
5. [packages/contracts/src/background.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/background.ts:1)、[packages/contracts/src/poker.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/poker.ts:1) 等注释同步去掉 `all mode` 语义。

### 二、把 keyspace fallback 改成“要么自动选中一把，要么明确进入非正常态”

1. 在 [packages/plugin-vault/src/keyspaceService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.ts:1) 删除：
   - `ACTIVE_KEY_MODE_KEY`
   - `readPersistedActive().mode`
   - `persistActive()` 中对 `"all"` 的存储
   - `setAll()`
   - 一切 `mode === "all"` 分支
2. 持久化只保存 `activePublicKeyHash`，不再保存 mode。
3. `autoPickActive()` 只返回两种结果：
   - 找到 ready key：返回该 `publicKeyHash`
   - 没有 ready key：返回空 active
4. `onVaultUnlocked()`、`deleteKeyRecord()`、`onVaultLocked()`、`activateCreatedKey()` 全部改成单一 active 模型。
5. `onVaultLocked()` 清空 active 是允许的，但这是锁屏内部态，不是已解锁业务态。

### 三、把“无 active key”的用户可见处理从页面分支，收敛到壳层守卫

1. `0 key` 不是业务态，必须落到 `vault.status() === "uninitialized"`。删除最后一把 key 的收尾已经有 [packages/plugin-vault/src/vaultService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.ts:845)；本次要把“解锁后意外发现 0 key”也统一收敛掉。
2. 建议在 [packages/plugin-vault/src/vaultService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.ts:1) 的 bootstrap / unlock 收尾增加一致性护栏：
   - `vault_meta` 存在但 `listKeys().length === 0` 时，直接清理 meta 并收敛到 `uninitialized`
   - 不让 App 进入“locked/unlocked 但 0 key”的假状态
3. 在 [apps/web/src/shell/AppShell.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/AppShell.tsx:1) 增加已解锁壳层守卫：
   - 若 `activePublicKeyHash` 存在：正常渲染
   - 若 `activePublicKeyHash` 不存在且 `listKeys().length === 0`：视为状态损坏，主动触发回 `uninitialized` 的恢复路径
   - 若 `activePublicKeyHash` 不存在但 `listKeys().length > 0`：进入阻断式“修复/管理态”，只允许去 Vault Key 管理页处理 failed / uninitialized key
4. 这类“修复/管理态”是壳层阻断，不是新的平台 mode，不新增 `all` 的替代状态类型。

### 四、顶栏只允许在具体 key 之间切换

1. 在 [packages/plugin-vault/src/KeySwitchWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/KeySwitchWidget.tsx:1) 删除：
   - `pickAll()`
   - “全部 key（只读总览）”按钮
   - `active.mode === "all"` 显示分支
   - “未选择”作为正常态标签的分支
2. 顶栏只显示三种结果：
   - 初始化中
   - 当前 active key 的 `label + 短公钥`
   - 无可切换 ready key 时的阻断提示文案，但这只应出现在异常修复态，不应出现在正常流程
3. [packages/plugin-vault/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/manifest.ts:1) 删除 `vault.keySwitch.allKey`、`vault.keySwitch.allKeyDesc`、`vault.keySwitch.unselected` 等不再成立的文案键。

### 五、业务插件彻底删除 all-mode 分支，不再各自兜底“请选择一个 key”

1. `plugin-assets`
   - [packages/plugin-assets/src/AssetsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-assets/src/AssetsPage.tsx:1)
   - [packages/plugin-assets/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-assets/src/manifest.ts:1)
   - 删除 “全部 key（只读总览）/ 无 key” 上下文文案
   - 页面描述只展示当前 active key 上下文；异常修复态由壳层接管，不在本页渲染
2. `plugin-transfer`
   - [packages/plugin-transfer/src/TransferPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-transfer/src/TransferPage.tsx:1)
   - 删除 `activeState.mode === "all"` 分支
   - “还没有 key / 请选择一个 key”不再作为正常已解锁页面空态；无 active 时由壳层阻断
3. `plugin-contacts`
   - [packages/plugin-contacts/src/ContactsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactsPage.tsx:1)
   - [packages/plugin-contacts/src/RecentContactsWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/RecentContactsWidget.tsx:1)
   - [packages/plugin-contacts/src/ContactDetailPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactDetailPage.tsx:1)
   - [packages/plugin-contacts/src/ContactPicker.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactPicker.tsx:1)
   - [packages/plugin-contacts/src/contactsService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/contactsService.ts:1)
   - 删除 all/no-active 语义，统一改成“需要 current active key；若缺失则说明壳层护栏失效，直接报错”
4. `plugin-p2pkh`
   - [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)
   - [packages/plugin-p2pkh/src/p2pkhAssetProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhAssetProvider.ts:1)
   - [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1)
   - [packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx:1)
   - [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
   - [packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx:1)
   - [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)
   - 删除聚合多 key 读、`（全部 key）` 后缀、all-mode warning、unselected warning
   - 所有 provider 和 widget 收敛成“只服务当前 active key namespace”
5. `plugin-poker`
   - [packages/plugin-poker/src/pokerSessionKey.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerSessionKey.ts:1)
   - [packages/plugin-poker/src/pokerService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerService.ts:1)
   - [packages/plugin-poker/src/PokerSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerSettingsPage.tsx:1)
   - [packages/contracts/src/poker.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/poker.ts:1)
   - 删除 `allMode` 解析结果与相关注释
   - Poker 只处理：
     - `vaultLocked`
     - `missing / notReady`
     - `ready`
   - “需要单一 active key”这类提示改成“当前没有可用 active key，请先修复 Vault key 状态”

### 六、测试与文档一起收尾，避免旧真值复活

1. 直接改掉依赖 `setAll()` / `mode: "all"` 的测试 mock：
   - [packages/plugin-poker/src/pokerService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerService.test.ts:1)
   - [packages/plugin-poker/src/pokerSessionKey.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerSessionKey.test.ts:1)
   - [packages/plugin-vault/src/vaultService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.test.ts:1)
   - [packages/plugin-vault/src/keyspaceService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.test.ts:1)
   - [packages/plugin-p2pkh/src/p2pkhDb.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.test.ts:1)
   - [packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts:1)
2. 删掉“切到 all mode”“allMode fail-closed”“全部 key 只读总览”这类测试真值，改成：
   - 正常 ready key 自动选中
   - 删除 active key 自动切下一把 ready key
   - 删空最后一把 key 回 `uninitialized`
   - 仍有 key 但无 ready key 时进入修复/管理态阻断
3. 旧施工单里凡是把 `all mode` 当作目标设计的内容，本次实现时一律以本单为准，不再按旧单补功能。

## 特殊情况提前约定

### 情况 1：删掉当前 active key

处理原则：

```txt
必须自动切到下一把 ready key
不能回落到 all
不能停在“未选择”
```

应该这样做：

1. keyspace 在删除流程收尾阶段重新扫描 ready keys。
2. 若仍有 ready key，自动选最近创建或持久化记录命中的那一把。
3. 立即发布 `activeKey.changed`，业务插件跟随新 key 重建上下文。

### 情况 2：删空最后一把 key

处理原则：

```txt
这不是“没有 active key”
这是“系统回到未初始化”
```

应该这样做：

1. 继续沿用 `vault.finalizeEmptyVaultAfterLastKeyDeletion()`。
2. 最终状态必须是 `vault.status() === "uninitialized"`。
3. App 必须回到首启 welcome，只显示 `new / import`。

### 情况 3：还有 key，但没有任何 ready key

处理原则：

```txt
这不是 all mode
这也不是 welcome
这是修复/管理态
```

应该这样做：

1. 不发明新的全局 mode。
2. 由壳层根据：
   - `vault.status() === "unlocked"`
   - `keyspace.active().activePublicKeyHash` 缺失
   - `keyspace.listKeys().length > 0`
   判定为阻断式修复态。
3. 阻断普通业务页，直接引导用户到 Vault Key 管理页处理 failed / uninitialized key。
4. 允许的动作应以“导出 / 删除 / 查看错误”为主，不允许假装继续资产、转账、联系人、Poker 业务流程。

不能这样做：

1. 不能跳 welcome 首启页。
2. 不能渲染“全部 key（只读总览）”。
3. 不能在业务页里散落“请选择一个 key”的普通提示。

### 情况 4：启动时发现 `vault_meta` 还在，但 key 列表已经是 0

处理原则：

```txt
自动收敛到 uninitialized
不能继续 locked / unlocked 假状态
```

应该这样做：

1. 在 Vault bootstrap 或 unlock 收尾阶段检测该异常。
2. 直接清理 meta 并切回 `uninitialized`。
3. 让用户进入首启 welcome，而不是进入一个永远没有 active key 的壳。

### 情况 5：active key 指向的持久化 hash 已不存在

处理原则：

```txt
重新挑一把 ready key
```

应该这样做：

1. `autoPickActive()` 发现持久化 hash 失效时，直接选当前 ready 列表中的 fallback。
2. 不保留“未选择”给用户手动补齐。

## 文件级实施清单

### A. 契约与平台状态

- [packages/contracts/src/keyspace.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/keyspace.ts:1)：删除 `ActiveKeyMode`、`setAll()`、all-mode 注释，收窄 `ActiveKeyState`。
- [packages/contracts/src/background.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/background.ts:1)：删除 background 关于 all-mode 分组的说明。
- [packages/contracts/src/poker.ts](/home/david/Workspaces/keymaster.cc/packages/contracts/src/poker.ts:1)：删除 `allMode` 相关契约注释与状态定义。

### B. Vault / Keyspace 实现

- [packages/plugin-vault/src/keyspaceService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.ts:1)：删除 `all mode` 状态、持久化、fallback、API。
- [packages/plugin-vault/src/KeySwitchWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/KeySwitchWidget.tsx:1)：删除“全部 key / 未选择”入口与展示。
- [packages/plugin-vault/src/vaultService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.ts:1)：增加空 Vault / 空 key 列表一致性收敛护栏。
- [packages/plugin-vault/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/manifest.ts:1)：删除 all/unselected 文案键。
- [packages/plugin-vault/src/VaultSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/VaultSettingsPage.tsx:1)：作为修复/管理态主入口承接失败 key 处理。

### C. 已解锁壳层与路由守卫

- [apps/web/src/App.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/App.tsx:1)：确认 `uninitialized` 继续回 `LockedShell`。
- [apps/web/src/shell/AppShell.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/AppShell.tsx:1)：增加“已解锁但无 active key”阻断式守卫。
- [apps/web/src/shell/LockedShell.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/shell/LockedShell.tsx:1)：无需引入 all/no-active 兼容逻辑，继续只承接 `uninitialized / locked`。

### D. 业务插件清理

- [packages/plugin-assets/src/AssetsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-assets/src/AssetsPage.tsx:1)
- [packages/plugin-assets/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-assets/src/manifest.ts:1)
- [packages/plugin-transfer/src/TransferPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-transfer/src/TransferPage.tsx:1)
- [packages/plugin-contacts/src/ContactsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactsPage.tsx:1)
- [packages/plugin-contacts/src/RecentContactsWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/RecentContactsWidget.tsx:1)
- [packages/plugin-contacts/src/ContactDetailPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactDetailPage.tsx:1)
- [packages/plugin-contacts/src/ContactPicker.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/ContactPicker.tsx:1)
- [packages/plugin-contacts/src/contactsService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-contacts/src/contactsService.ts:1)
- [packages/plugin-p2pkh/src/p2pkhService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhService.ts:1)
- [packages/plugin-p2pkh/src/p2pkhAssetProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhAssetProvider.ts:1)
- [packages/plugin-p2pkh/src/p2pkhTransferProvider.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhTransferProvider.ts:1)
- [packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx:1)
- [packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx:1)
- [packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx:1)
- [packages/plugin-p2pkh/src/manifest.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/manifest.ts:1)
- [packages/plugin-poker/src/pokerSessionKey.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerSessionKey.ts:1)
- [packages/plugin-poker/src/pokerService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerService.ts:1)
- [packages/plugin-poker/src/PokerSettingsPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/PokerSettingsPage.tsx:1)

### E. 测试收口

- [packages/plugin-vault/src/keyspaceService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/keyspaceService.test.ts:1)
- [packages/plugin-vault/src/vaultService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.test.ts:1)
- [packages/plugin-poker/src/pokerService.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerService.test.ts:1)
- [packages/plugin-poker/src/pokerSessionKey.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-poker/src/pokerSessionKey.test.ts:1)
- [packages/plugin-p2pkh/src/p2pkhDb.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhDb.test.ts:1)
- [packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts:1)

## 最终验收清单

- [ ] 仓库内不再存在 `setAll()`、`ActiveKeyMode`、`mode: "all"`、`allMode` 这几类平台语义残留。
- [ ] 顶栏 key 切换器只允许在具体 key 之间切换，不再出现“全部 key”“未选择”。
- [ ] `vault.status() === "unlocked"` 且存在 ready key 时，系统始终有且仅有一个 active key。
- [ ] 删除当前 active key 后会自动切到下一把 ready key，不会掉进只读态或未选择态。
- [ ] 删除最后一把 key 后系统回到 `uninitialized`，用户进入 `new / import` welcome。
- [ ] 启动时如果发现 `vault_meta` 存在但 key 列表为 0，会自动收敛到 `uninitialized`。
- [ ] 仍有 key 但没有 ready key 时，不会显示欢迎页，也不会显示 all-mode 总览，而是进入阻断式修复/管理态。
- [ ] `plugin-assets / plugin-transfer / plugin-contacts / plugin-p2pkh / plugin-poker` 不再包含 all-mode 只读分支。
- [ ] 所有 manifest/i18n 文案里不再出现“全部 key（只读总览）”“请选择一个 key”作为正常已解锁态文案。
- [ ] 测试真值已改成单一 active-key 模型，不再用 `mode: "all"` 作为 mock 或断言。
- [ ] 这次硬切换完成后，后续新增功能若需要“跨 key 视图”，必须作为独立页面能力设计，不能重新复用 `active key` 状态机。

## 备注

本单落地后，历史上把 `all mode` 视为目标能力的旧施工描述，只保留为历史记录；实现与验收一律以本单为准。
