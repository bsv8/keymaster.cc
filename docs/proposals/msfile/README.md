# MSFile 客户端能力提案

> 状态：架构 Spike 与 KMMF-001–007 已实现并通过测试；KMMF-004 生产网络
> Runtime 已完成真实 Chromium/Go supplier 验收。KMMF-008 因缺少外部发布
> 环境保持 BLOCKED，插件仍默认关闭。本文不是已上线能力声明。

## 实施状态矩阵

| 工单 | 状态 | 说明 |
|---|---|---|
| KMMF-000 架构 Spike | ✅ PASS | `bitcoin-libp2p@0.1.0` TypedSigner、真实 Chromium/SharedWorker、Go WebRTC Direct + Noise、lease/epoch 与双向 transferable 均已取证；见 [证据报告](./001-executor-spike-evidence.md) |
| KMMF-001 Contracts | ✅ 完成 | 类型/方法/错误码/规范化纯函数；含 SDK public exports |
| KMMF-002 Frame codec | ✅ 完成 | uvarint/dCBOR/attachment decoder、乱序关联、hash+尺寸校验；增量 SHA-256 已就绪供 executor 流式使用 |
| KMMF-003 DB/设置页 | ✅ 完成 | `keymaster.msfile`、供应商 PeerId pin、价格限制、App override UI |
| KMMF-004 libp2p runtime | ✅ PASS | WebRTC Direct/WSS、trusted/Connect、并发、identity pin 与 lifecycle 已由正式 Go supplier E2E 取证；见 [002 证据](./002-production-runtime-evidence.md) |
| KMMF-005 Trusted service | ✅ 完成 | trusted 只走全局额度；Seed 精确长度校验消费 Stat file size 缓存 |
| KMMF-006 Connect gateway | ✅ 完成 | session/identity/grant 复核、一次/永久提额、脱敏审批事件、popup 确认视图 |
| KMMF-007 Protocol + SDK | ✅ 完成 | strict 校验拒绝金额/身份注入字段；SDK 仅三个 MSFile 方法 |
| KMMF-008 发布互操作 | ⛔ BLOCKED-ENV | Chromium 无头预验收通过；缺 Firefox/Safari、公共 CA/公网 UDP、目标 NAS；见 [003 报告](./003-headless-preflight-evidence.md) |

插件当前 `defaultEnabled: false`；KMMF-008 发布互操作全部通过后再默认启用。本提案把 MSFile Proxy Protocol V1 接入 Keymaster：内部插件直接消费
`msfile.service`，Connect App 通过 session、App Identity 和 Keymaster 管理的价格授权
调用公开方法。Connect App 不取得 libp2p host、私钥、transport 或付款额度控制权。

协议真值来自相邻仓库：

- `$MSFILE_PROXY_PROTOCOL_DIR/docs/protocol/wire-messages.zh.md`
- `$MSFILE_PROXY_PROTOCOL_DIR/docs/protocol/network.zh.md`

Keymaster 层已经确认的产品口径：

1. wire 层仍使用统一的 `Read(content_hash, max_price_satoshis)`；
2. Keymaster service 与 Connect SDK 显式区分 Seed Read 和 Block Read；
3. Read 调用不接受 `maxPriceSatoshis`，金额只能来自 Keymaster 设置或用户确认；
4. 全局设置分别保存 Seed 与 Block 单个内容对象的最高金额，`0` 明确表示不限；
5. Connect App 可以按稳定 App Identity 覆盖两项金额，字段缺失表示继承全局设置；
6. 超额时可以拒绝、本次授权，或持久授权该 App 到新的上限；
7. 授权是 App 级金额策略，不是文件级许可；不设计 access/grant、文件 ID 或 blockIndex；
8. 设置中必须包含供应商配置页面，支持多个供应商及多个可拨号地址；
9. Vault lock 或 active key 切换立即关闭旧 libp2p host 和全部连接。

总设计见 [MSFile Keymaster V1 施工单](./implementation-plan.md)。后续按顺序独立派发：

1. [001 Remote Signer 与 Window Executor 架构 Spike](../../../施工单/2026-08-26/001-msfile-remote-signer-window-executor-spike.md)；
2. [002 生产 Runtime 与真实数据面](../../../施工单/2026-08-26/002-msfile-production-runtime.md)；
3. [003 跨环境互操作与正式发布验收](../../../施工单/2026-08-26/003-msfile-interop-release-acceptance.md)。
