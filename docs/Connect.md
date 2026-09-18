# Keymaster Connect

Connect 是外部网页 App 使用 Keymaster 能力的唯一公开入口。当前协议版本为 V1，推荐通过
`@keymaster/connect` SDK 接入；完整调用字段由 TypeDoc 从中文注释的契约代码生成。

## 会话模型

1. `connect.login` 让用户选择 Owner 并创建持久会话。
2. App 保存 `connectSessionId`（连接会话编号）。
3. 业务请求必须携带该编号，Owner 只从会话解析，不回退到钱包当前 Key。
4. Popup 刷新或关闭不会自动注销；`connect.resume` 恢复运行态。
5. `connect.logout` 撤销会话、订阅和相关授权。

消息只接受配置的 Keymaster origin 和当前 Session Window。`aud` 表示目标站点，必须等于
浏览器实际 `event.origin`，不能由调用方伪造其他来源。

## App 身份

需要 Storage 或 MSFile 的 App 必须在入口 HTML 提供固定签名身份：

| meta 字段 | 中文含义 |
| --- | --- |
| `keymaster-app:id` | 发行人命名空间内的 App 编号 |
| `keymaster-app:publisher-public-key` | 发行人压缩公钥 |
| `keymaster-app:name` | 用户看到的 App 名称 |
| `keymaster-app:description` | App 用途说明 |
| `keymaster-app:requirement` | 请求的能力，例如 `storage` |
| `keymaster-app:identity-signature` | 发行人对规范身份内容的签名 |

`keymaster.app.json` 只用于把同一份 proof（身份凭证）人工导入本地 launcher catalog，不是
运行时网络真值。Direct login 和 appView launch 都要验证 proof；会话保存其摘要，App 不能
在建立会话后靠增加参数升级身份。

## 能力

| 方法族 | 中文用途 | 关键边界 |
| --- | --- | --- |
| `identity.*` | 获取签名身份断言、签署明确意图 | 用户确认，绑定 Owner、origin 和有效期 |
| `cipher.*` | 加解密二进制内容 | AES-256-GCM，密钥绑定 Owner 和精确 origin |
| `p2pkh.*` | 受控转账（`assetId: "bsv-mainnet" / "bsv-testnet"`，缺省 mainnet） | App 不能指定私钥、找零或确认文案；testnet 需要用户在设置里开启 |
| `channel.*` | 发布 JSON、替换精确频道订阅 | App 不选择 Supplier，也看不到私密 inbox |
| `storage.*` | App 隔离目录、对象和 multipart | 需要 `storage` 身份需求；不暴露桶和凭据 |
| `msfile.*` | Stat、Seed Read、Block Read | 需要已验证身份；价格由 Keymaster 管理 |

统一请求支持超时和取消。错误使用稳定 `code`（错误码）；展示文案不能依赖英文错误文本。
Channel 成功只表示 Keymaster 接受本地发布，不表示远端已经收到或阅读。

## 精确真值

- 方法、参数、结果和错误：`packages/contracts/src/protocol.ts`
- Storage 类型：`packages/contracts/src/storage/index.ts`
- MSFile 类型：`packages/contracts/src/msfile.ts`
- Channel 类型：`packages/contracts/src/channel.ts`
- SDK 使用手册：`apps/connect-docs/site/`

Markdown 不再复制完整类型，避免协议文档和可执行契约漂移。
