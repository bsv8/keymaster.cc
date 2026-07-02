# 002 protocol appmsg 应用消息总线 + 插件端点统一地址模型硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/topbar.ts`
- `packages/contracts/src/messageBus.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-apps/src/manifest.ts`
- `packages/plugin-apps/src/AppsPage.tsx`
- `apps/web/src/bootstrapPlugins.ts`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `施工单/2026-06-28/001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md`
- `施工单/2026-06-28/002-protocol-business-methods-bind-connect-session-hard-switch.md`
- `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
- `施工单/2026-06-30/002-launcher-popup-unified-owner-runtime-hard-switch.md`
- `../HubMsg/docs/hubmsg-appmsg-v1-requirements.md`
- `../HubMsg/施工单/2026-07-01/001-hubmsg-appmsg-v1-hard-switch.md`

发生冲突时：

1. 本单关于 `appmsg.*`、统一地址模型、插件端点、`appmsg.client` 的定义优先。
2. 既有 `connectSessionId + ownerPublicKeyHex + exact origin` 的 session 真值继续有效；本单只是在其上新增“应用消息总线”能力，不重写 connect 体系。
3. 后续若再改地址模型、插件端点模型、对外 `appmsg.*` 方法族，必须先改本单与 HubMsg 需求文档，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是“给 `protocolService` 临时塞 3 个消息方法”的局部补丁，也不是“先只让外部 app 用，插件以后再说”的过渡方案。

本单定义的是一次**硬切换统一模型**：

- Keymaster 对外协议新增 `appmsg.send` / `appmsg.list` / `appmsg.get`；
- 这些方法成为外部 client web app 可调用的正式能力；
- Keymaster 内部插件也可使用同一条应用消息总线；
- 外部 app 与内部插件共用同一套**收件地址模型**；
- 地址隔离单位从“只有 owner”升级为“owner + 应用端点”；
- 对外 app 端点真值是 `exact origin`；
- 内部插件端点真值是稳定 `pluginEndpointId`；
- 底层远端承载统一收口为 HubMsg 单 WSS 服务；
- `protocolService` 是外部协议适配层，不承担 HubMsg 连接真值；
- HubMsg 连接、缓存、推送、订阅逻辑收口到独立平台能力，不和 popup UI / 命令流历史 / auth owner 逻辑缠在一起。

本单目标不是“再造一个远端版 runtime.messageBus”，而是给 app 与插件增加一条**跨 owner、跨 endpoint、按收件地址隔离**的最小应用消息总线。

---

## 2. 简述缘由

### 2.1 只按 owner 做 inbox，不足以支持应用隔离

你已经明确：

- `justnote` 可以给 `publickeyA` 的 `justnote` 发消息；
- `justnote` 也可以给 `publickeyA` 的 `demo` 发消息；
- `publickeyA` 侧的 `justnote` 只能看自己的消息，不能看到 `demo` 的消息。

这意味着 inbox 真值绝不能只做到：

```txt
recipient = ownerPublicKeyHex
```

必须升级为：

```txt
recipient = ownerPublicKeyHex + 应用端点
```

否则不同 app 的消息一定串库。

### 2.2 只用 origin 也不够，因为插件也要进同一条总线

如果这次只把消息总线设计成：

```txt
ownerPublicKeyHex + exact origin
```

那外部 app 场景能工作，但插件场景立刻缺真值：

- 插件不是浏览器站点；
- 插件没有 `window.origin`；
- 插件不能靠 fake origin 区分自己；
- 插件如果复用 manifest id，又会把“本地插件 id”和“远端应用端点 id”混成一层。

所以本次必须一次性把地址模型收口为：

```txt
ownerPublicKeyHex + endpoint(kind, id)
```

其中：

- `kind = "origin"` 时，`id = exact origin`
- `kind = "plugin"` 时，`id = pluginEndpointId`

### 2.3 protocolService 是对外适配层，不应成为 HubMsg 连接真值层

当前 `protocolService` 已经承载：

- connect session
- auth owner 仲裁
- popup feed 历史
- per-origin settings
- appView 启动 / launcher bootstrap
- owner runtime 解析

如果再把：

- HubMsg WSS 连接管理
- 远端消息缓存
- 插件端点收件逻辑
- 全局消息推送分发

全部直接塞进 `protocolService`，结果一定是：

- popup 对外适配逻辑与平台消息总线逻辑强耦合；
- app 场景和插件场景被迫混写在一个大 service 里；
- 后续任何消息能力演进都要穿过 protocol popup 层。

这与项目“简单优先、单真值、少分叉”的原则相冲突。

### 2.4 最合理的分层是“内部 appmsg 能力 + 外部 protocol 适配”

因此本次应当明确：

- **对外看**：`protocolService` 新增 `appmsg.*`
- **对内看**：新增独立平台能力（建议由 `plugin-appmsg` 提供）
- `protocolService` 依赖该能力并做 origin -> app endpoint 映射
- 插件直接依赖该能力或它的 scoped client

这样后续无论：

- 插件收消息
- app 收消息
- 首页 widget 提示
- Topbar 红点
- 外部 app dirty event

都只走一套平台真值，不需要在 `protocolService` 里偷偷复制第二套模型。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. Keymaster 对外协议新增 `appmsg.send` / `appmsg.list` / `appmsg.get`。
2. 外部 app 调用 `appmsg.*` 时，sender 真值自动绑定到 `connectSessionId` 对应的 owner 与当前 exact origin。
3. exact origin 的真值包含 `scheme + host + port`；端口是 origin 的一部分，不允许丢。
4. 内部插件也能使用同一条应用消息总线，但 sender 真值绑定为声明在插件 manifest 中的稳定 `pluginEndpointId`。
5. 外部 app 与内部插件共用同一套统一地址模型：
   - `ownerPublicKeyHex + endpoint(kind, id)`。
6. `protocolService` 不直接持有 HubMsg 的全局连接真值；HubMsg 连接与缓存能力收口到独立平台能力。
7. 新增平台能力后，`protocolService` 成为该能力的**外部协议适配层**，插件成为该能力的**内部调用方**。
8. 外部 app 默认只能读取“自己这个 endpoint”的 inbox/sent，不得读取其他 app 或插件 endpoint 的消息。
9. 插件默认只能读取“自己这个 pluginEndpointId”的 inbox/sent，不得读取其他插件 endpoint 或外部 app endpoint 的消息。
10. HubMsg 侧推到 Keymaster 的完整消息事件由平台能力先落本地缓存；对外 app 先只收到 `appmsg.inbox_dirty` 类 dirty event，不直接把完整消息正文当成外部唯一真值。
11. `appmsg.*` 的 v1 只支持 `text/plain` 与 `text/markdown`。
12. v1 不做未读计数真值、不做已读回执、不做群聊、不做附件、不做撤回、不做跨节点 session 恢复。

---

## 4. 单真值定义

> 本段是本次硬切换的术语与行为单真值。后续实现、联调、验收都按这里，不允许口头漂移。

### 4.1 统一收件地址

本次固定：

```txt
AppMsgAddress
  = ownerPublicKeyHex + endpoint
```

其中：

```txt
endpoint
  = { kind: "origin", id: exactOrigin }
  | { kind: "plugin", id: pluginEndpointId }
```

关键约束：

1. `ownerPublicKeyHex` 仍是 owner 根身份真值。
2. endpoint 是第二维隔离真值，没有这一维就不允许实现 inbox。
3. 不允许存在第三种 `kind`。

### 4.2 exact origin

本次固定：

```txt
exact origin
  = scheme + host + port
```

示例：

```txt
https://justnote.example:443
http://localhost:5173
https://demo.example:8443
```

关键约束：

1. port 是 exact origin 的组成部分。
2. 不做 host-only 归一化。
3. 不做“443 可省略后视为同一个 origin”的二次平台归一化；按浏览器 transport 真值走。

### 4.3 pluginEndpointId

本次固定：

```txt
pluginEndpointId
  = 插件声明的稳定应用消息端点 id
```

示例：

```txt
keymaster.message
keymaster.contacts
```

关键约束：

1. **不要**把这个字段叫 `keyId` / `keyid`；`keyId` 在平台里已有 Vault 私钥句柄语义。
2. **不要**默认把它等同于 manifest id。
3. `pluginEndpointId` 必须全局唯一。
4. `pluginEndpointId` 是远端消息地址语义，不是本地 plugin host 注册 id。

### 4.4 外部 app sender 真值

本次固定：

```txt
senderOwnerPublicKeyHex
  = connectSessionId 绑定 owner

senderEndpoint
  = { kind: "origin", id: currentExactOrigin }
```

关键约束：

1. 外部 app 不允许自报 sender owner。
2. 外部 app 不允许自报 sender endpoint。
3. 任何 `fromPublicKeyHex` / `fromOrigin` / `fromAppId` 风格字段都不能进入对外 `appmsg.send` 参数。

### 4.5 插件 sender 真值

本次固定：

```txt
senderOwnerPublicKeyHex
  = 当前插件运行上下文绑定 owner

senderEndpoint
  = { kind: "plugin", id: pluginEndpointId }
```

关键约束：

1. 插件也不允许自报 sender endpoint。
2. sender endpoint 必须来自 manifest 声明并由 runtime 注入。
3. 插件如未声明 `pluginEndpointId`，则不拥有应用消息发送能力。

### 4.6 平台能力分层

本次固定：

```txt
HubMsg WSS 连接与缓存真值
  = 内部平台能力

protocolService
  = 外部 app 协议适配层

插件
  = 内部平台能力消费者
```

建议能力划分：

```txt
appmsg.core
  = 平台单例真值层

appmsg.client
  = 面向插件的 scoped client

protocol.service
  = 面向外部 app 的 popup / appView 协议适配层
```

关键约束：

1. 不允许让插件伪造外部 `request` 来绕过内部能力。
2. 不允许把 HubMsg 连接真值直接塞进 `protocolService` 作为第二份平台状态。

### 4.7 外部实时提示

本次固定：

```txt
v1 对外 event
  = appmsg.inbox_dirty
```

关键约束：

1. 外部 app 先只收到 dirty event，不直接把完整消息正文作为对外 event 真值。
2. 正文真值仍然来自 `appmsg.list/get`。
3. 内部平台可以先拿到完整消息并写本地缓存；这是内部实现真值，不等于外部 event 真值。

---

## 5. 怎么做

### 一、contracts 层新增 appmsg 契约

在 `packages/contracts` 中新增应用消息总线契约，建议新文件：

- `packages/contracts/src/appmsg.ts`

至少定义：

- `AppMsgEndpoint`
- `AppMsgAddress`
- `AppMsgContentType`
- `AppMsgMessage`
- `AppMsgSendParams`
- `AppMsgListParams`
- `AppMsgGetParams`
- `AppMsgSendResult`
- `AppMsgListResult`
- `AppMsgGetResult`
- `AppMsgDirtyEvent`
- `APPMESSAGE_CORE_CAPABILITY`
- `APPMESSAGE_CLIENT_CAPABILITY`

要求：

1. `contentType` v1 只允许 `text/plain` 与 `text/markdown`。
2. message 真值必须包含 sender/recipient 两侧完整地址。
3. endpoint 明确区分 `origin` 与 `plugin`。

### 二、protocol contract 增加对外 appmsg 方法

在 `packages/contracts/src/protocol.ts` 中：

- `PROTOCOL_METHODS` 新增：
  - `appmsg.send`
  - `appmsg.list`
  - `appmsg.get`
- `MethodParams` / `MethodResult` 新增对应映射
- 顶层 transport 新增对外 `event` 消息契约
- 新增 `appmsg.inbox_dirty` 事件数据类型

要求：

1. `appmsg.*` 与 `storage.*` 一样属于 session-bound 外部业务方法；
2. 强制要求 `connectSessionId`；
3. sender 相关字段不进入对外 params。

### 三、plugin manifest 新增插件消息端点声明

在 `packages/contracts/src/plugin.ts` 中为 manifest 增加可选字段，建议形状：

```txt
appMessageEndpoint?: {
  endpointId: string;
  description?: string;
}
```

要求：

1. endpointId 全局唯一；
2. endpointId 不等于 keyId；
3. endpointId 不要求等于 manifest id；
4. runtime 在注册阶段做唯一性校验，冲突即 fail-closed。

### 四、新增平台插件 appmsg

建议新增平台插件：

```txt
packages/plugin-appmsg
```

职责：

- 与 HubMsg 建立 WSS 连接；
- 绑定当前 owner；
- 管理本地缓存；
- 按 endpoint 分发 inbox/sent；
- 向外提供 `appmsg.core`；
- 给声明了 `appMessageEndpoint` 的插件注入 scoped `appmsg.client`；
- 向 `protocolService` 提供面向 origin endpoint 的适配接口。

关键约束：

1. `plugin-appmsg` 是平台层，不是业务插件；
2. HubMsg 连接与缓存真值在这里，不在 `protocolService`。

### 五、protocolService 适配外部 appmsg

在 `packages/plugin-protocol/src/protocolService.ts` 中：

- 新增 `appmsg.send/list/get` 分发；
- accept 阶段继续校验 `connectSessionId` 真值；
- 执行阶段把当前 session 投影成：
  - `senderOwnerPublicKeyHex`
  - `senderEndpoint = { kind: "origin", id: exact origin }`
- 调 `appmsg.core` 或其 origin-adapter 执行；
- 新增 `appmsg.inbox_dirty` 对外 event 推送路径。

要求：

1. 外部 app 不能指定 sender endpoint；
2. `appmsg.list/get` 只看当前 exact origin 对应 endpoint；
3. `appmsg.inbox_dirty` 只能发给当前 endpoint 对应的 caller；
4. `appmsg.*` 不参与 popup 命令流 confirm UI，v1 走自动执行。

### 六、插件侧消费模型

对于声明了 `appMessageEndpoint` 的插件：

- runtime 在 setup context 中注入 scoped `appmsg.client`
- sender endpoint 自动绑定到 manifest 声明的 `pluginEndpointId`
- 插件调用时只传 recipient 与消息内容，不得传 sender endpoint

要求：

1. 插件未声明 endpoint，则拿不到 `appmsg.client`；
2. 插件声明 endpoint 后，host 负责校验唯一性与注入；
3. 不要求插件自己手工拼 sender endpoint。

### 七、本地缓存与 Topbar / widget

平台层需要本地缓存，至少满足：

- 最近消息列表
- 断线重连后补拉
- dirty event 收到后页面可快速刷新

是否做全局未读真值：

- v1 **不做**

可做：

- Topbar 红点
- 首页 widget
- 插件页面即时刷新

但这些都是 UI 投影，不是服务器未读真值。

---

## 6. 不能怎么做

1. 不能把应用隔离真值只做成 `ownerPublicKeyHex`。
2. 不能把插件端点字段命名成 `keyId` / `keyid`。
3. 不能让外部 app 自报 sender origin / sender owner。
4. 不能让插件自报任意 sender endpoint。
5. 不能把 HubMsg 连接逻辑整坨塞进 `protocolService` 当第二份平台状态。
6. 不能只支持外部 app，不同时定义插件端点模型；否则后续一定分叉。
7. 不能把 `manifest.id` 直接当成远端消息端点唯一真值。
8. 不能把对外 event 先设计成完整消息正文唯一真值，再让 `list/get` 变成旁路；v1 对外先只做 dirty。
9. 不能默认所有 connect 站点都拥有等价的消息总线能力而没有后续能力治理空间；本次 contract 与实现必须保留可扩展的 capability 闸门。

---

## 7. 验收标准

### 一、地址与隔离

- [ ] `justnote` 可以给 `publickeyA + exact justnote origin` 发消息。
- [ ] `justnote` 可以给 `publickeyA + exact demo origin` 发消息。
- [ ] `justnote` 无法在 `appmsg.list/get` 中看到 `demo` endpoint 的 inbox。
- [ ] `keymaster.message` 插件可以给 `publickeyA + exact justnote origin` 发消息。
- [ ] `keymaster.message` 插件无法读取 `keymaster.contacts` endpoint 的 inbox。

### 二、sender 真值

- [ ] 外部 app 发送时，sender owner 来自 session，sender endpoint 来自 exact origin。
- [ ] 插件发送时，sender endpoint 来自 manifest 声明的 `pluginEndpointId`。
- [ ] 任意伪造 sender 字段的请求都会被忽略或拒绝。

### 三、平台分层

- [ ] HubMsg 连接与缓存不驻留在 `protocolService` 本体里。
- [ ] `protocolService` 通过内部平台能力暴露 `appmsg.*`。
- [ ] 插件不需要伪造外部 popup request 即可发/列/取消息。

### 四、实时提示

- [ ] HubMsg 新消息到达后，内部平台先落本地缓存。
- [ ] 对外 app 能收到 `appmsg.inbox_dirty` event。
- [ ] 外部 app 通过 `appmsg.list/get` 拿正文，不需要依赖 push 正文作为唯一真值。

### 五、端点声明

- [ ] `pluginEndpointId` 冲突时，runtime 注册直接失败。
- [ ] 未声明 endpoint 的插件拿不到 `appmsg.client`。
- [ ] endpoint id 形如 `keymaster.message`，不与 manifest id / keyId 语义混淆。

