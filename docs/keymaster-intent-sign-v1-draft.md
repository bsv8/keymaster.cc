# Keymaster Intent.Sign V1（草案）

本文档定义 `intent.sign`。

`intent.sign` 的职责是：

- 对调用方提供的最终二进制内容签名；
- Keymaster 不负责理解业务对象本身；
- Keymaster 负责展示、校验安全边界、计算内容摘要、输出签名信封。

## 方法名

- `intent.sign`

## 设计原则

- `intent.sign` 后面钉死的是“调用方提供的二进制内容”。
- 调用方自己负责把业务对象转换成最终 `content.bytes`。
- Keymaster 不理解业务内容本身，只负责展示、校验安全边界并签名。
- 最终签名对象是一个内容信封：既绑定安全字段，也绑定 `contentType` 和 `contentSha256`。
- `intent.sign` 不是推荐的登录入口；推荐登录场景使用 `identity.get`。

## 请求

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440000",
  method: "intent.sign",
  params: {
    aud: "https://abc.com",
    iat: 1761018000,
    exp: 1761018300,
    text: "请确认签署合同",
    contentType: "abc.contract.v1",
    content: {
      $type: "binary",
      bytes: contractBytesArrayBuffer
    }
  }
}
```

业务签名示例：

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440001",
  method: "intent.sign",
  params: {
    aud: "https://abc.com",
    iat: 1761018000,
    exp: 1761018300,
    text: "请确认签名合同",
    contentType: "abc.contract.v1",
    content: {
      $type: "binary",
      bytes: contractBytesArrayBuffer
    }
  }
}
```

二进制载荷示例：

```ts
{
  params: {
    text: "请确认签名文件",
    contentType: "abc.file.v1",
    content: {
      $type: "binary",
      mime: "application/pdf",
      bytes: fileArrayBuffer
    }
  }
}
```

约束：

- `aud` 必填。
- `iat` 必填。
- `exp` 必填。
- `exp` 必须严格大于 `iat`。
- Keymaster 必须执行本地有效期上限策略；超出上限的请求必须拒绝。
- `content` 是调用方已经准备好的最终二进制内容，也是请求里传输文件本体、挑战本体、业务本体的统一字段名。
- `contentType` 是调用方自己定义的数据结构类型名；Keymaster 不要求理解，但必须一起签进去。
- `contentType` 必须足以让调用方自己和后续验签方理解“这份 bytes 的业务语义是什么”。
- `contentSha256` 由 Keymaster 对 `content.bytes` 直接计算，不允许调用方单独传入一个可被伪造的摘要字段。
- `content` 可以为空字节；此时 `contentSha256` 固定等于空字节的 SHA-256。
- 所有 `intent.sign` 请求都必须经过用户确认。

## 用户确认

确认页至少展示：

- 来源站点 `aud`
- 人类可读文案 `text`
- `contentType`
- 有效期信息（`iat` / `exp`）

## 签名信封

Keymaster 不返回一个“待你重新编码的对象”，而是直接返回 **Deterministic CBOR 编码后的最终真值字节**。

### 逻辑结构

签名信封的逻辑结构是一个固定顺序数组：

```txt
[
  v,
  id,
  aud,
  iat,
  exp,
  text,
  contentType,
  contentSha256,
  subjectPublicKey
]
```

字段定义：

1. `v`：协议版本号，整数，当前固定为 `1`
2. `id`：请求唯一标识，字符串
3. `aud`：目标站点 origin，字符串
4. `iat`：签发时间，整数
5. `exp`：过期时间，整数
6. `text`：人类可读确认文案，字符串
7. `contentType`：调用方定义的内容类型，字符串
8. `contentSha256`：`content.bytes` 的 SHA-256 原始 32 字节
9. `subjectPublicKey`：签名主体公钥原始字节

### 编码规则

V1 明确采用：

- 逻辑结构：固定顺序数组
- 编码格式：Deterministic CBOR

也就是说：

1. Keymaster 先按上面的数组规则组装逻辑结构；
2. 再用 Deterministic CBOR 编码成最终字节；
3. 对该字节直接签名。

示意（逻辑数组，不是传输对象字面量）：

```txt
[
  1,
  "550e8400-e29b-41d4-a716-446655440000",
  "https://abc.com",
  1761018000,
  1761018300,
  "登录 abc.com",
  "abc.auth.challenge.v1",
  <32-byte content sha256>,
  <33-byte compressed public key>
]
```

## 成功返回

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: true,
  result: {
    signedEnvelope: {
      $type: "binary",
      mime: "application/cbor",
      bytes: signedEnvelopeCborArrayBuffer
    },
    signature: {
      $type: "binary",
      bytes: signatureArrayBuffer
    }
  }
}
```

约束：

- `signedEnvelope` 是最终真值字节，内容是 Deterministic CBOR 编码结果。
- 验签方应直接对 `signedEnvelope.bytes` 验签，不需要自行重编码。
- 业务方若想读取内部字段，可在验签后自行对 `signedEnvelope.bytes` 做 CBOR 解码。
- `signature.bytes` 固定为 **64-byte compact secp256k1 signature（`r || s`）**。
  V1 不支持 DER / recovered / 其它变体；调用方应按 `r(32 bytes) || s(32 bytes)`
  解析后做 secp256k1 验签。

## 当前已达成共识

- `intent.sign` 只接收调用方准备好的最终二进制内容。
- 被签名的内容信封里包含 `contentType` 和 `contentSha256`。
- `intent.sign` 请求里的文件 / 挑战 / 业务本体统一放在 `params.content` 传输。
- 最终签名真值使用固定顺序数组 + Deterministic CBOR 编码。
- `result.signedEnvelope` 直接返回编码后的真值字节，不要求调用方重编码。
- `intent.sign` 也必须用户确认。
- 登录场景不推荐使用 `intent.sign` 作为主入口；推荐改走 `identity.get`。
