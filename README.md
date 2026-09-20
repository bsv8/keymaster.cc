# Keymaster

Keymaster 是本地优先的 BSV 浏览器钱包。它负责保管私钥，并通过受控的插件和
Connect 会话提供身份、签名、加密、资产、消息、文件及应用存储能力。

## 当前能力

- 多桶存储：浏览器 Local 桶或兼容 S3 的远程桶。
- 多 Key：私钥密文只存在桶内 Hold 快照，页面和业务插件拿不到私钥。
- P2PKH：主网/测试网余额、链上历史、本地交易、转账和 UTXO 快照刷新。
- Channel：消息、联系人在线状态、WebRTC 信令和外部 App 频道。
- MSFile：多供应商文件查询、读取、下载及原生 Range 媒体播放。
- Connect：外部 App 的会话、身份、签名、加密、转账、频道和隔离存储。
- 插件运行时：WebLoom 管理依赖、作用域、撤权和跨页面生命周期。

## 运行结构

```text
浏览器页面：界面、用户操作、浏览器专属网络能力
       ↓ 受限服务代理
Coordinator SharedWorker：桶、Key 会话、任务和跨页面唯一运行态
       ↓
Local / S3、WOC、MSFile / SatSubscription 等外部服务
```

所有敏感操作都绑定当前桶、Owner、会话和运行世代。锁定、切 Key、切桶或插件停用
后，旧句柄和迟到结果必须失效。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm lint:boundaries
pnpm test
pnpm build
pnpm dev
```

集成测试和真实资源测试不是默认单元测试的一部分，运行方法见
[集成测试说明](docs/集成测试/README.md)。

## 文档

从 [文档索引](docs/README.md) 开始阅读。项目不再长期保存施工单；当前行为写入对应
主题文档，精确字段以带中文注释的契约代码为准，测试结果以覆盖矩阵为准。
