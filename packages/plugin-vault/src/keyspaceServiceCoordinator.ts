// packages/plugin-vault/src/keyspaceServiceCoordinator.ts
// 页面侧 Keyspace facade —— 当前唯一 Key 的只读投影。
//
// 单 Key 本地存储（docs/存储.md）之后，keyspace 不再是 Key 容器：
//   - 没有 listKeys / getKey / setActive / deleteKey：系统里只有一把 Key，
//     不存在列举、切换或删除第二把 Key 的入口。
//   - 替换身份的唯一路径是 vault.resetWallet 之后的重新创建或导入；那不是
//     keyspace 的职责，也不允许沿用旧业务数据。
//   - 业务插件的持久化通过统一存储接口（ctx.storage）进入已绑定模块目录；
//     keyspace 不再提供任何存储入口或 background 取消。
//   - 业务对象里的 ownerPublicKeyHex、收款身份等字段仍然存在，它们是证据与
//     身份核对字段，不是多 Key 目录前缀。
//
// 因此这个 facade 是纯函数式的：它不发 RPC、不排任务、不持有 timer，所有
// 状态都从已提交的 SessionStateMirror 投影而来。

import type { KeyspaceService } from "@keymaster/contracts";
import type { SessionStateMirror, SessionStateSnapshot } from "./sessionStateMirror.js";

export type KeyspaceCoordinatorHandle = KeyspaceService;

/** 锁定/未初始化时 requireActiveKey 使用的统一错误码。 */
const ACTIVE_KEY_UNAVAILABLE = "Active key is unavailable";

export function createKeyspaceServiceCoordinator(mirror: SessionStateMirror): KeyspaceCoordinatorHandle {
  const handlers = new Set<(state: ReturnType<KeyspaceService["active"]>) => void>();
  let projection: ReturnType<KeyspaceService["active"]> = mirror.getSnapshot().activePublicKeyHex
    ? { activePublicKeyHex: mirror.getSnapshot().activePublicKeyHex }
    : {};
  let last: Readonly<SessionStateSnapshot> = mirror.getSnapshot();

  const project = (snapshot: Readonly<SessionStateSnapshot>): ReturnType<KeyspaceService["active"]> =>
    // 公钥只在 unlocked 时可见；锁定过渡态不继续对外投影身份。
    snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex
      ? { activePublicKeyHex: snapshot.activePublicKeyHex }
      : {};

  mirror.subscribe((snapshot) => {
    const next = project(snapshot);
    if (next.activePublicKeyHex === projection.activePublicKeyHex) return;
    projection = next;
    for (const handler of handlers) {
      try { handler(next); } catch { /* noop */ }
    }
  });

  const current = (): ReturnType<KeyspaceService["active"]> => {
    // 订阅回调可能在 handler 抛错时中断；这里每次读现值而不是缓存。
    last = mirror.getSnapshot();
    const next = project(last);
    if (next.activePublicKeyHex !== projection.activePublicKeyHex) projection = next;
    return projection;
  };

  const requireActiveKey = () => {
    const snapshot = mirror.getSnapshot();
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) throw new Error(ACTIVE_KEY_UNAVAILABLE);
    // 身份标签与创建时间由 vault.getCurrentKey() 提供；keyspace 只投影
    // 公钥身份，不读取也不缓存完整 KeyRef。
    return {
      publicKeyHex: snapshot.activePublicKeyHex.toLowerCase(),
      label: "",
      capabilities: [],
      createdAt: "",
    };
  };

  return {
    active: current,
    requireActiveKey,
    onActiveKeyChanged(handler) {
      handlers.add(handler);
      handler(current());
      return () => { handlers.delete(handler); };
    },
  };
}
