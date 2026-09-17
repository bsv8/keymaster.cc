import { useCallback, useEffect, useState } from "react";
import { HardDrive, KeyRound, Upload } from "lucide-react";
import type {
  BucketProbePlan,
  BucketProbeResult,
  ExistingRemoteStorageConnectPlan,
  ExistingRemoteStorageConnectResult,
  InitialSetupPlan,
  InitialSetupResult,
  StorageBucketConnectionConfigV1,
  StorageUserFacingError
} from "@keymaster/contracts";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { router, useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import {
  BucketConnectionFields,
  EMPTY_BUCKET_DRAFT,
  connectionFromBucketDraft,
  createBucketProvider,
  createDeviceRecordRepository,
  defaultDeviceStorage,
  updateBucketDraft,
  validateBucketDraft,
  type BucketBackend,
  type BucketDraft
} from "@keymaster/platform-storage";
import { FirstTimeImportWizard, type InitialSetupImportedKeyDraft } from "./FirstTimeImportWizard.js";
import { OnboardingShell } from "./OnboardingShell.js";
import { StepProgress, type StepDefinition } from "./StepProgress.js";
import { buildDiagnosticText, sanitizeDiagnosticText } from "../diagnostics/sanitizeDiagnostic.js";
import { copyDiagnosticText } from "../diagnostics/copyDiagnostic.js";

// 初始化流程（KeymasterFormats《初始化流程》）：
//   1. 选择类型（local / s3）
//   2. 填写参数 → 只读探测 keys/
//   3. 判定：有可解析 KeyHold 文件 = 解锁；空桶 = 创建；读取失败只允许重试
//   4. 解锁：选 Key + 该 Key 自己的密码（s3 另需启动密码以保存本机记录）
//   5. 创建：s3 设启动密码；local 不设。首 Key 有它自己的密码。
// 探测不抢锁；创建/解锁才抢该 Key 的应用锁。

type SetupStep =
  | "type"
  | "parameters"
  | "unlock"
  | "startup-password"
  | "key-choice"
  | "new-key"
  | "import-key"
  | "key-password"
  | "confirm";

const SETUP_STEPS: ReadonlyArray<StepDefinition> = [
  { id: "type", labelKey: "shell.setup.step.type", defaultLabel: "桶类型" },
  { id: "parameters", labelKey: "shell.setup.step.parameters", defaultLabel: "桶参数与探测" },
  { id: "branch", labelKey: "shell.setup.step.branch", defaultLabel: "解锁 / 创建" },
  { id: "key", labelKey: "shell.setup.step.key", defaultLabel: "第一把 Key" },
  { id: "confirm", labelKey: "shell.setup.step.confirm", defaultLabel: "确认" }
];

type InitialSetupKeyDraft =
  | { kind: "generate"; label: string; capabilities: string[] }
  | ({ kind: "import" } & InitialSetupImportedKeyDraft);

function transactionId(): string {
  try { return crypto.randomUUID(); }
  catch { return `setup-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/**
 * 本机是否已有同名桶（按设备引导记录的显示名称比对）。
 *
 * Local 桶 ID 由 Coordinator 随机生成，页面只需要保证用户输入的桶名称
 * 在本机唯一。
 */
function localNameConflict(label: string): boolean {
  const name = label.trim();
  if (!name) return false;
  try {
    const { entries } = createDeviceRecordRepository(defaultDeviceStorage()).list();
    return entries.some((entry) => (entry.record.displayName ?? "").trim() === name);
  } catch {
    // 设备存储不可用时由真正的探测/提交报错，名称检查不抢先失败。
    return false;
  }
}

function maskedIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length <= 4) return "••••";
  return `${normalized.slice(0, 2)}••••${normalized.slice(-2)}`;
}

function endpointHint(endpoint: string): string {
  try { return maskedIdentifier(new URL(endpoint).host || "未知主机"); }
  catch { return "地址格式待校验"; }
}

function connectionTargetHint(draft: BucketDraft, connection: StorageBucketConnectionConfigV1): string {
  if (connection.kind !== "s3") return "Local";
  if (draft.s3ConfigMode === "cloudflare-r2") return `R2 / ${maskedIdentifier(draft.accountId)} / ${connection.bucket}`;
  if (draft.s3ConfigMode === "aws-s3") return `AWS S3 / ${connection.region} / ${connection.bucket}`;
  return `S3 / ${endpointHint(connection.endpoint)} / ${connection.bucket}`;
}

function s3ConfigModeLabel(mode: BucketDraft["s3ConfigMode"]): string {
  if (mode === "aws-s3") return "AWS S3";
  if (mode === "cloudflare-r2") return "Cloudflare R2";
  return "普通 S3-compatible";
}

function errorFromException(caught: unknown, setupId?: string): StorageUserFacingError {
  const incidentId = `initial-ui-${transactionId().slice(0, 18)}`;
  const message = caught instanceof Error ? caught.message : "初始化请求失败";
  return {
    title: "无法完成初始化",
    summary: message,
    action: "请检查参数与存储权限后重试。",
    code: "initial_ui_failed",
    incidentId,
    ...(setupId === undefined ? {} : { transactionId: setupId }),
    diagnostic: buildDiagnosticText({ phase: "validate", code: "initial_ui_failed", incidentId, message }),
    phase: "validate",
    rollback: "not-started",
  };
}

/** 统一把任意抛出物转换成可展示错误（保留页面已构造的错误对象）。 */
function asUserFacingError(caught: unknown): StorageUserFacingError {
  if (caught && typeof caught === "object" && "diagnostic" in caught && "incidentId" in caught && "phase" in caught) {
    return caught as StorageUserFacingError;
  }
  return errorFromException(caught);
}

export function InitialSetupPage() {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const managerReady = Boolean(storage?.initialSetup);
  const [step, setStep] = useState<SetupStep>("type");
  const [draft, setDraft] = useState<BucketDraft>(() => ({ ...EMPTY_BUCKET_DRAFT }));
  const [probe, setProbe] = useState<Extract<BucketProbeResult, { ok: true }> | undefined>();
  // 探测成功后缓存的连接：探测会立即清除页面内的凭据,提交时不再依赖表单。
  const [probedConnection, setProbedConnection] = useState<StorageBucketConnectionConfigV1 | undefined>();
  const [selectedKeyHex, setSelectedKeyHex] = useState<string | undefined>();
  const [keyDraft, setKeyDraft] = useState<InitialSetupKeyDraft | undefined>();
  const [tagName, setTagName] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [keyPasswordConfirm, setKeyPasswordConfirm] = useState("");
  const [startupPassword, setStartupPassword] = useState("");
  const [startupPasswordConfirm, setStartupPasswordConfirm] = useState("");
  const [setupTransactionId, setSetupTransactionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StorageUserFacingError | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);

  const clearSecrets = useCallback((): void => {
    setDraft((current) => ({ ...current, password: "", passwordConfirm: "", accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    setKeyPassword("");
    setKeyPasswordConfirm("");
    setStartupPassword("");
    setStartupPasswordConfirm("");
    setKeyDraft((current) => current?.kind === "import" ? { ...current, material: { hex: "", wif: undefined } } : current);
  }, []);

  useEffect(() => () => { clearSecrets(); }, [clearSecrets]);

  function updateDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) {
    setDraft((current) => updateBucketDraft(current, key, value));
    setProbedConnection(undefined);
    setError(null);
  }

  function chooseBackend(backend: BucketBackend) {
    setDraft((current) => ({ ...EMPTY_BUCKET_DRAFT, label: current.label, backend }));
    setProbe(undefined);
    setProbedConnection(undefined);
    setSelectedKeyHex(undefined);
    setKeyDraft(undefined);
    setSetupTransactionId(undefined);
    setError(null);
    setStep("parameters");
  }

  const mainStepIndex = step === "type" ? 0
    : step === "parameters" ? 1
      : step === "unlock" || step === "startup-password" ? 2
        : step === "confirm" ? 4
          : 3;

  /** 参数校验 + 本机重名检查；通过后返回连接对象。 */
  function buildConnection(): StorageBucketConnectionConfigV1 | undefined {
    const invalid = validateBucketDraft(draft);
    if (invalid) throw errorFromException(new Error(invalid.message));
    if (draft.backend === "local") {
      // Local 桶 ID 由 Coordinator 随机生成；页面只保证显示名称本机唯一。
      if (localNameConflict(draft.label)) throw errorFromException(new Error(`本机已有同名桶“${draft.label.trim()}”，请换一个名字。`));
      return { kind: "local" };
    }
    const connection = connectionFromBucketDraft(draft);
    if (connection.kind !== "s3") throw errorFromException(new Error("S3 连接参数不完整。"));
    // 同一物理位置重复连接由 Worker 复用既有设备记录 ID,不会产生重复条目。
    return connection;
  }

  /**
   * 探测：只读连接并列出 keys/。
   * 判定：有 KeyHold → 解锁步骤；空 → 创建步骤；失败只允许重试。
   */
  async function probeBucket() {
    let connection: StorageBucketConnectionConfigV1;
    try {
      connection = buildConnection()!;
    } catch (caught) {
      setError(asUserFacingError(caught));
      return;
    }
    if (!storage?.probeBucket) { setError(errorFromException(new Error("存储探测服务尚未就绪。"))); return; }
    setBusy(true);
    setError(null);
    const plan: BucketProbePlan = {
      operationId: setupTransactionId ?? transactionId(),
      backend: draft.backend,
      connection,
    };
    try {
      // s3 先验证可达性与原子条件写；local 直接探测设备命名空间。
      if (draft.backend === "s3") {
        const provider = createBucketProvider(draft, `setup-test-${plan.operationId}`);
        try {
          const result = await provider.probe();
          if (!result.ok || result.conditionalWrites !== "native") throw new Error(t("shell.setup.error.atomic", { defaultValue: "该桶不支持 Keymaster 所需的原子条件写入。" }));
        } finally {
          provider.dispose();
        }
      }
      const result = await storage.probeBucket(plan);
      if (!result.ok) {
        // 读取失败不能当作空桶；停在参数步骤只允许重试。
        setProbe(undefined);
        setError(result.error);
        setStep("parameters");
        return;
      }
      setProbe(result);
      setProbedConnection(connection);
      if (!setupTransactionId) setSetupTransactionId(plan.operationId);
      if (result.state === "has-keys") {
        setSelectedKeyHex(result.keys[0]?.publicKeyHex);
        setStep("unlock");
      } else if (draft.backend === "s3") {
        setStep("startup-password");
      } else {
        setStep("key-choice");
      }
    } catch (caught) {
      setProbe(undefined);
      setError(errorFromException(caught, setupTransactionId));
      setStep("parameters");
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  function continueStartupPassword() {
    if (startupPassword.length < 8) { setError(errorFromException(new Error("启动密码至少 8 位。"))); return; }
    if (startupPassword !== startupPasswordConfirm) { setError(errorFromException(new Error("两次输入的启动密码不一致。"))); return; }
    setError(null);
    setStep("key-choice");
  }

  function chooseGeneratedKey() {
    setKeyDraft({ kind: "generate", label: tagName.trim(), capabilities: ["p2pkh"] });
    setError(null);
    setStep("new-key");
  }

  function continueGeneratedKey() {
    const label = tagName.trim();
    if (!label) { setError(errorFromException(new Error("请输入第一把 Key 的标签名称。"))); return; }
    setKeyDraft({ kind: "generate", label, capabilities: ["p2pkh"] });
    setError(null);
    setStep("key-password");
  }

  function acceptImportedKey(imported: InitialSetupImportedKeyDraft) {
    setKeyDraft({ kind: "import", ...imported });
    setTagName(imported.label);
    setError(null);
    setStep("key-password");
  }

  function continueKeyPassword(target: "unlock" | "create") {
    if (keyPassword.length < 8) { setError(errorFromException(new Error("这把 Key 的密码至少 8 位。"))); return; }
    if (target === "create" && keyPassword !== keyPasswordConfirm) { setError(errorFromException(new Error("两次输入的 Key 密码不一致。"))); return; }
    setError(null);
    setStep("confirm");
  }

  async function submitConnect() {
    if (!storage?.connectExistingRemote || probe?.state !== "has-keys") return;
    const connection = probedConnection;
    if (!connection) { setError(errorFromException(new Error("连接参数已失效，请返回参数步骤重新探测。"))); return; }
    const plan: ExistingRemoteStorageConnectPlan = {
      operationId: setupTransactionId ?? transactionId(),
      displayName: draft.label.trim() || "钱包",
      backend: draft.backend,
      connection,
      ...(selectedKeyHex === undefined ? {} : { publicKeyHex: selectedKeyHex }),
      keyPassword,
      ...(draft.backend === "s3" ? { startupPassword } : {}),
    };
    if (!setupTransactionId) setSetupTransactionId(plan.operationId);
    setBusy(true); setError(null);
    try {
      const result: ExistingRemoteStorageConnectResult = await storage.connectExistingRemote(plan);
      clearSecrets();
      if (result.ok) router.push("/settings/vault");
      else { setError(result.error); setStep("unlock"); }
    } catch (caught) {
      clearSecrets();
      setStep("unlock");
      setError(errorFromException(caught, plan.operationId));
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  async function submitInitialSetup() {
    if (!storage?.initialSetup || !keyDraft) return;
    const connection = probedConnection;
    if (!connection) { setError(errorFromException(new Error("连接参数已失效，请返回参数步骤重新探测。"))); return; }
    const currentTransactionId = setupTransactionId ?? transactionId();
    const plan: InitialSetupPlan = {
      transactionId: currentTransactionId,
      bucketLabel: draft.label.trim() || "钱包",
      backend: draft.backend,
      connection,
      ...(draft.backend === "s3" ? { startupPassword } : {}),
      firstKey: keyDraft.kind === "generate"
        ? { kind: "generate", label: keyDraft.label, capabilities: [...keyDraft.capabilities], password: keyPassword }
        : {
            kind: "import",
            label: keyDraft.label,
            material: { hex: keyDraft.material.hex, ...(keyDraft.material.wif === undefined ? {} : { wif: keyDraft.material.wif }) },
            format: keyDraft.format,
            ...(keyDraft.source === undefined ? {} : { source: keyDraft.source }),
            capabilities: [...keyDraft.capabilities],
            password: keyPassword,
          },
    };
    if (!setupTransactionId) setSetupTransactionId(currentTransactionId);
    setBusy(true); setError(null);
    try {
      const result: InitialSetupResult = await storage.initialSetup(plan);
      if (!result.ok) {
        clearSecrets();
        setError(result.error);
        setStep(keyDraft.kind === "import" ? "key-choice" : "new-key");
        return;
      }
      clearSecrets();
      router.push("/settings/vault");
    } catch (caught) {
      // 响应可能丢失但事务已完成；用同一 transactionId 查询结果。
      let recovered: InitialSetupResult | undefined;
      try { recovered = await storage.getInitialSetupResult?.(plan.transactionId); } catch { recovered = undefined; }
      if (recovered?.ok) { clearSecrets(); router.push("/settings/vault"); return; }
      if (recovered && !recovered.ok) { clearSecrets(); setError(recovered.error); setStep("confirm"); return; }
      clearSecrets();
      setError(errorFromException(caught, plan.transactionId));
      setStep("confirm");
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  async function copyDiagnostic() {
    if (!error) return;
    const ok = await copyDiagnosticText(sanitizeDiagnosticText(error.diagnostic));
    setCopyState(ok ? "已复制" : "复制失败");
    setTimeout(() => setCopyState(null), 2000);
  }

  const progress = <StepProgress steps={SETUP_STEPS} currentIndex={mainStepIndex} doneUpToIndex={mainStepIndex} />;
  const connection = (() => {
    try { return connectionFromBucketDraft(draft); } catch { return undefined; }
  })();

  let content;
  if (step === "type") {
    content = <>
      <PageHeader title={t("shell.setup.type.title", { defaultValue: "选择桶类型" })} description="选择后填写参数并探测目标：已有钱包进入解锁，空桶进入创建。" />
      <div className="initial-setup__choices">
        <button type="button" onClick={() => chooseBackend("local")}>
          <HardDrive size={22} />
          <span><strong>Local 桶</strong><small>只需填写桶名称；桶 ID 自动生成，不需要启动密码</small></span>
        </button>
        <button type="button" onClick={() => chooseBackend("s3")}>
          <HardDrive size={22} />
          <span><strong>S3-compatible 远端</strong><small>需要启动密码（保护本机保存的连接参数）</small></span>
        </button>
      </div>
    </>;
  } else if (step === "parameters") {
    content = <>
      <PageHeader
        title={t("shell.setup.parameters.title", { defaultValue: "填写桶参数" })}
        description={draft.backend === "local"
          ? "填写桶名称（本机显示名称）；桶 ID 由系统随机生成，只需要保证名称不重复。"
          : "填写对象存储位置和访问凭据；点击测试连接并读取桶内 keys/ 目录。"}
      />
      <BucketConnectionFields draft={draft} onChange={updateDraft} section="parameters" />
      {draft.backend === "local" ? (
        <p className="initial-setup__hint">{t("shell.setup.parameters.localIdNote", { defaultValue: "本机桶 ID 会在初始化时随机生成，不需要也不能手工填写。" })}</p>
      ) : null}
      <div className="initial-setup__actions">
        <Button onClick={() => void probeBucket()} loading={busy}>
          {draft.backend === "local" ? "开始创建" : "测试连接并探测"}
        </Button>
        <Button variant="ghost" onClick={() => setStep("type")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
      <p className="initial-setup__hint">探测只读取 `keys/`，不加锁、不写入；读取失败时只允许重试，不会当作空桶。</p>
    </>;
  } else if (step === "unlock") {
    const keys = probe?.state === "has-keys" ? probe.keys : [];
    content = <>
      <PageHeader
        title="解锁已有钱包"
        description="桶内已有 Key；选择要使用的 Key 并输入它自己的密码。s3 还需要启动密码来保存本机连接记录。"
      />
      <ul className="initial-setup__choices">
        {keys.map((key) => (
          <li key={key.publicKeyHex}>
            <button
              type="button"
              aria-pressed={selectedKeyHex === key.publicKeyHex}
              onClick={() => { setSelectedKeyHex(key.publicKeyHex); setError(null); }}
            >
              <KeyRound size={22} />
              <span>
                <strong>{key.label || "（无标签）"}</strong>
                <small><code>{key.publicKeyHex.slice(0, 10)}…{key.publicKeyHex.slice(-8)}</code></small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <TextInput
        label="这把 Key 自己的密码"
        type="password"
        value={keyPassword}
        onChange={(event) => { setKeyPassword(event.currentTarget.value); setError(null); }}
        autoComplete="current-password"
      />
      {draft.backend === "s3" ? <>
        <TextInput
          label="启动密码（保存本机连接参数）"
          type="password"
          value={startupPassword}
          onChange={(event) => setStartupPassword(event.currentTarget.value)}
          autoComplete="new-password"
        />
        <TextInput
          label="再输入一次启动密码"
          type="password"
          value={startupPasswordConfirm}
          onChange={(event) => setStartupPasswordConfirm(event.currentTarget.value)}
          autoComplete="new-password"
        />
      </> : null}
      <div className="initial-setup__actions">
        <Button
          onClick={() => void submitConnect()}
          loading={busy}
          disabled={!managerReady || selectedKeyHex === undefined || keyPassword.length < 8 || (draft.backend === "s3" && startupPassword.length < 8)}
        >
          解锁并进入钱包
        </Button>
        <Button variant="ghost" onClick={() => setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "startup-password") {
    content = <>
      <PageHeader title="设置启动密码" description="S3 桶连接参数在本机会用启动密码加密保存；它不用于加密任何 Key。" />
      <TextInput
        label="启动密码（至少 8 位）"
        type="password"
        value={startupPassword}
        onChange={(event) => { setStartupPassword(event.currentTarget.value); setError(null); }}
        autoComplete="new-password"
      />
      <TextInput
        label="再输入一次启动密码"
        type="password"
        value={startupPasswordConfirm}
        onChange={(event) => setStartupPasswordConfirm(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <div className="initial-setup__actions">
        <Button onClick={continueStartupPassword} disabled={busy || startupPassword.length < 8 || startupPasswordConfirm.length < 8}>继续</Button>
        <Button variant="ghost" onClick={() => setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "key-choice") {
    content = <>
      <PageHeader title={t("shell.setup.keyChoice.title", { defaultValue: "设置第一把 Key" })} description="新建或导入；导入会以这把 Key 自己的密码重新加密 KeyHold 文档。" />
      <div className="initial-setup__choices">
        <button type="button" onClick={chooseGeneratedKey}>
          <KeyRound size={22} />
          <span><strong>{t("shell.setup.keyChoice.new", { defaultValue: "新建 Key" })}</strong><small>由受信任的 Coordinator 在提交时生成私钥</small></span>
        </button>
        <button type="button" onClick={() => setStep("import-key")}>
          <Upload size={22} />
          <span><strong>{t("shell.setup.keyChoice.import", { defaultValue: "导入 Key" })}</strong><small>支持 WIF / Hex / JSON / KeyHold 文件</small></span>
        </button>
      </div>
      <div className="initial-setup__actions">
        <Button variant="ghost" onClick={() => setStep(draft.backend === "s3" ? "startup-password" : "parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "new-key") {
    content = <>
      <PageHeader title={t("shell.setup.newKey.title", { defaultValue: "新建第一把 Key" })} description="填写标签名称；私钥在最终提交边界内生成。" />
      <TextInput
        label={t("shell.setup.newKey.tag", { defaultValue: "Tag Name（Key 标签名称）" })}
        value={tagName}
        onChange={(event) => setTagName(event.currentTarget.value)}
        placeholder={t("shell.setup.newKey.placeholder", { defaultValue: "例如：主 Key" })}
      />
      <div className="initial-setup__actions">
        <Button onClick={continueGeneratedKey} loading={busy} disabled={!tagName.trim()}>继续</Button>
        <Button variant="ghost" onClick={() => setStep("key-choice")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "import-key") {
    content = <FirstTimeImportWizard vaultPassword={keyPassword} onCancel={() => setStep("key-choice")} onComplete={acceptImportedKey} />;
  } else if (step === "key-password") {
    content = <>
      <PageHeader title="设置这把 Key 的密码" description="每把 Key 有自己的密码（KeyHold 文档）；与启动密码互不关联。" />
      <TextInput
        label="Key 密码（至少 8 位）"
        type="password"
        value={keyPassword}
        onChange={(event) => { setKeyPassword(event.currentTarget.value); setError(null); }}
        autoComplete="new-password"
      />
      <TextInput
        label="再输入一次 Key 密码"
        type="password"
        value={keyPasswordConfirm}
        onChange={(event) => setKeyPasswordConfirm(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <div className="initial-setup__actions">
        <Button onClick={() => continueKeyPassword("create")} disabled={busy || keyPassword.length < 8 || keyPasswordConfirm.length < 8}>继续确认</Button>
        <Button variant="ghost" onClick={() => setStep(keyDraft?.kind === "import" ? "import-key" : "new-key")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else {
    const key = keyDraft;
    const isUnlock = probe?.state === "has-keys";
    content = <>
      <PageHeader
        title={isUnlock ? "确认解锁已有钱包" : t("shell.setup.confirm.title", { defaultValue: "确认并初始化" })}
        description={isUnlock
          ? "确认后只读取 keys/ 并解锁所选 Key；不会创建、覆盖或删除远端对象。"
          : "确认后先抢首 Key 的锁，再写入 keys/<公钥>.keyhold，最后写入本机 device 记录与 session。"}
      />
      <p className="initial-setup__hint">不会显示或复制完整 Endpoint、访问凭据、密码或私钥材料。</p>
      {probe?.state === "has-keys" ? (
        <dl className="initial-setup__summary">
          <dt>操作</dt><dd>解锁已有钱包</dd>
          <dt>桶</dt><dd>{draft.backend === "local" ? "Local" : `S3 / ${s3ConfigModeLabel(draft.s3ConfigMode)}`}</dd>
          {connection?.kind === "s3" ? <><dt>S3 目标摘要</dt><dd>{connectionTargetHint(draft, connection)}</dd></> : null}
          <dt>Key</dt><dd><code>{selectedKeyHex?.slice(0, 10)}…{selectedKeyHex?.slice(-8)}</code></dd>
        </dl>
      ) : (
        <dl className="initial-setup__summary">
          <dt>操作</dt><dd>创建新钱包</dd>
          <dt>桶</dt><dd>{draft.backend === "local" ? `Local / ${draft.label.trim() || "未命名"}` : `S3 / ${s3ConfigModeLabel(draft.s3ConfigMode)}`}</dd>
          {connection?.kind === "s3" ? <><dt>S3 目标摘要</dt><dd>{connectionTargetHint(draft, connection)}</dd></> : null}
          <dt>第一把 Key</dt><dd>{key?.label ?? "未完成"}{key?.kind === "import" ? `（${key.format}）` : "（新建）"}</dd>
        </dl>
      )}
      <div className="initial-setup__actions">
        {isUnlock ? (
          <Button onClick={() => void submitConnect()} loading={busy} disabled={!managerReady || selectedKeyHex === undefined || keyPassword.length < 8 || (draft.backend === "s3" && startupPassword.length < 8)}>
            解锁并进入钱包
          </Button>
        ) : (
          <Button onClick={() => void submitInitialSetup()} loading={busy} disabled={!managerReady || !key}>
            创建桶和第一把 Key
          </Button>
        )}
        <Button variant="ghost" onClick={() => setStep(isUnlock ? "unlock" : "key-password")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
      {busy ? <p role="status">{isUnlock ? "正在解锁并安装运行态，请不要关闭页面。" : "正在写入 KeyHold、本机记录与 session，请不要关闭页面。"}</p> : null}
    </>;
  }

  return (
    <OnboardingShell width="wizard">
      <div className="initial-setup">
        {progress}
        {content}
        {error ? (
          <aside className="initial-setup__error" role="alert">
            <h2>{error.title}</h2>
            <p>{error.summary}</p>
            {error.action ? <p>{error.action}</p> : null}
            <p>错误码：<code>{error.code}</code> · 关联 ID：<code>{error.incidentId}</code></p>
            <details>
              <summary>查看脱敏技术诊断</summary>
              <pre>{sanitizeDiagnosticText(error.diagnostic)}</pre>
              <Button variant="ghost" onClick={() => void copyDiagnostic()}>复制诊断信息</Button>
              {copyState ? <span role="status">{copyState}</span> : null}
            </details>
          </aside>
        ) : null}
      </div>
    </OnboardingShell>
  );
}
