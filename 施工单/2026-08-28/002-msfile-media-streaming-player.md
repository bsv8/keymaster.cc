# 002 MSFile 媒体流播放器与内部 SDK 施工单

> 状态：🟡 首版代码已落地；普通 MP4 转封装冒烟已通过，真实多格式夹具、Go supplier E2E 与长时验收待完成（2026-08-28）。
>
> 本单在 Keymaster 内部建立可复用的 MSFile 媒体播放 SDK，并让首页文件模块对
> MP3、WAV、MP4、MKV 使用有界流式播放。目标是首批必要 Block 验证后开始播放，
> 不再等待完整文件下载；同时冻结可接入未来 Live 的播放器边界，但本单不实现
> Live 服务端协议，也不发布独立公共 SDK。

> **后续裁决：** 本单中的 `mediaPlaybackPrefetchBlocks`、MSE、自管缓存、转封装及
> 未缓冲 seek 方案，已由
> [003 MSFile 原生 Range 媒体播放器施工单](./003-msfile-media-native-range-player.md)
> 替代。002 保留为首版实现记录；后续施工与验收以 003 为准。

## 1. 已冻结产品决定

1. 媒体播放器先在 Keymaster monorepo 内完善，稳定且出现第二个真实调用方后再讨论独立发布；
2. 内部包暂定为 `@keymaster/msfile-media`，不得放入 `bitcoin-libp2p`、Connect SDK 或 React 组件内部；
3. SDK 必须无 React、无页面路由、无私钥、无 libp2p host、无供应商配置 DB 依赖；
4. 首页 `msfile` 插件是首个正式调用方，通过适配器消费受信任 `msfile.service`；
5. SDK 输入中不得出现 `maxPriceSatoshis`，Seed/Block 金额继续来自现有全局设置；
6. MSFile V1 wire/network、Seed 和 256 KiB Block 模型保持不变；VOD 不增加新的服务端接口；
7. 首次播放设置一个默认 5 Block 的滑动预取窗口，并允许用户在 MSFile 设置页调整；
8. 滑动窗口不能是唯一背压：播放器还必须按“已缓冲播放时长”和总内存设置内部硬上限；
9. MP3、WAV、MP4、MKV 只在容器和 Codec 经运行时确认可播放时进入播放器，不按扩展名或供应商 MIME 盲信；
10. 不支持的容器、Codec 或浏览器能力必须安全降级到现有下载路径；
11. 媒体播放可以突破当前 32 MiB 自动 Blob 预览线，因为不再完整驻留内存；完整 Blob 下载仍保持 256 MiB 上限；
12. 有声音的播放由用户点击触发；允许提前准备头部和播放器，但不得依赖绕过浏览器自动播放策略；
13. 当前 MasterSeed 是不可变内容地址，未来 Live 不得通过“不断增长同一个 Seed”实现；
14. 本单只提供 Live-ready 抽象、模拟源和长时间有界验收，不修改 `MSFile-Proxy-Protocol` 服务端；
15. `bitcoin-libp2p` 项目保持只读；若发现 SDK 确有阻断，必须提交明确缺口与协调建议，禁止直接修改。

## 2. 前置条件与 Gate

- [001 首页 Seed 文件获取](./001-msfile-home-seed-file-fetch.md) 已 PASS；
- 生产 `msfile.service.stat/readSeed/readBlock`、SharedWorker/Window executor、WebRTC Direct/WSS 已 PASS；
- `bitcoin-libp2p@0.2.0` 继续负责身份认证、连接、stream 和 transport 流控制；
- 媒体 SDK 负责应用层付费 Block 的读取窗口、容器解析、播放器背压和资源回收；
- 普通 Block 只有完整读取、Hash 和精确长度验证后才能进入媒体解析器；不得播放未验证 attachment 前缀。

### Gate 0：浏览器与依赖能力实测

正式编码前必须先阅读并续写
[媒体第三方候选调研报告](../../../docs/proposals/msfile/media-third-party-candidates.md)，
再在当前 Chromium/微软无头环境完成可丢弃 spike。不得先安装一个依赖、写完适配器后，
再用沉没成本反推选型。

Gate 0 至少比较 3 个媒体解析/播放内核候选和 3 个播放器 UI 候选，并记录：

- `MediaSource.isTypeSupported()` 的实际 MP3、fMP4、WebM 组合；
- `AudioDecoder.isConfigSupported()`、`VideoDecoder.isConfigSupported()` 的目标 Codec 组合；
- MediaSource 是否可在 DedicatedWorker 构造；不支持时是否能在 Window 安全运行；
- MP3、RIFF/WAV、ISO-BMFF/MP4、Matroska/MKV 所选 demux 依赖的许可证、维护状态、浏览器构建体积和恶意输入边界；
- 普通 MP4 的尾部 `moov`、fMP4 初始化段、MKV Cues/Cluster 的增量解析能力；
- 自定义随机读取能否严格经过 MSFile Block 窗口，是否会因库内预取/缓存造成重复购买或窗口越界；
- 暂停、seek、dispose、Worker terminate 后是否还有网络读取、定时器、SourceBuffer、Frame 或 AudioData 残留；
- UI 候选的键盘、ARIA、焦点、触摸、音频/视频共用、React 接入、主题定制和自定义后端适配成本；
- exact 版本、直接/传递依赖、实际 production chunk 增量、Worker/WASM 资源、许可证义务和安全公告；
- 不得自行实现 H.264、AAC、MP3、VP9 等 Codec；容器解析也优先使用通过审计的依赖，不复制不完整实现。

候选报告必须保留“广格式但较新”“格式较少但长期稳定”“WASM 广格式兜底”“完整播放器框架”
等不同路线，不得只列名字相似的库。最终选择由实施者根据 spike 证据作出，并在报告中写明：
选择项、拒绝项、组合方式、已知缺口、退出/替换策略和锁定版本。

Gate 0 不能证明目标格式能够增量解析、资源可释放或构建可接受时，不得用“完整 Blob 作为内部实现”
冒充流式播放，也不得自行补写一个未经充分测试的通用 demuxer。

## 3. 包与依赖边界

建议新增：

```text
packages/msfile-media/
  package name: @keymaster/msfile-media
  src/core/       BlockSource、调度、窗口、状态机、稳定错误
  src/browser/    MediaSource、WebCodecs、AudioWorklet、能力检测
  src/formats/    容器探测与 demux 适配器
  src/testing/    假 BlockSource、慢消费者、无限 Live 模拟源
```

边界要求：

- `core` 不 import React、DOM、Keymaster runtime、Coordinator、DB 或 transport；
- `browser` 可以使用标准浏览器媒体 API，但不读取 Vault、session 或设置 DB；
- `plugin-msfile` 负责把 `msfile.service` 和设置快照适配为 SDK 输入；
- React 组件只订阅播放器快照和调用命令，不持有 demux、SourceBuffer 或 Read 调度算法；
- 不把媒体字节、Seed attachment、Block 内容或解码帧写入 DB、日志、Resource Store；
- 普通生产包不得包含固定测试 Seed、供应商、公钥、密码或 session 注入。

## 4. 设置设计

新增全局字段：

```ts
interface MsFileMediaPlaybackSettings {
  /** 媒体播放最大预取窗口，单位为 256 KiB MSFile Block。 */
  mediaPlaybackPrefetchBlocks: number;
}
```

规范：

```text
默认值       5
最小值       2
最大值       64
是否允许 0   否；0 不表示无限
单位         MSFile Block（每块 256 KiB）
```

- 旧 DB 没有字段时读取为默认 5，不得影响已保存的 Seed/Block 金额；
- 使用独立设置更新入口或清晰的通用设置 mutation，不得伪装成价格更新；
- 更新继续经过 Coordinator 串行化、generation/epoch fence 和初始化失败 fail-closed；
- 设置调小时：当前 session 停止发新 Read，等待占用降到新窗口，不取消已经验证且正在播放的数据；
- 设置调大时：按正常调度补充，不能一次启动无界请求；
- 首页设置说明必须明确它会影响提前购买数量、流量与内存；
- 该字段是内置播放器资源策略，不改变 Connect App 付费授权模型，也不能限制 App 自己直接调用既有 Read API。

设置页中文说明使用：

> 媒体播放预取窗口：控制播放器最多提前购买和读取多少个文件块。每块
> 256 KiB，默认 5 块。数值越大越不容易卡顿，但会增加内存、流量和提前付费数量。

## 5. SDK 核心契约

以下是职责草图，不要求逐字采用字段名，但中文语义和边界必须保留：

```ts
interface MsFileMediaBlockReader {
  /** 从现有授权边界读取并返回已经校验的 Seed。 */
  readSeed(input: { signal: AbortSignal }): Promise<Uint8Array>;
  /** 按 Hash 读取并返回已经校验的单个 Block。 */
  readBlock(input: { blockHashHex: string; signal: AbortSignal }): Promise<Uint8Array>;
}

interface MsFileVodSourceInput {
  seedHashHex: string;          // Seed 内容 Hash
  supplierPublicKeyHex: string; // 本次播放固定供应商
  fileSizeBytes: bigint;        // Stat 给出的源文件大小
  declaredMediaType: string;    // 不可信提示，只用于初步候选
  reader: MsFileMediaBlockReader;
}

interface MsFileMediaSession {
  snapshot(): MsFileMediaSnapshot;
  subscribe(listener: () => void): () => void;
  attach(element: HTMLMediaElement): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
```

不变量：

- Reader 返回前仍由 `msfile.service` 保证 content hash、响应 hash、上限和 Block 精确长度；
- SDK 在容器层再次验证 Seed Block 计划、顺序、末块长度和总文件大小；
- `supplierPublicKeyHex` 在一次播放 session 内固定，禁止跨供应商拼接；
- SDK 不接收调用方金额，不生成 grant，不访问 session/App Identity；
- 所有 public command 都支持幂等 stop/dispose；迟到结果必须受 session generation 与 Abort fence 拦截；
- 稳定错误码至少区分：配置、网络、金额、完整性、容器不支持、Codec 不支持、浏览器能力、解码失败、已取消。

## 6. 两级背压与滑动窗口

### 6.1 Block 读取窗口

窗口占用定义为：

```text
windowOccupancy = 已发起未完成 Read + 已验证但尚未被 demux 接受的 Block
```

规则：

1. 启动时单独读取并验证 Block 0，优先获得首播证据；
2. 容器需要尾部索引时可以随机读取对应 Block，但所有在途/待解析 Block 仍计入同一窗口；
3. 首播条件满足后再把窗口补到 `mediaPlaybackPrefetchBlocks`；
4. 建议普通读取并发默认为 2，且永远不超过剩余窗口槽位和现有 Read stream 上限；
5. ReadResponse 可以乱序到达，但只能按容器需要的顺序交给顺序解析器；
6. 同一窗口中的重复 Hash 必须共用一个 in-flight Promise，避免触发 wire 的同 Hash 覆盖取消；
7. 任一 Hash/长度/顺序校验失败，立即 Abort 全窗口，错误内容不得进入 demux；
8. 不能把整个 Seed 的所有 Block Promise 一次性创建后再用 worker pool 限速。

### 6.2 播放时间与内存背压

仅限制 5 个原始 Block 不足以限制 MediaSource/WebCodecs 内部缓冲。SDK 内部首版固定：

```text
低水位               5 秒：低于时恢复解析/读取
目标缓冲             15 秒：达到后暂停继续向播放器提交
绝对前向硬上限       30 秒：考虑一次媒体段跨越后的安全线
后向保留建议         30 秒：更旧媒体帧主动回收
原始块窗口内存上限   prefetchBlocks * 256 KiB，加固定小额解析开销
```

- 这些是内部安全默认值，首版不增加第二组 UI 设置；
- SDK 必须同时满足 Block 窗口和媒体时间水位，任一达到上限都停止继续读取；
- MSE `SourceBuffer.remove()`、WebCodecs frame/AudioData `close()`、Worker transferable 和事件监听器都必须有确定回收点；
- 设置中的块数不是“播放器总内存”，UI 不得误导；解码器、GPU 和 MSE 另有有界资源；
- 暂停较久时不得继续购买直到文件结束；恢复后从低水位正常补充。

## 7. 首播与容器随机读取

首播最早边界：

```text
Stat
  -> Read/验证完整 Seed
  -> Read/验证首个完整 Block（最多 256 KiB）
  -> 容器/Codec 确认
  -> 必要时读取有限的尾部索引 Block
  -> 建立初始化段/首批可解码样本
  -> playing
```

- 禁止把尚未完成 Block SHA-256 的 attachment 前缀交给媒体 API；
- `playing` 必须在未读取完整文件时发生，除非文件本身不超过首播必要块；
- 头部探测不能无界扫描；同时驻留仍受用户窗口限制，总探测块数另设内部上限 8；
- 超出探测上限仍找不到可信容器初始化信息时降级下载，不完整猜测；
- MP4 `moov` 位于尾部时按 byte range 映射到 Block 随机读取，不允许完整顺序下载后才播放；
- seek 到未缓冲位置时，取消旧预取窗口，从目标关键帧/样本边界建立新窗口；首版若无法建立可信索引，只允许缓冲区内 seek，并在 UI 明示。

## 8. 格式与播放后端

扩展名、文件名和 Stat `mediaType` 都是不可信提示。最终路由依据魔数、容器结构、轨道 Codec 和运行时能力。

### 8.1 MP3

- 支持 ID3v2 头跨 Block，设置严格 tag 大小上限；
- 找到连续合法 MPEG Audio frame 后才确认 MP3；
- 优先选择实测可用且内存可控的 MSE 或 WebCodecs 路径；
- 首批完整音频 frame 解码后即可播放，不等待 EOF；
- 非法 frame 长度、采样率变化或解码失败安全停止并允许下载。

### 8.2 WAV

- 增量解析 RIFF/WAVE chunk，不假定 `fmt `、`data` 紧邻或头部固定 44 字节；
- 首版至少支持常见 PCM/IEEE float、单声道/双声道，并明确其他格式降级；
- PCM 数据使用 AudioWorklet 或经 Gate 0 证明等价且有背压的路径输出；
- chunk 长度、通道数、采样率、位深和乘法全部做溢出/资源上限检查；
- 不得使用需要完整文件的 `decodeAudioData()` 冒充流式 WAV。

### 8.3 MP4

- fMP4 初始化段和媒体段可在能力确认后进入 MSE；
- 普通 progressive MP4 使用增量 demux/必要的 transmux，不把任意 256 KiB 切片直接 append；
- 支持 `moov` 在头部与尾部两类基线样本；尾部索引通过随机 Block 读取；
- 首个生产基线为 Chromium 实际支持的 H.264/AAC 组合；其他 Codec 只按运行时能力增加；
- box 尺寸、递归层数、track 数、sample 数、时间刻度、分辨率和时长必须有上限。

### 8.4 MKV

- 识别 EBML/Matroska，不把所有 MKV 当成 WebM；
- WebM 子集在运行时支持时可走 MSE；
- 通用 MKV 需要增量 demux，再把编码样本交给 WebCodecs 或经审计的 transmux 后端；
- 首个验收矩阵至少包含 WebM 兼容 VP8/VP9 + Opus/Vorbis，以及一组普通 MKV 的支持/不支持分支；
- 浏览器不支持容器内 Codec 时显示明确原因并降级下载，不在浏览器中做无界软件转码。

## 9. 首页接入与 UX

- 图片、文本、HTML、PDF 继续使用现有安全预览路径；
- 可流式媒体不再进入 `read all -> parts[] -> Blob URL`；
- 用户点击“播放”后开始首播读取，并显示：正在读取 Seed、正在解析媒体头、缓冲中、播放中、暂停、已结束、失败；
- 展示已缓冲时间和 Block 窗口占用，不把“已验证 Block”误写成“已播放”；
- 媒体大于 32 MiB 仍允许有界播放；
- “下载”保持独立意图，继续走完整下载策略；部分播放缓冲不得伪装成完整下载文件；
- 不支持播放但 `<= 256 MiB` 时提供现有 Blob 下载；更大文件继续提示需要后续流式保存能力；
- 新文件、供应商切换、路由卸载、插件 disable、Vault lock、active key switch 时全部 dispose；
- 播放失败不得自动重新购买整个文件或无界重试。

## 10. Live-ready 边界

播放器内部数据源至少支持：

```ts
type MediaSourceMode = "vod" | "live";

interface MediaTimelineSource {
  mode: MediaSourceMode;
  durationSeconds?: number; // VOD 通常已知；Live 可以未知
  initialization(): Promise<MediaInitialization>;
  segments(signal: AbortSignal): AsyncIterable<MediaSegment>;
  seek?(seconds: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
```

- VOD 适配器由不可变 Seed + Block 产生有限 segment 流；
- 测试适配器可以不断产生带 sequence/timestamp/keyframe 的 segment；
- 播放器不得用 `totalBlocks`、EOF 或固定 `fileSizeBytes` 作为核心状态机的必需条件；
- Live rolling window 必须可删除过旧媒体、处理 discontinuity、等待关键帧并在断流后恢复；
- 本单不冻结正式 Live Head/Manifest wire，不新增可变 Seed，不实现供应商发布/订阅；
- 未来 Live 开工前必须单独裁决持续播放的累计付费或单位时间预算；现有“单 Block 最高金额”不能限制无限播放总支出。

## 11. 生命周期与安全

- demux 必须在 DedicatedWorker；若 MSE 不能在 Worker 构造，仅把最小 append 控制留在 Window；
- 原始 Block 使用 transferable 交给 Worker，所有权转移后原 buffer 应 detach；
- demux 输入视为敌对数据：所有长度、计数、时间、内存分配先校验再转换；
- WebCodecs 的 `VideoFrame`、`AudioData` 和 decoder 必须及时 close/reset；
- MSE append、remove、endOfStream 串行化，dispose 时等待/作废所有迟到 callback；
- 页面隐藏不等于 dispose；是否继续播放由用户播放状态决定；page unload、lock、key switch 必须强制终止；
- 任何媒体字节不得进入控制台、错误 message、遥测、DB、URL query 或 DOM 文本；
- 能力检测失败、QuotaExceeded、decoder error 和恶意容器都 fail closed，不能回退到不受限完整内存装配。

## 12. 必测矩阵

| ID | 场景 | 通过条件 |
|---|---|---|
| M01 | 设置默认与迁移 | 旧记录读取为 5；价格字段不变；2–64 合法，0/越界/小数拒绝 |
| M02 | 设置动态调小 | 停止新 Read，窗口自然下降，无已验证数据泄漏或重复购买 |
| M03 | 设置动态调大 | 只按可用槽位补充，不突破 Read stream 与内存上限 |
| M04 | 首块优先 | Seed 后只读首块；未验证完成前不触发 demux/play |
| M05 | 提前首播 | `playing` 时供应商确认仍有后续 Block 未被请求 |
| M06 | 滑动窗口 | 慢消费者下任何时刻占用不超过设置；消费/释放后才补新块 |
| M07 | 双重背压 | 媒体达到目标秒数后不继续购买；降到低水位后恢复 |
| M08 | 乱序响应 | 网络响应乱序但容器输入、时间轴与播放字节保持正确 |
| M09 | 完整性 | 错 Hash、错长度、错误末块、Seed 计数不符均不进入 demux |
| M10 | 同 Hash 在途 | 同窗口重复 Hash 只有一个 active Read，不触发覆盖取消 |
| M11 | Pause | 长时间暂停不继续读到 EOF；恢复后从低水位补充 |
| M12 | Seek | 取消旧窗口，从可信关键帧/样本边界重建；迟到块作废 |
| M13 | MP3 | 跨 Block ID3/帧可增量首播；非法帧安全降级 |
| M14 | WAV | RIFF chunk 跨 Block、PCM 持续输出；不依赖完整 `decodeAudioData` |
| M15 | MP4 头部索引 | fMP4/头部 moov 在未读完整文件时播放 |
| M16 | MP4 尾部索引 | 只随机读取必要尾部 Block，不顺序下载完整文件 |
| M17 | MKV/WebM | 支持组合流式播放；不支持 Codec 明确降级下载 |
| M18 | 伪造 MIME | MIME/扩展名与魔数不符时不进入错误后端 |
| M19 | 生命周期 | 新文件、Abort、disable、卸载、lock、key switch 全部停止并释放媒体资源 |
| M20 | 大文件 | 超过 256 MiB 的支持媒体仍可有界播放，内存不随文件长度增长 |
| M21 | 长时间 VOD | 无头 Chromium 连续一小时或等价加速验收，堆/GPU/SourceBuffer 有界 |
| M22 | Live 模拟 | 无限源持续产生 segment，rolling window、断流恢复和 discontinuity 有界 |
| M23 | 真实数据面 | 本地生产构建经真实 Go supplier 播放正式多 Block 媒体，不注入 fake transport |
| M24 | 边界与敏感数据 | SDK 无 React/私钥/transport 越界；文件内容、私钥、付款原文不进日志 |

## 13. 分阶段实施

### 阶段 A：内部 SDK Core

- 先完成 Gate 0 候选报告、可丢弃 spike 与依赖裁决，再进入生产包；
- 包边界、Vod BlockSource、窗口调度、设置、稳定错误、假源与单元测试；
- 暂不接播放器 UI，但必须以慢消费者证明窗口和背压；
- A 阶段完成前不得把新逻辑直接堆进 `MsFileHomeFileWidget.tsx`。

### 阶段 B：格式后端与首页接入

- 完成 Gate 0 后接入 MP3/WAV/MP4/MKV；
- 首页媒体从完整 Blob 路径迁移到 SDK；
- 完成真实 Chromium + Go supplier E2E、错误降级与生命周期验收。

### 阶段 C：Live-ready 收口

- 用无限模拟源运行长时间 rolling buffer、断流、discontinuity 和 keyframe 测试；
- 确保播放器核心不依赖 EOF/固定总长度；
- 只形成未来 Live Manifest 的问题清单，不修改服务端或 wire。

三个阶段可以在同一施工单内连续提交，但每阶段必须有独立提交和可回退基线。

## 14. 明确不做

- 发布独立 npm 公共 SDK；
- 修改 `bitcoin-libp2p`；
- 修改 MSFile V1 wire/network 或 Go/NAS supplier；
- 正式 Live Head/Manifest、发布、订阅或服务端推流；
- HLS/DASH/RTMP/WebTorrent 协议；
- 浏览器端无界转码或自行实现 Codec；
- DRM/EME、字幕、倍速、画中画、投屏和多音轨完整产品化；
- 256 MiB 以上流式保存到文件系统；
- 把 Connect App 作为本单第二调用方，或让 Connect App 取得内部 trusted reader；
- 改变 Seed/Block 单对象最高金额授权模型。

## 15. 验收命令与证据

至少执行：

```text
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm exec vitest run packages/msfile-media packages/plugin-msfile/src
pnpm exec playwright test <MSFile 媒体流 E2E> --project=chromium --workers=1
pnpm build
pnpm test
git diff --check
```

真实 E2E 必须能从供应商计数器证明：播放器进入 `playing` 时尚未读取全部 Block；
不能只根据 UI 状态、mock reader 或完整 Blob 播放宣称通过。微软无头环境可以作为正式
Chromium 验收环境，不要求人工桌面点击，但播放动作必须以真实用户 gesture 语义触发。

## 16. 完成定义

- M01–M24 全部通过；
- 默认 5 Block 且可在设置页配置 2–64，旧设置安全迁移；
- MP3、WAV、MP4、MKV 的基线支持矩阵有真实 Chromium 证据，不支持组合正确降级；
- 首播发生在完整文件读取之前，Block 未验证前绝不进入解析/播放；
- Block 窗口、播放秒数、CPU/GPU/内存和生命周期全部有界；
- 首页不再为支持媒体创建完整 Blob 才播放；下载路径仍保持独立；
- 内部 `@keymaster/msfile-media` 无 React、私钥、session、transport 和金额输入；
- Live 模拟源可长时间持续播放，核心不依赖固定 EOF，但服务端/wire 未被偷偷扩展；
- `bitcoin-libp2p`、`MSFile-Proxy-Protocol` 工作树保持未修改；如有外部缺口，形成单独协调意见而非跨仓直接施工。

## 17. 当前实现记录（2026-08-28）

本次已落地：

- 新增内部包 `@keymaster/msfile-media`。Core 负责 Seed/Block 校验、Hash 合并、最多
  2 路读取、2–64 Block 窗口、随机读取上限、Abort/释放和 VOD/Live-ready 假源；不依赖
  React、Coordinator、DB、transport、私钥或金额。
- Mediabunny `1.55.3` 通过 DedicatedWorker 的受限 `CustomSource` 做容器/轨道探测，
  关闭库内预取；fMP4 直接进入 MSE，普通 progressive MP4 在 DedicatedWorker 内以
  `Conversion + Mp4OutputFormat(fastStart: "fragmented")` 转为 fMP4，再由 Window 串行
  append；WAV 走增量 RIFF/PCM Audio API。原生 `audio/video controls` 是首版 UI 和零依赖回退。
- 首页媒体不再走完整 Blob 预览；播放按钮才启动 Seed/Block 读取，下载仍是独立动作。
  不支持的 Codec、容器、浏览器能力、完整性错误和大于 safe integer 的文件会明确降级。
- MSFile 设置页新增独立的媒体预取窗口字段，默认 5、范围 2–64；旧 DB 缺失字段时
  回退为 5，更新不会改动 Seed/Block 金额。状态通过 Coordinator/Resource Store 传播。

已完成的本地验证：`pnpm typecheck`、`pnpm lint:boundaries`、
`pnpm lint:react-boundaries`、媒体与 MSFile 设置/服务测试，以及 `pnpm build`。

以下内容尚未在本地声称通过：正式 MP3/WAV/fMP4/尾部 `moov`/普通 MKV 多格式夹具、真实
Go supplier 数据面 E2E、暂停/seek/dispose 长时 Chromium 验收。当前普通 MP4 已有本地
Chromium 的 H.264 progressive → fMP4 → MSE 冒烟证据；HEVC 等浏览器不支持的 Codec
仍会安全降级下载。补齐正式素材和供应商计数器证据后再更新 M13、M15–M17、M19–M23
的验收状态。

### 17.1 progressive MP4 修复记录（2026-08-28）

- 现象：普通 `sample-30s.mp4` 被探测为 `mp4` 但 `directMse=false`，旧逻辑直接抛出
  `msfile_media_unsupported_container`，导致 UI 只能提示下载。
- 修复：session 对 `mp4 + !directMse` 启用 `MsFileMp4Transmuxer`；Worker 的每次
  `CustomSource` range 都回到 `MsFileVodSource`，输出 chunk 必须等 Window 的
  `SourceBuffer.updateend` 后 ack，避免绕过 Block 校验或无界堆积。
- 本地证据：Chromium 中生成的普通 H.264 MP4 已成功经历
  `reading-seed → parsing-header → buffering → playing`；HEVC 素材返回稳定的
  `msfile_media_unsupported_codec`。正式 `sample-30s.mp4` 和多 Block 供应商计数器
  尚未纳入仓库夹具。
