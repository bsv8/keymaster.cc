# Keymaster 文档索引

这里只记录当前有效的需求和设计。历史方案、施工步骤与阶段性验收记录由 Git 历史保存，
不再作为现行文档。

| 主题 | 现行文档 | 主要回答 |
| --- | --- | --- |
| 项目总览 | [README](../README.md) | 项目做什么、如何开发 |
| 架构 | [架构](./架构.md) | 模块如何协作、权限如何流动 |
| 存储 | [存储](./存储.md) | 桶、Hold、中央 K-V 和初始化 |
| 插件生命周期 | [插件生命周期](./插件生命周期.md) | WebLoom、运行作用域、锁定与升级 |
| Connect | [Connect](./Connect.md) | 外部 App 会话、能力和身份边界 |
| P2PKH | [P2PKH](./P2PKH.md) | 链上事实、本地交易和转账 |
| MSFile | [MSFile](./MSFile.md) | 文件读取、价格、并发和媒体播放 |
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

- [BitFS 本地 MSFile 与卖方模式需求](./proposals/msfile/BitFS本地代理与卖方模式需求.md)
- [BitFS 本地 MSFile 与卖方模式施工单](./proposals/msfile/BitFS本地代理与卖方模式施工单.md)
