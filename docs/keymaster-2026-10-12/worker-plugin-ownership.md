# SharedWorker 插件职责迁移

日期：2026-10-12。用户已确认设计并授权实施。

## 问题与目标

`apps/web/src/keymasterSessionCoordinator.worker.ts` 同时持有 Host 装配、跨 tab 会话、authority、各插件 setup、领域状态、业务分发和测试入口。Webloom 已管理运行单元生命周期，但插件实现的所有权仍集中在应用入口。

目标：保持一个 SharedWorker，将每个领域的 Worker 实现归还所属包。新增插件只需实现 Worker 单元、声明 capability 并加入装配，不应增加 coordinator 的业务分支、全局状态或专属清理。

## 职责边界

- Worker 入口：环境初始化、基础设施创建、插件列表、Host 启动。
- Coordinator 基础设施：真实 peer 绑定、跨 tab 会话准入/撤销、authority、升级交接、最终 I/O 租约与审计、公共事件传输。
- Vault：私钥、钱包解锁事实、硬件、支付、迁移、自动锁定策略。会话转换与 coordinator 协作，不能各持一份解锁真值。
- Storage：Root、binding、grant、请求排队、授权、浏览、存储健康与恢复。
- Window P2P：executor 租约、桥接请求、预算、取消与断连。
- WOC：查询/广播服务、配置、队列观察、链高度任务与快照。
- P2PKH：provider registry、UTXO、设置、转账、广播、同步任务及证据。
- SatSubscription：供应商 runtime、Channel mux、订阅、发布和入站处理。
- MSFile：内容服务、授权、队列、BitFS 协议与资金任务。
- Contacts、Forum、Token、Ordinals：各自服务、状态、任务、请求和清理。
- Background：任务运行注册表、调度、取消、设置与快照。任务定义由领域插件提供。

## 实现要求

1. 各插件导出无 React 的 Worker 实现入口；实现与静态声明共用唯一运行单元契约。
2. 插件私有状态在 runtime/实例闭包内创建，旧实例不能覆盖新实例。禁止插件反向 import `apps/web`。
3. 插件业务依赖由 capability 获取；公共机制使用小而明确的类型接口，禁止传递整个 coordinatorState 或通用 callback 大包。
4. 同步撤销通过 `scope.onRevoke` 关闭准入、取消请求；异步排空通过 `context.onDispose` 或异步 teardown 等待。不能以 fire-and-forget 清理冒充完成。
5. typed RPC 的业务 handler 归对应插件。公共准入仍绑定真实 peer、epoch 和取消信号。广播等不可逆操作的过期证据由业务插件保留。
6. Host 管理实例与 scope；领域健康状态不可伪装成第二套 Host。就绪状态必须在实际 setup 完成后提交。
7. 锁定、改密、重置、Root 换绑、升级和迟到结果隔离保留现有约束；不得通过兼容 fallback 回到旧中央实现。
8. 生产 Worker 重启保持 locked，不恢复明文私钥。

## Webloom 边界

现有 0.6.0 已提供独立单元、capability、typed handler、父 scope、同步撤销和异步 disposal。本次不预先升级框架。只有真实生命周期验证证明通用语义缺失，才提出最小框架修改；钱包策略不进入框架。

## 实施顺序

1. 建立无 React 的插件实现装配与公共准入/任务接口。
2. 完整迁移 WOC 和 Forum，验证私有状态、依赖和清理。
3. 迁移资产插件、Contacts、P2PKH、SatSubscription、MSFile、Window P2P。
4. 迁移 Background、Vault、Storage，统一锁定和恢复协议。
5. 将业务请求分发和策略归还插件、迁移测试入口，删除旧装配/状态/分发。现有 typed Coordinator RPC 保留为跨 tab 的公共准入入口，客户端 wire 格式不变。

各阶段必须真实可运行，不把单纯移文件或 callback 转发标记为职责迁移完成。

## 验收

- 入口不认识领域业务命令，不持有插件私有 runtime。
- 所有 Worker 单元的 setup 在所属包，装配没有 productId 分支。
- 插件间仅通过声明能力协作，公共接口不暴露可变中央状态。
- 两次实例启动、撤销后的迟到结果、依赖停用、异步清理失败均正确隔离。
- 锁定后立即拒绝旧会话；排空结束后才报告清理完成。
- 存储故障/恢复、跨 tab、广播证据和升级交接保持正确。
- 类型检查、相关插件/Coordinator 测试、Worker 导入边界、最终 I/O 审计与浏览器生命周期检查通过。

## 实施记录

核心职责迁移已实施；完整验收仍有下述基线失败。Webloom 保持 0.6.0，没有修改框架。

### 已实施的结构

- `apps/web/src/keymasterSessionCoordinator.worker.ts` 从 9,739 行缩为 11 行，只启动 Host、绑定观察与安装退场机制。
- `apps/web/src/assembly/coordinatorWorker.ts` 是可信组合根：装配插件的运行时与公共端口，协调跨 tab 会话和跨插件撤销。它不是插件实现包；领域算法、Worker setup、任务定义和私有状态已移入所属包。
- `apps/web/src/coordinator/workerAuthority.ts` 拥有跨物理 Worker authority、升级 gate、最终 I/O 租约与审计。
- `apps/web/src/assembly/coordinatorWorkerTesting.ts` 承接测试钩子和领域夹具，生产入口不导入它。Forum 网络测试也已移入 Forum 包，旧应用转发文件已删除。
- Storage、Vault、WOC、P2PKH、SatSubscription、MSFile、Window P2P、Contacts、Forum、Token BSV21、Token STAS、Ordinals 均有自己的 `/worker` 入口。Background 包拥有任务注册表、调度、快照、取消、阻塞与恢复。
- `defineBuiltinWorkerPlugin` 复用静态运行单元目录，拒绝缺失或不唯一的 Worker 声明。插件通过 `defineWorkerRequestRoute` 声明自己的请求处理、并发、清理、激活与过期处理策略；公共路由没有业务 switch。
- Vault 的钱包控制与 Window executor bridge 新增声明 capability。Forum 从 capability 借 bridge；MSFile、SatSubscription 声明可选 bridge，支持本地设置和离线读取，网络操作在缺席时明确失败。绑定检查 consumer/scope、owner、epoch，组合取消信号并检查迟到结果。
- 其他现有声明能力继续承接钱包状态、crypto、存储、WOC、P2PKH、Sat、MSFile 与 Contacts 协作。公共 I/O、事件、任务注册与安全撤销通过明确类型端口装配，不传递整个可变 coordinatorState。
- 异步任务、未完成的服务启动和 protocol 启动纳入 disposal 排空；旧 Window 实例撤销及 MSFile disposal 不得影响新实例。

仍使用一个物理 SharedWorker。这里拆分的是插件运行单元与代码所有权，不是为每个插件创建独立 OS Worker。

### 验证记录

- `pnpm test:types`：通过，包含目录与类型检查、79 项契约测试及 Worker 导入边界检查。
- Worker 边界门禁新增入口职责、禁止插件反向引用应用装配、禁止生产图导入测试钩子的检查；最终 I/O 门禁检查组合根及插件的真实调用，不能仅由转发回调满足审计要求。
- 相关回归：428 项中 424 项通过，剩余 4 项均在修改前的 `1843fc1` 分离工作树中复现。真实 Native Worker Host 验证了 WOC 旧句柄撤销和新实例启动，以及 Forum 使用真实领域提供方的能力发布与撤销。
- Web 生产构建与产物扫描通过。现有跨 tab 浏览器 smoke 到达初始化后，被 `key.json 必须保存唯一 Key 的标签` 的断言阻塞；同一失败在原提交复现。

### 尚未通过的验收

现有基线的 A05、A03、B11 signer/单 Key 用例，以及“已验证 Hash 请求命中本地 Seed 时建立卖方会话”用例仍失败。浏览器跨 tab smoke 也未完整走完。此次没有通过跳过用例、放宽断言、增加假实现或延长超时掩盖这些失败，因此不能把完整验收标记为通过。
