# Vault 软硬件统一施工单

> 状态：未开工。日期：2026-10-07。全部复选框表示未来任务。
> 需求见 [Vault 软硬件统一需求](./Vault软硬件统一需求.md)。本单只规划 Keymaster 改造；固件由 [Rockey 施工单](../../../../Rockey/docs/施工单.md) 承担。
> 用户本轮只授权写文档，不授权按本单立即实施代码、刷机、熔丝操作或真实资金测试。

## 1. 工作边界

保留已有单 Key、WebLoom 插件边界、Coordinator 唯一权威和 Storage 事务域。不引入钱包列表，不改变 BSV/Channel 既有 wire，不把设备导出能力开放给业务插件。复用当前代码实际 API；已有提案和 README 可能滞后，不能按旧多 Key/多桶描述重建体系。

先定义业务语义，再接设备。支持范围不足时显式不可用，禁止以摘要转发假称硬件已核验。施工期间与 Forum、MSFile/BitFS 等其它变更协调，不能回退其代码或文档。

## 2. G0：联合冻结与调用清单

- [ ] 与 Rockey 完成协议草案 Gate 0，固定版本、编码、算法、限额、请求/结果未知处理和黄金向量目录。
- [ ] 完成签名/解密调用清单：Vault、P2PKH、Protocol/Connect/appView、Channel、P2P identity、订阅、MSFile/BitFS、Forum、Token 和藏品；逐项标出实际调用文件、协议语义、解析器、是否预签/付款/释放明文。
- [ ] 在 M5Stack 具体型号上确认 USB 与浏览器支持、Window/Worker 传输桥、失活检测和权限请求位置。未选型前提供 transport 模型，不预设原生 HID。
- [ ] 冻结软件记录向后兼容、硬件公开绑定格式、迁移 journal 与注销事务范围；确认“不保留旧软件封装”建议。
- [ ] 冻结隐私与授权边界：App 验证 proof 不等同于设备验证 origin；主机自报文本不得升级为可信身份。

门禁：共同协议版本及黄金向量双方可引用；每个现有敏感调用有归属，不支持项公开列出。输出的是规格，不算实现通过。

## 3. K1：统一后端与生命周期契约

主要单元：`packages/contracts/src/vault.ts`、`activeKeyCrypto.ts`、`vaultSession.ts`、`sessionCoordinator.ts`、`workerTransfer.ts`；`packages/plugin-vault/src/publicVaultService.ts`、`vaultServiceCoordinator.ts`、`workerActiveKeyCrypto.ts`、`workerKeySession.ts`。

- [ ] 定义软件/硬件后端、版本化语义操作、能力声明、取消/等待用户/否决/未知结果等类型；字段中文注释。
- [ ] 区分连接、设备解锁、钱包会话和操作授权；让 unlocked 不再隐含 Worker 持有私钥。
- [ ] 将软件密码校验留在软件认证路径；硬件认证和 appView 授权不传 PIN、不伪造 verifyPassword 成功。
- [ ] 把软件原语包在软件后端内部，统一能力不泄露私钥、设备对象、内部 coordinator 或 unrestricted signDigest。
- [ ] 绑定钱包、公钥、运行/会话/后端世代与 App/consumer；缓存方法与异步结果也检查撤权。

门禁：类型与能力边界检查通过；软件创建、解锁、锁定、消息及本地秘密回归通过；旧句柄无法用于新后端。

## 4. K2：单 Key 存储、绑定与注销

主要单元：`walletKeyRepository.ts`、`walletLifecycleService.ts`、`walletControlExecutor.ts`、`walletStateAccess.ts`；`packages/platform-storage/src/coordinator/` 与现有 storage internal 契约。

- [ ] 固定路径钱包记录支持旧软件 KeyHold 和版本化硬件公开记录，保持唯一身份结构约束。
- [ ] 新增后端条件替换和公开迁移 journal；事务内核对公钥、revision、钱包世代。
- [ ] 不匹配设备只能拒绝，不能自动重置、创建第二 Key 或访问旧数据。
- [ ] 注销先撤权与停止 I/O，再按当前格式清理全部钱包数据；跨 Tab 同步、新世代初始化、失败恢复明确。
- [ ] 同 Key 后端迁移保留业务数据及身份世代，但推进后端/会话世代；迁移完成不保留软件自动回退副本。

门禁：并发初始化/迁移/注销只有合法提交；损坏或过新格式不退回空钱包；删除后迟到写入不复活。

## 5. K3：USB 会话与硬件代理

归属：Vault 内部 Window transport 与 Worker 后端代理；`apps/web` 只做最低限度装配，不持有业务私钥。

- [ ] 建立唯一连接桥租约，多 Tab/页面占用、控制页关闭、断线及失活回收明确。
- [ ] 能力协商、实体确认配对码、认证加密、分片、关联/重放校验、队列上限和错误映射。
- [ ] 设备用挑战签名证明当前钱包 Key，浏览器核验；设备编号或 VID/PID 不作证明。
- [ ] 锁定/撤权发送到设备，设备主动取消事件同步到 Coordinator；链路失活时双方拒绝执行，重连发新世代。
- [ ] 结果未知不自动重发；已签/已交付/已广播分别表示，不把 timeout 当成“未签”。

门禁：模拟 transport 的失序/断片/重放/拒绝测试通过；真浏览器真 USB 另行验收，模拟器不能替代。

## 6. K4：语义操作与现有插件接入

- [ ] P2PKH：改造 `p2pkhTransferService.ts`、`p2pkhSigner.ts` 和 protocol spend 入口；费用求解不再调用真实签名，稳定交易提交一次授权；设备拒绝后不广播。
- [ ] 输入金额/脚本来源证据与找零归属可由设备校验；不信任主机简单标注 change 或 fee。冻结支持的 sighash 和脚本范围。
- [ ] Protocol/Connect：身份和 intent 的规范对象、challenge、App proof/主机声明标识与会话范围接入同一后端。
- [ ] Channel：public/hash/private 的签名与 seal/open 改用操作能力；会话范围不覆盖订阅付款或任意 digest。
- [ ] 本地秘密：保持 `active-key-hkdf-v1`、v3 字段、现有盐/AAD 与 scope 校验；设备内部派生并 seal/open，小秘密按授权返回 Worker。
- [ ] P2P identity、BitFS/订阅/Forum 等签名逐项接入；真实资金协议未有设备解析器前标成不支持，不套 Channel 持续允许。
- [ ] 大文件只在明确授权下释放用途限定的数据密钥；把“主机获得解密能力”与长期私钥保密分开说明。

门禁：TS/设备黄金向量双向验签、旧消息解封、旧 v3 秘密解封；软件功能回归；预览无签名、语义/摘要不一致拒绝。

## 7. K5：迁移、迁回与恢复

- [ ] 软迁硬向导：冻结任务、认证导入、原子设备保存、兼容检查、条件切换和内存清理。
- [ ] 迁移 ID/journal 不含 Key、密码、PIN、解封明文；每个设备/浏览器提交点加入断电/崩溃恢复案例。
- [ ] 主机提交前保留软件可恢复记录；提交后设备缺席呈现待连接，不回退软件。
- [ ] 建立专用 Worker 一次性硬迁软导入，验证并以新软件密码封装；先冻结设备残留副本及擦除规则。
- [ ] 与设备备份流程联调准确单 Key 恢复；明确 KeyHold 不是完整业务数据库备份。

门禁：双向同 Key 迁移后数据可用；失败时原数据不丢；Key 导出需设备主动进入、重新认证和物理确认，普通 App 请求不可触发。

## 8. K6：主机 UI 与设备阅读联动

主要单元：Vault 内部创建/解锁/设置/重置页面、Protocol 的 appView/Connect 授权页，以及业务转账预览。

- [ ] 唯一钱包入口区分软件创建/导入、硬件新绑定和当前软件迁入；已有钱包禁止不同 Key 覆盖。
- [ ] 硬件等待、未解锁、待物理确认、持续否决、不支持、断线、忙和结果未知分别显示；不出现浏览器 PIN 输入框。
- [ ] 主机提供冻结的结构化可信度/证据包；设备决定徽标与风险模板；变更内容取消旧请求重新确认。
- [ ] 设备撤销持续决定后，主机下一次正常请求重新进入授权流程；持续否决不循环弹窗重试。
- [ ] 迁回提示“私钥将进入软件环境”，注销提示删除本地业务数据，设备擦除另行说明。

门禁：长文、完整公钥、缺字、错误证明、读到中途取消/锁定/替换请求联调符合 Rockey UX。

## 9. K7：联合验收与稳定文档

- [ ] 将需求 KM-RK-01 至 09 映射到独立 Journey/Gate，实际证据仅维护 `docs/集成测试/覆盖矩阵.yaml`，生成 Markdown。
- [ ] 执行针对性单元/契约测试、类型与边界检查、生产构建；再做真浏览器、真 USB、真按钮和设备重启测试。
- [ ] 回归现有软件身份、P2PKH、Channel、MSFile、BitFS 和 Connect 路径；未支持硬件项不假称通过。
- [ ] 合并稳定结论到 `docs/架构.md`、`存储.md`、`Connect.md`、`P2PKH.md`、Channel/BitFS 文档；修正 README 的旧多 Key/多桶描述。

完成条件：需求门禁均有对应证据；真实硬件交互不以模拟器替代；未完成扩展明确列出。当前文档提交不运行业务测试、不修改覆盖矩阵状态。
