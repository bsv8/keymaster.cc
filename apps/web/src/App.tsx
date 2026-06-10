// apps/web/src/App.tsx
// 根组件：根据 vault 状态决定渲染哪个 shell。
// 设计缘由：Booting/Locked/Unlocked 三态由 runtime 决定，App 只负责调度。
//
// 硬切换 003：启动 loading 文案走 i18n。正常路径下 i18n service 在 host
// 创建时已存在；这里直接 useI18n 取 t() 即可。

import { useI18n, useRuntimeStatus } from "@keymaster/runtime";
import { LockedShell } from "./shell/LockedShell.js";
import { UnlockedShell } from "./shell/UnlockedShell.js";

export function App() {
  const { vault, ready } = useRuntimeStatus();
  const { t } = useI18n();

  if (!ready || vault === "booting") {
    return (
      <div className="app-booting">
        <p>{t("common.status.loading", { defaultValue: "正在加载…" })}</p>
      </div>
    );
  }

  if (vault === "uninitialized" || vault === "locked") {
    return <LockedShell />;
  }

  return <UnlockedShell />;
}
