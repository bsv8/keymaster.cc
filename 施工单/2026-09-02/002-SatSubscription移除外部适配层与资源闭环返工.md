# SatSubscription 移除外部适配层与资源闭环返工单

> 状态：施工中；内部 transport、Worker handler 资源闭环和 C01–C05 定向测试已落地；两次全仓测试、冻结锁文件安装、生产构建和 Go Server 本地 Gate 已通过；外部目录已删除并完成删除后复验；真实多参与方 E2E 与 Go Server release 待完成
>
> 优先级：P0
>
> 目标：取消独立 `SatSubscriptionLibp2p` 项目，把必要的 SSP Stream 适配代码收回 Keymaster；修复取消后 Worker handler 可能无限累积的问题；完成真实发布与 S01–S22 验收。

## 1. 最终架构真值

```text
P2P 网络基础系统插件（不可禁用）
  └─ plugin-window-p2p
       └─ 唯一 bitcoin-libp2p 0.3.0 Host
            ├─ MSFile lane
            └─ SatSubscription lane
                 ├─ 直接使用 bitcoin-libp2p 0.3.0
                 ├─ /ssp/1.0.0 长期 Stream
                 ├─ request_id 响应关联
                 ├─ 入站 Publish
                 └─ SSP/SPI 资源限制
```

边界要求：

- `bitcoin-libp2p 0.3.0` 是身份、Noise、Yamux、Stream 和 uvarint 分帧唯一真值。
- Keymaster 不复制 uvarint 编解码器。
- 不再发布或依赖 `sat-subscription-libp2p` npm 包。
- SSP 业务适配属于 `plugin-sat-subscription` 内部实现，不对 Connect App 暴露。
- Connect App 仍只能调用 `appmsg.*`。
- P2P、MSFile、SatSubscription 都不可禁用。

## 2. 当前阻断问题

### P0-1：外部 adapter 项目没有必要

原依赖为：

```json
"sat-subscription-libp2p": "file:../../../SatSubscriptionLibp2p"
```

该项目只能在当前开发机安装，且目录不是 Git 仓库。决定删除外部 adapter 发布层，
将必要实现迁入 `packages/plugin-sat-subscription`，最终删除精确目录：

```text
/home/david/Workspaces/SatSubscriptionLibp2p
```

### P0-2：取消后的 Worker handler 没有硬上限

Window 入站事件超时后可以释放 bridge Wire，但 Worker 业务 handler 可能仍未返回。
因此必须把“已启动但未 settle 的 Promise”纳入 Worker 权威资源表，而不能只依赖
bridge pending Map 或取消标记。

### Gate-1：全仓测试存在超时抖动

以下 KeyHold 用例使用单测试 15 秒超时，不提高全局测试超时：

- `cross-vault import succeeds with different passwords`；
- `imports the first key into a locked empty Vault and activates it after unlock`
- `new and hex-imported records round-trip through the KeyHold SDK`

### Gate-2：真实 E2E 未完成

双 Supplier、双 Keymaster owner、双 Connect origin、真实 Chromium、真实 Go Server
以及 S01–S22 证据归档必须单独执行；mock 单测通过不能代替真实验收。

## 3. RW2-001：收回 SSP Stream 适配实现

新增内部模块：

```text
packages/plugin-sat-subscription/src/satLibp2pTransport.ts
packages/plugin-sat-subscription/src/satLibp2pTransport.test.ts
```

模块只负责：

- 在 Window P2P Host 上连接 Supplier；
- 校验 Noise 认证后的 Supplier 公钥；
- 打开 `/ssp/1.0.0` 长期 Stream；
- 调用 `bitcoin-libp2p/stream` 的 `readUvarintFrames()` 和 `writeUvarintFrame()`；
- 单 reader、单 writer、request_id 响应关联和入站 Publish；
- SSP/SPI pending、writer、入站 handler 和 framing buffer 资源上限；
- 维护准确的 `sentBoundary`。

禁止：

- 自己实现 uvarint；
- 保留 `uint32be` 或双分帧模式；
- 创建第二个 libp2p Host；
- 读取 Keymaster 私钥；
- 向 Connect App 导出 transport；
- 将该模块设计成独立 SDK 或可发布包。

身份失败规则：地址解析失败或纯拨号失败可以继续尝试下一个地址；已连接但身份
pin 失败必须关闭连接并立即 fail closed，禁止继续 fallback。

## 4. RW2-002：Worker 入站取消与资源闭环

Worker 使用唯一的 `activeSatInboundHandlers` 表，字段含义如下：

```ts
interface ActiveSatInboundHandler {
  leaseId: string;              // Window executor 租约编号
  eventId: string;              // 本次入站事件编号
  supplierId: string;           // Supplier 配置编号
  connectionId: string;         // 真实连接实例编号
  ownerSessionEpoch: string;    // 当前 owner 会话代际
  supplierGeneration: number;   // Supplier 配置代际
  controller: AbortController;  // 通知内部操作取消
  canceled: boolean;             // 是否已经取消
  bridgeBytesReleased: boolean;  // 入站 Wire bridge 额度是否已释放
}
```

集中资源限制：

```ts
maxActiveWorkerInboundHandlers: 64
```

中文含义：SharedWorker 中尚未真正结束的 SatSubscription 入站业务 handler 总数。

执行规则：

- handler 开始前预占 slot；
- `event-cancel` 标记 `canceled`、调用 `AbortController.abort()` 并清除可释放的 Wire；
- 取消不能提前释放 active handler slot；
- 只有实际 Promise settle 后才能删除任务并释放 slot；
- 达到 64 后新入站请求返回稳定失败，不进入业务 handler；
- lock、key switch、lease revoke、连接关闭时取消对应任务；
- 迟到结果必须通过 lease、owner epoch、Supplier generation 和 connection 四元组检查；
- 已取消或过期结果不得写入新连接，不得产生第二次付费请求。

取消状态直接保存在权威任务表中，不再使用无界的
`windowP2pExecutorCanceledInboundEvents` Set。若以后增加 tombstone，必须有数量上限、
TTL 和 lease revoke 清理规则。

## 5. RW2-003：迁移 adapter 测试

原 adapter 的 6 项测试已迁入 `satLibp2pTransport.test.ts`，覆盖以下行为：

1. `/ssp/1.0.0` 使用 uvarint Frame；
2. 一个长期 Stream 处理连续多帧；
3. 并发请求按 `request_id` 乱序返回；
4. 入站 Publish 返回匹配的 ActionResult；
5. Supplier 身份 pin 失败后关闭连接且停止 fallback；
6. 拨号失败可以尝试下一个 multiaddr；
7. writer 严格串行；
8. pending 请求达到上限时 fail closed；
9. response timeout 后结果为 `sentBoundary=unknown`；
10. close/reset/abort 后正常 pending 全部回收。

测试向量只调用或对照 `bitcoin-libp2p 0.3.0`，不在测试中重新实现分帧器。

## 6. RW2-004：资源攻击定向测试

Worker 已增加 C01–C05：

- C01：永不返回的 handler 被取消后仍保留 slot，直到 Promise settle；
- C02：取消后的迟到成功不会回写 ActionResult；
- C03：lease revoke 会 abort 所有仍在等待的入站任务；
- C04：Supplier generation 变化后丢弃迟到成功；
- C05：64 个 active handler 后第 65 个 fail closed，取消后仍等待真实 settle。

Window executor 已覆盖以下闭环：填满 32 MiB 后 waiter 被 timeout/release，额度释放
后超时事件不得重新发送；已发送事件通过 `event-cancel` 通知 Worker；裸
`Uint8Array` 响应使用精确长度的 transferable buffer。

## 7. RW2-005：稳定全仓测试

只为明确耗时的 KeyHold 用例设置 15 秒单测试超时，不提高全局默认值。正式验收时
必须连续执行两次 `pnpm test`，并在删除外部目录后再次安装、测试和构建。

## 8. RW2-006：真实服务端和浏览器验收

真实环境必须包含：

- 两个不同 Supplier identity；
- 两个不同 Keymaster owner；
- 两个不同 Connect App origin；
- 真实 Chromium；
- 真实 Go SatSubscription Server；
- 真实 Noise/Yamux `/ssp/1.0.0`；
- 真实 SPI Information、充值和 Collect。

继续执行原 S01–S22，重点包括长流乱序、多 Supplier 去重与 ACK 原路、App ACL、离线
先落库后 ACK、owner/Supplier 余额隔离、真实 P2PKH 充值、Collect 幂等、lock/key
switch/takeover/config mutation、Connect App 无 SSP/SPI 原始入口、HubMsg/WebRTC
回归以及敏感数据不越过 Window/Supplier/API result。

## 9. RW2-007：文档更新

两份旧施工单顶部已明确：

- 独立 `SatSubscriptionLibp2p` adapter 方案废弃；
- 不再要求 adapter npm release；
- 当前实现为 Keymaster 内部 `satLibp2pTransport.ts`；
- 正式发布对象只剩 Keymaster 和 Go SatSubscription Server；
- `bitcoin-libp2p 0.3.0` 仍是分帧唯一真值。

## 10. RW2-008：删除外部目录

只能在源码、测试、依赖、lockfile、干净安装、类型检查、构建、Go/TS integration
全部确认后，删除以下精确目录：

```text
/home/david/Workspaces/SatSubscriptionLibp2p
```

删除后不得建立替代 adapter 仓库或同名 workspace package；必须重新执行安装、测试和
构建，证明 Keymaster 在该目录不存在时仍可完整工作。

## 11. 验收命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm test
pnpm build
pnpm docs:connect:build
git diff --check
```

相邻仓库的 Go Server 还需执行：

```bash
go test ./...
go test -race ./...
make integration-typescript
```

最终还必须运行 SatSubscription 真实 Playwright E2E 和 S01–S22 验收脚本。

## 12. 当前落地记录

已完成代码工作：

- 内部 transport 已迁入 `plugin-sat-subscription`，调用 `bitcoin-libp2p 0.3.0` SDK；
- Sat Window lane、测试和 package 依赖已切换到内部模块；
- Worker 已建立 active inbound handler 权威表和 64 项硬上限；
- timeout/cancel 释放 bridge Wire，但只在真实 Promise settle 后回收 handler slot；
- lease revoke、runtime release、连接关闭和配置代际变化均有取消/迟到结果栅栏；
- C01–C05 定向测试、6 项内部 transport 测试和原有 bridge 测试已加入；
- 三个 KeyHold 慢测试已改为单测试 15 秒超时；
- 两份旧施工单已标记独立 adapter 方案废弃并指向本单。

当前验证记录：

- `pnpm typecheck`：通过；
- Worker 定向测试：91 项通过；
- 内部 Sat transport、Sat lane、Window executor、Sat provider 定向测试：20 项通过；
- `pnpm install --offline --ignore-scripts`、删除前后的 `pnpm install --frozen-lockfile`：通过；`file:` 依赖和 lockfile link 已移除；
- `pnpm lint:react-boundaries`、`pnpm build`、`pnpm docs:connect:build`、`git diff --check`：通过；
- `pnpm test` 连续两次：均通过，均为 211 个测试文件；
- Go Server `GOWORK=off go test ./...`、`go test -race ./...`、`go vet ./...` 和 SSP 长流重复抑制集成测试：通过。

以下事项尚未完成，不得声明 SatSubscription 能力完成：

- 双 Supplier、双 owner、双 origin 真实 E2E；
- S01–S22 真实供应商验收和证据归档；
- Go SatSubscription Server 正式 commit/release；
- PostgreSQL-backed `make integration-typescript`（当前环境未设置 `SAT_SUBSCRIPTION_TEST_DSN`）；
- 上述真实验收需要外部 Supplier、浏览器和 PostgreSQL 验收环境。

## 13. 完成定义

- [x] Keymaster 不再依赖 `sat-subscription-libp2p`。
- [x] 必要 SSP transport 已成为 `plugin-sat-subscription` 内部模块。
- [x] SSP 分帧只调用 `bitcoin-libp2p 0.3.0`。
- [x] 不存在 Sat 自建 uvarint codec 或双分帧模式。
- [x] 原 adapter 测试全部迁移。
- [x] Worker active inbound handler 有真实硬上限。
- [x] timeout/cancel 不再造成 handler 和取消状态无限累积。
- [x] ACK claim、bridge、writer、pending 上限继续通过。
- [x] Connect App 仍只能访问 `appmsg.*`。
- [x] 全仓测试连续两次通过。
- [x] 冻结锁文件安装和生产构建通过。
- [ ] PostgreSQL-backed `make integration-typescript` 通过。
- [ ] 双 Supplier、双 owner、双 origin 真实 E2E 通过。
- [ ] S01–S22 证据归档完成。
- [ ] Go Server 有可定位的正式 commit/release。
- [x] `/home/david/Workspaces/SatSubscriptionLibp2p` 已删除。
- [x] 删除外部目录后重新安装、测试和构建仍通过。

只有全部勾选后，才可以声明 SatSubscription 能力建立完成。
