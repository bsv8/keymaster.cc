# Keymaster 插件系统重构施工单

日期：2026-09-06。状态：主链、Window lifetime 编排、子 Scope 清理聚合和 Worker 状态聚合已落地；目标部署发布证据仍待完成。设计基线：[设计文档](./design.md)，代码基线为工作区当前代码。

## 1. 施工约束

1. 先固定行为与证据，再引入 Cordis；先迁移生命周期，再拆领域代码。保留现有存储世代、删除日志、签名格式、Connect 校验及网络并发限制。
2. 一个实例只有一个生命周期所有者。迁移批次内部一次切换，旧监听、旧任务注册和旧清理在同批删除；禁止两个框架同时启动同一业务。
3. 字段、状态、错误原因须有中文说明。文中路径为建议责任范围，新模块路径是施工目标，不表示文件已存在。
4. 本轮可以为已施工的边界补机制测试，但不能把机制测试等同于生产验收；以下仍未运行的项目必须明确标为未验证。不得把“计划验证”写成“已经通过”。
5. 不用真实付款、广播或真实私钥验证生命周期；用现有测试替身、临时桶和故障注入。需要端到端协议验证时沿用项目测试环境。

## 2. 推荐执行顺序与交付门槛

| 工单 | 目标 | 前置 |
| --- | --- | --- |
| KMP-001 | 现状清单、模型与协议验证、首次升级路径定案 | 无 |
| KMP-002 | 无 React 的作用域、资源归属与远程服务桥 | 001 通过 |
| KMP-003 | 插件依赖、并发命令与升级接管门禁 | 002 |
| KMP-004A | 权限契约、租约验证器与受限 Context | 002、003 |
| KMP-004B | owner 存储权限纵向迁移 | 004A |
| KMP-004C | 密码学权限纵向迁移 | 004A |
| KMP-005 | 主会话锁屏 / 切 Key / 解锁统一边界 | 003、004A–C |
| KMP-006 | 后台任务与系统网络服务迁移 | 005 |
| KMP-007 | Key 删除流程补齐与恢复验证 | 004、005；006 后做完整回归 |
| KMP-008 | Connect 实例与授权生命周期统一 | 004、005、007 |
| KMP-009 | 系统应用迁移、旧逻辑删除、发布验收 | 006、007、008 |

002–005 可在开发分支形成一个可完整验证的基础批次；在 005 前不把不完整新生命周期发布到生产。006–008 每个切换点保持单一实现，009 做全量收尾。不要在本轮自动执行这些工单。

原 KMP-004 编号保留为一组，后文依赖“004”均指 A / B / C 三个子单全部通过。001 是验证关卡，不是批量迁移授权；其中的协议草案和验证失败必须先反馈到设计，不能边大批改业务边决定安全语义。

## KMP-001：建立实际能力清单，验证 Cordis 适配（已完成证据收集，结论不通过）

**目标：** 确定要替换的是哪套运行机制，避免重构建立在历史注释上。

**责任范围：** `apps/web/src/pluginCatalog.ts`、`bootstrapPlugins.ts`；各包 manifest 和 `coordinator` 入口；`packages/plugin-vault/src/sessionCrypto*`、`vaultService*`；`packages/plugin-protocol/src/protocolService.ts`；`packages/runtime` 的隔离验证入口。

**施工内容：**

- 盘点全部 25 个 catalog 插件：提供能力、硬依赖、条件依赖、执行位置、生命周期、存储声明、批准权限、注册资源和后台任务。另列 Host 内置服务、Worker 手工创建服务，不能只扫 manifest。
- 对照所有 `ctx.get / require / has / provide`、Coordinator 注入和 Registry 注册，记录未声明服务、重复服务、跨层调用、异步启停及隐藏支付依赖。
- 追踪主页面、Connect 普通 popup、AppView 启动器三条生产入口，记录密码学对象如何交接、谁持钥、锁屏 / 切 Key / 关闭窗口后谁仍可执行。
- 固定 Connect 策略。设计默认“撤销借用主会话的授权”；若选择独立会话，先更新设计第 8 节及 008 验收，不能静默改变已有行为。
- 在隔离验证中安装固定版本 Cordis 核心，记录实际包名、版本、锁文件、上游提交和构建结果；不使用 Harness vendor 的 API 名称推断 npm 包兼容性。
- 验证 Window、Dedicated Worker（专用 Worker）、SharedWorker 均可构建运行，不引入 React、Node 专属模块或动态脚本 loader。
- 验证依赖缺失等待、提供者撤销与恢复、异步初始化中卸载、初始化失败、清理异常和清理超时；确认怎样拿到可靠的就绪与停止结果。
- 按设计 4.2 节区分产品描述、运行单元和运行实例；验证一份 Worker 服务对应多个 Window 消费实例。纯 UI 样板不能替代跨环境验证。
- 按设计 4.4 / 6.1 节验证服务就绪、代理重建、快照乱序和控制命令冲突；确认现有 RPC / baseline 能复用的部分，记录需要补充的字段。
- 将升级接管提前到此单：采用 WebLoom 稳定 WebLock + `ifAvailable` 直接冲突错误，验证旧页面拒绝和当前 Worker I/O 排空；无法证明安全时，不允许后续批次切换生产写入。

**交付：** [inventory.md](./inventory.md)（现状矩阵）、[cordis-spike.md](./cordis-spike.md)（版本和验证记录）、[connect-strategy.md](./connect-strategy.md)（Connect 策略决策记录）。没有实际执行的项目明确标为未验证。

另在验证记录内强制记录四项决策及证据：运行单元模型（设计 4.2）、状态与命令协议（6.1）、远程服务桥（4.4）、首次升级接管（11.1）。每项写清选择、未选方案原因、测试结果和剩余限制；直接引用并修订这些规范，不强制另建四份重复 ADR（架构决策记录）。

**验收结果：** 已解释主会话与 Connect 的实际入口并盘点 25 个 catalog 产品；作用域、资源、意图命令、服务桥、显式运行单元和升级门禁的基础契约已有测试。Cordis 的 Node 隔离导入成功，但浏览器 / Dedicated Worker / SharedWorker 的 Cordis 适配链未验证，且依赖未锁定，因此“采用 Cordis”不通过。本批次选择现有 Host 的自研薄核心作为施工实现；主页面 Window → SharedWorker → 独立 MessagePort → owner/platform 存储与 Coordinator crypto、Dedicated Worker Session Crypto，以及 `/apps → Session Window → 外部 AppView → connect.launch` 已在 Chromium 生产构建回归。25 个产品的 manifest 已显式声明 Window / Worker 单元，Coordinator Worker 另有静态目录和运行态实例注册；剩余门禁是目标部署的 AppView、恢复、不可逆 I/O、旧 Worker 退出和回退证据。

**处理：** 保留现有 Host 并完成最小自研增强；不引入 Cordis，不开始批量业务迁移，不同时引入两套调度器。后续如改用 Cordis，必须先完成浏览器 / Worker 适配器验证并替换当前实现，而不是并行运行。

## KMP-002：作用域与资源归属

**目标：** 资源在创建时有所有者，销毁不依赖事后猜测。

**当前结果：** 作用域、资源登记、同步撤权、服务桥和跨环境协议的本地实现已落在 `packages/runtime/src/lifecycle/`；Window Host 已按 `storage`、`owner-session`、`connect-session` 选择 Root 子 Scope，锁屏 / 切 Key 同步撤销旧 owner Scope，并在新身份下重建实例；父 Scope 会聚合子 Scope 的超时、失败、迟到成功与待清理资源。已覆盖迟到资源最终成功回收、旧代理、快照缺口、`callId` 复用、插件子 Scope 纳入 Host 清理结果等测试。Node Coordinator 纵向测试与 Chromium 生产构建已验证 Window → SharedWorker → 独立 MessagePort → owner/platform 存储和 crypto；25 个产品的 manifest 与 contracts 静态运行单元目录已逐项校验，Coordinator Worker 的 12 个任务 / 服务单元由运行态注册表绑定 instance。外部部署链和目标环境恢复证据不在本地测试范围内。

**责任范围：** `packages/contracts/src/plugin.ts`；`packages/runtime/src/createPluginHost.ts`、`pluginOwnership.ts`、`messageBus.ts`、`resources/`、各 Registry；建议新增 `packages/runtime/src/lifecycle/`，保持可被 Worker 独立导入。

**施工内容：**

- 按设计 4.2 / 6.1 定义运行单元、作用域、实例令牌、只读上下文、取消信号和清理结果，使用 `packages/runtime/src/lifecycle/` 自研薄核心实现；不把 Cordis 原始根 Context 暴露给业务。Cordis 暂不作为生产依赖。
- 包装现有服务提供、消息订阅、Registry 注册、定时器和请求资源；逐步把 `onDispose` 与 teardown 接到同一释放记录。
- 规定同步撤销入口和异步收尾分离；所有回调尽力执行、幂等、可观测。清理失败或超时保留待处理状态。
- 异步创建资源需在开始前登记取消责任；停止后返回的资源立即释放，不能发布到旧上下文。
- 优先迁移一个纯注册插件作为样板，例如导入器；只证明归属机制，不先触碰私钥和远端支付。
- 按设计 4.4 在现有 RPC 上实现最小服务桥；先以测试租约验证结构，不用测试授权替代后续 004 的真实权限校验。
- 增加“假的 Worker Provider → Window 代理 → owner 存储消费者”验证链：Provider（提供者）使用测试数据和临时 owner 存储，浏览器测试使用真实 Worker / MessagePort，故障用替身注入；不得仅在同一个 Context 中模拟跨环境。

**验收：** 初始化半途失败、注册后异步新增资源、重复停止、释放回调抛错、停止后迟到资源五种场景都无残留贡献；关闭一个页面不销毁 SharedWorker 根。

跨环境链还必须覆盖：服务 ready 前消费者不启动；Provider 重建后旧代理拒绝；断线进入等待；重连后只重建一次；旧连接和旧 revision 的快照无效；初始化 / 写入中撤权不让旧结果进入新 owner。此验证先于业务批量迁移，004 / 005 再使用真实验证器与会话边界重复相关断言。

**完成证据：** 新旧资源数量对比与失败注入测试。已迁移 Registry 不再通过 ownership 快照差分回收。

## KMP-003：依赖驱动启停与唯一权威

**目标：** 禁用提供者时自动停止消费者，解锁或恢复依赖不篡改用户设置。

**当前结果：** SharedWorker 已持有插件意图控制器，页面 UI 已改为提交绝对意图命令；命令去重、修订冲突、Worker 重启后的旧 `authorityInstanceId` 拒绝和页面旧事件丢弃已有测试。运行时按 `execution` 选择唯一单元，严格依赖匹配 `sourceExecution`、`scope` 和 `contractVersion`；Coordinator 最终存储与签名边界使用 WebLoom 浏览器运行锁、本地 gate 和内存 I/O 计数，不再把临时 authority / active lease 写入业务 K-V。25 个产品均有显式 manifest 单元，Coordinator Worker 目录登记 12 个任务 / 服务单元，并由 Worker 运行态注册表绑定实际 instance；未登记的生产任务继续 fail closed。

Coordinator 的生产任务装配现在对未登记 `productId`、`unitId` 或最终 I/O 审计入口的任务 fail closed（安全拒绝）；只有测试专用注册入口可创建临时未登记任务。这样新增手工任务会在运行前暴露为施工缺口，不会静默进入生产。

**责任范围：** `pluginGraph.ts`、`pluginConfigStore.ts`、`createPluginHost.ts`；`apps/web/src/bootstrapPlugins.ts`、`pluginCatalog.ts`、Coordinator Client / Worker；`plugin-settings` 启停界面。

**施工内容：**

- 持久启用意图与运行状态分离；旧布尔配置映射成用户意图，不把“依赖不可用”写回禁用配置。
- 产品启停、运行单元装配和各环境实例快照分离；以单元图处理依赖，以产品意图控制是否允许运行，避免 Window 初始化失败被写成 Worker 停用。
- 依赖图由描述构建；装配前检查缺失提供者、重复单一服务、硬依赖环、必需管理外壳对可禁用业务的依赖。
- 移除“有 enabled dependent 就拒绝 disable”的旧行为，改为显示受影响列表、统一撤权、逆依赖停止；无需用户逐个关闭依赖插件。
- 由主 Worker 接收系统启停意图、持久化修订号并发布权威快照；页面只装配本地贡献。删除页面对 Worker 业务启停的隐式控制。
- 实现设计 6.1 的合法转换、实例令牌、命令去重与预期修订比较；控制确认与运行成功分别反馈。旧异步完成只清理自身，不覆盖新实例。
- 实现 001 选定的版本握手、兼容策略与接管门禁。若需过渡版本，先在旧架构发布并验证，再进入新生命周期的生产切换；不把过渡版本误作为批量业务迁移。
- 可选依赖改为局部子功能；Provider 选择仍走已有 Registry。恢复依赖时不重试永久失败插件到无限循环。
- 启动阶段只保留用户流程门禁；服务顺序由依赖解决，去除清单顺序要求与重复手动重试。

**验收：** A → B → C 三层依赖正确停止和恢复；手动关闭 C 后恢复 A，C 不启动；循环和重复提供能诊断；双 Tab 同时启停按单一修订序列收敛；关闭任务托盘不取消其他业务应有的内核任务。

补充验收：starting 中 disable、stopping 中 enable、旧初始化晚报错、配置持久化后启动失败、命令确认丢失后重复提交、相同 commandId 不同内容、修订冲突、主 Worker 重启后旧命令被拒绝。双版本测试必须证明旧写入已被隔离，不能仅验证新页面收到了升级提示。

**清理失败要求：** 旧实例即时失去服务权限；新实例不得在旧写入或排他资源未排空时运行。UI 区分“已停用”和“清理未完成”；清理超时但最终成功后必须自动收敛并允许再次启用。

## KMP-004A：权限契约与租约验证器

**目标：** 建立可复用的校验入口，不在这一单同时搬迁存储和密码学业务。

**当前结果：** 远程服务桥已使用服务端持有的不透明 `grantId`，并在连接、服务实例、作用域、会话 / owner、授权修订和最终操作 allowlist（允许操作集合）处复核；主页面与 Coordinator 的独立 MessagePort、Worker 服务单元实例和旧代理失效已有 Node / Chromium 证据。上传、订阅、广播 / 支付等不可逆领域入口仍按审计台账要求等待目标环境 smoke，不能以本地链替代外部证据。

**责任范围：** `packages/contracts/src/plugin.ts`、`sessionCoordinator.ts` 及权限契约；`packages/runtime` 的 Context / 服务桥；`bootstrapPlugins.ts` 的 Coordinator facade；Worker RPC 授权入口。

**施工内容：** 区分权限申请、内置批准策略、Connect 用户授权；实现实例、会话、桶与授权修订的统一租约校验，绑定真实端口身份，关闭公共表获取私有 Coordinator 的入口。按设计 7.3 验证升级新增权限，不从旧批准自动扩权。收口错误码与中文映射，并让 Resource Store、MessageBus 和 002 已绑定归属的 Registry 使用同一权限规则；不再重写这些组件的生命周期机制。

**验收：** 测试服务通过真实 RPC 校验器，伪造身份、租约重放、授权版本过期、未获批准的新单元、新增权限未批准、替代 Context 入口绕过均被拒绝；旧权限范围内的合法调用不受无关 App 授权变更影响。

## KMP-004B：存储权限纵向迁移

**目标：** 完整打通“单元声明 → 受限句柄 → RPC → 最终存储 I/O”一条链。

**当前结果：** owner 与 platform 存储均由 Coordinator 发放端口绑定 grant；最终 owner / platform I/O 复核 owner、桶世代、session epoch 和根安装令牌。owner 生命周期计数在同一 Worker 内按 owner 串行化短 CAS，跨 Worker 仍通过条件写入重试，避免启动并发时误报 lease 冲突。platform grant 在重连后只对尚未进入物理 I/O 的授权校验失败重绑一次，不重放未知结果写入。主链已由 Node / Chromium 覆盖；领域插件和外部部署仍需逐入口审计。

**责任范围：** `packages/contracts/src/storage/access.ts`、`storage/internal.ts`；`packages/platform-storage/src/coordinator/` 及 owner 存储边界；一个现有 owner 数据消费者。

**施工内容：** 沿用内置存储声明表，区分读写权限，句柄绑定产品 / 单元 / 实例、owner、桶和现有世代。使用 004A 验证器在服务端与最终 I/O 前检查；旧句柄不能动态换绑。替换这一链路按英文文本识别旧绑定的逻辑。

**验收：** 读其他 App 目录、替换 owner / App ID、只读授权写入、跨桶和重导入后的旧句柄全部拒绝；验证异步 I/O 撤权与排空语义，合法数据路径及 schema 不变。

## KMP-004C：密码学权限纵向迁移

**目标：** 完整打通“业务意图 → 专用能力 → RPC 授权 → 内核密码学”一条链。

**当前结果：** Coordinator crypto 服务通过独立 MessagePort 暴露，服务端持有 grant 并在最终派生 / 签名操作复核会话、owner、Provider 实例和允许操作；独立 Dedicated Worker Session Crypto 也已完成浏览器回归，dispose 后公开能力立即撤销。Connect 默认 AppView 仍使用受控 bootstrap runtime，不能把 Dedicated Worker 测试路径当作所有 Connect 请求的默认实现。

**责任范围：** `packages/contracts/src/activeKeyCrypto.ts`、`vault.ts`；Vault Coordinator 代理、Worker 密码学入口与一个交易 / 协议调用者。

**施工内容：** 拆分公开身份、交易 / 意图 / Channel 密码学、备份导出和 Vault 管理的窄接口；接入 004A 租约校验。任意摘要签名保留为受信任内部原语，不能因签名请求带一个用途字符串就放行。底层算法、编码格式和原业务校验不变。

**验收：** 公钥与会话不匹配、普通签名者导出备份、未经验证的任意摘要签名、普通插件取得管理能力均拒绝；通过真实调用链验证旧租约撤销；合法现有签名与协议输出兼容。

## KMP-005：统一主会话边界

**目标：** 锁屏、切 Key、解锁只通过一个控制器推动作用域。

**当前结果：** 主 Coordinator 已统一锁屏、切 Key、解锁时的 session epoch、owner fence、服务代理撤销和最终 I/O lease；旧 proxy、旧 Provider 实例和旧世代请求有 Node / Chromium 回归。运行唯一性由 WebLoom WebLock 提供，Keymaster 仅保留本 Worker 内存 gate/计数；双方都支持 Web Locks 的后续升级中，旧 Worker 存活时新 Worker 直接报错，用户刷新或关闭全部页面后重开。首次从不支持 Web Lock 的 `0.4.2` 迁移必须先走冷切换门禁。目标部署恢复演练和所有领域入口仍未完成。

**责任范围：** `apps/web/src/keymasterSessionCoordinator.worker.ts` 的 `performGlobalLock`、`transitionActiveStorageOwner`、`enterUnlockedState`、激活与 Passkey 入口；`packages/plugin-vault/src/*Coordinator.ts`、`sessionStateMirror.ts`；建议新增 `apps/web/src/coordinator/sessionLifecycle.ts`。

**施工内容：**

- 把现有状态转换、epoch 与 fence（写入封锁）逻辑提取到唯一会话控制器，调用作用域停止；保持既有操作验证和错误语义。
- 安全撤权不等待远端响应；元数据写入和网络清理不得回滚锁定。保留旧请求排空记录供下次解锁重试。
- 统一密码、Passkey、切 Key、换桶、Worker 恢复的入口，禁止某条路径绕过世代刷新或提前发布就绪。
- 旧 store 不自动换绑；依赖会话的实例重建后获取新 store。本地数据恢复完成才发布对应业务就绪服务。
- 清理失败保持撤权，前端显示确定的锁定状态与独立清理进度；主 Worker 崩溃后不得自动解锁。
- 先迁移一条完整业务链验证，再禁止新代码自行订阅锁屏事件管理资源。

**验收：** 锁屏在供应商永不返回时仍即时使新签名失败；A → B → A 旧句柄失败；切换失败不复活旧世代；初始化中锁屏不能发布新服务；锁屏后立即解锁不能绕过旧写入排空；多个 Tab 同时切换不会混合 owner。

**特别检查：** 无法中断的外部写入只能隔离并观察排空，不能把“本地 Promise 已取消”当作真实 I/O 已结束。

## KMP-006：后台任务、MSFile、Sat / Channel 与网络执行器

**目标：** Worker 不再硬编码业务任务和服务的生灭清单。

**当前结果：** 本轮保留领域运行时和现有限流 / 背压，补充了恢复仓库、最终 I/O lease、MSFile 并发压力与媒体 Service Worker smoke；任务型与服务型 Coordinator Worker 单元均已通过静态目录具名，并接入任务身份快照、服务实例快照和最终 I/O 审计。`registerCoordinatorTasks` 仍是单一 Worker 内的领域装配函数，但其创建结果必须绑定到已登记单元，未登记生产任务会 fail closed；下一步不再是隐式迁移，而是目标环境逐项验证和旧逻辑清理。

生产证据门禁从 `packages/contracts/src/pluginProducts.ts` 读取唯一产品清单，并拒绝占位 commit、验收引用和成功选择器；示例证据因此会明确失败，不能被误当作目标部署验收。

**责任范围：** Coordinator 的 `registerCoordinatorTasks`、`ensure/releaseMsfileRuntime`、`ensure/releaseSatRuntime`、P2PKH 支付适配、执行租约；`plugin-background`、`plugin-window-p2p`、`plugin-msfile`、`plugin-sat-subscription` 及各业务 `*CoordinatorTask.ts`；媒体 Worker 与 Service Worker 客户端。

**施工内容：**

- 后台调度器作为内核服务，业务通过实例上下文注册任务；任务自带所属插件、owner 和取消信号。
- 周期任务默认“恢复运行一次 + 正常周期”，不补跑所有错过 tick。交易 / 消息 / 付费行为继续使用领域意图机制，禁止框架自动重放。
- Worker 内每个领域提供无 React 的运行入口，主 Coordinator 只装配入口，不再直接拼所有业务任务。
- MSFile 与 Sat 注册为独立系统服务，共用 Window P2P 租约；执行器页面关闭后按现有租约机制接替。
- 明确 Channel 在 Sat 上层；将 Sat 所需支付能力从资产 UI 启停中拆开，保留既有实现和支出校验。
- 媒体任务管理 Worker、端口、流和对象 URL 的释放；Service Worker 接口逐次检查有效授权，不因浏览器常驻而持有永久 owner 访问权。
- 保留原来的限流、背压、请求上限和失败退避；`plugin-background` 只管理设置与状态投影。
- 按设计 5.5 盘点外部资源在断线后是否自然释放。只有需要持久收尾的订阅 / 上传 / 支付结果核对才补充现有仓库记录，绑定原 owner 和幂等标识；恢复单元只具备撤销 / 查询权限，停用业务后仍能收尾，不新建通用持久工作流引擎。

**验收：** 三个 Tab 仅一份资产同步与网络执行租约；重复锁屏解锁无定时器增长；禁用业务后其 Worker 任务不再执行；文件读中切 Key 能取消且不泄露旧数据；请求卡住后新 owner 不借用旧连接身份；执行器接替不复制付费操作。

恢复验收覆盖远端创建成功但响应丢失、撤销失败后 Worker 重启、结果未知支付只查询不重付、owner 删除中保留必要恢复依据、缺凭据等待认证。无远端幂等 / 查询支持的场景明确转人工，不假报自动恢复完成。

**专项回归：** 按影响范围运行现有 MSFile Service Worker smoke、并发压力验证与 Sat 资源限制测试；不因生命周期重构降低现有限流门槛。

## KMP-007：补齐删除归属与恢复

**目标：** 删除 Key 不依赖运行中的插件，同时覆盖平台目录中的关联数据。

**责任范围：** Coordinator 的 `executeKeyDeletionTransaction`、`recoverKeyDeletionJournals`；`platformRootStore.ts`；Vault 仓库；Protocol 仓库；multipart 仓库和实际盘点发现的共享元数据仓库。

**施工内容：**

- 保留现有日志、owner 墓碑 / 世代和串行删除队列；接入 owner 作用域撤权，覆盖主会话、Connect、后台任务与文件请求。
- 明确每种平台 owner 引用的固定仓库清理方法和幂等键；不引入要求运行插件参与的删除事件链。
- 按实际目录清单验证 owner 根删除覆盖 K-V、文件与临时内容。共享对象只清 owner 引用，不误删其他 owner。
- 故障恢复从持久阶段继续；旧日志兼容读取；分页读取删除记录。Key 记录缺失不能直接推断 owner 数据已清干净。
- 最后一把 Key 收尾保持删除恢复存储有效；重导入同公钥必须等待旧删除结束并消耗新 owner 世代。
- UI 区分删除进行中、失败待重试和完成；保留现有删除意图验证，不新增无关审批层。

**验收：** 活动 Key、非活动 Key、最后一把 Key；插件全部禁用；Connect 窗口仍开着；分片上传进行中；每个删除阶段故障 / 重启；删除后同公钥重导入；两个 owner 引用共享缓存；多页删除日志。所有场景不复活旧写入、不遗失恢复依据、不误删其他 Key。

**不可回退点：** owner 数据物理删除后禁止恢复旧快照冒充回滚。依靠日志继续完成；有存储格式升级时旧版本不得接管新日志。

## KMP-008：Connect 会话统一

**目标：** Connect 自己的实例与主会话授权之间只有一种明确关系。

**当前结果：** 默认“借用主会话授权、锁屏 / 切 Key 撤权”已经落实到 session、owner、来源、App 身份和 launch token 校验；Chromium 已验证 `/apps → Session Window → 外部 AppView → connect.launch`，同时覆盖预开窗口、一次性 bootstrap 和外部来源回传。独立 Dedicated Worker 仅作为 Session Crypto 能力的单独回归路径；普通 popup、Worker 崩溃和外部真实部署 origin 仍需补齐。

**责任范围：** `plugin-protocol/src/protocolService.ts`、`sessionWindowBootstrap.ts`、`storage/protocolStorageRepository.ts`；`plugin-vault/src/sessionCryptoClient.ts`、`sessionCryptoWorker.ts`、`vaultServiceCoordinator.ts`；Connect SDK 测试与协议说明。

**施工内容：**

- 按 001 的实际路径和策略决定，建立 Connect 会话作用域、请求子作用域、独立关闭处理和主授权撤销桥接。
- 默认方案使用主 Worker 发放的会话绑定能力；保留独立 Connect 执行环境，但不复制主私钥来绕开撤权。历史独立持钥路径如需保留，必须按独立授权模型另行明确。
- 绑定来源、已验证 App 身份、owner 和会话租约；切 Key 不替第三方默默换身份。
- 关闭 / 登出只影响当前 App；删除 Key 撤销所有关联会话；断线恢复重新验证，不仅监听一次性的撤销广播。
- 锁屏后未决审批 / 签名 / 付款明确结束；解锁不能重放旧请求。只在现有协议允许范围重新建立连接和订阅。
- 保留弹窗用户激活、launch token（启动令牌）、origin/source（来源与窗口）校验和现有协议限制。若外部行为或错误码必须改变，同步修改协议文档、SDK 和兼容说明。

**验收：** 主窗口、普通 popup、AppView 三入口；主锁屏、A 切 B、单 App 退出、删除非活动 owner、Worker 崩溃、窗口暂停后恢复、伪造来源、启动令牌重复使用。App 不获得 B 的隐式签名权；一个 App 结束不锁死其他会话。

## KMP-009：应用迁移、删除旧实现与最终验收

**目标：** 新机制成为唯一机制，文档描述与实际代码一致。

**责任范围：** 其余全部 catalog 插件；`packages/runtime/src/resources/`；`scripts/check-boundaries.mjs`、`check-react-resource-boundaries.mjs`；`docs/architecture/`、`docs/存储结构.md` 和 Connect 文档。

**迁移批次：**

1. WOC / JungleBus → P2PKH owner 资产与同步 → BSV21 / STAS / 1Sat，确认支付基础能力不被 UI 禁用牵连。
2. Contacts 数据服务 → 在线探测与 Channel → Message / WebRTC → BsvPrice，拆局部可选依赖并回收媒体；Poker 按现有 Vault / Keyspace / 总线关系单独迁移。
3. Home / Settings / Apps / 导入器等界面贡献，最后清理旧装配顺序和兼容桥。

**必须删除 / 收敛：**

- 业务为启停资源而监听 `vault.locked`、`vault.unlocked`、active-key change 的重复逻辑；纯展示失效通知可以保留，但由统一资源适配器管理。
- Worker 中逐个业务 `release`、任务重建、散落的延迟重试列表。
- `pluginOwnership` 中已被身份注册器替代的差分字段与回收路径。
- 公共表中的私有 Coordinator 面、服务取不到时从其他入口借能力的兼容分支。
- 经生产调用链证明不再使用的 Vault / Session Crypto 实现；保留独立 Connect 所需的实际路径，不按文件名一刀切。

**检查规则：** 按目录和例外清单限制业务裸建周期定时器、未归属 Worker / MessagePort、跨插件内部导入；不要使用简单“全仓库禁止 setTimeout”误伤超时实现和测试。保留现有 UI Resource Store 规范。

**运行验证：**

- 对修改模块先跑对应 Vitest 文件；基础机制完成后运行 `pnpm typecheck`、`pnpm lint:boundaries`、`pnpm test`、`pnpm build`。
- 对会话与多窗口变化运行相关 Playwright 测试；MSFile 变化补跑 `pnpm smoke:msfile-media-sw` 与 `pnpm verify:msfile-read-concurrency-pressure`，记录环境与结果。
- 保留已确认生命周期竞态的回归测试；不建立仅镜像实现细节的测试。
- 报告构建体积、启动行为、锁屏生效时延、活动任务 / 订阅 / Worker 数量的改前改后结果。阈值基于 001 实测基线确定，不虚构性能收益。

## 3. 必须覆盖的跨模块验收矩阵

| 场景 | 关键断言 |
| --- | --- |
| 初始化中锁屏 | 服务不能在停止后迟到注册 |
| 锁屏遇到网络永久挂起 | 新敏感操作立即失败，清理失败单独可见 |
| A → B → A | 原 A 的句柄不能在新 A 下复活 |
| 旧请求忽略 AbortSignal | 不能写新 owner；未排空写入保持封锁 |
| 依赖链、菱形依赖、可选服务变化 | 每个实例释放一次，恢复遵循原启用意图 |
| 清理函数抛错或超时 | 其他资源继续释放，权限不恢复，不假报完全成功 |
| 多 Tab 启停、重连、执行器切换 | 一个系统运行真值，不重复同步与扣费 |
| 删除中崩溃 | 从日志继续；Key 缺失仍检查 owner 与平台引用 |
| 删除后重新导入同公钥 | 新存储世代拒绝所有旧句柄 |
| Connect owner 与主 active owner 不同 | 无隐式换 Key，无越权读写 |
| 交易提交后恰好锁屏 | 显示结果待确认，不自动再提交 |
| Storage 故障、换桶、Worker 重启 | 先恢复存储与删除流程，再开放新会话 |
| 远程服务 ready / 撤销 / 重建与快照乱序 | 只有当前握手、当前引用与连续目录基线可提供本地代理 |
| 启停命令重放、修订冲突、迟到初始化 | 用户意图只提交一次，旧实例不能覆盖新实例状态 |
| 插件升级扩大权限 | 无显式批准不扩权，旧租约不能访问新增动作 |
| 新旧版本同时存在 | 在 003 验证接管门禁；009 复验，不到发布时才定义协议 |

## 本轮仍未解除的生产阻断项

以下项目不是基础机制缺失，而是生产发布仍不能放行的剩余条件：

1. 25 个产品的 manifest / contracts 静态单元和 Coordinator Worker 运行态登记已完成；仍需在发布证据中核对每个目标构建实际输出与单元快照，不能只凭源码声明放行。
2. AppView 主链已在本地 Chromium 生产构建通过，但外部部署 origin 的同等回归仍未完成；当前外部 App 由 Playwright fixture 提供。
3. 双方都支持 Web Locks 时，旧 Worker 仍存活会让新 Worker 立即 fail closed 并要求用户刷新/关闭全部页面；但首次从不申请 Web Lock 的 registry `0.4.2` 迁移到 `0.4.3` 时不能自动发现旧 Worker，必须先通过部署门禁完成冷切换退出证据。Worker 崩溃后浏览器自动释放锁，但远端未知结果仍需领域仓库对账，不能自动重放。
4. Coordinator 入口已经统一标记并形成[不可逆 I/O 审计台账](./irreversible-io-audit.md)，但上传、远端订阅、广播 / 支付、未知结果仍需在目标部署环境执行 smoke；本地测试和 MSFile 压力验证不能替代外部供应商验证。
5. 运行锁只覆盖同一浏览器配置；不能把它当成跨浏览器 S3 写锁。发布环境仍需完成旧版本退出、版本淘汰、业务未知结果对账和回退演练。

## 4. 发布与回退

优先使用兼容现有数据格式的代码迁移；第一阶段不更改 Key 加密格式、桶路径和业务 schema。每个批次记录删除了哪些旧逻辑、保留哪些桥接、下一批在哪里移除。


回退只能在已验证读写格式兼容、没有新旧 Worker 并行接管的条件下恢复上一代码版本；已撤销的会话必须重新认证。删除是不可逆操作，失败通过原删除日志继续处理，不采用数据“回滚恢复”。

本节的运行策略补充：不做新旧 Worker 自动接管。首次启用 Web Lock 是受控冷切换；只有双方都支持 Web Lock 的后续升级，旧 Worker 存活时新 Worker 才报告运行锁冲突并要求用户关闭/刷新所有页面。单浏览器 Web Lock 不是跨设备写锁，两个浏览器同时使用同一 S3 时必须依赖业务 K-V CAS 和领域级幂等。

最终交付应包含实现后的依赖矩阵、完整验证记录、旧逻辑删除清单、Connect 行为说明和更新后的架构图。仅移动文件或加一层 Context 包装，不算完成重构。
