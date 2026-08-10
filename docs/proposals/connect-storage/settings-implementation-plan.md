# Keymaster S3 Settings 专项施工单

## 1. 目标与完成结果

在 Keymaster 现有 `Settings -> System` 中加入 S3 Storage 配置区，让用户能够配置、
验证、加密保存并激活一套 AWS S3、Cloudflare R2 或通用 S3-compatible 连接。

本施工单完成后，已解锁的 Keymaster 在配置成功时必须达到：

```text
Settings candidate
  -> normalize
  -> read-only provider probe
  -> Vault seal
  -> IndexedDB atomic replace
  -> active S3Client
  -> storage.service ready
  -> Connect storage.* operational
```

本单属于总施工单 `KMS3-012`，依赖 `KMS3-004/005/007/008`。它是实现施工说明，
不是当前功能已上线的声明。

## 2. 修改范围

预计修改：

```text
packages/contracts/src/storage.ts
packages/plugin-storage/src/StorageSettings.tsx
packages/plugin-storage/src/storageService.ts
packages/plugin-storage/src/providerConfig.ts
packages/plugin-storage/src/storageDb.ts
packages/plugin-storage/src/manifest.ts
packages/plugin-storage/src/styles.css
packages/plugin-storage/src/locales/en.ts
packages/plugin-storage/src/locales/zh.ts
packages/plugin-storage/src/*.test.ts(x)
apps/web/src/*                                  # 只做插件 assembly；不硬编码表单
```

不得修改 `plugin-settings` 来硬编码 Storage 字段；设置宿主只负责渲染 registry item。

## 3. SETTINGS-001：服务契约与状态机

### 工作

- 定义 `StorageProviderConfigDraft` 和显式 `credentials: retain | replace`。
- 定义只包含脱敏字段的 `StorageProviderSummary`。
- 定义 `StorageServiceStatus`：`unconfigured/locked/checking/ready/reconfiguring/degraded`。
- 服务暴露 `getProviderSummary`、`probeProvider`、`activateProvider`、
  `clearProviderConfig`、`status`、`subscribe`。
- `ready` 作为 Connect Storage 可执行的唯一 Provider 状态。
- 所有 service result/error 都禁止携带完整 credential、原始 S3 body 和物理 Key。

### 验收

- contracts 和 plugin-storage typecheck。
- 初次配置使用 `retain` 被拒绝。
- Provider 改变却使用 `retain` 被拒绝。
- UI 无法通过 service contract 获取明文配置。

## 4. SETTINGS-002：Provider 动态表单

### 字段矩阵

| 字段 | AWS | R2 | Compatible |
|---|---:|---:|---:|
| Bucket | 必填 | 必填 | 必填 |
| Root Prefix | 可选 | 可选 | 可选 |
| Region | 必填 | 固定 `auto`，不显示输入 | 必填 |
| Account ID | - | 必填 | - |
| Endpoint Variant | - | `default/eu/fedramp` | - |
| HTTPS Endpoint | - | 由 Keymaster 派生 | 必填 |
| Force Path Style | - | - | 默认关闭 |
| Access Key ID | 必填/可保留 | 必填/可保留 | 必填/可保留 |
| Secret Access Key | 必填/可保留 | 必填/可保留 | 必填/可保留 |

### 工作

- Provider 切换时清除不适用字段，并强制进入“替换凭据”。
- Secret input 使用 password 类型，禁止预填、autocomplete 回显和复制 summary 值。
- 编辑已有配置默认显示 `credentials configured`，用户主动选择后才显示替换输入。
- Prefix 在 blur/test/save 时显示规范化预览，不在用户输入过程中偷偷改值。
- Compatible endpoint 必须是绝对 HTTPS URL，不含 username/password/hash；生产构建
  不开放 localhost HTTP 例外。
- 表单 dirty 后清除上次 Test 成功状态。

### 验收

- 三种 Provider 的字段显示和提交 shape 有组件测试。
- Secret 不出现在 snapshot、DOM value、错误文本或 logger mock。
- 非法 endpoint、空 Bucket/Region、危险 Prefix 无法 Test 或 Save。

## 5. SETTINGS-003：接入 System Settings Registry

### 工作

- `plugin-storage` manifest attach 时获取 `system-settings.registry`。
- 注册 item id `storage.system-settings.provider`、group id `storage`。
- `visibleWhen({ unlocked })` 只允许 unlocked 时挂载。
- 使用 runtime ownership 自动回收，不手写重复设置路由。
- 插件未启用时不显示设置项，Protocol 的非 Storage 能力保持正常。

### 验收

- `/settings/system` 中出现唯一的 `S3 Storage` group。
- lock、plugin teardown、plugin disable 后组件和订阅均释放。
- attach/detach 重复执行不产生重复 registry id。

## 6. SETTINGS-004：候选配置 Probe

### 工作

- UI 把完整 draft 交给 `storage.service.probeProvider`。
- retain 模式只在 service 内解封旧 Secret并合并，UI 永远拿不到旧值。
- 创建临时 S3Client，执行
  `ListObjectsV2(Prefix=normalizedPrefix, MaxKeys=1)`，finally 中 destroy。
- AbortSignal 绑定组件卸载、再次测试和 Vault lock。
- 将 DNS/TLS/CORS/403/404/invalid credential 映射为脱敏诊断。
- 成功结果绑定 normalized draft fingerprint；修改任一字段立即失效。

### 验收

- Probe 不发 Put/Delete/Multipart 命令。
- 双击 Test 只保留最后一次结果，旧请求被取消。
- locked/teardown 时临时 client 被销毁。
- 错误 UI 能区分配置校验、认证、CORS 和网络问题，但不泄漏响应正文。

## 7. SETTINGS-005：Save and Activate

### 原子激活流程

1. service 取得单实例 reconfiguration mutex，状态变为 `checking`。
2. normalize draft，在内部完成 retain/replace credential 合并。
3. 创建候选 client 并执行只读 Probe。
4. Probe 成功后 seal 完整 normalized config。
5. 以单个 IDB transaction 替换 `providerConfig["active"]`。
6. 状态变为 `reconfiguring`，provider generation 加一。
7. 取消旧 generation 的请求；cursor、multipart context 全部失效。
8. 候选 client 成为 active，旧 client destroy，状态变为 `ready`。

### 失败和并发

- normalize/open/probe/seal/IDB commit 失败：destroy 候选 client，旧配置保持 active。
- 同时 Save/Test/Clear 必须序列化；UI disabled 不能代替 service mutex。
- 存储 App 请求在 `checking/reconfiguring` 阶段返回稳定 `storage_unavailable`。
- 配置切换提示会中止正在进行的传输；旧 multipart best-effort abort。
- 页面离开不能取消已经提交到 service 的 IDB transaction，但可以停止 UI state update。

### 验收

- 成功保存后 reload/unlock 能解封配置、重建 client 并恢复 `ready`。
- 候选 Probe 失败、Vault seal 失败、IDB 失败分别验证旧 client 仍可 Probe。
- 两个并发 Save 只有按 mutex 顺序完成的最后一次成为 active，不发生混合字段。
- active summary 的 `updatedAt/generation/fingerprint` 与实际 client 一致。

## 8. SETTINGS-006：Clear and Disable

### 工作

- 显示二次确认，明确所有 App Storage 会立即不可用且在途传输会中止。
- service 串行取得 reconfiguration mutex。
- best-effort abort 已知 multipart，取消旧 generation 请求。
- IDB transaction 删除 active config；成功后再清 summary/client/context。
- 状态落到 `unconfigured`，Protocol 返回 `storage_not_configured`。
- 删除失败则保持原 active config 和 client，并显示失败。

### 验收

- 未确认不会触发 service call。
- Clear 成功后 reload 仍为 `unconfigured`，DB 无 active sealed record。
- Clear 失败不会出现 UI/运行时状态分裂。
- 任何 App 都不能在 Clear 后继续使用旧 cursor/uploadId。

## 9. SETTINGS-007：状态、诊断与 CORS 指引

### 工作

- 展示 Provider 类型、Bucket hint、Prefix、masked Access Key、最后 Probe 时间和状态。
- `degraded` 提供重新测试/重新保存路径，不向 UI 交付明文配置。
- 按当前 `window.location.origin` 生成可复制 CORS 示例。
- 文案覆盖 GET/HEAD/PUT/DELETE/POST、Range、If-Match、If-None-Match、`x-amz-*`
  以及 ETag/Content-Range expose。
- 明确 Probe 只证明 List 权限和连通性，不证明 PUT/Multipart 权限。
- 增加中英文 i18n；禁止直接在组件中散落错误码原文。

### 验收

- 状态变化通过 subscribe 驱动，不轮询 DB。
- CORS 模板中的 origin 是当前 Keymaster origin，不使用 App origin。
- 截图/snapshot 不含 credential 或完整 endpoint query。

## 10. SETTINGS-008：端到端测试与完成定义

### 自动化场景

- 三 Provider 新建配置：Test -> Save -> `ready`。
- 编辑 Bucket/Prefix并保留 credential。
- 替换 credential。
- 切换 Provider并验证强制替换 credential。
- Probe 失败、seal 失败、IDB 失败，旧配置仍可用。
- reload、Vault lock/unlock、plugin disable/enable。
- Save/Clear 与 Connect `storage.list` 并发。
- Clear 后 Storage API 返回 `storage_not_configured`。
- secret/log/DOM/Protocol result 扫描。

### 真实 Provider Smoke

与 `KMS3-014` 组合执行 AWS、R2、S3-compatible opt-in smoke。设置页只负责配置和
Probe；CRUD/multipart 权限由 Storage Service smoke 验证。真实凭据只从 CI secret
注入，测试输出必须脱敏。

### 完成定义

- 用户可从 `/settings/system` 完成配置，无需改代码或环境变量。
- 保存成功后 `storage.service` 为 `ready`，Connect `storage.*` 能使用该 active client。
- reload/unlock 后自动恢复，不要求重新输入 Secret。
- 失败配置不会破坏上一套可用配置。
- 清除后凭据密文、client 和派生上下文均不可继续使用。
- 全仓 typecheck、boundary lint、相关 unit/integration 通过。

## 11. 不在本专项施工单

- 多 Provider Profile或多 Bucket切换。
- 自动修改 Bucket CORS/IAM policy。
- Presigned URL。
- 把 S3 credential 交给第三方 App。
- S3Disk 迁移。
- 对 App 对象做透明内容加密。
