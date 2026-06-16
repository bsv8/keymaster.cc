// packages/plugin-poker/src/pokerSessionKey.ts
// Poker session key 解析辅助：把 `keyspace.active()` + vault 状态机
// 收敛成 PokerSessionKeyState 一份解析结果。
//
// 设计缘由（硬切换 004 + 硬切换 005 收尾）：
//   - 旧 `pokerIdentityBinding.ts` 把"poker identity"做成独立绑定；现
//     在 Poker 身份永远来自 `keyspace.active()`，因此只需要"判断当前
//     active 能不能用作 Poker 身份"这一件事。
//   - 硬切换 005：`allMode` 已被删除——`mode: "all"` 不再是真值。
//     `activePublicKeyHash` 缺失 = 异常态（壳层会拦截到 uninitialized
//     或修复/管理态）；Poker 一律按 `noActiveHash` 处理。
//   - 解析逻辑必须独立可单测（不能直接耦合 vault / keyspace / service
//     内部状态），于是抽到独立模块。
//   - 该函数返回的 state 直接驱动 service 的 fail-closed 行为：
//     ready → 可建立会话；其它所有 kind → 断开、停止重连、不允许 publish。

import type {
  ActiveKeyState,
  KeyIdentity,
  KeyspaceService,
  PokerSessionKeyState,
  VaultService
} from "@keymaster/contracts";

/**
 * 从 `keyspace.active()` 取一把"可作为 Poker 身份的 KeyIdentity"。
 *
 * 行为约定（硬切换 004 + 硬切换 005 收尾）：
 *   - vault 未解锁 → `{ kind: "vaultLocked" }`。
 *   - activePublicKeyHash 缺省 → `{ kind: "noActiveHash" }`。
 *   - single + 有 hash：尝试 `keyspace.getKey(hash)`；
 *       * 未找到 → `{ kind: "missing" }`。
 *       * identityStatus === "ready" → `{ kind: "ready", key }`。
 *       * 其它 identityStatus（uninitialized / failed）→ `{ kind: "notReady", key, reason }`。
 *
 * 该函数**不**做连接判断、不开 storage、不读 settings——只解析身份。
 */
export async function resolvePokerSessionKey(
  vault: Pick<VaultService, "status">,
  keyspace: Pick<KeyspaceService, "active" | "getKey">
): Promise<PokerSessionKeyState> {
  if (vault.status() !== "unlocked") return { kind: "vaultLocked" };
  const active: ActiveKeyState = keyspace.active();
  if (!active.activePublicKeyHash) return { kind: "noActiveHash" };
  const key: KeyIdentity | undefined = await keyspace.getKey(active.activePublicKeyHash);
  if (!key) return { kind: "missing" };
  const status = key.identityStatus ?? "ready";
  if (status === "ready") return { kind: "ready", key };
  const reason = status === "failed" ? key.identityError ?? "failed" : status;
  return { kind: "notReady", key, reason };
}

/**
 * 同步版本：仅依赖 `keyspace.active()` 与 vault.status()，不读 key 元数据。
 * 用于 service 的状态机内"快速重评估"，避免每次都开 async；缺元数据的
 * 情形（missing / notReady 的具体 reason）由 `resolvePokerSessionKey`
 * 异步填充。
 */
export function quickResolvePokerSessionKey(
  vault: Pick<VaultService, "status">,
  keyspace: Pick<KeyspaceService, "active">
): PokerSessionKeyState {
  if (vault.status() !== "unlocked") return { kind: "vaultLocked" };
  const active = keyspace.active();
  if (!active.activePublicKeyHash) return { kind: "noActiveHash" };
  // 同步版本不查 key 元数据：返回 noActiveHash 视作"未知"，由 service
  // 异步解析升级为 missing / notReady / ready。
  return { kind: "noActiveHash" };
}
