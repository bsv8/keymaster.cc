# MSFile 读取并发硬上限压力测试证据

> 日期：2026-08-29
>
> 结论：选定的读取桥接预算 `8 Seed + 32 Block = 136 MiB` 在
> Headless Chromium 中完成最坏 attachment 分配、批量 transferable、释放和
> 页面心跳测试；超出该预算的 `208 MiB` 对照组也完成，但不因此扩大产品硬上限。

## 测试方法

测试脚本为 `scripts/msfile-read-concurrency-pressure.mjs`，运行：

```text
pnpm verify:msfile-read-concurrency-pressure
```

脚本启动带 `--enable-precise-memory-info` 的 Chromium，创建一个 Worker，按
MSFile 内容硬上限分配并触碰每个 4 KiB 页面，然后一次性将 Seed/Block
`ArrayBuffer` 通过 transferable 交给 Worker 暂存。测试期间每 10 ms 记录页面
事件循环心跳，Worker 收到全部 attachment 后再统一释放。页面 JS heap 不包含
所有 `ArrayBuffer` backing store，因此报告同时记录精确的显式在途字节数；不能
用测试前后 heap 差值替代桥接预算。

## 本次环境与结果

| 项目 | 实际值 | 中文说明 |
|---|---:|---|
| Playwright | 1.61.1 | 浏览器压力测试驱动 |
| Chromium | 149.0.7827.55 | 测试浏览器 |
| Seed attachment | 16 MiB/个 | MSFile Seed 内容硬上限 |
| Block attachment | 256 KiB/个 | MSFile Block 内容硬上限 |

一次实际运行结果如下（heap 数值为 Chromium 页面 JS heap；`requestedMiB` 是
桥接 attachment 的准确显式预算）：

| 场景 | Seed / Block | 在途字节 | 页面心跳最大延迟 | 释放 |
|---|---:|---:|---:|---|
| recommended | `4 / 8` | `66 MiB` | `140.90 ms` | PASS |
| selected-hard-budget | `8 / 32` | `136 MiB` | `173.60 ms` | PASS |
| above-selected-budget | `12 / 64` | `208 MiB` | `433.10 ms` | PASS |

本轮三组均完成批量 transfer、Worker 暂存和释放，没有页面崩溃、Worker 超时或
未释放结果。`208 MiB` 仅是压力对照，不能推导低内存设备安全，也不作为设置
允许值。

## 硬上限裁决

代码中的 `MSFILE_READ_CONCURRENCY_HARD_LIMITS` 采用以下独立上限：

| 字段 | 硬上限 | 依据 |
|---|---:|---|
| `mediaBlockReadConcurrency` | `16` | 单媒体逻辑并发；且必须不大于全局 Block 上限 |
| `globalSeedReadConcurrency` | `8` | 使最坏 Seed attachment 为 `128 MiB` |
| `globalBlockReadConcurrency` | `32` | 使最坏 Block attachment 为 `8 MiB` |
| `globalStatConcurrency` | `16` | Stat 不携带内容 attachment，独立限制请求/协议压力 |

因此 Window Executor 的 `bridgeMaxInFlightBytes` 固定由设置推导为：

```ts
globalSeedReadConcurrency * MSFILE_MAX_SEED_BYTES
+ globalBlockReadConcurrency * MSFILE_MAX_BLOCK_BYTES
```

选定的 `136 MiB` 低于本次 `208 MiB` 压力对照，给页面解码、React、协议对象和
Supplier 运行时保留余量；建议值 `4 / 8 / 4` 仍只作为恢复值，不是技术上限。
