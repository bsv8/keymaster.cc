# 003 MSFile 跨环境互操作与正式发布验收施工单

> 状态：等待 002 生产 Runtime 完成。
>
> 本单是发布门禁，不是 Runtime 编码前门禁。缺少 Safari、公共 CA WSS 或指定 NAS 环境时，只阻止本单完成及 `defaultEnabled: true`，不得把 001/002 回退成未施工。

## 1. 前置条件

- [001 架构 Spike](./001-msfile-remote-signer-window-executor-spike.md) 已 PASS；
- [002 生产 Runtime](./002-msfile-production-runtime.md) 已完成 B01–B16；
- Keymaster 已能在 Chromium 自动化环境通过真实 `MsFileTransport` 连接正式 Go `/msfile/1.0.0` supplier；
- trusted capability 与 Connect SDK 已有真实数据面 E2E。

若上述条件不成立，本单不得用发布环境测试替代缺失实现，应退回 002 修复。

## 2. 目标

在目标浏览器、目标网络和目标 Go/NAS supplier 上完成可复现的 I02–I15 互操作证据，验证生产部署而非本机测试夹具，并据此决定是否：

- 将 proposal 升级为正式协议/SDK 文档；
- 把 MSFile 插件从实验能力转为正式能力；
- 翻转 `defaultEnabled: true`。

## 3. 环境清单

验收开始前必须冻结并记录：

- Keymaster commit；
- MSFile Proxy Protocol/Go supplier commit；
- Keymaster 与 Go supplier 使用的 `bitcoin-libp2p` 发布版本及固定 vector 结果；
- Node、pnpm、Go、js-libp2p、go-libp2p 版本；
- Chrome、Firefox、Safari 的准确版本与操作系统；
- supplier public key、PeerId；
- WebRTC Direct multiaddr、certhash 与公网 UDP 映射；
- WSS 域名、端口、公共 CA、证书有效期与 TLS 终止位置；
- NAS 型号、系统、挂载类型和网络拓扑；
- 测试数据 hash、尺寸与期望摘要；
- Keymaster 测试 App Identity，不记录任何生产私钥。

Go WebRTC Direct listener 因上游 go-libp2p DTLS certificate 构造限制，可在受信任 supplier 的 Host composition root 使用本地完整身份私钥。验收必须证明该 raw key 没有进入 protocol handler、日志、数据库或管理响应；该受控服务端例外不放宽 Keymaster Window/SharedWorker 的私钥隔离要求。

测试必须使用专用无资金身份。日志、截图和报告不得包含 raw private key、付款原文或内容 attachment。

## 4. I02–I15 发布矩阵

| ID | 场景 | 发布通过条件 |
|---|---|---|
| I02 | Browser -> Go WebRTC Direct 身份认证 | 三个目标浏览器均以 active business public key 对应的 PeerId 完成 Noise 握手并取得预期 authenticated remote public key；证据确认只调用受限 Noise/Peer Record signer，未读取 `raw` |
| I03 | WebRTC Direct 双向 protocol stream | Stat/Read stream 双向收发、half-close/Reset 行为有记录 |
| I04 | WebRTC Direct 大内容 | 16 MiB Seed 与规定压力数据摘要正确、内存有界 |
| I05 | Browser -> Supplier WSS 身份认证 | 公共 CA TLS、Noise、PeerId/public key pin 全通过 |
| I06 | WSS/Yamux 双向 protocol stream | Stat/Read 两条 stream 独立且双向正常 |
| I07 | WSS 大内容与背压 | 大 Seed/并发 Block 摘要正确、队列和内存有界 |
| I08 | 同供应商双 transport | 两种 transport 认证为同一 supplier，fallback 不换身份 |
| I09 | 长驻 Stat stream | 高频、多 hash、乱序响应，不重复建 stream且内存不增长 |
| I10 | 长驻 Read stream | 多 hash 并发按 request ID 正确关联 |
| I11 | Read 授权覆盖 | 更大 ID 覆盖旧上限，旧请求收到 ReadCancelled |
| I12 | ReadResponse 发送竞态 | 已开始 attachment 不截断，新请求不重复购买 |
| I13 | Stat/Read 隔离 | 大 attachment 期间 StatResponse 仍可及时返回 |
| I14 | 4/8 并发与恢复 | Frame 不串线、hash 正确、Reset/断线后新请求恢复 |
| I15 | 非白名单与错误 pin | 两种 transport 均拒绝非白名单及错误 PeerId/key/certhash |

I01 固定 identity vector 继续作为自动化基线，本单必须在 Keymaster 与 Go supplier 使用同一个不可变 `bitcoin-libp2p` release 重跑。任一侧使用本机 `file:`、未发布补丁或不同 vector 都不得进入 I02。

## 5. 浏览器矩阵

### 5.1 Chrome/Chromium

- 自动化 E2E 全量执行；
- 至少一次 headed/manual 复核真实页面、executor 切换和设置流程；
- 记录 WebRTC selected candidate pair 与 transport 证据。

### 5.2 Firefox

- WebRTC Direct、WSS 分别执行 I02–I15 适用项；
- 记录浏览器特有连接、stream、transferable 和内存行为；
- 不得用 Chromium 结果推定 Firefox 通过。

### 5.3 Safari

- 在目标 macOS/Safari 真机执行；
- 验证 Window executor、SharedWorker、WebRTC Direct、WSS 和 transferable；
- 若 Safari 缺少必要平台能力，记录最小复现并重新裁决支持范围，不得静默降级或把私钥移出 Worker。

## 6. 真实网络与供应商验收

### 6.1 WebRTC Direct

- 使用公网可达 UDP 或明确的稳定端口映射；
- 验证正确和错误 certhash；
- 验证 NAT/网络切换、端口不可达和中途断线；
- 证明实际使用 WebRTC Direct，不得混入 relay-signaled WebRTC、Circuit Relay 或 TURN。

### 6.2 WSS

- 使用公共信任链、匹配域名和正式 443/TCP 路径；
- 验证正确证书、错误域名、过期/无效证书；
- 验证反向代理透明传递 binary WebSocket；
- 验证 TLS 之后仍由 Noise/PeerId/public key 完成 supplier identity pin；
- 裸 WS 只允许 loopback，不作为发布证据。

### 6.3 目标 Go/NAS

- 使用指定生产形态的 Go supplier 与目标 NAS/挂载；
- NAS 数据保持只读边界；
- 执行 Stat、Seed Read、Block Read、并发、断线和重启；
- 记录 supplier 资源峰值、Keymaster 峰值与内容摘要；
- 不要求本单实现 NAS 新功能，发现供应商缺陷时在相邻仓库单独修复并回填 commit。

## 7. 产品级验收

真实浏览器中分别验证：

- Window 只持有 SDK `TypedSigner` bridge；RPC 只出现 32-byte Noise static key 或受限 Peer Record 结构，不出现任意 message/payload/digest/domain/format/algorithm 或 raw private key；
- Peer Record 的 PeerId 绑定 active key、addresses 为空且 sequence 单调不减；伪造记录必须失败；
- 每个浏览器至少完成一次与 Go supplier 的真实 Noise authenticated handshake，并记录 active public key、PeerId 与握手 identity 的一致性；
- `/settings/system` 的全局 Seed/Block 金额；
- 多 supplier 配置、地址顺序、启停、删除与 Probe；
- App override 的 inherit/finite/unlimited；
- trusted plugin 不经过 session/App policy；
- Connect session + verified App Identity；
- 额度内直接读取；
- 超额拒绝、本次授权、始终授权；
- Seed/Block 金额互不污染；
- Read params 无 `maxPriceSatoshis`、fileId、blockIndex；
- lock、logout、session revoke、active key switch、executor tab 关闭；
- reload 后设置和 always policy 恢复，但未完成购买不恢复。

## 8. 性能与资源证据

WebRTC Direct 与 WSS 分别记录：

```text
connection_setup_ms
stream_open_ms
first_frame_ms
stat_rtt_ms
read_ttfb_ms
read_throughput_bytes_per_second
open_stream_memory_bytes
pending_request_memory_bytes
response_queue_peak_bytes
```

至少覆盖：

- 10,000 次长驻 Stat；
- 4 个并发 Seed；
- 8 个并发 Block；
- 16 MiB Seed 期间并发 Stat；
- stream Reset；
- connection 断开；
- WebRTC Direct 到同 supplier WSS fallback。

验收关注有界、无持续增长和控制面不被 attachment 阻塞，不为发布人为制定脱离环境的吞吐常数。

## 9. 证据落盘

在 `docs/proposals/msfile/` 下新增或更新互操作报告，至少包含：

- 每个 I02–I15 的 PASS/FAIL/BLOCKED；
- 执行日期、环境、commit 与命令；
- multiaddr、PeerId/public key、certhash 和证书摘要；
- 测试内容的 hash/size，不提交内容正文；
- JSONL 事件摘要和峰值资源数据；
- 失败的最小复现；
- 外部环境责任人与待补条件。

大型原始浏览器 trace、视频或堆快照不直接提交 Git；报告记录 SHA-256、保存位置和脱敏说明。小型 JSONL 可作为 `docs/proposals/msfile/evidence/` 下的文本证据提交。

## 10. 阻断分类

### 10.1 产品阻断

以下失败必须退回 002 修复，不能靠文档豁免：

- identity pin 可绕过；
- raw private key 离开 Coordinator；
- Window 可借 Noise/Peer Record signer 请求其它 domain/digest/格式的签名，或实际生产 service 读取/依赖伪造的 `privateKey.raw`；
- Keymaster 保留自研 libp2p private-key adapter、身份/签名校验副本，或两端未固定同一 `bitcoin-libp2p` release/vector；
- 旧 epoch/executor 仍可签名或返回结果；
- hash/尺寸校验错误；
- Frame 串线、永久 pending、无界内存；
- trusted/Connect 权限或金额策略错误；
- 正确配置下目标 transport 无法工作。

### 10.2 环境阻断

只有确实缺少以下资源时才可以标记 BLOCKED：

- 目标 macOS/Safari 设备；
- 公共 CA 域名/WSS 部署；
- 指定 NAS 硬件或公网 UDP；
- 需要外部运维开放的端口或证书。

环境阻断必须写明缺少什么、谁提供、拿到后执行什么命令。它只阻止本单完成和正式启用，不否定 001/002 已完成状态。

`bitcoin-libp2p` SDK 缺陷不属于可静默豁免的环境阻断。发现后必须附最小复现和建议修复点，由项目负责人协调该项目；Keymaster/MSFile 实施者不得直接修改、打未发布补丁或复制实现绕过。

## 11. 正式文档与启用

只有 I02–I15 全部 PASS 且没有产品阻断后：

1. 更新 Keymaster Connect 正式协议文档和 SDK API 文档；
2. 把 MSFile proposal 的稳定契约迁入正式协议文档；
3. 更新设置说明、供应商部署要求和故障诊断；
4. 将状态矩阵改为已上线；
5. 单独审查并翻转 `defaultEnabled: true`；
6. 重新运行全仓测试、构建和正式页面 smoke。

不得因为单元测试全绿提前翻转默认开关。

## 12. 完成定义

- I01–I15 全部有可复现证据且 PASS；
- Chrome、Firefox、Safari 目标版本均完成适用矩阵；
- WebRTC Direct 和公共 CA WSS 均连接目标 Go/NAS supplier；
- trusted capability、Connect SDK、价格授权和生命周期完成产品级验收；
- 性能与内存证据表明队列有界且无持续增长；
- 正式协议/SDK/设置文档已更新；
- 全仓 typecheck、boundary、unit/integration/E2E 和 build 通过；
- 经独立审查后才允许 `defaultEnabled: true`。

如果仅剩明确的环境阻断，本单状态应保持 BLOCKED，并保留 `defaultEnabled: false`；不得写成“全部落地”。
