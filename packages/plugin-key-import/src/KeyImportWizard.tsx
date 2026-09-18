// packages/plugin-key-import/src/KeyImportWizard.tsx
// Key 导入向导（原 apps/web/src/shell/FirstTimeImportWizard.tsx 迁移）：
//   业务流程固定为：
//     1) 选择导入类型（importer）
//     2) 输入 / 解析导入材料
//     3) 解析成功后决定标签（以及 LockedShell 模式下的本机锁屏密码）
//     4) 回调 onComplete：draft 模式只交还内存草稿；首启模式直接落库
//
// 双模式：
//   - `vaultPassword + onComplete(draft)`（draft 模式）：只解析并把材料草稿
//     交还宿主；真正的持久化由宿主事务完成（初始化 / 新建桶 / 桶内导入共用）。
//   - 无 `vaultPassword`（首启模式）：解析后用 `createVaultWithImportedKey`
//     一次性建 Vault + 落首把 Key + 切 active。
//
// 设计缘由：
//   - 解析失败时导入源密码草稿必须保留以便重试；解析成功时才转存为
//     resolvedImportPassword，且只活在向导内存里。
//   - 私钥材料**不**写 localStorage / platform K-V repository / URL / 长期 React state。
//   - 主题/语言切换不影响当前 step、已选 importer、文件、解析结果和密码内存态。
//   - 不能把私钥材料或密码写到持久化介质；不能跳过 steps 的前置条件。

import { useEffect, useReducer } from "react";
import { Button, PageHeader, Select, TextArea, TextInput } from "@keymaster/ui";
import {
  useI18n,
  usePluginHost
} from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import {
  KeyPersistedButActivationFailedError,
  VAULT_SERVICE_CAPABILITY,
  type KeyImportMaterial
} from "@keymaster/contracts";
import { ImporterPicker } from "./ImporterPicker.js";
import {
  peekEncryptedKeyDocumentBytes,
  peekEncryptedKeyDocumentText
} from "./importFileSniff.js";
import {
  buildImportInput,
  isJsonImporter,
  type JsonInputMode
} from "./jsonImportStateMachine.js";
import {
  initialWizardState,
  prevStepFor,
  reduceWizard,
  STEP_ORDER
} from "./wizardImportStateMachine.js";
import {
  StepProgress,
  type StepDefinition
} from "./ImportStepProgress.js";

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

export interface KeyImportWizardProps {
  /** 用户点"返回"回到上一步 / 宿主页面时触发。 */
  onCancel(): void;
  /** 首启模式：宿主已收集的统一密码；draft 模式下不使用。 */
  vaultPassword?: string;
  /**
   * draft 模式：只把解析结果交还宿主（不调用 Vault RPC）。
   * 省略时按 `vaultPassword` 是否存在推断（存在即 draft 模式）。
   */
  draftMode?: boolean;
  /**
   * draft 模式回调：交还解析后的 Key 草稿，由宿主事务完成持久化。
   */
  onComplete?(draft?: InitialSetupImportedKeyDraft): void;
}

/** importer 解析后的 Key 草稿；不包含桶密码或导入源密码。 */
export interface InitialSetupImportedKeyDraft {
  /** 页面显示标签。 */
  label: string;
  /** 临时私钥材料，只在最终提交前留在内存。 */
  material: KeyImportMaterial;
  /** importer 识别出的格式。 */
  format: string;
  /** importer 身份，用于公开来源说明。 */
  source?: string;
  /** 默认公开能力。 */
  capabilities: string[];
}

export function KeyImportWizard({ onCancel, vaultPassword, draftMode, onComplete }: KeyImportWizardProps) {
  // draft / 初始化时 Vault 可能还没有安装；导入步骤只负责解析并把内存草稿
  // 交还给宿主页面，不能因为缺少 vault.service 让整个向导 fatal。
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const { t } = useI18n();
  // draft 模式：只解析并交还草稿；首启模式才创建 Vault。
  const isDraftMode = draftMode ?? Boolean(vaultPassword);

  // 所有 wizard 状态机收敛到 reducer；组件本身只负责发起 async parse +
  // 首启模式下的 createVaultWithImportedKey。
  const [state, dispatch] = useReducer(reduceWizard, initialWizardState);
  const step = state.step;
  const importer = state.importState.importer;
  const jsonInputMode = state.importState.jsonInputMode;
  const importPasswordDraft = state.importState.password;

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
        needsPassword: peekEncryptedKeyDocumentBytes(bytes)
      }
    });
  }

  function clearFile() {
    dispatch({ type: "import", action: { type: "clear-file" } });
  }

  /** 文本输入实时嗅探加密密钥文档，与文件模式共用同一套逻辑。 */
  function onTextChange(value: string) {
    const sniff = isJsonImporter(importer) ? peekEncryptedKeyDocumentText(value) : false;
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

    // draft 模式只把解析结果交还宿主；这里绝不创建空 Vault，也不写入
    // keys/、Hold 或目录。宿主会在最终确认时调用单一事务入口。
    if (isDraftMode && onComplete) {
      const parsed = state.importState.result;
      const label = state.label.trim() || `key-${Date.now()}`;
      onComplete({
        label,
        material: {
          hex: parsed.material.hex,
          ...(parsed.material.wif === undefined ? {} : { wif: parsed.material.wif })
        },
        format: parsed.detectedFormat,
        ...(importer?.id === undefined ? {} : { source: importer.id }),
        capabilities: ["p2pkh"]
      });
      dispatch({ type: "reset" });
      return;
    }

    // 首启模式：根据 useSamePassword 显式选择最终的 vaultPassword。
    let finalVaultPassword: string;
    if (vaultPassword) {
      finalVaultPassword = vaultPassword;
    } else if (state.importRequiredPassword && state.useSamePassword) {
      if (!state.resolvedImportPassword) {
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

    if (!vault) {
      dispatch({
        type: "import",
        action: {
          type: "parse-failure",
          error: t("shell.locked.createInitialKeyFailed", { defaultValue: "钱包服务尚未就绪" })
        }
      });
      return;
    }

    dispatch({ type: "import", action: { type: "parse-start" } });
    try {
      const parsed = state.importState.result;
      await vault.createVaultWithImportedKey({
        vaultPassword: finalVaultPassword,
        key: {
          label: state.label.trim() || `key-${Date.now()}`,
          material: parsed.material,
          format: parsed.detectedFormat,
          capabilities: ["p2pkh"],
          source: importer?.id
        }
      });
      // 成功：vault 内部会切到 unlocked，App 卸载 LockedShell。
      onComplete?.();
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
  const visibleSteps = isDraftMode ? STEP_DEFINITIONS.slice(0, 3) : STEP_DEFINITIONS;
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
      // 第 1 步返回：用户点"返回"回到宿主页面。**不**写 vault_meta，
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
      if (jsonInputMode === "text") {
        if (state.importState.text.trim().length === 0) return false;
      } else if (!state.importState.fileBytes) {
        return false;
      }
    }
    if (state.importState.needsPassword && !importPasswordDraft) return false;
    return true;
  })();

  // ----------------- 渲染 -----------------
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
          steps={visibleSteps}
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
          steps={visibleSteps}
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
          steps={visibleSteps}
          currentIndex={currentIndex}
          doneUpToIndex={doneUpToIndex}
          onStepClick={gotoStepIndex}
        />
        <PageHeader
          title={t("shell.import.wizard.confirmKeyTitle", {
            defaultValue: "导入私钥：3. 确认解析结果"
          })}
          description={t("shell.import.wizard.confirmKeyDesc", {
            defaultValue: isDraftMode ? "确认解析结果并填写这把 Key 的标签名称。" : "解析成功后，确认标签后继续设置本机系统锁屏密码。"
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
          <Button onClick={isDraftMode ? finish : gotoPassword} loading={state.importState.busy} disabled={!parsed || (isDraftMode && !state.label.trim())}>
            {isDraftMode ? t("shell.import.wizard.confirmInitial", { defaultValue: "使用这把 Key" }) : t("common.action.next", { defaultValue: "下一步" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={state.importState.busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  // step === "set-password"（首启模式）
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
