# 003 联系人公钥操作钩子一次性硬切换施工单

## 目标

一次性把联系人页面从“仅管理联系人资料”切换为“联系人公钥的统一业务入口”。

联系人仍以 `publicKeyHex` 为唯一身份；任何业务模块只要能针对一个对端公钥
执行有意义的用户动作，就可以向 runtime 注册一个联系人公钥操作。联系人插件
读取操作注册表，在每个联系人后面渲染对应按钮。

本单首批且仅要求落地两个操作：

1. `transfer.to-contact`：转账模块注册“转账”，把目标公钥带入转账流程；
2. `message.to-contact`：消息模块注册“发消息”，打开该公钥对应的会话。

本次是**硬切换**。可以分多个 commit 完成，但不得合并、发布或验收任何只做了
一半的中间态：不能出现联系人页面写死两个跨插件按钮、转账只能半预填地址、
或者注册表已经存在却没有 owner 回收的状态。

### 本单修订：接收页必须是完整业务页（2026-07-21）

当前实施检查结论是：联系人只看到了“转账”，**消息钩子没有实际钩上**，因此
“消息”不能视为完成；联系人转账也不能只带用户进入某一个 P2PKH 地址表单。

自本修订起，两个按钮的完成定义如下：

1. “发消息”按钮必须实际出现、可点击，并进入能向该公钥发送第一条消息的会话页；
2. “转账”按钮必须进入**系统级、以目标公钥为中心的综合转账页**。该页聚合
   mainnet、testnet、其它资产与收藏品的转账能力；P2PKH 仅是其中一个贡献者；
3. 任何只完成 registry 类型、只注册动作、只有深链接、或只让 P2PKH widget
   接收参数的实现，均不构成完成。

## 缘由

当前联系人 canonical 身份已经是压缩 SEC1 `publicKeyHex`；消息页已经以对端
`publicKeyHex` 路由会话，P2PKH 转账也已经可以由联系人公钥派生收款地址。
因此联系人应当传递“对端公钥”这一稳定业务事实，而不应知道消息路由、转账
资产、地址格式、金额、矿工费或任一 Provider 的细节。

如果由 `plugin-contacts` 直接 import / 调用 `plugin-message`、`plugin-transfer`
或 `plugin-p2pkh`，每增加一种公钥能力都要修改联系人插件，并且插件禁用、依赖
顺序和卸载后的按钮残留都会变成跨域耦合。本单以 runtime 内建 registry 作为
唯一装配点：联系人只负责显示，动作所属模块只负责其业务与跳转。

## 硬切换结论

### 一、唯一公共契约

新增 capability：`contacts.public-key-action.registry`。

它由 `@keymaster/runtime` 在创建 `PluginHost` 时提供，是长期存在的内建
registry，不由 contacts / transfer / message 任一业务插件提供。接口放在
`@keymaster/contracts`，至少包含：

| 成员 | 最终语义 |
|---|---|
| `register(action)` | 注册一项联系人公钥操作；`id` 重复必须同步抛错。 |
| `unregister(id)` | 注销操作；不存在必须抛错，供 runtime owner 回收调用。 |
| `list()` | 返回稳定排序后的动作。排序为 `order` 升序、再以稳定 `id` 升序。 |
| `get(id)` | 返回动作或 `undefined`。 |
| `_ids()` | 仅供 runtime 拍 ownership 快照，不作为业务调用入口。 |

动作定义必须只有下列业务输入：

| 字段 | 规则 |
|---|---|
| `id` | 全局唯一、稳定的 `${pluginId}.${verb}`，首批固定为 `transfer.to-contact`、`message.to-contact`。 |
| `label` | `I18nText`，由动作 owner 提供翻译资源；不得让 contacts 翻译其它插件文案。 |
| `icon` | 可选的既有图标名；只是展示提示，不能成为业务分支依据。 |
| `order` | 数字；首批转账为 10、发消息为 20。 |
| `run(input)` | 可同步或异步；唯一业务入参为只读 `{ publicKeyHex }`。 |

V1 **不**定义异步 `isAvailable`、动作动态表单、动作返回 JSX、联系人资料透传、
权限模型或二级 action registry。按钮是否存在只由“动作是否注册”决定；具体
业务是否可完成由动作 owner 在点击后处理。

### 二、注册、卸载和 React 刷新

新 registry 必须接入现有 `PluginHost` 的 ownership snapshot / diff / recovery
链路，和 route、command、transfer provider 一样。

1. host 在创建时创建 registry，暴露 capability，并在 `PluginHost` 上保留强类型字段；
2. ownership snapshot 增加 `contactPublicKeyActions` id 集合；
3. 插件 setup 前后 diff 必须捕获新增 id；disable / unregister / setup 失败回滚时必须
   调用 `unregister(id)`；
4. plugin enable / disable 已会推进 host version；联系人页面用现有 `useRegistry`
   读取列表，随 host version 重渲染。不得为此再造轮询、全局 event bus 或第二份
   React state 真值；
5. registry 的 `list()` 永远按上述排序返回，页面不得自行按翻译后字符串排序。

### 三、联系人页面是唯一渲染 owner

`ContactsPage` 从该 registry 取得动作。每个联系人行的“操作”列最终顺序为：

`转账` → `发消息` → 动态新增动作（按 order） → `编辑` → `删除`

首批动作在桌面端必须是两个明确可点击按钮；小屏可以折叠进“更多”菜单，但
不得隐藏成不可发现的能力。动作按钮的 label/icon 使用动作自身定义，编辑和
删除仍由 contacts 自己拥有。

点击规则：

1. 调用 `action.run({ publicKeyHex: contact.publicKeyHex })`；
2. 当前行、当前 action 在 Promise 未结束前禁用，其他联系人及编辑/删除不受影响；
3. `run` 拒绝或抛错时保留联系人列表和编辑状态，显示当前行可见的本地化失败摘要；
   开发日志可保留原始错误；
4. 不在联系人侧预先检查余额、消息在线状态、资产 Provider、路由是否已注册，
   更不能在这里转换公钥为地址；
5. `ContactDetailPage` 页头复用同一 action 列表和执行逻辑，保证列表和详情的
   能力一致。不得复制第二套 registry 遍历和错误处理。

联系人未选择 active key 时，现有页面空态仍然生效，不渲染任一联系人或动作。

### 四、消息动作的最终行为

`plugin-message` 在 setup 时注册 `message.to-contact`，label 为“发消息”，图标
为消息语义图标，`order = 20`。执行动作只做：

`router.push("/message/" + encodeURIComponent(publicKeyHex))`

`/message/:publicKeyHex` 是唯一目标路由；不得跳转到 `/messages` 后再通过临时
state、localStorage、消息总线或组件 ref 注入对端。无历史会话不是错误：消息详情
页必须按现有语义显示空会话与发送输入区。联系人名称由消息页既有
`contacts.service` 回填，不能复制到 URL。

消息钩子要按“真实装配”验收，而非只检查源文件里存在一段 `register(...)`：

1. 现有代码中 `apps/web/src/pluginCatalog.ts` 已把 `messagePlatformPlugin` 放进
   catalog，`packages/plugin-message/src/manifest.ts` 也已有注册
   `message.to-contact` 的位置。因此联系人看不到按钮时，**不能再加第二个消息
   hook**；必须先在实际 host 记录 `state("message")`、其 startup error 和
   `host.contactPublicKeyActions.list()`。
2. `message` 未处于 `enabled` 时，按现有 manifest 依赖逐项修复
   `appmsg.endpoint.registry`、`keyspace.service`、`webrtc.service`、route / business /
   breadcrumb registry 或用户插件配置；修复的是实际 bootstrap / dependency failure，
   不是 contacts 的渲染代码。
3. `message` 已处于 `enabled` 但 list 中没有 `message.to-contact` 时，检查实际运行的
   manifest 与 setup rollback；若 list 中已有而按钮不显示，才检查
   `ContactPublicKeyActions` 对 registry / host version 的订阅。
4. 在 contacts、message 都 enabled 的实际 PluginHost 中，`list()` 必须包含
   `message.to-contact`，联系人行必须出现“发消息”；
5. 点击后 URL 必须是 `/message/<canonical publicKeyHex>`，消息详情页必须拿到同一
   peer key，输入并发送第一条消息时 `recipientPublicKeyHex` 必须完全相等；
6. 只有 message 被 disable / unregister 时，该按钮才消失。不能因“当前没有
   历史会话”“对端离线”或 contacts 刷新而消失；这些是进入会话后的业务状态。

### 五、转账动作与目标公钥上下文

`plugin-transfer` 在 setup 时注册 `transfer.to-contact`，label 为“转账”，
`order = 10`。执行动作只做安全的 client-side 跳转：

`/transfer?recipientPublicKeyHex=<encodeURIComponent(normalized publicKeyHex)>`

该 query 是**用户可见、可刷新、可手工编辑的预填目标**，不是授权、不是待签名
数据、不是自动提交指令。参数名固定为 `recipientPublicKeyHex`；不得同时保留
`recipient`、`to`、`contactId` 等旧/别名参数。

`plugin-transfer` 是该 query 的唯一解释 owner：

1. `TransferPage` 读取并校验它必须为 66 位、小写规范化的压缩 secp256k1 公钥
   hex（首字节只接受 `02` 或 `03`）；非法值显示“联系人转账目标无效”，不挂载
   Provider Widget，也不把非法字符串传给任何 Provider；
2. 有合法目标时，TransferPage 只展示声明支持“以公钥作为收款目标”的 Provider
   所属 Offer；无支持 Offer 时显示目标专属空态，保留短公钥，并提供“清除目标，
   浏览全部资产”按钮，清除后唯一跳到 `/transfer`；
3. `TransferProvider` 增加可选、同步的目标能力声明
   `supportsRecipientPublicKeyHex(publicKeyHex): boolean`。未声明或返回 `false`
   的 Provider 在带目标公钥的页面绝不能被选中；
4. `TransferWidgetProps` 增加只读可选 `recipientPublicKeyHex`。只有通过上项
   声明的 Provider 才收到该字段；普通 `/transfer` 入口一律为 `undefined`；
5. `plugin-p2pkh` 声明支持该公钥目标。其 Widget 首次收到该 prop 时，用现有
   `publicKeyHexToP2pkhAddress(publicKeyHex, network)` 填入当前网络的收款地址，
   然后仍走原有地址、金额、费率、预览、用户确认和提交链路；
6. 用户手工修改收款地址后，以用户输入为准。切换 offer、切换 active key、清除
   目标或离开转账页时，目标预填状态与 preview/result 一并按现有页面状态机清理；
7. 点击联系人“转账”绝不自动选择金额、绝不创建 preview、绝不签名、绝不广播，
   也不能绕过 Provider 的最终用户确认。

TransferPage 永远不派生 P2PKH 地址、不过问网络、UTXO、金额或矿工费；这些仍是
P2PKH Widget 的资产专属职责。

### 六、综合转账页是系统级页面（以现有 registry / 路由落地）

`/transfer?recipientPublicKeyHex=...` 的 owner 固定为 `plugin-transfer`，但它的
产品身份是**系统级综合转账页**，不是 P2PKH 的别名页面。页面先确认目标联系人
公钥，再汇总系统中所有“可向该公钥转移”的能力；它不拥有任一资产的交易细节。

页面必须有明确的目标头部，至少显示联系人名称（可取得时）与短公钥，并按以下
稳定分区展示贡献项：

| 分区 | 必须承接的能力 | 页面职责 |
|---|---|---|
| 主网 | Mainnet 资产（首批为 BSV P2PKH mainnet） | 展示可用 Offer，选择后把目标公钥交给对应 Widget；Widget 自行派生主网收款形式。 |
| 测试网 | Testnet 资产（首批为 BSV P2PKH testnet） | 与主网独立展示；不得复用或误填主网地址。 |
| 其它资产 | 所有其它已注册、声明支持该目标公钥的资产 Provider | 由 Provider 的 capability / Offer 贡献卡片，不由 transfer page 写资产白名单。 |
| 收藏品 | 当前 owner 的可转移收藏品及其转移入口 | 展示可转移对象；选中后进入收藏品转移流程，目标公钥必须原样继续传递。 |

现有代码已经给出了三个不能混用的事实来源，施工必须在其上扩展：

1. `transfer.registry` → `TransferProvider.listOffers()` 是 coin / fungible asset
   来源，现有 `/transfer` 已用其生成 `transfer.offers`；
2. `collectible.registry` → `CollectibleProvider.listCollectibles()` 是当前 owner 的
   收藏品来源，现有 `plugin-collectibles` 已以它生成 `collectibles.list` resource；
3. `collectible-transfer.registry` → `listSupporting({ providerId, collectibleId })` 是
   已选收藏品的 handler 选择来源，现有正式路由是
   `/collectibles/transfer?providerId=...&collectibleId=...`。

因此最终实现**不新增模糊的“收藏品发现 capability”或第二套总注册表**，而是：

1. 扩展 `TransferOffer`，增加由 Provider 声明的稳定分区字段
   `recipientTargetSection: "mainnet" | "testnet" | "other-assets"`。`TransferPage`
   只按此字段分组，不根据 `assetId`、Provider id 或标签猜网络；P2PKH provider 对
   现有 `bsv` Offer 声明 `mainnet`，对 `bsvtest` Offer 声明 `testnet`，其它 Provider
   自己声明 `other-assets`。
2. `plugin-transfer` 在自己的 setup 内、使用现有 `collectible.registry` 注册一个
   `transfer.recipient-collectibles` resource。其 load 对 `collectibles.list()` 的每个
   Provider 调用 `listCollectibles()`；每个 summary 再以既有
   `collectible-transfer.registry.listSupporting(ref)` 判断是否有 handler。
   不依赖或 deep import `plugin-collectibles` 的页面 / resource。
3. 扩展现有 `CollectibleTransferHandler` 的支持声明，新增同步
   `supportsRecipientPublicKeyHex(publicKeyHex): boolean`；综合页只显示同时满足
   `handler.supports(ref)` 与该新声明的藏品。未声明等同不支持联系人目标。
4. 扩展现有 `CollectibleTransferWidgetProps`，新增可选只读
   `recipientPublicKeyHex`。`CollectibleTransferPage` 继续从当前 query 读取
   `providerId`、`collectibleId`，并新增读取、规范化、校验同名 query；该目标存在时
   用“两项 supports 均为 true”筛 handler，并把它传给选中的 Widget。
5. 综合页的收藏品卡片跳转到**既有**正式路由：
   `/collectibles/transfer?providerId=<...>&collectibleId=<...>&recipientPublicKeyHex=<...>`。
   现有 `CollectibleDetailPage` 的普通“转移”入口不带这个 query，仍表示用户自行
   选择接收方；两条入口由 query 是否存在区分，不能互相覆盖。
6. 系统页只聚合、筛选、导航、显示空态和转发目标；地址派生、藏品 outpoint、
   原始交易、费用、签名、广播和最终确认仍归对应 Provider / handler。任一分区为空
   时，其他分区照常展示，并显示自身“未安装 / 不支持 / 无可转移对象”状态。

点击联系人“转账”后的默认视图是该综合页的资产选择态，**不得**自动选中 P2PKH、
不得自动打开 mainnet、不得自动跳到收藏品详情，也不得自动发起任何交易。

## 不能怎么做

1. 不能在 `ContactsPage` 直接 import `router` 后写死“转账 / 发消息”按钮，或
   import 任一 `plugin-*` 的组件、service、路由常量。
2. 不能让 contacts 提供这个 registry；contacts 被禁用时，其他模块的 registry
   能力不能消失，runtime 才是唯一 owner。
3. 不能让 message / transfer 通过 `contacts.service` 给联系人注入字段、保存
   “可转账”“可消息”等状态，联系人数据模型仍只保存联系人资料。
4. 不能把 `Contact`、`name`、`note`、`tags`、active key、余额、私钥、地址或
   UI component 作为 `run` 入参；跨域输入只有目标 `publicKeyHex`。
5. 不能用 URL query、localStorage、sessionStorage、IndexedDB、MessageBus 或
   React 全局 state 保存“待执行动作”。唯一持久的 URL 信息是转账的非敏感预填
   `recipientPublicKeyHex`，且它绝不代表已授权。
6. 不能把消息动作做成直接调用消息 service 发送空消息，或以“联系人存在”推断
   对方在线。
7. 不能让转账模块把公钥先变成地址再传给 TransferPage；平台只携带公钥，具体
   Provider 自己决定是否接受及如何转换。
8. 不能向所有 Transfer Widget 无差别注入该公钥，也不能让不支持的 Widget 静默
   忽略它；必须由 `supportsRecipientPublicKeyHex` 显式筛选。
9. 不能为了兼容保留旧 `/transfer?recipient=`、`/transfer?to=` 或通过
   `history.state` 传目标的第二条路径。本单合入后只有一个 query 契约。
10. 不能把动态 action 的 label 在 setup 中调用 `t()` 固化为字符串；必须注册
    `I18nText`，保证切换语言后按钮实时更新。
11. 不能漏接 owner snapshot 回收；插件禁用后仍显示、仍可点击的动作属于严重错误。
12. 不在本次引入动作权限审批、批量联系人动作、右键菜单、后台自动执行、异步
    可用性探测或新的“联系人扩展市场”。这些均不属于当前闭环。
13. 不能把综合转账页做成“只有 mainnet / testnet 两个硬编码按钮”的 P2PKH
    子页面；其它资产与收藏品必须通过 registry / 正式 capability 接入。
14. 不能把收藏品选择后丢掉 `recipientPublicKeyHex`，再要求用户第二次输入地址或
    公钥；从联系人到收藏品 handler 的目标必须保持同一值。
15. 不能因消息当前无会话而不注册 `message.to-contact`，也不能用仅在测试里注册
    action 的替身冒充实际应用已接通。

## 特殊情况提前约定

### 1. 消息或转账插件被禁用、卸载，或 setup 失败

runtime 回收动作 registration 后，联系人页下次 host version 刷新必须立即不再
显示该按钮。已开始但尚未完成的 `run` 若随后失败，只显示失败，不恢复已卸载
的 action，也不尝试重新 enable 插件。

### 2. 两个模块错误地使用同一 action id

`register` 立即抛错，触发当前插件 setup 失败并按既有 lifecycle 回滚。不得
“后注册覆盖前注册”，更不能按 plugin 加载顺序随机选一个。

### 3. 联系人公钥异常或数据被旧存储污染

正常联系人创建/编辑已校验公钥；渲染动态 action 前仍应进行轻量的压缩公钥格式
防御校验。无效记录显示既有联系人资料和编辑/删除，但不渲染公钥业务动作，且
开发日志记录诊断。不能尝试猜测 address、修正为另一把 key，或把错误值带到 URL。

### 4. 用户从联系人转账后刷新、后退、前进或手工改 URL

query 是当前页面唯一真值：刷新后仍按同一合法公钥预填；浏览器前进/后退按 URL
重新计算；手改为无效值则进入无效目标错误态；删掉 query 即回普通转账入口。
不得另设隐藏 state 与 URL 竞争。

### 5. 没有支持目标公钥的资产 Provider

保留在 `/transfer?recipientPublicKeyHex=...`，显示“当前没有可向该联系人公钥
转账的资产”及清除目标按钮。不能偷偷落到普通资产列表、不能自动使用一个地址
输入为空的 Provider，更不能把公钥当地址提交。

### 6. P2PKH Provider / active key /网络在转账过程中变化

沿用现有 TransferPage 和 P2PKH Widget 的 key 切换清理语义：清空 preview、结果
与 busy 状态；P2PKH Widget 按当前 offer 网络重新计算预填地址。若 Provider 消失，
平台显示 provider-gone 错误；不得复用旧 Widget 内存里的地址或 preview。

### 7. 同一联系人重复点击或动作运行失败

同一行同一 action pending 期间禁用，避免双跳转/双提交。`run` 失败仅影响该
action；联系人不能被删除、修改或从列表移除。跳转成功后由目标页面承担后续异常。

### 8. 无 active key

contacts 既有空态和壳层 guard 是第一道入口；message/transfer 仍必须保留自身
无 active key 防御，不能因为联系人按钮存在过就默认安全。不得在 action 内偷偷
切换 key 或请求解锁。

## 文件级一次性迭代施工单

### A. 公共 contracts

1. 修改 `packages/contracts/src/contacts.ts`
   - 在联系人域增加 `CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY` 常量；
   - 增加 `ContactPublicKeyActionInput`、`ContactPublicKeyAction`、
     `ContactPublicKeyActionRegistry` 契约；label 使用 `I18nText`；
   - 保持 `Contact` / `ContactInput` / `ContactsService` 数据字段不变，绝不迁移 DB。

2. 修改 `packages/contracts/src/index.ts`
   - 确保上述联系人动作公共类型与 capability 常量从 contracts 根出口导出。

3. 修改 `packages/contracts/src/transfer.ts`
   - 给 `TransferWidgetProps` 增加只读可选 `recipientPublicKeyHex`；
   - 给 `TransferProvider` 增加可选同步
     `supportsRecipientPublicKeyHex(publicKeyHex): boolean`；
   - 不新增 P2PKH 地址、金额、网络或任何 coin 专属字段。

4. 修改 `packages/contracts/src/registries.ts`（如该文件是 registry 类型汇总出口）
   - 从 contacts 契约重导出/引用该 registry 类型，确保依赖方只从 contracts
     获得类型；不能在 plugin 之间 deep import。

### B. Runtime registry 与生命周期

5. 新增 `packages/runtime/src/registries/contactPublicKeyActionRegistry.ts`
   - 使用 `Map<id, action>` 实现 register / unregister / get / sorted list / `_ids()`；
   - 重复 id、注销不存在 id 均抛可诊断错误；排序按 `order`、`id`；
   - 只存动作定义，不持有联系人、URL、React 状态或任何业务数据。

6. 修改 `packages/runtime/src/createPluginHost.ts`
   - 创建 registry，放进 `PluginHost` 字段，作为
     `contacts.public-key-action.registry` capability 提供；
   - 扩展 registry snapshot、ownership 类型、diff、回收函数和 setup 失败回滚，
     使 action id 与其它 registry 一样被 owner 精确回收；
   - 不以插件 id 作为 runtime 硬编码分支；runtime 不知道“转账”“消息”。

7. 修改 `packages/runtime/src/pluginOwnership.ts`
   - `PluginOwnership` 与 `emptyOwnership()` 增加 `contactPublicKeyActions`。

8. 新增 `packages/runtime/src/registries/contactPublicKeyActionRegistry.test.ts`
   - 覆盖重复注册、稳定排序、get、注销、注销不存在 id。

9. 修改 `packages/runtime/src/createPluginHost.test.ts`，必要时修改现有 lifecycle 测试
   - 覆盖 setup 注册 action 后的 ownership 捕获；disable / unregister / setup
     抛错回滚后 action 不存在；其它插件动作不受影响。

### C. 联系人显示层

10. 修改 `packages/plugin-contacts/src/manifest.ts`
    - 把新 capability 列为必需 dependency；contacts 不提供它；
    - 增加动态按钮、错误、无效公钥的 i18n key；不得加入“转账”“消息”所属
      业务文案的翻译 ownership。

11. 修改 `packages/plugin-contacts/src/ContactsPage.tsx`
    - 通过 `useRegistry` 或等价 host-version 响应方式取得 registry list；
    - 抽出可复用的联系人 action 渲染/执行单元，完成行级 pending、防御校验和错误显示；
    - 顺序严格遵循本单“动态动作在编辑/删除之前”的规定。

12. 修改 `packages/plugin-contacts/src/ContactDetailPage.tsx`
    - 复用第 11 项动作单元，在 `PageHeader` actions 展示同一批操作；
    - 不为详情页写第二套 registry 读取、按钮 pending 或错误逻辑。

13. 新增或修改 `packages/plugin-contacts/src/ContactsPage.test.tsx` 与
    `packages/plugin-contacts/src/ContactDetailPage.test.tsx`
    - 覆盖排序、两个首批按钮、无 action、action 失败、pending、无效公钥、
      action registry 更新后的显示变化、编辑/删除仍可用。

### D. 消息动作

14. 修改 `packages/plugin-message/src/manifest.ts`
    - 声明依赖新 registry，在 setup 注册 `message.to-contact`；
    - action 使用 runtime router 推到唯一 canonical `/message/:publicKeyHex`；
    - teardown/disable 不手写解绑，交由 runtime owner recovery。

15. 修改或新增 `packages/plugin-message/src/manifest.test.ts`
    - 用实际 `messagePlatformPlugin` 装配 action，断言 action id、I18nText、排序、
      正确 encode 的路由以及 enable / disable 回收；
    - 不能只 mock 一个自行注册 action 的假 plugin。

16. 修改 `packages/plugin-message/src/MessageDetailPage.test.tsx`，必要时新增
    联系人 → 消息集成测试
    - 覆盖无历史会话：点击联系人“发消息”后进入详情、输入第一条消息、发送服务
      收到完全相同的 `recipientPublicKeyHex`；
    - 覆盖 contacts / message 都 enabled 时按钮可见，message disable 后按钮消失。

### E. 转账目标公钥贯通

17. 修改 `packages/plugin-transfer/src/manifest.ts`
    - 声明依赖新 registry，在 setup 注册 `transfer.to-contact`；
    - 只构造固定的 `/transfer?recipientPublicKeyHex=` 深链接，不 import contacts 或
      P2PKH service。

18. 修改 `packages/plugin-transfer/src/TransferPage.tsx`
    - 将页面收口为系统级综合转账页：目标头部 + 主网 / 测试网 / 其它资产 /
      收藏品四个分区；合法时按 Provider 目标能力筛选 Offer，并把
      `recipientPublicKeyHex` 传给选中 Widget；
    - 解析、规范化、验证唯一 query；实现非法目标态、无兼容 Provider 态、清除
      目标按钮及 active key / offer 变化清理；普通入口不改变现有无目标转账流；
    - 使用现有完整 location/reactive navigation 机制，不能手读一次
      `window.location.search` 后失去前进/后退响应。

19. 修改 `packages/plugin-transfer/src/transferFeature.test.ts`、
    `packages/plugin-transfer/src/TransferPage.test.tsx`（不存在则新增）以及
    `packages/plugin-transfer/src/manifest.test.ts`（不存在则新增）
    - 覆盖 action 深链接、query 合法/非法、Provider 支持筛选、无匹配、清除目标、
      普通入口、Widget prop 传递与 URL 前进/后退。

20. 修改 `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx`
    - 消费可选 `recipientPublicKeyHex`，按 offer network 用既有 helper 预填地址；
    - 只在 prop 的有效首次变化时覆盖初始地址；用户编辑后不可被无关 render 覆盖；
    - 绝不改变 preview、签名、广播服务的安全边界。

21. 修改 `packages/plugin-p2pkh/src/manifest.ts` 或其 TransferProvider 创建位置
    - 声明 `supportsRecipientPublicKeyHex`，只接受有效压缩公钥；
    - 不在 p2pkh 中注册联系人 action，动作 owner 固定为 transfer 平台。

22. 新增或修改 `packages/plugin-p2pkh/src/widgets/P2pkhTransferWidget.test.tsx`
    - 覆盖 main/test network 派生、无 prop 的普通表单、用户改地址后不被覆盖、
      active key/offer 变化清理。

### F. 收藏品目标转账贯通

23. 修改 `packages/contracts/src/collectibleTransfer.ts`
    - 在现有 `CollectibleTransferHandler` 加
      `supportsRecipientPublicKeyHex(publicKeyHex): boolean`，在现有
      `CollectibleTransferWidgetProps` 加可选只读 `recipientPublicKeyHex`；不得把
      它塞进 `details` 或非类型化 query。

24. 修改 `packages/contracts/src/transfer.ts` 与所有 `TransferProvider` 实现
    - 在现有 `TransferOffer` 增加 `recipientTargetSection`；由 Provider 声明
      `mainnet` / `testnet` / `other-assets`，不得由 `/transfer` 猜测；
    - 保留已有 `supportsRecipientPublicKeyHex` 与 Widget prop，补齐所有测试替身。

25. 修改 `packages/plugin-transfer/src/manifest.ts` 与 `TransferPage.tsx`
    - 增加 `collectible.registry`、`collectible-transfer.registry` dependency，并在
      transfer plugin 自己注册 `transfer.recipient-collectibles` resource；
    - 用现有 `TransferOffer.recipientTargetSection` 渲染三类资产分区；用新 resource
      渲染收藏品分区。不能读取 `plugin-collectibles` 的内部 resource 或组件。

26. 修改 `packages/plugin-collectible-transfer/src/CollectibleTransferPage.tsx` 及 manifest
    - 扩展现有 query 解析和 handler 选择：有 `recipientPublicKeyHex` 时必须验证它，
      并同时满足 `listSupporting(ref)` 与 handler 的新目标支持声明；
    - 将目标 prop 传给既有 Widget。无目标时必须保持现有普通收藏品转移行为不变。

27. 修改具体收藏品 handler、`CollectibleTransferPage` 测试与新增
    `TransferPage` 综合转账测试
    - 以现有 `CollectibleProvider.listCollectibles` fixture 产生藏品，以现有
      `CollectibleTransferRegistry.listSupporting` fixture 产生 handler；覆盖联系人 →
      `/transfer` → 既有 `/collectibles/transfer` → handler 的公钥连续性。

### G. 边界与质量检查

28. 修改 `scripts/check-boundaries.mjs`（若当前规则不能覆盖）
    - 增加静态边界：`plugin-contacts` 不得 import `plugin-message`、
      `plugin-transfer`、`plugin-p2pkh`；
    - `plugin-transfer` 不得 import contacts 或 p2pkh；本单允许它依赖新 contracts
      capability 与 runtime 公共 router。

29. 修改相关 package 的类型测试/构建配置（仅在新增测试文件被现有 include 排除时）
    - 不引入 `any` 绕过新的 Transfer contract；所有 Provider 测试替身显式补齐或
      依赖 optional 字段。

## 最终验收清单

### 一、契约与 lifecycle

- [ ] contracts 根出口能获得唯一的 `contacts.public-key-action.registry` capability
  与全部动作类型。
- [ ] runtime 是此 capability 的唯一 provider；contacts/message/transfer 都不提供它。
- [ ] action id 重复会失败且不会覆盖已有 action。
- [ ] `list()` 顺序是 `order`、`id` 的稳定顺序，不依赖当前语言。
- [ ] 启用 message / transfer 后，分别出现各自 action；禁用、卸载或 setup 失败后，
  对应 action 被精确移除，其它 action 仍在。
- [ ] 不存在 owner snapshot 遗漏、内存残留或需要刷新页面才能消失的按钮。

### 二、联系人体验

- [ ] 每个合法联系人显示“转账”“发消息”“编辑”“删除”，且前两个先于编辑/删除。
- [ ] 无 action 时联系人页面正常显示编辑/删除，不显示空占位或禁用的业务按钮。
- [ ] 动态 action label 能随语言切换更新。
- [ ] 点击某一行 action 时只锁定该按钮；失败可见且不丢联系人、编辑状态或其它按钮。
- [ ] 无效 `publicKeyHex` 记录不展示业务动作，但仍可编辑/删除并有开发诊断。
- [ ] 联系人详情页和列表页的业务动作一致，且共享执行行为。

### 三、消息闭环

- [ ] contacts 与实际 `messagePlatformPlugin` 同时 enabled 时，每个合法联系人都显示
  “发消息”；不能只在 fixture 或源文件静态检查中存在。
- [ ] “发消息”使用 URL 编码后的 `/message/:publicKeyHex`。
- [ ] 已有会话正确打开；无会话时正确显示空会话并可发送第一条消息，发送入参的
  `recipientPublicKeyHex` 与联系人 canonical 公钥完全相等。
- [ ] 联系人动作不直接发送消息、不写临时目标状态、不依赖对方在线。
- [ ] disable / unregister message 后“发消息”立即消失；重新 enable 后恢复。

### 四、转账闭环

- [ ] “转账”只能产生 `/transfer?recipientPublicKeyHex=<canonical hex>`，没有其它
  query 别名或隐藏传参。
- [ ] 点击“转账”进入系统级综合转账页，而不是 P2PKH 专属表单；页面显示目标
  联系人 / 短公钥、主网、测试网、其它资产、收藏品四个分区。
- [ ] 合法目标仅显示支持公钥收款目标的 Offer，并将公钥 prop 传给对应 Widget。
- [ ] 非法 query 不触达 Widget，显示明确错误。
- [ ] 无兼容 Provider 时显示目标专属空态；“清除目标”回到唯一的 `/transfer`。
- [ ] 普通 `/transfer` 不传 `recipientPublicKeyHex`，原先转账选择与输入流程不退化。
- [ ] P2PKH main/test offer 能由目标公钥得到正确网络地址；用户手改地址后不会被重渲染覆盖。
- [ ] mainnet、testnet、其它资产和收藏品任一分区不可用时，其他分区仍保持可用且
  有自己的空态；页面没有 P2PKH 硬编码白名单。
- [ ] 从系统页进入收藏品转移后，目标公钥连续传到收藏品 handler；没有支持 handler
  时不得丢失目标进入普通收藏品转账。
- [ ] 从联系人进入转账不会自动填写金额、预览、签名、广播或绕过确认。
- [ ] 刷新、后退、前进、编辑或删除 query 后，页面只以当前 URL 作为目标真值。

### 五、边界、安全与回归

- [ ] contacts 不 import message、transfer、p2pkh 的内部代码；transfer 不 import
  contacts 或 p2pkh 的内部代码。
- [ ] action 入参没有联系人私有资料、地址、余额、active key 或任何私钥材料。
- [ ] `recipientPublicKeyHex` 未被当作授权或持久化 pending command；无 active key 时
  目标页面仍 fail closed。
- [ ] `pnpm typecheck`、受影响 package tests、runtime lifecycle tests、联系人、消息、
  转账与 P2PKH widget tests 全部通过。
- [ ] `pnpm lint:boundaries` 通过。

### 本次验收状态（2026-07-21）

- [x] 收藏品入口、`recipientPublicKeyHex` URL 路由与目标专属空态：综合转账页只在
  有合法联系人目标时显示收藏品分区；目标页会校验并规范化公钥、同时检查
  `supports(ref)` 和 `supportsRecipientPublicKeyHex()`，并把同一 canonical 值传给
  Widget。普通藏品转移流程保持不带目标。
- [ ] 收藏品真实转账：未验收，等待协议施工单明确 Ordinals/inscription 的 outpoint
  保护、脚本、找零、签名、广播和错误码后，由 `plugin-collectible-1satordinals`
  注册真实 `collectible-transfer.registry` handler。当前 1Sat Ordinals 仅提供发现，
  无 handler 时必须维持可解释空态；不得由 `plugin-transfer` 或普通 P2PKH Widget
  代替。

## 非目标

本单不改变 contacts DB schema，不迁移历史联系人，不增加 address 联系人兼容，不做
批量转账/群发消息，不添加动作权限审批或后台自动执行，也不改变 P2PKH 的签名、
UTXO、网络或确认协议。未来其它模块若要加入联系人操作，只能复用本单的唯一
registry 和只传 `publicKeyHex` 的契约。
