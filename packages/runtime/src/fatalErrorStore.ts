// packages/runtime/src/fatalErrorStore.ts
// 全局 fatal 错误存储：施工单 2026-06-30 001 落地。
//
// 这是全局应用级退出通道,不是普通日志通道。
// fatal 一旦确认,当前正常 UI 路径不再可信。
//
// 设计缘由：
//   - store 本身不依赖 DOM / window / React,既可以被 React 业务树挂载
//     之前调用,也可以被 plugin-vault 等业务包在同步启动路径里调用。
//   - 第一条 fatal 生效并接管页面;后续 fatal 只记录到内存附注或直接忽略,
//     不反复重绘。
//   - 不把 fatal 上报路径耦合进 messageBus:fatal 可能发生在 host 还没
//     创建之前。
//   - 不把 fatal 基础设施塞进 apps/web 私有目录:plugin-vault 等包也可
//     以安全 import 本 store。
//
// 边界(本文件注释必须说明清楚):
//   - 主题/语言/localStorage 最佳努力读写失败:
//     -> **不**走 fatal store,继续 best-effort 降级。
//   - WOC / 链上接口 / 普通网络错误:
//     -> **不**走 fatal store,继续走现有局部错误处理。
//   - 业务页 provider 错误(已有局部 ProviderErrorBoundary):
//     -> **不**走 fatal store,继续局部展示。
//   - 浏览器扩展 / 第三方脚本 / analytics 抛错:
//     -> **不**走 fatal store(在 apps/web 的 global handler 里做来源
//        过滤后再决定是否升级)。
//   - bootstrap / 顶级 React 渲染 / vault 关键持久化损坏 / invariant 破坏:
//     -> 走 fatal store,接管页面。

/**
 * Fatal 错误阶段标签:用于排障时定位"发生在哪一段"。
 *
 * 不强约束:允许调用方在自定义场景传入 `phase = "custom:xxx"`。
 */
export type FatalPhase =
  | "pre-bootstrap.env"
  | "pre-bootstrap.plugins"
  | "react.render"
  | "react.lifecycle"
  | "vault.bootstrap"
  | "vault.persist"
  | "global.error"
  | "global.unhandledrejection"
  | "custom";

/**
 * Fatal 错误来源范围:用于排障与权限过滤。
 *
 * "app" = 本应用代码/启动链;其它来源(global handler 来源过滤前)暂不
 * 决定 fatal,放在 global handler 内做归因后再升级为 fatal。
 */
export type FatalScope = "app-root" | "vault-service" | "browser" | "custom";

/** Fatal 错误来源描述:哪个 bundle / 文件 / 第三方。 */
export type FatalSource =
  | "app-bundle"
  | "browser-extension"
  | "third-party-script"
  | "unknown";

/** 归一化后的 fatal 输入。任意业务入口只需把 Error 或原始值塞进 message / cause。 */
export interface FatalErrorReportInput {
  phase: FatalPhase;
  scope: FatalScope;
  message: string;
  stack?: string;
  source?: FatalSource;
  cause?: unknown;
}

/** 归一化后的 fatal 快照:被 fatal crash page 读取。 */
export interface FatalErrorSnapshot {
  id: string;
  time: string;
  phase: FatalPhase;
  scope: FatalScope;
  message: string;
  stack: string;
  source: FatalSource;
  cause?: unknown;
}

type FatalListener = (snapshot: FatalErrorSnapshot) => void;

let current: FatalErrorSnapshot | null = null;
/** 后续 fatal 追加到的副表:首条 fatal 赢,后续仅供诊断。 */
const tail: FatalErrorSnapshot[] = [];
const listeners = new Set<FatalListener>();

/**
 * 第一条 fatal 生效;后续 fatal 只追加到 tail,不重复通知订阅者。
 * 理由:系统已经退出正常路径,再重复接管没有意义。
 */
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `fatal_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function normalizeErrorLike(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toSnapshot(input: FatalErrorReportInput, id: string): FatalErrorSnapshot {
  const stack = input.stack && input.stack.length > 0
    ? input.stack
    : normalizeErrorLike(input.cause);
  return {
    id,
    time: new Date().toISOString(),
    phase: input.phase,
    scope: input.scope,
    message: input.message,
    stack,
    source: input.source ?? "app-bundle",
    cause: input.cause
  };
}

/**
 * 上报一条 fatal 错误。幂等:第一条 fatal 赢,后续 fatal 仅追加到 tail
 * 供诊断;不再次通知订阅者,避免重绘。
 */
export function reportFatalError(input: FatalErrorReportInput): FatalErrorSnapshot {
  if (current) {
    // 后续 fatal:仅追加诊断,不再触发接管。
    const snapshot = toSnapshot(input, makeId());
    tail.push(snapshot);
    return snapshot;
  }
  const snapshot = toSnapshot(input, makeId());
  current = snapshot;
  // 通知订阅者(应用接管者)。订阅者内部应尽快 unmount React root 并渲染
  // 纯 DOM 崩溃页;不要再尝试让正常 React 树继续工作。
  for (const l of [...listeners]) {
    try {
      l(snapshot);
    } catch (err) {
      // 订阅者自己抛错:不能让 fatal 通道再次进入自己——console.error
      // 兜底即可。设计缘由:崩溃页可能自身渲染失败,这里就是最后一道
      // 防线。
      // eslint-disable-next-line no-console
      console.error("[fatalErrorStore] subscriber threw", err);
    }
  }
  return snapshot;
}

/** 读取当前 fatal 快照;没有则 null。 */
export function getFatalError(): FatalErrorSnapshot | null {
  return current;
}

/** 读取首条 fatal 之后追加的诊断列表(只读,顺序 = 上报顺序)。 */
export function getFatalTail(): readonly FatalErrorSnapshot[] {
  return tail;
}

/**
 * 订阅 fatal 事件:第一条 fatal 上报时立刻被调用一次;之后只会被同一次
 * session 的第一条 fatal 调用一次。返回取消订阅函数。
 *
 * 设计缘由:本次"首条 fatal 赢"语义下,订阅者通常只关心接管动作。
 * listener 抛出不能影响其它订阅者;内部已 try/catch。
 */
export function subscribeFatalError(listener: FatalListener): () => void {
  listeners.add(listener);
  if (current) {
    // 当前已有 fatal:补一次喂给刚注册的订阅者,避免它在 store 已生效
    // 之后才挂载时漏掉接管。
    try {
      listener(current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[fatalErrorStore] subscriber threw on resync", err);
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 重置 fatal store。仅供测试夹具使用;生产代码不应调用。
 *
 * 与 logService 的 disposeLogDb 暴露方式一致:作为 runtime 入口的浅
 * re-export,业务插件仍只能走公共 API。
 */
export function resetFatalErrorForTest(): void {
  current = null;
  tail.length = 0;
  listeners.clear();
}
