# 001 移除 S3 存储、存储设置与 protocol storage 能力硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolValidation.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-protocol/src/storageObjectService.ts`
- `packages/plugin-protocol/src/index.ts`
- `packages/plugin-settings/src/manifest.ts`
- `packages/plugin-settings/src/StorageSettingsPage.tsx`
- `packages/plugin-settings/src/StorageSettingsPage.test.tsx`
- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/protocolStorageDb.test.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.test.tsx`
- `README.md`
- `docs/keymaster-storage-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
- `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md`

发生冲突时：

1. 本单关于“彻底移除 storage.* / S3 provider / `/settings/storage`”的定义优先。
2. 历史施工单保留为历史真值证据，**不修改**，但不再作为现行能力承诺。
3. 后续若再引入新的对象存储能力，必须先出新施工单与新 docs，再改 contract、实现、测试；不允许在本单删除后的残骸上恢复。

---

## 1. 本单定位

本单不是“先把 UI 隐藏，底层接口先留着”的软下线，也不是“保留 contract，运行时报不支持”的兼容过渡。

本单定义的是一次**硬切换真删除**：

- 删除 S3-compatible provider 配置能力；
- 删除 `/settings/storage` 设置页；
- 删除 `protocolService` 上的 storage provider 配置读写接口；
- 删除对外 `storage.put/get/list/listAll/delete` 协议方法；
- 删除 storage 参数校验、storage 执行链路、storage 错误映射、S3 适配实现；
- 删除 `keymaster.protocol` DB 中 `storageProviderConfig` store；
- 删除现行 README / docs 中把该能力视为“当前存在能力”的描述；
- **不修改历史施工单**，保留过去决策痕迹。

这次目标不是“降级为不可用”，而是把这套能力从现行系统里**彻底抹去，不留尾巴**。

---

## 2. 简述缘由

### 2.1 这套能力目前已经扩散到多层，不硬切只会留下半死状态

当前 S3 / `storage.*` 不是单点实现，而是已经扩散到：

- `contracts` 对外协议；
- `protocolService` 调度与执行；
- `protocolValidation` 入参校验；
- `protocolStorageDb` 本地配置落盘；
- `plugin-settings` 设置页与 i18n；
- `plugin-protocol` manifest 注入与文案；
- README / docs / tests。

如果只删页面、不删 contract，不会得到“简单”，只会得到：

- 文档还说支持；
- 类型系统还说支持；
- 测试桩还要求实现这些方法；
- DB 里还残留旧 store；
- 后续有人以为这是临时坏掉而不是已删除。

这与项目“简单优先、失败就失败、不要留下复杂边缘兼容层”的原则相冲突。

### 2.2 这套能力还没沉淀成稳定系统，继续留壳没有收益

从当前仓库状态看，这套能力主要还是：

- 一份协议定义；
- 一套本地设置；
- 一条 `protocolService -> storageObjectService -> S3` 执行链；
- 一批测试与文档承诺。

它还没有成为项目里不可替代的运行时基石。此时最合理的处理不是“兼容保留”，而是一次性整根拔掉，避免后续维护和认知污染。

### 2.3 本次删除必须是“现行真值删除”，不是“历史痕迹删除”

你已经明确：

- 现行系统里要彻底抹去；
- 历史施工单不动，因为施工单是过去式，要保留证据。

所以本次边界很清楚：

- **删现行代码、现行测试、现行文档、现行配置入口、现行 DB store；**
- **不碰历史施工单。**

### 2.4 不做远端清理，是为了保持系统简单

这次删除只作用于**本地代码与本地存储真值**。

不做这些事：

- 不主动连接远端 S3 清对象；
- 不尝试迁移旧对象；
- 不做“如果远端还有数据则提示迁移”的复杂补偿；
- 不做“检测历史配置后自动导出”之类的一次性迁移脚本。

原因很简单：

- 这些都是带外部副作用的复杂迁移；
- 会让“删除能力”变成“删除 + 迁移 + 回滚 + 外部清理”组合工程；
- 与本项目的简单性原则不符。

本次只要求：本地系统从现在开始**不再认识这套能力**。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. 对外协议方法集合中不再存在 `storage.put/get/list/listAll/delete`。
2. `packages/contracts/src/protocol.ts` 中不再存在 `StorageProviderConfig`、storage params/result 类型、`ProtocolService` 上的 storage config CRUD。
3. `protocolValidation` 不再识别 storage 方法，也不再解析 storage 参数。
4. `protocolService` 不再分发 storage 方法，不再持有 storage provider config 读写接口，不再依赖 storage crypto bridge / object service。
5. `storageObjectService.ts` 彻底删除，`plugin-protocol` 不再注入 S3 适配与 storage content key 派生桥。
6. `/settings/storage` 路由、页面、面包屑、i18n 文案、测试全部删除。
7. `keymaster.protocol` IndexedDB schema 中不再存在 `storageProviderConfig` store；升级后旧本地配置被物理删除。
8. README / docs 不再把 storage.* / S3 provider 当成现行支持能力。
9. 历史施工单原文保持不动。
10. 仓库中除历史施工单外，不应再出现“现行能力语义”的 `storage.*` / S3 provider 残留引用。

---

## 4. 单真值定义

### 4.1 本次要删掉的“storage”指什么

本单里“要删的 storage”**只**指以下对象：

- `storage.put`
- `storage.get`
- `storage.list`
- `storage.listAll`
- `storage.delete`
- `StorageProviderConfig`
- `/settings/storage`
- `storageProviderConfig` IndexedDB store
- `storageObjectService.ts` 及其 S3-compatible 适配实现

### 4.2 本次明确**不**删什么

以下能力**不是**本次删除对象：

- `keyspace.openKeyStorage` 相关 key-scoped storage 能力
- vault / keyspace / runtime 自己用的 IndexedDB
- `localStorage` 通用配置能力
- connect session / launch token / fee pool / command history 等 protocol DB 其它 store
- 历史施工单里的 storage 描述

也就是说，本次删除的是“对象存储协议能力”，不是“项目里所有叫 storage 的东西”。

### 4.3 删除完成后的现行真值

删除完成后，现行系统的真值应是：

```txt
Keymaster 当前不支持 storage.* 对外协议族
Keymaster 当前不支持全局 S3 provider 配置页
Keymaster 当前不在 protocol DB 中保存 storage provider 配置
```

不是：

```txt
支持但默认关闭
支持但 UI 隐藏
支持但运行时报错
支持但文档还没改
```

---

## 5. 怎么做

### 一、contracts 层硬删除 storage 契约

在 `packages/contracts/src/protocol.ts` 中一次性删除：

- `PROTOCOL_METHODS` 内的五个 `storage.*` 方法；
- `StoragePutParams` / `StorageGetParams` / `StorageListParams` / `StorageListAllParams` / `StorageDeleteParams`；
- `StoragePutResult` / `StorageGetResult` / `StorageListResult` / `StorageDeleteResult`；
- `StorageListEntry`、`StorageProviderConfig`；
- `MethodParams` / `MethodResult` 中对应 storage 映射；
- `ProtocolStorageDb` 上的 `get/put/deleteStorageProviderConfig`；
- `ProtocolService` 上的 `get/set/clearStorageProviderConfig`；
- 相关注释与“现行 contract 承诺”文字。

要求：

1. 删干净，不留 deprecated。
2. 不保留“临时兼容别名类型”。
3. 不保留空接口占位。

### 二、protocol validation 层硬删除 storage 校验分支

在 `packages/plugin-protocol/src/protocolValidation.ts` 中删除：

- storage 方法分支；
- storage 参数解析函数；
- storage 路径约束、binary 校验等相关逻辑；
- 对应测试前提。

要求：

1. 非 storage 方法不受影响。
2. 删除后如果外部传 `method = "storage.put"`，应作为未知/非法 method 走现行非法请求语义，而不是识别后再报“不支持”。

### 三、protocol service 层硬删除 storage 执行链

在 `packages/plugin-protocol/src/protocolService.ts` 中删除：

- `dispatch()` 里的 storage 分发；
- `getStorageProviderConfig` / `setStorageProviderConfig` / `clearStorageProviderConfig`；
- `getStorageObjectServiceOrNull()`；
- `executeStoragePut/Get/List/ListAll/Delete()`；
- `mapStorageError()`；
- storage 相关依赖声明与注释；
- 与 storage 相关的类型 import；
- 与 storage crypto bridge / object service 相关的构造参数。

要求：

1. 删除后 `protocolService` 不再知道 S3、不再知道 provider config、不再知道 storage content key。
2. connect / identity / intent.sign / cipher / p2pkh / feepool / launchAppView 现有路径不被顺手改形。

### 四、protocol plugin 层硬删除 storage 注入与导出

在 `packages/plugin-protocol/src/manifest.ts` 与 `packages/plugin-protocol/src/index.ts` 中删除：

- `storageObjectService` 相关 import；
- `createStorageObjectService` 注入；
- `createVaultBackedStorageCryptoBridge()`；
- storage 相关 i18n 文案；
- 若 `index.ts` 对外导出了仅 storage 用到的内容，一并删除。

要求：

1. manifest 最终不再构造任何 storage 相关依赖。
2. 不把 storage 桥接保留成“将来可能还会用”的死代码。

### 五、settings 插件层硬删除 `/settings/storage`

在 `packages/plugin-settings` 中删除：

- `StorageSettingsPage.tsx`
- `StorageSettingsPage.test.tsx`
- `manifest.ts` 中 `/settings/storage` 路由注册；
- 相关 breadcrumb；
- 相关中英文 i18n 文案；
- 若存在样式残留，一并删除。

要求：

1. settings 页面最终只保留仍然存在的系统设置。
2. 不能只是 `visibleWhen = false`，必须真删注册。

### 六、protocol DB 层做 schema 硬迁移，物理删除旧 store

在 `packages/plugin-protocol/src/protocolStorageDb.ts` 中：

- 升 DB version；
- 在 upgrade 路径里物理删除 `storageProviderConfig` store；
- 删除 `STORE_STORAGE_PROVIDER_CONFIG` 常量；
- 删除 `txStorageProviderConfig()`；
- 删除 `get/put/deleteStorageProviderConfig()` 实现；
- 调整顶部注释、schema 注释、version 迁移说明；
- 保持 `commands` / `origins` / `feePools` / `connectSessions` / `launchTokens` 正常存在。

要求：

1. 这是**真删除旧 store**，不是“保留 store 但不再读写”。
2. 升级后旧本地配置自动消失，不需要用户手工清理。
3. 不允许顺手重建无关 store，不允许把 connect / launchToken 逻辑一起翻修。

### 七、测试层同步收口

必须同步删除或改写以下测试残留：

- `packages/plugin-settings/src/StorageSettingsPage.test.tsx`
- `packages/plugin-protocol/src/protocolService.test.ts` 中 storage config stub / storage.* 用例
- `packages/plugin-protocol/src/protocolStorageDb.test.ts` 中 storageProviderConfig 相关用例
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`、`OriginSettingsTray.test.tsx` 等 mock `ProtocolService` 时带的 storage config stub

要求：

1. 测试桩接口必须跟最终 contract 一致。
2. 不允许为了省事保留“多余 mock 方法”。

### 八、README / docs 收口为“已删除或不再支持”

现行文档处理原则：

- `README.md`：删除现行能力描述。
- `docs/keymaster-storage-v1-draft.md`：不再作为现行能力文档。可删除文件，或明确改成“已撤回/已移除”的状态说明，但不能继续写成有效协议草案。
- `docs/keymaster-protocol-common-v1-draft.md` / `docs/keymaster-connect-v1-draft.md`：删除把 `storage.*` 视为现行方法族的描述。

要求：

1. 不能让现行 docs 继续暗示系统支持这套能力。
2. 历史施工单保留，不改。

---

## 6. 不能怎么做

本次明确禁止以下做法：

### 6.1 不能只隐藏 UI

禁止：

- 只删 `/settings/storage` 页面；
- 只删菜单入口；
- 保留 contract、service、DB store。

这会留下假能力。

### 6.2 不能保留“报 not supported”的兼容空壳

禁止：

- `storage.*` 还留在 `PROTOCOL_METHODS`；
- `protocolService` 识别 storage 方法但返回 `internal_error`；
- `ProtocolService` 还挂着 config CRUD 但实现 no-op。

这不是简单，是死壳。

### 6.3 不能只停用，不删本地 schema

禁止：

- 保留 `storageProviderConfig` store；
- 注释写“旧数据懒得删”；
- 把旧 store 当将来可能复用的缓存。

你要求的是“彻底抹去不留尾巴”，这里必须物理删除。

### 6.4 不能误删项目里别的 storage 概念

禁止把以下内容一并删掉：

- key-scoped storage
- vault / keyspace 自身 DB
- protocol DB 的非 storage store
- localStorage 通用逻辑

删错对象比不删更糟。

### 6.5 不能改历史施工单

禁止：

- 回写旧施工单把 storage 段落删掉；
- 在历史施工单正文里补“已废弃”；
- 用修改历史文档来伪装现行真值变更。

历史单据就是历史证据，保持原样。

### 6.6 不能引入复杂迁移补偿

禁止：

- 自动导出旧 S3 配置；
- 自动访问远端 S3 做对象清理；
- 为旧 storage.* 请求做兼容转发；
- 做跨版本双读双写。

一旦做这些，删除工程就被复杂迁移绑架了。

---

## 7. 特殊情况与处理

### 情况 1：用户本地已有旧 `storageProviderConfig`

处理：

- 通过 DB version 升级，在 `onupgradeneeded` 中物理删除 `storageProviderConfig` store。
- 不做数据保留，不做导出提示，不做迁移。

理由：

- 本次是硬切换真删除；
- 配置作为已撤销能力的一部分，应随升级一起清除。

### 情况 2：现有测试或 mock 因接口删除而大面积编译失败

处理：

- 以最终 contract 为准逐个收口；
- 删掉多余 stub；
- 只保留现行接口需要的方法。

禁止：

- 为了让测试先过，把已删除接口重新塞回类型定义。

### 情况 3：README / docs 与历史施工单内容冲突

处理：

- 现行 README / docs 必须改成与删除后的系统一致；
- 历史施工单保持不动。

解释口径：

- 历史施工单描述过去计划；
- README / docs 描述当前系统。

### 情况 4：仓库里还有 `storage.*` 文字残留

处理：

- 先判断是否属于历史施工单；
- 若是历史施工单：保留；
- 若是现行代码、测试、README、docs、注释：清掉或改写。

### 情况 5：IndexedDB 版本升级影响其它 store

处理：

- 迁移脚本只针对 `storageProviderConfig` store 做最小必要修改；
- 其它 store 除非为删除该 store 必须触及，否则不改行为。

理由：

- 这是删除对象存储能力，不是重构 protocol DB。

### 情况 6：外部调用方还在发 `storage.*` 请求

处理：

- 删除后这些 method 不再是合法协议方法；
- 按现行非法请求语义处理；
- 不提供“旧接口仍可识别但回不支持”的软兼容。

理由：

- 硬切换的边界就是“旧调用方必须升级”。

---

## 8. 文件级施工清单

### A. 必改文件

- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/protocolValidation.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-protocol/src/index.ts`
- `packages/plugin-settings/src/manifest.ts`
- `README.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`

### B. 预期删除文件

- `packages/plugin-protocol/src/storageObjectService.ts`
- `packages/plugin-settings/src/StorageSettingsPage.tsx`
- `packages/plugin-settings/src/StorageSettingsPage.test.tsx`
- `docs/keymaster-storage-v1-draft.md`

> 若执行时决定 `docs/keymaster-storage-v1-draft.md` 不直接删除，则必须把文件头部和正文明确改成“已撤回/不再支持”，不能继续保留为有效草案。

### C. 必改测试文件

- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/protocolStorageDb.test.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.test.tsx`

### D. 可能需要顺手收口的引用文件

- `packages/plugin-settings/src/index.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
- `apps/web/src/bootstrapPlugins.ts`
- 其它被类型删除波及的文件

要求：

1. 这些文件只能做“被本次删除直接牵连的最小修改”。
2. 不借机重构无关模块。

---

## 9. 实施步骤

1. 先删 `contracts` 中 storage 契约，建立最终类型真值。
2. 再删 `protocolValidation` 与 `protocolService` 中的 storage 执行路径。
3. 再删 `storageObjectService.ts` 与 `plugin-protocol` manifest 注入。
4. 再删 `plugin-settings` 的 `/settings/storage` 页面、注册与文案。
5. 再做 `protocolStorageDb` version 升级，物理删除 `storageProviderConfig` store。
6. 再统一修测试、mock、导出引用。
7. 最后清 README / docs，并做全文搜索确认残留只存在于历史施工单。

这个顺序的原因：

- contract 先收口，能最快暴露哪些调用点还在依赖已删除能力；
- DB 迁移后做，避免前面改动过程中还误用旧接口；
- 文档最后做，保证文字跟最终代码状态一致。

---

## 10. 最终验收清单

### 10.1 代码结构验收

- [ ] `packages/contracts/src/protocol.ts` 中不再出现 `storage.put/get/list/listAll/delete`。
- [ ] `packages/contracts/src/protocol.ts` 中不再出现 `StorageProviderConfig` 与 storage params/result 类型。
- [ ] `ProtocolService` 接口上不再出现 storage config CRUD。
- [ ] `ProtocolStorageDb` 接口上不再出现 storage provider config CRUD。
- [ ] `packages/plugin-protocol/src/protocolValidation.ts` 不再有 storage 分支。
- [ ] `packages/plugin-protocol/src/protocolService.ts` 不再有 storage 执行函数与错误映射。
- [ ] `packages/plugin-protocol/src/storageObjectService.ts` 已删除。
- [ ] `packages/plugin-settings/src/StorageSettingsPage.tsx` 已删除。
- [ ] `packages/plugin-settings/src/manifest.ts` 不再注册 `/settings/storage`。

### 10.2 本地存储验收

- [ ] `packages/plugin-protocol/src/protocolStorageDb.ts` DB version 已提升。
- [ ] upgrade 逻辑中明确物理删除 `storageProviderConfig` store。
- [ ] 运行后 `keymaster.protocol` schema 中不再存在 `storageProviderConfig`。

### 10.3 文档与文案验收

- [ ] README 不再宣称系统支持 storage.* / S3 provider。
- [ ] 现行 docs 不再把 storage.* 当成有效方法族。
- [ ] `docs/keymaster-storage-v1-draft.md` 已删除，或已明确改成撤回状态。
- [ ] 历史施工单未被修改。

### 10.4 搜索验收

以仓库根目录全文搜索为准：

- [ ] `rg -n "storage\\.put|storage\\.get|storage\\.listAll|storage\\.list|storage\\.delete" packages apps README.md docs` 无现行残留。
- [ ] `rg -n "StorageProviderConfig|storageProviderConfig|StorageSettingsPage|storageObjectService" packages apps README.md docs` 无现行残留。
- [ ] 若仍有命中，仅允许出现在 `施工单/` 历史文档中，或本单这种“删除说明”文档中。

### 10.5 回归验收

- [ ] TypeScript / 测试在删除后的最终接口上通过。
- [ ] 现有 connect / identity / intent.sign / cipher / p2pkh / feepool / appView 启动路径不因 storage 删除而回归失败。
- [ ] `/settings/language`、`/settings/plugins`、`/settings/logs` 正常存在。
- [ ] `/settings/storage` 不再可达。

---

## 11. 完成定义

以下条件同时满足，才算本单完成：

1. 代码中已无现行 storage.* / S3 provider 能力实现；
2. DB schema 中已无 `storageProviderConfig` store；
3. settings 中已无 storage 入口；
4. 现行文档中已无该能力承诺；
5. 历史施工单保持不动；
6. 全仓搜索后，相关残留只存在于历史施工单或本单这种删除记录里。

只做到“用户看不到入口”不算完成。
只做到“接口运行时报错”不算完成。
只做到“代码删了但 DB / docs 还在”也不算完成。
