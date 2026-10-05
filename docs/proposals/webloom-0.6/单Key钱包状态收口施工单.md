# 单 Key 钱包状态收口施工单

状态：复核两项阻断及实际服务恢复后暴露的锁定清理回归已修复；WK-001–005 全部完成，复验见第 11 节。日期：2026-10-05。

依据：用户确认将 Keyspace 的当前身份读取与变化通知收进 Vault 的公开状态服务，迁移消费者后删除旧接口。承接[扁平插件迁移需求](./Keymaster扁平插件迁移需求.md)的显式依赖、三个访问面与实例生命周期边界；本项是后续单 Key API 收口，不把新增清理要求追溯为上一轮迁移阻断。

## 1. 目标与范围

**Vault 提供唯一的钱包状态读取／订阅能力；其他插件声明依赖后使用。Keyspace 服务退出系统，不只给 onActiveKeyChanged 改名。**

```text
Vault 插件
  ├─ 对内公开：钱包状态读取／订阅
  ├─ 对内公开：明确允许的密钥操作
  ├─ Connect：保持现有对外方法
  └─ 私有：自己的密钥管理流程与 UI

其他插件 ──声明钱包状态能力依赖──→ Vault
```

本项复用已有 VaultLifecycleSnapshot（钱包生命周期快照）、Vault 权威状态和会话事件，不新建状态机。Window 与 Worker 是同一权威的投影，不各自维护身份真值。

不改变单 Key 存储、KeyHold、逻辑目录、签名/交易/支付、Connect 会话或公开 SDK；不添加多 Key 切换，不清除钱包数据，不把状态订阅当成签名或存储授权。

## 2. 目标契约

已定义 VAULT_WALLET_STATE_CAPABILITY（Vault 公开只读钱包状态能力），放在 packages/contracts 的 Vault 契约中。能力身份为 vault.wallet-state@1，不保留旧服务别名。

消费者拿到的实例绑定视图只提供：

| 方法 | 中文用途 | 行为 |
| --- | --- | --- |
| snapshot() | 读取当前已提交的钱包状态 | 返回不可变快照或防御性副本，不返回内部对象 |
| subscribe(handler) | 订阅状态变化 | 先同步交付当前快照，后交付有效变化；返回幂等退订函数 |

local（同 realm 对象）能力沿用当前真实 consumer/Scope 绑定模式：公开服务可提供 bind(consumer, scope)，核对真实签发身份、精确 Scope 和该能力依赖后，返回上述视图。绑定不接受自报 pluginId，不提供其他实例视图；不借完整 Host 或全局 VaultService 查询免检。

快照复用以下既有字段及含义：

| 字段 | 中文含义 | 主要消费者行为 |
| --- | --- | --- |
| status | booting/uninitialized/locked/unlocked，即启动中/未初始化/锁定/解锁 | 决定展示和业务可用性 |
| activePublicKeyHex | 唯一钱包的公开身份 | 仅解锁时公开；锁定/未初始化/过渡态不继续投影 |
| sessionEpoch | 会话世代 | 同一 Key 再次解锁也变化；旧工作和句柄失效 |
| runGeneration | Worker 运行世代 | Worker 重启后不沿用旧结果或授权 |
| walletGeneration | 钱包身份世代 | 重置与重新初始化时区分新旧钱包 |
| vaultLifecycleRevision | 本轮生命周期快照修订 | 同一运行世代内拒绝乱序/旧快照；不同世代不只比较修订数字大小 |

不把 Keyspace 的 generation（旧身份投影计数）机械复制为新状态真值。公开身份类型中的 label/capabilities/createdAt（标签/支持能力/创建时间）若仍有真实调用，保留其权威公开投影或已有精确读取契约，不能默默删除业务需要的字段，也不能为取字段授予整份 Vault 管理服务。

订阅的初始交付必须与后续注册建立一致顺序，不能“读一次再注册”漏掉中间变化。相同有效快照不重复通知；同公钥但世代变化必须通知。观察者抛错不阻断其他观察者。

提供实例或消费实例撤销后，旧 snapshot/subscribe 拒绝，已有订阅清理且不再交付；退订仍可幂等调用。重建重新解析并重新绑定，不让旧视图自动指向新实例。普通对象引用不会被框架自动撤销，产品必须实现这些有效性检查。

## 3. 旧接口清理表

| 旧项 | 处理方式 |
| --- | --- |
| KEYSPACE_SERVICE_CAPABILITY / keyspace.service | 消费者迁移完后删除提供、依赖、目录与解析入口 |
| KeyspaceService | 删除服务类型，不留兼容代理 |
| active() / ActiveKeyState | 改读钱包快照；旧投影类型在无引用后删除 |
| requireActiveKey() | 消费者检查快照已解锁且有公钥；真正操作入口继续核对当前授权/世代，不新增一个同名全局服务 |
| onActiveKeyChanged() | 改订阅钱包状态；按具体变化处理，不只替换函数名 |
| EVENT_ACTIVE_KEY_CHANGED / activeKey.changed / ActiveKeyChangedEvent | 盘点实际发布与订阅，迁移后删除旧事件及类型，不另建全局事件旁路 |
| keyspaceServiceCoordinator / Worker identity 的 Keyspace 视图 | 删除或收缩为 Vault 私有投影辅助，不再提供独立服务 |
| KeyIdentity 等仍用于签名、展示的公开类型 | 移到合适的 Vault/身份契约，保留含义；不能随 keyspace.ts 整文件误删 |

VaultService 已有 getLifecycleSnapshot/onLifecycleChange，不能最终保留两个不同快照源或独立通知实现。将其中只读状态职责收口到新能力；本包 UI 可用同一私有状态源。若其公开方法要删除，盘点并迁移调用后一次删除；不改变其他管理和密钥操作方法的语义。

## 4. WK-001 · 盘点消费者与运行依赖

- [x] 盘点生产代码和测试中的 Keyspace 方法、能力、旧事件、身份类型及自动资源绑定。生成的调用盘点只是辅助，必须覆盖持有旧句柄后再调用的路径。
- [x] 逐项记录用途：公开身份展示、锁定可用性、会话变化失效、钱包变化清理、资源重新绑定；确定需要哪些字段与通知。
- [x] 核对 Window/Worker 单元的依赖来源，避免新状态服务依赖某个反过来等待它的业务插件；Vault 状态在锁定/未初始化时也可读取，不等待“已经解锁”的业务 scope。
- [x] 明确 provider（提供者）、consumer（消费者）、Scope（实例作用域）与目录/部署绑定；不因同 realm 或基础服务免去声明。

主要落点：contracts/keyspace.ts、vault.ts；Vault manifest、keyspaceServiceCoordinator.ts、workerIdentityProjection.ts；Runtime adapter；Coordinator Worker；全部实际消费者。

验收：每个旧调用有目标能力、用途及具体迁移位置，不以“当前只有一个公钥”判为无用。

## 5. WK-002 · Vault 只读状态能力

- [x] 定义只读能力与实例绑定视图，复用既有快照结构和权威状态；锁定时不泄露旧公开身份，始终不返回密码、私钥、grant、可执行管理对象或 Root/Coordinator 引用。
- [x] Window 复用 SessionStateMirror/Vault 已提交快照；Worker 从相同权威构造投影。更新 status/身份/世代必须是一份一致快照，不组合不同修订的字段。
- [x] 统一 snapshot/subscribe 的初始交付、去重和跨运行世代排序规则；所有生产出口复用这份状态源。
- [x] 绑定入口核对真实 consumer 与声明；每次读取、订阅和回调交付核对消费/提供实例。撤销清理订阅，旧视图不重新绑定。
- [x] 暂时并存的旧接口仅用于迁移中的工作树，转发同一状态源；最终提交/交付不保留旧能力、双轨或自动回退。

验收：类型负面与真实适配测试证明未声明/伪造绑定拒绝；修改返回对象不影响权威；初始订阅无漏通知，撤销后读/订阅拒绝，旧回调不发布。

## 6. WK-003 · 消费者逐组迁移

以下是当前搜索到的主要组别，以实施时实际源码为准，不以包数量关闭任务。

| 消费者 | 必须保留的行为 |
| --- | --- |
| P2PKH、资产/藏品聚合、BSV21/STAS/1SatOrdinals | 公开身份、资源键、资产失效与转账准备；状态读取不授予密钥操作 |
| Contacts、Message、WebRTC | 公开身份变化及会话失效，解绑旧 inbox/连接/回调，不重复建立订阅 |
| Apps、Protocol | 钱包当前状态与外部 App 会话区分；不能以当前钱包身份替代持久 App 会话 Owner |
| MSFile、SatSubscription、Window P2P、Background | 身份与任务前置条件、租约及订阅失效；不新增联网/支付行为 |
| BSV Price、Page、Vault 自己的 UI | 状态变化驱动展示/资源；每个贡献仍使用所属 consumer |
| Runtime、App/bootstrap、Coordinator | 接线与资源身份刷新，不另立一份 Keyspace 真值或调度器 |

- [x] 每个单元将旧依赖替换为精确钱包状态能力及正确来源；只需要状态的插件不得改为依赖完整 Vault 管理服务。
- [x] 迁移 active/requireActiveKey：保持原锁定错误/空态，检查 status 与公钥一致；读到解锁快照不代表异步操作期间授权仍有效。
- [x] 迁移 onActiveKeyChanged：身份变动更新展示/资源键；会话/运行/钱包世代变化撤下旧工作。调用结果在提交前复核原世代，旧结果不能影响新会话。
- [x] 订阅只关注本功能实际需要的字段，不因每个快照变化全量重载数据；只读身份展示可按公钥比较，涉及授权有效期的工作必须比较世代。
- [x] 提供者替换后重新解析/订阅，解除旧订阅；去掉“方法不存在就静默不订阅”的兼容分支。
- [x] 迁移真实 UI、资源 loader 和 Worker 任务，不只更新测试 stub 或生成目录。

验收：同一 Key 锁定再解锁时，身份展示恢复但旧请求/回调失效；没有重复订阅、旧缓存泄漏或多 Key 选择入口。

## 7. WK-004 · Runtime 接线与旧 API 删除

- [x] 移除 keymasterHostAdapter 中 bindHostKeyspace、按 KEYSPACE_SERVICE_CAPABILITY 特判 provide 和 Keyspace 订阅钩子。资源身份刷新走既有权威 runtime identity（运行身份）转换及其明确接线，不在插件 provide 中隐式截获服务。
- [x] 核对重置、同 Key 再解锁及 Worker 重启的 scope/缓存/资源绑定；新只读状态不能成为另一个推进 sessionEpoch 的写入者。
- [x] 删除 Vault 的 Keyspace 提供与全部声明依赖、Coordinator 的能力实现/物化目录项、公共 exports、旧方法/事件/投影计数；保留仍被业务使用的公开身份类型。
- [x] 清理旧测试夹具、API 注释与失效断言，更新调用盘点/生成能力目录及契约检查；不扫描或删除持久业务数据中的公钥/Owner 字段。
- [x] 收口 getLifecycleSnapshot/onLifecycleChange 的公开重复路径，不保留 keyspace.service 别名、旧事件转发或缺新能力时回退旧服务。

验收：正式源码、公开导出及构建产物无旧服务可用路径；资源与生命周期检查仍通过。必要历史说明可留，但不能被运行代码或生成清单当作现行契约。

## 8. WK-005 · 验收与文档

| 场景 | 必须证明 |
| --- | --- |
| 未初始化/冷启动/锁定 | 状态可读，不误报解锁，不投影旧公钥，不形成启动环 |
| 首次订阅及快照去重 | 基线立即交付，无注册窗口漏事件；重复状态不反复重载 |
| 同 Key 锁定再解锁 | 公钥相同但 sessionEpoch 不同；旧授权、在途结果与旧订阅不沿用 |
| 重置后重新初始化 | walletGeneration 区分新钱包，旧状态/资源不接管新实例 |
| Worker 重启/多 Tab | runGeneration 改变、快照乱序拒绝、各 Tab 最终一致；不恢复旧秘密 |
| 声明与实例边界 | 未声明能力、伪造 consumer/Scope、撤销后旧视图拒绝；退订幂等 |
| 功能回归 | 联系人/消息、我的信息/资产、钱包管理、后台任务及现有本地 Connect 流程保持 |
| API 删除 | 旧能力/方法/事件无法导入或解析，生成目录无旧项目 |

- [x] 补类型、Vault/适配单元、消费者集成与真实浏览器测试，证据分层注明；不只用固定同公钥 stub 验证状态变化。
- [x] 运行本项目类型/契约、源码/Worker/React 边界、相关单元及生产构建；真实浏览器覆盖锁定再解锁、多 Tab、刷新/重启及本地 Demo 回归。
- [x] 按用户已确认范围只要求本地验收，不新增线上部署、真实资金或公开网测试门槛。
- [x] 证据写入 docs/集成测试/覆盖矩阵.yaml；更新架构/生命周期及公开 API 中文说明，重新生成调用/依赖盘点。

完成条件：WK-001–005 全部关闭；消费者使用 Vault 只读状态，旧 Keyspace 服务完全删除；单 Key 的锁定、会话和重置失效语义完整保留。任何临时兼容分支、未迁移实际消费者或缺失真实生命周期证据均不得标记完成。


## 9. 实际调用迁移盘点

下表记录生产用途，完整解析位置见[能力调用盘点](能力调用盘点.md)。Window/Worker 各自从本 realm 的 Vault 根单元取状态；Worker 可信装配注入的私有端口投影同一权威，业务 capability 仍按声明与实例绑定。

| 用途/消费者 | 迁移位置与行为 |
| --- | --- |
| 公开身份、资产/藏品聚合 | Assets/Collectibles manifest、P2PKH 资源与身份页面；读取公开元数据，保持锁定空态 |
| P2PKH 余额/交易准备 | p2pkhService、balanceRefresh、Worker 任务；捕获完整会话，迟到查询不写缓存或启动旧转账 |
| BSV21/STAS/1SatOrdinals | 各 service/syncService、Worker ports；状态依赖独立于 Vault 管理，持仓/历史提交与通知前复核世代 |
| Contacts/Message | contactsService、ContactsEditor、messageService；同公钥新会话清理 presence/inbox/草稿，旧发布不写本地记录 |
| WebRTC | webrtcService 的会话订阅与 owner fence；撤下连接、拨号和文件传输工作，基线不会重复建立 inbox |
| Apps/Protocol | AppLaunchModal、Protocol 的状态/存储前置检查；世代变化撤回密码，持久 App Owner 保留原协议语义 |
| MSFile | Worker ports、Home/Bucket 资源与任务；全会话 token 隔离旧任务，状态读取不取得 Vault 管理服务 |
| SatSubscription/Window P2P | Worker setup/ports 绑定只读状态，status 适配来自同一 snapshot，原租约和授权入口继续围栏 |
| Background/Price/Page | 删除 Background 无用身份钩子；领域资源订阅驱动 UI，Page 展示由贡献实例消费资源 |
| Vault UI | 内部 walletSnapshot/subscribeWalletState 与 Resource Store 同源；公开管理门面移除重复快照方法 |
| Runtime/App/bootstrap | 删除 bindHostKeyspace/特判 provide，可信装配提交含 runGeneration 的 runtime identity；旧资源和 Scope 撤销 |
| Coordinator/身份元数据 | 已提交状态提供世代；workerIdentityProjection 只保留私有公开元数据辅助，无独立身份计数或 Keyspace 服务 |

状态-only 消费者不会被授予完整 Vault 管理服务。现行只读契约、示例与边界说明见[钱包状态 API](../../钱包状态API.md)。


## 10. 首轮验收记录 · 2026-10-04（历史证据）

复核已确认本节未覆盖实际 Worker 签发登记表及 Window 通知中新增观察者的生产路径，因此这些历史通过结果不能单独关闭 WK-002、WK-003、WK-005。最终结论以第 11 节复验为准。

| 层次 | 实际证据 |
| --- | --- |
| 类型/删除 | `pnpm typecheck`、`pnpm typecheck:e2e` 通过；新能力的伪造绑定、管理操作和旧接口导入负面类型断言通过；99 契约结构通过 |
| 全部单元 | `node scripts/run-vitest-batches.mjs`：274 文件、2224 用例全部通过，包括真实 Worker 的 121 项；非浏览器部分使用明确标注的 fixture，不把固定公钥 stub 当成真实会话证据 |
| 状态/实例 | walletStateAccess 的 7 项验证真实适配签发、声明/Scope、提供及消费撤销、冻结、去重、重入时新观察者不接收旧/重复提交；walletSessionProjection 验证跨 run 乱序拒绝和 Window 缓存/迟到密码学操作 |
| 实际消费者 | STAS 同公钥的 epoch/run/wallet 迟到结果不落盘、不通知；Message 旧发布不保存；Apps 表单在三类世代变化时清空密码并关闭；资源恢复回归验证新会话贡献先提交，再加载全局投影 |
| 真实浏览器 | `local-integration-mutr3981-219f9e7081cb`：21 项通过。新增 Page Gate 从真实新钱包、Vault 公共句柄和双 Tab 验证同 Key 解锁失效；CDP 终止该 context 的真实 SharedWorker 后确认新 run、冷启动 locked、同钱包恢复；原初始化、导入、联系人/消息、导航、存储、语言及扫码贡献保持 |
| 本地 Connect | `/home/david/Workspaces/KeymasterConnectDemo` 的 `npm run test:e2e:local-connect` 通过，生产 origin 4184/4201：login、identity.get、intent.sign/验签、cipher、App 文件 put/get/list/delete、price、resume/logout；Demo 类型与 9 文件/123 用例通过 |
| 边界/产物 | 源码、React、Worker（250 workspace modules）、final-I/O、WebLoom 发行边界通过；20 项源码真实导入负面探针与 Worker 负面检查通过；普通生产构建由本地 Demo 执行并通过产物扫描；构建及现行生成清单没有旧 Keyspace/重复快照接口 |
| 文档/生成 | 覆盖矩阵 YAML 更新并生成 Markdown；产品/能力目录、函数依赖、调用盘点、实施附表重生成；架构、生命周期和钱包状态 API 中文说明更新 |

测试结果按层次记录：钱包重置/重新初始化与钱包世代的密钥和存储围栏由实际 Worker 单元及领域测试覆盖；多 Tab 和物理 Worker 重启由真实 Chromium 覆盖。未新增线上、部署交接、真实资金或公网业务验收。Connect 公共 SDK 方法及持久 App Owner 语义保持原状。


## 11. 阻断修复与正式路径复验 · 2026-10-05

| 复核项 | 实施与回归证据 |
| --- | --- |
| Worker 合法 consumer 被拒绝 | Vault Worker setup 给状态绑定注入实际 `workerConsumers` 登记表验证器；保留 provider/consumer Scope、签发对象、声明及当前提供实例检查。`keymasterSessionCoordinator.worker.test.ts` 用原生 WebLoom Host 装配正式 Vault 与 Window P2P setup，不走 Window 适配器：合法 consumer 可读、伪造/错 Scope 拒绝、去掉声明 setup 失败，消费及提供撤销后旧视图失效且订阅停止 |
| Window 重入重复基线 | 实际 `VaultServiceCoordinator` 使用 `createWalletStateSource`，删除可变 Set 通知循环。`walletSessionProjection.test.ts` 经过实际 Window 服务和公开 `bind`，验证 epoch-2 通知中新增观察者只收到一次 epoch-2，随后 epoch-3 一次；覆盖重入提交、观察者异常隔离及提供实例撤销 |
| 实际服务恢复后的锁定清理 | 浏览器发现后台展示快照调用撤销中的任务 `keyScope`，中断锁定结果发布。锁定时不读取任务身份；仅展示投影将 `lifecycle.scope_revoked` 视为无身份，其他错误继续抛出。待结算任务仍保留原执行/重装围栏；原生 Host 回归验证旧 view 本身拒绝，但后台快照及 lock 成功。Contacts 在线状态清理不再读取被撤销 view，并补清理回归 |
| 类型/契约/边界 | `pnpm test:types`、E2E 类型通过；99 契约及 8 文件/63 契约用例通过；源码、React、Worker、final-I/O、发行边界、20 项源码负面探针和 Worker 门禁自检通过 |
| 全量单元 | `node scripts/run-vitest-batches.mjs`：274 文件/2229 用例全部通过，包含 Worker 123 项及实际 Window 投影 7 项 |
| 本地真实浏览器 | `local-integration-muu0bhwy-9a386b761f9d`：21 项全通过。正式业务服务可启动后仍覆盖锁定/再解锁、SatSubscription、多 Tab、存储授权撤销；同 Key 的新 epoch、旧签名句柄拒绝及 CDP 真正终止 SharedWorker 后新 run/冷启动 locked 恢复通过 |
| 本地 Demo/构建 | `/home/david/Workspaces/KeymasterConnectDemo` 的 `npm run test:e2e:local-connect` 通过：生产 origin 4184/4201 的 login、identity、签名/验签、cipher、Storage、price、resume/logout；该流程重新执行普通生产构建，产物扫描通过 |
| 文档/生成 | 更新钱包状态 API 的 realm 身份验证与提交序列交付说明；生成函数依赖、调用盘点、实施附表及覆盖矩阵。第 10 节保留为历史证据，明确其不足，不能替代本次正式路径复验 |

本次重新关闭 WK-002、WK-003、WK-005 的相关项；同一 Key 再次解锁仍推进会话，旧句柄不能复活。验收范围按用户要求仅限本地。
