# 001 Monorepo 插件化 BSV Web Wallet 硬切换施工单

## 目标

把当前项目一次性切换为 `Monorepo 多 package + 插件宿主 + 能力注册表` 架构，面向 BSV Web Wallet。

本次不是渐进式重构，不保留旧的单体页面结构作为并行入口。切换完成后，应用只能通过 Shell 加载插件、通过 registry/hook 获取资源、通过插件声明接入页面和菜单。

## 硬切换缘由

1. 插件系统的核心价值在边界。如果同时保留旧的直接 import、硬编码菜单、硬编码页面，边界会立刻失效。
2. 私钥、导入、P2PKH、转账、联系人、首页资源、设置都需要统一 runtime 管理。分步骤迁移会导致同一资源被两套系统同时管理。
3. BSV 钱包能力会继续扩展，例如 P2PKH、1Sat、合约签名、不同私钥格式导入。必须先把扩展点定死，否则后续插件会互相缠绕。

## 最终结构

```txt
apps/
  web/
    src/
      main.tsx
      App.tsx
      bootstrapPlugins.ts
      shell/
        AppShell.tsx
        LockedShell.tsx
        UnlockedShell.tsx
        Sidebar.tsx
        Topbar.tsx
        Breadcrumbs.tsx
        RouteRenderer.tsx
      styles/
        global.css

packages/
  contracts/
    src/
      index.ts
      plugin.ts
      vault.ts
      keyImport.ts
      transfer.ts
      navigation.ts
      settings.ts
      home.ts
      p2pkh.ts
      contacts.ts

  runtime/
    src/
      index.ts
      createPluginHost.ts
      capabilityRegistry.ts
      eventBus.ts
      registries/
        routeRegistry.ts
        menuRegistry.ts
        breadcrumbRegistry.ts
        settingsRegistry.ts
        homeRegistry.ts
        commandRegistry.ts
        importerRegistry.ts
        transferRegistry.ts
      react/
        PluginHostProvider.tsx
        useCapability.ts
        useRegistry.ts
        useRuntimeStatus.ts

  ui/
    src/
      index.ts
      Button.tsx
      TextInput.tsx
      Select.tsx
      Modal.tsx
      PageHeader.tsx
      DataTable.tsx
      EmptyState.tsx

  plugin-vault/
    src/
      index.ts
      manifest.ts
      vaultService.ts
      vaultDb.ts
      crypto.ts
      VaultUnlockPage.tsx
      VaultCreatePage.tsx
      VaultSettingsPage.tsx

  plugin-key-import/
    src/
      index.ts
      manifest.ts
      ImportPage.tsx
      ImporterPicker.tsx
      importFlow.ts

  plugin-importer-wif/
    src/
      index.ts
      manifest.ts
      wifImporter.ts

  plugin-importer-hex/
    src/
      index.ts
      manifest.ts
      hexImporter.ts

  plugin-importer-json-file/
    src/
      index.ts
      manifest.ts
      jsonFileImporter.ts

  plugin-p2pkh/
    src/
      index.ts
      manifest.ts
      p2pkhService.ts
      p2pkhDb.ts
      wocClient.ts
      utxoAllocator.ts
      p2pkhTransferProvider.ts
      p2pkhSigner.ts
      pages/
        P2pkhOverviewPage.tsx
        P2pkhHistoryPage.tsx
        P2pkhUtxosPage.tsx
        P2pkhSettingsPage.tsx
      widgets/
        P2pkhBalanceWidget.tsx

  plugin-contacts/
    src/
      index.ts
      manifest.ts
      contactsService.ts
      contactsDb.ts
      ContactsPage.tsx
      ContactDetailPage.tsx
      ContactPicker.tsx
      RecentContactsWidget.tsx

  plugin-transfer/
    src/
      index.ts
      manifest.ts
      TransferPage.tsx
      TransferProviderPicker.tsx
      TransferPreview.tsx
      transferFlow.ts

  plugin-home/
    src/
      index.ts
      manifest.ts
      HomePage.tsx

  plugin-settings/
    src/
      index.ts
      manifest.ts
      SettingsPage.tsx
```

## 平台能力

### Capability Registry

所有资源服务都通过 capability 提供和消费。

必须支持：

```txt
provide(key, value)
get(key)
has(key)
require(key)
```

能力 key 使用命名空间：

```txt
vault.service
keyImport.registry
transfer.registry
route.registry
menu.registry
breadcrumb.registry
settings.registry
home.registry
command.registry
p2pkh.service
contacts.service
```

### Plugin Host

Plugin Host 负责：

```txt
插件注册
依赖检查
能力注入
事件总线
registry 初始化
插件 setup 生命周期
插件启用状态
```

插件只能通过 `setup(ctx)` 注册能力、页面、菜单、设置、首页模块和 provider。

### UI Registry

Shell 必须提供这些 UI 扩展点：

```txt
route.registry        插件独立页面
menu.registry         侧边栏/顶部导航
breadcrumb.registry   面包屑
settings.registry     设置页和设置字段
home.registry         首页资源模块
command.registry      全局动作
```

### Importer Registry

`plugin-key-import` 提供导入平台，不负责具体格式解析。

具体格式由以下插件接入：

```txt
plugin-importer-wif
plugin-importer-hex
plugin-importer-json-file
后续 plugin-importer-mnemonic
```

Importer 只能输出标准私钥材料，不能直接写 Vault 或 P2PKH DB。

### Transfer Registry

`plugin-transfer` 提供转账平台，不负责具体转账协议。

具体转账能力由业务插件接入：

```txt
plugin-p2pkh 注册 p2pkh transfer provider
plugin-1sat 后续注册 1sat transfer provider
```

Transfer 页面只负责选择 provider、收集输入、展示 draft、触发 prepare/sign/broadcast。

## 插件边界

### 允许

```txt
apps/web 可以 import 各插件 manifest，用于装配。
plugin-* 可以 import contracts/runtime/ui。
plugin-* 可以通过 capability 调用其他插件提供的服务。
plugin-* 可以通过 registry 注册页面、菜单、设置、首页模块、导入器、转账 provider。
```

### 禁止

```txt
plugin-* 之间禁止直接 import 源码。
plugin-transfer 禁止直接实现 P2PKH 或 1Sat 业务。
plugin-key-import 禁止直接解析所有格式。
plugin-importer-* 禁止直接写 Vault。
plugin-p2pkh 禁止把 DB、签名、历史 UI 拆成互相独立的小插件。
Shell 禁止硬编码业务页面、业务菜单、业务设置项。
首页禁止直接 import 业务 widget。
设置页禁止直接 import 业务设置页面。
面包屑禁止只靠路径字符串硬拼动态资源名。
私钥禁止作为普通 capability 长期暴露。
```

## 私钥与 Vault 规则

Vault 插件负责：

```txt
创建钱包密码
解锁钱包
登出/锁定
导入私钥
加密保存私钥到 IndexedDB
保存 keyRef、地址、标签、格式、网络等元数据
提供 withPrivateKey(keyId, fn)
```

允许可信插件临时借用私钥：

```ts
await vault.withPrivateKey(keyId, async (privateKey) => {
  return provider.signWithPrivateKey(privateKey, draft);
});
```

禁止把明文私钥放入：

```txt
React state 的长期状态
localStorage
sessionStorage
普通 IndexedDB 表
全局 capability
日志
错误信息
```

用户点击登出后：

```txt
清空内存解密 key
清空临时私钥缓存
清空 signer 临时上下文
回到 LockedShell
```

## 文件级施工项

### 根目录

`package.json`

```txt
定义 workspaces。
定义 dev/build/typecheck/lint:boundaries 脚本。
统一 React、Vite、TypeScript 版本。
```

`tsconfig.base.json`

```txt
定义严格 TypeScript 配置。
定义 @web-wallet/* path alias。
```

`tsconfig.json`

```txt
引用 apps/web 和所有 packages。
```

`scripts/check-boundaries.mjs`

```txt
扫描 plugin-* 源码。
发现 plugin-* 直接 import 其他 plugin-* 时失败。
```

### apps/web

`apps/web/src/main.tsx`

```txt
创建 React root。
调用 bootstrapPlugins。
挂载 PluginHostProvider 和 App。
```

`apps/web/src/bootstrapPlugins.ts`

```txt
创建 PluginHost。
按依赖顺序注册平台插件和业务插件。
只 import manifest，不 import 插件内部服务。
```

推荐顺序：

```txt
runtime 内置 registry
plugin-vault
plugin-home
plugin-settings
plugin-key-import
plugin-transfer
plugin-contacts
plugin-p2pkh
plugin-importer-wif
plugin-importer-hex
plugin-importer-json-file
```

`apps/web/src/App.tsx`

```txt
读取 vault 状态。
Booting 显示初始化状态。
Locked 显示 LockedShell。
Unlocked 显示 AppShell。
```

`apps/web/src/shell/AppShell.tsx`

```txt
统一布局。
渲染 Sidebar、Topbar、Breadcrumbs、RouteRenderer。
不写业务页面。
```

`apps/web/src/shell/LockedShell.tsx`

```txt
未创建 vault 时显示创建密码入口。
已有 vault 时显示输入密码解锁入口。
提供导入入口但导入保存必须依赖 vault。
```

`apps/web/src/shell/RouteRenderer.tsx`

```txt
从 route.registry 读取插件页面。
负责路由匹配和渲染。
缺失路由时显示 NotFound。
```

`apps/web/src/shell/Sidebar.tsx`

```txt
从 menu.registry 读取菜单。
按 group/order 排序。
根据 visibleWhen 过滤。
```

`apps/web/src/shell/Breadcrumbs.tsx`

```txt
从 breadcrumb.registry 获取当前路径面包屑。
动态资源名称必须通过 provider resolve。
```

### packages/contracts

`plugin.ts`

```txt
PluginManifest、PluginContext、PluginDependency。
```

`vault.ts`

```txt
VaultService、KeyRef、PrivateKeyMaterial、VaultStatus。
```

`keyImport.ts`

```txt
KeyImporter、KeyImportInput、KeyImportResult、ImporterRegistry。
```

`transfer.ts`

```txt
TransferProvider、TransferRegistry、TransferInput、TransferDraft、SignedTransfer、BroadcastResult。
```

`navigation.ts`

```txt
AppRoute、MenuItem、BreadcrumbProvider、BreadcrumbItem。
```

`settings.ts`

```txt
SettingsPage、SettingsField、SettingsRegistry。
```

`home.ts`

```txt
HomeWidget、HomeRegistry。
```

`p2pkh.ts`

```txt
P2pkhService、P2pkhKeyResource、P2pkhBalance、P2pkhUtxo、P2pkhHistoryItem、UtxoAllocation。
```

`contacts.ts`

```txt
Contact、ContactInput、ContactsService。
```

### packages/runtime

`createPluginHost.ts`

```txt
创建 host。
初始化内置 registry。
执行插件依赖检查。
执行 plugin.setup(ctx)。
```

`capabilityRegistry.ts`

```txt
实现 provide/get/has。
重复 provide 必须报错。
缺失 capability 必须报错。
```

`eventBus.ts`

```txt
实现 on/off/emit。
用于 key.imported、vault.locked、p2pkh.synced、transfer.completed 等事件。
```

`registries/routeRegistry.ts`

```txt
注册、列出、查找 AppRoute。
route id/path 冲突必须报错。
```

`registries/menuRegistry.ts`

```txt
注册、列出 MenuItem。
menu id 冲突必须报错。
```

`registries/breadcrumbRegistry.ts`

```txt
注册 BreadcrumbProvider。
按 order 匹配当前 location。
```

`registries/settingsRegistry.ts`

```txt
注册 SettingsPage 和 SettingsField。
settings id 冲突必须报错。
```

`registries/homeRegistry.ts`

```txt
注册 HomeWidget。
按 order/size 输出给 HomePage。
```

`registries/commandRegistry.ts`

```txt
注册 Command。
菜单、Topbar、快捷键以后都可以调用 command。
```

`registries/importerRegistry.ts`

```txt
注册 KeyImporter。
支持 text/file/form 类型 importer。
```

`registries/transferRegistry.ts`

```txt
注册 TransferProvider。
支持 list/canHandle/prepare/sign/broadcast。
```

`react/useCapability.ts`

```txt
React hook。
组件只能通过它读取服务。
```

### packages/plugin-vault

`manifest.ts`

```txt
提供 vault.service。
注册 vault 设置页。
注册 lock/unlock command。
```

`vaultService.ts`

```txt
实现 VaultService。
管理 locked/unlocked 状态。
提供 withPrivateKey。
```

`vaultDb.ts`

```txt
IndexedDB 表：
vault_meta
vault_keys
```

`crypto.ts`

```txt
WebCrypto KDF、encrypt、decrypt。
```

`VaultUnlockPage.tsx`

```txt
输入密码解锁。
失败显示明确错误。
```

`VaultCreatePage.tsx`

```txt
第一次创建钱包密码。
```

### packages/plugin-key-import

`manifest.ts`

```txt
依赖 vault.service 和 importer.registry。
注册 /import 页面、菜单项、面包屑。
```

`ImportPage.tsx`

```txt
读取 importer.registry。
展示可用导入方式。
完成 parse 后调用 vault.importPrivateKey。
发出 key.imported 事件。
```

`ImporterPicker.tsx`

```txt
只负责选择导入器。
不解析业务格式。
```

### packages/plugin-importer-*

每个 importer 插件只做一件事：

```txt
注册一种导入格式。
解析输入。
输出 KeyImportResult[]。
```

禁止：

```txt
写 Vault。
写 P2PKH DB。
注册菜单。
注册页面。
```

### packages/plugin-p2pkh

`manifest.ts`

```txt
依赖 vault.service、transfer.registry、route.registry、menu.registry、settings.registry、home.registry。
提供 p2pkh.service。
注册 P2PKH 页面、菜单、首页 widget、设置页。
注册 P2PKH transfer provider。
监听 key.imported。
```

`p2pkhService.ts`

```txt
统一暴露 P2PKH 能力：
syncAll
getBalance
listUtxos
listHistory
allocateUtxos
prepareTransfer
signTransfer
broadcastTransfer
```

`p2pkhDb.ts`

```txt
IndexedDB 表：
p2pkh_addresses
p2pkh_balances
p2pkh_utxos
p2pkh_history
```

`wocClient.ts`

```txt
封装 WOC API。
不能把 fetch 散落在页面组件里。
```

`utxoAllocator.ts`

```txt
根据 amount + feeReserve 返回合理 UTXO。
默认只使用 confirmed UTXO。
allowUnconfirmed 由调用方显式开启。
```

`p2pkhTransferProvider.ts`

```txt
向 transfer.registry 注册 provider。
prepare/sign/broadcast 委托 p2pkhService。
```

`p2pkhSigner.ts`

```txt
使用 vault.withPrivateKey。
实现 P2PKH 相关签名。
特殊 BSV sighash 规则只放在这里或同包内扩展文件。
```

### packages/plugin-transfer

`manifest.ts`

```txt
提供 transfer.registry。
注册 /transfer 页面、菜单、面包屑。
```

`TransferPage.tsx`

```txt
读取 transfer.registry。
展示可用 provider。
根据 provider 字段收集输入。
调用 prepare/sign/broadcast。
```

禁止：

```txt
直接 import p2pkhService。
直接实现 1Sat 或 P2PKH 交易逻辑。
直接查 UTXO DB。
```

### packages/plugin-contacts

`manifest.ts`

```txt
提供 contacts.service。
注册 /contacts 页面、菜单、面包屑、首页 widget。
```

`contactsService.ts`

```txt
联系人增删改查。
按 address 查找联系人。
```

`contactsDb.ts`

```txt
IndexedDB 表：
contacts
```

`ContactPicker.tsx`

```txt
供 transfer 页面通过 capability 或 UI slot 使用。
不能让 transfer 直接 import 该组件。
如果 transfer 需要联系人选择，应该通过 contacts.service 或 slot/field provider 接入。
```

### packages/plugin-home

`manifest.ts`

```txt
注册 / 首页路由。
```

`HomePage.tsx`

```txt
从 home.registry 读取 widget。
按 size/order 渲染资源面板。
不直接 import P2PKH、contacts 等 widget。
```

### packages/plugin-settings

`manifest.ts`

```txt
注册 /settings 页面、菜单。
```

`SettingsPage.tsx`

```txt
从 settings.registry 读取页面和字段。
不直接 import 业务设置组件。
```

## 特殊情况处理

### 插件依赖缺失

处理方式：

```txt
PluginHost 注册时报错。
开发环境显示插件 id 和缺失 capability。
生产环境禁用该插件并记录错误。
```

禁止：

```txt
让插件在运行中静默失败。
```

### capability 冲突

处理方式：

```txt
同一个 key 只能 provide 一次。
如果确实需要多实现，必须使用 registry，例如 transfer.registry、importer.registry。
```

禁止：

```txt
后注册覆盖先注册。
```

### route/menu/settings/home id 冲突

处理方式：

```txt
registry 抛错。
id 必须使用插件命名空间，例如 p2pkh.history。
```

### Vault 未解锁

处理方式：

```txt
只允许访问公开元数据和公开链上数据。
需要私钥的动作必须跳转或弹出 unlock。
```

禁止：

```txt
让 signer 或 transfer 自己绕过 vault 状态。
```

### 导入格式无法识别

处理方式：

```txt
key-import 页面展示没有 importer 可处理。
允许用户手动选择 importer。
importer parse 失败时只返回格式错误，不写任何 DB。
```

### 导入了当前未安装能力支持的 key

例如导入了某种将来才支持的 key scheme。

处理方式：

```txt
Vault 仍可保存 keyRef。
没有对应资源插件时，不生成余额/历史/转账能力。
UI 提示缺少对应能力插件。
```

### WOC 不可用或限流

处理方式：

```txt
p2pkhService 标记 syncStatus=failed/rateLimited。
保留本地上次同步数据。
首页 widget 显示 stale 状态。
允许用户手动重试。
```

禁止：

```txt
同步失败时清空余额、UTXO、历史。
```

### UTXO 不足

处理方式：

```txt
allocateUtxos 返回明确错误：
required
available
feeReserve
```

Transfer 页面只展示错误，不自己重新计算。

### BSV 特殊签名格式

处理方式：

```txt
属于某能力包的签名放在该插件内。
例如 P2PKH 放 plugin-p2pkh。
1Sat 放 plugin-1sat。
合约类放对应合约插件。
```

禁止：

```txt
把所有签名集中塞进 vault。
```

### 联系人地址重复

处理方式：

```txt
contacts.service 以 address 为唯一索引或提示冲突。
允许同一地址多个标签时必须明确设计 alias 表。
第一版建议 address 唯一。
```

### IndexedDB schema 升级

处理方式：

```txt
每个插件管理自己的 DB schema version。
升级失败时不破坏旧数据。
插件页面显示迁移失败状态。
```

禁止：

```txt
所有插件共用一个巨大 schema 文件。
```

## 最终验收清单

### 架构验收

- [ ] 根目录是 workspace 项目。
- [ ] `apps/web` 只负责 Shell 和插件装配。
- [ ] `packages/contracts` 只包含类型和协议，不包含业务实现。
- [ ] `packages/runtime` 提供 PluginHost、capability、eventBus、全部 registry 和 React hooks。
- [ ] 所有业务能力都在 `packages/plugin-*`。
- [ ] 插件之间没有直接 import。
- [ ] `lint:boundaries` 可以发现插件互相 import。

### Shell 验收

- [ ] 应用启动后先进入 Booting。
- [ ] 未解锁时进入 LockedShell。
- [ ] 解锁后进入 AppShell。
- [ ] 侧边栏来自 menu.registry。
- [ ] 页面来自 route.registry。
- [ ] 面包屑来自 breadcrumb.registry。
- [ ] 设置页来自 settings.registry。
- [ ] 首页模块来自 home.registry。
- [ ] Shell 没有硬编码 P2PKH、contacts、transfer 的业务组件。

### Vault 验收

- [ ] 可以创建钱包密码。
- [ ] 可以解锁。
- [ ] 可以登出并清空内存会话。
- [ ] 私钥加密保存到 IndexedDB。
- [ ] 明文私钥不进入 localStorage/sessionStorage。
- [ ] 可信插件只能通过 `vault.withPrivateKey` 使用私钥。

### 导入能力验收

- [ ] `plugin-key-import` 提供统一导入页面。
- [ ] WIF importer 可以注册到 importer.registry。
- [ ] HEX importer 可以注册到 importer.registry。
- [ ] JSON file importer 可以注册到 importer.registry。
- [ ] Import 页面不直接解析具体格式。
- [ ] Importer 插件不直接写 Vault。
- [ ] 导入成功后发出 `key.imported` 事件。

### P2PKH 验收

- [ ] `plugin-p2pkh` 提供 `p2pkh.service`。
- [ ] 可以监听 `key.imported` 并生成 P2PKH 地址资源。
- [ ] 可以通过 WOC 同步余额。
- [ ] 可以同步 UTXO。
- [ ] 可以同步历史。
- [ ] 可以提供首页余额 widget。
- [ ] 可以提供历史页面。
- [ ] 可以提供 UTXO 页面。
- [ ] 可以注册 P2PKH transfer provider。
- [ ] P2PKH 签名逻辑留在 `plugin-p2pkh` 内。

### Contacts 验收

- [ ] `plugin-contacts` 提供 `contacts.service`。
- [ ] 可以新增联系人。
- [ ] 可以编辑联系人。
- [ ] 可以删除联系人。
- [ ] 可以按地址查联系人。
- [ ] 联系人页面来自 route.registry。
- [ ] 联系人菜单来自 menu.registry。
- [ ] 首页最近联系人模块来自 home.registry。

### Transfer 验收

- [ ] `plugin-transfer` 提供 `transfer.registry`。
- [ ] Transfer 页面列出已注册 provider。
- [ ] 没有 provider 时展示空状态。
- [ ] P2PKH provider 可以挂入 Transfer 页面。
- [ ] Transfer 页面不直接读取 P2PKH DB。
- [ ] Transfer 页面不直接 import P2PKH 服务。
- [ ] prepare/sign/broadcast 生命周期由 provider 执行。

### 设置验收

- [ ] `plugin-settings` 提供统一设置页面。
- [ ] P2PKH 可以注册 WOC/network 设置。
- [ ] Vault 可以注册安全设置。
- [ ] 设置页面不硬编码业务设置组件。

### 运行验收

- [ ] `npm run typecheck` 通过。
- [ ] `npm run lint:boundaries` 通过。
- [ ] `npm run build` 通过。
- [ ] 浏览器打开首页无 console fatal error。
- [ ] 锁定/解锁/登出流程可用。
- [ ] 导入私钥后 P2PKH 插件能看到 key.imported 事件。
- [ ] 首页 widget 能随插件安装/移除变化。
- [ ] 菜单能随插件安装/移除变化。
- [ ] 设置页能随插件安装/移除变化。

## 完成定义

本施工单完成后，项目应达到：

```txt
工程上：Monorepo 多 package。
运行时：一个 React Shell。
能力上：插件通过 registry/hook 协作。
边界上：插件之间无直接源码依赖。
业务上：Vault、导入、P2PKH、联系人、转账、首页、设置都有明确插件归属。
```

任何新能力必须先回答：

```txt
它是平台扩展点，还是业务能力包？
它提供哪些 capability？
它依赖哪些 capability？
它注册哪些 route/menu/settings/home/command？
它是否直接 import 了其他插件？
```

不能回答清楚时，不进入实现。
