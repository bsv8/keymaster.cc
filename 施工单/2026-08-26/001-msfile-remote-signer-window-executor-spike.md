# 001 MSFile Remote Signer 与 Window Executor 架构 Spike 施工单

> 状态：✅ PASS（2026-08-27）。
>
> 验收证据：[001 Executor Spike 证据报告](../../docs/proposals/msfile/001-executor-spike-evidence.md)。002 生产 Runtime 已 PASS；003 发布验收仍受外部环境阻断，默认开关未启用。
>
> 本单是 MSFile 生产 Runtime 的唯一编码前门禁。它只裁决架构可行性，不承担完整网络 Runtime、跨浏览器发布验收或默认启用。

## 1. 目标

用运行在真实浏览器中的最小实现证明下面的安全边界能够成立：

```text
Coordinator SharedWorker
  - 唯一持有 active business private key
  - 维护 sessionEpoch、active owner 与 executor lease
  - 只接受当前 lease 的受限 libp2p signer 请求

唯一 Keymaster Window executor
  - 不取得 raw private key
  - 使用 remote signer 创建与 active business public key 一致的 libp2p identity
  - 承担 RTCPeerConnection 所在的浏览器 Window 运行位置
```

本单必须给出明确的 PASS 或 FAIL。不得以“依赖可以构建”“类型检查通过”代替真实浏览器运行证据。

## 2. 已有基线

- MSFile contracts、Frame codec、设置、trusted service、Connect gateway 和 SDK 已有 fail-closed 脚手架；
- `packages/plugin-msfile/src/msfileTransport.ts` 仍是 unavailable 默认实现；
- Coordinator 已持有 Vault 状态、active key 与 `sessionEpoch` 真值；
- `/home/david/Workspaces/bitcoin-libp2p` 已统一 TypeScript/Go 两端的 secp256k1 business identity、PeerId、Noise、Signed Peer Record 和 authenticated connection 规则；
- 相邻 `MSFile-Proxy-Protocol` 仓库已经提供 Go supplier、Chromium Playwright 和 WebRTC Direct 实验基础；
- 本单固定使用不可变发布版 `bitcoin-libp2p@0.1.0`，不再维护 Keymaster 私有的 libp2p identity/signing 实现。

### 2.1 冻结依赖与变更纪律

`bitcoin-libp2p` 是本单的只读上游和唯一 libp2p identity/signing 真值，实施者不得直接修改该仓库，包括为了让本单测试通过而打本地补丁、复制后改名或在 Keymaster 中 fork 其逻辑。

- 依赖必须固定到可复现的不可变版本；最终交付不得使用 `file:/home/david/Workspaces/bitcoin-libp2p`；
- 若 SDK 接口、行为或上游依赖形成阻断，提交最小复现、期望/实际行为、受影响版本和建议修复点，由项目负责人协调 `bitcoin-libp2p` 修改；
- 在协调修复发布前保持 fail closed，不得用 `as any`、私有字段、伪造 `raw` 或 Keymaster 内兼容 fork 绕过；
- Go WebRTC Direct listener 需要读取 identity `Raw()` 是已知 go-libp2p 限制，不要求在本单修改 `bitcoin-libp2p`，其服务端兼容边界由 002/003 明确。

## 3. 本单必须完成

### 3.1 `bitcoin-libp2p` TypedSigner 可行性

1. 使用 `bitcoin-libp2p` TypeScript SDK 的 `TypedSigner` 和 host adapter，不自行实现 libp2p private-key adapter；
2. 用不暴露 raw private key 的 `TypedSigner` 创建 libp2p host；
3. 证明 host 的 public key、PeerId 以及 Noise authenticated identity 均与 active business public key 一致；
4. 覆盖 SDK 定义的 Noise Static Key 与 Signed Peer Record 两类 typed signing purpose；
5. signer RPC 不得暴露无约束的通用 `sign(bytes)` 钱包签名能力。

Window 内部实现 `KeymasterMsFileIdentitySigner implements TypedSigner`。`publicKey()` 返回取得 executor lease 时冻结的 active compressed public key 快照；另外两种签名用途分别映射到两个独立 RPC，不接受 Window 传入任意 message、digest、domain、签名格式或算法：

```ts
interface MsFileNoiseSignRequest {
  leaseId: string;
  expectedSessionEpoch: SessionEpoch;
  noiseStaticPublicKey: ArrayBuffer; // 必须恰好 32 bytes
}

interface MsFilePeerRecordSignRequest {
  leaseId: string;
  expectedSessionEpoch: SessionEpoch;
  peerId: string;
  addresses: string[];
  sequence: string; // uint64 十进制字符串
}

interface MsFileIdentitySignResult {
  signatureDer: ArrayBuffer;
}
```

RPC 方法语义固定为 `msfile.executor.identity.sign-noise` 和 `msfile.executor.identity.sign-peer-record`。SharedWorker 必须使用 `bitcoin-libp2p` 定义的标准签名构造规则，从上述业务字段重建准确 payload 和 digest，再调用 active business key 的 `signDigest({ format: "der" })`。返回前必须满足 SDK 的严格 DER、low-S 和本地公钥验签规则。

对于当前只拨号、不监听地址的 MSFile Window host，Peer Record 还必须满足：

- `peerId` 必须由当前冻结的 active public key 派生；
- `addresses` 必须为空数组，不允许 Window 借此声明监听地址；
- `sequence` 必须是合法 uint64，并在同一 lease 内单调不减；
- 未来若 Window host 增加监听能力，必须重新审查地址授权边界，不得直接放宽本 RPC。

SharedWorker 在签名前、签名完成后分别复核调用 port/client、lease id、`sessionEpoch`、active owner 和 active public key；任一变化都丢弃结果。未知 purpose、通用 `sign(bytes)`、`signDigest(digest)` 和由 Window 选择 domain/format/algorithm 的接口一律禁止。

### 3.1.1 Non-extractable adapter 所有权

Non-extractable private-key adapter、Noise/Peer Record payload 识别、DER/low-S 校验、PeerId 派生和本地验签全部由 `bitcoin-libp2p` SDK 负责。Keymaster 只实现 `TypedSigner` 到 Coordinator RPC 的桥，不得复制 SDK adapter、实现自有 `raw`/`equals` 接缝或保留两套并行路径。

Spike 必须通过真实 Chromium 测试证明 `bitcoin-libp2p.createHost()` 的启动、PeerId 派生、Noise、Identify/Identify Push 和销毁路径均不取得 raw private key。`Raw/raw` 调用必须明确 fail closed。若锁定版本失败，按 2.1 上报协调，不得直接修改 `bitcoin-libp2p` 或把私钥复制到 Window。

现有 Spike 是迁移输入，不是可并行保留的第二套实现。施工时必须完成以下清理：

- 删除或停止生产引用 `packages/plugin-msfile/src/spike/remoteSigner.ts` 中的自研 adapter/payload 逻辑；
- 删除 `MsFileSignerPurpose`、`MSFILE_SIGNER_MAX_PAYLOAD_BYTES` 和通用 `msfile.executor.sign` 契约；
- 删除 Worker 内硬编码 Noise prefix、通用 payload 分派和 compact signature 路径；
- 替换为上述两个 typed RPC，签名结果统一为严格 low-S DER；
- 若旧文件暂因测试迁移保留，必须不再被 production graph 引用，并在本单完成前删除，不得形成 feature flag 双路径。

### 3.2 Executor lease

实现最小、可测试的 lease 协议：

- 同一 `sessionEpoch` 最多一个 Window executor；
- lease 绑定 Coordinator 实际 port/client、active owner、session epoch 和随机 lease id；
- 两个 tab 同时申请时只能一个成功；
- 非 lease owner、旧 epoch、旧 owner、已释放 lease 的 signer 请求全部拒绝；
- executor 明确释放、port 失效或有界 lease 超时后，下一窗口可以取得新 lease；
- 不恢复旧请求，新 executor 只服务新请求。

不得引入跨重启恢复、无限重试、复杂 leader consensus 或第二套持久化状态机。lease 是 Coordinator 内存真值，Vault lock、active key 切换和 Worker 重启均直接清空。

### 3.3 生命周期与失败语义

必须在真实浏览器中覆盖：

- Vault lock；
- active key 切换；
- `sessionEpoch` 推进；
- executor tab 关闭或失去 lease；
- 两个 tab 竞争与接管；
- signer 请求正在等待时发生上述变化。

所有旧 signer 请求和旧 executor 请求必须稳定失败，不得永远 pending。错误统一为英文且不得包含私钥、签名原文、完整内部堆栈或未脱敏 session 数据。

### 3.4 Window/Worker 传输基本能力

不实现正式 MSFile stream，但必须证明：

- `ArrayBuffer` 可以通过 transferable 在 Coordinator 与 executor 间双向传递；
- 16 MiB Seed 与 4 个并发 256 KiB Block 不被隐式整包复制多次；
- 队列存在明确的数量和字节上限；
- executor 消失时所有等待响应明确失败；
- Abort 可以终止本地等待并释放队列记录。

记录峰值内存的采样方法和结果。不得只比较测试开始与结束时的堆大小。

## 4. 建议落点

实施者应先检查现有结构，再以最少的新模块完成 Spike。预计涉及：

- `packages/contracts/src/sessionCoordinator.ts`：仅增加必要的 executor lease/signer 消息契约；
- `apps/web/src/keymasterSessionCoordinator.worker.ts`：lease 与受限 signer 的权威实现；
- `apps/web/src/` 下独立的 Window executor spike 模块；
- `e2e/`：两个页面连接同一 SharedWorker 的真实浏览器测试；
- `packages/plugin-msfile/`：只放可被第二单复用的 `TypedSigner` RPC bridge，不实现或复制 libp2p private-key adapter，不实现 supplier connection manager。

Spike 代码不得接入生产 MSFile data path，也不得把 `createUnavailableMsFileTransport()` 替换为假装可用的实现。

## 5. 明确不做

- 完整 `MsFileTransport`；
- supplier 配置拨号和地址 fallback；
- Stat/Read 长驻 stream；
- Connect 价格授权修改；
- Firefox、Safari 验收；
- 公共 CA WSS；
- 目标 NAS 硬件验收；
- `defaultEnabled: true`；
- raw private key 进入 Window、localStorage、日志或测试快照。

## 6. 必测矩阵

| 编号 | 场景 | 通过条件 |
|---|---|---|
| A01 | Remote signer 创建 host | 无 raw key 的 Window host 成功启动 |
| A02 | Identity 一致 | public key、PeerId、Noise identity 与 active key 一致 |
| A03 | TypedSigner 输入约束 | Noise 只能提交 32-byte static key；Peer Record 只能提交受限结构；不存在通用 payload/digest 签名入口 |
| A04 | 两 tab 竞争 | 同一 epoch 只有一个 executor lease |
| A05 | 旧 lease 重放 | 旧 lease id/旧 port 请求被拒绝 |
| A06 | Lock/key switch | 正在等待和后续 signer 请求全部失败 |
| A07 | Executor 丢失 | 未决请求失败，下一窗口可取得新 lease |
| A08 | Transferable | 16 MiB + 4×256 KiB 正确传输且队列/内存有界 |
| A09 | Abort | 取消后没有残留 Promise、队列项或可继续使用的签名请求 |
| A10 | 敏感数据搜索 | Window 消息、日志、DB、localStorage 中没有 raw private key |
| A11 | Worker 二次校验 | Worker 分别重建标准 Noise/Peer Record 签名输入；调用方不能选择 message/digest/domain/format/algorithm |
| A12 | Non-extractable 接缝 | SDK host 的启动、PeerId、Noise、Identify/Identify Push 和销毁均不取得 `raw`；任何读取都明确失败 |
| A13 | Peer Record | peerId 必须匹配 active key，addresses 为空，sequence 合法且单调不减；伪造字段全部拒绝 |
| A14 | SDK 单一实现 | 生产路径没有自研 private-key adapter、Noise payload parser、PeerId 或 DER/low-S 校验副本 |

单元测试可以覆盖纯状态机，但 A01、A02、A03、A04、A06、A07、A08、A11、A12、A13 必须至少有 Chromium Playwright 的真实 SharedWorker/多页面测试。A02 还必须与相邻 Go supplier 完成一次真实 Noise authenticated handshake，证明 DER 签名及 identity 可跨语言互操作。

## 7. 失败裁决

只有以下情况可以把本单判定为阻断：

1. 锁定版本的 `bitcoin-libp2p` 无法用 `TypedSigner` 创建所需 host；
2. signer 必然退化为无法约束的跨业务通用签名 oracle，或无法限制为 Noise Static Key 与 Signed Peer Record 两种用途；
3. SDK host 的实际 service map 必须取得 raw private key，或 Window executor 无法在不取得 raw private key 的情况下形成正确 Noise/PeerId identity；
4. 浏览器运行模型无法可靠维持唯一 executor 或无法让旧 epoch 请求失效；
5. transferable/队列模型无法给出可接受的明确内存上限。

阻断报告必须包含：失败步骤、最小复现、浏览器与依赖版本、上游接口证据、尝试过的安全方案，以及需要 `bitcoin-libp2p` 项目协调修改或重新裁决的具体问题。实施者不得直接修改该项目，也不得只写“需要真实环境”。

## 8. 验收命令与证据

至少执行并记录：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run <本单涉及的定向测试>
pnpm exec playwright test <MSFile executor spike E2E>
pnpm build
```

证据记录必须包含：

- Node、pnpm、浏览器和 libp2p 版本；
- active test public key 与派生 PeerId；
- Noise/Peer Record signer 请求类型和字段摘要，不记录完整待签名内容或签名；
- lease 竞争、回收和 epoch 失效事件；
- transferable 数量、总字节和峰值内存；
- PASS/FAIL 结论。

## 9. 完成定义

- A01–A14 全部通过；
- raw private key 从未离开 Coordinator；
- signer 只接受 Noise Static Key 与受限 Signed Peer Record 业务字段，由 Worker 按 SDK 标准构造签名输入和 DER 签名，不是跨业务通用签名入口；
- Keymaster 不再维护自研 libp2p private-key adapter、PeerId、payload 或签名格式校验副本；
- executor lease 的唯一性、失效和粗暴重建语义已冻结；
- 有真实 Chromium 证据，不只是 mock；
- 文档给出明确 PASS；
- 第二单可以在不重新裁决 Worker/Window 边界的前提下实现生产 Runtime。

本单完成不代表 MSFile 数据面可用，也不允许翻转默认开关。

## 10. 实施结论

2026-08-27 已完成 A01–A14，并按第 8 节命令完成自动验收。真实 Chromium Window host 使用 `bitcoin-libp2p@0.1.0` TypedSigner，通过 WebRTC Direct 与相邻 Go supplier 完成 Noise authenticated handshake；Go 端观察到的远端 PeerId/公钥与 active business identity 一致。raw private key 未离开 Coordinator，生产 MSFile transport 与 `defaultEnabled` 均未启用。

最终裁决：**PASS**。详细版本、运行结果、字段摘要、lease/epoch 事件与内存采样见证据报告。
