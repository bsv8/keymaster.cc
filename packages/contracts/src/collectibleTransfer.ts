// packages/contracts/src/collectibleTransfer.ts
// collectible transfer 框架公共契约。
//
// 设计缘由：
//   - collectible transfer 是"单件对象 + widget"语义，与现有
//     transfer.registry 的"coin/offer 平台"语义不同；本协议不复用
//     现有 transfer.registry，单独维护 collectible-transfer.registry。
//   - 选择规则：
//       0 个 handler：详情页/平台页显示"当前藏品暂无可用转移处理器"空态。
//       1 个 handler：直接挂载。
//       多个 handler：按 order 升序选最小者；order 仍冲突则抛英文错误
//         并记日志，禁止静默随机挑选。
//   - 平台（plugin-collectible-transfer）只负责路由 + 选择 + 挂载，
//     不解释 outpoint / raw tx / 手续费 / 脚本；这些都交给具体 handler。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";
import type { CollectibleDetail } from "./collectibles.js";

/** 平台引用一个 collectible 的最小定位信息。 */
export interface CollectibleRef {
  providerId: string;
  collectibleId: string;
}

/** handler 平台契约：仅声明"是否支持"。 */
export interface CollectibleTransferCapability {
  /** handler 是否支持该 ref；平台据此选择挂载。 */
  supports(ref: CollectibleRef): boolean;
}

/** Widget 入参：平台传 detail + ref + 完成回调。 */
export interface CollectibleTransferWidgetProps {
  ref: CollectibleRef;
  detail: CollectibleDetail;
  onCompleted(result: CollectibleTransferCompletion): void;
}

/** 完成回调入参。 */
export interface CollectibleTransferCompletion {
  ref: CollectibleRef;
  /** provider-specific reference：例如 txid / new outpoint。 */
  reference?: string;
  completedAt: string;
  /** 诊断/展示用；平台不解释内容。 */
  details?: Record<string, unknown>;
}

/** collectible transfer handler 完整契约。 */
export interface CollectibleTransferHandler extends CollectibleTransferCapability {
  id: string;
  name: I18nText;
  /** 平台排序：越小越靠前；order 冲突时按本注册表抛英文错误。 */
  order?: number;
  /** 挂载的 Widget 组件。 */
  component: ComponentType<CollectibleTransferWidgetProps>;
}

/** collectible transfer 注册表。 */
export interface CollectibleTransferRegistry {
  /** 注册 handler；id 重复抛错。 */
  register(handler: CollectibleTransferHandler): void;
  /** 注销 handler；id 不存在抛错。 */
  unregister(id: string): void;
  /** 列出全部 handler；按 order 升序。 */
  list(): CollectibleTransferHandler[];
  /** 按 id 取 handler。 */
  get(id: string): CollectibleTransferHandler | undefined;
  /**
   * 给定 ref：按 supports 过滤后按 order 升序排序。
   * 命中多个且 order 相同时抛英文错误并记日志（平台层不在此处抛错，
   * 由平台页面在拿到候选集后自行决策）。
   */
  listSupporting(ref: CollectibleRef): CollectibleTransferHandler[];
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
}