// apps/web/src/shell/FirstTimeImportWizard.tsx
// 首启"导入私钥"向导（硬切换 011 + 012）：
//   业务流程固定为：
//     1) 选择导入类型（importer）
//     2) 输入 / 解析导入材料
//     3) 解析成功后决定本机系统锁屏密码
//     4) 调 vault.createVaultWithImportedKey(...)：一次性建 Vault +
//        落首把导入 Key + 切 active
//   整个流程在用户**没有创建 Vault**之前完成；首启导入完成后 vault
//   自动进入 unlocked，App 切到 UnlockedShell，本向导自然卸载。
//
// 硬切换 011：密码状态机重新拆分为：
//   - importPasswordDraft：第 2 步输入框的未提交草稿。
//   - resolvedImportPassword：parse 成功后保存在本次 wizard 内存中的
//     "已实际用于导入解析的密码"。**只活在 wizard 生命周期内**。
//   - vaultPasswordDraft / vaultPasswordConfirmDraft：用户**新设**的
//     本机系统锁屏密码（双输入框，仅在取消"使用同一密码"时使用）。
//
// 第 4 步复用规则（硬切换 011）：
//   - importRequiredPassword === true 且 useSamePassword === true：
//       复用 resolvedImportPassword。**不**渲染任何密码输入框，
//       仅展示"将复用第 2 步已输入的解密密码"说明。
//   - importRequiredPassword === true 且 useSamePassword === false：
//       必须输入"新密码 + 确认密码"。
//   - importRequiredPassword === false（明文路径）：
//       强制"新密码 + 确认密码"；不显示"使用同一密码"勾选。
//
// 硬切换 012（施工单 001）：JSON importer 同时支持 file 与 text 两种来源；
// 第 2 步先让用户选"输入方式"，再渲染对应控件；切换方式 / 切换 importer /
// 重新解析时必须清掉旧模式残留的所有状态。`resolvedImportPassword` 的复用
// 语义对文本 / 文件完全一致。
//
// 硬切换 012 验收修复（施工单 001 复审）：
//   - 状态机拆分为两层 reducer：importState（plugin-key-import 提供的
//     纯函数 reducer）+ wizard 顶层 reducer（包裹 step / 密码决策 /
//     vaultPassword*）。所有验收关键不变量都用纯函数测试覆盖。
//   - 密码 label 不再固定"备份文件密码"：JSON 文本模式下显示"导入源密码"。
//   - isJsonImporter 走显式 id 判断（不再靠 supports 启发式）。
//
// 设计缘由：
//   - 解析失败时 importPasswordDraft 必须保留以便用户重试；
//     解析成功时才把草稿"转存"为 resolvedImportPassword。
//   - 重新选 importer / 重新选文件 / 重新解析后，必须清掉旧的
//     resolvedImportPassword、旧的 importRequiredPassword，否则第 4 步
//     会基于已失效的"曾经用过的密码"复用。
//   - 关闭向导 / 刷新页面 / 返回欢迎页：本次导入会话整体丢弃。
//   - 私钥材料**不**写 localStorage / IndexedDB / URL / 长期 React state。
//   - 主题/语言切换不影响当前 step、已选 importer、文件、解析结果和
//     密码内存态——只切换展示。
//
// 不能怎么做：
//   - 不能在 parse 成功后立刻清空 importPasswordDraft，然后让第 4 步
//     重新索取同一密码——那是伪复用。
//   - 不能把 importPasswordDraft / resolvedImportPassword 写到
//     localStorage、IndexedDB、URL、MessageBus payload。
//   - 不能让用户通过 step progress 跳到尚未满足前置条件的步骤。
//   - 不能在第 4 步复用时仍渲染密码输入框。
//   - 不能在"明文导入"路径下保留"单输入框无 confirm"的新密码流程。

import { useEffect, useReducer } from "react";
import { Button, PageHeader, Select, TextArea, TextInput } from "@keymaster/ui";
import {
  useCapability,
  useI18n,
  usePluginHost
} from "@keymaster/runtime";
import {
  KeyPersistedButActivationFailedError,
  type KeyImportResult,
  type KeyImporter,
  type PrivateKeyMaterial,
  type VaultService
} from "@keymaster/contracts";
import { ImporterPicker } from "@keymaster/plugin-key-import/ImporterPicker";
import {
  peekBsv8EnvelopeBytes,
  peekBsv8EnvelopeText
} from "@keymaster/plugin-key-import/importFileSniff";
import {
  buildImportInput,
  isJsonImporter,
  type JsonInputMode
} from "@keymaster/plugin-key-import/jsonImportStateMachine";
import {
  initialWizardState,
  prevStepFor,
  reduceWizard,
  STEP_ORDER,
  type WizardState
} from "@keymaster/plugin-key-import/wizardImportStateMachine";
import {
  StepProgress,
  type StepDefinition
} from "./StepProgress.js";

/** Importer parse 抛出的密码缺失错误——和 ImportPage 保持一致。 */
const PASSWORD_REQUIRED_MSG = "Password is required for encrypted key file";

/** 与 wizard 状态机的 step 顺序一一对应的 label 定义。 */
const STEP_DEFINITIONS: ReadonlyArray<StepDefinition> = [
  {
    id: "pick-importer",
    labelKey: "shell.onboarding.step.pickImporter",
    defaultLabel: "Pick a format"
  },
  {
    id: "input",
    labelKey: "shell.onboarding.step.input",
    defaultLabel: "Provide material"
  },
  {
    id: "confirm-key",
    labelKey: "shell.onboarding.step.confirmKey",
    defaultLabel: "Confirm result"
  },
  {
    id: "set-password",
    labelKey: "shell.onboarding.step.setPassword",
    defaultLabel: "Set lock password"
  }
];

export interface FirstTimeImportWizardProps {
  /** 用户点"返回"回到欢迎页时触发。 */
  onCancel(): void;
}

export function FirstTimeImportWizard({ onCancel }: FirstTimeImportWizardProps) {
  const vault = useCapability<VaultService>("vault.service");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();

  // 硬切换 012 验收修复：所有 wizard 状态机收敛到 reducer；
  // 组件本身只负责发起 async parse + 调用 vault.createVaultWithImportedKey。
  const [state, dispatch] = useReducer(reduceWizard, initialWizardState);
  const step = state.step;
  const importer = state.importState.importer;
  const jsonInputMode = state.importState.jsonInputMode;
  const importPasswordDraft = state.importState.password;

  // 解析成功后由 useEffect 把 importPasswordDraft 转存为
  // resolvedImportPassword 的逻辑已并入 reducer 的 `parse-resolved`
  // action；这里只剩一个无害的 language() 订阅用于触发重渲染。

  useEffect(() => {
    // 仅用于在语言切换时强制 wizard 重渲染。
    void host.i18n.language();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.i18n.language()]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    dispatch({
      type: "import",
      action: {
        type: "set-file",
        name: f.name,
        bytes,
        needsPassword: peekBsv8EnvelopeBytes(bytes)
      }
    });
  }

  function clearFile() {
    dispatch({ type: "import", action: { type: "clear-file" } });
  }

  /**
   * 硬切换 012：文本输入实时嗅探 envelope，命中即升起密码框。
   * 与文件模式共用同一套"是否像 envelope"的嗅探逻辑。
   */
  function onTextChange(value: string) {
    const sniff = isJsonImporter(importer) ? peekBsv8EnvelopeText(value) : false;
    dispatch({ type: "import", action: { type: "set-text", text: value, needsPassword: sniff } });
  }

  async function parse() {
    dispatch({ type: "import", action: { type: "parse-start" } });
    try {
      const input = buildImportInput(state.importState);
      if (!input || !importer) {
        dispatch({
          type: "import",
          action: {
            type: "parse-failure",
            error: t("keyImport.page.err.noFile", { defaultValue: "请先选择 JSON 文件" })
          }
        });
        return;
      }
      const r = await importer.parse(input);
      if (r.length === 0) {
        dispatch({
          type: "import",
          action: {
            type: "parse-failure",
            error: t("keyImport.page.err.noKey", { defaultValue: "未解析出私钥" })
          }
        });
        return;
      }
      const result = r[0]!;
      // reducer 内一并处理：转存 resolvedImportPassword + 跳到 confirm-key。
      dispatch({
        type: "parse-resolved",
        result,
        needsPassword: state.importState.needsPassword,
        importPasswordDraft
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t("keyImport.page.err.parse", { defaultValue: "解析失败" });
      // fail-open：parse-failure reducer 已会处理 PASSWORD_REQUIRED_MSG。
      dispatch({ type: "import", action: { type: "parse-failure", error: msg } });
    }
  }

  function gotoPassword() {
    if (!state.importState.result) return;
    setLabelDefault();
    dispatch({ type: "goto-step", step: "set-password" });
  }

  function setLabelDefault() {
    if (!state.label.trim()) {
      dispatch({ type: "set-label", value: `key-${Date.now()}` });
    }
  }

  async function finish() {
    if (!state.importState.result) return;

    // 硬切换 011：根据 useSamePassword 显式选择最终的 vaultPassword：
    //   - useSamePassword === true ⇒ 复用 resolvedImportPassword。
    //   - useSamePassword === false ⇒ 用户新设密码。
    let finalVaultPassword: string;
    if (state.importRequiredPassword && state.useSamePassword) {
      if (!state.resolvedImportPassword) {
        // 理论不可能到这里：useSamePassword === true 但解析时没有
        // 保存密码——保留一条防御性提示。
        dispatch({
          type: "import",
          action: {
            type: "parse-failure",
            error: t("keyImport.page.err.parse", { defaultValue: "解析失败" })
          }
        });
        return;
      }
      finalVaultPassword = state.resolvedImportPassword;
    } else {
      if (state.vaultPasswordDraft.length < 8) {
        dispatch({
          type: "import",
          action: {
            type: "parse-failure",
            error: t("shell.locked.passwordTooShort", { defaultValue: "密码至少 8 位" })
          }
        });
        return;
      }
      if (state.vaultPasswordDraft !== state.vaultPasswordConfirmDraft) {
        dispatch({
          type: "import",
          action: {
            type: "parse-failure",
            error: t("shell.locked.passwordMismatch", { defaultValue: "两次密码不一致" })
          }
        });
        return;
      }
      finalVaultPassword = state.vaultPasswordDraft;
    }

    dispatch({ type: "import", action: { type: "parse-start" } });
    try {
      const parsed = state.importState.result;
      // 把 KeyImportResult 收敛为 PrivateKeyMaterial——只把 hex / wif 喂给 Vault。
      const material: PrivateKeyMaterial = {
        hex: parsed.material.hex,
        wif: parsed.material.wif
      };
      await vault.createVaultWithImportedKey({
        vaultPassword: finalVaultPassword,
        key: {
          label: state.label.trim() || `key-${Date.now()}`,
          material,
          format: parsed.detectedFormat,
          capabilities: ["p2pkh"],
          source: importer?.id
        }
      });
      // 成功：vault 内部会切到 unlocked，App 卸载 LockedShell。
      dispatch({ type: "reset" });
    } catch (err) {
      if (err instanceof KeyPersistedButActivationFailedError) {
        dispatch({ type: "reset" });
        return;
      }
      dispatch({
        type: "import",
        action: {
          type: "parse-failure",
          error:
            err instanceof Error
              ? err.message
              : t("shell.locked.createInitialKeyFailed", { defaultValue: "创建钱包失败" })
        }
      });
    } finally {
      // 清掉新设密码草稿，避免本 wizard 重用旧值。
      dispatch({
        type: "set-use-same-password",
        value: state.useSamePassword
      });
    }
  }

  // ---- step progress 派生 ----
  const currentIndex = STEP_ORDER.indexOf(step);
  const doneUpToIndex = Math.max(currentIndex, 0);

  function gotoStepIndex(i: number) {
    const cur = STEP_ORDER.indexOf(step);
    if (i < 0) return;
    if (i > cur) return; // 禁止向前跳
    const target = STEP_ORDER[i];
    if (!target) return;
    dispatch({ type: "goto-step", step: target });
  }

  function gotoPrev() {
    const prev = prevStepFor(step);
    if (!prev) {
      // 第 1 步返回：用户点"返回"回到欢迎页。**不**写 vault_meta，
      // 状态保持 uninitialized。私钥材料（如果已解析）随组件卸载。
      onCancel();
      return;
    }
    dispatch({ type: "goto-prev" });
  }

  // 当前 JSON 模式下解析按钮是否可点：文本模式需要非空文本，文件模式需要已选文件。
  const canParse = (() => {
    if (!importer) return false;
    if (isJsonImporter(importer)) {
      if (jsonInputMode === "text") return state.importState.text.trim().length > 0;
      return Boolean(state.importState.fileBytes);
    }
    return true;
  })();

  // ----------------- 渲染 -----------------
  // 派生 boolean：方便 JSX 内 if-else 风格写法。
  const showJsonModeToggle = isJsonImporter(importer);
  const showTextInput =
    Boolean(importer) && !showJsonModeToggle && importer!.supports.includes("text");
  const showFileInput =
    Boolean(importer) && !showJsonModeToggle && importer!.supports.includes("file");
  const showPassword =
    (showJsonModeToggle && state.importState.needsPassword) ||
    (Boolean(importer) && !showJsonModeToggle && state.importState.needsPassword && Boolean(state.importState.fileBytes));

  if (step === "pick-importer") {
    return (
      <div className="first-time-import">
        <StepProgress
          steps={STEP_DEFINITIONS}
          currentIndex={currentIndex}
          doneUpToIndex={doneUpToIndex}
          onStepClick={gotoStepIndex}
        />
        <PageHeader
          title={t("shell.import.wizard.pickImporterTitle", {
            defaultValue: "导入私钥：1. 选择导入方式"
          })}
          description={t("shell.import.wizard.pickImporterDesc", {
            defaultValue:
              "请先选择一种导入格式。私钥材料在本地解析，不会上传到任何服务器。"
          })}
        />
        <section className="first-time-import__picker">
          <ImporterPicker
            selected={importer?.id}
            onSelect={(imp) => dispatch({ type: "pick-importer", importer: imp })}
          />
        </section>
        {state.importState.error ? <p className="first-time-import__error">{state.importState.error}</p> : null}
        <div className="first-time-import__actions">
          <Button
            onClick={() => dispatch({ type: "goto-step", step: "input" })}
            disabled={!importer}
          >
            {t("common.action.next", { defaultValue: "下一步" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={state.importState.busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "input") {
    return (
      <div className="first-time-import">
        <StepProgress
          steps={STEP_DEFINITIONS}
          currentIndex={currentIndex}
          doneUpToIndex={doneUpToIndex}
          onStepClick={gotoStepIndex}
        />
        <PageHeader
          title={t("shell.import.wizard.inputTitle", {
            defaultValue: "导入私钥：2. 输入"
          })}
          description={t("shell.import.wizard.inputDesc", {
            defaultValue: "粘贴或选择你的私钥材料。"
          })}
        />
        <section className="first-time-import__input">
          {showJsonModeToggle ? (
            <>
              <Select
                label={t("keyImport.page.label.inputMode", { defaultValue: "输入方式" })}
                value={jsonInputMode}
                onChange={(e) =>
                  dispatch({
                    type: "import",
                    action: {
                      type: "switch-input-mode",
                      next: (e.currentTarget.value as JsonInputMode) ?? "file"
                    }
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
              {jsonInputMode === "text" ? (
                <TextArea
                  label={t("keyImport.page.label.jsonText", { defaultValue: "JSON 文本" })}
                  value={state.importState.text}
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
                <label className="ui-field">
                  <span className="ui-field__label">
                    {t("keyImport.page.label.file", { defaultValue: "文件" })}
                  </span>
                  <input className="ui-input" type="file" onChange={onFile} />
                  {state.importState.fileName ? (
                    <span className="ui-field__hint">
                      {t("keyImport.page.filePicked", { defaultValue: "已选择：" })}
                      {state.importState.fileName}{" "}
                      <button
                        type="button"
                        className="import-page__clear"
                        onClick={clearFile}
                      >
                        {t("keyImport.page.action.clear", { defaultValue: "清除" })}
                      </button>
                    </span>
                  ) : null}
                </label>
              )}
              {state.importState.needsPassword ? (
                <TextInput
                  label={t("keyImport.page.label.importPassword", {
                    defaultValue: "导入源密码"
                  })}
                  type="password"
                  autoComplete="off"
                  value={importPasswordDraft}
                  onChange={(e) =>
                    dispatch({
                      type: "import",
                      action: { type: "set-password", password: e.currentTarget.value }
                    })
                  }
                  placeholder={t("keyImport.page.placeholder.importPassword", {
                    defaultValue: "加密 JSON 的密码"
                  })}
                />
              ) : null}
            </>
          ) : null}
          {showTextInput ? (
            <TextInput
              label={t("keyImport.page.label.text", { defaultValue: "文本" })}
              value={state.importState.text}
              onChange={(e) => onTextChange(e.currentTarget.value)}
              placeholder={t("keyImport.page.placeholder.text", {
                defaultValue: "粘贴 WIF 或 hex 私钥"
              })}
            />
          ) : null}
          {showFileInput ? (
            <>
              <label className="ui-field">
                <span className="ui-field__label">
                  {t("keyImport.page.label.file", { defaultValue: "文件" })}
                </span>
                <input className="ui-input" type="file" onChange={onFile} />
                {state.importState.fileName ? (
                  <span className="ui-field__hint">
                    {t("keyImport.page.filePicked", { defaultValue: "已选择：" })}
                    {state.importState.fileName}{" "}
                    <button
                      type="button"
                      className="import-page__clear"
                      onClick={clearFile}
                    >
                      {t("keyImport.page.action.clear", { defaultValue: "清除" })}
                    </button>
                  </span>
                ) : null}
              </label>
              {state.importState.needsPassword && state.importState.fileBytes ? (
                <TextInput
                  label={t("keyImport.page.label.importPassword", {
                    defaultValue: "导入源密码"
                  })}
                  type="password"
                  autoComplete="off"
                  value={importPasswordDraft}
                  onChange={(e) =>
                    dispatch({
                      type: "import",
                      action: { type: "set-password", password: e.currentTarget.value }
                    })
                  }
                  placeholder={t("keyImport.page.placeholder.importPassword", {
                    defaultValue: "加密 JSON 文件的密码"
                  })}
                />
              ) : null}
            </>
          ) : null}
        </section>
        {state.importState.error ? <p className="first-time-import__error">{state.importState.error}</p> : null}
        <div className="first-time-import__actions">
          <Button
            onClick={parse}
            loading={state.importState.busy}
            disabled={!canParse}
          >
            {t("keyImport.page.action.parse", { defaultValue: "解析" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={state.importState.busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "confirm-key" && state.importState.result) {
    const parsed = state.importState.result;
    return (
      <div className="first-time-import">
        <StepProgress
          steps={STEP_DEFINITIONS}
          currentIndex={currentIndex}
          doneUpToIndex={doneUpToIndex}
          onStepClick={gotoStepIndex}
        />
        <PageHeader
          title={t("shell.import.wizard.confirmKeyTitle", {
            defaultValue: "导入私钥：3. 确认解析结果"
          })}
          description={t("shell.import.wizard.confirmKeyDesc", {
            defaultValue: "解析成功后，确认标签后继续设置本机系统锁屏密码。"
          })}
        />
        <section className="first-time-import__confirm">
          <p>
            {t("keyImport.page.detected", { defaultValue: "检测到：" })}
            {parsed.detectedFormat}
            {parsed.summary ? ` · ${host.i18n.text(parsed.summary)}` : ""}
          </p>
          <p>
            {t("keyImport.page.derived", { defaultValue: "派生地址：" })}
            {parsed.address ||
              t("keyImport.page.derivedPending", { defaultValue: "等待业务插件回填" })}
          </p>
          <TextInput
            label={t("keyImport.page.label.label", { defaultValue: "标签" })}
            value={state.label}
            onChange={(e) => dispatch({ type: "set-label", value: e.currentTarget.value })}
            placeholder={t("keyImport.page.placeholder.label", {
              defaultValue: "例如 主钱包 / 冷钱包"
            })}
          />
        </section>
        {state.importState.error ? <p className="first-time-import__error">{state.importState.error}</p> : null}
        <div className="first-time-import__actions">
          <Button onClick={gotoPassword} disabled={!parsed}>
            {t("common.action.next", { defaultValue: "下一步" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={state.importState.busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  // step === "set-password"
  const isReuseMode =
    state.importRequiredPassword &&
    state.useSamePassword &&
    Boolean(state.resolvedImportPassword);

  return (
    <div className="first-time-import">
      <StepProgress
        steps={STEP_DEFINITIONS}
        currentIndex={currentIndex}
        doneUpToIndex={doneUpToIndex}
        onStepClick={gotoStepIndex}
      />
      <PageHeader
        title={t("shell.import.wizard.setPasswordTitle", {
          defaultValue: "导入私钥：4. 设置本机系统锁屏密码"
        })}
        description={t("shell.import.wizard.setPasswordDesc", {
          defaultValue:
            "该密码仅保存在本机，用于加密你导入的私钥。"
        })}
      />
      <section className="first-time-import__password">
        {state.importRequiredPassword ? (
          <label className="ui-field first-time-import__reuse-toggle">
            <input
              type="checkbox"
              checked={state.useSamePassword}
              onChange={(e) =>
                dispatch({
                  type: "set-use-same-password",
                  value: e.currentTarget.checked
                })
              }
            />
            <span className="first-time-import__reuse-toggle-label">
              {t("shell.import.wizard.useSamePassword", {
                defaultValue: "使用导入源密码作为本机系统锁屏密码"
              })}
            </span>
          </label>
        ) : null}

        {isReuseMode ? (
          <div className="first-time-import__reuse-notice" role="status">
            <p className="first-time-import__reuse-headline">
              {t("shell.import.wizard.reuseNotice", {
                defaultValue:
                  "将复用第 2 步已输入的导入源密码，Vault 将使用该密码创建并解锁。"
              })}
            </p>
            <p className="first-time-import__reuse-meta">
              <span className="first-time-import__reuse-label">
                {t("shell.import.wizard.reuseLabel", { defaultValue: "将使用的密码" })}
                {": "}
              </span>
              <code aria-hidden="true">{"•".repeat(state.resolvedImportPassword?.length ?? 0)}</code>
            </p>
            <p className="first-time-import__reuse-origin">
              {t("shell.import.wizard.reuseOrigin", {
                defaultValue: "来源：第 2 步（导入源密码，仅保存在本次向导内存中）。"
              })}
            </p>
          </div>
        ) : (
          <>
            <p className="first-time-import__new-password-intro">
              {t("shell.import.wizard.newPasswordTitle", {
                defaultValue: "设置新的本机系统锁屏密码"
              })}
            </p>
            <TextInput
              label={t("shell.locked.passwordNew", { defaultValue: "新密码" })}
              type="password"
              autoComplete="new-password"
              value={state.vaultPasswordDraft}
              onChange={(e) =>
                dispatch({ type: "set-vault-password-draft", value: e.currentTarget.value })
              }
            />
            <TextInput
              label={t("shell.locked.passwordConfirm", { defaultValue: "确认密码" })}
              type="password"
              autoComplete="new-password"
              value={state.vaultPasswordConfirmDraft}
              onChange={(e) =>
                dispatch({
                  type: "set-vault-password-confirm-draft",
                  value: e.currentTarget.value
                })
              }
            />
          </>
        )}

        <TextInput
          label={t("keyImport.page.label.label", { defaultValue: "标签" })}
          value={state.label}
          onChange={(e) => dispatch({ type: "set-label", value: e.currentTarget.value })}
          placeholder={t("keyImport.page.placeholder.label", {
            defaultValue: "例如 主钱包 / 冷钱包"
          })}
        />
      </section>
      {state.importState.error ? <p className="first-time-import__error">{state.importState.error}</p> : null}
      <div className="first-time-import__actions">
        <Button
          onClick={finish}
          loading={state.importState.busy}
          disabled={
            isReuseMode
              ? !state.resolvedImportPassword
              : !state.vaultPasswordDraft ||
                state.vaultPasswordDraft !== state.vaultPasswordConfirmDraft
          }
        >
          {t("shell.import.wizard.confirm", { defaultValue: "创建 Vault 并导入" })}
        </Button>
        <Button variant="ghost" onClick={gotoPrev} disabled={state.importState.busy}>
          {t("common.action.back", { defaultValue: "返回" })}
        </Button>
      </div>
    </div>
  );
}

// 抑制未用变量警告 — `WizardState` 类型在签名中已使用，TS 编译期不报错；
// 但保留类型导出供调用方 / 测试使用。
export type { WizardState };
void PASSWORD_REQUIRED_MSG;