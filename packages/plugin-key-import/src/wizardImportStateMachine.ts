// packages/plugin-key-import/src/wizardImportStateMachine.ts
// 首启导入向导的输入与密码决策状态机（硬切换 011 + 012 验收覆盖）。
//
// 设计缘由：
//   - FirstTimeImportWizard 的关键不变量：
//       * 切换 importer / 切换输入方式 / 重新选文件 / 重新解析都必须清掉
//         旧的 resolvedImportPassword 与 importRequiredPassword。
//       * JSON 文本模式走完整 parse -> confirm -> set password 流程，
//         第 4 步能复用第 2 步实际用于解析的密码。
//       * 返回上一步 / 退到第 2 步重选输入方式时旧解析结果与旧密码决策
//         必须失效。
//   - 这套规则靠"组件内 useState + 多个 action 函数"实现时容易漏写某条
//     清零分支；硬切换 012 验收要求把动作收敛成 reducer，用纯函数测试
//     覆盖关键转换。
//   - 本文件**不**依赖 React，调用方把 reducer 包成 hook。
//
// 与 jsonImportStateMachine 的关系：
//   - 输入与解析层（text / file / password sniff / parse 成功失败）
//     复用 `reduceJsonImport` 的同款 action，wizard 只是把它包进 step
//     进度与密码决策中。
//   - 密码决策层（importRequiredPassword / resolvedImportPassword）属于
//     wizard 的"业务级"状态，本文件提供专用 action。

import type {
  KeyImportResult,
  KeyImporter
} from "@keymaster/contracts";
import {
  initialJsonImportState,
  reduceJsonImport,
  type JsonImportAction,
  type JsonImportState
} from "./jsonImportStateMachine.js";

/** wizard 的 4 步。 */
export type WizardStep =
  | "pick-importer"
  | "input"
  | "confirm-key"
  | "set-password";

export const STEP_ORDER: ReadonlyArray<WizardStep> = [
  "pick-importer",
  "input",
  "confirm-key",
  "set-password"
];

export function prevStepFor(step: WizardStep): WizardStep | null {
  switch (step) {
    case "pick-importer":
      return null;
    case "input":
      return "pick-importer";
    case "confirm-key":
      return "input";
    case "set-password":
      return "confirm-key";
  }
}

export interface WizardState {
  step: WizardStep;
  /** 派生自 JsonImportState 的输入与解析字段；reducer 透传。 */
  importState: JsonImportState;
  /**
   * 本次首启导入的输入**实际**是否需要导入源密码。
   * 仅在 step 4 用于决定是否展示"使用同一密码"勾选。
   * 派生规则：parse 成功时由 useEffect 根据 importState.needsPassword
   * 派生；reducer 在 reset / pick-importer / clear-password-decision
   * 时清零。
   */
  importRequiredPassword: boolean;
  /**
   * parse 成功后保存"已实际用于导入解析的密码"。**只活在 wizard 内存中**。
   * 重新选 importer / 重新选文件 / 重新解析时**必须**清空。
   */
  resolvedImportPassword: string | null;
  /** "使用同一密码"勾选。 */
  useSamePassword: boolean;
  /** 用户**新设**的本机系统锁屏密码草稿（双输入框）。 */
  vaultPasswordDraft: string;
  vaultPasswordConfirmDraft: string;
  /** 用户给 key 设的 label。reducer 仅透传，调用方负责持久化。 */
  label: string;
}

export const initialWizardState: WizardState = {
  step: "pick-importer",
  importState: initialJsonImportState,
  importRequiredPassword: false,
  resolvedImportPassword: null,
  useSamePassword: true,
  vaultPasswordDraft: "",
  vaultPasswordConfirmDraft: "",
  label: ""
};

/** wizard 专有的 action。 */
export type WizardAction =
  /** 透传给 JsonImportState 的 action。 */
  | { type: "import"; action: JsonImportAction }
  /** 切换 importer：必须清掉旧密码决策。 */
  | { type: "pick-importer"; importer: KeyImporter }
  /** 跳到下一步。调用方控制跳转合法性，reducer 不再校验。 */
  | { type: "goto-step"; step: WizardStep }
  /** 返回上一步。如果目标步包含旧解析结果，必须清空。 */
  | { type: "goto-prev" }
  /**
   * parse 成功：把 importPasswordDraft 转存为 resolvedImportPassword，
   * 然后跳到 confirm-key 步。
   * 设计缘由：硬切换 011 第 2 步 parse 成功后立即"转存"草稿密码，
   * 再让用户进入 confirm-key 步继续。
   */
  | {
      type: "parse-resolved";
      result: KeyImportResult;
      needsPassword: boolean;
      importPasswordDraft: string;
    }
  /** 切换 useSamePassword 勾选。 */
  | { type: "set-use-same-password"; value: boolean }
  /** 设置 vaultPasswordDraft。 */
  | { type: "set-vault-password-draft"; value: string }
  /** 设置 vaultPasswordConfirmDraft。 */
  | { type: "set-vault-password-confirm-draft"; value: string }
  /** 设置 label。 */
  | { type: "set-label"; value: string }
  /** 整页重置（finish 成功时调）。 */
  | { type: "reset" };

/**
 * 清掉所有与"上一次解析"相关的密码决策：解析结果 / 解析错误 /
 * resolvedImportPassword / importRequiredPassword。
 * 设计缘由：硬切换 011 强调"重新选 importer / 重新选文件 / 重新解析时
 * 必须清掉旧的 resolvedImportPassword 与 importRequiredPassword"。
 *
 * 本函数**不**spread 整个 `s`：调用方在 reducer 里已经在更外层处理
 * 字段冲突；这里只返回"被清掉的密码决策字段"。这样既避免后续 spread
 * 把刚 reset 的 importState 覆盖回旧值，也让 reducer 行为可预测。
 */
function clearPasswordDecision(): Pick<
  WizardState,
  "importRequiredPassword" | "resolvedImportPassword"
> {
  return {
    importRequiredPassword: false,
    resolvedImportPassword: null
  };
}

export function reduceWizard(
  state: WizardState,
  action: WizardAction
): WizardState {
  switch (action.type) {
    case "import": {
      // 任何 import 层的"set-text / set-file / pick-importer"等都可能
      // 让旧的密码决策失效：在 importState 改变后清掉密码决策。
      const nextImport = reduceJsonImport(state.importState, action.action);
      const passwordDecisionChanged =
        nextImport !== state.importState &&
        (action.action.type === "set-text" ||
          action.action.type === "set-file" ||
          action.action.type === "clear-file" ||
          action.action.type === "switch-input-mode" ||
          action.action.type === "pick-importer" ||
          action.action.type === "reset");
      return {
        ...state,
        importState: nextImport,
        // 任何旧密码草稿都已经不能复用 —— reducer 不能保存旧密码决策，
        // 调用方负责在"set-text / set-file / pick-importer"后清掉。
        ...(passwordDecisionChanged ? clearPasswordDecision() : {})
      };
    }
    case "pick-importer": {
      // 切 importer：必须清掉旧密码决策 + 旧 vault 密码草稿 + useSamePassword
      // 回到默认 true + step 回到 pick-importer（即使已经在 input / confirm
      // / set-password 步，也按"重选 importer"语义回第 1 步）。
      return {
        ...initialWizardState,
        importState: reduceJsonImport(state.importState, {
          type: "pick-importer",
          importer: action.importer
        }),
        label: state.label
      };
    }
    case "goto-step": {
      // 设计要点：goto-step 不能盲目清掉 importState——用户在第 1 步
      // 选完 importer 后点"Next"到 input 步时，**importer 必须保留**。
      // 只清掉"已经走完一轮流程"的解析结果与密码决策：
      //   - 从 confirm-key / set-password 退回 input 步（跳回旧步），
      //     旧 parse 结果 / 密码决策必须失效。
      //   - 从 pick-importer 前进到 input 步时（跳到下一步），保留
      //     importer 与所有已选输入。
      // 这里我们以"前进 vs 跳回"来区分：cur < target 为前进；其它为跳回。
      const cur = STEP_ORDER.indexOf(state.step);
      const target = STEP_ORDER.indexOf(action.step);
      const isBackward = cur >= 0 && target >= 0 && target <= cur;
      if (action.step === "input" && isBackward) {
        return {
          ...state,
          importState: reduceJsonImport(state.importState, { type: "clear-parse" }),
          ...clearPasswordDecision(),
          useSamePassword: true,
          vaultPasswordDraft: "",
          vaultPasswordConfirmDraft: "",
          step: action.step
        };
      }
      return { ...state, step: action.step };
    }
    case "goto-prev": {
      // 退到上一步：如果目标步是 input，意味着"返回第 2 步重选"，
      // 必须清掉旧解析结果与密码决策，但**保留**已选 importer 与
      // 当前输入（用户不应被强制重选 importer）。
      const prev = prevStepFor(state.step);
      if (!prev) return state; // 第 1 步返回：交给调用方触发 onCancel
      if (prev === "input") {
        return {
          ...state,
          importState: reduceJsonImport(state.importState, { type: "clear-parse" }),
          ...clearPasswordDecision(),
          useSamePassword: true,
          vaultPasswordDraft: "",
          vaultPasswordConfirmDraft: "",
          step: prev
        };
      }
      return { ...state, step: prev };
    }
    case "parse-resolved": {
      // 解析成功 → 把 importPasswordDraft 提升为 resolvedImportPassword，
      // 并跳到 confirm-key 步。needsPassword 决定 importRequiredPassword。
      const next: WizardState = {
        ...state,
        step: "confirm-key",
        importState: reduceJsonImport(state.importState, {
          type: "parse-success",
          result: action.result
        }),
        importRequiredPassword: action.needsPassword,
        resolvedImportPassword: action.needsPassword
          ? action.importPasswordDraft
          : null
      };
      return next;
    }
    case "set-use-same-password": {
      // 切换 useSamePassword 时清掉新设密码草稿：避免用户在两个互斥
      // 字段之间误填后产生残留。
      return {
        ...state,
        useSamePassword: action.value,
        vaultPasswordDraft: "",
        vaultPasswordConfirmDraft: ""
      };
    }
    case "set-vault-password-draft": {
      return { ...state, vaultPasswordDraft: action.value };
    }
    case "set-vault-password-confirm-draft": {
      return { ...state, vaultPasswordConfirmDraft: action.value };
    }
    case "set-label": {
      return { ...state, label: action.value };
    }
    case "reset": {
      // reset 是"整个 wizard 走完一次"或"finish 成功后"触发的入口；
      // 不保留 label——label 是单次导入会话内的临时输入，不应跨次保留。
      // 与 jsonImportStateMachine.reset 的"不保留 label"语义一致。
      return { ...initialWizardState };
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}