# Keymaster 文档索引

这里只记录当前有效的需求和设计。历史方案、施工步骤与阶段性验收记录由 Git 历史保存，
不再作为现行文档。

| 主题 | 现行文档 | 主要回答 |
| --- | --- | --- |
| 项目总览 | [README](../README.md) | 项目做什么、如何开发 |
| 架构 | [架构](./架构.md) | 模块如何协作、权限如何流动 |
| 存储 | [存储](./存储.md) | 单 Key、本机 IndexedDB 数据模型与访问边界 |
| 插件生命周期 | [插件生命周期](./插件生命周期.md) | WebLoom、运行作用域、锁定与升级 |
| Connect | [Connect](./Connect.md) | 外部 App 会话、能力和身份边界 |
| P2PKH | [P2PKH](./P2PKH.md) | 链上事实、本地交易和转账 |
| MSFile | [MSFile](./MSFile.md) | 文件读取、价格、并发和媒体播放 |
| Forum | [Forum](./Forum.md) | 索引浏览、正文与签名发布、资金回收 |
| BitFS 文件买卖 | [BitFS 文档索引](./bitfs/README.md) | 买方、卖方、资金、交易、签名和恢复 |
| SatSubscription / Channel | [SatSubscription 与 Channel](./SatSubscription与Channel.md) | 供应商、频道、消息和 SPI 资金 |
| 集成测试 | [集成测试](./集成测试/README.md) | 测试层级、运行方法和证据状态 |
| Connect SDK 使用手册 | [文档站](../apps/connect-docs/site/index.md) | 外部开发者如何接入 |

## 维护规则

1. 每个主题只修改上表中的现行文档，不新建“新版”“返工版”或施工单。
2. 文档写稳定行为、边界和未完成事项，不记录文件级施工步骤和一次性命令输出。
3. 字段首次出现时必须有中文含义；完整字段以 `packages/contracts/src/` 的中文注释为准。
4. 测试证据只维护在 `docs/集成测试/覆盖矩阵.yaml`，Markdown 表由脚本生成。
5. 计划中的行为必须明确标为“未完成”，不能和当前实现混写。

## 未完成提案

提案不是当前行为；完成后应把稳定结论合并回对应主题文档，并由 Git 历史保留施工过程。

- [Vault 软硬件统一需求](./proposals/rockey/Vault软硬件统一需求.md)与[施工单](./proposals/rockey/Vault软硬件统一施工单.md)：未实施。统一软件 Worker 与 Rockey ESP32 后端，保留同 Key 身份和数据，定义注销、USB、操作白名单、设备会话撤权及三按钮长文授权；共同协议草案与固件需求在同级 Rockey 仓库维护。

- [Forum 客户端需求](./proposals/forum/Forum客户端需求.md)与[施工单](./proposals/forum/Forum客户端施工单.md)：**代码已实施，真实最小冒烟通过，完整资源矩阵部分验收**。Worker 发布权威、P2PKH 协议资金/持久提交与 MSFile 内容接入均已装配；真实 Chromium 双页配置共享、锁定和恢复已验证。真实 HTTPS 联合发布、广播后 Go 索引为 A，以及双独立客户端经 MSFile Hash 发现、购买正文、关池和卖方离线后本地阅读已通过；WSS/Direct、浏览器重启和完整资源边界仍待验证（见覆盖矩阵 `KM-FORUM-001`/`KM-FORUM-002`）。

- [单 Key 钱包状态收口施工单](./proposals/webloom-0.6/单Key钱包状态收口施工单.md)：待实施。将 Keyspace 身份读取/变化通知收进 Vault 只读状态能力，迁移消费者后删除旧 API，保留会话与钱包世代失效规则。

- [BitFS 本地 MSFile 与卖方模式需求](./proposals/msfile/BitFS本地代理与卖方模式需求.md)
- [BitFS 本地 MSFile 与卖方模式施工单](./proposals/msfile/BitFS本地代理与卖方模式施工单.md)
- [存储浏览器施工单](./proposals/storage/存储浏览器施工单.md)：代码已实施，真实浏览器验收已覆盖 JSON 预览、渲染量上界、锁定清空与窄屏键盘；Markdown/TXT 渲染与超大目录翻页仍未验证。
- [Keymaster 扁平插件迁移需求（WebLoom 0.6.0）](./proposals/webloom-0.6/Keymaster扁平插件迁移需求.md)与[施工单](./proposals/webloom-0.6/Keymaster扁平插件迁移施工单.md)：待实施。统一插件、显式能力依赖、page 挂载、Storage/Vault 多运行单元与 Connect 边界；按本次明确要求建立迁移提案，不代表现行代码已升级。
