# 003 keymaster.cc appmsg v1 冻结协议对齐硬切换施工单

## 文档定位

本文是 keymaster 侧与 HubMsg 共同冻结的 **appmsg v1 wire protocol**
对齐施工单。任何 wire / bind 签名 / messageId 编码 / endpoint 作用域
相关改动必须先改本单与 `../HubMsg/施工单/2026-07-01/002-keymaster-
appmsg-v1-frozen-protocol-hard-switch.md`，再改实现 / 测试 / 文档。

本文是 `002-protocol-appmsg-bus-hard-switch.md` 的"对齐版"：在原有
"统一地址模型 + protocolService 适配层 + plugin-appmsg 平台单例"基础
上，把与 HubMsg 的 wire 真值彻底对齐。

---

## 1. 与 `002` 的关系

`002-protocol-appmsg-bus-hard-switch.md` 已经落地的部分（保留）：
- contracts/appmsg.ts 收口地址模型；
- protocol.ts 新增 `appmsg.send/list/get` + `appmsg.inbox_dirty`；
- plugin.ts 新增 `manifest.appMessageEndpoint`；
- plugin-appmsg 平台单例；
- protocolService 新增 `appmsg.*` dispatch + dirty event 推送；
- bootstrap 装配 appmsgPlatformPlugin。

本文落地的整改（必须）：

1. 把 `plugin-appmsg/src/signing.ts` 与 `hubmsgConnection.ts` 的 bind
   拼接 / 签名方式**提取到 contracts 层**，成为两仓共用的纯函数；
   任何 wire 修改必须两仓同时改。
2. `appmsg.core` 的 `list / get` 命名 / 入参语义对齐 HubMsg：
   读取路径携带 `scopeEndpoint` 而不是 `sender`。
3. runtime host `enable` 阶段真正实现：
   - `manifest.appMessageEndpoint.endpointId` 形状与全局唯一性校验；
   - scoped `AppMsgPluginClient` 注入到 `ctx.get("<pluginId>.appmsg.client")`。
   取消"全局工厂 capability + forEndpoint()"作为插件作者最终体验。
4. `messageId` 全链路 string（`afterMessageId` / `beforeMessageId`
   在 wire 上必须是 string，不允许 number）。
5. 增加跨仓联调测试：真连本地 HubMsg，跑地址隔离 / dirty event /
   messageId round-trip。

---

## 2. 共同冻结真值（与 HubMsg 单对齐）

详见 `../HubMsg/施工单/2026-07-01/002-keymaster-appmsg-v1-frozen-protocol-hard-switch.md`
第 2 节。简版：

- bind 签名：`secp256k1 + compact 64-byte r||s + 明文原文 + 分隔符 |`
  - 原文 = `sessionId|nonce|publicKeyHex|issuedAtMs`（UTF-8 字节）。
- `messageId`：DB int64，wire string（十进制无前导零）。
- 连接 owner-bound；endpoint 随业务请求自带（`senderEndpoint` /
  `scopeEndpoint`）。
- 推送：`message.received`（完整 message）；dirty event 由 keymaster
  派生。

---

## 3. keymaster 侧整改项

### 3.1 提取共享 bind 函数到 contracts

新增 `packages/contracts/src/appmsgBind.ts`：

```ts
export function canonicalBindText(
  sessionId: string,
  nonce: string,
  publicKeyHex: string,
  issuedAtMs: number
): string; // sessionId|nonce|publicKeyHex|issuedAtMs
```

- 纯函数；不依赖任何运行时。
- 单元测试覆盖：分隔符、分段顺序、数字格式。
- 在 `packages/contracts/src/index.ts` 导出。
- plugin-appmsg 改用它；HubMsg Go 侧有等价 Go 实现，跨仓用同一份
  fixture 测试用例。

### 3.2 `plugin-appmsg/src/signing.ts`

- 删除独立的 `canonicalBind` 拼接逻辑；改用 `canonicalBindText`。
- `signCompactSecp256k1` 签名 `new TextEncoder().encode(
  canonicalBindText(...) )`；输出 hex。

### 3.3 `plugin-appmsg/src/hubmsgConnection.ts`

- 直接用 `canonicalBindText(...)` 拼原文；保持现有 pipe 分隔。
- 增加单元测试覆盖"bind 失败 → 抛错路径"。

### 3.4 `plugin-appmsg/src/appmsgCore.ts`

入参语义对齐：

```ts
// 旧
list(input: { sender: AppMsgAddress; ... })
get(input: { sender: AppMsgAddress; messageId: string })

// 新
list(input: { scope: AppMsgAddress; ... })    // scope.ownerPublicKeyHex + scope.endpoint
get(input: { scope: AppMsgAddress; messageId: string })

// send 不变：
send(input: { sender: AppMsgAddress; recipient... })
```

`scope` 在 server 端做 ACL：仅当 `(scope.owner, scope.endpoint)`
匹配 sender 或 recipient 之一时返回该 message；否则 `not_found`。

### 3.5 `packages/contracts/src/appmsg.ts`

- `AppMsgCore.list / get` 的入参：`scope: AppMsgAddress`。
- `AppMsgCore.send` 入参不变。
- 在 JSDoc 里写明"`messageId` 全链路 string"。
- 暴露 `AppMsgEndpointAddress` alias。

### 3.6 runtime host 校验与 scoped 注入

在 `packages/runtime/src/createPluginHost.ts`：

```ts
// enable 阶段：
const appMsgEp = record.manifest.appMessageEndpoint;
if (appMsgEp) {
  if (!isValidPluginEndpointIdShape(appMsgEp.endpointId)) {
    throw new Error(`plugin "${pluginId}": appMessageEndpoint.endpointId invalid shape`);
  }
  if (this.appMessageEndpointIds.has(appMsgEp.endpointId)) {
    throw new Error(`plugin "${pluginId}": appMessageEndpoint.endpointId "${appMsgEp.endpointId}" conflict`);
  }
  this.appMessageEndpointIds.add(appMsgEp.endpointId);
}

// disable 阶段：
this.appMessageEndpointIds.delete(appMsgEp.endpointId);
```

scoped client 注入：

```ts
// runSetup 后，appmsg.core 存在时，给该插件注入 scoped client：
const appMsgCore = capabilities.has(APPMESSAGE_CORE_CAPABILITY)
  ? capabilities.get(APPMESSAGE_CORE_CAPABILITY)
  : null;
if (appMsgCore && appMsgEp) {
  capabilities.provide(
    `${pluginId}.appmsg.client`,
    new AppMsgPluginClientImpl(appMsgCore, appMsgEp.endpointId)
  );
}
```

- 单元测试：
  1. endpointId 形状非法 → enable 抛错。
  2. 两个插件声明相同 endpointId → 后者 enable 抛错。
  3. 声明 endpoint 的插件拿到 scoped client；未声明拿不到。
  4. scoped client 的 `senderEndpoint` 固定为 `endpointId`，
     `list / get / send` 调用时不能再被覆盖。

### 3.7 取消"全局工厂 capability"

- `plugin-appmsg/src/manifest.ts` 不再把 `AppMsgPluginClientFactory` 挂
  到 `APPMESSAGE_CLIENT_CAPABILITY`。
- 改成只挂 `APPMESSAGE_CORE_CAPABILITY`；scoped client 由 host 在
  enable 阶段注入到 `<pluginId>.appmsg.client`。
- `AppMsgPluginClientFactory` 类型可以从 contracts 删掉（如果不
  再用）。

### 3.8 `protocolService` 入参对齐

- `protocolService` 对外的 `appmsg.send/list/get` 入参保持：
  - `appmsg.send.params`：`recipientOwnerPublicKeyHex` +
    `recipientEndpoint`（caller 给对方地址）。
  - `appmsg.list.params`：**不**带 endpoint（由 protocolService 从
    `event.origin` 自动投影成 `scopeEndpoint`；与现有 origin
    sender 真值同源）。
  - `appmsg.get.params.messageId` 必填；scope 由 protocolService
    自动填 `event.origin`。

整改方向：
- `executeAppMsgList / executeAppMsgGet` 入参从 `sender` 改为 `scope`；
  scope.endpoint.kind = "origin"、id = `rec.origin`；scope.owner
  = session.ownerPublicKeyHex。
- `executeAppMsgSend` 维持 sender 入参。

### 3.9 messageId 全链路 string

- `packages/contracts/src/appmsg.ts` 中 `AppMsgMessage.messageId: string`。
- `AppMsgListParams.afterMessageId?: string` /
  `beforeMessageId?: string`。
- `protocol.ts` 中 `AppMsgListParams` 已经同步为 string。
- 在 `appmsgCore.ts` 的 `list` 入参增加类型校验：必须是 string。

### 3.10 跨仓联调测试

新增 `packages/plugin-appmsg/test/integration/`：
- `integration.test.ts`：依赖本地 HubMsg（默认 `ws://localhost:8443/ws/v1`）；
- 测试 case：
  1. `bind` 成功；
  2. send from origin A to origin B → origin A inbox / origin B inbox；
  3. origin A 看不到 origin B 的消息（list 跨 origin 返回空）；
  4. plugin endpoint A 看不到 plugin endpoint B 的消息；
  5. dirty event 推送只给当前 origin 的 caller；
  6. messageId round-trip：send 返回的 string messageId 与
     list / get 返回的 string messageId bit 级一致。

测试运行命令（联调时）：
```bash
cd ../HubMsg && go test ./internal/ws -run TestBindRoundTrip
# 起一个本地 HubMsg：
go run ./cmd/hubmsgd &
# 然后在 keymaster 仓：
cd /home/david/Workspaces/keymaster.cc
pnpm test packages/plugin-appmsg/test/integration
```

---

## 4. 不能怎么做

1. 不能继续把 `plugin-appmsg/src/signing.ts` 的 bind 拼接作为"plugin
   内部实现"——必须提取到 contracts 作为两仓共用常数。
2. 不能继续把"全局工厂 capability + forEndpoint()"作为插件作者最终
   体验；最终体验是"声明 endpoint → 拿到 scoped client"。
3. 不能在 `appmsg.core` 走"每 endpoint 一条 HubMsg 连接池"。
4. 不能让 wire JSON 的 `messageId` / `afterMessageId` / `beforeMessageId`
   出现 int64 / number。
5. 不能让 HubMsg 同时兼容"keymaster 平台连接"和"任意浏览器 app 直连"。
6. 不能让 `appmsg.inbox_dirty` 携带完整消息正文；正文始终走
   `appmsg.list / get`。
7. 不能继续把 `scopeEndpoint` 命名为 `sender`；语义对齐 HubMsg 的
   `MessageListParams.scopeEndpoint` / `MessageGetParams.scopeEndpoint`。

---

## 5. 验收清单

### 一、bind 握手对齐

- [ ] `canonicalBindText` 单测覆盖分隔符 / 顺序 / 数字格式。
- [ ] HubMsg 端 Go 单测与 `signing.ts` 端 JS 单测用同一 fixture 验证
      round-trip。

### 二、endpoint 入参命名对齐

- [ ] `AppMsgCore.list / get` 入参改为 `scope: AppMsgAddress`。
- [ ] `protocolService.executeAppMsgList / executeAppMsgGet` 用
      `event.origin` 自动投影 scope.endpoint。

### 三、messageId 全链路 string

- [ ] `AppMsgMessage.messageId: string`。
- [ ] `AppMsgListParams.afterMessageId / beforeMessageId: string`。
- [ ] 单测覆盖"send 返回的 messageId 字符串与 list / get 返回的
      messageId bit 级一致"。

### 四、runtime host 注入

- [ ] endpointId 形状非法时 enable 抛错。
- [ ] endpointId 冲突时后者 enable 抛错。
- [ ] 声明 endpoint 的插件拿到 scoped client；未声明拿不到。
- [ ] scoped client 的 sender endpoint 不可被 caller 覆盖。

### 五、跨仓联调

- [ ] 本地 HubMsg 起服；keymaster 端跨仓测试通过。

### 六、对外 event 边界

- [ ] `appmsg.inbox_dirty` 不携带完整消息正文。
- [ ] 完整消息始终走 `appmsg.list / get`。