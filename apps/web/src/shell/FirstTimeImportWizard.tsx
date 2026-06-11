// apps/web/src/shell/FirstTimeImportWizard.tsx
// 首启"导入私钥"向导（硬切换 011）：
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

import { useEffect, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
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
import { peekBsv8Envelope } from "@keymaster/plugin-key-import/importFileSniff";
import {
  StepProgress,
  type StepDefinition
} from "./StepProgress.js";

/** Importer parse 抛出的密码缺失错误——和 ImportPage 保持一致。 */
const PASSWORD_REQUIRED_MSG = "Password is required for encrypted key file";

type Step = "pick-importer" | "input" | "confirm-key" | "set-password";

const STEP_ORDER: ReadonlyArray<Step> = [
  "pick-importer",
  "input",
  "confirm-key",
  "set-password"
];

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

/** 哪个步骤触发"返回"。每一步的返回目标不同。 */
function prevStepFor(step: Step): Step | null {
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

  const [step, setStep] = useState<Step>("pick-importer");

  // Step 1: 选择 importer
  const [importer, setImporter] = useState<KeyImporter | undefined>(undefined);

  // Step 2: 输入
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  /**
   * 嗅探 / fail-open 综合判断的"当前文件是否需要导入源密码"。
   * 初始 false（默认不显示密码框）；peekBsv8Envelope 命中时或
   * parse() 抛 PASSWORD_REQUIRED_MSG 时升 true。**不**在 importer
   * 级静态声明。
   */
  const [fileNeedsPassword, setFileNeedsPassword] = useState(false);
  /**
   * 硬切换 011：第 2 步密码输入框的草稿。**解析失败时必须保留**，
   * 方便用户重试；**解析成功后**才转存为 resolvedImportPassword。
   */
  const [importPasswordDraft, setImportPasswordDraft] = useState("");

  // Step 3: 解析结果 / 确认
  const [parsed, setParsed] = useState<KeyImportResult | null>(null);
  const [label, setLabel] = useState("");

  /**
   * 本次首启导入的输入**实际**是否需要导入源密码。仅在 step 4 用于
   * 决定是否展示"使用同一密码"勾选——如果本次没用过导入源密码，
   * 那个勾选就毫无意义。
   * 派生规则：
   *   - 文本输入（WIF / Hex）：parse 成功 ⇒ false。
   *   - 文件输入（json-file）：parse 成功 ⇒ fileNeedsPassword（如果
   *     这次解析是 bsv8 envelope 走的，就是 true；明文 JSON 走的就是
   *     false）。
   * 失败回退：如果 parse 抛了非密码错误，本字段保持原值；向导回到
   * step 1 / 2 时由 resetWizard 清零。
   */
  const [importRequiredPassword, setImportRequiredPassword] = useState(false);

  /**
   * 硬切换 011：parse 成功后保存"已实际用于导入解析的密码"。
   *   - 只活在 wizard 生命周期内。
   *   - 重新选 importer / 重新选文件 / 重新解析时**必须**清空，
   *     否则第 4 步会基于已失效的旧密码复用。
   *   - 关闭向导或刷新页面后随组件卸载丢弃。
   */
  const [resolvedImportPassword, setResolvedImportPassword] = useState<
    string | null
  >(null);

  // Step 4: 系统锁屏密码
  /**
   * "使用同一密码"勾选：
   *   - 当 importRequiredPassword === true 时才有意义（明文路径不显示）。
   *   - 默认 true：硬切换 011 强调"复用"是产品意图，**不能**让用户每
   *     次都要重新输入。
   *   - 取消勾选时清空新设密码草稿；勾回时清空 vaultPasswordDraft /
   *     vaultPasswordConfirmDraft。
   */
  const [useSamePassword, setUseSamePassword] = useState(true);
  const [vaultPasswordDraft, setVaultPasswordDraft] = useState("");
  const [vaultPasswordConfirmDraft, setVaultPasswordConfirmDraft] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 解析成功 → 把 importPasswordDraft 提升为 resolvedImportPassword。
  // 这里**不**再无条件清空可复用的成功密码；只清 importPasswordDraft
  // 字段本身以免 UI 上"残留"明文（resolvedImportPassword 是另一份
  // 受控状态）。
  useEffect(() => {
    if (parsed) {
      setImportRequiredPassword(fileNeedsPassword);
      // 解析成功 + 确实需要密码 ⇒ 把已用于解析的密码转存为
      // resolvedImportPassword。**不**写入长期 state、不写
      // localStorage / IndexedDB / URL。
      if (fileNeedsPassword) {
        setResolvedImportPassword(importPasswordDraft);
      } else {
        // 重新解析后输入不再需要密码——清掉旧 resolvedImportPassword。
        setResolvedImportPassword(null);
      }
      setImportPasswordDraft("");
    }
    // 故意只依赖 parsed：fileNeedsPassword / importPasswordDraft 在
    // parse 成功后已经被"读取"过一次，再变就无关 wizard 的当前决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFileName(f.name);
    setFileBytes(bytes);
    // 重新选文件 ⇒ 旧的密码决策已失效：清掉 resolvedImportPassword、
    // importRequiredPassword、importPasswordDraft。
    setResolvedImportPassword(null);
    setImportRequiredPassword(false);
    // fail-open 嗅探：选完文件后立即用 peekBsv8Envelope 判断是否像
    // bsv8 envelope。如果命中，预先打开密码框；如果不命中，保持隐藏。
    setFileNeedsPassword(peekBsv8Envelope(bytes));
    setImportPasswordDraft("");
    setError(null);
  }

  function clearFile() {
    setFileName(null);
    setFileBytes(null);
    setFileNeedsPassword(false);
    setImportPasswordDraft("");
    setResolvedImportPassword(null);
    setImportRequiredPassword(false);
  }

  function resetWizard() {
    setStep("pick-importer");
    setImporter(undefined);
    setText("");
    setFileName(null);
    setFileBytes(null);
    setFileNeedsPassword(false);
    setImportPasswordDraft("");
    setParsed(null);
    setLabel("");
    setImportRequiredPassword(false);
    setResolvedImportPassword(null);
    setUseSamePassword(true);
    setVaultPasswordDraft("");
    setVaultPasswordConfirmDraft("");
    setError(null);
  }

  /** 切换 importer：必须清掉旧密码决策。 */
  function pickImporter(imp: KeyImporter) {
    setImporter(imp);
    setError(null);
    setFileBytes(null);
    setFileName(null);
    setFileNeedsPassword(false);
    setImportPasswordDraft("");
    setImportRequiredPassword(false);
    setResolvedImportPassword(null);
    setUseSamePassword(true);
    setVaultPasswordDraft("");
    setVaultPasswordConfirmDraft("");
  }

  /**
   * 用户点击 step progress 上的某一步。仅允许跳到**已完成**或
   * **当前**步骤。返回未来步骤被 UI 禁点保护；这里再做一次保险。
   */
  function gotoStepIndex(i: number) {
    const cur = STEP_ORDER.indexOf(step);
    if (i < 0) return;
    if (i > cur) return; // 禁止向前跳
    const target = STEP_ORDER[i];
    if (!target) return;
    setError(null);
    setStep(target);
  }

  function gotoPrev() {
    const prev = prevStepFor(step);
    if (!prev) {
      // 第 1 步返回：用户点"返回"回到欢迎页。**不**写 vault_meta，
      // 状态保持 uninitialized。私钥材料（如果已解析）随组件卸载。
      onCancel();
      return;
    }
    setError(null);
    setStep(prev);
  }

  async function parse() {
    if (!importer) {
      setError(t("keyImport.page.err.noImporter", { defaultValue: "请先选择导入方式" }));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const input = fileBytes
        ? {
            kind: "file" as const,
            name: fileName ?? "blob",
            content: fileBytes,
            password: fileNeedsPassword ? importPasswordDraft : undefined
          }
        : { kind: "text" as const, text };
      const r = await importer.parse(input);
      if (r.length === 0) {
        setError(t("keyImport.page.err.noKey", { defaultValue: "未解析出私钥" }));
        return;
      }
      setParsed(r[0] ?? null);
      // resolvedImportPassword / importRequiredPassword 由 useEffect 在
      // parsed 变化时根据 fileNeedsPassword 派生；这里不需要手动设。
      setStep("confirm-key");
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t("keyImport.page.err.parse", { defaultValue: "解析失败" });
      // fail-open：解析失败如果是"密码缺失"——通常是 bsv8 envelope 未
      // 嗅探到但实际是加密——立即把密码框升上来，让用户输入后再点
      // 解析。ImportPage 也是这个语义。
      if (fileBytes && msg === PASSWORD_REQUIRED_MSG) {
        setFileNeedsPassword(true);
      }
      // 解析失败时**不**写 resolvedImportPassword（即便 draft 已填）；
      // 由 resetWizard / 重新选文件 / 重新解析时再清。
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function gotoPassword() {
    if (!parsed) return;
    setError(null);
    setLabel((prev) => (prev.trim() ? prev : `key-${Date.now()}`));
    setStep("set-password");
  }

  async function finish() {
    if (!parsed) return;
    setError(null);

    // 硬切换 011：根据 useSamePassword 显式选择最终的 vaultPassword：
    //   - useSamePassword === true ⇒ 复用 resolvedImportPassword。
    //   - useSamePassword === false ⇒ 用户新设密码。
    let finalVaultPassword: string;
    if (importRequiredPassword && useSamePassword) {
      if (!resolvedImportPassword) {
        // 理论不可能到这里：useSamePassword === true 但解析时没有
        // 保存密码——保留一条防御性提示。
        setError(
          t("keyImport.page.err.parse", { defaultValue: "解析失败" })
        );
        return;
      }
      finalVaultPassword = resolvedImportPassword;
    } else {
      // 新设密码场景：必须是双输入框模式（明文 / 取消复用）。
      if (vaultPasswordDraft.length < 8) {
        setError(t("shell.locked.passwordTooShort", { defaultValue: "密码至少 8 位" }));
        return;
      }
      if (vaultPasswordDraft !== vaultPasswordConfirmDraft) {
        setError(t("shell.locked.passwordMismatch", { defaultValue: "两次密码不一致" }));
        return;
      }
      finalVaultPassword = vaultPasswordDraft;
    }

    setBusy(true);
    try {
      // 把 KeyImportResult 收敛为 PrivateKeyMaterial——只把 hex / wif 喂给 Vault。
      // address / network / detectedFormat / summary 不进 Vault；Vault 不感知
      // 这些业务字段。
      const material: PrivateKeyMaterial = {
        hex: parsed.material.hex,
        wif: parsed.material.wif
      };
      await vault.createVaultWithImportedKey({
        vaultPassword: finalVaultPassword,
        key: {
          label: label.trim() || `key-${Date.now()}`,
          material,
          format: parsed.detectedFormat,
          capabilities: ["p2pkh"],
          source: importer?.id
        }
      });
      // 成功：vault 内部会切到 unlocked，App 卸载 LockedShell，导入 wizard 自然消失。
      // 不需要主动 push 路由——UnlockedShell 自己渲染默认首页。
      // 关闭前清掉本 wizard 的所有内存状态（包括
      // resolvedImportPassword / importPasswordDraft）。
      resetWizard();
    } catch (err) {
      if (err instanceof KeyPersistedButActivationFailedError) {
        // 可恢复：首 Key 已落库，active 没切上。Vault 已宣布 unlocked，
        // App 切到 UnlockedShell，AppShell / VaultSettingsPage 会展示
        // notice。本 wizard 不必再做任何事。
        resetWizard();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : t("shell.locked.createInitialKeyFailed", { defaultValue: "创建钱包失败" })
      );
    } finally {
      setBusy(false);
      setVaultPasswordDraft("");
      setVaultPasswordConfirmDraft("");
    }
  }

  // ---- step progress 派生 ----
  const currentIndex = STEP_ORDER.indexOf(step);
  // 已完成步骤的最高 exclusive index：当前步骤之前的所有步骤视为完成。
  // 关键约束：UI 不能让用户跳到尚未满足前置条件的步骤。
  const doneUpToIndex = Math.max(currentIndex, 0);

  // ----------------- 渲染 -----------------

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
            onSelect={pickImporter}
          />
        </section>
        {error ? <p className="first-time-import__error">{error}</p> : null}
        <div className="first-time-import__actions">
          <Button
            onClick={() => setStep("input")}
            disabled={!importer}
          >
            {t("common.action.next", { defaultValue: "下一步" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={busy}>
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
          {importer?.supports.includes("text") ? (
            <TextInput
              label={t("keyImport.page.label.text", { defaultValue: "文本" })}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              placeholder={t("keyImport.page.placeholder.text", {
                defaultValue: "粘贴 WIF 或 hex 私钥"
              })}
            />
          ) : null}
          {importer?.supports.includes("file") ? (
            <>
              <label className="ui-field">
                <span className="ui-field__label">
                  {t("keyImport.page.label.file", { defaultValue: "文件" })}
                </span>
                <input className="ui-input" type="file" onChange={onFile} />
                {fileName ? (
                  <span className="ui-field__hint">
                    {t("keyImport.page.filePicked", { defaultValue: "已选择：" })}
                    {fileName}{" "}
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
              {fileNeedsPassword && fileBytes ? (
                <TextInput
                  label={t("keyImport.page.label.password", {
                    defaultValue: "备份文件密码"
                  })}
                  type="password"
                  autoComplete="off"
                  value={importPasswordDraft}
                  onChange={(e) => setImportPasswordDraft(e.currentTarget.value)}
                  placeholder={t("keyImport.page.placeholder.password", {
                    defaultValue: "加密 JSON 文件的密码"
                  })}
                />
              ) : null}
            </>
          ) : null}
        </section>
        {error ? <p className="first-time-import__error">{error}</p> : null}
        <div className="first-time-import__actions">
          <Button
            onClick={parse}
            loading={busy}
            disabled={!importer || (fileNeedsPassword && !importPasswordDraft)}
          >
            {t("keyImport.page.action.parse", { defaultValue: "解析" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "confirm-key" && parsed) {
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
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder={t("keyImport.page.placeholder.label", {
              defaultValue: "例如 主钱包 / 冷钱包"
            })}
          />
        </section>
        {error ? <p className="first-time-import__error">{error}</p> : null}
        <div className="first-time-import__actions">
          <Button onClick={gotoPassword} disabled={!parsed}>
            {t("common.action.next", { defaultValue: "下一步" })}
          </Button>
          <Button variant="ghost" onClick={gotoPrev} disabled={busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  // step === "set-password"
  // 硬切换 011 第 4 步三种渲染模式：
  //   模式 A：importRequiredPassword === true 且 useSamePassword === true
  //     ⇒ 复用 resolvedImportPassword。**不**渲染密码输入框。
  //   模式 B：importRequiredPassword === true 且 useSamePassword === false
  //     ⇒ "新密码 + 确认密码"。
  //   模式 C：importRequiredPassword === false
  //     ⇒ "新密码 + 确认密码"，不显示"使用同一密码"勾选。
  const isReuseMode =
    importRequiredPassword && useSamePassword && Boolean(resolvedImportPassword);

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
        {importRequiredPassword ? (
          <label className="ui-field first-time-import__reuse-toggle">
            <input
              type="checkbox"
              checked={useSamePassword}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setUseSamePassword(next);
                if (next) {
                  // 切到模式 A：清掉所有"新设密码"草稿，最终以
                  // resolvedImportPassword 为准。
                  setVaultPasswordDraft("");
                  setVaultPasswordConfirmDraft("");
                } else {
                  // 切到模式 B：清掉 vaultPassword* 草稿，让用户重新
                  // 输入新密码 + 确认。
                  setVaultPasswordDraft("");
                  setVaultPasswordConfirmDraft("");
                }
              }}
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
              <code aria-hidden="true">{"•".repeat(resolvedImportPassword?.length ?? 0)}</code>
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
              {importRequiredPassword
                ? t("shell.import.wizard.newPasswordTitle", {
                    defaultValue: "设置新的本机系统锁屏密码"
                  })
                : t("shell.import.wizard.newPasswordTitle", {
                    defaultValue: "设置新的本机系统锁屏密码"
                  })}
            </p>
            <TextInput
              label={t("shell.locked.passwordNew", { defaultValue: "新密码" })}
              type="password"
              autoComplete="new-password"
              value={vaultPasswordDraft}
              onChange={(e) => setVaultPasswordDraft(e.currentTarget.value)}
            />
            <TextInput
              label={t("shell.locked.passwordConfirm", { defaultValue: "确认密码" })}
              type="password"
              autoComplete="new-password"
              value={vaultPasswordConfirmDraft}
              onChange={(e) =>
                setVaultPasswordConfirmDraft(e.currentTarget.value)
              }
            />
          </>
        )}

        <TextInput
          label={t("keyImport.page.label.label", { defaultValue: "标签" })}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder={t("keyImport.page.placeholder.label", {
            defaultValue: "例如 主钱包 / 冷钱包"
          })}
        />
      </section>
      {error ? <p className="first-time-import__error">{error}</p> : null}
      <div className="first-time-import__actions">
        <Button
          onClick={finish}
          loading={busy}
          disabled={
            isReuseMode
              ? !resolvedImportPassword
              : !vaultPasswordDraft ||
                vaultPasswordDraft !== vaultPasswordConfirmDraft
          }
        >
          {t("shell.import.wizard.confirm", { defaultValue: "创建 Vault 并导入" })}
        </Button>
        <Button variant="ghost" onClick={gotoPrev} disabled={busy}>
          {t("common.action.back", { defaultValue: "返回" })}
        </Button>
      </div>
    </div>
  );
}
