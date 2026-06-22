# Keymaster Protocol Common V1（草案）

本文档定义 Keymaster 对外协议的公共约定，供 `identity.get`、`intent.sign`、`cipher.encrypt` 与 `cipher.decrypt` 复用。

## 目标

- `keymaster.cc` 作为浏览器内密钥管理者，对外站点提供标准化能力。
- 协议当前聚焦：
  - 身份断言：`identity.get`
  - 内容签名：`intent.sign`
  - 内容加密：`cipher.encrypt`
  - 内容解密：`cipher.decrypt`

## 非目标

- 本协议 V1 不依赖服务器，不提供服务器级全局防重放保证。
- 本协议 V1 不定义第三方资料的校验流程，只定义如何命名、传输、签名与加解密。
- 本协议 V1 不暴露过低层密码学原语，例如原始共享密钥。

## 传输方式

通信方式固定为：

1. 第三方站点 `window.open("https://keymaster.cc/...")` 打开 Keymaster popup。
2. Keymaster popup 初始化完成后，通过 `postMessage` 回发一条 `ready`。
3. 第三方站点收到 `ready` 后，再发送正式 `request`。
4. Keymaster 完成后回发 `result`。

设计缘由：

- popup 页面加载和消息监听注册存在时序问题；
- `ready` 用来明确“我已经能收消息了”，避免首条请求丢失；
- 传输层只解决消息收发，不承载业务语义。

## 报文对象模型

V1 不是 JSON 文本协议，而是浏览器对象协议。

也就是说：

- 报文整体是 JS 对象；
- 发送时直接 `postMessage(message, targetOrigin)`；
- 接收时直接读取 `event.data`；
- 协议不要求先 `JSON.stringify()`；
- 协议允许报文内部直接包含二进制字段。

工程约束：

- 所有报文必须是 structured clone 可传输的对象；
- 不允许在协议里使用 `function`、DOM 节点等不可结构化克隆的值；
- 二进制字段必须使用本文档定义的“二进制字段对象”。

## 二进制字段对象

V1 约定：所有二进制内容都必须显式包成一个带特殊属性标记的对象。

```ts
type BinaryField = {
  $type: "binary";
  bytes: ArrayBuffer;
  mime?: string;
};
```

字段说明：

- `$type: "binary"`：二进制字段标记。
- `bytes`：真实字节内容。
- `mime`：可选。图片、文件、密文等有明确内容类型时填写。

约束：

- 所有二进制值都必须走 `BinaryField`。
- 哈希值不属于 `BinaryField`，继续用原始 32 字节或十六进制字符串表达，具体由各方法文档定义。
- 大对象允许结合 transfer list 发送，但传输语义不变。

## 顶层报文

### `ready`

```ts
{
  v: 1,
  type: "ready"
}
```

`ready` 只表示 popup 已准备好开始收消息，不表示用户已授权任何操作。

### `request`

```ts
{
  v: 1,
  type: "request",
  id: "550e8400-e29b-41d4-a716-446655440000",
  method: "identity.get",
  params: {}
}
```

字段说明：

- `v`：协议版本。
- `type`：固定为 `request`。
- `id`：请求唯一标识。V1 中它同时承担“请求-响应关联”和“本次业务操作唯一标识”的职责。
- `method`：调用的方法名。
- `params`：方法参数。

### `result`

成功：

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: true,
  result: {}
}
```

失败：

```ts
{
  v: 1,
  type: "result",
  id: "550e8400-e29b-41d4-a716-446655440000",
  ok: false,
  error: {
    code: "user_rejected",
    message: "User rejected"
  }
}
```

字段说明：

- `id` 必须原样回显请求的 `id`。
- `ok=true` 时返回 `result`。
- `ok=false` 时返回 `error`。

## 安全边界

- Keymaster 必须只接受预期来源窗口的消息。
- Keymaster 必须校验 `event.origin` 与业务参数中的 `aud` 一致；不一致立即拒绝。
- 每次请求都必须使用新的 `id`。
- 所有 `identity.get` / `intent.sign` 请求都必须经过用户确认。
- 不存在“静默获取轻量身份信息”的特例。

## `id` 的语义

V1 约定：顶层 `request.id` 既是传输层请求 id，也是业务层操作 id。

约束：

- 每次新请求都必须生成新的 UUID。
- 同一个 `id` 不应重复用于不同操作。

## Claims 命名规则

`claims` 不额外返回 `provenance` 字段，来源语义隐藏在 claim 名本身中。

### 保留命名空间

- `key.*`
- `profile.*`
- `wallet.*`
- `verified.<issuer>.*`
- `imported.<issuer>.*`

示例：

- `key.label`
- `profile.nickname`
- `profile.email`
- `profile.avatar.sha256`
- `profile.avatar.image`
- `wallet.bsv.address.main`
- `verified.google.email`
- `imported.google.nickname`

约束：

- claim 名本身必须足以表达“属性是什么”和“这个属性按什么语义理解”。
- `profile.email` 只能表示用户在 Keymaster 中自填的邮箱，不能暗示“已验证邮箱”。
- 需要“已验证”语义时，必须进入 `verified.<issuer>.*` 命名空间。
- 图片、文件等二进制 claim 不走 URL 引用，必须直接传输真实内容。

## Claims 值类型

大多数 claim 值是普通 JS 值，例如字符串、数字、布尔值、普通对象、数组。

二进制 claim 必须使用 `BinaryField`：

```ts
{
  $type: "binary",
  mime: "image/png",
  bytes: avatarArrayBuffer
}
```

约束：

- `mime` 表示内容类型。
- `bytes` 是真实内容，不是 URL，不是 base64 字符串。
- 同一个资源如果同时存在哈希 claim 与本体 claim，两者必须对应同一份内容。

## `resolvedClaims`

`resolvedClaims` 表示 Keymaster 本次实际返回给调用方的 claim 真值。

约束：

- `resolvedClaims` 只返回请求里明确索要且当前存在的 claim。
- 不存在的 claim 不报错，直接省略。
- 对于二进制 claim，`resolvedClaims` 返回真实文件本体 / 图片本体 / 二进制本体。
- `resolvedClaims` 不因为签名实现需要而改变 claim 名，也不自动补派生 claim。

### 头像 claims

头像至少拆成两类 claim：

- `profile.avatar.sha256`
- `profile.avatar.image`

推荐读取流程：

1. 常规流程里先请求 `profile.avatar.sha256`。
2. 第三方站点发现哈希变化，说明用户更新了头像。
3. 再请求 `profile.avatar.image`，拿到图片本体。

示例：

```ts
{
  resolvedClaims: {
    "profile.avatar.sha256": "a3f5..."
  }
}
```

```ts
{
  resolvedClaims: {
    "profile.avatar.image": {
      $type: "binary",
      mime: "image/png",
      bytes: avatarArrayBuffer
    }
  }
}
```

## Claims 签名投影规则

当某个方法需要把 claims 纳入签名信封时，不直接把 `resolvedClaims` 整体原样塞入，而是使用“签名投影”。

投影列表格式：

```txt
[
  [claimName, claimValue],
  [claimName, claimValue]
]
```

约束：

- 按 `claimName` 字典序升序排序。
- `claimName` 是字符串。
- `claimValue` 是该 claim 的签名投影，不一定等于返回给调用方的真实值。

签名投影规则：

- 文本 / 数字 / 布尔值等轻量 claim：直接以对应值进入签名信封。
- 二进制 claim：不把本体直接放入签名信封，而是放该二进制本体的摘要投影。

二进制 claim 的摘要投影格式：

```txt
["binary", mime, sha256(bytes)]
```

说明：

- 第一项固定字符串 `"binary"`。
- 第二项是 `mime`；没有时用空字符串。
- 第三项是该二进制 claim 本体的 SHA-256 原始 32 字节。

关键语义：

- 例如 `profile.avatar.image`：
  - 在 `resolvedClaims` 里返回的是真实图片本体；
  - 在签名信封里记录的是同名 claim 的摘要投影；
  - claim 名不变，只是签名表示和返回表示不同。

- `profile.avatar.image` 的摘要投影规则，不等于自动生成一个 `profile.avatar.sha256` claim。
  - `profile.avatar.sha256` 仍然是独立、显式、可单独请求的业务 claim；
  - `profile.avatar.image` 的摘要投影只是签名实现规则，不改变对外业务语义。
