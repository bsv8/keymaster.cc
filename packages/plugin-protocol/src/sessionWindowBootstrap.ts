// packages/plugin-protocol/src/sessionWindowBootstrap.ts
// Session Window 启动模式 + launcher 一次性 bootstrap consume（direct call）。
//
// 设计缘由（施工单 2026-06-29 001 硬切换 + 用户确认）：
//   - Session Window 仍只有唯一入口 `/protocol/v1/popup`；本文件负责
//     解析 URL 上的 `boot` + `bootstrapToken` 标记，并管理 appView mode 下
//     Session Window **主动**从同源 `window.opener` 拉取 bootstrap capsule。
//   - **不**走 postMessage handoff。postMessage 是事件队列：launcher 在
//     Session Window 的 message listener 挂好之前发出消息会**丢失**。同源
//     直接调用没有这个问题——`window.opener.<method>(args)` 是同步 JS 函数
//     调用，launcher 可以"立即返回"也可以"返回 Promise 等异步就绪"，
//     Session Window 自己决定何时调用。
//   - 启动阶段差异只允许出现在这里；进入已建立 session 的运行期后，
//     `protocolService` 不再区分 connect / appView 两种 mode。
//   - 本文件**不**承载协议命令流；它是 Session Window 自身的"启动期
//     状态机"——从 opener 拉 capsule → 喂给 handler → 由 handler 走
//     `protocolService.applyLauncherBootstrap()`。
//   - 握手协议（已硬切换为 direct consume）：
//       * launcher 在自己的 `window.__keymaster_session_window_bootstrap__`
//         上挂一个 `LauncherBootstrapRegistry`；`acquire(token)` 是入口；
//       * launcher 用
//         `window.open("/protocol/v1/popup?boot=appView&bootstrapToken=<id>")`
//         打开 Session Window；token 是 launcher 生成的不透明 ID，
//         URL 中**不**承载 capsule 内容（不敏感）；
//       * Session Window mount 时调 `consumeLauncherBootstrap({...})`，
//         内部读 URL token + 调
//         `window.opener.__keymaster_session_window_bootstrap__.acquire(token)`；
//       * launcher 命中 token → 返回 capsule，并从 registry 删除该 entry
//         （一次性消费）；token 不命中 / launcher 关闭 → 返回 null；
//         vault 未解锁 / 无 active key → throw；
//       * Session Window 拿到 capsule 后调用 `handler(payload)`，由
//         `protocolService.applyLauncherBootstrap` 应用。
//   - **不**做持续 RPC / keepalive / reconnect；`acquire` 是**一次**调用。

import type { AppBootstrapPayload } from "@keymaster/contracts";

/* ============== boot mode 解析 ============== */

/**
 * Session Window 当前 boot mode。
 *
 * 设计缘由：
 *   - 缺省 `connect`：第三方 client web `window.open` 拉起 Session Window；
 *   - `appView`：launcher 主动拉起；Session Window 进入"等待 launcher
 *     bootstrap"状态。
 *   - mode 一旦确定**不**可变；URL 上的 `boot` 参数只解析一次。
 */
export type SessionWindowBootMode = "connect" | "appView";

/**
 * 解析 URL 上的 boot mode 标记。
 *
 * 设计缘由：
 *   - 只解析 `?boot=appView`（缺省 / 其它值一律按 `connect` 走）。
 *   - URL **不**承载敏感 bootstrap 内容——只承载"该窗口要以哪种模式启动"
 *     的轻量标记。
 */
export function parseBootMode(search: string): SessionWindowBootMode {
  if (typeof search !== "string" || search.length === 0) return "connect";
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const boot = params.get("boot");
  return boot === "appView" ? "appView" : "connect";
}

/**
 * 解析 URL 上的 bootstrap token；不存在时返回 null。
 *
 * 设计缘由：
 *   - token 是 launcher 写入 URL 的不透明 ID，本身**不**敏感；
 *   - 真值 capsule 由 Session Window 通过 `acquire(token)` 从 launcher
 *     拉取，URL 中**不**承载。
 */
export function parseBootstrapToken(search: string): string | null {
  if (typeof search !== "string" || search.length === 0) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const t = params.get("bootstrapToken");
  return t && t.length > 0 ? t : null;
}

/* ============== 路径 normalize（storage.* 共享） ============== */

/**
 * 规范化 + 校验 storage 路径。
 *
 * 规则（施工单 2026-06-29 001 硬切换）：
 *   - 必须是非空字符串；
 *   - 不允许以 `/` 开头；
 *   - 不允许包含 `..` 段；
 *   - 不允许包含 `\`（会被规范化为 `/`）或 `\0`；
 *   - 统一使用 `/` 作为分隔符；连续 `/` 折叠为单个；
 *   - 单段长度不超过 1024 字符；
 *   - 越界直接 throw（由 caller 决定映射到 `invalid_request`）。
 *
 * 设计缘由：路径规则集中在 storage.* 入口校验；不在 S3 层校验，避免
 * 不同 adapter 各自实现一份。
 */
export function normalizeStoragePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Invalid storage path: empty");
  }
  if (path.startsWith("/")) {
    throw new Error("Invalid storage path: must not start with /");
  }
  if (path.includes("\0")) {
    throw new Error("Invalid storage path: contains NUL");
  }
  // 用 `/` 分隔，折叠连续分隔符。
  const raw = path.replace(/\\/g, "/").split("/").filter((seg) => seg.length > 0);
  if (raw.length === 0) {
    throw new Error("Invalid storage path: empty after normalize");
  }
  for (const seg of raw) {
    if (seg === "..") {
      throw new Error("Invalid storage path: contains ..");
    }
    if (seg.length > 1024) {
      throw new Error("Invalid storage path: segment too long");
    }
  }
  return raw.join("/");
}

/**
 * 把 origin 编码成 base64url 形式（不含 padding），用作物理对象 key
 * 第一段。
 *
 * 设计缘由（施工单 2026-06-29 001 硬切换）：
 *   - origin 可能含 `:` `/` 等 S3 不友好字符；走 base64url 后只含
 *     `[A-Za-z0-9_-]`，所有 S3 实现都接受。
 *   - 不含 padding；保持 key 紧凑。
 */
export function encodeOrigin(origin: string): string {
  const bytes = new TextEncoder().encode(origin);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  const b64 = typeof btoa === "function" ? btoa(binary) : "";
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ============== Session Window → launcher 直接 consume ============== */

/**
 * Session Window 端：从同源 `window.opener` 拉取 bootstrap capsule。
 *
 * 设计缘由（修复 issue #1）：
 *   - **不**挂 message listener、**不**做 postMessage handoff。
 *   - 这是同源直接调用：`window.opener.__keymaster_session_window_bootstrap__
 *     .acquire(token)` 是普通 JS 函数调用，**没有**事件队列时序竞态。
 *   - launcher 自己持有 `Map<token, AppBootstrapPayload>`；acquire 命中
 *     即从 map 删除——一次性消费，与 `AppBootstrapPayload.launchToken`
 *     一次性语义对齐。
 *   - 调用结果是"立即拿到 capsule"还是"launcher 还在准备，Promise
 *     pending 等一会"由 launcher 自己决定；本函数用 race 接超时定时器。
 *
 * 校验项：
 *   - `token` 非空（URL 解析时已经过滤；这里再保一道）；
 *   - `opener` 存在且未关闭（`opener.closed === false`）；
 *   - `opener.location.origin === ownOrigin`（同源）；
 *   - `opener.__keymaster_session_window_bootstrap__.acquire` 是函数；
 *   - acquire() 不抛错、不超时。
 */
export interface ConsumeLauncherBootstrapInput {
  token: string | null;
  opener: Window | null;
  ownOrigin: string;
  timeoutMs: number;
}
export interface ConsumeLauncherBootstrapOutput {
  bootstrap: AppBootstrapPayload | null;
  /** 失败原因；null 表示成功。 */
  failureReason: string | null;
}

const LAUNCHER_REGISTRY_KEY = "__keymaster_session_window_bootstrap__";

export async function consumeLauncherBootstrap(
  input: ConsumeLauncherBootstrapInput
): Promise<ConsumeLauncherBootstrapOutput> {
  if (!input.token) {
    return { bootstrap: null, failureReason: "bootstrap_token_missing" };
  }
  if (!input.opener) {
    return { bootstrap: null, failureReason: "launcher_opener_unavailable" };
  }
  try {
    if (input.opener.closed) {
      return { bootstrap: null, failureReason: "launcher_closed" };
    }
  } catch {
    // 跨源访问会抛 DOMException；忽略。
    return { bootstrap: null, failureReason: "launcher_opener_unavailable" };
  }
  let openerOrigin = "";
  try {
    openerOrigin = input.opener.location.origin;
  } catch {
    // 跨源访问 location 抛错 → 视为跨源，拒掉。
    return { bootstrap: null, failureReason: "launcher_cross_origin" };
  }
  if (openerOrigin !== input.ownOrigin) {
    return { bootstrap: null, failureReason: "launcher_cross_origin" };
  }
  // 读 registry。同源 window 直接读字段，不会抛 SecurityError。
  const registry = (input.opener as unknown as Record<string, unknown>)[LAUNCHER_REGISTRY_KEY] as
    | { acquire?: (token: string) => Promise<AppBootstrapPayload | null> }
    | undefined;
  if (!registry || typeof registry.acquire !== "function") {
    return { bootstrap: null, failureReason: "launcher_registry_missing" };
  }
  const acquire = registry.acquire;
  // 调 acquire + race 超时。launcher 可能"立即返回"也可能"还在准备"；
  // 我们的 Promise.race 让两端时序自由。
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race<AppBootstrapPayload | null>([
      Promise.resolve().then(() => acquire(input.token!)),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("bootstrap_acquire_timeout"));
        }, input.timeoutMs);
      })
    ]);
    if (!result) {
      return { bootstrap: null, failureReason: "launcher_token_not_found" };
    }
    return { bootstrap: result, failureReason: null };
  } catch (err) {
    return {
      bootstrap: null,
      failureReason: err instanceof Error ? err.message : "bootstrap_acquire_failed"
    };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

/* ============== Launcher 端：构造 handoff payload ============== */

/**
 * launcher 用于构造一次性 bootstrap payload 的依赖。
 *
 * 设计缘由：
 *   - launcher 已经持有 vault unlock runtime；本接口只声明它需要传入
 *     哪些已就绪数据，**不**替代 launcher 自己决定"是否允许启动
 *     appView"的策略。
 *   - `appUrl` 必须已经拼好 launchToken；Session Window bootstrap 完成后
 *     会用 `window.open(appUrl, "_blank")` 直接打开 client app
 *     （保留 `window.opener` 让 client app 能 `postMessage` 回
 *     Session Window，走现有 popup transport）。
 */
export interface LauncherHandoffInput {
  appId: string;
  appOrigin: string;
  appUrl: string;
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, unknown>;
  resolvedAt: number;
  launchToken: string;
  /** launchToken 过期时间（unix milliseconds）。Session Window 刷新后失效。 */
  expiresAt: number;
  unlockRuntime: unknown;
}

/**
 * launcher 用 `crypto.randomUUID()` 生成新 launchToken；要求调用方自己
 * 调 `crypto.randomUUID()` 后传入，避免本模块引入对 `crypto` 全局对象的
 * 隐式依赖。
 */
export function buildAppBootstrapPayload(input: LauncherHandoffInput): AppBootstrapPayload {
  if (!input.appId || !input.appOrigin || !input.appUrl) {
    throw new Error("Launcher handoff missing app fields");
  }
  if (!input.connectSessionId || !input.ownerPublicKeyHex) {
    throw new Error("Launcher handoff missing connect session fields");
  }
  if (!input.launchToken) {
    throw new Error("Launcher handoff missing launchToken");
  }
  if (!input.unlockRuntime) {
    throw new Error("Launcher handoff missing unlock runtime");
  }
  return {
    app: {
      appId: input.appId,
      appOrigin: input.appOrigin,
      appUrl: input.appUrl
    },
    connectSessionId: input.connectSessionId,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    resolvedClaims: input.resolvedClaims as AppBootstrapPayload["resolvedClaims"],
    resolvedAt: input.resolvedAt,
    launchToken: input.launchToken,
    unlockRuntime: input.unlockRuntime as AppBootstrapPayload["unlockRuntime"]
  };
}