// Forum 资源上下文。
//
// UI 只通过这里拿 Forum 服务，不直接依赖契约的其它 capability：资源 URL、订阅
// 与解析结果都绑定页面 Scope，退出或身份失效时随之释放。

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import {
  FORUM_SERVICE_CAPABILITY,
  type ForumService,
} from "@keymaster/contracts";

export interface ForumUiContextValue {
  readonly forum: ForumService;
}

const ForumUiContext = createContext<ForumUiContextValue | undefined>(undefined);

export function ForumResourceProvider(props: { readonly value: ForumUiContextValue; readonly children: ReactNode }): ReactNode {
  return createElement(ForumUiContext.Provider, { value: props.value }, props.children);
}

export function useForum(): ForumUiContextValue {
  const value = useContext(ForumUiContext);
  if (value === undefined) {
    throw new Error("useForum 必须在 ForumResourceProvider 内使用");
  }
  return value;
}

/** 按当前 Scope 绑定一份服务视图。 */
export function bindForumUi<T>(forum: ForumService, render: (value: ForumUiContextValue) => T): T {
  const value = useMemo<ForumUiContextValue>(() => ({ forum }), [forum]);
  return render(value);
}

export { FORUM_SERVICE_CAPABILITY };