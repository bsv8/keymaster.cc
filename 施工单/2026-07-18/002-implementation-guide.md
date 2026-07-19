# 施工单 002 实施指南

## 已创建的核心文件

### 1. Contracts（RPC 协议定义）
- `packages/contracts/src/sessionCoordinator.ts` - 定义 RPC discriminated union、公开 Coordinator snapshot、epoch、command acknowledgement、event 及 capability key

### 2. Coordinator SharedWorker
- `apps/web/src/keymasterSessionCoordinator.worker.ts` - 唯一 SharedWorker entry，创建 Coordinator，静态装配 Vault、keyspace、worker-safe task modules

### 3. Coordinator Client
- `apps/web/src/keymasterSessionCoordinatorClient.ts` - SharedWorker client transport，固定名称与 URL、port 生命周期、hello 重连、requestId pending map、epoch cache、subscription event 分发

### 4. Vault/Keyspace Facade
- `packages/plugin-vault/src/vaultServiceCoordinator.ts` - VaultService Coordinator facade
- `packages/plugin-vault/src/keyspaceServiceCoordinator.ts` - KeyspaceService Coordinator facade

### 5. Background Service
- `packages/plugin-background/src/sessionCoordinatorBackground.ts` - 从现有 service 提取无 DOM、无 tab 通道的唯一 scheduler/task runtime
- `packages/plugin-background/src/backgroundServiceCoordinator.ts` - BackgroundService Coordinator facade

### 6. Worker-safe Tasks
- `packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.ts` - P2PKH recent-sync 与 history-backfill Worker-safe task
- `packages/plugin-token-bsv21/src/bsv21CoordinatorTask.ts` - BSV-21 token sync Worker-safe task
- `packages/plugin-token-stas/src/stasCoordinatorTask.ts` - STAS token sync Worker-safe task

### 7. Bootstrap 集成
- `apps/web/src/coordinatorBootstrap.ts` - Coordinator Bootstrap 集成，创建/注入 coordinator client capability

---

## 待完成的集成工作

### Phase 7: 更新 bootstrap、AppShell、manifest 等

#### 1. 更新 `apps/web/src/bootstrapPlugins.ts`

在 bootstrap 开始时注入 Coordinator client：

```typescript
import { bootstrapCoordinator } from "./coordinatorBootstrap.js";

export async function bootstrapPlugins(): Promise<PluginHost> {
  const host = createPluginHost({ ... });

  // 启动 Coordinator
  const coordinatorResult = await bootstrapCoordinator(host);
  setCoordinatorBootstrapResult(coordinatorResult);

  // 继续注册插件...
  // vault manifest 需要使用 Coordinator facade
}
```

#### 2. 更新 `packages/plugin-vault/src/manifest.ts`

使用 Coordinator facade 替换原有 vaultService 和 keyspaceService：

```typescript
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";

export const vaultPlugin: PluginManifest = {
  id: "vault",
  setup: async (context) => {
    const coordinatorClient = context.getCapability("session-coordinator.client");

    const vault = createVaultServiceCoordinator({
      coordinatorClient,
    });

    const keyspace = createKeyspaceServiceCoordinator({
      coordinatorClient,
    });

    context.provideCapability("vault.service", vault);
    context.provideCapability("keyspace.service", keyspace);
  },
};
```

#### 3. 更新 `packages/plugin-background/src/manifest.ts`

使用 Coordinator facade 替换原有 backgroundService：

```typescript
import { createBackgroundServiceCoordinator } from "./backgroundServiceCoordinator.js";

export const backgroundPlugin: PluginManifest = {
  id: "background",
  setup: async (context) => {
    const coordinatorClient = context.getCapability("session-coordinator.client");

    const background = createBackgroundServiceCoordinator({
      coordinatorClient,
    });

    context.provideCapability("background.service", background);
  },
};
```

#### 4. 更新 `apps/web/src/shell/AppShell.tsx`

自动锁定改为向 Coordinator 发送节流 activity：

```typescript
import { getCoordinatorBootstrapResult } from "../coordinatorBootstrap.js";

// 在用户活动时发送 activity
function handleUserActivity() {
  const coordinator = getCoordinatorBootstrapResult();
  if (coordinator) {
    coordinator.client.sendActivity();
  }
}

// 使用节流
const throttledActivity = throttle(handleUserActivity, 5000);

// 监听用户活动
document.addEventListener("mousemove", throttledActivity);
document.addEventListener("keydown", throttledActivity);
```

---

### Phase 8: 删除旧机制残留

#### 必须删除的生产残留

扫描并删除以下代码：

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

#### 需要修改的文件

1. `packages/plugin-vault/src/sessionCryptoClient.ts` - 删除 `new Worker()`、`worker.terminate()`、50ms dispose timer 与 local production fallback
2. `packages/plugin-vault/src/sessionCryptoWorker.ts` - 删除作为 Dedicated Worker entry 的 `addEventListener("message")`、`postMessage`、`closeWorkerScope`
3. `packages/plugin-background/src/backgroundService.ts` - 删除 `createLeaderContext`、`LEADER_LOCK_NAME`、Web Locks、BroadcastChannel election/heartbeat/mailbox
4. `packages/runtime/src/createPluginHost.ts` - 删除 `BroadcastChannel("asset.data.changed")`

---

### Phase 9: 运行类型检查和测试验收

#### 类型检查
```bash
pnpm typecheck
```

#### 测试验收
```bash
# 新增/改造的测试
pnpm vitest run apps/web/src/keymasterSessionCoordinatorClient.test.ts
pnpm vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm vitest run packages/plugin-vault/src/vaultServiceCoordinator.test.ts
pnpm vitest run packages/plugin-vault/src/keyspaceServiceCoordinator.test.ts
pnpm vitest run packages/plugin-background/src/backgroundServiceCoordinator.test.ts
pnpm vitest run packages/plugin-background/src/sessionCoordinatorBackground.test.ts
pnpm vitest run packages/plugin-p2pkh/src/p2pkhCoordinatorTasks.test.ts
pnpm vitest run packages/plugin-token-bsv21/src/bsv21CoordinatorTask.test.ts
pnpm vitest run packages/plugin-token-stas/src/stasCoordinatorTask.test.ts

# 全量测试
pnpm test
pnpm lint:boundaries
```

#### 静态扫描验收

确保生产代码中不存在：

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

---

## 关键设计约束

1. **私钥只在 Worker 内存中**：永不离开 SharedWorker
2. **sessionEpoch 世代栅栏**：每个异步操作都带 epoch，防止旧会话结果写入新会话
3. **单一真值**：所有 tab 共享同一个 Coordinator 中的 Vault 会话
4. **删除多 tab 竞争机制**：不再有 leader 选举、BroadcastChannel 等
5. **Worker-safe tasks**：任务 handler 不依赖 window、DOM、React

---

## 注意事项

1. **SharedWorker 兼容性**：不支持 SharedWorker 的浏览器必须 fail closed，显示"此浏览器不支持共享钱包会话"
2. **appView/Protocol session**：仍按其专属、显式授权的会话 Worker 运行，不连接本单的 Keymaster coordinator
3. **数据变更通知**：Coordinator port event 是唯一跨 tab 数据失效分发路径
4. **自动锁定**：全局无用户活动达到配置时长才全局 lock，单个 tab 的 hidden/blur 不应立即 lock
