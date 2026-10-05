# Vault 只读钱包状态 API

`VAULT_WALLET_STATE_CAPABILITY` 是 `vault.wallet-state@1` local 能力，契约位于 `packages/contracts/src/vault.ts`。Window 与 Worker 的 Vault 根单元提供它；未初始化和锁定时也可读取，不依赖解锁后的业务单元。

## 声明和绑定

消费者在所属单元声明能力及来源，然后用真实 setup 的 consumer 和精确 Scope 绑定：

```ts
const state = ctx.capability(VAULT_WALLET_STATE_CAPABILITY)
  .bind(ctx.consumer, ctx.scope);
const snapshot = state.snapshot();
const off = state.subscribe(next => { /* 接收当前基线和随后提交的变化 */ });
```

绑定核对所属 realm 的真实签发身份、Scope、声明和当前提供实例。Window 使用 Runtime 适配器登记表；Worker 由可信装配注入实际 setup 的 consumer/Scope 登记表验证器，不把 Worker 身份交给 Window 的登记表判定。不能用自报 pluginId、复制的 consumer 或全局 Host 替代。视图只有 `snapshot`、`subscribe` 两个方法；没有密码学、管理、存储或内部 Coordinator 引用。UI 在所属贡献 Provider 中用 `useWalletState()` 取得同一实例视图；日常展示由本实例 Resource Store 注册状态投影，组件通过资源 reader 读取。联系人编辑器与 App 授权表单的安全订阅只负责在会话失效时撤回草稿或密码。

## 快照

| 字段 | 含义 |
| --- | --- |
| status | booting、uninitialized、locked、unlocked |
| activePublicKeyHex | 解锁时的唯一钱包公钥，其余状态省略 |
| activeKeyIdentity | 同一提交点的公开标签、支持能力和创建时间；锁定时省略 |
| sessionEpoch | 会话世代，同一 Key 再次解锁也变化 |
| runGeneration | Worker 运行世代 |
| walletGeneration | 钱包身份世代，重置后变化 |
| vaultLifecycleRevision | 当前运行世代中的提交修订号 |

快照及嵌套元数据被冻结；修改不能影响权威。Worker 从已有 Vault/Coordinator 已提交状态投影；Window 从唯一 SessionStateMirror 投影。状态服务不产生新 epoch 或独立身份计数，也不推进钱包状态。相同运行世代拒绝旧修订；新运行世代允许修订从零开始，并拒绝已退役运行的迟到事件。

## 订阅与撤销

`subscribe` 先注册，再同步交付当前基线，随后交付有效变化；相同快照去重，世代变化即使公钥相同仍通知。提交先于通知，重入提交按顺序交付；观察者抛错不会阻断其他观察者。Window 与 Worker 复用提交序列状态源：通知中新增观察者已收到当前基线，不再收到当前循环的同一提交或更旧提交。返回的退订函数幂等。

业务清理不再读取被撤销的状态视图；等待任务结算期间的后台展示快照不调用锁定身份，并将已撤销 Scope 的身份投影为空，业务操作仍严格拒绝。

提供或消费实例撤销时清理订阅；旧视图读取和订阅拒绝，回调不再交付。实例重建必须重新解析和绑定；旧引用不会自动连接新实例。退订在撤销后仍可调用。

## 异步结果和操作授权

`requireUnlockedWalletIdentity(snapshot)` 只做已解锁状态与公开身份检查，不签发授权。跨 await 的业务工作捕获原快照，在提交缓存、存储、历史或 UI 结果前用 `sameWalletSession(original, state.snapshot())` 复核 status、公钥、sessionEpoch、runGeneration、walletGeneration。只比较公钥不能识别同一 Key 的新会话。快照修订变化不必让不涉及授权的展示全量重载。

签名、交易和最终 I/O 仍由实际操作入口复核授权和世代。Vault 密码学子句柄绑定创建会话及提供方 Scope，每次调用和结果返回再次检查；新实例或再次解锁不会复活旧句柄。持久 App 会话 Owner 继续按 Connect 协议管理，不用当前钱包公钥覆盖。

## 已删除接口

不提供 `keyspace.service`、`KEYSPACE_SERVICE_CAPABILITY`、`KeyspaceService`、`ActiveKeyState`、`active()`、`requireActiveKey()`、`onActiveKeyChanged()` 或 `activeKey.changed` 事件。公开 VaultService 的 `getLifecycleSnapshot/onLifecycleChange` 以及独立 status-reader 能力也已删除，只读消费者统一声明上述能力。`KeyIdentity` 保留并移到 Vault 契约；Vault 私有 UI 使用同一状态源的私有端口。

实施与分层验收见[单 Key 钱包状态收口施工单](proposals/webloom-0.6/单Key钱包状态收口施工单.md)。
