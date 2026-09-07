# 不可逆 I/O 审计台账

日期：2026-09-06。状态：Coordinator 最终租约入口已统一标记；外部供应商与目标部署 smoke 尚未完成，因此本台账不能单独解除生产发布门禁。

## 审计规则

所有可能产生外部副作用、签名结果或持久化真值变化的 Coordinator 操作，必须先进入 `withCoordinatorFinalIoLease()`。该函数同时校验本地 `UpgradeSession`、共享 authority、owner/session/bucket 世代，并在结果返回前再次校验。已迁移的领域任务，其产品 / `unitId` / `taskId` / 审计入口由 [`workerUnitCatalog.ts`](../../../apps/web/src/coordinator/workerUnitCatalog.ts) 统一登记；新增任务不得只补 lease 调用而漏掉运行单元身份。

写操作的异常结果按 `unknown` 处理；不能因为网络超时、锁屏或 Worker 接管失败而自动重放。上传、远端订阅、广播和支付结果必须由各自领域仓库继续核对。`apps/web/src/coordinator/finalIoAudit.ts` 只保存按入口聚合的内存计数，不保存 payload，也不作为重试依据。

## Coordinator 入口台账

| 审计入口 | 业务边界 | 未知结果后的依据 |
| --- | --- | --- |
| `coordinator.bootstrap.recover`、`coordinator.meta.persist` | authority / Coordinator metadata / 删除 Journal | metadata、删除 Journal |
| `keyspace.active.set`、`vault.unlock`、`vault.activate-key`、`vault.operation` | Vault / active owner 变更 | Vault metadata |
| `vault.digest.sign`、`vault.address.derive`、`service.crypto.sign`、`window-p2p.identity.sign` | 签名或派生 | 请求方重新读取 session / owner 状态，签名类不盲目重放 |
| `service.owner-generation.read` | 服务授权修订读取 | 新服务目录和 owner generation |
| `storage.control`、`storage.platform.data`、`storage.owner.data`、`storage.connect.data`、`storage.owner.delete` | 平台 K-V、owner K-V、Connect 文件和删除 | storage journal / provider 状态 / owner generation |
| `msfile.control`、`msfile.data` | MSFile 配置、Stat、Seed、Block、上传相关数据面 | MSFile provider / upload repository |
| `sat.address.derive`、`sat.operation` | Sat provider、充值、collect 和结果落库 | Sat 请求仓库、未知支付结果记录 |
| `channel.subscribe`、`channel.unsubscribe` | 远端订阅 / 退订 | owner 订阅意图和 Mux 对账 |
| `channel.public-publish`、`channel.hash-publish`、`channel.private-publish` | Channel 签名与远端 Publish | Channel 关系记录和消息去重记录 |
| `channel.incoming-decrypt` | owner 收件箱解密与入站处理 | 当前 owner/session 栅栏；迟到事件丢弃 |
| `contacts.presence-probe` | 联系人在线探测的 Channel publish 与 presence 投影 | 联系人 owner K-V、当前 Channel 关系与 session 栅栏 |
| `p2pkh.sync`、`token-bsv21.sync`、`token-stas.sync`、`collectible-1satordinals.sync` | Worker Provider 网络读取、同步 checkpoint 与资产投影 | 各领域同步仓库的 checkpoint / facts；不因中断重放已完成页 |
| `p2pkh.broadcast` | 广播和本地 submission audit | submission repository / chain resolution |

## 仍需外部验收的部分

- 目标部署环境的 AppView：`pnpm test:e2e:external`，必须提供 `KEYMASTER_EXTERNAL_APPVIEW_ORIGIN` 与 `KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR`。
- 真实 S3 / 上传供应商、receive Supplier、广播和支付供应商的故障注入：`pnpm test:e2e:irreversible-io`，必须提供 `KEYMASTER_IRREVERSIBLE_IO_SMOKE_URL`，并由目标验收页注入 `__KEYMASTER_IRREVERSIBLE_IO_SMOKE__` runner；本地 fixture、Node 测试和 MSFile 压力测试不能替代这一步。
- 完全不认识 authority 协议的旧 Worker：必须在部署编排中确认退出、版本淘汰和回退窗口，不能由本地 lease 猜测完成。

上述外部证据必须和恢复演练、领域单元覆盖、回退演练一起写入发布证据文件，运行 `pnpm verify:lifecycle-production-gates` 校验；该门禁没有证据文件时明确失败。部署切换前另运行 `pnpm verify:lifecycle-deployment` 校验交接记录。旧 Worker 活动租约的人工处理步骤见 [Coordinator 接管恢复操作协议](./coordinator-recovery-runbook.md)。
