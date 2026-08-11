# Connect Storage 提案

> 本目录保留早期 proof 字段与 Storage 方案的历史设计，不再是当前身份契约。
> 当前实现使用入口 HTML 中的固定签名 proof；`keymaster.app.json` 只把同一 proof
> 人工导入 launcher catalog。Direct login 与 appView launch 都提交并验签 proof，
> 见 [App Identity Proof V1](../../app-metadata-v1.md)。

本目录记录 Keymaster Connect S3 Storage 能力及其施工验收。当前仓库已落地可编译、
可构建、可运行的原型代码，AWS S3、Cloudflare R2 和 Backblaze B2 真实 Provider
smoke 已通过；安全审计和 S3Disk 正式迁移契约尚未完成，不得把本目录当作已上线 API。

真实 Provider smoke 为显式 opt-in：`pnpm test:storage:smoke`。凭据从 shell/CI 的
`KEYMASTER_STORAGE_SMOKE_*` 环境变量或仓库根目录中被 Git 忽略的
`.storage-smoke/.env` 读取；shell/CI 变量优先。测试使用独立的
`keymaster-smoke/{runId}/.../` 前缀并在 finally 中清理对象。

本地配置方法见 [`.storage-smoke/README.md`](../../../.storage-smoke/README.md)。不要
把真实凭据填写到 `.env.example`，也不要使用具有账户管理或删除 Bucket 权限的密钥。

按 provider 选择所需变量：

- AWS：`KEYMASTER_STORAGE_SMOKE_AWS_REGION`、`_BUCKET`、`_ACCESS_KEY_ID`、`_SECRET_ACCESS_KEY`
- R2：`KEYMASTER_STORAGE_SMOKE_R2_ACCOUNT_ID`、`_BUCKET`、`_ACCESS_KEY_ID`、`_SECRET_ACCESS_KEY`
- Compatible：`KEYMASTER_STORAGE_SMOKE_COMPAT_ENDPOINT`、`_REGION`、`_BUCKET`、`_ACCESS_KEY_ID`、`_SECRET_ACCESS_KEY`

可用 `KEYMASTER_STORAGE_SMOKE_PROVIDER=aws|r2|compatible|all` 选择 Provider，默认是
`all`；不要把凭据写入仓库、URL 或日志。

条件写入优先使用 Provider 原生 `If-None-Match: *`。只有 Provider 明确返回
HTTP `501 NotImplemented` 时，adapter 才按
[KMS3-008A](./implementation-plan.md#补充工单-kms3-008a非原子条件写入兼容模式)
降级为 best-effort `HEAD` 后写入；该模式不提供跨客户端原子保证。能力按
[KMS3-008B](./implementation-plan.md#补充工单-kms3-008b配置级能力锁定与独立探测)
在当前激活配置 generation 内全局、独立且单向锁定。
可信设置页另按
[KMS3-012A](./implementation-plan.md#补充工单-kms3-012asettings-手动条件写入能力检测)
提供有副作用的手动检测和显式改判；它不替代只读连接测试，也不向 Connect App 暴露。
KMS3-012A 已完成实现与 69 项 `plugin-storage` 回归测试，并在三类真实 Provider 的
原有 smoke 上完成无回归复验；能力状态仍仅存在于当前配置 generation 的运行时内存。

- [需求文档](./requirements.md)
- [设计文档](./design.md)
- [施工单](./implementation-plan.md)
- [S3 Settings 专项施工单](./settings-implementation-plan.md)
- [Storage SharedWorker Runtime 硬切换施工单](./shared-worker-runtime-plan.md)

关联项目：

- `KeymasterAppPackCore`：App metadata 派生、内容寻址 Vite 构建、Manifest 与 bundle 签名工具。
- `MasterSeed`：Seed V1 Hash SDK。
- `S3Disk`：已验证的 AWS S3/R2/S3-compatible 行为参考，未来迁移消费者。
