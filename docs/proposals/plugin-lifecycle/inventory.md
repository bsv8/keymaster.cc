# KMP-001 实际能力清单

日期：2026-09-06。状态：代码盘点与本地生产链已完成；外部部署、旧 Worker 退出和不可逆 I/O 真实目标环境证据仍待执行。

本清单回答三个问题：用户启停的产品是什么、实际由哪个运行环境拥有副作用、哪些地方还不是静态 `units`（运行单元）契约。来源是 [pluginCatalog.ts](../../../apps/web/src/pluginCatalog.ts)、各插件 `src/manifest.ts`、[bootstrapPlugins.ts](../../../apps/web/src/bootstrapPlugins.ts) 和 [Coordinator Worker](../../../apps/web/src/keymasterSessionCoordinator.worker.ts)。

## 字段说明

| 字段 | 中文含义 |
| --- | --- |
| `pluginId` | 产品级稳定标识；设置页启停的对象。 |
| `windowHost` | 主页面 Window Host 是否装配该产品的 UI、Registry（注册表）或页面服务。当前 catalog 产品均由此入口注册。 |
| `workerOwner` | SharedWorker / Coordinator 是否实际持有任务、私钥、存储、网络或领域服务副作用。 |
| `declaredUnit` | 领域 manifest 是否已经用 `units` 明确声明 Worker / Window 单元；不是“代码能在该环境执行”的推断。当前 25 个产品均有显式声明，Worker 单元还必须通过 Coordinator Worker 目录和运行态注册表校验。 |
| `risk` | 盘点后仍需在后续施工单解决的边界，不等同于已复现故障。 |

## 25 个 catalog 产品

当前 `WEB_PLUGIN_CATALOG` 共 25 项。每个领域 manifest 都显式声明了自己的 Window 单元；Storage、Vault、Window P2P、MSFile、Sat、Contacts、P2PKH、Token、Ordinals、WOC、JungleBus 另声明 Coordinator Worker 单元。`apps/web/src/pluginCatalog.ts` 只做静态契约比对，不再为缺失声明补造生产单元。Worker 的实际实例由 `workerUnitCatalog.ts` 和 `workerUnitRuntime.ts` 共同登记，快照只报告本次确实激活的实例。

| `pluginId` | `windowHost` | `workerOwner` | `declaredUnit` | `risk` |
| --- | --- | --- | --- | --- |
| `storage` | Storage onboarding、设置入口 | Storage Provider、桶状态、平台存储 | 是（Window + Worker） | 外部 Provider 恢复与部署切换证据仍需执行。 |
| `vault` | Vault 选择、解锁和管理 UI | 私钥、Keyspace、密码学和 owner 会话 | 是（Window + Worker） | 外部发布后的旧 Worker 退出证据仍需执行。 |
| `window-p2p` | 浏览器 P2P Host / lane | Worker 执行租约、接管校验和签名请求 | 是（Window + Worker） | 真实 Go supplier 链需在固定 checkout 上留证。 |
| `msfile` | 文件页面、读取投影、Window lane | MSFile 服务、授权、读并发和取消 | 是（Window + Worker） | 真实 AppView、媒体 Range 和不可逆 I/O 证据仍需目标环境确认。 |
| `sat-subscription` | 订阅设置和状态 UI | Sat 运行时、Channel mux、owner 订阅 | 是（Window + Worker） | 真实远端订阅与未知支付结果恢复仍需目标环境演练。 |
| `protocol` | Connect 网关和请求 UI | protocol 平台存储、会话验证和请求执行 | 是（Window） | 普通 popup 与外部部署仍需补验。 |
| `contacts` | 联系人页面与注册贡献 | 联系人在线探测和 owner 任务 | 是（Window + Worker） | Channel 不可用时的降级证据仍需补验。 |
| `webrtc` | WebRTC / 文件传输 UI | 通过 Coordinator 使用 Channel 和联系人校验 | 是（Window） | 跨环境服务引用已收口，领域网络链仍需补验。 |
| `message` | 消息页、消息服务 | Channel 数据与通知由 Coordinator 持有 | 是（Window） | 文本消息与 WebRTC 的可选降级仍需补验。 |
| `settings` | 设置路由、设置注册表、插件管理页 | 无独立领域 Worker | 是（Window） | 展示与 Worker 运行快照的外部回归仍需补验。 |
| `key-import` | 导入 UI 和导入动作 | 通过 Vault facade 写入 Key 仓库 | 是（Window） | 解析器权限边界已有本地校验，需纳入发布回归。 |
| `background` | 任务托盘和后台设置 | 定时任务、任务恢复、任务状态快照 | 是（Window） | 真实重启恢复与任务接管仍需演练。 |
| `home` | 首页、业务导航投影 | 无独立领域 Worker | 是（Window） | 首页贡献与底层业务 Registry 需纳入发布回归。 |
| `woc` | Provider 设置和本地 service facade | WOC Provider、限流和 owner 配置 | 是（Window + Worker） | 真实 Provider smoke 仍需固定环境证据。 |
| `junglebus` | Provider 设置 | JungleBus Provider 配置和选择 | 是（Window + Worker） | 真实订阅 / Provider 故障恢复仍需固定环境证据。 |
| `p2pkh` | BSV 资产、转账和设置 UI | 资产同步、owner 仓库、广播与重广播 | 是（Window + Worker） | 真实广播 / 支付不可逆入口仍需逐项目标环境审计。 |
| `token-bsv21` | BSV21 展示和操作 UI | BSV21 owner 同步任务和仓库 | 是（Window + Worker） | 真实资产恢复与广播入口仍需逐项审计。 |
| `token-stas` | STAS 展示和操作 UI | STAS owner 同步任务和仓库 | 是（Window + Worker） | 真实资产恢复与广播入口仍需逐项审计。 |
| `collectible-1satordinals` | 1Sat Ordinals 页面 | Ordinals owner 同步和转账支持 | 是（Window + Worker） | 真实资产恢复与广播入口仍需逐项审计。 |
| `poker` | Poker 页面和身份会话 | 当前未发现独立 Coordinator 任务 | 是（Window） | 保持现有 Vault / MessageBus 关系并纳入发布回归。 |
| `importer-wif` | WIF 解析器和导入 UI | 无独立 Worker；写入经 Vault | 是（Window） | 解析器无签名权限的回归需保留。 |
| `importer-hex` | HEX 解析器和导入 UI | 无独立 Worker；写入经 Vault | 是（Window） | 解析器无签名权限的回归需保留。 |
| `importer-json-file` | JSON 文件解析器和导入 UI | 无独立 Worker；写入经 Vault | 是（Window） | 页面关闭后的文件资源释放需保留回归。 |
| `bsv-price` | 行情页和首页投影 | 价格频道通过 Coordinator Channel 获取 | 是（Window） | 频道断线与恢复需纳入发布回归。 |
| `apps` | App catalog、启动入口 | Connect 具体执行由 protocol / session 运行时负责 | 是（Window） | 启动器 UI 与 Connect session 授权仍需外部回归。 |

## 已确认的实际边界

- 页面装配入口是 `bootstrapPlugins()`；它给 Host 明确设置 `execution: "window"`。因此当前页面 Host 不会把一个未来的 Worker 单元假装成 Window capability。
- `WEB_PLUGIN_CATALOG` 通过 `materializeCatalogRuntimeUnit()` 校验每个 manifest 的显式 `units` 与 contracts 静态目录完全一致；生产路径不再为缺失声明补造单元。
- Coordinator Worker 的 `registerCoordinatorTasks()` 仍负责创建领域对象，但它现在必须通过 `workerUnitCatalog.ts` 取得所属单元，并由 `workerUnitRuntime.ts` 登记实际 instance。Storage、Vault、Window P2P、MSFile、Sat、WOC、JungleBus 等服务也在服务创建 / 销毁边界登记；快照不报告未实际激活的服务单元。
- Coordinator Worker 目录现在登记 12 个实际运行单元，覆盖任务型和服务型单元；目录同时绑定产品、稳定 `unitId`、生命周期、任务 / 服务和最终 I/O 审计入口，并由 Worker 装配、运行态快照和静态审计共同校验。
- 主页面收到的 Coordinator facade 按产品 id 收窄；插件不能从公共 capability 表取得另一个产品的完整 Coordinator client。
- 产品意图已经与运行状态分离：SharedWorker 持久化 `desiredEnabled` 和修订；Window Host 只投影并执行本地实例。启动失败不会把已保存意图改回 `false`。
- 主页面 Window → SharedWorker → 独立 MessagePort → owner/platform 存储与 crypto 的服务桥，以及 `/apps → Session Window → 外部 AppView → connect.launch`，已在 Chromium 生产构建回归；Dedicated Worker Session Crypto 另有浏览器回归。
- 最终存储 / crypto 入口校验端口连接、服务实例、服务端 grant、session epoch、owner、桶 / owner 世代和允许操作；platform grant 在授权校验尚未进入物理 I/O 时只重绑一次，未知结果不重放。
- 这份清单仍区分“静态单元契约”和“目标环境证据”：本地代码已经形成唯一 Worker 运行态注册表，但外部部署接管、真实不可逆 I/O、恢复演练和固定 supplier checkout 证据没有在本地伪造。

## 尚未完成的 KMP-001 检查

| 检查 | 当前结果 |
| --- | --- |
| 25 个 catalog 与 manifest / Coordinator 入口盘点 | 已完成。 |
| 主页面、Connect popup、AppView 三入口的持钥路径 | 主页面 AppView 交接已由 Chromium 回归；普通 popup、独立持钥路径的统一策略和外部部署仍需补验。 |
| Window、Dedicated Worker、SharedWorker 真实构建运行 | 主页面 Window / SharedWorker、独立 MessagePort 和 Dedicated Worker Session Crypto 已完成本地生产构建回归；Cordis-specific 浏览器链未做。 |
| Worker Provider → Window proxy → owner 存储消费者 | 主页面真实浏览器链与显式 Worker / Window 单元注册已完成；固定生产部署仍需执行外部 smoke。 |
| 真实授权表在 RPC / 最终存储与签名边界复核 | Coordinator 存储 / crypto / Worker lease 主链已完成；上传、远端订阅、广播 / 支付等不可逆领域入口仍需逐项目标环境审计。 |
| 新旧 Worker 接管和旧 I/O 原子排空 | 持久 authority、handover generation、最终 I/O lease 已接入并有 Node / Chromium 证据；部署 handover、旧 Worker 退出和 rollback 演练仍需真实发布证据。 |

## 已具名的 Coordinator Worker 单元

这张表是已落地的运行单元证据；服务型单元没有周期任务时以 `serviceId` 表示。它不替代目标环境的发布验收证据。

| 产品 `productId` | Worker `unitId` | 任务 `taskId` | 最终 I/O 审计入口 |
| --- | --- | --- | --- |
| `storage` | `storage.coordinator-worker` | — | `coordinator.storage` |
| `vault` | `vault.coordinator-worker` | — | `coordinator.crypto` |
| `window-p2p` | `window-p2p.coordinator-worker` | — | `window-p2p.executor` |
| `msfile` | `msfile.coordinator-worker` | — | `msfile.service` |
| `sat-subscription` | `sat-subscription.coordinator-worker` | — | `sat.runtime`、`channel.runtime` |
| `contacts` | `contacts.coordinator-worker` | `contacts.presence-probe` | `contacts.presence-probe` |
| `p2pkh` | `p2pkh.coordinator-worker` | `p2pkh.transactions-sync` | `p2pkh.sync` |
| `token-bsv21` | `token-bsv21.coordinator-worker` | `token-bsv21.sync` | `token-bsv21.sync` |
| `token-stas` | `token-stas.coordinator-worker` | `token-stas.sync` | `token-stas.sync` |
| `collectible-1satordinals` | `collectible-1satordinals.coordinator-worker` | `collectible-1satordinals.sync` | `collectible-1satordinals.sync` |
| `woc` | `woc.coordinator-worker` | — | `woc.service` |
| `junglebus` | `junglebus.coordinator-worker` | — | `junglebus.service` |

目录登记已经真正由 Coordinator Worker 装配的任务与服务；`workerUnitRuntime` 只在对象成功进入本次 Worker 运行态后发布 `starting` / `ready` 快照，失败或摘除时发布对应状态，不把静态声明当成运行成功。
