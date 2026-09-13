import type { IntegrationScenarioMetadata } from "./types.js";

/** 本地示例 Journey：初始化后用户可以进入首页菜单。 */
export const LOCAL_INIT_MENU_SCENARIO = {
  id: "J-LOCAL-INIT-MENU",
  level: "local-integration",
  requirementIds: ["KM-INIT-001", "KM-VAULT-001", "KM-NAV-001"],
  startingState: "全新 Chromium context，没有 Local catalog、Vault 或 active Key。",
  successCriteria: [
    "初始化事务只提交一次并创建一把带标签的 Key。",
    "运行态安装完成后进入 Key 管理，Local catalog 只有一个选中桶。",
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

/** 本地设置 Journey：验证正式 registry 提供的设置入口和热切换结果。 */
export const LOCAL_SETTINGS_SCENARIO = {
  id: "J-LOCAL-SETTINGS",
  level: "local-integration",
  requirementIds: ["KM-NAV-001", "KM-SETTINGS-001"],
  startingState: "全新 Chromium context 已完成 Local 初始化，Vault 已解锁且存在 active Key。",
  successCriteria: [
    "系统、应用设置、插件和系统状态入口都由正式业务菜单打开。",
    "语言修改立即反映到页面并持久化到 localStorage，刷新后仍保持合法语言。",
    "插件依赖状态和系统状态页可以读取，设置页失败时保留可诊断结果。",
  ],
  resourceProfile: "local-browser",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 S3 首次初始化 Journey；物理桶由 s3.json 指定，页面创建逻辑桶。 */
export const REAL_S3_INITIALIZATION_SCENARIO = {
  id: "J-REAL-S3-INIT",
  level: "real-resource",
  requirementIds: ["KM-INIT-002"],
  startingState: "s3.json 指定的真实物理桶已取得本轮 lease 并完成开场清理，浏览器是全新 Chromium context。",
  successCriteria: [
    "页面通过正式 S3-compatible 表单完成连接探测，并创建一个真实 S3 后端的逻辑桶。",
    "首个 Hold、Vault 和第一把 Key 提交到本轮 run_id/scenario_id 隔离的远端对象前缀。",
    "刷新后目录、选中桶和第一把 Key 仍可从真实 S3 恢复，访问凭据和桶密码不进入 localStorage。",
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

/** 真实 testnet 资产 Journey；资源未准备时由 real-resource setup fail closed。 */
export const REAL_TESTNET_ASSET_SCENARIO = {
  id: "J-REAL-TESTNET-ASSET",
  level: "real-resource",
  requirementIds: ["KM-ASSET-001"],
  startingState: "真实 testnet 资金库已完成网络、余额、预算和旧账检查，Journey 获得独立一次性钱包。",
  successCriteria: [
    "钱包余额和网络标签来自正式链上 provider，而不是页面 mock。",
    "转账前后本地 submission、广播结果和链上观察可以按 txid 对账。",
    "保护 outpoint、余额不足和广播结果未知均不会被错误地当作普通可重试失败。",
  ],
  resourceProfile: "testnet",
} as const satisfies IntegrationScenarioMetadata;

/** 真实资源层的 SatSubscription 配置投影 Journey；不把投影冒充成页面连接或收费业务。 */
export const REAL_SATSUBSCRIPTION_HEALTH_SCENARIO = {
  id: "J-REAL-SATSUB-HEALTH",
  level: "real-resource",
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
  level: "real-resource",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "全新 Chromium context，用户通过真实 Local 页面建立 active Key；Node 只读取仓库外 Sat 配置。",
  successCriteria: [
    "页面把 satsubscription.json 的 websocket/webrtc-direct libp2p multiaddr 映射为供应商 multiaddrs，并保存真实配置。",
    "正确公钥和地址在页面供应商行显示 online；故意错误公钥在同一页面显示 disconnected 或 degraded。",
    "正确与错误连接结果都来自页面可见文本，不使用 Node WebSocket、Sat API 或 SharedWorker 内部接口断言。",
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
    "浏览器提供 localStorage、Web Crypto 和 SharedWorker 能力。",
    "Local 业务存储的物理入口仍是 localStorage，而不是 IndexedDB。",
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
  level: "real-resource",
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
    "导入后的 Key 标签、公钥归属和 Key 管理页结果可观察。",
    "桶密码和一次性私钥原文不进入 localStorage 或测试附件。",
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

/** MSFile Window executor Gate：保留 Noise、签名、接管和传输边界技术证据。 */
export const MSFILE_EXECUTOR_GATE = {
  id: "G-MSFILE-EXECUTOR",
  level: "local-integration",
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
  level: "local-integration",
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
  level: "local-integration",
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
