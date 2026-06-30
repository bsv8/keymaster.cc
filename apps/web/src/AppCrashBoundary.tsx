// apps/web/src/AppCrashBoundary.tsx
// 顶级 React fatal 边界（施工单 2026-06-30 001）。
//
// 职责：
//   - 作为整棵业务树的唯一顶层 ErrorBoundary。
//   - componentDidCatch 内统一调 reportFatalError。
//   - fallback 不渲染业务 UI、不渲染"继续使用"按钮；最多返回 null。
//     真正的展示由纯 DOM 崩溃页（fatalCrashPage.ts）接管——
//     store 通知 main.tsx 卸载 root 并渲染纯 DOM 页。
//
// 关键约束：
//   - 不能在这里再渲染一套复杂 React 错误页（自己依赖的 React 业务树
//     已不可信,继续渲染 React 也会再次挂掉）。
//   - 不能把它当局部页面错误边界用。局部业务错误仍由各页面自己的
//     ErrorBoundary 处理；只有未被局部边界吸收、一路冒泡到顶层的异常
//     才升级 fatal。
//   - 已经在 fatal 状态时不再二次上报（fatal store 内部已"首条 fatal 赢"）。
//
// 子树已是 booted 状态（main.tsx 启动后）才能挂载本 boundary；启动前
// fatal 由 main.tsx 启动最前面的 fatal store 订阅直接渲染崩溃页。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { getFatalError, reportFatalError } from "@keymaster/runtime";

interface AppCrashBoundaryProps {
  children: ReactNode;
}

interface AppCrashBoundaryState {
  /** fatal store 是否已生效;仅用于决定是否渲染 null,不影响接管动作。 */
  taken: boolean;
}

export class AppCrashBoundary extends Component<AppCrashBoundaryProps, AppCrashBoundaryState> {
  state: AppCrashBoundaryState = { taken: false };

  static getDerivedStateFromError(): AppCrashBoundaryState {
    // 顶层层级 fatal 已交由 store 接管,这里只标记"不再渲染子树"。
    return { taken: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 关键:已经在 fatal 状态时不再二次上报,避免递归。
    if (getFatalError()) {
      return;
    }
    reportFatalError({
      phase: "react.render",
      scope: "app-root",
      source: "app-bundle",
      message: error.message,
      stack: error.stack,
      cause: { error, info }
    });
  }

  override render(): ReactNode {
    if (this.state.taken) {
      // 接管由 fatal store 通知 main.tsx 完成,这里只阻止继续渲染业务 UI。
      // 真正显示给用户的是纯 DOM 崩溃页。
      return null;
    }
    return this.props.children;
  }
}
