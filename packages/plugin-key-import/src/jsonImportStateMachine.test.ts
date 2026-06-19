// packages/plugin-key-import/src/jsonImportStateMachine.test.ts
// JSON importer 输入状态机的 reducer 单元测试（硬切换 012 / 施工单 001 验收）。
//
// 关键不变量：
//   1. 切换 JSON 输入方式（file <-> text）必须清掉另一种方式残留的：
//      文本值 / 文件名 / 文件字节 / 密码嗅探结果 / 密码草稿 / 解析结果 /
//      解析错误。
//   2. 切换 importer 时必须清掉旧 importer 的所有输入与解析状态。
//   3. parse 失败时如果错误是 PASSWORD_REQUIRED_MSG，必须升起密码框
//      （fail-open）。
//   4. parse 成功时清空密码草稿。
//   5. isJsonImporter 走显式 id 判断，不再用 supports 启发式。
//   6. buildImportInput 在 JSON text 模式下也能正确携带 password。

import { describe, expect, it } from "vitest";
import type { KeyImporter, KeyImportResult } from "@keymaster/contracts";
import {
  buildImportInput,
  initialJsonImportState,
  isJsonImporter,
  PASSWORD_REQUIRED_MSG,
  reduceJsonImport,
  type JsonImportState
} from "./jsonImportStateMachine.js";

const SAMPLE_HEX =
  "0000000000000000000000000000000000000000000000000000000000000003";

/** 一个最小的 JSON file importer。 */
const jsonImporter: KeyImporter = {
  id: "json-file",
  name: { key: "x", fallback: "JSON" },
  description: { key: "x", fallback: "" },
  supports: ["text", "file"],
  async parse() {
    return [];
  }
};

/** 一个仅支持 text 的 importer（模拟 WIF / Hex）。 */
const textOnlyImporter: KeyImporter = {
  id: "wif",
  name: { key: "x", fallback: "WIF" },
  description: { key: "x", fallback: "" },
  supports: ["text"],
  async parse() {
    return [];
  }
};

/** 一个仅支持 file 的 importer（边界测试用）。 */
const fileOnlyImporter: KeyImporter = {
  id: "file-only",
  name: { key: "x", fallback: "File" },
  description: { key: "x", fallback: "" },
  supports: ["file"],
  async parse() {
    return [];
  }
};

const sampleResult: KeyImportResult = {
  material: { hex: SAMPLE_HEX },
  address: "1abc",
  detectedFormat: "json-file"
};

/** 构造一个带文本 + 嗅探命中密码的状态。 */
function stateWithTextRequiringPassword(): JsonImportState {
  return {
    ...initialJsonImportState,
    importer: jsonImporter,
    jsonInputMode: "text",
    text: '{"version":"kek-v1"}',
    needsPassword: true,
    password: "draft-pw"
  };
}

/** 构造一个带文件 + 嗅探命中密码的状态。 */
function stateWithFileRequiringPassword(): JsonImportState {
  const bytes = new Uint8Array([0x7b, 0x22]); // "{" "
  return {
    ...initialJsonImportState,
    importer: jsonImporter,
    jsonInputMode: "file",
    fileName: "export.json",
    fileBytes: bytes,
    needsPassword: true,
    password: "draft-pw"
  };
}

describe("isJsonImporter (硬切换 012 验收修复)", () => {
  it("identifies json-file importer by explicit id", () => {
    expect(isJsonImporter(jsonImporter)).toBe(true);
  });

  it("rejects text-only importer even if it supports text + file", () => {
    // 验收修复：不再用 supports 启发式；只在 importer.id === "json-file" 时返回 true。
    expect(isJsonImporter(textOnlyImporter)).toBe(false);
    expect(isJsonImporter(fileOnlyImporter)).toBe(false);
  });

  it("rejects a hypothetical importer that supports text+file but is not JSON", () => {
    // 模拟未来仓库新增一个"既支持文本又支持文件但不是 JSON"的 importer；
    // 这种 importer 绝不能被错误套上 JSON 输入方式切换和 bsv8 嗅探逻辑。
    const dualNonJson: KeyImporter = {
      id: "some-other",
      name: { key: "x", fallback: "Other" },
      supports: ["text", "file"],
      async parse() {
        return [];
      }
    };
    expect(isJsonImporter(dualNonJson)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isJsonImporter(undefined)).toBe(false);
  });
});

describe("reduceJsonImport - pick-importer", () => {
  it("clears all input + parse state when switching importer", () => {
    const state = stateWithFileRequiringPassword();
    const next = reduceJsonImport(state, { type: "pick-importer", importer: textOnlyImporter });
    expect(next.importer).toBe(textOnlyImporter);
    expect(next.text).toBe("");
    expect(next.fileName).toBeNull();
    expect(next.fileBytes).toBeNull();
    expect(next.needsPassword).toBe(false);
    expect(next.password).toBe("");
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
    expect(next.jsonInputMode).toBe("file");
  });

  it("does not lose the in-progress label across pick-importer", () => {
    const state: JsonImportState = { ...initialJsonImportState, label: "my-key" };
    const next = reduceJsonImport(state, { type: "pick-importer", importer: jsonImporter });
    expect(next.label).toBe("my-key");
  });
});

describe("reduceJsonImport - switch-input-mode (硬切换 012 验收)", () => {
  it("file -> text clears file bytes / name / sniff / password draft", () => {
    const state = stateWithFileRequiringPassword();
    const next = reduceJsonImport(state, { type: "switch-input-mode", next: "text" });
    expect(next.jsonInputMode).toBe("text");
    expect(next.fileName).toBeNull();
    expect(next.fileBytes).toBeNull();
    expect(next.needsPassword).toBe(false);
    expect(next.password).toBe("");
  });

  it("text -> file clears text / sniff / password draft", () => {
    const state = stateWithTextRequiringPassword();
    const next = reduceJsonImport(state, { type: "switch-input-mode", next: "file" });
    expect(next.jsonInputMode).toBe("file");
    expect(next.text).toBe("");
    expect(next.needsPassword).toBe(false);
    expect(next.password).toBe("");
  });

  it("switching mode clears prior parse result and error", () => {
    const state: JsonImportState = {
      ...stateWithFileRequiringPassword(),
      result: sampleResult,
      error: "old error"
    };
    const next = reduceJsonImport(state, { type: "switch-input-mode", next: "text" });
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
  });

  it("switching to the same mode is a no-op (returns same state)", () => {
    const state = stateWithFileRequiringPassword();
    const next = reduceJsonImport(state, { type: "switch-input-mode", next: "file" });
    expect(next).toBe(state);
  });
});

describe("reduceJsonImport - set-text / set-file", () => {
  it("set-text updates text and sniffs for password requirement", () => {
    const state: JsonImportState = { ...initialJsonImportState, importer: jsonImporter };
    const next = reduceJsonImport(state, {
      type: "set-text",
      text: "plain",
      needsPassword: false
    });
    expect(next.text).toBe("plain");
    expect(next.needsPassword).toBe(false);
  });

  it("set-text clears any prior parse result + error", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      result: sampleResult,
      error: "x"
    };
    const next = reduceJsonImport(state, { type: "set-text", text: "y", needsPassword: false });
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
  });

  it("set-file updates file name + bytes + sniff", () => {
    const state: JsonImportState = { ...initialJsonImportState, importer: jsonImporter };
    const next = reduceJsonImport(state, {
      type: "set-file",
      name: "a.json",
      bytes: new Uint8Array([1, 2, 3]),
      needsPassword: true
    });
    expect(next.fileName).toBe("a.json");
    expect(next.fileBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(next.needsPassword).toBe(true);
    // 重新选文件时旧密码草稿清零。
    expect(next.password).toBe("");
  });

  it("clear-file wipes file state and parse result", () => {
    const state: JsonImportState = {
      ...stateWithFileRequiringPassword(),
      result: sampleResult,
      error: "x"
    };
    const next = reduceJsonImport(state, { type: "clear-file" });
    expect(next.fileName).toBeNull();
    expect(next.fileBytes).toBeNull();
    expect(next.needsPassword).toBe(false);
    expect(next.password).toBe("");
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
  });
});

describe("reduceJsonImport - parse lifecycle", () => {
  it("parse-start sets busy=true and clears error", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      error: "stale"
    };
    const next = reduceJsonImport(state, { type: "parse-start" });
    expect(next.busy).toBe(true);
    expect(next.error).toBeNull();
  });

  it("parse-success stores result and clears password draft", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      password: "draft"
    };
    const next = reduceJsonImport(state, { type: "parse-success", result: sampleResult });
    expect(next.result).toBe(sampleResult);
    expect(next.password).toBe("");
    expect(next.busy).toBe(false);
    expect(next.error).toBeNull();
  });

  it("parse-failure with PASSWORD_REQUIRED_MSG raises needsPassword (fail-open)", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "text",
      needsPassword: false
    };
    const next = reduceJsonImport(state, {
      type: "parse-failure",
      error: PASSWORD_REQUIRED_MSG
    });
    expect(next.needsPassword).toBe(true);
    expect(next.error).toBe(PASSWORD_REQUIRED_MSG);
    expect(next.busy).toBe(false);
  });

  it("parse-failure with non-password error does NOT raise needsPassword", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      needsPassword: false
    };
    const next = reduceJsonImport(state, { type: "parse-failure", error: "Invalid JSON" });
    expect(next.needsPassword).toBe(false);
    expect(next.error).toBe("Invalid JSON");
  });

  it("parse-failure on already-elevated needsPassword keeps it raised", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      needsPassword: true
    };
    const next = reduceJsonImport(state, { type: "parse-failure", error: "wrong pw" });
    expect(next.needsPassword).toBe(true);
  });

  it("reset wipes everything including label (no stale label across imports)", () => {
    // 关键不变量（施工单 001 复审回归）：已解锁导入页在一次导入成功后
    // 直接 dispatch reset；reset **不能**保留 label，否则下一次导入会
    // 不经意复用旧 label。旧实现是 setLabel("")，reducer 化后必须等价。
    const state: JsonImportState = {
      ...stateWithFileRequiringPassword(),
      label: "previous-key",
      busy: false,
      result: sampleResult,
      error: "x"
    };
    const next = reduceJsonImport(state, { type: "reset" });
    expect(next).toEqual(initialJsonImportState);
    expect(next.label).toBe("");
  });

  it("clear-parse keeps importer and inputs but wipes result/error/password", () => {
    const state: JsonImportState = {
      ...stateWithFileRequiringPassword(),
      label: "k",
      result: sampleResult,
      error: "old"
    };
    const next = reduceJsonImport(state, { type: "clear-parse" });
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
    expect(next.password).toBe("");
    // 保留 importer / file / jsonInputMode / label
    expect(next.importer?.id).toBe("json-file");
    expect(next.jsonInputMode).toBe("file");
    expect(next.fileName).toBe("export.json");
    expect(next.label).toBe("k");
  });
});

describe("buildImportInput", () => {
  it("returns null when importer is undefined", () => {
    expect(buildImportInput(initialJsonImportState)).toBeNull();
  });

  it("returns null when JSON file mode has no bytes selected", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "file"
    };
    expect(buildImportInput(state)).toBeNull();
  });

  it("builds text input for JSON text mode without password when not needed", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "text",
      text: '{"a":1}',
      needsPassword: false,
      password: "ignored"
    };
    expect(buildImportInput(state)).toEqual({
      kind: "text",
      text: '{"a":1}',
      password: undefined
    });
  });

  it("builds text input for JSON text mode WITH password when needsPassword", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "text",
      text: '{"a":1}',
      needsPassword: true,
      password: "secret"
    };
    expect(buildImportInput(state)).toEqual({
      kind: "text",
      text: '{"a":1}',
      password: "secret"
    });
  });

  it("builds file input for JSON file mode without password when not needed", () => {
    const bytes = new Uint8Array([1, 2]);
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "file",
      fileName: "exp.json",
      fileBytes: bytes
    };
    expect(buildImportInput(state)).toEqual({
      kind: "file",
      name: "exp.json",
      content: bytes,
      password: undefined
    });
  });

  it("builds file input for JSON file mode WITH password when needsPassword", () => {
    const bytes = new Uint8Array([1, 2]);
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: jsonImporter,
      jsonInputMode: "file",
      fileName: "exp.json",
      fileBytes: bytes,
      needsPassword: true,
      password: "secret"
    };
    expect(buildImportInput(state)).toEqual({
      kind: "file",
      name: "exp.json",
      content: bytes,
      password: "secret"
    });
  });

  it("text-only importer always returns text input", () => {
    const state: JsonImportState = {
      ...initialJsonImportState,
      importer: textOnlyImporter,
      text: "abc"
    };
    expect(buildImportInput(state)).toEqual({ kind: "text", text: "abc" });
  });
});