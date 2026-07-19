# 001 ECDSA 签名编码格式显式契约硬切换一次性迭代施工单

## 参考文档与代码

本次施工、联调与验收以下列文档和代码为准：

- `docs/protocol/keymaster-protocol-v1-draft.md`
- `docs/protocol/keymaster-identity-get-v1-draft.md`
- `docs/protocol/keymaster-intent-sign-v1-draft.md`
- `packages/contracts/src/activeKeyCrypto.ts`
- `packages/contracts/src/sessionCoordinator.ts`
- `packages/plugin-vault/src/sessionCryptoCore.ts`
- `packages/plugin-vault/src/sessionCryptoClient.ts`
- `packages/plugin-vault/src/sessionCryptoWorker.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.ts`
- `packages/plugin-protocol/src/protocolCrypto.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`
- `packages/plugin-protocol/src/feepoolSdk.ts`

发生冲突时：

1. 对外 `identity.get` / `intent.sign` 签名格式以协议 docs 的固定
   64-byte compact 定义为准。
2. Bitcoin P2PKH / fee pool 交易输入签名以 Bitcoin Script 的 strict DER
   约束为准。
3. 本单定义 `ActiveKeyCrypto`、Session Worker 与 Coordinator 的内部签名
   capability 契约；该部分优先于现有实现中任何依赖默认格式或猜测长度的
   行为。
4. 后续若新增签名格式，必须先改本单、contract 和调用方测试，再改实现；
   不允许只在某一层默默变更输出编码。

---

## 1. 背景与问题

当前 `ActiveKeyCrypto.signDigest({ publicKeyHex, digest })` 的输入和输出均
不包含签名编码格式。Vault session signer 按 Bitcoin 交易路径产出 DER，
而 `identity.get` / `intent.sign` 按协议要求消费 64-byte compact `r || s`。
两边使用的都是同一份 ECDSA 数学签名，但二进制编码不同：

```txt
同一 ECDSA (r, s)
  ├─ Bitcoin transaction script  -> ASN.1 DER（可变长，常见 70~72 bytes）
  └─ Keymaster protocol envelope -> compact r || s（固定 64 bytes）
```

此前协议层通过“收到非 64 字节就失败”暴露问题；临时修复把 DER 转成
compact。该兼容行为解决了当前 `identity.get` 失败，但仍让底层 capability
的真实输出格式保持不透明。只要以后新增调用方，仍可能重演同类错误。

问题不在于 DER 或 compact 谁“更正确”，而在于一个未声明格式的
`signDigest` 被不同格式消费者复用。

---

## 2. 本单目标

本次是一次**硬切换**，完成后系统必须满足：

1. 所有受控 ECDSA digest 签名调用都必须显式提供 `format`。
2. `ActiveKeyCrypto`、Session Worker、Coordinator RPC 的签名请求与响应
   都携带相同且受限的 `format`。
3. 没有默认格式；缺少、未知或与响应不一致的格式一律失败。
4. `identity.get` / `intent.sign` 只请求和接受 `compact`；不再做 DER
   fallback 或转换。
5. P2PKH transfer 与 fee pool 所有需要放进交易脚本的签名只请求和接受
   `der`。
6. 所有受控 signer 都以同一 `(privateKey, digest, format)` 产生对应格式，
   且保持 secp256k1 ECDSA、`lowS = true`、`prehash = false` 语义。
7. 删除旧的“未携带格式”的 `signDigest` contract、RPC operation、worker
   message、实现、mock 和测试 fixture；不保留兼容入口、默认值、隐式转换或
   feature flag。

本次不涉及：

- 私钥、Vault、connect session、用户身份或链上数据迁移；
- IndexedDB / localStorage 新字段或数据回填；
- 对外 Keymaster envelope 格式变更；
- DER 与 compact 之外的新算法（Schnorr、recovered signature 等）。

格式是能力调用的即时契约，不是必须持久化的业务数据。已固定格式的外部
协议无需额外存一个 `format` 字段：协议定义本身就是格式真值。

---

## 3. 最终模型（唯一真值）

### 3.1 统一格式枚举

在 `packages/contracts/src/activeKeyCrypto.ts` 定义并导出：

```ts
export type EcdsaSignatureFormat = "der" | "compact";
```

语义固定：

| `format` | 真实字节 | 长度 | 允许消费者 |
|---|---|---:|---|
| `"der"` | strict ASN.1 DER ECDSA signature | 可变，通常 70–72 | P2PKH / fee pool Bitcoin Script |
| `"compact"` | `r(32 bytes) || s(32 bytes)` | 64 | Keymaster identity / intent protocol envelope |

不支持：`recovered`、Schnorr、`raw`、base64/hex 文字串、`undefined`、默认值。

### 3.2 ActiveKeyCrypto 新契约

旧契约：

```ts
signDigest({ publicKeyHex, digest })
  -> { publicKeyHex, signature }
```

最终契约：

```ts
export interface ActiveKeyCryptoSignDigestInput {
  publicKeyHex: string;
  digest: ArrayBuffer; // 必须恰好 32 bytes
  format: EcdsaSignatureFormat;
}

export interface ActiveKeyCryptoSignDigestResult {
  publicKeyHex: string;
  format: EcdsaSignatureFormat;
  signature: ArrayBuffer;
}
```

`ActiveKeyCrypto.signDigest` 名称可以保留，但**旧的无 `format` 签名已经
删除**，因此这是 source-level hard break。结果携带 `format` 是为了让每一
段 RPC / worker 边界都能校验“响应是否确实对应请求”；业务层不得依此改写
已由协议规定的对外格式。

实现必须同时验证：

```txt
input.digest.byteLength === 32
input.format ∈ { der, compact }
result.format === input.format
result.signature 的实际编码和长度符合 result.format
```

### 3.3 签名生成唯一入口

`packages/plugin-vault/src/sessionCryptoCore.ts` 不再保留语义模糊的：

```ts
signDigestBytes(privateKeyBytes, digest) // 旧：隐式 DER
```

替换为：

```ts
signEcdsaDigest({ privateKeyBytes, digest, format }): Promise<Uint8Array>
```

固定算法：

```txt
ECDSA/secp256k1
digest: 已哈希 32-byte digest（不二次 hash）
prehash: false
lowS: true
format: 调用方必传 der 或 compact
```

该函数是 session worker、本地 fallback 和 SharedWorker Coordinator 的共同
真值。不得再各自手写 `r/s -> DER` 或 `r/s -> compact`。

---

## 4. 硬切换范围与实施步骤

### 4.1 先冻结 contract，再改实现

1. 修改 `packages/contracts/src/activeKeyCrypto.ts`：新增
   `EcdsaSignatureFormat`，在 sign input/result 中加入必填 `format`。
2. 修改 `packages/contracts/src/sessionCoordinator.ts`：

   ```ts
   { type: "signDigest"; digestHex: string; format: EcdsaSignatureFormat }
   { type: "signDigest"; signatureHex: string; format: EcdsaSignatureFormat }
   ```

3. 所有 mock、stub、fake 与 TypeScript 编译错误必须在本次一并修完；不得
   用 `as unknown as`、可选字段、默认 `"der"` 来临时绕过。

### 4.2 收口 Vault / Session signing 实现

修改以下路径，使其原样转发并校验 `format`：

- `packages/plugin-vault/src/sessionCryptoCore.ts`
- `packages/plugin-vault/src/sessionCryptoProtocol.ts`
- `packages/plugin-vault/src/sessionCryptoWorker.ts`
- `packages/plugin-vault/src/sessionCryptoClient.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/plugin-vault/src/vaultServiceCoordinator.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.ts`
- `apps/web/src/keymasterSessionCoordinatorClient.ts`

具体要求：

1. `SessionCryptoSignDigestMessage` 加必填 `format`；worker response 也带
   `format`。
2. postMessage transfer 的 `ArrayBuffer` 只传实际签名字节切片，不能误传
   有额外 byteOffset/byteLength 的底层 buffer。
3. Coordinator `crypto` RPC 的 request/result 都传 `format`；Coordinator
   signer 只按该格式调用核心函数。
4. `vaultServiceCoordinator` 的 hex 编解码路径必须校验 response 的
   `format` 与 input 一致后才构造 `ActiveKeyCryptoSignDigestResult`。
5. 本地 fallback、worker-backed runtime、Coordinator-backed runtime 对相同
   私钥、digest、format 的结果必须可由同一公钥验签。

### 4.3 让每个业务调用点显式选择格式

#### 协议签名：固定 compact

修改 `packages/plugin-protocol/src/protocolService.ts`：

```ts
crypto.signDigest({ publicKeyHex, digest, format: "compact" })
```

适用所有 identity assertion 与 intent envelope 签名路径，特别是
`signWithSessionOwner()`。

修改 `packages/plugin-protocol/src/protocolCrypto.ts`：

- `signCompactSecp256k1` 只接受长度恰好 64 的结果；
- 删除本次临时加入的 `DER -> compact` fallback；
- 不解析 DER，不猜测长度，也不产生协议层格式转换。

协议 docs 中的 `signature.bytes = 64-byte compact r || s` 保持不变。

#### 链上签名：固定 DER

修改所有将签名放入 Bitcoin transaction script 的调用点：

- `packages/plugin-p2pkh/src/p2pkhTransferService.ts`
- `packages/plugin-protocol/src/protocolService.ts` 的 `feepool.*` signer
- `packages/plugin-protocol/src/feepoolSdk.ts` 的类型和变量名

统一调用：

```ts
crypto.signDigest({ publicKeyHex, digest, format: "der" })
```

并在进入 scriptSig / witness-like payload 前断言结果为 strict DER。变量名
必须用 `signDerDigest` / `derSignature` 等表达格式，不得继续把未标注格式的
`signature` 直接拼入交易。

#### 不在本单迁移范围的独立 signer

`plugin-appmsg`、`plugin-broadcast`、`plugin-poker` 的独立签名 helper 不经
`ActiveKeyCrypto.signDigest`，且已有各自协议格式；本单不改变其 wire format。
但施工时必须确认它们没有调用旧的无格式 ActiveKeyCrypto API。若发现调用，
按真实消费者格式迁移，不能留例外。

### 4.4 删除旧理解与兼容实现

以下内容在同一个变更中必须删除：

1. 无 `format` 的 `ActiveKeyCryptoSignDigestInput` / Result 定义。
2. 无 `format` 的 Coordinator `signDigest` request/result。
3. `sessionCryptoCore.signDigestBytes` 的隐式 DER 语义及其 export。
4. 协议层的 DER -> compact 转换 fallback。
5. `format ?? "der"`、按 `signature.byteLength` 推断格式、先尝试 compact
   再尝试 DER、仅靠函数名/注释约定格式等任何兼容行为。
6. 所有旧 mock、fixture 与文档中“`signDigest` 默认返回 DER/compact”的叙述。

本单不允许双接口过渡：

```ts
signDigest(digest)                 // 禁止
signDigest({ digest })             // 禁止
signDigest({ digest, format })     // 唯一允许
```

---

## 5. 关键安全与一致性约束

1. `compact` 必须恰好 64 bytes，按 `r || s`，不是 recoverable 65-byte
   signature。
2. `der` 必须是 strict DER；不得把 compact 原样标成 DER，也不得接受一个
   “能被宽松解析”的非 canonical DER。
3. 所有 signer 都使用 low-S；格式转换或编码不得改变 `(r, s)` 的数学值。
4. 输入 digest 必须恰好 32 bytes；调用方负责先进行 SHA-256 / BIP143
   sighash，signer 不做隐式二次 hash。
5. public key 绑定、session revoked、owner mismatch、locked 等既有安全检查
   不因新增 `format` 被跳过。
6. 任何跨 worker / coordinator 的 response 若 `format` 不匹配 request，
   视为内部错误并丢弃签名，不得降级使用。

---

## 6. 测试与验收

### 6.1 纯密码学测试

为 `signEcdsaDigest` 增加测试向量，覆盖：

1. 同一私钥与 32-byte digest 请求 `compact`，输出恰好 64 bytes，使用
   `secp256k1.verify(..., { prehash: false, format: "compact" })` 成功。
2. 同一输入请求 `der`，输出为 strict DER，使用
   `secp256k1.verify(..., { prehash: false, format: "der" })` 成功。
3. 两种编码解析得到同一个 `(r, s)`，且均为 low-S。
4. digest 非 32 bytes、未知 format、错误私钥、格式与结果不一致均失败。

### 6.2 每条运行时路径

分别覆盖并断言 response `format` 与长度：

| 路径 | 请求 | 期望 |
|---|---|---|
| local fallback | compact / der | 格式原样回传、可验签 |
| SessionCrypto Worker | compact / der | postMessage 后格式不丢失、可验签 |
| Coordinator SharedWorker | compact / der | RPC hex 往返后格式不丢失、可验签 |
| vaultServiceCoordinator | compact / der | mismatch response 被拒绝 |

重点更新：

- `packages/plugin-vault/src/sessionCryptoClient.test.ts`
- `packages/plugin-vault/src/sessionCryptoWorker.test.ts`
- `packages/plugin-vault/src/vaultService.test.ts`
- `apps/web/src/keymasterSessionCoordinatorClient.test.ts`
- Session Window / protocol service 的 signer mock

### 6.3 业务验收

1. 从 Session Window 启动 demo，确认 `identity.get` 通过，且
   `signature.bytes.byteLength === 64`、可按 subject 公钥验签。
2. `intent.sign` 同样返回 64-byte compact，不能收到 DER。
3. P2PKH transfer 构造的 scriptSig 中签名为 DER + sighash byte；使用现有
   BSV 验证路径可通过。
4. `feepool.prepare` / `feepool.commit` 所有客户端签名仍为 DER，现有
   SDK 验签与交易构造通过。
5. 构造一个 Coordinator/worker 故意回传 `{ format: "der" }` 给 compact
   request 的 mock，必须失败，且不发送协议成功 result。
6. 仓库搜索不得再存在旧调用：

   ```bash
   rg -n 'signDigest\(\{[^}]*digest[^}]*\}\)' packages apps
   rg -n 'format \?\?|DER -> compact|fromBytes\(.*"der"' packages/plugin-protocol
   ```

   第一条不得找到无 `format` 的调用；第二条不得在协议签名 fallback 路径
   找到兼容转换。

### 6.4 最终质量门槛

```bash
pnpm typecheck
pnpm vitest run packages/plugin-vault/src/sessionCryptoClient.test.ts
pnpm vitest run packages/plugin-vault/src/sessionCryptoWorker.test.ts
pnpm vitest run packages/plugin-protocol/src/protocolService.test.ts
pnpm vitest run packages/plugin-p2pkh/src/p2pkhTransferService.test.ts
pnpm vitest run
```

所有测试通过、`git diff --check` 通过后才能合并。

---

## 7. 禁止事项

1. 不要只修 `identity.get`，继续让 fee pool / P2PKH 靠默认 DER。
2. 不要全局改成 compact；Bitcoin Script 仍要求 DER。
3. 不要新增持久化 `format` 字段或迁移历史 Vault 数据；该格式属于本次
   operation，不是 key identity 或签名记录的长期业务状态。
4. 不要保留“旧调用默认 DER”的过渡逻辑；本单是 hard switch。
5. 不要把协议层 DER -> compact 当成长期架构；格式应在 signer capability
   请求时确定。
6. 不要仅通过 signature length 判定格式；长度是结果校验，不是选择规则。

---

## 8. 完成定义

以下条件同时满足，才算本单完成：

- [x] `EcdsaSignatureFormat` 是 ActiveKeyCrypto 与 Coordinator 的唯一格式枚举。
- [x] 所有 `signDigest` request 和 result 都有必填 `format`。
- [x] Vault core、Worker、Coordinator 和 fallback 都按 request 格式真实签名。
- [x] identity / intent 只请求且只接受 compact 64-byte 签名。
- [x] P2PKH / fee pool 只请求且只接受 strict DER 签名。
- [x] 旧无格式 contract、实现、mock 与 fallback 已删除。
- [x] 不存在格式默认、猜测或协议层转换。
- [x] 单元、集成和 demo 验收均通过。
