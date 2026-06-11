// apps/web/src/shell/FirstTimeImportWizard.tsx
// 首启"导入私钥"向导（硬切换 010）：
//   业务流程固定为：
//     1) 选择导入类型（importer）
//     2) 输入 / 解析导入材料
//     3) 解析成功后决定本机系统锁屏密码
//     4) 调 vault.createVaultWithImportedKey(...)：一次性建 Vault +
//        落首把导入 Key + 切 active
//   整个流程在用户**没有创建 Vault**之前完成；首启导入完成后 vault
//   自动进入 unlocked，App 切到 UnlockedShell，本向导自然卸载。
//
// 设计缘由：
//   - 业务流程必须固定"先解析、再决定本机如何加密保存"，不允许
//     出现"先建空 Vault 再导入"——那是硬切换 010 要彻底消除的产品状态。
//   - "导入源密码"与"系统锁屏密码"是两个独立字段；UI 上允许用户选
//     "使用同一密码"，但内部语义必须分开（持久化为 vaultPassword）。
//   - 解析失败 / 用户取消：状态保持 uninitialized，私钥材料只留在
//     本次向导内存，关闭向导后丢弃。
//   - 私钥材料**不**写 localStorage / IndexedDB / URL / 长期 React state；
//     只活在向导的局部 state，关闭向导或刷新页面即丢。
//
// 关于"是否需要导入源密码"（硬切换 010 收尾）：
//   - 这是**输入**的属性，不是 importer 的属性。json-file 同一个 importer
//     既能解析明文 JSON（无需密码），也能解析 bsv8 envelope（需要密码）。
//   - 平台契约 `KeyImporter` 不声明"是否需要密码"字段（参见
//     [keyImport.ts] 注释）——任何在 importer 级加这类字段的尝试
//     都会诱导 UI 在解析前锁死流程，是产品回归。
//   - 正确做法是 **fail-open**：先调 parse()，如果 importer 抛
//     "Password is required for encrypted key file"（业务约定错误）
//     就追问密码；并用 `peekBsv8Envelope` 在选完文件时做一次乐观嗅探
//     提前展示密码框，提升体验。
//   - 步骤 4 的"使用同一密码"勾选**仅**在本次解析**确实**用过导入源
//     密码时展示——再次确认"是否需要密码"是运行时属性。
//
// 步骤 4 模式（基于运行时 importRequiredPassword）：
//   - 模式 1（单输入框，无 confirm）：
//       a) importRequiredPassword === false（明文 WIF / Hex / 明文 JSON）
//          —— 单"本机系统锁屏密码"输入框。
//       b) importRequiredPassword === true 且用户勾选"使用同一密码"
//          —— 单"导入源密码兼系统锁屏密码"输入框。
//   - 模式 2（双输入框，含 confirm）：
//       importRequiredPassword === true 且用户**未**勾选"使用同一密码"——
//       新密码 + 确认密码两个输入框。
//
// 不能怎么做：
//   - 不能复用 /import 页面——它只服务已解锁态导入更多 key。
//   - 不能先 vault.createVault() 再解析：会留下"有密码但 0 key"空壳。
//   - 不能把 importPassword 直接当 vaultPassword 隐式复用：
//     必须给用户明确选择权。
//   - 不能让私钥材料进入 useEffect 长期 state / 全局 capability。
//   - 不能在 KeyImporter 契约里加"是否需要密码"的布尔字段。

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

/** Importer parse 抛出的密码缺失错误——和 ImportPage 保持一致。 */
const PASSWORD_REQUIRED_MSG = "Password is required for encrypted key file";

type Step = "pick-importer" | "input" | "confirm-key" | "set-password";

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
  const [importPassword, setImportPassword] = useState("");

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

  // Step 4: 系统锁屏密码
  const [useSamePassword, setUseSamePassword] = useState(true);
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 模式 1：单输入框，无 confirm。
  //   - importRequiredPassword === false（明文路径）→ 强制模式 1。
  //   - importRequiredPassword === true 且 useSamePassword===true → 模式 1。
  // 模式 2：双输入框，含 confirm——importRequiredPassword === true 且
  // useSamePassword===false。
  const isSingleFieldMode = !importRequiredPassword || useSamePassword;

  // 解析成功 → 记录本次是否真的用过导入源密码，再清掉 importPassword
  // （闭包结束即丢，避免内存中残留）。
  useEffect(() => {
    if (parsed) {
      setImportRequiredPassword(fileNeedsPassword);
      setImportPassword("");
    }
    // 故意只依赖 parsed：fileNeedsPassword 在 parse 成功后已经被
    // "读取"过一次，再变就无关 wizard 的当前决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFileName(f.name);
    setFileBytes(bytes);
    // fail-open 嗅探：选完文件后立即用 peekBsv8Envelope 判断是否像
    // bsv8 envelope。如果命中，预先打开密码框；如果不命中，保持隐藏，
    // 让用户直接点"解析"——如果实际是加密但未被识别，parse() 抛
    // PASSWORD_REQUIRED_MSG 时再把 fileNeedsPassword 升 true。
    setFileNeedsPassword(peekBsv8Envelope(bytes));
    setImportPassword("");
    setError(null);
  }

  function clearFile() {
    setFileName(null);
    setFileBytes(null);
    setFileNeedsPassword(false);
    setImportPassword("");
  }

  function resetWizard() {
    setStep("pick-importer");
    setImporter(undefined);
    setText("");
    setFileName(null);
    setFileBytes(null);
    setFileNeedsPassword(false);
    setImportPassword("");
    setParsed(null);
    setLabel("");
    setImportRequiredPassword(false);
    setUseSamePassword(true);
    setVaultPassword("");
    setVaultPasswordConfirm("");
    setError(null);
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
            password: fileNeedsPassword ? importPassword : undefined
          }
        : { kind: "text" as const, text };
      const r = await importer.parse(input);
      if (r.length === 0) {
        setError(t("keyImport.page.err.noKey", { defaultValue: "未解析出私钥" }));
        return;
      }
      setParsed(r[0] ?? null);
      // importRequiredPassword 由 useEffect 在 parsed 变化时根据
      // fileNeedsPassword 派生；这里不需要手动设。
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
    // 校验锁屏密码。
    if (vaultPassword.length < 8) {
      setError(t("shell.locked.passwordTooShort", { defaultValue: "密码至少 8 位" }));
      return;
    }
    // 模式 2（双输入框）才需要校验两次输入一致；模式 1（单输入框）
    // 没有 confirm 字段，无条件跳过这一步。
    if (!isSingleFieldMode && vaultPassword !== vaultPasswordConfirm) {
      setError(t("shell.locked.passwordMismatch", { defaultValue: "两次密码不一致" }));
      return;
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
        vaultPassword,
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
      // 关闭前清掉本 wizard 的所有内存状态。
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
      setVaultPassword("");
      setVaultPasswordConfirm("");
    }
  }

  // ----------------- 渲染 -----------------

  if (step === "pick-importer") {
    return (
      <div className="first-time-import">
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
            onSelect={(imp: KeyImporter) => {
              setImporter(imp);
              setError(null);
              setFileBytes(null);
              setFileName(null);
              setFileNeedsPassword(false);
              setImportPassword("");
              setImportRequiredPassword(false);
              setUseSamePassword(true);
              setVaultPassword("");
              setVaultPasswordConfirm("");
            }}
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
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.currentTarget.value)}
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
            disabled={!importer || (fileNeedsPassword && !importPassword)}
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
  return (
    <div className="first-time-import">
      <PageHeader
        title={t("shell.import.wizard.setPasswordTitle", {
          defaultValue: "导入私钥：4. 设置本机系统锁屏密码"
        })}
        description={t("shell.import.wizard.setPasswordDesc", {
          defaultValue:
            "该密码仅保存在本机，用于加密你导入的私钥。导入源密码与本机系统锁屏密码是两个独立字段。"
        })}
      />
      <section className="first-time-import__password">
        {/*
          模式 1 / 模式 2 渲染分支：
          - 模式 1（单输入框，无 confirm）：
              * importRequiredPassword === false（明文 WIF / Hex / 明文
                JSON）→ 单"本机系统锁屏密码"输入框。
              * importRequiredPassword === true 且 useSamePassword===true
                → 单"导入源密码兼系统锁屏密码"输入框。
          - 模式 2（双输入框，含 confirm）：
              importRequiredPassword === true 且 useSamePassword===false。
          旧实现的两个回归：
            1) 把 json-file 静态标成"必需要密码"，未加密 JSON 主路径
               解析按钮被禁用。
            2) 在 KeyImporter 契约加 requiresPassword 字段，把"输入
               属性"误建模为"importer 属性"。
          修复后所有"是否需要密码"的判断都来自运行时（peekBsv8Envelope
          嗅探 + parse() 抛 PASSWORD_REQUIRED_MSG fail-open）。
        */}
        {importRequiredPassword ? (
          <label className="ui-field">
            <input
              type="checkbox"
              checked={useSamePassword}
              onChange={(e) => {
                setUseSamePassword(e.currentTarget.checked);
                if (e.currentTarget.checked) {
                  // 切到模式 1：清空所有密码字段，让用户重新输入。
                  setVaultPassword("");
                  setVaultPasswordConfirm("");
                }
              }}
            />
            <span style={{ marginLeft: 8 }}>
              {t("shell.import.wizard.useSamePassword", {
                defaultValue: "使用导入源密码作为本机系统锁屏密码"
              })}
            </span>
          </label>
        ) : null}
        {isSingleFieldMode ? (
          <TextInput
            label={
              importRequiredPassword
                ? t("shell.import.wizard.importPassword", {
                    defaultValue: "导入源密码（同时作为本机系统锁屏密码）"
                  })
                : t("shell.import.wizard.vaultPasswordOnly", {
                    defaultValue: "本机系统锁屏密码"
                  })
            }
            type="password"
            autoComplete={importRequiredPassword ? "off" : "new-password"}
            value={vaultPassword}
            onChange={(e) => setVaultPassword(e.currentTarget.value)}
            placeholder={
              importRequiredPassword
                ? t("keyImport.page.placeholder.password", {
                    defaultValue: "加密 JSON 文件的密码"
                  })
                : t("shell.import.wizard.placeholder.vaultPassword", {
                    defaultValue: "至少 8 位"
                  })
            }
          />
        ) : (
          <>
            <TextInput
              label={t("shell.locked.passwordNew", { defaultValue: "新密码" })}
              type="password"
              autoComplete="new-password"
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.currentTarget.value)}
            />
            <TextInput
              label={t("shell.locked.passwordConfirm", { defaultValue: "确认密码" })}
              type="password"
              autoComplete="new-password"
              value={vaultPasswordConfirm}
              onChange={(e) => setVaultPasswordConfirm(e.currentTarget.value)}
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
            !vaultPassword ||
            (isSingleFieldMode ? false : vaultPassword !== vaultPasswordConfirm)
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
