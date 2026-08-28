# 002 MSFile 生产 Runtime 与真实数据面施工单

> 状态：✅ PASS（2026-08-27）。验收证据见
> [002 生产 Runtime 证据报告](../../docs/proposals/msfile/002-production-runtime-evidence.md)。
>
> 本单实现 KMMF-004，并把现有 fail-closed 脚手架接入真实 WebRTC Direct/WSS 数据面。外部 Safari、公共 CA 和指定 NAS 环境不属于本单前置条件。

## 1. 前置条件

- [001 MSFile Remote Signer 与 Window Executor 架构 Spike](./001-msfile-remote-signer-window-executor-spike.md) 已明确 PASS；
- `bitcoin-libp2p` `TypedSigner`、executor lease、epoch 失效和 transferable 边界已经冻结；
- 相邻 MSFile Proxy Protocol 的 Wire Messages V1 与 Network V1 是协议真值；
- 当前 contracts、codec、settings、trusted service、Connect gateway 和 SDK 作为既有基线保留。

001 未 PASS 时不得通过复制 raw private key、改用另一把身份 key 或把 libp2p host 塞进不支持的运行位置来绕过。`bitcoin-libp2p` 是只读上游；实施者发现 SDK 阻断时必须提交最小复现并由项目负责人协调，不得直接修改该项目或在 Keymaster 内 fork。

## 2. 交付目标

实现下面的真实链路：

```text
trusted plugin / Connect App
  -> Coordinator MsFileService
  -> Worker 侧 MsFileTransport proxy
  -> 当前 epoch 的唯一 Window executor
  -> js-libp2p host
  -> WebRTC Direct 或 WSS
  -> 目标 Go MSFile supplier /msfile/1.0.0
```

配置真实 supplier 后，内部 `msfile.service` 与 Connect SDK 必须能完成真实 Stat、Seed Read 和 Block Read。不得在完成验收时注入 fake transport。

## 3. Runtime 所有权

### 3.1 Coordinator SharedWorker

继续作为以下真值的唯一 owner：

- raw private key；
- active owner 与 `sessionEpoch`；
- executor lease；
- MSFile 设置、App policy 与审批；
- supplier generation；
- trusted/Connect 请求的并发上限与取消入口；
- lock/key switch/plugin teardown 的最终失效裁决。

### 3.2 Window executor

只负责浏览器网络执行：

- 一个当前 epoch 的 js-libp2p host；
- `bitcoin-libp2p` `TypedSigner` bridge；
- WebRTC Direct 与 WSS 拨号；
- supplier connection/stream 生命周期；
- Frame 编解码、request ID、写串行化和响应关联；
- attachment 背压、transferable 和内容校验；
- 把规范化结果返回 Coordinator。

Window 不读取 MSFile DB，不解析 App price policy，不弹授权 UI，也不持久化 owner、supplier 或内容字节。

## 4. 必须实现

### 4.1 生产 executor 接线

- 把 001 的 lease/signer/transferable 接缝变为生产模块；
- 使用 `bitcoin-libp2p@0.1.0` 的 `TypedSigner` 与 `createHost()`；Keymaster 不实现第二套 private-key adapter、PeerId、Noise/Peer Record payload parser 或 DER/low-S 校验；
- signer RPC 固定为 `msfile.executor.identity.sign-noise` 与 `msfile.executor.identity.sign-peer-record`；Noise 只能提交恰好 32-byte static key，Peer Record 只能提交 `peerId/addresses/sequence` 结构；
- 当前拨号型 host 的 Peer Record 必须绑定 active-key PeerId、空 addresses 和 lease 内单调不减的 uint64 sequence；
- SharedWorker 按 `bitcoin-libp2p` 标准重建两种签名输入并由 active business key输出 DER；签名前后都复核 port/client、lease、epoch、owner 和 active public key；
- 任意 message、payload、digest、domain、format、algorithm、unknown purpose 或 raw private key 请求全部 fail closed；
- 若未来 SDK 增加第三种签名用途或 Window host 增加监听地址，必须回到架构 Gate 重新裁决，不得扩展现有 RPC 为通用签名；
- 页面启动、plugin enable、Vault unlock 时允许选举 executor；
- lock、active key 切换、plugin disable、Window unload、lease 丢失时销毁 host；
- 新 executor 只重建 host 和新请求，不恢复旧请求；
- Worker 侧实现真实 `MsFileTransport` proxy，替换运行时中的 unavailable 注入；
- unavailable 默认实现继续保留，供 locked、disabled、无 executor 和启动失败状态 fail closed。

### 4.2 libp2p host

严格使用冻结依赖：

```text
bitcoin-libp2p          0.1.0（唯一 identity/signing/host adapter 真值）
@libp2p/webrtc          6.0.30，仅 webRTCDirect()
@libp2p/websockets      10.1.20
```

`bitcoin-libp2p.createHost({ signer, transports: [webRTCDirect(), webSockets()] })` 负责安装冻结的 Noise、Yamux、Identify 与 Identify Push。Keymaster 保留上述 transport 的直接运行时依赖用于注入。最终依赖不得指向本机 `file:` 路径。

禁止绕开 SDK 自建 host，也禁止引入 relay-signaled `webRTC()`、Circuit Relay、TURN 数据路径、DHT 或 mDNS。

### 4.3 Supplier identity 与地址

- 每次连接都用 `bitcoin-libp2p.authenticateConnection()` 从 authenticated libp2p connection 取得并验证远端 identity；
- PeerId、33 字节压缩 supplier public key 与配置地址必须一致；
- WebRTC Direct 校验 PeerId 和 certhash；
- WSS 校验浏览器 TLS、Noise identity、PeerId 与 supplier public key pin；
- 地址按用户保存顺序尝试 fallback；
- fallback 只能发生在同一 supplier public key 下；
- 配置 generation 改变立即关闭旧连接并拒绝迟到结果。

### 4.4 Connection 与双 stream

每个启用 supplier 最多一个 active connection：

- 一条长驻 Stat stream；
- 一条按需建立并复用的 Read stream；
- 每条 stream 只有一个 Frame writer；
- 同一 stream 支持多请求并发及乱序响应；
- connection 重建形成新的 request ID 作用域；
- stream Reset 可在同一业务调用内重建一次，仍失败则让本次请求失败；
- 不建立无限后台重试或跨重启 pending 恢复。

### 4.5 Stat

- 向所有启用 supplier 并发发送 Stat；
- 单供应商网络错误形成该 supplier 的规范化 network-error，不伪装 absent；
- 聚合 available/absent/discovering/quoted/network-error；
- 大 Read 期间 Stat 不得被同一数据 attachment 阻塞；
- supplier disable/delete/address replacement 后旧结果不得进入聚合。

### 4.6 Read

- 只按 `supplierPublicKeyHex` 定向；
- wire 仍是统一 `Read(content_hash, max_price_satoshis)`；
- Seed/Block 只在 Keymaster 层选择金额策略与内容校验规则；
- request ID 更大的同 hash 请求按协议覆盖旧上限；
- 正确处理 ReadCancelled 和 attachment 已开始后的竞态；
- content hash、Seed/Block 最大尺寸和已知 Seed 精确长度必须在返回前验证；
- 验证后的 `ArrayBuffer` 通过 transferable 返回；
- 任何网络、协议、hash 或尺寸错误不得返回部分内容。

### 4.7 背压与资源限制

至少冻结并测试：

- Coordinator 全局 active data request 上限；
- 每 supplier pending Stat/Read 上限；
- 每 connection 单 writer 队列上限；
- Window/Worker transferable 在途字节上限；
- Seed 最大 16 MiB、Block 最大 256 KiB；
- 4 个并发 Seed 与 8 个并发 Block 场景；
- Abort、disconnect、lock 后队列和 pending map 全部释放。

达到上限时让当前请求稳定失败，不增加排队重试状态机。

### 4.8 状态与恢复

- 无 executor、host 启动失败、所有 transport 不可用时状态为 unavailable；
- 有配置且 executor 可工作时状态反映真实可用性；
- executor 丢失使当前请求失败；下一次请求或下一 executor 可以粗暴重建；
- DB 初始化失败仍永久 fail closed，直到 Coordinator 重建 runtime；
- 不允许 UI 状态显示 available 而执行路径仍使用 unavailable transport。

## 5. 本机自动化 E2E

本单必须使用相邻仓库的正式 Go `/msfile/1.0.0` supplier，而不是只测 mock/fake supplier：

- Chromium Keymaster Window executor -> Go supplier WebRTC Direct；
- Chromium Keymaster Window executor -> Go supplier WSS；本机可以用测试 CA/自签证书并显式配置浏览器信任，仅作为自动化证据；
- Stat available/absent/discovering/quoted；
- Seed Read 和 Block Read 的真实字节/hash 验证；
- wrong PeerId、wrong public key、wrong certhash、TLS 错误；
- Stat/Read 双 stream 隔离；
- 4/8 并发、乱序、覆盖、Reset、fallback；
- executor tab 关闭后另一 tab 接管；
- lock/key switch/config mutation 中断在途请求；
- trusted `msfile.service` 和 Connect SDK 各至少走一次完整真实链路。

若相邻仓库现有 supplier/acceptance fixture 仍缺少测试控制能力，应明确记录需要的最小测试夹具变更；不得用 Keymaster 内 fake transport 替代正式协议 E2E。

### 5.1 Go supplier 对齐前置

相邻 `MSFile-Proxy-Protocol` 必须固定同一 `github.com/bsv8/bitcoin-libp2p v0.1.0`，并按以下边界提供验收服务：

- identity 解析、压缩公钥、PeerId、一致性校验和 authenticated connection 取值使用 Go SDK，不保留重复业务 helper；
- `/msfile/1.0.0` handler 使用 SDK 的 authenticated peer 公钥做白名单判断，不信任 Frame 或 Identify 自报字段；
- Host 显式配置 Noise 与 Yamux，不依赖 go-libp2p 默认 security/muxer；
- 当前 go-libp2p WebRTC Direct listener 构造 DTLS certificate 会调用 identity `Raw()`。Go supplier 是已持有本地身份文件的受信任服务进程，因此只允许在 NAS Host composition root 使用本地完整私钥并直接调用原生 `libp2p.New`；raw 不得进入 handler、日志、数据库或管理响应；
- 不为绕过上述限制修改 `bitcoin-libp2p`，不伪造 `Raw()`，不增加 WebRTC certificate signer purpose，也不拆成两个不同身份的 host；待上游支持注入 DTLS certificate 后再单独评估收口；
- 恢复当前损坏的 `labs/webrtc-go/cmd/msfile-acceptance/main.go` 是 B01/B02 前置 Gate；修复前不得宣称跨仓 E2E 已完成。

若上述服务器改动需要施工，应在 `MSFile-Proxy-Protocol` 仓库由其负责人单独提交；本单不得越权直接修改 `bitcoin-libp2p`。

## 6. 建议检查范围

至少检查和按需修改：

- `packages/contracts/src/sessionCoordinator.ts`
- `packages/plugin-msfile/src/msfileTransport.ts`
- `packages/plugin-msfile/src/frameCodec.ts`
- `packages/plugin-msfile/src/readStream.ts`
- `packages/plugin-msfile/src/wireStream.ts`
- `packages/plugin-msfile/src/msfileService.ts`
- `packages/plugin-msfile/src/coordinator.ts`
- `apps/web/src/keymasterSessionCoordinator.worker.ts`
- `apps/web/src/keymasterSessionCoordinatorClient.ts`
- `apps/web/src/bootstrapPlugins.ts`
- 新增的 Window executor/runtime 模块
- `e2e/` 下 MSFile 真实浏览器测试

不得把 React 设置 UI、Protocol popup 或其它业务插件引入 SharedWorker 网络模块。

## 7. 明确不做

- 修改 MSFile wire/network 协议；
- 实现 NAS/供应商服务端产品功能；
- 上传、删除、目录、挂载；
- 文件级授权、累计预算或 access/grant API；
- 让 Connect App 选择 transport 或地址；
- relay、TURN、DHT、mDNS；
- 自动无限重试；
- Safari 和指定真实 NAS 的发布签字；
- 本单结束时翻转 `defaultEnabled`。

## 8. 必测矩阵

| 编号 | 场景 | 通过条件 |
|---|---|---|
| B01 | WebRTC Direct 正式协议 | Stat/Seed/Block 真实成功 |
| B02 | WSS 正式协议 | TLS+Noise+Yamux 下真实成功 |
| B03 | Identity pin | 错 PeerId/public key/certhash 全部拒绝 |
| B04 | 双 stream | Read attachment 期间 Stat 仍及时完成 |
| B05 | 乱序关联 | 并发响应按 request ID 返回正确调用方 |
| B06 | Read 覆盖 | 新上限覆盖旧请求且取消语义正确 |
| B07 | 4/8 并发 | Frame 不串线、hash 正确、资源不超限 |
| B08 | 地址 fallback | 同 supplier 地址按序切换，identity 不变 |
| B09 | Stream/connection 恢复 | 有界重建，新请求可继续，旧请求不恢复 |
| B10 | executor 接管 | 旧请求失败，新 tab 可建立新 host |
| B11 | lifecycle | lock/key switch/config mutation 后旧结果无效 |
| B12 | trusted 真实链路 | 内部插件无需 session，可完成真实读 |
| B13 | Connect 真实链路 | session/identity/金额授权后完成真实读 |
| B14 | 敏感数据 | 私钥、attachment、付款原文不进日志/DB/result |
| B15 | Typed signer 生产边界 | Go supplier 真实握手成功；只出现受限 Noise/Peer Record RPC，Worker 构造标准签名输入与 DER，`raw`、未知 purpose 和通用签名均 fail closed |
| B16 | SDK 单一真值 | Keymaster 与 Go supplier 固定同一 SDK release/vector；没有 Keymaster 自研 adapter 或身份/签名校验副本 |

## 9. 验收命令

至少执行：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/plugin-msfile/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm exec vitest run packages/plugin-protocol/src packages/connect/src
pnpm exec playwright test <MSFile production runtime E2E>
pnpm build
pnpm test
```

相邻 Go supplier 同时执行其 `go test ./...`、`go test -race ./...` 和正式服务构建。若全仓存在无关基线失败，必须提供失败文件、复现命令和与本单无关的证据；B01–B16 不得因此跳过。

## 10. 完成定义

- B01–B16 全部通过；
- `MsFileTransport` 在 unlocked/enabled/有 executor 时使用真实生产实现；
- 配置真实 Go supplier 后 trusted capability 与 Connect SDK 均完成 Stat、Seed Read、Block Read；
- E2E 不注入 fake transport；
- lock、key switch、supplier mutation 和 executor 丢失均不会让旧 host/连接/结果继续使用；
- Runtime 失败后新请求可以粗暴重建，不留下永久 pending；
- 保持 `defaultEnabled: false`；
- 产出供 003 发布验收复用的命令、测试数据和证据采集入口。

只有完成本单，才可以说“MSFile 数据面已经实现”。
