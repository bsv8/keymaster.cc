# Keymaster 集成测试

这套测试从检查者能理解的用户目标出发，再向下追踪到浏览器、Worker、协议和外部资源。

## 如何运行

| 命令 | 层级 | 说明 |
| --- | --- | --- |
| `pnpm test:e2e:integration` | `local-integration` | 生产构建 + 真实 Chromium；不需要 S3、testnet 或长期秘密 |
| `pnpm test:e2e:integration:list` | — | 只列出集成测试，不启动浏览器 |
| `pnpm check:integration-coverage` | — | 检查生产入口、矩阵、Journey/Gate 和生成视图的一致性 |
| `pnpm typecheck:e2e` | — | 检查 E2E TypeScript 类型 |
| `pnpm test:e2e:real-resource` | `real-resource` | 显式提供受保护资源配置后才运行；缺配置时 fail closed |
| `pnpm test:e2e:deployment` | `deployment-acceptance` | 必须提供不可变目标 Build ID；本地 preview 不能替代它 |

普通 `pnpm test:e2e` 仍保留仓库原有的 E2E。旧文件的需求、层级和迁移边界登记在
[`现有E2E迁移目录.json`](./现有E2E迁移目录.json)，不会因为新目录建设而静默丢失断言。
新场景位于 `e2e/integration/`，不会通过另一个 Playwright `test()` 共享状态；每条 Journey
使用自己的浏览器上下文。

## 目录约定

- `journeys/`：一个完整用户目标对应一个可独立报告的 Playwright 测试。
- `flows/`：只封装可复用业务过程，不注册 `test()`。
- `drivers/`：只负责可访问性定位、页面/协议等待和浏览器技术证据。
- `resources/`：只在 Node 侧处理 S3、testnet 和 SatSubscription 资源。
- `gates/`：不适合伪装成用户旅程的 Worker、协议、并发和秘密安全门禁。
- `support/`：场景状态、运行编号、脱敏和报告辅助工具。

## 证据边界

`local-integration` 只证明本地生产构建在真实浏览器中的链路；它不证明 S3、testnet、公共
P2P 或目标部署。`real-resource` 只证明本次实际连接到的 testnet/S3/SatSubscription 资源，
不自动提升为 mainnet 或公开部署验收。`deployment-acceptance` 必须绑定报告中的 Build ID。

报告中的 `未执行`、`阻断`、`清理失败` 和 `结果未知` 都是独立结论，不能折叠为 `passed`。

真实资源配置的空白模板位于 `资源配置模板/`。复制到仓库外的
`/home/david/.config/keymaster-e2e/` 后，必须由维护者人工填写并设置 `0700/0600` 权限；模板本身
不含任何凭据。当前 `real-resource` 命令先执行资源权限、专用 S3 ownership/lease/清理、
SatSubscription 健康预检和 testnet 资金库预检；真实 testnet 资产 Journey 还要等待链上确认并
归集。SatSubscription 健康 Journey 只证明运行时身份和网络，不能替代充值、消费与账本对账；
尚未配置真实适配器的业务 Journey 不会被伪装成已通过。

## 检查者阅读顺序

1. 先看 [覆盖矩阵.md](./覆盖矩阵.md)，确认需求、场景和证据层级。
2. 再看对应 Journey 的文件头和中文 `test.step`，理解用户为什么完成这件事。
3. 需要技术细节时，再沿 Flow → Driver → Resource/Gate 追踪。
4. 最后查看命令输出和报告；没有执行的外部层级保持明确缺口。

矩阵的机器真值是 [覆盖矩阵.yaml](./覆盖矩阵.yaml)。它采用 YAML 1.2 的 JSON 子集，因而不依赖
测试环境隐式安装 YAML 解析器；生成 Markdown 和一致性校验都只读取这一份真值。
