# Keymaster / RocKey 产品 E2E 需求与施工单

2026-10-10：本期验证既定单笔/会话额度、硬件基础确认、真实 VLP 连接与签名；不加入信用信息或其它业务。

跨项目主设计：[产品 E2E 设计与施工单](../../../../BSV8_VaultLinkProtocol/docs/产品E2E设计与施工单.md)。

## 装配边界

`Coding/keymaster/e2e-rockey` 是独立测试入口，不发布到 Keymaster App。

Window 使用正式 openWindowUsbBridge；真实 USB 测试复用层只搬运 VLP 字节，交给正式 MessagePort 租约和 WorkerUsbTransport。Worker 装配正式 HardwareConnectionOwner、VaultLinkHardwareBackend 和 HardwareWalletPayments，执行真实注册、配置、会话、签名、取消及关闭命令。付款结果来自硬件并由实际后端验签，不使用成功替身。

自动流程观察设备审核状态并模拟 A/B/C 原始电平，不能从 Keymaster RPC 传入“硬件已同意”。Keymaster 的正常页面、Coordinator 私有服务和产品 SDK 导出不增加测试接口。

这条 E2E 证明产品 Worker 适配器至硬件的链路；独立装配不证明完整 App 的所有页面。现有完整 App 初始化/软件钱包浏览器测试和软件超额弹窗真实核心测试继续保留。最终正式固件验收还必须实际打开 Keymaster App，在设置/发送页面执行连接、渠道注册/设置、自动支付与超额提示。

## 状态

- [x] 测试 Window→真实 Worker 装配。
- [x] 实际持有权验证、钱包身份文档及硬件付款服务。
- [x] 22 项跨项目 USB 场景入口，包括 Connect/BitFS 两种费用池。
- [x] 浏览器启动/真实 Worker 初始化与缺设备失败验证。
- [x] 软件超额弹窗、硬件 Coordinator/身份记录相关回归。
- [x] 真机执行 USB 自动流程 22/22，包括 Connect/BitFS 两种费用池及重启恢复。
- [ ] 正式固件在完整 Keymaster App 中的人工确认。
- [ ] 双向迁移、真实掉电和其它签名 Profile 的真机验收。

统一运行命令见 [VLP 产品 E2E 入口](../../../../BSV8_VaultLinkProtocol/Coding/BSV8_VaultLinkProtocol/integration/rockey/README.md)。输出报告区分实际硬件通过和人工待验收，不因设备缺失跳过后宣布完成。

2026-10-11：真实 Worker / Web Serial / RocKey 产品固件完整自动流程通过，机器结果 22/22。完整 App 页面与正式固件实体操作仍按上述人工门禁验收。见 [跨项目验收记录与原始证据](../../../../BSV8_VaultLinkProtocol/reports/2026-10-11-产品E2E验收.md)。
