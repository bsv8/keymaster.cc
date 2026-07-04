# 004 `appmsg` 签名消息壳 / HubMsg 二进制帧 / 密文正文硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下现状文件为准：

- `packages/contracts/src/appmsg.ts`
- `packages/contracts/src/messageProvider.ts`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/appmsgDb.ts`
- `packages/plugin-appmsg/src/signer.ts`
- `packages/plugin-appmsg/src/appmsgSync.ts`
- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
- `packages/plugin-hubmsg/src/hubmsgProvider.ts`
- `packages/plugin-hubmsg/src/hubmsgProvider.test.ts`
- `packages/plugin-message/src/messageService.ts`
- `packages/plugin-message/src/MessagePage.tsx`
- `packages/plugin-protocol/src/protocolCbor.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `施工单/2026-07-03/001-appmsg-local-truth-full-push-online-hard-switch.md`
- `施工单/2026-07-03/002-message-route-and-hubmsg-boundary-hard-switch.md`
- `施工单/2026-07-04/001-appmsg-provider-split-and-thin-message-hard-switch.md`
- `../HubMsg/施工单/2026-07-04/001-hubmsg-binary-frame-signed-envelope-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“传输壳 / 永久消息壳 / 加密正文三层拆分”的定义优先。
2. `app / plugin` 公开消息接口继续保持明文业务语义；HubMsg provider wire 改为二进制签名消息壳，这一内外分层优先。
3. 本次是硬切换：不保留 JSON frame，不保留 base64 密文，不保留明文 HubMsg 正文，不保留双路兼容。

---

## 1. 文档定位

这不是一次“给 `body` 外面包一层密文字符串”的小修，也不是“先保留 JSON，再慢慢换二进制”的过渡方案。

这次要一次性解决三个缠在一起的问题：

- 当前 HubMsg wire 把 RPC 壳、永久消息对象、业务正文混成一层；
- 当前消息正文以明文 `contentType + body` 进 HubMsg 和链路；
- 以后要做签名校验、密文传输、服务端真值存储时，JSON/base64 会把二进制、签名、稳定字节真值搅成一团。

因此本次必须硬切成三层：

1. 传输壳：WebSocket binary frame，只解决“这帧是什么”；
2. 永久消息壳：HubMsg 存储、转发、接收方验签的唯一真值；
3. 加密正文：只给收发双方看的业务内容。

---

## 2. 简述缘由

### 2.1 不应把一次 RPC 调用壳签成永久消息真值

下面这些字段：

- `type = "request"`
- `id`
- `method = "appmsg.send"`
- `connectSessionId`

都只是“这一跳怎么发出去”的调用上下文，不是消息本体。

如果把它们签进永久消息：

- HubMsg 后续 `message.list / get / received` 都得把历史 RPC 壳永久背着走；
- 接收方验签会依赖“发送当时的本地 session 真值”；
- 协议会被一次性的 request/response 语义绑死。

这是错误分层。本次必须把“发送调用壳”和“永久消息壳”拆开。

### 2.2 本地搜索需要明文，不等于链路和服务端也该看明文

你已经明确：

- 本地 DB 存明文，方便搜索；
- 加密只定义在“报文传递”这部分。

这意味着正确边界应该是：

- `app / plugin` 调 `appmsg.send` 时仍给明文 `contentType + body`；
- `plugin-appmsg` 在 provider 边界前做 seal + sign；
- HubMsg 只看明文路由头和签名，不看正文；
- 接收方 `plugin-appmsg` 在 provider 入站边界处先验签，再解密，再落本地明文投影。

### 2.3 这次不该继续用 JSON/base64

JSON/base64 对这个问题是错方向：

- JSON 对二进制不友好；
- base64 把密文又包装回字符串，浪费空间，也让“签的到底是什么”变糊；
- 以后 server/client 都要围着字符串编解码和 canonicalization 打转。

本次固定为：

- WebSocket binary frame；
- Deterministic CBOR；
- 固定顺序数组，不用 map；
- 签名与验签都针对最终传输的真值 bytes。

### 2.4 本次选 `static-static ECDH`，不选 `ephemeral-static`

按“系统简单优先 + 本地 DB 明文 + 仍要支持 sent history 重建”的约束，本次加密方案固定为：

- sender 长期私钥
- recipient 长期公钥
- `secp256k1 ECDH`

原因：

- 发送方以后从 HubMsg 补拉自己发出去的历史消息时，仍能自己解开；
- 不需要为“我自己历史 sent message 也要可恢复”再加第二份 sender ciphertext；
- envelope 字段更少，不需要 `ephemeralPublicKey`；
- 协议和实现都更直接。

代价是：

- 本次不提供 forward secrecy。

这是本次有意接受的简化，不在当前范围内补。

---

## 3. 硬切换后的最终状态

本次完成后，系统必须达到以下最终状态：

1. `plugin-message`、`plugin-protocol`、其它业务插件继续面向明文 `AppMsgSendInput / AppMsgMessage` 编程。
2. `plugin-appmsg` 成为唯一的 seal/open + sign/verify 边界。
3. `plugin-hubmsg` 不再发送 JSON `request/result/event` 文本帧，而是发送 binary frame。
4. `HubMsg` 不再接收 `contentType/body` 明文消息记录，而是接收 `SignedAppMsgEnvelope`。
5. HubMsg 持久化真值不再是明文正文，而是：
   - 路由索引字段
   - `envelopeBytes`
   - `signatureBytes`
6. 入站消息必须先验签，再解密；任一步失败都 fail-closed。
7. 本地 DB 继续保留明文投影，供列表、搜索、详情页使用。
8. 外部协议 `appmsg.send / list / get` 继续暴露明文业务语义，不要求调用方自己造密文。
9. 不保留旧 JSON frame，不保留明文 HubMsg body，不保留“兼容读旧消息”尾巴。
10. provider 不升级时，`plugin-appmsg` 直接 not-ready / unhealthy，不做自动 fallback。

---

## 4. 单真值定义

### 4.1 传输壳：`HubFrame`

本次固定：

- WebSocket 上只传二进制；
- 每个 frame body 用 Deterministic CBOR 编码；
- frame 自身也是固定顺序数组。

逻辑形状：

```txt
HubFrame = [frameVersion, frameKind, frameBody]
```

约束：

- 不再传 JSON 字符串；
- 不再在 frame 里出现 base64；
- 不再在 frame 里出现 method 名字字符串；
- frame kind / method id 都用整数常量。

### 4.2 永久消息壳：`AppMsgEnvelopeV1`

本次固定：

```txt
AppMsgEnvelopeV1 = [
  1,                     // envelopeVersion
  senderPublicKey33,     // bytes, 33-byte compressed secp256k1 pubkey
  senderEndpointKind,    // uint, 1=origin, 2=plugin
  senderEndpointId,      // text
  recipientPublicKey33,  // bytes
  recipientEndpointKind, // uint, 1=origin, 2=plugin
  recipientEndpointId,   // text
  clientMessageId,       // text
  createdAtMs,           // int
  sealSuiteId,           // uint
  nonce12,               // bytes, 12-byte AES-GCM nonce
  ciphertext             // bytes
]
```

关键约束：

1. 这是唯一允许被 HubMsg 持久化、转发、被接收方验签的消息真值。
2. 不包含 `requestId`、`method`、`connectSessionId`。
3. sender / recipient 的路由头进入 envelope 真值，而不是放在 envelope 外另起一层字符串字段。
4. `contentType / body` 不允许出现在 envelope 明文层。

### 4.3 签名壳：`SignedAppMsgEnvelopeV1`

本次固定：

```txt
SignedAppMsgEnvelopeV1 = [
  envelopeBytes,
  signature64
]
```

其中：

- `envelopeBytes` = `AppMsgEnvelopeV1` 的 Deterministic CBOR 真值字节；
- `signature64` = sender owner 私钥对 `SHA-256(envelopeBytes)` 做的 secp256k1 compact 64-byte 签名。

关键约束：

1. 验签对象是 `envelopeBytes` 原始字节，不是 parse 后重编码出来的新字节。
2. HubMsg 存储与转发的也是原始 `envelopeBytes + signature64`。
3. 接收方先验 `signature64`，后解密 `ciphertext`。

### 4.4 加密正文：`AppMsgPlaintextV1`

本次固定：

```txt
AppMsgPlaintextV1 = [
  1,            // plaintextVersion
  contentType,  // text
  bodyUtf8Bytes // bytes
]
```

关键约束：

1. `contentType` 和 `body` 一起进密文。
2. v1 仍只允许：
   - `text/plain`
   - `text/markdown`
3. `body` 在密文层用 UTF-8 bytes，不做额外 base64 包装。

### 4.5 加密套件：`sealSuiteId = 1`

本次固定：

```txt
sealSuiteId = 1
  = secp256k1 static-static ECDH
  + HKDF-SHA256
  + AES-256-GCM
```

逻辑：

```txt
sharedSecret =
  ECDH(senderPriv, recipientPub)

messageKey =
  HKDF-SHA256(
    ikm  = sharedSecret,
    salt = empty,
    info = "keymaster:appmsg:seal:v1"
  )
```

关键约束：

1. 本次不做 `ephemeralPublicKey`。
2. 本次不做双密文（recipient 一份、sender 一份）。
3. 本次不做 AAD；路由头完整性由 envelope 签名覆盖。

### 4.6 本地 DB 真值

本次固定：

- 本地 DB 继续存明文投影；
- 搜索、列表、详情都读本地明文投影；
- HubMsg provider 只负责远端密文壳。

允许本地额外存：

- `sealedEnvelopeBytes`
- `sealedEnvelopeSigBytes`

作为诊断字段，但它们**不是**业务查询真值必需项。

---

## 5. 必须怎么做

### 5.1 把 Deterministic CBOR 提升成共享原语

当前 `protocolCbor.ts` 只在 `plugin-protocol` 内部。

本次必须把它提升成共享实现，供：

- `plugin-protocol`
- `plugin-appmsg`
- `plugin-hubmsg`

共同使用。

推荐落点：

- `packages/contracts/src/cbor.ts`

原因：

- 这是纯编码原语，不应继续只挂在 `plugin-protocol` 下面；
- `plugin-appmsg` 不能反向依赖 `plugin-protocol`。

本次选型固定：

- TypeScript / 浏览器侧：`cborg`
- Go / HubMsg 侧：`github.com/fxamacker/cbor/v2`

选择原因：

- `cborg` 官方明确强调 strictness、deterministic 表示、`Uint8Array` 原生支持，适合浏览器 binary protocol；
- `fxamacker/cbor/v2` 官方明确支持 RFC 8949 Core Deterministic Encoding，且成熟度、并发复用、抗恶意输入能力都足够好；
- 本次协议刻意只使用：
  - arrays
  - bytes
  - text
  - int
  不使用 map 作为签名真值、不使用 float，因此两边 deterministic 约束最容易稳定对拍。

关键修正：

- **不能**继续维护仓内手写的“不完整最小 CBOR 编解码器”作为长期方案；
- 必须采用成熟、经过实际使用验证的 CBOR 库；
- 仓内允许保留一层很薄的 `cbor.ts` 封装，但这层只负责：
  - 固定 deterministic encode 选项
  - 固定 bytes / text / array 的项目级约束
  - 统一错误映射
- 这层**不**负责重写一套自己的 CBOR 编码规则。

### 5.2 `appmsg` 公开接口继续明文，provider internal 改 sealed

`AppMsgSendInput / AppMsgMessage` 继续保持现在的业务形状：

- `contentType`
- `body`

但 provider internal contract 必须改成 sealed record，而不是继续把 `body` 明文穿透到 `plugin-hubmsg`。

也就是说：

- 业务层 API 不变；
- provider 层 API 改。

### 5.3 `plugin-appmsg` 收口 seal/open + sign/verify

`plugin-appmsg` 必须新增独立消息密码学模块，负责：

- sender 侧：`plaintext -> ciphertext -> envelope -> signature`
- recipient / sender replay 侧：`signature verify -> ciphertext decrypt -> plaintext`

这层必须完全收口在 `plugin-appmsg`。

不能把：

- ECDH
- HKDF
- AES-GCM
- envelope sign/verify

散落到 `plugin-message`、`plugin-hubmsg`、`plugin-protocol` 多处。

### 5.4 `plugin-hubmsg` 改成 binary frame + signed envelope

`plugin-hubmsg` 必须一次性完成：

- WebSocket 二进制收发
- CBOR frame encode/decode
- `message.send` payload 从明文 body 改为 `SignedAppMsgEnvelope`
- `message.list / get / received` 返回 sealed envelope record

不能再保留 JSON `request/result/event` 双路。

### 5.5 HubMsg push / list / get 全部走 sealed record

`plugin-appmsg` 入站处理统一改成：

1. 从 provider 拿 `sealed record`
2. 验签
3. 解密
4. 生成公开 `AppMsgMessage`
5. 落本地明文投影

不能出现：

- push 走密文，list/get 走明文
- sender 自己发的消息走明文捷径
- HubMsg 单独回传 `contentType/body`

### 5.6 对外协议不扩张为“调用方自己组密文”

`appmsg.send` 不应该变成：

- 外部 app 自己传 `envelopeBytes`
- 外部 app 自己传 `signatureBytes`

那会把消息系统复杂度漏给调用方。

本次固定：

- 外部 app 仍传明文 `contentType/body`
- Keymaster 内部帮它 seal + sign

---

## 6. 不能怎么做

### 6.1 不能把 RPC 壳签成永久消息真值

下面这些字段不能进入 `AppMsgEnvelopeV1`：

- `type = "request"`
- `requestId`
- `method = "appmsg.send"`
- `connectSessionId`

它们只属于调用壳，不属于永久消息壳。

### 6.2 不能继续把密文塞回字符串字段

下面这些方案本次全部禁止：

- `body = base64(ciphertext)`
- `contentType = application/octet-stream`
- `body` 里再包一层 JSON 字符串

这会让“哪些字节被签、哪些字节被加密、哪些字段是路由头”全部重新混乱。

### 6.3 不能让 HubMsg 负责解密或理解正文

HubMsg 只能：

- 解 envelope 路由头
- 验 envelope 签名
- 存 envelope bytes + sig

HubMsg 不能：

- 解 `ciphertext`
- 看 `contentType/body`
- 按正文做业务逻辑

### 6.4 不能为了省字段改成 `ephemeral-static` 再忽略 sent history

如果改成 `ephemeral-static` 又不持久化 sender 私有临时密钥，就会导致：

- sender 以后无法重解自己发给别人的历史消息。

本次明确不接受这种“协议更酷，但 sent history 重建直接坏掉”的设计。

### 6.5 不能保留 JSON / binary 双栈

本次必须一次切干净：

- 旧文本 JSON frame 不再收、不再发；
- 旧明文 HubMsg 消息记录不兼容读；
- provider 版本不匹配时直接 unhealthy / close。

---

## 7. 特殊情况提前约定

### 7.1 验签失败

场景：

- envelope 被篡改
- sender 公钥与签名不匹配
- HubMsg 或链路返回坏数据

处理：

- `plugin-appmsg` 直接丢弃该条消息；
- 不落本地明文；
- 记录英文错误日志；
- sync 路径把该 target 标记为最近一次同步失败。

本次不做“坏消息隔离箱”。

### 7.2 解密失败

场景：

- `ciphertext` 坏了
- nonce 坏了
- route 正常但正文解不开

处理：

- 与验签失败同口径：丢弃、不落本地、记录错误、同步状态标红。

本次不保留“只存坏密文，晚点再重试”的复杂队列。

### 7.3 自发给自己

必须支持：

- senderPub == recipientPub
- endpoint 可以相同，也可以不同

原因：

- `static-static ECDH` 下这条路径天然可解；
- 不应该因为“收发同 key”再分叉一套特殊逻辑。

### 7.4 本地 DB 被清空后的历史恢复

本次明确支持：

- 从 HubMsg 重新补拉后，当前 owner 可以重建：
  - 收到的消息
  - 自己发出去的消息

前提：

- 用的是本次固定 `static-static ECDH`

### 7.5 provider 未升级或连接到旧 HubMsg

处理：

- `plugin-hubmsg` 在握手或首帧解码阶段直接失败；
- provider health = fail；
- `plugin-appmsg` not-ready；
- 管理页明确显示 provider 不兼容。

本次不做自动降级回旧 JSON 协议。

---

## 8. 文件级施工清单

以下为本次必须落地的文件级改动。

### 8.1 `packages/contracts`

必须新增 / 修改：

- `packages/contracts/src/cbor.ts`
  - 从 `plugin-protocol` 提升出共享 Deterministic CBOR 原语
  - 基于 `cborg` 做薄封装，而不是自写编解码器
- `packages/contracts/src/appmsg.ts`
  - 保持公开明文业务接口
  - 新增 platform internal sealed message / envelope 类型定义
- `packages/contracts/src/messageProvider.ts`
  - provider internal 输入输出从明文 `body` 改为 sealed envelope record
- `packages/contracts/src/index.ts`
  - 导出新增 CBOR 与 sealed message internal 类型

### 8.2 `packages/plugin-appmsg`

必须新增 / 修改：

- `packages/plugin-appmsg/src/appmsgCrypto.ts`
  - 新增：seal/open、sign/verify、envelope 编解码
- `packages/plugin-appmsg/src/appmsgCore.ts`
  - send 路径：明文 -> sealed envelope -> provider
  - 入站路径：sealed envelope -> verify -> decrypt -> local plaintext projection
- `packages/plugin-appmsg/src/appmsgDb.ts`
  - 继续存明文投影
  - 如有需要可加 raw envelope/sig 诊断列
- `packages/plugin-appmsg/src/appmsgCore.test.ts`
  - 新增 seal/open、verify fail、decrypt fail、自发给自己、sender 历史重建测试

### 8.3 `packages/plugin-hubmsg`

必须新增 / 修改：

- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
  - WebSocket binary frame
  - CBOR frame encode/decode
  - `message.send/list/get/received` 改 sealed envelope record
- `packages/plugin-hubmsg/src/hubmsgProvider.ts`
  - bind 后 typed handle 改为 sealed provider contract
- `packages/plugin-hubmsg/src/hubmsgProvider.test.ts`
  - 新增 binary frame / sealed payload / provider health 测试

### 8.4 `packages/plugin-protocol`

必须新增 / 修改：

- `packages/plugin-protocol/src/protocolCbor.ts`
  - 改为复用共享 `packages/contracts/src/cbor.ts`，或删除本地重复实现
  - 不再继续演化为项目自维护 CBOR 实现
- `packages/plugin-protocol/src/protocolService.ts`
  - 继续对外暴露明文 `appmsg.send`
  - 不扩张为“调用方自造密文”

### 8.5 `packages/plugin-message`

原则上不改接口，不改页面语义。

若测试需要更新，只允许改：

- `packages/plugin-message/src/messageService.test.ts`
- `packages/plugin-message/src/MessagePage.test.tsx`

不能把加密 / 签名逻辑下放到 `plugin-message`。

---

## 9. 最终验收清单

- [ ] WebSocket 链路上已无 JSON 文本业务帧。
- [ ] WebSocket 链路上已无 base64 密文字段。
- [ ] HubMsg provider 发送的 `message.send` payload 已改为 `SignedAppMsgEnvelope`。
- [ ] HubMsg provider 返回的 `message.list/get/received` 已不再含明文 `contentType/body`。
- [ ] `plugin-appmsg` 成为唯一 seal/open + sign/verify 边界。
- [ ] `appmsg.send` 对外协议仍保持明文业务语义。
- [ ] 本地 DB 仍可按明文 `body` 搜索。
- [ ] 验签失败消息不会落本地明文库。
- [ ] 解密失败消息不会落本地明文库。
- [ ] 自发给自己消息可正常发送、同步、解密。
- [ ] 清空本地 DB 后，可从 HubMsg 补拉重建 sent + received 历史。
- [ ] 连接旧 HubMsg / 旧 provider 时，系统 fail-closed，而不是偷偷 fallback。
- [ ] 仓库内不存在“密文塞回 `body` 字符串”的新实现。

---

## 10. 本次明确不做

- 不做 `ephemeral-static`。
- 不做 forward secrecy。
- 不做群聊密钥管理。
- 不做附件 / 二进制正文业务接口扩张。
- 不做坏密文隔离箱。
- 不做 JSON/binary 双协议兼容。
- 不做让外部 app 直接构造 envelope/signature 的高级接口。
- 不自研新的 CBOR 编解码器。

本次目标很克制：

- HubMsg 看不见正文；
- 链路上是二进制真值帧；
- 服务端能验签、能做路由、能持久化；
- 本地继续保留明文搜索体验；
- 系统复杂度不再继续泄漏给业务插件和外部调用方。
