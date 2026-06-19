// packages/plugin-key-import/src/ImportPage.tsx
// 导入页面：选择 importer -> 输入 -> 解析 -> 通过 vault 保存 -> 触发 key.imported。
// 设计缘由：平台只编排流程，不解析具体格式。
//
// bsv8 envelope 支持：
//   - 文件读取后能快速识别为 envelope 时，显示"导入源密码"输入框；
//   - parse 时把 password 放入 file/text input，parse 成功后立即清空密码输入。
//   - 密码只活在这一次 parse 闭包里，不进入 KeyImportResult / localStorage / IDB。
//
// 硬切换 003：所有展示文案走 i18n；KeyImportResult.summary 是 I18nText，
// 渲染时通过 host.i18n.text() 解析。
//
// 硬切换 010：本页面**只**服务"已解锁态导入更多 key"——首启导入第一把
// key 的入口是 LockedShell 里的首启导入向导（走
// `vault.createVaultWithImportedKey`），不再让本页面承担首启导入的职责。
// 已存在 Vault 且处于 uninitialized 状态不可达：首启导入通过 wizard 完成
// 之后 vault 状态就是 unlocked；但出于防御，页面挂载时仍 fail-closed 拒绝
// uninitialized / locked 状态，避免用户在"半路"看到 0-key 保存错误。
//
// 硬切换 012（施工单 001）：JSON importer 同时支持 file 与 text 两种来源，
// 输入区先让用户在"JSON 文件 / JSON 文本"之间二选一，再渲染对应控件；
// 切换方式时必须清理旧模式残留的状态。
//
// 硬切换 012 验收修复（施工单 001 复审）：
//   - 密码 label 不再固定"备份文件密码"：JSON 文本模式下显示"导入源密码"。
//   - isJsonImporter 走显式 id 判断（不再靠 supports 启发式）。

import { useEffect, useReducer } from "react";
import { Button, EmptyState, PageHeader, Select, TextArea, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type {
  ImporterRegistry,
  KeyImportResult,
  KeyImporter,
  MessageBus,
  VaultService
} from "@keymaster/contracts";
import { ImporterPicker } from "./ImporterPicker.js";
import { persistImport } from "./importFlow.js";
import {
  peekBsv8EnvelopeBytes,
  peekBsv8EnvelopeText
} from "./importFileSniff.js";
import {
  buildImportInput,
  initialJsonImportState,
  isJsonImporter,
  reduceJsonImport,
  type JsonInputMode,
  type JsonImportState
} from "./jsonImportStateMachine.js";

export function ImportPage() {
  const registry = useCapability<ImporterRegistry>("importer.registry");
  const vault = useCapability<VaultService>("vault.service");
  const messageBus = useCapability<MessageBus>("runtime.messageBus");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();

  // 硬切换 010：本页面只服务已解锁态导入更多 key。
  // - uninitialized：本应走 LockedShell 里的首启导入向导；如果意外
  //   跳转到这里（路由级 redirect 漏了），展示引导文案，不让用户
  //   在这里拼出一个空 Vault。
  // - locked：必须先解锁；不调 importer，避免让用户解析出私钥却无处
  //   保存。
  // - booting：尚在 bootstrap，按 locked 处理。
  const vaultStatus = vault.status();

  // 硬切换 012 验收修复：JSON importer 的输入与解析状态机收敛到 reducer。
  // 设计缘由：所有"切换 importer / 切换输入方式 / 切换文件 / 解析失败
  // 升密码"等关键不变量都集中在 jsonImportStateMachine 的 reducer 里，
  // 用纯函数测试覆盖，组件本身只负责渲染与发起 async parse。
  const [state, dispatch] = useReducer(reduceJsonImport, initialJsonImportState);
  const importer = state.importer;
  const jsonInputMode = state.jsonInputMode;

  useEffect(() => {
    if (state.result) return;
    // result 清空时（即导入完成 / reset 后），确保 password 也清空。
    if (state.password) {
      dispatch({ type: "set-password", password: "" });
    }
    // 仅依赖 result：其他字段变化不触发本 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.result]);

  if (vaultStatus !== "unlocked") {
    return (
      <div className="import-page">
        <PageHeader
          title={t("keyImport.page.title", { defaultValue: "导入私钥" })}
          description={t("keyImport.page.lockedHint", {
            defaultValue:
              "此页面仅用于在已解锁的钱包中导入更多 key。请先解锁 Vault，或返回欢迎页通过首启导入向导新建钱包并导入第一把 key。"
          })}
        />
      </div>
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    dispatch({
      type: "set-file",
      name: f.name,
      bytes,
      needsPassword: peekBsv8EnvelopeBytes(bytes)
    });
  }

  function clearFile() {
    dispatch({ type: "clear-file" });
  }

  /**
   * 文本输入时也用文本 sniff 决定是否升起密码框。
   * 设计缘由：JSON 文本模式与文件模式必须共用同一套"是否像 envelope"的
   * 嗅探逻辑。
   */
  function onTextChange(value: string) {
    const sniff = isJsonImporter(importer) ? peekBsv8EnvelopeText(value) : false;
    dispatch({ type: "set-text", text: value, needsPassword: sniff });
  }

  async function parse() {
    dispatch({ type: "parse-start" });
    try {
      const input = buildImportInput(state);
      if (!input || !importer) {
        dispatch({
          type: "parse-failure",
          error: t("keyImport.page.err.noFile", { defaultValue: "请先选择文件" })
        });
        return;
      }
      const r = await importer.parse(input);
      if (r.length === 0) {
        dispatch({
          type: "parse-failure",
          error: t("keyImport.page.err.noKey", { defaultValue: "未解析出私钥" })
        });
        return;
      }
      dispatch({ type: "parse-success", result: r[0] ?? null });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t("keyImport.page.err.parse", { defaultValue: "解析失败" });
      dispatch({ type: "parse-failure", error: msg });
    }
  }

  async function save() {
    if (!state.result || !importer) return;
    dispatch({ type: "parse-start" });
    try {
      await persistImport(vault, state.result, {
        label: state.label || `key-${Date.now()}`,
        capabilities: ["p2pkh"],
        source: importer.id
      });
      messageBus.publish("key.imported", { keyId: null });
      dispatch({ type: "reset" });
    } catch (err) {
      dispatch({
        type: "parse-failure",
        error:
          err instanceof Error
            ? err.message
            : t("keyImport.page.err.save", { defaultValue: "保存失败" })
      });
    }
  }

  // 当 reducer 处于 busy 状态时（parse / save 中）渲染 loading 标记。
  const busy = state.busy;

  // 文件 / 文本输入区的可见性派生：JSON importer 走 mode 切换；其它走 supports。
  const showJsonModeToggle = isJsonImporter(importer);
  const showTextInput =
    Boolean(importer) && !showJsonModeToggle && importer!.supports.includes("text");
  const showFileInput =
    Boolean(importer) && !showJsonModeToggle && importer!.supports.includes("file");

  // 是否升起密码框：JSON importer 看 needsPassword；其它 importer 仅在 file 模式下。
  const showPassword =
    (showJsonModeToggle && state.needsPassword) ||
    (Boolean(importer) && !showJsonModeToggle && state.needsPassword && Boolean(state.fileBytes));

  // 解析按钮是否可点：importer 已选；JSON 模式下要求有输入（文件已选 / 文本非空）；
  // 密码需求时必须已填密码。
  const canParse = (() => {
    if (!importer) return false;
    if (showJsonModeToggle) {
      if (jsonInputMode === "text") {
        if (state.text.trim().length === 0) return false;
      } else {
        if (!state.fileBytes) return false;
      }
    }
    if (state.needsPassword && !state.password) return false;
    return true;
  })();

  return (
    <div className="import-page">
      <PageHeader
        title={t("keyImport.page.title", { defaultValue: "导入私钥" })}
        description={t("keyImport.page.desc", {
          defaultValue: "选择导入方式，平台不会直接读取你的私钥；私钥始终只通过 Vault 加密保存。"
        })}
      />
      <section className="import-page__pickers">
        <h3>{t("keyImport.page.step.picker", { defaultValue: "1. 选择导入方式" })}</h3>
        <ImporterPicker
          selected={importer?.id}
          onSelect={(imp) => dispatch({ type: "pick-importer", importer: imp })}
        />
      </section>
      <section className="import-page__input">
        <h3>{t("keyImport.page.step.input", { defaultValue: "2. 输入" })}</h3>
        {showJsonModeToggle ? (
          <JsonModeInputs
            state={state}
            dispatch={dispatch}
            onFile={onFile}
            onTextChange={onTextChange}
            t={t}
          />
        ) : null}
        {showTextInput ? (
          <TextInput
            label={t("keyImport.page.label.text", { defaultValue: "文本" })}
            value={state.text}
            onChange={(e) => onTextChange(e.currentTarget.value)}
            placeholder={t("keyImport.page.placeholder.text", { defaultValue: "粘贴 WIF 或 hex 私钥" })}
          />
        ) : null}
        {showFileInput ? (
          <FilePicker
            fileName={state.fileName}
            onFile={onFile}
            onClear={clearFile}
            t={t}
          />
        ) : null}
        {showPassword ? (
          <TextInput
            label={t("keyImport.page.label.importPassword", { defaultValue: "导入源密码" })}
            type="password"
            autoComplete="off"
            value={state.password}
            onChange={(e) =>
              dispatch({ type: "set-password", password: e.currentTarget.value })
            }
            placeholder={t("keyImport.page.placeholder.importPassword", {
              defaultValue: "加密 JSON 的密码"
            })}
          />
        ) : null}
        <Button onClick={parse} loading={busy} disabled={!canParse}>
          {t("keyImport.page.action.parse", { defaultValue: "解析" })}
        </Button>
        {state.error ? <p className="import-page__error">{state.error}</p> : null}
      </section>
      {state.result ? (
        <section className="import-page__confirm">
          <h3>{t("keyImport.page.step.confirm", { defaultValue: "3. 确认导入" })}</h3>
          <p>
            {t("keyImport.page.detected", { defaultValue: "检测到：" })}
            {state.result.detectedFormat}
            {state.result.summary ? ` · ${host.i18n.text(state.result.summary)}` : ""}
          </p>
          <p>
            {t("keyImport.page.derived", { defaultValue: "派生地址：" })}
            {state.result.address ||
              t("keyImport.page.derivedPending", { defaultValue: "等待业务插件回填" })}
          </p>
          <TextInput
            label={t("keyImport.page.label.label", { defaultValue: "标签" })}
            value={state.label}
            onChange={(e) => dispatch({ type: "set-label", label: e.currentTarget.value })}
            placeholder={t("keyImport.page.placeholder.label", { defaultValue: "例如 主钱包 / 冷钱包" })}
          />
          <Button onClick={save} loading={busy} disabled={!state.result}>
            {t("keyImport.page.action.save", { defaultValue: "保存到 Vault" })}
          </Button>
        </section>
      ) : (
        !state.result && (
          <EmptyState
            title={t("keyImport.page.empty.title", { defaultValue: "等待解析" })}
            description={t("keyImport.page.empty.desc", { defaultValue: "解析成功后这里会显示派生地址和确认按钮。" })}
          />
        )
      )}
    </div>
  );
}

/** JSON importer 专属输入区：mode 切换 + file / text 分支。 */
function JsonModeInputs(props: {
  state: JsonImportState;
  dispatch: React.Dispatch<Parameters<typeof reduceJsonImport>[1]>;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onTextChange: (value: string) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const { state, dispatch, onFile, onTextChange, t } = props;
  return (
    <>
      <Select
        label={t("keyImport.page.label.inputMode", { defaultValue: "输入方式" })}
        value={state.jsonInputMode}
        onChange={(e) =>
          dispatch({
            type: "switch-input-mode",
            next: (e.currentTarget.value as JsonInputMode) ?? "file"
          })
        }
        options={[
          {
            value: "file",
            label: t("keyImport.page.option.jsonFile", { defaultValue: "JSON 文件" })
          },
          {
            value: "text",
            label: t("keyImport.page.option.jsonText", { defaultValue: "JSON 文本" })
          }
        ]}
      />
      {state.jsonInputMode === "text" ? (
        <TextArea
          label={t("keyImport.page.label.jsonText", { defaultValue: "JSON 文本" })}
          value={state.text}
          onChange={(e) => onTextChange(e.currentTarget.value)}
          placeholder={t("keyImport.page.placeholder.jsonText", {
            defaultValue: "粘贴从钱包导出的 JSON 内容"
          })}
          hint={t("keyImport.page.hint.jsonText", {
            defaultValue:
              "切换输入方式会清空当前文件 / 文本内容、密码草稿与解析结果。"
          })}
        />
      ) : (
        <FilePicker
          fileName={state.fileName}
          onFile={onFile}
          onClear={() => dispatch({ type: "clear-file" })}
          t={t}
        />
      )}
    </>
  );
}

/** 通用文件选择控件。 */
function FilePicker(props: {
  fileName: string | null;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  onClear: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const { fileName, onFile, onClear, t } = props;
  return (
    <label className="ui-field">
      <span className="ui-field__label">{t("keyImport.page.label.file", { defaultValue: "文件" })}</span>
      <input className="ui-input" type="file" onChange={onFile} />
      {fileName ? (
        <span className="ui-field__hint">
          {t("keyImport.page.filePicked", { defaultValue: "已选择：" })}
          {fileName}{" "}
          <button type="button" className="import-page__clear" onClick={onClear}>
            {t("keyImport.page.action.clear", { defaultValue: "清除" })}
          </button>
        </span>
      ) : null}
    </label>
  );
}