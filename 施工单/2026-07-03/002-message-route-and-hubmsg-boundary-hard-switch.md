# 002 `/messages` 归 `plugin-message`、HubMsg 管理面归 `plugin-appmsg` 的职责硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/plugin.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/MessagePage.test.tsx`
- `packages/plugin-message/src/messageService.test.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/messageFacade.ts`
- `packages/plugin-appmsg/src/styles.css`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`
- `施工单/2026-07-03/001-appmsg-local-truth-full-push-online-hard-switch.md`
- `施工单/2026-07-02/001-appmsg-system-log-and-system-diagnostics-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“`plugin-message` 只负责 `keymaster.message` 自己的消息业务”“`plugin-appmsg` 承担 HubMsg 管理展示能力”的定义优先。
2. 旧文档里凡是把 `keymaster.message` 同时当作“普通消息 app 身份”和“全库管理员身份”的描述，本次全部失效。
3. 包名 / capability 名本次不做大规模重命名；代码里的 `plugin-appmsg` 仍可保留，但产品语义、路由语义、页面语义按本单收口为 `HubMsg` 管理面。

---

## 1. 文档定位

这不是一次“页面小修”或“先挪一点 UI”的调整，而是一次**职责边界硬切换**。

本次要解决的不是某个按钮摆错位置，而是下面这个根问题：

- `keymaster.message` 既被当成一个普通消息应用在用，
- 又被当成一个能看全库、看连接、看同步、看错误的系统管理员身份在用。

这会把三层语义搅在一起：

1. **普通消息业务**
   - 看自己的消息
   - 搜自己的消息
   - 看单条消息
   - 给某个 `publicKeyHex` 发一条 `keymaster.message`

2. **消息总线平台能力**
   - HubMsg 连接
   - 本地消息库真值
   - 增量同步
   - 在线查询

3. **系统管理展示**
   - 所有 origin / appId 的消息查看
   - 全局统计
   - 连接状态
   - 报错信息
   - 同步状态

如果这三层不拆开，`/messages` 就会持续膨胀成一个“既是产品页、又是管理页、又是内核诊断页”的混合页，后面一定继续乱。

所以本次必须一刀切：

- `/messages` 只归 `plugin-message`
- HubMsg 管理面只归 `plugin-appmsg`
- 二者不再共享“同一个页面 + 两套语义”

---

## 2. 简述缘由

### 2.1 `/messages` 应该是用户消息页，不是总线管理页

用户进入 `/messages`，想看的应该是：

- `keymaster.message` 这条消息通道下的消息内容
- 搜索与阅读
- 给某个公钥发消息

用户不应该在这个页面被迫理解：

- 当前 HubMsg 是否已 bind
- 最近一次 sync 错误
- 哪些 origin 有多少消息
- 当前有哪些 targetKey

这些都是平台层与管理层概念，不是消息业务页概念。

### 2.2 HubMsg 管理展示必须看“全局”，而不是看 `keymaster.message` scope

HubMsg 管理页看的不是：

- “`keymaster.message` 这个 appId 自己有哪些消息”

而是：

- 当前 owner 下所有 origin / appId 的本地消息总览
- 这些消息的分组与统计
- 连接、同步、错误状态

这天然是 `plugin-appmsg` 的职责，不是 `plugin-message` 的职责。

### 2.3 不能再让 `keymaster.message` 走特权旁路

当前 `plugin-message` 通过 `createSystemMessageClient(...)` 拿全库读能力，这会导致：

- `keymaster.message` 不是一个正常 app 身份；
- runtime 的 `appMessageEndpoint` 注入能力没有真正用起来；
- `plugin-message` 和 `plugin-appmsg` 的边界继续糊掉。

更合理的结构是：

- `plugin-message` 声明 `appMessageEndpoint.endpointId = "keymaster.message"`
- runtime 像对待普通消息插件一样给它注入 scoped `appmsg.client`
- 它只能看、发、订阅 `keymaster.message` scope 内的消息

全库读、连接态、诊断态由 `plugin-appmsg` 自己的管理页直接消费 `appmsg.core`。

### 2.4 样式入口必须显式收口

你提醒得对，这里还有一个工程纪律问题：

- 页面迁移时最容易漏掉插件样式入口
- 一旦漏掉，功能改对了，视觉却是坏的

所以本次必须把样式要求钉死：

- `plugin-message` 新增自己的 `src/styles.css`
- `packages/plugin-message/package.json` 显式导出 `./styles.css`
- `apps/web/src/styles/plugins.css` 显式 `@import "@keymaster/plugin-message/styles.css";`

不能再靠“页面正好没写样式所以看起来没坏”这种偶然状态混过去。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `/messages` 固定归 `plugin-message`。
2. `/messages` 只展示 `keymaster.message` 自己的消息业务能力。
3. `plugin-message` 只看 scoped 本地消息，不再看全库。
4. `plugin-message` 支持：
   - 本地消息列表
   - 本地消息搜索
   - 单条消息查看
   - 给一个 `publicKeyHex` 发送 `keymaster.message` 文本消息
5. `plugin-message` 不再展示：
   - 连接状态
   - 在线状态查询
   - target sync 状态
   - 全局统计
   - 全局错误信息
6. HubMsg 管理页固定归 `plugin-appmsg`。
7. HubMsg 管理页路由固定为 `/system/hubmsg`。
8. 旧 `/system/messages` 路由彻底删除，不保留兼容别名。
9. HubMsg 管理页展示的是**当前 owner 的本地消息真值 + 当前连接态真值**，而不是远端数量真值。
10. HubMsg 管理页至少提供：
    - 所有 origin / appId 的本地消息查看
    - 按 origin / appId 的统计
    - 当前连接状态
    - 当前 owner
    - 最近错误
    - target sync 状态
    - 手动同步入口
    - 在线查询入口
11. `plugin-message` 通过 runtime 注入的 scoped `appmsg.client` 工作，不再通过 `createSystemMessageClient(...)` 走特权旁路。
12. `plugin-message` 与 `plugin-appmsg` 都有自己的样式入口，并在装配层显式引入。

---

## 4. 单真值与职责边界

### 4.1 `plugin-message` 的单真值边界

`plugin-message` 是一个**普通消息应用**，固定 appId：

```txt
keymaster.message
```

它的边界只到这里：

- 列出自己 scope 内的本地消息
- 查看自己 scope 内的单条消息
- 搜索自己 scope 内的消息正文
- 发送一条 `recipientAppId = keymaster.message` 的文本消息

它**不**负责：

- 看全库
- 看所有 origin
- 看连接状态
- 看同步状态
- 看系统错误
- 做在线诊断

### 4.2 `plugin-appmsg` 的单真值边界

`plugin-appmsg` 是**HubMsg 平台内核 + 管理展示 owner**。

本次虽然代码包名仍叫 `plugin-appmsg`，但页面与产品语义按 `HubMsg` 理解。

它负责：

- HubMsg 连接
- 本地消息库真值
- 增量同步
- 推送分发
- 在线查询
- HubMsg 管理页

它的管理页看的是真正的：

- 本地全库消息
- 本地分组统计
- 当前连接态
- 当前错误态
- 当前同步态

### 4.3 路由边界

本次固定：

- `/messages` = `plugin-message`
- `/messages/:messageId` = `plugin-message` 单条详情
- `/system/hubmsg` = `plugin-appmsg` 管理页

本次删除：

- `/system/messages`

原因很简单：

- `/messages` 是业务页
- `/system/hubmsg` 是系统管理页

路径语义必须和职责语义一致，不能继续把“系统管理页”伪装成“消息页”。

### 4.4 scoped client 边界

`plugin-message` 必须声明：

```txt
appMessageEndpoint.endpointId = keymaster.message
```

然后只消费 runtime 注入的 scoped `appmsg.client`。

这意味着：

- 它只能看到 `keymaster.message` 相关消息
- 它发送时 sender 身份就是 `keymaster.message`
- 它不需要也不允许直接拿全库特权

### 4.5 样式边界

本次固定：

- 每个有独立页面的插件都要有自己的 `src/styles.css`
- 每个插件包都要在 `package.json` 显式导出 `./styles.css`
- 装配层只在 `apps/web/src/styles/plugins.css` 统一引入插件样式

也就是说，样式真值是：

```txt
插件自己的 styles.css
  + apps/web/plugins.css 显式 @import
```

不是：

- 靠组件内联样式硬撑
- 靠 global.css 偷写业务样式
- 靠“当前页面刚好没写 CSS”蒙混过关

---

## 5. 必须怎么做

### 5.1 `plugin-message` 必须退回“普通消息应用”

`plugin-message` 必须改成下面这条最小路径：

1. manifest 声明 `appMessageEndpoint.endpointId = "keymaster.message"`
2. setup 阶段从 runtime 注入能力拿到 scoped `appmsg.client`
3. `message.service` 改为只封装本消息应用自己的业务动作
4. 页面只使用这些业务动作

`message.service` 最小职责固定为：

- `listMessages`
- `getMessage`
- `sendTextMessage`
- `subscribeMessages`

如果还需要搜索：

- 先取本地列表
- 再在 `plugin-message` 自己 UI 层做本地过滤

本次不为了搜索去扩张全局 contract。

### 5.2 `/messages` 页面必须收口

`/messages` 页面本次固定由三块组成：

1. 发送区
   - 输入 `publicKeyHex`
   - 输入文本正文
   - 发送到 `recipientAppId = "keymaster.message"`

2. 搜索区
   - 只按本地已同步消息正文做过滤

3. 列表区
   - 展示 `keymaster.message` scope 内消息
   - 点击进入单条详情

页面上不再允许出现：

- HubMsg 连接状态
- target sync 状态
- 在线查询按钮
- 全局错误信息
- 所有 origin 的统计

### 5.3 `plugin-message` 必须有单条详情能力

本次固定补上：

- `/messages/:messageId`

其职责只包含：

- 展示单条消息正文
- 展示发件方 / 收件方
- 展示创建时间 / 入库时间

详情页仍然只看 `keymaster.message` scope 内可见消息。

### 5.4 HubMsg 管理页必须回到 `plugin-appmsg`

`plugin-appmsg` 必须新增正式管理页：

- 路由：`/system/hubmsg`
- 菜单分组：`system`
- 菜单文案：`HubMsg`

该页至少包含四个区块：

1. 连接区
   - 当前连接状态
   - 当前 owner
   - HubMsg URL
   - 最近错误

2. 同步区
   - target sync 状态
   - 手动同步

3. 统计区
   - 按 origin / appId 分组统计
   - 消息总数

4. 全局消息浏览区
   - 当前 owner 下所有本地消息
   - 可按 origin / appId 过滤
   - 可按正文搜索

注意，这里的“查看”与“统计”都以**本地消息库**为准。

### 5.5 `createSystemMessageClient(...)` 必须退出主路径

本次固定：

- `plugin-message` 不再使用 `createSystemMessageClient(...)`
- `keymaster.message` 不再拥有“因为自己叫 `keymaster.message`，所以能看全库”的特权旁路

更进一步，推荐本次直接把以下结构从主设计中移除：

- `AppMsgCore.createSystemMessageClient(...)`
- `SystemMessageAppClient`
- 相关 contract 注释里“系统消息应用可全库读”的语义

`plugin-appmsg` 管理页如果要看全库，直接消费 `appmsg.core` 的平台管理能力即可。

这样边界最清楚：

- `message` 是业务 app
- `appmsg` 是平台内核 + 管理页

### 5.6 样式入口必须显式补齐

这次凡是新增 / 重做的插件页面，样式必须按下面的文件纪律落地：

1. `packages/plugin-message/src/styles.css`
2. `packages/plugin-message/package.json` 导出 `"./styles.css": "./src/styles.css"`
3. `apps/web/src/styles/plugins.css` 增加：

```css
@import "@keymaster/plugin-message/styles.css";
```

4. `plugin-appmsg` 的 HubMsg 管理页样式继续放在：

```txt
packages/plugin-appmsg/src/styles.css
```

本次不允许再出现“页面已迁移，但插件样式入口没接上”的漏项。

---

## 6. 不能怎么做

### 6.1 不能继续让 `/messages` 同时承担管理页语义

不允许在 `/messages` 里继续展示：

- 连接状态
- HubMsg 在线查询
- target sync 状态
- 所有 origin 的统计
- 最近系统错误

这些都必须离开 `/messages`。

### 6.2 不能保留双路由双语义

不允许同时保留：

- `/messages`
- `/system/messages`

分别又都叫“消息”。

这只会继续让用户和代码都分不清谁是业务页、谁是管理页。

### 6.3 不能让 `plugin-message` 继续拿全库特权

不允许：

- `plugin-message` 继续依赖 `appmsg.core` 直接读全库
- `plugin-message` 继续通过 `createSystemMessageClient(...)` 获得全库读
- 因为它的 appId 叫 `keymaster.message`，就默认它可以看所有 origin / appId 的消息

### 6.4 不能把 HubMsg 管理页做成远端统计页

HubMsg 管理页要看的是：

- 本地消息库真值
- 当前连接态
- 当前同步态

不允许把以下东西当页面主真值：

- HubMsg 远端历史数量
- HubMsg 远端 origin 汇总
- 只靠当前在线连接推导出来的会话视角

远端可以是辅助信息，但不是本页真值。

### 6.5 不能忘记插件样式入口

不允许：

- 新建了 `styles.css` 却没导出
- 导出了 `styles.css` 却没在 `apps/web/src/styles/plugins.css` 引入
- 把插件业务样式写回 `global.css`

这条不是“可选优化”，而是本次硬切换必做项。

### 6.6 不能顺手扩大消息协议范围

本次不做：

- 已读未读
- 删除消息
- 重发队列
- 草稿箱
- 在线订阅流
- 心跳保活
- 管理页分页协议扩张

这次只做职责归位，不顺手做产品膨胀。

---

## 7. 特殊情况提前约定

### 7.1 Vault 锁定或当前没有 active owner

处理方式固定如下：

- `/messages` 可以打开
- 列表显示空态或未就绪态
- 发送按钮禁用
- 不偷偷创建假 sender

HubMsg 管理页也可以打开，但：

- 连接状态显示未连接
- 手动同步禁用
- 只展示当前可得的静态状态，不强行补数据

### 7.2 active key 切换

处理方式固定如下：

- `plugin-message` 自动切到新 owner 下的 `keymaster.message` scope
- 旧 owner 的页面内容不再继续显示为当前真值
- HubMsg 管理页切到新 owner 的本地消息库与连接状态

不允许把上一把 key 的全局消息继续挂在当前页上。

### 7.3 收件人离线

发送时：

- 允许正常发送
- 不因为“离线”阻断消息发送

语义固定为：

- HubMsg 离线代收
- 对方以后上线补同步

`plugin-message` 页面本次不负责在线查询提示。

### 7.4 推送丢失或连接中断

处理方式固定如下：

- HubMsg 管理页展示错误与当前状态
- `plugin-appmsg` 继续靠重连 + 增量同步自愈
- `/messages` 不额外引入自己的重试 / 队列逻辑

### 7.5 scoped client 注入缺失

如果 `plugin-message` 忘了声明 `appMessageEndpoint.endpointId`，或者 runtime 没有注入 scoped client：

- 这属于实现错误
- 页面应明确显示能力缺失空态
- 测试必须覆盖

不允许退回去偷偷改成直接用 `appmsg.core` 兜底。

### 7.6 样式入口漏接

如果 `plugin-message` 页面结构已完成，但样式没生效：

- 先检查 `package.json` 的 `./styles.css` 导出
- 再检查 `apps/web/src/styles/plugins.css` 是否显式 `@import`

这类问题不允许通过把选择器临时塞进 `global.css` 来绕过。

---

## 8. 文件级实施清单

以下清单按“该文件本次应该承担什么改动”给出，作为一次性实施范围。

### 8.1 contracts / runtime

- `packages/contracts/src/appmsg.ts`
  - 删除或收缩“`keymaster.message` 可全库读”的设计描述。
  - 明确 `plugin-message` 是普通 scoped app。
  - 明确平台全库读 / 全库订阅仅供 `plugin-appmsg` 管理面使用。
  - 若实现时不再需要 `createSystemMessageClient(...)`，本次直接删掉对应 contract。

- `packages/contracts/src/plugin.ts`
  - 保持 `appMessageEndpoint` 作为普通消息插件声明机制。
  - 注释上明确 `plugin-message` 将成为该机制的正式使用者。

- `packages/runtime/src/createPluginHost.ts`
  - 不改模型，只验证 `plugin-message` 走真实的 scoped client 注入路径。

### 8.2 `plugin-message`

- `packages/plugin-message/package.json`
  - 导出 `./styles.css`。

- `packages/plugin-message/src/styles.css`
  - 新增消息业务页样式。
  - 只负责 `/messages` 与详情页的业务样式。

- `packages/plugin-message/src/index.ts`
  - 显式引入 `./styles.css` 的说明注释。
  - 导出消息业务页相关入口。

- `packages/plugin-message/src/manifest.ts`
  - 新增 `appMessageEndpoint.endpointId = "keymaster.message"`。
  - 依赖从直接读 `appmsg.core` 改为消费本插件 scoped `appmsg.client`。
  - `/messages` 路由归这里。
  - 新增 `/messages/:messageId` 路由与面包屑。

- `packages/plugin-message/src/messageService.ts`
  - 改为只封装 scoped client。
  - 保留业务方法：
    - `listMessages`
    - `getMessage`
    - `sendTextMessage`
    - `subscribeMessages`
  - 删除管理 / 诊断导向方法：
    - `listTargetSyncStates`
    - `triggerSync`
    - `checkOnline`
    - `getLocalDbSnapshot`

- `packages/plugin-message/src/MessagePage.tsx`
  - 删除连接状态、同步状态、在线查询区域。
  - 保留发送、搜索、列表。
  - 列表进入单条详情。

- `packages/plugin-message/src/MessageDetailPage.tsx`
  - 新增单条消息详情页。

- `packages/plugin-message/src/messageService.test.ts`
  - 改写为 scoped client 路径测试。
  - 覆盖发送、列表、单条读取、无 scoped client 时的空态。

- `packages/plugin-message/src/MessagePage.test.tsx`
  - 改写断言：
    - 不再出现 sync / online / connection UI
    - 出现发送区、搜索区、消息列表

- `packages/plugin-message/src/MessageDetailPage.test.tsx`
  - 新增详情页测试。

### 8.3 `plugin-appmsg`

- `packages/plugin-appmsg/src/manifest.ts`
  - 注册 `/system/hubmsg` 路由。
  - 注册 `system` 分组菜单项 `HubMsg`。
  - 不再把 `plugin-message` 语义塞进自己的页面职责。

- `packages/plugin-appmsg/src/HubMsgPage.tsx`
  - 新增正式管理页组件。
  - 展示：
    - 连接态
    - owner
    - 错误
    - sync 状态
    - 分组统计
    - 全局消息浏览

- `packages/plugin-appmsg/src/hubmsgService.ts`
  - 新增管理页 service。
  - 直接基于 `appmsg.core` 组织管理页所需数据。

- `packages/plugin-appmsg/src/styles.css`
  - 扩充 HubMsg 管理页样式。
  - 不承载 `plugin-message` 的业务样式。

- `packages/plugin-appmsg/src/index.ts`
  - 导出 HubMsg 管理页与 service。

- `packages/plugin-appmsg/src/messageFacade.ts`
  - 删除 `SystemMessageAppClient` 或把它从主路径退出。

- `packages/plugin-appmsg/src/appmsgCore.ts`
  - 如 contract 已删 `createSystemMessageClient(...)`，同步删除实现与测试。
  - 保留管理页直接需要的全库 / 状态能力。

- `packages/plugin-appmsg/src/appmsgCore.test.ts`
  - 删掉旧的 `createSystemMessageClient(...)` 相关测试。
  - 新增或保留全库消息 / 连接态 / sync 状态读取测试。

### 8.4 web 装配层

- `apps/web/src/styles/plugins.css`
  - 增加：

```css
@import "@keymaster/plugin-message/styles.css";
```

  - 保留：

```css
@import "@keymaster/plugin-appmsg/styles.css";
```

- `apps/web/src/bootstrapPlugins.ts`
  - 只验证插件加载顺序仍然正确。
  - 本次不因语义改名而重排整个插件装配。

---

## 9. 最终验收清单

以下清单全部满足，才算本次硬切换完成。

### 9.1 路由与入口

- `/messages` 打开的是 `plugin-message` 业务页。
- `/messages/:messageId` 可正常进入详情页。
- `/system/hubmsg` 打开的是 `plugin-appmsg` 管理页。
- `/system/messages` 已不存在。

### 9.2 `plugin-message` 边界

- `plugin-message` manifest 已声明 `appMessageEndpoint.endpointId = "keymaster.message"`。
- `plugin-message` 不再通过 `appmsg.core` 直接读全库。
- `plugin-message` 不再使用 `createSystemMessageClient(...)`。
- `/messages` 页面上看不到连接态、在线查询、sync 状态、全局统计。
- `/messages` 只剩发送、搜索、列表、详情。

### 9.3 发送与读取行为

- 在 `/messages` 输入一个合法 `publicKeyHex` 和文本，发送成功。
- 发送目标固定为 `recipientAppId = "keymaster.message"`。
- 列表只能看到 `keymaster.message` scope 内的消息。
- 详情页只能看到当前 scope 可见的消息；越权 `messageId` 不可见。

### 9.4 HubMsg 管理页行为

- `/system/hubmsg` 能展示当前连接状态。
- 能展示当前 owner。
- 能展示最近错误。
- 能展示 target sync 状态。
- 能展示所有 origin / appId 的本地消息统计。
- 能浏览当前 owner 的全局本地消息。
- 能手动触发同步。
- 能执行在线查询。

### 9.5 本地真值边界

- HubMsg 管理页的消息浏览与统计来自本地消息库，而不是远端统计直接渲染。
- HubMsg 远端删除旧消息后，已同步到本地的消息仍能在管理页查看。

### 9.6 样式验收

- `packages/plugin-message/src/styles.css` 已存在。
- `packages/plugin-message/package.json` 已导出 `./styles.css`。
- `apps/web/src/styles/plugins.css` 已显式引入 `@keymaster/plugin-message/styles.css`。
- `plugin-message` 页面样式生效。
- `plugin-appmsg` 管理页样式生效。
- 没有把 `plugin-message` 或 HubMsg 管理页的业务样式偷塞进 `global.css`。

### 9.7 测试验收

- `plugin-message` 的 service / page / detail page 测试通过。
- `plugin-appmsg` 的管理页相关测试通过。
- runtime 的 scoped client 注入路径仍通过原有测试。
- 与本次删除能力直接相关的旧测试已同步删改，不残留假阳性。

---

## 10. 一句话结论

这次硬切换的核心不是“多一个页面”，而是把两种本来就不该混在一起的身份彻底拆开：

- `plugin-message` = `keymaster.message` 业务页
- `plugin-appmsg` = HubMsg 平台内核 + 管理页

只要还让 `/messages` 承担连接态、全局统计、全局消息浏览，它就还没真正切干净。
