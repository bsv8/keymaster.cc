# 004 Coordinator Session State 单事件硬切换施工单

## 0. 结论与约束

本单将 SharedWorker 的 **Vault 会话状态**跨 tab 通知硬切换为：

```text
一次 Session 动作完成原子提交
    -> 一条 session.state.changed 广播
    -> client 原子更新 Session snapshot
    -> 本地派生 Vault facade / Keyspace facade 通知
```

`lock`、`unlock`、`activate-key` 以及会改变 Vault session / active key /
generation 的首次建库、首 key 创建、删除 active key 等路径，**每次动作仅允许
广播一条 `session.state.changed`**。

本单是硬切换：

1. 删除 `vault.lifecycle` 与 `keyspace.active-key` Coordinator topic、event、
   baseline、revision gate 与 Worker publish helper。
2. 不保留旧 topic、adapter、双订阅、feature flag、fallback 或“先发新、再发旧”。
3. 保留 `VaultService.onLifecycleChange()` 与
   `KeyspaceService.onActiveKeyChanged()` 这两个 facade API；它们都由同一条
   `session.state.changed` 在页面本地派生，不再对应跨 tab 的两条消息。
4. `background.snapshot` 与 `asset.data-changed` 保持独立领域事件；本单不把
   它们塞进 Session 状态事件，也不允许它们驱动 Vault/Keyspace 变化。

本单替代并废止
[`2026-07-20/001-coordinator-domain-event-boundary-hard-switch.md`](../2026-07-20/001-coordinator-domain-event-boundary-hard-switch.md)
中关于 `vault.lifecycle` 与 `keyspace.active-key` 分离 transport topic、独立
revision 和双 topic baseline 的规定。该旧单有关 Background 与 Asset 数据领域隔离的
规定继续有效。

---

## 1. 问题与目标

当前 `activate-key` 在 Worker 内依次发送 `keyspace.active-key.changed` 与
`vault.lifecycle.changed`，但二者都携带新的 `sessionEpoch`。client 为避免旧 epoch
覆盖新状态，会拒绝尚未由 Vault topic 确认的新 epoch 的 Keyspace event；因此第一条消息
可能被丢弃。Worker 已持久化新 key，而 tab 仍显示旧 key，刷新后才通过 baseline 收敛。

这不是应由“调整发送顺序”解决的问题：两个消息本身表达同一次原子 Session 状态变更。
在 transport 上拆成两条消息必然引入中间态和排序规则。

目标：

1. Worker 的 Session 真值只经一个可订阅事件暴露。
2. 每个 tab 只按 `sessionRevision` 应用完整 Session snapshot；不存在“先 Vault、后
   Keyspace”或反向的可观察中间态。
3. 刷新后 Worker 为 `locked` 时，App 必须渲染 `LockedShell`；不允许 Vault facade 和
   Keyspace facade 分别保留 unlocked / no-active-key 的错位状态。
4. 切换 key 的同一 tab 和所有其它已连接 tab，顶栏、active-key Resource Store、余额和
   key-scoped 页面无需刷新即切到新 key。
5. Background / Asset 事件仍严格领域隔离，不能造成 Vault 状态回调、key 切换或连接重绑。

---

## 2. 唯一跨 tab 合同

### 2.1 Topic 与事件

`packages/contracts/src/sessionCoordinator.ts` 中的 Coordinator session topic 固定为：

```ts
export type CoordinatorTopic =
  | "session.state"
  | "background.snapshot"
  | "asset.data-changed";

export interface SessionStateEvent {
  topic: "session.state";
  type: "session.state.changed";
  sessionRevision: number;
  sessionEpoch: SessionEpoch;
  cause:
    | "bootstrap"
    | "unlock"
    | "lock"
    | "activate-key"
    | "create-vault"
    | "create-initial-key"
    | "import-initial-key"
    | "delete-active-key"
    | "recover-empty-vault";
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex: string | null;
  keyspaceGeneration: number;
}
```

字段约束：

- `sessionRevision` 是唯一 Session topic 的严格递增版本；不按不同 epoch 重置。
- `sessionEpoch` 仍是 crypto / 异步命令栅栏；每次 lock、unlock、active key 切换或
  Worker 重建按既有安全语义更新。
- `activePublicKeyHex` 是公开标识；locked、uninitialized、fatal 时必须为 `null`。
- payload 禁止包含私钥、密码、`CryptoKey`、签名原料、完整资产数据、未脱敏异常对象。
- `cause` 只作诊断与测试断言；消费者不得以 cause 猜测或绕过 snapshot 字段。

`CoordinatorTopicEvent` 与 `CoordinatorTopicBaseline.snapshot` 只用
`SessionStateEvent | BackgroundSnapshotEvent | AssetDataChangedEvent` 联合。

### 2.2 原子 baseline

`subscribe` 的 baseline 以 `session.state` 为唯一 Session 基线：

```text
Worker 注册 port 的 topics
  -> 在同一 Worker turn 取 sessionRevision + 完整 Session snapshot
  -> 返回 baseline
  -> 之后该 port 只接收 revision 更大的 session.state event
```

不得再为 Vault 和 Keyspace 分别取 baseline。`hello` 仍可返回
`CoordinatorBootstrapSnapshot` 供启动/诊断读取，但它不是业务订阅源。

### 2.3 Worker publish 规则

新增唯一 helper：

```ts
publishSessionState(cause: SessionStateEvent["cause"]): void
```

它只在以下顺序全部完成后调用：

1. 更新内存中的 `vaultStatus`、active public key、私钥会话和 generation；
2. 完成必需的持久化（包括 coordinator meta）；
3. 撤销旧 key crypto、取消旧 key task 等安全边界动作；
4. 递增 `sessionEpoch` / `sessionRevision`；
5. 构造并广播完整 event。

一条 Worker command 对同一次 Session 状态提交最多调用一次该 helper。
任何失败在提交前返回 error；不得发半状态 event。提交后发生的非 Session 任务进度只能走
`background.snapshot`。

---

## 3. Client 与 facade 迁移

### 3.1 Coordinator client

`apps/web/src/keymasterSessionCoordinatorClient.ts` 必须：

1. 启动订阅列表改为 `session.state`、`background.snapshot`、
   `asset.data-changed`。
2. 删除 `vaultLifecycleRevisionCache`、`activeKeyRevisionCache`、对应
   `topicEpochs` 特判，以及“仅 Vault event 可推进新 epoch”的逻辑。
3. 为 `session.state` 单独维护 `sessionRevisionCache`；仅接受比当前 revision 更大的
   event。相同/倒退 revision 写脱敏诊断后丢弃。
4. 应用 `session.state` 时在一次同步更新中写完整
   `bootstrapSnapshotCache`：`sessionEpoch`、`vaultStatus`、
   `activePublicKeyHex`、`keyspaceGeneration`；然后才通知 session topic listener。
5. Worker 重启、transport 失败或非法 Session payload 时清空 cache 到 `booting`；不得
   保留旧 unlocked snapshot。重连后以新的 `session.state` baseline 收敛。

### 3.2 页面侧的单一 Session mirror

`packages/plugin-vault` 新增仅供 facade 使用的 `SessionStateMirror`。它是页面内
Session snapshot 的唯一读模型：

1. 它是该 tab 中 `session.state` 的唯一 `subscribeTopic` 调用者；
2. 收到 baseline / event 后，先替换自己的完整 immutable snapshot；
3. 再通知 Vault / Keyspace facade 的本地投影监听器；
4. 任意 facade 的同步 read API 必须从 mirror 的当前 snapshot 派生，不得从另一个
   facade 的异步通知时机推断状态。

Vault manifest 创建一个 mirror，并将同一实例注入 `createVaultServiceCoordinator` 与
`createKeyspaceServiceCoordinator`。这样即便 Vault facade 的本地 listener 先执行，任何
listener 同步读取 `keyspace.active()` 时看到的也是 mirror 已提交的新 key，而不是旧 cache。

### 3.3 Vault facade

`packages/plugin-vault/src/vaultServiceCoordinator.ts` 只订阅 `session.state`。
每条 event 用完整字段构造 `VaultLifecycleSnapshot`：

```ts
{
  status: mapVaultStatus(event.vaultStatus),
  activePublicKeyHex: event.vaultStatus === "unlocked"
    ? event.activePublicKeyHex ?? undefined
    : undefined,
  sessionEpoch: event.sessionEpoch,
  vaultLifecycleRevision: event.sessionRevision
}
```

`onLifecycleChange`、`status()`、`getLifecycleSnapshot()` 的现有 API 名与调用者保持不变。
它们不再知道 transport topic 名称。

### 3.4 Keyspace facade

`packages/plugin-vault/src/keyspaceServiceCoordinator.ts` 同样只订阅 `session.state`。

- state 由 `activePublicKeyHex` 和 `keyspaceGeneration` 一次更新；
- `onActiveKeyChanged` 只在 key 或 generation 真的变化时通知；
- locked/uninitialized event 必须将 active key 清为 `undefined`，从而让
  Resource Store 取消 active-key 请求；
- 不再 import `KeyspaceActiveKeyEvent`，不再订阅 `keyspace.active-key`。

在同一个 mirror event turn 中，先提交 mirror 的完整 cache，再向外发 facade 监听器：

```text
client 应用完整 session snapshot
  -> SessionStateMirror 原子替换 snapshot
  -> Vault facade / Keyspace facade 从 mirror 读取新 snapshot
  -> 派发 Vault / Keyspace 的本地监听器
```

facade 本地回调的相对顺序不得成为业务正确性前提；每个 consumer 必须读取当前 facade
snapshot，而不是组合两次回调参数。

---

## 4. 调用者与行为边界

以下消费者不应改为直接订阅 `session-coordinator.client`：

- App / `useRuntimeStatus` 继续使用 `VaultService.onLifecycleChange()`；
- Resource Store、资产、余额、联系人、AppMsg、Broadcast、Transfer、Home 等继续使用
  `KeyspaceService.onActiveKeyChanged()`；
- Broadcast/AppMsg 连接生命周期可以同时观察 Vault 与 Keyspace facade，但必须按完整
  `(sessionEpoch, activePublicKeyHex, keyspaceGeneration)` 去重；不能依赖两条 transport
  message 的顺序；
- `background.snapshot` 只更新 Background facade / UI；
- `asset.data-changed` 只交给 `AssetDataNotifier` / Resource Store。

这保留了业务层的窄 API 和隔离边界；删除的是 Coordinator transport 的双事件，不是把
所有业务订阅合并为宽泛的全局 callback。

---

## 5. 文件级施工清单

| 文件 | 必做修改 |
|---|---|
| `packages/contracts/src/sessionCoordinator.ts` | 用 `session.state` / `SessionStateEvent` 替换两个旧 session topic、event、revision 字段和 baseline union；更新 `CoordinatorTopic` 与注释。 |
| `packages/contracts/src/index.ts` | 移除旧 event type 出口，导出 `SessionStateEvent`。 |
| `apps/web/src/keymasterSessionCoordinator.worker.ts` | 删除 `publishVaultLifecycleEvent`、`publishActiveKeyEvent`、两个 revision 计数器；新增 `sessionRevision` 与 `publishSessionState`。迁移 bootstrap、unlock、lock、activate-key、首 key 建立、删除 / 恢复路径，逐路径保证一次提交只发一次 session event。 |
| `apps/web/src/keymasterSessionCoordinatorClient.ts` | 用一个 Session revision gate 和一份原子 cache 写入替换双 topic gate；更新 reconnect/baseline/诊断。 |
| `packages/plugin-vault/src/sessionStateMirror.ts`（新增） | 唯一订阅 `session.state`，保存完整 immutable snapshot，并在替换 snapshot 后向 Vault / Keyspace facade 派发本地投影通知。 |
| `packages/plugin-vault/src/vaultServiceCoordinator.ts` | 改由 `SessionStateMirror` 读取完整 snapshot；由它生成 lifecycle snapshot；新增启动 locked baseline 与 session event 回归测试。 |
| `packages/plugin-vault/src/keyspaceServiceCoordinator.ts` | 改由同一 `SessionStateMirror` 读取 active key/generation；删除旧 event import 与独立 transport 订阅。 |
| `packages/plugin-vault/src/manifest.ts` | 创建一个 SessionStateMirror，并将同一实例注入 VaultService 与 KeyspaceService facade；禁止它们各自再订阅 transport。 |
| `apps/web/src/bootstrapPlugins.ts` | client 初始订阅名改为新 topic；Asset bridge 保持不变。 |
| `packages/plugin-vault/src/manifest.ts`、`KeySwitchWidget.tsx`、`VaultSettingsPage.tsx` | 不直接依赖 transport topic；只验证 facade 回调已在无需刷新时驱动 resource invalidation 和顶栏更新。 |
| `packages/plugin-appmsg/src/reconnectCoordinator.ts`、`packages/plugin-broadcast/src/*` | 保留 facade 层订阅；为同一 Session identity 的 Vault / Keyspace 本地连续通知增加完整 identity 去重，确保至多一次断开/重绑。 |
| `packages/runtime/src/resources/resourceStore.ts` | 验证 active-key 变为 undefined 时 abort/blocked，切到新 key 时旧请求不能写入新 key；实现一般无需订阅 Coordinator。 |
| `施工单/2026-07-20/001-coordinator-domain-event-boundary-hard-switch.md` | 在文件开头加入“被本单替代”的醒目说明；删除或标注与本单冲突的 Vault/Keyspace transport 章节。 |

---

## 6. 必须删除的旧实现

完成后，生产代码中不得再出现：

```text
"vault.lifecycle"
"keyspace.active-key"
VaultLifecycleEvent
KeyspaceActiveKeyEvent
activeKeyRevision
publishVaultLifecycleEvent
publishActiveKeyEvent
```

`VaultLifecycleSnapshot.vaultLifecycleRevision` 是既有 facade API，必须保留；其值映射
为 `SessionStateEvent.sessionRevision`。本节要求删除的是旧 transport 的独立
`vaultLifecycleRevision` 计数器、gate 和 event 字段。

历史施工单与迁移说明中的文字不受此 grep 约束；生产 TypeScript、测试 fixture、协议
contract、日志 event 和文档真值都必须迁移。不得仅调整 `activate-key` 的发送顺序作为
“修复”。

---

## 7. 测试矩阵与验收

### 7.1 Worker / transport

1. `unlock`、`lock`、`activate-key` 各只向订阅 `session.state` 的 port 发送一条
   `session.state.changed`，且其 `sessionRevision` 递增。
2. 每条事件的字段是提交后的完整 snapshot；locked 时没有 active public key。
3. 首次订阅的 baseline 与随后事件严格连续；订阅和状态变更并发时不丢更新。
4. 旧 revision、非法 payload、Worker 重启前的 event 不得覆盖新 snapshot。
5. `background.snapshot` 与 `asset.data-changed` 不触发 Session listener；反之亦然。

### 7.2 页面 / facade

1. Worker baseline 为 `locked` 时，刷新页面最终渲染 `LockedShell`，不得渲染
   `UnlockedShell` 或保留旧 key 页面。
2. `activate-key` 成功后，不刷新页面：顶栏显示新 key、Keyspace active key 变更一次、
   active-key Resource Store abort 旧请求并读取新 key。
3. 余额/资产页面在切 key 后只能展示新 key namespace 的数据；旧请求晚到不得写入。
4. 多 tab 同时打开时，执行切 key 的 tab 与旁观 tab 均收敛到相同 key/generation。
5. lock 后所有 tab 回到锁屏；AppMsg/Broadcast 结构性断开一次；不保留 owner。
6. 同一 `session.state` 的重复投递不产生二次 bind、二次 close 或二次资源加载。

### 7.3 完整检查

```bash
pnpm exec tsc -b --pretty false
pnpm exec vitest run apps/web/src/keymasterSessionCoordinator.worker.test.ts \
  apps/web/src/keymasterSessionCoordinatorClient.test.ts \
  packages/plugin-vault/src/vaultServiceCoordinator.test.ts \
  packages/plugin-vault/src/KeySwitchWidget.test.tsx
pnpm test
pnpm lint:boundaries
pnpm lint:react-boundaries
```

验收通过的唯一标准是：切 key 与锁定/解锁均不存在刷新前后不一致；Coordinator 对每次
Session 动作只发送一条权威 Session 状态消息；仓库中不存在旧 transport topic 的生产
兼容路径。
