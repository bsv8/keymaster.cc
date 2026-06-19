// packages/plugin-key-import/src/jsonImportStateMachine.ts
// JSON importer 输入状态机（硬切换 012 验收覆盖）。
//
// 设计缘由：
//   - ImportPage 与 FirstTimeImportWizard 都共享同一套 JSON 文件 / 文本
//     输入方式切换 + bsv8 envelope 嗅探 + 密码草稿 + 解析结果清理逻辑。
//     这套逻辑是施工单 001 验收的关键不变量，必须可独立测试。
//   - 这里把状态机的"动作 -> 状态派生"收敛到一个 reducer，
//     让 ImportPage / 向导各自把它包成 hook 调用，并把页面级验收测试
//     收敛到这个 reducer 的纯函数测试上。
//   - reducer **不**做 async；调用方负责驱动 importer.parse() 并把结果
//     通过 action 提交回来。
//
// 关键不变量（对应施工单 001 验收清单）：
//   1. 切换 JSON 输入方式（file <-> text）必须清掉另一种方式残留的：
//      文本值 / 文件名 / 文件字节 / 密码嗅探结果 / 密码草稿 / 解析结果 /
//      解析错误 / 密码决策（resolvedImportPassword）。
//   2. 切换 importer 时必须清掉旧 importer 的所有输入与解析状态。
//   3. parse 失败时如果错误是 PASSWORD_REQUIRED_MSG，必须升起密码框。
//   4. parse 成功时只保留解析结果，并清空密码草稿（密码决策由调用方
//      决定是否转存为 resolvedImportPassword）。
//   5. fail-open：嗅探未命中但 parse 抛出密码缺失时，仍然升起密码框。

import type {
  KeyImportInput,
  KeyImportResult,
  KeyImporter
} from "@keymaster/contracts";

/** 与 ImportPage / 向导保持一致的 bsv8 密码缺失错误。 */
export const PASSWORD_REQUIRED_MSG = "Password is required for encrypted key file";

/** JSON importer 的输入方式。 */
export type JsonInputMode = "file" | "text";

/**
 * 硬切换 012（验收修复）：判断当前 importer 是否走 JSON 输入方式切换。
 *
 * 设计缘由：旧实现靠"同时支持 text 和 file"做启发式判断；施工单 001 验收
 * 修复指出这会让未来任何"同时支持 text 和 file 但不是 JSON"的 importer
 * 被错误套上 JSON 文件/文本切换和 bsv8 嗅探逻辑。本判断**显式**走
 * `importer.id === "json-file"`：如果未来出现多个 JSON 风格 importer，应
 * 让它们共用一个明确的 id 集合（例如 `"json-file"` / `"json-v2"`），
 * 或显式扩展本函数，而不是再用 `supports` 启发式。
 */
export function isJsonImporter(importer: KeyImporter | undefined): boolean {
  return Boolean(importer && importer.id === "json-file");
}

/** 状态机持有的输入与解析状态。 */
export interface JsonImportState {
  importer: KeyImporter | undefined;
  /** 仅当 isJsonImporter(importer) 时被读取与切换。 */
  jsonInputMode: JsonInputMode;
  text: string;
  fileName: string | null;
  fileBytes: Uint8Array | null;
  needsPassword: boolean;
  password: string;
  /** parse() 返回的第一条结果；reset 时清空。 */
  result: KeyImportResult | null;
  /** 上一次 parse / save 失败的错误信息；reset 时清空。 */
  error: string | null;
  /** parse 是否正在进行中；调用方控制，reducer 不修改。 */
  busy: boolean;
  /** 调用方填的 label；reducer 不感知业务，仅保留最新值。 */
  label: string;
}

export const initialJsonImportState: JsonImportState = {
  importer: undefined,
  jsonInputMode: "file",
  text: "",
  fileName: null,
  fileBytes: null,
  needsPassword: false,
  password: "",
  result: null,
  error: null,
  busy: false,
  label: ""
};

/** reducer action 类型。 */
export type JsonImportAction =
  /** 选中一个 importer：必须清掉旧 importer 的所有输入与解析状态。 */
  | { type: "pick-importer"; importer: KeyImporter }
  /** 切换 JSON 输入方式；必须清掉另一种方式的残留。 */
  | { type: "switch-input-mode"; next: JsonInputMode }
  /** 设置文本。 */
  | { type: "set-text"; text: string; needsPassword: boolean }
  /** 设置已选文件（来自 <input type="file">）。 */
  | {
      type: "set-file";
      name: string;
      bytes: Uint8Array;
      needsPassword: boolean;
    }
  /** 清掉文件选择。 */
  | { type: "clear-file" }
  /** 设置密码草稿。 */
  | { type: "set-password"; password: string }
  /** 开始 parse。reducer 把 busy=true，error 清空。 */
  | { type: "parse-start" }
  /** parse 成功：保存结果，清空密码草稿。 */
  | { type: "parse-success"; result: KeyImportResult | null }
  /** parse 失败：保存错误；如果错误是 PASSWORD_REQUIRED_MSG，升起密码框。 */
  | { type: "parse-failure"; error: string }
  /** parse / save 结束：busy=false。 */
  | { type: "parse-end" }
  /** 设置 label（reducer 仅透传，调用方负责持久化）。 */
  | { type: "set-label"; label: string }
  /**
   * 软重置：清掉"已完成的解析结果 + 错误 + 密码草稿"，**保留**
   * importer 与当前输入值。
   * 设计缘由：用户在向导里从 confirm-key / set-password 退回 input 步
   * 时希望保留已选 importer / 文件 / 文本，但 parse 结果与密码决策
   * 必须失效——否则第 4 步会基于旧密码复用。
   */
  | { type: "clear-parse" }
  /** 整页重置：调用方在 save 成功后调用。 */
  | { type: "reset" };

/**
 * 清掉"文件模式"的所有残留：文件 / 密码嗅探 / 密码草稿。
 * 设计缘由：硬切换 012（施工单 001 验收修复）要求切换到 text 时
 * 必须清掉文件相关全部状态；同样适用于 pick-importer 后旧 importer
 * 是 file 模式的情况。
 */
function clearFileBranch(state: JsonImportState): JsonImportState {
  return {
    ...state,
    fileName: null,
    fileBytes: null,
    needsPassword: false,
    password: ""
  };
}

/** 清掉"文本模式"的所有残留。 */
function clearTextBranch(state: JsonImportState): JsonImportState {
  return {
    ...state,
    text: "",
    needsPassword: false,
    password: ""
  };
}

/** 清掉所有解析相关的瞬时态：解析结果 / 解析错误 / 密码决策标记。 */
function clearParseBranch(state: JsonImportState): JsonImportState {
  return {
    ...state,
    result: null,
    error: null
  };
}

/**
 * JSON importer 输入状态机的纯 reducer。
 * 设计缘由：让 ImportPage 与 FirstTimeImportWizard 共享同一套状态转移规则，
 * 并把页面级验收测试收敛到 reducer 单测上（不依赖 React DOM）。
 */
export function reduceJsonImport(
  state: JsonImportState,
  action: JsonImportAction
): JsonImportState {
  switch (action.type) {
    case "pick-importer": {
      // 切换 importer ⇒ 全部输入与解析状态都要清零；
      // 包括 jsonInputMode 重置为默认 "file"。
      return {
        ...initialJsonImportState,
        importer: action.importer,
        label: state.label,
        busy: state.busy
      };
    }
    case "switch-input-mode": {
      if (state.jsonInputMode === action.next) return state;
      // 切换模式前先清掉所有解析相关瞬时态，避免旧模式下的
      // 结果 / 错误跨模式残留。
      const cleared = clearParseBranch(state);
      if (action.next === "text") {
        return {
          ...clearFileBranch(cleared),
          jsonInputMode: "text"
        };
      }
      return {
        ...clearTextBranch(cleared),
        jsonInputMode: "file"
      };
    }
    case "set-text": {
      return {
        ...state,
        text: action.text,
        needsPassword: action.needsPassword,
        // 重新输入文本 ⇒ 旧的解析结果与错误已失效。
        result: null,
        error: null
      };
    }
    case "set-file": {
      return {
        ...state,
        fileName: action.name,
        fileBytes: action.bytes,
        needsPassword: action.needsPassword,
        password: "",
        // 重新选文件 ⇒ 旧的解析结果与错误已失效。
        result: null,
        error: null
      };
    }
    case "clear-file": {
      return clearFileBranch(clearParseBranch(state));
    }
    case "set-password": {
      return { ...state, password: action.password };
    }
    case "parse-start": {
      return { ...state, busy: true, error: null };
    }
    case "parse-success": {
      // 解析成功：保留 result，清掉密码草稿。密码决策由调用方负责
      // 把 importPasswordDraft 转存为 resolvedImportPassword（reducer
      // 不知道那个字段，那是 wizard 的额外状态）。
      return {
        ...state,
        busy: false,
        result: action.result,
        password: "",
        error: null
      };
    }
    case "parse-failure": {
      // fail-open：若错误是密码缺失，立即把 needsPassword 升起来，
      // 让用户补密码后再次解析。这条规则对 file 与 text 来源都生效。
      const isPasswordRequired = action.error === PASSWORD_REQUIRED_MSG;
      return {
        ...state,
        busy: false,
        error: action.error,
        needsPassword: state.needsPassword || isPasswordRequired
      };
    }
    case "parse-end": {
      return { ...state, busy: false };
    }
    case "set-label": {
      return { ...state, label: action.label };
    }
    case "clear-parse": {
      // 软重置：保留 importer / text / file / jsonInputMode / label；
      // 清掉 result / error / password 草稿。
      return {
        ...state,
        result: null,
        error: null,
        password: ""
      };
    }
    case "reset": {
      // reset 是"导入完成后整体回到干净状态"的入口；它**不能**保留
      // label——已解锁导入页用户连续导入多把 key 时，旧 label 会
      // 不经意被复用。设计缘由（施工单 001 复审回归）：
      //   - 旧实现 save 成功后显式 setLabel("")；
      //   - 现在的 reducer 化 reset 必须等价于此行为，否则就是回归。
      // busy 也清零：reset 通常在 parse / save 完成后触发，busy 在
      // parse-end 已经清零，但这里保险再清一次。
      return { ...initialJsonImportState };
    }
    default: {
      // exhaustiveness check
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

/**
 * 根据当前状态构造送给 importer.parse() 的标准化 KeyImportInput。
 * 设计缘由：reducer 只管输入状态；具体如何把状态映射成 importer 输入是
 * 派生逻辑，独立成函数以便单测覆盖 file / text 两条分支以及密码语义。
 *
 * 调用方必须保证 `state.importer` 已设置；本函数不抛错，由调用方决定
 * 缺 importer 时返回 null 还是抛错。
 */
export function buildImportInput(
  state: JsonImportState
): KeyImportInput | null {
  if (!state.importer) return null;
  if (isJsonImporter(state.importer)) {
    if (state.jsonInputMode === "text") {
      return {
        kind: "text",
        text: state.text,
        password: state.needsPassword ? state.password : undefined
      };
    }
    if (!state.fileBytes) return null;
    return {
      kind: "file",
      name: state.fileName ?? "blob",
      content: state.fileBytes,
      password: state.needsPassword ? state.password : undefined
    };
  }
  if (state.importer.supports.includes("file") && state.fileBytes) {
    return {
      kind: "file",
      name: state.fileName ?? "blob",
      content: state.fileBytes,
      password: state.needsPassword ? state.password : undefined
    };
  }
  return { kind: "text", text: state.text };
}