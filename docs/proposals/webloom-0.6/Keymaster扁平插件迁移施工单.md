# Keymaster 扁平插件迁移施工单（WebLoom 0.6.0）

状态：编码迁移及用户确认范围内的本地验收已完成。编写日期：2026-10-03；收口日期：2026-10-04。

已接入正式 0.6.0，删除启停意图、等级字段与 Poker 整包。Page 拥有壳、路由和 UI 挂载；`/transfer` 归 P2PKH，藏品转移归 Workspace；`/settings/storage` 保持 Storage 私有 UI 和框架私有 RPC。Vault 拥有生命周期、KeyHold、明文密钥和操作视图，冷启动仅使用 Storage 私有受限端口。Worker 领域执行、状态和任务已归对应插件；Root 保留权威、连接、最终 I/O lease 和 typed 装配。最终发行目录与生产调用盘点已生成，所有本地类型、单元、浏览器及边界门禁通过。

用户于 2026-10-04 明确本次只需 Demo 与 Keymaster 本地测试，线上测试不再作为完成条件。下面原始施工要求保留：完成的编码项已关闭；真实历史数据库全量样本、资金/公网操作及生产交接等未取得的证据仍明确列出，不由本地 fixture 代替。

当前声明盘点见[实施附表](./实施附表.md)；此附表不是全量调用/私有边界验收。测试证据仍记入覆盖矩阵，不在这里预先宣布完成。

唯一目标依据：[迁移需求](./Keymaster扁平插件迁移需求.md)。下文路径是当前修改落点或明确标记的拟新增位置，不代表已经迁移。

## 1. 给施工者的提示

这是运行模型迁移，不是批量改 manifest 字段。完成形态必须满足：**插件平等、具体能力先声明后使用、UI 经 page 挂载、私有服务留在所属插件、生命周期由实际依赖与运行条件驱动。**

- 先确认消费到正式 webloom-framework@0.6.0，再依次完成运行适配、page、Storage、Vault、其他插件与 Connect。不要修改 WebLoom 源码来迁就旧 Keymaster API。
- 不保留 0.5/0.6 双运行时、enable/disable 兼容别名、全局 Host 降级或未声明能力自动补依赖。分阶段施工允许中间工作树尚未通过全部产品门禁，但阶段不能靠免检兼容路径假装通过；恢复集成后再进入下一阶段验收。
- 插件作者决定哪些函数属于公开/私有服务；可信装配决定 Worker 槽位。不要一个函数建一个 Worker，也不要把 Web/Worker 改成两个 pluginId。
- Storage/Vault 各一个 Web 单元即可容纳页面、设置及指示灯。不要误扩为任意多个同 realm 单元，不强制生产拆成两个物理 Worker。
- 不重新实现框架私有票据、stream 清理、注册世代和依赖状态机；产品只接入公开 API 并验证领域范围。
- 不移动/清空已有钱包数据，不扩展 Connect、链服务和存储浏览器功能。已经存在但未验收的其他提案，继续保留自己的验收范围。

## 2. 已核对的施工前源码基线

| 当前落点 | 需要处理的实际问题 |
| --- | --- |
| 根 package.json、packages/runtime/package.json、锁文件、发布脚本 | 仍引用 0.5.0，发布版本配置也为 0.5.0 |
| packages/contracts/src/plugin.ts、webloom.ts、pluginProducts.ts | 产品分类、启停意图、旧状态及重复产品/单元目录 |
| packages/runtime/src/keymasterHostAdapter.ts | 配置启停、旧状态转换、自动 Storage/Coordinator 扩展及多类全局 registry |
| packages/runtime/src/react/PluginHostProvider.tsx | 完整 Host 进入业务 React 树；存在 App 全局能力查询 |
| apps/web/src/App.tsx、bootstrapPlugins.ts、shell/* | 阶段启动、全局资源查询、宿主直接选择领域页面/布局 |
| packages/platform-storage/src/manifest.ts、coordinator/*、runtime/*、ui/* | 已有 Storage Web/Worker 组织，浏览能力还走公开 capability 形态 |
| packages/plugin-vault/src/manifest.ts、coordinator.ts、*Coordinator.ts | 已有 Vault 代理/Worker 服务；密钥流程和存储生命周期需按职责理清 |
| apps/web/src/coordinator/*、keymasterSessionCoordinator.worker.ts | 领域运行单元、启停可用性、服务 handler 与最终 I/O 混在协调入口 |
| apps/web/src/system/registerAssetWorkspace.ts | 资产等工作区由宿主全局 Host 注册，无明确插件消费身份 |
| packages/plugin-protocol、packages/connect | Connect 网关和外部 SDK，需保持外部协议，移除内部全局旁路 |
| scripts/check-boundaries.mjs 等 | 插件互导主要按 plugin-* 扫描，未全面覆盖 platform-storage |

施工前目录列有 24 个插件产品。最终目录为 25 个：新增 page/workspace，移除 Poker；数量由真实发行目录物化，不作为长期硬编码门禁。

## 3. 执行顺序与需求映射

| 顺序 | 施工项 | 对应需求 | 进入后续阶段前的主要结果 |
| --- | --- | --- | --- |
| 1 | KFM-001 盘点与冻结边界 | 全部 | 插件/能力/UI/数据与依赖对照表 |
| 2 | KFM-002 版本与契约切换 | R01、R02、R07 | 0.6.0 单版本、旧启停声明删除 |
| 3 | KFM-003 运行时与消费视图 | R02、R03、R07、R08 | 无免检注入；实例、依赖与状态接入框架 |
| 4 | KFM-004 page 与 UI 注册 | R04 | 正式页面只经 page，贡献身份正确 |
| 5 | KFM-005 Storage | R03、R05 | 三访问面、私有浏览和三类 UI |
| 6 | KFM-006 Vault | R03、R06 | 私钥归 Worker、自己的 UI 和存储协作 |
| 7 | KFM-007 聚合工作区 | R04、R09 | 宿主领域页面归入明确插件 |
| 8 | KFM-008 全插件迁移 | R01、R02、R09 | 最终发行版逐插件无旧模型 |
| 9 | KFM-009 Connect 网关 | R03、R10 | 明确对外名单及 App 会话身份 |
| 10 | KFM-010 Worker 装配收口 | R07、R08 | 多槽位接入、共享页面、权威唯一 |
| 11 | KFM-011 总体验收与文档收口 | 全部 | 真实产品证据与旧路径清除 |

顺序是施工顺序，不是程序启动顺序。程序只按声明依赖与运行条件启动。

## 4. KFM-001 · 盘点与冻结边界

- [x] 从 pluginCatalog、pluginProducts、Worker unit catalog 和各 manifest 生成一份迁移对照，记录每个插件的单元、提供能力、实际调用、UI、存储用途及运行条件；不得只从 imports 推导依赖。
- [x] 记录能力 id/version（标识/版本）、公共/Connect/私有归属、消费者、来源 runtime/slot（执行环境/槽位）、必需/可选与提供者绑定。区分调用能力、领域授权和 UI 注册三个问题。
- [x] 核对 Storage/Vault 的初始化依赖，识别 WalletLifecycleService 等混合职责。确定底层引擎无解锁前置条件，避免双向初始化环。
- [x] 标出所有全局 Host/App、字符串资源查询、Storage/Coordinator 自动注入、UI 宿主特判及跨插件实现 import，逐项指定替代能力或所属插件。
- [ ] 冻结现有钱包数据 schema、模块目录、KeyHold、Connect V1 和不可逆操作语义；记录可恢复的迁移前数据样本与业务测试基线。

验收：最终候选依赖图无环，调用没有“稍后补”的未知归属，公开/私有边界明确。对照作为本施工单的实施附表维护，不另起一套需求。

## 5. KFM-002 · 升级版本与插件契约

主要落点：根/各消费包 package.json、pnpm-lock.yaml、scripts/webloom-release-config.mjs 相关门禁、packages/contracts/src/plugin.ts、webloom.ts、pluginProducts.ts、各插件 manifest。

- [x] 消费正式 registry 0.6.0，统一版本配置和 lock integrity（锁文件产物完整性）；不得用工作区源码、旧 tarball 或本地补丁冒充正式产物。核对本次会用到的公开 exports。
- [x] 删除 PluginKind、PluginStartupMode 及启停专用字段/类型；同步删除序列化快照中的意图字段和旧状态，生产两端使用一致契约。
- [x] 所有发行版插件机械更新到新定义结构；同插件包统一 manifest 与身份，保留稳定 pluginId、可复用的 unitId 和业务配置。
- [x] 建立分开的 Web/Worker 实现入口与统一物化的静态描述；检查导入图，不能把 Worker 私有实现先导进 Web 再靠运行时过滤隐藏。
- [x] 清单只保存发行版选择和部署事实。运行单元的 provides/dependencies 从真实定义物化，不再手抄另一份目录作为真值；任务与最终 I/O 审计可保留额外绑定并校验一致。
- [x] 删除启动分类/显示分组的等级语义；导航主题可以保留，但不能影响生命周期与授权。

验收：契约和定义按 0.6.0 编译，无旧字段兼容别名。此阶段不声明钱包已可完整运行；与下一项适配完成后建立首个可运行集成检查点。

## 6. KFM-003 · Runtime 适配与实例消费

主要落点：packages/runtime/src/keymasterHostAdapter.ts、pluginHostContract.ts、React hooks、资源适配、apps/web/src/bootstrapPlugins.ts 与 Coordinator 运行条件适配。

- [x] 删除启停配置存储、用户意图同步、enable/disable/submitIntent 及 Worker 固定 always-on 策略。只删除这些设置键，保留其他业务设置和恢复记录。
- [x] 生命周期、来源解析、就绪与失效复用框架；由实际能力就绪和钱包运行条件驱动，不保留 bootstrapStage 或产品清单顺序的第二套调度器。
- [x] 同插件 Web/Worker 的初始化前置和私有服务来源也显式绑定；授权登记/代理创建不能满足就绪条件，服务缺席时不能提前开放相关 UI 操作。
- [x] setup、UI、资源和后台任务都用真实单元实例的 consumer。新增/调整产品 hooks 为 consumer 范围；完整 Host/App 只留可信装配模块，业务包不可导入。
- [x] 关闭自动 Storage/Coordinator/registry 注入旁路。为便捷 Storage 门面核对具体依赖及用途，其他 Coordinator 领域操作改为明确服务。
- [x] 收口资源注册/读取，只允许本实例定义；跨插件 reader 明确声明。资产失效通知等原全局事件改为提供方发布的范围明确能力。
- [x] 运行条件接入 framework availability（单元可用性）与 revoke/retry，保留锁定、重置、请求租约及最终 I/O 约束，删除旧状态翻译分支。
- [x] 应用就绪检查处理 blocked/failed（依赖等待/启动失败），不以 App 构造成功判断全钱包可用；提供可诊断恢复入口。

验收：生产 resolver 在未声明、错版本、错来源、撤销时拒绝；可选缺席与未声明区别明确；B 的传递依赖不授予 A。测试必须经过真实适配入口，不只测 mock consumer。

## 7. KFM-004 · 建立 page 插件并收口 UI

已新增：packages/plugin-page；主要迁移来源：apps/web/src/shell/*、App.tsx 的正式页面选择、packages/runtime/src/registries 中的 UI 注册表。

- [x] 在 contracts 定义页面/菜单、设置块、header 项等 typed 注册契约及条目 schema（结构）；沿用现有交互和排序，不新增页面产品功能。
- [x] page 提供注册能力，内部拥有路由、布局、注册表与渲染器；公开服务不提供其他插件的原始可执行条目列表。领域注册表先保持归属迁移清单，不能一律迁入 page。
- [x] 贡献方声明相应能力，通过 createScopedRegistryView 登记；框架写入实例归属，产品核对 consumer 的签发真实性与贡献实例一致性。更新/注销/冲突策略不能越权。
- [x] 每个可执行条目通过 ScopedPluginConsumerProvider 清空 Host/App Context，再以贡献方 consumer 挂载；私有 Context 由贡献方闭包/组件提供。布局不会把 page 的 consumer 覆盖给内容；组合设置/首页也维持每项贡献身份。
- [x] 原 Shell、路由、header、通知、设置容器调用全部改为 page 接入。app 根保留装配与最低限度故障兜底，不导入 Storage/Vault/protocol 领域页面。
- [x] 为初始化、锁定、解锁、protocol popup 的正式内容建立注册方式；page 无 Storage/Vault 等硬依赖，贡献方 → page，无反向服务初始化环。
- [x] 撤销时立即撤下 UI/入口；异步注册晚到清理，旧回调和旧注销不影响新实例。撤下内容后不沿用缓存的旧私有代理。

验收：通过真实消费适配完成页面/设置/header 三类挂载；伪造归属、换 consumer、跨实例更新/注销被拒；page 无法解析 Storage 私有浏览。普通 Button/Modal 和插件内部子组件无需逐项注册。

## 8. KFM-005 · Storage 完整插件迁移

主要落点：packages/platform-storage/src 的 manifest、runtime、kv-engine、storage-access、wallet、coordinator、ui；相关 contracts/storage 和 Coordinator 存储 handler。

- [x] 同一 storage 包分别导出 Web/Worker 实现；Worker 不导入 React/DOM，Web 不执行后台引擎。复用现有实现并按职责搬出宿主。
- [x] 对内公开文件/K-V/快照服务，消费身份与 module/purpose 声明绑定；保留现有路径与事务。删除任意自报 plugin/module 的授权途径。
- [x] 对 Connect 提供 App 会话受限入口，与内部文件服务复用引擎，保留稳定 App 存储身份和 /apps/ 范围；网关身份不代替 App 身份。
- [x] 全局浏览改为 Storage 私有跨单元 API，取消公共 STORAGE_BROWSE_SERVICE_CAPABILITY 的发布/消费入口；私有契约留本包，不向其他插件导出。
- [x] 可信装配登记允许的调用单元，双方发布真实实例快照；私有代理复用框架有效期、连接/实例授权与 RPC/stream。
- [x] 浏览页面、现有设置/状态内容及读写指示灯经 page 注册，共享 Storage 私有 Context，不为各组件增加权限表。补充展示只限既定三类 UI，不新增存储配置功能。
- [x] 锁定、刷新、重建后旧 UI/句柄失效；在途浏览取消、迟到结果隔离。保持只读、分页/预览资源上界和秘密不可展示。
- [ ] 用迁移前数据库样本验证文件/K-V/快照、KeyHold 和恢复文件仍可读；启停设置清理不触碰业务数据。

验收：另一插件可读写自己的授权目录但不能根浏览；page/其他插件/App 均不能调用私有浏览，业务 handler 不执行；App 目录互隔离；同插件三类 UI 能使用私有服务；实际事务和旧数据恢复通过。

## 9. KFM-006 · Vault 完整插件迁移

主要落点：packages/plugin-vault/src、Storage WalletLifecycleService 相关混合流程、Coordinator 密钥与会话 handler。

- [x] Web/Worker 同一 vault 身份；将私钥、密码学与会话权威实现归回 Vault Worker，Web 只有代理和 UI。
- [x] 明确内部操作式服务、现有 Connect 服务、私有管理接口。私有 API 不发布到公共 registry，不导出原始私钥字节。
- [x] 声明精确 Storage 依赖及专用受限用途；保持创建/导入/改密/重置的事务、身份校验与失败恢复。不要简单拆文件破坏原子提交。
- [x] 消除引擎启动与解锁循环：Storage 底层先可用，Vault 依赖密文存储；受锁定条件限制的业务能力按状态发布/撤销。
- [x] 创建/导入、解锁、当前 Key 管理、自动锁定等自己的 UI 经 page 注册；以 Vault consumer 与私有代理运行。
- [x] 原会话投影使用公开且范围明确的读取/订阅能力，单一权威不迁成多个 Tab 的本地状态机。

验收：未初始化、锁定、解锁、改密、导出、自动锁定和重置流程保持；页面/外部消费者无私钥；撤销/Worker 重启旧签名句柄失败、迟到结果不可发布；存储故障不报告钱包操作成功。

## 10. KFM-007 · 给系统工作区明确插件归属

已新增：packages/plugin-workspace（workspace 身份）；主要来源：apps/web/src/system/*、registerAssetWorkspace.ts；涉及资产/藏品/转账等领域 registry。

- [x] 将现有资产、藏品与链设置聚合工作区纳入 workspace 插件，普通 BSV 转账页按用户确认归 P2PKH；保留路由/交互并删除宿主全局 Host 注册流程。
- [x] 按实际使用声明资产、Token、藏品、转账、联系人、WOC 等能力，不通过查询全局注册表得到未声明服务。
- [x] 领域扩展注册/读取服务归 workspace 或已有明确提供方；页面展示只经 page。转账执行继续委托既有领域服务，workspace 不获得密钥/根存储。
- [x] 资源 loader/订阅/缓存归真实 workspace 实例；提供方贡献组件仍用自身 consumer，不能以 workspace 身份执行其私有服务。

验收：apps/web 无残留领域页面或 host.provide 工作区服务；各聚合流程保留；workspace 缺某个必需服务时有正确等待/原因，不借全局查询回退。

## 11. KFM-008 · 全插件逐一清理

每个清单项目关闭前，都必须完成：新单元/依赖定义、三个访问面判断、page 接入、受限存储、无 Host/私有互导、所属资源与任务清理。不存在的 Connect/Worker 面明确“不提供”，无需凑三份实现。

| 迁移组 | 最终插件（迁移实现已接入） | 重点 |
| --- | --- | --- |
| 基础 UI 与管理 | home、settings | 普通插件身份，运行诊断替代启停 |
| Vault 内部导入 UI | WIF、Hex、JSON、Key Import | 四个原插件并入 Vault；解析注册表、导入向导和钱包导入/导出使用内部 API，不再发布导入 capability |
| 链与资产 | woc、p2pkh、token-bsv21、token-stas、collectible-1satordinals、bsv-price | 实际服务依赖、资源读取、网络条件及不可逆操作保护 |
| 网络与后台 | window-p2p、msfile、sat-subscription、background、webrtc | 单执行租约、lane 复用、任务归属、依赖失效和恢复 |
| 业务 UI | contacts、message、apps | 页面/设置/header 统一入口，插件存储与 App 存储分开 |
| 已单列施工 | storage、vault、protocol、新 page、新 workspace | 不能因重复列在目录中而免验收 |

- [x] 全部 manifest 删除等级与启停字段；所有装配插件参与系统。保留插件全部登记，不自动触发交易或付费业务。Poker 按用户最新要求整包移除，不再迁移或装配；既有钱包数据不清除。
- [x] 清除跨插件实现 import 特许路径，公共契约/无服务工具适当抽出；门禁覆盖真实插件清单与所有 realm。
- [x] 非 UI 的领域 registry 也发布 typed capability，并约束真实注册归属；不得当作运行时内置免检服务。
- [x] 搬回所属插件的后台 handler/task/状态；保留 finalIoAudit、lease 与恢复逻辑，宿主不再拥有领域实现。
- [x] 删除启停 UI、旧配置读写与 worker dependsOn 产品开关判定；新的诊断页使用状态/原因和必要恢复，不出现改名的停用开关。

验收：对最终发行版逐行关闭迁移对照；源码门禁故意植入私有互导/全局 Host/未登记 UI 旁路时确实失败。不能只测 Storage/Vault 后批量勾选其他插件。

## 12. KFM-009 · Connect 网关

主要落点：packages/plugin-protocol、packages/contracts/src/protocol.ts、protocol 相关 Coordinator handler、packages/connect、apps/connect-docs。

- [x] protocol 拥有网关方法分派/确认 UI，明确声明消费提供方 Connect 契约；SDK 保留原外部用途。
- [x] 建立提供方明确发布的名单与网关静态映射，不按公共服务目录自动遍历方法。内部/私有服务均不能自动外发。
- [x] 从真实 App 会话派生身份与授权范围，向 Storage 传受限 App 绑定而非任意 App 字符串；保持 origin、Owner、用户确认和会话撤销。
- [x] 确认 UI 经 page 挂载，以 protocol consumer 执行；关闭 popup 不错误销毁其他页面共享的服务。
- [x] 外部 SDK 方法、错误码与文档保持一致；只更新内部架构说明，不偷偷新增 Connect 方法。

验收：外部 App 的 login/resume/logout、存储及既有代表性密码学/转账/Channel/MSFile 流程通过；内部-only 方法拒绝、私有 handler 不执行；伪造 App/越目录/撤销后调用拒绝。

## 13. KFM-010 · Worker 槽位与装配收口

主要落点：apps/web/src/keymasterSessionCoordinator.worker.ts、Client、coordinator/*、Worker 构建入口、bootstrap、部署与恢复测试。

- [x] 默认共享 Coordinator 只装配各插件 Worker 单元与权威运行条件。统一消费完整插件定义，不再维护宿主业务 handler 巨表。
- [x] 产品适配使用多槽位 bridge 与精确绑定；解析和就绪采用同一来源。错误槽位和同名本地服务不能满足远端声明。
- [x] 两端发布单元实例快照，私有消费授权有效期与页面连接对应；断线/替换清理旧授权和在途 RPC/stream。
- [x] 生产构建的接入 fixture 使用同一产品槽位适配连接两个真实 SharedWorker，验证挂接顺序无关、同时可用、单槽断开/恢复、旧卸载不误伤及来源冲突。此 fixture 证明接入，不宣称钱包已完成物理分离部署。
- [x] 两真实页面连接默认钱包 Worker：关闭/刷新一页后另一页服务继续可用；该页 UI/授权被撤下，重建重新取句柄。
- [ ] 检查 authority lock、sessionEpoch/runGeneration/walletGeneration（会话/运行/钱包世代）、最终 I/O、预算及执行名额未丢失。新旧构建交接不得出现第二个钱包写入/签名权威。

验收：真实浏览器有共享两页与多槽位两个 Worker 两类证据；断线期间必需依赖 blocked，恢复自动收敛，无显式手工 reconcile 测试作弊；无关服务持续工作，旧连接/句柄不能调用新实例。

## 14. KFM-011 · 最终验收、删除旧路径、同步稳定文档

- [ ] 在 coverage YAML 中将下面矩阵登记到具体用例、环境、构建与证据；每个施工项只有达到自己的判据才能关闭。
- [x] 更新 types/contracts、存储、Worker、React、插件 import 与 release 边界门禁；删除只验证旧启停/等级的断言，补实际新边界，不能简单放宽规则。
- [ ] 运行本项目 test:types、test、lint:boundaries、lint:react-boundaries、lint:webloom-release、verify:webloom-registry、build，以及对应生产恢复/最终 I/O 门禁。脚本若依赖旧语义，先更新其检查目标再运行。
- [ ] 运行本地核心、初始化、多 Tab/刷新、资源生命周期、外部 Connect、不可逆 I/O 与恢复的真实浏览器验收。需要真实网络/资金的证据按既有资源配置与授权执行；未具备条件不得由单元测试替代。
- [x] 检查构建产物：Worker 不引 React/DOM，Web 不包含 Worker 密钥/存储引擎实现，公开契约入口不导出私有实现或授权配置；运行时与锁文件为同一正式 0.6.0。
- [x] 更新 docs/架构.md、插件生命周期.md、存储.md、Connect.md、README 与必要 SDK 内部说明，移除旧等级/启停目标，字段补中文解释；数据与协议稳定行为不得改写。
- [x] 删除全局业务 Host hooks、旧 UI 注册入口、字符串/自动注入服务旁路、用户启停存储/同步、旧状态与固定不可停用清单。必要宿主诊断例外有明确调用位置，不能出现在插件组件。
- [x] 交付最终插件/能力/单元/槽位清单与未验收事项。版本升级或框架门禁全绿不能替代 Keymaster 迁移关闭。

### 验收矩阵

| 需求/场景 | 必须观察到的结果 | 必需证据层 |
| --- | --- | --- |
| R01 扁平及全登记 | 无等级、用户启停和旧意图；全清单有迁移归属 | 源码/产物门禁、产品状态 |
| R02 未声明与传递依赖 | setup/UI/资源/Worker 均拒绝，handler 未执行；optional 不免检 | 类型负面、适配集成、真实页面 |
| R03 私有边界 | 另一插件/page/App 解析和直接调用拒绝；空快照/撤销不放行 | transport/产品集成、浏览器 |
| R04 page 三类贡献 | 贡献方 consumer、私有 Context；越权更新/注销及晚到注册拒绝 | React/注册适配、真实浏览器 |
| R05 Storage | 插件/App 目录隔离、根浏览仅私有、路径穿越拒绝、数据仍可读 | 数据/事务、真实 UI、外部 App |
| R06 Vault | 全钱包管理路径保持、无明文私钥外泄、操作故障不报成功 | 密钥/事务集成、浏览器 |
| R07 生命周期 | 打乱清单仍依赖顺序启动；反向清理；共享提供者不误销毁 | 生命周期集成、运行 trace |
| R07 旧句柄/在途请求流 | 撤销后调用/订阅拒绝，无迟到结果；清理完成前不回收执行占用 | RPC/stream 联测、浏览器 |
| R08 多槽位 | 两真实 Worker 并存；错槽不能替代；单槽失效不影响其他槽 | 产品适配、构建产物浏览器 |
| R08 多页面/构建交接 | 一页退出不毁共享提供者，新旧权威不并存 | 两页真实浏览器、恢复/部署证据 |
| R09 全插件/工作区 | 全部实际调用有声明，聚合页面有 owner，不留宿主领域特判 | 清单逐项、代表性业务 E2E |
| R10 Connect | 显式名单、App/Owner/origin 绑定、既有 SDK 流程一致 | 网关负面、真实外部 App |

本矩阵是计划，不是通过记录。每项证据注明代码/构建版本与实际覆盖层次；Firefox/WebKit 等未运行环境如实标注，不用 Chromium 结果代替。发布、部署及 Keymaster 版本号决策不由此文档提前执行。

### 2026-10-03 实施记录补充

Storage 私有浏览已完成真实跨端接入与归属收口。浏览 DTO、request/response parser、授权与执行 coordinator 留在 Storage，公共 contracts 不导出它们；可信装配登记的私有调用限定 storage.window → default → storage.coordinator-worker。公开 RPC 直调与其他插件解析在 handler 执行前拒绝。Storage 页面保持只读、分页与预览上界，并在锁定和重建时丢弃旧会话。

生产适配的多槽位门禁使用两个实际 SharedWorker、两个实际页面，并验证反向挂接、同名本地冲突、替换世代围栏、旧卸载、单槽断开及恢复。它不替代全部钱包领域迁移或物理分离部署验收。旧意图清理只删除原专用对象，真实 IndexedDB 保留其他业务与恢复数据；全量旧数据库样本仍待核对。

Worker 目录删除 background/自身产品等开关依赖，只登记实际服务单元；可用性契约删除 plugin-disabled/dependency-disabled，任务调度共用依赖与作用域判定。UI page/workspace、Vault Worker、Connect 和全局 Host/自动注入清理仍未达到关闭条件，相关施工项保持未勾选。

### 2026-10-03 page 注册接入进展

新增真实 `page` 产品和 `page.window` 单元，纳入发行版清单与 Window setup 装配。公开 typed 契约分开注册服务和渲染出口，不提供可执行条目列表；注册表与组合渲染在 page 包内。菜单、旧壳、其他 UI 注册表及普通/协议页面仍未全量搬迁，因此 KFM-004 不整体关闭。

贡献方经声明的 page 服务提交自己的真实 consumer 和 Scope。适配器只记入框架 setup 签发的 consumer/Scope 引用；page 拒绝克隆 consumer、伪造 Scope 和换用其他实例。`createScopedRegistryView` 写入实际归属并负责撤销、条件清理与 staged commit（延迟提交）；原始注册函数留在 page 闭包，贡献方没有自报 owner 的入口。

Storage 浏览页、同路径的只读状态块与原 IndexedDB 持久存储授权条通过同一注册服务挂载，全部在 Storage consumer 与包内私有 Context 中执行。原授权条实现已搬回 Storage，正常与 onboarding 壳都改用 page 的 header 出口。这里的 header 是既有持久存储授权条，不能代替施工单仍待迁移的读写指示灯。

`pageContributions.test.tsx` 使用生产 Keymaster 适配器验证三类 UI 的贡献实例、无原始列表、伪造/换 consumer、跨实例注销、冲突、旧清理、撤销后晚到 staged commit，以及 page 撤销后缓存渲染节点立刻消失。正式源码门禁新增 consumer 签发入口与 page 私有实现边界；10 个故意越界导入均被拒绝。全量 242 个测试文件（2164 项）、类型与生产构建通过；真实浏览器证据追加到覆盖矩阵。


### 2026-10-03 行情页面与实例资源读取进展

`bsv-price` 的业务页和设置页已从旧 route registry 迁入 page，菜单仍保留路径与 routeId 元数据。两页以及首页行情卡片使用真实贡献实例的 consumer，移除价格 UI 的全局 Host、全局语言和全局 capability 读取；首页卡片的缓存组件在实例撤销后也立即退出。首页卡片注册仍经过旧 home registry，不计为 home 聚合迁移完成。

新增 typed `resource.owned-access`：使用框架签发的真实 consumer 与精确 Scope 绑定资源视图，只允许 ensure/read/subscribe/invalidate 本实例注册的资源；不暴露 disposeOwner 或其他 Store 管理入口。价格包内私有 Context 捕获这份视图，UI 不持有全局 Store。视图操作逐次复核实例/Scope/资源归属，Scope 撤销退订，旧句柄无法读取其他实例或重新绑定。跨插件资源聚合仍需 workspace 的正式消费契约，不能用此视图放宽为任意资源读取。

生产适配资源测试验证伪造 consumer、错 Scope、未声明能力的真实 consumer、跨实例读写/订阅与撤销后句柄拒绝；真实价格 setup 的 React 集成验证两页与卡片、设置更新后资源刷新、缓存节点撤销。全量 244 个文件/2168 项测试、类型、源码边界门禁与生产构建通过。新真实 Chromium Gate `G-PAGE-PRICE-CONTRIBUTIONS` 使用生产 preview、真实 SharedWorker 与 IndexedDB，验证首页卡片、两个页面的冷启动解锁、锁定移除和再次解锁恢复；`local-integration-murrdgzl-05c5de902383` 通过且 pageErrors 为空。声明校验的后续收口在 page 注册与资源绑定两个入口均拒绝未声明能力的真实 consumer，最新 9 项生产适配/React 回归通过。旧壳、其他插件页面、workspace、Vault/Connect 与 Host 自动领域注入仍需继续迁移，整体施工单保持实施中。


### 2026-10-03 插件诊断页接入进展

`/settings/plugins` 已由 Settings setup 注册为 page 贡献，使用真实 Settings consumer 和包内诊断 Context。插件管理页与依赖面板不再调用全局 Host 诊断 hook，改用声明的 `runtime.diagnostics`；接口绑定真实 consumer/Scope，并复核能力声明，返回状态、依赖图和经过筛选的元数据，包含实例重试操作，不返回 manifest 的 setup、组件或服务。撤销后旧视图拒绝读取、订阅与重试，订阅随 Scope 退出。Settings 业务域导航通过所属实例的 scoped business registry 登记，避免旧静态业务贡献适配器替诊断页注册全局执行组件。

`settingsPageContributions.test.tsx` 使用真实 Host、Settings 与 page setup，验证未声明能力的真实 consumer 拒绝、诊断数据不含 setup、失败实例从页面重试恢复，以及缓存页面与旧诊断视图随 Settings 撤销。广播网关聚合页仍经旧 route/system-status registry 渲染，语言设置等其他 Settings UI 和菜单注册服务也仍待收口；不能据此关闭整个 Settings/page 迁移项。

最新全量 245 个测试文件/2169 项通过，包含独立 Worker 重型批次；类型、源码边界门禁、正式发行版生产构建及产物扫描通过。真实 Chromium `G-PAGE-PRICE-CONTRIBUTIONS` 已扩展覆盖诊断页，`local-integration-murrsk6h-7d1e8531193f` 通过且页面异常为空；此前修正绑定声明校验后的价格页和 Storage 浏览页共 6 项生产 Chromium 检查也通过。整体仍为实施中，保留未完成的全插件 UI、workspace、Vault/Connect 和旧 Host 注入清理项。


### 2026-10-03 聚合页面及设置区块继续迁移

广播网关页改为 Settings 的 Page 贡献，Sat 和 WebRTC 自己注册设置块，分别绑定真实 consumer 和私有资源 Context。删除旧 system-status/system-settings 注册表以及未注册的旧系统设置页；Page 的 embedded 设置布局防止区块重复挂载。Settings 已迁移源码使用实例语言能力，菜单和旧壳仍需后续收口。

Apps 列表迁入 Page，首页应用卡片和授权弹窗使用 Apps consumer，补齐 Keyspace 声明。Home 首页也迁入 Page：身份、业务投影、卡片和动作经所属资源读取，P2PKH 测试网开关通过可选只读设置能力消费。余额、扑克、联系人及文件卡片分别绑定贡献方 consumer 与包内资源视图。MSFile 文件、存储桶及本地文件设置三个正式页面改为 Page 贡献；媒体组件和设置页不再从全局 Host 读取资源。Home/Business 原注册表仍保留，不将此阶段记为所有 UI 已归 Page。

新增真实 workspace 产品和 owner-session 单元，纳入发行目录及实现装配。资产/藏品列表与详情入口、首页资产卡片、聚合 loader 及身份/详情/测试网资源归本实例。宿主中的资产及藏品页面和对应直接注册函数删除；资产页与首页卡片共用聚合资源。藏品快照只包含 provider 的 id/name，不携带可执行服务句柄。

BSV 链设置页面也迁入 Workspace，经声明的 Page renderer 组合 P2PKH/WOC 自己的设置块，Workspace 不导入它们的内部组件或持有它们的设置服务。两个插件移除公开 settings-page 子路径；P2PKH 设置使用本实例资源视图，WOC 配置和队列事件由实例所属资源订阅，UI 保持原有确认持久化后应用配置的顺序。Page 支持动态路径参数、静态路径优先、非法参数/等价路由拒绝；带查询或 hash 的页面与设置区块按 pathname 匹配，贡献接收完整原始路径。

真实 Home 可选依赖撤销回归发现全局资源在框架 context 刷新后丢失记录订阅，已在受限资源视图中重绑 global 记录订阅并随 Scope 退出；active-key 记录仍使用框架自身的重绑逻辑。已迁移生产 UI 的 AST 门禁禁止全局 Host、语言、能力及价格 hook 的别名/namespace/动态导入，正式负面探针全部 14 项被拒绝。

本阶段仍不关闭整体施工单：转账与藏品转移聚合页、其余业务页面和旧壳/菜单、Vault Worker 私有密钥归属、Connect 显式提供方名单及 App 绑定、自动 Storage/Coordinator 领域注入清理、旧数据库全量基线和完整发行版验收均待继续实施。Storage 浏览接口保持包内私有，未因聚合页面迁移扩大公共 API。


BSV 链真实 Chromium 检查进一步暴露身份切换顺序问题：逐个撤销并立即重启会让新会话消费者读取尚未撤销的旧会话提供方，也可能在 WOC 异步重建时使 P2PKH 读取不到服务。现改为对受身份约束的全部旧实例同步发起 revoke，等待清理完成后再恢复实例。新增真实生产适配回归在修复前复现跨会话读取、修复后通过；相关 Host 生命周期、启动装配及迁移回归共 65 项通过。此修复在 Keymaster 适配器内完成，未改框架发行版。


并发显式 retry 还可能发生在提供方 starting、local 服务尚未发布时。新增受控异步发布回归在修复前得到 failed、修复后保持 blocked 并在发布后恢复 enabled。适配器为本地必需依赖补充实际发布检查，仅在提供方仍 starting 时补充等待条件，使用原有 missing:local 原因；不增加产品开关或 WOC 特判。相关回归现共 66 项通过。


最终生产适配/React 回归覆盖 Workspace 资产与藏品页面、资源共享与事件刷新、撤销后旧句柄拒绝，以及 BSV 链容器响应独立区块的加入/撤销。全量 245 个测试文件/2175 项通过（含独立 Worker 重型批次），类型、E2E 类型、正式 0.6 发行版边界、源码门禁及 14 个真实负面导入探针、生产构建和产物扫描通过。真实 Chromium `local-integration-murv8qjf-af7c4df99b65` 共 6 项通过：扩展后的页面贡献 Gate 与全部 5 项 Storage 浏览用例；页面异常为空。覆盖矩阵保持部分覆盖，不以这些结果代替尚未完成的迁移和发行验收。

广播网关最终 Chromium 回归 `local-integration-murvatwc-58526e9e2ebd` 通过：缺省 SatSubscription、刷新回到锁定、多标签共享解锁，以及 Sat/WebRTC 设置区块各挂载一次；该用例允许外部网关不可达状态，但拒绝其他页面与 Worker 异常。


### 2026-10-03 普通转账归 P2PKH，删除宿主工作区装配

按用户确认，普通 BSV 的 `/transfer` 由 P2PKH 插件承接，不归 Workspace。页面迁入 P2PKH 包并通过 Page 注册；收款地址/公钥一致性、主网/testnet 约束、联系人搜索、费用输入和原有预览/确认交互保持。页面直接组合包内 Transfer Widget；Widget 使用自身 consumer 与私有资源 Context，领域 TransferProvider 对外贡献也绑定该实例。Offer 只读取本插件 provider，余额通知、active key、设置和联系人投影均归 P2PKH 资源，不再按字符串读取 Contacts 的资源。Contacts 通过声明的可选服务消费，选择器由 Contacts consumer 与本包资源视图提供。

藏品转移仍是独立 handler 组合，页面迁入 Workspace，通过自己的 active-key 详情资源加载并订阅藏品变化，只返回 provider 元数据与 detail。1Sat 转移 Widget 绑定 1Sat consumer；Workspace 不持有其私有服务。真实生产适配/React 回归验证详情被移除时的最终不可用状态、加载失败、处理器撤销、Workspace 撤销，以及迟到详情响应不恢复缓存页面。

删除 `apps/web/src/system/registerAssetWorkspace.ts` 和全部宿主领域页面，以及无人消费的 `feature.transfer` 模拟注册服务。bootstrap 不再注册或按全局差集清理领域资源/页面/导航，只投影真实 Workspace 的就绪状态；插件 Scope 负责各自回收。P2PKH 转账语言键收口到自己的命名空间，避免原宿主 namespace 消失后使用默认中文文案。

真实浏览器检查进一步发现壳层只给 Page 传 pathname，丢失查询/hash；修复为传完整位置，旧路由仍按 pathname 匹配。新增生产壳回归先复现丢参数，再验证动态参数、完整查询/hash和同路径查询更新，同时维持真实贡献方 consumer。此改动使转账收款入口、资产详情和藏品转移不再依赖组件读取全局 window 查询参数。

本阶段不代表 KFM-004/KFM-008 全部完成：其余业务页面、旧壳/菜单和领域注册表归属、Vault Worker 私有密钥归属、Connect 名单与 App 绑定、自动 Storage/Coordinator 注入，以及全数据库/发行版验收仍待后续实施。`/settings/storage` 保持 Storage 内部 UI，公共服务面未扩大。


最终验证：全量 245 个测试文件/2178 项通过，含独立 Worker 重型批次；类型、E2E 类型、80 项契约结构/60 项契约测试、14 项真实负面导入探针、Worker 边界、正式 0.6 发行边界、生产构建和产物扫描通过。真实 Chromium `local-integration-muryybaa-1bf3af247758` 的扩展页面 Gate 通过：P2PKH 转账页的英文标题、Contacts 自有选择器、地址查询入口及真实 P2PKH Widget 只读地址、藏品转移不可用状态，以及其余正式页面与锁定恢复；pageErrors 为空。此前 `local-integration-murygnkn-cf24774a08d4` 的全部 5 项 Storage 浏览和缺省广播网关/刷新/多标签回归通过。只验证转账 UI 和授权/生命周期边界，未执行真实签名或广播，不代替最终交易 I/O 验收。KFM-007 的宿主工作区直接注册移除项关闭，其余领域注册表归属及整体施工项继续保持实施中。


### 2026-10-03 Contacts 页面与对外编辑器的实例归属

Contacts 的 `/contacts` 和 `/contacts/:id` 改为 Page 贡献，删除其旧路由注册；动态详情使用 Page 传入的参数，不读取全局 location。列表、详情、公钥动作和编辑器改用 Contacts consumer 的语言/服务与本实例资源视图，不再读取完整 Host 或全局注册表。公钥动作通过 Contacts 自有资源订阅已声明的领域注册能力，新增/撤销动作会重新投影；领域注册表本身仍由 Runtime 装配，未达到 KFM-008 的归属收口条件。

对外 `contacts.editor` 与既有选择器一样绑定 Contacts 的真实 consumer 和包内资源 Context。其他插件只声明 UI 能力即可使用编辑器，不需要联系人内部服务，也不会以调用方 consumer 执行联系人 CRUD。公共包入口删除未绑定的编辑器组件导出，保留 props 类型与 UI capability。编辑器实例撤销或表单关闭/替换后，迟到的保存结果不再调用旧 onSaved。

验证使用真实 Keymaster 适配和正式 Page/Contacts setup，未提供全局 App Provider：页面可新建、删除并实时更新详情及动作，撤销 Contacts 同步移除缓存节点；另一个只声明 editor 的实例无法解析 contacts.service，但可以通过 Contacts 自有编辑器保存。编辑器回归模拟撤销后的迟到保存，旧回调不执行。其余 Contacts 后台/存储绑定、公钥动作注册表的领域归属、全量 UI/Host 与 Vault/Connect 仍待迁移。


本轮真实浏览器先发现详情刷新失败但面包屑能读到联系人。错误状态定位到延迟 owner 文件绑定的并发首次打开：多个 loader 各自拿到句柄后互相替换，导致正常读取被世代围栏拒绝。适配器现在让并发首次读取共用一次打开，撤销或钱包世代变化后的迟到句柄关闭，失败的打开可重试；旧操作失败也不能注销已经替换的新句柄。K-V 的相同路径一并修复。新增真实适配回归先复现文件/K-V 重复打开及迟到文件泄漏，再验证 8 项并发/撤销/世代/重试场景通过。未放宽最终 I/O 世代围栏或改变存储格式。

浏览器还发现消息资源 loader 使用 contacts.service 却未声明该可选依赖；补充 Message 的联系人服务及编辑器 UI 依赖，保持其可选关系，消息 UI 的 Page/消费视图迁移仍待实施。联系人详情把加载中、失败与最终未找到分开，失败显示用户可理解的提示。新增详情 pending/error 回归通过，不将加载失败伪报为联系人已删除。


公钥动作资源重新加载前，旧快照可能仍持有被撤销/替换的回调。Contacts 在执行时使用已声明注册能力核对当前条目，旧回调不能执行；真实集成同时验证有效动作仍可运行和撤销后旧快照不能运行。

本阶段最终验证：`pnpm test` 全量 247 个文件 / 2190 项通过；类型、E2E 类型、React/源码边界、14 项真实负面探针、Worker 边界、最终 I/O 审计、正式框架 release 与 registry 消费门禁及生产构建/产物扫描通过。Chromium `local-integration-murzx5he-e6b56d0360aa` 的扩展 Page Gate 与联系人到消息会话 Journey 均通过，联系人新建、编辑、刷新后的动态详情和锁定恢复使用真实 SharedWorker/IndexedDB，两项页面异常均为空。未执行真实消息发送、签名或广播。施工项按各自判据继续保持未关闭，不将本阶段作为全项目迁移验收。


### 2026-10-03 Message 页面与跨插件只读投影迁移

`/messages`、`/message/:publicKeyHex` 和兼容路径 `/messages/:publicKeyHex` 改为正式 Page 贡献；删除 Message 的旧 route 注册和包入口的未绑定页面组件导出。页面由真实 Message consumer 与私有资源 Context 挂载，动态参数来自 Page，资源 loader、订阅、缓存及 mutation 失效全部归本实例，不再读取完整 Host 或 Contacts/WebRTC 的资源定义。保留联系人编辑器 capability，并使用 Contacts 自有编辑器消费身份。移除无实现 import 的 plugin-webrtc 包依赖，同步 lockfile。

在线状态仍以既有 Coordinator Worker 的快照为真值。Contacts 发布仅含 snapshot/subscribe 的 `contacts.presence-reader` 只读能力，按已保存联系人过滤结果并复用既有四类失效通知；Message 不获探测、Pong 写入或 Coordinator 控制。旧 reader 在撤销后拒绝读取/订阅，已有订阅随 Contacts scope 撤销清理。该能力是内部插件间的只读公共契约，不新增 Connect 方法。Contacts/Coordinator 的其他职责与自动注入仍待迁移。

Message 将在线状态、WebRTC 会话和历史投影为自己的资源，显式声明可选依赖。提供方晚到、撤销或替换时，资源订阅比较当前解析到的服务并重新绑定，清理旧回调；在线证据加载中/失败时按离线处理。WebRTC 缺席时不沿用旧会话/历史句柄。修复原详情选择器只比较消息数量及公钥，导致联系人同公钥改名不能更新标题的问题。

发送结果跨越会话切换或撤销后不再清空新会话草稿/失效其资源；WebRTC 动作也核对当前提供方，旧完成不影响替换后的状态。可选 WebRTC 出现不会清空正在编辑的文本草稿。维持既有文本发送、附件、在线门禁及通话布局，不扩展业务功能。

本阶段真实适配测试通过正式 Page/Message setup 挂载，无全局 App Provider，并植入跨插件资源 loader 陷阱：所有三个路径正常渲染，Message reader 拒绝读取其他插件资源，陷阱从未执行；可选提供方晚到/在线变化/历史变化/撤销/恢复、迟到历史丢弃、切换 peer 后迟到发送、实际 Contacts 同公钥改名回填均通过。Contacts 的正式 setup 另验证只读 Worker 投影、过滤非联系人、拒绝传递授权及撤销后旧 reader/订阅清理。其余全量 UI、领域注册表归属、Vault/Connect 与 Host 注入仍未达到关闭条件。

本阶段最终验证：全量 248 个测试文件 / 2196 项通过；类型、E2E 类型、契约结构及 60 项契约测试、React/源码边界、14 项真实负面导入探针、Worker 边界、最终 I/O 审计、正式 0.6 发行与 registry 消费门禁、生产构建及产物扫描通过。真实 Chromium `local-integration-mus4hlaa-08aaee3252b0` 的扩展生产页面 Gate 与联系人到消息会话 Journey 两项通过：三个消息路径、保存联系人标题、离线通话门禁、锁定移除及解锁恢复均验证，页面异常为空。未执行真实消息发送、签名或广播；不替代最终消息 I/O 验收，不关闭其余全项目施工项。


### 2026-10-03 Worker 实际依赖、领域服务与任务归属

Storage Worker 提供 Scope/consumer/purpose 受限文件和 K-V 客户端；Vault Worker 提供公开身份、锁定状态与操作 RPC；WoC Worker 发布查询能力并拥有服务实例和链高度任务。P2PKH 及 BSV21/STAS/1SatOrdinals 的实际 setup 消费声明的身份、Storage 和 WoC 能力，任务注册/定时器随 Scope 撤销并等待旧物理执行结束后替换。Worker 目录的具体能力依赖由真实 manifest 推导，生产就绪读取和订阅框架实例，手工就绪表仅供领域测试夹具。

Contacts 的 Worker 服务、订阅和探测任务由本单元装配。SatSubscription 提供只允许 Ping/Pong 和当前 owner inbox 的在线探测 Channel；Contacts 显式消费它，不能选 system caller 或发布应用协议。Sat 的仓储/Provider/SPI 候选与 MSFile 的仓储/服务候选在各自包内构造，失败或过期候选清理后不发布；实际 Worker 单元使用受限 Storage 客户端并发布本单元服务。MSFile 的既有平台 app-settings purpose 已显式列入声明，物理数据路径不变。

Storage 的模块文件句柄、数据队列、RPC handler、App/owner/platform 授权复核与 K-V 维护已归内部 Worker 入口。App 授权在异步权威会话查询后再次核对原 grant 对象；维护任务在 root 更换后停止继续打开旧命名空间。Vault 的身份投影、活动密钥操作视图和密码学 RPC handler 也归本包，Root 保留认证、代际及最终 I/O 租约。

回归发现锁定时 React 仍可能补做撤销视图的订阅。受限资源视图增加撤销后可读的 isActive 状态；UI 收尾返回稳定 blocked 快照，ensure/read/subscribe/invalidate 业务调用仍严格拒绝旧 consumer。链高度读取在提交前核对会话，过期结果和非法高度均不发布。

验证：Worker/目录/在线探测能力 141 项测试通过；核心 Chromium 7 条流程通过，包括初始化、联系人入口、设置、多 tab 恢复、P2PKH 与反复锁定/解锁。源码边界、React 资源边界、97 个 typed 契约、220 个 Worker 模块边界、最终 I/O 审计、正式 registry 0.6.0 及覆盖矩阵检查通过。全量回归和剩余领域迁移继续进行；上述证据不替代外部、资金及生产交接验收。

### 2026-10-03 Worker 领域执行与状态归属收口

Storage 控制器及 Window 门面移除钱包生命周期转发；创建、解锁、改密、改名、导出与重置由 Vault lifecycle/控制分派执行。Vault 的本地秘密操作也归包，异步派生及加解密后复核原会话；失败时擦除调用方明文字节，旧解密结果不进入新会话。

Channel 策略、物理订阅 Mux、关系和重放状态、出站协议序列化、发布结果核对、入站路由及操作分派归 SatSubscription。BitFS 的专款账本、拆分和 exact outbox 对账、买方恢复/需求/购买、卖方索引/会话、WebRTC 信令及 MSFile 控制分派归 MSFile。Coordinator 保留真实 peer/session 授权、最终 I/O 租约和主题 transport；签名和不可逆发布仍位于同一最终租约内。

P2PKH 拥有普通广播的 canonical 交易校验、写前审计、快照消费/回滚和隔离结果，以及设置持久化、候选费率/Provider 更新和懒加载 Worker 转账实例。设置、资金保护与快照在同一 Key 重新解锁后也按 epoch 拒绝迟到结果。Worker 转账通过 P2PKH 的真实单元消费 Storage、Keyspace 和 Vault Worker crypto；Sat 只声明可选的 p2pkh.worker-transfer，不因尚未充值而创建交易服务，不新增 Connect 方法。

WoC 的 Worker 查询视图按契约列出方法，不含 broadcast、ready 或 dispose；另发布 woc.worker-broadcast，P2PKH 显式消费，MSFile 的 BitFS 链操作显式声明可选查询及广播依赖。撤销期间的迟到节点结果拒绝返回；Scope 清理只释放对应实例，旧清理不清掉替换后的 Provider 或快照。

已取得的验证证据：257 个测试文件的全量分批回归通过（随后新增能力接线仍需复核）；Channel/Worker/资金/设置 203 项专项回归通过；Storage 私有浏览和核心 Chromium 合计 13 条流程通过。WoC 能力接线后的 7 条核心流程通过，查询视图的反射隔离及迟到结果回归通过。一轮 Worker 回归中的链高度用例超时，其独立用例与整组 119 项复跑通过；不将该超时报告为通过。新增 Worker 转账能力的类型、专项及发行回归继续执行。上述本地证据不替代外部 App、真实资金或生产交接验收。

### 2026-10-04 Worker 归属、冷启动端口与外部 Demo 联调

- Background 的定时器、空闲同步、任务执行、取消及设置归 `workerRuntime`；Root 保留框架就绪、权威状态和最终 I/O lease 的装配回调。
- Vault 的自动锁定及解锁分派归包内实现；自动锁回调同时检查 session epoch 与 Worker 世代。Contacts 的 presence 发布和 RPC 投影在 await 后检查原服务、Owner、epoch；P2PKH 快照执行捕获本轮仓储与文件句柄。Sat 连接拥有自己的状态及多个订阅者，解绑一个订阅者不会覆盖其它订阅者。
- WOC 查询订阅按提供实例 Scope 过滤迟到事件，并在 revoke 时解除真实订阅。Worker 的 `dependsOn` 只从实际 manifest 的必需依赖物化，不再手抄另一张依赖表。
- Storage 冷启动与 Vault 生命周期使用私有 bootstrap 端口：Key 仓储只有固定 `key.json` 的 get/put；生命周期只有 readMeta、原子 batch 和 reset。初始化 batch 仅允许 KeyHold、meta、初始化记录三个固定对象，越界在物理 I/O 前拒绝。完整 WalletStore 不发布为能力，也不交给 Vault；冷启动先于解锁相关 scope，因此不能让 Vault 等待该 scope 形成自循环。
- 新增 [能力调用盘点](./能力调用盘点.md)，从真实生产源码 AST 记录 233 个已声明解析位置和 2 个泛型包装器位置，结合真实单元与能力声明核对；这不是对 Root 私有权威回调的伪造公共授权。
- 本轮改动前完整回归：262 个测试文件通过，真实 Chromium 本地集成 20 项通过，两个 Worker/两个页面槽位生产 fixture 通过。新增冷启动端口及跨站发现的问题另行回归，不以旧结果冒充新结果。
- 用户指定外部项目 `/home/david/Workspaces/KeymasterConnectDemo` 和 `https://demo.apps.bsv8.com/`。当前使用 Demo 与真实钱包的两个本地生产 origin 联调；Demo 同步为 23 个 SDK 公开方法和两个事件，删除旧 multipart 方法，MSFile 使用 sources/sourceId。尚未 git push 或触发线上自动部署。
- 真实跨站已发现并修复：测试 App 签名默认 prehash 导致身份校验失败；Demo 验签漏算 CBOR 摘要；Storage 摘要错误依赖解锁后失效的冷启动缓存；Coordinator 文件列举需接受表示 App 根的空前缀及结果的空父前缀。完整本地外部流程已通过（见下）。

### 2026-10-04 本次交付范围与最终证据

| 验证 | 结果 |
| --- | --- |
| Keymaster 类型、E2E 类型 | 通过 |
| 完整单元回归 | 263 个测试文件通过，含 121 项 Coordinator Worker 回归 |
| Keymaster 真实 Chromium 本地集成 | 20 项通过；执行档 `local-integration-musmezh7-3f4c3ae16fd3` |
| Demo 类型、E2E 类型与单元回归 | 通过；9 个文件、123 项测试 |
| Demo 生产 popup fixture | 通过，覆盖 Connect/Channel/Price/Storage/MSFile |
| Demo 与真实钱包跨 origin | 通过；包含身份/内容验签、文件内容核验、完整注销，无资金钱包 |
| 正式发行目录、契约和边界 | 25 产品、36 单元、100 契约；源码与 Worker 反向探针通过 |
| 数据保护 | 真实 IndexedDB 的旧启停对象定向删除测试通过；KeyHold/业务/恢复字节不变，未清除 Poker 业务数据 |

Storage 摘要失去 walletGeneration、空 App 根前缀及空父前缀被 RPC 校验拒绝、会话撤销递归这三个真实联调问题均已修复并增加回归。Demo 的测试身份签名和 CBOR 验签同步为协议的一次 SHA-256，测试不再沿用先前结果断言下一次请求成功。

本次未运行线上部署、生产交接或真实资金广播；用户已排除线上验收。历史完整数据库实物样本和付费协议的独立资源验收没有冒充完成；这些证据不改变已完成的本次代码迁移和本地测试结果。未提交、推送或触发自动部署。

## Vault 导入插件收口（2026-10-04）

按用户最新边界要求，Hex Importer、WIF Importer、JSON Importer、Key Import 四个插件整包并入 `plugin-vault/src/import`。发行目录、依赖、项目引用和锁文件已移除原独立插件；当前为 21 产品、32 运行单元、97 契约。导入注册表、向导、解析类型及翻译均属于 Vault 内部，不发布导入 registry/wizard/platform capability。

Vault 内部服务保留初始化、改名、改密、KeyHold 导出和重置；内部 UI 从所属实例的私有 React Context 获取它。公共 vault.service 发布无原型、冻结的白名单对象，不泄露内部 service、Coordinator 或管理方法；公共 ActiveKeyCrypto 的备份导出也已删除。原公共 vault.coordinator-control 已移除，可信 Coordinator 连接继续只允许 Vault 的真实 consumer/Scope 绑定。

验证：根类型与 E2E 类型通过；完整 263 个测试文件通过（含 121 项 Worker 回归）；最终 Vault 定向 20 文件、165 项通过；20 项 Chromium 本地集成通过；追加真实导入→菜单打开钱包设置→下载 KeyHold 检查通过，加密导出与本地 key.json 字节一致且不含明文私钥；Demo 与真实本地钱包 Connect 联调再次通过。契约、目录、React/插件/Worker 边界及反向探针、生产产物检查通过。用户范围内不运行线上验收，未提交或推送。

## 插件设置依赖图（2026-10-04）

插件设置页已移除普通 enabled/disabled 状态列表，改为 21 节点的可搜索、可缩放依赖图。Page 与 Vault 依赖连线按用户要求分别增加显示开关，默认隐藏；此开关只控制图的显示，不写插件启停配置。节点的函数详情使用源码生成的 588 个跨插件服务方法调用点，展示调用函数、目标方法、提供插件/单元和源码位置；可搜索、反向查看与跳转提供方。Window/Worker 来源分别匹配，循环依赖按强连通分量处理，不遗漏节点。未静态解析的调用明确保持未知。

验证：根及 E2E 类型检查通过；Settings 与目录/装配定向回归 4 文件、36 项通过；真实 Chromium 的 J-LOCAL-SETTINGS 验证完整节点、Page/Vault 连线独立开关、键盘操作、方法搜索与反向详情、关闭弹框和窄屏布局通过（local-integration-mut8rrr9-a9aa668f75af）；源码数据一致性、插件/React 边界与生产构建通过。


### 2026-10-04：Page 收拢首页与通用设置，修复函数详情滚动

Settings 仅承载页面装配，无独立领域服务；Home 的页面容器也属于 Page。删除 `plugin-settings`、`plugin-home` 两个包和发行版入口，现有 `/`、`/settings/plugins`、`/settings/system-status` 路径及导航保持可用。Page 内部持有诊断视图、插件依赖图和广播网关容器；各业务设置块继续由贡献方渲染。首页身份、二维码、扫码及联系人操作由 Workspace 使用自己的 consumer 和私有资源视图贡献，Page 不增加 Keyspace/Contacts/P2PKH 业务依赖。首页注册变化通过 Page 自己的资源订阅，撤销后缓存容器退出。

当前目录为 19 个产品、30 个运行单元；函数依赖生成器随 UI 移入 Page，记录 577 个跨插件实际调用点。Page/Vault 连线显示开关仍互相独立，默认隐藏不影响函数详情。函数详情弹框使用受视口高度约束的纵向布局，标题与关闭按钮保持可见，内容区允许收缩并独立滚动，长列表子项不被 flex 压缩。

验证：全量单元回归 265 文件、2184 项通过；补充 Page 缓存首页撤销验证的定向回归 11 文件、43 项通过；根/E2E 类型、目录和函数数据一致性、覆盖矩阵检查通过。Chromium local-integration-mut9tdl1-4345a1f915f6 全部 20 项通过，包含首页恢复、导航、锁定/解锁和桌面/390px 窄屏长列表滚动到末项。14 项真实源码负面探针均被拒绝；Worker 边界与不可逆 I/O 审计通过。

Demo 与 Keymaster 的两个本地生产 origin Connect 联调通过（login、identity、cipher、Storage、price、resume、logout）；无 E2E 标志的生产构建及产物扫描通过。未推送或测试线上部署。

### 2026-10-04：Workspace 拆分与统一扫码 / URI 分派

Workspace 独立插件删除，产品名称明确改为 Assets（资产聚合）、Collectibles（藏品聚合）和 Scan（统一输入及 URI 分派）。Page 接管钱包分类和 BSV 链设置容器；P2PKH 接管身份/地址二维码及通用转账注册表。各插件自己的资源、Context、注册表、业务 UI 保持所属实例身份，不通过聚合插件转接业务内部服务。

Scan 发布实例绑定的 `uri.action.registry@1`、`uri.action.resolver@1`、`scan.ui@1`；Contacts、P2PKH、Message、MSFile 以可选注册能力贡献内部 UI。支持既有公钥/JSON 二维码、公钥 URI、P2PKH 地址、BSV 付款 URI及显式 MSFile Seed URI。解析只返回冻结摘要与短期令牌，选择后渲染真正提供方 UI；保存、发送、签名、广播仍需业务确认。输入只留在有界内存，释放、关闭及撤销时清理，旧令牌不随同名处理器恢复。

当前发行版 21 产品、32 单元、100 契约；依赖图生成 584 个实际调用点。全量单元回归 268 文件/2193 项通过；后续 URI 提供方撤销/恢复、停止快照和 BSV21/STAS 迟到状态成功/失败定向回归通过。根/E2E 类型、目录、契约、源码/React/Worker 边界、14 项源码反向探针和 I/O 审计通过。Chromium `local-integration-mutnm3qb-244fe8459201` 全部 20 项通过，包含实际图片扫码、金额精确预填、设置图及长内容滚动、锁定/恢复；页面异常为空。

Demo 与 Keymaster 本地生产 origin Connect 联调通过，生产产物扫描通过。详细边界、协议和验收见 [统一扫码与URI分派设计](统一扫码与URI分派设计.md)。按用户范围未运行线上验收，未提交或推送。

### 2026-10-04：安全边界复核重开

KFM-003/004/011 的 Host Context 与公开入口隔离、KFM-003/008 的公共服务内部引用、KFM-006/010 的 Vault 子句柄归属撤销重新打开。必须以真实贡献树、真实发布能力及同会话撤销/迟到结果回归验证后才能重新关闭；先前绿灯不覆盖本轮三个绕过。

### 2026-10-04：三项安全阻断修复后复核关闭

本轮先重开 KFM-003/004/006/008/010/011 对应边界，以下三个阻断现已通过回归关闭；施工单原有未验收事项保持原状态。

1. **Host/App Context 隔离**：完整 Host 创建、Context、Provider 与控制 hooks 移至可信 `@keymaster/runtime/assembly`，业务主入口不再导出。所有 Page 贡献、领域私有 UI 绑定及 URI 业务回调使用 `ScopedPluginConsumerProvider`，清空 Keymaster Host 和 WebLoom App Context。真实贡献树验证页面、设置块、header、首页、frame 无原始 Host/App，未声明能力仍拒绝，可信兄弟节点保留合法 Host；URI render 回调本身也使用业务提供方 consumer。门禁拒绝 Context 别名、原生 Provider、可信装配入口、require/re-export/动态导入及 namespace 旁路；20 个真实源码负面探针通过。
2. **公共服务内部引用收口**：MSFile Web/Worker 发布冻结、无原型的显式契约方法门面，Connect 子视图同样隔离，调用与异步结果复核提供方 Scope；Proxy 内部状态和 Coordinator 使用 ECMAScript 私有字段/方法。真实 manifest 发布回归和运行时反射证明无法取得 Coordinator、control、grant、缓存或 dispose。检查其他直接发布对象时发现 Protocol 类同类内部依赖风险，已改用同样的契约门面；其余已查直接服务采用闭包或已有公开门面，不返回 Coordinator/依赖字段。
3. **Vault 子句柄归属**：生产 Worker 的公开及内部创建路径均捕获实际 Vault 提供方 Scope。每次身份读取、签名、派生在操作前、I/O 执行内及结果返回前复核，Scope 撤销同步 dispose 子句柄并移除撤销监听。真实 LifecycleScope 回归验证会话不变时撤销仍拒绝缓存签名/派生、旧句柄不能因新实例恢复而复活，签名/派生的迟到 I/O 结果不可返回；原会话世代和 final I/O 约束继续保留。

验证：根/E2E 类型、契约、发行目录、函数依赖数据、源码/React/Worker 边界、20 个源码负面探针、Worker 边界反向自测、最终 I/O 审计、正式 0.6 release 边界和生产产物扫描通过。全量 273 个单元测试文件、2208 个用例通过；随后追加 URI 回调身份回归的 7 项定向检查通过。Chromium `local-integration-mutoovvy-e518dabf0f48` 全部 20 项通过；最终 URI/Page Gate `local-integration-mutos6z0-a35a048e72a2` 再次通过且页面异常为空。Demo 与 Keymaster 两个本地生产 origin 的 login、identity、cipher、Storage、price、resume、logout 联调通过。未测试线上，未提交或推送。
