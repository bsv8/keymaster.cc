# 施工单 002 实施进度总结

## 当前状态：部分完成，需要继续实施

### 已完成的核心修改

#### 1. Contracts 定义
- ✅ `packages/contracts/src/sessionCoordinator.ts` - RPC 协议定义

#### 2. Coordinator SharedWorker
- ✅ `apps/web/src/keymasterSessionCoordinator.worker.ts` - SharedWorker 核心实现
  - 状态管理（sessionEpoch、vaultStatus、activeKey）
  - Port 连接管理
  - Vault 操作（unlock/lock/activate）
  - Background 任务管理
  - 自动锁定 timer

#### 3. Coordinator Client
- ✅ `apps/web/src/keymasterSessionCoordinatorClient.ts` - Client transport
  - SharedWorker 连接管理
  - RPC 请求/响应处理
  - 事件订阅和分发
  - 状态缓存

#### 4. Session Crypto Client 修改
- ✅ `packages/plugin-vault/src/sessionCryptoClient.ts` - 接入 Coordinator
  - 删除了 `new Worker()` 创建 Dedicated Worker 的路径
  - 添加了 `createCoordinatorBackedEngine` 通过 Coordinator 执行 crypto
  - 保留了 `createLocalEngine` 作为测试专用

#### 5. Vault Facade
- ✅ `packages/plugin-vault/src/vaultServiceCoordinator.ts` - VaultService Coordinator facade
  - 通过 Coordinator client 执行 unlock/lock/activate
  - 状态缓存和事件监听

#### 6. Vault Manifest 修改
- ✅ `packages/plugin-vault/src/manifest.ts` - 使用 Coordinator facade
  - 优先获取 Coordinator client
  - 有 Coordinator 时使用 facade，否则回退到本地实现

---

### 待完成的工作

#### Phase 6: 删除 backgroundService 中的 leader 选举
**关键文件**: `packages/plugin-background/src/backgroundService.ts`

需要删除：
- `createLeaderContext` 函数（第 908-1256 行）
- `LEADER_LOCK_NAME` 常量
- Web Locks 使用（`navigator.locks`）
- BroadcastChannel 选举/心跳/快照广播
- Follower 动作转发（`forwardAction`）
- Leader 快照合并（`leaderSnapshots`）

需要修改：
- `createBackgroundService` 函数，删除 leader context 相关代码
- 删除 `runLocallyIfEligible`、`shouldUseLocalSession` 等函数

#### Phase 7: 修改 P2PKH/BSV-21/STAS manifest
**关键文件**:
- `packages/plugin-p2pkh/src/manifest.ts`
- `packages/plugin-token-bsv21/src/manifest.ts`
- `packages/plugin-token-stas/src/manifest.ts`

需要修改：
- 删除 tab 内 `backgroundRegistry.register()` 调用
- 删除本地任务执行实例
- 改为发给 Coordinator 的 trigger command

#### Phase 8: 修改 bootstrap 和 AppShell
**关键文件**:
- `apps/web/src/bootstrapPlugins.ts`
- `apps/web/src/shell/AppShell.tsx`
- `apps/web/src/shell/LockedShell.tsx`

需要修改：
- 在 bootstrap 开始时注入 Coordinator client
- AppShell 自动锁定改为向 Coordinator 发送节流 activity
- UI 仅按全局 vault status/epoch 切换

#### Phase 9: 删除旧机制残留
**需要扫描并删除的代码**:
```
new Worker(new URL("./sessionCryptoWorker"
background.leader
createLeaderContext
leaderSnapshots
runLocallyIfEligible
shouldUseLocalSession
forwardAction
broadcastSnapshots
BroadcastChannel("background
navigator.locks.*background.leader
```

**关键文件**:
- `packages/plugin-background/src/backgroundService.ts`
- `packages/runtime/src/createPluginHost.ts`（删除 `asset.data.changed` BroadcastChannel）

---

### 关键设计约束

1. **私钥只在 Worker 内存中**：永不离开 SharedWorker
2. **sessionEpoch 世代栅栏**：每个异步操作都带 epoch
3. **单一真值**：所有 tab 共享同一个 Coordinator
4. **删除多 tab 竞争机制**：不再有 leader 选举
5. **Worker-safe tasks**：任务 handler 不依赖 window、DOM、React

---

### 下一步实施建议

1. **优先级 1**：删除 backgroundService 中的 leader 选举
   - 这是最关键的修改，删除所有多 tab 竞争机制
   - 需要仔细处理，确保不影响现有功能

2. **优先级 2**：修改 P2PKH/BSV-21/STAS manifest
   - 删除 tab 内任务注册
   - 改为通过 Coordinator 执行

3. **优先级 3**：修改 bootstrap 和 AppShell
   - 注入 Coordinator client
   - 修改自动锁定逻辑

4. **优先级 4**：修复类型错误并运行测试
   - 运行 `pnpm typecheck`
   - 运行新增/改造的测试
   - 静态扫描确认旧机制残留已清除
