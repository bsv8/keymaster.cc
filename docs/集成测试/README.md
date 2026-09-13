# Keymaster 集成测试

这套测试从检查者能理解的用户目标出发，再向下追踪到浏览器、Worker、协议和外部资源。

## 如何运行

| 命令 | 层级 | 说明 |
| --- | --- | --- |
| `pnpm test:e2e:integration` | `local-integration` | 生产构建 + 真实 Chromium；不需要 S3、testnet 或长期秘密 |
| `pnpm test:e2e:integration:list` | — | 只列出集成测试，不启动浏览器 |
| `pnpm test:e2e` | `local-core` + `dev-http` | 稳定默认聚合入口，顺序运行本地生产构建和非安全 HTTP Coordinator 回归 |
| `pnpm test:e2e:local-core` | `local-core` | 只运行 `journeys/local` 和 `gates/local` |
| `pnpm test:e2e:dev-http` | `dev-http` | 独立 Vite dev server，验证非安全 HTTP Coordinator 边界 |
| `pnpm test:e2e:msfile` | `msfile` | 需要临时 Go supplier 的 MSFile 技术 Gate；默认不运行 |
| `pnpm check:integration-coverage` | — | 检查生产入口、矩阵、Journey/Gate 和生成视图的一致性 |
| `pnpm typecheck:e2e` | — | 检查 E2E TypeScript 类型 |
| `pnpm test:e2e:real-resource` | `real-resource` | 显式提供受保护资源配置后才运行；缺配置时 fail closed |
| `pnpm test:e2e:real-s3` | `real-resource` | 只读取 `s3.json`，执行真实 S3 初始化；不依赖 SatSubscription/testnet 配置 |
| `pnpm test:e2e:deployment` | `deployment-acceptance` | 收集该执行档的全部 4 个正式场景；必须提供 `KEYMASTER_E2E_DEPLOYMENT_BASE_URL` 和不可变 `KEYMASTER_DEPLOYED_BUILD_ID`，本地 preview 不能替代它 |

部署层的 `pnpm test:e2e:external` 还需要 `KEYMASTER_EXTERNAL_APPVIEW_ORIGIN`、
`KEYMASTER_EXTERNAL_APPVIEW_SUCCESS_SELECTOR`，并沿用同一个
`KEYMASTER_E2E_DEPLOYMENT_BASE_URL` 与 `KEYMASTER_DEPLOYED_BUILD_ID`。不可逆 I/O 和恢复
runner 也只接受这个目标部署 Build ID；缺少地址、hook 或不可变标识时直接失败，不把跳过当成通过。

所有浏览器 spec 已统一位于 `e2e/integration/`；`pnpm test:e2e` 是
`local-core` + `dev-http` 的稳定聚合入口，不再扫描 `e2e/` 根目录或隐式收集外部资源测试。旧测试的独有断言
已经按“重复合并、独有能力迁移、证据层级拆分”落到对应 Journey/Gate；覆盖矩阵只登记正式
`J-` Journey 和 `G-` Gate，不再维护过渡性的旧测试目录。每条 Journey 使用自己的浏览器上下文，
不会通过另一个 Playwright `test()` 共享状态。

## 目录约定

- `journeys/local/`：不依赖仓库外资源的本地用户 Journey。
- `journeys/real-resource/`：需要受保护 S3、testnet 或 SatSubscription 资源的 Journey。
- `journeys/deployment/`：绑定不可变 Build ID 的目标部署 Journey。
- `flows/`：只封装可复用业务过程，不注册 `test()`。
- `drivers/`：只负责可访问性定位、页面/协议等待和浏览器技术证据。
- `resources/`：只在 Node 侧处理 S3、testnet 和 SatSubscription 资源。
- `gates/local/`：本地浏览器能力、生命周期和秘密边界 Gate。
- `gates/dev-http/`：非安全 HTTP 开发服务器 Gate。
- `gates/lifecycle/`：Coordinator/插件生命周期真实浏览器 Gate。
- `gates/msfile/`：临时 Go supplier 的 MSFile/P2P 技术 Gate。
- `gates/real-resource/`：真实资源清理范围 Gate。
- `gates/deployment/`：不可逆 I/O 和部署恢复 Gate。
- `support/`：场景状态、运行编号、脱敏和报告辅助工具。

## 证据边界

`local-integration` 只证明本地生产构建在真实浏览器中的链路；它不证明 S3、testnet、公共
P2P 或目标部署。`real-resource` 只证明本次实际连接到的 testnet/S3/SatSubscription 资源，
不自动提升为 mainnet 或公开部署验收。`deployment-acceptance` 必须绑定报告中的 Build ID。

报告中的 `未执行`、`阻断`、`清理失败` 和 `结果未知` 都是独立结论，不能折叠为 `passed`。

真实资源配置的空白模板位于 `资源配置模板/`。复制到仓库外的
`/home/david/.config/keymaster-e2e/` 后，必须由维护者人工填写并设置 `0700/0600` 权限；模板本身
不含任何凭据。`real-s3` 命令只执行 s3.json 指定桶的 lease/清理和真实 S3 Journey；完整
`real-resource` 命令还会执行 SatSubscription 配置投影检查和 testnet 资金库预检；真实 Sat
页面 Journey 使用独立的 `real-satsubscription-page` 项目运行，避免 S3/testnet 资源阻断掩盖页面结果。S3 初始化
Journey 会使用 setup 的 lease 在隔离 prefix 下建立逻辑桶，并在刷新后验证恢复；它不会
创建物理桶。非前缀 setup/teardown 才执行指定桶的全量业务对象清理。真实 testnet 资产
Journey 还要等待链上确认并归集。SatSubscription 健康
Journey 只检查不冒充页面结果的配置投影，真实页面 Journey 还要比较正确/错误供应商身份的
连接状态；两者都不能替代充值、消费与账本对账；
尚未配置真实适配器的业务 Journey 不会被伪装成已通过。

## 检查者阅读顺序

1. 先看 [覆盖矩阵.md](./覆盖矩阵.md)，确认需求、场景和证据层级。
2. 再看对应 Journey 的文件头和中文 `test.step`，理解用户为什么完成这件事。
3. 需要技术细节时，再沿 Flow → Driver → Resource/Gate 追踪。
4. 最后查看命令输出和报告；没有执行的外部层级保持明确缺口。

矩阵的机器真值是 [覆盖矩阵.yaml](./覆盖矩阵.yaml)。它采用 YAML 1.2 的 JSON 子集，因而不依赖
测试环境隐式安装 YAML 解析器；生成 Markdown 和一致性校验都只读取这一份真值。
