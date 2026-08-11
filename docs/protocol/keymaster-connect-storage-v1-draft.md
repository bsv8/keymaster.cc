# Keymaster Connect Storage V1

Connect Storage 是可选的 Protocol 平台能力。App 主动登录时提交从自身 HTML meta
读取的 App Identity Proof；Keymaster launcher 拉起时则使用本地 catalog 中人工导入的
proof 预建 session，并要求 App 在 `connect.launch` 提交相同 proof。session 会持久化
已验证 proof 的 digest 快照。没有该快照的 Connect Session 仍可使用既有业务方法，
但不能使用 `storage.*`。完整信任边界见
[App Metadata V1](../app-metadata-v1.md)。

## Methods

`storage.list`、`storage.directory.create`、`storage.directory.delete`、
`storage.put`、`storage.get`、`storage.delete` 和
`storage.upload.begin/part/complete/abort` 均要求 `connectSessionId`。
Protocol 从 session 真值构造 Storage Context，caller 不能传入 publisher、app、
namespace、bucket、endpoint、S3 key 或凭据字段。

单次对象读写上限为 16 MiB；multipart 使用 16 MiB 固定 part、最多 10,000 parts。
游标和内部 upload id 绑定 session、origin、Identity namespace 与 Provider
generation，不能跨应用或跨配置复用。

## Provider boundary

`plugin-storage` 提供 `storage.service`，设置入口注册在
`Settings -> System -> S3 Storage`。AWS S3、Cloudflare R2 与 S3-compatible
Provider 均使用 HTTPS（R2 使用 account endpoint）。Provider 凭据由 Vault 的
`vault.local-secret` capability seal，`keymaster.storage` IndexedDB 只保存密文
envelope 和脱敏 summary；Protocol 不接触 AWS SDK，也不返回凭据。

Storage plugin 未启用、Vault locked、Provider 未配置或 Provider 不可用时，
Storage 请求 fail closed，并返回稳定的 `storage_*` 错误码；其它 Connect 方法
不因可选 Storage capability 缺失而 blocked。

当前实现的纯函数、安全边界和 fake-provider 回归测试位于
`packages/plugin-storage/src`，真实云 Provider smoke 仍是 opt-in 验收项。
