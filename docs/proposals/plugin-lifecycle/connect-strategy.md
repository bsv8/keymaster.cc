# Connect 生命周期策略记录

日期：2026-09-06。状态：施工默认值已固定；主页面 AppView 交接、服务桥授权和独立 Dedicated Worker 能力已有本地浏览器证据，普通 popup、外部部署和完整崩溃恢复验收未完成。

## 决策

默认采用：**撤销借用主会话的 Connect 授权，保留第三方窗口但让操作进入需重新授权状态。**

这里的“借用”是 Connect 请求通过主 Coordinator 的受控能力访问主 owner；不是把主私钥复制给页面或第三方 Worker。主会话锁屏、切 Key、owner 删除、授权修订变化时，旧 Connect session 和对应授权必须失效；重新解锁不会自动重放签名、付款或其他外部副作用。

本批次不默认启用“独立 Connect Worker 持有一份私钥”的方案。若产品以后确实需要锁屏后仍独立签名，必须增加独立认证、独立 owner / 私钥持有边界、授权有效期和删除撤权，并单独修改设计第 8 节和 KMP-008 验收，不能把现有 AppView 路径直接解释成独立会话。

## 代码入口追踪

| 入口 | 实际观察 | 结论 |
| --- | --- | --- |
| `packages/plugin-vault/src/sessionCryptoClient.ts` | `mode: "appview"` 可以创建 `sessionCryptoWorker.ts`，该路径持有私钥字节状态；应用 Worker 工厂已有 Dedicated Worker 浏览器回归。 | 是可用能力路径，但不能据此认定为当前所有 Connect 请求的默认持钥路径。 |
| `packages/plugin-vault/src/sessionCryptoWorker.ts` | 专用 Worker 的密码学执行与消息处理。 | 需独立验证启动、撤权、崩溃和 owner 绑定。 |
| `packages/plugin-vault/src/vaultServiceCoordinator.ts` | 当前 manifest 使用 `createVaultServiceCoordinator`；其 `createAppViewSession()` 返回 Coordinator 密码学代理，并有 session 撤销表。 | 当前主生产行为更接近借用主 Coordinator 的受控授权。 |
| `packages/plugin-protocol/src/protocolService.ts` | 创建和执行 Connect 请求时绑定 `connectSessionId`、来源、owner 公钥，并在执行阶段重新读取 session / key；AppView 预开 Session Window 后再导航。 | 保留为可信 Connect 网关；真实 `/apps → Session Window → 外部 AppView → connect.launch` 已有 Chromium 生产构建证据，不能由内部插件 `ctx.get` 绕过。 |
| `packages/plugin-protocol/src/sessionWindowBootstrap.ts` | AppView 启动令牌和 `sessionWindowOrigin` 交接；启动载荷校验 session 与 owner 公钥一致。 | 是窗口启动交接，不等同于独立私钥运行环境。 |
| `packages/platform-storage/src/coordinator/storageBindingAuthority.ts` | Owner / platform 存储 grant（授权句柄）由 Coordinator 发放并绑定端口、桶、owner 和会话；服务端持有不透明 `grantId`，最终 I/O 重新校验世代。 | 继续作为最终存储授权入口；授权校验未进入物理 I/O 时只重绑一次，未知结果不重放。 |

## 事件处理规则

| 事件 | 强制动作 |
| --- | --- |
| 主会话 A 切换到 B | 撤销绑定 A 的 Connect 授权、存储 / MSFile grant 和请求；不把 session owner 改成 B。 |
| 主会话锁屏 | 先拒绝旧 session 的新敏感调用，再取消订阅和请求；窗口保留安全占位。 |
| Connect 窗口关闭或退出 | 只撤销该 `connectSessionId`；不能锁定主会话或其他 App。 |
| 协议 / Provider 禁用 | 依赖该服务的请求进入不可用；不影响无关 Connect session。 |
| Worker / MessagePort 断线 | 旧 grant 和旧代理 fail closed；重连必须重新握手、重新核验来源 / owner / 授权。 |
| 外部操作结果未知 | 复用现有领域仓库查询和恢复记录；不因本地 Abort 自动再次付款或广播。 |

## 当前限制

- 当前主页面 bootstrap 已把统一 `RemoteServiceBridge` 注入真实 Coordinator Provider 目录；Node / Chromium 已验证服务握手、server grant、旧代理撤销和最终存储 / crypto 边界。这仍不是“所有领域 Connect 已经迁移完成”的声明。
- `sessionCryptoWorker` 路径和 Coordinator facade 路径并存，必须以生产入口的浏览器测试决定后续删留，不能按名称删除。
- 定时器、监听器和页面临时资源不建立持久清理队列；它们由作用域重建和撤权处理。上传、远端订阅、未知支付结果使用 protocol / storage / 资产领域仓库恢复依据。

仍未解除的生产条件：普通 popup、真实外部部署 origin、旧 Worker 崩溃时活动 final-I/O lease 的人工恢复 / 运维协议，以及目标供应商 smoke。Coordinator 入口审计台账已建立（见 [不可逆 I/O 审计](./irreversible-io-audit.md)），但它不替代上传、订阅、广播 / 支付等未知结果的外部故障演练。冷切换也不能自动隔离完全不认识接管协议的旧 Worker。
