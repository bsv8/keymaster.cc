# Coordinator 运行锁与升级处理

日期：2026-09-13。状态：运行控制已移到 WebLoom 浏览器 Web Lock；业务 Local/S3 桶不再保存 Coordinator 临时锁或 `activeIoLeases`。

## 运行规则

- 同一稳定 SharedWorker name（Worker 名称）的多个 Tab 连接同一个物理 Worker，Worker 只申请一次 `navigator.locks` exclusive lock（浏览器唯一运行锁）。
- 锁名只由稳定 Runtime 标识组成，不包含 buildId（构建标识）、版本号或 Worker URL（脚本地址）。
- 第二个物理 Worker 使用 `ifAvailable`（立即检查）申请同一锁；拿不到时不等待、不启动插件、不进入 ready，返回 `runtime_lock_conflict`（运行锁冲突）。
- 页面提示必须是：“检测到另一个 Keymaster Runtime 正在运行。请刷新或关闭所有 Keymaster 页面后重新打开。”
- Worker 终止后由浏览器自动释放锁。Web Locks 不可用时返回 `runtime_lock_unavailable`（运行锁不可用），不能降级到 localStorage 模拟锁，也不能无锁运行。

## 用户处理流程

1. 记录运行锁错误码、中文提示和当前页面地址；不要把业务 payload（业务载荷）写入日志。
2. 刷新当前页面；如果仍提示冲突，关闭全部 Keymaster Tab、弹窗和旧版本页面。
3. 重新打开一个页面，确认新的 Worker 发布 `ready`，再恢复业务操作。
4. 如果页面刷新后仍提示 `runtime_lock_unavailable`，更换支持 Web Locks 的浏览器；不要清理或手工删除 Local/S3 K-V 对象。

## I/O 与未知远端结果

Keymaster 的 `withCoordinatorFinalIoLease()` 仍然保留本地 gate（本地入口闸门）、authorityInstanceId（本次 Worker 启动身份）、session/bucket/keyspace 世代和内存 I/O 计数。它不再把每次登记/释放写成 `coordinator-upgrade/authority` commit。

Worker 在网络或存储请求完成前崩溃时，浏览器会释放运行锁，但不能据此判断远端操作是否已经成功。不可逆操作必须由领域仓库使用请求 ID、交易 ID、上传记录或供应商状态做对账；未知结果不能自动重放。

## 发布要求

发布新版本时不做新旧 Worker 自动接管。这里必须区分两种升级：

### 首次从 0.4.2 启用 Web Lock：受控冷切换

registry 的 WebLoom `0.4.2` Worker 不申请 Web Lock，所以 `0.4.3` 无法通过
`LockManager` 发现一个仍在运行的 `0.4.2` Worker。不能把
`runtime_lock_conflict` 当成这次迁移的检测手段，也不能声称刷新一次就能自动完成迁移。

部署门禁 `pnpm verify:lifecycle-deployment` 要求交接文件有下面的结构化记录：

```json
{
  "runtimeLockMigration": {
    "mode": "initial-cold-switch",
    "previousWebLoomVersion": "0.4.2",
    "targetWebLoomVersion": "0.4.3",
    "previousRuntimeLockAware": false,
    "targetRuntimeLockAware": true,
    "legacyPagesExited": true,
    "legacyWorkersExited": true,
    "legacyExitEvidenceRef": "<部署平台原始 JSON 记录>",
    "targetCapabilityEvidenceRef": "<目标包能力验收原始 JSON 记录>"
  }
}
```

两份原始记录必须绑定同一个不可变 `targetBuildId`；本地 JSON 记录还必须明确写出
旧页面、旧 Worker 已退出以及目标包确实支持运行锁。实际发布顺序是：先停止并确认
所有旧 Keymaster 页面、弹窗和旧 Worker，再发布/启用带 Web Lock 的 WebLoom，最后
切换 Keymaster 消费者。缺少这份冷切换证据时发布门禁失败。

### 双方都支持 Web Lock 的后续升级

只有旧版本和新版本都申请同一个稳定 Web Lock 时，才使用
`runtime_lock_conflict` 直接报错，提示用户刷新或关闭全部 Keymaster 页面后重新打开。
门禁记录使用 `mode: "lock-aware-upgrade"`、`previousRuntimeLockAware: true` 和
`conflictErrorVerified: true`，不能用它替代首次冷切换证据。

当前消费者代码会先检查 WebLoom 的运行锁能力标记；若误装了旧的 `0.4.2`，在创建
SharedWorker 前直接安全拒绝并提示更新，不会把未知的 `runtimeLock` 字段传给旧包，也不会
让旧包无锁启动。但这个 fail-closed 检查只能阻止当前页面启动旧包，不能从外部发现已经
存活的旧 `0.4.2` 页面或 Worker，因此首次冷切换仍必须先完成现场退出确认。现在 registry
和两个消费者已经切换到精确的 `0.4.3`；该入口不需要消费者重复实现锁，默认
`startSharedWorkerApp` 会在 Worker 最外层持有 Web Lock。

发布顺序已经完成：WebLoom `0.4.3` 已发布，Keymaster 和演示项目使用该精确 registry
版本。首次从历史 `0.4.2` 升级时仍必须按上面的冷切换证据执行；后续双方都支持 Web Locks
的版本才使用 `runtime_lock_conflict` 验收。当前 registry lifecycle smoke 使用冻结的
`0.4.3` integrity；本地 `0.4.3` tarball 入口只保留给源码/产物隔离测试，不作为正式依赖。

不要直接删除任何 `commits/`、`values/` 或 `heads/` 物理对象。旧版本已经写入的 `coordinator-upgrade` 数据只能等待 K-V 引擎垃圾回收，或通过正式 K-V 删除语义在确认旧版本退出后处理；新版本不再依赖这条记录。
