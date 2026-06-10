// apps/web/src/shell/UnlockedShell.tsx
// 解锁后壳：等价于 AppShell，但语义明确。
// 拆出来便于以后扩展未解锁场景。

import { AppShell } from "./AppShell.js";

export function UnlockedShell() {
  return <AppShell />;
}
