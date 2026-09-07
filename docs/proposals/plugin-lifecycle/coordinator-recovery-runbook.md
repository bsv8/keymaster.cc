# Coordinator 接管恢复操作协议

日期：2026-09-06。状态：已落实现有 UI / RPC 的 fail-closed 恢复入口；本文是运维操作协议，尚未替代目标部署环境的恢复演练证据。

## 适用范围

当新 Coordinator Worker 发现共享 authority（唯一权威）记录仍有 `activeIoLeases`（活动最终 I/O 租约）时，接管必须失败并公开：

- `authorityRecovery.status = "recovery-required"`：需要人工确认，不代表操作已经成功恢复；
- `authorityBuildId`：仍持有租约的旧 Worker 构建标识，用于确认部署版本；
- `activeIoLeaseCount`：旧 Worker 尚未排空的租约数量；
- `activeIoOperations.read / write`：活动最终 I/O 的脱敏读写计数，二者之和必须等于租约数量；
- `handoverGeneration`：旧权威接管世代，只用于诊断和对账。

此时系统保持存储、签名、后台任务和新会话的安全拒绝。不能删除 authority 记录、清空租约、复用旧 grant（授权句柄），也不能因为本地 Promise 被取消就判断远端写入已经结束。

## 标准恢复流程

1. 记录页面显示的 `authorityRecovery`、Worker buildId（构建标识）、时间和受影响操作类型。不要把业务 payload（业务载荷）写入工单或日志。
2. 停止发布切换和流量回退操作；让仍持有旧 Worker 的页面、标签页、浏览器实例和部署副本退出。若外部供应商操作可能仍在进行，先按领域仓库查询其结果。
3. 等待旧 Worker 的真实最终 I/O settle（结算），确认 `activeIoLeaseCount` 降为 0。不能只等待 AbortSignal（取消信号）。
4. 在存储门禁页点击“重新探测存储”，或通过正式 `storage.control` 命令提交 `{ "type": "retry" }`。该命令会重新读取 authority、恢复删除日志，再恢复任务；不会强制清除旧租约。
5. 验证新的 bootstrap snapshot（启动快照）同时满足：
   - `authorityRecovery` 不存在；
   - Storage health 为 `ready`；
   - 新的 `authorityInstanceId` 和 `handoverGeneration` 已发布；
   - 旧 `providerInstanceId`、storage grant 和 crypto proxy（密码学代理）不能继续调用；
   - 后台任务在当前产品意图下为 `idle` 或明确 `blocked`，没有重复实例。
6. 对上传、远端订阅、广播、支付和未知结果逐条执行领域仓库对账。只有领域仓库确认“未提交”或“已完成”后才能继续；未知结果只能查询 / 撤销 / 转人工，不自动重放。

## 完全不认识接管协议的旧版本

若旧 Worker 不理解 `authority`、`handoverGeneration` 或最终 I/O lease：

- 禁止新 Worker 自动接管并开放写入；
- 先在部署编排中停止旧版本流量，确认旧实例退出，再执行冷切换；
- 若无法证明旧实例退出，保持发布阻断，转人工处理外部写入和数据对账；
- 回退时必须确认没有新旧 Worker 并行持有写权限，并要求页面重新认证。

部署切换前先运行交接门禁：

```bash
KEYMASTER_DEPLOYED_BUILD_ID="$TARGET_BUILD_ID" \
KEYMASTER_LIFECYCLE_DEPLOYMENT_FILE=./release/deployment-handover.json \
  pnpm verify:lifecycle-deployment
```

其中 `TARGET_BUILD_ID` 必须是部署平台从实际产物回报的不可变构建标识，不能由
交接文件自行推导。该文件必须由部署平台填入真实的流量排空、实例退出、authority
对账和回退窗口引用；`deployment-handover.example.json` 只是待填写模板。没有交接记录、
记录仍为 pending，或旧 Worker 的活动 final-I/O lease 不为 0 时，脚本拒绝
切换。它不能替代平台实际停止实例，只能把“未证明退出”固定成发布失败。

## 恢复演练验收

一次合格演练至少要记录：旧 Worker 持有租约、接管失败并显示 `recovery-required`、旧操作真实结束、点击 retry 后新 authority 成功接管、旧句柄失败、未知外部结果没有重复提交。证据写入发布证据文件后，运行：

```bash
KEYMASTER_DEPLOYED_BUILD_ID="$TARGET_BUILD_ID" \
KEYMASTER_LIFECYCLE_EVIDENCE_FILE=./release/plugin-lifecycle-evidence.json \
  pnpm verify:lifecycle-production-gates
```

没有目标部署和人工演练证据时，该命令必须失败；本地 Vitest / Chromium 结果只能作为证据的一部分。
`TARGET_BUILD_ID`、交接文件、现场报告和 bootstrap snapshot（启动快照）必须完全一致。
