# MSFile

MSFile 通过受控 P2P 网络按内容哈希查询和读取 Seed/Block。插件默认装配，但未配置供应商或
金额策略时读取会安全失败，不会建立隐式连接。

## 架构

```text
页面或 Connect App
→ Coordinator 中的 MSFile 服务、额度与公平队列
→ Window P2P 唯一 Host 的 MSFile lane
→ 已固定身份的 Go Supplier
```

Supplier 的 Noise 身份必须与配置的压缩公钥一致。Vault 锁定、切 Key、供应商变化或页面
释放时，排队和执行中的请求一起取消；迟到结果不能进入新会话。

## 对外能力

| 方法 | 中文用途 |
| --- | --- |
| `msfile.stat` | 查询哪些 Supplier 有目标 Seed、文件大小和报价 |
| `msfile.seed.read` | 读取并校验最多 16 MiB 的 Seed |
| `msfile.block.read` | 读取并校验最多 256 KiB 的 Block |

读取请求不接受调用方提供金额上限。全局价格和 App 单独额度由 Keymaster 管理；超额时用户可
拒绝、仅本次允许或保存新的 App 上限。`0` 表示明确不限金额，不表示字段缺失。

## 并发设置

| 字段 | 中文含义 | 建议值 | 硬上限 |
| --- | --- | ---: | ---: |
| `mediaBlockReadConcurrency` | 单个媒体同时读取的 Block 数 | 2 | 16 |
| `globalSeedReadConcurrency` | 全局 Seed 读取数 | 4 | 8 |
| `globalBlockReadConcurrency` | 全局 Block 读取数 | 8 | 32 |
| `globalStatConcurrency` | 全局 Stat 查询数 | 4 | 16 |

媒体值不能大于全局 Block 值。调低设置不取消已经开始的请求，只限制后续任务；队列有界、
可取消，并避免播放器、下载和 Connect App 长期互相饿死。

## 文件和媒体

- 首页按 Seed Hash 查询，校验文件大小、Block Hash 和实际字节后才展示或下载。
- 小文件可安全预览；HTML 隔离脚本、网络、表单和导航，超限文件不先读入 Blob。
- 音视频使用根作用域 Service Worker 提供临时同源 URL，浏览器原生 Range 请求再映射到
  256 KiB Block。
- 临时 URL 随机且绑定页面，不包含 Hash、Supplier、金额或身份；锁定和 dispose 会撤销。
- Keymaster 不维护已完成 Block 缓存，也不预测播放时间；浏览器不支持的格式回退为下载。

旧 MSE/转封装源码只作为暂存兼容代码存在，当前首页生产路径使用 Native Range。

## 验收状态

Chromium 与本机正式 Go Supplier 的身份、读取、Range、取消和压力测试已有自动化证据。
Firefox、Safari、公共 CA/公网网络、目标 NAS 和真实部署 smoke 仍需对应环境验证；以
[覆盖矩阵](./集成测试/覆盖矩阵.md)为准。
