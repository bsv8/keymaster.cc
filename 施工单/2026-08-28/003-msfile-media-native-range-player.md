# 003 MSFile 原生 Range 媒体播放器施工单

> 状态：🟡 原生 Range 链路已实施；真实 Chromium + Go supplier native Gate 11/11 通过，普通生产包
> 已通过 spike 产物扫描。仍待真实部署 smoke 和单独提交/固定 Go supplier 兼容 commit；旧后端暂保留
>（2026-08-29）。
>
> 本单用浏览器原生 `<audio>/<video src>` 替代应用自管的 MSE、转封装、缓存和 seek。
> Keymaster 只提供一个 session 级虚拟 HTTP 文件，把浏览器发出的 byte Range 精确映射到
> 256 KiB MSFile Block。目标是“浏览器请求哪里，MSFile 就读取哪里”。

## 1. 已冻结决定

1. 不建设懒 Seek 索引，不维护“时间 → 关键帧 → byte range”映射；这些工作交给浏览器原生媒体管线；
2. 不再使用 MediaSource、SourceBuffer、Mediabunny 转封装或自定义 WAV 播放后端；
3. 不设置应用级前向预读、向后保留、Block LRU 或媒体时间窗口；
4. 不新增任何媒体缓存设置，旧 `mediaPlaybackPrefetchBlocks` 退出生产播放路径和设置 UI；
5. MSFile Seed、256 KiB Block、Hash 校验、supplier、付款和 wire 保持不变；
6. 浏览器发出 HTTP Range 后才读取对应 Block；应用不得主动预测下一时间段；
7. 只保留 Seed/Block 计划、正在执行的请求和同 Block in-flight 去重，不保留已完成历史 Block；
8. seek 完全使用媒体元素原生行为；应用不监听原生 `seeking` 后再调用第二次 seek；
9. 只支持当前浏览器原生能够播放和 seek 的容器/Codec，不再通过转封装扩大格式范围；
10. 浏览器可能自行向前读取或重复 Range，这是选择极简架构后接受的行为，不伪装成可精确控制；
11. 普通媒体错误安全降级到现有下载，不重新回退到旧 MSE 实现；
12. debug 在本单验收前默认开启，只记录 Range、Block 序号/数量和状态，不记录敏感内容。

## 2. 目标架构

```text
<video src="/__keymaster/msfile-media/{随机会话 ID}">
                  │
                  │ GET / HEAD / Range: bytes=start-end
                  ▼
根作用域 Service Worker
                  │
                  │ MessageChannel：请求、pull、chunk、cancel
                  ▼
页面内 Range Host
                  │
                  │ byte range → Block 序号
                  ▼
现有受信任 msfile.service
                  │
                  ▼
读取并校验完整 Seed / Block
                  │
                  ▼
ReadableStream → HTTP 200/206 → 浏览器原生媒体管线
```

为什么需要 Service Worker：`HTMLMediaElement.src` 只能消费 URL，不能接收一个带随机读取回调的
JavaScript 对象；而当前 `msfile.service` 只存在于受信任页面运行时，普通服务端 URL 不能访问
用户本地身份和付款上下文。Service Worker 只做同源 HTTP 外壳，真实 MSFile 读取仍由页面内
Range Host 调用现有 service。

## 3. 极简职责边界

### 3.1 浏览器负责

- 解析 MP4/WebM/MP3/WAV 等原生支持的容器；
- 解析媒体索引和关键帧；
- 把播放时间换算成 HTTP byte Range；
- 管理解码、播放缓存、历史淘汰和 seek；
- 根据网络与内部策略决定请求长度、并发、取消和重复读取。

### 3.2 Keymaster 负责

- 创建不可猜测、可撤销、绑定当前页面的临时媒体 URL；
- 正确实现 `HEAD`、无 Range `GET`、单 Range `GET` 和 `416`；
- 把请求字节范围映射为 MSFile Block；
- 每个 Block 完整读取、校验 Hash 和精确长度后才输出其中字节；
- 流式返回，响应取消后停止后续 supplier Read；
- 同一时刻对相同 Block 做 in-flight Promise 合并；
- session dispose、Vault lock、active key/supplier/file 变化时立即撤销；
- 将网络、金额、完整性、浏览器能力和原生媒体不支持错误准确分类。

### 3.3 明确不负责

- 不知道当前播放时间对应哪个 Block；
- 不主动预读下一 Block；
- 不保留已经消费完成的 Block；
- 不保证浏览器只读取当前画面附近；
- 不保证回跳不会再次购买同一 Block；
- 不控制浏览器媒体缓存和解码器内存。

## 4. Gate 0：先证明浏览器 Range 行为

正式删除旧后端前，先用可丢弃 spike 在项目实际 Chromium 环境验证：

1. 根作用域 module Service Worker 能在首次注册并 `clients.claim()` 后控制当前页面，无需人工刷新；
2. `<video preload="none">` 点击播放后，请求会进入 Service Worker，而不是命中 SPA fallback HTML；
3. Chromium 对普通前置/尾部 `moov` MP4 发出的 Range 形态、并发数和取消行为；
4. 从头播放、远距离前跳、回跳和快速连续拖动时，请求范围是否足以原生恢复；
5. Service Worker `ReadableStream` 能通过 MessageChannel 按 pull/ack 接收 256 KiB chunk，浏览器取消后会触发 cancel；
6. 真实 production build 和实际部署响应头允许根 scope Service Worker；
7. 页面锁定、刷新、Service Worker 更新时，在途请求不会继续读取或串到新 session；
8. 至少 MP4/H.264/AAC、MP3、WAV 和 WebM 的真实浏览器结果；MKV 只按浏览器实测决定。

Gate 输出必须记录每个场景的 HTTP 方法、Range、响应码、返回字节数、映射 Block、supplier
读取数、cancel 时刻和媒体事件。不能只看“最终能播放”。

当前可重复 Gate 位于 `e2e/msfile-native-range.spec.ts`，使用真实 Chromium、production build、
真实 Go `msfile-nas` supplier 和临时 NAS 数据，覆盖格式矩阵、HTTP Range 契约、远跳/回跳/连续拖动、
cancel、旧根作用域 Service Worker 升级和 supplier Block 读取证据。编号与证据的对应关系如下：

- `G-SW-RESTART`：停止并重启 SW 后，已有 session 仍由 `event.clientId` 转发，继续返回 206、seek 和播放；
- `G-SW-UPGRADE`：旧根作用域 SW 被替换后，当前媒体 SW 重新控制页面，并验证跨 Client URL 拒绝；
- `R18`：lock、active key、supplier generation、文件切换和 unload 都立即撤销 session；Go supplier
  管理面计数证明在途 Read 进入 `aborted`，且没有继续产生未终结读取；
- `R19`：安装返回未知协议版本的 E2E SW，页面收到 `msfile_media_service_worker` 并安全终止，不安装媒体 URL；
- `R16`：`fixture-native-h264-aac-tail-moov.mp4` 是多 MiB、`moov` 位于文件尾部的真实 MP4；E2E
  必须同时记录非零起点的尾部 Range、未顺序读取全部中间 Block，并证明可以播放；
- `R21`：production preview 检查媒体 SW 的 JavaScript Content-Type、`Service-Worker-Allowed: /`、
  `Cache-Control: no-cache` 和非 SPA HTML 响应；真实部署需另外执行 deployment smoke；
- `R22`：真实 Go supplier 记录 Range 对应的 Block 读取数量和取消后的连接终止证据。

完整 R01–R22 仍需按部署环境补齐。Chromium 的手写 `fetch` + `ReadableStream.cancel()` 不保证一定
把取消传播为 Service Worker `FetchEvent.signal`；因此 R14 记录页面流式取消，真实 supplier Abort
由 R18 的生命周期撤销和 Go 计数验证，不把浏览器实现细节误报成传输层证据。

以下任一失败时停止正式迁移并回报，不允许暗中恢复旧 MSE：

- 当前页面无法被可靠控制；
- 媒体 Range 不进入 Service Worker；
- response stream 无法在取消时终止页面侧读取；
- 浏览器播放前稳定读取完整大文件，且业务不能接受；
- production 部署无法提供根 scope 或稳定脚本 URL。

## 5. 虚拟 URL 与安全边界

虚拟 URL 固定前缀：

```text
/__keymaster/msfile-media/{sessionId}
```

规则：

- `sessionId` 使用 Web Crypto 生成至少 128 bit 随机值，只存在内存；
- URL 不包含 Seed Hash、Block Hash、supplier 公钥、文件名、金额、身份或授权信息；
- session 绑定创建它的 `Client.id` 和当前 task token；其他窗口即使得到 URL也返回 `404`；
- Service Worker 不持有 Vault、私钥、grant、supplier 配置或媒体数据；
- Service Worker 不把 session 写 Cache Storage、IndexedDB 或日志；
- 非虚拟前缀请求原样 `fetch(request)`，不得改变应用其他网络行为；
- 页面在设置 `media.src` 前必须确认当前 `navigator.serviceWorker.controller.scriptURL` 是当前媒体 SW，
  并完成版本为 1 的协议握手；不能只判断是否存在任意 controller；
- 页面设置 `media.src` 前必须先发送 `bind-session`；SW 从 `MessageEvent.source.id` 固定 owner，HTTP
  Range 请求不能负责首次绑定；
- session dispose 后立即注销映射并 Abort 全部 request；旧 URL 固定返回 `404/410`；
- 响应使用 `Cache-Control: no-store`，不得进入 HTTP/Service Worker Cache API；
- 页面和 SW debug 不输出 session URL、Hash 或文件字节。

Service Worker 更新必须兼容已有 session 消息版本；无法兼容时明确中止旧播放，不能把旧请求
交给新页面 session。

## 6. HTTP Range 契约

### 6.1 支持的请求

| 请求 | 响应 |
|---|---|
| `HEAD` | `200`，只返回文件长度、类型、`Accept-Ranges` |
| `GET` 无 Range | `200`，从 byte 0 流到 EOF 或浏览器取消 |
| `bytes=start-end` | `206`，返回闭区间 `[start, end]` |
| `bytes=start-` | `206`，从 start 流到 EOF 或取消 |
| `bytes=-suffixLength` | `206`，返回文件末尾指定长度 |
| 越界、非法、多 Range | `416`，返回 `Content-Range: bytes */total` |

首版只支持单 Range。浏览器实测出现 multipart Range 才另开设计，不在这里实现 multipart 编码。

### 6.2 必需响应头

```http
Accept-Ranges: bytes
Content-Length: <本响应精确字节数>
Content-Type: <经白名单收敛的媒体类型>
Cache-Control: no-store
Content-Range: bytes <start>-<end>/<total>   # 仅 206
```

- `Content-Length`、`Content-Range` 使用 safe integer 且必须与实际输出一致；
- 0 字节文件不进入播放器；
- 不设置包含 Seed/Block Hash 的 ETag；
- declared MIME 只做白名单收敛，不再为魔数确认额外读取 Block 0；容器和 Codec 交给浏览器原生解析，
  不在白名单时直接保留下载降级；
- Codec 是否可播交给媒体元素；`MediaError` 映射为稳定的不支持/解码错误并提供下载入口。

## 7. byte range → Block 算法

对半开区间 `[startByte, endByteExclusive)`：

```ts
const firstBlockIndex = Math.floor(startByte / MSFILE_BLOCK_SIZE_BYTES);
const lastBlockIndex = Math.floor((endByteExclusive - 1) / MSFILE_BLOCK_SIZE_BYTES);
```

逐块执行：

1. 根据已经完整校验的 Seed 取得位置对应 Block Hash 和预期长度；
2. 通过现有 `msfile.service.readBlock` 读取完整 Block；
3. 校验响应 Hash、内容 SHA-256、普通块/末块精确长度；
4. 首块只输出 `startByte % blockSize` 之后的部分；
5. 末块只输出到 `endByteExclusive`；
6. ArrayBuffer 通过 MessagePort transfer，SW enqueue 后页面侧引用必须释放；
7. 浏览器取消或 session 失效时，不再启动下一个 Block Read。

不允许把完整 requested range 先拼成一个大 `Uint8Array`。请求覆盖 2 GiB 时，内存仍只由少量
在途 Block、MessagePort chunk 和浏览器内部缓冲构成。

## 8. 唯一允许的“缓存”：in-flight 合并

建议页面 Range Host 只维护：

```ts
interface MsFileNativeRangeSession {
  sessionId: string; // 临时随机 ID
  ownerClientId: string; // 创建该会话的受控页面
  fileSizeBytes: number; // 文件总长度
  mediaType: string; // 白名单收敛后的媒体类型
  blockHashes: string[]; // 已校验 Seed 得到的 Block 计划
  activeRequests: Map<string, AbortController>; // 正在服务的 HTTP 请求
  inFlightBlocks: Map<number, Promise<Uint8Array>>; // 同时重叠读取去重
}
```

- `inFlightBlocks` 条目只活到共享 Promise settle 且所有当前消费者取得结果；
- Block 一旦不再被 active request 使用就删除，不进入 LRU/history；
- 两个重叠 Range 同时需要同一 Block 时只产生一次 supplier Read；
- 后来的请求发生在 Block 释放之后，允许重新读取和再次付费；
- 页面到 SW 采用一块一 ack 的背压，禁止无界 postMessage；
- 读取并发首版最多 2，只是运输安全上限，不是预读窗口；
- Seed/Block Hash 计划属于读取必需元数据，在 session 全程保留，dispose 时释放。

## 9. 原生播放器生命周期

播放器只保留以下流程：

```text
页面创建 Range session
  -> 注册当前 Service Worker、等待匹配 controller、完成协议握手
  -> bind-session：SW 通过 MessageEvent.source.id 固定 ownerClientId
  -> element.src = 虚拟 URL
  -> 用户点击播放，浏览器发起 HTTP Range
  -> 首次正文 pull 时读取并校验 Seed，再按需读取并校验 Block
  -> element.play()
```

- UI 直接使用原生 controls；拖动进度条不经过自定义 `session.seek()`；
- `play/pause/currentTime/duration/buffered/error/ended/waiting` 直接来自媒体元素；
- 新文件、组件卸载、下载任务结束、Vault lock、active key/supplier generation 变化时：
  `pause → removeAttribute("src") → load() → revoke session → Abort`；
- React 组件只订阅状态和展示 debug，不持有 Range/Block 算法；
- session resource 可以保留，但其职责改为创建 URL、桥接 Range、聚合原生事件和 dispose；
- 页面刷新后不恢复旧 session，用户重新点击播放即可。

## 10. 设置迁移

- 删除 MSFile 设置页的“媒体播放预取窗口”；
- `mediaPlaybackPrefetchBlocks` 不再传入 `MsFileMediaPlayer`、Resource args 或媒体 package；
- 旧 IndexedDB 字段暂时保留以便版本回滚，但新代码不读、不写、不显示；
- 不增加“前向秒数”“向后秒数”或“缓存 MiB”等替代字段；
- 现有 Seed/Block 最高金额设置保持原义；
- UI 说明必须诚实：浏览器会自行决定 Range 和缓冲，播放或回跳可能再次读取并付费。

建议中文说明：

> 媒体由浏览器按需读取。浏览器可能提前读取播放点之后的数据；回跳到已释放内容时可能重新读取对应文件块。

## 11. Debug 与错误

本单验收前 debug 默认展开或默认启用，至少记录：

```text
sw.register.begin / ready / failed
session.created  backend、buildVersion、serviceWorkerProtocolVersion、serviceWorkerScriptUrl
range.session.created / revoked
range.request.begin       requestId、method、start、end、total
range.request.mapped      firstBlock、lastBlock、blockCount
range.block.read          blockIndex、inflightHit；不含 Hash
range.block.done          blockIndex、byteLength、elapsedMs
range.request.cancelled   已输出字节、取消阶段
range.request.done        status、输出字节、supplierReadCount
media.native.event        loadedmetadata/canplay/playing/waiting/seeking/seeked/error
```

稳定错误至少区分：

```text
msfile_media_range_invalid       HTTP Range 非法
msfile_media_service_worker      SW 注册、控制或消息协议失败
msfile_media_native_unsupported  浏览器原生不支持该容器/Codec
msfile_media_network             supplier/transport 失败
msfile_media_amount              金额超限
msfile_media_integrity           Seed/Block/长度校验失败
msfile_media_cancelled           用户、生命周期或旧请求取消
```

旧 `msfile_media_browser_capability` 不再承载所有 Range/seek 失败。原始异常、响应内容、媒体字节、
Hash、Seed、公钥、付款和身份正文不得进入 DOM、Resource Store、DB 或业务日志。

## 12. 主要改动位置

建议新增：

```text
apps/web/src/msfileMediaServiceWorker.ts        # 根 scope fetch/HTTP 外壳
apps/web/src/msfileMediaServiceWorkerClient.ts  # 注册、controller 与页面消息协议
packages/msfile-media/src/range/rangeParser.ts  # 纯 Range 解析与响应描述
packages/msfile-media/src/range/rangeSource.ts  # Seed、Block 映射、校验、in-flight 合并
packages/msfile-media/src/range/rangeHost.ts    # MessagePort pull/chunk/cancel
packages/msfile-media/src/browser/nativeSession.ts
```

重点迁移：

```text
apps/web/vite.config.ts
packages/contracts/src/msfile.ts
packages/contracts/src/sessionCoordinator.ts
apps/web/src/keymasterSessionCoordinator.worker.ts
packages/plugin-msfile/src/msfileDb.ts
packages/plugin-msfile/src/msfileService.ts
packages/plugin-msfile/src/msfileServiceProxy.ts
packages/plugin-msfile/src/msfileMediaResource.ts
packages/plugin-msfile/src/MsFileMediaPlayer.tsx
packages/plugin-msfile/src/MsFileHomeFileWidget.tsx
packages/plugin-msfile/src/MsFileSettings.tsx
```

迁移完成后删除生产引用：

```text
packages/msfile-media/src/browser/mseBackend.ts
packages/msfile-media/src/browser/mediaTransmux.ts
packages/msfile-media/src/browser/mediaTransmux.worker.ts
packages/msfile-media/src/browser/mediaDemux.ts
packages/msfile-media/src/browser/mediaDemux.worker.ts
packages/msfile-media/src/browser/wavBackend.ts
```

只有确认没有其他调用方后才能删除文件和 Mediabunny 依赖；对应旧测试同步替换。不得先删除旧
后端再做 Gate，必须保持一个可回退提交基线。

## 13. 必测矩阵

| ID | 场景 | 通过条件 |
|---|---|---|
| R01 | SW 首次启用 | 当前页面无需人工刷新即可取得 controller；失败明确降级下载 |
| R02 | 非媒体请求 | 根 scope SW 对其他应用请求完全透传 |
| R03 | HEAD | 200、无 body、长度/类型/Accept-Ranges 正确 |
| R04 | 三种单 Range | 固定、开放、suffix Range 均返回精确 206 和字节 |
| R05 | 非法 Range | 越界、倒序、多 Range 返回 416，不读取 supplier |
| R06 | 跨 Block 切片 | 首尾切片精确，响应长度正确，不拼接完整大范围 |
| R07 | 完整性 | Seed、Hash、Block 长度任一错误时，错误字节不进入响应 |
| R08 | in-flight 合并 | 同时重叠请求同一 Block 只有一次 supplier Read |
| R09 | 不保留缓存 | Block 消费释放后再次请求会重新 Read，内存不保留历史项 |
| R10 | 从头首播 | 多 Block 文件在 `playing` 时没有应用主动请求全文件 |
| R11 | 远距离前跳 | 浏览器请求目标 Range，不按顺序读取中间全部 Block |
| R12 | 回跳 | 原生进度条可恢复；允许重新读取，但无卡死和自定义 seek 递归 |
| R13 | 快速拖动 | 旧响应 cancel，停止后续 Read，最新原生 seek 胜出 |
| R14 | 无 Range GET | 按 pull 流式输出；浏览器取消后停止，不完整驻留内存 |
| R15 | 原生格式矩阵 | MP4、MP3、WAV、WebM 实测；不支持组合明确下载 |
| R16 | 尾部 moov | 浏览器自行请求尾部 Range 并成功播放，不使用 Mediabunny |
| R17 | 页面绑定 | 其他 client 使用同一 URL 返回 404，不能借 URL 调用媒体 session |
| R18 | 生命周期 | unload、lock、换 key/supplier/file、dispose 后旧 URL 立即失效；Go supplier 计数证明在途 Read Abort |
| R19 | SW 更新 | 协议版本不一致安全中止，不把旧请求串到新 session；包含未知版本 E2E fixture |
| R20 | 敏感数据 | URL、响应头、debug、错误不含 Seed/Block Hash、公钥、付款或身份 |
| R21 | production | production preview 与部署配置提供稳定脚本、根 scope、响应头，且不会返回 SPA HTML |
| R22 | 真实数据面 | Chromium + 真实 Go supplier 证明 Range、Block 计数和 cancel |

R10 的含义是 Keymaster 不主动预读，不承诺 Chromium 自己只请求一个 Block。必须把浏览器实际
请求的所有 Range 和 supplier 读取如实列入证据。

## 14. 实施顺序

### 提交 1：Gate spike

- 最小根 scope SW、固定内存文件 Range responder、原生 video；
- 验证首次控制、Range 形态、seek、cancel、production 部署；
- 把证据写入本单，PASS 后才进入生产读取。

### 提交 2：Range Core 与真实 MSFile 桥

- 纯 Range parser、Block 映射、Seed/Block 校验、in-flight 合并；
- MessageChannel pull/chunk/ack/cancel 和 session/client 绑定；
- fake reader 精确测试并接真实 `msfile.service`。

### 提交 3：原生播放器接入

- native session、Resource Store、React 原生 controls、debug 和错误降级；
- 移除播放路径中的 prefetch setting、MSE、转封装和自定义 seek；旧后端文件在 Gate 完成前保留为
  可回退基线，不得重新接入生产播放路径；
- 保留下载路径和生命周期 fence。

### 提交 4：旧后端清理与真实验收

- 完成 R01–R22；
- 确认无调用方后删除旧 Worker/MSE/WAV 后端和 Mediabunny 依赖；
- 更新 002/003 状态、格式支持说明和 production 证据。

## 15. 明确不做

- 懒时间索引、关键帧索引、SegmentReference；
- MSE、SourceBuffer、WebCodecs、浏览器端转封装或重编码；
- 应用级前向/向后缓存、LRU、持久化缓存或 Cache Storage；
- 限制浏览器只能读取播放点对应 Block；
- 避免回跳重复读取或重复付费；
- 为不受浏览器原生支持的 MKV/Codec 自建播放路径；
- 修改 MSFile V1 wire、Seed、Block、supplier 或金额授权模型；
- Live、HLS/DASH、DRM、字幕、多音轨完整产品化。

## 16. 验收命令

真实 Go supplier E2E 不允许依赖开发机默认路径。先 checkout 与 Keymaster 兼容的
MSFile-Proxy-Protocol commit，并显式传入仓库根目录；CI 还必须传入完整 commit SHA，测试会校验
HEAD 且拒绝 dirty checkout：

```bash
export MSFILE_PROXY_PROTOCOL_DIR="/path/to/MSFile-Proxy-Protocol"
export MSFILE_PROXY_PROTOCOL_COMMIT="<已单独提交的兼容 Go commit SHA>"
```

本机尚未提交的 supplier 工作树可暂时只设置 `MSFILE_PROXY_PROTOCOL_DIR` 做开发验证；发布验收不能
使用该方式。Keymaster 与 MSFile-Proxy-Protocol 的兼容 commit 必须分别提交并在发布记录中成对保存。

至少执行：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/msfile-media packages/plugin-msfile/src apps/web/src
pnpm exec playwright test <MSFile native Range E2E> --project=chromium --workers=1
pnpm build
pnpm test
git diff --check
```

部署到真实站点后执行：

```bash
MSFILE_MEDIA_DEPLOYMENT_ORIGIN="https://<真实部署域名>" pnpm smoke:msfile-media-sw
```

该命令直接请求 `/msfile-media-sw.js`，检查响应状态、JavaScript Content-Type、根 scope、`no-cache`
以及 SPA fallback；没有真实部署域名时不能把 R21 标记为完成。

## 17. 完成定义

- Gate 0 和 R01–R22 全部 PASS；
- 播放器生产路径是原生 media URL，不再创建 MediaSource、SourceBuffer 或转封装 Worker；
- 应用没有预读/历史缓存设置和算法，只有 active request 与同 Block in-flight 合并；
- 任意响应按 Block 完整校验后流式输出，内存不随请求长度或文件长度增长；
- 从头、远跳、回跳和连续拖动均由浏览器原生完成，没有自定义 seek 递归或卡死；
- debug 和真实 supplier 计数能逐项对应每个 HTTP Range 与 Block Read；
- 不支持格式明确降级下载，不静默恢复旧 MSE；
- session/client 绑定、取消、锁定、换 key 和 SW 更新均 fail closed；
- 旧 MSE、Mediabunny、WAV 后端和 `mediaPlaybackPrefetchBlocks` 已退出生产路径并在无调用方后删除。
