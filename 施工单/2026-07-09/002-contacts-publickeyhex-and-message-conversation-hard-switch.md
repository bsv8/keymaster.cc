# 002 通讯录 `publicKeyHex` canonical 化与 `/messages` 会话化硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/contacts.ts`
- `packages/contracts/src/appmsg.ts`
- `packages/plugin-contacts/src/contactsService.ts`
- `packages/plugin-contacts/src/contactsDb.ts`
- `packages/plugin-contacts/src/ContactsPage.tsx`
- `packages/plugin-contacts/src/ContactDetailPage.tsx`
- `packages/plugin-contacts/src/ContactPicker.tsx`
- `packages/plugin-contacts/src/RecentContactsWidget.tsx`
- `packages/plugin-contacts/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `packages/plugin-message/src/MessagePage.test.tsx`
- `packages/plugin-message/src/MessageDetailPage.test.tsx`
- `packages/plugin-message/src/styles.css`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`
- `packages/plugin-p2pkh/src/p2pkhSigner.ts`
- `apps/web/src/shell/RouteRenderer.tsx`
- `packages/runtime/src/navigate.ts`

发生冲突时，按以下优先级：

1. 本单关于“通讯录 canonical 身份 = `publicKeyHex`”“`/messages` 首页 = 会话列表”“联系人编辑能力归 `plugin-contacts`”的定义优先。
2. 旧代码与旧文档里凡是把联系人 canonical 字段定义为 `address`、把 `/messages/:messageId` 当作主流程、把消息页联系人弹框实现为 message 私有表单的做法，本次全部失效。
3. 本次是硬切换，不保留双 schema，不保留 address/publicKeyHex 双写，不保留旧联系人数据迁移，不保留分阶段实施尾巴。

---

## 1. 文档定位

这不是一次“消息页改个列表形式”或“通讯录多加个字段”的小修，而是一次**身份通讯录模型重建 + 消息页组织方式改写**的硬切换。

当前系统里有 3 个根问题已经碰到一起：

- 联系人 canonical 字段是 `address`，这对消息、公钥身份、后续 WebRTC 都不成立
- `/messages` 仍按单条消息组织，不符合“像手机短信一样按会话看”的产品模型
- 联系人编辑逻辑只存在于 contacts 页面里，message 侧一旦需要原地编辑，最容易复制出第二套表单

如果不一次性收口，后面只会继续出现：

- `contacts` 同时维护 `address` 和 `publicKeyHex` 两套真值
- `message` 为了原地编辑再复制一套联系人表单
- `p2pkh`、`webrtc`、`message` 各自定义自己的“联系人身份”

所以这次必须直接统一成：

- 通讯录只存身份 `publicKeyHex`
- 地址、链上投影、协议投影都由消费方自己现算
- 联系人编辑器能力归 `plugin-contacts`
- `/messages` 首页改成按对端 `publicKeyHex` 聚合的会话列表

---

## 2. 简述缘由

### 2.1 `publicKeyHex` 才是系统级身份，`address` 只是某类投影

`publicKeyHex` 可以派生很多 use-site 语义：

- `message` 用它当对端身份
- `webrtc` 未来用它当对端身份
- `p2pkh` 可以从它派生链上地址

反过来 `address` 无法恢复 `publicKeyHex`。所以 `address` 不能再当通讯录 canonical 字段。

### 2.2 联系人归属应该由 key-scoped DB 体现，不应再行内存一份 owner 字段

你明确不喜欢行内再放 `ownerPublicKeyHex`。这个判断是对的。

当前 `plugin-contacts` 已经是按 active key 打开 key-scoped DB。也就是说，“联系人属于哪把 key”这个事实应该由：

- DB namespace
- keyspace 的存储隔离

来表达，而不是每一行联系人再存一个重复 owner 字段。

这对“删除账号时顺手清掉联系人”也更直接，因为删除的是整库，不是扫表删行。

### 2.3 `/messages` 的主模型是“和谁聊”，不是“哪条消息”

用户进入消息首页，应该先看到：

- 我最近和谁聊过
- 最近一条是什么
- 最近什么时候

而不是先看到一堆 message row 再点进去单条详情。

所以 `/messages` 首页必须改成会话列表，按对端 `publicKeyHex` 聚合并按最新消息时间排序。

### 2.4 联系人编辑器必须归 `plugin-contacts`

联系人表单、校验、重复检查、保存逻辑都属于 contacts 域。

如果 message 为了“原地弹框新增联系人”自己复制一套表单，短期看能用，长期必然出现：

- contacts 页面一套字段
- message 页面一套字段
- 两边文案、校验、保存逻辑漂移

正确做法是：

- `plugin-contacts` 抽出 `contacts.editor` 能力
- `message` 只负责打开
- 真正的表单、保存、错误处理仍归 contacts

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `Contact` canonical 字段从 `address` 切为 `publicKeyHex`。
2. 旧 `Contact.publicKeyHex` “归属字段”语义彻底删除，不再保留同名旧含义。
3. 联系人归属只由 key-scoped DB 表达，不再在联系人行内存 owner 字段。
4. `ContactsService` 不再暴露 `findByAddress`，改为 `findByPublicKeyHex` / `findByPublicKeyHexes`。
5. `plugin-contacts` 的新增、编辑、列表、详情、picker、recent widget 全部显示 `publicKeyHex` 视角。
6. `plugin-contacts` 对外新增 `contacts.editor` 能力，供其它插件原地打开联系人编辑器。
7. `/messages` 首页改成会话列表；会话主键 = 对端 `publicKeyHex`。
8. `/messages` 首页会话按最新聊天时间倒序。
9. 会话标题优先显示通讯录 name；没有联系人则显示短写 `前四个...后四个`。
10. `/messages/:publicKeyHex` 改成会话详情页，不再以 `messageId` 作为主详情路由。
11. 陌生会话在 `/messages` 首页可直接弹框“新增联系人”，新增成功后会话名立即切换为联系人 name。
12. 已有联系人在 `/messages` 首页可直接进入“对应联系人专项编辑”。
13. `p2pkh` 不再把 contacts 当地址簿，而是拿 `publicKeyHex` 后自行做 `publicKeyHex -> address` 投影。
14. 本次不做旧联系人 `address -> publicKeyHex` 迁移；旧数据直接废弃。

---

## 4. 单真值与边界定义

### 4.1 通讯录单真值

通讯录唯一 canonical 身份字段：

```txt
publicKeyHex
```

它表示“这个联系人是谁”。

下面这些都不是通讯录真值字段：

- `address`
- `p2pkh address`
- `webrtc peer id`
- `message conversation id`

这些都只能是各业务插件基于 `publicKeyHex` 派生出来的 use-site 投影。

### 4.2 联系人归属边界

联系人“属于哪把本地 key”不再通过联系人行内字段表达，而是通过：

- `keyspace.openKeyStorage({ publicKeyHex, pluginId, storageId })`
- key-scoped DB namespace

表达。

因此本次最终模型里：

- 不保留 `ownerPublicKeyHex` 行内字段
- 不再给联系人 store 建 owner 索引
- 删除 key 时，联系人跟随该 key 的 storage 一起删除

### 4.3 联系人编辑器边界

`contacts.editor` 是 `plugin-contacts` 提供的 UI 能力。

它负责：

- 新建联系人表单
- 编辑联系人表单
- 字段校验
- 重复联系人提示
- 保存成功回调

它不负责：

- 决定从哪个业务页打开
- 决定保存后调用方页面如何刷新列表

调用方（如 `plugin-message`）只负责：

- 打开/关闭状态
- 传入要编辑的 `publicKeyHex` 或已有 `contactId`
- 在 `onSaved` 后重新拉自己需要的数据

### 4.4 消息页边界

`plugin-message` 的会话模型只围绕：

- 当前 active owner
- 对端 `publicKeyHex`
- 本地 scoped message 列表

它不负责：

- 联系人表单实现
- 地址派生逻辑
- 联系人持久化细节

---

## 5. 必须怎么做

### 5.1 `Contact` 契约改成身份通讯录

`packages/contracts/src/contacts.ts` 必须重写成以下语义：

- `Contact.publicKeyHex` = 联系人身份公钥 hex
- 删除 `address`
- 删除旧“归属 publicKeyHex”语义字段
- `ContactInput` 改为：
  - `publicKeyHex`
  - `name`
  - `note?`
  - `tags?`

`ContactsService` 至少改为：

- `addContact(input)`
- `updateContact(id, input)`
- `removeContact(id)`
- `listContacts()`
- `findByPublicKeyHex(publicKeyHex)`
- `findByPublicKeyHexes(publicKeyHexes)`
- `onChange(handler)`

### 5.2 `plugin-contacts` DB schema 一次性硬切

`packages/plugin-contacts/src/contactsDb.ts` / `contactsService.ts` 必须一次性切到新 schema：

- store 主体行只存联系人自身字段
- 唯一索引改为 `publicKeyHex`
- 删除 `address` 索引
- 删除旧 `publicKeyHex` 展示字段/归属字段索引

本次不做旧数据迁移，原因必须在代码注释里写清楚：

- 旧联系人 canonical 字段是 `address`
- 无法从 `address` 可靠恢复 `publicKeyHex`
- 任何“猜测式迁移”都会制造脏身份数据

因此允许的做法是：

- 直接 bump DB version，upgrade 时重建 `contacts` store
- 或直接切新的 storage/schema 并视旧库为废弃

但最终结果必须保证：

- 运行后读取到的联系人全是新 schema
- 系统里不再有“新旧双读”的兼容逻辑

### 5.3 `plugin-contacts` UI 全部按 `publicKeyHex` 工作

以下 UI 必须改：

- `ContactsPage.tsx`
- `ContactDetailPage.tsx`
- `ContactPicker.tsx`
- `RecentContactsWidget.tsx`
- `manifest.ts` 内 i18n 文案

要求：

- 表单输入项从“地址”改为“联系人 publicKeyHex”
- 列表展示完整 `publicKeyHex` 或短写 `publicKeyHex`
- 详情页描述字段不再显示 address
- picker 的 value 改为 `publicKeyHex`
- recent widget 显示 `name + 短写 publicKeyHex`

### 5.4 `plugin-contacts` 新增 `contacts.editor` 能力

`packages/plugin-contacts/src/manifest.ts` 必须新增 capability，例如：

```txt
contacts.editor
```

这个 capability 应提供一个 React 组件型能力，而不是全局命令式弹框服务。

推荐形状：

- props:
  - `open`
  - `mode: "create" | "edit"`
  - `publicKeyHex?`
  - `contactId?`
  - `onClose`
  - `onSaved`

设计要求：

- “新增陌生联系人”时允许预填 `publicKeyHex`
- “编辑联系人”时按 `contactId` 载入现有数据
- 保存逻辑复用 `contacts.service`
- 不允许 `plugin-message` 自己复制联系人表单

### 5.5 `/messages` 首页改成会话列表

`packages/plugin-message/src/MessagePage.tsx` 必须重写主模型：

- 不再直接渲染 message row 列表
- 不再把 `/messages/:messageId` 当主入口
- 首页从 scoped message 列表中聚合出 conversation list

会话聚合规则：

1. 先拿当前 active owner `publicKeyHex`
2. 遍历 scoped messages
3. 对每条消息判断对端：
   - 如果 `senderPublicKeyHex === owner`，则对端 = `recipientPublicKeyHex`
   - 否则对端 = `senderPublicKeyHex`
4. 用对端 `publicKeyHex` 作为 conversation key 聚合
5. 每个会话保留：
   - `peerPublicKeyHex`
   - `latestMessage`
   - `latestInsertedAtMs`
   - `messageCount`

排序规则：

- 用 `latestInsertedAtMs` 倒序

### 5.6 `/messages` 首页接入通讯录名称解析

`plugin-message` 必须消费 `contacts.service` 做名称回填。

要求：

- 优先用 `findByPublicKeyHexes()` 一次性批量解析
- 有联系人则显示 `name`
- 无联系人则显示 `shortHex(publicKeyHex)`

UI 行为：

- 陌生联系人显示“添加联系人”
- 已有联系人显示“编辑联系人”

### 5.7 `/messages` 首页原地新增联系人

对于陌生会话：

- 点击“添加联系人”必须留在当前页
- 通过 `contacts.editor` 打开 modal
- 预填当前会话对端 `publicKeyHex`
- 保存后会话列表立即刷新 name

不允许的替代做法：

- 跳转 `/contacts`
- 在 message 内部另写一套联系人 modal

### 5.8 `/messages` 首页可进入联系人专项编辑

对于已有联系人：

- 必须提供直接进入对应联系人专项编辑的操作

允许的实现方式只有两种，二选一即可：

1. 仍通过 `contacts.editor` modal 直接 edit
2. 跳到 contacts 页面专项编辑入口

若选择第 2 种，必须把 contacts 页面专项编辑入口正式化，例如：

- `/contacts?edit=<contactId>`
- 或 `/contacts/:id?mode=edit`

但不允许依赖隐式页面内部状态或手工控制台操作。

### 5.9 `/messages/:publicKeyHex` 改成会话详情

`packages/plugin-message/src/MessageDetailPage.tsx` 与 `manifest.ts` 必须改为：

- 详情路由参数 = `publicKeyHex`
- 页面显示和该对端的所有会话记录
- 页面头部显示：
  - 联系人名或短写公钥
  - 完整 `publicKeyHex`

会话详情里的消息排序建议：

- 按 `insertedAtMs` 正序

发送入口建议收口到会话详情页，而不是继续留在首页。

### 5.10 `plugin-message` 必须接入 keyspace，但只用于识别 owner

`plugin-message` 当前只依赖自己的 `message.service`。

本次为了正确做会话聚合，允许它新增依赖：

- `keyspace.service`

用途只能是：

- 读取当前 active owner `publicKeyHex`
- active key 变化时刷新 conversation list / conversation detail

不允许借此把 provider、vault、地址派生等其它复杂度拖进 message。

### 5.11 `p2pkh` 改为从联系人公钥自行派生地址

`packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx` 必须停止把联系人当地址簿使用。

新的责任边界：

- contacts picker 提供 `publicKeyHex`
- `p2pkh` 在自己域内把 `publicKeyHex -> address`

派生逻辑必须复用/下沉到 `plugin-p2pkh` 自己的地址派生工具，不允许反向把地址派生逻辑塞进 contacts。

若 picker 仍要显示给用户看的文本，可显示：

- `name`
- 短写 `publicKeyHex`

### 5.12 样式与文案要跟着模型一起改

`packages/plugin-message/src/styles.css` 与 `plugin-contacts` 相关文案必须同步改：

- 消息首页视觉上以会话列表为主，而不是调试列表
- 会话项要有标题、预览、时间、联系人操作位
- 联系人相关文案统一用 `publicKeyHex`
- 不再出现“地址已存在”“输入地址”等旧词

---

## 6. 不能怎么做

### 6.1 不能保留 `address` 和 `publicKeyHex` 双 canonical

禁止出现：

- 联系人行里同时存 `address` 和 `publicKeyHex`，并宣称“以后再慢慢迁”
- service 同时支持 `findByAddress` 和 `findByPublicKeyHex`
- UI 同时接受“地址或公钥都行”

这样只会把歧义永久化。

### 6.2 不能做猜测式数据迁移

禁止：

- 根据旧 address 猜对应公钥
- 通过任何远端服务补公钥
- 留一个“迁移失败先用 address 占位”的灰状态

原因很简单：联系人 identity 一旦脏了，后面 message / webrtc / p2pkh 都会跟着脏。

### 6.3 不能在联系人行内重复存 owner 归属字段

本次禁止把你明确否掉的方案再变相塞回来，例如：

- `ownerPublicKeyHex`
- `contactOwnerPublicKeyHex`
- `namespacePublicKeyHex`

联系人归属只能由 key-scoped DB 表达。

### 6.4 不能让 message 自己实现联系人编辑表单

禁止：

- `plugin-message` 自己复制 contacts modal
- `plugin-message` 自己做重复联系人校验
- `plugin-message` 直接拼 contacts DB 细节

联系人编辑逻辑必须留在 `plugin-contacts`。

### 6.5 不能继续把 `/messages/:messageId` 当主详情模型

单条消息 detail 可以作为内部调试能力存在，也可以直接删掉，但它不能再是用户消息主路径。

用户主路径必须是：

- `/messages`
- `/messages/:publicKeyHex`

### 6.6 不能把 `publicKeyHex -> address` 派生逻辑塞回 contacts

通讯录是身份簿，不是投影工厂。

禁止：

- contacts service 直接返回 p2pkh address
- contacts row 再加链上 address cache 字段
- contacts contract 里长出网络相关参数

这些都属于 use-site 责任。

---

## 7. 特殊情况与处理原则

### 7.1 没有 active key

处理原则：

- contacts 页面显示“请选择一个 key”
- recent widget / picker 返回空态
- `/messages` 会话列表不做聚合，显示无 active key 或空态

不能怎么做：

- 退回“all 模式”
- 混看所有 key 的联系人或消息

### 7.2 `contacts.service` 不可用

`plugin-message` 必须容错：

- 会话列表仍可按短写公钥显示
- “添加联系人/编辑联系人”操作可降级隐藏

不能因为 contacts capability 缺失把消息页整页打挂。

### 7.3 联系人重复

重复判断以当前 key-scoped DB 内的 `publicKeyHex` 唯一为准。

处理方式：

- `addContact` 命中重复时抛重复错误
- `contacts.editor` 负责展示错误
- `message` 不自己解释重复细节

### 7.4 active key 在 modal 打开期间切换

处理原则：

- `contacts.editor` 监听 keyspace active 变化
- 若 active key 变化，当前 modal 关闭或清空并提示重开

不能继续在旧 key 的上下文里把联系人写到新 key 的 DB。

### 7.5 会话内消息很多

当前系统保持简单优先。

允许的最小实现：

- 先用 `listMessages({ limit: N })` 拿最近若干条做聚合
- 会话详情可先展示当前可见窗口内消息

若要补“拉全历史”，必须用现有 `afterMessageId` 分页能力顺序拉，不要为了“全量可靠”先引入新的缓存层或后台协调器。

### 7.6 旧联系人数据如何处理

处理原则：

- 旧 address 通讯录直接废弃
- 代码与文档里写清这是有意硬切，不是遗漏

不能怎么做：

- 留“临时读取旧地址簿”的分支
- 页面静默混出新旧联系人

---

## 8. 文件级实施清单

以下为实现时必须覆盖的文件级改动点。

### 8.1 contracts

`packages/contracts/src/contacts.ts`

- `Contact` 从 address 模型改成 `publicKeyHex` 模型
- 删除行内 owner 归属字段方案
- `ContactInput` 改成以 `publicKeyHex` 为输入
- `ContactsService` 改为 `findByPublicKeyHex` / `findByPublicKeyHexes`
- 若需要新增 editor capability 对应类型，也在 contracts 中定义

### 8.2 contacts 数据层

`packages/plugin-contacts/src/contactsDb.ts`

- bump schema
- `publicKeyHex` 设为唯一索引
- 删除 `address` 相关索引与读写逻辑
- 删除旧展示性 `publicKeyHex`/owner 语义注释
- 明确写明旧地址簿数据废弃的设计缘由

`packages/plugin-contacts/src/contactsService.ts`

- 输入校验改为 `publicKeyHex`
- 重复错误改为基于 `publicKeyHex`
- `findByAddress` 改为 `findByPublicKeyHex`
- 新增批量 `findByPublicKeyHexes`

### 8.3 contacts UI 与能力导出

`packages/plugin-contacts/src/ContactsPage.tsx`

- 表格列与表单改成 `publicKeyHex`
- 文案全改
- 若支持专项编辑 query/path，也在这里正式接入

`packages/plugin-contacts/src/ContactDetailPage.tsx`

- 详情描述改成显示 `publicKeyHex`

`packages/plugin-contacts/src/ContactPicker.tsx`

- `value` / `onChange` 改成 `publicKeyHex`
- option 文案改成 `name + 短写公钥`

`packages/plugin-contacts/src/RecentContactsWidget.tsx`

- 展示 `name + 短写公钥`

`packages/plugin-contacts/src/manifest.ts`

- 新增 `contacts.editor` capability
- 更新所有 i18n 文案
- 如采用专项编辑深链，这里要保证路由语义明确

建议新增文件：

- `packages/plugin-contacts/src/ContactEditorModal.tsx`
- 或等价命名的 editor 组件文件

### 8.4 message 业务页

`packages/plugin-message/src/messageService.ts`

- service 本身通常不需要懂会话，只要保留 list/get/send/subscribe
- 如需要辅助方法，可保持最小接口，不要把 contacts 逻辑塞进 service

`packages/plugin-message/src/MessagePage.tsx`

- 从“单条消息列表”重写为“会话列表页”
- 接入 `keyspace.service`
- 接入 `contacts.service`
- 接入 `contacts.editor`
- 陌生人添加联系人用 modal
- 已有联系人支持专项编辑入口

`packages/plugin-message/src/MessageDetailPage.tsx`

- 改成“会话详情页”
- 路由参数由 `messageId` 改为 `publicKeyHex`
- 会话内展示消息流

`packages/plugin-message/src/manifest.ts`

- 路由从 `/messages/:messageId` 改成 `/messages/:publicKeyHex`
- breadcrumb 文案与解析逻辑跟着改
- 如 message 新增依赖 `keyspace.service` / `contacts.service`，在 manifest 里声明

`packages/plugin-message/src/styles.css`

- 重写成会话列表/会话详情样式
- 去掉“调试式消息列表”视觉假设

### 8.5 p2pkh 消费方

`packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`

- 联系人 picker value 改为 `publicKeyHex`
- 选中联系人后不再直接写 `recipient = c.address`
- 改为在 widget/service 内派生地址

如有必要，补或复用：

- `packages/plugin-p2pkh/src/p2pkhSigner.ts`
- 或当前 p2pkh 域内等价地址派生 helper

要求：

- 地址派生责任留在 p2pkh
- contacts contract 不回流链上语义

### 8.6 测试

`packages/plugin-message/src/MessagePage.test.tsx`

- 改测会话列表，而不是 message row 列表
- 验证联系人名称回填
- 验证陌生会话的添加联系人入口

`packages/plugin-message/src/MessageDetailPage.test.tsx`

- 改测 `/messages/:publicKeyHex` 会话详情

如已有 contacts / p2pkh 测试覆盖旧 address 语义：

- 一并改成 `publicKeyHex` 模型

---

## 9. 最终验收清单

以下清单全部通过，才算本单完成。

### 9.1 通讯录模型验收

- `Contact` contract 中不再出现 canonical `address` 字段。
- contacts DB 新 schema 里联系人唯一键语义是 `publicKeyHex`。
- 联系人行内不再存 owner 归属字段。
- `findByAddress` 及其调用链已全部删除。

### 9.2 contacts UI 验收

- 联系人新增/编辑表单要求输入 `publicKeyHex`。
- 联系人列表、详情、picker、recent widget 不再以 address 为主显示。
- `contacts.editor` capability 可被外部插件打开。
- 保存成功 / 重复报错 / key 切换时关闭或重置行为明确可用。

### 9.3 messages 首页验收

- `/messages` 首屏看到的是会话列表，不是单条消息列表。
- 会话按最近聊天时间倒序。
- 通讯录里有 name 的会话显示 name。
- 没有 name 的会话显示短写 `publicKeyHex`。
- 陌生会话点“添加联系人”不离开当前页。
- 添加成功后会话标题立即刷新为联系人名。
- 已有联系人可进入专项编辑。

### 9.4 messages 详情验收

- `/messages/:publicKeyHex` 能进入对应会话详情。
- 详情页展示与该对端的消息流，而不是单条 message 元数据页。
- 页头可看到联系人名或短写公钥，以及完整 `publicKeyHex`。

### 9.5 p2pkh 验收

- p2pkh 联系人选择流拿到的是 `publicKeyHex`。
- 地址派生发生在 p2pkh 域内，而不是 contacts 域内。
- 旧的 `fillFromContact(c) => c.address` 路径已经删除。

### 9.6 硬切换纪律验收

- 系统中不再保留 address/publicKeyHex 双 canonical 兼容代码。
- 不再保留旧联系人地址簿迁移分支。
- 不再把 `/messages/:messageId` 作为用户主路径。
- 不再在 message 插件里复制联系人编辑表单。

---

## 10. 实施原则总结

这次改动的核心不是“把字段名从 address 改成 publicKeyHex”，而是把系统认知改对：

- 通讯录是身份簿，不是地址簿
- 联系人归属靠 key-scoped DB，不靠行内 owner 字段
- 联系人编辑器属于 contacts，不属于 message
- 消息首页按会话组织，不按单条消息组织
- 地址、链上资源、协议投影都由 use-site 自己现算

一旦实现里出现下面这些信号，就说明偏了，必须拉回：

- 还想保留 `findByAddress`
- 还想在联系人行里存 owner
- 还想让 message 自己写联系人表单
- 还想做旧地址簿迁移
- 还想让 contacts 直接返回 p2pkh address

这些都不是“先这样也能跑”的简化，而是把错误模型继续固化。
