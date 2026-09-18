// packages/platform-storage/src/ui/useBucketSetupFlow.ts
// 桶初始化 / 解锁向导的业务状态机（React hook，无 UI）。
//
// 流程（KeymasterFormats《初始化流程》）：
//   1. 选择类型（local / s3）
//   2. 填写参数 → 只读探测 keys/
//   3. 判定：有可解析 KeyHold 文件 = 解锁；空桶 = 创建；读取失败只允许重试
//   4. 解锁：选 Key + 该 Key 自己的密码（s3 另需启动密码以保存本机记录）
//   5. 创建：s3 设启动密码；local 不设。首 Key 有它自己的密码。
//   探测不抢锁；创建/解锁才抢该 Key 的应用锁。
//
// 该 hook 被 InitialSetupPage（整页 onboarding）与 BucketSetupWizard
// （桶管理页 Modal）共用；UI 差异只存在于渲染层。

import { useCallback, useEffect, useState } from "react";
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
import { useOptionalCapability } from "webloom-framework/react";
import { updateBucketDraft, EMPTY_BUCKET_DRAFT, type BucketBackend, type BucketDraft } from "../index.js";
import type { InitialSetupImportedKeyDraft } from "@keymaster/plugin-key-import/KeyImportWizard";
import {
  asUserFacingError,
  bucketSetupErrorFromException,
  bucketSetupTransactionId,
  buildBucketConnection,
  buildConnectPlan,
  buildInitialSetupPlan,
  BUCKET_SETUP_STEPS,
  probedKeys,
  validateKeyPassword,
  type BucketSetupKeyDraft,
  type BucketSetupStep
} from "./bucketSetupService.js";

export interface BucketSetupFlowOptions {
  /** 提交成功（新建桶或解锁已有桶）后的去向；由宿主决定（跳 home / 关 Modal）。 */
  onDone(): void;
}

export interface BucketSetupFlowApi {
  step: BucketSetupStep;
  draft: BucketDraft;
  probe: Extract<BucketProbeResult, { ok: true }> | undefined;
  selectedKeyHex: string | undefined;
  keyDraft: BucketSetupKeyDraft | undefined;
  tagName: string;
  keyPassword: string;
  keyPasswordConfirm: string;
  passwordTarget: "create" | "import";
  startupPassword: string;
  startupPasswordConfirm: string;
  transactionId: string | undefined;
  busy: boolean;
  error: StorageUserFacingError | null;
  copyState: string | null;
  managerReady: boolean;
  probedKeys: Array<{ publicKeyHex: string; label: string }>;
  connection: StorageBucketConnectionConfigV1 | undefined;
  mainStepIndex: number;
  steps: typeof BUCKET_SETUP_STEPS;
  setStep(step: BucketSetupStep): void;
  updateDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]): void;
  chooseBackend(backend: BucketBackend): void;
  setSelectedKeyHex(publicKeyHex: string | undefined): void;
  setTagName(value: string): void;
  setKeyPassword(value: string): void;
  setKeyPasswordConfirm(value: string): void;
  setStartupPassword(value: string): void;
  setStartupPasswordConfirm(value: string): void;
  setPasswordTarget(target: "create" | "import"): void;
  probeBucket(): Promise<void>;
  continueStartupPassword(): void;
  chooseGeneratedKey(): void;
  continueGeneratedKey(): void;
  acceptImportedKey(draft: InitialSetupImportedKeyDraft): void;
  continueKeyPassword(target: "unlock" | "create"): void;
  submitConnect(): Promise<void>;
  submitInitialSetup(): Promise<void>;
  copyDiagnostic(): Promise<void>;
  clearSecrets(): void;
}

export function useBucketSetupFlow(options: BucketSetupFlowOptions): BucketSetupFlowApi {
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const managerReady = Boolean(storage?.initialSetup);
  const [step, setStep] = useState<BucketSetupStep>("type");
  const [draft, setDraft] = useState<BucketDraft>(() => ({ ...EMPTY_BUCKET_DRAFT }));
  const [probe, setProbe] = useState<Extract<BucketProbeResult, { ok: true }> | undefined>();
  // 探测成功后缓存的连接：探测会立即清除页面内的凭据,提交时不再依赖表单。
  const [probedConnection, setProbedConnection] = useState<StorageBucketConnectionConfigV1 | undefined>();
  const [selectedKeyHex, setSelectedKeyHex] = useState<string | undefined>();
  const [keyDraft, setKeyDraft] = useState<BucketSetupKeyDraft | undefined>();
  const [tagName, setTagName] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  // "Key 密码"步骤之后的去向：新建则去确认页,导入则先进导入向导。
  const [passwordTarget, setPasswordTarget] = useState<"create" | "import">("create");
  const [keyPasswordConfirm, setKeyPasswordConfirm] = useState("");
  const [startupPassword, setStartupPassword] = useState("");
  const [startupPasswordConfirm, setStartupPasswordConfirm] = useState("");
  const [transactionId, setTransactionId] = useState<string | undefined>();
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
    setTransactionId(undefined);
    setError(null);
    setStep("parameters");
  }

  const mainStepIndex = step === "type" ? 0
    : step === "parameters" ? 1
      : step === "unlock" || step === "startup-password" ? 2
        : step === "confirm" ? 4
          : 3;

  /**
   * 探测：只读连接并列出 keys/。
   * 判定：有 KeyHold → 解锁步骤；空 → 创建步骤；失败只允许重试。
   */
  async function probeBucket() {
    let connection: StorageBucketConnectionConfigV1;
    try {
      connection = buildBucketConnection(draft);
    } catch (caught) {
      setError(asUserFacingError(caught));
      return;
    }
    if (!storage?.probeBucket) { setError(bucketSetupErrorFromException(new Error("存储探测服务尚未就绪。"))); return; }
    setBusy(true);
    setError(null);
    const plan: BucketProbePlan = {
      operationId: transactionId ?? bucketSetupTransactionId(),
      backend: draft.backend,
      connection,
    };
    try {
      // S3 的原子条件写能力由 Worker 在 probe 内验证；这里只发起只读探测。
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
      if (!transactionId) setTransactionId(plan.operationId);
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
      setError(bucketSetupErrorFromException(caught, transactionId));
      setStep("parameters");
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  function continueStartupPassword() {
    if (startupPassword.length < 8) { setError(bucketSetupErrorFromException(new Error("启动密码至少 8 位。"))); return; }
    if (startupPassword !== startupPasswordConfirm) { setError(bucketSetupErrorFromException(new Error("两次输入的启动密码不一致。"))); return; }
    setError(null);
    setStep("key-choice");
  }

  function chooseGeneratedKey() {
    setPasswordTarget("create");
    setKeyDraft({ kind: "generate", label: tagName.trim(), capabilities: ["p2pkh"] });
    setError(null);
    setStep("new-key");
  }

  function continueGeneratedKey() {
    const label = tagName.trim();
    if (!label) { setError(bucketSetupErrorFromException(new Error("请输入第一把 Key 的标签名称。"))); return; }
    setKeyDraft({ kind: "generate", label, capabilities: ["p2pkh"] });
    setError(null);
    setStep("key-password");
  }

  function acceptImportedKey(imported: InitialSetupImportedKeyDraft) {
    setKeyDraft({ kind: "import", ...imported });
    setTagName(imported.label);
    setError(null);
    setStep("confirm");
  }

  function continueKeyPassword(target: "unlock" | "create") {
    const invalid = validateKeyPassword({ password: keyPassword, confirm: target === "create" ? keyPasswordConfirm : undefined });
    if (invalid) { setError(bucketSetupErrorFromException(new Error(invalid))); return; }
    setError(null);
    // 导入路径：先有密码,再让向导解析材料；新建路径直接进入确认。
    if (target === "create" && passwordTarget === "import") { setStep("import-key"); return; }
    setStep("confirm");
  }

  async function submitConnect() {
    if (!storage?.connectExistingRemote || probe?.state !== "has-keys") return;
    const connection = probedConnection;
    if (!connection) { setError(bucketSetupErrorFromException(new Error("连接参数已失效，请返回参数步骤重新探测。"))); return; }
    const plan: ExistingRemoteStorageConnectPlan = buildConnectPlan({
      operationId: transactionId ?? bucketSetupTransactionId(),
      draft,
      connection,
      selectedKeyHex,
      keyPassword,
      startupPassword,
      ...(probe?.conditionalWrites === undefined ? {} : { capabilities: { conditionalWrites: probe.conditionalWrites } }),
    });
    if (!transactionId) setTransactionId(plan.operationId);
    setBusy(true); setError(null);
    try {
      const result: ExistingRemoteStorageConnectResult = await storage.connectExistingRemote(plan);
      clearSecrets();
      if (result.ok) options.onDone();
      else { setError(result.error); setStep("unlock"); }
    } catch (caught) {
      clearSecrets();
      setStep("unlock");
      setError(bucketSetupErrorFromException(caught, plan.operationId));
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  async function submitInitialSetup() {
    if (!storage?.initialSetup || !keyDraft) return;
    const connection = probedConnection;
    if (!connection) { setError(bucketSetupErrorFromException(new Error("连接参数已失效，请返回参数步骤重新探测。"))); return; }
    const currentTransactionId = transactionId ?? bucketSetupTransactionId();
    const plan: InitialSetupPlan = buildInitialSetupPlan({
      transactionId: currentTransactionId,
      draft,
      connection,
      startupPassword,
      keyDraft,
      keyPassword,
      ...(probe?.conditionalWrites === undefined ? {} : { capabilities: { conditionalWrites: probe.conditionalWrites } }),
    });
    if (!transactionId) setTransactionId(currentTransactionId);
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
      options.onDone();
    } catch (caught) {
      // 响应可能丢失但事务已完成；用同一 transactionId 查询结果。
      let recovered: InitialSetupResult | undefined;
      try { recovered = await storage.getInitialSetupResult?.(plan.transactionId); } catch { recovered = undefined; }
      if (recovered?.ok) { clearSecrets(); options.onDone(); return; }
      if (recovered && !recovered.ok) { clearSecrets(); setError(recovered.error); setStep("confirm"); return; }
      clearSecrets();
      setError(bucketSetupErrorFromException(caught, plan.transactionId));
      setStep("confirm");
    } finally {
      setBusy(false);
      setDraft((current) => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "" }));
    }
  }

  async function copyDiagnostic() {
    if (!error) return;
    const text = error.diagnostic;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyState("已复制");
      } else {
        setCopyState("复制失败");
      }
    } catch {
      setCopyState("复制失败");
    }
    setTimeout(() => setCopyState(null), 2000);
  }

  const connection = (() => {
    try { return buildBucketConnection(draft); } catch { return undefined; }
  })();

  return {
    step,
    draft,
    probe,
    selectedKeyHex,
    keyDraft,
    tagName,
    keyPassword,
    keyPasswordConfirm,
    passwordTarget,
    startupPassword,
    startupPasswordConfirm,
    transactionId,
    busy,
    error,
    copyState,
    managerReady,
    probedKeys: probedKeys(probe),
    connection,
    mainStepIndex,
    steps: BUCKET_SETUP_STEPS,
    setStep,
    updateDraft,
    chooseBackend,
    setSelectedKeyHex,
    setTagName,
    setKeyPassword,
    setKeyPasswordConfirm,
    setStartupPassword,
    setStartupPasswordConfirm,
    setPasswordTarget,
    probeBucket,
    continueStartupPassword,
    chooseGeneratedKey,
    continueGeneratedKey,
    acceptImportedKey,
    continueKeyPassword,
    submitConnect,
    submitInitialSetup,
    copyDiagnostic,
    clearSecrets,
  };
}
