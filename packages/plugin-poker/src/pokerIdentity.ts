// packages/plugin-poker/src/pokerIdentity.ts
// Poker identity 解析：在"稳定身份绑定"前提下返回签名身份。
//
// 设计缘由：
//   - 硬切换 001 修订版要求"plugin-poker 的稳定玩家身份不能跟随当前
//     active key 漂移；必须有独立的 poker identity 绑定"。
//   - 历史实现把 keyspace.requireActiveKey() 直接当 poker identity；
//     这条路径已被废弃——只有当绑定缺失时，UI 才会去引导用户绑定，
//     而不是悄悄用 active key 顶替。
//   - 本文件依旧保留一个 `currentPokerIdentity(keyspace)` 工具函数以
//     兼容老调用方，但实现已改为"始终返回 null"，强制业务方走
//     PokerIdentityBindingManager.resolveIdentity()。

import type { KeyIdentity, KeyspaceService } from "@keymaster/contracts";

/**
 * @deprecated
 * 旧入口：原本根据 keyspace.active() 选 active key 作为 poker identity。
 * 硬切换 001 修订版 100/567/764 行明确这是设计错误：active key 切换
 * 会导致 presence / 桌主 / 聊天身份漂移。新代码必须通过
 * `PokerIdentityBindingManager.resolveIdentity()` 拿到稳定身份。
 *
 * 本函数现在恒返回 null，保留只为不破坏旧 import 路径；下次硬切换
 * 收尾时整体删除。
 */
export function currentPokerIdentity(_keyspace: KeyspaceService): KeyIdentity | null {
  void _keyspace;
  return null;
}
