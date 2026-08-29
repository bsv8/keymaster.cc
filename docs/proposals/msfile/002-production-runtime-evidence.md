# 002 MSFile 生产 Runtime 验收证据

> 结论：**PASS（2026-08-27）**。B01–B16 全部由生产代码、正式 Go
> `/msfile/1.0.0` supplier 与既有定向测试共同覆盖；没有注入 fake
> `MsFileTransport`。外部 Safari、公共 CA 与目标 NAS 仍属于 003。

## 冻结环境

- Keymaster 基线：`b6bfec5ca3ff3374238db7f923a0c8932fb50348`，本报告对应其后的待提交工作树；
- MSFile Proxy Protocol 基线：`75179dd75ec6a6e9ae0394810dcc0711efa78f98`，增加显式 Noise/Yamux 装配；
- `bitcoin-libp2p`：两端均为发布版 `0.1.0`；未修改 `/home/david/Workspaces/bitcoin-libp2p`；
- Node `v22.13.1`、pnpm `11.5.1`、Go `1.26.0 linux/amd64`；
- Playwright `1.61.1`、Headless Chromium `149.0.7827.55`；
- js-libp2p `3.3.9`、`@libp2p/webrtc 6.0.30`、`@libp2p/websockets 10.1.20`；
- go-libp2p `0.49.0`。

## 真实链路

`e2e/msfile-production-runtime.spec.ts` 每轮会：

1. 构建相邻仓库正式 `cmd/msfile-nas`；
2. 创建真实文件、Seed 索引、供应商 secp256k1 identity 与短期 TLS 证书；
3. 启动同时监听 WebRTC Direct 与 WSS 的 Go supplier；
4. 以 Headless Chromium 加载 Vite 生产构建；
5. 通过真实 PluginHost、Coordinator SharedWorker、Window executor 和
   `bitcoin-libp2p` 拨号；
6. trusted `msfile.service` 与不同 origin 的真实 Connect SDK 分别读取；
7. 对返回 Seed/Block 重新计算 SHA-256，不把 attachment 写入报告或日志。

WSS 成功浏览器只信任本轮证书 SPKI；反例使用没有该 SPKI 的独立 Chromium，
证明没有使用全局 `ignoreHTTPSErrors`。Chromium 不向页面披露证书失败细节，
因此公开结果为 `dial_failed`，但安全断言是未信任证书无法连接。

## B01–B16

| ID | 结果 | 证据摘要 |
|---|---|---|
| B01 | PASS | Chromium → Go WebRTC Direct 完成 Stat、Seed、Block |
| B02 | PASS | Chromium → Go WSS 在 TLS + Noise + Yamux 下完成三类操作 |
| B03 | PASS | 错公钥/PeerId 在保存边界拒绝；错 certhash 与未信任 TLS 在拨号边界拒绝 |
| B04 | PASS | 4 Seed + 8 Block 与 Stat 同时执行，Stat 使用独立长驻 stream |
| B05 | PASS | 多 hash 并发结果逐项 hash 对应；codec/Go server 乱序定向测试通过 |
| B06 | PASS | 同 hash 两次真实 wire Read：旧请求取消，新请求返回正确 Block |
| B07 | PASS | 4 Seed + 8 Block 真实并发，无串线且摘要正确 |
| B08 | PASS | 无效首地址后回落同 supplier WSS，PeerId/public key 不变 |
| B09 | PASS | 10,000 次 Stat 复用生产 stream；配置/epoch 重建后新请求恢复 |
| B10 | PASS | 关闭持有 lease 的 tab，另一 tab 接管并继续 WSS Read |
| B11 | PASS | lock/unlock 与 active-key switch 均撤销旧 runtime/lease，并用新 owner 重建 |
| B12 | PASS | trusted capability 无 session 完成真实 Stat/Seed/Block |
| B13 | PASS | 不同 origin Connect SDK 经 session + 已验证 App Identity + 全局金额额度完成真实读 |
| B14 | PASS | supplier 日志不含 identity 私钥；attachment 只经 transferable/摘要断言 |
| B15 | PASS | 生产 Go 握手成功；001 signer 边界与 Worker 定向测试继续通过 |
| B16 | PASS | 两仓均锁定发布版 `bitcoin-libp2p 0.1.0`，无 `file:` 依赖或复制 adapter |

金额超限的拒绝、本次授权、始终授权由 `msfileService.test.ts` 的供应商错误
控制夹具覆盖。正式 NAS 当前内容价格为 0，因此 Connect 生产 E2E 验证的是
额度内自动执行；不能伪造一次超限审批。

## 本轮发现并修复

- 浏览器默认 connection gater 会拒绝 loopback/LAN NAS：生产 host 现在允许
  已经由供应商配置和 identity pin 约束的私网地址；
- Go supplier 过去依赖 go-libp2p 默认 security/muxer：现显式冻结 Noise/Yamux；
- generate/import key 的 active-key 切换遗漏 MSFile lease 撤销，Window 又可能在
  session/revoke 竞态中误判旧 executor 仍有效：Worker 与 Window 双侧均已收口，
  并新增单测和真实浏览器回归。
- Coordinator 的并发预算是 4 Seed + 8 Block，但 Window 单 supplier pending
  曾误设为 8：现已对齐为 12，并在 001→002 串跑负载下连续三轮通过。
- 普通 Vite 构建曾仍生成 E2E hook 的孤立 chunk：现由 Vite virtual module
  在模块图入口隔离；普通 `pnpm build` 对测试密码/session 注入标识零命中。

## 验收命令

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/plugin-msfile/src
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts
pnpm exec vitest run packages/plugin-protocol/src packages/connect/src
pnpm exec playwright test e2e/msfile-production-runtime.spec.ts --project=chromium --workers=1
pnpm build
pnpm test

export MSFILE_PROXY_PROTOCOL_DIR="/path/to/MSFile-Proxy-Protocol"
cd "$MSFILE_PROXY_PROTOCOL_DIR/labs/webrtc-go"
go test ./...
go test -race ./...
go build ./cmd/msfile-nas
```

最终结果：typecheck、两项 boundary、全仓 185 个 Vitest 文件、001+002
Playwright 12/12、生产 build、生产 E2E hook 零泄漏、Go `test`/`test -race`/
正式构建及两仓 `diff --check` 全部 PASS。本报告不翻转插件默认开关。
