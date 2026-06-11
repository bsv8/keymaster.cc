// apps/web/src/shell/StepProgress.tsx
// 首启导入向导步骤进度：有状态的步骤指示器，**不是**可任意跳转的 tabs。
//
// 设计缘由：
//   - 业务顺序固定为 4 步（选择方式 → 输入材料 → 确认结果 → 设置锁屏密码）。
//   - 当前步骤高亮，已完成步骤显示完成态，未到达步骤显示未激活态。
//   - 允许点击返回到**已完成**步骤；不允许点击跳转到**未来**步骤——
//     UI 必须真实反映状态机，而不是诱导用户绕过验证。
//   - 文案进入 i18n；视觉与 onboarding 主面板一体化（暖色圆角、圆点、
//     连线）。

import { Check } from "lucide-react";
import { useI18n } from "@keymaster/runtime";

export type StepState = "done" | "current" | "upcoming";

export interface StepDefinition {
  /** 内部 ID，仅用于 React key。 */
  id: string;
  /** i18n key，resources.ts 里 step label。 */
  labelKey: string;
  /** i18n key 的默认 fallback。 */
  defaultLabel: string;
}

export interface StepProgressProps {
  steps: ReadonlyArray<StepDefinition>;
  /** 当前步骤的 index（0-based）。 */
  currentIndex: number;
  /** 已完成步骤的最高 index（exclusive），例如 3 表示 0/1/2 已完成。 */
  doneUpToIndex: number;
  /**
   * 用户点击某一步时触发。**父组件**决定是否允许跳转；本组件只
   * 渲染"可点"或"禁点"的视觉，**不**自行决定业务规则。
   */
  onStepClick?: (index: number) => void;
}

function stateOf(i: number, currentIndex: number, doneUpToIndex: number): StepState {
  if (i < doneUpToIndex) return "done";
  if (i === currentIndex) return "current";
  return "upcoming";
}

export function StepProgress({
  steps,
  currentIndex,
  doneUpToIndex,
  onStepClick
}: StepProgressProps) {
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();

  return (
    <nav
      className="step-progress"
      role="navigation"
      aria-label={t("shell.onboarding.step.navLabel", {
        defaultValue: "Import wizard steps"
      })}
    >
      <ol className="step-progress__list">
        {steps.map((step, i) => {
          const state = stateOf(i, currentIndex, doneUpToIndex);
          // 仅允许"已完成"或"当前"步骤被点击——未来步骤一律禁点。
          // 这一约束必须在 UI 层强制：用户对进度条的核心预期就是
          // "做过的能回看，没做过的不能跳"。
          const clickable = state !== "upcoming" && Boolean(onStepClick);
          const Tag = clickable ? "button" : "div";
          return (
            <li
              key={step.id}
              className={`step-progress__item step-progress__item--${state}`}
            >
              {i > 0 ? <span className="step-progress__connector" aria-hidden="true" /> : null}
              <Tag
                type={clickable ? "button" : undefined}
                className="step-progress__node"
                aria-current={state === "current" ? "step" : undefined}
                disabled={!clickable}
                onClick={
                  clickable && onStepClick
                    ? () => onStepClick(i)
                    : undefined
                }
                title={t(
                  state === "current"
                    ? "shell.onboarding.step.state.current"
                    : state === "done"
                    ? "shell.onboarding.step.state.done"
                    : "shell.onboarding.step.state.upcoming",
                  {
                    defaultValue:
                      state === "current"
                        ? "Current"
                        : state === "done"
                        ? "Done"
                        : "Upcoming"
                  }
                )}
              >
                <span className="step-progress__index" aria-hidden="true">
                  {state === "done" ? <Check size={12} /> : i + 1}
                </span>
                <span className="step-progress__label">
                  {t(step.labelKey, { defaultValue: step.defaultLabel })}
                </span>
              </Tag>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
