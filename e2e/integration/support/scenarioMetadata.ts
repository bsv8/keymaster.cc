import type { IntegrationScenarioMetadata } from "./types.js";

/** 本地示例 Journey：初始化后用户可以进入首页菜单。 */
export const LOCAL_INIT_MENU_SCENARIO = {
  id: "J-LOCAL-INIT-MENU",
  level: "local-integration",
  requirementIds: ["KM-INIT-001", "KM-VAULT-001", "KM-NAV-001"],
  startingState: "全新 Chromium context，没有 Local catalog、Vault 或 active Key。",
  successCriteria: [
    "初始化事务只提交一次并创建一把带标签的 Key。",
    "运行态安装完成后进入首页，Local catalog 只有一个选中桶。",
    "刷新页面后仍能读取同一桶和 active Key。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 本地示例 Journey：保存联系人并检查会话入口与非法输入恢复。 */
export const LOCAL_CONTACT_MESSAGE_SCENARIO = {
  id: "J-LOCAL-CONTACT-MESSAGE",
  level: "local-integration",
  requirementIds: ["KM-INIT-001", "KM-CONTACT-001", "KM-MESSAGE-001"],
  startingState: "全新 Chromium context，用户尚未建立身份或联系人。",
  successCriteria: [
    "初始化只发生一次。",
    "联系人保存到当前 active Key 的业务空间。",
    "错误的会话身份在表单内失败，修正后可以进入对应会话页面。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 SatSubscription 本地供应商 Journey：正式服务完成 Channel 私信收发。 */
export const REAL_SATSUB_MESSAGE_SCENARIO = {
  id: "J-REAL-SATSUB-MESSAGE",
  level: "satsubscription",
  requirementIds: ["KM-MESSAGE-001", "KM-SATSUB-001"],
  startingState: "Node 从仓库外 SATS_SUBSCRIPTION_DIR 构建正式 cmd/satsubscription 并启动一次性 PostgreSQL；三个用户各用一个独立浏览器进程和确定性白名单 Hex Key。",
  successCriteria: [
    "三个独立浏览器都通过真实页面完成供应商身份 pin 和 online 连接。",
    "真实账本登记三个 owner inbox 订阅，且 ssp-publish/ssp-subscribe 的 charged_subunits 为 0。",
    "A 发送后 B 的会话页收到消息，A 保留自己的已发送记录。",
    "B 刷新并重新解锁后本地历史仍存在。",
    "独立浏览器 C 打开与 A 的会话看不到这条消息。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 SS server 设置页 Journey：单免费用户验证 SPI/订阅/账单真实翻页。不测内置 bsv8 缺省供应商。 */
export const REAL_SATSUB_SERVER_SETTINGS_SCENARIO = {
  id: "J-REAL-SATSUB-SERVER-SETTINGS",
  level: "satsubscription",
  requirementIds: ["KM-SATSUB-001", "KM-SETTINGS-001"],
  startingState: "Node 从仓库外 SATS_SUBSCRIPTION_DIR 构建正式 cmd/satsubscription 并启动一次性 PostgreSQL；单用户用确定性免费白名单 Hex Key 初始化本地桶并把本地 SS 供应商设为默认发布方；3 条正扣费账单由一次性库的正式 operations fixture 预置（查询走真实 SSP）。",
  successCriteria: [
    "初始化桶 Key 后进入设置页，本地 SS 供应商红绿灯变绿（online）且中文说明为已连接。",
    "点击刷新 SPI 余额后行内出现 BSV/testnet 账户余额且无报错。",
    "点击刷新远端订阅后状态栏提示已刷新且无报错。",
    "以每页 2 条查询账单：第 1 页 2 条且有下一页，第 2 页 1 条且与第 1 页不重复，返回第 1 页记录一致，全程无报错。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/**
 * 本地缺省 SatSubscription Journey：
 * 验证缺省供应商可见、刷新锁定边界与多 tab 共享解锁/全局锁定。
 */
export const LOCAL_SATSUBSCRIPTION_DEFAULT_SCENARIO = {
  id: "J-LOCAL-SATSUB-DEFAULT",
  level: "local-integration",
  requirementIds: ["KM-SETTINGS-001", "KM-LIFECYCLE-001"],
  startingState: "全新 Chromium context 完成 Local 初始化；缺省 SatSubscription 供应商由运行时写入。",
  successCriteria: [
    "解锁后系统设置中的 SatSubscription 显示缺省 bsv8 供应商。",
    "单页面刷新必须回到锁定页，重新输入 Key 密码后才能进入。",
    "多个 tab 共享解锁：其它页面在场时刷新不回锁定页，且缺省供应商仍可读。",
    "任一 tab 手动锁定后，所有 tab 都必须回到锁定页。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 本地设置 Journey：验证正式 registry 提供的设置入口和热切换结果。 */
export const LOCAL_SETTINGS_SCENARIO = {
  id: "J-LOCAL-SETTINGS",
  level: "local-integration",
  requirementIds: ["KM-NAV-001", "KM-SETTINGS-001"],
  startingState: "全新 Chromium context 已完成 Local 初始化，Vault 已解锁且存在 active Key。",
  successCriteria: [
    "系统、价格、插件和系统状态入口都由正式业务菜单打开。",
    "语言修改立即反映到页面并持久化到 localStorage，刷新后仍保持合法语言。",
    "插件依赖状态和系统状态页可以读取，设置页失败时保留可诊断结果。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 S3 首次初始化 Journey；物理桶由 s3.json 指定，页面创建逻辑桶。 */
export const REAL_S3_INITIALIZATION_SCENARIO = {
  id: "J-REAL-S3-INIT",
  level: "s3",
  requirementIds: ["KM-INIT-002"],
  startingState: "s3.json 指定的真实物理桶已取得本轮 lease 并完成开场清理，浏览器是全新 Chromium context。",
  successCriteria: [
    "页面通过正式 S3-compatible 表单完成连接探测，并创建一个真实 S3 后端的逻辑桶。",
    "首个 Hold、Vault 和第一把 Key 提交到本轮 run_id/scenario_id 隔离的远端对象前缀。",
    "刷新后目录、选中桶和第一把 Key 仍可从真实 S3 恢复，访问凭据和桶密码不进入 localStorage。",
    "主动锁定只释放 Key 应用锁，桶认证保留；仅凭 Key 密码即可重新解锁。",
    "清空本机目录的全新浏览器连接同一已有数据的桶时必须走“解锁已有钱包”，远端 KeyHold 不被改写。",
  ],
  resourceProfile: "s3",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 S3 + Local 双桶双 Key 交叉切换 Journey；以首页「我的信息」公钥为准。 */
export const REAL_S3_BUCKET_KEY_SWITCH_SCENARIO = {
  id: "J-REAL-S3-BUCKET-KEY-SWITCH",
  level: "s3",
  requirementIds: ["KM-STORAGE-001"],
  startingState: "s3.json 指定的真实物理桶已取得本轮 lease 并完成开场清理；浏览器从全新 Local 桶开始建立身份。",
  successCriteria: [
    "Local 桶与真实 S3 桶各有两把 Key；第二把 Key 通过 /storage/buckets 的“新建 Key”产生。",
    "Local↔S3 跨桶与桶内切换后，首页“我的信息”公钥和 session.activeKey 都与目标 Key 一致。",
    "S3 非当前桶必须先输入桶密码读取 Keys；Local 桶无需桶密码。",
    "真实 S3 前缀下 keys/ 只有本场景的两把 KeyHold，当前 Key 的应用锁由当前 session 持有。",
    "条件写能力随设备记录持久化（native/best-effort），连接与列 Keys 不再自动探测；桶管理页可手工重新探测并写回。",
    "桶管理页直接列出当前 S3 与非当前 Local 桶的 Key；删除非当前 Local Key 会移除 KeyHold 与该 Key 的 owner 数据，且不影响当前身份。",
  ],
  resourceProfile: "s3",
} as const satisfies IntegrationScenarioMetadata;

/** 生命周期技术 Gate：验证撤权先于 drain，并阻止旧 owner 的迟到结果回写。 */
export const LIFECYCLE_BOUNDARY_GATE = {
  id: "G-LIFECYCLE-BOUNDARY",
  level: "local-integration",
  requirementIds: ["KM-TECH-001", "KM-LIFECYCLE-001"],
  startingState: "Node 侧构造一个带 active scope、Channel 订阅和受保护 outpoint provider 的运行态。",
  successCriteria: [
    "撤权同步隐藏旧回调、释放逻辑订阅，并拒绝新的非空操作。",
    "provider 注销后，已经在途的旧刷新结果不能重新发布受保护 outpoint。",
    "生命周期清理是幂等的，失败不会把旧能力重新暴露给业务。",
  ],
  resourceProfile: "none",
} as const satisfies IntegrationScenarioMetadata;

/**
 * 真实 testnet 收币、到账观察与全额回款 Journey。
 *
 * 原来的随机一次性钱包 Journey 与独立到账探针已合并到这里：随机钱包的私钥
 * 跑完即丢、无法跨轮回收，探针的计时也只在这里作为附件记录。资源未准备时由
 * resources setup fail closed。
 */
export const REAL_TESTNET_ROUNDTRIP_SCENARIO = {
  id: "J-REAL-TESTNET-ROUNDTRIP",
  level: "p2pkh",
  requirementIds: ["KM-ASSET-001"],
  startingState: "真实 testnet 资金库已完成网络、余额和预算检查；浏览器是全新 Chromium context；页面从仓库外 key01.hex 正式导入固定测试 Key，该地址在上一轮必须已无可花费输出。",
  successCriteria: [
    "页面导入后的 active Key 公钥等于 key01 派生公钥，Node 只按这个可追踪 testnet 地址从 seed 打入 50 sat 并等待链上（mempool 即可）可观察。",
    "Keymaster 的 WoC `unspent/all` 快照在转账 Offer 上把余额检测为 50 sats，而不是 Node 侧重新查询余额；广播/链上可观察/页面可见三个时间点写入脱敏附件。",
    "用户填写 seed 地址并以“全部”转出：预览无找零、矿工费从余额扣除，页面返回 local-confirmed 和 canonical txid。",
    "转出后页面余额回到 0；Node 按原始交易核对回款消费了资助输出、seed 实收金额与页面预览一致且损失不超过声明上限；页面广播前失败时用同一把 key01 按同一低费率归集回 seed。",
  ],
  resourceProfile: "testnet",
} as const satisfies IntegrationScenarioMetadata;

/**
 * 真实 testnet 通讯录收款方 + 多笔转账 Journey；覆盖 001/002/003 的页面与链上衔接。
 * 字段说明：联系人身份使用 publicKeyHex，余额使用 sats，广播状态使用页面结果卡。
 */
export const REAL_TESTNET_CONTACT_TRANSFER_SCENARIO = {
  id: "J-REAL-TESTNET-CONTACT-TRANSFER",
  level: "p2pkh",
  requirementIds: ["KM-ASSET-001", "KM-CONTACT-001", "KM-BALANCE-001", "KM-BROADCAST-001"],
  startingState: "真实 testnet 资源已完成预算与网络门禁；全新 Chromium context 导入固定 key01，key01 地址无可花费输出；seed 的压缩公钥作为公开联系人投影提供给页面。",
  successCriteria: [
    "R1–R10 覆盖通讯录、公钥、命中联系人地址、陌生地址、网络锁定、关闭 testnet、冲突和非法 P2PKH 地址；Widget 收款地址全程只读。",
    "B1–B5 证明金额旁余额参考来自页面余额广播，跨 tab 刷新不覆盖金额输入，testnet 开关和资产总览同步。",
    "T1–T5 在真实 testnet 完成 4 笔固定金额和 1 笔全部发送；每笔结果是 local-confirmed，Node 按 fundingTxid/前一笔找零输入与目标输出对账。",
    "T2 不等待上一笔页面同步即继续，由中心服务按 UTXO 序号门禁重建；T4.5 超额金额不进入广播，T5 sendAll 遇 requires-reconfirm 最多重新确认一次。",
    "任意页面广播进入后不再自动归集；isolated 立即停止并保留现场；正常完成后 key01 归零且总手续费不超过 10 sats。",
  ],
  resourceProfile: "testnet",
} as const satisfies IntegrationScenarioMetadata;

/** 真实资源层的 SatSubscription 配置投影 Journey；不把投影冒充成页面连接或收费业务。 */
export const REAL_SATSUBSCRIPTION_HEALTH_SCENARIO = {
  id: "J-REAL-SATSUB-HEALTH",
  level: "satsubscription",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "resource-setup 已写入脱敏配置投影；真实连接结果由 Chromium 页面 Journey 产生。",
  successCriteria: [
    "资源状态只保留 testnet 和供应商公钥等公开配置投影，不把配置文字冒充实时健康握手。",
    "WebSocket/WebRTC Direct 的 Node 直连探针不作为页面业务断言；页面 Journey 单独报告 online、disconnected 或 degraded。",
    "资源状态检查不被解释为充值、消费或服务端账本已经闭合。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 SatSubscription 页面 Journey；页面结果独立于资源状态投影。 */
export const REAL_SATSUBSCRIPTION_PAGE_SCENARIO = {
  id: "J-REAL-SATSUB-PAGE",
  level: "satsubscription",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "全新 Chromium context，用户通过真实 Local 页面建立 active Key；Node 只读取仓库外 Sat 配置。",
  successCriteria: [
    "页面把 satsubscription.json 的 websocket/webrtc-direct libp2p multiaddr 映射为供应商 multiaddrs，并保存真实配置。",
    "正确公钥和地址在页面供应商行显示 online；故意错误公钥在同一页面显示 disconnected 或 degraded。",
    "正确与错误连接结果都来自页面可见文本，不使用 Node WebSocket、Sat API 或 SharedWorker 内部接口断言。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 bsv8 缺省网关 Journey：直连内置缺省配置，只做只读查询，不测本地 SS。 */
export const REAL_SATSUB_DEFAULT_SETTINGS_SCENARIO = {
  id: "J-REAL-SATSUB-DEFAULT-SETTINGS",
  level: "satsubscription",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "全新 Chromium context，用户通过真实 Local 页面建立全新 active Key；不启动本地 SS，直连构建对应的缺省网关。",
  successCriteria: [
    "bsv8 缺省卡片显示内置默认说明且无删除按钮，红绿灯变绿（online）。",
    "刷新 SPI 余额后行内出现 BSV 账户且无报错，刷新远端订阅后状态栏提示已刷新且无报错。",
    "查询服务器账单第 1 页成功；全新 Key 账单为空且上一页/下一页禁用，全程无报错。",
    "只做只读查询，不启用接收、不发布、不充值。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 部署验收 Journey 的矩阵入口；本地 preview 不得替代不可变 Build ID。 */
export const DEPLOYMENT_APPS_SCENARIO = {
  id: "J-DEPLOYMENT-APPS",
  level: "deployment-acceptance",
  requirementIds: ["KM-APPS-001"],
  startingState: "目标部署返回指定 Build ID，外部 App 具有固定 origin、identity proof 和 session 入口。",
  successCriteria: [
    "外部 App 只能通过正式 Connect/Popup 协议建立绑定 origin 的 session。",
    "版本、origin、用户拒绝、popup 关闭和 session 过期均按稳定错误结论收口。",
    "结束时 MessagePort、session 和外部测试状态均已关闭，不保留凭据。",
  ],
  resourceProfile: "deployment",
} as const satisfies IntegrationScenarioMetadata;

/** 技术 Gate 的 stable id；矩阵把它们与业务结果分开记录。 */
export const STORAGE_BROWSER_GATE = {
  id: "G-STORAGE-BROWSER-BOUNDARY",
  level: "local-integration",
  requirementIds: ["KM-TECH-001"],
  startingState: "真实 Chromium 打开的生产 preview，未注入 Node 存储替身。",
  successCriteria: [
    "浏览器提供 localStorage、IndexedDB、Web Crypto 和 SharedWorker 能力。",
    "Local 桶对象只写入 IndexedDB；localStorage 只保留 keymaster.device.* 与 keymaster.session 引导记录。",
    "IndexedDB 未获持久化授权时授权条持续显示，授权后消失且刷新仍保持。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 配置安全 Gate：验证仓库外路径、权限和 SecretString 的读取边界。 */
export const CONFIG_SAFETY_GATE = {
  id: "G-CONFIG-SAFETY",
  level: "local-integration",
  requirementIds: ["KM-TECH-002"],
  startingState: "临时配置目录位于 Git 工作树之外，目录和文件权限由测试明确设置。",
  successCriteria: [
    "合法配置可以读入，但 S3/testnet 秘密只以 SecretString 存在。",
    "目录权限过宽时在读取任何资源前 fail-closed。",
  ],
  resourceProfile: "none",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 S3 Resource 安全 Gate：验证真实 lease、prefix 清理范围和收尾边界。 */
export const RESOURCE_SAFETY_GATE = {
  id: "G-RESOURCE-SAFETY",
  level: "s3",
  requirementIds: ["KM-RESOURCE-001"],
  startingState: "真实 S3 setup 已读取仓库外 s3.json、取得 lease 并完成非前缀开场清理。",
  successCriteria: [
    "真实业务对象只在本场景 run_id/scenario_id prefix 下创建。",
    "prefix 清理不会删除另一个 prefix，路径越界会 fail-closed。",
    "prefix 清理和非前缀 teardown 都在释放 lease 前完成并确认。",
  ],
  resourceProfile: "s3",
} as const satisfies IntegrationScenarioMetadata;

/** 本地初始化 Journey：沿用正式导入入口建立第一把 Hex Key。 */
export const LOCAL_IMPORTED_KEY_SCENARIO = {
  id: "J-LOCAL-INIT-IMPORTED",
  level: "local-integration",
  requirementIds: ["KM-INIT-001", "KM-VAULT-001"],
  startingState: "全新 Chromium context，没有 Local catalog、Vault 或 active Key，使用一次性测试 Hex Key。",
  successCriteria: [
    "用户可以在首次初始化中解析并导入 Hex Key，而不是只能生成 Key。",
    "导入后的 Key 标签、公钥归属由 session 与桶文件真值可观察。",
    "桶密码和一次性私钥原文不进入 localStorage、IndexedDB 或测试附件。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 本地 P2PKH Journey：验证资产菜单、主网交易和本地交易路由。 */
export const LOCAL_P2PKH_NAVIGATION_SCENARIO = {
  id: "J-LOCAL-P2PKH-NAVIGATION",
  level: "local-integration",
  requirementIds: ["KM-ASSET-001", "KM-NAV-001"],
  startingState: "全新 Chromium context 已建立 Local 身份，但没有可消费的真实余额。",
  successCriteria: [
    "真实生产 provider 读取链上交易入口，不由测试替身注入响应。",
    "主网链上交易和本地交易页面均由正式菜单/路由打开。",
    "没有余额时只验证导航和页面就绪，不把页面打开冒充转账成功。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 多标签恢复 Journey：固定 tab1→tab2→tab1 刷新顺序。 */
export const MULTI_TAB_RECOVERY_SCENARIO = {
  id: "J-LOCAL-MULTI-TAB-RECOVERY",
  level: "local-integration",
  requirementIds: ["KM-TECH-001", "KM-LIFECYCLE-001"],
  startingState: "同一 Chromium context 中 tab1 已完成 Local 初始化，第二个 tab 共享同源 Worker 和 catalog。",
  successCriteria: [
    "tab1 刷新进入可恢复锁定态，仍能读到同一把 Key。",
    "tab2 打开并刷新不会破坏共享 catalog 或旧 peer。",
    "回到 tab1 再刷新仍可恢复，失败时保留脱敏诊断。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 开发 HTTP Coordinator Gate：复现非安全上下文的真实 SharedWorker 链路。 */
export const COORDINATOR_DEV_HTTP_GATE = {
  id: "G-COORDINATOR-DEV-HTTP",
  level: "local-integration",
  requirementIds: ["KM-TECH-001", "KM-INIT-001"],
  startingState: "非 loopback 信任的 Vite dev HTTP origin，真实 Chromium 未注入 Worker 替身。",
  successCriteria: [
    "非安全上下文仍能观察真实 SharedWorker、有效 Web Crypto 和无 Service Worker 的边界。",
    "Local 初始化最终 HMAC 提交成功，目录、Hold 和第一把 Key 都可读回。",
    "Worker 启动错误和页面 fatal crash 均不被吞掉。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 浏览器 Coordinator 生命周期 Gate：验证真实 peer handoff 和迟到 session 隔离。 */
export const COORDINATOR_RUNTIME_LIFECYCLE_GATE = {
  id: "G-COORDINATOR-RUNTIME-LIFECYCLE",
  level: "local-integration",
  requirementIds: ["KM-TECH-001", "KM-LIFECYCLE-001"],
  startingState: "真实生产 E2E hook 已启动两个同源页面，Coordinator 正在承载 owner/session。",
  successCriteria: [
    "旧 tab close 会完成 drain 并把 owner handoff 给存活 peer。",
    "旧 proxy 在撤权后失败，新 owner 的 Storage round-trip 仍成功。",
    "物理断开后的 late session result 被清理，运行态保持可恢复而不复活旧 session。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 本地插件生命周期 Gate：覆盖真实 SharedWorker、Dedicated Worker 和锁屏撤权。 */
export const PLUGIN_LIFECYCLE_PRODUCTION_GATE = {
  id: "G-PLUGIN-LIFECYCLE-PRODUCTION",
  level: "local-integration",
  requirementIds: ["KM-TECH-001", "KM-LIFECYCLE-001"],
  startingState: "生产 preview 的 E2E hook 已装配，浏览器通过真实 Window/Worker/MessagePort 链路运行。",
  successCriteria: [
    "owner Storage 和 crypto 能力来自真实服务端 grant。",
    "锁屏即时拒绝旧 proxy，解锁后得到新的 service instance。",
    "Dedicated Worker dispose 后撤权，不暴露旧能力。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 msfile-nas 页面 Journey：正式 UI 从真实 Go NAS 获取并下载文件。 */
export const REAL_MSFILE_NAS_SCENARIO = {
  id: "J-REAL-MSFILE-NAS",
  level: "msfile",
  requirementIds: ["KM-MSFILE-001"],
  startingState: "Node 从仓库外 MSFile-Proxy-Protocol 构建正式 cmd/msfile-nas，用一次性 NAS 目录、确定性供应商身份和 WebRTC Direct listener 发布夹具文件；浏览器是全新 Chromium context。",
  successCriteria: [
    "设置页保存全局金额上限并保存真实 NAS 公钥与地址，Test connection 显示连接成功且协议协商通过。",
    "文本 Seed 通过正式文件入口显示可获取，预览内容与 NAS 磁盘源文件完全一致。",
    "二进制文件下载后的 SHA-256 与长度等于 NAS 源文件，证明跨 Block 装配和完整性校验成立。",
    "未知 Seed 只显示没有文件，不出现下载入口，也不会被当成成功的读取。",
    "供应商 Read 计数证明读取到达真实 NAS 且没有悬挂请求。",
    "刷新并重新解锁后同一身份仍能用持久化供应商配置再次取得同一文件。",
  ],
  resourceProfile: "p2p",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 BSV8 官方 msfiles 服务 Journey：四个官方示例按正确方式打开。 */
export const REAL_MSFILE_OFFICIAL_SCENARIO = {
  id: "J-REAL-MSFILE-OFFICIAL",
  level: "msfile",
  requirementIds: ["KM-MSFILE-001"],
  startingState: "全新 Chromium context 已完成 Local 初始化；MSFile 系统内置 BSV8 官方供应商（公钥 039da3…26，WSS /dns4/msfiles.bsv8.com/tcp/443/tls/ws）。",
  successCriteria: [
    "内置官方供应商无需手工添加：设置页标记为系统内置且不能删除，Test connection 完成真实 WSS 连接和协议协商。",
    "sample-15s.wav、sample-15s.mp3、sample-30s.mp4 都通过虚拟媒体 URL 进入原生 Range 播放，产生真实 Block 读取，而不是整文件 Blob 下载。",
    "Hello.md 以文本预览打开并显示与源文件一致的内容。",
    "媒体虚拟 URL 的请求携带真实 Range 并由 Service Worker 返回 206。",
  ],
  resourceProfile: "p2p",
} as const satisfies IntegrationScenarioMetadata;

/** MSFile Window executor Gate：保留 Noise、签名、接管和传输边界技术证据。 */
export const MSFILE_EXECUTOR_GATE = {
  id: "G-MSFILE-EXECUTOR",
  level: "msfile",
  requirementIds: ["KM-MSFILE-001", "KM-LIFECYCLE-001"],
  startingState: "临时 Go MSFile supplier、真实 Chromium 和隔离 Window executor 已准备。",
  successCriteria: [
    "真实 Noise/Identify/Peer Record 链路通过生产 parser 和 signer。",
    "并发 executor 只允许一个 owner，关闭后可由另一个 peer 接管。",
    "锁屏、取消和 transferable burst 不泄漏私钥或留下 pending signer 请求。",
  ],
  resourceProfile: "p2p",
} as const satisfies IntegrationScenarioMetadata;

/** MSFile 原生 Range Gate：保留 Service Worker、Range、媒体和撤权边界。 */
export const MSFILE_NATIVE_RANGE_GATE = {
  id: "G-MSFILE-NATIVE-RANGE",
  level: "msfile",
  requirementIds: ["KM-MSFILE-001", "KM-TECH-001", "KM-LIFECYCLE-001"],
  startingState: "临时 Go supplier 与真实生产媒体 Service Worker 已准备，浏览器通过原生媒体元素读取。",
  successCriteria: [
    "Range/416/cancel、尾部 moov 和多种媒体格式走真实 SW/Go 链路。",
    "Worker 重启、旧根 controller、协议不匹配和跨 client 访问均安全收口。",
    "锁屏、换 Key、换 supplier、换文件和 unload 都撤销旧媒体 session。",
  ],
  resourceProfile: "p2p",
} as const satisfies IntegrationScenarioMetadata;

/** MSFile supplier runtime Gate：保留传输、TLS、Connect、并发和接管证据。 */
export const MSFILE_PRODUCTION_RUNTIME_GATE = {
  id: "G-MSFILE-PRODUCTION-RUNTIME",
  level: "msfile",
  requirementIds: ["KM-MSFILE-001", "KM-APPS-001", "KM-LIFECYCLE-001"],
  startingState: "临时 Go supplier 发布 WebRTC/WSS 地址、证书 pin 和测试文件，生产 hook 已启动。",
  successCriteria: [
    "Stat、Seed、Block 和 bounded concurrency 使用真实 supplier。",
    "证书、PeerId、supplier identity 和 Connect SDK/session pin 校验失败时 fail-closed。",
    "锁屏、Key 切换和 tab takeover 后旧 runtime 不再拥有 executor 或输出秘密。",
  ],
  resourceProfile: "p2p",
} as const satisfies IntegrationScenarioMetadata;

/** 部署不可逆 I/O Gate：只接受目标部署注入的真实 runner 结果。 */
export const DEPLOYMENT_IRREVERSIBLE_IO_GATE = {
  id: "G-DEPLOYMENT-IRREVERSIBLE-IO",
  level: "deployment-acceptance",
  requirementIds: ["KM-APPS-001", "KM-LIFECYCLE-001"],
  startingState: "目标部署通过固定 Build ID 提供不可逆 I/O smoke runner。",
  successCriteria: [
    "供应商上传、订阅、广播和支付场景返回结构化真实结果。",
    "每个不可逆操作使用唯一业务 operationId，不能用 transport callId 替代。",
    "未知结果先对账，明确 replayPrevented，不自动重复提交。",
  ],
  resourceProfile: "deployment",
} as const satisfies IntegrationScenarioMetadata;

/** 部署 Coordinator 恢复 Gate：只接受真实部署的 lease 崩溃恢复演练。 */
export const DEPLOYMENT_RECOVERY_GATE = {
  id: "G-DEPLOYMENT-COORDINATOR-RECOVERY",
  level: "deployment-acceptance",
  requirementIds: ["KM-APPS-001", "KM-LIFECYCLE-001"],
  startingState: "目标部署存在活动 final-I/O lease，恢复 runner 使用固定 Build ID。",
  successCriteria: [
    "新 Worker 拒绝旧 lease 抢占，旧操作结束后 retry 才能接管。",
    "旧句柄在新权威下被拒绝，活动 lease 最终归零。",
    "未知外部结果不会被自动重放，并保留可审查 evidenceRef。",
  ],
  resourceProfile: "deployment",
} as const satisfies IntegrationScenarioMetadata;

/** 部署外部 AppView Journey：在固定构建上完成 Connect/Popup session。 */
export const DEPLOYMENT_APPVIEW_CONNECT_SCENARIO = {
  id: "J-DEPLOYMENT-APPVIEW-CONNECT",
  level: "deployment-acceptance",
  requirementIds: ["KM-APPS-001"],
  startingState: "目标部署返回指定不可变 Build ID，外部 AppView origin 和成功选择器均已固定。",
  successCriteria: [
    "正式 Apps 菜单打开 Session Window，并完成绑定部署 origin 的 connect.launch。",
    "外部 AppView 收到 launchToken 和 sessionWindowOrigin，显示真实成功状态。",
    "部署缺少 Build ID、hook、外部 origin 或成功选择器时直接失败。",
  ],
  resourceProfile: "deployment",
} as const satisfies IntegrationScenarioMetadata;
