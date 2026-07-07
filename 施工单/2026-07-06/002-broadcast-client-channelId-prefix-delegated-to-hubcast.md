# 002 broadcast core 客户端 channelId 前缀校验下放 HubCast 服务端

## 背景

[001-broadcast-core-and-plugin-hubcast-hard-switch.md](./001-broadcast-core-and-plugin-hubcast-hard-switch.md) 第 §3 / §6.4 条把"core 校验 `channelId` 前缀 owner 与 publisher 一致"写进了客户端实施步骤。但 v1 实际落地时,这条约束的真实归属是 **HubCast 服务端契约**,不属于 `keymaster.cc` 的 broadcast core / contracts 抽象。

本附记用于:

- 记录这次偏差的最终决定;
- 给后续实施者一个明确的指针,避免回到 001 的字面表述去把这条校验补回 `plugin-broadcast`;
- 明确分层边界。

## 最终决定

`channelId` 前缀(owner) 与 `publisherPublicKeyHex` 一致这一约束,**只在 HubCast 服务端 publish 阶段强制**。`plugin-broadcast` / `packages/contracts/src/broadcast.ts` / `plugin-hubcast` 中的客户端路径**不**重复校验。

## 为什么不放在 broadcast core

1. **分层边界**:`packages/contracts/src/broadcast.ts` 是 provider-generic 抽象;`<publisherPublicKeyHex>.<channelPath>` 是 HubCast 专属 channel 命名规则,把它上浮到 core 契约等于把某个 provider 的语义偷偷钉进 provider-generic 接口。
2. **服务端已经够硬**:HubCast 服务端在 `broadcast.publish` 处理链路上既验签也校验 `channelId` 前缀 == publisher,还校验 publisher == bound owner。客户端再叠一层是 defense-in-depth,但重复防线的复杂度大于收益。
3. **服务端是真值的最终权威**:服务端拒收的请求根本不会到达 client fanout,所以客户端即使校验也只是为"服务端出错"做兜底——而服务端出错属于 HubCast 服务端的 bug 域,不该让 broadcast core 替它扛。

## 这次落地的代码改动

| 文件 | 改动 |
|---|---|
| [packages/plugin-broadcast/src/broadcastCore.ts](../../packages/plugin-broadcast/src/broadcastCore.ts) 文件头 | 删去"校验 channelId 前缀 owner 与 publisher 一致",改为"该约束由 HubCast 服务端在 publish 阶段强制,本侧不重复" |
| [packages/plugin-broadcast/src/broadcastCore.ts](../../packages/plugin-broadcast/src/broadcastCore.ts) `onProviderBroadcast` inline 注释 | 同步重写,明确"publisher-vs-bound-owner 与 channelId 前缀一致性的最终校验由 HubCast 服务端完成" |
| [packages/contracts/src/broadcast.ts](../../packages/contracts/src/broadcast.ts) `BroadcastSubscribeInput.handler` 注释 | 删去"core 已经完成 verify → publisher/channel 一致性校验",改为"该约束由 provider 服务端在 publish 阶段强制" |
| [packages/contracts/src/broadcast.ts](../../packages/contracts/src/broadcast.ts) `BroadcastProviderOperations.subscribeBroadcasts` 注释 | 同步删去 publisher 一致性校验描述 |
| [packages/plugin-broadcast/src/broadcastCore.test.ts](../../packages/plugin-broadcast/src/broadcastCore.test.ts) line ~405 测试用例 | 重命名为 `provider-generic: core dispatches any verify-passing envelope to its exact-channel subscription regardless of publisher`;用例注释明确**不**是 HubCast 真实链路正例,只是钉住 provider-generic 行为 |

## 这次**没**改的东西(以及为什么)

| 项 | 不改的原因 |
|---|---|
| [001-broadcast-core-and-plugin-hubcast-hard-switch.md](./001-broadcast-core-and-plugin-hubcast-hard-switch.md) 历史正文 | 001 是历史施工单,记录当时的决策;追溯修改历史正文会破坏"施工单是某一时刻的决定"的语义。后续实施者应同时读 001 + 002,本附记就是为这个目的存在。 |
| [HubCast/docs/hubcast-broadcast-v1-requirements.md](../../../HubCast/docs/hubcast-broadcast-v1-requirements.md) 和 [HubCast/施工单/2026-07-06/001-hubcast-broadcast-v1-hard-switch.md](../../../HubCast/施工单/2026-07-06/001-hubcast-broadcast-v1-hard-switch.md) | 它们本来就是服务端契约,本来就对,没有需要改的字面。 |
| `plugin-broadcast` 的运行逻辑和测试断言 | 行为本身没有 bug;只是文档/契约文本与代码不一致。本附记处理的是文档层偏差,不动运行层。 |
| `broadcastCore.ts` publish 侧是否提前校验 `<ownerPubkey>.<path>` 格式 | 也不补到 core。原因同 §"为什么不放在 broadcast core"。如果以后要为 HubCast 提供更好的 UX,应放在 `plugin-hubcast` 这一层(那是 provider 约束的归属),而不是 broadcast core。 |

## 验收

- [x] `packages/plugin-broadcast/src/broadcastCore.ts` 文件头注释已不含"core 校验 channelId 前缀"字样
- [x] `packages/plugin-broadcast/src/broadcastCore.ts` `onProviderBroadcast` inline 注释指向 HubCast 服务端契约
- [x] `packages/contracts/src/broadcast.ts` `BroadcastSubscribeInput.handler` 注释不再声称 core 完成 publisher/channel 一致性校验
- [x] `packages/contracts/src/broadcast.ts` `BroadcastProviderOperations.subscribeBroadcasts` 注释同步
- [x] `packages/plugin-broadcast/src/broadcastCore.test.ts` 跨 publisher 用例改名 + 注释,标明 provider-generic
- [x] 现有测试断言全部不变,继续通过
- [x] 不动 001 历史正文;本附记作为偏差说明存在