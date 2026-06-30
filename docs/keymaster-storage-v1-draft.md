# Keymaster Storage V1 协议草案（施工单 2026-06-29 001）

> 本文档定义 V1 阶段对外 storage.* 协议族的公共语义。任何实现必须与本单与 `docs/keymaster-protocol-common-v1-draft.md` 保持一致；发生冲突时以本单为准。

---

## 1. 协议族

V1 新增以下五个 method，全部归入同一套 protocol method 总线：

- `storage.put`
- `storage.get`
- `storage.list`
- `storage.listAll`
- `storage.delete`

所有 method 与现有 `cipher.*` / `identity.*` 共用同一套 transport（`ready` → `request` → `result`）、同一套错误码、`ProtocolMessage` 顶层结构。

---

## 2. 共同约束

1. **必须**传 `connectSessionId`；缺字段直接 `invalid_request`。
2. namespace 真值统一按：
   - `session.origin`
   - `session.ownerPublicKeyHex`
   不读 `appViewContext.appId` 当 namespace 真值（与施工单收口一致）。
3. 路径约束（`storage.*` 入口统一校验）：
   - 必须是非空字符串；
   - 不允许以 `/` 开头；
   - 不允许包含 `..` 段；
   - 不允许包含 `\`（会被规范化为 `/`）或 `\0`；
   - 统一使用 `/` 作为分隔符，连续 `/` 折叠为单个；
   - 单段长度 ≤ 1024 chars；
   - 越界直接 `invalid_request`，**不**做自动修正 / 不做静默截断。
4. Keymaster 内部对写入明文自动加密，对读取密文自动解密；app 始终拿到明文。
5. `storage.listAll` 返回当前虚拟桶下全部相对路径，供 app 自己组目录树。
6. `storage.list` 按 `prefix` 过滤；`prefix` 为空串表示当前虚拟桶根。
7. S3 provider 配置由 Keymaster 设置页管理，**不**暴露给 client app。
8. **owner 执行面 = 统一 owner execution runtime（施工单 2026-06-30 002 硬切换）**：
   内容 key 派生与签名 / 加解密走同一条 `resolveOwnerRuntime(session)`：
   - `bootstrap_owner`：当前 Session Window 内存已 bootstrap 的
     `OwnerRuntimeBootstrap`；命中后直接拿 owner 私钥 hex。
   - `vault_unlock`：本窗口 vault 已 `unlocked` 时按 `ownerPublicKeyHex`
     解析 vault `keyId` 再 `vault.withPrivateKey` 借出。
   两条来源对外行为完全一致；runtime 解析失败时 `storage.*` 与
   `cipher.*` / `intent.sign` 一致 fail-closed（`runtime_missing`）。
   **不**允许根据"当前 bootMode"或"vault.status()"临时猜测执行路径，
   **不**允许 runtime 缺失时 fallback 到 vault 或当前 active key。

---

## 3. 虚拟桶（Virtual Storage Namespace）

外部 app 看到的是相对路径：

```
relativePath = "目录01/note.md"
```

物理对象 key 派生：

```
physicalKey = "/" + base64url(origin) + "/" + ownerPublicKeyHex + "/" + normalize(relativePath)
```

其中：

- `base64url(origin)` = 不含 padding 的 base64url 编码；
- `ownerPublicKeyHex` = 当前 `connectSessionId` 绑定 owner 的压缩公钥 hex；
- `normalize(relativePath)` = 按第 2 节规则处理后的相对路径。

S3 实际看到的对象内容 = **密文**；路径名 / 文件名 / 对象大小 / 修改时间 = **明文元数据**。V1 明确接受"路径名 S3 可见"的取舍，避免引入路径加密 + 目录索引映射带来的复杂度。

---

## 4. 透明加解密

每个对象独立加密，对象内容字节布局：

```
[version: 1 byte = 0x01][nonce: 12 bytes][ciphertext+tag: rest]
```

- 算法：AES-GCM-256；
- nonce：每次 `put` 重新随机生成 12 字节；
- domain separation：HKDF-SHA256 with `info = "keymaster.storage.v1" || ownerPublicKeyHex`，从 owner 私钥派生；
- 与 `cipher.*` 站点密钥**隔域**，但同 PBKDF2 → HKDF 链路；
- 同一路径重复写入，密文**必**不同（不同 nonce）；
- 派生输入（IKM = owner 私钥 hex）按 `resolveOwnerRuntime(session)`
  走同一条 owner 解析真值（`bootstrap_owner` / `vault_unlock` 两条来源
  最终都返回同一份 owner 私钥 hex）。两条来源**不**允许在同一
  `connectSessionId` 下混用；缺 runtime 即 fail-closed
  （`runtime_missing`）。

不做：

- 块级增量；
- dedup；
- 路径加密；
- SSE-KMS；
- 多版本。

---

## 5. Method 详细形状

### `storage.put`

输入：

```ts
{
  connectSessionId: string;
  path: string;
  contentType?: string;
  content: BinaryField;
}
```

行为：

1. 校验 `connectSessionId` 对应 session 仍有效（与其它业务方法同走 `requireConnectSession`）。
2. 路径 normalize。
3. 派生物理 key。
4. 用 owner-bound content key 加密。
5. 写入对象存储。

成功：

```ts
{
  objectKey: string;  // 物理 key（调试用；app 不应依赖）
  updatedAt: number;
}
```

### `storage.get`

输入：

```ts
{
  connectSessionId: string;
  path: string;
}
```

成功：

```ts
{
  contentType?: string;
  content: BinaryField;
  updatedAt?: number;
}
```

对象不存在 → `not_found`。

### `storage.list`

输入：

```ts
{
  connectSessionId: string;
  prefix: string;  // 相对路径前缀；空串 = 当前虚拟桶根
}
```

成功：

```ts
{
  entries: Array<{ path: string; updatedAt?: number }>;
}
```

### `storage.listAll`

输入：

```ts
{
  connectSessionId: string;
}
```

成功：与 `storage.list` 同形状（`prefix` 隐式 = ""）。

### `storage.delete`

输入：

```ts
{
  connectSessionId: string;
  path: string;
}
```

成功：

```ts
{
  deleted: true;
  updatedAt: number;
}
```

对象不存在 → `not_found`。

---

## 6. 错误码

`storage.*` 沿用协议错误码字面量：

- `invalid_request`：路径非法、字段缺失；
- `not_found`：对象不存在（仅 `storage.get` / `storage.delete`）；
- `user_rejected`：本地终态原因（写本地历史），具体本地 reason 在 `ProtocolCommandRecord.failureReason`：
  - `storage_provider_not_configured`；
  - `storage_io_error`；
- `internal_error`：DB 不可用等兜底。

---

## 7. Provider 配置

V1 只支持一套全局 S3-compatible 配置：

```ts
interface StorageProviderConfig {
  provider: "s3-compatible";
  endpoint: string;     // 例如 "https://s3.amazonaws.com" 或 "https://minio.local"
  region: string;       // 例如 "us-east-1"
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;  // 默认 false
  updatedAt: number;
}
```

写入位置：`keymaster.protocol` IndexedDB `storageProviderConfig` store（v6 新增）。

不暴露给 client app；Keymaster 设置页 `/settings/storage` 提供 CRUD UI。

---

## 8. 安全边界

V1 明确接受的边界：

1. **S3 可见元数据**：路径名、文件名、对象大小、修改时间。这是 V1 为保持 `list/listAll` 简单、避免引入额外索引的取舍。
2. **client app 永远看不到**：
   - launcher window 内部对象；
   - Session Window 内部 vault 私密运行时；
   - S3 物理 bucket 前缀真值；
   - Keymaster 内部 storage 内容加密 key；
   - storage provider 配置（含 secretAccessKey）。
3. **storage 权限真值**：所有 namespace 派生**严格**按 `sessionRecord.origin + sessionRecord.ownerPublicKeyHex`。`appViewContext.appId` 只用于 UI / 启动决策，**不**进入 namespace。

---

## 9. 不可做（施工单硬约束）

1. **禁止**把 storage 物理 key 加 `appId` 段。
2. **禁止**把 storage 内容加密 key 派生出多个子域；V1 单域（"keymaster.storage.v1"）。
3. **禁止**在 V1 同步做路径名加密 + 目录索引映射；那会让 `list/listAll` 复杂到不可接受。
4. **禁止**偷偷降级到本地明文存储；provider 不可用 → `internal_error`。
5. **禁止**按 origin / public key 建物理 bucket。
6. **禁止**把 storage 权限绑定回"当前全局 active key"——必须绑定 `connectSessionId`。

---

## 10. 兼容性

- `storage.*` 是新方法；旧 client 不受影响。
- 新 Session Window（`/protocol/v1/popup`）仍是唯一入口；`storage.*` 走同一套 popup transport。
- `connect.launch` 是 appView mode 下 client app 的首登入口；返回结果形状与 `connect.login` 对齐。