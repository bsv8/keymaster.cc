# Keymaster Identity.Get V1（草案）

本文档定义 `identity.get`。

它不是“裸读取资料”，而是向 Keymaster 请求一份：

- 有 `aud`
- 有 `iat`
- 有 `exp`
- 有用户确认
- 有 Keymaster 签名

的身份断言。

## 方法名

- `identity.get`

## 设计原则

- `identity.get` 返回当前 active key 的身份与请求的 claims。
- `identity.get` 必须由 Keymaster 签名，不只是返回信息。
- `identity.get` 也必须有时效性，因此带 `aud` / `iat` / `exp`。
- 调用方拿到结果后，可以长期保存 `identityEnvelope + signature` 作为证据。
- 推荐把 `identity.get` 作为登录入口使用；调用方可在登录时一并请求 profile claims，从而同时完成身份建立与 profile 同步。
- 是否把 `identity.get` 用作站点登录策略，由调用方自己决定；Keymaster 只提供能力，不强制产品策略。

## 请求

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440000",
  method: "identity.get",
  params: {
    aud: "https://abc.com",
    iat: 1761018000,
    exp: 1761018300,
    text: "向 abc.com 提供身份信息",
    claims: ["key.label", "profile.nickname", "profile.avatar.image"]
  }
}
```

约束：

- `aud` 必填。
- `iat` 必填。
- `exp` 必填。
- `exp` 必须严格大于 `iat`。
- Keymaster 必须执行本地有效期上限策略；超出上限的请求必须拒绝。
- 所有 `identity.get` 请求都必须经过用户确认。

## 用户确认

确认页至少展示：

- 来源站点 `aud`
- 人类可读文案 `text`
- 请求索要的 claim 名列表
- 有效期信息（`iat` / `exp`）

说明：

- 不存在轻量 / 重量 claim 的免确认模式。
- 轻量 / 重量的区别只影响 UI 展示轻重，不影响是否必须确认。

## Identity 信封

Keymaster 不返回一个“待你重新编码的对象”，而是直接返回 **Deterministic CBOR 编码后的最终真值字节**。

### 逻辑结构

Identity 信封的逻辑结构是一个固定顺序数组：

```txt
[
  v,
  id,
  aud,
  iat,
  exp,
  text,
  subjectPublicKey,
  claims
]
```

字段定义：

1. `v`：协议版本号，整数，当前固定为 `1`
2. `id`：请求唯一标识，字符串
3. `aud`：目标站点 origin，字符串
4. `iat`：签发时间，整数
5. `exp`：过期时间，整数
6. `text`：人类可读确认文案，字符串
7. `subjectPublicKey`：签名主体公钥原始字节
8. `claims`：排序后的 claims 签名投影列表

### 编码规则

V1 明确采用：

- 逻辑结构：固定顺序数组
- 编码格式：Deterministic CBOR

也就是说：

1. Keymaster 按上面的数组规则组装逻辑结构；
2. 用 Deterministic CBOR 编码成最终字节；
3. 对该字节直接签名。

示意（逻辑数组，不是传输对象字面量）：

```txt
[
  1,
  "550e8400-e29b-41d4-a716-446655440000",
  "https://abc.com",
  1761018000,
  1761018300,
  "向 abc.com 提供身份信息",
  <33-byte compressed public key>,
  [
    ["key.label", "Main Key"],
    ["profile.avatar.image", ["binary", "image/png", <avatarSha256>]],
    ["profile.nickname", "alice"]
  ]
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
    identityEnvelope: {
      $type: "binary",
      mime: "application/cbor",
      bytes: identityEnvelopeCborArrayBuffer
    },
    signature: {
      $type: "binary",
      bytes: signatureArrayBuffer
    },
    subject: {
      publicKey: {
        $type: "binary",
        bytes: publicKeyArrayBuffer
      }
    },
    resolvedClaims: {
      "key.label": "Main Key",
      "profile.nickname": "alice",
      "profile.avatar.image": {
        $type: "binary",
        mime: "image/png",
        bytes: avatarArrayBuffer
      }
    }
  }
}
```

约束：

- `identityEnvelope` 是最终真值字节，内容是 Deterministic CBOR 编码结果。
- 验签方应直接对 `identityEnvelope.bytes` 验签，不需要自行重编码。
- 业务方若想读取内部字段，可在验签后自行对 `identityEnvelope.bytes` 做 CBOR 解码。
- `result.resolvedClaims` 返回业务真正可消费的 claim 真值。
- 对于二进制 claim，`result.resolvedClaims` 返回本体，`identityEnvelope` 记录其摘要投影。
- `signature.bytes` 固定为 **64-byte compact secp256k1 signature（`r || s`）**。
  V1 不支持 DER / recovered / 其它变体；调用方应按 `r(32 bytes) || s(32 bytes)`
  解析后做 secp256k1 验签。

## 当前已达成共识

- `identity.get` 有时效性，带 `aud` / `iat` / `exp`。
- `identity.get` 必须由 Keymaster 签名。
- `identityEnvelope` 采用固定顺序数组 + Deterministic CBOR。
- `identity.get` 请求也必须用户确认，不区分信息轻重。
- 推荐使用 `identity.get` 作为登录入口，并顺便同步 profile。
