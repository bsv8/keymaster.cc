import { useMemo, useState } from "react";
import { HardDrive, KeyRound, Upload } from "lucide-react";
import type { StorageRuntimeController, VaultService } from "@keymaster/contracts";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { router, useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import {
  BucketConnectionFields,
  EMPTY_BUCKET_DRAFT,
  connectionFromBucketDraft,
  createBucketProvider,
  createStorageBucketManagementService,
  readStorageCatalog,
  type BucketBackend,
  type BucketDraft
} from "@keymaster/platform-storage";
import { FirstTimeImportWizard } from "./FirstTimeImportWizard.js";
import { OnboardingShell } from "./OnboardingShell.js";
import { StepProgress, type StepDefinition } from "./StepProgress.js";

type SetupStep = "type" | "parameters" | "password" | "key-choice" | "new-key" | "import-key";

const SETUP_STEPS: ReadonlyArray<StepDefinition> = [
  { id: "type", labelKey: "shell.setup.step.type", defaultLabel: "桶类型" },
  { id: "parameters", labelKey: "shell.setup.step.parameters", defaultLabel: "桶参数" },
  { id: "password", labelKey: "shell.setup.step.password", defaultLabel: "设置密码" },
  { id: "key", labelKey: "shell.setup.step.key", defaultLabel: "第一把 Key" }
];

function readInitialCatalog() {
  try { return readStorageCatalog(); }
  catch { return { format: "keymaster.storage.catalog" as const, version: 2 as const, buckets: [] }; }
}

/**
 * 首次设置专用状态机。它只负责创建首个桶和首把 Key，绝不复用桶管理页。
 * 密码保留在本组件内存中，并分别交给桶和 Vault 的既有事务入口。
 */
export function InitialSetupPage() {
  const { t } = useI18n();
  const storage = useOptionalCapability<StorageRuntimeController & { unlockBucket?: (password: string) => Promise<{ ok?: boolean; diagnostic?: string }> }>("storage.runtime-controller");
  const vault = useOptionalCapability<VaultService>("vault.service");
  const initialCatalog = useMemo(readInitialCatalog, []);
  const hasPreparedBucket = initialCatalog.buckets.length > 0 && Boolean(initialCatalog.selectedBucketId);
  const manager = useMemo(() => createStorageBucketManagementService(), []);
  const [bucketPrepared, setBucketPrepared] = useState(hasPreparedBucket);
  const [step, setStep] = useState<SetupStep>(hasPreparedBucket ? "password" : "type");
  const [draft, setDraft] = useState<BucketDraft>(() => ({ ...EMPTY_BUCKET_DRAFT }));
  const [setupPassword, setSetupPassword] = useState("");
  const [tagName, setTagName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mainStepIndex = step === "type" ? 0 : step === "parameters" ? 1 : step === "password" ? 2 : 3;

  function updateDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  function chooseBackend(backend: BucketBackend) {
    setDraft((current) => ({ ...EMPTY_BUCKET_DRAFT, label: current.label, backend }));
    setError(null);
    setStep("parameters");
  }

  function validateParameters(): string | undefined {
    if (!draft.label.trim()) return t("shell.setup.error.label", { defaultValue: "请输入桶名称（本机显示名称）" });
    if (draft.backend === "s3" && (!draft.endpoint.trim() || !draft.region.trim() || !draft.bucket.trim() || !draft.accessKeyId || !draft.secretAccessKey)) {
      return t("shell.setup.error.s3", { defaultValue: "请填写 Endpoint、Region、Bucket、Access Key ID 和 Secret Access Key。" });
    }
    return undefined;
  }

  async function testParameters() {
    const invalid = validateParameters();
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    const config = connectionFromBucketDraft(draft);
    const provider = createBucketProvider(config, `setup-test-${crypto.randomUUID()}`);
    try {
      const result = await provider.probe();
      if (!result.ok || result.conditionalWrites !== "native") throw new Error(t("shell.setup.error.atomic", { defaultValue: "该桶不支持 Keymaster 所需的原子条件写入。" }));
      setStep("password");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("shell.setup.error.probe", { defaultValue: "桶连接测试失败，请检查参数。" }));
    } finally {
      provider.dispose();
      setBusy(false);
    }
  }

  async function prepareStorage() {
    if (draft.password.length < 8) { setError(t("shell.setup.error.passwordLength", { defaultValue: "密码至少 8 位。" })); return; }
    if (draft.password !== draft.passwordConfirm) { setError(t("shell.setup.error.passwordMismatch", { defaultValue: "两次输入的密码不一致。" })); return; }
    if (!storage?.unlockBucket) { setError(t("shell.setup.error.storagePending", { defaultValue: "存储服务尚未就绪，请稍后重试。" })); return; }
    setBusy(true); setError(null);
    try {
      if (!bucketPrepared) {
        const config = connectionFromBucketDraft(draft);
        await manager.prepareBucketConfig(config, draft.password, {
          label: draft.label.trim(),
          backend: draft.backend,
          createProvider: (bucketId) => createBucketProvider(config, bucketId),
          bucketGeneration: 1
        });
        setBucketPrepared(true);
      }
      const result = await storage.unlockBucket(draft.password);
      if (result && result.ok === false) throw new Error(result.diagnostic || t("shell.setup.error.unlock", { defaultValue: "密码错误，或桶无法读取。" }));
      setSetupPassword(draft.password);
      setDraft((current) => ({ ...current, password: "", passwordConfirm: "" }));
      setStep("key-choice");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("shell.setup.error.prepare", { defaultValue: "初始化桶失败，请重试。" }));
    } finally {
      setBusy(false);
    }
  }

  async function createFirstKey() {
    if (!vault || !setupPassword || !tagName.trim()) return;
    setBusy(true); setError(null);
    try {
      await vault.createVaultWithInitialKey({ password: setupPassword, label: tagName.trim() });
      setSetupPassword("");
      router.push("/settings/vault");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("shell.setup.error.createKey", { defaultValue: "创建第一把 Key 失败，请重试。" }));
    } finally {
      setBusy(false);
    }
  }

  const progress = step !== "import-key" ? <StepProgress steps={SETUP_STEPS} currentIndex={mainStepIndex} doneUpToIndex={mainStepIndex} /> : null;

  let content;
  if (step === "type") {
    content = <><PageHeader title={t("shell.setup.type.title", { defaultValue: "选择桶类型" })} description={t("shell.setup.type.description", { defaultValue: "桶决定 Key 和应用数据保存在哪里。以后可以在桶管理中继续添加其他桶。" })} /><div className="initial-setup__choices"><button type="button" onClick={() => chooseBackend("local")}><HardDrive size={22} /><span><strong>Local</strong><small>{t("shell.setup.type.local", { defaultValue: "保存在当前浏览器，适合单设备使用" })}</small></span></button><button type="button" onClick={() => chooseBackend("s3")}><HardDrive size={22} /><span><strong>S3-compatible</strong><small>{t("shell.setup.type.s3", { defaultValue: "连接兼容 S3 的远程对象存储" })}</small></span></button></div></>;
  } else if (step === "parameters") {
    content = <><PageHeader title={t("shell.setup.parameters.title", { defaultValue: "填写桶参数" })} description={draft.backend === "local" ? t("shell.setup.parameters.local", { defaultValue: "给本地桶设置一个容易识别的名称。" }) : t("shell.setup.parameters.s3", { defaultValue: "填写对象存储位置和访问凭据；浏览器会直接连接该桶。" })} /><BucketConnectionFields draft={draft} onChange={updateDraft} section="parameters" /><div className="initial-setup__actions"><Button onClick={() => void testParameters()} loading={busy}>{draft.backend === "local" ? t("common.action.next", { defaultValue: "继续" }) : t("shell.setup.parameters.testNext", { defaultValue: "测试连接并继续" })}</Button><Button variant="ghost" onClick={() => setStep("type")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else if (step === "password") {
    content = <><PageHeader title={bucketPrepared ? t("shell.setup.password.resumeTitle", { defaultValue: "输入密码继续初始设置" }) : t("shell.setup.password.title", { defaultValue: "设置密码" })} description={t("shell.setup.password.description", { defaultValue: "此密码同时保护桶配置和 Key，但底层分别加密；密码不会写入本机目录或日志。" })} /><BucketConnectionFields draft={draft} onChange={updateDraft} section="password" /><div className="initial-setup__actions"><Button onClick={() => void prepareStorage()} loading={busy} disabled={!draft.password || !draft.passwordConfirm}>{t("shell.setup.password.next", { defaultValue: "保存并继续" })}</Button>{!bucketPrepared ? <Button variant="ghost" onClick={() => setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button> : null}</div></>;
  } else if (step === "key-choice") {
    content = <><PageHeader title={t("shell.setup.keyChoice.title", { defaultValue: "设置第一把 Key" })} description={t("shell.setup.keyChoice.description", { defaultValue: "初始设置只创建或导入一把 Key，完成后进入 Key 管理页面。" })} />{vault ? <div className="initial-setup__choices"><button type="button" onClick={() => setStep("new-key")}><KeyRound size={22} /><span><strong>{t("shell.setup.keyChoice.new", { defaultValue: "新建 Key" })}</strong><small>{t("shell.setup.keyChoice.newHint", { defaultValue: "生成一把新私钥，只需填写标签名称" })}</small></span></button><button type="button" onClick={() => setStep("import-key")}><Upload size={22} /><span><strong>{t("shell.setup.keyChoice.import", { defaultValue: "导入 Key" })}</strong><small>{t("shell.setup.keyChoice.importHint", { defaultValue: "支持现有的 WIF、Hex 和 JSON 导入逻辑" })}</small></span></button></div> : <p className="initial-setup__waiting" role="status">{t("shell.setup.keyChoice.loading", { defaultValue: "桶已就绪，正在加载 Key 服务…" })}</p>}</>;
  } else if (step === "new-key") {
    content = <><PageHeader title={t("shell.setup.newKey.title", { defaultValue: "新建第一把 Key" })} description={t("shell.setup.newKey.description", { defaultValue: "填写用于识别这把 Key 的 Tag Name，私钥将由本机安全生成。" })} /><TextInput label={t("shell.setup.newKey.tag", { defaultValue: "Tag Name（Key 标签名称）" })} value={tagName} onChange={(event) => setTagName(event.currentTarget.value)} placeholder={t("shell.setup.newKey.placeholder", { defaultValue: "例如：主 Key" })} /><div className="initial-setup__actions"><Button onClick={() => void createFirstKey()} loading={busy} disabled={!vault || !tagName.trim()}>{t("shell.setup.newKey.submit", { defaultValue: "创建并进入 Key 管理" })}</Button><Button variant="ghost" onClick={() => setStep("key-choice")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else {
    content = vault ? <FirstTimeImportWizard vaultPassword={setupPassword} onCancel={() => setStep("key-choice")} onComplete={() => { setSetupPassword(""); router.push("/settings/vault"); }} /> : <p className="initial-setup__waiting">{t("shell.setup.import.loading", { defaultValue: "正在加载 Key 导入服务…" })}</p>;
  }

  return <OnboardingShell width="wizard"><div className="initial-setup">{progress}{content}{error ? <p className="initial-setup__error" role="alert">{error}</p> : null}</div></OnboardingShell>;
}
