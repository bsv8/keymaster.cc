# KMS3-016：Storage SharedWorker Runtime 硬切换施工单

## 1. 状态与目标

- 状态：实施完成；Storage 范围验收通过。仓库级全量测试存在与本工单无关的
  `pluginManager` 基线挂起，归因与处置记录见第 9 节。
- 决策：Storage 逻辑上是独立 runtime，物理上归属现有
  `Keymaster Session Coordinator SharedWorker`；不新建第二个 SharedWorker、Dedicated
  Worker 或 Service Worker。
- 目标：Provider 配置、Provider 状态、S3 client、cursor、multipart runtime 和所有
  S3 I/O 只有一个跨 tab/window 真值所有者。
- 迁移方式：硬切换。页面/plugin host 不再创建可执行 S3 I/O 的
  `StorageServiceImpl`，只保留 Settings/ResourceRegistry 和 `StorageService` RPC proxy。

本工单同时收口 2026-08-10 总体 review 发现的 2 个 P1 和 5 个 P2。任何一项安全、
一致性或数据完整性验收未通过，都视为阻断，不得宣称工单完成。

## 2. 不可变设计规则

1. **单一所有者**：active provider record、明文 provider config、S3 client、provider
   generation、conditional capability state、cursor 和 multipart runtime 只能存在于
   Coordinator SharedWorker。
2. **凭据不回页面**：sealed config 由 Worker 内已有的 `storageSecretKey` 解密；页面
   不得通过 Vault RPC 取得 active provider 的明文凭据。
3. **锁定可抢占**：Vault lock 不得排在慢 S3 网络请求之后。锁定必须先关闭 Storage
   gate、abort 所有在途请求、立即 destroy client/清除明文，再推进 Vault 清钥和状态
   发布。远端 multipart cleanup 不得延迟凭据销毁。
4. **执行通道分离**：
   - Vault/control lane 保留 Coordinator 的安全串行化；
   - Storage mutation lane 串行执行 probe/activate/clear/reset；
   - Storage data lane 有界并发执行 list/get/put/delete/multipart；
   - lock/reconfiguration 可以抢占 data lane。
   Storage 网络请求禁止直接进入现有全局 `coordinatorRequestTail` 并阻塞 lock。
5. **世代双栅栏**：每个 Storage data request 绑定 `sessionEpoch` 和
   `providerGeneration`；请求开始与返回前都校验。旧 epoch/generation 的迟到结果必须
   失败，不能发布为成功。
6. **状态单流**：新增带单调 `storageRevision` 的 `storage.state` topic。订阅返回原子
   baseline；所有 tab/window 的 Settings 和 resource snapshot 只能消费该状态流，不能
   自行从 IndexedDB 恢复 active runtime。
7. **显式取消**：`AbortSignal` 不跨 MessagePort 传输。RPC 使用 request id 与
   `storage.cancel`；port 断开、Connect session logout/revoke、provider replacement 和
   Vault lock 都必须取消对应请求。
8. **零拷贝边界**：最高 16 MiB 的 binary request/result 使用 transferable
   `ArrayBuffer`；不得依赖默认 structured clone 复制大块正文。
9. **身份由 session 真值解析**：Connect data RPC 只接收 `connectSessionId` 和方法参数。
   Worker 必须从可信 session binding/grant 解析 transport origin 与 App Identity；不得
   信任页面随请求传入的任意 `StorageAppContext` 来决定 namespace。
10. **Worker 重启 fail closed**：Coordinator Worker 重启后 Vault 为 locked，Storage
    只能为 `locked` 或 `unconfigured`；不得仅凭 IndexedDB 自动恢复明文配置/client。
11. **无 BroadcastChannel 一致性协议**：完成硬切换后删除 Storage rotation/config
    BroadcastChannel handshake。Worker 内直接函数调用和 generation gate 是唯一运行时
    一致性机制。

## 3. Worker 状态与 RPC 契约

### 3.1 状态快照

```ts
interface CoordinatorStorageStateEvent {
  topic: "storage.state";
  type: "storage.state.changed";
  storageRevision: number;
  sessionEpoch: SessionEpoch;
  providerGeneration: number | null;
  status: StorageServiceStatus;
  summary: StorageProviderSummary | null;
  capabilities: StorageConditionalCapabilitiesView | null;
}
```

不得在事件、bootstrap、日志或错误中包含 access key、secret、完整 endpoint response、
完整物理 S3 key 或原始 S3 body/XML。

### 3.2 命令族

- `storage.control`：读取脱敏配置、probe、能力 probe、activate、clear、reset。
- `storage.data`：list、directory create/delete、put/get/delete、multipart begin/part/
  complete/abort。
- `storage.cancel`：按发起 port + request id 取消。
- `storage.session.abort`：logout/revoke 时终止并清理该 Connect session 的 multipart。

activate/clear/reset 必须支持 `expectedProviderGeneration` 的 compare-and-swap 语义；旧
Settings tab 不得静默覆盖新配置。

## 4. 生命周期顺序

### 4.1 Unlock

1. Coordinator 建立新的 `sessionEpoch` 和 `storageSecretKey`。
2. Storage runtime 读取 sealed active record。
3. Worker 内解密并规范化配置，创建唯一 S3 client。
4. 恢复同 generation 的 durable multipart metadata。
5. 发布 `ready`；失败则发布 `degraded`，不得把失败 client 暴露为 ready。

### 4.2 Lock

1. Storage gate 进入 locked/reconfiguring，拒绝新请求。
2. abort 全部 data/probe/mutation 中可取消的 Provider I/O。
3. 立即 destroy S3 client，清除 active config、cursor 和运行时 upload secret。
4. 使所有未完成请求以 `storage_unavailable` 收口，禁止返回锁定后的成功结果。
5. Coordinator 清除 `storageSecretKey`/Vault key 并推进 `sessionEpoch`。
6. 发布 session 与 storage 状态。
7. durable orphan cleanup 留到下次安全解锁后重试；禁止为了网络 cleanup 延迟步骤 3。

### 4.3 Activate/Replace

1. 校验 expected generation，关闭 data gate 并取消/排空旧 generation 请求。
2. 用 candidate 临时 client 执行只读 probe。
3. seal 完整配置并原子提交新 provider record/generation。
4. 提升 candidate 为唯一 active client，发布新 generation ready。
5. 旧 client 的 cleanup 必须有界；无论远端 cleanup 成败都及时 destroy。

### 4.4 Clear/Reset

本地事务是真值提交点。不得先成功 abort 远端 multipart、随后因本地事务失败又恢复已经
失效的 upload id。

- clear/reset 的本地事务失败：旧 runtime、旧 client 和可继续的 multipart 必须保持有效；
- 本地事务成功：立即撤销 runtime，再对事务前快照做有界 best-effort 远端 cleanup；
- 若 Provider API 的顺序迫使提前清理，则失败回滚时必须退休已成功 abort 的本地记录，
  不得把死 upload id 恢复为可继续状态。

## 5. Review 缺陷修复清单

### P1-1 Vault lock 后旧请求仍可成功

- lock 必须 abort runtime 总 controller；所有 Provider call 使用组合 signal。
- Provider 返回后必须同时校验 signal、session epoch、provider generation 和 runtime
  lifecycle token。
- client destroy 不等待 `abortKnownUploads()`。

### P1-2 多 tab/window 保留旧 Provider

- 删除页面级 active store/config 真值。
- 两个及以上 Coordinator client 看到相同 baseline/revision/generation。
- 任一 tab activate/clear 后，其他 tab 不能再通过旧 client 访问旧 bucket。

### P2-1 Clear/Reset 失败破坏 multipart

- 按 4.4 调整提交/cleanup 顺序。
- 增加“远端 abort 成功但 IDB 事务失败”的恢复测试；不得断言死 upload 仍可继续。

### P2-2 S3Disk directory marker 删除调用错误

- `deleteDirectoryMarker` 必须调用 directory delete capability，不能转发 ordinary
  object delete。
- 使用 `createDirectory()` 返回的带尾斜杠 path 做回归测试。

### P2-3 Range stream 混合对象版本

- 第一块读取后固定 ETag；后续每一块都传 `ifMatch`。
- 中途覆盖对象时必须以 `storage_conflict` 失败，禁止返回拼接 Blob。

### P2-4 零字节对象无法读取

- 允许写入并读取零字节普通对象。
- 不得向真实 S3 对零字节对象发送不可满足的 range，或必须对 InvalidRange 做经过 HEAD
  验证的零字节收口。
- fake adapter 必须模拟真实 S3 空对象 range 行为，防止测试假绿。

### P2-5 Cursor Map 无界增长

- 每次读写 cursor 前主动清理过期项。
- 同时设置全局与每 Connect session 上限；达到上限时淘汰最旧项或返回稳定错误。
- provider replace、lock、session abort 和 port disconnect 清除对应 cursor。

## 6. 模块边界

建议结构如下，实际文件名可在不改变边界的前提下调整：

```text
packages/plugin-storage/src/coordinator/
  storageRuntime.ts       # worker-safe 状态机；无 React/window/plugin manifest
  storageRpc.ts           # 命令校验、结果和错误映射
  storageScheduler.ts     # mutation/data lane、取消与并发上限
  storageState.ts         # revision/baseline/state event

packages/plugin-storage/src/
  storageServiceProxy.ts  # 页面端 StorageService RPC proxy
  StorageSettings.tsx     # UI only
  manifest.ts             # proxy/resource/settings wiring only
```

`plugin-protocol` 不得 import AWS SDK。AWS SDK 只能存在于 worker-safe Storage provider
实现及真实 Provider smoke 中。

## 7. 必须新增或更新的测试

1. 两个 MessagePort 同时订阅 `storage.state`，baseline 原子且 revision 单调。
2. tab A activate/clear 后 tab B 立即看到新 generation，且旧请求无法成功。
3. 慢 GET/PUT 期间 lock：lock 不等待网络超时，client 被 destroy，迟到结果失败。
4. Storage data lane 慢请求不阻塞 Vault lock/control RPC。
5. activate/clear 的 expected generation 冲突测试。
6. 16 MiB put/get 使用 transferable；发送后 request buffer detached 或由等价 spy 证明
   transfer list 被使用。
7. request cancel、port disconnect、logout 分别只清理正确作用域。
8. Worker restart 后 locked/unconfigured，不恢复 client。
9. clear/reset 事务失败与远端 multipart cleanup 顺序测试。
10. directory marker delete、ETag 分块一致性、零字节对象、cursor 上限回归测试。
11. 非 Storage Connect、Vault、后台任务回归测试。

## 8. 完成定义

- `pnpm typecheck` 通过。
- `plugin-storage`、Coordinator client/worker、Protocol Storage、Vault rotation 测试通过。
- 完整 `pnpm test` 能自行退出并生成汇总；存在开放句柄不算通过。
- `git diff --check` 通过。
- 真实 Provider smoke 仅在有凭据时运行；未运行必须明确记录，不能伪报。
- 页面 bundle/runtime 中不存在 active S3 client 和 active provider 明文凭据。
- 本工单全部 P1/P2 验收有直接回归测试。

## 9. 2026-08-10 实施验收记录

### 9.1 设计与边界结论

- 采用本工单的单 Worker 决策：Storage 是 Coordinator SharedWorker 内的独立逻辑
  runtime，不创建第二个 Worker。这样 Vault lock、session epoch 和 Storage request abort
  由同一个凭据所有者原子推进，避免跨 Worker 再建立密钥传递与一致性协议。
- 页面端 `plugin-storage` manifest 只创建 `StorageServiceProxy`；active S3 client、明文
  provider config、cursor、multipart runtime 和 Provider I/O 均由 Coordinator Worker
  单实例持有。
- Provider 与 Provider 状态通过带单调 revision 的 `storage.state` 向所有 port 发布；跨
  tab/window 同步不再依赖页面级 store 或 BroadcastChannel。
- P1/P2、grant 权威绑定、取消作用域、端口断开、队列公平性、transferable、启动隔离、
  password rotation、迟到结果 fence 和 durable multipart 清理均已有直接回归覆盖。

### 9.2 独立验收结果

- `pnpm typecheck`：通过。
- `pnpm lint:boundaries`：通过。
- `git diff --check`：通过。
- Coordinator worker/client、Storage service/proxy/S3 object store、Protocol Storage 与 App
  Identity 定向套件：7 个文件、124/124 项通过。其中 Worker 39 项、client 13 项、
  Storage service 33 项、proxy 4 项、S3 object store 21 项、Protocol Storage 6 项、App
  Identity 8 项。
- 全库分片复核：第 1、2、4 分片分别通过 350、412、470 项；第 3 分片中本工单涉及的
  Coordinator 39 项与 Storage 33 项均通过。
- 未运行真实 Provider smoke：验收环境未提供 S3 凭据；未将 fake/fixture 结果冒充真实
  Provider 验证。

### 9.3 仓库级全量门禁例外

`pnpm test` 未能自行退出：高 CPU 挂起定位到既有
`packages/runtime/src/pluginManager.test.ts` 的测试顺序。该文件及其
`createPluginHost`/`resourceStore` 实现不在本工单 diff 中，测试也不导入 Storage
manifest/catalog。相同最小命令已在不含本次 S3 改动的干净 HEAD detached worktree 中
复现超时；相关尾部用例单独或小组合运行则通过。

因此该挂起记录为仓库基线 runtime/test-harness 问题，不作为 KMS3-016 Storage 实施的
阻断，也不在本工单内越界修改 runtime 业务代码。仓库仍需另立工单修复该全量测试退出
问题；在此之前不得宣称整个仓库的 `pnpm test` 门禁通过。
