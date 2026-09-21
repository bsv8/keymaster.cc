# 集成测试

集成测试按用户目标组织，同时验证浏览器、Worker、协议和外部资源。覆盖状态只维护在
`覆盖矩阵.yaml`；[覆盖矩阵.md](./覆盖矩阵.md)是脚本生成的人类视图，不应手工修改。

## 测试层级

| 层级 | 中文含义 | 能证明什么 |
| --- | --- | --- |
| `local-integration` | 本地浏览器集成 | 生产构建在 Chromium 中的确定性业务与失败路径 |
| `p2pkh` | 链上资产与转账 | 真实 testnet 余额、转账、确认与资金归集 |
| `satsubscription` | SatSubscription | 真实服务/页面/健康投影的订阅、账单与连接行为 |
| `s3` | S3 桶存储 | 真实 S3 桶初始化、Key 切换与资源安全 |
| `msfile` | MSFile 与 P2P | 真实 msfile 供应商的文件读取与 Range 行为 |
| `deployment-acceptance` | 目标部署验收 | 指定不可变 Build ID 的公开部署行为 |

较低层级不能替代较高层级；未执行、阻断、清理失败和结果未知都不能写成通过。

## 代码组织

```text
Journey  用户可以独立理解和报告的一段业务旅程
  ↓
Flow     可复用业务过程，不单独注册测试
  ↓
Driver   页面、协议和浏览器操作
  ↓
Resource S3、testnet 等外部资源及其清理

Gate     不适合写成用户旅程的技术边界
```

每个 Journey 独立拥有状态。确实共享不可重复资源时，由 Resource 显式申请和释放，不能依赖
前一个测试先成功。

## 常用命令

```bash
pnpm test:e2e                    # 本地核心 + 非安全 HTTP 边界
pnpm test:e2e:integration        # 本地生产构建的完整 Chromium 集成测试
pnpm test:e2e:msfile             # 临时 Go Supplier 的 MSFile Gate
pnpm test:e2e:s3                 # 真实 S3
pnpm test:e2e:resources          # 资源准备 + 真实资源集合
pnpm test:e2e:deployment         # 指定部署验收
pnpm check:integration-coverage  # 检查矩阵、插件、场景和生成视图一致
```

## 真实资源安全

配置模板在 `资源配置模板/`。复制到仓库外的
`/home/david/.config/keymaster-e2e/` 后填写，并设置目录 `0700`、文件 `0600`。
其中 `seed-key.hex` 是测试资金库，`key01.hex` 是页面导入的固定可追踪测试 Key，
两者都必须存在（缺失时资源读取 fail closed）。

- 凭据不能写入仓库、URL、日志或附件。
- S3 测试先取得 lease（排他租约），按本轮 `run_id` 和 prefix 隔离并在 finally 清理。
- testnet 使用固定 key01 钱包：每轮开始断言其无可花费输出；页面广播前失败时
  Node 按链上事实归集回 seed；遗留余额用 `pnpm collect:testnet:key01` 手工归集。
  广播结果未知时不盲目重发，也不再维护跨轮恢复账本。
- 运行数据（state/logs/artifacts）落在仓库内 `e2e/runs/<执行档>/<run-id>/`，
  该目录不进 git、可整体删除；仓库外配置目录只放秘密。
- 报告上传前扫描私钥、WIF、S3 Secret 和已知秘密；命中即阻断附件。
- 配置缺失或权限不安全时 fail closed（安全拒绝），不把跳过当成通过。

## 维护要求

新增正式插件、路由、协议或高风险边界时，同步更新 `覆盖矩阵.yaml` 并新增独立 Journey/Gate。
运行 `pnpm generate:integration-coverage` 生成 Markdown，再运行一致性检查。
