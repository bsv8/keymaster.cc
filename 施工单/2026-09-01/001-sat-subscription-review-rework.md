# 001 SatSubscription 审查返工单

> 方案变更（2026-09-02）：本单原计划的独立 `SatSubscriptionLibp2p` adapter
> 已被 [SatSubscription 移除外部适配层与资源闭环返工单](../2026-09-02/002-SatSubscription移除外部适配层与资源闭环返工.md)
> 替代。后续实现以 Keymaster 内部 `satLibp2pTransport.ts` 为准；本单保留为历史
> 审查记录，禁止据此重新建立独立 adapter 项目。

> 状态：复查发现的 3 个实现级 P0 已修复；基础自动化与 Go/TS 长流 Gate 通过；正式发布与真实多参与方验收待完成
>
> 来源：[2026-08-31 SatSubscription、Channel AppMsg 与 SPI 资金能力施工单](../2026-08-31/001-sat-subscription-channel-appmsg-spi-capability.md)
>
> 目标：修复审查发现的传输安全、生命周期、资源上限和发布 Gate 问题，使 SatSubscription 可以进入真实 Supplier 验收。

## 1. 已冻结决策

以下结论已经对齐，实施者不得恢复旧方案。

1. 新建独立的 **P2P 网络基础系统插件**，负责唯一 Window `bitcoin-libp2p` Host、executor lease、TypedSigner bridge 和 lane registry。
2. MSFile 和 SatSubscription 都依赖 P2P 网络基础插件，不能由 MSFile 顺便拥有公共 Host。
3. P2P 网络基础插件、MSFile、SatSubscription 都是系统插件：`defaultEnabled: true`、`canDisable: false`。
4. Vault 锁定、active key 切换、executor lease 丢失或 Window unload 时仍必须关闭 Host；“不可 disable”不表示一直联网。
5. SatSubscription 客户端和服务器统一使用 `bitcoin-libp2p 0.3.0` 的 Stream 分帧能力。
6. `/ssp/1.0.0` 唯一线上格式为：

   ```text
   uvarint(payload.byteLength) || 完整 SSP Wire
   ```

7. TypeScript 使用 `bitcoin-libp2p/stream` 的 `writeUvarintFrame()`、`readUvarintFrames()`；Go 使用 `streamio.NewUvarintFramer()`。
8. 删除 `uint32be`、供应商分帧配置、自动格式猜测和 SatSubscription 自己维护的分帧 codec。
9. Connect App 仍只使用 `appmsg.*`；不得获得原始 SSP、SPI、供应商或资金接口。
10. V1 不增加 App 金额或频率限制；供应商 SPI 余额是消费上限，但浏览器资源硬上限必须执行。

## 2. 目标架构

```text
Coordinator SharedWorker
  ├─ active owner / session epoch / Vault 状态
  ├─ P2P executor lease 与受限 TypedSigner
  ├─ SatSubscription DB、状态机、Channel crypto、SPI 状态
  └─ MSFile 业务状态与并发配置

Window
  └─ P2P 网络基础系统插件
       ├─ 唯一 bitcoin-libp2p 0.3.0 Host
       ├─ executor bridge
       ├─ lane registry
       ├─ MSFile lane
       └─ SatSubscription lane

SatSubscription Supplier
  └─ bitcoin-libp2p 0.3.0
       └─ /ssp/1.0.0 + SDK uvarint framing
```

所有权边界：

| 能力 | 唯一 owner | 中文说明 |
|---|---|---|
| raw private key | SharedWorker | 不进入 Window、Supplier 或 Connect App |
| owner/session epoch | SharedWorker | 裁决旧请求、旧连接和迟到结果 |
| libp2p Host | P2P 网络基础插件（Window） | 当前 owner epoch 只能有一个 |
| P2P lane registry | P2P 网络基础插件（Window） | MSFile、SatSubscription 只注册 lane |
| SSP 分帧 | `bitcoin-libp2p 0.3.0` | SatSubscription 不复制实现 |
| SSP/SPI 业务状态 | SharedWorker | Window 只搬运 Wire |

## 3. 禁止事项

- 不保留 `msfile.executor.*` 作为公共 P2P RPC 的长期别名。
- 不让 MSFile manifest 提供公共 P2P capability。
- 不让 SatSubscription 创建第二个 Host。
- 不保留 `sspFrameEncoding`、`uint32be` 或每供应商分帧选择。
- 不复制 `bitcoin-libp2p 0.3.0` 的 uvarint 编解码代码。
- 不把底层错误压缩成只有英文 `message` 的普通 `Error`。
- 不允许旧连接仅凭相同 `supplierId` 操作新连接。
- 不允许无界 pending、writer queue、入站 handler 或 Worker bridge 队列。
- 不允许缺失 owner/generation/Wire 的 Collect 记录继续重试。
- 不允许以 fake transport 单测替代最终 Go/TypeScript 真实互操作。

## 4. P0-1：抽取 P2P 网络基础系统插件

### 4.1 建议范围

新增：

```text
packages/plugin-window-p2p/
  package.json
  src/index.ts
  src/manifest.ts
  src/windowExecutor.ts
  src/laneRegistry.ts
  src/*.test.ts
```

调整：

```text
packages/contracts/src/windowP2pExecutor.ts
packages/contracts/src/sessionCoordinator.ts
apps/web/src/keymasterSessionCoordinatorClient.ts
apps/web/src/keymasterSessionCoordinator.worker.ts
apps/web/src/pluginCatalog.ts
packages/plugin-msfile/src/manifest.ts
packages/plugin-msfile/src/windowExecutor.ts
packages/plugin-sat-subscription/src/manifest.ts
```

### 4.2 必须完成

- 新插件提供 `WINDOW_P2P_EXECUTOR_CAPABILITY`。
- 新插件创建 lane registry、安装 Window executor，并拥有 Host 的 start/stop。
- Coordinator 中公共 lease、signer、bridge 名称从 `msfileExecutor*` 硬切换为 `windowP2pExecutor*`。
- 公共 Coordinator request kind 从 `msfile.executor.*` 硬切换为 `window-p2p.executor.*`。
- MSFile 的 Stat/Read/Probe/Invalidate 改为 `msfile` lane，不再占用 executor 顶层 operation。
- SatSubscription 保持 `sat-subscription` lane。
- MSFile、SatSubscription 的 manifest 都依赖 `WINDOW_P2P_EXECUTOR_CAPABILITY`。
- 三个插件统一 `defaultEnabled: true`、`canDisable: false`。
- 移除 MSFile 中公共 lane registry 和 Host 安装责任。

### 4.3 生命周期验收

- 同一 session epoch 两个 Tab 竞争时只能产生一个 executor lease、一个 Host。
- Vault lock、key switch、Window unload 立即撤销 lease并关闭所有 lane。
- Window 接管后，MSFile 和 SatSubscription lane 都重新挂载。
- App 页面关闭不关闭同 owner 的共享 Host。
- 插件管理页不能 disable P2P、MSFile、SatSubscription。

## 5. P0-2：统一 bitcoin-libp2p 0.3.0 分帧

### 5.1 跨仓修改

> 本节原有独立 adapter 的跨仓实施步骤已废弃。当前 Keymaster 只在
> `packages/plugin-sat-subscription/src/satLibp2pTransport.ts` 内调用
> `bitcoin-libp2p 0.3.0` Stream/uvarint SDK；Go Server 的真实互操作仍按本单保留。

`/home/david/Workspaces/SatSubscriptionLibp2p`：

- 将 `bitcoin-libp2p` 精确固定为 `0.3.0`。
- 删除本地 `frame.ts` 和重复 codec 测试。
- 删除 `FrameEncoding`、`frameEncoding`、`uint32be`。
- 写入使用 `writeUvarintFrame(stream, wire)`。
- 长流读取使用 `readUvarintFrames(stream, options)`。
- SSP 单条 Wire 上限显式设为 SSP `MaxWireBytes`，不得高于 SDK 安全上限。
- 保留 SSP 层的 request_id 关联、单 writer、入站 Publish/ActionResult 语义；这些不是 framing SDK 的责任。

SatSubscription Go 服务器：

- 固定 `bitcoin-libp2p 0.3.0` 对应 Go module release。
- `/ssp/1.0.0` 使用 `streamio.NewUvarintFramer(stream)`。
- 删除四字节大端长度读写。
- 服务端只从 authenticated Connection 取得 `remote_public_key`。

Keymaster：

- 删除 `SatSupplierConfigV1.sspFrameEncoding`。
- 删除设置页“SSP 分帧”字段和兼容文案。
- 删除 `satCodec.ts` 及其重复分帧测试。
- Keymaster 和 adapter 的 lockfile 必须固定正式 `bitcoin-libp2p 0.3.0`。

### 5.2 分帧验收

- Go/TypeScript 使用 `bitcoin-libp2p 0.3.0` 共用字节向量。
- 覆盖拆包、粘包、连续多 Frame、非最短 uvarint、超限、截断和正常 EOF。
- `/ssp/1.0.0` 不存在 framing 配置或协商字段。
- 仓库中搜索不到 `uint32be` 和 `sspFrameEncoding`。

## 6. P0-3：保留跨 Window/Worker 的传输错误语义

### 6.1 问题

adapter 的 `sentBoundary` 当前经过 Window executor 后只剩错误文本。SharedWorker 无法判断请求是“明确未发送”还是“可能已发送”。这会破坏 SSP 付费操作和 SPI Collect 的幂等策略。

### 6.2 错误契约

新增可序列化错误结构，字段必须有中文注释：

```ts
interface WindowP2pExecutorError {
  domain: "window-p2p" | "sat-transport" | "msfile-transport";
  code: string; // 稳定错误分类，不能依赖英文 message
  message: string; // 仅供诊断，不作为控制流
  sentBoundary?: "not-sent" | "unknown"; // 是否能证明 Wire 尚未发送
}
```

要求：

- Window executor 白名单序列化错误，不传递任意 `cause`。
- SharedWorker 根据 `domain/code/sentBoundary` 恢复 typed error。
- `not-sent` 才允许安全重连后重试。
- `unknown` 必须记录 `unknown_result`，不得自动重发。
- 锁定、代际过期、验证错误不能伪装成网络错误。

### 6.3 验收

- Frame 进入 writer 前失败：结果为明确未发送。
- `stream.send()` 后断流：结果为 `unknown_result`。
- SPI Collect 响应丢失：保存原始 Wire，同 request_id 只能显式重试。
- 错误桥接结果不包含私钥、Channel 明文或任意底层 cause 对象。

## 7. P0-4：连接实例、owner epoch 和 Supplier generation 隔离

### 7.1 新增字段

每次 Supplier connect 生成新的 `connectionId（连接实例编号）`。以下操作和事件必须携带：

```text
supplierId          本地供应商编号
connectionId        本次真实连接实例编号
ownerSessionEpoch   当前 owner/Vault 会话代际
supplierGeneration  当前供应商配置代际
```

适用范围：

- connect result
- requestSsp
- requestSpi
- respondSsp
- close
- inbound `ssp.request` event
- 所有迟到 response/error

### 7.2 裁决规则

- Window lane 只接受与当前连接四元组完全匹配的操作。
- 旧连接的 close 不得关闭同 supplierId 的新连接。
- 旧连接的入站 Publish 不得进入新 handler。
- Supplier key、multiaddr 或配置改变后，旧 generation 全部失效。
- lock/key switch 后，旧 owner epoch 的结果全部丢弃且不得写 DB。
- `subscribeSspRequests` 改成生产接口必选方法，删除无响应的 `subscribeSsp` fallback。

### 7.3 connect 入站竞态

当前 Window 可能在 connect 返回前收到 Publish，而 Worker handler 尚未注册。返工后必须：

- 在发起 connect 前创建有界的 deferred ingress queue；或
- 把 handler 注册与 connect 合并为一个原子业务操作。

不得使用 `if (!handler) return` 静默丢弃请求。

### 7.4 验收

- 旧 connect 迟到不能覆盖新 connect。
- 旧 close 不能关闭新连接。
- 旧入站事件不能进入新 generation。
- connect response 前到达第一条 Publish 仍能获得对应 ActionResult。
- executor takeover 后旧 event/response 全部失效。

## 8. P0-5：浏览器资源硬上限

`bitcoin-libp2p 0.3.0` 已负责 framing reader 的单 Frame、缓冲字节和缓冲 Frame 数上限；SatSubscription 仍需负责业务层上限。

必须定义并集中导出以下常量，禁止散落 magic number：

| 上限 | 中文含义 | 最低要求 |
|---|---|---|
| `maxPendingSspPerSupplier` | 每供应商等待响应的 SSP 请求数 | 达到后新请求 fail closed |
| `maxPendingSpiPerSupplier` | 每供应商等待响应的 SPI 请求数 | 达到后新请求 fail closed |
| `maxWriterQueuedFrames` | 单 writer 等待写入的 Frame 数 | 达到后 reset 或拒绝新请求 |
| `maxWriterQueuedBytes` | 单 writer 排队总字节 | 包含 framing 后实际字节 |
| `maxInboundHandlersPerSupplier` | 每供应商并发入站 Publish 数 | 超限不得无限创建 Promise |
| `maxPendingIncomingPerLane` | Window 等待 Worker 响应的入站数 | 超限关闭或 reset Stream |
| `maxBridgeInFlightBytes` | Window/Worker bridge 在途 Wire 总字节 | Sat lane 必须计入，不得按 0 字节 |
| `maxBridgePendingItems` | bridge 在途操作数 | 防止小消息数量攻击 |

要求：

- 上限是本地 DoS/内存保护，不进入 SSP Wire，不发送给 Supplier。
- 达到上限后必须返回稳定错误码并清理占用。
- Abort、timeout、reset、lock 和 lease revoke 都必须释放计数。
- 不得把 framing SDK 的 1024 Frame 缓冲上限误当成业务 handler 并发上限。

## 9. P1：SPI Collect 恢复必须 fail closed

新建 Collect 时以下字段全部必填并持久化：

```text
requestIdHex        Collect request_id
ownerPublicKeyHex   创建请求的 owner 公钥
ownerGeneration     创建请求的 owner 会话代际
supplierGeneration  创建请求的供应商配置代际
supplierId          供应商编号
requestWire         完整原始 Collect Wire
```

重试规则：

- 任一字段缺失：保持 `unknown_result`，禁止网络重试。
- owner、owner generation、supplier generation 任一不匹配：禁止重试。
- 调用方提交的 Wire 与持久化 Wire 不一致：禁止重试。
- 已成功或明确失败的记录：禁止重试。
- 只有原记录的同一 request_id、同一 Wire 才允许显式恢复。

若存在旧 DB 数据，迁移只允许：

- 已终态记录继续只读；
- 缺少安全字段的 pending/unknown 记录标记为不可恢复；
- 不得用当前 owner/generation 自动补全旧记录。

## 10. 测试与验收

### 10.1 必增自动化测试

P2P 基础插件：

- manifest 不可 disable；
- MSFile、SatSubscription 同时注册 lane；
- 双 Tab 唯一 lease/Host；
- lock、key switch、takeover、Window unload；
- lane stop/start 和重新挂载。

Sat transport：

- connectionId/generation/epoch 四元组校验；
- connect 前第一条 Publish；
- 旧 close、旧 response、旧 event；
- sentBoundary 跨桥接保持；
- pending/writer/inbound/bridge 上限及清理。

SPI：

- response lost 后同 Wire 重试；
- 缺字段旧记录 fail closed；
- owner 或 Supplier generation 改变后禁止重试；
- 同金额的新 Collect 使用新 request_id。

### 10.2 跨仓真实验收

必须使用两个真实 Supplier identity、两个 Keymaster owner、两个 Connect origin：

1. Go server ↔ TypeScript client `/ssp/1.0.0` 长流互操作。
2. 并发 request_id 与乱序响应。
3. 服务端主动 Publish、客户端返回同 request_id ActionResult。
4. 同 owner 的 App A/B 在 Supplier 侧观察到相同 `remote_public_key`。
5. 两个 Supplier 同时订阅接收，普通发布只走默认 Supplier。
6. 多 Supplier Deliver 去重、冲突拒绝、ACK 原路。
7. 断流后的 SSP 付费操作不隐藏重发。
8. SPI Information、真实充值、响应丢失后的幂等 Collect。
9. lock/key switch/executor takeover/config mutation 使旧结果失效。
10. Connect runtime 中不存在原始 SSP/SPI 方法。

### 10.3 命令

Keymaster：

```bash
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/plugin-window-p2p/src
pnpm exec vitest run packages/plugin-msfile/src
pnpm exec vitest run packages/plugin-sat-subscription/src
pnpm exec vitest run packages/plugin-appmsg/src packages/plugin-protocol/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm exec vitest run packages/connect/src
pnpm docs:connect:build
pnpm build
pnpm test
pnpm exec playwright test <SatSubscription real-provider E2E>
```

`bitcoin-libp2p 0.3.0`：

```bash
go test -race ./...
npm test --prefix typescript
node scripts/test-framing-integration.mjs
```

SatSubscription adapter/server：

```bash
# 具体命令由各仓库 package/script 固定，必须覆盖：
# - Go tests
# - TypeScript tests
# - Go/TypeScript /ssp/1.0.0 integration
```

## 11. 实施顺序

```text
R01 固定 bitcoin-libp2p 0.3.0 framing 真值
  -> R02 抽取 P2P 网络基础系统插件
  -> R03 MSFile 改为 lane
  -> R04 Sat adapter 删除自建 framing/uint32be
  -> R05 typed error bridge + sentBoundary
  -> R06 connectionId/epoch/generation 隔离 + 首条 Publish 竞态
  -> R07 资源硬上限
  -> R08 Collect fail closed
  -> R09 单元/Worker/双 Tab 测试
  -> R10 Go/TS 真实互操作与双 Supplier E2E
  -> R11 正式 release、固定版本和 lockfile
```

前一项未通过 Gate，不得把后一项标记为完成。

## 12. 本次返工落地与验证记录

### 已落地

- 新增 `plugin-window-p2p` 系统插件，统一拥有 Window `bitcoin-libp2p 0.3.0` Host、executor lease、TypedSigner 和 lane registry；MSFile、SatSubscription 均改为挂载业务 lane。
- Window/Worker 公共 executor 已硬切换为 `window-p2p.executor.*`；MSFile 不再拥有公共 Host。
- SatSubscription adapter、Keymaster client/server 和 Go server 统一使用 `/ssp/1.0.0` + SDK uvarint framing；删除 Sat 自建 codec、`uint32be` 和 `sspFrameEncoding`。
- 补齐序列化 typed error、`sentBoundary`、connectionId/ownerSessionEpoch/supplierGeneration 四元组校验、connect 前入站队列和旧连接 fence。
- 集中定义 SSP/SPI、writer、入站 handler、lane pending 和 Window/Worker bridge 的资源上限，并在 reset、abort、timeout、lock、lease revoke 路径释放占用。
- 入站 Publish 增加 `deliveryId` 与 `ackClaimToken`；SharedWorker 维护 `pending -> claimed -> ack_sending -> acknowledged/unknown`，同一 `deliveryId + supplierId` 只允许一次 ACK，`unknown` 不自动重发，并保留重复入站的原 Supplier 路由。
- 合并 Sat 入站 pending 队列与容量预占；无 subscriber 时第 65 条入站直接返回稳定失败，不再静默丢消息或错误返回成功。
- Window -> Worker 的入站 SSP Wire 与 Worker -> Window 的请求/响应统一计入 32 MiB/256 item bridge 预算；SSP/SPI 请求按“实际请求字节 + 最大响应字节”预留，直接 `Uint8Array` 响应精确切片并使用 transferable；入站响应前先释放输入预算，避免满载死锁。
- bridge waiter 在 lane timeout/stop 时会被移除并拒绝；已发送事件通过 `event-cancel` 通知 Worker，迟到事件不会重新进入业务 handler。
- ACK RPC 只回传 `deliveryId`、`supplierId`、`ackClaimToken`；Worker claim 保存 sender/messageId/dedupKey/generation，active claim 限制为 64，终态进入有界 tombstone 并及时回收。
- 内部 `satLibp2pTransport.ts` 在连接成功后的身份 pin 失败时立即关闭连接并 fail closed，不再 fallback 到后续 multiaddr；地址解析和纯拨号失败仍可继续尝试。
- Collect 新建/显式 retry 已保存完整安全字段与原始 Wire；旧记录缺字段时 fail closed 为 `unknown_result`，不会自动补全或重发。
- AppMsg 增加 Sat provider 选择入口；多 Supplier Deliver 保留 ACK 原路并抑制重复业务事件。

### 已验证

- Keymaster：`pnpm typecheck`、`pnpm lint:boundaries`、`pnpm lint:react-boundaries`、`pnpm build`、`pnpm docs:connect:build` 通过。
- Keymaster 全仓 `pnpm test`：211 个测试文件全部通过；Worker 定向测试 91 项通过；内部 Sat transport 迁移测试 6 项、Sat lane/provider、C01–C05 handler 资源闭环和 bridge 定向测试通过；覆盖双标签页 `sat.events`、入站 ACK 单写者、claim 字段隔离与容量、无 subscriber 队列满载、请求/响应 bridge 预算、waiter timeout/cancel 和身份 pin 停止 fallback。
- 删除外部目录前后均通过 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint:react-boundaries`、`pnpm build`、`pnpm docs:connect:build` 和 `git diff --check`；
- `bitcoin-libp2p`：Go `go test -race ./...`、TypeScript 63 项测试和 10 组 uvarint 跨语言向量通过。
- SatSubscription：Go 全量及 `-race`、内部 transport 集成、Go↔TypeScript `/ssp/1.0.0` 长流互操作通过；内部 transport 迁移测试 6 项通过。

### 仍待完成

- 独立 `SatSubscriptionLibp2p` 与本地 `file:` 依赖已移除，外部目录已删除；内部 transport 已迁入 Keymaster。Go Server 正式 release/commit 仍待完成。
- 双 Supplier、双 Keymaster owner、双 Connect origin 的真实 E2E 尚未执行；S01–S22 真实供应商验收和证据归档尚未开始。

## 13. 完成定义

以下条件必须全部满足：

- [x] P2P Host 不再归 MSFile 所有。
- [x] P2P、MSFile、SatSubscription 均不可 disable。
- [x] 公共 executor/lease/bridge 不再使用 `msfile` 命名。
- [x] MSFile 和 SatSubscription 都通过 lane 使用唯一 Host。
- [x] SatSubscription 客户端、adapter 和服务器固定 `bitcoin-libp2p 0.3.0`。
- [x] 源码与 lockfile 中不存在 `uint32be`、`sspFrameEncoding` 或 Sat 自建 framing codec（本施工单中的禁止项示例除外）。
- [x] `/ssp/1.0.0` Go/TypeScript 真实长流互操作通过。
- [x] `sentBoundary` 跨 Window/Worker 后保持准确。
- [x] 旧 connection/epoch/generation 不能污染新状态。
- [x] connect 前到达的第一条 Publish 不丢失。
- [x] pending、writer、inbound、bridge 都有硬上限和清理实现及定向测试。
- [x] 每次 ingress 都有独立 `deliveryId`/claim token；同一 `deliveryId + supplierId` 不会重复发送付费 ACK。
- [x] 入站队列满载 fail closed，第 65 条消息不会被静默丢弃。
- [x] SSP/SPI 请求预留实际请求 Wire 与最大响应 Wire；裸 `Uint8Array` 响应使用精确 transferable buffer。
- [x] bridge waiter 在 timeout/stop 后不会重新发送；已发送旧事件有 cancel 闭环。
- [x] ACK claim 只接受三元组引用，权威 sender/messageId/dedupKey/generation 留在 Worker，active claim 与 tombstone 均有上限。
- [x] Collect 缺少安全字段时 fail closed。
- [x] Connect App 仍只能访问 `appmsg.*`。
- [ ] 双 Supplier、双 owner、双 origin 真实 E2E 通过。
- [ ] Go SatSubscription Server 正式 release/commit 已提交，Keymaster 与 Go 依赖版本及发布验证完成。
- [x] 全仓测试、构建和 Connect 文档构建通过。
- [ ] S01-S22 真实供应商验收和证据归档完成。

只有全部勾选后，才可以声明“SatSubscription 能力建立完成”。
