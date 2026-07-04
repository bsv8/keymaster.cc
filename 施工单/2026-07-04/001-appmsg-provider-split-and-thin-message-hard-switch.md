# 001 `hubmsg provider` / `appmsg core` / `plugin-message` 三层收口硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/plugin.ts`
- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/createPluginHost.test.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/hubmsgConnection.ts`
- `packages/plugin-appmsg/src/hubmsgService.ts`
- `packages/plugin-appmsg/src/HubMsgPage.tsx`
- `packages/plugin-appmsg/src/messageFacade.ts`
- `packages/plugin-appmsg/src/pluginClient.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`
- `施工单/2026-07-03/002-message-route-and-hubmsg-boundary-hard-switch.md`
- `施工单/2026-07-03/003-runtime-scoped-appmsg-client-owner-refresh-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“`hubmsg` 是消息服务 provider，`appmsg` 是系统逻辑中心，`plugin-message` 是极薄业务应用”的定义优先。
2. 旧设计里凡是把 `plugin-appmsg` 同时当成 provider 适配层和业务中心、把 runtime 当成 `appmsg.client` 生命周期 owner 的描述，本次全部失效。
3. 本次不保留兼容层、不保留双路实现、不保留旧 capability 别名，不做“先接上再慢慢迁”的尾巴方案。

---

## 1. 文档定位

这不是一次“修发送报错”或“改页面归属”的小调整，而是一次**消息系统分层重建硬切换**。

当前系统最绕的地方不是某一个 bug，而是职责交叉：

- `plugin-appmsg` 里同时塞了 HubMsg 协议适配、owner 生命周期、消息本地库、管理页
- runtime 又介入了 `appmsg.client` 的 owner 绑定与重建
- `plugin-message` 虽然想保持极薄，却仍然被迫感知“client 变了没有”

这会导致：

- 设计讨论很容易绕到“到底谁该重建 client”
- 代码实现很容易在 runtime / appmsg / message 三层来回泄漏
- 新 provider 未来一旦出现，系统会继续纠缠在 `HubMsg == 消息系统` 的错误假设上

所以这次必须直接一刀切成三层：

- `plugin-hubmsg`：HubMsg 服务适配层
- `plugin-appmsg`：消息系统逻辑中心
- `plugin-message`：极薄消息应用

---

## 2. 简述缘由

### 2.1 `hubmsg` 不是消息系统本身，而是某一种消息服务

你已经把核心前提说清楚了：

- 未来会有别的消息系统
- `hubmsg` 只是其中一种
- 运行时只能单选激活一个消息服务

既然如此，`hubmsg` 就不能继续承担“系统逻辑中心”的角色。它应该只是 provider。

### 2.2 owner / key / vault 变化属于系统逻辑，不属于 provider 逻辑

下面这些都不是 HubMsg 私有问题：

- 当前 owner 是谁
- vault 锁定后要不要断开
- active key 切换后消息订阅怎么续上
- 本地消息模型如何对上层保持稳定

这些都属于统一消息系统行为，必须收口到 `plugin-appmsg`。

### 2.3 `plugin-message` 必须极薄，不能再碰身份和 provider 细节

`plugin-message` 只应该关心：

- 列表
- 单条查看
- 发送 `keymaster.message`
- 订阅“我的消息流”

它不应该知道：

- 当前 active provider 是谁
- 当前 owner 是谁
- key 切换后要不要重建 client
- vault 锁定后 provider 是怎么断开的

### 2.4 runtime 不应该再拥有消息业务生命周期

`runtime` 负责通用插件装配，不应该继续持有“消息 endpoint 的 owner 跟随逻辑”。

一旦 runtime 负责 `appmsg.client` 生命周期，就会把消息系统特有复杂度漏进通用层。这正是 003 之所以越修越绕的根因。

---

## 3. 硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `plugin-hubmsg` 独立存在，成为一个消息服务 provider 插件。
2. `plugin-appmsg` 不再直接持有 HubMsg 线协议实现文件；它只消费“激活中的消息 provider”。
3. `plugin-appmsg` 成为唯一的消息系统逻辑中心，负责 owner、连接生命周期、订阅迁移、本地库、统计、诊断、管理页。
4. `plugin-message` 只消费 `plugin-appmsg` 提供的稳定消息能力，不再感知 runtime 注入的临时 `appmsg.client`。
5. runtime 删除 `<pluginId>.appmsg.client` 这条生命周期注入机制，不再监听 keyspace / vault 去重建消息 client。
6. `HubMsgPage` 从“HubMsg 管理页”升级为 `plugin-appmsg` 的统一消息系统管理页；路由改为 `/system/appmsg`，不再使用 `/system/hubmsg`。
7. `plugin-hubmsg` 不提供页面，不提供业务菜单；它只注册 provider。
8. 系统只允许单选一个 active message provider；默认可选 `hubmsg`，未来其它 provider 与它平行。
9. 切 key、锁库、解锁、切 provider 后，`plugin-message` 不需要刷新页面、不需要重建自己的 service、不需要观察 client 引用变化。
10. 本次不保留 `HubMsg` 管理页旧别名、不保留 `appmsg.client` 旧 capability、不保留 `createMessageScopedClient(...)` 旧设计。

---

## 4. 最终分层定义

### 4.1 `plugin-hubmsg`

它是 HubMsg 服务的 provider 对应层，只负责：

- HubMsg 连接、断开、bind、收发帧
- HubMsg 的 `message.list` / `message.send` / `message.online` 等服务调用
- HubMsg 协议特有签名、序列化、错误映射

它不负责：

- owner 真值
- active key / vault 生命周期
- 本地消息库
- 业务页
- 全局管理页
- `keymaster.message` 业务语义

### 4.2 `plugin-appmsg`

它是消息系统的逻辑中心，只负责：

- 单选 active provider
- owner 真值与连接真值
- provider 切换时的断开 / 切换 / 重绑
- 本地消息库
- 统一消息模型
- endpoint 级消息 service
- 系统管理页 `/system/appmsg`
- 统计、诊断、报错、同步、在线查询

它不负责：

- 直接把 provider 线协议细节暴露给业务插件
- 把 owner 生命周期丢给 runtime

### 4.3 `plugin-message`

它是极薄业务应用，只负责：

- `/messages`
- `/messages/:messageId`
- `keymaster.message` 列表 / 单条 / 搜索 / 发送 / 订阅

它不负责：

- provider 选择
- owner 感知
- keyspace / vault 监听
- 本地库策略
- 管理展示

---

## 5. 必须怎么做

### 5.1 新建 provider 契约与 provider registry

必须新增独立 provider 契约，例如：

- `messageProvider.registry`
- `MessageProvider`
- `ActiveMessageProviderSnapshot`

provider 契约必须是窄接口，只描述“如何和某个消息服务说话”，不能夹带业务语义。

### 5.2 `plugin-hubmsg` 从 `plugin-appmsg` 中完整抽出

当前这些 HubMsg 特有文件必须迁出 `plugin-appmsg`：

- `hubmsgConnection.ts`
- `signing.ts`
- `hubmsg` 协议调用相关测试
- 与 HubMsg wire record 强绑定的适配逻辑

迁出后：

- `plugin-hubmsg` 负责把自己注册为一个 provider
- `plugin-appmsg` 通过 registry 拿 provider，而不是直接 import HubMsg 连接实现

### 5.3 `plugin-appmsg` 提供稳定 endpoint service

`plugin-appmsg` 必须对上层提供**稳定对象**，而不是“带固化 owner 的临时 client 引用”。

这里的稳定能力至少要满足：

- endpoint 固定，例如 `keymaster.message`
- owner 在内部按当前真值解析
- `send/list/get/subscribe` 都由 `plugin-appmsg` 内部处理 owner / provider 变化
- `subscribe` 需要在内部自动迁移，不允许把“订阅重绑”泄漏给页面

### 5.4 runtime 删除消息专用生命周期逻辑

`createPluginHost.ts` 里与 `appmsg.client` 相关的专用逻辑必须一次性删除：

- `ensureScopedClientWatchers()`
- `refreshAllScopedClients()`
- `<pluginId>.appmsg.client` 注入 / revoke / rebuild
- 针对 `appMessageEndpoint` 的 owner watcher

runtime 最多只保留：

- manifest 元数据校验
- registry / capability 的通用装配

不能再持有消息系统业务逻辑。

### 5.5 管理页从 `/system/hubmsg` 改为 `/system/appmsg`

既然 `appmsg` 才是系统中心，管理页就必须归 `plugin-appmsg` 而不是 provider 名。

必须改成：

- 路由：`/system/appmsg`
- 菜单：`AppMsg`
- 页面语义：显示当前 active provider、当前 owner、连接态、同步态、错误态、本地消息统计

provider 名只作为页面中的一个字段，不再作为整个页面命名。

### 5.6 本地 DB 按 provider 隔离

provider 可切换后，本地消息库不能继续只按 owner 一层命名。

必须改为至少按：

- `owner`
- `providerId`

两层隔离。

本次不做旧 `messages` DB 迁移；直接切新命名空间，旧缓存视为废弃数据。

---

## 6. 不能怎么做

### 6.1 不能继续保留 runtime `.appmsg.client` 双路

不能出现下面这种过渡态：

- 新的 `plugin-appmsg` endpoint service 已经上线
- 旧的 `<pluginId>.appmsg.client` 还保留着给老页面用

这就是典型尾巴。必须直接砍掉旧路。

### 6.2 不能让 `plugin-message` 直接碰 provider

`plugin-message` 不能：

- 直接 `ctx.get("hubmsg.*")`
- 直接 import `plugin-hubmsg` 内部实现
- 直接订阅 keyspace / vault 自己处理身份

它只能向 `plugin-appmsg` 要稳定业务能力。

### 6.3 不能让 provider 承担统一业务语义

`plugin-hubmsg` 不能承载：

- `keymaster.message` endpoint 语义
- 本地消息库
- 系统统计页
- UI 管理页
- 统一消息搜索行为

否则未来第二个 provider 到来时，系统还会再绕一次。

### 6.4 不能继续把 `HubMsg` 当成管理页名字

provider 只是底层实现，管理页必须是系统名，不是某个 provider 名。

所以本次不能保留：

- `/system/hubmsg`
- `HubMsgPage`
- “HubMsg 就是消息系统”的页面文案

### 6.5 不能做自动 fallback 到另一 provider

系统是单选 active provider，不是多活。

当前 active provider 缺失、禁用、报错时：

- `plugin-appmsg` 应进入 not-ready / degraded 真值
- 页面明确展示错误

不能偷偷切到第二个 provider。

---

## 7. 特殊情况提前约定

### 7.1 当前没有 active provider

处理方式：

- `plugin-appmsg` 管理页显示“未选择消息服务”
- `plugin-message` 列表返回空态
- 发送返回明确 `not_ready`
- 不自动选第一个 provider 兜底，除非配置里明确指定默认值

### 7.2 当前 active provider 被禁用或卸载

处理方式：

- `plugin-appmsg` 立刻断开旧 provider
- 保留本地状态只作为只读缓存，不再继续同步
- 管理页展示 provider 缺失错误
- 业务页进入未就绪态

不能自动切去别的 provider。

### 7.3 vault 锁定或没有 active key

处理方式：

- `plugin-appmsg` 负责断开 active provider
- endpoint service 保持对象稳定，但业务方法按 `not_ready` 降级
- `plugin-message` 不做任何 owner 补丁逻辑

### 7.4 用户切换 active provider

处理方式：

1. `plugin-appmsg` 断开旧 provider
2. 切换到新 provider
3. 以当前 owner 重新 bind
4. 内部重挂订阅
5. 页面不 reload、不 remount、不做双路兼容

### 7.5 旧本地 DB 数据

处理方式：

- 不迁移
- 不合并
- 不补桥
- 直接启用新 DB 命名空间

这是明确的硬切换成本，用来换取后续结构干净。

---

## 8. 文件级一次性施工单

### 8.1 新增 `packages/plugin-hubmsg`

必须新增：

- `packages/plugin-hubmsg/package.json`
- `packages/plugin-hubmsg/tsconfig.json`
- `packages/plugin-hubmsg/src/index.ts`
- `packages/plugin-hubmsg/src/manifest.ts`
- `packages/plugin-hubmsg/src/hubmsgProvider.ts`
- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
- `packages/plugin-hubmsg/src/signing.ts`
- `packages/plugin-hubmsg/src/*.test.ts`

要求：

- 只提供 provider 注册能力
- 不注册页面
- 不注册系统菜单
- 不提供业务 message service

### 8.2 修改 `packages/contracts/src/appmsg.ts`

必须：

- 删除 `APPMESSAGE_CLIENT_CAPABILITY_SUFFIX`
- 删除 `createMessageScopedClient(...)` 这套“sender 固化 client”设计
- 新增稳定 endpoint service / provider registry / active provider 契约
- 注释明确：owner 生命周期由 `plugin-appmsg` 内部持有

### 8.3 修改 `packages/contracts/src/plugin.ts`

必须：

- 取消 `appMessageEndpoint` 与 runtime 注入 scoped client 的绑定语义
- 若保留 `appMessageEndpoint` 字段，只允许它表达 endpoint 元数据与唯一性约束
- 注释明确：runtime 不再注入 `<pluginId>.appmsg.client`

### 8.4 修改 `packages/runtime/src/createPluginHost.ts`

必须删除：

- scoped appmsg client watcher
- scoped appmsg client refresh
- 与 keyspace / vault 绑定的消息专用逻辑

必须新增或保留：

- provider registry 这类通用装配能力
- endpoint 元数据的通用校验能力

### 8.5 修改 `packages/runtime/src/createPluginHost.test.ts`

必须：

- 删除 003 中所有“runtime 重建 scoped client”的测试
- 改成验证 runtime 已不再持有消息业务生命周期
- 若保留 endpoint 元数据校验，补唯一性测试

### 8.6 重构 `packages/plugin-appmsg`

至少涉及：

- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/index.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/hubmsgService.ts`
- `packages/plugin-appmsg/src/HubMsgPage.tsx`
- `packages/plugin-appmsg/src/styles.css`
- `packages/plugin-appmsg/src/messageFacade.ts`
- `packages/plugin-appmsg/src/pluginClient.ts`
- `packages/plugin-appmsg/src/appmsgCore.test.ts`
- `packages/plugin-appmsg/src/HubMsgPage.test.tsx`

必须做到：

- `hubmsg` 适配层迁出
- 管理页改为 `AppMsg` 语义
- 提供稳定 endpoint service
- `messageFacade.ts` / `pluginClient.ts` 若仍基于“sender 固化 client”模型，直接删除或重写，不保留旧名旧义

### 8.7 修改 `packages/plugin-message`

至少涉及：

- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/MessagePage.test.tsx`
- `packages/plugin-message/src/messageService.test.ts`

必须做到：

- 不再依赖 runtime 注入的 `<pluginId>.appmsg.client`
- 改为依赖 `plugin-appmsg` 提供的稳定 endpoint service
- 删除 `subscriptionSource()` 这类为 runtime client 引用变化服务的补丁接口
- 页面订阅回到普通长寿订阅模型

### 8.8 修改装配层

至少涉及：

- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/styles/plugins.css`

必须做到：

- 先装 `plugin-hubmsg`，再装 `plugin-appmsg`
- `plugin-message` 继续在 `plugin-appmsg` 之后装载
- 若 `plugin-hubmsg` 无页面，则不要给它加样式入口
- `plugin-appmsg` 页面样式入口继续显式引入

---

## 9. 最终验收清单

### 9.1 分层验收

- 存在独立 `packages/plugin-hubmsg`
- `plugin-appmsg` 不再 import HubMsg 线协议实现
- `plugin-message` 不再 import 或 get 任何 provider 细节

### 9.2 路由与页面验收

- `/messages` 仍归 `plugin-message`
- `/system/appmsg` 归 `plugin-appmsg`
- `/system/hubmsg` 不再存在
- `plugin-hubmsg` 无页面、无菜单

### 9.3 生命周期验收

- 切换 active key 后，`/messages` 不刷新页面即可继续发送和收实时消息
- vault 锁定后，`/messages` 进入未就绪态
- vault 解锁后，`/messages` 自动恢复
- 切换 active provider 后，`/messages` 无需 remount 即恢复到新 provider

### 9.4 结构洁净度验收

- 仓库内不存在 `<pluginId>.appmsg.client` 旧 capability 用法
- 仓库内不存在 `createMessageScopedClient(...)` 旧调用
- `plugin-message` 中不存在 `subscriptionSource()` 旧补丁接口
- runtime 中不存在消息专用 watcher / refresh 逻辑

### 9.5 管理面验收

- `plugin-appmsg` 页面显示 active provider
- 显示当前 owner
- 显示连接状态
- 显示最近错误
- 显示本地消息统计
- 显示同步状态
- 可手动同步
- 可做在线查询

### 9.6 Provider 选择验收

- 系统只允许单选一个 active provider
- active provider 缺失时不自动切到别的 provider
- provider 缺失时页面明确报未就绪

### 9.7 无尾巴验收

- 没有旧路由别名
- 没有旧 capability 别名
- 没有旧 facade 兼容层
- 没有“新旧两套 message service 并存”
- 没有“runtime 一套、appmsg 一套”双重生命周期逻辑

---

## 10. 一句话验收标准

最终应当达到：

`hubmsg` 只是消息服务 provider，`appmsg` 是唯一消息系统中心，`plugin-message` 是极薄业务页；系统内部不再存在“谁来重建消息 client”这类绕题，因为业务层已经不再直接持有带身份生命周期的临时 client。
