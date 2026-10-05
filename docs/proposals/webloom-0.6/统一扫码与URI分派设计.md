# 统一扫码与 URI 分派

2026-10-04，按用户确认的设计实施。统一识别入口保留，领域业务流程不归入口插件。

## 职责

| 插件 | 持有的实现与界面 |
| --- | --- |
| Scan | 摄像头、图片、本地粘贴；URI 处理器注册、匹配、短期候选和选择界面 |
| Contacts | 公钥识别后的联系人查询、创建/编辑 UI；复用自己的编辑器 |
| P2PKH | 地址/付款请求校验、转账入口、金额预填、首页身份/地址二维码；签名/广播仍走既有转账确认 |
| Message | 公钥对应的会话入口；选择和打开会话不发送消息 |
| MSFile | Seed URI 解析及自有文件表单；识别和挂载不发起付费购买 |
| Assets | 资产/Token 注册表、失效通知、持仓聚合、资产总览/详情及首页卡片 |
| Collectibles | 藏品与转移处理器注册表、列表/详情/转移页面和资源 |
| Page | 首页、钱包导航类别、BSV 链/通用设置容器及贡献挂载 |

独立 Workspace 插件删除，不保留别名产品、旧 consumer 或兼容入口。发行版共 21 个产品、32 个单元。通用转账 provider 注册表归 P2PKH；藏品转移使用 Collectibles 的独立注册表。具体 Token/藏品标准仍自行注册 provider，不导入聚合插件实现。

## 公共能力

三项均为 Window local capability，版本 1：

- `uri.action.registry.bind(consumer, scope)`：返回 WebLoom `createScopedRegistryView` 注册视图。处理器提供同步、无业务副作用的 `resolve(input)` 和业务 UI 的 `render(actionId, input, close)`。
- `uri.action.resolver.bind(consumer, scope)`：解析得到冻结的 resolution/candidate 摘要；`activate` 只进入对应实例 UI；`release` 回收解析结果。
- `scan.ui.bind(consumer, scope).open(input?)`：从其它插件打开统一输入界面，可直接预填 URI，不需要摄像头。

消费者必须声明对应能力；处理方可选声明 registry，使用实例订阅在 Scan 提供方晚到、撤销、替换时重绑。Scan 不声明 Contacts/P2PKH/Message/MSFile 业务服务依赖，因此缺少任何处理方不阻止其它格式识别。

注册、解析与打开入口验证已签发 consumer、实际所属 Scope、能力声明、提供方和消费方状态。返回的公共对象不提供处理器列表、原始输入、组件、consumer、私有 Context 或业务服务。

## 分派与生命周期

1. 输入去除首尾空白，长度为 1–16384 字符。处理器只进行解析；单个处理器异常不阻止其它格式。
2. 按处理器顺序与稳定 id 匹配。同一内容允许多个操作，不自动执行第一个候选；无匹配时提供重新输入。
3. 操作标识是随机、短期、调用实例所属的令牌。每个视图最多 16 次解析，路由器全局最多 128 次；不落盘、不记录输入日志。
4. 选择时重新解析输入，并复核处理方实例和注册条目。不能把其他实例的 resolution 或 candidate 拿来执行。
5. 业务 UI 在实际提供方 `PluginConsumerProvider` 中挂载，可使用自己的私有 Context/内部 API。Scan 只组合 UI，不调用导入、保存、发送、签名、广播或购买接口。
6. 注册撤销立即清理候选并撤下已打开业务 UI。同名新处理器不继承旧令牌。调用方撤销、Scan 撤销、主动关闭/释放或有界淘汰时回收输入；打开界面的来源实例在用户选中操作后仍保留撤销控制。
7. 相机 controls 在关闭/切换/卸载时停止，包括晚到的启动结果；图片识别按世代隔离晚到结果并回收 Blob URL。

Page 的 `uri-action` frame 挂在已解锁壳内，页面导航后仍能挂载统一入口。未解锁的 Vault 导入仍由 Vault 的已有内部初始化界面负责，不把私钥或 KeyHold 导入 API 暴露给 Scan。

## 已接入格式

| 内容 | 可用操作 |
| --- | --- |
| 裸压缩公钥、既有 `{publicKeyHex}` JSON 二维码 | 联系人、BSV 转账、会话 |
| `keymaster:contact?publicKeyHex=...` 或 `keymaster://contact?publicKeyHex=...` | 联系人、BSV 转账、会话 |
| 校验和有效的 P2PKH 主网/测试网裸地址 | BSV 转账 |
| `bsv:<address>?amount=<BSV>&label=<text>` | BSV 转账；金额按整数 sats 精确预填，仍须用户确认 |
| `msfile://seed/<64 hex>` | MSFile 文件表单，Seed Hash 预填 |

公钥 URI 拒绝重复/未知字段及 fragment。付款 URI 拒绝错误校验和、未知/重复字段、fragment、非正金额、科学计数、超过 8 位小数及超过总量的金额；主网/测试网限制继续由 P2PKH 自有页面校验。Seed URI 必须明确声明格式，不把裸 64 位十六进制文本误判成文件或密钥。

Connect、Vault 或未来业务可以按其实际协议注册内部 UI；本次不自行发明 Connect 授权格式或启用已初始化钱包的密钥替换入口。

## 验证

生产 Host 适配回归验证真实 consumer 的 UI 挂载、冻结摘要、多候选、未声明/伪造/跨实例访问拒绝、撤销后的缓存访问拒绝、同名处理器重注册与候选隔离、输入限制和令牌释放/淘汰、外部入口来源实例撤销。解析器覆盖既有公钥二维码、显式 URI、地址校验、金额精度及异常字段。

Chromium 页面 Gate 在真实 SharedWorker/IndexedDB 下从钱包身份二维码生成图片，通过统一图片入口识别，选择 Contacts 并打开其编辑器；另验证未知内容和 BSV 请求的转账/金额预填。既有全量本地页面 Gate 验证拆分后的资产/藏品、导航、设置、锁定与重新解锁。

### 本地验收结果（2026-10-04）

- 发行目录 21 个产品、32 个单元；100 个契约；584 个实际跨插件函数调用点。无 Workspace 产品、包或资源别名。
- 全量单元回归 268 文件、2193 项通过；之后新增/更新的 URI、可选提供方、诊断停止快照及 Token 迟到状态结果定向回归通过。真实 Host 验证 Scan 撤销后可选业务实例继续运行、恢复后重新注册，旧解析器保持失效。
- Chromium `local-integration-mutnm3qb-244fe8459201` 全部 20 项通过。真实身份 QR 图片与高分辨率解码样本通过；本地缩放/旋转重试有界，相机与图片输入不上传。关闭未激活识别、关闭业务 UI、提供方/调用方撤销回收对应输入。
- 锁定并发验收暴露的 BSV21/STAS 迟到查询已修复，成功/失败的晚到结果均不得触发停止实例的后台同步；页面异常为空。
- 根及 E2E 类型、契约、目录/函数数据、源码/React/Worker 边界、14 个真实源码反向探针、Worker 反向探针、不可逆 I/O 审计和生产产物扫描通过。
- Demo 与 Keymaster 两个本地生产 origin Connect 联调通过：login、identity、cipher、Storage、price、resume、logout。仅执行本地测试，未提交或推送。
