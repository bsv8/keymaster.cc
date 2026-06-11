// packages/plugin-key-import/src/ImportPage.tsx
// 导入页面：选择 importer -> 输入 -> 解析 -> 通过 vault 保存 -> 触发 key.imported。
// 设计缘由：平台只编排流程，不解析具体格式。
//
// bsv8 envelope 支持：
//   - 文件读取后能快速识别为 envelope 时，显示"备份文件密码"输入框；
//   - parse 时把 password 放入 file input，parse 成功后立即清空密码输入。
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

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, TextInput } from "@keymaster/ui";
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
import { peekBsv8Envelope } from "./importFileSniff.js";

/**
 * Importer parse 抛出的 "Password is required" 错误：
 * 文件被识别为 bsv8 envelope 但用户没填密码。
 * 检测到时打开密码输入框，避免用户重选文件。
 */
const PASSWORD_REQUIRED_MSG = "Password is required for encrypted key file";

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

  // Hooks 必须在条件返回前全部注册，避免违反 Rules of Hooks。
  const [importer, setImporter] = useState<KeyImporter | undefined>(undefined);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [fileNeedsPassword, setFileNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyImportResult | null>(null);

  useEffect(() => {
    if (result) return;
    setPassword("");
  }, [result]);

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
    setFileName(f.name);
    setFileBytes(bytes);
    setFileNeedsPassword(peekBsv8Envelope(bytes));
    setPassword("");
    setError(null);
  }

  function clearFile() {
    setFileName(null);
    setFileBytes(null);
    setFileNeedsPassword(false);
    setPassword("");
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
            password: fileNeedsPassword ? password : undefined
          }
        : { kind: "text" as const, text };
      const r = await importer.parse(input);
      if (r.length === 0) {
        setError(t("keyImport.page.err.noKey", { defaultValue: "未解析出私钥" }));
        return;
      }
      setResult(r[0] ?? null);
      setPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("keyImport.page.err.parse", { defaultValue: "解析失败" });
      if (fileBytes && msg === PASSWORD_REQUIRED_MSG) {
        setFileNeedsPassword(true);
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    setError(null);
    setBusy(true);
    try {
      await persistImport(vault, result, {
        label: label || `key-${Date.now()}`,
        capabilities: ["p2pkh"],
        source: importer?.id
      });
      messageBus.publish("key.imported", { keyId: null });
      setResult(null);
      setText("");
      clearFile();
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("keyImport.page.err.save", { defaultValue: "保存失败" }));
    } finally {
      setBusy(false);
    }
  }

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
        <ImporterPicker selected={importer?.id} onSelect={setImporter} />
      </section>
      <section className="import-page__input">
        <h3>{t("keyImport.page.step.input", { defaultValue: "2. 输入" })}</h3>
        {importer?.supports.includes("text") ? (
          <TextInput
            label={t("keyImport.page.label.text", { defaultValue: "文本" })}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={t("keyImport.page.placeholder.text", { defaultValue: "粘贴 WIF 或 hex 私钥" })}
          />
        ) : null}
        {importer?.supports.includes("file") ? (
          <>
            <label className="ui-field">
              <span className="ui-field__label">{t("keyImport.page.label.file", { defaultValue: "文件" })}</span>
              <input className="ui-input" type="file" onChange={onFile} />
              {fileName ? (
                <span className="ui-field__hint">
                  {t("keyImport.page.filePicked", { defaultValue: "已选择：" })}
                  {fileName}
                  {" "}
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
                label={t("keyImport.page.label.password", { defaultValue: "备份文件密码" })}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                placeholder={t("keyImport.page.placeholder.password", { defaultValue: "加密 JSON 文件的密码" })}
              />
            ) : null}
          </>
        ) : null}
        <Button
          onClick={parse}
          loading={busy}
          disabled={!importer || (fileNeedsPassword && !password)}
        >
          {t("keyImport.page.action.parse", { defaultValue: "解析" })}
        </Button>
        {error ? <p className="import-page__error">{error}</p> : null}
      </section>
      {result ? (
        <section className="import-page__confirm">
          <h3>{t("keyImport.page.step.confirm", { defaultValue: "3. 确认导入" })}</h3>
          <p>
            {t("keyImport.page.detected", { defaultValue: "检测到：" })}
            {result.detectedFormat}
            {result.summary ? ` · ${host.i18n.text(result.summary)}` : ""}
          </p>
          <p>
            {t("keyImport.page.derived", { defaultValue: "派生地址：" })}
            {result.address || t("keyImport.page.derivedPending", { defaultValue: "等待业务插件回填" })}
          </p>
          <TextInput
            label={t("keyImport.page.label.label", { defaultValue: "标签" })}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder={t("keyImport.page.placeholder.label", { defaultValue: "例如 主钱包 / 冷钱包" })}
          />
          <Button onClick={save} loading={busy} disabled={!result}>
            {t("keyImport.page.action.save", { defaultValue: "保存到 Vault" })}
          </Button>
        </section>
      ) : (
        !result && (
          <EmptyState
            title={t("keyImport.page.empty.title", { defaultValue: "等待解析" })}
            description={t("keyImport.page.empty.desc", { defaultValue: "解析成功后这里会显示派生地址和确认按钮。" })}
          />
        )
      )}
    </div>
  );
}
