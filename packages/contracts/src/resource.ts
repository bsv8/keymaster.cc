/**
 * Runtime Resource Store 契约
 *
 * 定义资源键、快照、定义和注册表的类型。
 * Resource Store 是 React 读取业务数据、订阅业务数据变更的唯一框架入口。
 */

/** 资源键：稳定、可比较、无秘密信息的字符串元组 */
export type ResourceKey = readonly [resourceId: string, ...parts: readonly string[]];

/** 资源状态 */
export type ResourceStatus = "pending" | "ready" | "stale" | "error" | "blocked";

/** 资源快照：包含状态、数据、错误和修订版本 */
export interface ResourceSnapshot<T> {
  readonly key: ResourceKey;
  readonly status: ResourceStatus;
  readonly data: T | undefined;
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
}

/** 资源上下文：由 runtime 创建，包含稳定的只读 capability reader、当前 active-key 快照等 */
export interface ResourceContext {
  /** 获取 capability */
  getCapability<T>(id: string): T | undefined;
  /** 当前 active public key hex（可能为 undefined） */
  readonly activePublicKeyHex: string | undefined;
  /** 插件 owner ID（由 runtime 在注册时绑定，插件代码不可写入） */
  readonly ownerId: string;
}

/** Runtime-only metadata. It is intentionally not part of the public definition shape. */
export const RESOURCE_OWNER = Symbol("keymaster.resource.owner");
export type OwnedResourceDefinition = ResourceDefinition<any, any> & {
  readonly [RESOURCE_OWNER]?: string;
};

/** 资源定义：描述如何加载、订阅和比较资源 */
export interface ResourceDefinition<T, TArgs extends readonly string[] = readonly string[]> {
  /** 资源唯一 ID */
  readonly id: string;
  /** 作用域：global 或 active-key */
  readonly scope: "global" | "active-key";
  /** 生成资源键 */
  key(args: TArgs, context: ResourceContext): ResourceKey;
  /** 加载资源数据（只能读取本地服务/DB） */
  load(args: TArgs, context: ResourceContext, signal: AbortSignal): Promise<T>;
  /** 订阅失效事件（只表达失效，不直接 setState） */
  subscribe?(args: TArgs, context: ResourceContext, invalidate: () => void): () => void;
  /** 语义相等判断：决定是否发布新 snapshot */
  equals?(previous: T | undefined, next: T | undefined): boolean;
  /** 失效策略：immediate 或 microtask（合并同轮失效） */
  readonly invalidation: "immediate" | "microtask";
}

/** 资源注册表：管理资源定义的注册和查询 */
export interface ResourceRegistry {
  /** 注册资源定义 */
  register<T, TArgs extends readonly string[]>(definition: ResourceDefinition<T, TArgs>): void;
  /** 注销资源定义 */
  unregister(id: string): void;
  /** 获取资源定义 */
  get<T, TArgs extends readonly string[]>(id: string): ResourceDefinition<T, TArgs> | undefined;
  /** 获取所有已注册的资源定义 id（用于 ownership 快照） */
  _ids(): string[];
}

/** Resource Registry capability key */
export const RESOURCE_REGISTRY_CAPABILITY = "resource.registry";
