// packages/contracts/src/msfileContent.ts
// MSFile 跨插件内容能力契约。
//
// 设计缘由：
//   - Forum 之类的阅读型插件需要「获取 / 导入 / 读取已验证内容 / 进度 / 失效」
//     这组能力，但绝不能拿到 OwnerFileStore、原始私有路径或供应商私钥；
//   - 内容真值、来源选择、价格策略、网络并发、失败重试与落盘全部留在 MSFile；
//     调用方只持有任务引用与状态；
//   - `openVerifiedContent` 只在完整性验证通过后返回字节、大小与内容身份，
//     调用方不能凭 metadata 或任务成功标志绕过内容验证。

import { defineCapability } from "webloom-framework";

import type { MsFileSatoshiAmount } from "./msfile.js";

/** 内容状态。`verified` 是唯一允许被当作完整内容的状态。 */
export type MsFileContentState =
  | "absent"
  | "fetching"
  | "partial"
  | "verified"
  | "unreachable"
  | "verification-failed";

export type MsFileContentFailureCode =
  | "content-not-found"
  | "source-unreachable"
  | "integrity-error"
  | "too-large"
  | "price-limit-exceeded"
  | "no-available-channel"
  | "cancelled"
  | "storage-error";

/** 进度；`completedBytes` 与 `totalBytes` 都是规范十进制字符串。 */
export interface MsFileContentProgress {
  readonly state: MsFileContentState;
  readonly completedBytes: MsFileSatoshiAmount;
  readonly totalBytes?: MsFileSatoshiAmount;
  readonly failureCode?: MsFileContentFailureCode;
}

export interface MsFileContentStatus {
  readonly seedHashHex: string;
  readonly state: MsFileContentState;
  /** 仅 verified 有值；已经与 meta、块数量和块 hash 对账。 */
  readonly verifiedBytes?: MsFileSatoshiAmount;
  readonly failureCode?: MsFileContentFailureCode;
  /** 本地已有完整副本，因此断网后仍可读取。 */
  readonly localCopy: boolean;
  /** meta 声明的原始文件名；只是元数据，不能作为内容证据。 */
  readonly fileName?: string;
  readonly mediaType?: string;
}

export interface MsFileVerifiedContent {
  readonly seedHashHex: string;
  /** 已验证的完整字节；大小与 seedHashHex 一一对应。 */
  readonly bytes: Uint8Array;
  /** 经核对的大小，规范十进制字符串。 */
  readonly byteLength: MsFileSatoshiAmount;
  readonly mediaType?: string;
  readonly fileName?: string;
}

export interface MsFileContentEnsureInput {
  readonly seedHashHex: string;
  /**
   * 是否允许为付费内容动用资金。
   *
   * 默认 false：列表浏览不得自动无限购买正文，只有用户明确的阅读动作
   * 才允许触发获取。
   */
  readonly allowPurchase?: boolean;
  readonly signal?: AbortSignal;
}

export interface MsFileContentImportInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: string;
  readonly signal?: AbortSignal;
}

export interface MsFileContentService {
  /**
   * 确保本地存在该 hash 的完整内容。
   *
   * 本地完整命中不走远程；不完整命中复用已验证块，缺失部分由 MSFile 调度。
   * 相同 hash 的并发请求合并为一个任务；取消一个消费者不终止其他消费者
   * 仍需要的任务。
   */
  ensureContent(input: MsFileContentEnsureInput): Promise<MsFileContentStatus>;
  /** 只读本地已验证内容；不完整或不存在时返回 undefined，不触发网络。 */
  openVerifiedContent(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<MsFileVerifiedContent | undefined>;
  /** 把调用方提供的字节按 MSFile 布局存入；返回其 seed hash。 */
  importContent(input: MsFileContentImportInput): Promise<{ readonly seedHashHex: string; readonly byteLength: MsFileSatoshiAmount }>;
  /** 当前状态；不触发网络。 */
  getContentStatus(seedHashHex: string): Promise<MsFileContentStatus>;
  /**
   * 订阅单个 hash 的状态变化（进度、删除与损坏失效）。
   *
   * 返回的退订函数只解除本次订阅，不取消底层任务。
   */
  subscribeContent(seedHashHex: string, listener: (status: MsFileContentStatus) => void): () => void;
  /**
   * 发布可达性证据：读者能否通过 MSFile 取得该内容。
   *
   * 渠道尚未实现时必须返回不可达并附稳定原因，调用方不得伪造发布成功。
   */
  publicationReachability(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<MsFilePublicationReachability>;
}

export interface MsFilePublicationReachability {
  readonly seedHashHex: string;
  /** 本地已保存不等于读者可取得，所以两者分开表达。 */
  readonly published: boolean;
  readonly sourceIds: readonly string[];
  readonly detail: string;
}

export const MSFILE_CONTENT_CAPABILITY = defineCapability<MsFileContentService>({
  kind: "local",
  id: "msfile.content",
  version: "1",
});

/** 严格校验 seed hash；内容能力的所有入口都以此为第一道闸门。 */
export function isValidMsFileContentSeedHash(input: unknown): input is string {
  return typeof input === "string" && /^[0-9a-f]{64}$/u.test(input);
}