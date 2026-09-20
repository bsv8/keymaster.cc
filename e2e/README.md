# Keymaster E2E 测试

本页是 e2e 的代码视角总览：**每个执行档(Group)及档内每个场景(Item)**。测试层级含义、
真实资源安全规则和证据状态以 [集成测试文档](../docs/集成测试/README.md) 为准，覆盖真值在
[覆盖矩阵.yaml](../docs/集成测试/覆盖矩阵.yaml)，本页不重复维护状态。

所有 spec 都在 `e2e/integration/` 下，跑的是生产构建产物(`vite preview`)，不是 dev server。

## 代码分层

```text
Journey  用户可以独立理解和报告的一段业务旅程(journeys/*, 独立注册)
  ↓
Flow     可复用业务过程，不单独注册测试(flows/*)
  ↓
Driver   页面、协议和浏览器操作(drivers/*)
  ↓
Resource S3、testnet、SatSubscription 等外部资源及其清理(resources/*)

Gate     不适合写成用户旅程的技术边界(gates/*)
support/ 场景元数据、脱敏、诊断等横切能力
```

场景编号由 `support/scenarioMetadata.ts` 统一定义，spec 里通过
`export const JOURNEY_ID/GATE_ID = XXX.id` 引用。

## 执行档总表

| 执行档(Group) | 配置/入口 | 命令 | 目录范围 | 中文说明 |
| --- | --- | --- | --- | --- |
| local-core | `playwright.config.ts` | `pnpm test:e2e:local-core` | `journeys/local`、`gates/local` | 日常入口，30s 超时；`pnpm test:e2e` = local-core + dev-http |
| local-integration | `playwright.integration.config.ts` | `pnpm test:e2e:integration` | 同上 | 完整本地集成，60s 超时；另有初始化/多标签单场景 smoke 命令 |
| dev-http | `playwright.dev-http.config.ts` | `pnpm test:e2e:dev-http` | `gates/dev-http` | 非安全 HTTP + 非 loopback 域名，真实 Vite dev server，不复用旧进程 |
| lifecycle-local | `playwright.lifecycle.config.ts` | `pnpm test:e2e:lifecycle:local` | `gates/lifecycle` | 本地 WebLoom 0.5.0 tarball 的临时副本验收 |
| lifecycle-registry | `playwright.lifecycle.registry.config.ts` | `pnpm test:e2e:lifecycle:registry` | `gates/lifecycle` | npm registry 0.5.0 的临时副本验收，`workers: 1` 串行 |
| msfile | `playwright.msfile.config.ts` | `pnpm test:e2e:msfile` | `gates/msfile`、`journeys/msfile` | 需临时 Go supplier，360s 超时，`workers: 1` |
| satsubscription | `playwright.satsubscription.config.ts` | `pnpm test:e2e:satsubscription` | `journeys/satsubscription` | 从仓库外 SatSubscription 构建正式服务 + 一次性 PostgreSQL；需 `SATS_SUBSCRIPTION_DIR`、Go、PostgreSQL，360s 超时，`workers: 1` |
| real-resource | `playwright.real-resource.config.ts` | `pnpm test:e2e:real-resource` | `resources/*`、`journeys/real-resource/*` | 受保护真实资源；setup → 场景 → teardown 投影，`trace/screenshot/video` 全关 |
| real-s3 | `playwright.real-s3.config.ts` | `pnpm test:e2e:real-s3` | `resources/s3-*`、`gates/real-resource/resource-safety`、`real-s3-initialization` | 只读取仓库外 `s3.json`，不碰 testnet/Sat 秘密 |
| deployment | `playwright.deployment.config.ts` | `pnpm test:e2e:deployment` | `journeys/deployment`、`gates/deployment` | 目标部署验收，必须提供不可变 Build ID；单项可用脚本入口(见下表) |

执行档之外还有两个辅助脚本：`pnpm smoke:msfile-media-sw`(线上媒体 SW 响应头契约)和
`pnpm verify:msfile-read-concurrency-pressure`(读取并发压力与内存上界)。

---

## 1. local-core / local-integration

Journey(6 项，跑在真实 Chromium 生产 preview 上，独立 BrowserContext)：

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| J-LOCAL-INIT-MENU | `journeys/local/initialization-generated.spec.ts` | 新用户生成 Key 完成初始化 → 刷新恢复 → 锁定 → 正确密码重新解锁同一身份 | KM-INIT-001、KM-VAULT-001、KM-NAV-001 |
| J-LOCAL-INIT-IMPORTED | `journeys/local/initialization-imported-key.spec.ts` | 首次初始化走正式导入入口建立第一把 Hex Key，桶密码和私钥不落 localStorage/IndexedDB | KM-INIT-001、KM-VAULT-001 |
| J-LOCAL-CONTACT-MESSAGE | `journeys/local/local-contact-message.spec.ts` | 保存联系人并归属当前 active Key；非法公钥在表单内失败，合法公钥打开正确会话 | KM-INIT-001、KM-CONTACT-001、KM-MESSAGE-001 |
| J-LOCAL-SETTINGS | `journeys/local/local-settings.spec.ts` | 从正式菜单打开系统/应用/插件设置；切换语言立即生效且刷新后持久化 | KM-NAV-001、KM-SETTINGS-001 |
| J-LOCAL-P2PKH-NAVIGATION | `journeys/local/p2pkh-navigation.spec.ts` | 真实 provider 下打开链上交易和本地交易页面；无余额只验证导航，不冒充转账成功 | KM-ASSET-001、KM-NAV-001 |
| J-LOCAL-MULTI-TAB-RECOVERY | `journeys/local/multi-tab-recovery.spec.ts` | 固定 tab1→tab2→tab1 顺序刷新，共享 Worker/catalog 下运行态可恢复 | KM-TECH-001、KM-LIFECYCLE-001 |

Gate(4 项)：

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| G-STORAGE-BROWSER-BOUNDARY | `gates/local/storage-browser-boundary.spec.ts` | 真实浏览器内 IndexedDB/localStorage/Web Crypto/SharedWorker 边界；Local 桶对象落在 IndexedDB，未授权时永久存储授权条持续显示，授权后消失 | KM-TECH-001 |
| G-LIFECYCLE-BOUNDARY | `gates/local/lifecycle-boundary.spec.ts` | 2 个用例：撤权同步先于 drain 并拒绝新操作；provider 注销后迟到刷新不能复活受保护 outpoint | KM-TECH-001、KM-LIFECYCLE-001 |
| G-REDACTION-BOUNDARY | `gates/local/redaction-boundary.spec.ts` | SecretString 默认脱敏；私钥形状进入附件时在上传前被阻断 | KM-TECH-002 |
| G-CONFIG-SAFETY | `gates/local/config-safety.spec.ts` | 2 个用例：合法仓库外配置只以 SecretString 载入；目录权限过宽时读取资源前 fail-closed | KM-TECH-002 |

---

## 2. dev-http

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| G-COORDINATOR-DEV-HTTP | `gates/dev-http/coordinator-dev-http.spec.ts` | 非安全 HTTP(非 loopback 域名)下真实 SharedWorker 仍完成 Local 初始化最终 HMAC 提交；Worker 错误和页面 fatal crash 不被吞掉 | KM-TECH-001、KM-INIT-001 |

---

## 3. lifecycle-local / lifecycle-registry

两个执行档跑同一组 spec，区别只在 WebLoom 来源(本地 tarball 或 npm registry)，证据不混用。
所有用例 `serial`。

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| G-PLUGIN-LIFECYCLE-PRODUCTION | `gates/lifecycle/plugin-lifecycle-production.spec.ts` | 3 个用例：真实 SharedWorker/MessagePort 提供 owner K-V 与 crypto 且有服务端 grant；锁屏即时拒绝旧 proxy、解锁得到新实例；Dedicated Worker dispose 后撤权 | KM-TECH-001、KM-LIFECYCLE-001 |
| G-COORDINATOR-RUNTIME-LIFECYCLE | `gates/lifecycle/coordinator-runtime-lifecycle.spec.ts` | 2 个用例：关闭一个 tab 后另一 tab 完成 owner handoff；in-flight session.open 在物理撤权后作为 late result 被丢弃 | KM-TECH-001、KM-LIFECYCLE-001 |

---

## 4. msfile

需临时 Go supplier，只使用临时测试对象，结束关闭 lease 和远端连接。所有用例 `serial`。

Journey(2 项，真实页面 + 真实 `cmd/msfile-nas` 或 BSV8 官方服务)：

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| J-REAL-MSFILE-NAS | `journeys/msfile/real-nas-file.spec.ts` | 全新 Local 身份在 /settings/system 保存金额上限并 pin 真实 NAS 的 WebRTC Direct 地址；Test connection 成功后从正式文件入口按 Seed Hash 获取文本预览（与源文件完全一致）、下载跨 Block 二进制并做 SHA-256 对账、未知 Seed 只显示没有文件；供应商 Read 计数证明读取到达真实 NAS；刷新重新解锁后同一身份仍能再次取得文件 | KM-MSFILE-001 |
| J-REAL-MSFILE-OFFICIAL | `journeys/msfile/official-nas-files.spec.ts` | 系统内置 BSV8 官方供应商（不可删除）经真实 WSS 完成 Test connection；sample-15s.wav/mp3 与 sample-30s.mp4 按原生 Range 方式打开并播放（虚拟媒体 URL + 真实 Block 读取 + Range/206 证据），Hello.md 按文本预览打开；不把下载当成打开 | KM-MSFILE-001 |

Gate(3 项)：

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| G-MSFILE-EXECUTOR | `gates/msfile/msfile-executor-spike.spec.ts` | 5 个用例：真实 Go Noise/Identify/Peer Record 签名；畸形字段被类型化 bridge 拒绝；同一 SharedWorker 只允许一个 executor 且可接管；锁定推进 epoch 使旧 signer 失效；transferable burst 有界且 Window 不暴露私钥 | KM-MSFILE-001、KM-LIFECYCLE-001 |
| G-MSFILE-NATIVE-RANGE | `gates/msfile/msfile-native-range.spec.ts` | 11 个用例：原生媒体经真实 SW/Go 的 Range/416/cancel/尾部 moov/多格式；SW 重启与旧根作用域升级；锁屏/换 Key/换 supplier/unload 撤销媒体 session；协议不匹配安全中止；production preview 媒体 SW 部署契约 | KM-MSFILE-001、KM-TECH-001、KM-LIFECYCLE-001 |
| G-MSFILE-PRODUCTION-RUNTIME | `gates/msfile/msfile-production-runtime.spec.ts` | 9 个用例：WebRTC Direct/WSS 的真实 Stat/Seed/Block 和有界并发；TLS/PeerId/certhash pin 校验失败 fail-closed；request 取消；1 万次 Stat 内存有界；真实首页预览/下载；Connect SDK 与 App Identity；锁屏撤销和 tab 接管 executor lease | KM-MSFILE-001、KM-APPS-001、KM-LIFECYCLE-001 |

---

## 4.1 satsubscription

真实 SatSubscription 源码执行档；辅助入口 `node scripts/run-satsubscription-e2e.mjs`
会解析 Go/PostgreSQL 并透传 Playwright 参数。资源由场景里
`resources/satsubscription/localServerResource.ts` 按运行启动和回收：临时 PostgreSQL
集群、随机服务身份、回环 WebSocket 地址，不读取仓库外秘密。

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| J-REAL-SATSUB-MESSAGE | `journeys/satsubscription/real-channel-message.spec.ts` | 三个独立浏览器进程各自建立白名单身份并连接正式供应商；验证真实 Channel 私信收发、刷新后本地历史、账本 0 扣费、第三方不可见，以及桶内 sent/received raw + timeindex 证据与 raw 缺失展示 | KM-MESSAGE-001、KM-SATSUB-001 |

## 5. real-resource

项目依赖：`resource-setup` → `real-resource`(默认场景) → `resource-teardown`；
`real-satsubscription-page` 不依赖资源准备项目，独立报告页面结果。配置在仓库外
`~/.config/keymaster-e2e/`，缺失或权限不安全时 fail-closed。

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| 资源准备 | `resources/resource-setup.spec.ts` | 整轮唯一 setup：配置权限预检；S3 取得 lease 并全量开场清理；testnet 网络/余额/旧账门禁 | KM-RESOURCE-001 |
| 资源可用性 | `resources/real-resource-availability.spec.ts` | 断言同一 `run_id` 的资源状态存在且 lease 已取得，不读取长期秘密 | KM-RESOURCE-001 |
| J-REAL-TESTNET-ASSET | `journeys/real-resource/real-testnet-asset.spec.ts` | 真实 testnet 余额、转账、txid 对账和资金归集；保护 outpoint/结果未知不按普通可重试处理 | KM-ASSET-001 |
| J-REAL-SATSUB-HEALTH | `journeys/real-resource/real-satsubscription-health.spec.ts` | 只读取脱敏配置投影；Node 探针不冒充页面健康和充值/账本结果 | KM-SATSUB-001 |
| J-REAL-SATSUB-PAGE | `journeys/real-resource/real-satsubscription-page.spec.ts` | 真实页面把 multiaddr 映射为 supplier 配置；先验证错误公钥 disconnected/degraded，再验证正确公钥 online | KM-SATSUB-001 |
| 资源收尾 | `resources/resource-teardown.spec.ts` | 依赖失败也执行；清理指定桶并释放 lease，清理不确定时保留 lease 交给下一轮恢复 | KM-RESOURCE-001 |

---

## 6. real-s3

项目依赖：`s3-resource-setup` → `real-s3`(安全 Gate + 初始化 Journey) → `s3-resource-teardown`。

| 编号 | 文件 | 中文说明 | 覆盖需求 |
| --- | --- | --- | --- |
| 资源准备 | `resources/s3-resource-setup.spec.ts` | 真实 S3 专用 setup：取得 lease 并执行非前缀全量开场清理，不读 testnet/Sat 秘密 | KM-RESOURCE-001、KM-INIT-002 |
| G-RESOURCE-SAFETY | `gates/real-resource/resource-safety.spec.ts` | 真实业务对象只在本场景 `run_id/scenario_id` prefix 内；prefix 清理不越界，路径越界 fail-closed | KM-RESOURCE-001 |
| J-REAL-S3-INIT | `journeys/real-resource/real-s3-initialization.spec.ts` | 真实 S3 表单连接探测 → 创建逻辑桶 → 首把 Key 提交到 run 隔离前缀 → 刷新恢复 → 主动锁定/仅 Key 密码解锁 → 清空本机目录的全新浏览器接入已有桶（解锁既有 Key 不覆盖）；凭据不进 localStorage | KM-INIT-002 |
| J-REAL-S3-BUCKET-KEY-SWITCH | `journeys/real-resource/real-s3-bucket-key-switching.spec.ts` | Local 桶与真实 S3 桶各两把 Key（第二把在 `/storage/buckets` 新建）→ 桶内与跨桶交叉切换（以首页“我的信息”公钥为准）→ 桶管理页列出当前 S3/非当前 Local 桶 Key，并删除非当前 Local Key（KeyHold + owner 数据，不影响当前身份）；远端 keys/ 真值校验 | KM-STORAGE-001 |
| 资源收尾 | `resources/s3-resource-teardown.spec.ts` | 全量业务清理确认后才释放 lease | KM-RESOURCE-001 |

---

## 7. deployment

必须有非本机真实部署地址和不可变 Build ID(`commit40位-sourceDigest16位`)。前两项由
`playwright.deployment.config.ts` 统一运行；带故障注入 runner 的 Gate 建议用脚本入口，
脚本会先校验目标环境再启动 Playwright，缺参数直接失败而不是 skip：

| 编号 | 文件 | 中文说明 | 覆盖需求 | 脚本入口 |
| --- | --- | --- | --- | --- |
| J-DEPLOYMENT-APPS | `journeys/deployment/deployment-acceptance.spec.ts` | 公开入口返回与期望一致的不可变 Build ID 响应头 | KM-APPS-001 | `pnpm test:e2e:deployment` |
| J-DEPLOYMENT-APPVIEW-CONNECT | `journeys/deployment/external-appview-connect.spec.ts` | 正式 Apps 菜单打开 Session Window，外部 AppView 固定 origin 完成 `connect.launch` 并显示成功状态 | KM-APPS-001 | `pnpm test:e2e:external` |
| G-DEPLOYMENT-IRREVERSIBLE-IO | `gates/deployment/plugin-lifecycle-irreversible-io.spec.ts` | 目标部署 runner 返回 7 类不可逆操作(上传/订阅/广播/支付等)结构化脱敏报告；operationId 幂等且未知结果不重放 | KM-APPS-001、KM-LIFECYCLE-001 | `pnpm test:e2e:irreversible-io` |
| G-DEPLOYMENT-COORDINATOR-RECOVERY | `gates/deployment/plugin-lifecycle-recovery.spec.ts` | 目标部署完成 lease 崩溃恢复演练：新 Worker 拒绝抢占 → 旧操作结束后 retry 接管 → 旧句柄被拒且 lease 归零 | KM-APPS-001、KM-LIFECYCLE-001 | `pnpm test:e2e:recovery` |

---

## 常用命令

```bash
pnpm test:e2e                    # 本地核心 + 非安全 HTTP 边界
pnpm test:e2e:integration        # 完整本地集成
pnpm test:e2e:msfile             # 本地/临时 Go supplier 的 MSFile Journey 与 Gate
pnpm test:e2e:satsubscription    # 真实 SatSubscription 源码 + 一次性 PostgreSQL 的 Channel 消息
pnpm test:e2e:real-s3            # 真实 S3
pnpm test:e2e:real-resource      # 真实资源集合
pnpm test:e2e:deployment         # 指定部署验收
pnpm check:integration-coverage  # 校验覆盖矩阵、插件、场景和生成视图一致
pnpm test:e2e:report             # 打开最近一次 Playwright 报告
```

## 新增或修改场景

1. 在 `e2e/integration/support/scenarioMetadata.ts` 注册稳定编号、开始状态、成功标准和资源类型；
2. spec 放入对应目录(Journey 进 `journeys/<层级>`，技术边界进 `gates/<层级>`)并引用该编号；
3. 在 `docs/集成测试/覆盖矩阵.yaml` 更新需求的 `scenario_ids` 和证据；
4. 运行 `pnpm generate:integration-coverage` 生成 Markdown，再用 `pnpm check:integration-coverage` 校验；
5. 真实资源场景必须复用 `resources/` 的 setup/teardown，不能依赖前一个测试先成功。
