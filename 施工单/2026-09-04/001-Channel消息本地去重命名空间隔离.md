# Channel 消息本地去重命名空间隔离施工单

> 状态：已完成
>
> 优先级：P1
>
> 目标：隔离 Keymaster Coordinator 内公共消息、私密消息与 Hash Request 的本地去重 key，避免不同协议消息在共享集合中互相误判为重复。

## 1. 问题边界

该问题只属于 Keymaster 内部实现，不属于 `bsv8-channel-protocol` 协议或 SDK：

- SDK 为公共消息返回 `(channel, from_public_key, message_id)`；
- SDK 为私密消息返回 `(protocol, from_public_key, message_id)`；
- 两种结构各自正确；
- Keymaster 将它们拼成字符串后写入同一个 `channelSeenMessages` 集合，但原实现没有消息类型命名空间。

当公共消息 `channel` 与私密消息 `protocol` 相同，并且二者的发送者和 `message_id` 也相同时，原 key 完全相同，后到的合法消息会被错误丢弃。

## 2. 冻结方案

共享集合继续保留，不新增第二套缓存或生命周期机制。所有写入必须先增加本地类型前缀：

```text
私密消息       private\0<protocol>\0<from_public_key>\0<message_id>
公共消息       public\0<channel>\0<from_public_key>\0<message_id>
Hash Request  hash-request\0<relation_key>
```

约束：

1. 命名空间只用于 Keymaster 本地去重，不进入线上消息、签名内容或 SDK API。
2. 不修改 `bsv8-channel-protocol`。
3. 不修改三类消息各自的协议去重字段。
4. `channelHashRequests` 关系索引继续使用原 `relationKey`，不得混入本地 seen 前缀。
5. `CHANNEL_SEEN_LIMIT` 和 FIFO 淘汰语义保持不变。

## 3. 实施结果

- 新增统一的 `channelSeenMessageKey(kind, ...parts)` 构造函数。
- 私密消息写入 `private` 命名空间。
- 公共消息写入 `public` 命名空间。
- Hash Request 写入 `hash-request` 命名空间；关系查询仍使用未加前缀的 `relationKey`。
- 新增测试接缝和回归用例，固定三种消息在业务字段完全可碰撞时仍生成不同 key。

## 4. 验收标准

1. 相同 `firstPart/from_public_key/message_id` 的公共消息和私密消息生成不同 key。
2. Hash Request 不与公共消息或私密消息共享 key。
3. 同类型、同字段重复输入仍生成相同 key，继续被本地去重。
4. Hash Request 写入后仍能通过原关系 key 被 WebRTC offer 查询。
5. TypeScript 类型检查通过。
6. Coordinator Channel 相关测试通过。
7. `git diff --check` 通过。

## 5. 非目标

- 不调整 `bsv8-channel-protocol@0.3.0` 的升级和 patch 删除工作。
- 不改变协议级 digest conflict 处理策略。
- 不增加持久化消息历史或跨 Worker 重启去重。
- 不改变消息 ID 的生成规则。
