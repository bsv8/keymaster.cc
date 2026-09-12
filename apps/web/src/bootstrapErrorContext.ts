import type { PluginBootstrapStage } from "@keymaster/contracts";

/** Bootstrap 中发生错误时的结构化上下文。字符串只描述操作，不用于错误分类。 */
export interface BootstrapErrorContext {
  readonly stage: BootstrapErrorStage;
  readonly operation: string;
  readonly pluginId?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export type BootstrapErrorStage =
  | PluginBootstrapStage
  | "coordinator"
  | "window-app"
  | "transport"
  | "storage-status"
  | "bootstrap";

export type BootstrapFatalPhase =
  | "pre-bootstrap.coordinator"
  | "pre-bootstrap.window-app"
  | "pre-bootstrap.transport"
  | "pre-bootstrap.storage-status"
  | "pre-bootstrap.storage-onboarding"
  | "pre-bootstrap.vault-selection"
  | "pre-bootstrap.owner-apps-ready"
  | "pre-bootstrap.connect-apps-ready"
  | "pre-bootstrap.fallback";

/** 将结构化阶段映射成 fatal store 的稳定阶段值。 */
export function bootstrapPhaseForContext(
  context: BootstrapErrorContext | undefined
): BootstrapFatalPhase {
  switch (context?.stage) {
    case "coordinator": return "pre-bootstrap.coordinator";
    case "window-app": return "pre-bootstrap.window-app";
    case "transport": return "pre-bootstrap.transport";
    case "storage-status": return "pre-bootstrap.storage-status";
    case "storage-onboarding": return "pre-bootstrap.storage-onboarding";
    case "vault-selection": return "pre-bootstrap.vault-selection";
    case "owner-apps-ready": return "pre-bootstrap.owner-apps-ready";
    case "connect-apps-ready": return "pre-bootstrap.connect-apps-ready";
    default: return "pre-bootstrap.fallback";
  }
}

/** 仅用于调试读取；上下文本身不改变原始错误的 name/details/stack。 */
const bootstrapContexts = new WeakMap<object, BootstrapErrorContext>();
const BOOTSTRAP_CONTEXT_PROPERTY = "bootstrapContext";

/** 带有 cause 的 fallback 异常，用于原始值或不可扩展对象。 */
export class BootstrapContextError extends Error {
  readonly bootstrapContext: BootstrapErrorContext;

  constructor(context: BootstrapErrorContext, cause: unknown) {
    super(`Bootstrap operation failed: ${context.operation}`, { cause });
    this.name = "BootstrapContextError";
    this.bootstrapContext = context;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** 返回异常最近一次的 bootstrap 上下文；未知异常返回 undefined。 */
export function getBootstrapErrorContext(error: unknown): BootstrapErrorContext | undefined {
  if (!isObjectLike(error)) return undefined;
  return bootstrapContexts.get(error)
    ?? (BOOTSTRAP_CONTEXT_PROPERTY in error
      ? (error as { bootstrapContext?: unknown }).bootstrapContext as BootstrapErrorContext | undefined
      : undefined);
}

/**
 * 给原始异常附加上下文并原样抛回。
 *
 * 使用 WeakMap 作为主存储，避免污染错误类型的可枚举诊断字段；同时以
 * 非枚举属性暴露给脱敏诊断序列化器/调试器。已存在的上下文不被外层
 * wrapper 覆盖，这样 pluginId 和具体 stage 始终优先于父级操作。
 */
export function attachBootstrapErrorContext(
  error: unknown,
  context: BootstrapErrorContext
): unknown {
  if (!isObjectLike(error)) return new BootstrapContextError(context, error);
  if (getBootstrapErrorContext(error)) return error;
  bootstrapContexts.set(error, context);
  try {
    Object.defineProperty(error, BOOTSTRAP_CONTEXT_PROPERTY, {
      configurable: true,
      enumerable: false,
      value: context,
      writable: false
    });
  } catch {
    // WeakMap remains authoritative for frozen/sealed Error objects.
  }
  return error;
}

/** 捕获异步装配操作并保留原始异常身份。 */
export async function withBootstrapErrorContext<T>(
  context: BootstrapErrorContext,
  operation: () => T | PromiseLike<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw attachBootstrapErrorContext(error, context);
  }
}

/** 捕获同步装配操作并保留原始异常身份。 */
export function runWithBootstrapErrorContext<T>(
  context: BootstrapErrorContext,
  operation: () => T
): T {
  try {
    return operation();
  } catch (error) {
    throw attachBootstrapErrorContext(error, context);
  }
}
