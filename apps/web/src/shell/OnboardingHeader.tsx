// apps/web/src/shell/OnboardingHeader.tsx
// 首启 onboarding 共享 header：
//   - 左侧：品牌（Keymaster）+ 副标题（"本地私钥保险箱"等）。
//   - 右侧：ThemeToggle（onboarding 变体）+ LanguageSwitch。
//   - 顶部留一行安全提示（"私钥不会离开浏览器..."）。
// 设计缘由：
//   - welcome / 新建钱包 / 解锁 / 首启导入各 step 都使用同一套 header，
//     主题切换与语言切换才有一致入口。
//   - 视觉上独立于 unlocked 顶栏：浅底深字 + 暖色重点 + 大圆角，呈现
//     "首次进入应用时的完整 onboarding 体验"。
//   - header 自身不持有任何 wizard 状态：它只承担展示与切换入口。

import { ShieldCheck } from "lucide-react";
import { useI18n } from "@keymaster/runtime";
import { BrandIcon } from "./BrandIcon.js";
import { ThemeToggle } from "../theme/ThemeToggle.js";
import { LanguageSwitch } from "../i18n/LanguageSwitch.js";

export interface OnboardingHeaderProps {
  /**
   * 当处于窄屏时，安全提示文案可以折叠隐藏（避免拥挤）。
   * 默认始终显示。
   */
  hideSecurityNote?: boolean;
}

export function OnboardingHeader({ hideSecurityNote = false }: OnboardingHeaderProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();

  return (
    <header className="onboarding-header" role="banner">
      <div className="onboarding-header__row">
        <div className="onboarding-header__brand">
          <BrandIcon className="onboarding-header__brand-icon" />
          <div className="onboarding-header__brand-copy">
            <span className="onboarding-header__brand-mark">Keymaster</span>
            <span className="onboarding-header__brand-subtitle">
              {t("shell.onboarding.brandSubtitle", { defaultValue: "Local key vault" })}
            </span>
          </div>
        </div>
        <div className="onboarding-header__actions">
          <ThemeToggle variant="onboarding" />
          <LanguageSwitch />
        </div>
      </div>
      {hideSecurityNote ? null : (
        <p className="onboarding-header__note" aria-live="polite">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>
            {t("shell.onboarding.securityNote", {
              defaultValue:
                "Your keys never leave the browser. The password is never uploaded."
            })}
          </span>
        </p>
      )}
    </header>
  );
}
