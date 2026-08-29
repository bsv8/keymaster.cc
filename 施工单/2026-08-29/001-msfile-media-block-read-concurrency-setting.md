# 001 MSFile 读取并发设置施工单

> 状态：待实施
>
> 目标：将 MSFile 播放和全局读取并发开放到 Settings。系统提供建议值和一键恢复，但不把开发机上的经验值当成所有用户的固定限制。

## 1. 设置项

| 字段 | 中文含义 | 建议值 |
|---|---|---:|
| `mediaBlockReadConcurrency` | 单个媒体 Session 同时读取的 Block 数 | `2` |
| `globalSeedReadConcurrency` | 整个 Keymaster 同时读取的 Seed 数 | `4` |
| `globalBlockReadConcurrency` | 整个 Keymaster 同时读取的 Block 数 | `8` |
| `globalStatConcurrency` | 整个 Keymaster 同时执行的 Stat 数 | `4` |

规则：

- 所有字段都是大于等于 `1` 的整数；
- `mediaBlockReadConcurrency` 不能大于 `globalBlockReadConcurrency`；
- Settings 提供“恢复建议值”按钮，一次恢复为 `2 / 4 / 8 / 4`；
- 字段旁必须有中文说明：调高可能提升高带宽设备的吞吐，但会增加网络、内存、Supplier 压力以及同时付款请求；调低会节约资源，但可能增加等待；
- UI 显示按最坏情况估算的在途媒体字节：`Seed 并发 × 16 MiB + Block 并发 × 256 KiB`，帮助用户根据设备能力选择；
- 技术硬上限不能直接沿用建议值。实施者必须通过浏览器内存压力测试确定防止页面失控的硬上限，并在代码和设置说明中记录依据。

## 2. 推导值，不单独设置

以下值不得再维护独立魔法数字：

```ts
supplierPendingReadLimit = globalSeedReadConcurrency + globalBlockReadConcurrency;

executorBridgeMaxInFlightBytes =
  globalSeedReadConcurrency * MSFILE_MAX_SEED_BYTES +
  globalBlockReadConcurrency * MSFILE_MAX_BLOCK_BYTES;
```

当前的 `12` 只是建议值 `4 + 8` 的结果，不在 Settings 中单独出现，也不能与上游设置失配。

## 3. 实施范围

1. 在 contracts、MSFile DB、service 和 `MsFileSettingsSnapshot` 中增加并持久化上述四项设置；旧数据缺少字段时使用建议值；
2. MSFile Settings 新增“读取并发与资源”区域，支持分别保存及一键恢复建议值；
3. 新建 `MsFileNativeMediaSession` 时读取 `mediaBlockReadConcurrency`，不再写死 `2`；现有媒体 Session 不因修改设置而重建；
4. Coordinator 使用三个全局设置替代写死的 Seed `4`、Block `8`、Stat `4`；降低设置时不取消已经开始的请求，只限制后续请求；
5. 全局并发满时进入有界、可取消的公平队列，不再直接返回 `Too many concurrent MSFile requests`；播放器、下载和 Connect App 不能长期互相饿死；
6. Window Executor 的单 Supplier pending 上限和 bridge 字节预算从设置推导；设置变更必须通过明确的版本化配置消息同步，不能让 Worker 与 Window 使用不同限制；
7. 播放器指标改名为 `在途 Block：{{used}} / {{limit}}（本媒体并发）`；Debug 同时记录本媒体限制和当时采用的全局限制。

## 4. 生效语义

- 单媒体并发：只影响修改后新建的媒体 Session；
- 全局并发：保存后影响新进入队列的请求；已经执行的请求继续完成；
- 调低到小于当前活动数时，不取消、不报错，等待活动数自然下降；
- Vault lock、切换身份、supplier/file generation 变化和页面退出时，排队任务必须与执行中任务一起取消；
- 设置损坏或越界时拒绝保存，并保留最后一个有效配置；不能静默写入一半字段。

## 5. 验收标准

- 首次使用显示并采用建议值 `2 / 4 / 8 / 4`；
- 修改、刷新和重启后设置仍然有效；“恢复建议值”可以一次恢复全部字段；
- 单媒体和全局压力测试证明实际活动数始终不超过对应设置；
- 全局槽位占满时后续读取等待而不是报错，释放槽位后继续执行；
- 多播放器、下载和 Connect App 并存时不存在永久饥饿；
- 调低并发不打断当前播放，新 Session 使用新值；
- `supplierPendingReadLimit`、bridge 最大在途字节等派生值没有独立常量；
- 回跳、连续拖动、取消、Vault lock 和 Service Worker 重启 Gate 继续通过；
- Settings 中所有字段、错误和资源影响均有中文说明及中英文测试。

## 6. 非目标

- 不增加应用级预读或历史 Block 缓存；
- 不控制浏览器自身的媒体缓存和 HTTP Range 调度；
- 不允许绕过实现者根据压力测试确定的浏览器安全硬上限；
- 不把并发数解释为金额预算或已缓存 Block 数量。
