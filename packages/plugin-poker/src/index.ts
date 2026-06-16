// packages/plugin-poker/src/index.ts
// 公开导出：manifest、service 工厂、和最小一组公开 API。
//
// 设计缘由：插件公开面尽量薄；具体类型从 contracts 直接 re-export，
// 不在本包重复声明；engine / tsstack / conformance 内部模块不对外
// 导出（避免 apps/web 直接 import 真值实现）。

export { pokerPlugin, POKER_SERVICE_CAPABILITY } from "./manifest.js";
export { createPokerService } from "./pokerService.js";
export { createPokerIdentityBinding } from "./pokerIdentityBinding.js";
export type {
  PokerService,
  PokerConnectionStatus,
  PokerIdentityBinding,
  PokerIdentityBindingState,
  PokerIdentityCandidate,
  PokerSettings
} from "@keymaster/contracts";
