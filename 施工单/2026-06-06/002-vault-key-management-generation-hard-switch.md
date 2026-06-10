# 002 Vault Key 管理与安全生成一次性硬切换施工单

## 目标

一次性补齐 Vault Key 管理入口、页面导航和本地安全生成能力。

本次不是只修一个失效链接，也不是先做空页面、后补生成逻辑。完成后系统必须形成以下完整闭环：

```txt
进入 Key 管理
  /settings/vault              -> 唯一正式路由
  /#/settings/vault            -> 启动时一次性迁移到 /settings/vault
  侧边栏“Key 管理”             -> SPA 内导航
  顶栏 Key Switch“管理 Key”    -> 正式 pathname 链接

管理已有 Key
  查看状态 / 标签 / 指纹 / 公钥 / 能力 / 创建时间
  设为 active
  导出加密备份
  删除 Key 及其 namespace

新增 Key
  新建 Key -> Vault 内部安全生成 secp256k1 私钥 -> 立即加密落库
  导入 Key -> 进入现有 /import 流程
  新建成功 -> 自动设为 active -> 提示立即导出加密备份
```

## 简述缘由

1. `/settings/vault` 路由和 `VaultSettingsPage` 实际已经存在，页面“找不到”的直接原因是应用路由只读取 `window.location.pathname`，而顶栏链接错误地写成了 `#/settings/vault`。
2. 只把链接改正确仍不完整。当前 Key 管理页只能管理已有 Key，没有安全生成新 Key 的能力，用户必须从外部准备私钥再导入。
3. 私钥生成属于 Vault 安全边界，不能放在 React 页面、Importer 或 P2PKH 插件中。页面只能提交标签，Vault 负责生成、派生身份、加密和持久化。
4. 项目已经通过 `keyspace.notifyKeyCreated` 保证新 Key 自动成为 active key。新建流程应复用同一条持久化路径，不能另写一套不发事件、不切 active 的旁路。
5. 当前 `/settings` 中注册了一个没有字段、没有组件的 Vault“安全”占位区，同时又存在独立 `/settings/vault` 路由。硬切换后必须保留一个明确入口，避免重复和空白设置项。

## 硬切换边界

本施工单要求一次完成以下内容，不允许拆成“先可访问、后能生成”：

```txt
旧 hash 链接迁移
正式 pathname 路由
侧边栏入口
面包屑
Key 管理页面重构
VaultService 安全生成接口
新建 Key Modal
新建后 active 切换
新建后备份提示
单元测试
构建与人工验收
```

可以分多个 commit 实施，但合并、发布和验收必须作为一个整体完成。中间态不能进入主分支。

## 核心不变量

1. `/settings/vault` 是唯一正式路由，不建立长期 hash router。
2. `/#/settings/vault` 只作为旧入口兼容，应用启动前通过 `history.replaceState` 一次性迁移；迁移后地址栏必须是 `/settings/vault`。
3. React 页面、组件 state、MessageBus payload、日志和 URL 中不得出现私钥明文。
4. 随机私钥必须由 Vault 插件内部使用密码学安全随机源生成。
5. 生成结果必须先派生 `publicKeyHex / publicKeyHash / fingerprint`，再按现有 Vault 加密规则写入 `vault_keys`。
6. 新建和导入必须共用同一条私钥持久化内部流程，不能复制加密、去重、事件和 active 切换逻辑。
7. 新 Key 持久化成功后必须调用 `keyspace.notifyKeyCreated`，再发布 `key.created`；订阅者看到事件时 active key 已经切换完成。
8. 新建成功后提示导出备份，但不能强制用户先导出才能继续。
9. 导出仍只允许 bsv8 加密 JSON，不增加 WIF、HEX 或明文 JSON 导出。
10. 删除仍必须走 `keyspace.deleteKeyById(keyId)`，不能从页面直接删除 Vault 记录。
11. 标签不是身份主键，可以重复；`publicKeyHash` 才是跨插件 Key 身份。
12. 页面文案、文档和注释使用中文；代码错误信息使用英文。

## 最终页面与交互

### 页面标题

```txt
Key 管理
管理本地 Vault 中的 Key、active 身份和加密备份。
```

### 页头操作

按以下顺序显示：

```txt
新建 Key
导入 Key
锁定钱包
```

约束：

1. “新建 Key”是主操作。
2. “导入 Key”进入现有 `/import`，不在管理页重复实现 importer。
3. “锁定钱包”保留，但视觉层级不能高于新建操作。
4. 操作进行中必须禁用重复提交。

### Key 列表

桌面端保留紧凑数据表，至少展示：

```txt
标签
指纹
状态
公钥
能力
创建时间
操作
```

行操作保留：

```txt
设为 active / 当前 Key
导出
删除
```

移动端不能只依赖横向滚动的大表格。应改为纵向 Key 条目：

```txt
标签 + 状态
指纹
能力 + 创建时间
展开公钥
操作按钮组
```

移动端条目可以使用轻量分隔面，不做多层卡片嵌套。

### 空状态

没有任何 Key 时显示：

```txt
还没有 Key
可以在本地安全生成一把新 Key，也可以导入已有私钥。

[新建 Key] [导入 Key]
```

空状态不能再只提示“前往导入”。

### 新建 Key

点击“新建 Key”打开 Modal。

输入项：

```txt
标签
```

标签默认值建议使用本地时间生成，例如：

```txt
Key 2026-06-06 14:30
```

约束：

1. 提交前执行 `trim`。
2. 空标签拒绝提交。
3. 标签最长 64 个字符。
4. 不要求标签唯一。
5. 页面不提供“显示私钥”“复制 HEX”“下载 WIF”等选项。

确认文案：

```txt
新建 Key
```

创建期间：

```txt
按钮 loading
禁止关闭后再次提交
禁止连续点击生成多把 Key
```

### 创建成功

同一个 Modal 切换到成功状态，展示：

```txt
Key 已创建并设为 active
标签
指纹
备份风险提示
```

风险提示：

```txt
该 Key 只保存在当前浏览器的本地 Vault 中。清除浏览器数据、设备损坏或忘记 Vault 密码都可能导致无法恢复，请尽快导出加密备份。
```

操作：

```txt
导出加密备份
稍后
```

“导出加密备份”必须复用现有 `VaultKeyExportModal`，不能实现第二套导出逻辑。

## 私钥生成设计

### 对外契约

在 `VaultService` 增加：

```ts
generateKey(input: {
  label: string;
  capabilities?: string[];
}): Promise<KeyRef>;
```

语义：

1. 仅允许 Vault 已解锁时调用。
2. 默认 `capabilities = ["p2pkh"]`。
3. 返回公开 `KeyRef`，不返回私钥材料。
4. 记录的 `format` 固定为 `generated`。
5. 记录的 `source` 固定为 `vault-generated`。

### 内部生成

在 Vault 插件内部使用 `@noble/secp256k1` 已提供的安全生成函数：

```ts
secp256k1.utils.randomPrivateKey()
```

生成出的 `Uint8Array` 只允许在 `generateKey` 的局部调用链中短暂存在，并立即转换为现有加密持久化流程需要的材料。

不能把随机字节返回给组件，也不能通过 MessageBus 传递。

### 共用持久化路径

从现有 `importPrivateKey` 中抽出内部私有函数，例如：

```ts
persistPrivateKey(input: {
  label: string;
  material: PrivateKeyMaterial;
  format: string;
  capabilities: string[];
  source?: string;
}): Promise<KeyRef>
```

统一负责：

```txt
校验 Vault 已解锁
校验标签
派生 KeyIdentity
按 publicKeyHash 检查重复
加密私钥材料
写入 vault_keys
清空 keyCache
通知 keyspace 新 Key
发布 key.created
返回 KeyRef
```

调用关系：

```txt
importPrivateKey -> persistPrivateKey
generateKey      -> 安全随机生成 -> persistPrivateKey
```

设计缘由：

```txt
导入和生成的区别只在私钥材料来源。
加密、身份、去重、active 切换和事件语义必须完全一致。
```

## 路由硬切换

### 正式路由

继续使用已注册路由：

```txt
/settings/vault
```

不新增：

```txt
/vault/keys
/keys
/#/settings/vault 作为长期路由
```

### 旧 hash 地址迁移

在 React 挂载前处理旧地址。

迁移规则：

```txt
pathname === "/"
hash 以 "#/" 开头
hash 内是单斜杠开头的站内路径
  -> history.replaceState({}, "", hash.slice(1))
```

示例：

```txt
/#/settings/vault
  -> /settings/vault

/#/import?source=vault
  -> /import?source=vault
```

以下地址不得迁移：

```txt
/#section
/assets#/settings/vault
/#//example.com
/#/https://example.com
```

迁移必须使用 `replaceState`，不能新增一条浏览器历史记录，也不能触发整页重载。

### 导航入口

1. Vault 插件在 `menu.registry` 注册“Key 管理”，关联 `vault.settings` 路由。
2. 菜单分组使用 `settings`，排序位于通用“设置”之前。
3. Vault 插件注册 `/settings/vault` 面包屑。
4. 顶栏 Key Switch 中的“管理 Key”链接改为正式 `/settings/vault`。
5. 删除 Vault 当前在 `settings.registry` 中无字段、无组件的“安全”空占位页。

## 文件级施工

### 新增文件

```txt
apps/web/src/shell/legacyHashRoute.ts
apps/web/src/shell/legacyHashRoute.test.ts
packages/plugin-vault/src/VaultKeyCreateModal.tsx
```

如果移动端列表拆分后能明显降低 `VaultSettingsPage.tsx` 复杂度，可以新增：

```txt
packages/plugin-vault/src/VaultKeyList.tsx
```

不能为了拆文件创建只有一层 JSX 转发、没有独立职责的组件。

### `apps/web/src/main.tsx`

修改内容：

1. 在环境检查和 React 挂载前调用旧 hash 路由迁移函数。
2. 迁移只处理站内 `#/` 路径。
3. 保持主题初始化在首帧前完成。

目标顺序：

```txt
applyInitialTheme()
normalizeLegacyHashRoute()
checkEnvironment()
bootstrapPlugins()
React mount
```

### `apps/web/src/shell/legacyHashRoute.ts`

职责：

1. 解析旧 hash 路径。
2. 校验仅允许站内单斜杠路径。
3. 使用 `history.replaceState` 替换 URL。
4. 返回是否发生迁移，便于测试和诊断。

建议把纯解析与浏览器副作用分开：

```ts
parseLegacyHashPath(pathname: string, hash: string): string | undefined
normalizeLegacyHashRoute(): boolean
```

错误信息使用英文。

### `apps/web/src/shell/legacyHashRoute.test.ts`

覆盖：

1. `/#/settings/vault` 解析为 `/settings/vault`。
2. hash 内 query 被保留。
3. 普通 anchor hash 不迁移。
4. 非根 pathname 不迁移。
5. 双斜杠和外部 URL 形式不迁移。
6. `replaceState` 只调用一次。

### `vitest.config.ts`

当前只包含 `packages/**` 测试。扩展为同时包含：

```txt
packages/**/*.test.ts
packages/**/*.spec.ts
apps/**/*.test.ts
apps/**/*.spec.ts
```

本次路由解析测试是纯函数测试，不为了它引入 jsdom。

### `packages/contracts/src/vault.ts`

修改 `VaultService`：

```ts
generateKey(input: {
  label: string;
  capabilities?: string[];
}): Promise<KeyRef>;
```

注释必须写明：

1. 私钥由实现内部安全生成。
2. 调用方只能拿到 `KeyRef`。
3. 明文私钥不得离开 Vault 内部局部调用链。

不新增公开的：

```txt
generatePrivateKeyHex()
getGeneratedPrivateKey()
exportPlainKey()
```

### `packages/plugin-vault/src/keyIdentity.ts`

新增内部安全生成 helper，或直接在 `vaultService.ts` 中调用 noble 工具。

如果新增 helper，职责只允许是：

```txt
生成合法 secp256k1 私钥字节
转换为持久化流程需要的 lowercase hex
```

约束：

1. 使用 `@noble/secp256k1` 的 `utils.randomPrivateKey()`。
2. 不使用 `Math.random()`。
3. 不自行用时间戳、UUID、用户输入或 hash 拼私钥。
4. 不派生地址。
5. 不写 IndexedDB。

### `packages/plugin-vault/src/vaultService.ts`

主要改动：

1. 抽取 `persistPrivateKey` 内部函数。
2. `importPrivateKey` 改为调用统一内部函数。
3. 实现 `generateKey`。
4. `generateKey` 在 Vault 锁定时继续通过 `requireMasterKey()` fail closed。
5. 标签统一 trim、校验空值和最大长度。
6. 生成记录使用：

```txt
format = "generated"
source = "vault-generated"
capabilities = input.capabilities ?? ["p2pkh"]
```

7. DB 写入成功前不得通知 keyspace 或发布事件。
8. DB 写入成功后保持现有顺序：

```txt
keyCache = null
keyspace.notifyKeyCreated(identity)
messageBus.publish("key.created", ...)
```

9. `key.created` payload 仍只包含公开身份，不增加私钥、WIF 或 HEX。

### `packages/plugin-vault/src/vaultService.test.ts`

新增测试：

1. `generateKey` 在 unlocked 状态成功创建 Key。
2. 连续生成两把 Key，`publicKeyHash` 不同。
3. 生成 Key 的 `format/source/capabilities` 正确。
4. `withPrivateKey` 能证明生成材料是合法 32 字节私钥，但测试日志不得输出材料。
5. `generateKey` 返回值不含 `material/hex/wif`。
6. `key.created` 在 active 切换后发布。
7. locked 状态调用拒绝。
8. 空标签和超长标签拒绝。
9. 生成成功后 `listKeys` 能立即读到新 Key。
10. 重构后现有多 Key 导入、导出、删除测试全部继续通过。

测试不能断言固定随机私钥值。需要可控随机时，应在内部 helper 层注入测试替身，不能把随机源暴露到公开 VaultService 契约。

### `packages/plugin-vault/src/VaultKeyCreateModal.tsx`

职责：

1. 管理标签输入和提交状态。
2. 调用父组件传入的 `onCreate(label)`。
3. 创建成功后展示公开 Key 信息和备份提示。
4. 提供“导出加密备份”和“稍后”操作。
5. 防止重复提交。

不负责：

1. 不调用 `crypto.getRandomValues` 或 noble。
2. 不保存私钥材料。
3. 不直接写 IndexedDB。
4. 不实现导出加密和文件下载。
5. 不切换 active key。

组件 prop 建议：

```ts
onCreate(label: string): Promise<KeyRef>
onExport(key: KeyRef): void
onClose(): void
```

### `packages/plugin-vault/src/VaultSettingsPage.tsx`

修改为真正的 Key 管理工作面：

1. 标题从“安全设置”改为“Key 管理”。
2. 页头加入“新建 Key”“导入 Key”“锁定钱包”。
3. 接入 `VaultKeyCreateModal`。
4. 创建成功后刷新列表。
5. 创建成功对象用于打开现有 `VaultKeyExportModal`。
6. 空状态提供新建和导入两个动作。
7. 桌面表格与移动端列表使用同一份 `keys/active/expanded` 状态和同一组 handler。
8. 保留 failed / uninitialized Key 的现有防御：

```txt
failed 不允许设为 active
无 publicKeyHash 不展示公钥
failed 仍允许导出和删除
删除统一按 keyId
```

9. 异步操作失败后显示错误，但不能清空已有 Key 列表。
10. 创建请求返回错误时先刷新列表，防止“DB 已保存但 active 通知失败”导致用户误点再次生成。

### `packages/plugin-vault/src/KeySwitchWidget.tsx`

修改：

```txt
href="#/settings/vault"
  -> href="/settings/vault"
```

约束：

1. 不在插件里 import `apps/web/src/shell/RouteRenderer`。
2. 不继续写 hash 链接。
3. 主导航由新增侧边栏入口承担；该链接作为快捷入口。
4. 如果使用普通 anchor，部署环境必须继续满足 history fallback，这是 pathname 路由现有运行前提，不在组件内实现第二套路由器。

### `packages/plugin-vault/src/manifest.ts`

增加：

1. `MenuRegistry` 注册。
2. `BreadcrumbRegistry` 注册。

菜单建议：

```txt
id: menu.vault.keys
label: Key 管理
routeId: vault.settings
group: settings
order: 0
icon: KeyRound
visibleWhen: unlocked
```

面包屑：

```txt
设置 / Key 管理
```

删除：

```txt
settings.registerPage({
  id: "vault.security",
  fields: []
})
```

删除缘由：

```txt
它目前只在 /settings 产生空白“安全”区块，真实管理能力在独立路由。
硬切换后以独立 Key 管理页为唯一操作面。
```

### `packages/plugin-vault/src/index.ts`

只有外部确实需要复用时才导出 `VaultKeyCreateModal`。

默认不导出内部页面组件，避免扩大插件公开 API。

### `apps/web/src/styles/global.css`

新增或调整：

1. Key 管理页最大内容宽度和操作区布局。
2. 页头多操作按钮在窄屏换行。
3. 新建成功备份警告样式。
4. 移动端 Key 列表样式。
5. active / ready / failed / initializing 状态视觉。
6. 长公钥、长标签和长错误信息的断行。
7. Modal 在小屏下不溢出视口。

视觉约束：

1. 沿用现有浅色/深色变量。
2. 主色仍使用 `--primary`，危险操作使用 `--danger`。
3. 不新增紫色渐变或独立设计体系。
4. 不把每个字段包成独立卡片。
5. 动效只用于 Modal 出现和创建成功状态切换，保持短促。

## 不能怎么做

1. 不能只新增一个空的 `/settings/vault` 页面；现有页面已经存在，必须修正完整入口和能力。
2. 不能同时长期维护 pathname router 和 hash router。
3. 不能把 `RouteRenderer` 改成永久优先读取 `location.hash`，否则会形成两套当前路由状态。
4. 不能让 `/#/settings/vault` 保持在地址栏中正常运行；必须迁移成正式路径。
5. 不能在 React 组件中生成私钥。
6. 不能把私钥放进 `useState`、Context、MessageBus、localStorage、普通日志或错误对象。
7. 不能使用 `Math.random()`、时间戳、UUID 或用户标签作为私钥熵源。
8. 不能通过 Importer 实现“新建 Key”。Importer 只负责解析外部输入。
9. 不能让 P2PKH 插件生成平台 Key。P2PKH 只消费 Key 并派生业务资源。
10. 不能新增明文 WIF、HEX、助记词或未加密 JSON 导出。
11. 不能在创建完成前发布 `key.created`。
12. 不能创建成功后仍停留在 all-keys 模式；应复用现有自动 active 语义。
13. 不能为了简化删除而直接调用 `vault.deleteKeyMaterial`。
14. 不能强制用户完成导出后才能关闭成功提示。
15. 不能要求标签唯一，也不能用标签做 namespace。
16. 不能在本次修改 Vault 主密码、Vault DB schema、bsv8 envelope 格式或 P2PKH 同步架构。
17. 不能保留 `/settings` 中无内容的 Vault 安全占位区。
18. 不能因移动端适配复制一套独立业务逻辑。

## 特殊情况处理

### Vault 已锁定

正常情况下 `VaultSettingsPage` 只在 unlocked shell 渲染。

如果状态切换竞态导致提交时 Vault 已锁定：

```txt
generateKey 抛 "Vault is locked"
页面停止 loading
不创建任何记录
App 根据 Vault 状态返回 LockedShell
```

不能在页面缓存生成请求并在下次解锁后自动执行。

### WebCrypto 或安全上下文不可用

应用入口现有环境检查继续 fail closed。

不能降级到非安全随机源，也不能允许在 HTTP 非 localhost 环境生成 Key。

### 随机源失败

`utils.randomPrivateKey()` 抛错时：

```txt
不写 DB
不发事件
不切 active
页面显示错误
允许用户明确再次点击重试
```

不能自动无限重试。

### 随机 Key 碰撞

理论概率可忽略。如果 `publicKeyHash` 已存在：

```txt
按现有 "Key already exists" 失败
不覆盖旧 Key
不静默循环生成
```

碰撞更可能意味着随机源、测试替身或运行环境异常，应让错误可见。

### DB 写入失败

如果加密完成但 `vaultDb.putKey` 失败：

```txt
不通知 keyspace
不发布 key.created
不显示创建成功
局部私钥材料随调用结束不可达
```

### DB 已写入但 active 通知失败

现有时序中 DB 写入先于 `keyspace.notifyKeyCreated`。

如果通知失败：

1. 不能回删已经安全写入的 Key，避免误删用户刚生成且尚未备份的私钥。
2. 页面捕获错误后立即刷新 Key 列表。
3. 如果新 Key 已出现在列表中，提示：

```txt
Key 已保存，但未能自动设为 active。请在列表中手动切换。
```

4. 不能自动再次生成另一把 Key。
5. 后续应允许用户手动“设为 active”和导出备份。

### 创建后导出失败

创建成功与导出备份是两个独立结果。

导出失败时：

```txt
保留新 Key
保留 active 状态
成功 Modal 不回退成“创建失败”
展示导出错误并允许重试
```

不能因为导出失败删除新 Key。

### 用户关闭成功提示

允许关闭，不强制备份。

Key 已经持久化并保持 active。下次仍可从 Key 管理页导出。

### 标签重复

允许重复。列表通过指纹区分。

如果两个标签相同，删除确认仍必须使用指纹或 keyId 作为最终确认文本，不能只依赖标签。

### failed / uninitialized Key

现有规则保持：

```txt
failed          -> 可导出、可删除、不可 active
uninitialized   -> 显示初始化中、不可 active
无 publicKeyHash -> 不打开 namespace，不显示伪造指纹
```

新生成 Key 正常路径必须直接是 ready，不经过等待下次 unlock backfill。

### 删除当前唯一 Key

继续由 keyspace 决定 fallback。

删除后无 Key：

```txt
active 进入 all
顶栏显示“无 Key”
管理页显示新建 / 导入空状态
```

不能自动生成替代 Key。

### 旧 hash 中含 query

迁移时保留站内 query，但不保留外层旧 hash。

如果 hash 不符合安全规则，保持原 URL，由现有路由显示 404 或普通页面，不做猜测性修复。

### 部署环境没有 history fallback

本项目现有路由本来就是 pathname 模式，生产部署必须把未知前端路径回退到 `index.html`。

如果部署环境不支持该规则：

1. 应修部署配置。
2. 不能为单个 Key 管理页重新引入 hash router。
3. 验收必须直接刷新 `/settings/vault`，确认不会得到服务器 404。

## 实施顺序

必须按以下顺序完成并在同一次迭代合并：

```txt
1. 增加旧 hash 迁移 helper 与测试
2. 扩展 VaultService generateKey 契约
3. 抽取统一私钥持久化内部流程
4. 实现 Vault 内部安全生成
5. 补 VaultService 单测
6. 新增创建 Modal
7. 重构 VaultSettingsPage
8. 注册菜单与面包屑，删除空设置占位
9. 修正 KeySwitchWidget 正式链接
10. 完成桌面 / 移动端样式
11. 运行完整测试、类型检查、边界检查和构建
12. 按最终验收清单人工验收
```

不能在第 1 步完成后单独发布；此时用户虽然能进入页面，但新建闭环仍不完整。

## 最终验收清单

### 路由与导航

- [ ] 直接访问 `/settings/vault` 能看到 Key 管理页。
- [ ] 刷新 `/settings/vault` 不出现服务器 404。
- [ ] 访问 `/#/settings/vault` 后地址栏自动变为 `/settings/vault`。
- [ ] 旧 hash 迁移不新增浏览器历史记录。
- [ ] `/#section` 不被误迁移。
- [ ] 双斜杠或外部 URL 形式不被迁移。
- [ ] 侧边栏显示“Key 管理”。
- [ ] 顶栏 Key Switch 的“管理 Key”不再使用 hash 链接。
- [ ] 面包屑显示“设置 / Key 管理”。
- [ ] 通用 `/settings` 不再显示空白 Vault“安全”区块。

### 新建 Key

- [ ] 点击“新建 Key”打开 Modal。
- [ ] 空标签不能提交。
- [ ] 超过 64 个字符的标签不能提交。
- [ ] 重复标签允许提交。
- [ ] 连续双击不会生成两把 Key。
- [ ] 新建成功后列表立即出现新 Key。
- [ ] 新 Key 状态为 ready。
- [ ] 新 Key 自动成为 active。
- [ ] 顶栏 Key Switch 立即显示新 Key。
- [ ] 新建返回对象和事件 payload 中没有私钥材料。
- [ ] 新建成功提示包含备份风险说明。
- [ ] 用户可以选择稍后备份。

### 导入、导出与删除回归

- [ ] “导入 Key”进入现有 `/import`。
- [ ] WIF、HEX、bsv8 JSON 导入流程不回归。
- [ ] 新生成 Key 可以导出 bsv8 加密 JSON。
- [ ] 导出失败不删除新 Key。
- [ ] 删除前仍显示严重备份提示。
- [ ] 删除仍走 `keyspace.deleteKeyById`。
- [ ] 删除 active Key 后正确 fallback。
- [ ] 删除唯一 Key 后进入无 Key 空状态。
- [ ] failed Key 仍可导出和删除，但不能设为 active。

### 安全

- [ ] 代码中没有使用 `Math.random()` 生成 Key。
- [ ] React state 中没有私钥、WIF 或 HEX 材料。
- [ ] MessageBus 的 `key.created` 不含私钥。
- [ ] 控制台日志不输出私钥。
- [ ] DOM、URL、下载文件名不含私钥。
- [ ] 只提供加密 JSON 导出。
- [ ] Vault locked 时生成请求 fail closed。
- [ ] DB 写入失败时不发 `key.created`。
- [ ] active 通知失败时不自动重复生成。

### 响应式与可用性

- [ ] 桌面端表格信息完整且操作按钮不拥挤。
- [ ] Pad 和 Mobile 使用可读的纵向 Key 条目。
- [ ] 长标签、长公钥和错误信息不会撑破页面。
- [ ] Modal 在 320px 宽屏幕下可操作。
- [ ] 浅色和深色主题状态、警告和危险按钮均清晰。
- [ ] 键盘 Escape 可以关闭未提交的 Modal。
- [ ] loading 状态下不能关闭或重复提交创建请求。

### 自动化验证

必须全部通过：

```bash
npm test
npm run typecheck
npm run lint:boundaries
npm run build
```

新增测试至少覆盖：

```txt
旧 hash 路由安全迁移
Vault 生成合法 Key
连续生成身份不同
locked fail closed
标签校验
生成后 active 先切换、key.created 后发布
生成结果不暴露私钥
现有导入 / 导出 / 删除回归
```

## 完成定义

只有同时满足以下条件，本施工单才算完成：

```txt
用户能从正式入口进入 Key 管理页
旧 /#/settings/vault 能安全迁移
用户能在 Vault 内安全生成新 Key
新 Key 自动 active
用户能立即导出加密备份
导入 / 导出 / 删除 / failed Key 管理不回归
私钥不越过 Vault 安全边界
桌面和移动端可用
全部自动化命令通过
```
