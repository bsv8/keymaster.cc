# 003 MSFile 无头环境发布预验收

> 结论：**BLOCKED-ENV（2026-08-27）**。没有发现新的产品阻断；当前环境能
> 完成的 Chromium + 本机正式 Go supplier 自动化已通过。缺少 Firefox、
> macOS/Safari、公共 CA WSS、公网 UDP 和指定 NAS，因此 I02–I15 不能整体
> 签署 PASS，`defaultEnabled` 必须保持 `false`。

## 当前可用环境

- Linux x86_64，仅 Playwright Headless Chromium `149.0.7827.55`；
- Playwright cache 中没有 Firefox/WebKit；无 headed 桌面；
- 本机 loopback WebRTC Direct；
- 本机 WSS，短期自签证书并以单一 SPKI 显式信任；
- 正式 `msfile-nas` 二进制，但数据目录是临时磁盘，不是指定 NAS；
- 无公共域名/公共 CA、无公网 UDP/NAT 测试拓扑。

## I02–I15 状态

`本机 PASS` 只表示自动化预验收通过，不替代施工单要求的完整发布环境。

| ID | 本机自动化 | 发布结论 | 仍缺条件 |
|---|---|---|---|
| I02 | Chromium WebRTC Direct + Noise identity PASS | BLOCKED-ENV | Firefox、Safari、真实公网 UDP |
| I03 | 双 stream 双向收发 PASS | BLOCKED-ENV | Firefox/Safari、目标网络 half-close/Reset 证据 |
| I04 | 当前 Seed/Block 摘要与并发 PASS | BLOCKED-ENV | 目标 NAS 的 16 MiB Seed 与资源峰值 |
| I05 | 受控 SPKI WSS + Noise/pin PASS | BLOCKED-ENV | 公共 CA、正式域名、443 反向代理、Firefox/Safari |
| I06 | WSS Stat/Read 双 stream PASS | BLOCKED-ENV | 公共 WSS 与其它浏览器 |
| I07 | WSS 4/8 并发 PASS | BLOCKED-ENV | 大 Seed、公共链路背压与资源峰值 |
| I08 | 同 supplier WebRTC/WSS 与 fallback PASS | BLOCKED-ENV | 公网双 transport |
| I09 | 10,000 Stat PASS | BLOCKED-ENV | 目标 NAS/浏览器组合复跑 |
| I10 | 多 hash 并发关联 PASS | BLOCKED-ENV | 三浏览器与目标 NAS |
| I11 | 真实同 hash 覆盖取消 PASS | BLOCKED-ENV | 三浏览器/目标网络复跑 |
| I12 | Go/TS 竞态定向测试 PASS | BLOCKED-ENV | 目标链路 attachment 竞态 trace |
| I13 | Read burst 期间 Stat PASS | BLOCKED-ENV | 16 MiB Seed 期间的三浏览器证据 |
| I14 | 4/8、lock/key switch/tab takeover PASS | BLOCKED-ENV | 真实断网/NAT/供应商重启与资源记录 |
| I15 | 错 key/PeerId/certhash/TLS PASS | BLOCKED-ENV | 两 transport 的目标 private whitelist 与三浏览器 |

I09 本轮 JSON 证据：

```json
{"event":"msfile_i09_headless","completed":10000,"durationMs":17515.5,"heapBeforeBytes":19285285,"heapAfterBytes":28366273}
```

这只是一次隔离环境样本；它证明没有越过 256 MiB 自动化门限，不作为正式
吞吐 SLA，也不替代目标设备的堆快照和持续增长分析。

## 外部验收所需输入

项目负责人需协调以下资源后继续 003，而不是修改 Runtime 绕过：

1. macOS + 目标 Safari 真机，以及目标 Firefox 环境；
2. 公共域名、公共 CA 证书、443/TCP WSS 反代；
3. 公网可达 WebRTC Direct UDP 映射；
4. 指定 NAS 型号、挂载和生产形态 supplier；
5. 专用无资金测试 App Identity 与测试数据；
6. 对应 Keymaster/MSFile 已提交 commit（当前验收源仍是待提交工作树）。

拿到资源后按 003 的环境清单冻结版本，复用
`e2e/msfile-production-runtime.spec.ts` 的 hash/identity 断言，并补采 candidate
pair、TLS chain、stream/Reset、16 MiB Seed、内存和 NAS 资源证据。全部 I02–I15
PASS 后才迁移正式文档并单独审查 `defaultEnabled: true`。
