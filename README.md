# Keymaster

本地优先的 BSV 浏览器钱包。基于插件架构，按"基础设施 / 平台 / 业务"三层分离。

官网：<https://keymaster.cc>

## 架构（硬切换后）

```txt
plugin-woc          WOC API 代理（唯一 WOC 入口、限流、优先级、429 backoff、多标签页协调）
plugin-background   通用后台任务平台（注册、调度、去重、暂停、重试、Topbar 托盘）
plugin-p2pkh        P2PKH 资产实现（两类后台任务 recent-sync / history-backfill、reservation、Transfer Widget）
plugin-transfer     Transfer 平台（列 Offer，挂载 provider Widget，不解释 P2PKH/UTXO/地址/金额）
plugin-poker        浏览器原生扑克（与外部 poker-proxy 通信，本地签名 / 验签）
```

### 不变量

- 所有 WOC 请求必须经过 `woc.service`，不允许业务插件直接 fetch。
- WOC 是余额、UTXO、确认历史与未确认历史的链上真值；本地 IndexedDB 是可重建缓存。
- P2PKH 后台任务只有两类：`p2pkh.recent-sync` 与 `p2pkh.history-backfill`，通过 `P2pkhSyncCoordinator` 协调写入。
- 历史回填尽头由 WOC 分页响应中 `nextPageToken` 缺失决定；不依赖余额/金额/UTXO 数量。
- Transfer 平台不解释 P2PKH/UTXO/地址/金额/矿工费；选择 Offer 后挂载 provider 的完整 Widget。
- Shell Topbar 只渲染 `topbar.registry` 注册项，不 import 任何业务插件。
- plugin-poker 不持有私钥 / 明文种子 / 长期签名材料；只通过 `vault.withPrivateKey` 闭包签名。
- plugin-poker 不直接 import 其它 plugin-* 内部实现；只走 contracts capability。
- poker-proxy 与 plugin-poker 的内部浏览器协议有版本号（`POKER_BROWSER_PROTOCOL_VERSION`）；不匹配时立即断连，不进入半可用状态。

## 包结构

```txt
packages/
  contracts/        跨包协议（woc/background/topbar/transfer/poker/...）
  runtime/          plugin host + 内置 registry（含 topbar）
  ui/               原子组件
  plugin-vault/     私钥存储
  plugin-key-import/
  plugin-importer-wif|hex|json-file/
  plugin-contacts/
  plugin-home/
  plugin-settings/
  plugin-assets/    资产平台
  plugin-transfer/  Transfer 平台
  plugin-p2pkh/     P2PKH 业务
  plugin-poker/     扑克业务（与外部 poker-proxy 协议保真接入）
  plugin-woc/       WOC 基础设施
  plugin-background/  后台任务平台
apps/web/           装配 + shell
scripts/            check-boundaries.mjs
```

### 外部依赖

- `Projects/poker-proxy`：独立 Go 二进制，承接 bsv-poker 的 P2PNode topic
  平面与 TxLink raw tx 平面，承载多 web client 多租户复用。两类入口语义
  独立，配置 / 公告 / 日志 / 健康检查里分别命名，不会被压成"一个 endpoint"。
  - browser WSS：`wss://<proxy-host>/`（plugin-poker 拨入）
  - mesh TCP（P2PNode 平面）：bsv-poker P2PNode 节点接入，承载 topic 流量
  - txlink TCP（TxLink 平面）：bsv-poker TxLink 节点接入，承载 raw tx 流量

### plugin-poker 内部分层（硬切换 001 修订版）

```txt
packages/plugin-poker/src/
  manifest.ts              # 唯一插件装配入口
  pokerService.ts          # WSS 会话 + 状态 + publish 路径
  pokerIdentityBinding.ts  # 稳定 poker identity 绑定（独立于 active key）
  tsstack/adapter.ts       # @bsv/sdk 真值底座包装（仅 crypto / encoding / tx 解析）
  engine/                  # 协议真值层：txTemplates / chat / txIngest /
                           # pokerProtocolEngine / netGameEngine / netBlackjackEngine
  conformance/             # 与 bsv-poker C# 行为对拍的纯函数向量
  PokerSettingsPage.tsx 等 # UI 层
```

`ts-stack` 只是底座（hash / ECDH / tx 解析）；扑克协议状态机、ingest 语义、
chat marker / group id 派生都落在 `engine/`。`conformance/` 测试保证两端
wire-format / 派生公式不会偏移。

## 开发命令

```bash
npm install
npm run typecheck
npm run lint:boundaries
npm run dev       # vite
npm run build
```

## 数据真值语义

- 余额：WOC 真值；本地缓存是最近一次成功同步结果。
- UTXO：WOC 真值快照；本地 reservation 是防重复花费覆盖层。
- 历史：WOC 真值；本地 history store 按 `resourceId + txid` 去重。
- pending transfer：本地提交结果，不是链上确认历史。
- reservation：本地防重复花费，不改变 WOC UTXO 真值。

## 边界检查

`scripts/check-boundaries.mjs` 强制以下规则（违反一律 `process.exit(1)`）：

- `plugin-p2pkh` 不直接引用 WOC URL、不 import `plugin-woc`。
- `plugin-transfer` 不 import 任何具体资产 / vault / contacts。
- `plugin-woc` 不 import `plugin-p2pkh`。
- `plugin-background` 不 import `plugin-p2pkh` 或 `plugin-woc`。
- `runtime` 不 import 任何 `plugin-*`。
- `apps/web/src/shell/` 不 import `plugin-background`。
- `plugin-poker` 不 import 任何其它 plugin-*；不 import apps/web shell；
  engine/ 与 tsstack/ 不接 runtime / ui；tsstack/ 不接任何其它 plugin-*；
  代码里不允许硬编码 `new WebSocket("wss://…")`（必须从 service.settings 读）。

