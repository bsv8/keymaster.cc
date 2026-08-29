# MSFile 媒体解析与播放器 UI 第三方候选调研报告

> 状态：初步候选报告，等待施工单 002 Gate 0 实测后裁决。
>
> 调研日期：2026-08-28。版本和活跃时间来自当日 npm registry/GitHub；它们只用于建立
> 候选基线，不代替锁版本后的源码、许可证、安全和真实 Chromium 审计。

## 1. 调研目的

Keymaster 不应从零实现通用媒体容器解析、Codec 或播放器控制 UI。本报告把问题拆成两层：

```text
媒体解析/播放内核
  自定义 MSFile byte-range source、容器探测、demux、sample/packet、MSE/WebCodecs

播放器 UI
  play/pause、时间轴、音量、全屏、键盘、ARIA、焦点、触摸和主题
```

两层必须可以独立替换。不得因为某个 UI 框架内置 HLS/DASH，就让它绕过
`msfile.service`、Block Hash 验证、价格策略或滑动窗口自行发 HTTP 请求。

## 2. 强制评估维度

每个进入最终比较的候选都必须记录：

1. **格式与 Codec**：MP3、WAVE、MP4/ISO-BMFF、Matroska/MKV、WebM 的真实范围，不把容器和 Codec 混为一谈；
2. **输入模型**：随机 byte range、未知长度 append-only、取消、seek、尾部索引、增量读取；
3. **MSFile 适配**：range 到 256 KiB Block 的映射、库内预取/缓存、重复 Hash、窗口和付款次数；
4. **播放后端**：MSE、WebCodecs、AudioWorklet、硬件解码、音视频同步与 Live rolling buffer；
5. **成熟度**：项目年龄、最近 release、维护者/组织、release 频率、关键 issue、测试和文档；
6. **工程质量**：TypeScript 类型、Worker、tree-shaking、异常/资源释放、可观测性和替换边界；
7. **资源成本**：实际 production gzip chunk、WASM、首载/懒载、峰值堆/GPU、暂停一小时和 seek；
8. **安全性**：敌对容器输入、长度/计数溢出、fuzz/测试语料、C/WASM 解析器风险、CSP/Worker；
9. **许可证**：主包和传递依赖、修改/分发/源码提供义务、商标；许可证结论须由项目政策复核；
10. **退出策略**：适配层厚度、能否并存两套后端、升级/替换成本和失败时的安全降级。

`npm dist.unpackedSize` 不是最终 bundle size，GitHub star 也不是质量结论。实施者必须用本项目
production build 和测试素材测量，而不是只抄项目首页数字。

## 3. 媒体解析/播放内核候选

### 3.1 Mediabunny：广格式、Web 原生、优先进入 Spike

- 官网：[mediabunny.dev](https://mediabunny.dev/)
- 源码：[Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny)
- 调研版本：`mediabunny@1.55.3`；许可证 `MPL-2.0`；2026-08-26 更新；
- 官方声明支持读取 MP4、MOV、WebM、MKV、HLS、WAVE、MP3、Ogg、ADTS、FLAC、MPEG-TS；
- TypeScript、零运行时依赖、可 tree-shake，并以 WebCodecs 连接容器与 Codec；
- `CustomSource` 原生提供 `getSize()`、`read(start,end)`、`dispose()`、`maxCacheSize` 和
  `prefetchProfile`，与 MSFile Block 随机读取高度吻合；
- `ReadableStreamSource` 支持未知长度 append-only 输入，可作为 Live-ready spike 参考。

**优势**

- 一个库覆盖本期四种目标容器，减少自写/拼装多个 parser；
- lazy byte-range 读取适合尾部 `moov`、MKV 索引和 seek；
- `CustomSource` 能把每次 range 请求映射到已验证 Block，适配边界明确；
- Worker、生命周期、packet/sample API、解码能力检测和树摇均有正式文档。

**主要风险**

- 相比 GPAC/FFmpeg 路线更年轻、版本迭代快，公共 API 和边缘容器稳定性必须实测；
- MPL-2.0 允许商业使用，但若修改并分发其源码文件，需要公开对应修改；优先不 fork、不复制源码；
- 自带 cache/prefetch 可能和“用户设置的付费 Block 窗口”形成第二套策略；首个 spike 必须使用
  `prefetchProfile: "none"`，显式限制 `maxCacheSize`，从供应商计数器验证没有额外读取；
- “支持某容器”不等于当前 Chromium 支持其中所有 Codec；必须逐轨运行时检查；
- 需要证明其 sample/sink API 能稳定驱动实际音视频播放，而不仅是读取元数据或离线转换。

**初步定位**：最匹配 MSFile 的主候选，但不是免验收的既定答案。

### 3.2 MP4Box.js：MP4 专家、长期稳定的保守基线

- 源码：[GPAC/mp4box.js](https://github.com/gpac/mp4box.js)
- 调研版本：`mp4box@2.4.1`；许可证 `BSD-3-Clause`；2026-06-19 更新；
- 2015 年起由 GPAC 体系发展，提供 progressive parsing、sample extraction、seek、内存释放和
  on-the-fly fragmentation/MSE segmentation；2025 年发布 1.0 TypeScript 支持。

**优势**

- ISO-BMFF/MP4 单项专业能力深，长期生产使用历史和文档优于新型全格式库；
- 非 fragmented MP4 转 MSE、尾部 `moov`、关键帧 seek 和 `releaseUsedSamples()` 与本项目难点直接对应；
- BSD-3-Clause 简单，适合作为 MP4 专项对照和退路。

**主要风险**

- 只解决 MP4/ISO-BMFF，MP3、WAV、MKV 仍需其他库；
- 输入是带文件偏移的增量 ArrayBuffer，仍需 Keymaster 自己写严谨的 Block/range 适配；
- 多 parser 组合会产生不同生命周期、错误和 seek 语义，内部 SDK 需要统一它们；
- 不能因为 MP4Box 稳定就自行编写另外三套简化 demuxer。

**初步定位**：MP4 专项首选对照；若全格式库未通过，可作为“少格式但稳”的组合核心。

### 3.3 LibAV.js：格式广、FFmpeg 血统、WASM 重型兜底

- 源码：[Yahweasel/libav.js](https://github.com/Yahweasel/libav.js/)
- 调研版本：`libav.js@6.10.9`；许可证标记 `LGPL-2.1`；2026-08-18 更新；
- 把 FFmpeg 的 libavformat/libavcodec/libavfilter 等编译到 WebAssembly，支持异步虚拟设备 I/O；
- 官方提供与 WebCodecs 的 bridge/polyfill，并建议可用时优先 WebCodecs 硬件解码。

**优势**

- 容器和 Codec 覆盖面、异常媒体兼容性和 FFmpeg 生态积累最广；
- 可定制 variant，只编入目标 demux/codec；
- 适合作为浏览器原生 Codec 不支持时的明确、按需加载兜底研究对象。

**主要风险**

- npm 包调研时 unpacked size 约 179 MB；必须自建最小 variant、懒加载 Worker，不能进入首屏主 chunk；
- LGPL/FFmpeg 及所选外部库带来源码提供等分发义务，必须单独做许可证清单；
- WASM 软件解码不能等价替代硬件解码，CPU、电量、移动端、内存和 1080p 实时性风险高；
- bundler、WASM URL、线程、COOP/COEP/SharedArrayBuffer 和 CSP 部署明显更复杂；
- C/WASM 大型解析面必须在 Worker 中并加入资源/超时硬限。

**初步定位**：重型兼容性兜底，不建议成为默认热路径。

### 3.4 FFmpeg.wasm：知名度高，但默认不作为播放器热路径

- 源码：[ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
- 调研版本：`@ffmpeg/ffmpeg@0.12.15`；wrapper 为 MIT；核心 FFmpeg/WASM 及外部库许可证另算；
- 项目适合浏览器内命令式转换、编辑和离线处理，格式覆盖依赖具体 core build。

**优势**

- FFmpeg 使用经验和资料丰富；适合验证困难素材、诊断或离线转封装；
- 社区认知度高，遇到格式问题容易找到参考。

**主要风险**

- wrapper 包大小不代表另行加载的 core/WASM 大小；许可证也必须按 core 构建复核；
- CLI/虚拟文件模型与“按 Block 付费、随机 range、5 Block 窗口、持续低延迟播放”不自然；
- 容易退化成“先写完整虚拟文件再播放/转码”，违反本施工单核心验收；
- 当前不应仅因它支持格式多就优先选择。

**初步定位**：报告参考和诊断工具；除非 spike 证明真正增量、可取消、有界，否则拒绝生产播放热路径。

### 3.5 Shaka Player / hls.js：成熟流媒体参考，不直接解决当前原始文件

- [Shaka Player](https://github.com/shaka-project/shaka-player)：Apache-2.0，调研版本 `5.2.8`，
  成熟 DASH/HLS VOD/Live、MSE/EME、buffer/seek/discontinuity 和 UI；
- [hls.js](https://github.com/video-dev/hls.js)：成熟 HLS + MSE 专项实现。

**价值**

- 可参考长期运行的 buffer controller、Live window、错误恢复、MSE 生命周期和能力协商；
- 如果未来 MSFile Live 决定输出 CMAF/HLS/DASH-like manifest，Shaka 的 manifest/plugin 模型值得重新评估。

**不匹配点**

- 当前输入是一个不可变 Seed 描述的原始 MP3/WAV/MP4/MKV 文件，不是 DASH/HLS manifest + segment URL；
- 为 Shaka 编写自定义 manifest/network plugin 仍不能自动获得普通 MKV/WAV demux；
- 不得为迁就成熟播放器而偷偷把 MSFile V1 改造成 HTTP/HLS。

**初步定位**：未来 Live/流控参考，不作为本期原始文件解析首选。

### 3.6 已排除的新接入候选：`@remotion/media-parser`

Remotion 当前源码已经把 `parseMedia()` 标记为 deprecated，并明确建议改用 Mediabunny。
新代码不得选择一个已经声明迁移方向的 API。Remotion 整体还有特殊商业许可证条件，不能因为其
React 生态和知名度直接引入播放器核心。

## 4. 播放器 UI 候选

### 4.1 Media Chrome：后端解耦优先候选

- 源码：[muxinc/media-chrome](https://github.com/muxinc/media-chrome)
- 调研版本：`media-chrome@4.19.2`；MIT；2026-08-22 更新；
- 以 Web Components 提供音视频 controls，兼容原生 `<audio>/<video>` 和多种 player/backend。

**优势**

- UI 和媒体内核分离最清晰，符合 `@keymaster/msfile-media` 可替换后端设计；
- 同时覆盖 audio/video，CSS 与组件组合自由，不要求采用其网络层；
- MIT、持续维护、由 Mux/Video.js 背景团队维护。

**风险/必测**

- 官方也提示 Web Components 在 React 中可能不够 idiomatic；必须 spike ref/event/property 接入与卸载；
- 核对键盘、ARIA、焦点、中文 label、触摸和首页窄布局，不只看 demo 外观；
- 测量按需导入后的实际 chunk，不能用 npm unpacked size 判断。

**初步定位**：最符合架构的 UI 首选候选。

### 4.2 Video.js：最成熟、生态最大的保守候选

- 源码：[videojs/video.js](https://github.com/videojs/video.js/)
- 调研稳定版本：`video.js@8.24.0`；Apache-2.0；2010 年起发展；
- 官方说明拥有成熟插件生态、TSC 治理，并系统覆盖 ARIA、键盘、焦点、字幕、对比度和触摸。

**优势**

- 项目历史、使用规模、可访问性资料和问题经验最丰富；
- 控件、状态、插件和跨设备行为成熟，适合“不想自己踩播放器 UI 坑”的目标。

**风险/必测**

- 框架更重，内部 Tech/Source API 与自定义 MSFile backend 的耦合成本可能高；
- 2026 年 v10 正在 beta/架构转型，必须明确选稳定 v8 还是等待 v10，禁止混用文档；
- 测量只使用 UI 所需能力后的体积、React 生命周期、MSE 自定义源兼容和长期升级成本。

**初步定位**：成熟度/可访问性基准；如果 Media Chrome 接入不稳，优先对照。

### 4.3 Vidstack：现代 React 与功能丰富候选

- 官网：[vidstack.io](https://vidstack.io/docs/player/)
- 调研版本：`@vidstack/react@0.6.15`；MIT；2026-06-10 更新；
- 文档提供 Audio、Video、HLS、DASH、YouTube、Vimeo、Remotion 等 provider 和成套 UI。

**优势**

- React API、可组合 UI、状态和 provider 模型现代，开发体验可能优于 Web Components wrapper；
- 功能面丰富，未来字幕、手势、全屏、画中画等扩展空间大。

**风险/必测**

- 主版本仍低，API 稳定性、升级频率和长期维护风险要单独评估；
- 现成 provider 不等于支持 MSFile 自定义 sample/backend，可能需要维护私有 provider；
- 不要因为 React 接入舒服，就让 UI 框架成为媒体内核和协议边界。

**初步定位**：现代 React 体验候选，须与长期稳定性权衡。

### 4.4 Plyr：简单、轻职责候选

- 官网：[plyr.io](https://plyr.io/)
- 源码：[sampotts/plyr](https://github.com/sampotts/plyr)
- 调研版本：`plyr@3.8.4`；MIT；2026-01-03 更新；
- 目标是简单、可访问、可定制的 HTML5 audio/video UI。

**优势**

- 职责和学习成本较小，不试图接管 demux/网络；
- 若首页只需要可靠的基础 controls，可能比完整框架更合适。

**风险/必测**

- 高级缓冲状态、Live、错误态、外部 seek 管理和自定义 backend 扩展能力较弱；
- 仍需验证 React teardown、键盘/ARIA、音频样式和自定义缓冲指示。

**初步定位**：小而稳的 UI 对照，不追求完整流媒体框架能力。

### 4.5 原生 controls：必须保留的零依赖基准

原生 `<audio controls>` / `<video controls>` 不是最终美术方案，但必须加入 spike 作为基准：

- 若第三方 UI 无法正确反映 buffering、seek、error 或 dispose，不能比原生更差；
- Gate 0 可先用原生 controls 验证媒体内核，把 UI 选型和 demux 成败解耦；
- 第三方 UI 最终选择失败时，原生 controls 是安全回退，不应反过来阻塞核心流式播放。

## 5. 初步多维比较（非最终裁决）

评分 1–5 仅表示当前资料下的相对判断，实施者必须用 Gate 0 证据覆盖本表。

### 5.1 解析/内核

| 候选 | 格式广度 | 随机/增量输入 | 长期成熟度 | Web 原生/体积潜力 | 许可证便利度 | 当前 MSFile 适配度 |
|---|---:|---:|---:|---:|---:|---:|
| Mediabunny | 5 | 5 | 3 | 5 | 4 | 5 |
| MP4Box.js | 1 | 4 | 5 | 4 | 5 | 4（仅 MP4） |
| LibAV.js | 5 | 4 | 5 | 1 | 2 | 3（兜底） |
| FFmpeg.wasm | 5 | 2 | 4 | 1 | 2 | 1（热路径） |
| Shaka/hls.js | 2（分段流） | 4 | 5 | 3 | 5 | 2（当前）/5（未来 Live 参考） |

### 5.2 UI

| 候选 | 后端解耦 | React 接入 | 成熟度 | 可访问性资料 | 功能丰富度 | 当前建议 |
|---|---:|---:|---:|---:|---:|---|
| Media Chrome | 5 | 3 | 4 | 4 | 4 | 优先 Spike |
| Video.js v8 | 3 | 3 | 5 | 5 | 5 | 成熟基准 |
| Vidstack React | 4 | 5 | 3 | 4 | 5 | 现代候选 |
| Plyr | 3 | 4 | 4 | 4 | 3 | 简单候选 |
| 原生 controls | 5 | 5 | 5 | 由浏览器负责 | 2 | 零依赖基准/回退 |

## 6. Gate 0 必须产出的组合 Spike

实施者至少完成以下组合，不要求全部进入生产：

1. **广格式主候选**：Mediabunny `CustomSource` + 原生 controls/最小播放后端；
2. **MP4 稳定对照**：MP4Box.js + MSE + 原生 controls；
3. **重型兜底测量**：最小 LibAV.js variant，只验证一个主候选不支持的素材和真实资源成本；
4. **UI A/B**：同一个假 MSE/HTMLMediaElement backend 分别接 Media Chrome、Video.js 或 Vidstack/Plyr 中至少两种；
5. **Live 参考**：无限假 segment source 下验证 UI 和核心状态机，不要求接 Shaka。

每个 Spike 用完全相同的素材与指标：

- MP3（含跨 Block ID3）、PCM WAV、fMP4、尾部 moov MP4、WebM、普通 MKV、至少一个不支持 Codec；
- 到 `playing` 的已购 Block 数、首播时间、总 Read 次数、重复 Read、最大窗口占用；
- pause 60 秒、seek 前后、dispose 后的网络/Worker/内存；
- production gzip chunk、动态 chunk/WASM、首次与二次加载；
- 30 分钟或等价加速播放的堆、MSE、VideoFrame/AudioData 和 CPU；
- 恶意长度、截断容器、错误索引、巨量 track/sample 元数据的 fail-closed 行为。

## 7. 最终裁决模板

Gate 0 完成后，实施者必须在本报告追加：

```text
选择日期：
锁定版本：

容器解析主方案：
MP4 专项/回退方案：
Codec/重型兜底方案：
播放器 UI：
零依赖回退：

选择理由（实测数据）：
拒绝候选及原因：
许可证确认：
已知不支持格式/Codec：
MSFile CustomSource/Block 窗口适配方式：
依赖升级策略：
替换/退出策略：
```

最终方案可以是组合而不是单库。例如“广格式主库 + MP4 专项库 + 原生 Codec + UI 组件”，
但必须避免两套库同时解析同一输入、重复购买 Block 或形成无法统一释放的双状态机。

## 8. 当前建议但不冻结

当前最值得优先实测的组合是：

```text
Mediabunny CustomSource
  → MSFile byte-range/Block adapter
  → WebCodecs / 必要时 MSE
  → Media Chrome（UI）
  → 原生 controls（回退）
```

理由是格式覆盖和自定义 range source 与 MSFile 最匹配，UI 也与后端解耦。但 Mediabunny 的年轻度、
MPL-2.0、内部 cache/prefetch、真实音视频同步和边缘 MKV/MP4 稳定性都必须由 Gate 0 证明。
若失败，优先考虑 MP4Box.js 负责 MP4、其他格式采用经过实测的专用解析器；LibAV.js 只作为懒加载
重型兜底。不得把本段“当前建议”当作跳过对照实验的最终技术裁决。

## 9. Gate 0 实测裁决（2026-08-28）

### 9.1 实测环境与证据范围

- 包元数据通过当前 workspace 的 pnpm registry 查询：
  `mediabunny@1.55.3`（MPL-2.0）、`mp4box@2.4.1`（BSD-3-Clause）、
  `libav.js@6.10.9`（LGPL-2.1）、`media-chrome@4.19.2`（MIT）、
  `video.js@8.24.0`（Apache-2.0）、`@vidstack/react@0.6.15`（MIT）、
  `plyr@3.8.4`（MIT）。
- 本机 Playwright Chromium：`HeadlessChrome/149.0.0.0`，安全上下文为
  `http://localhost`；生产基线仍以运行时能力检测为准，不能把浏览器版本写死在代码中。
- Chromium 实测：Window `MediaSource` 可用，MP3/fMP4/WebM 的
  `MediaSource.isTypeSupported()` 为 true；`AudioDecoder` 和 `VideoDecoder`
  可用，H.264、VP8、VP9、AV1、AAC、MP3、Opus 能通过目标组合检测。
- DedicatedWorker 中虽然存在 `MediaSource` 名称，但当前浏览器没有可依赖的
  `canConstructInDedicatedWorker` 正向证据。因此生产路径只把 Worker 用于读取、
  解析准备和传输，`SourceBuffer` append 固定在 Window；能力不足时直接降级。
- 已检查 Mediabunny `CustomSource`：支持 `getSize/read/dispose`、`maxCacheSize`
  与 `prefetchProfile: "none"`；其 `Input` 支持 MP4、Matroska、WebM、MP3、WAVE
  等输入格式。另以本机 Chromium 实测普通 H.264 MP4 的
  `Conversion + Mp4OutputFormat(fastStart: "fragmented")` 转封装和 Window MSE
  append，可成功播放；当前仓库仍没有正式多格式媒体 fixture 和 Go supplier E2E，
  故尾部 `moov`、普通 MKV、WAV 长时播放和真实生产构建不能在本 Gate 声称通过，留在
  阶段 B 的验收矩阵中。

### 9.2 组合裁决

```text
选择日期：2026-08-28
锁定版本：mediabunny@1.55.3；UI 初版不锁第三方组件

容器解析主方案：Mediabunny 1.55.3，使用 CustomSource + prefetchProfile="none"
MP4 专项/回退方案：首版优先 Mediabunny 的 MP4 识别；MP4Box.js 2.4.1 只保留为后续专项回退候选
Codec/重型兜底方案：浏览器原生 MSE/WebCodecs；不把 LibAV.js/FFmpeg.wasm 放入热路径
播放器 UI：原生 <audio controls>/<video controls>，等待自定义后端指标验收后再引入 Media Chrome
零依赖回退：原生 controls；容器、Codec、能力或解码失败均回到独立下载

选择理由（实测数据）：Mediabunny 是唯一同时覆盖目标输入格式并直接提供可控
CustomSource range API 的主候选；其 cache/prefetch 参数可以映射 MSFile Block
窗口。Window MSE 与目标 Codec 组合在 Chromium 中通过能力检测。原生控件不增加
运行时依赖，并能先验证 buffer、pause、seek、error、dispose 的完整链路。
拒绝候选及原因：Video.js 传递依赖和运行时职责过重；Vidstack React 版本年轻且
自定义后端仍需额外验证；Plyr 对外部时间轴/后端控制能力不足；LibAV.js 体积和
LGPL 义务不适合热路径；MP4Box.js 只覆盖 MP4，不能单独承担全格式主解析。
许可证确认：Mediabunny 为 MPL-2.0，必须随发布物保留许可与修改说明；候选库的
许可证不能因为动态 import 而省略。当前 UI 不引入第三方许可证。
已知不支持格式/Codec：没有运行时能力或没有经过增量解析/释放验收的组合；普通
MKV、软件 Codec 以及未能建立可信转封装输出的 MP4 不得猜测播放，统一给出明确原因
并下载。普通 progressive MP4 已有 H.264 基线转 fMP4 路径，但尾部 moov 和其他
Codec 仍需阶段 B 的正式素材证据。
MSFile CustomSource/Block 窗口适配方式：先完整验证 Seed，再优先读取 Block 0；
按 byte range 映射 Block Hash，最大并发 2、Hash 在途合并、窗口可动态调整；
Mediabunny cache 设为不超过 SDK 窗口的字节预算，关闭其网络预取。
依赖升级策略：只允许显式升级并重新跑 Gate 0、边界测试、真实 fixture 与构建
体积检查；不接受浮动 major/minor 作为生产裁决。
替换/退出策略：若 Mediabunny 在真实 fixture 上无法证明边界或释放，先以 MP4Box.js
承担已验证 MP4 子集，其他格式继续下载；当前 MP4 转封装 Worker 也应保持为可替换
适配层；LibAV.js 只能作为单独评审的懒加载兜底。
```
