// apps/web/src/shell/OnboardingShell.tsx
// 首启 onboarding 共享壳层：
//   - 浅底渐变背景（不是纯白空页）。
//   - 居中容器，最大宽度收敛。
//   - 顶部：OnboardingHeader（品牌 + 安全说明 + 主题/语言切换）。
//   - 中部：主面板（圆角、干净边框、有限阴影）。
//   - 内部：children（页面级 PageHeader + 主体内容）。
// 设计缘由：
//   - 锁屏态的所有模式（welcome / new-wallet-form / first-time-import /
//     unlock-form）必须使用同一套壳层，主题/语言切换入口和视觉风格
//     才一致。
//   - 不引入 unlocked 顶栏、侧边栏、面包屑；这是首启 onboarding，
//     与已解锁态是两种完全不同的 IA。

import type { ReactNode } from "react";
import { OnboardingHeader } from "./OnboardingHeader.js";
import { SiteFooter } from "./SiteFooter.js";

export interface OnboardingShellProps {
  children: ReactNode;
  /**
   * 内容宽度档位：
   *   - `narrow`（默认 480px）：新建钱包 / 解锁 / 单一表单。
   *   - `wide`（720px）：welcome 双卡片。
   *   - `wizard`（640px）：首启导入向导，承载 step progress。
   */
  width?: "narrow" | "wide" | "wizard";
  /**
   * 在窄屏 / 简单模式下隐藏安全提示（让 header 更紧凑）。
   * 默认 `false`——首启阶段用户更看重"安全心智"，应保持可见。
   */
  hideHeaderSecurityNote?: boolean;
}

export function OnboardingShell({
  children,
  width = "narrow",
  hideHeaderSecurityNote = false
}: OnboardingShellProps) {
  return (
    <div className="onboarding-shell">
      <OnboardingHeader hideSecurityNote={hideHeaderSecurityNote} />
      <main className="onboarding-shell__main">
        <div className={`onboarding-shell__panel onboarding-shell__panel--${width}`}>
          {children}
        </div>
      </main>
      <SiteFooter variant="onboarding" />
    </div>
  );
}
