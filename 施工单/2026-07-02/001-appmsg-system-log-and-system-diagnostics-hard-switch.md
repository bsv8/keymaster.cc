# 001 appmsg 系统级日志 + “系统 / 消息系统”诊断页硬切换一次性迭代施工单

## 参考文件

本单落地、评审、联调以下列现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/navigation.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/hubmsgConnection.ts`
- `packages/plugin-settings/src/manifest.ts`
- `packages/runtime/src/log/logService.ts`
- `packages/runtime/src/registries/menuRegistry.ts`
- `apps/web/src/shell/Sidebar.tsx`
- `施工单/2026-07-01/002-protocol-appmsg-bus-hard-switch.md`
- `施工单/2026-07-01/003-appmsg-v1-frozen-protocol-alignment.md`
- `../HubMsg/README.md`
- `../HubMsg/internal/protocol/messages.go`
- `../HubMsg/internal/service/service.go`

发生冲突时，按以下优先级：

1. 本单关于“系统级日志”“系统菜单”“消息系统诊断页”“owner 下所有 origin 汇总”的定义优先。
2. 既有 `appmsg.send / list / get` 外部协议不扩张，外部协议面仍保持最小。
3. `AppMsgSystemPage` 是 `plugin-appmsg` 的管理页面，不是应用页面，不是协议页面。
4. HubMsg 负责 owner 级 origin 统计真值，不负责前端页面语义。

---

## 1. 简述缘由

这次需求本质上不是“给某个 app 增加一个 inbox 页面”，而是把 `appmsg` 正式收口成**系统级消息总线**，并补上最小可运维面。

当前系统已经有：

- `appmsg` 作为应用消息总线
- owner-bound 单 WSS 连接
- `send / list / get`
- `message.received` 到本地刷新
- `/settings/logs` 的统一日志底座

但仍缺三块关键能力：

1. **系统级行为可追溯**
   - 现在 send / receive / reconnect / bind / diagnostics refresh 没有被强约束成统一系统日志。
   - 出问题时无法稳定在 `/settings/logs` 回看消息系统行为。

2. **系统级诊断页**
   - 现在没有一个正式页面告诉用户：
     - 当前 active key 是否已连上 HubMsg
     - 当前绑定 owner 是谁
     - 这个 owner 下面有哪些 origin / plugin 渠道
     - 每个渠道各有多少消息

3. **owner 级 origin 统计真值**
   - 诊断页要看的不是“当前活跃 session”，而是“当前 active key 下所有已有消息的 origin 数据”。
   - 如果还从 `connect session` 推导 origin，会漏掉历史已有消息但当前未连接的 origin，这个真值是错的。

所以这次必须硬切换成：

- 所有消息系统关键动作统一记到 `/settings/logs`
- 左侧菜单新增正式“系统”分组
- `plugin-appmsg` 自己提供“消息系统”管理页
- 该页直接基于 HubMsg 的 owner 级诊断接口取数
- 页面只看连接状态与数量，不看消息明细

---

## 2. 本次硬切换目标

本次完成后，系统必须达到以下最终状态：

1. 所有真实的消息系统关键动作都能在 `/settings/logs` 查到统一日志。
2. 左侧菜单新增正式分组：`system`，展示文案为“系统”。
3. `system` 分组下新增“消息系统”页面入口。
4. 页面路径固定为 `/system/messages`。
5. 该页面归属 `plugin-appmsg`，不是 `plugin-protocol`。
6. 页面展示：
   - 当前连接状态
   - 当前绑定 owner
   - 当前 HubMsg URL
   - 最近一次成功 bind 时间
   - 最近一次错误
   - 当前 active key 下所有已有消息的 origin 渠道数量
   - 当前 active key 下所有 plugin endpoint 渠道数量
7. 页面只显示**数量**，不显示任何 message body / markdown / 明细列表。
8. 数量按渠道行展示，至少包含：
   - 渠道类型：`origin` / `plugin`
   - 渠道 id
   - `inbox`
   - `sent`
   - `all`
   - 最近刷新时间
   - 当前行错误状态
9. “手动查看”语义固定为用户点击刷新后从真值层重新取数，不允许只看 UI 内存猜测值。
10. 外部协议**不新增** `appmsg.count`、`appmsg.inspectOrigins` 之类对外方法；这次只做内部诊断能力。
11. `/settings/logs` 继续是唯一日志查看入口；**不**新增第二套消息日志页或消息诊断存储。

---

## 3. 单真值与不能怎么做

### 3.1 日志单真值

本次固定：

- 所有消息系统诊断日志统一走 `ctx.logger`
- 插件 id 固定归属 `appmsg`
- 存储仍然只走 `packages/runtime/src/log/logService.ts`
- 查看入口仍然只走 `/settings/logs`

**不能怎么做：**

- 不能给消息系统单独建第二套 IndexedDB 日志库
- 不能只打 `console.log`
- 不能让 HubMsg 服务端日志代替本地系统日志
- 不能把“系统页上的最近事件”当成日志真值

### 3.2 诊断页单真值

本次固定：

- “消息系统”是 `plugin-appmsg` 的**系统管理页**
- 它面向当前 active key 的所有渠道做总览
- 只看状态与数量，不看明细
- 它不是应用页面，不属于任何单一 origin 或单一 plugin

**不能怎么做：**

- 不能把这页挂到 `plugin-protocol`
- 不能把这页做成某个 app 的 inbox 页
- 不能在这页直接展示 message body / markdown
- 不能顺手加“删除消息”“重发消息”“标记已读”之类未批准动作

### 3.3 菜单分组单真值

本次固定：

- 菜单分组 key 用 `system`
- 展示文案显示“系统”
- “消息系统”作为 `system` 分组下的普通主菜单项

**不能怎么做：**

- 不能把 `MenuItem.group` 直接写成中文 `"系统"` 当真值
- 不能把这个页面塞进 `settings.registry`
- 不能复用 `/settings/logs` 或 `/settings/plugins` 路由冒充“系统主菜单”

### 3.4 渠道数量单真值

本次固定：

- 数量真值来自 HubMsg owner 级诊断接口
- 页面点击“刷新”时必须重新取真值
- 不能靠当前页缓存条数拼出“数量”

**不能怎么做：**

- 不能通过 `message.list(limit=999999)` 拉明细再本地计数
- 不能只用当前已知 connect session 推导 origin 目录
- 不能只用 `appmsg.core` 本地内存条数冒充真实数量
- 不能给外部第三方 app 暴露 `appmsg.count`

原因很明确：这页是系统诊断页，要看的是 owner 级总览真值，而不是当前会话猜测值。

### 3.5 origin 目录单真值

本次固定：

- origin 列表真值来自 HubMsg
- 语义是“当前 active key 对应 owner 下，已有消息记录的全部 origin 渠道”
- plugin 渠道列表真值来自 `plugin-appmsg` 已登记的 endpoint

**不能怎么做：**

- 不能把 origin 列表真值建立在 `connect session` 上
- 不能要求用户必须先打开过某 origin 页面，系统页才看得到它
- 不能把 origin 汇总接口做成前端自己扫缓存

---

## 4. 特殊情况提前约定

### 4.1 Vault 锁定

当 Vault 锁定或当前没有 active owner 时：

- 页面允许打开
- 连接状态显示为 `disconnected` / `no owner`
- 手动刷新按钮禁用
- 上一次成功刷新得到的数量可以作为“陈旧快照”展示，但必须有 stale 标识

不允许在锁定态为了刷新数量而偷偷解锁或绕过 owner 真值。

### 4.2 HubMsg 断线或 bind 失败

当 HubMsg 断线、bind 失败、网络错误时：

- 页面显示最后错误
- 手动刷新先走一次 best-effort reconnect
- reconnect 失败则本次刷新失败，但页面其它信息仍可展示
- 失败必须写系统日志

不允许因为某一次 reconnect 失败把整个系统页渲染崩掉。

### 4.3 部分渠道刷新失败

如果是批量刷新多个渠道数量：

- 单个渠道失败只标记该行错误
- 其它渠道继续刷新并显示结果
- 总刷新状态显示“部分失败”

不允许“一行失败，全页全失败”。

### 4.4 HubMsg 还未支持 owner 级 origin 汇总

这是这次迭代最关键的前置条件。

如果 HubMsg 还没有提供：

- 当前 owner 下 origin 列表
- 当前 owner 下按 origin 的数量统计

则 `AppMsgSystemPage` 不能降级成：

- 读取 connect session 代替
- 拉消息明细后本地枚举 origin

这两种都不允许。必须把 HubMsg 配套接口补齐后再上线本页。

### 4.5 日志敏感信息

消息系统日志必须遵守：

- **不记录正文**
- **不记录 markdown 内容**
- **不记录任何私钥、密码、密文**
- 可以记录：
  - `messageId`
  - `clientMessageId`
  - `contentType`
  - `bodyBytes`
  - sender / recipient endpoint
  - owner 的短标签或脱敏表示

绝不能为了“诊断方便”把消息正文打进系统日志。

---

## 5. 实施方案总览

本次采用一刀切硬切换，不拆阶段，不保留旧路径。

### 5.1 分层

本次分层固定如下：

1. `plugin-appmsg`
   - 持有 HubMsg 连接真值
   - 负责 send / receive / reconnect / diagnostics transport
   - 负责系统级消息日志
   - 注册 `/system/messages` 页面与 `system` 菜单项
   - 渲染 `AppMsgSystemPage`

2. `runtime log service`
   - 继续作为唯一日志底座

3. `HubMsg`
   - 新增 owner 级 origin 汇总与数量接口
   - 提供 plugin / origin 渠道的计数真值
   - 不感知前端页面 UI

### 5.2 为什么这样分

- 页面看的是 appmsg 总线的系统状态，所以页面必须属于 `plugin-appmsg`
- origin 汇总真值来自消息存储本身，而不是 connect session，所以必须直连 HubMsg 诊断接口
- `plugin-protocol` 只负责外部应用协议与连接会话，不应承担系统管理页面
- 把管理页和消息真值放在同一插件内，依赖方向最简单

---

## 6. 文件级施工清单

以下是**一次性迭代必须动到的文件**。未列出的文件，不要顺手扩张。

### 6.1 keymaster.cc：contracts / 内部 capability

#### 6.1.1 `packages/contracts/src/appmsg.ts`

目的：

- 在内部 capability 层补充“系统诊断所需”的最小接口

新增内容：

- 新增连接快照类型，例如：
  - `AppMsgConnectionSnapshot`
- 新增渠道统计类型，例如：
  - `AppMsgSystemChannelCount`
  - `AppMsgSystemChannelSummary`
- 新增 owner 级 origin 汇总结果类型，例如：
  - `AppMsgOriginSummary`
  - `AppMsgDiagnosticsSnapshot`
- 扩展 `AppMsgCore` 内部接口，新增只给内部 UI / 平台使用的方法，例如：
  - `inspectConnection()`
  - `refreshDiagnostics()`
  - `getDiagnosticsSnapshot()`
  - `listKnownPluginEndpoints()`

边界：

- **不**新增对外 `appmsg.count`
- **不**改既有 `appmsg.send / list / get` 对外 contract
- **不**在这里暴露第三方可调用的 owner 诊断方法

#### 6.1.2 `packages/contracts/src/navigation.ts`

目的：

- 保持 `MenuItem.group` 仍是分类键
- 给本次 `system` 分组补上明确注释约束

要求：

- 明确 `MenuItem.group` 不是最终展示文案真值
- 页面路由仍用普通 route/menu 机制，不做特殊侧门

---

### 6.2 keymaster.cc：plugin-appmsg

#### 6.2.1 `packages/plugin-appmsg/src/appmsgCore.ts`

目的：

- 承担消息系统诊断真值与系统日志

必须新增：

1. 连接状态快照
   - 当前 state
   - 当前 owner
   - 当前 url
   - 最近一次 bind 成功时间
   - 最近一次错误
   - 最近一次收到 message 时间

2. 已知 plugin endpoint 集合
   - 在 `createPluginScopedClient(endpointId)` 时登记
   - 为系统页提供 plugin 渠道目录

3. 诊断刷新接口
   - 调 HubMsg owner 级 origin 汇总接口
   - 调 HubMsg 渠道计数接口
   - 合并 origin / plugin 两类结果
   - 形成页面可直接消费的 snapshot

4. 系统日志埋点
   - connect attempt / bound / closed / failed
   - send start / success / failed
   - receive push
   - diagnostics refresh start / success / partial-failed / failed

日志字段要求：

- 只记元数据
- `body` 只记长度，不记正文

#### 6.2.2 `packages/plugin-appmsg/src/hubmsgConnection.ts`

目的：

- 补内部 diagnostics transport request / result 形状

要求：

- 支持 owner 级 origin list / count 请求
- 支持 plugin / origin 渠道 count 请求
- 只做内部 HubMsg 协议支持
- 不暴露给第三方 client app

#### 6.2.3 `packages/plugin-appmsg/src/manifest.ts`

目的：

- 由 `plugin-appmsg` 自己注册管理页与菜单

必须新增依赖：

- `route.registry`
- `menu.registry`

必须注册：

- route: `/system/messages`
- menu item:
  - `group = "system"`
  - label: “消息系统”

边界：

- **不**走 `settings.registry`
- **不**复用 popup 路径
- **不**把页面挂到 `plugin-protocol`

#### 6.2.4 `packages/plugin-appmsg/src/AppMsgSystemPage.tsx`（新文件）

目的：

- 消息系统总览管理页

页面必须展示：

- 连接状态卡
  - 当前 owner
  - HubMsg URL
  - state
  - last bound at
  - last error
  - last received at

- 渠道计数表
  - `kind`
  - `channel id`
  - `inbox`
  - `sent`
  - `all`
  - `last refreshed`
  - `row status`

- 操作
  - 手动刷新

页面边界：

- 不显示 message body
- 不显示 message list
- 不做删除 / 重发 / 跳转明细
- 直接通过 `appmsg.core` 内部 diagnostics 能力拿数据

#### 6.2.5 `packages/plugin-appmsg/src/*.test.ts` / `*.test.tsx`

必须补测试：

- send / receive 是否写日志
- reconnect / bind fail 是否写日志
- `createPluginScopedClient(endpointId)` 是否登记 plugin endpoint
- `refreshDiagnostics()` 是否正确处理全部成功 / 部分失败 / 全失败
- `/system/messages` 路由能打开
- 菜单项出现在 `system` 分组下
- 锁定态显示 disconnected / stale 并禁用刷新
- 页面不渲染正文细节

---

### 6.3 keymaster.cc：shell / i18n / 菜单展示

#### 6.3.1 `apps/web/src/shell/Sidebar.tsx`

目的：

- 让 `group = "system"` 展示为“系统”

硬切换要求：

- Sidebar 不再直接把 group 原样当成最终展示文案
- 至少对已知分组做稳定映射：
  - `settings` -> “设置”
  - `system` -> “系统”
- 其它未知 group 保持 fallback

不能怎么做：

- 不能继续直接 `<h4>{group}</h4>` 然后让插件传中文组名

#### 6.3.2 `packages/plugin-settings/src/manifest.ts` 或 `apps/web/src/i18n/resources.ts`

目的：

- 提供 `system` 分组与“消息系统”页面需要的公共文案

建议新增 key：

- `shell.menu.group.system`
- `appmsg.system.title`
- `appmsg.system.description`
- `appmsg.system.status.*`
- `appmsg.system.counts.*`

原则：

- 分组标题、页面标题、按钮、空态、错误态都走 i18n

---

### 6.4 HubMsg 配套文件级施工

本次不是只改前端。若没有 HubMsg owner 级诊断接口，前端“只看数量”会被迫去拉明细或去看 connect session，这两条都不允许。

#### 6.4.1 `../HubMsg/internal/protocol/messages.go`

新增内部协议结构：

- `OwnerOriginListParams`
- `OwnerOriginListResult`
- `OwnerOriginCountItem`
- `ChannelCountItem`
- 如果需要，也可以直接合并成一个 owner diagnostics result，但语义必须清晰

结果至少要包含：

- owner 下全部 origin 渠道列表
- 每个 origin 的 `inbox / sent / all`
- plugin 渠道的 `inbox / sent / all`

要求：

- origin 的判定单位必须是 exact origin，包含 port
- 不能做 host 级合并

#### 6.4.2 `../HubMsg/internal/protocol/frames.go`

新增内部 method 常量。

建议拆成两个方法，语义更稳：

- `owner.origins.list`
- `owner.channels.count`

也允许合并成一个方法，例如：

- `owner.diagnostics.get`

但无论哪种命名，要求保持：

- 只用于 keymaster ↔ HubMsg 内部协议
- 不等于第三方外部协议方法
- 返回 owner 级真值，不依赖前端 session

#### 6.4.3 `../HubMsg/internal/service/service.go`

新增处理逻辑：

- 按当前 owner 汇总全部 origin
- 按 owner + channel 统计 `inbox / sent / all`
- 支持批量返回
- 单个渠道异常时返回对应错误，不拖垮其它合法渠道

边界：

- 不返回 message detail
- 不额外推送 event
- 不引入复杂缓存层

#### 6.4.4 `../HubMsg/internal/store/store.go`

新增 store 诊断接口：

- list owner origins
- count owner origin channels
- count owner plugin channels

要求：

- 接口命名清楚区分 origin 与 plugin
- 可以批量，但不要引入过度抽象

#### 6.4.5 `../HubMsg/internal/db/pg.go`

新增 PG 查询：

- `SELECT DISTINCT origin ...`
- `COUNT(*)`
- 按 `(owner, endpoint, box)` 或等价字段查询

原则：

- SQL 以简单明确为先
- 不做花哨统计缓存
- 不做异步汇总表

#### 6.4.6 `../HubMsg/README.md`

更新内部协议文档：

- 新增 owner 级 diagnostics 方法
- 明确它只给 keymaster 系统诊断页使用
- 不等于第三方 app 外部协议

---

## 7. 日志事件规范

本次必须统一 event 命名，避免后续 `/settings/logs` 无法检索。

建议最小事件集如下：

### 7.1 connection

- `appmsg.connect.begin`
- `appmsg.connect.bound`
- `appmsg.connect.closed`
- `appmsg.connect.failed`
- `appmsg.reconnect.begin`
- `appmsg.reconnect.failed`

### 7.2 send

- `appmsg.send.begin`
- `appmsg.send.ok`
- `appmsg.send.failed`

建议字段：

- `messageId`
- `clientMessageId`
- `senderEndpoint`
- `recipientEndpoint`
- `contentType`
- `bodyBytes`

### 7.3 receive

- `appmsg.receive.pushed`

建议字段：

- `messageId`
- `senderEndpoint`
- `recipientEndpoint`
- `contentType`
- `bodyBytes`

### 7.4 diagnostics

- `appmsg.diagnostics.refresh.begin`
- `appmsg.diagnostics.refresh.ok`
- `appmsg.diagnostics.refresh.partial_failed`
- `appmsg.diagnostics.refresh.failed`

建议字段：

- `owner`
- `originCount`
- `pluginCount`
- `failedChannels`

---

## 8. 最终验收清单

以下清单全部通过，才算本次硬切换完成。

### 8.1 日志

1. 从外部 app 或 plugin 发送一条消息后，`/settings/logs` 能查到 `pluginId=appmsg` 的发送日志。
2. 收到一条消息后，`/settings/logs` 能查到接收日志。
3. 断网或 HubMsg 不可达时，`/settings/logs` 能查到连接失败 / diagnostics 刷新失败日志。
4. 日志中**没有** message body / markdown 正文。

### 8.2 菜单与路由

1. 左侧菜单出现“系统”分组。
2. “系统”分组下出现“消息系统”入口。
3. 点击后进入 `/system/messages`。
4. 该入口由 `plugin-appmsg` 注册，不在 `settings` 分组下。

### 8.3 页面展示

1. 页面能显示当前连接状态。
2. 页面能显示当前 owner。
3. 页面能显示最近一次 bind 成功时间。
4. 页面能显示最近一次错误。
5. 页面能列出当前 active key 下所有已有消息的 origin 渠道。
6. 页面能列出当前 active key 下已登记的 plugin 渠道。
7. 每行至少显示 `inbox / sent / all` 三列数量。
8. 页面不显示任何 message detail / body。

### 8.4 手动刷新

1. 解锁态点击刷新，会重新向 HubMsg 真值层取数。
2. 锁定态刷新按钮禁用。
3. 部分渠道失败时，其它渠道仍然更新。
4. 刷新动作自身会写系统日志。

### 8.5 HubMsg 配套

1. keymaster 能拿到 owner 下 origin list 真值。
2. keymaster 能拿到 owner 下按渠道统计的 `inbox / sent / all`。
3. count 查询不需要拉 message 明细。
4. origin 统计按 exact origin 隔离，port 不丢失。
5. plugin endpoint 与 origin 统计互不混入。

### 8.6 回归边界

1. 既有对外 `appmsg.send / list / get` 不变。
2. 既有 `/settings/logs` 不变，未出现第二套日志入口。
3. 既有 `plugin-protocol` 外部协议与 connect session 行为不回归。
4. 既有 appmsg 收发联调不回归。

---

## 9. 本次明确不做

以下内容本次明确排除，谁都不要顺手加：

- 消息明细页
- 未读计数真值
- 已读回执
- 删除消息
- 重发消息
- 搜索消息正文
- 对外第三方 `appmsg.count`
- 对外第三方 owner diagnostics 能力
- 通过 connect session 反推 origin 目录
- 第二套消息专用日志数据库

本次只做：

- 系统级日志可追溯
- 系统级连接与数量诊断
- owner 级 origin 汇总真值
- 系统菜单正式入口
