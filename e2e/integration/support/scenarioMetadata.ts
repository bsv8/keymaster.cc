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
    "系统、应用设置、插件、日志和系统状态入口都由正式业务菜单打开。",
    "语言修改立即反映到页面并持久化到 localStorage，刷新后仍保持合法语言。",
    "插件依赖状态和统一日志页可以读取，设置页失败时保留可诊断结果。",
  ],
  resourceProfile: "local-browser",
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

/** 真实 SatSubscription Journey；双入口身份和 testnet 由资源层运行时确认。 */
export const REAL_SATSUBSCRIPTION_SCENARIO = {
  id: "J-REAL-SATSUBSCRIPTION",
  level: "real-resource",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "SatSubscription WebSocket 与 WebRTC Direct 已通过同一 testnet 服务身份健康检查。",
  successCriteria: [
    "充值、消费和服务端账本按付款方、发布方和 request_id 闭合。",
    "重复 request_id 返回幂等结果，不产生第二笔收费。",
    "连接中断后的收费结果未知会先对账，不会盲目重发。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 真实资源层的 SatSubscription 健康 Journey；不把健康握手冒充成收费业务。 */
export const REAL_SATSUBSCRIPTION_HEALTH_SCENARIO = {
  id: "J-REAL-SATSUB-HEALTH",
  level: "real-resource",
  requirementIds: ["KM-SATSUB-001"],
  startingState: "resource-setup 已完成 testnet WebSocket 健康握手，并写入脱敏运行状态。",
  successCriteria: [
    "服务运行时返回 testnet 网络和稳定的服务身份公钥。",
    "要求 WebRTC Direct 的运行可以明确区分已验证与未配置，而不是默认为成功。",
    "健康门禁通过不被解释为充值、消费或服务端账本已经闭合。",
  ],
  resourceProfile: "satsubscription",
} as const satisfies IntegrationScenarioMetadata;

/** 真实 MSFile/P2P Journey 的矩阵入口；详细 Range/媒体断言由旧生产 Gate 承担。 */
export const REAL_MSFILE_SCENARIO = {
  id: "J-REAL-MSFILE",
  level: "real-resource",
  requirementIds: ["KM-MSFILE-001"],
  startingState: "临时 MSFile supplier、P2P lease 和测试文件已准备，浏览器使用真实生产构建。",
  successCriteria: [
    "Stat、Seed、Block、Range 和媒体首段读取使用正式 parser/schema。",
    "错误地址、非法范围、取消和锁定不会让旧 lease 继续进行不可逆 I/O。",
    "supplier、浏览器和临时文件在结束时关闭并可验证清理。",
  ],
  resourceProfile: "p2p",
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

/** Node Resource 安全 Gate：用无网络 fake adapter 验证资源边界和结果未知处理。 */
export const RESOURCE_SAFETY_GATE = {
  id: "G-RESOURCE-SAFETY",
  level: "local-integration",
  requirementIds: ["KM-RESOURCE-001"],
  startingState: "Node Resource 使用受控 fake adapter 和临时权限目录，不连接真实外部资源。",
  successCriteria: [
    "配置目录、S3 ownership/lease 和清理范围 fail-closed。",
    "SatSubscription 运行时身份和 testnet 网络不接受配置文字冒充。",
    "testnet 结果未知写入恢复账本且不盲目重发。",
  ],
  resourceProfile: "none",
} as const satisfies IntegrationScenarioMetadata;
