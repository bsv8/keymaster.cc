# 003 runtime scoped `appmsg.client` 随 active key / vault 状态重建硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下列现状文件为准：

- `packages/runtime/src/createPluginHost.ts`
- `packages/runtime/src/createPluginHost.test.ts`
- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/keyspace.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-message/src/manifest.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-message/src/MessageDetailPage.tsx`
- `施工单/2026-07-03/002-message-route-and-hubmsg-boundary-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“scoped `appmsg.client` 的 sender owner 必须随 runtime 当前 active key 同步重建”的定义优先。
2. 旧设计里凡是把 scoped `appmsg.client` 当成“enable 时注入一次即可长期有效”的描述，本次全部失效。
3. 本次问题 owner 固定在 runtime，不允许把根因转嫁给 `plugin-message`、`message.service` 或 `plugin-appmsg` 发送时兜底。

---

## 1. 文档定位

这不是一条“消息发送报错修复小补丁”，而是一次 **runtime 生命周期真值修正硬切换**。

当前问题的本质不是：

- `plugin-message` 发错了参数
- `recipientPublicKeyHex` 不合法
- `appmsg.core` 校验过严

而是：

- runtime 在 plugin `enable` 完成后，只给声明了 `appMessageEndpoint` 的插件注入**一次** scoped `appmsg.client`
- 这个 client 把当时的 `senderPublicKeyHex` 固化住
- 后续 active key 变化时，runtime **没有重建它**
- 结果插件页面继续拿着旧 owner 的 scoped client 发消息
- `appmsg.core` 当前已经 bind 到新 owner，于是硬拒绝：
  `senderPublicKeyHex mismatch`

所以这次必须硬切换成：

- scoped `appmsg.client` 不再是“enable 时一次性产物”
- 它必须成为一个**随 runtime owner 真值变化而重建的 capability**

---

## 2. 简述缘由

### 2.1 当前 bug 根因在 runtime，不在消息业务页

报错现象发生在 `/messages` 发送时，但错不在 `plugin-message`。

`plugin-message` 现在做的事情是合理的：

- 从 capability bus 读 `message.appmsg.client`
- 调 `sendMessage(...)`

真正出错的是 runtime 提供给它的 client 已经过期。

也就是说：

- 页面只是“使用者”
- runtime 才是“过期能力的提供者”

如果不在 runtime 修，后面任何声明了 `appMessageEndpoint` 的插件，只要依赖 sender 固化 owner，都有同类隐患。

### 2.2 scoped client 的 owner 不能在 enable 时一次性冻结

`AppMsgSimpleClient` 的 sender 投影设计本身没错，错的是它被 runtime 当成了静态资源。

但 owner/publicKey 是运行期真值，不是安装时真值，也不是插件 enable 时真值。

运行期里下面这些事件都会改变 sender owner：

- active key 切换
- vault 锁定后重新解锁
- 首次解锁后拿到第一把 active key
- 删除当前 active key 后切到另一把 key

只要这些事件发生，scoped client 就必须同步刷新。

### 2.3 不能把 mismatch 错误当成页面层可恢复问题

这个错误不是“让用户重试一下”就该接受的边缘失败。

因为它体现的是：

- runtime capability bus 提供了**错误真值**

只要 capability bus 上挂的是旧 owner client，页面、service、业务插件就都在错误前提上工作。

这不是 UI 层该兜底的事情，必须从 runtime capability 生命周期上修正。

### 2.4 不能继续让插件自己猜 owner

一个看似简单但方向错误的做法是：

- `plugin-message` 每次发送前自己去 `keyspace.active()` 取 owner
- 然后自己构造一个新的 sender

这会直接破坏边界：

- sender 投影本来应由 runtime 注入固化
- 插件不该自己拼 sender / endpoint / owner

一旦这么做，就等于把 runtime 的能力装配问题重新泄漏给业务插件。

---

## 3. 本次硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. 所有声明了 `manifest.appMessageEndpoint` 的已启用插件，其 scoped `appmsg.client` 都随当前 active key / vault 状态保持同步。
2. active key 变化后，不需要刷新页面、不需要重启应用、不需要 disable/enable 插件，发送路径即可自动切到新 owner。
3. vault 锁定后，旧 owner 的 scoped `appmsg.client` 不再继续留在 capability bus 上冒充可用。
4. vault 重新解锁后，runtime 会按当前 active key 重新注入新的 scoped `appmsg.client`。
5. `plugin-message`、以及未来任何其它声明 `appMessageEndpoint` 的插件，都无需自己感知 owner 变化。
6. `appmsg.core: senderPublicKeyHex mismatch` 不应再由“切 key 后的过期 scoped client”触发。
7. scoped `appmsg.client` 的生命周期真值完全归 runtime 管理。
8. 本次不引入双轨注入、不引入兼容旧 client 包装、不保留“旧 client 先用着”的中间态。

---

## 4. 单真值定义

### 4.1 scoped `appmsg.client` 的 owner 真值

本次固定：

```txt
scoped appmsg.client 的 senderPublicKeyHex
  = runtime 当前可用 active key 的 publicKeyHex
```

这里的“当前可用”指：

- vault 已解锁
- keyspace 当前存在 active key

不是：

- plugin enable 当时的 key
- 上一次解锁时的 key
- 页面 mount 时的 key

### 4.2 scoped `appmsg.client` 的注入真值

本次固定：

- scoped client 由 runtime 负责创建、覆盖、撤销
- 它是 capability bus 上的**运行期资源**
- 它必须随运行期 owner 真值变化而变化

不是：

- 只在 enable 时建一次的静态对象

### 4.3 插件 sender 边界

本次固定：

- 插件仍然只声明 `manifest.appMessageEndpoint.endpointId`
- sender owner 不由插件自己决定
- sender owner 由 runtime 在注入 scoped client 时绑定

插件**不能**：

- 读 keyspace 自己拼 sender
- 越过 runtime 自己调 `createMessageScopedClient(...)`
- 缓存一份旧 client 后长期自用

### 4.4 错误真值边界

本次固定：

- `senderPublicKeyHex mismatch` 是 runtime / capability 生命周期错误，不是消息业务错误
- 修复目标是让这类错误不再因为“旧 scoped client”出现

它**不**应该被：

- 页面吞掉
- `message.service` 转成更模糊的提示
- `appmsg.core` 放宽校验来掩盖

---

## 5. 必须怎么做

### 5.1 runtime 必须监听 owner 真值变化并刷新 scoped client

`createPluginHost` 必须在 host 生命周期内订阅 owner 真值变化，至少覆盖：

1. `keyspace.onActiveChange(...)`
2. 如当前 runtime 可拿到 vault 状态变化，也要覆盖 vault 锁定 / 解锁

一旦这些事件触发，runtime 必须执行统一的 scoped client 刷新流程：

1. 遍历所有已启用且声明了 `appMessageEndpoint` 的插件
2. 重新计算当前 owner publicKeyHex
3. 重新创建 scoped client
4. 覆盖原有 `<pluginId>.appmsg.client` capability

### 5.2 scoped client 刷新必须是“覆盖”，不是并存

本次固定：

- 同一个插件任一时刻只有一个 `<pluginId>.appmsg.client`
- 新 owner 到来时，用新的覆盖旧的
- 不保留“上一把 key 的 client”作为兼容路径

这很重要，因为双 client 并存会让调用方重新猜“我应该拿哪个”。

### 5.3 vault 锁定时必须撤销或失效化 scoped client

当 vault 锁定或当前没有 active key 时，runtime 不能继续让旧 owner 的 client 挂着。

本次建议固定行为：

- **直接 revoke `<pluginId>.appmsg.client`**

原因：

- 语义最清楚
- 与 `plugin-message` 现在“capability 缺失 → 空态 / not ready”的路径天然对齐
- 不会冒出“client 还在，但 sender 是旧 key”这种危险假象

不建议：

- 注入一个 sender 为空串的“假 client”

因为这会制造第二种“看起来有 capability，实际上不能用”的模糊状态。

### 5.4 解锁后必须自动恢复 scoped client

vault 解锁且 active key 可用后，runtime 必须自动重新注入 scoped client。

插件页面不需要刷新，不需要 remount，不需要重新 setup。

也就是说：

- `message.service` 按当前 capability bus 重新 `ctx.get(...)`
- 立刻拿到新的 scoped client

### 5.5 `plugin-message` 不改 owner 逻辑

`plugin-message` 和 `message.service` 本次不应被要求：

- 自己监听 active key
- 自己重建 scoped client
- 自己处理 mismatch 重试

它们现在的模型是对的：

- 每次调用时从 capability bus 取当前 client

真正缺的是 runtime 没把 capability bus 上的值保持最新。

### 5.6 测试必须覆盖“切 key 后直接发送”

本次必须新增或改写 runtime 级测试，明确验证：

1. 插件 enable 后，先注入第一把 key 的 scoped client
2. active key 切换
3. 不刷新 host、不重建 plugin
4. capability bus 上的 scoped client 已切到新 owner
5. 调 `sendMessage(...)` 时不再命中旧 owner mismatch

这是本次最核心的验收路径。

---

## 6. 不能怎么做

### 6.1 不能要求用户刷新页面或重启应用

不允许把下面这些当“正式解决方案”：

- 刷新浏览器页面
- 重启应用
- disable 再 enable 插件
- 手动切回旧 key 再切回来

这些最多是排障动作，不是设计解。

### 6.2 不能在 `plugin-message` 里自己拼 sender

不允许：

- `plugin-message` 自己读 `keyspace.active()`
- `message.service` 自己记一份 owner
- 页面层自己构造 sender 投影

否则 runtime 边界会重新散掉。

### 6.3 不能放宽 `appmsg.core` 的 mismatch 校验

不允许为了“让发送先过”而把下面这层校验改松：

- `input.senderPublicKeyHex !== currentBoundOwner`

这条校验是正确的，它在帮助我们发现 runtime 能力过期。

本次要修的是上游 capability 生命周期，不是下游 ACL 校验。

### 6.4 不能保留旧 owner client 作为兼容尾巴

不允许：

- active key 变化后同时保留新旧两份 scoped client
- 在 client 内部“懒判断当前 owner 再切”
- 继续让旧 client 活着，等业务失败再说

这只会把错误时机从“注入期”拖到“业务期”。

### 6.5 不能把 vault 锁定态伪装成 sender 空串可发送

不允许：

- sender 为空串但 capability 仍然可用
- 页面还能点发送，然后走到更下层才失败

锁定态的正确语义应该是：

- scoped client 不可用

这样上层页面才有稳定的“未就绪”判断。

---

## 7. 特殊情况提前约定

### 7.1 首次启动时 vault 尚未解锁

处理方式：

- runtime 不注入 scoped `appmsg.client`
- 业务插件页面显示 capability 缺失 / not ready 空态
- 解锁后 runtime 自动注入

### 7.2 active key 从 A 切到 B

处理方式：

- runtime 收到 `keyspace.onActiveChange`
- 先撤销旧 `message.appmsg.client`
- 再注入新 `message.appmsg.client`
- 之后页面直接发送，sender 已是 B

不允许继续沿用 A 的 client。

### 7.3 active key 被删除导致暂时没有 key

处理方式：

- runtime 撤销 scoped client
- 业务插件进入未就绪态
- 后续如果用户选择了新的 active key，再重新注入

### 7.4 vault 从解锁变回锁定

处理方式：

- runtime 撤销所有带 owner sender 的 scoped `appmsg.client`
- 页面不能继续拿旧 sender 发消息

### 7.5 `appmsg.core` capability 暂时缺失

处理方式：

- runtime 不注入 scoped client
- 已有 scoped client 也应撤销
- 页面走未就绪态

不能继续保留最后一次构造成功的旧 client。

### 7.6 plugin disable / unregister

处理方式：

- 原有 disable / unregister 路径继续生效
- `<pluginId>.appmsg.client` 仍由 ownership 回收
- runtime 后续 owner 变化不再尝试给已 disabled plugin 重建 client

### 7.7 同时有多个声明 `appMessageEndpoint` 的插件

处理方式：

- runtime 统一批量刷新
- 每个 plugin 都按自己的 `endpointId` + 当前 owner 重建
- 某个 plugin 重建失败不应阻塞其它 plugin 的 scoped client 刷新

但失败必须进入 host 状态或日志，不能静默吞掉。

---

## 8. 文件级实施清单

以下清单按“该文件本次应该承担什么改动”给出。

### 8.1 runtime

- `packages/runtime/src/createPluginHost.ts`
  - 抽出 scoped `appmsg.client` 注入 helper，不再把逻辑只埋在 enable 分支里。
  - 新增“刷新所有已启用 endpoint 插件 scoped client”的统一函数。
  - 订阅 `keyspace.onActiveChange(...)`。
  - 如可行，订阅 vault 状态变化；锁定 / 解锁时同样刷新 scoped client。
  - 当 owner 不可用或 `appmsg.core` 不可用时，撤销对应 `<pluginId>.appmsg.client` capability。
  - 当 owner 可用时，重建并覆盖 `<pluginId>.appmsg.client` capability。
  - 保持 disable / unregister 的 ownership 回收语义不变。

- `packages/runtime/src/createPluginHost.test.ts`
  - 新增“enable 后切 key，scoped client 自动刷新”的测试。
  - 新增“vault 锁定时 scoped client 被撤销，解锁后恢复”的测试。
  - 新增“active key 清空时 scoped client 不存在”的测试。
  - 新增“多个 endpoint 插件同时随 owner 刷新”的测试。
  - 现有 `injects scoped client into <pluginId>.appmsg.client on enable` 测试继续保留，但不再把 enable 当作唯一注入时机。

### 8.2 contracts

- `packages/contracts/src/plugin.ts`
  - 注释明确：`appMessageEndpoint` 产出的 scoped client 是**运行期随 owner 刷新**的能力，不是 enable 时静态快照。

- `packages/contracts/src/appmsg.ts`
  - 注释明确：`createMessageScopedClient(...)` 仍由 runtime 间接消费，但 runtime 必须在 owner 真值变化时重建对外 scoped capability。

### 8.3 `plugin-message`

- `packages/plugin-message/src/messageService.ts`
  - 不改业务模型，只更新注释：
    - service 依赖 runtime 维护 scoped client 最新真值
    - 当前未就绪时 capability 缺失是正常态

- `packages/plugin-message/src/manifest.ts`
  - 不改 owner 逻辑
  - 注释补清：`ctx.get("<pluginId>.appmsg.client")` 拿到的是 runtime 维护的“当前 owner” scoped client

- `packages/plugin-message/src/MessagePage.tsx`
  - 不增加任何 owner 监听或重建逻辑
  - 如有必要，只根据 capability 是否存在显示未就绪态

- `packages/plugin-message/src/MessageDetailPage.tsx`
  - 同上，不引入 owner 层逻辑

### 8.4 `plugin-appmsg`

- `packages/plugin-appmsg/src/appmsgCore.ts`
  - 业务逻辑原则上不改
  - 保持 `senderPublicKeyHex mismatch` 校验
  - 新增或保留测试，证明 mismatch 只用于真正越权，而不是 runtime 注入过期

---

## 9. 最终验收清单

以下清单全部满足，才算本次硬切换完成。

### 9.1 核心运行期行为

- 应用启动、plugin 已 enable、vault 解锁、active key = A 时，`message.appmsg.client` 已存在。
- 不刷新页面，把 active key 从 A 切到 B 后，`message.appmsg.client` 自动更新。
- 切 key 后立刻在 `/messages` 发送，不再出现 `senderPublicKeyHex mismatch`。
- 切 key 后消息发送实际使用的新 sender owner 是 B。

### 9.2 锁定 / 解锁行为

- vault 锁定后，`message.appmsg.client` 被撤销或不可用。
- 锁定态 `/messages` 进入未就绪空态，不能继续拿旧 sender 发送。
- vault 重新解锁后，`message.appmsg.client` 自动恢复。

### 9.3 active key 缺失行为

- 当前没有 active key 时，不存在 `message.appmsg.client`。
- 之后一旦 active key 恢复，runtime 自动重新注入。

### 9.4 多插件行为

- 多个声明 `appMessageEndpoint` 的已启用插件，都能随 owner 变化一起刷新 scoped client。
- 其中一个插件刷新失败，不会阻塞其它插件刷新。

### 9.5 边界验证

- `plugin-message` 没有新增自己监听 keyspace / vault 的逻辑。
- `message.service` 没有新增自己拼 sender / owner 的逻辑。
- `appmsg.core` 没有放宽 mismatch 校验。
- runtime 才是 scoped client 生命周期 owner。

### 9.6 测试验收

- `createPluginHost` 新增的 owner 刷新测试通过。
- `createPluginHost` 新增的锁定 / 解锁测试通过。
- `createPluginHost` 新增的 active key 清空测试通过。
- 现有 appmsg scoped client 注入测试继续通过。
- `plugin-message` 现有页面 / service 测试继续通过，不需要为 owner 切换额外加业务层补丁测试。

---

## 10. 一句话结论

这次不是修“消息页发送失败”，而是修：

```txt
runtime 提供了过期的 scoped appmsg.client
```

硬切换后的唯一正确模型是：

```txt
active key / vault 状态变
  -> runtime 刷新 scoped capability
  -> 业务插件无感拿到最新 client
  -> appmsg.core 继续严格校验
```

只要 scoped `appmsg.client` 还停留在“enable 时注入一次”的旧模型，这个问题就不算真正修掉。
