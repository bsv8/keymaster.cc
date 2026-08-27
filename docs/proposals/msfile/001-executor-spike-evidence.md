# 001 Remote Signer / Window Executor Spike 证据报告

> 结论：**PASS**（2026-08-27）。本报告只解除 002 生产 Runtime 的编码门禁，不代表 MSFile 数据面已上线，也不允许启用默认开关。

## 环境与冻结版本

| 项目 | 实际值 | 中文说明 |
|---|---:|---|
| Node | v22.13.1 | 测试与构建运行时 |
| pnpm | 11.5.1 | 依赖管理器 |
| Playwright | 1.61.1 | 浏览器自动化框架 |
| Chromium | Chrome for Testing 149.0.7827.55 | 真实 SharedWorker/多页面/WebRTC Direct 验收浏览器 |
| Go | go1.26.0 linux/amd64 | 相邻 supplier 构建运行时 |
| bitcoin-libp2p | 0.1.0 | 不可变 SDK 发布版；无 `file:`/`link:` 依赖 |
| libp2p | 3.3.9 | SDK host |
| @libp2p/webrtc | 6.0.30 | WebRTC Direct transport |
| @chainsafe/libp2p-noise | 17.0.0 | Noise |
| @chainsafe/libp2p-yamux | 8.0.1 | stream muxer |

只读上游 `/home/david/Workspaces/bitcoin-libp2p` 在施工后保持无工作区改动；验收时 commit 为 `d159854`。Go lab 来自相邻 `MSFile-Proxy-Protocol` commit `75179dd`。

## 身份与 signer 证据

- 最终完整 PASS 运行的 active test public key：`035a172650aa778e29b7a831846674debc94da39bca3410faab969b848e368ac29`。
- 派生 PeerId：`16Uiu2HAmJifWwp9KLvduveTPK4bxrntr5zmobB1c6PRT4hn2yBBE`。
- Go supplier identity stream 观察到相同远端公钥与 PeerId；连接 `direct=true`，Go 底层 transport 标签为 `udp`，实际拨号地址包含 `/webrtc-direct/certhash/...`。
- 该运行触发 1 次 Noise Static Key 签名和 2 次 Signed Peer Record 签名；日志只记录请求类型、计数与允许字段摘要，不记录 payload、digest 或签名字节。
- `raw` 读取明确失败：`identity private key is non-extractable`。Host start、PeerId、Noise、Identify、Identify Push、echo stream 与 stop 均完成。

允许的 signer 字段如下：

| RPC | Window 可提交字段 | Worker/SDK 负责内容 |
|---|---|---|
| `msfile.executor.identity.sign-noise` | `leaseId`、`expectedSessionEpoch`、32-byte static public key | 标准 Noise payload/digest、DER/low-S 与本地验签 |
| `msfile.executor.identity.sign-peer-record` | `leaseId`、`expectedSessionEpoch`、匹配 active key 的 PeerId、空 addresses、uint64 sequence | 标准 Peer Record unsigned bytes/digest、DER/low-S 与本地验签 |

不存在 MSFile 通用 `sign(bytes)`、`signDigest(digest)`、调用方自选 domain/format/algorithm 的入口。

## Lease、生命周期与 transferable 证据

- 两个真实 tab 同时申请时只有一个取得 lease；winner tab 关闭后，另一个 tab 取得不同的新 lease。
- 旧 lease id、错误 port、释放后的 lease、旧 epoch 均被拒绝。
- tab A 持有 pending Noise signer 时，tab B 经独立 MessagePort lock：pending 请求失败、pending 计数归零、epoch 推进，随后可取得新 lease。
- active key 切换使用同样的跨 tab 抢占路径：旧 pending signer 失败，新 lease 的 public key 等于 replacement key。
- transferable burst 为 5 项，共 `17,825,792` bytes（16 MiB Seed + 4 × 256 KiB Block）。数据真实执行 Window → SharedWorker → Window 双向 transfer；发送端 5 个原始 ArrayBuffer 全部 detach。
- Worker 硬上限：5 项、17 MiB 总在途字节、单项 16 MiB；实测 Worker 在途峰值 `17,825,792` bytes。
- Chromium 使用 `--enable-precise-memory-info`，在 baseline、每次 transfer 后、drain 后采样 `performance.memory.usedJSHeapSize`。最终完整 PASS 运行 baseline/peak 均为 `18,798,408` bytes；ArrayBuffer backing store 主要由 Worker 在途字节计数与 detach 证据界定，不用“测试开始/结束差值”代替峰值。
- Abort 后 signer pending 为 0；本地 `TransferQueue` 单测覆盖 abort、close、条目/字节溢出与所有 Promise 明确失败。

## A01–A14 裁决

| 编号 | 结果 | 核心证据 |
|---|---|---|
| A01 | PASS | Chromium Window 用 TypedSigner 启动 SDK host |
| A02 | PASS | active public key、PeerId 与 Go Noise 认证远端身份一致 |
| A03 | PASS | 32-byte Noise、受限 Peer Record；伪造 PeerId/地址/sequence 拒绝 |
| A04 | PASS | 两 tab 同 epoch 仅一个 lease |
| A05 | PASS | 旧 lease/错误 port/释放后重放拒绝 |
| A06 | PASS | 跨 tab lock 与 active key switch 使 pending/后续旧请求失败 |
| A07 | PASS | executor tab 关闭后 pending 失败且另一 tab 接管 |
| A08 | PASS | 17 MiB 双向 SharedWorker transferable，detach 且队列有硬上限 |
| A09 | PASS | Abort 后无残留 Promise/队列项/可继续 signer |
| A10 | PASS | Window/storage/log/静态搜索未发现 raw private key |
| A11 | PASS | Worker 使用 SDK 标准构造，仅接受业务字段，签名前后复核 lease/epoch/owner/key |
| A12 | PASS | SDK non-extractable adapter；完整 host/Noise/Identify/Push/stop 路径不取 raw |
| A13 | PASS | PeerId、空 addresses、uint64 单调 sequence；伪造字段 Chromium + Worker 均拒绝 |
| A14 | PASS | 无 Keymaster 自研 adapter/payload parser/PeerId/DER-low-S 校验副本 |

## 验收命令

```text
pnpm typecheck                                                        PASS
pnpm lint:boundaries                                                   PASS
pnpm lint:react-boundaries                                             PASS
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts apps/web/src/msfileSpike/transferQueue.test.ts packages/plugin-msfile/src/executorIdentitySigner.test.ts
  3 files / 86 tests                                                   PASS
pnpm exec playwright test e2e/msfile-executor-spike.spec.ts            PASS（5/5）
pnpm build                                                            PASS
```

生产 `packages/plugin-msfile/src/msfileTransport.ts` 仍为 unavailable/fail-closed 实现，插件仍 `defaultEnabled: false`。
