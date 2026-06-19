# 002 系统统一日志框架硬切换施工单

## 目标

一次性把当前系统从“没有统一日志框架、各插件各自无处可记或只能临时 `console.log`”硬切换为下面这套统一模型：

```txt
日志能力
  = runtime 内建
  = 每个插件 setup(ctx) 时自动拿到 ctx.logger
  = 插件不需要注册自己的日志基础设施

日志存储
  = 全局统一 IndexedDB
  = 统一 entry schema
  = 不为任何插件创建专属表 / 专属 DB / 专属迁移

日志查看
  = 系统设置页统一查看
  = /settings/logs
  = 统一过滤、统一清理、统一配置

日志配置
  = retentionDays 缺省 30 天
  = debugEnabled 缺省 false
  = debug 关闭时，不写 debug 日志到存储
```

本次是硬切换，不接受下面这些中间态：

1. 先让各插件自己 `console.log`，以后再统一收口。
2. 先给某几个插件单独做日志 DB 或日志表，后续再迁统一库。
3. 先做“日志插件”，但其他插件还要手工 `ctx.get("log.service")` 自己拼 `pluginId`。
4. 先把所有 `messageBus` 流量全量镜像进日志库，再慢慢筛。
5. 先只做查看页，不先把写入模型和 runtime 注入点收紧。
6. 保留“debug 即使关闭也照样入库，只是 UI 不显示”的伪开关。

## 简述缘由

1. 你现在要的是系统诊断面，不是零散调试输出。只要日志入口不统一，后面一定会重新分散。
2. “所有插件方便记录日志”这个目标，真正的关键不在存储，而在注入点。插件作者不应该每次都手工拿 service、拼 pluginId、判断开关。
3. “开发者删除插件目录，就带走一切”的重点，不是历史日志必须立刻消失，而是系统里不能为某个插件散落专属日志 schema、专属设置、专属 glue code。
4. 全量镜像 `messageBus` 虽然快，但一定带来噪音、爆量、payload 不稳定、敏感信息误落盘四个问题。它会把“有日志”迅速变成“日志不可用”。
5. debug 开关如果做成按插件、按模块、按 event pattern，会立刻把设置与判断复杂化，不符合当前系统“优先简单粗暴跑起来”的原则。
6. 统一日志页放在现有 `plugin-settings`，而不是再造一个“日志插件 UI 包”，可以把系统级能力留在 runtime，把系统级页面留在设置页，减少新的层次和装配顺序问题。

## 硬切换结论

本次统一采用下面这套最终架构：

```txt
contracts
  新增 log.ts
  定义 LogService / PluginLogger / LogEntry / LogConfig / capability key

runtime
  内建 createLogService()
  host 创建时立即 provide "log.service"
  buildContext(record) 时自动注入 ctx.logger
  plugin host / runtime 自己也用同一套 service 记系统日志

plugin-settings
  新增 /settings/logs
  统一做日志查看 + 配置

storage
  一个全局 IndexedDB
  store:
    entries
    config

debug
  默认 false
  false 时 debug 调用不写入 DB
  true 时后续新的 debug 调用开始入库
  不追补历史 debug
```

本次切换后，必须满足下面的不变量：

1. 任意插件记录日志的标准入口只有 `ctx.logger`，不是 `console.log`，也不是插件自己 new 一个 logger。
2. `ctx.logger` 已经天然绑定当前 `pluginId`；插件代码不能重复传自己的 `pluginId`。
3. 日志库只有一套全局 schema；不允许为某个插件建专属日志 store。
4. debug 开关是系统级单开关，不做按插件、按模块、按事件模式的细分。
5. `debugEnabled === false` 时，`logger.debug()` 不写入持久化存储。
6. 日志写入失败不能阻断业务流程；最多丢日志，不能卡业务。
7. 日志框架不保存私钥、助记词、密码、明文导入材料、解密后的敏感 JSON、明文签名材料。
8. 查看日志的 UI 是统一的系统设置页，不允许每个插件各做一页“自己的日志页”。
9. 插件删除后，系统里不应残留该插件专属日志代码；历史日志只是统一日志库中的普通历史记录。
10. 默认保留期为 30 天；过期删除是 best-effort，不因为清理失败阻断系统启动或业务执行。

## 不能怎么做

1. 不能给 `plugin-p2pkh`、`plugin-poker`、`plugin-woc` 分别建 `p2pkh_logs`、`poker_logs`、`woc_logs` 之类的表。那会直接违反“删除插件目录就带走一切”。
2. 不能要求插件作者在 manifest 里再声明一份 `logMeta`、`logSchema`、`logSettings`。日志平台不应要求业务插件做第二套注册。
3. 不能让插件每次调用日志都手工传 `{ pluginId: "p2pkh" }`。这类重复信息必须由 runtime 注入。
4. 不能把“统一日志”做成统一 `console` monkey patch。控制台不是系统存储，也不是稳定诊断面。
5. 不能一上来把 `messageBus.publish/dispatch/request` 全量镜像入库。那不是“简单”，那是把噪音直接持久化。
6. 不能把 `rawTxHex`、完整网络响应体、完整导入 JSON、完整 WebSocket frame 原文默认写库。第一期只记摘要与关键字段。
7. 不能在 debug 关闭时仍然把 debug entry 写库，然后靠查询时过滤。用户明确要求“默认不开 debug 的存储”。
8. 不能做“日志写失败就重试、排队、补写、双写备用库”这类复杂补偿。日志不是主业务真值，不能反客为主。
9. 不能让 `plugin-settings` import 任意业务插件内部日志类型或日志解析器。日志查看页只理解统一 schema。
10. 不能保留“旧插件专属日志实现先不删，只是暂时不用”。硬切换后只允许一套统一入口继续存在。

## 应该怎么做

### 一、把日志能力定义成平台契约，而不是业务插件私货

在 `packages/contracts/src/log.ts` 定义统一契约：

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  pluginId: string;
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  keyScope?: { publicKeyHash: string };
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

export interface LogConfig {
  retentionDays: number;
  debugEnabled: boolean;
}

export interface PluginLogger {
  debug(input: LogWriteInput): void;
  info(input: LogWriteInput): void;
  warn(input: LogWriteInput): void;
  error(input: LogWriteInput): void;
  child(scope: string): PluginLogger;
}

export interface LogService {
  getConfig(): LogConfig;
  updateConfig(patch: Partial<LogConfig>): LogConfig;
  listEntries(query?: LogQuery): Promise<LogEntry[]>;
  append(input: LogAppendInput): Promise<void>;
  clearEntries(query?: LogClearQuery): Promise<number>;
  pruneExpired(now?: string): Promise<number>;
  forPlugin(pluginId: string, baseScope?: string): PluginLogger;
  onConfigChange(handler: (config: LogConfig) => void): () => void;
}

export const LOG_SERVICE_CAPABILITY = "log.service";
```

要求：

1. `pluginId` 是 entry 的必填字段，但由平台注入，不由业务插件手工重复传。
2. `scope` 与 `event` 是结构化查询字段，不是可有可无的文案。
3. `message` 保持简短、可读，是最终查看页主文案。
4. `data` 只允许放摘要与非敏感上下文，不允许把任意对象原样 dump。
5. `error.message` 保留英文错误原文；注释与文档保持中文。

设计缘由：

```txt
日志契约必须先收紧，后面的 runtime 注入、设置页查询、测试夹具才能都围绕同一套模型工作。
```

### 二、把 logger 直接注入 PluginContext，插件作者不再手工拼装

在 `packages/contracts/src/plugin.ts`：

1. `PluginContext` 新增：

```ts
logger: PluginLogger;
```

2. 注释写清楚：
   - `logger` 已绑定当前 `pluginId`
   - 插件不要自己再构造第二套 logger
   - `child(scope)` 仅用于在同一插件内细分模块

在 `packages/runtime/src/createPluginHost.ts`：

1. host 创建时先创建 `logService`
2. 立即 `capabilities.provide("log.service", logService)`
3. `buildContext(record)` 时返回：

```ts
logger: logService.forPlugin(record.manifest.id)
```

设计缘由：

```txt
“所有插件方便记录日志”不是一句口号，必须落实到 ctx 天然有 logger。
只要要求插件作者自己 get service、自己 child、自己带 pluginId，这套能力很快就会碎掉。
```

### 三、日志 service 做成 runtime 内建，而不是新造一个日志插件

本次不新建 `packages/plugin-log/`。

统一做法：

1. `LogService` 实现在 `packages/runtime/src/log/` 下。
2. runtime 内建 capability，跟 `messageBus`、`i18n.service` 同级。
3. `plugin-settings` 只是日志 UI 的承载者，不拥有日志能力真值。

这样做的缘由：

1. 所有插件在 setup 阶段就可能需要日志；如果日志能力本身也是一个可 enable/disable 的普通插件，就会出现装配顺序和依赖问题。
2. runtime 内建能力更适合记录 plugin host 自己的系统日志，例如 plugin enable/disable/setup error。
3. 这也更符合“删除业务插件目录不留下专属基础设施”：日志能力不从属于任何业务插件。

### 四、统一存一个全局日志库，不做 per-plugin DB

新增统一全局 DB，例如：

```txt
DB name:
  keymaster.logs

DB version:
  1

stores:
  entries
  config
```

建议 schema：

`entries`
- keyPath: `id`
- index: `ts`
- index: `pluginId`
- index: `level`
- index: `scope`
- index: `event`

`config`
- keyPath: `id`
- 单条记录：`{ id: "singleton", retentionDays: 30, debugEnabled: false }`

要求：

1. 这是全局系统诊断数据，不走 key-scoped storage。
2. 不给任何插件开自己的日志 DB。
3. 不在 `localStorage` 存日志 entry。
4. 配置与 entry 共库即可，不再分第二套存储。

设计缘由：

```txt
日志是系统诊断面，不是某把 key 的业务真值。
如果做成 key-scoped 或 per-plugin storage，只会让查询和维护变碎。
```

### 五、debug 开关只做系统级简单开关

配置模型只保留两项：

```ts
{
  retentionDays: 30,
  debugEnabled: false
}
```

行为定义：

1. `debugEnabled === false`
   - `logger.debug()` 直接返回
   - 不写 DB
2. `debugEnabled === true`
   - 后续新的 debug 调用开始写 DB
3. 开关变化不回补历史
4. 一期不做：
   - `debugUntil`
   - 按插件单独开 debug
   - 按 scope / event pattern 开 debug

设计缘由：

```txt
你已经明确“不要搞复杂了，就做一个简单开关”。
那就不能再偷偷塞进时间窗、白名单、黑名单、采样器这些二阶设计。
```

### 六、日志 entry 只记“结构化摘要”，不记敏感原文

统一要求：

1. `message` 是一行摘要，例如：
   - `Recent sync started`
   - `Broadcast accepted`
   - `WOC request failed`
   - `Poker status changed`
2. `data` 只放必要摘要，例如：
   - `resourceId`
   - `network`
   - `addressCount`
   - `txid`
   - `statusBefore/statusAfter`
   - `requestId`
3. 默认禁止写入：
   - private key
   - mnemonic
   - password
   - cipher 明文材料
   - 完整导入 JSON
   - 完整 rawTxHex
   - 完整 WOC response body
   - 完整 WebSocket frame 文本
4. `error` 只保留 `name/message/stack` 的截断版本

设计缘由：

```txt
统一日志的价值在“能查状态变化与关键上下文”，不在“把一切原文都倒进去”。
原文 dump 会同时带来体积、噪音和敏感信息风险。
```

### 七、先埋关键轨迹，不做全量自动镜像

第一期埋点范围固定如下：

`runtime / plugin host`
- plugin registered
- plugin enabled
- plugin disabled
- plugin setup failed
- plugin teardown failed

`vault / keyspace`
- vault unlocked
- vault locked
- key created
- key deleted
- active key changed
- key identity failed

`background`
- task triggered
- task started
- task completed
- task failed
- task canceled / paused / resumed

`woc`
- config changed
- request queued
- request completed
- request failed
- backoff entered / cleared

`p2pkh`
- recent sync started / completed / failed
- history backfill page committed / failed
- transfer broadcast accepted / rejected / provider-inconsistent
- 关键状态判定

`poker`
- connect / disconnect
- status changed
- 关键 frame / tx ingest 摘要

明确不做：

1. 全量 `messageBus` 自动镜像
2. 全量 fetch request/response body 镜像
3. 全量 WebSocket frame 原文镜像

设计缘由：

```txt
日志系统第一期要先把“关键行为和状态判定看得见”解决，而不是把系统每个字节流都落库。
```

### 八、日志查看页统一挂到 settings，不给业务插件各自开日志页

在 `plugin-settings` 新增：

```txt
/settings/logs
```

页面职责：

1. 查看日志列表
2. 按插件、级别、时间做基础过滤
3. 打开/关闭 debug
4. 修改 retentionDays
5. 清空全部日志或按过滤条件清理

UI 一期只做基础能力：

1. 顶部配置卡片
   - debug 开关
   - retentionDays 输入
   - 保存按钮
2. 过滤条
   - pluginId
   - level
   - keyword（匹配 message / event）
3. 列表
   - 时间
   - 级别
   - pluginId
   - scope/event
   - message
4. 展开详情
   - data
   - error

设计缘由：

```txt
系统级诊断入口要统一；如果允许每个插件单独做一页“自己的日志”，日志很快又会退回分散状态。
```

## 特殊情况与处理规则

### 情况 A：插件目录已删除，但日志库里仍有该插件旧日志

处理：

1. 不做运行时错误。
2. 查询列表时仍按普通 `pluginId` 展示。
3. 如果当前 host.manifests() 里找不到该 `pluginId`，UI 可标记为“已移除插件”。
4. 历史日志继续按 retentionDays 正常过期或由用户手工清理。

设计缘由：

```txt
“删除插件目录就带走一切”指的是不保留插件专属基础设施，不是强制抹掉统一日志库里的历史条目。
历史条目仍然是统一 schema 下的普通数据。
```

### 情况 B：debug 关闭时，插件仍然调用了大量 `logger.debug()`

处理：

1. 直接 no-op。
2. 不写库。
3. 不做缓存、不做补写、不做内存排队。

设计缘由：

```txt
用户已经明确“默认不开 debug 的存储”。
那就必须在入口处直接拦掉，而不是把判断拖到后面。
```

### 情况 C：日志 DB 打开失败 / 写入失败 / 配额满

处理：

1. 当前业务继续运行。
2. 本次日志写入丢弃。
3. 允许 runtime 向 `console.error` 打一次内部错误摘要，便于开发环境察觉。
4. 不做复杂重试、不做备用库、不阻断插件流程。

设计缘由：

```txt
日志失败属于边缘失败。
系统复杂度必须让位于业务主路径继续跑下去。
```

### 情况 D：retentionDays 从大值改成小值

处理：

1. 保存配置成功后立刻 best-effort 执行一次 prune。
2. 之后按常规启动/节流清理继续运行。
3. prune 失败只影响日志保留，不影响配置保存和其他业务。

### 情况 E：日志 entry 的 `data` 或 `error.stack` 太大

处理：

1. 写入前统一归一化与截断。
2. 超过长度上限的字段截断并附带 `truncated: true` 语义或统一后缀提示。
3. 不允许原样写入超大对象。

### 情况 F：插件在 setup 阶段就要记日志

处理：

1. `log.service` 必须在 `host.enable(plugin)` 之前就已经可用。
2. `ctx.logger` 在 `manifest.setup(ctx)` 调用前已准备好。
3. setup 内的日志直接可用，不需要插件先 `ctx.get("log.service")`。

### 情况 G：用户打开 debug 后想看“之前没记下来的 debug”

处理：

1. 不补历史。
2. debug 开关只影响未来新产生的 debug entry。
3. UI 文案必须明确说明这一点。

## 文件级施工

### 一、contracts

#### `packages/contracts/src/log.ts`（新增）

新增统一日志契约：

1. `LogLevel`
2. `LogEntry`
3. `LogConfig`
4. `LogWriteInput`
5. `PluginLogger`
6. `LogService`
7. `LOG_SERVICE_CAPABILITY`

要求：

1. 注释全部中文。
2. 类型命名通用，不带任何业务插件前缀。
3. 错误消息如果需要抛出，代码内保持英文。

#### `packages/contracts/src/index.ts`

新增：

```ts
export * from "./log.js";
```

#### `packages/contracts/src/plugin.ts`

修改 `PluginContext`：

1. 增加 `logger: PluginLogger`
2. 注释说明 `logger` 已绑定当前插件

### 二、runtime

#### `packages/runtime/src/log/logDb.ts`（新增）

实现全局日志 DB 封装：

1. 打开 `keymaster.logs`
2. 创建 `entries` / `config` store
3. 提供基础 CRUD
4. 提供按 retention 删除过期日志

要求：

1. 不引入任何业务插件依赖。
2. 所有 schema 注释写清楚“为什么是全局 DB 而不是 key-scoped / per-plugin DB”。
3. DB 错误只向调用方抛普通英文错误，不做复杂恢复。

#### `packages/runtime/src/log/logService.ts`（新增）

实现 `createLogService()`：

1. `getConfig() / updateConfig()`
2. `append()`
3. `listEntries()`
4. `clearEntries()`
5. `pruneExpired()`
6. `forPlugin(pluginId, baseScope?)`
7. `onConfigChange()`

要求：

1. `debugEnabled === false` 时 `forPlugin(...).debug()` 直接返回。
2. `append()` 内统一做 entry 归一化、敏感字段过滤、长度截断。
3. `forPlugin()` 返回的 logger 不暴露 `pluginId` 可改入口。
4. service 自己不理解任何业务语义，只处理统一字段。

#### `packages/runtime/src/createPluginHost.ts`

修改点：

1. host 创建时实例化 `logService`
2. `capabilities.provide(LOG_SERVICE_CAPABILITY, logService)`
3. `buildContext(record)` 注入 `logger: logService.forPlugin(record.manifest.id)`
4. plugin host 自己增加少量系统日志：
   - plugin enabled
   - plugin disabled
   - setup failed
   - teardown failed

要求：

1. 不要为了记日志改乱现有 enable/disable 时序。
2. 日志失败不能反向影响 plugin lifecycle。
3. 系统日志的 `pluginId` 统一使用 `runtime` 或 `plugin-host`，不要伪装成某个业务插件。

#### `packages/runtime/src/index.ts`

导出新增 runtime 日志实现：

1. `export * from "./log/logService.js";`
2. 如需要，导出 `logDb` 只限内部测试使用；若无必要，不对外暴露底层 DB。

#### runtime 测试文件

至少补这些测试：

1. `ctx.logger` 在 plugin setup 内可用
2. `debugEnabled=false` 时 debug 不入库
3. `info/warn/error` 正常入库
4. plugin host 系统日志不会影响 enable/disable 主流程
5. prune 会删除超期数据

### 三、plugin-settings

#### `packages/plugin-settings/src/LogSettingsPage.tsx`（新增）

实现统一日志页：

1. 顶部 `PageHeader`
2. 配置区
   - debug 开关
   - retentionDays
   - 保存
3. 过滤区
   - pluginId
   - level
   - keyword
4. 日志列表
5. 清理按钮

要求：

1. 只通过 `useCapability<LogService>("log.service")` 访问日志能力。
2. 不 import 任何业务插件内部类型。
3. 文案中文，错误原文英文。
4. UI 说明要明确：
   - debug 关闭时不会存储 debug 日志
   - 开启后只对未来日志生效

#### `packages/plugin-settings/src/manifest.ts`

新增一条 settings route：

```txt
/settings/logs
```

要求：

1. 路由 label / description / breadcrumb i18n 全量补齐。
2. 可见性策略与 `/settings/plugins` 保持同级系统设置语义。
3. 不额外引入新的 menu 真值；仍走 settings.registry。

#### `packages/plugin-settings/src/index.ts`

导出 `LogSettingsPage`。

#### `packages/plugin-settings/src/styles.css`

补日志页样式，且样式必须继续跟随 `plugin-settings` 目录：

1. 过滤条
2. 配置卡片
3. 日志列表
4. 明细展开区
5. 级别 badge

要求：

1. 不把插件样式写回 `apps/web/src/styles/global.css`。
2. 注释写清楚：日志页是系统设置 UI，但样式所有权属于 `plugin-settings`。

#### plugin-settings 测试

至少补这些测试：

1. `/settings/logs` 注册存在
2. debug 开关与 retentionDays 能读写
3. 列表能显示 entry 基本字段

### 四、关键业务埋点

#### `packages/plugin-background/src/backgroundService.ts`

增加统一日志埋点：

1. trigger
2. start
3. complete
4. failed
5. cancel / pause / resume

要求：

1. 只记任务 id、reason、状态、必要错误摘要。
2. 不记整段 task payload。

#### `packages/plugin-woc/src/wocService.ts` 或 `wocActor.ts`

增加统一日志埋点：

1. config changed
2. request queued
3. request success
4. request failed
5. backoff entered / cleared

要求：

1. 不记录完整 response body。
2. 只记录 endpoint 摘要、请求类型、地址/网络摘要、错误摘要、等待时间等必要字段。

#### `packages/plugin-p2pkh/src/p2pkhService.ts`
#### `packages/plugin-p2pkh/src/p2pkhHistoryBackfill.ts`
#### `packages/plugin-p2pkh/src/p2pkhRecentSync.ts`
#### `packages/plugin-p2pkh/src/p2pkhTransferService.ts`

增加统一日志埋点：

1. recent sync started / completed / failed
2. backfill page committed / failed
3. transfer broadcast accepted / rejected / provider-inconsistent
4. 关键状态判定摘要

要求：

1. 不记录完整 `rawTxHex`。
2. 可记录 `txid`、`resourceId`、`network`、`page`、`counts` 等摘要。

#### `packages/plugin-poker/src/pokerService.ts`

增加统一日志埋点：

1. connect
2. disconnect
3. status changed
4. frame / tx ingest 摘要

要求：

1. 不记录完整 frame 原文。
2. 只记录 kind、route、tableId、txid、错误等摘要字段。

#### `packages/plugin-vault/src/vaultService.ts`
#### `packages/plugin-vault/src/keyspaceService.ts`

增加统一日志埋点：

1. vault unlocked / locked
2. key created / deleted
3. active key changed
4. identity failed

要求：

1. 不记录私钥、密码、明文导入材料。
2. 仅记录 keyId / publicKeyHash / label 摘要。

### 五、文档与说明

#### `README.md`

补一节简短说明：

1. 系统存在统一日志框架
2. 插件通过 `ctx.logger` 记录日志
3. 日志查看入口是 `/settings/logs`
4. debug 默认关闭，需手工开启

不要在 README 里展开实现细节，只说真值模型和使用原则。

## 最终验收清单

### 结构与边界

1. `contracts` 已新增统一 `log.ts`，并从 `contracts/index.ts` 导出。
2. `PluginContext` 已新增 `logger`，且所有插件 setup 都能直接使用。
3. runtime 已内建 `log.service` capability，不依赖额外日志插件装配顺序。
4. 系统中不存在任何 per-plugin 日志 DB / 日志 store / 日志 schema 注册点。
5. `plugin-settings` 已提供 `/settings/logs`，且这是唯一正式日志查看入口。

### 行为

1. 默认配置为：
   - `retentionDays = 30`
   - `debugEnabled = false`
2. debug 关闭时，`logger.debug()` 不写入 DB。
3. debug 打开后，只影响未来新产生的 debug 日志。
4. `info/warn/error` 在默认配置下正常写入并可查询。
5. 运行时系统日志可看到 plugin enable/disable/setup error 等关键轨迹。
6. `background`、`woc`、`p2pkh`、`poker`、`vault/keyspace` 的关键轨迹已进入统一日志。

### 删除友好

1. 删除某个业务插件目录后，不需要再去别处删它的专属日志基础设施。
2. 日志平台与查看页不 import 该业务插件内部实现。
3. 旧日志即使保留，也只是统一日志库里的普通历史条目。

### 安全与简化

1. 日志中不出现私钥、助记词、密码、完整导入 JSON、完整 `rawTxHex`、完整网络响应体。
2. 日志写入失败不会阻断业务主路径。
3. 没有引入复杂重试、双写、备用库、历史 debug 回补、按插件 debug 开关等复杂机制。

### 测试与回归

1. runtime 日志能力有自动化测试。
2. `/settings/logs` 页面和配置读写有自动化测试。
3. 现有插件 enable/disable、设置页路由、关键业务流程回归不被日志系统破坏。

## 收尾说明

本施工单的核心不是“把日志做出来”，而是一次性把日志的真值边界钉死：

```txt
日志能力属于 runtime 平台
日志查看属于系统 settings
业务插件只负责写结构化摘要
不做 per-plugin 基础设施
不做全量自动镜像
不让日志失败反向拖垮系统
```

只要这几个边界守住，后续新插件接入日志只需要使用 `ctx.logger`，而不需要再发明第二套方案。
