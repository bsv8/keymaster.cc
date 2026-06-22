# Keymaster Cipher V1（草案）

本文档定义：

- `cipher.encrypt`
- `cipher.decrypt`

它们的职责是：

- 让第三方站点把任意二进制内容交给 Keymaster 加密；
- 让第三方站点把之前产出的密文交给 Keymaster 解密；
- Keymaster 不理解业务内容本身，只负责基于当前站点 origin 执行站点绑定的加解密。

## 方法名

- `cipher.encrypt`
- `cipher.decrypt`

## 设计原则

- `cipher` 方法处理的是二进制内容，不是文本专用能力。
- `contentType` 属于业务语义，但不应在密文外单独传来传去；因此它与内容本体一起进入密文。
- Keymaster 不负责管理调用方的业务信封；调用方自己决定如何落库、如何组织业务记录。
- 站点绑定不通过调用方传入 `aud`，而通过浏览器实际消息来源 `event.origin` 取得。
- `cipher` V1 固定算法，不做多算法协商。
- `cipher` V1 不使用 `AAD`；站点绑定依赖 origin 派生出的站点密钥。

## 安全边界

- Keymaster 必须从收到消息的 `event.origin` 获取当前调用方 origin。
- Keymaster 必须把 `event.origin` 原样作为 `exactOrigin` 使用，不自行补默认端口，不自行重写 host，不自行做归一化。
- 同一份密文只能在相同 `exactOrigin` 下被成功解开；origin 不同会导致站点密钥不同，从而解密失败。
- 本设计主要防御“第三方站点数据脱裤后的离线读取”。
- 如果攻击者已经能在线伪装成真实 origin，并驱动受害者本地的 Keymaster 发起解密，则视为超出本协议 V1 的防御边界。

## 固定算法

V1 固定使用：

- 站点密钥派生：`HMAC-SHA256`
- 对称加密：`AES-256-GCM`

说明：

- V1 不引入 `alg` 参数。
- V1 不做算法协商。
- `AES-GCM` 使用随机 `nonce`，并依赖其自带的完整性校验。

## 站点密钥派生

Keymaster 必须基于当前 active key 的私钥秘密材料与 `exactOrigin` 推导站点密钥。

逻辑表达：

```txt
siteKey = HMAC-SHA256(
  key = privateKeySecret,
  message = UTF-8(cipherContext + "|" + exactOrigin)
)
```

其中：

- `privateKeySecret`：当前 active key 的私钥秘密材料
- `exactOrigin`：浏览器事件中的 `event.origin` 原样字符串
- `cipherContext`：协议常量，V1 固定为 `keymaster:cipher:v1`

说明：

- `cipherContext` 是协议的一部分，不能在同一协议实现里随意改动。
- 同一私钥、同一 `exactOrigin`、同一协议版本，必须推导出相同的 `siteKey`。
- 不同 origin 必须推导出不同的 `siteKey`。

## 内层明文结构

`cipher.encrypt` 实际加密的不是裸 `content.bytes`，而是一个固定结构的二进制对象。

### 逻辑结构

```txt
[
  v,
  contentType,
  contentBytes
]
```

字段定义：

1. `v`：密文内层结构版本，整数，当前固定为 `1`
2. `contentType`：调用方自定义的业务内容类型，字符串
3. `contentBytes`：真实业务字节

### 编码规则

V1 明确采用：

- 逻辑结构：固定顺序数组
- 编码格式：Deterministic CBOR

也就是说：

1. Keymaster 先按上面的数组规则组装内层逻辑结构；
2. 再用 Deterministic CBOR 编码成 `plainBytes`；
3. 对 `plainBytes` 执行 `AES-256-GCM` 加密。

说明：

- `contentType` 会与 `contentBytes` 一起被保密、一起被防篡改。
- 调用方解密时不需要额外再传一次 `contentType`。

## `cipher.encrypt`

### 请求

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440000",
  method: "cipher.encrypt",
  params: {
    text: "请确认加密笔记内容",
    contentType: "abc.note.v1",
    content: {
      $type: "binary",
      bytes: noteArrayBuffer
    }
  }
}
```

约束：

- `text` 必填，用于用户确认展示。
- `contentType` 必填。
- `content` 必填，且必须是最终业务字节。
- Keymaster 不要求理解 `contentType` 的业务语义。
- 所有 `cipher.encrypt` 请求都必须经过用户确认。

### 用户确认

确认页至少展示：

- 来源站点 `event.origin`
- 人类可读文案 `text`
- `contentType`

### 加密过程

Keymaster 必须：

1. 从 `event.origin` 取得 `exactOrigin`
2. 依据 `privateKeySecret + cipherContext + exactOrigin` 推导 `siteKey`
3. 构造内层明文结构 `[1, contentType, contentBytes]`
4. 用 Deterministic CBOR 编码得到 `plainBytes`
5. 生成随机 12 字节 `nonce`
6. 执行 `AES-256-GCM(siteKey, nonce, plainBytes)`
7. 返回 `nonce + cipherbytes`

说明：

- `cipherbytes` 指 `AES-GCM` 输出的最终密文字节；其中已包含该模式所需的认证标签。
- V1 不使用 `AAD`。

### 成功返回

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: true,
  result: {
    nonce: {
      $type: "binary",
      bytes: nonceArrayBuffer
    },
    cipherbytes: {
      $type: "binary",
      bytes: cipherbytesArrayBuffer
    }
  }
}
```

约束：

- `nonce` 是本次加密随机生成的 12 字节值。
- `cipherbytes` 是调用方需要保存的密文字节。
- Keymaster 不返回业务信封，不返回 `contentType` 回显，不返回 `text` 回显。

## `cipher.decrypt`

### 请求

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440001",
  method: "cipher.decrypt",
  params: {
    text: "请确认解密笔记内容",
    nonce: {
      $type: "binary",
      bytes: nonceArrayBuffer
    },
    cipherbytes: {
      $type: "binary",
      bytes: cipherbytesArrayBuffer
    }
  }
}
```

约束：

- `text` 必填，用于用户确认展示。
- `nonce` 必填。
- `cipherbytes` 必填。
- 解密请求不需要调用方额外提供 `contentType`。
- 所有 `cipher.decrypt` 请求都必须经过用户确认。

### 用户确认

确认页至少展示：

- 来源站点 `event.origin`
- 人类可读文案 `text`

说明：

- 在真正解密成功前，Keymaster 不知道密文内层的 `contentType`。
- 因此 `cipher.decrypt` 的确认页不能依赖密文内层字段先做业务展示。

### 解密过程

Keymaster 必须：

1. 从 `event.origin` 取得 `exactOrigin`
2. 依据 `privateKeySecret + cipherContext + exactOrigin` 推导 `siteKey`
3. 执行 `AES-256-GCM` 解密
4. 将解出的 `plainBytes` 按 Deterministic CBOR 解码
5. 按固定数组结构读取 `[v, contentType, contentBytes]`
6. 返回 `contentType + content`

说明：

- 如果 origin 不匹配、`nonce` 错误、`cipherbytes` 被篡改、或密文格式非法，解密都必须失败。
- 对调用方来说，“origin 不匹配”和“密文损坏”在 V1 中都表现为解密失败；Keymaster 不需要额外区分更细错误原因。

### 成功返回

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440001",
  ok: true,
  result: {
    contentType: "abc.note.v1",
    content: {
      $type: "binary",
      bytes: noteArrayBuffer
    }
  }
}
```

约束：

- `contentType` 来自密文内层结构。
- `content` 是解密得到的真实业务字节。
- Keymaster 不负责解释 `contentType`，只负责还原。

## 调用方存储建议

Keymaster 只负责返回密码学结果：

- `nonce`
- `cipherbytes`

调用方自己决定如何组织业务存储，例如：

```ts
{
  nonce,
  cipherbytes,
  localMeta: {
    createdAt: 1761018000,
    title: "note-1"
  }
}
```

说明：

- 调用方如果愿意，也可以在自己站点数据库中额外缓存明文侧的业务索引。
- 但真正可恢复的密码学必要数据，V1 只有 `nonce + cipherbytes`。

## 当前已达成共识

- `cipher.encrypt` / `cipher.decrypt` 是独立能力，不并入 `identity.get` 或 `intent.sign`。
- `cipher` 处理的是二进制内容，不是文本专用接口。
- `contentType` 与 `contentBytes` 一起加密，不在解密时额外传入。
- V1 固定使用 `HMAC-SHA256` 派生站点密钥，固定使用 `AES-256-GCM` 做加解密。
- V1 不做算法协商，不引入 `alg` 参数。
- V1 不使用 `AAD`。
- 站点绑定依赖 `event.origin` 原样参与站点密钥派生。
- Keymaster 只返回 `nonce + cipherbytes`，业务信封与业务落库由调用方自己负责。
