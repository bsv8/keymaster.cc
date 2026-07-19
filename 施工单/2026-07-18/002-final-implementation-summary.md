# 施工单 002 最终实施总结

## 实施状态：核心架构已搭建，待完善

### 已完成的核心修改

#### 1. 删除 backgroundService 中的 leader 选举 ✅
**文件**: `packages/plugin-background/src/backgroundService.ts`

- 删除了 `createLeaderContext` 函数（约 350 行代码）
- 删除了 `LEADER_LOCK_NAME`、`LEADER_HEARTBEAT_MS` 常量
- 删除了 Web Locks 使用（`navigator.locks`）
- 删除了 BroadcastChannel 选举/心跳/快照广播
- 删除了 Follower 动作转发（`forwardAction`）
- 删除了 Leader 快照合并（`leaderSnapshots`）
- 删除了 `runLocallyIfEligible`、`shouldUseLocalSession` 函数
- 保留了核心任务执行逻辑

#### 2. 创建 backgroundServiceCoordinator facade ✅
**文件**: `packages/plugin-background/src/backgroundServiceCoordinator.ts`

- 通过 Coordinator client 执行 runNow/cancel
- 状态缓存和事件监听
- 设置更新通过 Coordinator

#### 3. 修改 background manifest 使用 Coordinator ✅
**文件**: `packages/plugin-background/src/manifest.ts`

- 优先获取 Coordinator client
- 有 Coordinator 时使用 facade，否则回退到本地实现

#### 4. 修改 bootstrap 注入 Coordinator ✅
**文件**: `apps/web/src/bootstrapPlugins.ts`

- 在 bootstrap 开始时创建 Coordinator client
- 注入到 PluginHost 供其他插件使用
- 连接失败时回退到本地实现

#### 5. 修改 AppShell 自动锁定 ✅
**文件**: `apps/web/src/shell/AppShell.tsx`

- 自动锁定改为向 Coordinator 发送节流 activity
- 无 Coordinator 时回退到本地锁定
- 活动事件节流 5 秒

---

### 之前已完成的修改

#### 6. Contracts 定义 ✅
- `packages/contracts/src/sessionCoordinator.ts`

#### 7. Coordinator SharedWorker ✅
- `apps/web/src/keymasterSessionCoordinator.worker.ts`

#### 8. Coordinator Client ✅
- `apps/web/src/keymasterSessionCoordinatorClient.ts`

#### 9. Session Crypto Client 修改 ✅
- `packages/plugin-vault/src/sessionCryptoClient.ts`

#### 10. Vault Facade ✅
- `packages/plugin-vault/src/vaultServiceCoordinator.ts`

#### 11. Vault Manifest 修改 ✅
- `packages/plugin-vault/src/manifest.ts`

---

### 待完成的工作

#### 1. 删除旧机制残留代码
需要检查并删除：
- `packages/runtime/src/createPluginHost.ts` 中的 `BroadcastChannel("asset.data.changed")`
  - 应该由 Coordinator port event 替代
  - 暂时保留，添加注释说明

#### 2. 修复类型错误
- 运行 `pnpm typecheck` 检查类型错误
- 修复 import 路径问题
- 确保所有 facade 满足 contract 接口

#### 3. 补充测试
需要创建以下测试文件：
- `apps/web/src/keymasterSessionCoordinatorClient.test.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.test.ts`
- `packages/plugin-background/src/backgroundServiceCoordinator.test.ts`

#### 4. 完善 Coordinator 核心逻辑
当前 Coordinator 中的 TODO：
- Vault unlock 验密、读库、解密私钥
- Crypto 操作实现
- WOC capability 实现
- DB capability 实现

#### 5. 修改 P2PKH/BSV-21/STAS 任务注册
当前任务注册仍在 tab 内完成，需要改为通过 Coordinator：
- `packages/plugin-p2pkh/src/p2pkhService.ts`
- `packages/plugin-token-bsv21/src/manifest.ts`
- `packages/plugin-token-stas/src/manifest.ts`

---

### 关键设计约束

1. **私钥只在 Worker 内存中**：永不离开 SharedWorker
2. **sessionEpoch 世代栅栏**：每个异步操作都带 epoch
3. **单一真值**：所有 tab 共享同一个 Coordinator
4. **删除多 tab 竞争机制**：不再有 leader 选举
5. **Worker-safe tasks**：任务 handler 不依赖 window、DOM、React

---

### 下一步建议

1. **优先级 1**：修复类型错误，运行 `pnpm typecheck`
2. **优先级 2**：补充测试文件
3. **优先级 3**：完善 Coordinator 核心逻辑
4. **优先级 4**：修改 P2PKH/BSV-21/STAS 任务注册

---

### 文件清单

#### 新增文件（12个）
1. `packages/contracts/src/sessionCoordinator.ts`
2. `apps/web/src/keymasterSessionCoordinator.worker.ts`
3. `apps/web/src/keymasterSessionCoordinatorClient.ts`
4. `packages/plugin-vault/src/vaultServiceCoordinator.ts`
5. `packages/plugin-background/src/backgroundServiceCoordinator.ts`

#### 修改文件（6个）
1. `packages/plugin-vault/src/sessionCryptoClient.ts`
2. `packages/plugin-vault/src/manifest.ts`
3. `packages/plugin-background/src/backgroundService.ts`
4. `packages/plugin-background/src/manifest.ts`
5. `apps/web/src/bootstrapPlugins.ts`
6. `apps/web/src/shell/AppShell.tsx`

#### 备份文件（1个）
1. `packages/plugin-background/src/backgroundService.ts.bak`
