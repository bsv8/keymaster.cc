# 004 `plugin-poker` 跟随 `active key` + 多 Key 生命周期收敛硬切换施工单

## 目标

一次性把当前扑克插件从“独立 `poker identity` 绑定模型”硬切换为“永远跟随平台 `active key` 的单会话模型”：

```txt
身份真值
  = poker identity 不再独立存在
  = 当前 active key 就是唯一扑克身份
  = 不允许在 Poker 设置页再选择另一把 key

会话语义
  = single active key 时，Poker 会话只属于这把 key
  = all 模式时，Poker fail-closed
  = 切 active key 时，旧会话必须收拢，新会话必须按新 key 重建

多 key 生命周期
  = key.created / activeKey.changed / key.deleting / key.deleted / vault.locked
    全部成为 plugin-poker 的一等事件
  = 删除 key 时不只依赖平台删库，扑克自己也要主动清理内存态与连接态

存储分层
  = proxy endpoint / announce endpoint / fallback 开关
    改为全局配置
  = presence / table replay / tx ingest / 桌局缓存
    继续按 key namespace 归属

UI
  = /settings/poker 不再出现“选择 vault key / 绑定 / 解绑”
  = 明确展示“当前 active key 即扑克身份”
  = all 模式、锁定态、删除态都有明确降级行为
```

本次是硬切换，不接受先保留旧 `bindIdentity` API、先做一层兼容 UI、以后再慢慢删的中间态。

## 简述缘由

1. 当前 `plugin-poker` 的协议和实现把“稳定 `poker identity` 独立于 `active key`”当成真值，这在原先阶段是合理的，但已经与新的产品要求正面冲突。
   - 相关契约见 `packages/contracts/src/poker.ts`
   - 相关实现见 `packages/plugin-poker/src/pokerIdentityBinding.ts`
   - 相关测试见 `packages/plugin-poker/src/pokerIdentityBinding.test.ts` 与 `packages/plugin-poker/src/pokerService.test.ts`

2. 现在的交互之所以别扭，不是因为下拉框做得不好，而是因为系统里存在两个身份真值：
   - 平台级 `active key`
   - Poker 私有 `identity binding`

   只要两个真值并存，用户就一定会遇到“当前在 A key 下操作，却还要再给 Poker 选一次 B key”的语义撕裂。

3. 当前 Poker 设置持久化也建立在“身份绑定”之上：`proxyEndpoint`、双平面 announce、fallback 开关都写进了当前绑定 key 的 key-scoped DB。这个结构在“永远跟随 `active key`”下不成立，因为切 key 不应该把网络全局配置一起切掉。
   - 相关实现见 `packages/plugin-poker/src/pokerDb.ts`
   - 相关调用见 `packages/plugin-poker/src/pokerService.ts`

4. 当前 `keyspace` 已经统一管理：
   - `activeKey.changed`
   - `key.deleting`
   - `key.deleted`
   - key-scoped storage 删除

   但 `plugin-poker` 还没有把这些平台事件当成自身会话状态机的主入口。它目前主要依赖“绑定消失时 fail-closed”，这对多 key 生命周期管理是不够的。

5. 删除 key 不能只靠平台删 IndexedDB 名字。因为扑克还持有：
   - websocket 连接
   - reconnect timer
   - intended topic 订阅
   - last presence replay
   - owned table replay
   - 内存中的 presence / table / tx ingest 缓存

   如果不在插件层主动收拢，这些迟到状态会在删除后继续以旧 key 语义运行，造成脏回放、脏重连、脏 UI。

## 硬切换结论

本次统一采用下面这套唯一架构：

```txt
平台身份
  keyspace.active()
    = Poker 唯一身份真值

Poker 会话
  single 模式
    = 用 active key 建立唯一会话

  all 模式
    = fail-closed
    = 不连接
    = 不重连
    = 不允许 publish

  active key 切换
    = teardown old session
    = 清掉 old key 的内存态
    = hydrate new key 的本地状态
    = 如配置允许且 endpoint 完整，则重建连接

存储分层
  全局配置
    = proxyEndpoint
    = announceP2PNodeEndpoint
    = announceTxLinkEndpoint
    = allowFallbackBroadcast

  key-scoped 状态
    = presences
    = tables
    = txIngest
    = replay snapshots
    = 其他明确属于某把 key 的扑克状态

删除语义
  key.deleting
    = 先让 Poker 主动停旧会话、停重连、停写入

  key.deleted
    = 清理残余引用与 UI 悬挂态

  active fallback
    = 由 keyspace 决定下一把 active key
    = Poker 只消费最终 active 结果，不自己发明 fallback 规则
```

本次切换后，必须满足下面的不变量：

1. `plugin-poker` 不再存在独立的“已绑定扑克身份”概念。
2. `active key` 是 Poker 唯一玩家身份来源；不存在第二个可选 key。
3. `active key = all` 时，Poker 一律 fail-closed。
4. 切换 `active key` 时，旧会话必须先断开，再按新 key 重建；不允许会话内隐式漂移身份。
5. 删除 key 时，Poker 必须在 `key.deleting` 阶段主动停止旧 key 的连接态与内存态，不能只等平台删库。
6. 网络配置必须是全局配置，不能继续跟着某把 key 走。
7. key-scoped 状态只能保存明确属于该 key 的扑克数据，不能偷塞全局配置。
8. Poker 设置页不再提供 key 选择器、绑定按钮、解绑按钮。
9. “正在牌桌里时切 key”不是平滑换身份，而是强制收拢旧会话。
10. `plugin-poker` 不自己决定删除后的下一把 key，也不保留“最后一次绑定 key”的回退逻辑。

## 不能怎么做

1. 不能保留 `bindIdentity / unbindIdentity / listIdentityCandidates` 作为“暂时兼容层”，然后内部再偷偷映射到 `active key`。这会留下双真值和旧测试污染。

2. 不能保留 `PokerIdentityBinding` 契约，再只把 UI 隐藏掉。只隐藏 UI 不删除契约，后面实现一定继续分叉。

3. 不能继续把 `proxyEndpoint`、双平面 announce、fallback 开关存进 key-scoped DB。它们是全局网络配置，不属于某把 key。

4. 不能在 `active key` 切换时复用旧 websocket 会话，只改内存里的 `publicKeyHex`。认证、presence、table owner、重连回放都会错。

5. 不能把“桌内切 key”做成隐式平滑换身份。桌主、座位、聊天、公钥身份、回放快照全部会错位。

6. 不能在 `all` 模式下继续保持 ready / reconnecting。`all` 只用于只读总览，不允许承载需要唯一身份的扑克会话。

7. 不能在 `key.deleted` 之后才开始收连接。那时 namespace DB 已进入删除流程，迟到写入和重连会制造竞态。

8. 不能在删除当前 active key 后回退到“上一把绑定 key”或“旧 replay 对应的 key”。唯一 fallback 真值必须来自 `keyspace`。

9. 不能把不同 key 的 replay / presence / table announce 缓存混在一起。重连时只能回放当前 active key 的状态。

10. 不能在 `active key` 变成 `failed`、`uninitialized` 或不存在时悄悄继续用上一次 ready key。必须 fail-closed。

11. 不能只改 `PokerSettingsPage`，不改 service / contracts / tests。这个需求的核心是语义重构，不是 UI 删按钮。

12. 不能让 `packages/plugin-poker/src/pokerIdentity.ts` 继续以“deprecated 壳”长期存在。它现在就是旧模型残留，应在本次硬切换收尾时一并清掉。

## 应该怎么做

### 一、契约层把“独立扑克身份”整体删除

`packages/contracts/src/poker.ts` 需要从契约上切换到“active key 驱动”模型：

1. 删除：
   - `PokerIdentityBinding`
   - `PokerIdentityBindingState`
   - `PokerIdentityCandidate`
   - `getIdentityBinding()`
   - `onIdentityBindingChange(...)`
   - `listIdentityCandidates()`
   - `bindIdentity(...)`
   - `unbindIdentity()`

2. 新增或改名为更准确的会话入口：
   - `getActivePokerKey(): KeyIdentity | null`
   - `onActivePokerKeyChange(...)`
   - 如需暴露只读状态，可增加 `PokerSessionKeyState`

3. 契约注释必须明确写死：
   - Poker 身份始终取自 `keyspace.active()`
   - `all` 模式 / 锁定态 / 无 active key 时 fail-closed
   - 业务插件不再自行维护第二身份

### 二、服务层改成“active key 驱动会话状态机”

`packages/plugin-poker/src/pokerService.ts` 需要从“binding 驱动”改为“active key 驱动”：

1. 构造时订阅：
   - `keyspace.onActiveChange(...)`
   - `messageBus.subscribe("key.deleting", ...)`
   - `messageBus.subscribe("key.deleted", ...)`
   - `vault.onStatusChange(...)`

2. 内部增加统一原子流程：

```txt
rebindToActiveKey(reason)
  = 读取 keyspace.active()
  = 若不是 single 或 key 不 ready -> teardown + fail-closed
  = 若与当前 session key 相同 -> 只做必要 hydrate / 不重复重连
  = 若不同 -> teardown old -> hydrate new -> 视配置重连
```

3. 把当前这些逻辑整体删除或重写：
   - `identity = createPokerIdentityBinding(...)`
   - 绑定变化触发 disconnect
   - `resolveIdentity()` 走 binding
   - `withStorage()` 走 binding key
   - `hydrateSettingsForCurrentIdentity()`

4. `connect()` 的前置条件改成：
   - vault 已解锁
   - `active key` 是 single 且 ready
   - 全局 endpoint 已配置

5. `ensureReady()` 不再检查 binding，而是检查：
   - 当前 session key 存在
   - 当前 session key 与 `keyspace.active()` 一致
   - 当前状态为 `ready`

6. `handleChallenge()` 使用当前 session key 的 `keyId / publicKeyHex` 签名，不再走 binding resolve。

### 三、存储必须拆成“全局配置”与“按 key 状态”

这是本次最关键的结构调整。

#### 1. 全局配置

下面这些字段必须从 `packages/plugin-poker/src/pokerDb.ts` 的 key-scoped DB 中拆出去：

- `proxyEndpoint`
- `announceP2PNodeEndpoint`
- `announceTxLinkEndpoint`
- `allowFallbackBroadcast`

建议做法：

1. 新增 `packages/plugin-poker/src/pokerGlobalConfig.ts`
2. 使用独立全局存储承载 Poker 全局配置
3. 由 `pokerService` 在启动时读取，在设置页保存时写回

可接受的全局存储形式：

- `localStorage`
- 一个 plugin 级全局 IndexedDB

本次不要求必须抽成通用 runtime config capability，但实现必须明确是“与 key 无关”的全局配置。

#### 2. key-scoped 状态

`packages/plugin-poker/src/pokerDb.ts` 保留为“当前 active key 的扑克本地状态 DB”，只承载：

- `presences`
- `tables`
- `txIngest`
- `lastPresence replay`
- `ownedTablePublishes replay`
- 后续桌局状态缓存

必须删除：

- `identityBinding` store
- 与 identity binding 有关的读写 helper

同时需要升级 schema 设计说明：

1. 老版本若存在 `identityBinding` store，升级后可忽略残留 store，不再读取。
2. 老版本 `settings` 若在 key-scoped DB 里，迁移策略必须明确：
   - 只从“当前 active key 的旧 DB”尝试迁一次到全局配置
   - 迁完后新代码不再回写到 key-scoped settings
   - 不要求跨所有历史 key 扫描合并配置，避免引入“哪把 key 的旧配置才是真值”的新歧义

### 四、Poker 设置页改为“展示 active key，不再选择 key”

`packages/plugin-poker/src/PokerSettingsPage.tsx` 需要切换成下面的唯一交互模型：

1. 显示：
   - 当前连接状态
   - 当前 active key 标签与短公钥
   - 当前是否处于 `all` 模式
   - 当前是否锁定
   - 全局网络配置表单

2. 删除：
   - key 下拉选择器
   - 绑定按钮
   - 解绑按钮
   - “No poker identity bound” 这一类旧文案

3. 改为明确提示：
   - “当前 active key 即扑克身份”
   - “切换 active key 会断开当前 Poker 会话并以新 key 重建”
   - `all` 模式下“请先选择单一 active key”

4. `Connect` 按钮禁用条件改成：
   - 未配置 endpoint
   - vault 锁定
   - 当前不是 single active key
   - active key 还未 ready

### 五、Poker 大厅 / 单桌 / 首页 Widget 都要接上新语义

不是只有设置页要改。

#### `PokerHomeWidget.tsx`

1. 当 `all` 模式时显示只读提示，而不是显示“未绑定”。
2. 当 active key 切换时，Widget 状态必须跟着新 session 走。
3. 若旧 key 正在重连，切到新 key 后不得继续显示旧 key 的在线状态。

#### `PokerLobby.tsx`

1. presences / tables 必须只反映当前 active key 对应会话观察到的数据。
2. 切 key 后旧列表应立即清空或切成新 key hydrate 后的列表，不能短暂显示旧 key 的桌局。

#### `PokerTable.tsx`

1. 若用户正在桌里时切 `active key`，页面不能假装继续停留在同一玩家身份。
2. 合理行为是：
   - 旧订阅断开
   - 页内显示“active key 已变更，旧会话已关闭”
   - 由用户按新身份重新进入

### 六、删除前后钩子必须明确分工

#### `key.deleting`

这是删除前的主清理钩子，`plugin-poker` 必须消费。

若删除的是：

- 当前 session key
- 或当前内存 replay / 缓存归属的 key

必须立即：

1. 取消 reconnect timer
2. 关闭 ws
3. 清空 `intendedSubscriptions`
4. 清空 `lastPresence`
5. 清空 `ownedTablePublishes`
6. 清空 `presences`
7. 清空 `tables`
8. 停止后续向该 key namespace 写入

设计缘由：
删除是平台级最终动作；业务插件不能指望“等库没了再自然失败”。那会产生迟到重连与迟到回放。

#### `key.deleted`

这是删除后的收尾钩子。

需要做：

1. 清掉任何仍指向该 `publicKeyHash` 的残余 session 引用
2. 若当前页面正展示该 key 旧状态，切成空态
3. 等待 `activeKey.changed` 到达后，再按新的 single active key 决定是否重建会话

#### `activeKey.changed`

这是最终会话重建入口，不是 `key.deleted`。

理由：
删当前 key 后，下一把 active key 的选择权在 `keyspace`；Poker 只能消费结果，不能自己猜。

### 七、`all` 模式、锁定态、异常 key 都要 fail-closed

需要明确下面三个状态都不可继续持有活跃扑克会话：

1. `active.mode === "all"`
2. vault `locked`
3. active key `identityStatus !== "ready"`

统一行为：

- 断开连接
- 停止重连
- 不允许 publish
- UI 提示原因

不能出现：

- 表面 disconnected，后台却还在 reconnecting
- 旧 `lastPresence` 继续在内存里等待下一次错误回放

### 八、旧模型相关文件必须收尾删除

本次硬切换不允许留下“以后再删”的旧壳：

1. 删除 `packages/plugin-poker/src/pokerIdentityBinding.ts`
2. 删除 `packages/plugin-poker/src/pokerIdentityBinding.test.ts`
3. 删除 `packages/plugin-poker/src/pokerIdentity.ts`
4. 删除 `pokerDb.ts` 里的 binding 相关 schema / helper
5. 删除契约中 binding 相关导出

若某个旧文件暂时必须保留路径兼容，也只能保留极薄的过渡壳，并在同次提交内把内部实现改成新语义，不能继续保留旧数据模型。

### 九、测试必须整体翻面

当前很多测试在保护旧结论：“binding 不随 active key 漂移”。这些测试在新需求下是错误真值，必须删除或改写。

必须新增的测试包括：

1. `active key = single` 时可 connect/auth/publish
2. `active key = all` 时 connect/publish fail-closed
3. active key 从 `pkhA -> pkhB`：
   - 旧 ws 断开
   - 旧 replay 清理
   - 新 session key 切到 `pkhB`
4. 删除非 active key 不影响当前 Poker 会话
5. 删除当前 active key 时：
   - `key.deleting` 先触发 Poker 清理
   - `key.deleted` 后不再持有旧 key 内存态
   - `activeKey.changed` 到新 key 后能按新 key 重建
6. vault 锁定时清空可见会话态并停止重连
7. active key 变成 `all` 时立即 fail-closed
8. 全局网络配置不随 key 切换丢失
9. key-scoped replay / tx ingest 不会跨 key 串用
10. 正在桌里时切 key，会话被强制收拢而不是静默续用

## 特殊情况提前约定

### 情况 1：用户在 `all` 模式打开 `/settings/poker`

处理原则：

```txt
允许查看配置
不允许建立会话
```

具体行为：

1. 显示全局网络配置表单
2. 显示“当前处于全部 key 模式，Poker 需要单一 active key”
3. `Connect` 按钮禁用

### 情况 2：用户正在桌里时切 `active key`

处理原则：

```txt
强制收拢旧会话
不做桌内平滑换身份
```

具体行为：

1. 立即断开旧桌 topic 订阅
2. 清掉旧玩家身份对应的 replay / presence / owner 态
3. 页面提示“active key 已变更，需以新身份重新进入”

### 情况 3：删除当前 active key

处理原则：

```txt
先清旧会话
再等 keyspace 决定新 active
```

具体行为：

1. `key.deleting` 时立刻 teardown 当前 Poker 会话
2. `key.deleted` 时保持空态
3. 等 `activeKey.changed` 后，若新 key ready 且全局配置完整，则按新 key 自动恢复连接

### 情况 4：删除非当前 active key

处理原则：

```txt
不打断当前会话
只清残余引用
```

具体行为：

1. 如果被删 key 不是当前 session key，则不主动 disconnect 当前会话
2. 但必须删除任何残余缓存引用，避免误把被删 key 的 replay 当未来 active key 使用

### 情况 5：新增 key 后平台把它自动设为 active

处理原则：

```txt
跟随 active key
而不是跟随 key.created
```

具体行为：

1. `key.created` 只作为列表/诊断事件
2. 真正会触发 Poker 会话切换的是后续 `activeKey.changed`

### 情况 6：vault 锁定发生在重连过程中

处理原则：

```txt
锁定优先级高于重连
```

具体行为：

1. 立即取消 reconnect timer
2. 清空当前 session key 可见状态
3. 解锁后重新从 `keyspace.active()` 求值，不恢复旧“绑定身份”

### 情况 7：active key 处于 `failed` / `uninitialized`

处理原则：

```txt
不猜测
不偷用别的 key
直接 fail-closed
```

具体行为：

1. 不连接
2. 不重连
3. UI 明确提示 active key 尚未就绪

### 情况 8：浏览器刷新恢复

处理原则：

```txt
恢复当前 active key 的会话上下文
不恢复旧 binding
```

具体行为：

1. 启动时读取 `keyspace.active()`
2. 读取全局网络配置
3. 只打开当前 active key 的 key-scoped Poker DB
4. 按当前 active key 的 replay / 缓存重建

## 文件级改动清单

### 一、必须修改

1. `packages/contracts/src/poker.ts`
   - 删除 binding 相关契约与注释
   - 改成 active key 驱动语义

2. `packages/contracts/src/index.ts`
   - 同步移除旧导出，导出新契约类型

3. `packages/plugin-poker/src/pokerService.ts`
   - 删除 binding 管理接入
   - 接入 `activeKey.changed / key.deleting / key.deleted / vault status`
   - 改写 connect / ensureReady / replay / hydrate 逻辑

4. `packages/plugin-poker/src/pokerDb.ts`
   - 删除 `identityBinding` store 与 helper
   - 删除 key-scoped settings 真值
   - 收敛为按 key 的扑克状态缓存

5. `packages/plugin-poker/src/PokerSettingsPage.tsx`
   - 移除 key 选择、绑定、解绑
   - 改成展示当前 active key 与全局配置

6. `packages/plugin-poker/src/PokerLobby.tsx`
   - 接上 active key 切换后的空态 / 重建态

7. `packages/plugin-poker/src/PokerTable.tsx`
   - 接上“桌内切 key 强制收拢”提示与行为

8. `packages/plugin-poker/src/widgets/PokerHomeWidget.tsx`
   - 改成 active key 语义与 `all` 模式提示

9. `packages/plugin-poker/src/manifest.ts`
   - 更新 i18n 文案
   - 如有旧 identity 文案注册，全部删除

10. `packages/plugin-poker/src/pokerService.test.ts`
    - 删除旧 binding 相关断言
    - 新增 active key 生命周期测试

11. `packages/plugin-poker/src/styles.css`
    - 清理 identity binding 区块样式
    - 增加 active key 状态提示样式

### 二、必须新增

1. `packages/plugin-poker/src/pokerGlobalConfig.ts`
   - Poker 全局配置读写
   - 设计缘由：网络配置不属于某把 key

2. `packages/plugin-poker/src/pokerGlobalConfig.test.ts`
   - 全局配置持久化与恢复测试

3. `packages/plugin-poker/src/pokerSessionKey.ts`
   - 可选的 session key 解析辅助
   - 设计缘由：把“active key -> Poker session key”的校验集中起来

4. `packages/plugin-poker/src/pokerSessionKey.test.ts`
   - `single / all / failed / uninitialized` 解析测试

### 三、必须删除

1. `packages/plugin-poker/src/pokerIdentityBinding.ts`
2. `packages/plugin-poker/src/pokerIdentityBinding.test.ts`
3. `packages/plugin-poker/src/pokerIdentity.ts`

若删除文件会牵涉 import 路径清理，则相关 import 一并收尾，不保留死代码。

## 最终验收清单

### 一、契约与代码结构

- [ ] `plugin-poker` 不再暴露 `bindIdentity / unbindIdentity / listIdentityCandidates`
- [ ] `contracts/poker.ts` 已明确写成“Poker 身份永远跟随 `active key`”
- [ ] 仓库内不再存在独立 `poker identity binding` 真值实现

### 二、设置与存储

- [ ] `/settings/poker` 不再提供 key 选择器
- [ ] 页面明确展示“当前 active key 即扑克身份”
- [ ] `proxyEndpoint`、双平面 announce、fallback 开关不会因切 key 丢失
- [ ] key-scoped Poker DB 中不再持有全局网络配置真值

### 三、会话语义

- [ ] `single active key` 下可正常 connect/auth/publish
- [ ] `all` 模式下 Poker fail-closed，不连接、不重连、不允许 publish
- [ ] active key 从 A 切到 B 时，旧会话会断开，新会话按 B 重建
- [ ] 不存在“同一 websocket 会话中途换公钥身份继续跑”的行为

### 四、删除与清理

- [ ] 删除非 active key 不会打断当前 Poker 会话
- [ ] 删除当前 active key 时，`key.deleting` 阶段已停止旧会话与旧重连
- [ ] `key.deleted` 后不再残留旧 key 的 replay / presences / tables / tx 缓存引用
- [ ] keyspace 选择新 active key 后，Poker 只按新的 active 结果恢复，不自造 fallback

### 五、特殊场景

- [ ] vault 锁定时，Poker 立即 fail-closed
- [ ] active key `failed` / `uninitialized` 时，Poker 不偷用别的 key
- [ ] 正在桌里切 key 时，会话被强制收拢并提示重新进入
- [ ] 浏览器刷新后，只恢复当前 active key 的会话上下文，不恢复旧 binding

### 六、测试

- [ ] 旧的“binding 不随 active key 漂移”测试已删除或改写
- [ ] 新增 active key 切换、all 模式、删除钩子、全局配置、桌内切 key 等测试
- [ ] `plugin-poker` 所有测试通过，且不会因删除旧 binding 文件而残留编译错误

## 一次性实施要求

本次必须作为一个完整硬切换提交收敛，不能拆成：

1. 先删 UI，后面再删契约
2. 先让 service 兼容两套模型，后面再清旧 binding
3. 先保留 key-scoped settings，后面再做全局配置迁移
4. 先只处理 `activeKey.changed`，后面再补 `key.deleting / key.deleted`

原因很直接：

- 只删 UI 不删契约，会留下隐藏双真值。
- 只改 active 切换不改删除钩子，删除时一定出脏状态。
- 不拆全局配置，跟随 active key 后网络配置一定漂移。
- 保留双模型兼容层，测试和实现会同时保护两套相反结论，后续收尾成本更高。

这次就应该把旧模型一次性清掉，让 Poker 成为真正的平台 `active key` 消费者，而不是继续在平台身份之外再发明一个业务身份系统。
