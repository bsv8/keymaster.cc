# KMP-001 Cordis 验证记录

日期：2026-09-06。结论：**Cordis 采用门槛不通过；本批次暂不加入 Cordis 依赖。** 主页面跨环境链由 Keymaster 自研薄核心完成了本地浏览器回归，但这不是 Cordis 兼容性证据。

## 验证范围

目标是确认真实 npm 包能否承载 Keymaster 需要的 Context（上下文）、Fiber（运行实例）和 Effect（可撤销副作用），并检查它是否能在浏览器、Dedicated Worker 和 SharedWorker 中替代当前 Host。没有因为设计文档中的概念名称而假设 npm 包兼容。当前已验证的浏览器链使用 `packages/runtime/src/lifecycle/` 自研实现，不把它冒充为 Cordis 运行结果。

## 命令与结果

仓库依赖和锁文件检查：

```text
pnpm why cordis
pnpm why @cordisjs/core
```

结果：两条命令均没有返回工作区依赖；`pnpm-lock.yaml` 没有 Cordis 条目。

包元数据检查：

```text
pnpm view cordis version description --json
=> {"version":"4.0.0-rc.9","description":"Meta-Framework for Modern Applications"}

pnpm view @cordisjs/core version description --json
=> {"version":"3.18.1","description":"Meta-Framework for Modern JavaScript Applications"}
```

隔离临时目录安装（不修改本仓库 `package.json` 或锁文件）：

```text
npm init -y
npm install --ignore-scripts --no-audit --no-fund cordis@4.0.0-rc.9
```

结果：安装成功。隔离 Node 进程可以导入 `Context`、`Fiber`、`Service`，并成功执行 `new Context()`；导出版本为 `cordis@4.0.0-rc.9`。原型检查显示 `Context` 没有 `dispose()`，`Fiber` 提供 `dispose()`，因此仍需一层 Keymaster 适配来定义根作用域、撤权、超时、迟到资源和结构化清理结果。

未完成验证：

- 没有把 Cordis 加入工作区依赖或生成锁文件变更。
- 没有完成 Vite 浏览器构建、Window 运行、Dedicated Worker 运行和 SharedWorker 运行。
- 没有证明 Cordis 的 Fiber 卸载顺序与 Keymaster 的 owner 存储排空、权限即时撤销语义一致。
- 没有用 Cordis 验证真实 Worker Provider → Window MessagePort → owner 存储消费者链。

## 四项决策与证据

| 决策 | 选择 | 已有证据 | 剩余限制 |
| --- | --- | --- | --- |
| 运行单元模型 | Host 按 `execution` 选择唯一匹配单元；无环境或多匹配时 fail closed（拒绝装配）。产品状态聚合 `unitId` / `instanceId`；Web catalog 适配器为历史产品物化一个 Window 单元。 | `packages/runtime/src/pluginGraph.test.ts`、`packages/runtime/src/createPluginHost.test.ts` 覆盖 Worker / Window 隔离和未选能力不进入图；Chromium 回归覆盖 Window / SharedWorker 主链。 | 当前 25 个产品还没有按领域迁移成真实 Worker + Window 单元。 |
| 状态与命令 | SharedWorker `PluginIntentController` 是产品意图唯一写入面；命令为绝对值，带 `commandId`、`authorityInstanceId`、`expectedRevision`，持久化成功与运行成功分开；Coordinator 校验内置产品 allowlist（允许产品集合）。 | `packages/runtime/src/lifecycle/pluginIntentController.test.ts`、`apps/web/src/keymasterSessionCoordinator.worker.test.ts`、`apps/web/src/keymasterSessionCoordinatorClient.test.ts`。 | 运行态仍由各环境逐步投影，领域 Worker 单元迁移未完成。 |
| 远程服务桥 | 保留 Keymaster 窄服务桥，不传递 Context；桥负责握手、目录 revision、代理失效，Provider 负责最终授权检查；服务端持有 `grantId`。 | `packages/runtime/src/lifecycle/serviceBridge.test.ts`、`messagePortServiceTransport.test.ts`，以及 Node Coordinator / Chromium 生产构建 E2E，覆盖旧 Provider、快照缺口、旧连接、传输 `callId`、owner K-V 和 crypto。 | 领域手工运行时尚未全部迁移；外部部署 origin 和不可逆业务 I/O 仍需验证。 |
| 首次升级接管 | 先采用 `cold-switch`（冷切换）语义；本地门禁也支持 `two-phase`（两阶段）测试。握手返回绑定 `UpgradeSession`，只有该 Session 能申请 I/O lease（租约）。 | `packages/runtime/src/lifecycle/upgradeGate.test.ts`，以及 Coordinator Node / Chromium 回归覆盖 authority、handover generation、最终存储 / crypto lease 和活动 lease recovery-required。 | 不能自动隔离完全不认识协议的旧 Worker；崩溃后的人工恢复与部署编排仍未完成。 |

## 结论和后续门禁

本批次采用“借鉴 Cordis 语义、保留 Keymaster 自研薄核心”的方案，原因是：当前项目没有 Cordis 依赖；隔离 Node 导入成功不足以证明 Worker / 浏览器兼容；即使导入成功，根 Context 的生命周期和安全撤权仍需自定义适配。这样不会在仓库中并行引入第二套调度器。

这不是生产批准。恢复 Cordis 选项前，必须先完成固定版本、锁文件、三种执行环境构建 / 运行、清理故障注入和真实跨环境服务链验证；完成后替换当前核心并删除重复实现。当前自研主链的 Provider 注入、服务端授权表绑定以及最终存储 / 签名边界已有 Node / Chromium 证据，但生产仍受领域 Worker / Window 迁移、外部部署 smoke、不可逆 I/O 全量审计、旧 Worker 接管和崩溃恢复策略阻断。
