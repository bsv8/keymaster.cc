# Proposals

这里存放尚未进入正式协议与实现的设计提案。

- [Connect 外部存储](./connect-storage/README.md)：通过 Keymaster Connect 为经过开发者身份验证的第三方应用提供隔离的 S3 存储能力。
- [MSFile 客户端能力](./msfile/README.md)：通过受信任插件 capability 与 Keymaster Connect SDK 提供按哈希 Stat、Seed Read 和 Block Read，并由 Keymaster 统一管理供应商与价格授权。
- [插件生命周期重构](./plugin-lifecycle/design.md)：借鉴 Cordis，统一锁屏、切 Key、依赖启停与权限；配套[施工单](./plugin-lifecycle/implementation-plan.md)，保留现有存储和删除恢复能力。施工证据：[实际能力清单](./plugin-lifecycle/inventory.md)、[Cordis 验证记录](./plugin-lifecycle/cordis-spike.md)、[Connect 策略](./plugin-lifecycle/connect-strategy.md)。
