# Keymaster Protocol V1（草案）

本文档是 Keymaster 对外协议的总览入口。**当前**协议按能力拆成四份
草案：

- [公共约定](./keymaster-protocol-common-v1-draft.md)
- [Identity.Get](./keymaster-identity-get-v1-draft.md)
- [Intent.Sign](./keymaster-intent-sign-v1-draft.md)
- [Cipher](./keymaster-cipher-v1-draft.md)

拆分缘由：

- 公共约定承载 `BinaryField` / 顶层 `ready` / `request` / `result` 报文
  形态 / 安全边界 / claim 命名规则等所有方法共享的部分。
- `identity.get` 与 `intent.sign` 都需要 Keymaster 签名，但签名对象不同：
  - `identity.get` 签的是"身份断言"；
  - `intent.sign` 签的是"调用方提供的业务内容信封"。
  两者继续放在一份文档里，会让 `resolvedClaims` / `contentType` /
  `contentSha256` 等概念互相污染。
- `cipher.encrypt` / `cipher.decrypt` 处理的是站点绑定的二进制加解密，
  业务模型、加解密算法、错误语义与签名类方法差异较大，单独成文避免
  把"明文/密文"与"待签名字节/签名"混在一起。
- 四份草案都复用公共约定中的 transport / `BinaryField` / popup + `postMessage`
  通信模型；不要在子文档里再次定义这些。

当前协议能力包括：

- `identity.get`
- `intent.sign`
- `cipher.encrypt`
- `cipher.decrypt`

四个方法都：

- 走同一套 transport（popup + `postMessage` + JS 对象 + `BinaryField`）。
- 必须由 Keymaster popup 处理；Keymaster popup 协议入口固定为
  `/protocol/v1/popup`。
- 经过用户确认；不存在"轻量免确认"或"静默获取"模式。

各方法的"返回真值字节"语义**不**通用，按方法区分：

- `identity.get` 返回 `identityEnvelope`（含 `subjectPublicKey` 与
  `claims` 签名投影的 Deterministic CBOR 真值字节）+ `signature`。
  详见 [Identity.Get](./keymaster-identity-get-v1-draft.md)。
- `intent.sign` 返回 `signedEnvelope`（含 `contentType` / `contentSha256`
  / `subjectPublicKey` 的 Deterministic CBOR 真值字节）+ `signature`。
  详见 [Intent.Sign](./keymaster-intent-sign-v1-draft.md)。
- `cipher.encrypt` / `cipher.decrypt` **不**返回签名真值 envelope。
  详见 [Cipher](./keymaster-cipher-v1-draft.md)。

`signature.bytes` 的具体 secp256k1 编码细节请查阅对应方法文档的
"约束"段（[Identity.Get](./keymaster-identity-get-v1-draft.md) /
[Intent.Sign](./keymaster-intent-sign-v1-draft.md)）。本总览页只做
能力索引，不下沉到实现级编码细节。

后续扩展：

- 任何"非以上四个方法"的能力都视为 V2 范畴；本 V1 不预留"通用
  消息平台 / claim provider registry / 多算法协商"等扩展框架。
  后续若要新增，先改本文档总览，再单独开方法文档。
