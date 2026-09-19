# SatSubscription 与 Channel

SatSubscription 管理多个 SSP Supplier（订阅服务供应商）、SPI 资金和物理连接；Channel 是
内部插件与 Connect App 使用的唯一消息抽象。HubMsg、HubCast 和独立适配层已经退出架构。

## 运行结构

```text
业务插件 / Connect App
→ caller-scoped Channel Runtime（绑定调用者的频道接口）
→ Coordinator：签名、验签、订阅合并、去重、ACK 和状态
→ Window P2P Host 的 Sat lane
→ /ssp/1.0.0 与 /spi/1.0.0 Supplier
```

每个 Supplier 配置包含本地编号、名称、固定公钥、可拨号地址和启用状态。当前 Owner 选择一个
默认发布 Supplier，也可以选择多个接收 Supplier。配置变化推进 `supplierGeneration`（供应商
代际），旧连接和请求不能复用。

首次配置（或用户清空供应商列表后）会写入缺省供应商 `bsv8`：`npm run dev` 使用 testnet
网关，`npm run build` / `npm run build:production` 使用 mainnet 网关。缺省供应商是**出口**
（新消息默认从它发布）；**入口**不做单一化，所有被选为接收方的供应商都会侦听。用户可以
在系统设置里追加更多供应商并调整出口与接收选择。

## Channel 语义

- `channel.publish` 发布到区分大小写的精确频道，不接受通配符。
- `channel.subscription_set` 替换当前调用者贡献的完整频道集合；空数组表示释放。
- Coordinator 合并各插件和 Connect 会话的逻辑集合，再维护物理订阅。
- Connect App 不选择 Supplier，不接触 SSP/SPI wire（底层报文）、私钥或付款配置。
- 私密消息只走当前 Owner 固定 inbox；未知私密协议拒绝，不转发给 App。
- 公共消息、私密消息和 Hash Request 使用不同本地去重命名空间，避免相同编号互相误判。
- 发布成功表示本地操作被接受，不代表远端已经收到或阅读。

联系人在线状态使用 `bsv8.ping.v1` 的 Ping/Pong。它表达最近一次可达性，不是永久在线保证，
也不提供远端历史查询。

## BSV 价格展示

Keymaster 与 Connect App 通过 `price.get`（一次）和 `price.changed`（先
`price.subscribe`）读取 BSV 展示价：只有金额 + 单位，不暴露发布服务器、频道或交易对。
设置里可以登记多个 PriceCast 发布服务器，但只订阅当前激活服务器的频道；交易对选项来自
已收到的行情列表，缺省为生产公钥 + `gate/bsvusdt`。

价格只用于和 sats 相乘做参考显示，不进入业务判断。mainnet 使用实时价，testnet 固定显示
0；未配置、未收到快照或订阅出错时显示 `0.00`，错误详情只在 BSV Price 页面呈现。

## SPI 资金

- SPI Information 返回货币、网络、充值地址和余额；金额使用 `bigint`，不能用 JS `number`。
- BSV 正式网络名为 `mainnet` / `testnet`，转换为 P2PKH 的 `main` / `test` 后再充值。
- 充值先生成 P2PKH 预览，用户确认且配置代际仍一致时才广播。
- 每次主动回收创建新的 request ID（请求编号）。结果未知时只允许重发已保存的同一份 wire，
  不能重新读取余额后构造新请求。
- 旧记录缺少 Owner、会话代际或原始 wire 时只能人工对账，禁止自动恢复。

## 生命周期与限制

P2P Host 只有一个 Window 执行租约，MSFile 和 Sat 使用独立 lane。Worker 对待响应请求、写入
队列、入站 handler、ACK 和桥接字节都有硬上限。锁定、切 Key、删除 Supplier 或代际变化会
先撤权再关闭连接；网络超时不能被当成明确失败或成功。

## 验收状态

内部传输、资源上限、去重、Owner/代际隔离和 Chromium 设置页连接已有测试。真实页面已经
验证错误身份失败和正确身份 online；充值、消费、重复 request ID、WebRTC Direct 及双方账本
对账仍未完成，以[覆盖矩阵](./集成测试/覆盖矩阵.md)为准。
