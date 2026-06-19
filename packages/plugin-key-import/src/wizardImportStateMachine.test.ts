// packages/plugin-key-import/src/wizardImportStateMachine.test.ts
// 首启导入向导状态机的 reducer 单元测试（硬切换 011 + 012 / 施工单 001 验收）。
//
// 关键不变量：
//   1. 切换 importer ⇒ 重置所有密码决策（resolvedImportPassword /
//      importRequiredPassword / vaultPassword* / useSamePassword 回到默认）。
//   2. 跳到第 2 步（input）⇒ 清掉旧解析结果与密码决策。
//   3. 退到上一步如果是 input ⇒ 同上。
//   4. parse-resolved 时如果 needsPassword 为 true ⇒ 把
//      importPasswordDraft 转存为 resolvedImportPassword。
//   5. parse-resolved 时如果 needsPassword 为 false ⇒ 不存
//      resolvedImportPassword。
//   6. set-text / set-file / clear-file / pick-importer 在 import 层
//      发生时必须联动清掉 wizard 层的密码决策。

import { describe, expect, it } from "vitest";
import type { KeyImporter, KeyImportResult } from "@keymaster/contracts";
import {
  initialWizardState,
  prevStepFor,
  reduceWizard,
  STEP_ORDER,
  type WizardState
} from "./wizardImportStateMachine.js";

const SAMPLE_HEX =
  "0000000000000000000000000000000000000000000000000000000000000003";

const jsonImporter: KeyImporter = {
  id: "json-file",
  name: { key: "x", fallback: "JSON" },
  supports: ["text", "file"],
  async parse() {
    return [];
  }
};

const sampleResult: KeyImportResult = {
  material: { hex: SAMPLE_HEX },
  address: "1abc",
  detectedFormat: "json-file"
};

/** 构造一个进入第 4 步之前、已经成功解析 bsv8 envelope 的状态。 */
function wizardWithResolvedImport(): WizardState {
  return {
    ...initialWizardState,
    step: "set-password",
    importState: {
      ...initialWizardState.importState,
      importer: jsonImporter,
      result: sampleResult
    },
    importRequiredPassword: true,
    resolvedImportPassword: "import-pw",
    useSamePassword: true
  };
}

describe("STEP_ORDER / prevStepFor", () => {
  it("returns the four steps in order", () => {
    expect(STEP_ORDER).toEqual([
      "pick-importer",
      "input",
      "confirm-key",
      "set-password"
    ]);
  });

  it("returns the previous step for each non-first step", () => {
    expect(prevStepFor("input")).toBe("pick-importer");
    expect(prevStepFor("confirm-key")).toBe("input");
    expect(prevStepFor("set-password")).toBe("confirm-key");
  });

  it("returns null when already at the first step", () => {
    expect(prevStepFor("pick-importer")).toBeNull();
  });
});

describe("reduceWizard - pick-importer (硬切换 011 验收)", () => {
  it("clears resolvedImportPassword and importRequiredPassword", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, { type: "pick-importer", importer: jsonImporter });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
    expect(next.step).toBe("pick-importer");
    expect(next.useSamePassword).toBe(true);
    expect(next.vaultPasswordDraft).toBe("");
    expect(next.vaultPasswordConfirmDraft).toBe("");
  });

  it("keeps the label across pick-importer", () => {
    const state: WizardState = { ...wizardWithResolvedImport(), label: "my-key" };
    const next = reduceWizard(state, { type: "pick-importer", importer: jsonImporter });
    expect(next.label).toBe("my-key");
  });
});

describe("reduceWizard - parse-resolved (硬切换 011 + 012 验收)", () => {
  it("stores resolvedImportPassword when needsPassword is true", () => {
    const state: WizardState = {
      ...initialWizardState,
      step: "input",
      importState: {
        ...initialWizardState.importState,
        importer: jsonImporter,
        jsonInputMode: "text",
        text: "encrypted",
        password: "the-import-pw"
      }
    };
    const next = reduceWizard(state, {
      type: "parse-resolved",
      result: sampleResult,
      needsPassword: true,
      importPasswordDraft: "the-import-pw"
    });
    expect(next.resolvedImportPassword).toBe("the-import-pw");
    expect(next.importRequiredPassword).toBe(true);
    expect(next.step).toBe("confirm-key");
  });

  it("does NOT store resolvedImportPassword when needsPassword is false", () => {
    const state: WizardState = {
      ...initialWizardState,
      step: "input",
      importState: {
        ...initialWizardState.importState,
        importer: jsonImporter,
        jsonInputMode: "text",
        text: "plain"
      }
    };
    const next = reduceWizard(state, {
      type: "parse-resolved",
      result: sampleResult,
      needsPassword: false,
      importPasswordDraft: ""
    });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
    expect(next.step).toBe("confirm-key");
  });

  it("JSON text path with bsv8 envelope: the wizard reuses the import password in step 4", () => {
    // 端到端流程：选 importer -> 文本 -> 嗅探 -> 填密码 -> parse -> confirm -> step 4 复用。
    let s: WizardState = initialWizardState;
    s = reduceWizard(s, { type: "pick-importer", importer: jsonImporter });
    s = reduceWizard(s, { type: "goto-step", step: "input" });
    // 模拟用户粘贴了一段加密 JSON 文本；onTextChange 把 needsPassword 升 true。
    s = reduceWizard(s, {
      type: "import",
      action: { type: "set-text", text: '{"version":"kek-v1"}', needsPassword: true }
    });
    // 用户填密码草稿。
    s = reduceWizard(s, {
      type: "import",
      action: { type: "set-password", password: "secret-123" }
    });
    // parse 成功。
    s = reduceWizard(s, {
      type: "parse-resolved",
      result: sampleResult,
      needsPassword: true,
      importPasswordDraft: "secret-123"
    });
    expect(s.resolvedImportPassword).toBe("secret-123");
    expect(s.importRequiredPassword).toBe(true);
    expect(s.useSamePassword).toBe(true);
    expect(s.step).toBe("confirm-key");
  });
});

describe("reduceWizard - going back to step 2 (硬切换 011 验收)", () => {
  it("goto-step input from confirm-key wipes parse result + password decision (keeps importer)", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, { type: "goto-step", step: "input" });
    expect(next.step).toBe("input");
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
    expect(next.importState.result).toBeNull();
    // 硬切换 012 验收修复：从 confirm-key 退回 input 时**保留** importer，
    // 否则用户必须重新选择格式才能继续。
    expect(next.importState.importer?.id).toBe("json-file");
    expect(next.useSamePassword).toBe(true);
    expect(next.vaultPasswordDraft).toBe("");
    expect(next.vaultPasswordConfirmDraft).toBe("");
  });

  it("goto-step input from pick-importer (forward) keeps importer", () => {
    let s: WizardState = initialWizardState;
    s = reduceWizard(s, { type: "pick-importer", importer: jsonImporter });
    s = reduceWizard(s, { type: "goto-step", step: "input" });
    // 前进到 input 步：importer 必须保留。
    expect(s.importState.importer?.id).toBe("json-file");
    expect(s.step).toBe("input");
  });

  it("goto-prev from set-password to confirm-key does NOT wipe parse result", () => {
    // 退到 confirm-key 不应该清掉 result——只退到 input 才清。
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, { type: "goto-prev" });
    expect(next.step).toBe("confirm-key");
    expect(next.resolvedImportPassword).toBe("import-pw");
    expect(next.importRequiredPassword).toBe(true);
  });

  it("goto-prev from confirm-key to input wipes parse result + password decision (keeps importer)", () => {
    const state: WizardState = {
      ...initialWizardState,
      step: "confirm-key",
      importState: {
        ...initialWizardState.importState,
        importer: jsonImporter,
        result: sampleResult
      },
      importRequiredPassword: true,
      resolvedImportPassword: "import-pw",
      useSamePassword: true
    };
    const next = reduceWizard(state, { type: "goto-prev" });
    expect(next.step).toBe("input");
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
    expect(next.importState.result).toBeNull();
    // 硬切换 012 验收修复：保留 importer。
    expect(next.importState.importer?.id).toBe("json-file");
  });

  it("goto-prev from pick-importer is a no-op (onCancel handled by caller)", () => {
    const state = initialWizardState;
    const next = reduceWizard(state, { type: "goto-prev" });
    expect(next).toBe(state);
  });
});

describe("reduceWizard - import layer actions wipe password decision", () => {
  it("set-text wipes password decision (input layer change invalidates resolved)", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, {
      type: "import",
      action: { type: "set-text", text: "new", needsPassword: false }
    });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
  });

  it("set-file wipes password decision", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, {
      type: "import",
      action: {
        type: "set-file",
        name: "x.json",
        bytes: new Uint8Array([1]),
        needsPassword: true
      }
    });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
  });

  it("clear-file wipes password decision", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, {
      type: "import",
      action: { type: "clear-file" }
    });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
  });

  it("switch-input-mode wipes password decision", () => {
    const state: WizardState = {
      ...wizardWithResolvedImport(),
      importState: {
        ...wizardWithResolvedImport().importState,
        jsonInputMode: "file",
        fileName: "x.json",
        fileBytes: new Uint8Array([1])
      }
    };
    const next = reduceWizard(state, {
      type: "import",
      action: { type: "switch-input-mode", next: "text" }
    });
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
  });
});

describe("reduceWizard - use-same-password toggle", () => {
  it("toggling clears vault password drafts (互斥字段)", () => {
    const state: WizardState = {
      ...wizardWithResolvedImport(),
      useSamePassword: false,
      vaultPasswordDraft: "old",
      vaultPasswordConfirmDraft: "old"
    };
    const next = reduceWizard(state, {
      type: "set-use-same-password",
      value: true
    });
    expect(next.useSamePassword).toBe(true);
    expect(next.vaultPasswordDraft).toBe("");
    expect(next.vaultPasswordConfirmDraft).toBe("");
  });
});

describe("reduceWizard - reset", () => {
  it("reset wipes everything including label (no stale label across sessions)", () => {
    const state = wizardWithResolvedImport();
    const next = reduceWizard(state, { type: "reset" });
    expect(next.step).toBe("pick-importer");
    expect(next.resolvedImportPassword).toBeNull();
    expect(next.importRequiredPassword).toBe(false);
    expect(next.label).toBe("");
  });
});