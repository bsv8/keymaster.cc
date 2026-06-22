# 001 Keymaster Protocol V1 对外协议硬切换一次性迭代施工单

## 参考需求文档

可以参考以下需求文档，施工与验收以这些文档与本单"本单补充定义"段的合集为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-identity-get-v1-draft.md`
- `docs/keymaster-intent-sign-v1-draft.md`
- `docs/keymaster-cipher-v1-draft.md`

需求文档与本单发生冲突时：

1. `docs` 里有明确定义的，以 `docs` 为准。
2. `docs` 留有缺口（草案未钉死）而本单"本单补充定义"段对缺口做了硬切换的，以本单为准。
3. 后续若要改本单补充定义，必须先改本单与对应 `docs` 段，再改 contract、测试向量、示例，保持单真值。

## 本单补充定义

> 本段是"草案缺口 → 硬切换补钉"集合。**只有本段**是允许施工单对协议
> 真值做扩展的部分；其它需求仍以 `docs` 为准。
>
> 改本段必须先同步改对应 `docs` 段，再改 contract、测试向量、示例。

- **`signature.bytes` 编码格式**：V1 固定为

  ```txt
  signature.bytes
    = 64-byte compact secp256k1 signature
    = r || s
    = BinaryField.bytes
  ```

  不支持 DER / recovered / 其它变体。`signature.bytes` 必须可直接被
  第三方接入方按 `r(32 bytes) || s(32 bytes)` 解析为两组 32 字节大整数
  再做 secp256k1 验签。若后续要换格式，必须先改本段与
  `docs/keymaster-identity-get-v1-draft.md` /
  `docs/keymaster-intent-sign-v1-draft.md`，再改 contract 与测试向量。

- **错误码集合**：V1 公开错误码为

  ```txt
  invalid_request
  invalid_origin
  user_rejected
  active_key_unavailable
  decrypt_failed
  internal_error
  ```

  `wallet_locked` **不**属于 V1 公开错误码。locked 态在 popup 内
  直接走解锁页（"情况 C"）；用户取消解锁统一回 `user_rejected`。
  任何"locked 时直接拒绝"的中间态都不属于 V1 公开语义。

## 目标

一次性把当前系统切到下面这套最终模型：

```txt
对外协议入口
  = 单一 popup 路由
  = /protocol/v1/popup
  = 一个 popup 只处理一个 request

协议承载
  = JS object + postMessage
  = 非 JSON 文本协议
  = 二进制统一 BinaryField

支持方法
  = identity.get
  = intent.sign
  = cipher.encrypt
  = cipher.decrypt

身份来源
  = 当前 active key
  = 不允许调用方指定“替哪把 key 签”

签名真值
  = 固定顺序数组
  = Deterministic CBOR
  = Keymaster 直接返回最终真值字节

cipher 站点绑定
  = 只认 event.origin 原样字符串
  = 不做 host / port / protocol 归一化

会话状态
  = popup 内存态
  = 不写 localStorage
  = 不写 IndexedDB
  = 不做恢复

用户授权
  = 四个方法全部必须用户确认
  = 钱包若锁定，先在 popup 内解锁，再继续当前请求
```

本次是硬切换，不接受：

1. 先做 `identity.get`，以后再补 `intent.sign` / `cipher`。
2. 先把对象协议做成 `JSON.stringify()` 文本，后面再换 BinaryField。
3. 先把 popup 放进 shell 页面里跑通，再以后补真正的协议 owner。
4. 先静默放过轻量 claim，后面再补确认页。
5. 先把请求或确认状态写进本地持久化，后面再清。

## 简述缘由

1. 这套需求不是单页面需求，而是贯穿 `contracts`、`web 入口`、`vault 签名`、`origin 安全边界`、`确认 UI`、`测试向量` 的平台协议。没有单一 owner，后面一定散。

2. 对外协议最怕中间态。第三方一旦开始接入，`popup 路由`、`request/result 结构`、`签名真值字节`、`origin 规则` 就会变成外部依赖。分步骤上线只会让接入方踩两套协议。

3. 当前仓库已经有 `vault.withPrivateKey()`、`keyspace.requireActiveKey()`、WebCrypto、现成插件宿主。正确方向不是再造一层通用消息平台，而是在现有插件体系上补一套最小但完整的协议实现。

4. 文档已经明确要求 Deterministic CBOR、`BinaryField`、`event.origin`、用户确认。如果实现时改成 JSON/base64/自定义对象签名，本质上就是没按需求落地。

5. 项目当前更需要简单、稳定、可验签的最终协议，而不是带兼容开关、可恢复会话、可插拔 claim provider 之类的扩展框架。

## 硬切换结论

### 一、协议 owner 固定为独立平台插件

新增单独的 `plugin-protocol`，它是这次对外协议的唯一 owner，负责：

- popup 页面；
- `postMessage` 收发与会话绑定；
- 请求校验；
- 确认流程；
- CBOR 真值编码；
- 签名与加解密；
- claim 解析。

不要把协议逻辑拆散到：

- `apps/web` 里一半；
- `plugin-vault` 里一半；
- 某个 shell 组件里再塞一半。

### 二、popup 入口固定为单一路由

最终只保留：

```txt
/protocol/v1/popup
```

不要为每个方法拆成：

```txt
/protocol/identity
/protocol/sign
/protocol/encrypt
/protocol/decrypt
```

原因很简单：transport、origin 绑定、unlock、确认、结果回传全都一样，拆路由只会复制状态机。

### 三、一个 popup 只处理一个 request

会话模型固定为：

```txt
popup 打开
-> popup 监听 message
-> 给 opener 发 ready
-> 接收第一条合法 request
-> 绑定 source + origin
-> 校验 / 解锁 / 确认 / 执行
-> 回 result
-> window.close()
```

本次不做：

- 同一 popup 多次请求复用；
- 请求队列；
- 历史恢复；
- 页面刷新续跑；
- 后台恢复。

### 四、claim 先做“通道完整”，不做过度平台化

本次先把 claim 协议模型、排序规则、二进制摘要投影、确认展示、遗漏策略一次性做对。

claim 数据源策略固定为：

1. 先支持现有系统里天然已有的真值，例如 `key.label`。
2. 其他 claim 只在当前仓库已有明确真值来源时再补。
3. 请求了但当前不存在的 claim，直接省略，不报错。
4. 不为这次需求顺手发明一套“通用 claim provider registry”平台。

这比为了未来想象出来的大抽象更符合当前项目状态。

### 五、签名格式缺口必须在实现里钉死

需求文档当前已经钉死：

- 被签名字节是什么；
- 怎么做 CBOR；
- 返回什么 envelope。

但它没有明确钉死“`signature.bytes` 的 secp256k1 编码格式”。

本缺口已收口在本文"本单补充定义"段（`signature.bytes` 编码格式），
本节不再重复钉死。`signature.bytes = 64-byte compact` 是该段的硬切换
定义，不允许边写代码边猜，也不能一部分测试按 compact、一部分对外示例
按 DER。

## 核心不变量

1. 顶层 transport 报文只能是 structured clone 可传输对象。
2. 所有二进制字段只能使用 `BinaryField`，不允许 base64 字符串偷渡。
3. `identity.get` 与 `intent.sign` 必须校验 `params.aud === event.origin`。
4. `cipher.encrypt` / `cipher.decrypt` 不接收 `aud`，只认 `event.origin`。
5. `event.origin` 必须原样参与逻辑，不补默认端口、不 lower host、不改写协议。
6. 所有方法都必须经过用户确认，没有静默模式。
7. subject 永远是当前 active key，不允许请求方指定 keyId / publicKeyHex。
8. `identityEnvelope` / `signedEnvelope` 返回的是最终 Deterministic CBOR 真值字节，不是待调用方重编码的对象。
9. `resolvedClaims` 只返回请求且存在的 claim；不存在的直接省略。
10. 二进制 claim 的签名投影必须是 `["binary", mime, sha256(bytes)]`。
11. popup 会话只保留内存态；用户刷新、关闭、opener 丢失都视为会话结束。
12. 错误信息代码里保持英文；文档、注释、页面说明保持中文。

## 不能怎么做

1. 不能把协议 owner 放在 `apps/web` 散落组件里，导致签名、校验、origin 逻辑没有单一真值。

2. 不能在 transport 层使用：

```txt
JSON.stringify()
base64 bytes
stringified ArrayBuffer
```

来替代 `BinaryField`。

3. 不能让 `identity.get` / `intent.sign` 的 `aud` 只展示不校验。

4. 不能把 `event.origin` 规范化后再比对，例如自动补 `:443`、把 host 转写、去掉斜杠后再比较。

5. 不能把 `cipher` 的站点绑定做成“由调用方传一个 `aud`，Keymaster 相信它”。`cipher` 必须只认消息真实来源。

6. 不能把 pending request、claim 真值、待解锁状态、签名前真值写入 `localStorage`、`sessionStorage`、`IndexedDB`、URL query、hash。

7. 不能先上一个“无确认页的开发版协议”，后面再补确认。外部协议一旦暴露出去，就会被拿来集成。

8. 不能为了“灵活”做多 popup 复用、多请求并发、多标签协同。这些都不是当前需求，且复杂度远高于价值。

9. 不能自己手写“差不多像 CBOR”的编码器，或者退回 `JSON.stringify()` 再签名。

10. 不能把 `ProtocolPopupPage` 直接写成大杂烩组件，里面同时做 message transport、校验、密码学、claim 解析、UI 渲染，但没有可测试服务层。

11. 不能把不支持的 claim 当错误拦整个 `identity.get`。文档已经说了：不存在的 claim 直接省略。

12. 不能为了未来扩展，顺手再造一套“协议插件二级注册表”“claim provider 市场”“可插拔算法协商框架”。V1 明确不需要。

## 应该怎么做

### 一、先补公共 contract，再补实现

在 `packages/contracts` 先把协议公共类型钉死，至少包括：

- `BinaryField`
- `ProtocolReadyMessage`
- `ProtocolRequestMessage`
- `ProtocolResultMessage`
- `ProtocolError`
- `ProtocolMethod`
- `IdentityGetParams` / `IdentityGetResult`
- `IntentSignParams` / `IntentSignResult`
- `CipherEncryptParams` / `CipherEncryptResult`
- `CipherDecryptParams` / `CipherDecryptResult`
- `ResolvedClaimValue`

这样后续 `plugin-protocol`、`apps/web`、测试夹具、第三方示例代码才能共享同一套对象模型。

### 二、把协议实现收敛成 service + page 两层

建议固定分层：

```txt
ProtocolPopupPage
  只负责：
    绑定页面生命周期
    渲染 unlock / confirm / result / error UI
    调 protocolService

protocolService
  负责：
    ready / request / result transport
    request 校验
    source + origin 绑定
    调 vault / keyspace
    claim 解析
    envelope 构造
    sign / encrypt / decrypt
```

这样 `postMessage` 状态机和 UI 不会互相污染，单测也能落到 service 层。

### 三、把顶层 app 入口补一条 protocol 特例

当前 `apps/web/src/App.tsx` 只按 vault 状态渲染 `LockedShell` / `UnlockedShell`。这对正常站内导航没问题，但对协议 popup 不够。

本次必须改成：

```txt
如果 path 命中 /protocol/v1/popup
  App.tsx 仅做”放行”：直接渲染协议入口页面
  真正的页面、状态机、逻辑 owner 仍是 plugin-protocol
  App.tsx 不再”另起一套入口”

其它路径
  保持现有 LockedShell / UnlockedShell 逻辑
```

否则钱包锁定时根本进不到”协议页内先解锁再继续请求”的路径。

**入口 owner 收口（避免两套真值）**：

- `/protocol/v1/popup` → ProtocolPopupPage 的入口**只有一条**。
  App.tsx 是这条路径上唯一的”放行点”；plugin-protocol **不**再
  把这个路径注册到 `route.registry`，避免 “route.registry 路径 →
  组件” 与 “App.tsx 特例直接渲染” 两套映射并存。
- 协议页的所有真值（页面组件、状态机、capability、消息收发、签名、
  加解密、claim 解析）都收敛在 `plugin-protocol` 内部。
- `App.tsx` **不**持有协议状态；它只是”识别 path → 直接渲染”的
  壳层 gate。后续如果新增 `/protocol/v1/foo`，仍然由 App.tsx 加
  分流 + plugin-protocol 暴露新页面，而不是新搭一条入口路径。

**接线落地（必须显式，禁止隐式）**：

App.tsx 拿 `ProtocolPopupPage` 必须从 `plugin-protocol` 的**唯一公开
入口**走：

```ts
// apps/web/src/App.tsx
import { ProtocolPopupPage } from “@keymaster/plugin-protocol”;
```

禁止：

- `import { ProtocolPopupPage } from “@keymaster/plugin-protocol/src/ProtocolPopupPage.js”`
  这种 deep import；任何 deep import 都破坏单 owner 边界。
- 通过 `route.registry` / `RouteRenderer` 间接拿 `ProtocolPopupPage`；
  这条路径**只能**走 App.tsx 顶层特例直接渲染。
- 任何”复制一份简化版 ProtocolPopupPage 到 apps/web 内部”的折中；
  这会让”页面 owner 是 plugin-protocol”塌方。

`apps/web/package.json` 必须显式声明 `”@keymaster/plugin-protocol”: “*”`
依赖；不允许靠 transitive deps 凑出 import。

### 四、CBOR 与密码学都做成集中 helper

建议新增：

- `protocolCbor.ts`
- `protocolCrypto.ts`

规则：

1. `protocolCbor.ts` 统一负责 Deterministic CBOR 编码/解码，业务层不散落库调用。
2. `protocolCrypto.ts` 统一负责：
   - `sha256`
   - `signCompactSecp256k1`
   - `deriveSiteKey`
   - `aesGcmEncrypt`
   - `aesGcmDecrypt`
3. `cipher` 不复用 vault 的“密码加密私钥”逻辑；它和 vault 的职责不同。
4. `identity.get` / `intent.sign` 的签名都走同一个 secp256k1 helper。

### 五、claim 解析先按固定表处理

新增 `protocolClaims.ts`，里面维护一份明确的解析表。

本次先固定：

1. `key.label` 必须支持。
2. 不存在明确本地真值来源的 claim，直接省略。
3. 二进制 claim 一旦支持，必须同时走：
   - `resolvedClaims` 返回本体；
   - envelope 内写摘要投影。
4. 不要为了这一期发明 claim provider registry。

### 六、统一错误语义

本次只保留有限错误码，够用就行，不扩写一大串 taxonomy。

V1 公开错误码集合已收口在本文"本单补充定义"段（错误码集合），本节
不再重复列出。该集合**不**包含 `wallet_locked`：locked 态在 popup
内直接走解锁页（"情况 C"），用户取消解锁统一回 `user_rejected`。

规则：

1. 对外 `error.code` 固定、可判定，与"本单补充定义"段集合保持一致。
2. `error.message` 用英文。
3. `cipher.decrypt` 对 origin 不匹配、nonce 错误、密文损坏统一报 `decrypt_failed`，不要泄漏细分原因。
4. 任何"locked 时直接拒绝"的中间态**不**属于 V1 公开语义，禁止新
   加 `wallet_locked` / 类似的"locked 透传错误码"。

## 特殊情况提前约定

### 情况 A：popup 成功打开，但 `window.opener` 不存在

处理：

1. 不进入正常协议流程。
2. 页面显示一个简短错误状态。
3. 不重试、不轮询、不落库。
4. 用户只能关闭 popup 并让调用方重新发起。

### 情况 B：popup 已发 `ready`，收到的第一条消息不是合法 request

处理：

1. 直接忽略非协议消息。
2. 第一条合法 `request` 才绑定会话。
3. 一旦已绑定，会话只接受该 `source + origin` 后续消息。

### 情况 C：已绑定 request，但钱包当前是 locked

处理：

1. 在 popup 内显示解锁界面。
2. 解锁成功后继续同一条 pending request。
3. 不要求调用方重新发起。
4. 用户取消解锁视为 `user_rejected`。

### 情况 D：当前没有 active key，或者 active key 身份未 ready

处理：

1. 不进入确认页。
2. 直接返回 `active_key_unavailable`。
3. 不允许调用方指定另一把 key 兜底。

### 情况 E：`identity.get` / `intent.sign` 的 `exp <= iat`

处理：

1. 直接返回 `invalid_request`。
2. 不进入确认页。
3. 本地有效期上限同样在这个阶段校验，不要等用户点确认后才拒绝。

### 情况 F：请求里的 claim 部分存在、部分不存在

处理：

1. 确认页展示“请求方索要了哪些 claim 名”。
2. 实际返回时只带存在的 claim。
3. 不因为单个 claim 缺失而失败。

### 情况 G：二进制 claim 没有 `mime`

处理：

1. `resolvedClaims` 中 `mime` 允许缺省。
2. 签名投影时第二项写空字符串。
3. 不允许因为缺 `mime` 就把该 claim 当成文本 claim。

### 情况 H：用户已确认，但 popup 执行前 `window.opener` 被关闭

处理：

1. 仍然完成本地计算没意义，应该在真正回传前先判断 opener/source 是否还存在。
2. 若无法回传，直接结束本地流程并允许 popup 自行关闭。
3. 不做“结果暂存，等调用方回来再取”。

### 情况 I：用户刷新 popup

处理：

1. 视为会话丢失。
2. 页面重新进入等待 request 状态。
3. 不从本地存储恢复旧请求。

### 情况 J：外部验签方对 `signature.bytes` 期望 DER

处理：

1. 以本文"本单补充定义"段钉死的 compact 64-byte 为准（不允许
   在本节、其它节、代码注释、对外文档里另写一套编码）。
2. 不在实现里偷偷双格式输出。
3. 若要换 DER，必须**先**改"本单补充定义"段与对应 `docs` 段
   （identity / intent.sign），再改 contract 与测试向量——保持
   单一真值。

## 文件级一次性迭代施工单

### 一、`packages/contracts`

#### 1. `packages/contracts/src/protocol.ts`（新增）

新增协议公共契约，定义：

- `BinaryField`
- 顶层 message union
- 四个方法的 params/result
- error code
- claim value 类型
- popup 会话里需要的最小状态类型

注释里直接写清楚：

- `BinaryField` 只能承载真实二进制；
- `identityEnvelope` / `signedEnvelope` 是最终真值字节；
- `signature.bytes` 固定 compact 64-byte（具体编码以"本单补充定义"段
  为准，contract 注释里只引用、不另写）。

#### 2. `packages/contracts/src/index.ts`

导出 `protocol.ts`。

### 二、`packages/plugin-protocol`（新增整个 package）

#### 3. `packages/plugin-protocol/package.json`（新增）

声明新插件包与所需依赖。若引入 Deterministic CBOR 库，依赖只加在这里，不污染无关包。

#### 4. `packages/plugin-protocol/tsconfig.json`（新增）

对齐现有 plugin 包结构。

#### 5. `packages/plugin-protocol/src/index.ts`（新增）

这是 `plugin-protocol` 的**唯一**对外公开入口；下游（`apps/web`、
未来第三方接入方、tests）只能从这里 import 协议层 API。

必须显式导出：

- `protocolPlugin`（manifest 装配用）
- `ProtocolPopupPage`（**协议页 React 组件**，供 `apps/web/src/App.tsx`
  顶层特例直接渲染；这是协议页**唯一**被 `App.tsx` 使用的导出）
- `PROTOCOL_SERVICE_CAPABILITY`（contracts 已导出，这里再 re-export 一份
  便于 plugin host 装配）
- 协议层 helper：`createProtocolService` / `ProtocolServiceImpl` /
  `ProtocolValidationError` / `parseRequestMessage` / `cborEncode` /
  `cborDecode` / `signCompactSecp256k1` / `verifyCompactSecp256k1` /
  `deriveSiteKey` / `aesGcmEncrypt` / `aesGcmDecrypt` /
  `CIPHER_CONTEXT_V1` / `buildClaimProjection` /
  `buildClaimProjectionFromParams` / `resolveClaims` /
  `resolveBuiltinClaim`

约束：

- 内部实现文件（`protocolCbor.ts` / `protocolCrypto.ts` /
  `protocolClaims.ts` / `protocolValidation.ts` / `protocolService.ts` /
  `manifest.ts` / `ProtocolPopupPage.tsx`）**不**是公开入口；
  下游**禁止**走 `@keymaster/plugin-protocol/src/xxx.js` 这种 deep
  import；任何 deep import 都是单 owner 边界破坏。
- `App.tsx` 拿页面必须走 `import { ProtocolPopupPage } from
  "@keymaster/plugin-protocol"`，而不是直接指向 `ProtocolPopupPage.tsx`。

#### 6. `packages/plugin-protocol/src/manifest.ts`（新增）

负责：

- **不**注册 `/protocol/v1/popup` 路由（见 §硬切换结论 三、入口 owner 收口）；
  协议页**唯一**入口由 `apps/web/src/App.tsx` 顶层特例放行，
  plugin-protocol 不参与 `route.registry` 路径映射；
- 提供 `protocol.service` capability；
- 注册协议页所需 i18n 文案；
- 声明依赖 `vault.service` 与 `keyspace.service`。

#### 7. `packages/plugin-protocol/src/protocolService.ts`（新增）

这是核心实现文件，负责：

- `ready` 发送；
- request/source/origin 绑定；
- method 分发；
- request 校验；
- 用户确认前后的状态推进；
- 调用 `vault.withPrivateKey()`；
- 产出 `result`。

设计要求：

- 一次只处理一个 request；
- service 不依赖 React 组件状态；
- request 校验与业务执行分离成独立函数。

#### 8. `packages/plugin-protocol/src/protocolValidation.ts`（新增）

负责：

- 顶层 message 结构校验；
- `aud` / `iat` / `exp` 规则；
- `BinaryField` 形状校验；
- `contentType` / `text` 等字段约束。

不要把这些判断散落在 React 组件和执行函数里。

#### 9. `packages/plugin-protocol/src/protocolClaims.ts`（新增）

负责：

- claim 解析；
- claim 名排序；
- `resolvedClaims` 组装；
- 签名投影组装；
- 二进制 claim 摘要投影。

本次先至少支持 `key.label`，其它 claim 按“有源则回、无源则省略”处理。

#### 10. `packages/plugin-protocol/src/protocolCbor.ts`（新增）

集中封装 Deterministic CBOR 编码/解码。

要求：

- identity/sign/cipher 都走这里；
- 不允许业务代码直接调用第三方 CBOR 库 API；
- 需要有最小测试向量。

#### 11. `packages/plugin-protocol/src/protocolCrypto.ts`（新增）

集中封装：

- `sha256(bytes)`
- `signCompactSecp256k1(privateKeyHex, bytes)`
- `deriveSiteKey(privateKeyHex, exactOrigin)`
- `aesGcmEncrypt(siteKey, plainBytes)`
- `aesGcmDecrypt(siteKey, nonce, cipherbytes)`

要求：

- `deriveSiteKey` 严格按 `HMAC-SHA256(privateKeySecret, "keymaster:cipher:v1|"+exactOrigin)`；
- `AES-GCM` nonce 固定 12 字节随机；
- 解密失败统一抛英文错误。

#### 12. `packages/plugin-protocol/src/ProtocolPopupPage.tsx`（新增）

负责 popup UI：

- 等待 ready/request；
- 锁定态解锁；
- 展示确认内容；
- 展示执行中；
- 展示失败态；
- 完成后关闭窗口。

要求：

- 不把密码学逻辑写进组件；
- 不把 request 永久保存；
- 文案中文，错误 message 原样显示英文。

### 三、`apps/web`

#### 13. `apps/web/package.json`

把 `@keymaster/plugin-protocol` 加入依赖。

#### 14. `apps/web/src/bootstrapPlugins.ts`

注册 `protocolPlugin`。

顺序要求：

- `vaultPlugin` 之后；
- 其它业务插件之前或之后都可以，但协议依赖的 `vault.service` / `keyspace.service` 必须已存在。

#### 15. `apps/web/src/App.tsx`

补一条 protocol 顶层分流（**仅做放行，不持有协议状态**）：

```txt
path = /protocol/v1/popup
  -> 渲染协议路由入口（页面来自 plugin-protocol）

其它 path
  -> 保持现有 LockedShell / UnlockedShell
```

**入口 owner 收口**：

- `App.tsx` 是 `/protocol/v1/popup` 这条路径上唯一的"放行点"；
- 真正的页面、状态机、capability、消息收发、签名、加解密、claim 解析
  等所有协议真值都收敛在 `plugin-protocol` 内部；`App.tsx` 不持有
  任何协议状态；
- 配套：`plugin-protocol/manifest.ts` **不**再向 `route.registry`
  注册这条路径，避免 "route.registry 路径 → 组件" 与
  "App.tsx 特例直接渲染" 两套映射并存。

**接线（必须显式，不可隐式）**：

`App.tsx` 必须从 `plugin-protocol` 的**唯一公开入口**拿页面：

```ts
import { ProtocolPopupPage } from "@keymaster/plugin-protocol";
```

约束：

- 禁止 `import { ProtocolPopupPage } from "@keymaster/plugin-protocol/src/ProtocolPopupPage.js"`
  这种 deep import；任何 deep import 都意味着单 owner 边界被破坏。
- 禁止再把 `ProtocolPopupPage` 通过 `route.registry` 间接拿到；这条
  路径**只能**走 `App.tsx` 顶层特例直接渲染。
- `apps/web/package.json` 必须显式声明 `"@keymaster/plugin-protocol": "*"`
  依赖；如果没声明，TS / Vite 会从 transitive deps 凑出 import，
  后续清理时极易破坏。

这是本次落地里最关键的 app 级改动之一。

### 四、工程接线

#### 16. `tsconfig.json`

把新 package 加进 project references。

#### 17. `package-lock.json`

同步 workspace 与依赖变更。

### 五、测试文件

#### 18. `packages/plugin-protocol/src/protocolService.test.ts`（新增）

覆盖：

- ready -> request -> result 正常流程；
- `aud !== event.origin` 拒绝；
- 锁定态解锁后继续；
- 无 active key 拒绝；
- claim 省略规则；
- identity/sign envelope 字节稳定；
- cipher 同 origin 可解、异 origin 不可解。

#### 19. `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`（新增）

覆盖：

- 等待 request；
- 锁定态显示解锁；
- 确认页展示来源/文案/claims/contentType；
- 用户拒绝返回 `user_rejected`；
- 完成后触发关闭流程。

#### 20. `apps/web/src/App.protocol.test.tsx`（新增）

覆盖：

- `/protocol/v1/popup` 不被 `LockedShell` 吃掉；
- 钱包 locked/unlocked 时都能进入协议页面；
- 非协议路径仍保持原壳层逻辑。

## 最终验收清单

### 一、结构验收

1. 仓库里存在单独的 `packages/plugin-protocol`，而不是把协议散落塞进现有 shell 或 vault 页面。
2. `packages/contracts` 已导出统一的 protocol 类型。
3. 协议入口路由只有 `/protocol/v1/popup` 一条；这条路径**只**由
   `apps/web/src/App.tsx` 顶层特例放行到 `plugin-protocol` 的
   `ProtocolPopupPage`，`plugin-protocol/manifest.ts` **不**向
   `route.registry` 注册此路径。
4. `App.tsx` 已有 protocol 顶层分流，且**仅**做放行、不持有协议
   状态；任何协议真值仍收敛在 `plugin-protocol` 内部。
5. **接线验收**：
   - `apps/web/src/App.tsx` 通过
     `import { ProtocolPopupPage } from "@keymaster/plugin-protocol"`
     拿页面（**禁止** deep import 内部 `ProtocolPopupPage.tsx`）。
   - `apps/web/package.json` 显式声明 `"@keymaster/plugin-protocol": "*"`
     依赖（**禁止**靠 transitive deps 凑出 import）。
   - `packages/plugin-protocol/src/index.ts` 显式 re-export
     `ProtocolPopupPage` 与 `protocolPlugin`。
   - 全仓库搜索 `@keymaster/plugin-protocol/src/` 必须 0 hit（除
     `packages/plugin-protocol` 自身内部 cross-file import 外）。

### 二、transport 验收

1. popup 打开后，只有在消息监听已安装完成后才发送 `ready`。
2. `ready` 不携带敏感数据。
3. 第一条合法 `request` 会绑定 `source + origin`。
4. 绑定后不会接受其它来源窗口的消息。
5. `result.id` 会原样回显 `request.id`。

### 三、`identity.get` 验收

1. `aud` 不匹配真实 `event.origin` 时，请求直接失败。
2. 成功返回中包含：
   - `identityEnvelope`
   - `signature`
   - `subject.publicKey`
   - `resolvedClaims`
3. `identityEnvelope.bytes` 是 Deterministic CBOR 最终字节，不要求调用方重编码。
4. `resolvedClaims` 只返回请求且存在的 claim。
5. 二进制 claim 若存在，`resolvedClaims` 返回本体，envelope 内只写摘要投影。

### 四、`intent.sign` 验收

1. 确认页展示 `aud`、`text`、`contentType`、有效期。
2. `signedEnvelope` 内签的是 `contentSha256`，不是把原始大内容直接塞进 envelope。
3. `signature.bytes` 固定是 compact 64-byte（编码由"本单补充定义"段
   钉死；本节只引用、不另写一份编码规则）。
4. 调用方验签时只需要 `signedEnvelope.bytes + signature.bytes + subject public key`。

### 五、`cipher` 验收

1. `cipher.encrypt` / `cipher.decrypt` 全都要求用户确认。
2. `cipher.encrypt` 返回 `nonce + cipherbytes`，不回显 `contentType`。
3. 同一私钥、同一 `exactOrigin`、同一协议版本可以成功解密。
4. origin 改掉后解密失败。
5. `cipher.decrypt` 在 origin 不匹配、nonce 错、密文损坏三种情况下都统一表现为失败，不泄漏细分原因。

### 六、安全边界验收

1. 没有任何协议中间态写入 `localStorage`、`sessionStorage`、`IndexedDB`、URL。
2. 没有任何静默批准路径。
3. 钱包 locked 时，请求只会在 popup 内先解锁再继续，或者被拒绝，不会绕过。
4. `event.origin` 没有被 normalize。
5. 代码里不存在 `JSON.stringify(protocolMessage)` 作为正式 transport 的逻辑。

### 七、特殊情况验收

1. `window.opener` 缺失时不会进入半残协议状态。
2. popup 刷新后不会恢复旧 request。
3. 不存在的 claim 不会把整个 `identity.get` 打挂。
4. 无 active key 时返回明确错误。
5. 用户取消解锁或取消确认，都会得到 `user_rejected`。

### 八、自动化验收

执行并通过：

1. `npm run typecheck`
2. `npm run test`
3. `npm run lint:boundaries`

### 九、人工验收

至少手工验证下面几条：

1. 外部页面打开 `/protocol/v1/popup`，能稳定收到 `ready`。
2. 钱包已解锁时，`identity.get` 能正常确认并回传结果。
3. 钱包锁定时，popup 会先要求解锁，解锁后继续同一请求。
4. `intent.sign` 可以对给定二进制内容生成可验签结果。
5. `cipher.encrypt` 的结果在相同 origin 可解，在不同 origin 失败。

## 施工结束判定

只有当下面三件事同时成立，本单才算完成：

1. 外部协议四个方法都已按草案落地，不存在“先临时跑一个子集”的中间态。
2. popup 顶层入口、service owner、contract、测试向量已经统一成一套最终事实。
3. 验收时第三方接入方不需要猜消息结构、签名真值、origin 语义、错误行为。
