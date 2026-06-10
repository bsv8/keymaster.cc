# 006 私钥导入、导出与删除硬切换施工单

## 目标

一次性把私钥生命周期切换为以下模型：

```txt
Vault 已解锁
  可以随时导入多个 key
  可以从安全设置导出任意 key
  删除 key 前显示严重备份提示，但不强制备份

Vault 已锁定
  只能解锁
  不提供导入入口

首次未初始化
  可以选择新建钱包
  可以选择先创建 Vault 密码再导入私钥
```

本次是硬切换，不保留“已有私钥时禁止导入/导入灰化”的旧逻辑，也不保留多个互相不兼容的导出格式入口。

## 硬切换缘由

1. 当前 Vault 数据模型已经支持多 key，强行在 UI 上禁止第二把 key 会让数据模型和产品行为不一致，也会让后续联系人、资产或多身份场景受限。
2. 导入能力只有在 Vault unlocked 时才能保存私钥。locked 界面放“已有私钥？导入”按钮只是把用户带到不可完成的路径，应直接移除。
3. 删除私钥是不可逆操作，但强制备份会阻断用户清理测试 key、空 key 或已确认废弃 key。正确做法是在删除 step 中强提示风险，并给出同一个导出按钮。
4. 系统只应该提供一种正式导出格式。导出格式分裂会让用户不知道该备份哪个文件，也会让删除前备份和安全设置导出行为不一致。
5. bsv8 的 key envelope 已经是项目外部生态可识别格式，使用它能避免再发明一套 Web Wallet 私有备份格式。
6. bsv8 格式是加密 JSON，不是普通 JSON 私钥。导入必须真的解密出私钥材料，不能只识别字段后假装支持。

## 核心不变量

1. Vault 允许保存多个 key。
2. `vault.importPrivateKey` 不检查“是否已有 key”，只检查 Vault 是否 unlocked、输入材料是否有效。
3. `/import` 只在 unlocked shell 中可用。
4. 已有 vault 且 locked 时，锁屏界面不显示导入按钮。
5. 所有私钥导出只走 Vault 插件提供的统一导出能力。
6. 删除 key 不强制导出，但删除确认流程必须先展示备份风险提示和导出按钮。
7. 导出文件必须是加密 JSON，不允许导出明文 hex、明文 WIF 或未加密 JSON。
8. bsv8 加密 JSON 导入必须要求用户输入该文件的密码。
9. 私钥明文只能出现在 `vault.withPrivateKey` 回调或 importer parse 的短生命周期局部变量中，不能进入 React state。
10. 错误信息代码里使用英文，页面说明和注释使用中文。

## 统一格式

采用 bsv8 key envelope：

```json
{
  "pubkey_hex": "optional compressed public key hex",
  "version": "kek-v1",
  "key_id": "default",
  "kdf": "argon2id",
  "kdf_params": {
    "memory_kib": 65536,
    "time_cost": 3,
    "parallelism": 4,
    "salt_hex": "..."
  },
  "cipher": "xchacha20poly1305",
  "nonce_hex": "...",
  "ciphertext_hex": "...",
  "aad": "bitfs-keyring|client|default",
  "created_at_unix": 1773225104
}
```

导出时：

1. 使用用户输入的备份密码加密当前 key 的 32 字节私钥。
2. 默认写入 `pubkey_hex`，便于 bsv8 当前导入 API 直接使用。
3. `aad` 使用：

```txt
bitfs-keyring|client|default
```

导入时：

1. 优先使用文件内 `aad` 原样解密。
2. 如果历史文件缺少 `aad`，按 bsv8 兼容默认值尝试：

```txt
bitfs-keyring|client|default
bitfs-keyring|bitfs|default|kek-v1
bitfs-keyring|gateway|default|kek-v1
```

3. 解密后必须验证明文长度为 32 字节 secp256k1 私钥。

## 不能怎么做

1. 不能恢复“已有私钥时导入灰化”或在 `vault.importPrivateKey` 中拒绝第二把 key。
2. 不能在 locked shell 中保留“已有私钥？导入”按钮。
3. 不能把导出实现放在 importer 插件里。importer 只负责解析输入，不负责借用 Vault 明文私钥。
4. 不能提供多套导出按钮，例如 WIF 导出、hex 导出、JSON 导出并存。本次只保留 bsv8 加密 JSON。
5. 不能为了实现 bsv8 导入而把备份密码保存到 Vault、localStorage、IndexedDB 或 React state。
6. 不能把 `plugin-vault` 直接 import `plugin-p2pkh` 来派生地址或公钥。需要公钥时使用通用 secp256k1 库。
7. 不能把 bsv8 加密 envelope 当作普通 JSON importer 的“字段递归扫描”结果，否则会把密文字段误判为私钥候选。
8. 不能在删除按钮点击后直接删除 key，必须先进入备份提示 step。
9. 不能在删除流程中强制用户导出后才能继续删除。
10. 不能在本次顺手改 Vault 主密码、Vault IndexedDB schema 或 P2PKH 同步架构。

## 文件级施工

### apps/web/src/shell/LockedShell.tsx

删除已有 vault locked 状态下的导入入口。

需要保留：

```txt
首次 uninitialized:
  新建钱包
  导入私钥 -> 创建 Vault 密码 -> /import

已有 vault locked:
  输入密码
  解锁
```

页面提示改为强调：

```txt
需要先解锁本地 Vault，解锁后可以导入或管理私钥。
```

### packages/contracts/src/vault.ts

扩展 Vault 契约，增加统一导出所需类型与方法。

建议新增：

```ts
export interface KeyExportEnvelope {
  pubkey_hex?: string;
  version: "kek-v1";
  key_id: "default";
  kdf: "argon2id";
  kdf_params: {
    memory_kib: number;
    time_cost: number;
    parallelism: number;
    salt_hex: string;
  };
  cipher: "xchacha20poly1305";
  nonce_hex: string;
  ciphertext_hex: string;
  aad: string;
  created_at_unix: number;
}
```

VaultService 增加：

```ts
exportPrivateKey(input: {
  keyId: string;
  password: string;
}): Promise<KeyExportEnvelope>;
```

设计缘由写在注释里：

```txt
导出必须由 Vault 完成，因为只有 Vault 能通过 withPrivateKey 受控借用明文私钥。
```

### packages/plugin-vault/package.json

增加导出格式需要的依赖：

```json
"@noble/ciphers": "^2.x",
"@noble/hashes": "^1.x 或 ^2.x",
"@noble/secp256k1": "^2.x"
```

实际版本以 `npm install` 生成的 lockfile 为准，不手写 package-lock。

### packages/plugin-vault/src/keyEnvelope.ts

新增 bsv8 envelope 加密工具。

负责：

1. `encryptBsv8KeyEnvelope(privateKeyHex, password)`。
2. Argon2id 参数：

```txt
memory_kib = 65536
time_cost = 3
parallelism = 4
dkLen = 32
```

3. XChaCha20-Poly1305 加密 32 字节私钥。
4. 生成 16 字节 salt、24 字节 nonce。
5. 派生 compressed public key，写入 `pubkey_hex`。
6. 导出字段名必须与 bsv8 一致，使用 snake_case。

不负责：

1. 不访问 IndexedDB。
2. 不知道 React。
3. 不保存密码。
4. 不处理文件下载。

### packages/plugin-vault/src/vaultService.ts

实现 `exportPrivateKey`。

流程：

```txt
校验 password 非空
校验 key 存在
vault.withPrivateKey(keyId, material => encryptBsv8KeyEnvelope(material.hex, password))
返回 envelope
```

注意：

1. 不改变原 key 的 label、format、source。
2. 不触发 `key.imported`。
3. 不触发 `key.removed`。
4. 错误信息用英文。

### packages/plugin-vault/src/VaultSettingsPage.tsx

把安全设置页升级为 key 管理页。

表格列建议：

```txt
标签
地址
格式
能力
导入时间
操作
```

每行操作：

```txt
导出
删除
```

导出交互：

1. 打开导出 modal。
2. 用户输入备份密码和确认密码。
3. 调用 `vault.exportPrivateKey({ keyId, password })`。
4. 下载 JSON 文件。
5. 文件名建议：

```txt
web-wallet-key-{label-or-keyId}-{yyyyMMdd-HHmmss}.json
```

删除交互：

1. 点击删除进入严重提示 modal。
2. modal 文案必须明确：

```txt
删除后本机 Vault 将无法恢复这把私钥。没有备份文件或其他钱包副本时，相关资产可能永久无法使用。
```

3. modal 提供：

```txt
导出备份
下一步删除
取消
```

4. 点击“导出备份”复用统一导出 modal，不实现第二套导出。
5. 点击“下一步删除”进入最终确认。
6. 最终确认按钮文案使用危险语义：

```txt
确认删除
```

7. 删除成功后刷新 key 列表。

### packages/plugin-vault/src/VaultKeyExportModal.tsx

可新增导出 modal 组件，避免 `VaultSettingsPage.tsx` 过大。

职责：

1. 输入备份密码。
2. 输入确认密码。
3. 调用传入的 `onExport(password)`。
4. 下载 JSON。
5. 展示错误。

不负责：

1. 不直接调用 `removeKey`。
2. 不保存 key 列表。
3. 不知道删除流程。

### packages/plugin-vault/src/VaultKeyDeleteModal.tsx

可新增删除 modal 组件。

职责：

1. 展示备份风险。
2. 提供导出按钮。
3. 提供下一步删除按钮。
4. 提供最终删除确认。

不负责：

1. 不实现加密导出。
2. 不绕过 `VaultSettingsPage` 刷新列表。

### packages/plugin-importer-json-file/package.json

增加 bsv8 解密需要的依赖：

```json
"@noble/ciphers": "^2.x",
"@noble/hashes": "^1.x 或 ^2.x"
```

如果实现中需要校验 secp256k1 私钥，也增加：

```json
"@noble/secp256k1": "^2.x"
```

### packages/plugin-importer-json-file/src/bsv8KeyEnvelope.ts

新增 bsv8 envelope 解密工具。

负责：

1. 识别 `version=kek-v1`、`kdf=argon2id`、`cipher=xchacha20poly1305`。
2. 校验必需字段。
3. 用用户输入的密码解密。
4. 返回 32 字节 hex 私钥。
5. 兼容有 `aad` 和缺 `aad` 的历史 envelope。

不负责：

1. 不写 Vault。
2. 不弹 UI。
3. 不读取文件。

### packages/contracts/src/keyImport.ts

扩展 importer 输入，支持加密文件密码。

建议增加：

```ts
export type KeyImportInput =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; content: Uint8Array; password?: string };
```

设计缘由：

```txt
密码属于本次 parse 的瞬时输入，不能放到 importer 实例或 React 全局状态里。
```

### packages/plugin-importer-json-file/src/jsonFileImporter.ts

硬切换 JSON importer 行为：

1. 先解析 JSON。
2. 如果是 bsv8 envelope，必须走 bsv8 解密逻辑。
3. 如果 envelope 需要密码但 `input.password` 为空，抛出英文错误：

```txt
Password is required for encrypted key file
```

4. bsv8 envelope 解密成功后返回：

```txt
detectedFormat = "bsv8-key-envelope"
summary = "bsv8 encrypted key envelope"
```

5. 非 bsv8 JSON 才走旧的递归候选扫描。
6. 旧递归扫描必须跳过 `ciphertext_hex`、`salt_hex`、`nonce_hex` 等 envelope 字段，避免误判。

### packages/plugin-key-import/src/ImportPage.tsx

导入页面增加加密 JSON 密码输入。

建议行为：

1. 文件选中后读取 JSON。
2. 如果能快速识别为 bsv8 envelope，显示“备份文件密码”输入框。
3. parse 时把 `password` 放入 file input。
4. parse 成功后立即清空密码输入。
5. 保存成功后清空文件、文本、密码、结果。

注意：

1. 备份密码不能进入持久化。
2. 不能把密码写到 `KeyImportResult`。
3. 不能影响 WIF / hex 文本导入。

### packages/plugin-key-import/src/ImporterPicker.tsx

通常不需要改。

如果要在 JSON File 描述里显示支持 bsv8，应只改 importer 描述，不在 picker 写格式特判。

### apps/web/src/styles/global.css

补充最小样式：

```txt
.vault-key-actions
.vault-delete-warning
.vault-delete-warning__danger
.vault-export-modal
.import-page__password
```

要求：

1. 删除警告要有明显 danger 语义。
2. 不做营销式大卡片。
3. modal 内按钮不挤压、不换行错乱。
4. 移动端表格可横向滚动或操作区换行。

### apps/web/vite.config.ts

如果新增 noble 子路径 import，需要加入 optimizeDeps：

```txt
@noble/hashes/argon2
@noble/ciphers/chacha
@noble/secp256k1
```

具体路径以安装包 exports 为准。不能猜路径，必须用 TypeScript/build 验证。

### package-lock.json

通过 npm 安装依赖自然更新。

不能手工拼 lockfile。

### 测试文件

新增或扩展测试：

```txt
packages/plugin-importer-json-file/src/bsv8KeyEnvelope.test.ts
packages/plugin-vault/src/keyEnvelope.test.ts
packages/plugin-vault/src/vaultService.test.ts
```

覆盖：

1. Web Wallet 导出的 envelope 能被本项目 importer 解回同一私钥。
2. bsv8 示例字段能被识别为加密 envelope。
3. 密码错误时报错。
4. 缺少 password 时不会误扫 `ciphertext_hex` 当私钥。
5. `vault.importPrivateKey` 允许导入多把 key。
6. `exportPrivateKey` 不改变 key 列表。
7. `removeKey` 删除后 key 不再出现在列表。

## 特殊情况处理

### bsv8 envelope 密码错误

parse 失败，显示错误，不保存任何 key。

错误信息用英文：

```txt
Invalid password or corrupted key material
```

### envelope 字段完整但 aad 不匹配

先用文件内 `aad` 解密。

如果失败且文件看起来是历史格式，可以按兼容默认 AAD 列表尝试。全部失败后返回统一错误，不把内部尝试列表暴露给用户。

### envelope 没有 pubkey_hex

导入仍然允许。

私钥解密后由业务插件派生地址；导出时本项目生成 `pubkey_hex`。

### Argon2 参数过大

必须设置上限，避免恶意文件让浏览器卡死。

建议：

```txt
memory_kib <= 262144
time_cost <= 8
parallelism <= 8
```

超出上限时报错：

```txt
Unsupported key kdf params
```

### 浏览器内存不足

导入失败并提示错误。

不能降低安全参数后偷偷重试，因为这会改变文件语义。

### 用户删除前没有备份

允许继续删除。

但删除流程必须让用户明确经过备份提示和最终确认。

### key 还有余额或未同步完成

本次不做链上余额阻断。

原因：Vault 删除是本地私钥管理动作，P2PKH 链上余额判断可能受网络、WOC 限流、缓存状态影响。删除风险由严重提示覆盖，不用不可靠的余额判断拦截。

### 导出下载被浏览器阻止

保留 modal，显示错误或让用户重新点击导出。

不能在页面明文展示完整私钥作为替代。

### 多标签页同时删除/导出

以 Vault 当前 IndexedDB 状态为准。

如果导出时 key 已被删除，报错：

```txt
Unknown key
```

如果删除时 key 已不存在，刷新列表并显示已不存在的提示。

## 最终验收清单

### 行为验收

- [ ] 首次打开未初始化钱包时，仍可选择“新建钱包”和“导入私钥”。
- [ ] 已有 vault 但 locked 时，只显示解锁能力，不显示导入按钮。
- [ ] 解锁后 `/import` 页面可用。
- [ ] 已有一把 key 时，仍可继续导入第二把 key。
- [ ] WIF 导入不受影响。
- [ ] Hex 导入不受影响。
- [ ] 普通 JSON 私钥导入不受影响。
- [ ] bsv8 `kek-v1` 加密 JSON 文件要求输入文件密码。
- [ ] bsv8 密码正确时能导入 key。
- [ ] bsv8 密码错误时不会保存 key。
- [ ] 安全设置页能列出多把 key。
- [ ] 每把 key 都有导出按钮。
- [ ] 导出文件是加密 JSON envelope，不包含明文私钥字段。
- [ ] 删除按钮不会立即删除 key。
- [ ] 删除第一步显示严重备份提示。
- [ ] 删除第一步提供“导出备份”按钮。
- [ ] 用户不导出也能进入下一步删除。
- [ ] 最终确认后 key 被删除。
- [ ] 删除后列表刷新。

### 文件与架构验收

- [ ] `plugin-vault` 提供唯一导出能力。
- [ ] importer 插件没有调用 `vault.withPrivateKey`。
- [ ] `plugin-vault` 没有 import `plugin-p2pkh`。
- [ ] `plugin-key-import` 没有保存备份密码。
- [ ] `jsonFileImporter` 对 bsv8 envelope 不走普通递归扫描。
- [ ] `vault.importPrivateKey` 没有“已有 key 禁止导入”的判断。
- [ ] locked shell 没有导入跳转按钮。
- [ ] package-lock 由 npm 安装命令生成，不是手工编辑。

### 安全验收

- [ ] 导出必须输入备份密码。
- [ ] 导出密码和 bsv8 导入密码不进入 localStorage。
- [ ] 导出密码和 bsv8 导入密码不进入 IndexedDB。
- [ ] 导出密码和 bsv8 导入密码不进入 `KeyImportResult`。
- [ ] 删除前严重提示明确说明未备份可能永久丢失资产访问能力。
- [ ] 不存在明文 hex/WIF 下载按钮。
- [ ] bsv8 KDF 参数有上限保护。

### 自动化验收

- [ ] `npm run typecheck` 通过。
- [ ] `npm run build` 通过。
- [ ] `npm run lint:boundaries` 通过。
- [ ] `npm test` 通过。

### 浏览器验收

- [ ] `npm run dev -- --host 127.0.0.1` 能启动。
- [ ] 创建 Vault 后页面不黑屏。
- [ ] 解锁后安全设置页能打开。
- [ ] 导出下载的 JSON 文件能再次导入。
- [ ] 删除 modal 在窄屏下按钮和文字不重叠。
