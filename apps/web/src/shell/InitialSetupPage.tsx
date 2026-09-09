import { useCallback, useEffect, useState } from "react";
import { HardDrive, KeyRound, Upload } from "lucide-react";
import type {
  InitialSetupPlan,
  InitialSetupRecoveryRecordV1,
  InitialSetupResult,
  StorageBucketConnectionConfigV1,
  StorageRuntimeController,
  StorageUserFacingError
} from "@keymaster/contracts";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { router, useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import {
  BucketConnectionFields,
  EMPTY_BUCKET_DRAFT,
  connectionFromBucketDraft,
  createBucketProvider,
  type BucketBackend,
  type BucketDraft
} from "@keymaster/platform-storage";
import { FirstTimeImportWizard, type InitialSetupImportedKeyDraft } from "./FirstTimeImportWizard.js";
import { OnboardingShell } from "./OnboardingShell.js";
import { StepProgress, type StepDefinition } from "./StepProgress.js";
import { buildDiagnosticText, sanitizeDiagnosticText } from "../diagnostics/sanitizeDiagnostic.js";
import { copyDiagnosticText } from "../diagnostics/copyDiagnostic.js";

type SetupStep = "type" | "parameters" | "password" | "key-choice" | "new-key" | "import-key" | "confirm";

const SETUP_STEPS: ReadonlyArray<StepDefinition> = [
  { id: "type", labelKey: "shell.setup.step.type", defaultLabel: "桶类型" },
  { id: "parameters", labelKey: "shell.setup.step.parameters", defaultLabel: "桶参数" },
  { id: "password", labelKey: "shell.setup.step.password", defaultLabel: "设置密码" },
  { id: "key", labelKey: "shell.setup.step.key", defaultLabel: "第一把 Key" },
  { id: "confirm", labelKey: "shell.setup.step.confirm", defaultLabel: "确认初始化" }
];

type InitialSetupKeyDraft =
  | { kind: "generate"; label: string; capabilities: string[] }
  | ({ kind: "import" } & InitialSetupImportedKeyDraft);

function transactionId(): string {
  try { return crypto.randomUUID(); }
  catch { return `setup-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function endpointHint(endpoint: string): string {
  try { return new URL(endpoint).host || "(未知主机)"; }
  catch { return "(地址格式待校验)"; }
}

function errorFromException(caught: unknown, setupId?: string): StorageUserFacingError {
  const incidentId = `initial-ui-${transactionId().slice(0, 18)}`;
  const message = caught instanceof Error ? caught.message : "初始化请求失败";
  return {
    title: "无法完成初始化",
    summary: "初始化请求没有得到完整提交结果；请检查连接后重试。",
    action: "确认浏览器存储权限和网络状态后重试。",
    code: "initial_setup_transport_error",
    incidentId,
    ...(setupId === undefined ? {} : { transactionId: setupId }),
    phase: "runtime",
    rollback: "unconfirmed",
    diagnostic: buildDiagnosticText({
      phase: "runtime",
      code: "initial_setup_transport_error",
      incidentId,
      rollback: "unconfirmed",
      occurredAt: new Date().toISOString(),
      redactionVersion: "diagnostic-v2",
      message,
    })
  };
}

function recoveryErrorFromRecord(record: InitialSetupRecoveryRecordV1): StorageUserFacingError {
  if (record.error && record.error.rollback === "unconfirmed") return record.error;
  const incidentId = `initial-recovery-${record.transactionId.slice(0, 18)}`;
  const summary = record.status === "pending"
    ? "发现尚未完成的初始化事务；请先恢复或清理它，不能直接创建新的初始化事务。"
    : "上一次初始化的候选数据尚未确认清理；请先完成清理。";
  return {
    title: "需要恢复上一次初始化",
    summary,
    action: record.backend === "s3" ? "请重新输入原 S3 物理目标和访问凭据后重试清理。" : "请先重试清理本次初始化。",
    code: "initial_setup_recovery_required",
    incidentId,
    transactionId: record.transactionId,
    phase: record.phase,
    rollback: "unconfirmed",
    diagnostic: buildDiagnosticText({
      phase: record.phase,
      code: "initial_setup_recovery_required",
      incidentId,
      rollback: "unconfirmed",
      occurredAt: new Date(record.updatedAt).toISOString(),
      redactionVersion: "diagnostic-v2",
      message: summary,
      details: { transactionId: record.transactionId, bucketId: record.bucketId, backend: record.backend, catalog: record.catalog, cleanup: record.cleanup },
    }),
  };
}

function recoveryConnectionFromDraft(draft: BucketDraft): StorageBucketConnectionConfigV1 | undefined {
  if (draft.backend === "local") return { kind: "local" };
  if (!draft.endpoint.trim() || !draft.region.trim() || !draft.bucket.trim() || !draft.accessKeyId || !draft.secretAccessKey) return undefined;
  return connectionFromBucketDraft(draft);
}

function InitialSetupError({
  error,
  onRetryCleanup,
  recoveryDraft,
  onRecoveryDraftChange,
  retryBusy = false,
}: {
  error: StorageUserFacingError;
  onRetryCleanup?: (password?: string) => void;
  recoveryDraft?: BucketDraft;
  onRecoveryDraftChange?: <K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) => void;
  retryBusy?: boolean;
}) {
  const [copyState, setCopyState] = useState<string | null>(null);
  const [cleanupPassword, setCleanupPassword] = useState("");
  async function copyDiagnostic() {
    const copied = await copyDiagnosticText(sanitizeDiagnosticText(error.diagnostic));
    setCopyState(copied ? "已复制脱敏诊断" : "复制失败，请手动选择诊断文本");
  }
  return (
    <aside className="initial-setup__error" role="alert">
      <strong>{error.title}</strong>
      <p>{error.summary}</p>
      {error.action ? <p>{error.action}</p> : null}
      <p>错误码：<code>{error.code}</code> · 关联 ID：<code>{error.incidentId}</code></p>
      <details>
        <summary>查看脱敏技术诊断</summary>
        <pre>{sanitizeDiagnosticText(error.diagnostic)}</pre>
        <Button variant="ghost" onClick={() => void copyDiagnostic()}>复制诊断信息</Button>
        {copyState ? <span role="status">{copyState}</span> : null}
      </details>
      {error.rollback === "unconfirmed" && error.transactionId && onRetryCleanup ? <div className="initial-setup__cleanup-retry">
        {recoveryDraft?.backend === "s3" && onRecoveryDraftChange ? <>
          <p>清理前请重新确认 S3 物理目标；它必须与本次事务的目标指纹一致。</p>
          <BucketConnectionFields draft={recoveryDraft} onChange={onRecoveryDraftChange} section="parameters" lockBackend />
        </> : null}
        <TextInput
          label="重试清理所需的桶密码（S3 可能需要）"
          type="password"
          value={cleanupPassword}
          onChange={(event) => setCleanupPassword(event.currentTarget.value)}
          autoComplete="new-password"
        />
        <Button variant="ghost" onClick={() => onRetryCleanup(cleanupPassword || undefined)} loading={retryBusy}>
          重试清理本次初始化
        </Button>
      </div> : null}
    </aside>
  );
}

/**
 * 首次设置状态机。
 *
 * 步骤 1～4 只更新页面内存；最终确认才把完整 InitialSetupPlan 交给
 * Coordinator。页面不再分别创建桶、解锁桶或创建空 Vault。
 */
export function InitialSetupPage() {
  const { t } = useI18n();
  const storage = useOptionalCapability<StorageRuntimeController>("storage.runtime-controller");
  const managerReady = Boolean(storage?.initialSetup);
  const [step, setStep] = useState<SetupStep>("type");
  const [draft, setDraft] = useState<BucketDraft>(() => ({ ...EMPTY_BUCKET_DRAFT }));
  const [keyDraft, setKeyDraft] = useState<InitialSetupKeyDraft | undefined>();
  const [tagName, setTagName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StorageUserFacingError | null>(null);
  const [setupTransactionId, setSetupTransactionId] = useState<string | undefined>();
  const [recoveryRecord, setRecoveryRecord] = useState<InitialSetupRecoveryRecordV1 | undefined>();
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [legacyPassword, setLegacyPassword] = useState("");
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [legacyInspection, setLegacyInspection] = useState<Awaited<ReturnType<NonNullable<StorageRuntimeController["inspectLegacyInitialSetup"]>>> | null>(null);

  const clearSensitiveDraft = useCallback((): void => {
    setDraft((current) => ({
      ...current,
      password: "",
      passwordConfirm: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
    }));
    setKeyDraft((current) => current?.kind === "import"
      ? { ...current, material: { hex: "", wif: undefined } }
      : current);
  }, []);

  const resetInitialSetupDraft = useCallback((): void => {
    setError(null);
    setRecoveryRecord(undefined);
    setRecoveryUnavailable(false);
    setStep("type");
    setDraft({ ...EMPTY_BUCKET_DRAFT });
    setKeyDraft(undefined);
    setTagName("");
    setSetupTransactionId(undefined);
  }, []);

  function updateRecoveryDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const refreshRecoveryQueue = useCallback(async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (!storage?.listInitialSetupRecoveries) {
      if (!isCancelled()) setRecoveryLoading(false);
      return;
    }
    if (isCancelled()) return;
    setRecoveryLoading(true);
    setRecoveryUnavailable(false);
    try {
      const records = await storage.listInitialSetupRecoveries();
      if (isCancelled()) return;
      const pending = records
        .filter((record) => record.status === "pending" || record.cleanup === "unconfirmed")
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (pending) {
        setRecoveryRecord(pending);
        setSetupTransactionId(pending.transactionId);
        setDraft((current) => ({ ...current, backend: pending.backend }));
        setError(recoveryErrorFromRecord(pending));
        return;
      }
      const succeeded = records
        .filter((record) => record.status === "succeeded")
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (succeeded && storage.getInitialSetupResult) {
        const result = await storage.getInitialSetupResult(succeeded.transactionId);
        if (isCancelled()) return;
        if (result?.ok) {
          clearSensitiveDraft();
          router.push("/settings/vault");
          return;
        }
        if (result && !result.ok) {
          setRecoveryRecord(succeeded);
          setSetupTransactionId(succeeded.transactionId);
          setDraft((current) => ({ ...current, backend: succeeded.backend }));
          setError(result.error);
          return;
        }
        setRecoveryUnavailable(true);
        setError(errorFromException(new Error("已提交的初始化结果无法验证；不能创建新事务。"), succeeded.transactionId));
        return;
      }
      if (succeeded) {
        setRecoveryUnavailable(true);
        setError(errorFromException(new Error("已提交的初始化记录无法查询；不能创建新事务。"), succeeded.transactionId));
        return;
      }
      // 清理成功后再次读到完整队列；只有确认没有下一条记录时，才恢复
      // “选择桶类型”入口，避免用户绕过第二条待恢复事务。
      resetInitialSetupDraft();
    } catch (caught) {
      if (isCancelled()) return;
      setRecoveryUnavailable(true);
      setError(errorFromException(caught));
    } finally {
      if (!isCancelled()) setRecoveryLoading(false);
    }
  }, [clearSensitiveDraft, resetInitialSetupDraft, storage]);

  useEffect(() => {
    let cancelled = false;
    void refreshRecoveryQueue(() => cancelled);
    return () => { cancelled = true; };
  }, [refreshRecoveryQueue]);

  const mainStepIndex = step === "type" ? 0 : step === "parameters" ? 1 : step === "password" ? 2 : step === "confirm" ? 4 : 3;

  function updateDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  function chooseBackend(backend: BucketBackend) {
    if (recoveryLoading || recoveryUnavailable || recoveryRecord) return;
    setDraft((current) => ({ ...EMPTY_BUCKET_DRAFT, label: current.label, backend }));
    setKeyDraft(undefined);
    setSetupTransactionId(undefined);
    setError(null);
    setLegacyInspection(null);
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
    if (invalid) { setError(errorFromException(new Error(invalid))); return; }
    setBusy(true); setError(null);
    let provider: ReturnType<typeof createBucketProvider> | undefined;
    try {
      const config = connectionFromBucketDraft(draft);
      provider = createBucketProvider(config, `setup-test-${transactionId()}`);
      const result = await provider.probe();
      if (!result.ok || result.conditionalWrites !== "native") throw new Error(t("shell.setup.error.atomic", { defaultValue: "该桶不支持 Keymaster 所需的原子条件写入。" }));
      setStep("password");
    } catch (caught) {
      setError(errorFromException(caught));
    } finally {
      provider?.dispose();
      setBusy(false);
    }
  }

  function continuePassword() {
    if (draft.password.length < 8) { setError(errorFromException(new Error(t("shell.setup.error.passwordLength", { defaultValue: "密码至少 8 位。" })))); return; }
    if (draft.password !== draft.passwordConfirm) { setError(errorFromException(new Error(t("shell.setup.error.passwordMismatch", { defaultValue: "两次输入的密码不一致。" })))); return; }
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
    setSetupTransactionId((current) => current ?? transactionId());
    setError(null);
    setStep("confirm");
  }

  function acceptImportedKey(imported: InitialSetupImportedKeyDraft) {
    setKeyDraft({ kind: "import", ...imported });
    setTagName(imported.label);
    setError(null);
    setSetupTransactionId((current) => current ?? transactionId());
    setStep("confirm");
  }

  async function submitInitialSetup() {
    if (recoveryLoading || recoveryUnavailable || recoveryRecord) {
      setError(errorFromException(new Error("请先完成已有初始化事务的恢复或清理。"), setupTransactionId));
      return;
    }
    if (!storage?.initialSetup || !keyDraft) {
      setError(errorFromException(new Error("存储初始化服务尚未就绪，无法提交。")));
      return;
    }
    if (draft.password.length < 8) {
      setError(errorFromException(new Error("请先设置桶密码。")));
      setStep("password");
      return;
    }
    const plan: InitialSetupPlan = {
      transactionId: setupTransactionId ?? transactionId(),
      bucketLabel: draft.label.trim(),
      backend: draft.backend,
      connection: connectionFromBucketDraft(draft),
      bucketPassword: draft.password,
      firstKey: keyDraft.kind === "generate"
        ? { kind: "generate", label: keyDraft.label, capabilities: [...keyDraft.capabilities] }
        : {
            kind: "import",
            label: keyDraft.label,
            material: { hex: keyDraft.material.hex, ...(keyDraft.material.wif === undefined ? {} : { wif: keyDraft.material.wif }) },
            format: keyDraft.format,
            ...(keyDraft.source === undefined ? {} : { source: keyDraft.source }),
            capabilities: [...keyDraft.capabilities]
          }
    };
    if (!setupTransactionId) setSetupTransactionId(plan.transactionId);
    setBusy(true); setError(null);
    try {
      const result: InitialSetupResult = await storage.initialSetup(plan);
      if (!result.ok) {
        // 密码和导入私钥默认不保留；非敏感的桶名称/Key 标签仍可回看。
        clearSensitiveDraft();
        // 已确认回滚后，这个 transactionId 只能代表已经结束的事务；下次
        // 修改表单重试必须创建新事务。未确认时仍保留 ID，供清理重试使用。
        if (result.error.rollback === "confirmed") setSetupTransactionId(undefined);
        setStep("password");
        setError(result.error);
      return;
      }
      clearSensitiveDraft();
      router.push("/settings/vault");
    } catch (caught) {
      // 响应可能在事务已完成后丢失；先用同一个 transactionId 查询，
      // 不能因为 transport timeout 就盲目再次生成首 Key。
      let recovered: InitialSetupResult | undefined;
      try { recovered = await storage.getInitialSetupResult?.(plan.transactionId); } catch { recovered = undefined; }
      if (recovered) {
        if (recovered.ok) {
          clearSensitiveDraft();
          router.push("/settings/vault");
          return;
        }
        clearSensitiveDraft();
        if (recovered.error.rollback === "confirmed") setSetupTransactionId(undefined);
        setError(recovered.error);
        setStep("password");
        return;
      }
      clearSensitiveDraft();
      setStep("password");
      setError(errorFromException(caught, plan.transactionId));
    } finally {
      setBusy(false);
    }
  }

  async function retryCleanup(password?: string) {
    if (!error?.transactionId || !storage?.retryInitialSetupCleanup) return;
    const transactionId = error.transactionId;
    setCleanupBusy(true);
    try {
      const connection = recoveryConnectionFromDraft(draft);
      const result = await storage.retryInitialSetupCleanup(transactionId, {
        ...(password ? { password } : {}),
        ...(connection === undefined ? {} : { connection }),
      });
      clearSensitiveDraft();
      if (result.status === "setup-succeeded") {
        router.push("/settings/vault");
      } else if (result.status === "cleanup-confirmed") {
        await refreshRecoveryQueue();
      } else if (result.status === "cleanup-required") {
        setStep("type");
        setError(result.error);
      } else {
        setRecoveryRecord(undefined);
        setRecoveryUnavailable(true);
        setError(errorFromException(new Error("清理事务已不存在；为避免误创建新事务，请重新加载页面确认状态。"), transactionId));
      }
    } catch (caught) {
      clearSensitiveDraft();
      setError(errorFromException(caught, transactionId));
    } finally {
      setCleanupBusy(false);
    }
  }

  async function inspectLegacy() {
    if (!storage?.inspectLegacyInitialSetup) return;
    setLegacyBusy(true);
    setError(null);
    try {
      const result = await storage.inspectLegacyInitialSetup(legacyPassword);
      setLegacyInspection(result);
      if (result.status !== "safe-to-clean") setLegacyPassword("");
    } catch (caught) {
      setError(errorFromException(caught));
    } finally {
      setLegacyBusy(false);
    }
  }

  async function cleanupLegacy() {
    if (!storage?.cleanupLegacyInitialSetup) return;
    setLegacyBusy(true);
    setError(null);
    try {
      const result = await storage.cleanupLegacyInitialSetup(legacyPassword);
      if (result.ok) {
        setLegacyInspection(null);
        setLegacyPassword("");
        setDraft({ ...EMPTY_BUCKET_DRAFT });
        setKeyDraft(undefined);
        setTagName("");
        setSetupTransactionId(undefined);
        setStep("type");
      } else {
        // 旧版清理在目录 CAS 后删除对象失败时，会创建一条可重试的
        // 恢复记录。立即重新读取它，让 S3 失败路径当场显示物理目标和
        // 凭据输入，而不是要求用户刷新页面才获得恢复入口。
        if (result.error.transactionId && storage.listInitialSetupRecoveries) {
          try {
            const records = await storage.listInitialSetupRecoveries();
            const recovery = records.find((record) => record.transactionId === result.error?.transactionId);
            if (recovery) {
              setRecoveryRecord(recovery);
              setSetupTransactionId(recovery.transactionId);
              setDraft((current) => ({ ...current, backend: recovery.backend }));
            }
          } catch {
            // 原始错误仍然可展示；恢复记录读取失败会在下一次挂载时
            // fail-closed，不允许用户无提示地开始新事务。
          }
        }
        setError(result.error);
      }
    } catch (caught) {
      setError(errorFromException(caught));
    } finally {
      setLegacyPassword("");
      setLegacyBusy(false);
    }
  }

  const progress = <StepProgress steps={SETUP_STEPS} currentIndex={mainStepIndex} doneUpToIndex={mainStepIndex} />;

  let content;
  if (step === "type") {
    if (recoveryLoading) {
      content = <><PageHeader title="检查初始化恢复状态" description="正在读取本机保存的恢复记录。" /><p role="status">请稍候；在恢复记录确认前不能创建新的初始化事务。</p></>;
    } else if (recoveryUnavailable) {
      content = <><PageHeader title="无法确认初始化状态" description="恢复记录暂时不可读。" /><p role="alert">为避免覆盖未知的候选数据，当前不能开始新的初始化。请恢复存储连接后重新加载页面。</p></>;
    } else if (recoveryRecord) {
      content = <><PageHeader title={recoveryRecord.status === "succeeded" ? "验证已完成的初始化" : "恢复未完成的初始化"} description="必须先处理已有事务，不能创建新的 transactionId。" /><p>事务 ID：<code>{recoveryRecord.transactionId}</code></p>{recoveryRecord.backend === "s3" ? <p>清理 S3 候选需要重新输入完整物理目标和访问凭据；页面不会保存这些秘密。</p> : <p>请在下方输入本次候选桶密码，然后重试清理。</p>}{recoveryRecord.status === "succeeded" ? <p role="alert">已提交结果正在校验目录；校验完成前不会允许重新初始化。</p> : null}</>;
    } else {
      content = <><PageHeader title={t("shell.setup.type.title", { defaultValue: "选择桶类型" })} description={t("shell.setup.type.description", { defaultValue: "桶决定 Key 和应用数据保存在哪里。所有步骤完成后才会创建桶。" })} /><div className="initial-setup__choices"><button type="button" onClick={() => chooseBackend("local")}><HardDrive size={22} /><span><strong>Local</strong><small>{t("shell.setup.type.local", { defaultValue: "保存在当前浏览器，适合单设备使用" })}</small></span></button><button type="button" onClick={() => chooseBackend("s3")}><HardDrive size={22} /><span><strong>S3-compatible</strong><small>{t("shell.setup.type.s3", { defaultValue: "连接兼容 S3 的远程对象存储" })}</small></span></button></div>{storage?.inspectLegacyInitialSetup ? <section className="initial-setup__legacy" aria-label="旧版未完成初始化清理"><h2>发现旧版未完成初始化？</h2><p>只有在确认 Hold 没有 Key、keys/ 没有索引且没有 owner 数据后，才允许精确清理。</p><TextInput label="旧桶密码" type="password" value={legacyPassword} onChange={(event) => setLegacyPassword(event.currentTarget.value)} autoComplete="current-password" /><Button variant="ghost" onClick={() => void inspectLegacy()} loading={legacyBusy} disabled={legacyPassword.length < 8}>检查旧版状态</Button>{legacyInspection?.status === "safe-to-clean" ? <div role="status"><p>可安全清理：{legacyInspection.bucket.label}（{legacyInspection.bucket.bucketId}）</p><Button variant="ghost" onClick={() => void cleanupLegacy()} loading={legacyBusy}>清理未完成初始化并重新开始</Button></div> : null}{legacyInspection?.status === "unsafe" ? <p role="alert">无法自动清理：{legacyInspection.reason}</p> : null}{legacyInspection?.status === "none" ? <p role="status">没有发现旧版半截初始化。</p> : null}</section> : null}</>;
    }
  } else if (step === "parameters") {
    content = <><PageHeader title={t("shell.setup.parameters.title", { defaultValue: "填写桶参数" })} description={draft.backend === "local" ? t("shell.setup.parameters.local", { defaultValue: "给本地桶设置一个容易识别的名称。" }) : t("shell.setup.parameters.s3", { defaultValue: "填写对象存储位置和访问凭据；这里只做临时连接探测。" })} /><BucketConnectionFields draft={draft} onChange={updateDraft} section="parameters" /><div className="initial-setup__actions"><Button onClick={() => void testParameters()} loading={busy}>{draft.backend === "local" ? t("common.action.next", { defaultValue: "继续" }) : t("shell.setup.parameters.testNext", { defaultValue: "测试连接并继续" })}</Button><Button variant="ghost" onClick={() => setStep("type")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else if (step === "password") {
    content = <><PageHeader title={t("shell.setup.password.title", { defaultValue: "设置密码" })} description={t("shell.setup.password.description", { defaultValue: "密码只在最终初始化事务期间使用，不会写入本机目录、URL 或日志。" })} /><BucketConnectionFields draft={draft} onChange={updateDraft} section="password" /><div className="initial-setup__actions"><Button onClick={continuePassword} disabled={busy || !draft.password || !draft.passwordConfirm}>{t("shell.setup.password.next", { defaultValue: "继续" })}</Button><Button variant="ghost" onClick={() => setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else if (step === "key-choice") {
    content = <><PageHeader title={t("shell.setup.keyChoice.title", { defaultValue: "设置第一把 Key" })} description={t("shell.setup.keyChoice.description", { defaultValue: "选择新建或导入。资料只保存在本次页面内存，最终确认后才会和完整 Hold 快照一起提交。" })} /><div className="initial-setup__choices"><button type="button" onClick={chooseGeneratedKey}><KeyRound size={22} /><span><strong>{t("shell.setup.keyChoice.new", { defaultValue: "新建 Key" })}</strong><small>{t("shell.setup.keyChoice.newHint", { defaultValue: "由受信任的 Coordinator 在提交时生成私钥" })}</small></span></button><button type="button" onClick={() => setStep("import-key")}><Upload size={22} /><span><strong>{t("shell.setup.keyChoice.import", { defaultValue: "导入 Key" })}</strong><small>{t("shell.setup.keyChoice.importHint", { defaultValue: "支持现有的 WIF、Hex 和 JSON 导入逻辑" })}</small></span></button></div><div className="initial-setup__actions"><Button variant="ghost" onClick={() => setStep("password")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else if (step === "new-key") {
    content = <><PageHeader title={t("shell.setup.newKey.title", { defaultValue: "新建第一把 Key" })} description={t("shell.setup.newKey.description", { defaultValue: "填写用于识别这把 Key 的标签名称。私钥会在最终提交边界内生成。" })} /><TextInput label={t("shell.setup.newKey.tag", { defaultValue: "Tag Name（Key 标签名称）" })} value={tagName} onChange={(event) => setTagName(event.currentTarget.value)} placeholder={t("shell.setup.newKey.placeholder", { defaultValue: "例如：主 Key" })} /><div className="initial-setup__actions"><Button onClick={continueGeneratedKey} loading={busy} disabled={!tagName.trim()}>{t("common.action.next", { defaultValue: "继续确认" })}</Button><Button variant="ghost" onClick={() => setStep("key-choice")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div></>;
  } else if (step === "import-key") {
    content = <FirstTimeImportWizard vaultPassword={draft.password} onCancel={() => setStep("key-choice")} onComplete={acceptImportedKey} />;
  } else {
    const key = keyDraft;
    const connection = connectionFromBucketDraft(draft);
    content = <><PageHeader title={t("shell.setup.confirm.title", { defaultValue: "确认并初始化" })} description={t("shell.setup.confirm.description", { defaultValue: "确认后会一次性创建桶、提交包含第一把 Key 的 Hold 快照，并安装完整运行态。" })} /><dl className="initial-setup__summary"><dt>桶类型</dt><dd>{draft.backend === "local" ? "Local（浏览器本地存储）" : "S3-compatible"}</dd><dt>桶名称</dt><dd>{draft.label.trim()}</dd>{connection.kind === "s3" ? <><dt>S3 位置</dt><dd>{endpointHint(connection.endpoint)} / {connection.bucket}</dd></> : null}<dt>第一把 Key</dt><dd>{key?.label ?? "未完成"}{key?.kind === "import" ? `（${key.format}）` : "（新建）"}</dd></dl><p className="initial-setup__hint">不会显示或复制密码、完整 S3 凭据、私钥材料。</p><div className="initial-setup__actions"><Button onClick={() => void submitInitialSetup()} loading={busy} disabled={!managerReady || !key}>{busy ? "正在完成初始化…" : "创建桶和第一把 Key"}</Button><Button variant="ghost" onClick={() => setStep(key?.kind === "import" ? "key-choice" : "new-key")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button></div>{busy ? <p role="status">正在验证、写入完整快照并安装运行态，请不要关闭页面。</p> : null}</>;
  }

  return <OnboardingShell width="wizard"><div className="initial-setup">{progress}{content}{error ? <InitialSetupError error={error} onRetryCleanup={error.rollback === "unconfirmed" ? retryCleanup : undefined} recoveryDraft={recoveryRecord?.backend === "s3" || draft.backend === "s3" ? draft : undefined} onRecoveryDraftChange={updateRecoveryDraft} retryBusy={cleanupBusy} /> : null}</div></OnboardingShell>;
}
